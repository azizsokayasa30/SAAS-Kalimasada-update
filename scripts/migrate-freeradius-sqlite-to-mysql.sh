#!/usr/bin/env bash
# Solusi permanen timeout Mikrotik: FreeRADIUS pakai MySQL (bukan SQLite bersama billing).
# Jalankan sebagai root setelah backup:
#   sudo bash scripts/migrate-freeradius-sqlite-to-mysql.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SQLITE_DB="${ROOT}/data/radius.db"
CRED_FILE="/root/.freeradius_credentials"
FR_SQL="/etc/freeradius/3.0/mods-enabled/sql"
FR_SQL_AVAIL="/etc/freeradius/3.0/mods-available/sql"

if [[ ${EUID} -ne 0 ]]; then
  echo "Jalankan: sudo bash $0" >&2
  exit 1
fi

echo "=== Migrasi FreeRADIUS: SQLite → MySQL (MariaDB) ==="

MYSQL_ROOT=""
if [[ -f $CRED_FILE ]]; then
  MYSQL_ROOT=$(grep 'MARIADB_ROOT_PASSWORD' "$CRED_FILE" | cut -d'"' -f2)
fi
if [[ -z $MYSQL_ROOT ]]; then
  read -rs -p "Password MySQL root: " MYSQL_ROOT
  echo ""
fi

RADIUS_PW="oynFhZz8yD9zZ9jQF3CIdwi1d"
mysql -u root -p"$MYSQL_ROOT" -e "CREATE DATABASE IF NOT EXISTS radius CHARACTER SET utf8mb4;"
mysql -u root -p"$MYSQL_ROOT" -e "CREATE USER IF NOT EXISTS 'radius'@'localhost' IDENTIFIED BY '${RADIUS_PW}';"
mysql -u root -p"$MYSQL_ROOT" -e "GRANT ALL ON radius.* TO 'radius'@'localhost'; FLUSH PRIVILEGES;"

if [[ ! -f /etc/freeradius/3.0/mods-config/sql/main/mysql/schema.sql ]]; then
  echo "Schema MySQL FR tidak ditemukan. Install: apt install freeradius-mysql" >&2
  exit 1
fi
mysql -u root -p"$MYSQL_ROOT" radius < /etc/freeradius/3.0/mods-config/sql/main/mysql/schema.sql 2>/dev/null || true

echo "=== Salin data radcheck / radusergroup / nas dari SQLite ==="
if [[ ! -f $SQLITE_DB ]]; then
  echo "Tidak ada $SQLITE_DB" >&2
  exit 1
fi

export SQLITE_DB MYSQL_ROOT RADIUS_PW
python3 <<'PY'
import os, sqlite3, subprocess

sqlite_path = os.environ["SQLITE_DB"]
root_pw = os.environ["MYSQL_ROOT"]
radius_pw = os.environ["RADIUS_PW"]

def sqlite_rows(table, cols):
    conn = sqlite3.connect(sqlite_path)
    cur = conn.execute(f"SELECT {','.join(cols)} FROM {table}")
    rows = cur.fetchall()
    conn.close()
    return rows

def mysql_import(table, columns, rows):
    if not rows:
        print(f"  {table}: 0 rows")
        return
    sql = f"DELETE FROM {table};"
    subprocess.run(
        ["mysql", "-u", "root", f"-p{root_pw}", "radius", "-e", sql],
        check=False,
        capture_output=True,
    )
    insert_cols = ",".join(columns)
    placeholders = ",".join(["%s"] * len(columns))
    batch = []
    for row in rows:
        vals = ",".join(
            "'" + str(v).replace("\\", "\\\\").replace("'", "''") + "'" if v is not None else "NULL"
            for v in row
        )
        batch.append(f"({vals})")
    for i in range(0, len(batch), 200):
        chunk = batch[i : i + 200]
        q = f"INSERT INTO {table} ({insert_cols}) VALUES {','.join(chunk)};"
        subprocess.run(
            ["mysql", "-u", "root", f"-p{root_pw}", "radius", "-e", q],
            check=True,
        )
    print(f"  {table}: {len(rows)} rows")

for table, cols in [
    ("radcheck", "username,attribute,op,value"),
    ("radreply", "username,attribute,op,value"),
    ("radusergroup", "username,groupname,priority"),
    ("radgroupcheck", "groupname,attribute,op,value"),
    ("radgroupreply", "groupname,attribute,op,value"),
    ("nas", "nasname,shortname,type,ports,secret,server,community,description"),
]:
    try:
        mysql_import(table, cols.split(","), sqlite_rows(table, cols.split(",")))
    except Exception as e:
        print(f"  skip {table}: {e}")
PY

echo "=== Pasang mods-enabled/sql (MySQL) ==="
cp -a "$FR_SQL" "${FR_SQL}.bak-sqlite-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
cp "$ROOT/deploy/freeradius-mods-sql-mysql.conf" "$FR_SQL"
chown freerad:freerad "$FR_SQL"
chmod 640 "$FR_SQL"
echo "  config: deploy/freeradius-mods-sql-mysql.conf"

echo "=== Patch post-auth & accounting ==="
bash "$ROOT/scripts/patch-freeradius-sites-auth-only.sh"

echo "=== Validasi config ==="
if ! freeradius -C; then
  echo ""
  echo "GAGAL: freeradius -C — kemungkinan config rusak dari migrasi sebelumnya."
  echo "Jalankan: sudo bash scripts/complete-freeradius-mysql-migration.sh"
  exit 1
fi

systemctl restart freeradius
sleep 2
systemctl is-active freeradius

echo ""
echo "=== Tes MySQL ==="
mysql -u radius -p"${RADIUS_PW}" -e "SELECT COUNT(*) AS radcheck FROM radcheck; SELECT COUNT(*) AS radusergroup FROM radusergroup;" radius

echo ""
echo "Selesai. FreeRADIUS pakai MySQL; billing tetap SQLite (sync otomatis setelah edit user)."
echo "  pm2 restart billing-kalimasada"
echo "  npm run radius:health"
echo "  radtest USER PASS 127.0.0.1 0 SECRET_NAS"
