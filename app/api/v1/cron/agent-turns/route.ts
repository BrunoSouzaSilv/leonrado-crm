/**
 * GET/POST /api/v1/cron/agent-turns
 *
 * O motor do agente rodando como FUNÇÃO — sem contêiner, sem VPS, sem easypanel.
 *
 * ─── Por que esta rota existe ───────────────────────────────────────────────
 *
 * A cadeia completa é `ai_agent.dispatch_requested` → `drainTick` → job
 * `inbound_turn` → `createInboundTurnHandler` → LLM → envio. Até aqui o único
 * consumidor era o `workers/agent-worker`, um processo LONGO que precisa ficar
 * de pé num host. Nesta instalação não há host nenhum — só o Vercel —, então o
 * mesmo caminho roda aqui dentro de uma função, uma vez por gatilho.
 *
 * A peça que torna isso possível já existia: `requestTurnDeps()` é a MESMA
 * factory que as rotas de rota usam (`conversations/[id]/draft-reply`), e o
 * engine inteiro fala pg (`SUPABASE_DB_URL`), não worker.
 *
 * ─── O que ela faz, e a ordem importa ──────────────────────────────────────
 *
 *   1. `reapExpiredJobs` — uma invocação que estourou o `maxDuration` deixou o
 *      job em 'running' sem dono. Sem reaper, aquele lead nunca mais é
 *      respondido e ninguém vê erro nenhum: é o modo de falha silencioso.
 *   2. `drainTick` — eventos parados viram jobs.
 *   3. `claimJobs` — a contagem de 'running' é GLOBAL, então duas invocações
 *      simultâneas (gatilho externo + webhook) não se duplicam.
 *   4. o turno, e depois a disposição (`completeJob`/`failJob`/`cancelJob`).
 *
 * ─── O que ela NÃO faz, e por que isso é seguro ────────────────────────────
 *
 * O `runJob` do worker é maior: registra métricas, adia resposta quando o
 * provedor está sem saldo e trata deferrers de agenda. Aqui nada disso roda, e
 * cada ausência tem o efeito LIMITADO escrito abaixo:
 *
 *   - **Métricas/Central**: uma execução sem `recordRunMetrics` não aparece no
 *     painel de saúde da IA. Envolta o turno inteiro em `comHandoffSeOrcamento
 *     Acabar` (dentro do handler), então orçamento estourado ainda faz handoff
 *     humano na hora — o que importa continua acontecendo, só sem o gráfico.
 *   - **Saldo estourado**: vira `failJob` (reagendado, não descartado) até
 *     esgotar `max_attempts`. Resposta atrasa em vez de sumir.
 *
 * Nenhum dos dois pode DUPLICAR mensagem: o envio acontece dentro do handler,
 * e `failJob` depois de um envio bem-sucedido não re-roda o turno — o job só é
 * re-claimado se nunca chegou ao envio.
 *
 * ─── Autenticação e gatilho ────────────────────────────────────────────────
 *
 * Header `Authorization: Bearer <INTERNAL_SECRET>` (ou `x-cron-secret`), o
 * mesmo contrato dos demais crons. `GET` existe de propósito: o cron externo
 * (ver `docs/runbooks/relogio-http.md`) dispara por GET.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { createInboundTurnHandler } from "@/lib/agent-engine/agent/inbound-turn";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { drainTick } from "@/lib/agent-engine/edge/crm/drain";
import { loadEnv } from "@/lib/agent-engine/env";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import {
  cancelJob,
  claimJobs,
  completeJob,
  failJob,
  reapExpiredJobs,
  type JobRow,
} from "@/lib/agent-engine/queue/queue";
import { withServiceJob } from "@/lib/atendimento/fronteira-server";
import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import type pg from "pg";

export const dynamic = "force-dynamic";
// Um turno com LLM lê contexto, classifica e envia; 300s é o mesmo teto já
// declarado nas rotas de rota do engine. Estourou? O reaper de cima devolve o
// job para a próxima invocação.
export const maxDuration = 300;

/**
 * Turnos por invocação. Concorrência de 2 é deliberada: `claimJobs` desconta os
 * 'running' GLOBAIS do teto, então duas invocações simultâneas dividem estas
 * vagas em vez de somar. Mais que isso não cabe no teto do turno lento.
 */
const MAX_CONCURRENCY = 2;

/** 1ª linha, truncada — PII fora de log. Igual ao do worker. */
function errMsg(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split("\n", 1)[0] ?? "").slice(0, 300);
}

