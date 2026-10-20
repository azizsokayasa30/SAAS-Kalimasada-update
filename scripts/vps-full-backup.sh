#!/bin/bash
# Full VPS filesystem backup for migrating SaaS billing + FreeRADIUS + Nginx/SSL + PM2.
# Usage (as root):
#   bash scripts/vps-full-backup.sh
# Env:
#   OUT_DIR=/root          # where archive is written
#   KEEP_RUNNING=1         # skip stopping PM2/FreeRADIUS/Nginx (not recommended)
#   APP_DIR=/root/Saas-Kalimasada_Inti_Sarana

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: jalankan sebagai root (sudo)." >&2
  exit 1
fi

OUT_DIR="${OUT_DIR:-/root}"
APP_DIR="${APP_DIR:-/root/Saas-Kalimasada_Inti_Sarana}"
KEEP_RUNNING="${KEEP_RUNNING:-0}"
STAMP="$(date +%Y%m%d_%H%M%S)"
WORKDIR="${OUT_DIR}/.vps-full-work-${STAMP}"
MANIFEST="${WORKDIR}/MANIFEST.txt"
ARCHIVE=""
PM2_WAS_RUNNING=0
FR_WAS_RUNNING=0
NGINX_WAS_RUNNING=0
FR_UNIT=""

mkdir -p "$OUT_DIR" "$WORKDIR"

log() { echo "[$(date '+%F %T')] $*"; }

cleanup_on_fail() {
  local ec=$?
  if [[ "$ec" -ne 0 ]]; then
    log "BACKUP GAGAL (exit=$ec). Mencoba start ulang service..."
    start_services || true
  fi
}
trap cleanup_on_fail EXIT

detect_freeradius_unit() {
  if systemctl list-unit-files freeradius.service >/dev/null 2>&1 && \
     systemctl cat freeradius.service >/dev/null 2>&1; then
    FR_UNIT="freeradius"
  elif systemctl list-unit-files freeradius3.service >/dev/null 2>&1 && \
       systemctl cat freeradius3.service >/dev/null 2>&1; then
    FR_UNIT="freeradius3"
  else
    FR_UNIT=""
  fi
}

stop_services() {
  if [[ "$KEEP_RUNNING" == "1" ]]; then
    log "KEEP_RUNNING=1 — service tidak di-stop"
    return 0
  fi

  if command -v pm2 >/dev/null 2>&1; then
    if pm2 describe billing-kalimasada >/dev/null 2>&1; then
      # Selalu revive setelah backup jika proses terdaftar di PM2
      PM2_WAS_RUNNING=1
      log "Stop PM2 billing-kalimasada"
      pm2 stop billing-kalimasada >/dev/null 2>&1 || true
    fi
  fi

  detect_freeradius_unit
  if [[ -n "$FR_UNIT" ]] && systemctl is-active --quiet "$FR_UNIT" 2>/dev/null; then
    FR_WAS_RUNNING=1
    log "Stop ${FR_UNIT}"
    systemctl stop "$FR_UNIT" || true
  fi

  if systemctl is-active --quiet nginx 2>/dev/null; then
    NGINX_WAS_RUNNING=1
    log "Stop nginx (cegah log berubah saat tar)"
    systemctl stop nginx || true
  fi
}

start_services() {
  if [[ "$KEEP_RUNNING" == "1" ]]; then
    return 0
  fi

  if [[ "$NGINX_WAS_RUNNING" == "1" ]]; then
    log "Start nginx"
    systemctl start nginx || true
  fi

  if [[ "$FR_WAS_RUNNING" == "1" && -n "$FR_UNIT" ]]; then
    log "Start ${FR_UNIT}"
    systemctl start "$FR_UNIT" || true
  fi

  if [[ "$PM2_WAS_RUNNING" == "1" ]] && command -v pm2 >/dev/null 2>&1; then
    log "Start PM2 billing-kalimasada"
    pm2 start billing-kalimasada >/dev/null 2>&1 || \
      (cd "$APP_DIR" && pm2 start ecosystem.config.cjs >/dev/null 2>&1) || true
  fi
}

wal_checkpoint() {
  if ! command -v sqlite3 >/dev/null 2>&1; then
    log "WARN: sqlite3 tidak ada — lewati WAL checkpoint"
    return 0
  fi
  local f
  for f in \
    "${APP_DIR}/data/billing.db" \
    "${APP_DIR}/data/sessions.db" \
    "${APP_DIR}/data/radius.db" \
    "/var/lib/freeradius/radius.db"
  do
    if [[ -f "$f" ]]; then
      log "WAL checkpoint: $f"
      sqlite3 "$f" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || \
        log "WARN: checkpoint gagal untuk $f"
    fi
  done
}

write_manifest() {
  {
    echo "VPS Full Backup Manifest"
    echo "created_at=$(date -Is)"
    echo "hostname=$(hostname)"
    echo "uname=$(uname -a)"
    echo "---- os-release ----"
    cat /etc/os-release 2>/dev/null || true
    echo "---- disk ----"
    df -hT / 2>/dev/null || true
    echo "---- app ----"
    echo "APP_DIR=${APP_DIR}"
    du -sh "${APP_DIR}" 2>/dev/null || true
    du -sh "${APP_DIR}/data" "${APP_DIR}/whatsapp-session" "${APP_DIR}/public" 2>/dev/null || true
    echo "---- freeradius ----"
    du -sh /var/lib/freeradius /etc/freeradius 2>/dev/null || true
    echo "---- services ----"
    systemctl is-active freeradius freeradius3 nginx 2>/dev/null || true
    if command -v pm2 >/dev/null 2>&1; then
      pm2 jlist 2>/dev/null | head -c 4000 || true
      echo
    fi
    echo "---- keep_running=${KEEP_RUNNING} ----"
  } >"$MANIFEST"
}

