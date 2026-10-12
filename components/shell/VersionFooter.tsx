"use client";
import Link from "next/link";

import { ArrowCircleUp } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { useSystemVersion } from "@/hooks/system/useSystemVersion";
import { cn } from "@/lib/utils";

/**
 * Controle essencial da instalação: não é removível pela interface do vínculo.
 * Versão instalada no rodapé da sidebar. Vira um aviso clicável só para quem
 * é dono do servidor E tem versão nova — quem não pode atualizar não é
 * alertado sobre algo que não pode resolver.
 */
export function VersionFooter({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  /** Fecha a gaveta do mobile — é o único Link do drawer que não a recebia. */
  onNavigate?: () => void;
}) {
  const t = useT();
  const { data } = useSystemVersion();
  if (!data?.current_version) return null;

  const label = data.current_version.replace(/^v/i, "");
  // AVIA — fork travado: nunca oferece atualização. Só exibe a versão.
  const alerta = false;

  if (!alerta) {
    return (
      <div className={cn("space-y-1 px-3 py-1", collapsed && "px-0 text-center")}>
        <p className="text-[11px] text-muted-foreground" title={`${t("Versão")} ${label}`}>
          {collapsed ? label.split(".").slice(0, 2).join(".") : `${t("versão")} ${label}`}
        </p>
        {!collapsed && (
          <p
            className="text-[10px] leading-tight text-muted-foreground/80"
            title="Desenvolvido por Agência Outservice (Dev. Bruno Vitally) · Titularidade e direitos de revenda: Leonardo Silva Santos"
          >
            © 2026 AVIA · Todos os direitos reservados
          </p>
        )}
      </div>
    );
  }

  const novo = data.latest_version?.replace(/^v/i, "") ?? "";
  return (
    <Link
      href="/app/settings/atualizacao"
      onClick={onNavigate}
      title={`${t("Nova versão")} ${novo} ${t("disponível")}`}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-xs text-foreground hover:bg-accent/50",
        collapsed && "justify-center px-2",
      )}
    >
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
      </span>
      {!collapsed && (
        <span className="truncate">
          {t("Nova versão")}
          {novo ? ` · ${novo}` : ""}
        </span>
      )}
      {collapsed && <ArrowCircleUp size={16} aria-hidden />}
    </Link>
  );
}
