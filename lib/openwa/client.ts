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
  /**
   * Última transição de estado vista pelo painel (ISO). Medido no v0.23.x.
   *
   * É a única fonte de IDADE do QR: o painel não expõe quando emitiu o
   * código, e devolve o mesmo `qrCode` estático enquanto a sessão vive. Sem
   * esta data, a rota do QR não tem como saber que o código já venceu.
   */
  updatedAt?: string;
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
    /**
     * Para e religa o motor da sessão.
     *
     * ─── Por que isto existe ─────────────────────────────────────────────────
     * Medido contra o painel v0.23.x: `GET /sessions/:id/qr` devolve o MESMO
     * `qrCode` estático enquanto a sessão vive — o hash não muda de uma chamada
     * para a outra. O WhatsApp, porém, expira o código em ~20-60s. Depois
     * disso o painel segue servindo a MESMA imagem morta, e o app mostra um QR
     * que o celular rejeita com "código expirado" — o usuário lê como "não
     * gera o QR", porque na tela há um QR que não funciona.
     *
     * Parar e iniciar gera um código novo em ~8s (medido: hash trocou). É o
     * único caminho que o painel expõe para renovar — não há endpoint de
     * refresh.
     *
     * ─── Por que não espera o `start` ──────────────────────────────────────
     * Medido no painel: `stop` responde em ~1.4s, mas `start` não responde
     * nem em 30s — estoura o timeout da função e a tela fica sem QR nenhum
     * (ECONNRESET, confirmado em produção). O `start` é fire-and-forget: o
     * painel dispara o motor em background e segue sem responder. Então só o
     * `stop` é aguardado; o `start` é emitido e esquecido, e o `updatedAt`
     * fresco que ele deixa é o que impede a rota de reiniciar de novo.
     */
    async reiniciarSessao(id: string): Promise<void> {
      await fetch(url(`/api/sessions/${id}/stop`), {
        method: "POST",
        headers,
        body: "{}",
        ...comTempo(),
      }).catch(() => {});
      void fetch(url(`/api/sessions/${id}/start`), {
        method: "POST",
        headers,
        body: "{}",
        ...comTempo(),
      }).catch(() => {});
    },
    /** Estado crua da sessão, para a rota do QR decidir se precisa renovar. */
    async sessao(id: string): Promise<OpenwaSession> {
      const res = await fetch(url(`/api/sessions/${id}`), { headers, ...comTempo() });
      return (await ler(res, "sessao")) as unknown as OpenwaSession;
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
