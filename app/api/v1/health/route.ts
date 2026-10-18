/**
 * GET /api/v1/health — Supabase, Redis, WAHA e OpenWA respondem?
 *
 * ─── Por que cada check diz a CAUSA, e não só "down" ─────────────────────────
 * A versão anterior devolvia `error: "fetch failed"` — a mensagem que o `fetch`
 * dá para causas opostas. Com ela, produção passou semanas indistinguível entre
 * "o endereço configurado não existe" e "o serviço caiu", e a leitura que
 * prevaleceu foi a segunda: o dono reiniciava, toda vez, um container que nunca
 * havia caído (medido: `restarts=0`). Um diagnóstico que não separa configuração
 * de disponibilidade manda metade das pessoas para o lugar errado — e sempre a
 * mesma metade, porque "o serviço caiu" é a hipótese que não acusa quem
 * configurou.
 *
 * `reason` é a classificação (ver `lib/net/alcance`), e é o que basta para saber
 * ONDE mexer.
 *
 * ─── Por que o ENDEREÇO só sai autenticado ───────────────────────────────────
 * Esta rota é pública — é o que permite um monitor externo bater nela. O endereço
 * do Redis e do WAHA é superfície de ataque: publicá-lo entrega a quem varre a
 * internet o alvo exato de dois serviços que falam com o WhatsApp do cliente.
 * Então `target` só sai com `?verbose=1` mais o mesmo segredo interno dos crons:
 * quem opera o sistema vê para onde ele tentou ir; quem só passa na frente, não.
 *
 * ─── Por que `nao_configurado` é `ok` (e não mais `degraded`) ────────────────
 * Integração que NINGUÉM CONTRATOU nesta instalação não é degradação: é ausência
 * de contrato. Ver `integrazioneNaoContratada()`. O campo `skipped: true`
 * mantém a diferença entre "testado e passou" e "não testado porque não existe".
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { env } from "@/lib/env";
import { criarClienteOpenwa, OpenwaHttpError } from "@/lib/openwa/client";
import { chaveOpenwa, lerConfigOpenwa } from "@/lib/openwa/config";
import { alvoDe, classificarFalhaDeAlcance, type FalhaDeAlcance } from "@/lib/net/alcance";
import { validarConfigRedisRest } from "@/lib/redis-config";
import { createAdminClient } from "@/lib/supabase/admin";
import { urlDoSupabaseNoServidor } from "@/lib/supabase/url-do-servidor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CheckStatus = "ok" | "degraded" | "down";

/** Por que o check não passou. `credencial_recusada` é o 401/403 — chegamos lá, e fomos barrados. */
type MotivoDeFalha =
  | FalhaDeAlcance
  | "credencial_recusada"
  | "resposta_inesperada"
  | "nao_configurado"
  | "configuracao_invalida";

type Check = {
  status: CheckStatus;
  latency_ms: number;
  error?: string;
  reason?: MotivoDeFalha;
  /** Protocolo + host + porta que tentamos. Só com `?verbose=1` autenticado. */
  target?: string;
  /**
   * A integração não existe nesta instalação: `nao_configurado`.
   *
   * Distingue "testado e passou" de "não testado porque ninguém contratou" —
   * os dois saem `ok`, e só este carrega a marca. Sem ela, `ok` deixa de dizer
   * se o serviço foi alcançado ou simplesmente não é procurado.
   */
  skipped?: boolean;
};

const TIMEOUT_MS = 3_000;

async function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}

/** Chegamos ao serviço, ele respondeu, e a resposta não serve. */
function motivoDoStatusHttp(status: number): MotivoDeFalha {
  return status === 401 || status === 403 ? "credencial_recusada" : "resposta_inesperada";
}

