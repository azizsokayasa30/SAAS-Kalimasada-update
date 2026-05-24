#!/usr/bin/env bash
# Muat ulang config MySQL ke proses FreeRADIUS.
#
#   sudo bash scripts/restart-freeradius-load-mysql.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FR_SQL="/etc/freeradius/3.0/mods-enabled/sql"
LOG=/var/log/freeradius/radius.log

[[ ${EUID} -eq 0 ]] || { echo "sudo bash $0"; exit 1; }

echo "=== Bersihkan file backup di mods-enabled ==="
bash "$ROOT/scripts/fix-freeradius-mods-enabled-junk.sh"

echo "=== Pasang sql MySQL (lengkap) ==="
cp "$ROOT/deploy/freeradius-mods-sql-mysql.conf" "$FR_SQL"
chown freerad:freerad "$FR_SQL"
chmod 640 "$FR_SQL"

if ! grep -q 'authcheck_table' "$FR_SQL"; then
  echo "GAGAL: config sql tidak lengkap" >&2
  exit 1
fi

echo "=== Perbaiki user/password MySQL radius ==="
bash "$ROOT/scripts/fix-radius-mysql-password.sh"

echo "=== Validasi (sama seperti systemd ExecStartPre -Cx) ==="
/usr/sbin/freeradius -Cx -lstdout

echo "=== Restart FreeRADIUS ==="
systemctl restart freeradius
sleep 3
systemctl is-active freeradius
echo "Start: $(systemctl show freeradius -p ActiveEnterTimestamp --value)"

echo ""
echo "=== Log (15 baris terakhir) ==="
tail -15 "$LOG"

if tail -15 "$LOG" | grep -q 'rlm_sql_sqlite'; then
  echo ""
  echo "GAGAL: masih rlm_sql_sqlite" >&2
  exit 1
fi

echo ""
echo "OK. Jalankan: npm run radius:health"
