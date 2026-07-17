#!/usr/bin/env bash
# Library bersama: install & konfigurasi FreeRADIUS untuk Billing Kalimasada
# Dipakai oleh deploy-full-server.sh dan install-freeradius-billing.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

require_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    log_error "Perintah ini butuh root: sudo bash $0"
    exit 1
  fi
}

detect_os() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    export DETECTED_OS="${ID:-unknown}"
    export DETECTED_OS_VERSION="${VERSION_ID:-}"
    log_info "OS: ${DETECTED_OS} ${DETECTED_OS_VERSION}"
  else
    log_error "Tidak bisa deteksi OS (/etc/os-release tidak ada)"
    exit 1
  fi
}

fr_service_name() {
  if systemctl list-unit-files 2>/dev/null | grep -q '^freeradius\.service'; then
    echo freeradius
  elif systemctl list-unit-files 2>/dev/null | grep -q '^freeradiusd\.service'; then
    echo freeradiusd
  else
    echo freeradius
  fi
}

restart_freeradius() {
  local svc
  svc="$(fr_service_name)"
  if systemctl list-unit-files 2>/dev/null | grep -q "^${svc}\.service"; then
    systemctl enable "$svc" >/dev/null 2>&1 || true
    systemctl restart "$svc"
    sleep 2
    if systemctl is-active --quiet "$svc"; then
      log_success "FreeRADIUS aktif ($svc)"
    else
      log_error "FreeRADIUS gagal start — cek: journalctl -u $svc -n 50"
      exit 1
    fi
  else
    log_warn "Service FreeRADIUS tidak ditemukan"
  fi
}

validate_freeradius_config() {
  if command -v freeradius >/dev/null 2>&1; then
    freeradius -C >/dev/null
    log_success "Validasi config FreeRADIUS OK (freeradius -C)"
  else
    log_warn "Perintah freeradius tidak ada — lewati validasi"
  fi
}

install_freeradius_packages() {
  local mode="${1:-sqlite}"
  export DEBIAN_FRONTEND=noninteractive

  log_info "Install paket FreeRADIUS (mode: $mode)..."
  apt-get update -qq

  if [[ "$mode" == "mysql" ]]; then
    apt-get install -y freeradius freeradius-mysql mariadb-server freeradius-utils
  else
    # Ubuntu 22.04+: SQLite built into freeradius (libsqlite3); no freeradius-sqlite package
    local sqlite_pkgs=(freeradius freeradius-utils sqlite3)
    if apt-cache show freeradius-sqlite &>/dev/null; then
      sqlite_pkgs+=(freeradius-sqlite)
    fi
    apt-get install -y "${sqlite_pkgs[@]}"
  fi

  log_success "Paket FreeRADIUS terpasang"
}

cleanup_freeradius_mods_junk() {
  local mods_dir="/etc/freeradius/3.0/mods-enabled"
  [[ -d $mods_dir ]] || return 0
  find "$mods_dir" -maxdepth 1 -type f \( -name '*.bak*' -o -name '*.backup*' -o -name '*~' \) -delete 2>/dev/null || true
}

enable_freeradius_sql_module() {
  local avail="/etc/freeradius/3.0/mods-available/sql"
  local enabled="/etc/freeradius/3.0/mods-enabled/sql"
  [[ -f $avail ]] || { log_error "mods-available/sql tidak ditemukan"; exit 1; }
  ln -sf "$avail" "$enabled" 2>/dev/null || true
  cleanup_freeradius_mods_junk
}

generate_radius_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 24 | tr -d '/+=' | head -c 24
  else
    date +%s | sha256sum | head -c 24
  fi
}

