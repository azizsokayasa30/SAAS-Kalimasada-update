CREATE TABLE IF NOT EXISTS platform_nms_graph_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    router_id INTEGER,
    nms_device_id TEXT NOT NULL,
    nms_device_name TEXT,
    nms_device_ip TEXT,
    nms_graph_id TEXT NOT NULL,
    nms_graph_name TEXT,
    nms_graph_kind TEXT,
    interface_key TEXT,
    show_on_management INTEGER DEFAULT 0 CHECK (show_on_management IN (0, 1)),
    show_on_tenant INTEGER DEFAULT 1 CHECK (show_on_tenant IN (0, 1)),
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_nms_bindings_tenant ON platform_nms_graph_bindings(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_nms_bindings_router ON platform_nms_graph_bindings(router_id);
CREATE INDEX IF NOT EXISTS idx_nms_bindings_mgmt ON platform_nms_graph_bindings(show_on_management, is_active);
