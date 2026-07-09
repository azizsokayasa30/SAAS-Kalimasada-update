#!/usr/bin/env bash
#
# deploy-full-server.sh — Deploy lengkap Billing Kalimasada SaaS di server baru
# Termasuk: Node.js, PM2, FreeRADIUS, database, platform SaaS, siap produksi.
#
# Jalankan dari folder repo (atau clone otomatis):
#   sudo bash scripts/deploy-full-server.sh
#
# Variabel lingkungan (opsional, non-interaktif):
#   APP_DIR=/var/www/billing-kalimasada
#   GIT_REPO=https://github.com/USER/SaaS-Billing_Kalimasada.git
#   GIT_BRANCH=main
#   RADIUS_MODE=sqlite          # sqlite | mysql
#   RADIUS_DB_PATH=/var/lib/freeradius/radius.db
#   APP_PORT=4555
#   PUBLIC_APP_BASE_URL=http://IP:4555
#   KALIMASADA_BASE_DOMAIN=kalimasada-app.com
#   KALIMASADA_SERVER_IP=1.2.3.4
#   INSTALL_NGINX=0             # 1 = pasang nginx reverse proxy
#   SKIP_FREERADIUS=0           # 1 = lewati install FreeRADIUS
#   NAS_IP=192.168.1.1          # IP Mikrotik pertama (opsional)
#   NAS_SECRET=testing123
#   SESSION_SECRET=...          # auto-generate jika kosong
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/freeradius-billing-common.sh
source "${SCRIPT_DIR}/lib/freeradius-billing-common.sh"

APP_DIR="${APP_DIR:-${REPO_ROOT}}"
GIT_REPO="${GIT_REPO:-}"
GIT_BRANCH="${GIT_BRANCH:-main}"
RADIUS_MODE="${RADIUS_MODE:-sqlite}"
RADIUS_DB_PATH="${RADIUS_DB_PATH:-/var/lib/freeradius/radius.db}"
APP_PORT="${APP_PORT:-4555}"
ISOLIR_PORT="${ISOLIR_PORT:-8899}"
INSTALL_NGINX="${INSTALL_NGINX:-0}"
SKIP_FREERADIUS="${SKIP_FREERADIUS:-0}"
NAS_IP="${NAS_IP:-}"
NAS_SECRET="${NAS_SECRET:-testing123}"
PUBLIC_APP_BASE_URL="${PUBLIC_APP_BASE_URL:-}"
KALIMASADA_BASE_DOMAIN="${KALIMASADA_BASE_DOMAIN:-kalimasada-app.com}"
KALIMASADA_CENTRAL_SUBDOMAIN="${KALIMASADA_CENTRAL_SUBDOMAIN:-manage}"
KALIMASADA_SERVER_IP="${KALIMASADA_SERVER_IP:-}"
SESSION_SECRET="${SESSION_SECRET:-}"

APP_USER="${SUDO_USER:-$(whoami)}"

banner() {
  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║   Billing Kalimasada SaaS — Deploy Server Lengkap            ║${NC}"
  echo -e "${GREEN}║   Billing + FreeRADIUS + PM2 + Database                      ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
}

ensure_app_dir() {
  if [[ -n $GIT_REPO ]]; then
    log_info "Clone repo → $APP_DIR"
    mkdir -p "$(dirname "$APP_DIR")"
    if [[ -d $APP_DIR/.git ]]; then
      log_info "Repo sudah ada, git pull..."
      git -C "$APP_DIR" fetch origin
      git -C "$APP_DIR" checkout "$GIT_BRANCH"
      git -C "$APP_DIR" pull origin "$GIT_BRANCH"
    else
      git clone -b "$GIT_BRANCH" "$GIT_REPO" "$APP_DIR"
    fi
  elif [[ ! -f "${APP_DIR}/package.json" ]]; then
    log_error "package.json tidak ditemukan di $APP_DIR"
    log_error "Set APP_DIR ke folder repo atau set GIT_REPO untuk clone otomatis"
    exit 1
  fi
  log_success "App directory: $APP_DIR"
}

install_system_base() {
  log_info "Update sistem & install dependensi dasar..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get upgrade -y -qq
  apt-get install -y \
    build-essential git curl wget python3 make g++ \
    libssl-dev libsqlite3-dev sqlite3 ca-certificates gnupg lsb-release \
    freeradius-utils
  log_success "Dependensi sistem terpasang"
}

