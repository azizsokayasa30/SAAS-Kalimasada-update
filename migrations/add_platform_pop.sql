-- Platform POP/CABANG management for SaaS management portal

CREATE TABLE IF NOT EXISTS platform_pops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    location TEXT,
    address TEXT,
    latitude REAL,
    longitude REAL,
    description TEXT,
    is_active INTEGER DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS platform_pop_switches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pop_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    brand TEXT,
    model TEXT,
    ip_address TEXT NOT NULL,
    snmp_community TEXT,
    snmp_version TEXT DEFAULT 'v2c',
    main_interface TEXT DEFAULT 'SFP+1',
    include_in_aggregate INTEGER DEFAULT 1 CHECK (include_in_aggregate IN (0, 1)),
    description TEXT,
    is_active INTEGER DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (pop_id) REFERENCES platform_pops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform_pop_radius_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pop_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    auth_port INTEGER DEFAULT 1812,
    acct_port INTEGER DEFAULT 1813,
    radius_secret TEXT,
    description TEXT,
    is_active INTEGER DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (pop_id) REFERENCES platform_pops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_pop_switches_pop ON platform_pop_switches(pop_id);
CREATE INDEX IF NOT EXISTS idx_platform_pop_radius_pop ON platform_pop_radius_servers(pop_id);
CREATE INDEX IF NOT EXISTS idx_platform_pops_active ON platform_pops(is_active);
