# O que o assistente faz e o que não faz neste projeto

## Faz
- Escreve e testa o código do motor, do painel e da versão Cloudflare (41 testes automáticos).
- Cria branches, commits e pull requests no repositório `Mohamed-ia-analiser`.
- Consulta a documentação oficial da Deriv e da Cloudflare antes de implementar cada integração.
- Lê o estado do Worker no Cloudflare (existência, código publicado) e testa `/health` e `/health/ready`.
- Testa o painel num navegador simulado de iPhone.
- Consulta a Deriv em modo somente leitura (símbolos e cotações públicas).

## Não faz
- Não grava variáveis nem segredos no Cloudflare; só lê.
- Não cria contas nem cadastra cartões (Deriv, Cloudflare, Oracle, Render, Railway).
- Não gera nem lê tokens ou App IDs da Deriv.
- Não acessa a Deriv real a partir do ambiente de desenvolvimento.
- Não garante lucro. Backtests medem o passado, não o futuro.

## Passos que dependem do dono da conta
1. Criar o App ID (tipo PAT) e o token (permissão Trade) no developers.deriv.com.
2. Salvar `DERIV_APP_ID` e `DERIV_PAT` como Secret em Workers → Settings → Variables and Secrets.
3. Confirmar que o deploy mais recente está Active.
4. Abrir o DIAGNÓSTICO no painel e conferir "Credenciais Deriv", "Canal autenticado (OTP)" e "Saldo recebido".

## Regras de uso
- Usar somente dados reais; quando faltar um dado, mostrar "indisponível" com o motivo.
- Conta real desligada por padrão; só liberada com confirmação explícita.
- Nunca enviar tokens, senhas ou App IDs no chat.
- Começar sempre pelo modo SINAIS antes de ativar o modo demonstração.