install_nodejs_20() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -v | cut -d'v' -f2 | cut -d'.' -f1)"
    if [[ $major -ge 20 ]]; then
      log_success "Node.js sudah ada: $(node -v)"
      return 0
    fi
  fi
  log_info "Install Node.js 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  log_success "Node.js: $(node -v), npm: $(npm -v)"
}

install_pm2_global() {
  if command -v pm2 >/dev/null 2>&1; then
    log_success "PM2 sudah ada: $(pm2 -v)"
    return 0
  fi
  log_info "Install PM2..."
  npm install -g pm2
  log_success "PM2 terpasang"
}

setup_app_config() {
  log_info "Setup konfigurasi aplikasi..."
  cd "$APP_DIR"

  if [[ ! -f settings.json ]]; then
    if [[ -f settings.server.template.json ]]; then
      cp settings.server.template.json settings.json
      log_success "settings.json dibuat dari template"
    else
      log_warn "settings.server.template.json tidak ada — buat settings.json manual"
    fi
  fi

  if [[ ! -f .env ]]; then
    cp .env.example .env 2>/dev/null || touch .env
  fi

  if [[ -z $KALIMASADA_SERVER_IP ]]; then
    KALIMASADA_SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '127.0.0.1')"
  fi

  if [[ -z $PUBLIC_APP_BASE_URL ]]; then
    PUBLIC_APP_BASE_URL="http://${KALIMASADA_SERVER_IP}:${APP_PORT}"
  fi

  if [[ -z $SESSION_SECRET ]]; then
    SESSION_SECRET="$(generate_radius_secret)$(generate_radius_secret)"
  fi

  set_env_kv() {
    local key="$1" val="$2" file="$APP_DIR/.env"
    if grep -q "^${key}=" "$file" 2>/dev/null; then
      sed -i "s|^${key}=.*|${key}=${val}|" "$file"
    else
      echo "${key}=${val}" >> "$file"
    fi
  }

  set_env_kv PORT "$APP_PORT"
  set_env_kv ISOLIR_PORT "$ISOLIR_PORT"
  set_env_kv NODE_ENV production
  set_env_kv PUBLIC_APP_BASE_URL "$PUBLIC_APP_BASE_URL"
  set_env_kv KALIMASADA_BASE_DOMAIN "$KALIMASADA_BASE_DOMAIN"
  set_env_kv KALIMASADA_CENTRAL_SUBDOMAIN "$KALIMASADA_CENTRAL_SUBDOMAIN"
  set_env_kv KALIMASADA_SERVER_IP "$KALIMASADA_SERVER_IP"
  set_env_kv SESSION_SECRET "$SESSION_SECRET"

  if [[ "$RADIUS_MODE" == "sqlite" ]]; then
    set_env_kv RADIUS_SQLITE_PATH "$RADIUS_DB_PATH"
  fi

  log_success "Konfigurasi .env selesai"
}

setup_app_directories() {
  cd "$APP_DIR"
  mkdir -p data data/backup data/nginx logs whatsapp-session
  chown -R "${APP_USER}:${APP_USER}" data logs whatsapp-session 2>/dev/null || true
  log_success "Direktori data/logs siap"
}

install_app_dependencies() {
  log_info "npm install (mungkin beberapa menit)..."
  cd "$APP_DIR"
  sudo -u "$APP_USER" npm install
  sudo -u "$APP_USER" npm rebuild sqlite3 2>/dev/null || true
  log_success "Dependensi Node terpasang"
}

init_databases() {
  log_info "Inisialisasi database billing..."
  cd "$APP_DIR"
  sudo -u "$APP_USER" npm run setup
  sudo -u "$APP_USER" npm run platform:init
  log_success "Database billing + platform SaaS siap"
}

install_freeradius_step() {
  if [[ "$SKIP_FREERADIUS" == "1" ]]; then
    log_warn "SKIP_FREERADIUS=1 — lewati install FreeRADIUS"
    return 0
  fi

  log_info "Install & konfigurasi FreeRADIUS (mode: $RADIUS_MODE)..."
  install_freeradius_for_billing \
    "$APP_DIR" \
    "$RADIUS_MODE" \
    "$RADIUS_DB_PATH" \
    "$NAS_IP" \
    "$NAS_SECRET" \
    "$APP_USER"
}

