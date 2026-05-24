#!/usr/bin/env bash
# Perbaikan wajib (root) — timeout/resend Mikrotik karena SQLite lock + post-auth -sql.
# Jika FreeRADIUS sudah MySQL: hanya patch site + radiusd.conf (TIDAK menyentuh mods-enabled/sql).
#
#   cd ~/internet-express
#   sudo bash scripts/apply-freeradius-sqlite-fix.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT="/etc/freeradius/3.0/sites-enabled/default"
INNER="/etc/freeradius/3.0/sites-enabled/inner-tunnel"
SQL_MOD="/etc/freeradius/3.0/mods-enabled/sql"
RADIUS_DB="${ROOT}/data/radius.db"
BACKUP="/etc/freeradius/3.0/backup-sqlite-fix-$(date +%Y%m%d%H%M%S)"

if [[ ${EUID} -ne 0 ]]; then
  echo "Jalankan: sudo bash $0" >&2
  exit 1
fi

USE_MYSQL=0
if [[ -f $SQL_MOD ]] && grep -q 'dialect = "mysql"' "$SQL_MOD" 2>/dev/null; then
  USE_MYSQL=1
  echo "=== Backend SQL = MySQL (tidak mengubah mods-enabled/sql) ==="
else
  echo "=== Backend SQL = SQLite ==="
fi

echo "=== Backup ke $BACKUP ==="
mkdir -p "$BACKUP"
for f in "$DEFAULT" "$INNER" /etc/freeradius/3.0/radiusd.conf; do
  [[ -f $f ]] && cp -a "$f" "$BACKUP/"
done
if [[ $USE_MYSQL -eq 0 && -f $SQL_MOD ]]; then
  cp -a "$SQL_MOD" "$BACKUP/"
fi

echo "=== Patch post-auth & accounting ==="
bash "$ROOT/scripts/patch-freeradius-sites-auth-only.sh"

if [[ $USE_MYSQL -eq 0 ]]; then
  echo "=== Tune mods-enabled/sql (SQLite) ==="
  python3 - "$SQL_MOD" "$RADIUS_DB" <<'PY'
import re, sys
from pathlib import Path
path, db = Path(sys.argv[1]), sys.argv[2]
text = path.read_text()
text = re.sub(r'busy_timeout\s*=\s*\d+', 'busy_timeout = 60000', text)
if 'busy_timeout' not in text:
    text = re.sub(r'(sqlite\s*\{)', r'\1\n        busy_timeout = 60000', text, count=1)
text = re.sub(r'max_connections\s*=\s*\d+', 'max_connections = 1', text)
if 'max_connections' not in text:
    text = re.sub(r'(sql\s*\{)', r'\1\n    max_connections = 1', text, count=1)
text = re.sub(r'filename\s*=\s*"[^"]*"', f'filename = "{db}"', text, count=1)
path.write_text(text)
print(f'sqlite: busy_timeout=60000 max_connections=1 filename={db}')
PY
fi

echo "=== radiusd.conf + thread pool (optimize-freeradius-mass-auth.sh) ==="
bash "$ROOT/scripts/optimize-freeradius-mass-auth.sh"

echo ""
echo "=== Verifikasi cepat ==="
if grep -q 'billing: post-auth sql disabled' "$DEFAULT"; then
  echo "OK: post-auth -sql dinonaktifkan"
else
  echo "GAGAL: post-auth masih aktif — lihat $BACKUP"
  exit 1
fi
if grep -q 'billing: accounting sql disabled' "$DEFAULT"; then
  echo "OK: accounting sql dinonaktifkan (auth tetap pakai sql)"
else
  echo "PERINGATAN: accounting sql masih aktif — jalankan ulang script ini"
fi

if [[ $USE_MYSQL -eq 1 ]]; then
  echo ""
  echo "FreeRADIUS memakai MySQL. Jangan jalankan script ini untuk 'fix sqlite' —"
  echo "pastikan mods-enabled/sql masih deploy/freeradius-mods-sql-mysql.conf:"
  echo "  sudo bash scripts/complete-freeradius-mysql-migration.sh"
else
  echo ""
  echo "Langkah sebagai user ajizs (bukan root):"
  echo "  pm2 stop billing-kalimasada"
  echo "  node scripts/fix-radius-sqlite-contention.js --yes"
  echo "  pm2 start billing-kalimasada"
  echo "  npm run radius:health"
fi
echo ""
echo "Backup: $BACKUP"
