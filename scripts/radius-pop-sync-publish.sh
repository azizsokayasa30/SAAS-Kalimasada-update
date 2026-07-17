#!/usr/bin/env bash
# radius-pop-sync-publish.sh — di VPS: buat dump user RADIUS ringan jika berubah, push ke POP,
# lalu apply segera di POP (MikroTik auth ke FreeRADIUS lokal butuh sync mendekati realtime).
# Dipanggil: (1) hook app setelah write RADIUS, (2) cron tiap 1 menit sebagai cadangan.
# Skip cepat jika tidak ada perubahan.
#
# Env:
#   RADIUS_SQLITE_PATH  default /var/lib/freeradius/radius.db
#   POP_SYNC_HOST       default 10.10.0.12
#   POP_SYNC_USER       default ajizs
#   POP_SYNC_SSH_KEY    default /root/.ssh/id_ed25519_radius_pop
#   POP_SYNC_DIR        remote dir default ~/radius-sync
#   POP_SYNC_APPLY_NOW  default 1 — jalankan apply di POP setelah push (0 = biarkan cron POP)
#
set -euo pipefail

FR_DB="${RADIUS_SQLITE_PATH:-/var/lib/freeradius/radius.db}"
SYNC_DIR="${SYNC_DIR:-/root/Saas-Kalimasada_Inti_Sarana/data/radius-sync}"
STATE_DIR="${STATE_DIR:-/var/lib/kalimasada-radius-sync}"
POP_HOST="${POP_SYNC_HOST:-10.10.0.12}"
POP_USER="${POP_SYNC_USER:-ajizs}"
SSH_KEY="${POP_SYNC_SSH_KEY:-/root/.ssh/id_ed25519_radius_pop}"
REMOTE_DIR="${POP_SYNC_DIR:-radius-sync}"
LOG_TAG="radius-pop-sync-publish"

mkdir -p "$SYNC_DIR" "$STATE_DIR"
DUMP="$SYNC_DIR/radius-users-live.sql"
SHA_FILE="$SYNC_DIR/radius-users-live.sha256"
LAST_SHA_FILE="$STATE_DIR/last-published.sha256"
STAMP_FILE="$STATE_DIR/last-run.txt"

log() { logger -t "$LOG_TAG" "$*" 2>/dev/null || true; echo "[$(date -Iseconds)] $*"; }

[[ -f $FR_DB ]] || { log "ERR DB hilang: $FR_DB"; exit 1; }
[[ -f $SSH_KEY ]] || { log "ERR SSH key hilang: $SSH_KEY"; exit 1; }

# Fingerprint cepat sumber (mtime+size) — hindari dump jika file diam
SRC_FP="$(stat -c '%Y:%s' "$FR_DB" 2>/dev/null || echo none)"
FP_FILE="$STATE_DIR/source-fp.txt"
PREV_FP="$(cat "$FP_FILE" 2>/dev/null || true)"
FORCE="${FORCE_SYNC:-0}"

date -Iseconds > "$STAMP_FILE"

if [[ "$FORCE" != "1" && -n $PREV_FP && "$PREV_FP" == "$SRC_FP" && -f $DUMP && -f $SHA_FILE ]]; then
  # Masih cek SHA remote vs lokal? Cukup skip publish jika sumber sama
  log "skip: sumber radius.db tidak berubah ($SRC_FP)"
  exit 0
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

{
  echo "BEGIN IMMEDIATE;"
  echo "DELETE FROM radcheck;"
  echo "DELETE FROM radusergroup;"
  echo "DELETE FROM radgroupcheck;"
  echo "DELETE FROM radgroupreply;"
  sqlite3 "$FR_DB" "SELECT 'INSERT INTO radcheck(username,attribute,op,value) VALUES(' || quote(username) || ',' || quote(attribute) || ',' || quote(op) || ',' || quote(value) || ');' FROM radcheck;"
  sqlite3 "$FR_DB" "SELECT 'INSERT INTO radusergroup(username,groupname,priority) VALUES(' || quote(username) || ',' || quote(groupname) || ',' || COALESCE(priority,1) || ');' FROM radusergroup;"
  sqlite3 "$FR_DB" "SELECT 'INSERT INTO radgroupcheck(groupname,attribute,op,value) VALUES(' || quote(groupname) || ',' || quote(attribute) || ',' || quote(op) || ',' || quote(value) || ');' FROM radgroupcheck;"
  sqlite3 "$FR_DB" "SELECT 'INSERT INTO radgroupreply(groupname,attribute,op,value) VALUES(' || quote(groupname) || ',' || quote(attribute) || ',' || quote(op) || ',' || quote(value) || ');' FROM radgroupreply;"
  echo "COMMIT;"
} > "$TMP"

SHA="$(sha256sum "$TMP" | awk '{print $1}')"
PREV_SHA="$(cat "$LAST_SHA_FILE" 2>/dev/null || true)"

echo "$SRC_FP" > "$FP_FILE"

if [[ "$FORCE" != "1" && -n $PREV_SHA && "$PREV_SHA" == "$SHA" ]]; then
  log "skip: konten user tables identik ($SHA)"
  cp -f "$TMP" "$DUMP"
  echo "$SHA  radius-users-live.sql" > "$SHA_FILE"
  exit 0
fi

cp -f "$TMP" "$DUMP"
echo "$SHA  radius-users-live.sql" > "$SHA_FILE"
# keep legacy name for manual pull
cp -f "$DUMP" "$SYNC_DIR/radius-users-latest.dump.sql" 2>/dev/null || true

SSH=(ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8)
SCP=(scp -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8)

if ! "${SSH[@]}" "${POP_USER}@${POP_HOST}" "mkdir -p ~/${REMOTE_DIR}"; then
  log "ERR SSH gagal ke ${POP_USER}@${POP_HOST}"
  exit 1
fi

"${SCP[@]}" "$DUMP" "$SHA_FILE" "${POP_USER}@${POP_HOST}:${REMOTE_DIR}/"
"${SSH[@]}" "${POP_USER}@${POP_HOST}" "mv ~/${REMOTE_DIR}/radius-users-live.sql ~/${REMOTE_DIR}/pending.sql && mv ~/${REMOTE_DIR}/radius-users-live.sha256 ~/${REMOTE_DIR}/pending.sha256 && touch ~/${REMOTE_DIR}/pending.ready"

echo "$SHA" > "$LAST_SHA_FILE"
BYTES="$(wc -c < "$DUMP" | tr -d ' ')"
log "published $BYTES bytes sha=$SHA → ${POP_USER}@${POP_HOST}:${REMOTE_DIR}/pending.*"

# Apply segera di POP — jangan tunggu cron 1 menit (auth MikroTik sudah ke RADIUS lokal)
APPLY_NOW="${POP_SYNC_APPLY_NOW:-1}"
if [[ "$APPLY_NOW" == "1" ]]; then
  if "${SSH[@]}" "${POP_USER}@${POP_HOST}" "bash ~/${REMOTE_DIR}/radius-pop-sync-apply.sh"; then
    log "applied on POP immediately"
  else
    log "WARN apply remote gagal — cron POP akan coba ulang <=1 menit"
  fi
fi
exit 0