/**
 * Integração que NINGUÉM CONTRATOU nesta instalação: `nao_configurado`.
 *
 * ─── Por que deixou de ser `degraded` ───────────────────────────────────────
 *
 * Esta rota nasceu numa instalação self-host onde WAHA e Redis são o produto:
 * não configurá-los é o sistema pela metade, e `degraded` era o sinal honesto.
 *
 * Mas o produto também se instala com UMA integração só — e aí o resto marcava
 * degradado para sempre. Medido na instalação AVIA: `redis` e `waha` nunca
 * serão configurados (o canal é OpenWA, sem fila e sem engine WAHA), e a
 * resposta era `status: "degraded"` por semanas, com tudo funcionando. Um
 * indicador que aponta problema inexistente desensina quem olha — e o defeito
 * que ele causa é grave: no primeiro problema VERDADEIRO, ninguém acredita.
 *
 * ─── Por que `ok`, e não `degraded` nem `skipped` como status ───────────────
 *
 * `ok` porque não há nada a fazer: quem opera não precisa abrir o `.env` para
 * uma integração que não vai usar. Mas o campo `reason` continua saindo com
 * `nao_configurado`, e o novo `skipped: true` diz explicitamente que NÃO foi
 * testado — a diferença entre "testado e passou" e "não testado porque não
 * existe" continua legível para quem lê o JSON.
 *
 * O que NÃO muda: `configuracao_invalida` continua `down`. Configurado ERRADO
 * é o produto contando com o Redis e não o tendo — o caso que este arquivo foi
 * escrito para separar de "o serviço caiu", e ele segue separado.
 */
function integrazioneNaoContratada(): Check {
  return { status: "ok", latency_ms: 0, reason: "nao_configurado", skipped: true };
}

async function checkSupabase(): Promise<Check> {
  const t0 = Date.now();
  // A sonda pergunta ao MESMO endereço que o app usa para falar com o banco, e
  // não ao público: com `SUPABASE_SERVER_URL` (#1082) preenchida, uma instalação
  // com Kong privado não tem REST publicado — a URL pública daria `down` com o
  // CRM inteiro funcionando ao lado. Sem a variável, é a pública, como sempre.
  const url = urlDoSupabaseNoServidor(env.SUPABASE_SERVER_URL, env.NEXT_PUBLIC_SUPABASE_URL);
  try {
    // Ping leve via REST com anon key — não precisa de service_role pra health check.
    // Se chegar 200/401/empty body, conexão e API key estão OK.
    const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const res = await withTimeout(
      fetch(`${url}/rest/v1/organizations?select=id&limit=1`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          // O SCHEMA VAI EXPLÍCITO, como o resto do app faz.
          //
          // Este `fetch` é cru, então ele cai no schema DEFAULT do PostgREST —
          // o primeiro da lista "Exposed schemas" do projeto. Que esse default
          // seja `public` é costume de projeto novo, não garantia do Supabase:
          // num projeto que já servia outra aplicação (schema próprio primeiro
          // na lista), o ping procurava `<outro>.organizations`, levava
          // `404 PGRST205` e o check declarava o banco `down` — com o CRM
          // atendendo normalmente ao lado.
          //
          // Não é falso alarme de menos importância: `update.sh` termina em
          // `wait_app_healthy`, e sair diferente de zero é o sinal que o
          // `agent.sh` usa para REVERTER a imagem. Uma atualização boa era
          // desfeita por uma configuração de painel que o CRM não controla.
          //
          // Nenhum client do CRM declara `db.schema` (`lib/supabase/*.ts`), e o
          // default do supabase-js é `public` — então é `public` que o app
          // usa de verdade, e é o que esta sonda tem de perguntar para estar
          // medindo o mesmo banco que o app enxerga.
          "Accept-Profile": "public",
        },
        cache: "no-store",
      }),
    );
    // 200 (lista vazia por RLS) ou 401/403 (auth ok mas RLS bloqueia anon) → conexão OK
    if (res.status === 200 || res.status === 401 || res.status === 403) {
      return { status: "ok", latency_ms: Date.now() - t0, target: alvoDe(url) };
    }
    return {
      status: "down",
      latency_ms: Date.now() - t0,
      error: `http_${res.status}`,
      reason: motivoDoStatusHttp(res.status),
      target: alvoDe(url),
    };
  } catch (e) {
    return {
      status: "down",
      latency_ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
      reason: classificarFalhaDeAlcance(e),
      target: alvoDe(url),
    };
  }
}

