-- Platform finance module — tenant gateway aggregation, settlement invoices, platform ledger

CREATE TABLE IF NOT EXISTS platform_tenant_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT NOT NULL UNIQUE,
    tenant_id INTEGER NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    gross_amount REAL NOT NULL DEFAULT 0,
    tax_amount REAL NOT NULL DEFAULT 0,
    bhp_uso_amount REAL NOT NULL DEFAULT 0,
    management_fee_amount REAL NOT NULL DEFAULT 0,
    net_amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    notes TEXT,
    owner_snapshot TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_platform_tenant_invoices_tenant ON platform_tenant_invoices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_platform_tenant_invoices_period ON platform_tenant_invoices(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_platform_tenant_invoices_status ON platform_tenant_invoices(status);

CREATE TABLE IF NOT EXISTS platform_tenant_invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    item_type TEXT NOT NULL DEFAULT 'gateway_collection',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (invoice_id) REFERENCES platform_tenant_invoices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_tenant_invoice_items_invoice ON platform_tenant_invoice_items(invoice_id);

CREATE TABLE IF NOT EXISTS platform_finance_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'income',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_platform_finance_categories_type ON platform_finance_categories(type);

CREATE TABLE IF NOT EXISTS platform_finance_income (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT NOT NULL DEFAULT 'Lainnya',
    transaction_date TEXT NOT NULL,
    payment_method TEXT,
    notes TEXT,
    reference_type TEXT,
    reference_id INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_platform_finance_income_date ON platform_finance_income(transaction_date);

CREATE TABLE IF NOT EXISTS platform_finance_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT NOT NULL DEFAULT 'Lainnya',
    transaction_date TEXT NOT NULL,
    payment_method TEXT,
    notes TEXT,
    reference_type TEXT,
    reference_id INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_platform_finance_expenses_date ON platform_finance_expenses(transaction_date);

INSERT OR IGNORE INTO platform_finance_categories (id, name, type) VALUES
(1, 'Fee Management', 'income'),
(2, 'BHP USO', 'income'),
(3, 'Lainnya', 'income'),
(4, 'Operasional', 'expense'),
(5, 'Gaji', 'expense'),
(6, 'Lainnya', 'expense');