/**
 * Veto PERMANENTE de negócio × incidente de sistema — a fila precisa distinguir.
 *
 * Mesmo contrato do worker: a propriedade `terminal`, e não a classe, é quem
 * separa "tentar de novo dá o mesmo resultado" de "falha real". Hoje o único
 * produtor é o estouro de orçamento, e ele já fez handoff humano antes.
 */
function ehVetoPermanenteDeNegocio(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { terminal?: unknown }).terminal === true;
}

/**
 * Devolve o job a 'pending' sem contar tentativa.
 *
 * Só para kinds que ESTA rota não executa: claimamos tudo que está pronto, e
 * descartar (via `cancelJob`) ou reagendar (via `failJob`) um turno que não
 * nos cabe perderia trabalho que outro executor pode fazer. A comparação no
 * `where` (org + locked_by + 'running') é o mesmo cinto que o worker usa no
 * ramo de deferrer — se o lease expirou nesse meio-tempo, a atualização não
 * pega nada e o reaper resolve.
 */
async function devolverParaPendente(
  pool: pg.Pool,
  job: JobRow,
  workerId: string,
): Promise<void> {
  await pool.query(
    `update job_queue set status='pending', locked_by=null, locked_at=null
      where id=$1 and organization_id=$2 and locked_by=$3 and status='running'`,
    [job.id, job.organization_id, workerId],
  );
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const env = loadEnv();
  const log = createLogger();
  const pool = getRequestPool();
  // Identidade por invocação: o claim a usa como lease, e cada função tem o seu.
  const workerId = `vercel-${requestId.slice(0, 8)}`;

  try {
    const reap = await reapExpiredJobs(pool, {
      visibilityTimeoutMs: env.QUEUE_VISIBILITY_TIMEOUT_MS,
    });

    const drenados = await drainTick(
      pool,
      {
        batchSize: env.CRM_DRAIN_BATCH_SIZE,
        intervalMs: env.CRM_DRAIN_INTERVAL_MS,
        idleIntervalMs: env.CRM_DRAIN_IDLE_INTERVAL_MS,
        debounceMs: env.INBOUND_DEBOUNCE_MS,
        reapTimeoutMs: env.CRM_EVENT_REAP_TIMEOUT_MS,
        allowlistTtlMs: env.AI_ALLOWLIST_TTL_DAYS * 24 * 60 * 60 * 1000,
      },
      log,
    );

    const jobs = await claimJobs(pool, {
      workerId,
      maxConcurrency: MAX_CONCURRENCY,
      batchSize: MAX_CONCURRENCY,
    });

    // O deps é construído DEPOIS do claim de propósito: `requestTurnDeps()`
    // lê o env e monta o logger a cada chamada, e fazer isso por turno seria
    // repetir o mesmo trabalho N vezes dentro do mesmo request.
    const turno = createInboundTurnHandler(requestTurnDeps());

    const resumo = { turnos: 0, falhas: 0, devolvidos: 0 };

    for (const job of jobs) {
      if (job.kind !== "inbound_turn") {
        await devolverParaPendente(pool, job, workerId);
        resumo.devolvidos += 1;
        continue;
      }
      try {
        // Fronteira de serviço: o estado do compromisso é revalidado na borda,
        // e não por um gate lido antes do turno — o operador pode ter mudado
        // autoridade enquanto a IA gerava.
        await withServiceJob(pool, job, () => turno(job, pool, { workerId }));
        await completeJob(pool, job.id, workerId, undefined, claimOfJob(job)?.acquired_at);
        resumo.turnos += 1;
        log.info("turno concluído", { job_id: job.id });
      } catch (err) {
        resumo.falhas += 1;
        try {
          if (ehVetoPermanenteDeNegocio(err)) {
            log.warn("turno cancelado por veto permanente de negócio", {
              job_id: job.id,
              error: errMsg(err),
            });
            await cancelJob(pool, job.id, workerId, errMsg(err), claimOfJob(job)?.acquired_at);
          } else {
            log.error("turno falhou", { job_id: job.id, error: errMsg(err) });
            await failJob(pool, job.id, workerId, err, claimOfJob(job)?.acquired_at);
          }
        } catch (disposicaoErr) {
          // Falha dupla: o turno falhou E a fila não conseguiu registrar. O job
          // só se recupera pelo reaper da PRÓXIMA invocação.
          log.error("disposição do job indisponível — reaper da próxima invocação resolve", {
            job_id: job.id,
            error: errMsg(disposicaoErr),
          });
        }
      }
    }

    return ok({ drenados, reapados: reap, ...resumo }, { requestId });
  } catch (err) {
    log.error("tick do agente falhou", { error: errMsg(err) });
    // 500 de propósito: o gatilho externo precisa ver a falha e tentar de novo.
    return fail("internal_error", errMsg(err), 500, { requestId });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
