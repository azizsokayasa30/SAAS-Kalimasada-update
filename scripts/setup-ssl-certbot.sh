#!/usr/bin/env bash
# Pasang SSL Let's Encrypt — jalankan SETELAH DNS benar & port 80/443 terbuka
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Jalankan: sudo bash $0 [domain] [email]"
  exit 1
fi

APP_DIR="/var/www/billing-kalimasada"
DOMAIN="${1:-kalimasada-app.com}"
EMAIL="${2:-admin@${DOMAIN}}"
WEBROOT="/var/www/certbot"
PUBLIC_IP="$(curl -s --connect-timeout 5 ifconfig.me 2>/dev/null || curl -s --connect-timeout 5 icanhazip.com 2>/dev/null || true)"
LAN_IP="$(hostname -I | awk '{print $1}')"

echo "=============================================="
echo " Kalimasada — Setup SSL Let's Encrypt"
echo "=============================================="
echo " Domain : $DOMAIN"
echo " Email  : $EMAIL"
echo " IP publik server: ${PUBLIC_IP:-tidak terdeteksi}"
echo " IP LAN server   : ${LAN_IP}"
echo ""

check_dns() {
  local host="$1"
  local resolved
  resolved="$(getent hosts "$host" | awk '{print $1}' | head -1)"
  if [ -z "$resolved" ]; then
    echo "  [GAGAL] $host — tidak ada record DNS"
    return 1
  fi
  if [ -n "$PUBLIC_IP" ] && [ "$resolved" != "$PUBLIC_IP" ]; then
    echo "  [SALAH] $host → $resolved (harusnya → $PUBLIC_IP)"
    return 1
  fi
  echo "  [OK]    $host → $resolved"
  return 0
}

echo "==> Cek DNS (harus mengarah ke IP publik server: ${PUBLIC_IP})..."
DNS_OK=1
check_dns "$DOMAIN" || DNS_OK=0
check_dns "manage.$DOMAIN" || DNS_OK=0

if [ "$DNS_OK" -eq 0 ]; then
  echo ""
  echo "ERROR: DNS belum benar."
  echo ""
  echo "Perbaiki di panel DNS domain Anda:"
  echo "  A   @      →  ${PUBLIC_IP}"
  echo "  A   *      →  ${PUBLIC_IP}"
  echo "  A   manage →  ${PUBLIC_IP}"
  echo ""
  echo "Saat ini kalimasada-app.com mungkin masih ke IP lama (bukan server ini)."
  echo "Setelah DNS diubah, tunggu 5–30 menit lalu jalankan script ini lagi."
  exit 1
fi

echo ""
echo "==> Cek port 80 dari internet..."
if ! curl -sf --connect-timeout 5 -o /dev/null "http://${PUBLIC_IP}/" -H "Host: manage.${DOMAIN}"; then
  echo "PERINGATAN: Port 80 mungkin belum ter-forward ke ${LAN_IP}"
  echo "Forward di router: 80 dan 443 → ${LAN_IP}"
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y certbot python3-certbot-nginx

mkdir -p "$WEBROOT/.well-known/acme-challenge"
chown -R www-data:www-data "$WEBROOT" 2>/dev/null || chown -R nginx:nginx "$WEBROOT" 2>/dev/null || true

echo ""
echo "==> Terapkan ulang config Nginx (dengan acme-challenge)..."
bash "$APP_DIR/scripts/nginx-apply.sh" apply

echo ""
echo "==> Ambil sertifikat Let's Encrypt..."
# Webroot lebih stabil dengan reverse proxy Kalimasada
certbot certonly \
  --webroot -w "$WEBROOT" \
  -d "$DOMAIN" \
  -d "manage.$DOMAIN" \
  --email "$EMAIL" \
  --agree-tos \
  --non-interactive \
  --preferred-challenges http

echo ""
echo "=============================================="
echo " SSL berhasil!"
echo "=============================================="
echo "Sertifikat: /etc/letsencrypt/live/${DOMAIN}/"
echo ""
echo "Langkah berikutnya:"
echo "  1. Buka http://${LAN_IP}:4555/management/reverse-proxy"
echo "  2. Centang 'Aktifkan HTTPS (SSL)'"
echo "  3. Klik 'Simpan & Terapkan Semua Tenant'"
echo "=============================================="
