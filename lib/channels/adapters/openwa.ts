/**
 * Adapter do canal OpenWA — engine WhatsApp Web auto-hospedada (painel medido
 * em v0.23.x), o transporte da AVIA depois do WAHA sair de cena.
 *
 * Burro de propósito, como os irmãos: traduz formato e nada mais. Janela,
 * limite e horário vivem na cadeia `before_send`
 * (`docs/doctrine/restricao-de-canal.md`).
 *
 * ─── O painel só manda TEXTO, e isto é MEDIDO ───────────────────────────────
 *
 * `lib/openwa/client.ts` lista os endpoints conferidos contra o painel real, e
 * o único de escrita é `POST /api/sessions/:id/messages/send-text`. Não há
 * envio de mídia nem de cartão de contato medida lá — e inventar um caminho
 * não medido seria adivinhar a API de produção de um cliente.
 *
 * Então `send` aceita SÓ `kind: "text"` sem `media` e sem `contact`. O resto
 * LANÇA `openwa_media_unsupported:` e o handler grava a mensagem como `failed`
 * com o motivo — mentir um `sent` num anexo que não saiu deixaria a tela
 * dizendo "entregue" para algo que ficou no servidor.
 *
 * ─── Falta de credencial enfileira, não falha ───────────────────────────────
 *
 * A base e a chave vivem em `organizations.settings->'openwa'`, não no env —
 * um método SÍNCRONO não tem como consultá-las, então `isConfigured` responde
 * `true` e quem sabe é `send` (mesmo raciocínio escrito em `datafy.ts`). Quem
 * lança com o prefixo `openwa_not_configured` cai no ramo que o handler grava
 * como `queued`: a mensagem sai sozinha assim que alguém configurar o canal,
 * em vez de virar falha definitiva.
 */
import { criarClienteOpenwa } from "@/lib/openwa/client";
import { chaveOpenwa, lerConfigOpenwa } from "@/lib/openwa/config";
import { createAdminClient } from "@/lib/supabase/admin";

import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";

const NAO_CONFIGURADO = "openwa_not_configured";
const SEM_MIDIA = "openwa_media_unsupported";

async function clienteDaOrg(organizationId: string) {
  const admin = createAdminClient();
  const cfg = await lerConfigOpenwa(admin, organizationId);
  const chave = await chaveOpenwa(admin, cfg);
  if (!cfg.base_url || !chave) return null;
  return { cfg, cliente: criarClienteOpenwa(cfg.base_url, chave) };
}

export const openwaAdapter: ChannelAdapter = {
  provider: "openwa",

  /**
   * O endereço que `send-text` espera: `<somente dígitos>@c.us` — o mesmo formato
   * que a rota de envio manual já usa contra o painel.
   *
   * Grupos devolvem `null` de propósito, e não é preguiça: a ingestão do app
   * recusa `@g.us` (`identidade_nao_enderecavel`, `lib/openwa/ingest.ts`), então
   * conversa de grupo nem chega a existir por este canal. Prometer endereçamento
   * aqui seria criar um caminho que a outra ponta já recusou.
   */
  resolveRecipient(input: RecipientInput): string | null {
    if (input.isGroup) return null;
    const digitos = String(input.phoneNumber ?? "").replace(/\D/g, "");
    return digitos.length >= 10 ? `${digitos}@c.us` : null;
  },

  /**
   * `true` sempre: base e chave moram no settings da organização e este método
   * é síncrono. Quem de fato sabe é `send`, que consulta o banco e lança
   * `openwa_not_configured` — o handler traduz o prefixo para `queued`.
   */
  isConfigured(): boolean {
    return true;
  },

  codes: {
    notConfigured: NAO_CONFIGURADO,
    sendFailed: "openwa_error",
    unknownError: "openwa_unknown",
  },

  /**
   * Saúde da sessão junto ao painel — `GET /api/sessions` e procura pelo id.
   *
   * O campo `status` é o que o motor relata (`WORKING`, `SCAN_QR`, …), passado
   * intacto: quem lê é a Central, e traduzir para o vocabulário dos demais
   * canais esconderia a diferença real entre "pareado" e "mostrando QR".
   */
  async checkHealth(input: ChannelTenantScope & { sessionRef: string }): Promise<ChannelHealth> {
    let montado: Awaited<ReturnType<typeof clienteDaOrg>>;
    try {
      montado = await clienteDaOrg(input.organizationId);
    } catch (err) {
      return {
        reachable: false,
        status: null,
        detail: (err instanceof Error ? err.message : "erro_desconhecido").slice(0, 200),
      };
    }
    if (!montado) return { reachable: false, status: null, detail: "canal_nao_configurado" };

    try {
      const sessoes = await montado.cliente.sessoes();
      const alvo = sessoes.find((s) => s.id === input.sessionRef);
      if (!alvo) return { reachable: true, status: "NOT_FOUND", detail: "sessao_ausente_no_painel" };
      return { reachable: true, status: alvo.status, detail: null };
    } catch (err) {
      // `reachable: false` e não `FAILED`: não deu para PERGUNTAR (painel fora do
      // ar), que tem ação diferente — religar o serviço, não escanear o QR.
      const detail = err instanceof Error ? err.message : "erro_desconhecido";
      return { reachable: false, status: null, detail: detail.slice(0, 200) };
    }
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    if (envelope.media || envelope.contact || envelope.kind !== "text") {
      throw new Error(
        `${SEM_MIDIA}: o painel OpenWA só expõe messages/send-text (medido em v0.23.x).`,
      );
    }

    const montado = await clienteDaOrg(envelope.organizationId);
    if (!montado) {
      throw new Error(`${NAO_CONFIGURADO}: configure a base, a chave e a sessão ativa primeiro.`);
    }

    // Revalida a origem no último instante — o operador pode ter fechado o canal
    // enquanto a IA gerava a resposta.
    await envelope.beforeSend?.();

    try {
      const recibo = (await montado.cliente.enviarTexto(
        envelope.sessionRef,
        envelope.to,
        envelope.body ?? "",
      )) as { messageId?: string; id?: string; message?: { id?: string } };

      // O painel já devolveu o aceite: reconhecer o envio não é outro envio.
      const externalId =
        (typeof recibo.messageId === "string" && recibo.messageId) ||
        (typeof recibo.id === "string" && recibo.id) ||
        (typeof recibo.message?.id === "string" && recibo.message.id) ||
        null;
      return { externalId };
    } catch (err) {
      // `notConfigured` não acontece aqui (já resolvido acima), então tudo que
      // sobe vira `failed` com o motivo — inclusive painel fora do ar.
      const detalhe = err instanceof Error ? err.message : "erro_desconhecido";
      throw new Error(`openwa_error: ${detalhe}`);
    }
  },
};
