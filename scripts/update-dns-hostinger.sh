#!/usr/bin/env bash
# Perbarui record DNS A di Hostinger agar mengarah ke IP server ini.
# Butuh HOSTINGER_API_TOKEN di .env atau environment.
# Token: https://hpanel.hostinger.com/profile/api
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${1:-kalimasada-app.com}"
TARGET_IP="${2:-$(curl -s --connect-timeout 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')}"

if [ -f "$APP_DIR/.env" ]; then
  # shellcheck disable=SC1090
  set -a; source <(grep -E '^HOSTINGER_API_TOKEN=' "$APP_DIR/.env" 2>/dev/null || true); set +a
fi

TOKEN="${HOSTINGER_API_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  echo "ERROR: HOSTINGER_API_TOKEN belum di-set."
  echo "Tambahkan di $APP_DIR/.env:"
  echo "  HOSTINGER_API_TOKEN=your_token_here"
  echo "Token dari: https://hpanel.hostinger.com/profile/api"
  exit 1
fi

echo "==> Update DNS $DOMAIN → $TARGET_IP via Hostinger API"

PAYLOAD=$(cat <<EOF
{
  "overwrite": true,
  "zone": [
    {
      "name": "@",
      "type": "A",
      "ttl": 300,
      "records": [{ "content": "$TARGET_IP" }]
    },
    {
      "name": "*",
      "type": "A",
      "ttl": 300,
      "records": [{ "content": "$TARGET_IP" }]
    },
    {
      "name": "www",
      "type": "CNAME",
      "ttl": 300,
      "records": [{ "content": "${DOMAIN}." }]
    },
    {
      "name": "manage",
      "type": "A",
      "ttl": 300,
      "records": [{ "content": "$TARGET_IP" }]
    },
    {
      "name": "skynet",
      "type": "A",
      "ttl": 300,
      "records": [{ "content": "$TARGET_IP" }]
    }
  ]
}
EOF
)

echo "==> Validasi record..."
VALIDATE=$(curl -sS -w "\n%{http_code}" -X POST \
  "https://developers.hostinger.com/api/dns/v1/zones/${DOMAIN}/validate" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")
HTTP_CODE=$(echo "$VALIDATE" | tail -1)
BODY=$(echo "$VALIDATE" | sed '$d')
if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "204" ]; then
  echo "Validasi gagal (HTTP $HTTP_CODE): $BODY"
  exit 1
fi

echo "==> Terapkan perubahan DNS..."
RESULT=$(curl -sS -w "\n%{http_code}" -X PUT \
  "https://developers.hostinger.com/api/dns/v1/zones/${DOMAIN}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")
HTTP_CODE=$(echo "$RESULT" | tail -1)
BODY=$(echo "$RESULT" | sed '$d')
if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "204" ]; then
  echo "Update gagal (HTTP $HTTP_CODE): $BODY"
  exit 1
fi

echo "OK: DNS diperbarui. Tunggu propagasi 1–5 menit."
echo ""
echo "Verifikasi:"
for h in "$DOMAIN" "www.$DOMAIN" "manage.$DOMAIN" "skynet.$DOMAIN"; do
  echo -n "  $h → "
  dig +short "$h" A | head -1
done
