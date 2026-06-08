#!/usr/bin/env bash
# Perluas sertifikat Let's Encrypt untuk semua subdomain tenant
set -euo pipefail

APP_DIR="/var/www/billing-kalimasada"
WEBROOT="/var/www/certbot"

sudo_hint() {
  echo "ERROR: Butuh izin sudo tanpa password untuk: $*" >&2
  echo "Jalankan sekali di server: sudo bash $APP_DIR/scripts/install-nginx-sudoers.sh" >&2
}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return $?
  fi
  if sudo -n "$@"; then
    return 0
  fi
  sudo_hint "$*"
  return 1
}

BASE_DOMAIN="${1:-kalimasada-app.com}"
CENTRAL="${2:-manage}"
EMAIL="${3:-admin@${BASE_DOMAIN}}"
shift 3 || true
SUBS=("$@")

if ! run_root test -f "/etc/letsencrypt/live/${BASE_DOMAIN}/fullchain.pem"; then
  echo "ERROR: Sertifikat belum ada. Jalankan setup-ssl-certbot.sh dulu."
  exit 1
fi

ARGS=(certonly --webroot -w "$WEBROOT" -d "$BASE_DOMAIN" -d "${CENTRAL}.${BASE_DOMAIN}")
for sub in "${SUBS[@]}"; do
  [ -n "$sub" ] && ARGS+=(-d "${sub}.${BASE_DOMAIN}")
done
ARGS+=(--cert-name "$BASE_DOMAIN" --expand --email "$EMAIL" --agree-tos --non-interactive)

echo "==> Perluas SSL: ${BASE_DOMAIN} + ${#SUBS[@]} subdomain"
run_root certbot "${ARGS[@]}"
echo "OK: Sertifikat diperluas"
