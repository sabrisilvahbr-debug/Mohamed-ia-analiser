#!/bin/bash
# =====================================================================
# AI OTC TRADER 3D — instalação automática na VM Oracle (Ubuntu)
# Cole este script INTEIRO em: Criar instância → Mostrar opções avançadas
# → Gerenciamento → "Colar script cloud-init".
#
# Preencha SOMENTE as linhas abaixo. Este texto fica na sua conta Oracle;
# NÃO o envie para o GitHub nem para chats.
# =====================================================================
PAINEL_SENHA=""        # senha do painel, mínimo 16 caracteres (você escolhe)
DERIV_APP_ID=""        # opcional — vazio = só cotações públicas, sem saldo/ordens
DERIV_PAT=""           # opcional — token pessoal da Deriv com escopo "trade"
DERIV_ACCOUNT_ID=""    # opcional — vazio = conta DEMO descoberta automaticamente
# Nome secreto do canal onde o link trycloudflare será publicado.
# Abra https://ntfy.sh/SEU_CANAL no Safari (ou no app ntfy) para ver o link atual.
# Use algo difícil de adivinhar, ex.: mohamed-otc-7f3k9q2z
CANAL_LINK=""
# Opcional: só este e-mail poderá abrir o link (PIN enviado por e-mail pela Cloudflare)
EMAIL_PERMITIDO=""
PAINEL_CLOUDFLARE="https://mohamed-ia-analiser.pages.dev"  # painel no Cloudflare Pages (opcional)
USAR_CADDY="nao"       # "sim" = também publica em https://IP.sslip.io (abrir portas 80/443)
# =====================================================================

set -euo pipefail
exec > >(tee -a /var/log/otc-install.log) 2>&1
echo "== início $(date -u)"

if [ "${#PAINEL_SENHA}" -lt 16 ]; then echo "ERRO: PAINEL_SENHA precisa ter pelo menos 16 caracteres"; exit 1; fi
if ! [[ "$CANAL_LINK" =~ ^[A-Za-z0-9_-]{12,64}$ ]]; then echo "ERRO: CANAL_LINK precisa ter 12–64 letras/números/-/_"; exit 1; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io docker-compose-v2 git curl iptables-persistent
systemctl enable --now docker

if [ -d /opt/otc/.git ]; then git -C /opt/otc pull --ff-only; else git clone https://github.com/sabrisilvahbr-debug/Mohamed-ia-analiser.git /opt/otc; fi

install -d -m 700 /opt/otc-secrets
umask 077
cat > /opt/otc-secrets/app.env <<EOF
ADMIN_TOKEN=${PAINEL_SENHA}
DERIV_APP_ID=${DERIV_APP_ID}
DERIV_PAT=${DERIV_PAT}
DERIV_ACCOUNT_ID=${DERIV_ACCOUNT_ID}
ALLOW_REAL_TRADING=false
ALLOWED_ORIGINS=${PAINEL_CLOUDFLARE}
DB_PATH=/app/data/trader.db
PORT=8080
EOF
echo "$CANAL_LINK" > /opt/otc-secrets/canal.txt

IP=$(curl -fsS https://api.ipify.org || echo 127.0.0.1)
CF_EXTRA_ARGS=""
[ -n "$EMAIL_PERMITIDO" ] && CF_EXTRA_ARGS="--allowed-mail ${EMAIL_PERMITIDO}"
cat > /opt/otc/deploy/oracle/.env <<EOF
OTC_DOMAIN=${IP//./-}.sslip.io
CF_EXTRA_ARGS=${CF_EXTRA_ARGS}
EOF

PROFILE=""
if [ "$USAR_CADDY" = "sim" ]; then
  for p in 80 443; do iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -p tcp --dport "$p" -j ACCEPT; done
  netfilter-persistent save
  PROFILE="--profile caddy"
fi
echo "$PROFILE" > /opt/otc-secrets/profile.txt

cd /opt/otc/deploy/oracle
docker compose $PROFILE up -d --build

# Publica o link trycloudflare atual no canal ntfy sempre que ele mudar (a cada minuto)
install -m 755 /opt/otc/deploy/oracle/publish-link.sh /usr/local/bin/otc-publish-link
cat > /etc/cron.d/otc <<'EOF'
* * * * * root /usr/local/bin/otc-publish-link >> /var/log/otc-link.log 2>&1
30 3 * * * root cd /opt/otc && git fetch -q origin main && [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] && git pull -q --ff-only && cd deploy/oracle && docker compose $(cat /opt/otc-secrets/profile.txt) up -d --build >> /var/log/otc-update.log 2>&1
EOF

sleep 20
/usr/local/bin/otc-publish-link || true
echo "== pronto ($(date -u)). Link em https://ntfy.sh/${CANAL_LINK}"
