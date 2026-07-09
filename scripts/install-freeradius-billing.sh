#!/usr/bin/env bash
#
# install-freeradius-billing.sh — Install FreeRADIUS + konfigurasi ke Billing Kalimasada
# Untuk server RADIUS terpisah di lokasi POP (tanpa install billing penuh).
#
# Jalankan di server POP (Ubuntu/Debian):
#   sudo bash scripts/install-freeradius-billing.sh
#
# Dengan billing app di server yang sama:
#   sudo bash scripts/install-freeradius-billing.sh --billing-dir /var/www/billing-kalimasada
#
# Variabel lingkungan / opsi:
#   --mode sqlite|mysql     default: mysql (disarankan untuk POP terpisah)
#   --billing-dir PATH      folder repo billing (untuk template & update billing.db)
#   --radius-db PATH        path radius.db (mode sqlite, default: /var/lib/freeradius/radius.db)
#   --pop-name NAMA         label POP (informasi saja)
#   --billing-host IP       IP server billing pusat (informasi + catatan sinkronisasi)
#   --nas-ip IP             IP Mikrotik/NAS pertama
#   --nas-secret SECRET     secret RADIUS NAS (default: testing123)
#   --mysql-password PASS   password user MySQL radius (auto-generate jika kosong)
#   --allow-remote-mysql    buka akses MySQL radius dari billing-host (hati-hati firewall)
#   --no-restart            jangan restart FreeRADIUS di akhir
#
# Contoh POP dengan MySQL (billing pusat sync via RADIUS_MYSQL_*):
#   sudo BILLING_HOST=10.0.1.5 bash scripts/install-freeradius-billing.sh \
#     --mode mysql --pop-name "POP Lebakwangi" --nas-ip 192.168.10.1 --nas-secret RahasiaPOP1
#
# Contoh POP SQLite (billing & radius satu mesin):
#   sudo bash scripts/install-freeradius-billing.sh \
#     --mode sqlite --billing-dir /var/www/billing-kalimasada
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_BILLING_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/freeradius-billing-common.sh
source "${SCRIPT_DIR}/lib/freeradius-billing-common.sh"

RADIUS_MODE="${RADIUS_MODE:-mysql}"
RADIUS_DB_PATH="${RADIUS_DB_PATH:-/var/lib/freeradius/radius.db}"
BILLING_DIR="${BILLING_DIR:-}"
POP_NAME="${POP_NAME:-}"
BILLING_HOST="${BILLING_HOST:-}"
NAS_IP="${NAS_IP:-}"
NAS_SECRET="${NAS_SECRET:-testing123}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-}"
ALLOW_REMOTE_MYSQL=0
NO_RESTART=0

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --mode) RADIUS_MODE="$2"; shift 2 ;;
      --billing-dir) BILLING_DIR="$2"; shift 2 ;;
      --radius-db) RADIUS_DB_PATH="$2"; shift 2 ;;
      --pop-name) POP_NAME="$2"; shift 2 ;;
      --billing-host) BILLING_HOST="$2"; shift 2 ;;
      --nas-ip) NAS_IP="$2"; shift 2 ;;
      --nas-secret) NAS_SECRET="$2"; shift 2 ;;
      --mysql-password) MYSQL_PASSWORD="$2"; shift 2 ;;
      --allow-remote-mysql) ALLOW_REMOTE_MYSQL=1; shift ;;
      --no-restart) NO_RESTART=1; shift ;;
      -h|--help) usage 0 ;;
      *) log_error "Opsi tidak dikenal: $1"; usage 1 ;;
    esac
  done
}

resolve_billing_dir() {
  if [[ -z $BILLING_DIR ]]; then
    if [[ -f "${DEFAULT_BILLING_DIR}/deploy/freeradius-mods-sql-sqlite.conf" ]]; then
      BILLING_DIR="$DEFAULT_BILLING_DIR"
    else
      BILLING_DIR="/tmp/billing-kalimasada-templates"
      mkdir -p "$BILLING_DIR/deploy" "$BILLING_DIR/scripts/lib"
      cp "${SCRIPT_DIR}/patch-freeradius-sites-auth-only.sh" "$BILLING_DIR/scripts/"
      cp "${SCRIPT_DIR}/optimize-freeradius-mass-auth.sh" "$BILLING_DIR/scripts/"
      for conf in freeradius-mods-sql-sqlite.conf freeradius-mods-sql-mysql.conf; do
        [[ -f "${DEFAULT_BILLING_DIR}/deploy/${conf}" ]] && \
          cp "${DEFAULT_BILLING_DIR}/deploy/${conf}" "$BILLING_DIR/deploy/"
      done
      log_warn "Billing dir tidak ada — pakai template minimal di $BILLING_DIR"
    fi
  fi

  for f in \
    "${BILLING_DIR}/deploy/freeradius-mods-sql-sqlite.conf" \
    "${BILLING_DIR}/scripts/patch-freeradius-sites-auth-only.sh" \
    "${BILLING_DIR}/scripts/optimize-freeradius-mass-auth.sh"; do
    [[ -f $f ]] || { log_error "File wajib tidak ada: $f"; exit 1; }
  done

  if [[ "$RADIUS_MODE" == "mysql" ]]; then
    [[ -f "${BILLING_DIR}/deploy/freeradius-mods-sql-mysql.conf" ]] || \
      { log_error "Template MySQL tidak ada: deploy/freeradius-mods-sql-mysql.conf"; exit 1; }
  fi

  log_info "Billing/template dir: $BILLING_DIR"
}