async function checkRedis(): Promise<Check> {
  const t0 = Date.now();
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;

  /**
   * A FORMA do valor vem antes da ida à rede, e o motivo é o que quem opera faz
   * a seguir.
   *
   * Um `.env` com as aspas sobrando (`URL="https://srh:80"`) hoje chega até o
   * `fetch`, falha, e o `reason` que sai é o de alcance — indistinguível do
   * contêiner do Redis realmente parado. As duas leituras mandam o operador
   * para lugares opostos: uma para reiniciar um serviço que está de pé, a outra
   * para o editor. `configuracao_invalida` separa as duas SEM ida à rede.
   *
   * Só "não configurado" segue `degraded`: é integração que ninguém contratou.
   * Configurado errado é `down` — o produto conta com o Redis e não o tem.
   *
   * O texto continua carregando o endereço de propósito: `semAlvo()` o redige
   * para quem não tem o segredo interno, e quem tem precisa ver QUAL valor está
   * malformado — dizer só "inválido" sem dizer qual não conserta nada.
   */
  const config = validarConfigRedisRest(url, token);
  if (!config.ok) {
    if (config.reason === "nao_configurado") {
      return integrazioneNaoContratada();
    }
    return {
      status: "down",
      latency_ms: 0,
      error: `configuracao_invalida: UPSTASH_REDIS_REST_URL=${url}`,
      reason: "configuracao_invalida",
      target: alvoDe(url),
    };
  }
  try {
    // Protocolo REST do Upstash (compatível com serverless-redis-http): comando no
    // corpo via POST na raiz. NÃO existe GET /ping — daria 404 no SRH self-host.
    const res = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["PING"]),
        cache: "no-store",
      }),
    );
    if (!res.ok) {
      return {
        status: "down",
        latency_ms: Date.now() - t0,
        error: `http_${res.status}`,
        reason: motivoDoStatusHttp(res.status),
        target: alvoDe(url),
      };
    }
    return { status: "ok", latency_ms: Date.now() - t0, target: alvoDe(url) };
  } catch (e) {
    return {
      status: "down",
      latency_ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
      reason: classificarFalhaDeAlcance(e),
      target: alvoDe(url),
    };
  }
}

async function checkWaha(): Promise<Check> {
  const t0 = Date.now();
  const base = env.WAHA_API_BASE_URL;
  if (!base) {
    return integrazioneNaoContratada();
  }
  try {
    // /api/sessions valida conectividade E autenticação num tiro só. O WAHA Core não
    // expõe /api/health (daria 404 mesmo autenticado).
    const res = await withTimeout(
      fetch(`${base.replace(/\/$/, "")}/api/sessions`, {
        headers: env.WAHA_API_KEY ? { "X-Api-Key": env.WAHA_API_KEY } : {},
        cache: "no-store",
      }),
    );
    if (!res.ok) {
      return {
        status: "down",
        latency_ms: Date.now() - t0,
        error: `http_${res.status}`,
        reason: motivoDoStatusHttp(res.status),
        target: alvoDe(base),
      };
    }
    return { status: "ok", latency_ms: Date.now() - t0, target: alvoDe(base) };
  } catch (e) {
    return {
      status: "down",
      latency_ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
      reason: classificarFalhaDeAlcance(e),
      target: alvoDe(base),
    };
  }
}

