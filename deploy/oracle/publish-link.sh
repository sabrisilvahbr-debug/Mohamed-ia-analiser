#!/bin/bash
# Lê o link https://xxxx.trycloudflare.com nos logs do cloudflared e o publica no canal
# ntfy configurado sempre que mudar (o link muda a cada reinício do túnel).
set -euo pipefail
CANAL=$(cat /opt/otc-secrets/canal.txt)
URL=$(docker compose -f /opt/otc/deploy/oracle/docker-compose.yml logs --no-color cloudflared 2>/dev/null \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
[ -n "$URL" ] || exit 0
LAST=$(cat /opt/otc-secrets/link.txt 2>/dev/null || true)
[ "$URL" = "$LAST" ] && exit 0
if curl -fsS -H "Title: AI OTC TRADER - novo link" -H "Click: $URL" -d "$URL" "https://ntfy.sh/${CANAL}" > /dev/null; then
  echo "$URL" > /opt/otc-secrets/link.txt
  echo "$(date -u) publicado $URL"
fi
