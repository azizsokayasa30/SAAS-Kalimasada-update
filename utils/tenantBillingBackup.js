'use strict';

/**
 * Backup / restore data per-tenant (bukan full billing.db).
 * - Export: baris tenant + RADIUS slice → satu file ZIP (tanpa image)
 * - Restore: purge hanya tenant target + insert dengan ID remap + merge RADIUS
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const sqlite3 = require('sqlite3').verbose();
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const logger = require('../config/logger');

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

const SCHEMA_VERSION = 1;
const DEFAULT_KEEP_COUNT = 5;

const TENANT_TABLES = [
    'areas',
    'attendance_branches',
    'attendance_settings',
    'attendance_shifts',
    'finance_categories',
    'packages',
    'routers',
    'technicians',
    'collectors',
    'agents',
    'odps',
    'genieacs_servers',
    'olts',
    'employees',
    'customers',
    'members',
    'member_packages',
    'invoices',
    'payments',
    'installation_jobs',
    'installation_job_status_history',
    'trouble_reports',
    'employee_attendance',
    'employee_payroll',
    'employee_leave_requests',
    'warehouse_items',
    'warehouse_inbound_batches',
    'warehouse_units',
    'goods_invoices',
    'goods_invoice_items',
    'expenses',
    'income',
    'collector_areas',
    'collector_assignments',
    'collector_payments',
    'collector_remittance_receipts',
    'voucher_revenue',
    'activity_logs',
    'app_settings',
    'tenant_pppoe_users',
    'tenant_pppoe_profiles'
];

/** Child tables tanpa tenant_id — diekspor via parent */
const CHILD_EXPORT = [
    {
        table: 'cable_routes',
        sql: `SELECT * FROM cable_routes WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)
              OR odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)`,
        params: (tid) => [tid, tid]
    },
    {
        table: 'odp_connections',
        sql: `SELECT * FROM odp_connections WHERE from_odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)
              OR to_odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)`,
        params: (tid) => [tid, tid]
    },
    {
        table: 'network_segments',
        sql: `SELECT * FROM network_segments WHERE start_odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)
              OR end_odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)`,
        params: (tid) => [tid, tid]
    },
    {
        table: 'cable_maintenance_logs',
        sql: `SELECT * FROM cable_maintenance_logs WHERE
              network_segment_id IN (
                SELECT id FROM network_segments
                WHERE start_odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)
                   OR end_odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)
              )
              OR cable_route_id IN (
                SELECT id FROM cable_routes
                WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)
                   OR odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)
              )`,
        params: (tid) => [tid, tid, tid, tid]
    },
    {
        table: 'customer_router_map',
        sql: `SELECT * FROM customer_router_map WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)`,
        params: (tid) => [tid]
    },
    {
        table: 'installation_job_equipment',
        sql: `SELECT * FROM installation_job_equipment WHERE job_id IN (SELECT id FROM installation_jobs WHERE tenant_id = ?)`,
        params: (tid) => [tid]
    },
    {
        table: 'agent_balances',
        sql: `SELECT * FROM agent_balances WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`,
        params: (tid) => [tid]
    },
    {
        table: 'agent_transactions',
        sql: `SELECT * FROM agent_transactions WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`,
        params: (tid) => [tid]
    },
    {
        table: 'agent_payments',
        sql: `SELECT * FROM agent_payments WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`,
        params: (tid) => [tid]
    },
    {
        table: 'pon_ports',
        sql: `SELECT * FROM pon_ports WHERE olt_id IN (SELECT id FROM olts WHERE tenant_id = ?)`,
        params: (tid) => [tid]
    },
    {
        table: 'onus',
        sql: `SELECT * FROM onus WHERE olt_id IN (SELECT id FROM olts WHERE tenant_id = ?)`,
        params: (tid) => [tid]
    },
    {
        table: 'onu_devices',
        sql: `SELECT * FROM onu_devices WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)
              OR odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)`,
        params: (tid) => [tid, tid]
    }
];

