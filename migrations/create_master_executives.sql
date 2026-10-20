-- Jabatan pimpinan master tenant.
-- Komisaris, Direktur, dan Wakil Direktur login dengan akses admin utama.

CREATE TABLE IF NOT EXISTS master_executives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    password TEXT NOT NULL,
    jabatan TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'suspended')),
    tenant_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_master_executives_tenant_username
    ON master_executives(tenant_id, LOWER(TRIM(username)));
