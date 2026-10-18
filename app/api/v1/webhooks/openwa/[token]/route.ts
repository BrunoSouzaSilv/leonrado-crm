/**
 * POST /api/v1/webhooks/openwa/[token] — ingestão do gateway OpenWA.
 *
 * Token no path = a amarração com a organização (mesmo desenho das demais
 * rotas de entrada): sem ele, quem conhecesse o painel escreveria em qualquer
 * tenant. Sem handshake nem HMAC nesta fatia — o segredo HMAC do painel entra
 * na Fase 3 com a verificação de assinatura; o token aleatório por org é a
 * autenticação da v1.
 *
 * Corpo esperado (envelope `message.received` do painel):
 *   { "event": "message.received", "data": { ...mensagem... } }
 * Aceita também a mensagem nua (sem envelope) — o painel e os testes de
 * integração variam. Idempotente por (organization_id, external_id).
 */
import { after, NextResponse, type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { garantirLinhaDeSessao, ingerirMensagem, mapearMensagemOpenwa } from "@/lib/openwa/ingest";
import { chaveOpenwa, lerConfigOpenwa, orgPorWebhookToken } from "@/lib/openwa/config";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// O `after()` abaixo espera o turno terminar — e o turno pode levar o teto que
// a própria rota `cron/agent-turns` declara. Sem este 300 aqui, o acordar é
// morto no teto padrão da rota de entrada, no meio de um LLM. Importa saber que
// NÃO é o painel que espera: `after()` roda depois do response já entregue, e o
// ack do OpenWA sai na hora.
export const maxDuration = 300;

/**
 * Acorda o motor do agente DEPOIS da resposta já ter sido entregue ao painel.
 *
 * A ingestão grava o evento no `event_log`; o `drainTick` é quem o vira em
 * turno `inbound_turn`. Sem este acordar, o evento fica esperando o tique do
 * cron do Vercel — até 60s. A IA responderia, mas tarde o bastante para o
 * operador concluir que não respondeu.
 *
 * `after()` e não `await` é a decisão central desta função: um turno com LLM
 * pode levar dezenas de segundos, e segurar o webhook por isso faria o painel
 * do OpenWA — que tem teto de ack — reentregar a mensagem. A reentrega viraria
 * um segundo evento e uma segunda resposta. A resposta sai primeiro; o turno
 * roda em segundo plano.
 *
 * Não há laço de acordar-em-loop: `fromMe` (a própria saída) é descartado em
 * `mapearMensagemOpenwa` lá em cima, então este gatilho só dispara para entrada
 * de verdade. E concorrência com o cron não duplica trabalho — `claimJobs`
 * segura a fila com advisory lock e desconta os `running` globais.
 */
async function acordarMotorDoAgente(urlDaChamada: string): Promise<void> {
  const segredo = process.env.CRON_SECRET ?? process.env.INTERNAL_SECRET;
  // Sem segredo nesta instalação não há como chamar a rota (fail-closed). O
  // cron do Vercel manda o `CRON_SECRET` sozinho e cobre este evento.
  if (!segredo) return;
  try {
    await fetch(new URL("/api/v1/cron/agent-turns", urlDaChamada), {
      method: "POST",
      headers: { Authorization: `Bearer ${segredo}` },
      cache: "no-store",
    });
  } catch {
    // Silencioso de propósito: a mensagem já está persistida e idempotente.
    // Se este fetch falhar, o cron do Vercel pega o mesmo evento em ≤60s.
  }
}

interface RouteCtx {
  params: Promise<{ token: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const { token } = await ctx.params;
  const admin = createAdminClient();
  const dono = await orgPorWebhookToken(admin, token);
  if (!dono) return fail("not_found", "webhook desconhecido", 404);

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return fail("invalid_body", "corpo inválido", 400);
  }
  const rec = (corpo ?? {}) as Record<string, unknown>;
  const evento = typeof rec.event === "string" ? rec.event : "";
  const msgBruta =
    rec.data && typeof rec.data === "object" ? (rec.data as Record<string, unknown>) : rec;
  if (evento && evento !== "message.received" && evento !== "message") {
    // Acks, status de sessão etc.: 200 sem efeito (o painel reentrega 4xx).
    return ok({ ignored: evento });
  }

  const cfg = dono.config;
  // Número próprio: o campo `to` do evento (para quem a mensagem foi) quando
  // presente; sem ele, o descarte cai só no fromMe do payload.
  const para = msgBruta.to;
  const proprios = typeof para === "string" ? para.replace(/\D/g, "") : "";

  const mapeada = mapearMensagemOpenwa(msgBruta, proprios);
  if ("ignorar" in mapeada) {
    logger.info("openwa.webhook: evento ignorado", { motivo: mapeada.ignorar });
    return ok({ ignored: mapeada.ignorar });
  }

  const linha = await garantirLinhaDeSessao(
    admin,
    dono.id,
    cfg.session_id ?? "desconhecida",
    null,
    null,
  );
  const { conversaId, mensagemId } = await ingerirMensagem(admin, dono.id, linha.id, mapeada.evento);

  // Evento no banco → acorda o motor sem segurar o ack do painel.
  after(() => acordarMotorDoAgente(req.url));

  return ok({ conversaId, mensagemId });
}
