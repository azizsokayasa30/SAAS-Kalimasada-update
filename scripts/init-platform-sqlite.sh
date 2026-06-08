#!/usr/bin/env bash
# Init platform tables without npm (uses sqlite3 CLI)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$ROOT/data/billing.db"
SQL_PLATFORM="$ROOT/migrations/create_saas_platform_tables.sql"
SQL_TENANT_ID="$ROOT/migrations/add_tenant_id_core_tables.sql"
BCRYPT_HASH='$2b$10$aNNHzD.vBJoEnvRypY7V8u06jkCPixcpoJOit.OzWsIxjO0frXZTy'

mkdir -p "$ROOT/data"
touch "$DB"

run_sql_file() {
  local file="$1"
  echo ">> Running $(basename "$file")"
  while IFS= read -r stmt || [[ -n "$stmt" ]]; do
    stmt="$(echo "$stmt" | sed '/^--/d' | tr '\n' ' ' | xargs)"
    [[ -z "$stmt" ]] && continue
    sqlite3 "$DB" "$stmt" 2>/dev/null || true
  done < <(awk 'BEGIN{RS=";"} {gsub(/^\s+|\s+$/,"",$0); if(length($0)>0) print $0";"}' "$file")
}

if [[ -f "$SQL_PLATFORM" ]]; then
  sqlite3 "$DB" < "$SQL_PLATFORM" 2>/dev/null || run_sql_file "$SQL_PLATFORM"
fi

if [[ -f "$SQL_TENANT_ID" ]]; then
  run_sql_file "$SQL_TENANT_ID"
fi

sqlite3 "$DB" "INSERT OR REPLACE INTO super_admins (id, name, email, password_hash, is_active)
  VALUES (1, 'Kalimasada Management', 'management@kalimasada', '$BCRYPT_HASH', 1);"

sqlite3 "$DB" "INSERT OR IGNORE INTO tenants (
  id, uuid, name, subdomain, slug, owner_name, owner_email, owner_phone,
  subscription_plan_id, status, settings, provisioned_at, subscription_starts_at, subscription_ends_at
) VALUES (
  1, lower(hex(randomblob(16))), 'Default Tenant', 'default', 'default',
  'Administrator', 'admin@local', '08000000000', 3, 'active',
  '{\"admin_username\":\"admin\",\"admin_password\":\"admin\",\"company_header\":\"Kalimasada Billing\"}',
  datetime('now','localtime'), datetime('now','localtime'), datetime('now','+10 years','localtime')
);"

echo "✅ Platform DB initialized: $DB"
echo "   Portal: /platform/login"
echo "   Super Admin: management@kalimasada / kalimasada123"
