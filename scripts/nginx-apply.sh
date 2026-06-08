#!/usr/bin/env bash
# Terapkan konfigurasi Nginx Kalimasada (dipanggil dari Management Portal)
set -euo pipefail

APP_DIR="/var/www/billing-kalimasada"
SRC_CONF="${KALIMASADA_NGINX_CONF:-$APP_DIR/data/nginx/kalimasada-app.conf}"
DEST_CONF="/etc/nginx/sites-available/kalimasada-app.conf"
ENABLED_LINK="/etc/nginx/sites-enabled/kalimasada-app.conf"
DEFAULT_SITE="/etc/nginx/sites-enabled/default"

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

cmd="${1:-apply}"

case "$cmd" in
  check-ssl)
    CERT_PATH="${2:-/etc/letsencrypt/live/kalimasada-app.com/fullchain.pem}"
    KEY_PATH="${3:-/etc/letsencrypt/live/kalimasada-app.com/privkey.pem}"
    run_root test -f "$CERT_PATH"
    run_root test -f "$KEY_PATH"
    echo "OK: sertifikat SSL ditemukan"
    ;;
  test)
    if [ ! -f "$SRC_CONF" ]; then
      echo "ERROR: File konfigurasi tidak ada: $SRC_CONF" >&2
      exit 1
    fi
    # Harus cp dari path yang sama persis seperti di /etc/sudoers.d/kalimasada-nginx
    run_root cp "$SRC_CONF" "$DEST_CONF"
    run_root nginx -t
    echo "OK: nginx -t berhasil"
    ;;
  apply)
    if [ ! -f "$SRC_CONF" ]; then
      echo "ERROR: File konfigurasi tidak ada: $SRC_CONF" >&2
      exit 1
    fi
    if ! command -v nginx >/dev/null 2>&1; then
      echo "ERROR: nginx belum terinstall. Jalankan: sudo bash $APP_DIR/scripts/setup-nginx-proxy.sh" >&2
      exit 1
    fi
    run_root mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
    run_root cp "$SRC_CONF" "$DEST_CONF"
    run_root ln -sf "$DEST_CONF" "$ENABLED_LINK"
    if [ -f "$DEFAULT_SITE" ] || [ -L "$DEFAULT_SITE" ]; then
      run_root rm -f "$DEFAULT_SITE"
    fi
    run_root nginx -t
    run_root systemctl enable nginx 2>/dev/null || true
    run_root systemctl reload nginx 2>/dev/null || run_root systemctl restart nginx
    echo "OK: Konfigurasi Nginx diterapkan dan di-reload"
    ;;
  reload)
    run_root nginx -t
    run_root systemctl reload nginx
    echo "OK: Nginx reload berhasil"
    ;;
  status)
    systemctl is-active nginx 2>/dev/null || echo "inactive"
    ;;
  *)
    echo "Usage: $0 {test|apply|reload|status}" >&2
    exit 1
    ;;
esac
