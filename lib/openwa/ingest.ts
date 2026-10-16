/**
 * Ingestão OpenWA → tabelas do CRM (fatia mínima).
 *
 * Reusa as RPCs atômicas do WhatsApp (`fn_upsert_wa_contact`,
 * `fn_upsert_wa_conversation`) e o carimbo (`fn_mark_conversation_message`):
 * o vínculo número↔org↔conversa é o MESMO de qualquer transporte; só a origem
 * do evento muda. A linha de sessão do canal é a da migration 0490
 * (provider `openwa`), criada sob demanda — sem ela, `channel_session_id`
 * (NOT NULL em conversations/messages) não teria de onde vir.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { parseChatId } from "@/lib/waha/ingest";
import { logger } from "@/lib/logger";

/** Subconjunto do evento `message.received` que a ingestão lê. */
export interface EventoMensagemOpenwa {
  chatId: string;
  texto: string;
  waId: string | null;
  dePropria: boolean;
  enviadaEm: string;
  chatNome: string | null;
}

const digitos = (s: string) => s.replace(/\D/g, "");

/**
 * Mapeia o payload cru para o formato interno, ou `null` com o motivo quando
 * a mensagem não deve virar linha no CRM. Pura e testada — rede nunca entra
 * aqui.
 */
export function mapearMensagemOpenwa(
  bruto: Record<string, unknown>,
  digitosProprios: string,
): { evento: EventoMensagemOpenwa } | { ignorar: string } {
  const chatId = typeof bruto.chatId === "string" ? bruto.chatId : "";
  if (!chatId) return { ignorar: "sem_chat_id" };
  const identidade = parseChatId(chatId);
  if (identidade.kind !== "phone" && identidade.kind !== "lid") {
    return { ignorar: identidade.kind === "group" ? "grupo" : "chat_desconhecido" };
  }
  const fromMe =
    bruto.fromMe === true ||
    bruto.from_me === true ||
    bruto.fromMe === "true" ||
    bruto.self === true;
  const de = typeof bruto.from === "string" ? bruto.from : "";
  if (fromMe || (digitosProprios && de && digitos(de).endsWith(digitosProprios))) {
    return { ignorar: "propria" };
  }
  const texto = typeof bruto.body === "string" ? bruto.body : typeof bruto.text === "string" ? bruto.text : "";
  if (!texto.trim()) return { ignorar: "sem_texto" };
  const ts = typeof bruto.timestamp === "number" ? new Date(bruto.timestamp * 1000).toISOString() : new Date().toISOString();
  return {
    evento: {
      chatId,
      texto,
      waId:
        typeof bruto.waMessageId === "string"
          ? bruto.waMessageId
          : typeof bruto.id === "string"
            ? bruto.id
            : null,
      dePropria: false,
      enviadaEm: ts,
      chatNome: typeof bruto.chatName === "string" ? bruto.chatName : null,
    },
  };
}

interface SessaoCanal {
  id: string;
}

/** Acha ou cria a linha `channel_sessions` do número (idempotente). */
export async function garantirLinhaDeSessao(
  admin: SupabaseClient,
  organizationId: string,
  panelSessionId: string,
  telefone: string | null,
  nome: string | null,
): Promise<SessaoCanal> {
  const { data: existente } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("provider", "openwa")
    .eq("openwa_session_id", panelSessionId)
    .maybeSingle();
  if (existente) return { id: (existente as { id: string }).id };
  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: organizationId,
      provider: "openwa",
      openwa_session_id: panelSessionId,
      waha_session_name: panelSessionId,
      webhook_secret_encrypted: "\\x00",
      status: "WORKING",
      phone_number: telefone,
      display_name: nome,
      metadata: { via: "openwa" },
    })
    .select("id")
    .maybeSingle();
  if (error || !data) throw new Error(`sessao_openwa_nao_gravada: ${error?.message ?? "empty"}`);
  return { id: (data as { id: string }).id };
}