const FK_COLUMN_MAP = {
    customer_id: 'customers',
    package_id: 'packages',
    area_id: 'areas',
    router_id: 'routers',
    technician_id: 'technicians',
    assigned_technician_id: 'technicians',
    collector_id: 'collectors',
    agent_id: 'agents',
    odp_id: 'odps',
    from_odp_id: 'odps',
    to_odp_id: 'odps',
    start_odp_id: 'odps',
    end_odp_id: 'odps',
    employee_id: 'employees',
    job_id: 'installation_jobs',
    invoice_id: 'invoices',
    member_id: 'members',
    shift_id: 'attendance_shifts',
    branch_id: 'attendance_branches',
    item_id: 'warehouse_items',
    batch_id: 'warehouse_inbound_batches',
    goods_invoice_id: 'goods_invoices',
    olt_id: 'olts',
    genieacs_server_id: 'genieacs_servers',
    parent_id: 'odps',
    cable_route_id: 'cable_routes',
    network_segment_id: 'network_segments'
};

function getTenantBackupDir(tenantId) {
    return path.join(process.cwd(), 'data', 'backup', 'tenant', String(tenantId));
}

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
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

async function tableExists(db, name) {
    const row = await dbGet(
        db,
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
        [name]
    );
    return !!row;
}

async function getColumns(db, table) {
    return dbAll(db, `PRAGMA table_info(${table})`);
}

function openSqlite(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => (err ? reject(err) : resolve(db)));
    });
}

function closeSqlite(db) {
    return new Promise((resolve) => {
        if (!db) return resolve();
        db.close(() => resolve());
    });
}

async function resolveRadiusPath() {
    try {
        const { resolveRadiusSqliteDbPath } = require('../config/radiusSQLite');
        const r = await resolveRadiusSqliteDbPath();
        return r.dbPath;
    } catch (_) {
        return path.join(process.cwd(), 'data', 'radius.db');
    }
}

async function collectTenantUsernames(billingDb, tenantId) {
    const names = new Set();
    if (await tableExists(billingDb, 'customers')) {
        const rows = await dbAll(
            billingDb,
            `SELECT DISTINCT TRIM(pppoe_username) AS u FROM customers
             WHERE tenant_id = ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''`,
            [tenantId]
        );
        rows.forEach((r) => r.u && names.add(String(r.u).trim()));
    }
    if (await tableExists(billingDb, 'tenant_pppoe_users')) {
        const rows = await dbAll(
            billingDb,
            `SELECT DISTINCT TRIM(username) AS u FROM tenant_pppoe_users
             WHERE tenant_id = ? AND username IS NOT NULL AND TRIM(username) != ''`,
            [tenantId]
        );
        rows.forEach((r) => r.u && names.add(String(r.u).trim()));
    }
    return Array.from(names);
}

async function collectTenantGroups(billingDb, tenantId) {
    const groups = new Set();
    if (await tableExists(billingDb, 'tenant_pppoe_profiles')) {
        const rows = await dbAll(
            billingDb,
            `SELECT DISTINCT TRIM(groupname) AS g FROM tenant_pppoe_profiles
             WHERE tenant_id = ? AND groupname IS NOT NULL AND TRIM(groupname) != ''`,
            [tenantId]
        );
        rows.forEach((r) => r.g && groups.add(String(r.g).trim()));
    }
    if (await tableExists(billingDb, 'packages')) {
        const rows = await dbAll(
            billingDb,
            `SELECT DISTINCT TRIM(pppoe_profile) AS g FROM packages
             WHERE tenant_id = ? AND pppoe_profile IS NOT NULL AND TRIM(pppoe_profile) != ''`,
            [tenantId]
        );
        rows.forEach((r) => r.g && groups.add(String(r.g).trim()));
    }
    if (await tableExists(billingDb, 'customers')) {
        const rows = await dbAll(
            billingDb,
            `SELECT DISTINCT TRIM(pppoe_profile) AS g FROM customers
             WHERE tenant_id = ? AND pppoe_profile IS NOT NULL AND TRIM(pppoe_profile) != ''`,
            [tenantId]
        );
        rows.forEach((r) => r.g && groups.add(String(r.g).trim()));
    }
    return Array.from(groups);
}

