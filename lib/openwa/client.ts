/**
 * Cliente REST do painel OpenWA (transporte). Sem regra de negócio aqui.
 *
 * Endpoints medidos contra o painel real (v0.23.x):
 *   GET  /api/sessions
 *   POST /api/sessions {name}            → 201 (409 nome repetido)
 *   POST /api/sessions/:id/start         (liga o motor; demora ~1 min)
 *   GET  /api/sessions/:id/qr            → {qrCode: "data:image/png;base64,…"}
 *   GET  /api/sessions/:id/messages?limit=N → {messages: [...]}
 *   POST /api/sessions/:id/messages/send-text {chatId, text}
 */
const TEMPO_LIMITE_MS = 45000;

export class OpenwaHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

async function ler(
  res: Response,
  caminho: string,
): Promise<Record<string, unknown> & { messages?: unknown[] }> {
  if (!res.ok) throw new OpenwaHttpError(`openwa_http_${res.status} em ${caminho}`, res.status);
  return (await res.json()) as Record<string, unknown> & { messages?: unknown[] };
}

function comTempo(): { signal: AbortSignal } {
  return { signal: AbortSignal.timeout(TEMPO_LIMITE_MS) };
}

export interface OpenwaSession {
  id: string;
  name: string;
  status: string;
  phone: string | null;
}

export function criarClienteOpenwa(baseUrl: string, apiKey: string) {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { "X-API-Key": apiKey, "Content-Type": "application/json" };
  const url = (p: string) => `${base}${p}`;

  return {
    async sessoes(): Promise<OpenwaSession[]> {
      const res = await fetch(url("/api/sessions"), { headers, ...comTempo() });
      const j = await ler(res, "sessoes");
      return (Array.isArray(j) ? j : []) as OpenwaSession[];
    },
    async criarSessao(name: string): Promise<OpenwaSession> {
      const res = await fetch(url("/api/sessions"), {
        method: "POST",
        headers,
        body: JSON.stringify({ name }),
        ...comTempo(),
      });
      return (await ler(res, "criarSessao")) as unknown as OpenwaSession;
    },
    /** Liga o motor em segundo plano (fire-and-forget proposital). */
    iniciarSessao(id: string): void {
      fetch(url(`/api/sessions/${id}/start`), {
        method: "POST",
        headers,
        body: "{}",
        ...comTempo(),
      }).catch(() => {});
    },
    async qr(id: string): Promise<string | null> {
      const res = await fetch(url(`/api/sessions/${id}/qr`), { headers, ...comTempo() });
      const j = await ler(res, "qr");
      const qr = (j.qrCode ?? j.qr ?? null) as string | null;
      return typeof qr === "string" && qr.length > 0 ? qr : null;
    },
    async enviarTexto(id: string, chatId: string, text: string): Promise<unknown> {
      const res = await fetch(url(`/api/sessions/${id}/messages/send-text`), {
        method: "POST",
        headers,
        body: JSON.stringify({ chatId, text }),
        ...comTempo(),
      });
      return ler(res, "enviarTexto");
    },
  };
}

export type ClienteOpenwa = ReturnType<typeof criarClienteOpenwa>;
