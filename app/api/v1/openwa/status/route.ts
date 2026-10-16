/**
 * GET /api/v1/openwa/status — sessões do painel + qual é a ativa. Só manager+.
 * Nunca devolve a chave.
 */
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { chaveOpenwa, lerConfigOpenwa } from "@/lib/openwa/config";
import { criarClienteOpenwa } from "@/lib/openwa/client";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const authz = await requireRole("manager", { resource: "openwa_config" });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  const cfg = await lerConfigOpenwa(admin, authz.org.orgId);
  if (!cfg.base_url) return fail("not_configured", "OpenWA não configurado.", 409);
  const chave = await chaveOpenwa(admin, cfg);
  if (!chave) return fail("no_key", "Cadastre a chave do painel.", 409);
  try {
    const sessoes = await criarClienteOpenwa(cfg.base_url, chave).sessoes();
    return ok({
      ativa: cfg.session_id,
      itens: sessoes.map((s) => ({
        id: s.id,
        nome: s.name,
        status: s.status,
        telefone: s.phone ?? null,
      })),
    });
  } catch (e) {
    return fail("upstream", e instanceof Error ? e.message : String(e), 502);
  }
}
