-- Add tenant_id to core tenant-scoped tables (default 1 = legacy single-tenant data)

-- customers
ALTER TABLE customers ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_customers_tenant_id ON customers(tenant_id);

-- packages
ALTER TABLE packages ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_packages_tenant_id ON packages(tenant_id);

-- invoices
ALTER TABLE invoices ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_id ON invoices(tenant_id);

-- payments
ALTER TABLE payments ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_payments_tenant_id ON payments(tenant_id);

-- routers
ALTER TABLE routers ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_routers_tenant_id ON routers(tenant_id);

-- technicians
ALTER TABLE technicians ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_technicians_tenant_id ON technicians(tenant_id);

-- collectors
ALTER TABLE collectors ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_collectors_tenant_id ON collectors(tenant_id);

-- areas
ALTER TABLE areas ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_areas_tenant_id ON areas(tenant_id);

-- app_settings
ALTER TABLE app_settings ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_app_settings_tenant_id ON app_settings(tenant_id);

-- agents
ALTER TABLE agents ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_agents_tenant_id ON agents(tenant_id);

-- members
ALTER TABLE members ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_members_tenant_id ON members(tenant_id);

-- member_packages
ALTER TABLE member_packages ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_member_packages_tenant_id ON member_packages(tenant_id);

-- expenses
ALTER TABLE expenses ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_expenses_tenant_id ON expenses(tenant_id);

-- income
ALTER TABLE income ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_income_tenant_id ON income(tenant_id);

-- odps
ALTER TABLE odps ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_odps_tenant_id ON odps(tenant_id);
