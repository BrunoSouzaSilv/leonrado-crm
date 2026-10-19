/**
 * GET /api/v1/openwa/qr?session=&renovar= — QR da sessão (?session ou a ativa).
 * Só manager+.
 *
 * ─── Por que renova o QR sozinho ───────────────────────────────────────────
 * Medido contra o painel v0.23.x: `GET /sessions/:id/qr` devolve o MESMO
 * `qrCode` estático enquanto a sessão vive, mas o WhatsApp expira o código em
 * ~20-60s. Depois disso o painel às vezes segue servindo a MESMA imagem morta —
 * e a tela mostra um QR que o celular rejeita com "código expirado". Quem
 * opera lê isso como "não gera o QR", porque na tela há um QR que não funciona.
 *
 * ─── Por que NÃO espera o QR novo dentro da requisição ─────────────────────
 * Parar + iniciar o motor leva ~8s para emitir o código novo (medido), e o
 * polling de renovação dispara mais 12 degraus de 4s. Somados, passam de 45s —
 * acima do tempo da função na Vercel, que derruba a chamada com ECONNRESET e
 * deixa a tela sem QR nenhum (medido em produção: foi exatamente o que
 * aconteceu). Esperar dentro da requisição troca um bug por outro.
 *
 * Então o reinício é DISPARADO e a rota responde na hora. A tela já faz
 * polling a cada 15s, e nesse intervalo o motor já religou. O `updatedAt` da
 * sessão, atualizado no reinício, ainda serve de trava: sem ela, cada poll
 * reiniciaria o motor de novo e o QR nunca sairia.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { chaveOpenwa, lerConfigOpenwa } from "@/lib/openwa/config";
import { criarClienteOpenwa, OpenwaHttpError } from "@/lib/openwa/client";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * O reinício fala com o painel quatro vezes — `sessao`, `stop`, `start` e o
 * primeiro `qr` — e esse painel mede 4-9s por chamada quando está lento
 * (medido em produção). Sem folga, a Vercel derruba a função no padrão de 10s
 * com ECONNRESET, e a tela fica sem QR nenhum — era exatamente o que o cliente
 * via. As outras rotas do projeto já declararam a sua; esta ficou de fora.
 */
export const maxDuration = 60;

/**
 * Idade do `updatedAt` mínima para aceitar o QR como atual.
 *
 * O WhatsApp expira o código em ~20-60s, mas o painel também troca o QR sozinho
 * em alguns casos (medido: duas leituras 12s de intervalo devolveram hashes
 * diferentes sem reinício nenhum). Renovar a cada 90s é o ponto que evita servir
 * código morto sem reiniciar o motor a todo instante — o reinício custa ~8s e
 * derruba a sessão por um instante.
 */
const QR_MAX_AGE_MS = 90_000;

export async function GET(req: NextRequest): Promise<Response> {
  const authz = await requireRole("manager", { resource: "openwa_config" });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  const cfg = await lerConfigOpenwa(admin, authz.org.orgId);
  const chave = await chaveOpenwa(admin, cfg);
  if (!cfg.base_url || !chave) return fail("not_configured", "OpenWA não configurado.", 409);
  const session = req.nextUrl.searchParams.get("session") || cfg.session_id || undefined;
  if (!session) return fail("no_session", "Escolha a sessão ativa primeiro.", 409);
  const forcar = req.nextUrl.searchParams.get("renovar") === "1";

  const cliente = criarClienteOpenwa(cfg.base_url, chave);
  try {
    const sessao = await cliente.sessao(session).catch(() => null);
    const parada = sessao?.status === "disconnected" || sessao?.status === "stopped";
    const idade = sessao?.updatedAt ? Date.now() - Date.parse(sessao.updatedAt) : Infinity;
    // Com a sessão conectada não há QR a servir — e reiniciar desconectaria o
    // WhatsApp do cliente no meio do atendimento.
    const conectada = sessao?.status === "ready";
    const vencido = !conectada && (forcar || parada || idade > QR_MAX_AGE_MS);

    if (vencido) {
      // Dispara e responde. O `updatedAt` fresco que o reinício deixa é o que
      // impede o próximo poll (15s) de reiniciar de novo.
      await cliente.reiniciarSessao(session);
      return ok({ qr: null, reiniciando: true });
    }

    const qr = await cliente.qr(session).catch(() => null);
    if (!qr) return fail("qr_unavailable", "QR ainda não disponível — aguarde o motor subir.", 409);
    return ok({ qr, reiniciando: false });
  } catch (e) {
    const status = e instanceof OpenwaHttpError ? e.status : null;
    return fail("upstream", e instanceof Error ? e.message : String(e), status === 404 ? 404 : 502);
  }
}
