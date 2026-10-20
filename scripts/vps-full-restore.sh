#!/bin/bash
# Restore full VPS archive (app + FreeRADIUS + Nginx/SSL + PM2) onto a fresh Ubuntu 22.04.
# Usage (as root on NEW server):
#   bash scripts/vps-full-restore.sh /root/vps-full-YYYYMMDD_HHMMSS.tar.zst
# Env:
#   APP_DIR=/root/Saas-Kalimasada_Inti_Sarana
#   RESTORE_SSH_KEYS=1     # also restore /etc/ssh/ssh_host_* from backup (default: keep new host keys)
#   SKIP_CHECKSUM=1        # skip .sha256 verification if file missing/unwanted

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: jalankan sebagai root (sudo)." >&2
  exit 1
fi

ARCHIVE="${1:-}"
APP_DIR="${APP_DIR:-/root/Saas-Kalimasada_Inti_Sarana}"
RESTORE_SSH_KEYS="${RESTORE_SSH_KEYS:-0}"
SKIP_CHECKSUM="${SKIP_CHECKSUM:-0}"

log() { echo "[$(date '+%F %T')] $*"; }

if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "Usage: $0 /path/to/vps-full-XXXX.tar.zst|.tar.gz" >&2
  exit 1
fi

ARCHIVE="$(readlink -f "$ARCHIVE")"
SUMFILE="${ARCHIVE}.sha256"

verify_checksum() {
  if [[ "$SKIP_CHECKSUM" == "1" ]]; then
    log "SKIP_CHECKSUM=1 — lewati verifikasi"
    return 0
  fi
  if [[ ! -f "$SUMFILE" ]]; then
    log "WARN: ${SUMFILE} tidak ada — lewati verifikasi"
    return 0
  fi
  log "Verifikasi SHA256..."
  # sha256sum -c expects relative or matching path; run from archive dir
  (
    cd "$(dirname "$ARCHIVE")"
    sha256sum -c "$(basename "$SUMFILE")"
  )
}

extract_archive() {
  local exclude_args=(
    --exclude='./proc'
    --exclude='./sys'
    --exclude='./dev'
    --exclude='./run'
    --exclude='./tmp'
    --exclude='./mnt'
    --exclude='./media'
    --exclude='./lost+found'
    --exclude='./snap'
    --exclude='./etc/fstab'
    --exclude='./etc/hostname'
    --exclude='./etc/hosts'
    --exclude='./etc/machine-id'
    --exclude='./etc/netplan'
    --exclude='./etc/network'
    --exclude='./etc/resolv.conf'
    --exclude='./etc/cloud'
    --exclude='./var/lib/cloud'
  )

  if [[ "$RESTORE_SSH_KEYS" != "1" ]]; then
    exclude_args+=(
      --exclude='./etc/ssh/ssh_host_*'
    )
  fi

  # Jangan timpa arsip yang sedang di-restore di /root
  exclude_args+=(
    --exclude="./root/$(basename "$ARCHIVE")"
    --exclude="./root/$(basename "$SUMFILE")"
  )

  log "Extract ke / (host network/identity dipertahankan)..."
  case "$ARCHIVE" in
    *.tar.zst)
      if ! command -v zstd >/dev/null 2>&1; then
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq zstd
      fi
      zstd -dc "$ARCHIVE" | tar -xpf - -C / "${exclude_args[@]}"
      ;;
    *.tar.gz|*.tgz)
      tar -xzpf "$ARCHIVE" -C / "${exclude_args[@]}"
      ;;
    *.tar)
      tar -xpf "$ARCHIVE" -C / "${exclude_args[@]}"
      ;;
    *)
      echo "ERROR: format arsip tidak dikenali: $ARCHIVE" >&2
      exit 1
      ;;
  esac
}

