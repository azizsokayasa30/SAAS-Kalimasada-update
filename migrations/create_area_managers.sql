-- Migration: Area Managers (Manager Area) for billing tenants
-- Multi-area scoped admin-like access (excluding app settings)

CREATE TABLE IF NOT EXISTS area_managers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    password TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'suspended')),
    tenant_id INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_area_managers_tenant_username
    ON area_managers(tenant_id, LOWER(TRIM(username)));

CREATE INDEX IF NOT EXISTS idx_area_managers_tenant_status
    ON area_managers(tenant_id, status);

CREATE TABLE IF NOT EXISTS area_manager_areas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area_manager_id INTEGER NOT NULL,
    area_id INTEGER NOT NULL,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(area_manager_id, area_id),
    FOREIGN KEY (area_manager_id) REFERENCES area_managers(id) ON DELETE CASCADE,
    FOREIGN KEY (area_id) REFERENCES areas(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_area_manager_areas_manager
    ON area_manager_areas(area_manager_id);

CREATE INDEX IF NOT EXISTS idx_area_manager_areas_area
    ON area_manager_areas(area_id);

CREATE INDEX IF NOT EXISTS idx_area_manager_areas_tenant
    ON area_manager_areas(tenant_id);