async function exportRadiusSlice(radiusDbPath, usernames, groups, tenantId) {
    const slice = {
        usernames,
        groups,
        radcheck: [],
        radreply: [],
        radusergroup: [],
        radgroupcheck: [],
        radgroupreply: [],
        nas: []
    };
    if (!fs.existsSync(radiusDbPath)) return slice;

    const db = await openSqlite(radiusDbPath);
    try {
        const placeholders = (arr) => arr.map(() => '?').join(',');
        if (usernames.length) {
            const ph = placeholders(usernames);
            for (const table of ['radcheck', 'radreply', 'radusergroup']) {
                if (await tableExists(db, table)) {
                    slice[table] = await dbAll(
                        db,
                        `SELECT * FROM ${table} WHERE username IN (${ph})`,
                        usernames
                    );
                }
            }
        }
        if (groups.length) {
            const ph = placeholders(groups);
            for (const table of ['radgroupcheck', 'radgroupreply']) {
                if (await tableExists(db, table)) {
                    slice[table] = await dbAll(
                        db,
                        `SELECT * FROM ${table} WHERE groupname IN (${ph})`,
                        groups
                    );
                }
            }
        }
        if (await tableExists(db, 'nas')) {
            const cols = await getColumns(db, 'nas');
            if (cols.some((c) => c.name === 'tenant_id')) {
                slice.nas = await dbAll(db, `SELECT * FROM nas WHERE tenant_id = ?`, [tenantId]);
            }
        }
    } finally {
        await closeSqlite(db);
    }
    return slice;
}

