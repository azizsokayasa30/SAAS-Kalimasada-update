-- Migration: OLT Management Enterprise
-- Description: Inventory, realtime ONU state, polling queue, API profiles, and customer mapping.

CREATE TABLE IF NOT EXISTS olt_api_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    vendor TEXT,
    model TEXT,
    base_path TEXT DEFAULT '',
    auth_type TEXT DEFAULT 'basic' CHECK (auth_type IN ('none', 'basic', 'bearer', 'header')),
    auth_header TEXT,
    verify_tls INTEGER DEFAULT 1,
    timeout_ms INTEGER DEFAULT 10000,
    endpoints_json TEXT NOT NULL,
    parser_json TEXT,
    capabilities_json TEXT,
    is_active INTEGER DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS olts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    vendor TEXT NOT NULL,
    model TEXT,
    ip_address TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 443,
    username TEXT,
    password_encrypted TEXT,
    enable_password TEXT,
    connection_method TEXT NOT NULL DEFAULT 'https_api' CHECK (connection_method IN ('ssh', 'telnet', 'snmp_v2', 'snmp_v3', 'http_api', 'https_api')),
    snmp_community TEXT,
    snmp_version TEXT DEFAULT 'v2' CHECK (snmp_version IN ('v2', 'v3')),
    location TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'connected', 'disconnected', 'error')),
    polling_interval INTEGER NOT NULL DEFAULT 10 CHECK (polling_interval IN (1, 5, 10, 15)),
    api_profile_id INTEGER,
    last_sync DATETIME,
    last_connection_status TEXT,
    last_error TEXT,
    system_info_json TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (api_profile_id) REFERENCES olt_api_profiles(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS pon_ports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    olt_id INTEGER NOT NULL,
    slot TEXT,
    pon TEXT NOT NULL,
    name TEXT,
    onu_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (olt_id) REFERENCES olts(id) ON DELETE CASCADE,
    UNIQUE(olt_id, slot, pon)
);

CREATE TABLE IF NOT EXISTS onus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    olt_id INTEGER NOT NULL,
    pon_port_id INTEGER,
    onu_index TEXT,
    onu_id TEXT,
    onu_sn TEXT,
    onu_name TEXT,
    vendor TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('ONLINE', 'OFFLINE', 'LOS', 'POWER_OFF', 'DYING_GASP', 'DISABLED', 'AUTH_FAILED', 'UNKNOWN')),
    rx_power REAL,
    tx_power REAL,
    signal_quality TEXT,
    distance REAL,
    mac_address TEXT,
    ip_address TEXT,
    last_seen DATETIME,
    last_polled_at DATETIME,
    missing_since DATETIME,
    raw_data_json TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (olt_id) REFERENCES olts(id) ON DELETE CASCADE,
    FOREIGN KEY (pon_port_id) REFERENCES pon_ports(id) ON DELETE SET NULL,
    UNIQUE(olt_id, onu_index),
    UNIQUE(olt_id, onu_sn)
);

CREATE TABLE IF NOT EXISTS onu_histories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    onu_id INTEGER NOT NULL,
    status TEXT CHECK (status IN ('ONLINE', 'OFFLINE', 'LOS', 'POWER_OFF', 'DYING_GASP', 'DISABLED', 'AUTH_FAILED', 'UNKNOWN')),
    rx_power REAL,
    tx_power REAL,
    distance REAL,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (onu_id) REFERENCES onus(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    olt_id INTEGER,
    onu_id INTEGER,
    level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warning', 'critical')),
    title TEXT NOT NULL,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (olt_id) REFERENCES olts(id) ON DELETE CASCADE,
    FOREIGN KEY (onu_id) REFERENCES onus(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS olt_sync_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    olt_id INTEGER NOT NULL,
    job_type TEXT NOT NULL DEFAULT 'sync' CHECK (job_type IN ('sync', 'manual_sync', 'refresh_onu')),
    onu_id INTEGER,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    priority INTEGER DEFAULT 5,
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    locked_at DATETIME,
    locked_by TEXT,
    run_after DATETIME DEFAULT (datetime('now','localtime')),
    error_message TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (olt_id) REFERENCES olts(id) ON DELETE CASCADE,
    FOREIGN KEY (onu_id) REFERENCES onus(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS olt_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    olt_id INTEGER NOT NULL,
    job_id INTEGER,
    started_at DATETIME DEFAULT (datetime('now','localtime')),
    finished_at DATETIME,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
    pon_count INTEGER DEFAULT 0,
    onu_count INTEGER DEFAULT 0,
    online_count INTEGER DEFAULT 0,
    offline_count INTEGER DEFAULT 0,
    error_message TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (olt_id) REFERENCES olts(id) ON DELETE CASCADE,
    FOREIGN KEY (job_id) REFERENCES olt_sync_jobs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_olts_status_vendor ON olts(status, vendor);
CREATE INDEX IF NOT EXISTS idx_pon_ports_olt_slot_pon ON pon_ports(olt_id, slot, pon);
CREATE INDEX IF NOT EXISTS idx_onus_olt_port_status ON onus(olt_id, pon_port_id, status);
CREATE INDEX IF NOT EXISTS idx_onus_sn ON onus(onu_sn);
CREATE INDEX IF NOT EXISTS idx_onu_histories_onu_created ON onu_histories(onu_id, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_status_level_created ON alerts(status, level, created_at);
CREATE INDEX IF NOT EXISTS idx_olt_sync_jobs_status_run_after ON olt_sync_jobs(status, run_after, priority);
CREATE INDEX IF NOT EXISTS idx_olt_sync_runs_olt_started ON olt_sync_runs(olt_id, started_at);

ALTER TABLE customers ADD COLUMN onu_id INTEGER;
ALTER TABLE customers ADD COLUMN olt_id INTEGER;
ALTER TABLE customers ADD COLUMN pon_port TEXT;
ALTER TABLE customers ADD COLUMN onu_sn TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_onu_id ON customers(onu_id);
CREATE INDEX IF NOT EXISTS idx_customers_olt_id ON customers(olt_id);
CREATE INDEX IF NOT EXISTS idx_customers_onu_sn ON customers(onu_sn);