setup_mysql_radius_database() {
  local mysql_root_pw="${1:-}"
  local radius_pw="${2:-}"

  if [[ -z $radius_pw ]]; then
    radius_pw="$(generate_radius_secret)"
  fi

  if [[ -z $mysql_root_pw ]]; then
    if [[ -f /root/.freeradius_credentials ]]; then
      mysql_root_pw=$(grep 'MARIADB_ROOT_PASSWORD' /root/.freeradius_credentials 2>/dev/null | cut -d'"' -f2 || true)
    fi
  fi

  if [[ -z $mysql_root_pw ]]; then
    log_info "Setup MariaDB root password..."
    mysql_root_pw="$(generate_radius_secret)"
    mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED BY '${mysql_root_pw}'; FLUSH PRIVILEGES;" 2>/dev/null || \
      mysql_secure_installation <<EOF || true

y
${mysql_root_pw}
${mysql_root_pw}
y
y
y
y
EOF
    mkdir -p /root
    cat > /root/.freeradius_credentials <<EOF
MARIADB_ROOT_PASSWORD="${mysql_root_pw}"
RADIUS_MYSQL_PASSWORD="${radius_pw}"
EOF
    chmod 600 /root/.freeradius_credentials
  fi

  mysql -u root -p"${mysql_root_pw}" -e "CREATE DATABASE IF NOT EXISTS radius CHARACTER SET utf8mb4;"
  mysql -u root -p"${mysql_root_pw}" -e "CREATE USER IF NOT EXISTS 'radius'@'localhost' IDENTIFIED BY '${radius_pw}';"
  mysql -u root -p"${mysql_root_pw}" -e "GRANT ALL ON radius.* TO 'radius'@'localhost'; FLUSH PRIVILEGES;"

  local schema="/etc/freeradius/3.0/mods-config/sql/main/mysql/schema.sql"
  if [[ -f $schema ]]; then
    mysql -u root -p"${mysql_root_pw}" radius < "$schema" 2>/dev/null || true
    log_success "Schema MySQL RADIUS diimport"
  fi

  export RADIUS_MYSQL_ROOT_PASSWORD="$mysql_root_pw"
  export RADIUS_MYSQL_PASSWORD="$radius_pw"
}

deploy_freeradius_sqlite_config() {
  local billing_dir="$1"
  local radius_db_path="$2"
  local template="${billing_dir}/deploy/freeradius-mods-sql-sqlite.conf"
  local target="/etc/freeradius/3.0/mods-enabled/sql"

  [[ -f $template ]] || { log_error "Template tidak ada: $template"; exit 1; }

  mkdir -p "$(dirname "$radius_db_path")"
  touch "$radius_db_path"
  chown freerad:freerad "$(dirname "$radius_db_path")" 2>/dev/null || true
  chown freerad:freerad "$radius_db_path" 2>/dev/null || chmod 664 "$radius_db_path"

  sed "s|__RADIUS_DB_PATH__|${radius_db_path}|g" "$template" > "$target"
  chown freerad:freerad "$target"
  chmod 640 "$target"
  log_success "mods-enabled/sql (SQLite) → $radius_db_path"
}

deploy_freeradius_mysql_config() {
  local billing_dir="$1"
  local radius_pw="${2:-}"
  local template="${billing_dir}/deploy/freeradius-mods-sql-mysql.conf"
  local target="/etc/freeradius/3.0/mods-enabled/sql"

  [[ -f $template ]] || { log_error "Template tidak ada: $template"; exit 1; }

  if [[ -n $radius_pw ]]; then
    sed "s|password = \".*\"|password = \"${radius_pw}\"|" "$template" > "$target"
  else
    cp "$template" "$target"
  fi
  chown freerad:freerad "$target"
  chmod 640 "$target"
  log_success "mods-enabled/sql (MySQL) terpasang"
}