/**
 * O CANAL REAL desta instalação: o painel OpenWA.
 *
 * ─── Por que existe ────────────────────────────────────────────────────────
 * Esta rota nasceu cobrindo Supabase + Redis + WAHA. Instalações que operam
 * pelo OpenWA ficavam sem NENHUM check de canal: o painel podia estar fora do
 * ar com a health respondendo `healthy`, porque o que ela media não era o que
 * o app usava de verdade. Um health que não cobre o canal do produto não é
 * health — é um ping no banco com outro nome.
 *
 * ─── Por que lê o BANCO, e não o .env ──────────────────────────────────────
 * A config OpenWA é por organização (`organizations.settings->'openwa'`, em
 * `lib/openwa/config.ts`), com a chave cifrada em repouso. Então o check
 * decifra e fala com o painel do mesmo jeito que o adapter fala — se a chave
 * no banco não decifra, quem opera precisa saber AGORA, e não na primeira
 * mensagem que virar `failed`.
 *
 * ─── Por que pega só a PRIMEIRA org configurada ────────────────────────────
 * Instalação single-tenant (o caso medido) tem uma. Multi-tenant: se múltiplas
 * orgs configurarem canais diferentes, o check continua sendo um — a health
 * mede a instalação, não cada locatário. Cobrir todas mudaria o contrato do
 * aggregate por um caso ainda não vivido.
 *
 * Mesmo contrato do WAHA: `GET /api/sessions` valida conectividade E
 * autenticação num tiro só, e o `withTimeout` de 3s da rota segura o teto de
 * 45s do cliente.
 */
async function checkOpenwa(): Promise<Check> {
  const t0 = Date.now();
  const admin = createAdminClient();
  try {
    // Mesmo filtro de orgPorWebhookToken: orgs que TÊM bloco openwa.
    const { data, error } = await admin
      .from("organizations")
      .select("id, settings")
      .not("settings->openwa", "is", null)
      .limit(1);
    if (error) {
      return {
        status: "down",
        latency_ms: Date.now() - t0,
        error: error.message,
        reason: "resposta_inesperada",
      };
    }
    const org = (data ?? [])[0] as { id: string } | undefined;
    if (!org) return integrazioneNaoContratada();

    const cfg = await lerConfigOpenwa(admin, org.id);
    if (!cfg.base_url) return integrazioneNaoContratada();

    const chave = await chaveOpenwa(admin, cfg);
    if (!chave) {
      // Configurou o endereço, não a chave (ou a chave não decifra). Isso é
      // o caso que separa "abra o editor" de "reinicie o serviço": quem opera
      // precisa ir ao painel de conexões, não ao terminal.
      return {
        status: "degraded",
        latency_ms: Date.now() - t0,
        error: "api_key_ausente_ou_indecifravel",
        reason: "configuracao_invalida",
        target: alvoDe(cfg.base_url),
      };
    }

    const cliente = criarClienteOpenwa(cfg.base_url, chave);
    await withTimeout(cliente.sessoes());
    return { status: "ok", latency_ms: Date.now() - t0, target: alvoDe(cfg.base_url) };
  } catch (e) {
    if (e instanceof OpenwaHttpError) {
      return {
        status: "down",
        latency_ms: Date.now() - t0,
        error: e.message,
        reason: e.status === null ? classificarFalhaDeAlcance(e) : motivoDoStatusHttp(e.status),
      };
    }
    return {
      status: "down",
      latency_ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
      reason: classificarFalhaDeAlcance(e),
    };
  }
}

/**
 * O segredo interno dos crons também abre o modo verboso. Mesmo contrato de
 * `/api/v1/system/agent`: Bearer, comparação em tempo constante, e segredo vazio
 * nunca vira credencial válida.
 */