async function mergeRadiusSlice(radiusDbPath, slice) {
    if (!slice || !fs.existsSync(radiusDbPath)) return;
    const db = await openSqlite(radiusDbPath);
    try {
        await dbRun(db, 'BEGIN IMMEDIATE');
        const usernames = slice.usernames || [];
        const groups = slice.groups || [];

        if (usernames.length) {
            const ph = usernames.map(() => '?').join(',');
            for (const table of ['radcheck', 'radreply', 'radusergroup']) {
                if (!(await tableExists(db, table))) continue;
                await dbRun(db, `DELETE FROM ${table} WHERE username IN (${ph})`, usernames);
            }
        }
        if (groups.length) {
            const ph = groups.map(() => '?').join(',');
            for (const table of ['radgroupcheck', 'radgroupreply']) {
                if (!(await tableExists(db, table))) continue;
                await dbRun(db, `DELETE FROM ${table} WHERE groupname IN (${ph})`, groups);
            }
        }

        async function insertRows(table, rows) {
            if (!(await tableExists(db, table)) || !rows || !rows.length) return;
            const cols = (await getColumns(db, table)).map((c) => c.name);
            const insertCols = cols.filter((c) => c !== 'id');
            for (const row of rows) {
                const values = insertCols.map((c) => (row[c] !== undefined ? row[c] : null));
                const placeholders = insertCols.map(() => '?').join(',');
                try {
                    await dbRun(
                        db,
                        `INSERT INTO ${table} (${insertCols.join(',')}) VALUES (${placeholders})`,
                        values
                    );
                } catch (err) {
                    logger.warn(`[tenant-backup] RADIUS insert ${table}: ${err.message}`);
                }
            }
        }

        await insertRows('radcheck', slice.radcheck);
        await insertRows('radreply', slice.radreply);
        await insertRows('radusergroup', slice.radusergroup);
        await insertRows('radgroupcheck', slice.radgroupcheck);
        await insertRows('radgroupreply', slice.radgroupreply);

        if (slice.nas && slice.nas.length && (await tableExists(db, 'nas'))) {
            for (const row of slice.nas) {
                const nasname = row.nasname;
                if (!nasname) continue;
                const existing = await dbGet(db, `SELECT id FROM nas WHERE nasname = ?`, [nasname]);
                if (existing) {
                    await dbRun(
                        db,
                        `UPDATE nas SET shortname=?, secret=?, type=?, ports=?, server=?, community=?, description=?, tenant_id=COALESCE(?, tenant_id)
                         WHERE nasname=?`,
                        [
                            row.shortname || null,
                            row.secret || null,
                            row.type || null,
                            row.ports || null,
                            row.server || null,
                            row.community || null,
                            row.description || null,
                            row.tenant_id || null,
                            nasname
                        ]
                    );
                } else {
                    const cols = (await getColumns(db, 'nas')).map((c) => c.name).filter((c) => c !== 'id');
                    const values = cols.map((c) => (row[c] !== undefined ? row[c] : null));
                    await dbRun(
                        db,
                        `INSERT INTO nas (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
                        values
                    );
                }
            }
        }

        await dbRun(db, 'COMMIT');
    } catch (err) {
        try {
            await dbRun(db, 'ROLLBACK');
        } catch (_) {
            /* ignore */
        }
        throw err;
    } finally {
        await closeSqlite(db);
    }
}

async function exportTenantTables(billingDb, tenantId) {
    const tables = {};
    for (const table of TENANT_TABLES) {
        if (!(await tableExists(billingDb, table))) continue;
        const cols = await getColumns(billingDb, table);
        if (!cols.some((c) => c.name === 'tenant_id')) continue;
        tables[table] = await dbAll(
            billingDb,
            `SELECT * FROM ${table} WHERE tenant_id = ?`,
            [tenantId]
        );
    }

    const child_tables = {};
    for (const spec of CHILD_EXPORT) {
        if (!(await tableExists(billingDb, spec.table))) continue;
        try {
            child_tables[spec.table] = await dbAll(billingDb, spec.sql, spec.params(tenantId));
        } catch (err) {
            logger.warn(`[tenant-backup] skip child ${spec.table}: ${err.message}`);
        }
    }
    return { tables, child_tables };
}

async function getTenantSettingsSnapshot(billingDb, tenantId) {
    try {
        if (!(await tableExists(billingDb, 'tenants'))) return null;
        const row = await dbGet(
            billingDb,
            `SELECT id, subdomain, name, settings FROM tenants WHERE id = ?`,
            [tenantId]
        );
        if (!row) return null;
        let settings = row.settings;
        if (typeof settings === 'string') {
            try {
                settings = JSON.parse(settings);
            } catch (_) {
                /* keep string */
            }
        }
        return {
            id: row.id,
            subdomain: row.subdomain,
            name: row.name,
            settings
        };
    } catch (_) {
        return null;
    }
}

function zipFromBuffers(entries, outPath) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        const output = fs.createWriteStream(outPath);
        const ZipArchive = archiver.ZipArchive || archiver;
        const archive =
            typeof ZipArchive === 'function'
                ? new ZipArchive({ zlib: { level: 9 } })
                : archiver('zip', { zlib: { level: 9 } });
        output.on('close', () => resolve(outPath));
        archive.on('error', reject);
        archive.pipe(output);
        for (const [name, buf] of Object.entries(entries)) {
            archive.append(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)), { name });
        }
        archive.finalize();
    });
}

/**
 * Export backup ZIP untuk satu tenant (tanpa image).
 */
async function exportTenantBackup(billingDb, tenantId, options = {}) {
    const tid = parseInt(tenantId, 10);
    if (!Number.isFinite(tid)) throw new Error('tenant_id tidak valid');

    const tenantMeta = await getTenantSettingsSnapshot(billingDb, tid);
    const { tables, child_tables } = await exportTenantTables(billingDb, tid);
    const usernames = await collectTenantUsernames(billingDb, tid);
    const groups = await collectTenantGroups(billingDb, tid);
    const radiusPath = options.radiusDbPath || (await resolveRadiusPath());
    const radius = await exportRadiusSlice(radiusPath, usernames, groups, tid);

    const counts = {};
    Object.keys(tables).forEach((t) => {
        counts[t] = (tables[t] || []).length;
    });
    Object.keys(child_tables).forEach((t) => {
        counts[`child:${t}`] = (child_tables[t] || []).length;
    });
    counts['radius:usernames'] = usernames.length;

    const manifest = {
        schema_version: SCHEMA_VERSION,
        kind: 'tenant_billing_backup',
        tenant_id: tid,
        subdomain: tenantMeta?.subdomain || null,
        created_at: new Date().toISOString(),
        includes_images: false,
        counts
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = getTenantBackupDir(tid);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `tenant_${tid}_${stamp}.zip`;
    const outPath = path.join(dir, filename);

    const billingJson = JSON.stringify({ tables, child_tables });
    const entries = {
        'manifest.json': JSON.stringify(manifest, null, 2),
        'billing.json.gz': await gzipAsync(Buffer.from(billingJson, 'utf8')),
        'radius.json.gz': await gzipAsync(Buffer.from(JSON.stringify(radius), 'utf8')),
        'tenant_settings.json': JSON.stringify(tenantMeta || {}, null, 2)
    };

    await zipFromBuffers(entries, outPath);
    const stat = fs.statSync(outPath);

    return {
        filename,
        path: outPath,
        size: stat.size,
        created: stat.mtime,
        manifest
    };
}

async function purgeTenantData(billingDb, tenantId) {
    await dbRun(billingDb, 'PRAGMA foreign_keys=OFF');

    const childDeletes = [
        [
            'odp_connections',
            `DELETE FROM odp_connections WHERE from_odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)
             OR to_odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)`,
            (tid) => [tid, tid]
        ],
        [
            'cable_maintenance_logs',
            `DELETE FROM cable_maintenance_logs WHERE
             network_segment_id IN (
               SELECT id FROM network_segments
               WHERE start_odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)
                  OR end_odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)
             )
             OR cable_route_id IN (
               SELECT id FROM cable_routes
               WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)
                  OR odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)
             )`,
            (tid) => [tid, tid, tid, tid]
        ],
        [
            'network_segments',
            `DELETE FROM network_segments WHERE start_odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)
             OR end_odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)`,
            (tid) => [tid, tid]
        ],
        [
            'cable_routes',
            `DELETE FROM cable_routes WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)
             OR odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)`,
            (tid) => [tid, tid]
        ],
        [
            'customer_router_map',
            `DELETE FROM customer_router_map WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)`,
            (tid) => [tid]
        ],
        [
            'installation_job_equipment',
            `DELETE FROM installation_job_equipment WHERE job_id IN (SELECT id FROM installation_jobs WHERE tenant_id = ?)`,
            (tid) => [tid]
        ],
        [
            'installation_job_status_history',
            `DELETE FROM installation_job_status_history WHERE job_id IN (SELECT id FROM installation_jobs WHERE tenant_id = ?)`,
            (tid) => [tid]
        ],
        [
            'payments',
            `DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE tenant_id = ?)`,
            (tid) => [tid]
        ],
        [
            'agent_balances',
            `DELETE FROM agent_balances WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`,
            (tid) => [tid]
        ],
        [
            'agent_transactions',
            `DELETE FROM agent_transactions WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`,
            (tid) => [tid]
        ],
        [
            'agent_payments',
            `DELETE FROM agent_payments WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`,
            (tid) => [tid]
        ],
        [
            'pon_ports',
            `DELETE FROM pon_ports WHERE olt_id IN (SELECT id FROM olts WHERE tenant_id = ?)`,
            (tid) => [tid]
        ],
        [
            'onus',
            `DELETE FROM onus WHERE olt_id IN (SELECT id FROM olts WHERE tenant_id = ?)`,
            (tid) => [tid]
        ],
        [
            'onu_devices',
            `DELETE FROM onu_devices WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)
             OR odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)`,
            (tid) => [tid, tid]
        ]
    ];

    for (const [table, sql, paramsFn] of childDeletes) {
        if (!(await tableExists(billingDb, table))) continue;
        try {
            await dbRun(billingDb, sql, paramsFn(tenantId));
        } catch (err) {
            logger.warn(`[tenant-backup] purge ${table}: ${err.message}`);
        }
    }

    const allTables = await dbAll(
        billingDb,
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    );
    const skip = new Set([
        'tenants',
        'super_admins',
        'subscription_plans',
        'master_packages',
        'migrations',
        'platform_settings',
        'platform_audit_logs'
    ]);
    for (const { name: table } of allTables) {
        if (skip.has(table)) continue;
        const cols = await getColumns(billingDb, table);
        if (!cols.some((c) => c.name === 'tenant_id')) continue;
        await dbRun(billingDb, `DELETE FROM ${table} WHERE tenant_id = ?`, [tenantId]);
    }

    await dbRun(billingDb, 'PRAGMA foreign_keys=ON');
}

function remapRow(row, table, idMaps, tenantId) {
    const out = { ...row };
    if (Object.prototype.hasOwnProperty.call(out, 'tenant_id')) {
        out.tenant_id = tenantId;
    }
    for (const [col, refTable] of Object.entries(FK_COLUMN_MAP)) {
        if (out[col] == null) continue;
        const map = idMaps.get(refTable);
        if (!map) continue;
        const key = String(out[col]);
        if (map.has(key)) out[col] = map.get(key);
    }
    // Unik bisnis yang sering bentrok
    if (table === 'installation_jobs' && out.job_number) {
        out.job_number = `${out.job_number}-R${Date.now().toString(36).slice(-4)}`;
    }
    if (table === 'employees' && out.public_code) {
        out.public_code = `${out.public_code}-r${Date.now().toString(36).slice(-3)}`;
    }
    return out;
}

async function insertRemappedTable(billingDb, table, rows, tenantId, idMaps) {
    if (!rows || !rows.length) return;
    if (!(await tableExists(billingDb, table))) return;

    const colsInfo = await getColumns(billingDb, table);
    const colNames = colsInfo.map((c) => c.name);
    const hasId = colNames.includes('id');
    const insertCols = colNames.filter((c) => c !== 'id');
    const map = idMaps.get(table) || new Map();
    idMaps.set(table, map);

    for (const raw of rows) {
        const oldId = raw.id;
        const row = remapRow(raw, table, idMaps, tenantId);
        const values = insertCols.map((c) => (row[c] !== undefined ? row[c] : null));
        const placeholders = insertCols.map(() => '?').join(',');
        try {
            const result = await dbRun(
                billingDb,
                `INSERT INTO ${table} (${insertCols.join(',')}) VALUES (${placeholders})`,
                values
            );
            if (hasId && oldId != null) {
                map.set(String(oldId), result.id);
            }
        } catch (err) {
            // Retry unik invoice_number
            if (table === 'invoices' && /UNIQUE/i.test(err.message) && row.invoice_number) {
                row.invoice_number = `${row.invoice_number}-R${Date.now().toString(36).slice(-4)}`;
                const values2 = insertCols.map((c) => (row[c] !== undefined ? row[c] : null));
                const result = await dbRun(
                    billingDb,
                    `INSERT INTO ${table} (${insertCols.join(',')}) VALUES (${placeholders})`,
                    values2
                );
                if (hasId && oldId != null) map.set(String(oldId), result.id);
            } else {
                throw new Error(`Gagal insert ${table}: ${err.message}`);
            }
        }
    }
}

async function restoreTenantSettings(billingDb, tenantId, snapshot) {
    if (!snapshot || !snapshot.settings) return;
    if (!(await tableExists(billingDb, 'tenants'))) return;
    const settingsJson =
        typeof snapshot.settings === 'string'
            ? snapshot.settings
            : JSON.stringify(snapshot.settings);
    await dbRun(
        billingDb,
        `UPDATE tenants SET settings = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
        [settingsJson, tenantId]
    );
}

