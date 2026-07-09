-- Master tenant parent (read-only aggregation layer, not operational billing tenant)

ALTER TABLE tenants ADD COLUMN is_master INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_single_master
  ON tenants(is_master) WHERE is_master = 1 AND deleted_at IS NULL;
