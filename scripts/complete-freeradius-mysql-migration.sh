#!/usr/bin/env bash
# Selesaikan migrasi MySQL — urutan benar: patch site → pasang MySQL sql → restart.
#   sudo bash scripts/complete-freeradius-mysql-migration.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FR_SQL="/etc/freeradius/3.0/mods-enabled/sql"
LOG=/var/log/freeradius/radius.log

[[ ${EUID} -eq 0 ]] || { echo "sudo bash $0"; exit 1; }

echo "=== 1/4 Patch post-auth & accounting (tanpa sentuh sql module) ==="
bash "$ROOT/scripts/patch-freeradius-sites-auth-only.sh"

echo "=== 2/4 Bersihkan backup di mods-enabled + pasang sql MySQL ==="
bash "$ROOT/scripts/fix-freeradius-mods-enabled-junk.sh"
mkdir -p /etc/freeradius/3.0/backup-sql-deploy
cp -a "$FR_SQL" "/etc/freeradius/3.0/backup-sql-deploy/sql.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
cp "$ROOT/deploy/freeradius-mods-sql-mysql.conf" "$FR_SQL"
chown freerad:freerad "$FR_SQL"
chmod 640 "$FR_SQL"
grep -q 'dialect = "mysql"' "$FR_SQL"

echo "=== 3/4 radiusd.conf (reject_delay, thread pool — skip SQLite tuning) ==="
bash "$ROOT/scripts/optimize-freeradius-mass-auth.sh"

echo "=== 4/4 Validasi & restart FreeRADIUS ==="
/usr/sbin/freeradius -Cx -lstdout
systemctl restart freeradius
sleep 3
systemctl is-active freeradius

echo ""
echo "=== Tes MySQL ==="
mysql -u radius -p'oynFhZz8yD9zZ9jQF3CIdwi1d' -e \
  "SELECT COUNT(*) AS radcheck FROM radcheck; SELECT COUNT(*) AS radusergroup FROM radusergroup;" radius

echo ""
echo "=== Log baru (harus rlm_sql_mysql, BUKAN rlm_sql_sqlite) ==="
if [[ -r $LOG ]]; then
  # Hanya baris setelah restart (~3 detik terakhir bisa masih sisa; ambil 15 baris + filter)
  tail -15 "$LOG" | tee /tmp/fr-mysql-migrate-tail.log
  if grep -q 'rlm_sql_sqlite' /tmp/fr-mysql-migrate-tail.log; then
    echo ""
    echo "PERINGATAN: log masih menyebut rlm_sql_sqlite — cek:"
    echo "  grep dialect $FR_SQL"
    echo "  sudo freeradius -X 2>&1 | head -80"
    exit 1
  fi
  echo "OK: tidak ada rlm_sql_sqlite di 15 baris terakhir log"
else
  echo "Tidak bisa baca $LOG"
fi

echo ""
echo "Selesai. Jalankan sebagai ajizs:"
echo "  pm2 restart billing-kalimasada"
echo "  npm run radius:health"
