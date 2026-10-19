/**
 * GET /api/v1/openwa/qr?session= — QR da sessão (?session ou a ativa).
 * Só manager+.
 *
 * ─── Por que renova o QR sozinho ───────────────────────────────────────────
 * Medido contra o painel v0.23.x: `GET /sessions/:id/qr` devolve o MESMO
 * `qrCode` estático enquanto a sessão vive (hash idêntico entre chamadas), mas
 * o WhatsApp expira o código em ~20-60s. Depois disso o painel segue servindo
 * a MESMA imagem morta — e a tela mostra um QR que o celular rejeita com
 * "código expirado". Quem opera lê isso como "não gera o QR", porque na tela
 * há um QR que não funciona.
 *
 * Então esta rota mede a IDADE do código pelo `updatedAt` da sessão: se ele
 * está mais velho que 90s e a sessão ainda espera pareamento, reinicia o motor
 * (parar + iniciar = QR novo em ~8s, medido) antes de servir. O `?renovar=1`
 * força a renovação mesmo com o QR "novo", pra quem acabou de escanear e
 * falhou.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { chaveOpenwa, lerConfigOpenwa } from "@/lib/openwa/config";
import { criarClienteOpenwa, OpenwaHttpError } from "@/lib/openwa/client";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Idade máxima do QR antes de renovar. O WhatsApp expira em ~20-60s. */
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
    // A sessão precisa estar iniciada: com ela parada o painel responde 400
    // "Session is not started" (medido), e o app mostraria "QR não disponível"
    // para um caso que tem solução — religar.
    const sessao = await cliente.sessao(session).catch(() => null);
    const parada = sessao?.status === "disconnected" || sessao?.status === "stopped";
    const idade = sessao?.updatedAt ? Date.now() - Date.parse(sessao.updatedAt) : Infinity;
    const vencido = forcar || parada || idade > QR_MAX_AGE_MS;

    if (vencido && sessao?.status !== "ready") {
      await cliente.reiniciarSessao(session);
      // O motor demora ~8s para emitir o novo código (medido). Esperamos em
      // degraus, devolvendo o primeiro QR vivo que aparecer.
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const qr = await cliente.qr(session).catch(() => null);
        if (qr) return ok({ qr, renovado: vencido });
      }
      return fail("qr_unavailable", "A sessão está reiniciando — tente de novo em instantes.", 409);
    }

    const qr = await cliente.qr(session);
    if (!qr) return fail("qr_unavailable", "QR ainda não disponível — aguarde o motor subir.", 409);
    return ok({ qr, renovado: false });
  } catch (e) {
    const status = e instanceof OpenwaHttpError ? e.status : null;
    return fail("upstream", e instanceof Error ? e.message : String(e), status === 404 ? 404 : 502);
  }
}
