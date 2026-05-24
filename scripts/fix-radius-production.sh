#!/usr/bin/env bash
# Perbaikan lengkap RADIUS timeout / auth failed di Mikrotik (server Ubuntu + FreeRADIUS + SQLite).
# Jalankan dari folder proyek:
#   cd /home/ajizs/internet-express
#   bash scripts/fix-radius-production.sh
#
# Bagian FreeRADIUS membutuhkan sudo.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== [1/4] Optimasi SQLite (radpostauth, radacct basi, WAL) ==="
if command -v pm2 >/dev/null 2>&1 && pm2 describe billing-kalimasada >/dev/null 2>&1; then
  echo "Menghentikan billing-kalimasada sementara agar tidak SQLITE_BUSY..."
  pm2 stop billing-kalimasada || true
  RESTART_PM2=1
else
  RESTART_PM2=0
fi

node scripts/fix-radius-sqlite-contention.js --yes --keep-postauth-days 3 --close-stale-acct-days 7

if [[ "${RESTART_PM2}" == "1" ]]; then
  pm2 start billing-kalimasada || pm2 restart billing-kalimasada
  echo "billing-kalimasada dijalankan kembali"
fi

echo ""
echo "=== [2/4] Index & ANALYZE tambahan ==="
node scripts/optimize-radius-sqlite.js

echo ""
echo "=== [3/4] Optimasi FreeRADIUS (reject_delay, thread pool, busy_timeout) ==="
if [[ ${EUID} -eq 0 ]]; then
  bash scripts/optimize-freeradius-mass-auth.sh
elif command -v sudo >/dev/null 2>&1; then
  sudo bash scripts/optimize-freeradius-mass-auth.sh
else
  echo "Lewati: jalankan manual sebagai root:"
  echo "  sudo bash scripts/optimize-freeradius-mass-auth.sh"
fi

echo ""
echo "=== [4/4] Cek log (10 baris terakhir) ==="
if [[ -r /var/log/freeradius/radius.log ]]; then
  tail -10 /var/log/freeradius/radius.log
else
  echo "Tidak bisa baca /var/log/freeradius/radius.log"
fi

cat <<'EOF'

=== Mikrotik (wajib) ===
# RouterOS: hanya timeout= (maks 3s), tidak ada retry=
/radius print
/radius set [find] timeout=3s

Jadwalkan perawatan mingguan:
  node scripts/fix-radius-sqlite-contention.js --yes

EOF
