#!/usr/bin/env bash
# Pasang sudoers agar Management Portal bisa nginx -t / apply / reload tanpa password
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Jalankan sebagai root: sudo bash $0"
  exit 1
fi

APP_DIR="/var/www/billing-kalimasada"
APP_USER="${SUDO_USER:-ajizs}"
SUDOERS_FILE="/etc/sudoers.d/kalimasada-nginx"

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
${APP_USER} ALL=(root) NOPASSWD: /usr/bin/test -f /etc/letsencrypt/live/kalimasada-app.com/fullchain.pem
${APP_USER} ALL=(root) NOPASSWD: /usr/bin/test -f /etc/letsencrypt/live/kalimasada-app.com/privkey.pem
${APP_USER} ALL=(root) NOPASSWD: ${APP_DIR}/scripts/nginx-apply.sh
${APP_USER} ALL=(root) NOPASSWD: ${APP_DIR}/scripts/expand-ssl-domains.sh
${APP_USER} ALL=(root) NOPASSWD: /usr/bin/certbot
EOF

chmod 440 "$SUDOERS_FILE"
visudo -cf "$SUDOERS_FILE"

echo "OK: sudoers terpasang untuk user ${APP_USER}"
echo "Coba dari portal: Test (nginx -t) di /management/reverse-proxy"
