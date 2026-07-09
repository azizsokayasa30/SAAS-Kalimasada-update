-- Master internet packages (SaaS management catalog)

CREATE TABLE IF NOT EXISTS master_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    speed TEXT NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    tax_rate DECIMAL(5,2) DEFAULT 11.00,
    description TEXT,
    pppoe_profile TEXT DEFAULT 'default',
    upload_limit TEXT,
    download_limit TEXT,
    burst_limit_upload TEXT,
    burst_limit_download TEXT,
    burst_threshold TEXT,
    burst_time TEXT,
    billing_only INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS tenant_package_selections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    master_package_id INTEGER NOT NULL,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(tenant_id, master_package_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (master_package_id) REFERENCES master_packages(id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_package_selections_tenant ON tenant_package_selections(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_package_selections_master ON tenant_package_selections(master_package_id);

-- Link tenant packages row to master catalog
ALTER TABLE packages ADD COLUMN master_package_id INTEGER NULL;
CREATE INDEX IF NOT EXISTS idx_packages_master_package_id ON packages(master_package_id);
