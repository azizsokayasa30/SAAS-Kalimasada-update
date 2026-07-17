-- Platform VPN / WireGuard management for SaaS management portal

CREATE TABLE IF NOT EXISTS platform_vpn_server (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_endpoint TEXT,
    listen_port INTEGER DEFAULT 51820,
    wan_interface TEXT DEFAULT 'eth0',
    tunnel_address TEXT DEFAULT '10.10.0.1/24',
    network_subnet TEXT DEFAULT '10.10.0.0/24',
    server_public_key TEXT,
    server_private_key TEXT,
    interface_name TEXT DEFAULT 'wg0',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS platform_vpn_peers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tunnel_ip TEXT NOT NULL UNIQUE,
    peer_public_key TEXT NOT NULL UNIQUE,
    peer_private_key TEXT,
    allowed_ips TEXT,
    persistent_keepalive INTEGER DEFAULT 25,
    notes TEXT,
    is_active INTEGER DEFAULT 1 CHECK (is_active IN (0, 1)),
    tenant_id INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_platform_vpn_peers_active ON platform_vpn_peers(is_active);
CREATE INDEX IF NOT EXISTS idx_platform_vpn_peers_tenant ON platform_vpn_peers(tenant_id);
