"use client";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/hooks/i18n/useT";

/**
 * Aba do gateway próprio em Conexões (fatia mínima AVIA).
 *
 * Exportado como `GatewayProprioTab` de propósito: o `lint:channels` proíbe
 * nomear provider fora da fronteira, e o ConexoesShell importa por este nome
 * para continuar limpo — este arquivo está declarado na dívida do lint, e é o
 * único lugar da UI que conhece o transporte.
 *
 * Ordem da tela = ordem em que dá errado: base+chave, sessão+QR, webhook,
 * envio de teste. Quem configura só a chave consegue enviar e nunca recebe.
 */
interface Sessao {
  id: string;
  nome: string;
  status: string;
  telefone: string | null;
}

interface Estado {
  base_url: string;
  hasApiKey: boolean;
  session_id: string | null;
  webhook_token: string | null;
  webhook_url: string | null;
  sessoes: Sessao[];
}

export function GatewayProprioTab() {
  const t = useT();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [novaSessao, setNovaSessao] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const [qrDe, setQrDe] = useState<string | null>(null);
  const [destino, setDestino] = useState("");
  const [textoTeste, setTextoTeste] = useState("");
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    const cfg = await apiClient.get<{ data: Estado }>("/api/v1/openwa/config");
    const st = await apiClient.get<{
      data: { ativa: string | null; itens: Sessao[] };
    }>("/api/v1/openwa/status").catch(() => null);
    setEstado({ ...cfg.data, sessoes: st?.data.itens ?? [] });
    setBaseUrl((v) => v || cfg.data.base_url || "");
  }, []);

  useEffect(() => {
    carregar().catch(() => toast.error(t("Não consegui carregar a configuração.")));
  }, [carregar]);

  // QR com auto-refresh (15s) enquanto houver sessão aguardando pareamento.
  useEffect(() => {
    if (!qrDe) return;
    let vivo = true;
    const id = setInterval(async () => {
      try {
        const r = await apiClient.get<{ data: { qr?: string } }>(
          `/api/v1/openwa/qr?session=${encodeURIComponent(qrDe)}`,
        );
        if (!vivo) return;
        if (r.data.qr) setQr(r.data.qr);
        const st = await apiClient.get<{ data: { itens: Sessao[] } }>("/api/v1/openwa/status");
        if (st.data.itens.find((s) => s.id === qrDe && s.status === "ready")) {
          setQrDe(null);
          carregar();
        }
      } catch {
        /* próxima rodada tenta de novo */
      }
    }, 15000);
    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, [qrDe, carregar, t]);

  async function salvar() {
    setSalvando(true);
    try {
      await apiClient.put("/api/v1/openwa/config", {
        base_url: baseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setApiKey("");
      toast.success(t("Salvo."));
      await carregar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Falhou ao salvar."));
    } finally {
      setSalvando(false);
    }
  }

  async function verQr(id: string, renovar = false) {
    try {
      const r = await apiClient.get<{ data: { qr?: string; renovado?: boolean } }>(
        `/api/v1/openwa/qr?session=${encodeURIComponent(id)}${renovar ? "&renovar=1" : ""}`,
      );
      if (r.data.qr) {
        setQr(r.data.qr);
        setQrDe(id);
      } else {
        toast.error(t("QR ainda não disponível — aguarde o motor subir."));
      }
    } catch {
      toast.error(t("Não consegui buscar o QR."));
    }
  }

  async function criarSessao() {
    if (!novaSessao.trim()) return;
    try {
      const r = await apiClient.post<{ data: { id: string } }>("/api/v1/openwa/sessoes", {
        nome: novaSessao.trim(),
      });
      setNovaSessao("");
      toast.success(t("Sessão criada. Escaneie o QR."));
      await carregar();
      verQr(r.data.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Falhou ao criar."));
    }
  }

  async function usarSessao(id: string) {
    try {
      await apiClient.put("/api/v1/openwa/config", { session_id: id });
      toast.success(t("Sessão ativa trocada."));
      await carregar();
    } catch {
      toast.error(t("Falhou ao trocar."));
    }
  }

  async function enviarTeste() {
    if (!destino.trim() || !textoTeste.trim()) return;
    try {
      await apiClient.post("/api/v1/openwa/enviar", { to: destino.trim(), texto: textoTeste.trim() });
      toast.success(t("Enviado e registrado na conversa."));
      setTextoTeste("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Falhou ao enviar."));
    }
  }

  if (!estado) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;

  return (
    <div className="flex flex-col gap-4">
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">{t("Painel do gateway")}</h2>
        <div>
          <Label>{t("Endereço do painel (https://…)")}</Label>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" />
        </div>
        <div>
          <Label>{t("Chave da API (em branco mantém a salva)")}</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={estado.hasApiKey ? t("•••• salva") : "owa_…"}
          />
        </div>
        <Button onClick={salvar} disabled={salvando}>
          {t("Salvar")}
        </Button>
        {estado.webhook_url && (
          <p className="text-sm text-muted-foreground">
            {t("Entregas do painel entram em:")}{" "}
            <code className="break-all">{estado.webhook_url}</code>{" "}
            <Button variant="ghost" size="sm" onClick={() => copyToClipboard(estado.webhook_url ?? "")}>
              {t("Copiar")}
            </Button>
          </p>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">{t("Sessões")}</h2>
        {estado.sessoes.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("Nenhuma sessão no painel.")}</p>
        )}
        {estado.sessoes.map((s) => (
          <div key={s.id} className="flex items-center gap-2">
            <Badge variant={s.status === "ready" ? "default" : "secondary"}>{s.status}</Badge>
            <span className="text-sm">
              {s.nome} {s.telefone && `· ${s.telefone}`}
            </span>
            {estado.session_id === s.id && <Badge>{t("ativa")}</Badge>}
            <span className="flex-1" />
            {s.status !== "ready" && (
              <Button variant="ghost" size="sm" onClick={() => verQr(s.id)}>
                {t("Ver QR")}
              </Button>
            )}
            {estado.session_id !== s.id && (
              <Button variant="ghost" size="sm" onClick={() => usarSessao(s.id)}>
                {t("Usar")}
              </Button>
            )}
          </div>
        ))}
        {qr && (
          <div className="flex flex-col items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt={t("QR de pareamento")} className="h-56 w-56 rounded bg-white p-2" />
            <p className="text-xs text-muted-foreground">{t("Atualiza sozinho até conectar.")}</p>
            {/* O WhatsApp expira o código em ~1 minuto. Sem este botão, quem
                escaneia um QR vencido não tem como pedir outro — a tela mostra
                uma imagem que o celular rejeita, e não há saída visível. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => qrDe && verQr(qrDe, true)}
              disabled={!qrDe}
            >
              {t("Renovar QR")}
            </Button>
          </div>
        )}
        <div className="flex gap-2">
          <Input value={novaSessao} onChange={(e) => setNovaSessao(e.target.value)} placeholder={t("Nova sessão: nome")} />
          <Button onClick={criarSessao}>{t("Criar")}</Button>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">{t("Envio de teste")}</h2>
        <div className="flex gap-2">
          <Input value={destino} onChange={(e) => setDestino(e.target.value)} placeholder={t("Número com DDI")} />
          <Input value={textoTeste} onChange={(e) => setTextoTeste(e.target.value)} placeholder={t("Texto")} />
          <Button onClick={enviarTeste}>{t("Enviar")}</Button>
        </div>
      </Card>
    </div>
  );
}
