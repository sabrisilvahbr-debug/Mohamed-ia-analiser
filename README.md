# Mohamed IA Analiser — AI OTC TRADER 3D Autonomous Tradefloor

Plataforma de algo trading com escritório 3D interativo, 9 agentes de software coordenados por um supervisor, gestão de risco no servidor e integração com a **API Options oficial da Deriv** (`api.derivws.com`, documentação em https://developers.deriv.com).

> **Sem promessa de lucro.** Derivativos envolvem risco de perda. A execução em conta **real fica desativada por padrão**. Não há martingale nem aumento de stake após perdas.

## O que é real e o que não é

| Elemento | Origem |
|---|---|
| Cotações, gráfico, histórico | Deriv `ticks` / `ticks_history` (canal público, sem login) |
| Lista de ativos | Deriv `active_symbols` — nenhum ativo OTC é presumido |
| Contratos permitidos | Deriv `contracts_for` (visão da conta quando autenticado) |
| Saldo | Deriv `balance` — só aparece com credenciais; demo é rotulado **CONTA DEMO — DINHEIRO VIRTUAL** |
| Ordem aberta | Somente após `buy` retornar `contract_id` |
| Resultado | Somente após `proposal_open_contract` com `is_sold=1` e `profit = sell_price − buy_price` |
| Estado dos agentes | Atualizado apenas quando o agente executa trabalho ou detecta falha |
| Globo girando, luzes, janelas | Decoração do ambiente 3D (não representa dados) |

Sem credenciais, o sistema roda em **modo SINAIS**: analisa cotações reais e registra decisões, sem saldo e sem ordens.

## Arquitetura

```
backend/src
├── main.ts              inicialização, lock de instância única, desligamento seguro
├── server.ts            API HTTP protegida (Bearer ADMIN_TOKEN) + streaming + arquivos do painel
├── config.ts / settings.ts / db.ts / logger.ts (com mascaramento de segredos)
├── deriv/
│   ├── client.ts        WebSocket: req_id, assinaturas, ping 30 s, reconexão com backoff
│   ├── auth.ts          OTP via REST (PAT + Deriv-App-ID), modo demo/real pela URL
│   └── protocol.ts      tipos transcritos dos JSON Schemas oficiais
├── strategies/          indicadores (EMA, RSI, volatilidade) e motor de decisão puro
└── agents/
    ├── marketData.ts    1 Market Data         ├── execution.ts  6 Execution Engine
    ├── analyzer.ts      2 Market Analyzer     ├── portfolio.ts  7 Portfolio Monitor
    ├── (engine.ts)      3 Strategy Engine     ├── audit.ts      8 Audit Agent
    ├── validator.ts     4 Signal Validator    └── supervisor.ts 9 Supervisor
    └── risk.ts          5 Risk Manager
frontend/                painel (HTML/CSS/JS) + scene3d.js (motor WebGL2 próprio)
```

Sem dependências de runtime: Node.js ≥ 22.18 executa TypeScript diretamente; o banco é `node:sqlite`.

### Fluxo de uma ordem
1. tick ao vivo → análise → estratégia (CALL / PUT / **AGUARDAR**, sempre com motivo)
2. decisão gravada com `UNIQUE(símbolo, estratégia, tick)` — o mesmo evento nunca decide duas vezes
3. validador: cotação recente, mercado aberto, contrato e duração presentes em `contracts_for`
4. risco: stake máx., perda diária (inclui pior cenário dos abertos), exposição, contratos abertos, perdas seguidas, intervalo mínimo, saldo confirmado, modo da conta = modo escolhido
5. execução: operação gravada antes do envio (`signal_key` único) → `proposal` → confere `ask_price` → `buy` pelo ID da proposta
6. erro da Deriv → `REJECTED`; sem resposta → `UNCONFIRMED`, novas entradas bloqueadas e reconciliação pelo `statement`
7. `proposal_open_contract` acompanha até `is_sold=1`; valores inconsistentes não são contabilizados

**PARAR** bloqueia novas ordens; contratos abertos seguem até a liquidação pela Deriv (o sistema não presume cancelamento).

## Executar localmente

```bash
cp .env.example .env      # preencha ADMIN_TOKEN (>= 16 caracteres)
npm install               # apenas typescript/@types para checagem
npm start                 # http://localhost:8080
npm run check             # tipagem + testes
npm run backtest -- R_100 5000 0.95   # backtest com dados reais da Deriv
```

## Testes

`npm test` executa 40 testes (inclui o código real do Worker/Durable Object executado no Node): indicadores, estratégias, validação, risco, banco, liquidação, reconciliação e integração ponta a ponta contra um **servidor de teste local** que implementa o protocolo documentado da Deriv (`backend/test/helpers/mockDeriv.ts`). Esse servidor existe só para os testes automatizados; o aplicativo nunca o usa.

## Deploy

**Cloudflare Workers (grátis):** motor completo num Durable Object + painel — veja docs/DEPLOY.md, seção 2b.

Motor 24h na VM Oracle Always Free, acessível por link `trycloudflare.com` (ou painel com link fixo no Cloudflare Pages). Na Vercel o painel roda em **modo direto** (navegador ↔ canal público da Deriv, sem saldo e sem ordens). Veja [docs/DEPLOY.md](docs/DEPLOY.md).
