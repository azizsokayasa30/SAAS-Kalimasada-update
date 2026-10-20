-- Mirror columns for master-tenant copies (view-only records).
-- Safe to re-run: duplicate-column / already-exists errors are ignored by the loader.

ALTER TABLE customers ADD COLUMN master_origin TEXT;
ALTER TABLE customers ADD COLUMN source_tenant_id INTEGER;
ALTER TABLE customers ADD COLUMN source_customer_id INTEGER;
ALTER TABLE customers ADD COLUMN source_tenant_name TEXT;

ALTER TABLE invoices ADD COLUMN source_invoice_id INTEGER;
ALTER TABLE invoices ADD COLUMN source_missing INTEGER NOT NULL DEFAULT 0;

ALTER TABLE payments ADD COLUMN source_payment_id INTEGER;

CREATE TABLE IF NOT EXISTS master_customer_copies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  master_tenant_id INTEGER NOT NULL,
  master_customer_id INTEGER NOT NULL,
  source_tenant_id INTEGER NOT NULL,
  source_customer_id INTEGER NOT NULL,
  copied_at DATETIME DEFAULT (datetime('now','localtime')),
  UNIQUE(source_tenant_id, source_customer_id),
  UNIQUE(master_customer_id)
);

CREATE TABLE IF NOT EXISTS master_package_mirrors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  master_tenant_id INTEGER NOT NULL,
  source_tenant_id INTEGER NOT NULL,
  source_package_id INTEGER NOT NULL,
  master_package_id INTEGER NOT NULL,
  UNIQUE(master_tenant_id, source_tenant_id, source_package_id)
);

CREATE TABLE IF NOT EXISTS master_copy_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  master_tenant_id INTEGER,
  source_tenant_id INTEGER,
  source_customer_id INTEGER,
  master_customer_id INTEGER,
  actor_type TEXT,
  actor_id INTEGER,
  action TEXT,
  details TEXT,
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_customers_master_origin ON customers(master_origin);
CREATE INDEX IF NOT EXISTS idx_customers_source_ref ON customers(source_tenant_id, source_customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_source_invoice_id ON invoices(source_invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_source_payment_id ON payments(source_payment_id);
CREATE INDEX IF NOT EXISTS idx_master_copies_source ON master_customer_copies(source_tenant_id, source_customer_id);