init_radius_sqlite_schema() {
  local billing_dir="$1"
  local radius_db_path="$2"

  if [[ ! -d ${billing_dir}/node_modules ]]; then
    log_warn "node_modules belum ada — schema RADIUS dibuat saat billing pertama kali jalan"
    return 0
  fi

  log_info "Inisialisasi schema SQLite RADIUS..."
  (
    cd "$billing_dir"
    RADIUS_SQLITE_PATH="$radius_db_path" node -e "
      const { getRadiusConnection } = require('./config/radiusSQLite');
      (async () => {
        const conn = await getRadiusConnection();
        await conn.end();
        console.log('Schema RADIUS SQLite OK');
        process.exit(0);
      })().catch(e => { console.error(e); process.exit(1); });
    "
  )
  chown freerad:freerad "$radius_db_path" 2>/dev/null || true
  chmod 664 "$radius_db_path" 2>/dev/null || true
  log_success "Schema radius.db siap"
}

apply_freeradius_billing_patches() {
  local billing_dir="$1"
  log_info "Terapkan patch billing (post-auth off, mass-auth, reject_delay)..."
  bash "${billing_dir}/scripts/patch-freeradius-sites-auth-only.sh"
  bash "${billing_dir}/scripts/optimize-freeradius-mass-auth.sh"
  log_success "Patch FreeRADIUS billing selesai"
}

configure_default_nas_client() {
  local nas_ip="${1:-}"
  local nas_secret="${2:-testing123}"
  local clients_conf="/etc/freeradius/3.0/clients.conf"

  [[ -n $nas_ip ]] || return 0
  [[ -f $clients_conf ]] || return 0

  if grep -q "ipaddr = ${nas_ip}" "$clients_conf" 2>/dev/null; then
    log_info "NAS client $nas_ip sudah ada di clients.conf"
    return 0
  fi

  local client_name="mikrotik-$(echo "$nas_ip" | tr '.' '-')"
  cat >> "$clients_conf" <<EOF

# Ditambahkan otomatis oleh install-freeradius-billing.sh
client ${client_name} {
    ipaddr = ${nas_ip}
    secret = ${nas_secret}
    nas_type = other
    require_message_authenticator = no
}
EOF
  log_success "NAS client ditambahkan: $nas_ip"
}

mirror_radius_clients_to_billing() {
  local billing_dir="$1"
  local app_user="${2:-}"

  if [[ -z $app_user ]]; then
    app_user="${SUDO_USER:-${APP_USER:-}}"
  fi
  [[ -n $app_user ]] || { log_warn "Lewati mirror clients.conf — user app tidak diketahui"; return 0; }

  local dest="${billing_dir}/data/clients.conf.mirror"
  mkdir -p "${billing_dir}/data"
  cp /etc/freeradius/3.0/clients.conf "$dest"
  chown "${app_user}:${app_user}" "$dest"
  chmod 640 "$dest"
  log_success "clients.conf mirror → $dest"
}

open_radius_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
    ufw allow 1812/udp comment 'RADIUS auth' >/dev/null 2>&1 || true
    ufw allow 1813/udp comment 'RADIUS acct' >/dev/null 2>&1 || true
    log_success "UFW: port 1812/1813 dibuka"
  fi
}

write_billing_env_radius() {
  local billing_dir="$1"
  local radius_db_path="${2:-}"
  local env_file="${billing_dir}/.env"

  if [[ ! -f $env_file ]]; then
    if [[ -f "${billing_dir}/.env.example" ]]; then
      cp "${billing_dir}/.env.example" "$env_file"
    else
      touch "$env_file"
    fi
  fi

  if [[ -n $radius_db_path ]] && ! grep -q '^RADIUS_SQLITE_PATH=' "$env_file" 2>/dev/null; then
    echo "RADIUS_SQLITE_PATH=${radius_db_path}" >> "$env_file"
  elif [[ -n $radius_db_path ]]; then
    sed -i "s|^RADIUS_SQLITE_PATH=.*|RADIUS_SQLITE_PATH=${radius_db_path}|" "$env_file"
  fi

  if [[ -n ${RADIUS_MYSQL_PASSWORD:-} ]]; then
    for kv in \
      "RADIUS_MYSQL_HOST=127.0.0.1" \
      "RADIUS_MYSQL_PORT=3306" \
      "RADIUS_MYSQL_USER=radius" \
      "RADIUS_MYSQL_PASSWORD=${RADIUS_MYSQL_PASSWORD}" \
      "RADIUS_MYSQL_DATABASE=radius" \
      "RADIUS_ACCOUNTING_MYSQL=auto"; do
      key="${kv%%=*}"
      if grep -q "^${key}=" "$env_file" 2>/dev/null; then
        sed -i "s|^${key}=.*|${kv}|" "$env_file"
      else
        echo "$kv" >> "$env_file"
      fi
    done
  fi

  log_success ".env RADIUS diperbarui"
}