/** Persiste uma mensagem inbound mapeada. Retorna null quando dedupada. */
export async function ingerirMensagem(
  admin: SupabaseClient,
  organizationId: string,
  sessaoCanalId: string,
  evento: EventoMensagemOpenwa,
): Promise<{ conversaId: string; mensagemId: string | null }> {
  const identidade = parseChatId(evento.chatId);
  if (identidade.kind !== "phone" && identidade.kind !== "lid") {
    throw new Error("identidade_nao_enderecavel");
  }
  const { data: contatoId, error: errContato } = await admin.rpc("fn_upsert_wa_contact" as never, {
    p_org: organizationId,
    p_kind: identidade.kind,
    p_phone: identidade.kind === "phone" ? canonicalPhoneBR(identidade.phone) : null,
    p_lid: identidade.kind === "lid" ? identidade.lid : null,
    p_chat_id: evento.chatId,
    p_notify: evento.chatNome,
  } as never);
  if (errContato || !contatoId) throw new Error(`contato_openwa: ${errContato?.message ?? "empty"}`);

  const { data: conversaId, error: errConv } = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: organizationId,
    p_contact: contatoId as string,
    p_session: sessaoCanalId,
  } as never);
  if (errConv || !conversaId) throw new Error(`conversa_openwa: ${errConv?.message ?? "empty"}`);

  const { data: mensagem, error: errMsg } = await admin
    .from("messages")
    .insert({
      organization_id: organizationId,
      conversation_id: conversaId as string,
      channel_session_id: sessaoCanalId,
      contact_id: contatoId as string,
      external_id: evento.waId,
      type: "text",
      direction: "inbound",
      status: "delivered",
      body: evento.texto,
      sent_via: "external_device",
      sent_at: evento.enviadaEm,
      delivered_at: new Date().toISOString(),
      metadata: { via: "openwa" },
    })
    .select("id")
    .maybeSingle();
  if (errMsg) {
    // 23505 = unique (organization_id, external_id) já ingerida: dedup, não erro.
    if (errMsg.code === "23505") {
      logger.info("openwa.ingest: inbound ja ingerido, dedup por external_id", {
        organization_id: organizationId,
        external_id: evento.waId,
      });
      return { conversaId: conversaId as string, mensagemId: null };
    }
    throw new Error(`mensagem_openwa: ${errMsg.message}`);
  }
  await admin.rpc("fn_mark_conversation_message", {
    p_conv: conversaId,
    p_direction: "inbound",
    p_preview: evento.texto.slice(0, 120),
    p_at: evento.enviadaEm,
  } as never);
  return { conversaId: conversaId as string, mensagemId: (mensagem as { id: string } | null)?.id ?? null };
}

/**
 * Acha ou cria contato + conversa por telefone (para o envio manual).
 * Reusa as mesmas RPCs do inbound: o vínculo é idêntico, só muda a direção.
 */
export async function garantirConversaPorTelefone(
  admin: SupabaseClient,
  organizationId: string,
  sessaoCanalId: string,
  telefoneE164: string,
  nome: string | null,
): Promise<{ conversaId: string; contatoId: string }> {
  const { data: contatoId, error: errContato } = await admin.rpc("fn_upsert_wa_contact" as never, {
    p_org: organizationId,
    p_kind: "phone",
    p_phone: telefoneE164,
    p_lid: null,
    p_chat_id: null,
    p_notify: nome,
  } as never);
  if (errContato || !contatoId) throw new Error(`contato_openwa: ${errContato?.message ?? "empty"}`);
  const { data: conversaId, error: errConv } = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: organizationId,
    p_contact: contatoId as string,
    p_session: sessaoCanalId,
  } as never);
  if (errConv || !conversaId) throw new Error(`conversa_openwa: ${errConv?.message ?? "empty"}`);
  return { conversaId: conversaId as string, contatoId: contatoId as string };
}

/** Registra uma mensagem de SAÍDA (manual ou teste) na conversa. */
export async function registrarSaida(
  admin: SupabaseClient,
  organizationId: string,
  sessaoCanalId: string,
  conversaId: string,
  contatoId: string,
  texto: string,
  waId: string | null,
): Promise<string | null> {
  const agora = new Date().toISOString();
  const { data: mensagem, error } = await admin
    .from("messages")
    .insert({
      organization_id: organizationId,
      conversation_id: conversaId,
      channel_session_id: sessaoCanalId,
      contact_id: contatoId,
      external_id: waId,
      type: "text",
      direction: "outbound",
      status: "sent",
      body: texto,
      sent_via: "user",
      sent_at: agora,
      delivered_at: agora,
      metadata: { via: "openwa" },
    })
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`saida_openwa: ${error.message}`);
  await admin.rpc("fn_mark_conversation_message", {
    p_conv: conversaId,
    p_direction: "outbound",
    p_preview: texto.slice(0, 120),
    p_at: agora,
  } as never);
  return (mensagem as { id: string } | null)?.id ?? null;
}
