#!/usr/bin/env bash
# Setup awal Nginx reverse proxy Kalimasada SaaS
set -euo pipefail

APP_DIR="/var/www/billing-kalimasada"

if [ "$(id -u)" -ne 0 ]; then
  echo "Jalankan sebagai root: sudo bash $0"
  exit 1
fi

echo "==> Install Nginx..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y nginx

echo "==> Buat direktori data nginx..."
mkdir -p "$APP_DIR/data/nginx"
chown -R "${SUDO_USER:-ajizs}:${SUDO_USER:-ajizs}" "$APP_DIR/data/nginx"

echo "==> Generate konfigurasi awal..."
cd "$APP_DIR"
node -e "
const nm = require('./config/platform/nginxManager');
const cfg = nm.loadConfig();
nm.writeGeneratedConfig(cfg);
console.log('Config written:', nm.GENERATED_CONF);
"

echo "==> Terapkan ke Nginx..."
bash "$APP_DIR/scripts/nginx-apply.sh" apply

echo "==> Opsional: sudoers untuk apply tanpa password (user app)..."
SUDOERS_FILE="/etc/sudoers.d/kalimasada-nginx"
APP_USER="${SUDO_USER:-ajizs}"
cat > "$SUDOERS_FILE" <<EOF
# Kalimasada Nginx management (Management Portal)
${APP_USER} ALL=(root) NOPASSWD: /usr/sbin/nginx -t
${APP_USER} ALL=(root) NOPASSWD: /bin/systemctl reload nginx
${APP_USER} ALL=(root) NOPASSWD: /bin/systemctl restart nginx
${APP_USER} ALL=(root) NOPASSWD: /bin/systemctl enable nginx
${APP_USER} ALL=(root) NOPASSWD: /bin/cp ${APP_DIR}/data/nginx/kalimasada-app.conf /etc/nginx/sites-available/kalimasada-app.conf
${APP_USER} ALL=(root) NOPASSWD: /bin/ln -sf /etc/nginx/sites-available/kalimasada-app.conf /etc/nginx/sites-enabled/kalimasada-app.conf
${APP_USER} ALL=(root) NOPASSWD: /bin/rm -f /etc/nginx/sites-enabled/default
${APP_USER} ALL=(root) NOPASSWD: /bin/mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
EOF
chmod 440 "$SUDOERS_FILE"
visudo -cf "$SUDOERS_FILE"

echo ""
echo "=============================================="
echo " Nginx reverse proxy Kalimasada siap!"
echo "=============================================="
echo "  HTTP  : port 80 → Node app :4555"
echo "  Domain: kalimasada-app.com + *.kalimasada-app.com"
echo "  UI    : http://192.168.166.197:4555/management/reverse-proxy"
echo ""
echo " Pastikan DNS A record mengarah ke IP server ini."
echo "=============================================="