fix_ownership() {
  if id freerad >/dev/null 2>&1; then
    [[ -d /var/lib/freeradius ]] && chown -R freerad:freerad /var/lib/freeradius || true
    [[ -d /etc/freeradius ]] && chown -R freerad:freerad /etc/freeradius || true
  fi
  if [[ -d "$APP_DIR" ]]; then
    # pastikan app readable; owner root OK untuk setup Hostinger ini
    chmod 755 "$APP_DIR" 2>/dev/null || true
  fi
  # systemd / dbus machine-id: regenerate if empty after exclude
  if [[ ! -s /etc/machine-id ]]; then
    systemd-machine-id-setup 2>/dev/null || true
  fi
}

start_stack() {
  log "Reload systemd daemon"
  systemctl daemon-reload 2>/dev/null || true

  if command -v nginx >/dev/null 2>&1; then
    if nginx -t 2>/dev/null; then
      systemctl enable nginx >/dev/null 2>&1 || true
      systemctl restart nginx || systemctl start nginx || true
    else
      log "WARN: nginx -t gagal — periksa config manual"
    fi
  fi

  local fr_unit=""
  if systemctl cat freeradius.service >/dev/null 2>&1; then
    fr_unit="freeradius"
  elif systemctl cat freeradius3.service >/dev/null 2>&1; then
    fr_unit="freeradius3"
  fi
  if [[ -n "$fr_unit" ]]; then
    systemctl enable "$fr_unit" >/dev/null 2>&1 || true
    systemctl restart "$fr_unit" || systemctl start "$fr_unit" || \
      log "WARN: gagal start ${fr_unit}"
  fi

  if command -v pm2 >/dev/null 2>&1; then
    if [[ -f "${APP_DIR}/ecosystem.config.cjs" ]]; then
      log "Start PM2 dari ecosystem.config.cjs"
      (cd "$APP_DIR" && pm2 startOrReload ecosystem.config.cjs --update-env) || \
        (cd "$APP_DIR" && pm2 start ecosystem.config.cjs) || true
      pm2 save >/dev/null 2>&1 || true
    elif pm2 describe billing-kalimasada >/dev/null 2>&1; then
      pm2 restart billing-kalimasada >/dev/null 2>&1 || pm2 start billing-kalimasada || true
      pm2 save >/dev/null 2>&1 || true
    else
      log "WARN: PM2 ecosystem / proses billing-kalimasada tidak ditemukan"
    fi
  else
    log "WARN: pm2 tidak ada di PATH — install: npm install -g pm2"
  fi
}

print_verify() {
  echo
  log "=== Status setelah restore ==="
  systemctl is-active nginx freeradius freeradius3 2>/dev/null || true
  command -v pm2 >/dev/null 2>&1 && pm2 status || true

  if command -v sqlite3 >/dev/null 2>&1; then
    if [[ -f "${APP_DIR}/data/billing.db" ]]; then
      echo -n "billing.db integrity: "
      sqlite3 "${APP_DIR}/data/billing.db" "PRAGMA integrity_check;" 2>/dev/null || echo "FAIL"
    fi
    if [[ -f /var/lib/freeradius/radius.db ]]; then
      echo -n "radius.db integrity: "
      sqlite3 /var/lib/freeradius/radius.db "PRAGMA integrity_check;" 2>/dev/null || echo "FAIL"
    fi
  fi

  cat <<EOF

=== Checklist cutover (manual) ===
1. Arahkan DNS domain ke IP server baru
2. Jika IP server berubah: update RADIUS client di Mikrotik + /etc/freeradius clients
3. Sesuaikan PUBLIC_APP_BASE_URL / IP di ${APP_DIR}/.env bila perlu
4. Uji login admin, 1 tenant, auth PPPoE/hotspot, WhatsApp session
5. JANGAN jalankan scripts/fresh-server-installation.js (menghapus data)

EOF
}

# ---- main ----
log "=== VPS Full Restore mulai ==="
log "Archive: ${ARCHIVE}"
log "APP_DIR: ${APP_DIR}"

verify_checksum
extract_archive
fix_ownership
start_stack
print_verify

log "=== RESTORE SELESAI ==="
exit 0
