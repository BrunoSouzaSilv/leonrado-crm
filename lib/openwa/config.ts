/**
 * Configuração OpenWA por organização — `organizations.settings->'openwa'`.
 *
 * DE PROPÓSITO fora de `channel_sessions`: a linha de sessão do canal (com o
 * provider `openwa` liberado na migration 0490) guarda o VÍNCULO número↔org;
 * aqui mora o ACESSO (base + chave cifrada + sessão ativa + token do webhook).
 * Chave cifrada em repouso com a infra de `lib/webhooks/secrets`
 * (`fn_encrypt_oauth`/`fn_decrypt_oauth`, só service_role).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface OpenwaConfig {
  base_url: string;
  /** Hex cifrado (bytea) — nunca plaintext no banco. */
  api_key_encrypted: string | null;
  session_id: string | null;
  webhook_token: string | null;
}

const VAZIA: OpenwaConfig = {
  base_url: "",
  api_key_encrypted: null,
  session_id: null,
  webhook_token: null,
};

function comoConfig(valor: unknown): OpenwaConfig {
  if (!valor || typeof valor !== "object") return { ...VAZIA };
  const v = valor as Record<string, unknown>;
  return {
    base_url: typeof v.base_url === "string" ? v.base_url : "",
    api_key_encrypted: typeof v.api_key_encrypted === "string" ? v.api_key_encrypted : null,
    session_id: typeof v.session_id === "string" ? v.session_id : null,
    webhook_token: typeof v.webhook_token === "string" ? v.webhook_token : null,
  };
}

/** Lê com MERGE defensivo (nunca confia no jsonb cru). */
export async function lerConfigOpenwa(
  admin: SupabaseClient,
  organizationId: string,
): Promise<OpenwaConfig> {
  const { data } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  const settings = ((data?.settings ?? {}) as Record<string, unknown>) || {};
  return comoConfig(settings.openwa);
}

/**
 * Grava com MERGE (nunca sobrescreve o resto do settings — mesma regra da
 * rota de provedores de IA). Chave em branco preserva a cifrada existente.
 */
export async function salvarConfigOpenwa(
  admin: SupabaseClient,
  organizationId: string,
  patch: {
    base_url?: string;
    apiKey?: string;
    session_id?: string | null;
    webhook_token?: string;
  },
): Promise<{ error: string | null }> {
  const { data: orgAtual } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  const settingsAtuais = ((orgAtual?.settings ?? {}) as Record<string, unknown>) || {};
  const atual = comoConfig(settingsAtuais.openwa);

  let apiKeyEncrypted = atual.api_key_encrypted;
  if (patch.apiKey !== undefined) {
    if (patch.apiKey.trim().length === 0) {
      apiKeyEncrypted = atual.api_key_encrypted;
    } else {
      const enc = await encryptWebhookSecret(admin, patch.apiKey.trim());
      if (enc === null) return { error: "cipher_unavailable" };
      apiKeyEncrypted = enc.replace(/^\\x/, "");
    }
  }

  const settings = {
    ...settingsAtuais,
    openwa: {
      base_url: patch.base_url?.trim() || atual.base_url,
      api_key_encrypted: apiKeyEncrypted,
      session_id: patch.session_id !== undefined ? patch.session_id : atual.session_id,
      webhook_token: patch.webhook_token?.trim() || atual.webhook_token,
    } satisfies OpenwaConfig,
  };

  const { data: gravado, error } = await admin
    .from("organizations")
    .update({ settings })
    .eq("id", organizationId)
    .select("id")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!gravado) return { error: "nothing_saved" };
  return { error: null };
}

/** Decifra a chave para uso server-side. null = sem chave utilizável. */
export async function chaveOpenwa(
  admin: SupabaseClient,
  cfg: OpenwaConfig,
): Promise<string | null> {
  if (!cfg.api_key_encrypted) return null;
  return decryptWebhookSecret(admin, cfg.api_key_encrypted);
}

/**
 * Resolve a organização dona de um webhook_token (rota pública de ingestão).
 * Sem índice novo: filtra no JS as orgs que TÊM bloco openwa — volume baixo;
 * se virar gargalo, vira tabela própria na Fase 3 do seam.
 */
export async function orgPorWebhookToken(
  admin: SupabaseClient,
  token: string,
): Promise<{ id: string; config: OpenwaConfig } | null> {
  const { data } = await admin
    .from("organizations")
    .select("id, settings")
    .not("settings->openwa", "is", null);
  for (const row of (data ?? []) as { id: string; settings: unknown }[]) {
    const cfg = comoConfig((row.settings as Record<string, unknown>)?.openwa);
    if (cfg.webhook_token && cfg.webhook_token === token)
      return { id: row.id, config: cfg };
  }
  return null;
}