/**
 * Restore dari ZIP per-tenant. Hanya menyentuh data tenant target.
 */
async function restoreTenantBackup(billingDb, tenantId, archivePath, options = {}) {
    const tid = parseInt(tenantId, 10);
    if (!Number.isFinite(tid)) throw new Error('tenant_id tidak valid');
    if (!fs.existsSync(archivePath)) throw new Error('File backup tidak ditemukan');

    const zip = new AdmZip(archivePath);
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) throw new Error('manifest.json tidak ada di arsip');
    const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    if (manifest.kind !== 'tenant_billing_backup') {
        throw new Error('Bukan arsip backup tenant yang valid');
    }
    if (Number(manifest.tenant_id) !== tid) {
        throw new Error(
            `Backup milik tenant ${manifest.tenant_id}, tidak bisa di-restore ke tenant ${tid}`
        );
    }

    const billingEntry = zip.getEntry('billing.json.gz') || zip.getEntry('billing.json');
    if (!billingEntry) throw new Error('billing.json tidak ada di arsip');
    let billingRaw = billingEntry.getData();
    if (billingEntry.entryName.endsWith('.gz')) {
        billingRaw = await gunzipAsync(billingRaw);
    }
    const billingData = JSON.parse(billingRaw.toString('utf8'));

    let radiusData = { usernames: [], groups: [], radcheck: [], radreply: [], radusergroup: [] };
    const radiusEntry = zip.getEntry('radius.json.gz') || zip.getEntry('radius.json');
    if (radiusEntry) {
        let raw = radiusEntry.getData();
        if (radiusEntry.entryName.endsWith('.gz')) raw = await gunzipAsync(raw);
        radiusData = JSON.parse(raw.toString('utf8'));
    }

    let tenantSettings = null;
    const settingsEntry = zip.getEntry('tenant_settings.json');
    if (settingsEntry) {
        tenantSettings = JSON.parse(settingsEntry.getData().toString('utf8'));
    }

    const idMaps = new Map();
    await dbRun(billingDb, 'BEGIN IMMEDIATE');
    try {
        await purgeTenantData(billingDb, tid);

        const tables = billingData.tables || {};
        for (const table of TENANT_TABLES) {
            if (!tables[table] || !tables[table].length) continue;
            await insertRemappedTable(billingDb, table, tables[table], tid, idMaps);
        }

        const children = billingData.child_tables || {};
        for (const table of Object.keys(children)) {
            await insertRemappedTable(billingDb, table, children[table], tid, idMaps);
        }

        await restoreTenantSettings(billingDb, tid, tenantSettings);
        await dbRun(billingDb, 'COMMIT');
    } catch (err) {
        try {
            await dbRun(billingDb, 'ROLLBACK');
        } catch (_) {
            /* ignore */
        }
        throw err;
    }

    const radiusPath = options.radiusDbPath || (await resolveRadiusPath());
    await mergeRadiusSlice(radiusPath, radiusData);

    return { success: true, tenant_id: tid, manifest };
}

