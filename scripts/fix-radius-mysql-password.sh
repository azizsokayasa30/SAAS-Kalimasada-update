#!/usr/bin/env bash
# Reset user MySQL radius@localhost agar cocok dengan deploy/freeradius-mods-sql-mysql.conf
#
#   sudo bash scripts/fix-radius-mysql-password.sh
#
set -euo pipefail

CREDENTIALS_FILE="/root/.freeradius_credentials"
RADIUS_PASSWORD="${RADIUS_MYSQL_PASSWORD:-oynFhZz8yD9zZ9jQF3CIdwi1d}"
MYSQL_ROOT_PASSWORD=""

echo "=== Fix password MySQL user radius ==="

if [[ ${EUID} -ne 0 ]]; then
  echo "Jalankan: sudo bash $0" >&2
  exit 1
fi

if [[ -f $CREDENTIALS_FILE ]]; then
  MYSQL_ROOT_PASSWORD=$(grep -m1 'MARIADB_ROOT_PASSWORD' "$CREDENTIALS_FILE" | cut -d'"' -f2 || true)
fi
if [[ -z $MYSQL_ROOT_PASSWORD ]]; then
  read -rs -p "Password MySQL root: " MYSQL_ROOT_PASSWORD
  echo ""
fi

mysql_root() {
  mysql -u root -p"$MYSQL_ROOT_PASSWORD" "$@"
}

if ! mysql_root -e "SELECT 1" >/dev/null 2>&1; then
  echo "GAGAL: tidak bisa login MySQL sebagai root (cek $CREDENTIALS_FILE)" >&2
  exit 1
fi
echo "OK: koneksi root MySQL"

mysql_root -e "CREATE DATABASE IF NOT EXISTS radius CHARACTER SET utf8mb4;"

USER_EXISTS=$(mysql_root -sN -e "SELECT COUNT(*) FROM mysql.user WHERE User='radius' AND Host='localhost';" 2>/dev/null || echo "0")

set_radius_password() {
  local sql="$1"
  mysql_root -e "$sql" 2>/dev/null
}

if [[ "$USER_EXISTS" -eq 0 ]]; then
  echo "Membuat user radius@localhost ..."
  set_radius_password "CREATE USER 'radius'@'localhost' IDENTIFIED BY '${RADIUS_PASSWORD}';" \
    || set_radius_password "CREATE USER 'radius'@'localhost' IDENTIFIED WITH mysql_native_password BY '${RADIUS_PASSWORD}';"
else
  echo "Memperbarui password radius@localhost ..."
  set_radius_password "ALTER USER 'radius'@'localhost' IDENTIFIED BY '${RADIUS_PASSWORD}';" \
    || set_radius_password "ALTER USER 'radius'@'localhost' IDENTIFIED WITH mysql_native_password BY '${RADIUS_PASSWORD}';" \
    || set_radius_password "SET PASSWORD FOR 'radius'@'localhost' = PASSWORD('${RADIUS_PASSWORD}');"
fi

mysql_root -e "GRANT ALL PRIVILEGES ON radius.* TO 'radius'@'localhost'; FLUSH PRIVILEGES;"

echo "Tes login radius ..."
if mysql -u radius -p"$RADIUS_PASSWORD" -e "SELECT COUNT(*) AS radcheck FROM radcheck;" radius 2>/dev/null; then
  echo "OK: user radius bisa akses database radius"
else
  echo "GAGAL: masih tidak bisa login sebagai radius" >&2
  echo "Coba manual: sudo mysql -e \"SHOW GRANTS FOR 'radius'@'localhost';\"" >&2
  exit 1
fi