function segredoInternoConfere(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const fornecido = bearer || (req.headers.get("x-cron-secret")?.trim() ?? "");
  if (!fornecido) return false;
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  return aceitos.some((esperado) => {
    const a = Buffer.from(fornecido);
    const b = Buffer.from(esperado);
    // timingSafeEqual LANÇA se os tamanhos diferirem.
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/**
 * Sem o segredo, o endereço não sai — nem pelo `target`, nem pelo `error`.
 *
 * O `target` sempre foi escondido de propósito: esta rota é PÚBLICA (o `GET` não
 * exige nada; o segredo interno só destrava o `?verbose=1`), e o cabeçalho deste
 * arquivo chama o endereço de WAHA e Redis do cliente de superfície de ataque.
 * Mas o `error` saía cru ao lado dele, e ele carrega o mesmo endereço numa das
 * formas mais comuns de configuração errada.
 *
 * Medido, com valores que passam pelo Zod de `lib/env.ts` — porque só
 * `NEXT_PUBLIC_SUPABASE_URL` é `.url()` (linha 69); `WAHA_API_BASE_URL` (140) e
 * `UPSTASH_REDIS_REST_URL` (155) são `required()` puro, sem validação de forma:
 *
 *   "redis-interno.hostgator-vps.com"
 *     -> e.message = "Failed to parse URL from redis-interno.hostgator-vps.com"
 *   `"https://redis-interno.hostgator-vps.com"`  (aspas sobrando no .env)
 *     -> e.message = "Failed to parse URL from \"https://redis-interno...\""
 *
 * Ou seja: exatamente os dois serviços cujo endereço a rota esconde por decisão
 * escrita, e exatamente a instalação self-host que erra o `.env` — o caso já
 * catalogado nesta casa como ".env sem aspas". O `error` publicava pela porta
 * que a redação do `target` fechou.
 *
 * Contra-exemplo medido, para o escopo ficar honesto: um endereço com esquema
 * válido e host inalcançável devolve `"fetch failed"`, e o host mora em
 * `e.cause`, que esta rota nunca devolveu. O vazamento é da forma MALFORMADA,
 * não de toda falha — e é por isso que a troca é de redação, não de remoção.
 *
 * O que NÃO se perde: `reason` (`classificarFalhaDeAlcance`) continua saindo
 * inteiro, então quem monitora de fora segue distinguindo dns, recusa, tempo
 * esgotado e credencial recusada. E quem tem o segredo continua vendo o texto
 * original, porque `verbose=1` não passa por aqui.
 */
function semAlvo(check: Check): Check {
  const { target: _oculto, error, ...resto } = check;
  return error === undefined ? resto : { ...resto, error: "erro_ao_consultar" };
}

export async function GET(req: NextRequest) {
  const [supabase, redis, waha, openwa] = await Promise.all([
    checkSupabase(),
    checkRedis(),
    checkWaha(),
    checkOpenwa(),
  ]);

  const verboso = req.nextUrl.searchParams.get("verbose") === "1" && segredoInternoConfere(req);
  const filtrar = verboso ? (c: Check) => c : semAlvo;
  const checks = {
    supabase: filtrar(supabase),
    redis: filtrar(redis),
    waha: filtrar(waha),
    openwa: filtrar(openwa),
  };

  const anyDown = Object.values(checks).some((c) => c.status === "down");
  const anyDegraded = Object.values(checks).some((c) => c.status === "degraded");
  const status: "healthy" | "degraded" | "unhealthy" = anyDown
    ? "unhealthy"
    : anyDegraded
      ? "degraded"
      : "healthy";

  const httpStatus = status === "unhealthy" ? 503 : 200;

  return NextResponse.json(
    {
      data: {
        status,
        // APP_VERSION é injetada no build da imagem (ARG no Dockerfile) e vale
        // "1.2.3" numa release, ou o SHA curto fora de tag.
        //
        // Antes isto era `process.env.npm_package_version ?? "0.1.0"`, e a
        // variável só existe quando o processo nasce de um `npm`/`pnpm run`. O
        // CMD da imagem é `node server.js`: TODA instalação do mundo reportava
        // "0.1.0". Um campo que responde o valor errado com confiança é pior que
        // um campo ausente — ele desliga a pergunta em vez de deixá-la aberta.
        // Por isso o fallback agora é "desconhecido", e não um número plausível.
        version: process.env.APP_VERSION || "desconhecido",
        timestamp: new Date().toISOString(),
        checks,
      },
    },
    { status: httpStatus },
  );
}
