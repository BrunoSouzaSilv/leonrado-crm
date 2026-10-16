/**
 * POST /api/v1/webhooks/openwa/[token] — ingestão do gateway OpenWA.
 *
 * Token no path = a amarração com a organização (mesmo desenho das demais
 * rotas de entrada): sem ele, quem conhecesse o painel escreveria em qualquer
 * tenant. Sem handshake nem HMAC nesta fatia — o segredo HMAC do painel entra
 * na Fase 3 com a verificação de assinatura; o token aleatório por org é a
 * autenticação da v1.
 *
 * Corpo esperado (envelope `message.received` do painel):
 *   { "event": "message.received", "data": { ...mensagem... } }
 * Aceita também a mensagem nua (sem envelope) — o painel e os testes de
 * integração variam. Idempotente por (organization_id, external_id).
 */
import { NextResponse, type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { garantirLinhaDeSessao, ingerirMensagem, mapearMensagemOpenwa } from "@/lib/openwa/ingest";
import { chaveOpenwa, lerConfigOpenwa, orgPorWebhookToken } from "@/lib/openwa/config";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const { token } = await ctx.params;
  const admin = createAdminClient();
  const dono = await orgPorWebhookToken(admin, token);
  if (!dono) return fail("not_found", "webhook desconhecido", 404);

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return fail("invalid_body", "corpo inválido", 400);
  }
  const rec = (corpo ?? {}) as Record<string, unknown>;
  const evento = typeof rec.event === "string" ? rec.event : "";
  const msgBruta =
    rec.data && typeof rec.data === "object" ? (rec.data as Record<string, unknown>) : rec;
  if (evento && evento !== "message.received" && evento !== "message") {
    // Acks, status de sessão etc.: 200 sem efeito (o painel reentrega 4xx).
    return ok({ ignored: evento });
  }

  const cfg = dono.config;
  // Número próprio: o campo `to` do evento (para quem a mensagem foi) quando
  // presente; sem ele, o descarte cai só no fromMe do payload.
  const para = msgBruta.to;
  const proprios = typeof para === "string" ? para.replace(/\D/g, "") : "";

  const mapeada = mapearMensagemOpenwa(msgBruta, proprios);
  if ("ignorar" in mapeada) {
    logger.info("openwa.webhook: evento ignorado", { motivo: mapeada.ignorar });
    return ok({ ignored: mapeada.ignorar });
  }

  const linha = await garantirLinhaDeSessao(
    admin,
    dono.id,
    cfg.session_id ?? "desconhecida",
    null,
    null,
  );
  const { conversaId, mensagemId } = await ingerirMensagem(admin, dono.id, linha.id, mapeada.evento);
  return ok({ conversaId, mensagemId });
}
