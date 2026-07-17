#!/usr/bin/env bash
# Verifikasi persiapan Radius Manager + FreeRADIUS aktif (READ-ONLY).
# TIDAK mengubah /radius di MikroTik, TIDAK memutus PPPoE, TIDAK restart FreeRADIUS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FR_DB="${RADIUS_SQLITE_PATH:-/var/lib/freeradius/radius.db}"
BILLING_DB="$ROOT/data/billing.db"
STALE_COPY="$ROOT/data/radius.db"
REPORT_DIR="$ROOT/data/reports"
mkdir -p "$REPORT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$REPORT_DIR/radius-manager-prep-$STAMP.txt"

{
  echo "=== Radius Manager prep verification ==="
  echo "Waktu: $(date -R)"
  echo "Host: $(hostname) / $(hostname -I 2>/dev/null | tr -s ' ')"
  echo

  echo "--- FreeRADIUS service ---"
  if systemctl is-active freeradius >/dev/null 2>&1; then
    echo "status: active"
    systemctl status freeradius --no-pager -l 2>/dev/null | head -12 || true
  else
    echo "status: NOT active"
  fi
  echo

  echo "--- SQL module path ---"
  if [[ -f /etc/freeradius/3.0/mods-enabled/sql ]]; then
    grep -E 'dialect|filename|driver' /etc/freeradius/3.0/mods-enabled/sql | grep -v '^#' || true
  else
    echo "mods-enabled/sql tidak ditemukan"
  fi
  echo "FR_DB expected: $FR_DB"
  if [[ -f "$FR_DB" ]]; then
    echo "FR_DB size: $(stat -c '%s' "$FR_DB") bytes"
    echo "radcheck: $(sqlite3 "$FR_DB" 'SELECT COUNT(*) FROM radcheck;' 2>/dev/null || echo ERROR)"
    echo "radusergroup: $(sqlite3 "$FR_DB" 'SELECT COUNT(*) FROM radusergroup;' 2>/dev/null || echo ERROR)"
    echo "nas: $(sqlite3 "$FR_DB" 'SELECT COUNT(*) FROM nas;' 2>/dev/null || echo ERROR)"
    echo "NAS list:"
    sqlite3 -header -column "$FR_DB" 'SELECT nasname, shortname FROM nas ORDER BY shortname;' 2>/dev/null || true
  else
    echo "FR_DB MISSING"
  fi
  echo

  echo "--- clients.conf (nama + ipaddr saja) ---"
  if [[ -f /etc/freeradius/3.0/clients.conf ]]; then
    awk '
      /^client / { name=$2; gsub(/[{]/,"",name) }
      /ipaddr[[:space:]]*=/ { ip=$0; sub(/.*ipaddr[[:space:]]*=[[:space:]]*/,"",ip); gsub(/;.*/,"",ip); gsub(/[[:space:]]/,"",ip); print name, ip }
    ' /etc/freeradius/3.0/clients.conf
  else
    echo "clients.conf tidak ditemukan"
  fi
  echo

  echo "--- Billing vs FreeRADIUS DB align ---"
  if [[ -f "$ROOT/.env" ]]; then
    ENV_PATH="$(grep -E '^RADIUS_SQLITE_PATH=' "$ROOT/.env" | tail -1 | cut -d= -f2- || true)"
    echo ".env RADIUS_SQLITE_PATH=$ENV_PATH"
  else
    echo ".env tidak ada"
  fi
  if [[ -f "$STALE_COPY" ]]; then
    echo "stale copy $STALE_COPY exists size=$(stat -c '%s' "$STALE_COPY")"
    echo "stale radcheck: $(sqlite3 "$STALE_COPY" 'SELECT COUNT(*) FROM radcheck;' 2>/dev/null || echo ERROR)"
    if [[ -f "$FR_DB" ]]; then
      FR_I="$(stat -c '%i' "$FR_DB")"
      ST_I="$(stat -c '%i' "$STALE_COPY")"
      if [[ "$FR_I" == "$ST_I" ]]; then
        echo "inode: SAMA (hardlink/sama file) — OK"
      else
        echo "inode: BEDA — data/radius.db adalah salinan terpisah (jangan diandalkan untuk auth)"
      fi
    fi
  else
    echo "Tidak ada data/radius.db"
  fi
  echo

  echo "--- Radius Manager inventory (platform_pop_radius_servers) ---"
  sqlite3 -header -column "$BILLING_DB" "
    SELECT r.id, p.code AS pop, r.name, r.host, r.auth_port, r.acct_port,
           CASE WHEN r.radius_secret IS NULL OR r.radius_secret='' THEN 'empty' ELSE 'set' END AS secret,
           r.is_active
    FROM platform_pop_radius_servers r
    JOIN platform_pops p ON p.id = r.pop_id
    ORDER BY p.code, r.id;
  " 2>/dev/null || echo "Gagal baca inventaris"
  echo

  echo "--- Kesimpulan aman ---"
  echo "Skrip ini read-only. Tidak ada perubahan MikroTik / PPPoE."
  echo "Lanjut cutover hanya setelah checklist MikroTik diterapkan di jam sepi."
} | tee "$OUT"

echo
echo "Laporan disimpan: $OUT"
