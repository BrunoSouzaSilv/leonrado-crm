/**
 * GET /api/v1/openwa/qr?session= — QR da sessão (?session ou a ativa).
 * Só manager+. O QR expira em segundos: a tela atualiza sozinha.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { chaveOpenwa, lerConfigOpenwa } from "@/lib/openwa/config";
import { criarClienteOpenwa, OpenwaHttpError } from "@/lib/openwa/client";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const authz = await requireRole("manager", { resource: "openwa_config" });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  const cfg = await lerConfigOpenwa(admin, authz.org.orgId);
  const chave = await chaveOpenwa(admin, cfg);
  if (!cfg.base_url || !chave) return fail("not_configured", "OpenWA não configurado.", 409);
  const session = req.nextUrl.searchParams.get("session") || cfg.session_id || undefined;
  if (!session) return fail("no_session", "Escolha a sessão ativa primeiro.", 409);
  try {
    const qr = await criarClienteOpenwa(cfg.base_url, chave).qr(session);
    if (!qr) return fail("qr_unavailable", "QR ainda não disponível — aguarde o motor subir.", 409);
    return ok({ qr });
  } catch (e) {
    const status = e instanceof OpenwaHttpError ? e.status : null;
    return fail("upstream", e instanceof Error ? e.message : String(e), status === 404 ? 404 : 502);
  }
}
