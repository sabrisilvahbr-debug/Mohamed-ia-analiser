# Deploy, operação e recuperação

## 1. Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `ADMIN_TOKEN` | sim | Senha do painel (≥ 16 caracteres). Ex.: `openssl rand -hex 24` |
| `DB_PATH` | não | Caminho do SQLite. Use um volume persistente. Padrão `./data/trader.db` |
| `DERIV_APP_ID` | p/ conta | App ID registrado no painel de desenvolvedor da Deriv |
| `DERIV_PAT` | p/ conta | Personal Access Token com escopo `trade` |
| `DERIV_ACCOUNT_ID` | p/ conta | ID da conta Options (ex.: conta demo `DOT…`) |
| `ALLOW_REAL_TRADING` | não | `false` (padrão). Somente `true` libera o modo REAL, que ainda exige confirmação no painel |
| `PORT` | não | Porta HTTP (padrão 8080) |

Nunca coloque essas variáveis no GitHub, no frontend ou em mensagens. Configure-as no painel do provedor.

## 2. Hospedagem — limites reais (verificados em 31/10/2026)

O motor precisa de um **processo contínuo** (WebSocket aberto com a Deriv). Funções serverless não servem.

| Opção | Custo | Funciona 24 h? | Observações |
|---|---|---|---|
| **Oracle Cloud Always Free (VM)** | grátis | **sim** | VM sempre ligada com disco persistente. Exige cartão para verificação; capacidade ARM às vezes indisponível na região. Recomendado. |
| Render Free | grátis | **não** | Dorme após 15 min sem tráfego de entrada; disco efêmero (o SQLite some ao reiniciar/dormir); 750 h/mês. Serve para testar o painel. |
| Render Starter | US$ 7/mês | sim | Sem hibernação; disco persistente é cobrado à parte. Requer sua autorização. |
| Koyeb Free | grátis | verificar | 1 serviço pequeno; confirme a política de hibernação atual antes de usar. |

Nenhum recurso pago foi criado.

## 3. Oracle Always Free (recomendado)

```bash
# na VM Ubuntu
sudo apt-get update && sudo apt-get install -y docker.io git
git clone https://github.com/sabrisilvahbr-debug/Mohamed-ia-analiser.git && cd Mohamed-ia-analiser
sudo docker build -t otc-trader .
sudo docker volume create otc-data
sudo docker run -d --name otc-trader --restart unless-stopped -p 80:8080 \
  -v otc-data:/app/data \
  -e ADMIN_TOKEN='...' -e DERIV_APP_ID='...' -e DERIV_PAT='...' -e DERIV_ACCOUNT_ID='...' \
  otc-trader
```
Abra a porta 80 (ou 443 com um proxy HTTPS como Caddy) na lista de segurança da VCN. Use HTTPS antes de acessar pelo iPhone fora de casa.

## 4. Render (somente para testar)

New → Blueprint → selecione o repositório (usa `render.yaml`). Preencha `DERIV_*` no painel. O `ADMIN_TOKEN` é gerado automaticamente (veja em Environment).

## 5. Inicialização controlada

- Um lock no banco impede duas instâncias do motor operando juntas (ex.: deploy sobreposto).
- O estado desejado (EM EXECUÇÃO / PAUSADO / PARADO) é persistido: após reinício o motor volta ao mesmo estado.
- Operações interrompidas: `PROPOSAL_*` viram `REJECTED` (nada foi enviado); `BUY_SENT` vira `UNCONFIRMED` e bloqueia novas entradas até a reconciliação pelo extrato.
- Contratos `OPEN` voltam a ser acompanhados por `proposal_open_contract`.

## 6. Recuperação

1. Abra **DIAGNÓSTICO** no painel: cada verificação mostra OK/falha e o motivo.
2. `GET /health` (vivo) e `GET /health/ready` (canal público + banco) servem para monitores externos (ex.: UptimeRobot).
3. Ordem `UNCONFIRMED` ambígua: confira na Deriv (extrato da conta) e depois toque em **Reconhecer travas manuais**.
4. Pausa por perdas seguidas: revise a estratégia antes de tocar em INICIAR.

## 7. Verificar a conexão com a Deriv

1. Sem credenciais: a pílula "Deriv público: conectado" e a cotação atualizando provam o canal público.
2. Com credenciais: "Conta demo: conectada" e o saldo com o rótulo DEMO provam o OTP + `balance`.
3. DIAGNÓSTICO executa `GET /trading/v1/options/accounts` e mostra o resultado.
4. Teste o modo **DEMONSTRAÇÃO** (conta demo) por dias antes de qualquer decisão sobre conta real.
