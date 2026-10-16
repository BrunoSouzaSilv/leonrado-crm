import { describe, expect, it } from "vitest";

import { mapearMensagemOpenwa } from "@/lib/openwa/ingest";

describe("mapearMensagemOpenwa", () => {
  it("mapeia texto inbound de número", () => {
    const r = mapearMensagemOpenwa(
      {
        chatId: "5517992231061@c.us",
        body: "Oi, quero orçamento",
        waMessageId: "abc123",
        from: "5517992231061@c.us",
        timestamp: 1760610000,
      },
      "5511999999999",
    );
    expect("evento" in r && r.evento.texto).toBe("Oi, quero orçamento");
    expect("evento" in r && r.evento.waId).toBe("abc123");
  });

  it("ignora mensagem própria por fromMe e por número", () => {
    expect(mapearMensagemOpenwa({ chatId: "5517992231061@c.us", body: "x", fromMe: true }, "1")).toEqual({
      ignorar: "propria",
    });
    expect(
      mapearMensagemOpenwa({ chatId: "5517992231061@c.us", body: "x", from: "5517992231061@c.us" }, "5517992231061"),
    ).toEqual({ ignorar: "propria" });
  });

  it("ignora grupo, desconhecido, sem texto e sem chat", () => {
    expect(mapearMensagemOpenwa({ chatId: "123@g.us", body: "x" }, "1")).toEqual({ ignorar: "grupo" });
    expect(mapearMensagemOpenwa({ chatId: "x@y.zz", body: "x" }, "1")).toEqual({ ignorar: "chat_desconhecido" });
    expect(mapearMensagemOpenwa({ chatId: "5517992231061@c.us", body: "  " }, "1")).toEqual({
      ignorar: "sem_texto",
    });
    expect(mapearMensagemOpenwa({ body: "x" }, "1")).toEqual({ ignorar: "sem_chat_id" });
  });

  it("usa fallbacks de campo (text, id) e timestamp ausente", () => {
    const r = mapearMensagemOpenwa({ chatId: "5517992231061@c.us", text: "olá", id: "w1" }, "");
    expect("evento" in r && r.evento.texto).toBe("olá");
    expect("evento" in r && r.evento.waId).toBe("w1");
  });
});