function listTenantBackups(tenantId) {
    const dir = getTenantBackupDir(tenantId);
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.zip') && f.startsWith(`tenant_${tenantId}_`))
        .map((filename) => {
            const full = path.join(dir, filename);
            const st = fs.statSync(full);
            return {
                filename,
                size: st.size,
                created: st.mtime,
                path: full
            };
        })
        .sort((a, b) => new Date(b.created) - new Date(a.created));
}

function cleanupTenantBackups(tenantId, keepCount = DEFAULT_KEEP_COUNT) {
    const keep = Math.max(parseInt(keepCount, 10) || DEFAULT_KEEP_COUNT, 1);
    const files = listTenantBackups(tenantId);
    const toDelete = files.slice(keep);
    const deleted = [];
    for (const f of toDelete) {
        try {
            fs.unlinkSync(f.path);
            deleted.push(f.filename);
        } catch (_) {
            /* ignore */
        }
    }
    return { kept: files.slice(0, keep).map((f) => f.filename), deleted, deletedCount: deleted.length };
}

function resolveTenantBackupFile(tenantId, filename) {
    const safe = path.basename(String(filename || ''));
    if (!safe || !safe.endsWith('.zip') || !safe.startsWith(`tenant_${tenantId}_`)) {
        return null;
    }
    const full = path.join(getTenantBackupDir(tenantId), safe);
    if (!fs.existsSync(full)) return null;
    return full;
}

