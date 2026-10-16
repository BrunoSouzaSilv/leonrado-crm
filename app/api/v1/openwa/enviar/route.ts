/**
 * POST /api/v1/openwa/enviar {to, texto, nome?} — envio manual de teste.
 * Envia pelo painel e REGISTRA a saída na conversa (mesmo vínculo do
 * inbound). Só manager+.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { chaveOpenwa, lerConfigOpenwa } from "@/lib/openwa/config";
import { criarClienteOpenwa, OpenwaHttpError } from "@/lib/openwa/client";
import {
  garantirConversaPorTelefone,
  garantirLinhaDeSessao,
  registrarSaida,
} from "@/lib/openwa/ingest";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const authz = await requireRole("manager", { resource: "openwa_config" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const corpo = (await req.json().catch(() => null)) as {
    to?: string;
    texto?: string;
    nome?: string;
  } | null;
  const digitos = String(corpo?.to ?? "").replace(/\D/g, "");
  const texto = corpo?.texto?.trim() ?? "";
  if (digitos.length < 10 || !texto) {
    return fail("invalid_body", t("Informe o número com DDI e o texto."), 400);
  }

  const admin = createAdminClient();
  const cfg = await lerConfigOpenwa(admin, authz.org.orgId);
  const chave = await chaveOpenwa(admin, cfg);
  if (!cfg.base_url || !chave || !cfg.session_id) {
    return fail("not_configured", t("Configure base, chave e sessão ativa primeiro."), 409);
  }
  const cliente = criarClienteOpenwa(cfg.base_url, chave);
  const chatId = `${digitos}@c.us`;
  try {
    const recibo = (await cliente.enviarTexto(cfg.session_id, chatId, texto)) as {
      messageId?: string;
    };
    const linha = await garantirLinhaDeSessao(admin, authz.org.orgId, cfg.session_id, null, null);
    const { conversaId, contatoId } = await garantirConversaPorTelefone(
      admin,
      authz.org.orgId,
      linha.id,
      `+${digitos}`,
      corpo?.nome?.trim() || null,
    );
    const mensagemId = await registrarSaida(
      admin,
      authz.org.orgId,
      linha.id,
      conversaId,
      contatoId,
      texto,
      typeof recibo.messageId === "string" ? recibo.messageId : null,
    );
    await audit({
      action: "openwa.envio_manual",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      metadata: { conversa: conversaId },
    });
    return ok({ conversaId, mensagemId });
  } catch (e) {
    const status = e instanceof OpenwaHttpError ? e.status : null;
    return fail("upstream", e instanceof Error ? e.message : String(e), status === 404 ? 404 : 502);
  }
}
