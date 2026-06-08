#!/usr/bin/env python3
"""Initialize Kalimasada SaaS platform tables (no npm/sqlite3 CLI required)."""
import os
import sqlite3
import uuid
import bcrypt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, "data", "billing.db")
os.makedirs(os.path.dirname(DB), exist_ok=True)

def run_migration(conn, path):
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        sql = f.read()
    # Remove line comments
    lines = [ln for ln in sql.splitlines() if not ln.strip().startswith("--")]
    sql = "\n".join(lines)
    for stmt in sql.split(";"):
        stmt = stmt.strip()
        if not stmt:
            continue
        try:
            conn.execute(stmt)
        except sqlite3.Error as e:
            msg = str(e).lower()
            if "already exists" in msg or "duplicate column" in msg or "no such table" in msg:
                continue
            print(f"warn: {e}")
    conn.commit()

conn = sqlite3.connect(DB)
conn.execute("PRAGMA foreign_keys = ON")

run_migration(conn, os.path.join(ROOT, "migrations", "create_saas_platform_tables.sql"))
run_migration(conn, os.path.join(ROOT, "migrations", "add_tenant_id_core_tables.sql"))

pwd_hash = bcrypt.hashpw(b"kalimasada123", bcrypt.gensalt(10)).decode()
conn.execute(
    """INSERT OR REPLACE INTO super_admins (id, name, email, password_hash, is_active)
       VALUES (1, 'Kalimasada Management', 'management@kalimasada', ?, 1)""",
    (pwd_hash,),
)

conn.execute(
    """INSERT OR IGNORE INTO tenants (
        id, uuid, name, subdomain, slug, owner_name, owner_email, owner_phone,
        subscription_plan_id, status, settings, provisioned_at,
        subscription_starts_at, subscription_ends_at
    ) VALUES (?, ?, 'Default Tenant', 'default', 'default', 'Administrator',
        'admin@local', '08000000000', 3, 'active', ?, datetime('now','localtime'),
        datetime('now','localtime'), datetime('now','+10 years','localtime'))""",
    (
        1,
        str(uuid.uuid4()),
        '{"admin_username":"admin","admin_password":"admin","company_header":"Kalimasada Billing"}',
    ),
)
conn.commit()
conn.close()

print("✅ Platform DB initialized:", DB)
print("   Portal: /management/login")
print("   Super Admin: management@kalimasada / kalimasada123")