# tar exit 1 = file berubah saat dibaca (aman). exit >=2 = fatal.
tolerate_tar_exit() {
  local tar_ec="${1:-0}"
  # pastikan angka
  if ! [[ "$tar_ec" =~ ^[0-9]+$ ]]; then
    log "ERROR: exit code tar tidak valid: ${tar_ec}"
    return 2
  fi
  if [[ "$tar_ec" -eq 0 ]]; then
    return 0
  fi
  if [[ "$tar_ec" -eq 1 ]]; then
    log "WARN: tar exit 1 (beberapa file berubah saat dibaca) — arsip tetap dipakai"
    return 0
  fi
  log "ERROR: tar gagal fatal (exit=${tar_ec})"
  return "$tar_ec"
}

create_archive() {
  local archive_base="${OUT_DIR}/vps-full-${STAMP}"
  local exclude_file="${WORKDIR}/exclude.txt"
  local tar_ec=0

  cat >"$exclude_file" <<EOF
./proc
./sys
./dev
./run
./tmp
./mnt
./media
./lost+found
./snap
./proc/*
./sys/*
./dev/*
./run/*
./tmp/*
./mnt/*
./media/*
./snap/*
./var/tmp/*
./var/cache/apt/archives/*.deb
./var/log
./var/log/*
./root/.vps-full-work-${STAMP}
./root/.vps-full-work-${STAMP}/*
./root/vps-full-${STAMP}.tar
./root/vps-full-${STAMP}.tar.gz
./root/vps-full-${STAMP}.tar.zst
./root/vps-full-${STAMP}.tar.gz.sha256
./root/vps-full-${STAMP}.tar.zst.sha256
./root/vps-full-*.tar.gz
./root/vps-full-*.tar.zst
./root/billing-full-*.tar.gz
./root/Saas-Kalimasada_Inti_Sarana/logs
./root/Saas-Kalimasada_Inti_Sarana/logs/*
./root/vps-full-backup-rerun.log
EOF

  local used_kb avail_kb
  used_kb="$(df -Pk / | awk 'NR==2{print $3}')"
  avail_kb="$(df -Pk "$OUT_DIR" | awk 'NR==2{print $4}')"
  if [[ "${avail_kb:-0}" -lt 20971520 ]]; then
    log "WARN: ruang bebas di ${OUT_DIR} < 20GB — backup mungkin gagal"
  fi
  log "Disk used≈$((used_kb/1024/1024))G, free on OUT_DIR≈$((avail_kb/1024/1024))G"

  if command -v zstd >/dev/null 2>&1; then
    ARCHIVE="${archive_base}.tar.zst"
    log "Membuat arsip (tar -I zstd): $ARCHIVE"
    # Satu proses tar+zstd — hindari pipefail/PIPESTATUS yang bikin exit 1 keliru
    set +e
    tar \
      -I 'zstd -T0 -3' \
      --exclude-from="$exclude_file" \
      --warning=no-file-ignored \
      --numeric-owner \
      --one-file-system \
      -C / \
      -cf "$ARCHIVE" \
      .
    tar_ec=$?
    set -e
    tolerate_tar_exit "$tar_ec"
  else
    ARCHIVE="${archive_base}.tar.gz"
    log "zstd tidak ada — fallback gzip: $ARCHIVE"
    set +e
    tar \
      --exclude-from="$exclude_file" \
      --warning=no-file-ignored \
      --numeric-owner \
      --one-file-system \
      -C / \
      -czf "$ARCHIVE" \
      .
    tar_ec=$?
    set -e
    tolerate_tar_exit "$tar_ec"
  fi

  if [[ ! -s "$ARCHIVE" ]]; then
    log "ERROR: arsip kosong atau tidak ada: $ARCHIVE"
    return 1
  fi

  cp -f "$MANIFEST" "${archive_base}.MANIFEST.txt"
  log "Checksum SHA256..."
  sha256sum "$ARCHIVE" | tee "${ARCHIVE}.sha256"
  ls -lh "$ARCHIVE" "${ARCHIVE}.sha256" "${archive_base}.MANIFEST.txt"
}

# ---- main ----
log "=== VPS Full Backup mulai ==="
log "OUT_DIR=${OUT_DIR} APP_DIR=${APP_DIR}"

write_manifest
stop_services
wal_checkpoint
create_archive
start_services

rm -rf "$WORKDIR"

trap - EXIT
log "=== SELESAI ==="
log "Arsip : ${ARCHIVE}"
log "SHA256: ${ARCHIVE}.sha256"
log "Salin ke server baru, lalu:"
log "  sudo bash /root/Saas-Kalimasada_Inti_Sarana/scripts/vps-full-restore.sh ${ARCHIVE}"
exit 0
