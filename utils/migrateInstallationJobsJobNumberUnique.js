/**
 * Migrasi UNIQUE(job_number) global → UNIQUE(tenant_id, job_number).
 * Tanpa ini, tenant berbeda yang generate PSB-YYYYMMDD001 di hari yang sama
 * saling bentrok constraint SQL.
 */
const logger = require('../config/logger');

const NEW_TABLE_DDL = `CREATE TABLE installation_jobs__mt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_number VARCHAR(50) NOT NULL,
    customer_name VARCHAR(255) NOT NULL,
    customer_phone VARCHAR(20),
    customer_address TEXT,
    customer_id INTEGER,
    package_id INTEGER,
    installation_date DATE,
    installation_time VARCHAR(20),
    assigned_technician_id INTEGER,
    status VARCHAR(50) DEFAULT 'scheduled',
    priority VARCHAR(20) DEFAULT 'normal',
    notes TEXT,
    equipment_needed TEXT,
    estimated_duration INTEGER DEFAULT 120,
    created_by_admin_id INTEGER,
    completed_at DATETIME,
    completion_notes TEXT,
    customer_latitude DECIMAL(10, 8),
    customer_longitude DECIMAL(11, 8),
    assigned_at DATETIME,
    work_started_at DATETIME,
    work_duration_seconds INTEGER,
    tech_completion_latitude REAL,
    tech_completion_longitude REAL,
    install_cable_length_m REAL,
    install_ont_sticker_photo_path TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime')),
    tenant_id INTEGER NOT NULL DEFAULT 1,
    UNIQUE(tenant_id, job_number),
    FOREIGN KEY (package_id) REFERENCES packages(id),
    FOREIGN KEY (assigned_technician_id) REFERENCES technicians(id)
)`;

const COPY_COLS = [
    'id',
    'job_number',
    'customer_name',
    'customer_phone',
    'customer_address',
    'customer_id',
    'package_id',
    'installation_date',
    'installation_time',
    'assigned_technician_id',
    'status',
    'priority',
    'notes',
    'equipment_needed',
    'estimated_duration',
    'created_by_admin_id',
    'completed_at',
    'completion_notes',
    'customer_latitude',
    'customer_longitude',
    'assigned_at',
    'work_started_at',
    'work_duration_seconds',
    'tech_completion_latitude',
    'tech_completion_longitude',
    'install_cable_length_m',
    'install_ont_sticker_photo_path',
    'created_at',
    'updated_at',
    'tenant_id'
];

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
    });
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function hasGlobalJobNumberUnique(tableSql, uniqueIndexes) {
    const sql = String(tableSql || '');
    if (/job_number\s+VARCHAR\s*\(\s*\d+\s*\)\s+UNIQUE/i.test(sql)) return true;
    if (/job_number\s+TEXT\s+UNIQUE/i.test(sql)) return true;
    if (/UNIQUE\s*\(\s*job_number\s*\)/i.test(sql)) return true;
    for (const idx of uniqueIndexes || []) {
        const cols = (idx.cols || []).map((c) => String(c || '').toLowerCase());
        if (cols.length === 1 && cols[0] === 'job_number') return true;
    }
    return false;
}

async function ensureTenantScopedIndexes(db) {
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_installation_jobs_status ON installation_jobs(status)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_installation_jobs_technician ON installation_jobs(assigned_technician_id)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_installation_jobs_date ON installation_jobs(installation_date)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_installation_jobs_created ON installation_jobs(created_at)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_installation_jobs_tenant_id ON installation_jobs(tenant_id)');
    await dbRun(
        db,
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_installation_jobs_tenant_job_number ON installation_jobs(tenant_id, job_number)'
    );
}

/**
 * @param {import('sqlite3').Database} db
 * @returns {Promise<boolean>} true jika migrasi dijalankan
 */
async function migrateInstallationJobsJobNumberUnique(db) {
    const tableRow = await dbGet(
        db,
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='installation_jobs'`
    );
    if (!tableRow) return false;

    // Pastikan kolom tenant_id ada sebelum rebuild / index
    const cols = await dbAll(db, 'PRAGMA table_info(installation_jobs)');
    const colNames = new Set((cols || []).map((c) => String(c.name || '').toLowerCase()));
    if (!colNames.has('tenant_id')) {
        await dbRun(db, 'ALTER TABLE installation_jobs ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1');
    }

    const idxList = await dbAll(db, 'PRAGMA index_list(installation_jobs)');
    const uniqueIndexes = [];
    for (const idx of idxList || []) {
        if (!idx.unique) continue;
        const safeName = String(idx.name || '').replace(/'/g, "''");
        const info = await dbAll(db, `PRAGMA index_info('${safeName}')`);
        uniqueIndexes.push({
            name: idx.name,
            cols: (info || []).map((r) => r.name)
        });
    }

    const needsRebuild = hasGlobalJobNumberUnique(tableRow.sql, uniqueIndexes);
    if (!needsRebuild) {
        await ensureTenantScopedIndexes(db);
        return false;
    }

    logger.info('[installation-jobs] Migrating UNIQUE(job_number) → UNIQUE(tenant_id, job_number)');

    await dbRun(db, 'PRAGMA foreign_keys=OFF');
    try {
        await dbRun(db, 'BEGIN IMMEDIATE');
        await dbRun(db, 'DROP TABLE IF EXISTS installation_jobs__mt');
        await dbRun(db, NEW_TABLE_DDL);

        const existingCols = await dbAll(db, 'PRAGMA table_info(installation_jobs)');
        const existingSet = new Set((existingCols || []).map((c) => String(c.name || '').toLowerCase()));
        const selectParts = COPY_COLS.map((c) => {
            if (c === 'tenant_id') {
                return existingSet.has('tenant_id') ? 'COALESCE(tenant_id, 1)' : '1';
            }
            if (!existingSet.has(c.toLowerCase())) {
                return `NULL AS ${c}`;
            }
            return c;
        });

        await dbRun(
            db,
            `INSERT INTO installation_jobs__mt (${COPY_COLS.join(', ')})
             SELECT ${selectParts.join(', ')} FROM installation_jobs`
        );
        await dbRun(db, 'DROP TABLE installation_jobs');
        await dbRun(db, 'ALTER TABLE installation_jobs__mt RENAME TO installation_jobs');
        await dbRun(db, 'COMMIT');
        logger.info('[installation-jobs] UNIQUE(job_number) migrated to per-tenant');
    } catch (err) {
        try {
            await dbRun(db, 'ROLLBACK');
        } catch (_) {
            /* ignore */
        }
        logger.error('[installation-jobs] job_number unique migration failed:', err.message || err);
        throw err;
    } finally {
        try {
            await dbRun(db, 'PRAGMA foreign_keys=ON');
        } catch (_) {
            /* ignore */
        }
    }

    await ensureTenantScopedIndexes(db);
    return true;
}

/**
 * Fire-and-forget wrapper untuk startup serialize() callback style.
 * @param {import('sqlite3').Database} db
 */
function migrateInstallationJobsJobNumberUniqueAsync(db) {
    migrateInstallationJobsJobNumberUnique(db).catch((err) => {
        logger.error('[installation-jobs] migrate job_number unique:', err.message || err);
    });
}

module.exports = {
    migrateInstallationJobsJobNumberUnique,
    migrateInstallationJobsJobNumberUniqueAsync,
    ensureTenantScopedIndexes
};
