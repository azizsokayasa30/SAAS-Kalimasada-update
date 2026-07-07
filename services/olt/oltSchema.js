const logger = require('../../config/logger');

const OLT_SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS olt_api_profiles (
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
    )`,
    `CREATE TABLE IF NOT EXISTS olts (
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
    )`,
    `CREATE TABLE IF NOT EXISTS pon_ports (
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
    )`,
    `CREATE TABLE IF NOT EXISTS onus (
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
    )`,
    `CREATE TABLE IF NOT EXISTS onu_histories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        onu_id INTEGER NOT NULL,
        status TEXT CHECK (status IN ('ONLINE', 'OFFLINE', 'LOS', 'POWER_OFF', 'DYING_GASP', 'DISABLED', 'AUTH_FAILED', 'UNKNOWN')),
        rx_power REAL,
        tx_power REAL,
        distance REAL,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (onu_id) REFERENCES onus(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS alerts (
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
    )`,
    `CREATE TABLE IF NOT EXISTS olt_sync_jobs (
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
    )`,
    `CREATE TABLE IF NOT EXISTS olt_sync_runs (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_olts_status_vendor ON olts(status, vendor)`,
    `CREATE INDEX IF NOT EXISTS idx_pon_ports_olt_slot_pon ON pon_ports(olt_id, slot, pon)`,
    `CREATE INDEX IF NOT EXISTS idx_onus_olt_port_status ON onus(olt_id, pon_port_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_onus_sn ON onus(onu_sn)`,
    `CREATE INDEX IF NOT EXISTS idx_onu_histories_onu_created ON onu_histories(onu_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_alerts_status_level_created ON alerts(status, level, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_olt_sync_jobs_status_run_after ON olt_sync_jobs(status, run_after, priority)`,
    `CREATE INDEX IF NOT EXISTS idx_olt_sync_runs_olt_started ON olt_sync_runs(olt_id, started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_customers_onu_id ON customers(onu_id)`,
    `CREATE INDEX IF NOT EXISTS idx_customers_olt_id ON customers(olt_id)`,
    `CREATE INDEX IF NOT EXISTS idx_customers_onu_sn ON customers(onu_sn)`
];

const CUSTOMER_COLUMNS = [
    'ALTER TABLE customers ADD COLUMN onu_id INTEGER',
    'ALTER TABLE customers ADD COLUMN olt_id INTEGER',
    'ALTER TABLE customers ADD COLUMN pon_port TEXT',
    'ALTER TABLE customers ADD COLUMN onu_sn TEXT'
];

function get(db, sql, params = []) {
    return new Promise((resolve) => {
        db.get(sql, params, (err, row) => {
            if (err) {
                logger.warn(`[olt-schema] ${err.message}`);
                resolve(null);
            } else {
                resolve(row || null);
            }
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                logger.warn(`[olt-schema] ${err.message}`);
                resolve([]);
            } else {
                resolve(rows || []);
            }
        });
    });
}

function run(db, sql) {
    return new Promise((resolve) => {
        db.run(sql, (err) => {
            if (err && !String(err.message || '').toLowerCase().includes('duplicate column')) {
                logger.warn(`[olt-schema] ${err.message}`);
            }
            resolve();
        });
    });
}

async function hasLegacyOltForeignKey(db, tableName) {
    const rows = await all(db, `PRAGMA foreign_key_list(${tableName})`);
    return rows.some((row) => String(row.table || '').startsWith('olts_legacy_'));
}

async function rebuildTableWithFreshForeignKeys(db, tableName, createStatement) {
    const existingColumns = await all(db, `PRAGMA table_info(${tableName})`);
    if (!existingColumns.length) return;

    const tempTable = `${tableName}_fk_rebuild_${Date.now()}`;
    const tempCreate = createStatement
        .replace(new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${tableName}\\b`, 'i'), `CREATE TABLE ${tempTable}`)
        .replace(new RegExp(`CREATE TABLE\\s+${tableName}\\b`, 'i'), `CREATE TABLE ${tempTable}`);

    logger.warn(`[olt-schema] Rebuilding ${tableName} foreign keys`);
    await run(db, tempCreate);

    const newColumns = await all(db, `PRAGMA table_info(${tempTable})`);
    const newColumnNames = new Set(newColumns.map((column) => column.name));
    const sharedColumns = existingColumns
        .map((column) => column.name)
        .filter((name) => newColumnNames.has(name));

    if (sharedColumns.length) {
        const columnList = sharedColumns.map((name) => `"${name}"`).join(', ');
        await run(db, `INSERT OR IGNORE INTO ${tempTable} (${columnList}) SELECT ${columnList} FROM ${tableName}`);
    }

    await run(db, `DROP TABLE ${tableName}`);
    await run(db, `ALTER TABLE ${tempTable} RENAME TO ${tableName}`);
}

async function rebuildLegacyOltForeignKeys(db) {
    const tableStatements = [
        ['pon_ports', OLT_SCHEMA_STATEMENTS[2]],
        ['onus', OLT_SCHEMA_STATEMENTS[3]],
        ['alerts', OLT_SCHEMA_STATEMENTS[5]],
        ['olt_sync_jobs', OLT_SCHEMA_STATEMENTS[6]],
        ['olt_sync_runs', OLT_SCHEMA_STATEMENTS[7]]
    ];

    const needsRebuild = [];
    for (const [tableName, statement] of tableStatements) {
        if (await hasLegacyOltForeignKey(db, tableName)) {
            needsRebuild.push([tableName, statement]);
        }
    }
    if (!needsRebuild.length) return;

    await run(db, 'PRAGMA foreign_keys = OFF');
    for (const [tableName, statement] of needsRebuild) {
        await rebuildTableWithFreshForeignKeys(db, tableName, statement);
    }
    await run(db, 'PRAGMA foreign_keys = ON');
}

async function migrateLegacyOltsIfNeeded(db) {
    const table = await get(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'olts'");
    if (!table || !table.sql) return;

    const sql = String(table.sql);
    const hasEnterpriseColumns = /\bvendor\b/i.test(sql) && /\bapi_profile_id\b/i.test(sql) && /\bconnection_method\b/i.test(sql);
    if (hasEnterpriseColumns) return;

    const legacyTableName = `olts_legacy_${Date.now()}`;
    logger.warn(`[olt-schema] Migrating legacy olts table to ${legacyTableName}`);
    await run(db, `ALTER TABLE olts RENAME TO ${legacyTableName}`);
    await run(db, OLT_SCHEMA_STATEMENTS[1]);
    await run(
        db,
        `INSERT INTO olts (
            id, name, vendor, model, ip_address, port, username, password_encrypted,
            enable_password, connection_method, snmp_community, snmp_version,
            location, description, status, polling_interval, created_at, updated_at
        )
        SELECT
            id,
            name,
            'Generic',
            NULL,
            ip_address,
            443,
            NULL,
            NULL,
            NULL,
            'https_api',
            NULL,
            'v2',
            location,
            notes,
            CASE WHEN status = 'up' THEN 'active' ELSE 'inactive' END,
            5,
            created_at,
            updated_at
        FROM ${legacyTableName}`
    );
}

async function migrateOltPollingIntervalConstraint(db) {
    const table = await get(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'olts'");
    if (!table || !table.sql) return;

    const sql = String(table.sql);
    const hasPollingIntervalCheck = /polling_interval[\s\S]*CHECK\s*\([\s\S]*polling_interval\s+IN/i.test(sql);
    if (!hasPollingIntervalCheck || /\bpolling_interval\s+IN\s*\([^)]*\b10\b/i.test(sql)) return;

    logger.warn('[olt-schema] Rebuilding olts table to allow 10 minute polling interval');
    await run(db, 'PRAGMA foreign_keys = OFF');
    await rebuildTableWithFreshForeignKeys(db, 'olts', OLT_SCHEMA_STATEMENTS[1]);
    await run(db, 'PRAGMA foreign_keys = ON');
}

async function ensureOltSchema(db) {
    await run(db, OLT_SCHEMA_STATEMENTS[0]);
    await migrateLegacyOltsIfNeeded(db);
    for (const statement of OLT_SCHEMA_STATEMENTS.slice(1, 8)) {
        await run(db, statement);
    }
    await migrateOltPollingIntervalConstraint(db);
    for (const statement of CUSTOMER_COLUMNS) {
        await run(db, statement);
    }
    for (const statement of OLT_SCHEMA_STATEMENTS.slice(8)) {
        await run(db, statement);
    }
    await rebuildLegacyOltForeignKeys(db);
    for (const statement of OLT_SCHEMA_STATEMENTS.slice(8)) {
        await run(db, statement);
    }
    try {
        await run(db, 'ALTER TABLE olts ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1');
    } catch (e) {
        if (!String(e.message || '').includes('duplicate column')) throw e;
    }
}

module.exports = {
    ensureOltSchema
};