allow_remote_mysql_from_billing() {
  [[ $ALLOW_REMOTE_MYSQL -eq 1 ]] || return 0
  [[ -n $BILLING_HOST ]] || { log_warn "--allow-remote-mysql butuh --billing-host"; return 0; }
  [[ -n ${RADIUS_MYSQL_PASSWORD:-} ]] || return 0

  local root_pw="${RADIUS_MYSQL_ROOT_PASSWORD:-}"
  [[ -n $root_pw ]] || return 0

  log_info "Buka akses MySQL radius dari $BILLING_HOST ..."
  mysql -u root -p"${root_pw}" -e \
    "CREATE USER IF NOT EXISTS 'radius'@'${BILLING_HOST}' IDENTIFIED BY '${RADIUS_MYSQL_PASSWORD}';" 2>/dev/null || true
  mysql -u root -p"${root_pw}" -e \
    "GRANT ALL ON radius.* TO 'radius'@'${BILLING_HOST}'; FLUSH PRIVILEGES;" 2>/dev/null || true
  log_warn "Pastikan firewall hanya mengizinkan $BILLING_HOST → port 3306"
  log_success "User radius@${BILLING_HOST} dibuat (jika belum ada)"
}

write_pop_info_file() {
  local info_dir="/etc/freeradius/billing-pop"
  mkdir -p "$info_dir"
  cat > "${info_dir}/pop-info.env" <<EOF
# Dibuat oleh install-freeradius-billing.sh — $(date -Iseconds)
POP_NAME=${POP_NAME:-unset}
BILLING_HOST=${BILLING_HOST:-unset}
RADIUS_MODE=${RADIUS_MODE}
RADIUS_DB_PATH=${RADIUS_DB_PATH}
AUTH_PORT=1812
ACCT_PORT=1813
EOF
  if [[ -n ${RADIUS_MYSQL_PASSWORD:-} ]]; then
    echo "RADIUS_MYSQL_PASSWORD=${RADIUS_MYSQL_PASSWORD}" >> "${info_dir}/pop-info.env"
  fi
  chmod 600 "${info_dir}/pop-info.env"
  log_success "Info POP disimpan: ${info_dir}/pop-info.env"
}

print_pop_registration_hint() {
  local server_ip
  server_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'IP_SERVER_POP')"

  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║         FreeRADIUS POP — Siap Terhubung ke Billing           ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  [[ -n $POP_NAME ]] && echo "  POP Name       : $POP_NAME"
  echo "  Server IP      : $server_ip"
  echo "  RADIUS Auth    : udp/$server_ip:1812"
  echo "  RADIUS Acct    : udp/$server_ip:1813"
  echo "  Mode           : $RADIUS_MODE"
  if [[ "$RADIUS_MODE" == "sqlite" ]]; then
    echo "  Database file  : $RADIUS_DB_PATH"
  else
    echo "  MySQL database : radius (user: radius)"
    if [[ -n ${RADIUS_MYSQL_PASSWORD:-} ]]; then
      echo "  MySQL password : ${RADIUS_MYSQL_PASSWORD}"
    fi
  fi
  echo ""
  echo -e "${CYAN}Daftarkan di Management Portal:${NC}"
  echo "  Menu: POP / Cabang → RADIUS Server"
  echo "  Host     : $server_ip"
  echo "  Auth Port: 1812"
  echo "  Acct Port: 1813"
  echo "  Secret   : (sama dengan secret di Mikrotik / NAS)"
  echo ""
  echo -e "${CYAN}Di Mikrotik POP:${NC}"
  echo "  /radius add address=$server_ip secret=$NAS_SECRET service=ppp,hotspot timeout=3s"
  echo ""
  if [[ "$RADIUS_MODE" == "mysql" && -n $BILLING_HOST ]]; then
    echo -e "${CYAN}Di server billing pusat (.env) untuk sync ke POP ini:${NC}"
    echo "  RADIUS_MYSQL_HOST=$server_ip"
    echo "  RADIUS_MYSQL_USER=radius"
    echo "  RADIUS_MYSQL_PASSWORD=<password di atas>"
    echo "  RADIUS_MYSQL_DATABASE=radius"
    echo "  RADIUS_ACCOUNTING_MYSQL=auto"
    echo ""
    echo "  Lalu: npm run radius:migrate-mysql (jika belum) dan restart PM2"
  fi
  echo -e "${CYAN}Verifikasi:${NC}"
  echo "  systemctl status freeradius"
  echo "  radtest USER PASSWORD 127.0.0.1 0 $NAS_SECRET"
  echo "  tail -f /var/log/freeradius/radius.log"
  echo ""
}

main() {
  parse_args "$@"
  require_root

  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║   Install FreeRADIUS untuk Billing Kalimasada (POP)          ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""

  resolve_billing_dir

  if [[ -n $MYSQL_PASSWORD ]]; then
    export RADIUS_MYSQL_PASSWORD="$MYSQL_PASSWORD"
  fi

  install_freeradius_for_billing \
    "$BILLING_DIR" \
    "$RADIUS_MODE" \
    "$RADIUS_DB_PATH" \
    "$NAS_IP" \
    "$NAS_SECRET" \
    "${SUDO_USER:-}"

  allow_remote_mysql_from_billing
  write_pop_info_file

  if [[ $NO_RESTART -eq 1 ]]; then
    log_info "--no-restart: lewati restart tambahan"
  fi

  print_pop_registration_hint
}

main "$@"
