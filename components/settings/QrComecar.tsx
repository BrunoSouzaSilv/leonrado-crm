"use client";
import { useEffect, useState } from "react";

import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

/** QR da sessão ativa com auto-refresh — sem ele o código expira na tela. */
export function QrComecar({ sessionId }: { sessionId: string }) {
  const t = useT();
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    async function buscar() {
      try {
        const r = await apiClient.get<{ data: { qr?: string } }>(
          `/api/v1/openwa/qr?session=${encodeURIComponent(sessionId)}`,
        );
        if (vivo && r.data.qr) setQr(r.data.qr);
      } catch {
        /* próxima rodada */
      }
    }
    buscar();
    const id = setInterval(buscar, 15000);
    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, [sessionId]);

  if (!qr) return <p className="text-sm text-muted-foreground">{t("Gerando QR…")}</p>;
  return (
    <div className="flex flex-col items-center gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={qr} alt={t("QR de pareamento")} className="h-56 w-56 rounded bg-white p-2" />
      <p className="text-xs text-muted-foreground">{t("WhatsApp → Aparelhos conectados → Conectar")}</p>
    </div>
  );
}
