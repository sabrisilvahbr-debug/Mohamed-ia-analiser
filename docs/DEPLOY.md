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

## 3. Oracle Always Free (recomendado) — tudo pelo iPhone

O script `deploy/oracle/cloud-init.sh` instala Docker, baixa este repositório, cria o HTTPS automático (Caddy + domínio `IP.sslip.io`) e sobe o app. Também agenda a atualização diária a partir da `main`.

1. Crie a conta em **cloud.oracle.com** (escolha a região *São Paulo* ou *Vinhedo*; é pedido um cartão só para verificação — recursos Always Free não são cobrados).
2. Menu → **Compute → Instances → Create instance**.
3. **Image:** Canonical Ubuntu 24.04. **Shape:** `VM.Standard.A1.Flex` (1 OCPU, 6 GB) — se aparecer "Out of capacity", use `VM.Standard.E2.1.Micro`. Ambos têm o selo *Always Free-eligible*.
4. **Networking:** mantenha "Create new virtual cloud network" e **Assign a public IPv4 address** ligado.
5. **SSH keys:** "No SSH keys" é aceitável (tudo é feito pelo script); se quiser acesso de manutenção, baixe a chave gerada.
6. **Show advanced options → Management → Paste cloud-init script:** cole o conteúdo de `deploy/oracle/cloud-init.sh` e preencha as linhas do topo (senha do painel e, opcionalmente, os dados da conta DEMO da Deriv).
7. **Create.** Anote o *Public IP address* da instância.
8. Libere as portas na rede: na instância → **Subnet → Security List → Add Ingress Rules**: Source `0.0.0.0/0`, TCP, destination port `80`; repita para `443`.
9. Aguarde ~10 minutos e abra `https://A-B-C-D.sslip.io` (o IP com hífens no lugar dos pontos, ex.: `129.1.2.3` → `https://129-1-2-3.sslip.io`). Entre com a senha do painel.

Alterar segredos depois (pelo **Cloud Shell** do console Oracle, com a chave SSH baixada):
```bash
ssh ubuntu@IP
sudo nano /opt/otc-secrets/app.env
cd /opt/otc/deploy/oracle && sudo docker compose up -d
```
Logs: `sudo docker compose -f /opt/otc/deploy/oracle/docker-compose.yml logs -f app` • instalação: `/var/log/otc-install.log`.

## 3b. Painel no Cloudflare Pages (link fixo e gratuito)

O **painel** é estático (`frontend/`) e pode ficar em `https://<projeto>.pages.dev`. O **motor** continua na VM Oracle, porque o Cloudflare Pages/Workers só executa quando chega uma requisição e não mantém a conexão contínua com a Deriv.

1. dash.cloudflare.com → **Workers & Pages → Create → Pages → Connect to Git**.
2. Autorize o GitHub e escolha `Mohamed-ia-analiser`.
3. **Project name:** `mohamed-ia-analiser` (o link será `https://mohamed-ia-analiser.pages.dev`; se o nome estiver ocupado, anote o link real).
4. **Framework preset:** None • **Build command:** (vazio) • **Build output directory:** `frontend`.
5. **Save and Deploy.** Cada push na `main` atualiza o painel sozinho.
6. Na VM, `ALLOWED_ORIGINS` precisa conter exatamente o link do painel (o `cloud-init.sh` já usa `https://mohamed-ia-analiser.pages.dev`; se o link real for outro, edite `/opt/otc-secrets/app.env` e rode `sudo docker compose up -d` em `/opt/otc/deploy/oracle`).
7. Abra o link do Pages, informe o **endereço do motor** (`https://IP-com-hífens.sslip.io`) e a senha do painel. O endereço fica salvo no aparelho.

A API só aceita requisições de navegador vindas das origens listadas em `ALLOWED_ORIGINS`, e toda chamada exige a senha do painel.

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
