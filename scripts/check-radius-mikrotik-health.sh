#!/usr/bin/env bash
# Cek cepat: apakah FreeRADIUS masih lock (penyebab timeout/resend Mikrotik).
set -euo pipefail

LOG=/var/log/freeradius/radius.log
DEFAULT=/etc/freeradius/3.0/sites-enabled/default
FR_SQL=/etc/freeradius/3.0/mods-enabled/sql
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAIL_LINES=120

echo "=== FreeRADIUS health (Mikrotik timeout/resend) ==="

fr_started=""
fr_active=0
if systemctl is-active --quiet freeradius 2>/dev/null; then
  fr_active=1
  fr_started=$(systemctl show freeradius -p ActiveEnterTimestamp --value 2>/dev/null || true)
  echo "Layanan: active (sejak ${fr_started:-?})"
else
  echo "Layanan: TIDAK AKTIF — jalankan: sudo systemctl restart freeradius"
fi

uses_mysql=0
if [[ -r $FR_SQL ]] && grep -q 'dialect = "mysql"' "$FR_SQL" 2>/dev/null; then
  uses_mysql=1
  echo "SQL backend: MySQL"
elif [[ -r $FR_SQL ]] && grep -q 'dialect = "sqlite"' "$FR_SQL" 2>/dev/null; then
  echo "SQL backend: SQLite (konflik dengan billing)"
else
  echo "SQL backend: tidak bisa baca $FR_SQL"
fi

if [[ -r $LOG ]]; then
  # Hanya hitung error SETELAH start terakhir (Ready to process requests)
  log_slice=$(tail -n 500 "$LOG" | awk '
    /Ready to process requests/ { buf=""; capture=1 }
    capture { buf = buf $0 "\n" }
    END { printf "%s", buf }
  ')
  if [[ -z $log_slice ]]; then
    log_slice=$(tail -n "$TAIL_LINES" "$LOG")
    echo "(Menganalisis $TAIL_LINES baris terakhir — belum ada 'Ready' di 500 baris)"
  else
    echo "(Menganalisis log sejak start terakhir — setelah 'Ready to process requests')"
  fi

  locked=$(printf '%s' "$log_slice" | grep -c 'database is locked' || true)
  sqlite_drv=$(printf '%s' "$log_slice" | grep -c 'rlm_sql_sqlite' || true)
  mysql_drv=$(printf '%s' "$log_slice" | grep -c 'rlm_sql_mysql' || true)
  postauth=$(printf '%s' "$log_slice" | grep -c 'post-auth module sql' || true)
  queue=$(printf '%s' "$log_slice" | grep -c 'waiting in the processing queue' || true)
  blast=$(printf '%s' "$log_slice" | grep -c 'require_message_authenticator = true' || true)

  echo "Log sejak start:"
  echo "  database is locked     : $locked"
  echo "  rlm_sql_sqlite         : $sqlite_drv"
  echo "  post-auth module sql   : $postauth"
  echo "  queue menunggu lama    : $queue"
  echo ""
  echo "Contoh baris terakhir:"
  tail -n 3 "$LOG" | sed 's/^/  /'

  if [[ $fr_active -eq 1 && $uses_mysql -eq 1 && $sqlite_drv -eq 0 && $locked -le 2 ]]; then
    echo ""
    echo ">>> OK: FreeRADIUS MySQL jalan, tidak ada lock SQLite baru."
    echo "    Cek Mikrotik: /radius monitor 0"
  elif [[ $fr_active -eq 0 ]]; then
    echo ""
    echo ">>> GAGAL: FreeRADIUS mati. sudo bash scripts/restart-freeradius-load-mysql.sh"
  elif [[ $uses_mysql -eq 1 && $sqlite_drv -gt 0 ]]; then
    echo ""
    echo ">>> Masih ada rlm_sql_sqlite setelah start — proses/config salah."
    echo "    sudo bash scripts/restart-freeradius-load-mysql.sh"
  elif [[ $locked -gt 5 ]]; then
    echo ""
    if [[ $uses_mysql -eq 1 ]]; then
      echo ">>> Masih lock di log baru — tunggu 2 menit atau cek: tail -30 $LOG | grep -i sql"
    else
      echo ">>> SQLite lock. sudo bash scripts/apply-freeradius-sqlite-fix.sh"
      echo "    atau: sudo bash scripts/migrate-freeradius-sqlite-to-mysql.sh"
    fi
  fi

  if [[ $blast -gt 0 ]]; then
    echo ""
    echo "PERINGATAN: BlastRADIUS — set require_message_authenticator = yes untuk client MikroTik"
    echo "  di Admin RADIUS → Clients, atau edit /etc/freeradius/3.0/clients.conf lalu restart FR"
  fi
else
  echo "Tidak bisa baca $LOG"
fi

echo ""
if [[ -r $DEFAULT ]]; then
  if grep -q 'billing: post-auth sql disabled' "$DEFAULT"; then
    echo "OK: post-auth -sql dinonaktifkan"
  else
    echo "GAGAL: post-auth masih aktif → sudo bash scripts/patch-freeradius-sites-auth-only.sh"
  fi
  if grep -q 'billing: accounting sql disabled' "$DEFAULT"; then
    echo "OK: accounting sql dinonaktifkan (auth-only)"
  elif grep -q 'billing: skip sql on Interim-Update' "$DEFAULT"; then
    echo "PERINGATAN: accounting patch lama → sudo bash scripts/patch-freeradius-sites-auth-only.sh"
  else
    echo "PERINGATAN: accounting belum di-patch"
  fi
elif [[ $uses_mysql -eq 1 && $fr_active -eq 1 ]]; then
  echo "Config site: tidak bisa baca $DEFAULT (opsional: sudo usermod -aG freerad \$USER)"
fi
