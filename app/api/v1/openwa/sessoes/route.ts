/**
 * POST /api/v1/openwa/sessoes {nome} — cria + liga o motor + ativa na org.
 * Só admin (cria custo/lado no painel).
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { chaveOpenwa, lerConfigOpenwa, salvarConfigOpenwa } from "@/lib/openwa/config";
import { criarClienteOpenwa, OpenwaHttpError } from "@/lib/openwa/client";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function clienteDaOrg(orgId: string) {
  const admin = createAdminClient();
  const cfg = await lerConfigOpenwa(admin, orgId);
  if (!cfg.base_url) return { erro: "not_configured" as const };
  const chave = await chaveOpenwa(admin, cfg);
  if (!chave) return { erro: "no_key" as const };
  return { admin, cfg, cliente: criarClienteOpenwa(cfg.base_url, chave) };
}

export async function POST(req: NextRequest): Promise<Response> {
  const authz = await requireRole("admin", { resource: "openwa_config" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const corpo = (await req.json().catch(() => null)) as { nome?: string } | null;
  const nome = corpo?.nome?.trim() ?? "";
  if (!nome) return fail("invalid_body", t("Informe o nome da sessão."), 400);
  const pronto = await clienteDaOrg(authz.org.orgId);
  if ("erro" in pronto)
    return fail(pronto.erro === "no_key" ? "no_key" : "not_configured", t("Configure base e chave primeiro."), 409);
  try {
    const criada = await pronto.cliente.criarSessao(nome);
    pronto.cliente.iniciarSessao(criada.id);
    const { error } = await salvarConfigOpenwa(pronto.admin, authz.org.orgId, {
      session_id: criada.id,
    });
    if (error) return fail("save_failed", error, 500);
    await audit({
      action: "openwa.config_updated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      metadata: { sessao: criada.id },
    });
    return ok({ id: criada.id, nome: criada.name, status: criada.status });
  } catch (e) {
    if (e instanceof OpenwaHttpError && e.status === 409)
      return fail("name_taken", t("Já existe sessão com esse nome."), 409);
    return fail("upstream", e instanceof Error ? e.message : String(e), 502);
  }
}
