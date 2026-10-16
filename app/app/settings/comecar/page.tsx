/**
 * GET /app/settings/comecar — configuração inicial guiada (hub AVIA).
 *
 * Três passos na ordem em que dão errado: WhatsApp (com QR inline da sessão
 * ativa), IA (provedor em vigor) e teste ponta a ponta. Cada cartão leva à
 * tela definitiva; este hub não duplica configuração, só orienta.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { QrComecar } from "@/components/settings/QrComecar";
import { chaveOpenwa, lerConfigOpenwa } from "@/lib/openwa/config";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Começar" };

export default async function ComecarPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");
  const idioma = user.idioma;

  const admin = createAdminClient();
  const cfg = await lerConfigOpenwa(admin, activeOrg.orgId);
  const chave = await chaveOpenwa(admin, cfg);
  const whatsappOk = Boolean(cfg.base_url && chave && cfg.session_id);

  const { data: org } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  const provedorIA =
    ((org?.settings as Record<string, unknown> | null)?.llm as { provider?: string } | undefined)
      ?.provider ?? null;

  const passos = [
    {
      n: 1,
      titulo: traduzir("Conecte o WhatsApp", idioma),
      desc: traduzir("Pareie a sessão e receba mensagens no Inbox.", idioma),
      pronto: whatsappOk,
      href: "/app/connections?aba=gateway",
    },
    {
      n: 2,
      titulo: traduzir("Escolha a IA", idioma),
      desc: traduzir("Provedor e modelo que atendem seus clientes.", idioma),
      pronto: Boolean(provedorIA),
      href: "/app/ai/providers",
    },
    {
      n: 3,
      titulo: traduzir("Teste de ponta a ponta", idioma),
      desc: traduzir("Envie uma mensagem para o número e responda pelo Inbox.", idioma),
      pronto: false,
      href: "/app/inbox",
    },
  ];

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Começar", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Três passos até o primeiro atendimento.", idioma)}
        </p>
      </header>
      <ol className="flex flex-col gap-4">
        {passos.map((p) => (
          <li key={p.n} className="rounded-lg border p-4">
            <div className="flex items-center gap-3">
              <span
                className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
                  p.pronto ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}
              >
                {p.pronto ? "✓" : p.n}
              </span>
              <div className="flex-1">
                <h2 className="font-semibold">{p.titulo}</h2>
                <p className="text-sm text-muted-foreground">{p.desc}</p>
              </div>
              <Link href={p.href} className="text-sm font-medium text-primary hover:underline">
                {traduzir("Abrir", idioma)}
              </Link>
            </div>
            {p.n === 1 && cfg.session_id && chave && cfg.base_url && <QrComecar sessionId={cfg.session_id} />}
          </li>
        ))}
      </ol>
    </div>
  );
}
