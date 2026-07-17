#!/usr/bin/env bash
# radius-pop-sync-apply.sh — di POP (user ajizs, grup freerad): terapkan pending.sql jika SHA baru.
# Dipanggil: (1) langsung dari VPS setelah publish, (2) cron tiap 1 menit cadangan.
# Ringan: no-op jika tidak ada pending / SHA sama. Tidak stop FreeRADIUS.
#
set -euo pipefail

HOME_DIR="${HOME:-/home/ajizs}"
SYNC_DIR="${RADIUS_POP_SYNC_DIR:-$HOME_DIR/radius-sync}"
FR_DB="${RADIUS_DB_PATH:-/var/lib/freeradius/radius.db}"
PENDING="$SYNC_DIR/pending.sql"
PENDING_SHA="$SYNC_DIR/pending.sha256"
PENDING_READY="$SYNC_DIR/pending.ready"
APPLIED_SHA="$SYNC_DIR/applied.sha256"
LOG_FILE="$SYNC_DIR/apply.log"
LOCK_FILE="$SYNC_DIR/apply.lock"

mkdir -p "$SYNC_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

ts() { date -Iseconds; }
log() { echo "$(ts) $*" >> "$LOG_FILE"; }

[[ -f $FR_DB ]] || { log "ERR no db $FR_DB"; exit 1; }
[[ -f $PENDING_READY && -f $PENDING && -f $PENDING_SHA ]] || exit 0

NEW_SHA="$(awk '{print $1; exit}' "$PENDING_SHA" 2>/dev/null || true)"
[[ -n $NEW_SHA ]] || exit 0
OLD_SHA="$(cat "$APPLIED_SHA" 2>/dev/null || true)"
if [[ -n $OLD_SHA && "$OLD_SHA" == "$NEW_SHA" ]]; then
  rm -f "$PENDING_READY"
  exit 0
fi

# Pastikan writable (user di grup freerad)
if [[ ! -w $FR_DB ]]; then
  log "ERR DB tidak writable: $FR_DB (tambahkan user ke grup freerad)"
  exit 1
fi

APPLY_TMP="$SYNC_DIR/applying-$$.sql"
cp -f "$PENDING" "$APPLY_TMP"

sqlite3 "$FR_DB" "PRAGMA busy_timeout=30000;" >/dev/null 2>&1 || true
if ! sqlite3 "$FR_DB" < "$APPLY_TMP" 2>"$SYNC_DIR/apply.err"; then
  log "ERR import gagal: $(head -c 400 "$SYNC_DIR/apply.err" | tr '\n' ' ')"
  rm -f "$APPLY_TMP"
  exit 1
fi

echo "$NEW_SHA" > "$APPLIED_SHA"
rm -f "$PENDING_READY" "$APPLY_TMP"
# pindahkan pending ke last sukses (opsional debug)
mv -f "$PENDING" "$SYNC_DIR/last-applied.sql" 2>/dev/null || true
mv -f "$PENDING_SHA" "$SYNC_DIR/last-applied.sha256" 2>/dev/null || true

RC="$(sqlite3 "$FR_DB" 'SELECT COUNT(*) FROM radcheck;' 2>/dev/null || echo '?')"
RG="$(sqlite3 "$FR_DB" 'SELECT COUNT(*) FROM radusergroup;' 2>/dev/null || echo '?')"
log "OK applied sha=$NEW_SHA radcheck=$RC radusergroup=$RG"
exit 0
