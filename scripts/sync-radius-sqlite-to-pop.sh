#!/usr/bin/env bash
# sync-radius-sqlite-to-pop.sh — dari VPS: push / serve dump ke FreeRADIUS lokal
#
# Mode A (SSH key sudah terpasang di POP):
#   sudo bash scripts/sync-radius-sqlite-to-pop.sh --host 10.10.0.12
#
# Mode B (tanpa SSH — serve lewat WireGuard, jalankan pull di POP):
#   sudo bash scripts/sync-radius-sqlite-to-pop.sh --serve
#   # di POP: curl -fsSL http://10.10.0.1:9876/pull-radius-on-pop.sh | sudo bash
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FR_DB="${RADIUS_SQLITE_PATH:-/var/lib/freeradius/radius.db}"
SYNC_DIR="$ROOT/data/radius-sync"
DUMP="$SYNC_DIR/radius-users-latest.dump.sql"
POP_HOST=""
SSH_KEY="${SSH_KEY:-/root/.ssh/id_ed25519_radius_pop}"
SSH_USER="${SSH_USER:-ajizs}"
SERVE=0
SERVE_PORT="${SERVE_PORT:-9876}"
SERVE_BIND="${SERVE_BIND:-10.10.0.1}"
REMOTE_DB="${REMOTE_DB:-/var/lib/freeradius/radius.db}"

log() { echo "[*] $*"; }
ok() { echo "[OK] $*"; }
die() { echo "[ERR] $*" >&2; exit 1; }

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) POP_HOST="$2"; shift 2 ;;
    --key) SSH_KEY="$2"; shift 2 ;;
    --user) SSH_USER="$2"; shift 2 ;;
    --serve) SERVE=1; shift ;;
    --port) SERVE_PORT="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) die "Opsi tidak dikenal: $1" ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || die "Jalankan dengan sudo"
[[ -f $FR_DB ]] || die "DB sumber tidak ada: $FR_DB"
mkdir -p "$SYNC_DIR"

log "Dump tabel user dari $FR_DB ..."
sqlite3 "$FR_DB" ".dump radcheck radusergroup radgroupcheck radgroupreply" > "$DUMP"
ok "Dump: $DUMP ($(wc -c < "$DUMP") bytes)"
cp -f "$ROOT/data/radius-sync/pull-radius-on-pop.sh" "$SYNC_DIR/pull-radius-on-pop.sh" 2>/dev/null || true
chmod +x "$SYNC_DIR/pull-radius-on-pop.sh" 2>/dev/null || true

if [[ $SERVE -eq 1 ]]; then
  log "Serve dump di http://${SERVE_BIND}:${SERVE_PORT}/ (hanya WireGuard)"
  log "Di POP jalankan:"
  echo "  curl -fsSL http://${SERVE_BIND}:${SERVE_PORT}/pull-radius-on-pop.sh | sudo bash"
  cd "$SYNC_DIR"
  exec python3 -m http.server "$SERVE_PORT" --bind "$SERVE_BIND"
fi

[[ -n $POP_HOST ]] || die "Pakai --host 10.10.0.12 atau --serve"
[[ -f $SSH_KEY ]] || die "SSH key tidak ada: $SSH_KEY — tambahkan pubkey ke POP dulu"

SSH=(ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8)
SCP=(scp -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8)

log "Cek SSH ${SSH_USER}@${POP_HOST} ..."
"${SSH[@]}" "${SSH_USER}@${POP_HOST}" 'echo ok' >/dev/null || die "SSH gagal — pasang pubkey di POP"

REMOTE_TMP="/tmp/radius-users-sync-$$.dump.sql"
log "Upload dump..."
"${SCP[@]}" "$DUMP" "${SSH_USER}@${POP_HOST}:${REMOTE_TMP}"

log "Import di POP (backup + replace tabel user, via sudo)..."
"${SSH[@]}" "${SSH_USER}@${POP_HOST}" bash -s <<REMOTE
set -euo pipefail
FR_DB="${REMOTE_DB}"
DUMP="${REMOTE_TMP}"
BAK="\${FR_DB}.bak-before-sync-\$(date +%Y%m%d-%H%M%S)"
SUDO=""
if [[ \${EUID:-0} -ne 0 ]]; then
  command -v sudo >/dev/null || { echo "Butuh sudo di POP"; exit 1; }
  SUDO="sudo"
fi
\$SUDO cp -a "\$FR_DB" "\$BAK"
\$SUDO systemctl stop freeradius 2>/dev/null || \$SUDO systemctl stop freeradiusd 2>/dev/null || true
\$SUDO sqlite3 "\$FR_DB" "PRAGMA foreign_keys=OFF; DROP TABLE IF EXISTS radcheck; DROP TABLE IF EXISTS radusergroup; DROP TABLE IF EXISTS radgroupcheck; DROP TABLE IF EXISTS radgroupreply;"
\$SUDO sqlite3 "\$FR_DB" < "\$DUMP"
\$SUDO chown freerad:freerad "\$FR_DB" 2>/dev/null || true
\$SUDO chmod 664 "\$FR_DB" 2>/dev/null || true
\$SUDO systemctl start freeradius 2>/dev/null || \$SUDO systemctl start freeradiusd 2>/dev/null || true
echo "radcheck=\$(\$SUDO sqlite3 "\$FR_DB" 'SELECT COUNT(*) FROM radcheck;')"
rm -f "\$DUMP"
REMOTE

ok "Sync ke ${POP_HOST} selesai"