start_pm2() {
  log_info "Start aplikasi dengan PM2..."
  cd "$APP_DIR"
  sudo -u "$APP_USER" npm run pm2:delete 2>/dev/null || true
  sudo -u "$APP_USER" npm run pm2:start
  sudo -u "$APP_USER" npm run pm2:save
  pm2 startup systemd -u "$APP_USER" --hp "$(eval echo "~${APP_USER}")" 2>/dev/null | tail -1 | bash 2>/dev/null || \
    log_warn "Jalankan manual: pm2 startup (sebagai user $APP_USER)"
  log_success "PM2 billing-kalimasada berjalan"
}

install_nginx_step() {
  if [[ "$INSTALL_NGINX" != "1" ]]; then
    return 0
  fi
  log_info "Install Nginx reverse proxy..."
  if [[ -f "${APP_DIR}/scripts/setup-nginx-proxy.sh" ]]; then
    APP_DIR="$APP_DIR" bash "${APP_DIR}/scripts/setup-nginx-proxy.sh"
  else
    log_warn "setup-nginx-proxy.sh tidak ditemukan"
  fi
}

post_deploy_verify() {
  log_info "Verifikasi deploy..."
  cd "$APP_DIR"

  if [[ "$SKIP_FREERADIUS" != "1" ]]; then
    sudo -u "$APP_USER" npm run radius:check 2>/dev/null || log_warn "radius:check — periksa manual"
    if [[ -f /etc/freeradius/3.0/clients.conf ]]; then
      sudo -u "$APP_USER" npm run radius:mirror-clients 2>/dev/null || \
        mirror_radius_clients_to_billing "$APP_DIR" "$APP_USER"
    fi
  fi

  sleep 3
  if curl -sf "http://127.0.0.1:${APP_PORT}/" >/dev/null 2>&1 || \
     curl -sf "http://127.0.0.1:${APP_PORT}/management/login" >/dev/null 2>&1; then
    log_success "HTTP merespons di port $APP_PORT"
  else
    log_warn "HTTP belum merespons — cek: pm2 logs billing-kalimasada"
  fi
}

print_summary() {
  local mgmt_url="http://${KALIMASADA_SERVER_IP}:${APP_PORT}/management/login"
  local admin_url="http://${KALIMASADA_SERVER_IP}:${APP_PORT}/admin/login"

  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║              DEPLOY SELESAI — SIAP PAKAI                     ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "${CYAN}Akses aplikasi:${NC}"
  echo "  Management Portal : $mgmt_url"
  echo "  Admin Tenant      : $admin_url"
  echo "  Super Admin       : management@kalimasada / kalimasada123"
  echo ""
  echo -e "${CYAN}Konfigurasi:${NC}"
  echo "  App dir     : $APP_DIR"
  echo "  Port        : $APP_PORT"
  echo "  RADIUS mode : $RADIUS_MODE"
  if [[ "$RADIUS_MODE" == "sqlite" ]]; then
    echo "  RADIUS DB   : $RADIUS_DB_PATH"
  fi
  echo ""
  echo -e "${CYAN}Perintah berguna:${NC}"
  echo "  pm2 status"
  echo "  pm2 logs billing-kalimasada"
  echo "  npm run radius:health"
  echo "  npm run radius:check"
  echo ""
  echo -e "${YELLOW}Langkah berikutnya:${NC}"
  echo "  1. Edit settings.json (Mikrotik, WhatsApp, perusahaan)"
  echo "  2. Login Management Portal → ubah password super admin"
  echo "  3. Tambah tenant & konfigurasi DNS wildcard"
  if [[ "$SKIP_FREERADIUS" != "1" && -n $NAS_IP ]]; then
    echo "  4. Di Mikrotik: /radius add address=$(hostname -I | awk '{print $1}') secret=$NAS_SECRET"
  elif [[ "$SKIP_FREERADIUS" != "1" ]]; then
    echo "  4. Tambah NAS Mikrotik: sudo bash scripts/auto-add-radius-client.sh <IP_MIKROTIK> <SECRET>"
  fi
  if [[ "$INSTALL_NGINX" == "1" ]]; then
    echo "  5. Setup SSL: sudo bash scripts/setup-ssl-certbot.sh"
  fi
  echo ""
}

main() {
  if [[ ${EUID:-0} -ne 0 ]]; then
    log_error "Jalankan sebagai root: sudo bash $0"
    exit 1
  fi

  banner
  detect_os
  ensure_app_dir
  install_system_base
  install_nodejs_20
  install_pm2_global
  setup_app_directories
  setup_app_config
  install_app_dependencies
  init_databases
  install_freeradius_step
  start_pm2
  install_nginx_step
  post_deploy_verify
  print_summary
}

main "$@"
