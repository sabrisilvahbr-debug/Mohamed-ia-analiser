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
DERIV_ACCOUNT_ID=""    # opcional — ID da conta DEMO (ex.: DOT...)
PAINEL_CLOUDFLARE="https://mohamed-ia-analiser.pages.dev"  # link do painel no Cloudflare Pages
# =====================================================================

set -euo pipefail
exec > >(tee -a /var/log/otc-install.log) 2>&1
echo "== início $(date -u)"

if [ "${#PAINEL_SENHA}" -lt 16 ]; then
  echo "ERRO: PAINEL_SENHA precisa ter pelo menos 16 caracteres"; exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io docker-compose-v2 git curl iptables-persistent

# As imagens Ubuntu da Oracle bloqueiam portas no iptables: liberar 80 e 443
for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -p tcp --dport "$p" -j ACCEPT
done
netfilter-persistent save

systemctl enable --now docker

# Código
if [ -d /opt/otc/.git ]; then git -C /opt/otc pull --ff-only; else git clone https://github.com/sabrisilvahbr-debug/Mohamed-ia-analiser.git /opt/otc; fi

# Segredos (somente root lê)
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

# Domínio HTTPS gratuito baseado no IP público (ex.: 129-1-2-3.sslip.io)
IP=$(curl -fsS https://api.ipify.org)
echo "OTC_DOMAIN=${IP//./-}.sslip.io" > /opt/otc/deploy/oracle/.env
echo "${IP//./-}.sslip.io" > /opt/otc-secrets/domain.txt

cd /opt/otc/deploy/oracle
docker compose up -d --build

# Atualização automática diária (03:30 UTC): puxa a main e reconstrói se houver mudança
cat > /etc/cron.d/otc-update <<'EOF'
30 3 * * * root cd /opt/otc && git fetch -q origin main && [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] && git pull -q --ff-only && cd deploy/oracle && docker compose up -d --build >> /var/log/otc-update.log 2>&1
EOF

echo "== pronto: https://${IP//./-}.sslip.io  ($(date -u))"
