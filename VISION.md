# 🧭 Visão — AVIA

> **O sistema operacional de vendas com agentes de IA, nativo no WhatsApp.**
> Este documento é a fonte da verdade do posicionamento do projeto. Tudo que for público (README, site, docs, descrições) deriva daqui.

---

## O nome

**AVIA**: atendimento, vendas e IA num nome só — toda a operação comercial de um negócio — atendimento, qualificação, funil, pós-venda — operada a partir de uma única mesa, por pessoas e por agentes de IA trabalhando juntos.

O "CRM" continua sendo a categoria de entrada, não o teto. O AVIA é **mais que um CRM**: é o sistema onde a venda acontece.

## De onde viemos, pra onde vamos

O projeto nasceu em 2026 como um CRM operacional para **e-commerce brasileiro** — WhatsApp via WAHA, integração Nuvemshop, LGPD nativa. Na operação, o uso se expandiu: a maioria das instalações passou a rodar em **clínicas, infoprodutos, imobiliárias, agências e prestadores de serviço** — qualquer negócio que vende conversando.

Os pedidos de feature dessa operação empurraram o produto na direção que hoje é a nossa identidade: **agentes de IA cada vez mais capazes, integrados ao sistema via MCP, operando o CRM de verdade**. O e-commerce continua sendo um caso de uso de primeira classe (foi nosso berço e a integração Nuvemshop prova isso) — mas ele é **um** vertical, não **o** produto.

**A transição, em uma frase:** de "CRM de e-commerce com IA" para **"sistema operacional de vendas com agentes de IA, para qualquer negócio que vende pelo WhatsApp"**.

## O que acreditamos sobre agentes de IA

1. **Agente que opera, não chatbot que enfeita.** Nosso agente lê contexto real (histórico, perfil, pedido), consulta a base de conhecimento do tenant (RAG por organização), responde, qualifica, move o lead no funil — e é **assignee de primeira classe** no sistema, com as mesmas regras de governança de um atendente humano.

2. **Agentes que se auto-aprimoram.** O sistema é desenhado como um flywheel: conversas resolvidas viram conhecimento novo na base RAG; handoffs pro humano marcam onde o agente ainda não alcança; métricas e budget por tenant fecham o loop. Cada dia de operação torna o agente melhor — com **gate humano** nas decisões que importam. Essa é a aposta central do roadmap.

3. **MCP como sistema nervoso.** O CRM inteiro é exposto como tools MCP — primeiro para os agentes internos, depois como contrato público. Um negócio deve poder plugar o agente que quiser e ele **opera** o AVIA: cria lead, responde cliente, agenda, consulta pedido. O CRM vira infraestrutura para agentes.

4. **Humano no comando.** Handoff auditado, escopo por papel (RBAC), fila com posição, budget de IA por organização. Autonomia do agente cresce na medida em que a governança prova que ele acerta.

## Os pilares do produto

| Pilar | O que significa na prática |
|---|---|
| **Agentes de IA nativos** | RAG por tenant, análise de sentimento, handoff IA→humano auditado, IA como assignee, budget por org |
| **CRM automatizado pela IA** | O agente move leads, aplica tags, dispara automações QUANDO/SE/ENTÃO — o funil anda sozinho |
| **Ferramentas de apoio ao comercial** | Inbox em tempo real, kanban com fractional indexing, customer 360, métricas por atendente, roteamento automático |
| **WhatsApp-native** | WAHA multi-número, anti-banimento, mídia, STOP detection — o canal onde o Brasil vende |
| **Multi-nicho por design** | `vocabulary` configurável por pipeline (lead = Cliente/Paciente/Comprador; won = Pago/Agendado/Fechado) — o mesmo core serve e-commerce, clínica, imobiliária, infoproduto |
| **Self-hosted de verdade** | Seus dados na sua VPS, kit de instalação com 1 comando, `baseline.sql` auto-curativo, atualização com 1 script |
| **Compliance nativo** | Multi-tenant com RLS testada em CI, LGPD by-design (redact, data_request, anonimização), audit append-only |

## Posicionamento

**Categoria de entrada (âncora):** plataforma privada de atendimento e vendas por WhatsApp, com agentes de IA nativos.

**Categoria própria (bandeira):** **sistema operacional de vendas com agentes de IA** — *AI Sales OS*. É pra onde a âncora nos leva: um sistema onde o agente de IA é operador nativo e a operação é sua.

**Uma frase (pt-br):**
> AVIA é o sistema operacional de vendas com agentes de IA nativos e WhatsApp — privado, multi-tenant, para qualquer negócio que vende conversando.

**One-liner (en):**
> AI sales OS: a private CRM where AI agents natively operate sales and support over WhatsApp.

**Público:** negócios que vendem pelo WhatsApp — e-commerce, clínicas, imobiliárias, infoprodutores, agências, serviços.

## Modelo do projeto (sem letra miúda)

- **O software é completo, sem funcionalidade bloqueada.** A operação é privada, no seu servidor.
- **A operação é por infraestrutura privada:** o caminho recomendado de produção é a VPS (datacenter em São Paulo), instalada com 1 comando.
- **O caminho genérico nunca é sabotado:** `docker compose` funciona em qualquer VPS.

## Princípios de comunicação

1. **Keyword primeiro, jargão depois.** Em todo título público: "AI agents", "WhatsApp", "CRM" antes de qualquer nome interno de subsistema.
2. **Mostrar, não descrever.** Screenshot/GIF do produto no primeiro scroll de qualquer página.
3. **Âncora explícita.** A categoria de entrada aparece no README e nos materiais — é assim que a demanda nos encontra (busca e LLMs).
4. **E-commerce é exemplo, não definição.** Ao citar casos de uso, sempre em lista multi-nicho ("e-commerce, clínicas, imobiliárias...").
5. **Transparência de modelo.** Telemetria declarada em linguagem humana no README, nunca escondida.

## Norte de 3 anos

Ser a resposta padrão para a pergunta **"qual o melhor CRM com agentes de IA e WhatsApp?"**; com milhares de instalações privadas rodando, um ecossistema de agentes plugados via MCP público, e um flywheel de auto-aprimoramento que faça cada instalação vender melhor a cada mês de operação.

---

*Última revisão: 2026-07-19 — reposicionamento e-commerce → multi-nicho / AI Sales OS.*