async function runTenantAutoBackupIfEnabled(billingDb, tenantId, getSettingFn) {
    const settings = typeof getSettingFn === 'function' ? await getSettingFn(tenantId) : {};
    const enabled =
        settings.billing_autobackup_enabled === 'true' ||
        settings.billing_autobackup_enabled === true;
    if (!enabled) return { ran: false, reason: 'disabled', tenantId };

    const interval = Math.max(parseInt(settings.billing_autobackup_interval, 10) || 7, 1);
    const latest = listTenantBackups(tenantId)[0];
    if (latest) {
        const days = Math.floor(
            Math.abs(Date.now() - new Date(latest.created).getTime()) / (1000 * 60 * 60 * 24)
        );
        if (days < interval) {
            return {
                ran: false,
                reason: 'interval',
                tenantId,
                interval,
                daysSinceLast: days,
                lastBackup: latest.filename
            };
        }
    }

    const result = await exportTenantBackup(billingDb, tenantId);
    cleanupTenantBackups(tenantId, DEFAULT_KEEP_COUNT);
    return { ran: true, tenantId, interval, ...result };
}

module.exports = {
    SCHEMA_VERSION,
    DEFAULT_KEEP_COUNT,
    TENANT_TABLES,
    getTenantBackupDir,
    exportTenantBackup,
    restoreTenantBackup,
    listTenantBackups,
    cleanupTenantBackups,
    resolveTenantBackupFile,
    runTenantAutoBackupIfEnabled,
    collectTenantUsernames,
    exportRadiusSlice,
    mergeRadiusSlice
};
