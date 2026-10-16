/**
 * GET /api/v1/openwa/config — lê a config (chave NUNCA volta).
 * PUT /api/v1/openwa/config — grava base_url, apiKey, session_id e
 * webhook_token (gera um se vazio). Só manager+.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { lerConfigOpenwa, salvarConfigOpenwa } from "@/lib/openwa/config";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const authz = await requireRole("manager", { resource: "openwa_config" });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  const cfg = await lerConfigOpenwa(admin, authz.org.orgId);
  return ok({
    base_url: cfg.base_url,
    hasApiKey: cfg.api_key_encrypted !== null,
    session_id: cfg.session_id,
    webhook_token: cfg.webhook_token,
    webhook_url: cfg.webhook_token
      ? `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/v1/webhooks/openwa/${cfg.webhook_token}`
      : null,
  });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const authz = await requireRole("admin", { resource: "openwa_config" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const corpo = (await req.json().catch(() => null)) as {
    base_url?: string;
    apiKey?: string;
    session_id?: string | null;
    webhook_token?: string;
  } | null;
  if (!corpo) return fail("invalid_body", t("Corpo inválido."), 400);

  const patch: Parameters<typeof salvarConfigOpenwa>[2] = {};
  if (corpo.base_url !== undefined) {
    const base = corpo.base_url.trim().replace(/\/+$/, "");
    if (base && !/^https?:\/\//i.test(base)) return fail("invalid_base_url", t("Endereço inválido: use http(s)://."), 400);
    patch.base_url = base;
  }
  if (corpo.apiKey !== undefined) patch.apiKey = corpo.apiKey;
  if (corpo.session_id !== undefined) patch.session_id = corpo.session_id?.trim() || null;
  if (corpo.webhook_token !== undefined) {
    patch.webhook_token = corpo.webhook_token.trim() || randomUUID().replace(/-/g, "");
  }

  const admin = createAdminClient();
  const antes = await lerConfigOpenwa(admin, authz.org.orgId);
  if (!antes.webhook_token && patch.webhook_token === undefined) {
    patch.webhook_token = randomUUID().replace(/-/g, "");
  }
  const { error } = await salvarConfigOpenwa(admin, authz.org.orgId, patch);
  if (error === "cipher_unavailable")
    return fail("cipher_unavailable", t("Cifra indisponível: confira a chave de criptografia da instalação."), 422);
  if (error) return fail("save_failed", error, 500);

  await audit({
    action: "openwa.config_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
  });
  const depois = await lerConfigOpenwa(admin, authz.org.orgId);
  return ok({
    base_url: depois.base_url,
    hasApiKey: depois.api_key_encrypted !== null,
    session_id: depois.session_id,
    webhook_token: depois.webhook_token,
  });
}