update_billing_radius_db_config() {
  local billing_dir="$1"
  local radius_host="${2:-localhost}"
  local radius_database="${3:-}"
  local radius_password="${4:-}"

  [[ -d ${billing_dir}/node_modules ]] || return 0
  [[ -f ${billing_dir}/data/billing.db ]] || return 0

  (
    cd "$billing_dir"
    node scripts/cli-set-radius-config.js \
      --mode radius \
      --host "$radius_host" \
      --user radius \
      --password "$radius_password" \
      --database "$radius_database"
  )
  log_success "Konfigurasi RADIUS di billing.db diperbarui"
}

install_freeradius_for_billing() {
  # install_freeradius_for_billing <billing_dir> <mode> <radius_db_path> [nas_ip] [nas_secret] [app_user]
  local billing_dir="$1"
  local mode="${2:-sqlite}"
  local radius_db_path="${3:-/var/lib/freeradius/radius.db}"
  local nas_ip="${4:-}"
  local nas_secret="${5:-testing123}"
  local app_user="${6:-}"

  require_root
  detect_os

  if [[ "$DETECTED_OS" != "ubuntu" && "$DETECTED_OS" != "debian" ]]; then
    log_warn "Script dioptimalkan untuk Ubuntu/Debian — lanjut dengan risiko sendiri"
  fi

  install_freeradius_packages "$mode"
  enable_freeradius_sql_module

  if [[ "$mode" == "mysql" ]]; then
    setup_mysql_radius_database "" "${RADIUS_MYSQL_PASSWORD:-}"
    deploy_freeradius_mysql_config "$billing_dir" "${RADIUS_MYSQL_PASSWORD:-}"
    radius_db_path=""
  else
    deploy_freeradius_sqlite_config "$billing_dir" "$radius_db_path"
    init_radius_sqlite_schema "$billing_dir" "$radius_db_path"
  fi

  apply_freeradius_billing_patches "$billing_dir"
  # Pin literal `@` in PPPoE User-Name (disable suffix + soften filter_username + sql_user_name)
  if [[ -f "${billing_dir}/scripts/lib/freeradius-pin-literal-at.sh" ]]; then
    bash "${billing_dir}/scripts/lib/freeradius-pin-literal-at.sh" --no-restart
  elif [[ -f "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/freeradius-pin-literal-at.sh" ]]; then
    bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/freeradius-pin-literal-at.sh" --no-restart
  else
    log_warn "freeradius-pin-literal-at.sh tidak ditemukan — lewati pin @"
  fi
  configure_default_nas_client "$nas_ip" "$nas_secret"
  validate_freeradius_config
  restart_freeradius
  open_radius_firewall

  if [[ -d $billing_dir ]]; then
    mirror_radius_clients_to_billing "$billing_dir" "$app_user"
    if [[ "$mode" == "sqlite" ]]; then
      write_billing_env_radius "$billing_dir" "$radius_db_path"
      update_billing_radius_db_config "$billing_dir" "localhost" "$radius_db_path" ""
    else
      write_billing_env_radius "$billing_dir" ""
      update_billing_radius_db_config "$billing_dir" "localhost" "radius" "${RADIUS_MYSQL_PASSWORD:-}"
    fi
  fi

  log_success "FreeRADIUS siap untuk Billing Kalimasada (mode: $mode)"
}
