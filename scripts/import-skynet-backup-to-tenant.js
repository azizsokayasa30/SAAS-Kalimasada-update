#!/usr/bin/env node
'use strict';

/**
 * Import hati-hati backup Skynet (single-tenant) ke tenant SaaS shared-DB.
 *
 * Usage:
 *   node scripts/import-skynet-backup-to-tenant.js --archive="..." --tenant=skynet --dry-run
 *   node scripts/import-skynet-backup-to-tenant.js --archive="..." --tenant=skynet --execute
 *   node scripts/import-skynet-backup-to-tenant.js --source-db=/path/billing.db --tenant=skynet --execute
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { createBillingDbBackup } = require('../utils/billingDbBackup');

const LIVE_DB = path.join(__dirname, '../data/billing.db');
const UPLOADS_DEST = path.join(__dirname, '../public/uploads');

const PACKAGE_NAME_MAP = {
    TEKNISI: 'GRATIS',
    GRATIS: 'GRATIS',
    'PAKET 5MBPS': 'GRATIS',
    'PAKET 10MBPS': 'paket 100',
    'PAKET 20MBPS': 'paket 150',
    'PAKET 30MBPS': 'paket 200',
    'PAKET 40MBPS': 'paket 300',
    'PAKET 50MBPS': 'paket 350',
};

const EXCLUDE_PACKAGES = new Set([
    'DEDICATED',
    'DEDICATED 200MBPS',
    'DEDICATED 300MBPS',
    'DEDICATED 500MBPS',
    'DEDICATED 600MBPS',
    'DEDICATED 700MBPS',
    'DEDICATED 1GBPS',
]);

const SKIP_IMPORT_TABLES = new Set([
    'packages',
    'app_settings',
    'tenants',
    'subscription_plans',
    'super_admins',
    'platform_audit_logs',
    'tenant_provisioning_logs',
    'sqlite_sequence',
    'migrations',
    'onu_histories',
    'license',
]);

/** Parent → child order for core billing import. */
const IMPORT_TABLES = [
    'areas',
    'routers',
    'odps',
    'collectors',
    'technicians',
    'agents',
    'customers',
    'collector_areas',
    'invoices',
    'payments',
    'collector_payments',
    'cable_routes',
    'odp_connections',
    'expenses',
    'income',
    'installation_jobs',
    'trouble_reports',
    'installation_job_status_history',
];

/**
 * Modul tambahan yang wajib ikut restore (dulu terlewat di impor Skynet).
 * Parent → child. File gambar di disk tetap dikecualikan.
 */
const EXTRA_DATA_TABLES = [
    'finance_categories',
    'attendance_branches',
    'attendance_settings',
    'attendance_shifts',
    'warehouse_items',
    'warehouse_inbound_batches',
    'employees',
    'warehouse_units',
    'employee_attendance',
    'employee_leave_requests',
    'employee_payroll',
    'goods_invoices',
    'goods_invoice_items',
    'installation_job_equipment',
];

function parseArgs(argv) {
    const out = {
        archive: null,
        sourceDb: null,
        tenant: 'skynet',
        dryRun: false,
        execute: false,
        copyUploads: true,
    };
    for (const arg of argv) {
        if (arg === '--dry-run') out.dryRun = true;
        else if (arg === '--execute') out.execute = true;
        else if (arg === '--no-uploads') out.copyUploads = false;
        else if (arg.startsWith('--archive=')) out.archive = arg.slice('--archive='.length).replace(/^["']|["']$/g, '');
        else if (arg.startsWith('--source-db=')) out.sourceDb = arg.slice('--source-db='.length).replace(/^["']|["']$/g, '');
        else if (arg.startsWith('--tenant=')) out.tenant = arg.slice('--tenant='.length);
    }
    return out;
}

function normName(name) {
    return String(name || '')
        .trim()
        .toUpperCase();
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
    });
}

function isValidSqliteFile(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(16);
        fs.readSync(fd, buf, 0, 16, 0);
        fs.closeSync(fd);
        return buf.toString('utf8').startsWith('SQLite format 3');
    } catch (_) {
        return false;
    }
}

async function tableExists(db, schema, table) {
    const row = await get(
        db,
        `SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name=?`,
        [table]
    );
    return !!row;
}

async function getColumns(db, schema, table) {
    return all(db, `PRAGMA ${schema}.table_info(${table})`);
}

function extractBillingDb(archivePath, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    execFileSync('tar', ['-xzf', archivePath, '-C', destDir, '--wildcards', '*/sqlite/billing.db'], {
        stdio: 'inherit',
    });
    const matches = [];
    function walk(dir) {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) walk(p);
            else if (ent.name === 'billing.db' && p.includes(`${path.sep}sqlite${path.sep}`)) matches.push(p);
        }
    }
    walk(destDir);
    if (!matches.length) throw new Error('billing.db tidak ditemukan di archive');
    return matches[0];
}

function copyUploadsFromArchive(archivePath, destRoot, options = {}) {
    const onlyEmployees = options.onlyEmployees === true;
    const tmp = path.join('/tmp', `skynet-uploads-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
        const patterns = onlyEmployees
            ? ['*/uploads/employees/*']
            : ['*/uploads/*', '*/uploads-extra/*'];
        execFileSync(
            'tar',
            ['-xzf', archivePath, '-C', tmp, '--wildcards', ...patterns],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );
    } catch (err) {
        // tar may exit non-zero if one pattern missing; continue if anything extracted
        console.warn('  catatan extract uploads:', err.message.split('\n')[0]);
    }

    let copied = 0;
    let skipped = 0;

    /** Skip bukti transfer, foto instalasi/tiket, dan folder gambar lain. */
    function shouldSkipRel(rel) {
        const norm = String(rel || '').replace(/\\/g, '/').toLowerCase();
        if (norm.includes('payments/') || norm.startsWith('payments')) return true;
        if (norm.includes('field-completion')) return true;
        if (norm.includes('uploads-extra') && !onlyEmployees) {
            // uploads-extra sering berisi field-completion
            if (norm.includes('field-completion') || norm.includes('/img/')) return true;
        }
        if (onlyEmployees && !(norm.includes('employees/') || norm.startsWith('employees'))) {
            return true;
        }
        return false;
    }

    function copyTree(srcDir, relBase) {
        if (!fs.existsSync(srcDir)) return;
        for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
            const src = path.join(srcDir, ent.name);
            const rel = path.join(relBase, ent.name);
            if (shouldSkipRel(rel)) continue;
            const dest = path.join(destRoot, rel);
            if (ent.isDirectory()) {
                fs.mkdirSync(dest, { recursive: true });
                copyTree(src, rel);
            } else {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                if (fs.existsSync(dest)) {
                    skipped += 1;
                } else {
                    fs.copyFileSync(src, dest);
                    copied += 1;
                }
            }
        }
    }

    function findAndCopy(label) {
        function walk(dir) {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                    if (ent.name === label) return p;
                    const found = walk(p);
                    if (found) return found;
                }
            }
            return null;
        }
        return walk(tmp);
    }

    if (onlyEmployees) {
        const empDir = findAndCopy('employees');
        if (empDir) copyTree(empDir, 'employees');
    } else {
        const uploadsDir = findAndCopy('uploads');
        const extraDir = findAndCopy('uploads-extra');
        if (uploadsDir) copyTree(uploadsDir, '');
        if (extraDir) copyTree(extraDir, 'uploads-extra');
    }

    try {
        fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {
        /* ignore */
    }
    return { copied, skipped };
}

async function resolveTenant(db, slug) {
    const tenant = await get(
        db,
        `SELECT id, slug, name, status FROM main.tenants WHERE slug = ? OR subdomain = ?`,
        [slug, slug]
    );
    if (!tenant) throw new Error(`Tenant "${slug}" tidak ditemukan`);
    if (String(tenant.status).toLowerCase() === 'deleted') {
        throw new Error(`Tenant "${slug}" status deleted`);
    }
    return tenant;
}

async function resolveTargetPackages(db, tenantId) {
    const rows = await all(
        db,
        `SELECT id, name FROM main.packages WHERE tenant_id = ?`,
        [tenantId]
    );
    const byNorm = new Map();
    for (const row of rows) {
        byNorm.set(normName(row.name), row);
        byNorm.set(String(row.name).trim().toLowerCase(), row);
    }

    const targetBySourceName = {};
    for (const [srcName, targetName] of Object.entries(PACKAGE_NAME_MAP)) {
        const hit =
            byNorm.get(normName(targetName)) ||
            byNorm.get(String(targetName).trim().toLowerCase());
        if (!hit) {
            throw new Error(`Paket target "${targetName}" tidak ada di tenant ${tenantId}`);
        }
        targetBySourceName[srcName] = { id: hit.id, name: hit.name };
    }
    return { rows, targetBySourceName };
}

async function buildSourcePackageMaps(db, targetBySourceName) {
    const pkgs = await all(db, `SELECT id, name FROM src.packages`);
    const srcIdToTarget = new Map();
    const mappedSrcIds = new Set();
    const excludedSrcIds = new Set();

    for (const p of pkgs) {
        const n = normName(p.name);
        if (EXCLUDE_PACKAGES.has(n) || n.startsWith('DEDICATED')) {
            excludedSrcIds.add(p.id);
            continue;
        }
        const target = targetBySourceName[n];
        if (target) {
            srcIdToTarget.set(p.id, target);
            mappedSrcIds.add(p.id);
        }
    }
    return { srcIdToTarget, mappedSrcIds, excludedSrcIds, pkgs };
}

async function analyze(db, srcIdToTarget, excludedSrcIds) {
    const customers = await all(
        db,
        `SELECT c.id, c.username, c.pppoe_username, c.package_id, c.area_id, p.name AS package_name
         FROM src.customers c
         LEFT JOIN src.packages p ON p.id = c.package_id`
    );

    let mapped = 0;
    let excluded = 0;
    let unmapped = 0;
    const keepIds = new Set();
    const excludeIds = new Set();
    const dist = {};
    const pppoeMap = new Map();

    for (const c of customers) {
        const n = normName(c.package_name);
        if (excludedSrcIds.has(c.package_id) || EXCLUDE_PACKAGES.has(n) || n.startsWith('DEDICATED')) {
            excluded += 1;
            excludeIds.add(c.id);
            continue;
        }
        const target = srcIdToTarget.get(c.package_id);
        if (!target) {
            unmapped += 1;
            continue;
        }
        mapped += 1;
        keepIds.add(c.id);
        dist[target.name] = (dist[target.name] || 0) + 1;
        if (c.pppoe_username && String(c.pppoe_username).trim()) {
            const key = String(c.pppoe_username).trim();
            if (!pppoeMap.has(key)) pppoeMap.set(key, []);
            pppoeMap.get(key).push(c.username);
        }
    }

    const dupPppoe = [...pppoeMap.entries()].filter(([, users]) => users.length > 1);

    const invKeep = await get(
        db,
        `SELECT COUNT(*) AS c FROM src.invoices WHERE customer_id IN (${[...keepIds].join(',') || 'NULL'})`
    );
    const payKeep = await get(
        db,
        `SELECT COUNT(*) AS c FROM src.payments pay
         JOIN src.invoices i ON i.id = pay.invoice_id
         WHERE i.customer_id IN (${[...keepIds].join(',') || 'NULL'})`
    );

    return {
        mapped,
        excluded,
        unmapped,
        keepIds,
        excludeIds,
        dist,
        dupPppoe,
        invoices: invKeep?.c || 0,
        payments: payKeep?.c || 0,
        totalCustomers: customers.length,
    };
}

async function assertNoLiveConflicts(db, keepIds, tenantId) {
    const usernames = await all(
        db,
        `SELECT username FROM src.customers WHERE id IN (${[...keepIds].join(',') || 'NULL'})`
    );
    for (const row of usernames) {
        const hit = await get(
            db,
            `SELECT id, tenant_id FROM main.customers WHERE username = ? AND tenant_id != ?`,
            [row.username, tenantId]
        );
        if (hit) throw new Error(`Username bentrok di tenant lain (id=${hit.tenant_id}): ${row.username}`);
    }
    const invs = await all(
        db,
        `SELECT invoice_number FROM src.invoices WHERE customer_id IN (${[...keepIds].join(',') || 'NULL'})`
    );
    for (const row of invs) {
        const hit = await get(
            db,
            `SELECT id, tenant_id FROM main.invoices WHERE invoice_number = ? AND tenant_id != ?`,
            [row.invoice_number, tenantId]
        );
        if (hit) throw new Error(`invoice_number bentrok di tenant lain: ${row.invoice_number}`);
    }
}

async function purgeTenantBusiness(db, tenantId) {
    await run(db, 'PRAGMA foreign_keys=OFF');

    // Hapus dulu tabel tanpa tenant_id yang bergantung pada data tenant
    if (await tableExists(db, 'main', 'odp_connections')) {
        await run(
            db,
            `DELETE FROM odp_connections
             WHERE from_odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)
                OR to_odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)`,
            [tenantId, tenantId]
        );
    }
    if (await tableExists(db, 'main', 'cable_routes')) {
        await run(
            db,
            `DELETE FROM cable_routes
             WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)
                OR odp_id IN (SELECT id FROM odps WHERE tenant_id = ?)`,
            [tenantId, tenantId]
        );
    }

    const junctionDeletes = [
        `DELETE FROM customer_router_map WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)`,
        `DELETE FROM collector_assignments WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)`,
        `DELETE FROM collector_assignments WHERE collector_id IN (SELECT id FROM collectors WHERE tenant_id = ?)`,
        `DELETE FROM collector_areas WHERE collector_id IN (SELECT id FROM collectors WHERE tenant_id = ?)`,
        `DELETE FROM collector_payments WHERE collector_id IN (SELECT id FROM collectors WHERE tenant_id = ?)`,
        `DELETE FROM installation_job_equipment WHERE job_id IN (SELECT id FROM installation_jobs WHERE tenant_id = ?)`,
        `DELETE FROM installation_job_status_history WHERE job_id IN (SELECT id FROM installation_jobs WHERE tenant_id = ?)`,
        `DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE tenant_id = ?)`,
    ];

    for (const sql of junctionDeletes) {
        const table = sql.match(/FROM (\w+)/)?.[1];
        if (!table || !(await tableExists(db, 'main', table))) continue;
        try {
            await run(db, sql, [tenantId]);
        } catch (_) {
            /* optional */
        }
    }

    const tables = await all(
        db,
        `SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    );
    for (const { name: table } of tables) {
        if (table === 'packages' || SKIP_IMPORT_TABLES.has(table)) continue;
        const cols = await getColumns(db, 'main', table);
        if (!cols.some((c) => c.name === 'tenant_id')) continue;
        await run(db, `DELETE FROM main.${table} WHERE tenant_id = ?`, [tenantId]);
    }

    await run(db, 'PRAGMA foreign_keys=ON');
}

async function importAreas(db, tenantId) {
    const maxLive = await get(db, `SELECT COALESCE(MAX(id), 0) AS m FROM main.areas`);
    const offset = maxLive?.m || 0;
    const srcAreas = await all(
        db,
        `SELECT * FROM src.areas WHERE UPPER(TRIM(nama_area)) != 'DEDICATED' ORDER BY id`
    );
    const areaIdMap = new Map();
    const destCols = await getColumns(db, 'main', 'areas');
    const destNames = new Set(destCols.map((c) => c.name));

    for (const row of srcAreas) {
        const newId = row.id + offset;
        areaIdMap.set(row.id, newId);
        const insertCols = [];
        const values = [];
        for (const col of destCols) {
            if (col.name === 'id') {
                insertCols.push('id');
                values.push(newId);
            } else if (col.name === 'tenant_id') {
                insertCols.push('tenant_id');
                values.push(tenantId);
            } else if (Object.prototype.hasOwnProperty.call(row, col.name)) {
                insertCols.push(col.name);
                values.push(row[col.name]);
            }
        }
        const placeholders = insertCols.map(() => '?').join(',');
        await run(
            db,
            `INSERT INTO main.areas (${insertCols.join(',')}) VALUES (${placeholders})`,
            values
        );
    }
    return { areaIdMap, offset, imported: srcAreas.length };
}

function pickInsertColumns(destCols, srcRow, options = {}) {
    const { tenantId, overrides = {}, skip = new Set() } = options;
    const insertCols = [];
    const values = [];
    const destNames = destCols.map((c) => c.name);

    for (const name of destNames) {
        if (skip.has(name)) continue;
        if (Object.prototype.hasOwnProperty.call(overrides, name)) {
            insertCols.push(name);
            values.push(overrides[name]);
            continue;
        }
        if (name === 'tenant_id' && tenantId != null) {
            insertCols.push(name);
            values.push(tenantId);
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(srcRow, name)) {
            insertCols.push(name);
            values.push(srcRow[name]);
        }
    }
    return { insertCols, values };
}

async function insertRow(db, table, destCols, srcRow, options) {
    const { insertCols, values } = pickInsertColumns(destCols, srcRow, options);
    if (!insertCols.length) return 0;
    const placeholders = insertCols.map(() => '?').join(',');
    const result = await run(
        db,
        `INSERT INTO main.${table} (${insertCols.join(',')}) VALUES (${placeholders})`,
        values
    );
    return result.changes;
}

async function importSimpleTable(db, table, tenantId, filterSql = null, filterParams = []) {
    if (!(await tableExists(db, 'src', table))) return { table, skipped: true, reason: 'not in backup' };
    if (!(await tableExists(db, 'main', table))) return { table, skipped: true, reason: 'not in live' };

    const destCols = await getColumns(db, 'main', table);
    const hasTenant = destCols.some((c) => c.name === 'tenant_id');
    const sql = filterSql
        ? `SELECT * FROM src.${table} WHERE ${filterSql}`
        : `SELECT * FROM src.${table}`;
    const rows = await all(db, sql, filterParams);
    let imported = 0;
    for (const row of rows) {
        imported += await insertRow(db, table, destCols, row, {
            tenantId: hasTenant ? tenantId : undefined,
        });
    }
    return { table, imported };
}

async function importCustomers(db, tenantId, keepIds, srcIdToTarget, areaIdMap) {
    const destCols = await getColumns(db, 'main', 'customers');
    const ids = [...keepIds];
    let imported = 0;
    const chunk = 200;
    for (let i = 0; i < ids.length; i += chunk) {
        const slice = ids.slice(i, i + chunk);
        const rows = await all(
            db,
            `SELECT * FROM src.customers WHERE id IN (${slice.join(',')})`
        );
        for (const row of rows) {
            const target = srcIdToTarget.get(row.package_id);
            if (!target) continue;
            let areaId = row.area_id;
            if (areaId != null) {
                areaId = areaIdMap.has(areaId) ? areaIdMap.get(areaId) : null;
            }
            imported += await insertRow(db, 'customers', destCols, row, {
                tenantId,
                overrides: {
                    package_id: target.id,
                    area_id: areaId,
                },
                skip: new Set(['created_by_technician_id']),
            });
        }
    }
    return { table: 'customers', imported };
}

async function importInvoices(db, tenantId, keepIds, srcIdToTarget) {
    const destCols = await getColumns(db, 'main', 'invoices');
    const ids = [...keepIds];
    let imported = 0;
    const chunk = 200;
    for (let i = 0; i < ids.length; i += chunk) {
        const slice = ids.slice(i, i + chunk);
        const rows = await all(
            db,
            `SELECT * FROM src.invoices WHERE customer_id IN (${slice.join(',')})`
        );
        for (const row of rows) {
            const target = srcIdToTarget.get(row.package_id);
            if (!target) {
                throw new Error(
                    `Invoice ${row.invoice_number} package_id=${row.package_id} tidak ter-map`
                );
            }
            imported += await insertRow(db, 'invoices', destCols, row, {
                tenantId,
                overrides: {
                    package_id: target.id,
                    package_name: target.name,
                },
            });
        }
    }
    return { table: 'invoices', imported };
}

async function importPayments(db, tenantId, keepIds) {
    const destCols = await getColumns(db, 'main', 'payments');
    const hasTenant = destCols.some((c) => c.name === 'tenant_id');
    const ids = [...keepIds];
    let imported = 0;
    const chunk = 200;
    for (let i = 0; i < ids.length; i += chunk) {
        const slice = ids.slice(i, i + chunk);
        const rows = await all(
            db,
            `SELECT pay.* FROM src.payments pay
             JOIN src.invoices i ON i.id = pay.invoice_id
             WHERE i.customer_id IN (${slice.join(',')})`
        );
        for (const row of rows) {
            imported += await insertRow(db, 'payments', destCols, row, {
                tenantId: hasTenant ? tenantId : undefined,
                skip: new Set(['remittance_net_applied']),
            });
        }
    }
    return { table: 'payments', imported };
}

async function importCollectorPayments(db, tenantId, keepIds) {
    if (!(await tableExists(db, 'main', 'collector_payments'))) {
        return { table: 'collector_payments', skipped: true };
    }
    if (!(await tableExists(db, 'src', 'collector_payments'))) {
        return { table: 'collector_payments', skipped: true };
    }
    const destCols = await getColumns(db, 'main', 'collector_payments');
    const hasTenant = destCols.some((c) => c.name === 'tenant_id');
    const invoiceRequired = destCols.some((c) => c.name === 'invoice_id' && c.notnull === 1);

    // Prefetch one invoice id per keep customer (sumber sering invoice_id NULL)
    const invoiceByCustomer = new Map();
    const idList = [...keepIds];
    const chunk = 200;
    for (let i = 0; i < idList.length; i += chunk) {
        const slice = idList.slice(i, i + chunk);
        const rows = await all(
            db,
            `SELECT customer_id, MAX(id) AS invoice_id
             FROM main.invoices
             WHERE tenant_id = ? AND customer_id IN (${slice.join(',')})
             GROUP BY customer_id`,
            [tenantId]
        );
        for (const r of rows) invoiceByCustomer.set(r.customer_id, r.invoice_id);
    }

    let imported = 0;
    let skippedNoInvoice = 0;
    for (let i = 0; i < idList.length; i += chunk) {
        const slice = idList.slice(i, i + chunk);
        const rows = await all(
            db,
            `SELECT * FROM src.collector_payments
             WHERE customer_id IN (${slice.join(',')})
                OR invoice_id IN (
                    SELECT id FROM src.invoices WHERE customer_id IN (${slice.join(',')})
                )`
        );
        for (const row of rows) {
            const customerId =
                row.customer_id ||
                (
                    await get(db, `SELECT customer_id FROM src.invoices WHERE id = ?`, [row.invoice_id])
                )?.customer_id;
            if (customerId && !keepIds.has(customerId)) continue;

            let invoiceId = row.invoice_id;
            if (invoiceId == null && customerId) {
                invoiceId = invoiceByCustomer.get(customerId) || null;
            }
            if (invoiceRequired && invoiceId == null) {
                skippedNoInvoice += 1;
                continue;
            }

            const overrides = {};
            if (invoiceId != null) overrides.invoice_id = invoiceId;
            if (row.payment_amount == null && row.amount != null) overrides.payment_amount = row.amount;
            if (row.commission_amount == null) overrides.commission_amount = 0;

            imported += await insertRow(db, 'collector_payments', destCols, row, {
                tenantId: hasTenant ? tenantId : undefined,
                overrides,
            });
        }
    }
    return { table: 'collector_payments', imported, skippedNoInvoice };
}

async function importCableRoutes(db, keepIds) {
    if (!(await tableExists(db, 'main', 'cable_routes'))) return { table: 'cable_routes', skipped: true };
    const destCols = await getColumns(db, 'main', 'cable_routes');
    const ids = [...keepIds];
    let imported = 0;
    const chunk = 200;
    for (let i = 0; i < ids.length; i += chunk) {
        const slice = ids.slice(i, i + chunk);
        const rows = await all(
            db,
            `SELECT * FROM src.cable_routes WHERE customer_id IN (${slice.join(',')})`
        );
        for (const row of rows) {
            imported += await insertRow(db, 'cable_routes', destCols, row, {});
        }
    }
    return { table: 'cable_routes', imported };
}

async function importInstallationJobs(db, tenantId, keepIds, srcIdToTarget) {
    if (!(await tableExists(db, 'src', 'installation_jobs'))) {
        return { table: 'installation_jobs', skipped: true };
    }
    if (!(await tableExists(db, 'main', 'installation_jobs'))) {
        return { table: 'installation_jobs', skipped: true };
    }
    const destCols = await getColumns(db, 'main', 'installation_jobs');
    const maxLive = await get(db, `SELECT COALESCE(MAX(id), 0) AS m FROM main.installation_jobs`);
    const offset = maxLive?.m || 0;
    const jobIdMap = new Map();
    const rows = await all(db, `SELECT * FROM src.installation_jobs ORDER BY id`);
    let imported = 0;
    for (const row of rows) {
        if (row.customer_id != null && !keepIds.has(row.customer_id)) continue;
        const newId = row.id + offset;
        jobIdMap.set(row.id, newId);
        const overrides = { id: newId };
        if (row.package_id != null && srcIdToTarget.has(row.package_id)) {
            overrides.package_id = srcIdToTarget.get(row.package_id).id;
        } else if (row.package_id != null && !srcIdToTarget.has(row.package_id)) {
            overrides.package_id = null;
        }
        imported += await insertRow(db, 'installation_jobs', destCols, row, {
            tenantId,
            overrides,
        });
    }
    return { table: 'installation_jobs', imported, jobIdMap, offset };
}

async function importTroubleReports(db, tenantId, keepIds) {
    if (!(await tableExists(db, 'src', 'trouble_reports'))) {
        return { table: 'trouble_reports', skipped: true };
    }
    if (!(await tableExists(db, 'main', 'trouble_reports'))) {
        return { table: 'trouble_reports', skipped: true };
    }
    const destCols = await getColumns(db, 'main', 'trouble_reports');
    const rows = await all(db, `SELECT * FROM src.trouble_reports`);
    let imported = 0;
    for (const row of rows) {
        if (row.customer_id != null && !keepIds.has(row.customer_id)) continue;
        imported += await insertRow(db, 'trouble_reports', destCols, row, { tenantId });
    }
    return { table: 'trouble_reports', imported };
}

async function importJobStatusHistory(db, tenantId, jobIdMap) {
    if (!(await tableExists(db, 'src', 'installation_job_status_history'))) {
        return { table: 'installation_job_status_history', skipped: true };
    }
    if (!(await tableExists(db, 'main', 'installation_job_status_history'))) {
        return { table: 'installation_job_status_history', skipped: true };
    }
    const destCols = await getColumns(db, 'main', 'installation_job_status_history');
    const hasTenant = destCols.some((c) => c.name === 'tenant_id');
    const maxLive = await get(
        db,
        `SELECT COALESCE(MAX(id), 0) AS m FROM main.installation_job_status_history`
    );
    const offset = maxLive?.m || 0;
    const rows = await all(db, `SELECT * FROM src.installation_job_status_history ORDER BY id`);
    let imported = 0;
    for (const row of rows) {
        if (!jobIdMap || !jobIdMap.has(row.job_id)) continue;
        const overrides = {
            id: row.id + offset,
            job_id: jobIdMap.get(row.job_id),
        };
        imported += await insertRow(db, 'installation_job_status_history', destCols, row, {
            tenantId: hasTenant ? tenantId : undefined,
            overrides,
        });
    }
    return { table: 'installation_job_status_history', imported };
}

async function verify(db, tenantId, expected) {
    const customers = await get(
        db,
        `SELECT COUNT(*) AS c FROM main.customers WHERE tenant_id = ?`,
        [tenantId]
    );
    const invoices = await get(
        db,
        `SELECT COUNT(*) AS c FROM main.invoices WHERE tenant_id = ?`,
        [tenantId]
    );
    const payments = await get(
        db,
        `SELECT COUNT(*) AS c FROM main.payments WHERE tenant_id = ?`,
        [tenantId]
    );
    const packages = await all(
        db,
        `SELECT id, name FROM main.packages WHERE tenant_id = ? ORDER BY id`,
        [tenantId]
    );
    const dist = await all(
        db,
        `SELECT p.name, COUNT(*) AS c
         FROM main.customers c
         JOIN main.packages p ON p.id = c.package_id
         WHERE c.tenant_id = ?
         GROUP BY p.name
         ORDER BY c DESC`,
        [tenantId]
    );
    const dedicatedLeft = await get(
        db,
        `SELECT COUNT(*) AS c
         FROM main.customers c
         JOIN main.packages p ON p.id = c.package_id
         WHERE c.tenant_id = ? AND UPPER(TRIM(p.name)) LIKE 'DEDICATED%'`,
        [tenantId]
    );
    const areasOther = await all(
        db,
        `SELECT id, tenant_id, nama_area FROM main.areas WHERE tenant_id != ? ORDER BY id`,
        [tenantId]
    );
    const sample = await all(
        db,
        `SELECT c.username, c.name, p.name AS package_name
         FROM main.customers c
         JOIN main.packages p ON p.id = c.package_id
         WHERE c.tenant_id = ?
         ORDER BY c.id
         LIMIT 10`,
        [tenantId]
    );

    const ok =
        customers.c === expected.mapped &&
        invoices.c === expected.invoices &&
        payments.c === expected.payments &&
        (dedicatedLeft?.c || 0) === 0 &&
        packages.some((p) => normName(p.name) === 'GRATIS');

    return {
        ok,
        customers: customers.c,
        invoices: invoices.c,
        payments: payments.c,
        packages,
        dist,
        dedicatedLeft: dedicatedLeft?.c || 0,
        areasOther,
        sample,
        expected,
    };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.dryRun && !opts.execute) {
        console.error('Wajib --dry-run atau --execute');
        process.exit(1);
    }
    if (opts.dryRun && opts.execute) {
        console.error('Pilih salah satu: --dry-run atau --execute');
        process.exit(1);
    }

    let sourceDb = opts.sourceDb;
    let extractDir = null;
    if (!sourceDb && opts.archive) {
        if (!fs.existsSync(opts.archive)) {
            throw new Error(`Archive tidak ditemukan: ${opts.archive}`);
        }
        extractDir = path.join('/tmp', `skynet-import-${Date.now()}`);
        console.log('Extract billing.db dari archive...');
        sourceDb = extractBillingDb(opts.archive, extractDir);
        console.log('Source DB:', sourceDb);
    }
    if (!sourceDb || !fs.existsSync(sourceDb)) {
        throw new Error('Source DB tidak ditemukan. Pakai --archive= atau --source-db=');
    }
    if (!isValidSqliteFile(sourceDb)) {
        throw new Error(`Bukan SQLite valid: ${sourceDb}`);
    }
    if (!fs.existsSync(LIVE_DB)) {
        throw new Error(`Live DB tidak ditemukan: ${LIVE_DB}`);
    }

    const db = new sqlite3.Database(LIVE_DB);
    const summary = [];

    try {
        await run(db, 'PRAGMA wal_checkpoint(TRUNCATE)');
        await run(db, `ATTACH DATABASE ? AS src`, [sourceDb.replace(/\\/g, '/')]);

        const tenant = await resolveTenant(db, opts.tenant);
        const tenantId = tenant.id;
        console.log(`\nTarget tenant: ${tenant.name} (${tenant.slug}, id=${tenantId})`);

        const { targetBySourceName } = await resolveTargetPackages(db, tenantId);
        console.log('\nPackage mapping (sumber → target id/name):');
        for (const [src, tgt] of Object.entries(targetBySourceName)) {
            console.log(`  ${src} → ${tgt.name} (id=${tgt.id})`);
        }

        const { srcIdToTarget, excludedSrcIds } = await buildSourcePackageMaps(
            db,
            targetBySourceName
        );
        const analysis = await analyze(db, srcIdToTarget, excludedSrcIds);

        console.log('\n=== Preflight ===');
        console.log(`Pelanggan total sumber : ${analysis.totalCustomers}`);
        console.log(`Mapped (akan impor)    : ${analysis.mapped}`);
        console.log(`Excluded DEDICATED     : ${analysis.excluded}`);
        console.log(`Unmapped               : ${analysis.unmapped}`);
        console.log(`Invoice (keep)         : ${analysis.invoices}`);
        console.log(`Payment (keep)         : ${analysis.payments}`);
        console.log('Distribusi target:');
        for (const [name, c] of Object.entries(analysis.dist).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${name}: ${c}`);
        }
        if (analysis.dupPppoe.length) {
            console.log('\nPeringatan duplikat PPPoE:');
            for (const [pppoe, users] of analysis.dupPppoe) {
                console.log(`  ${pppoe} → ${users.join(', ')}`);
            }
        }

        if (analysis.unmapped !== 0) {
            throw new Error(`Ada ${analysis.unmapped} pelanggan unmapped — abort`);
        }
        if (analysis.mapped !== 2056 || analysis.excluded !== 13) {
            console.warn(
                `Peringatan hitungan: expected mapped=2056 excluded=13, got mapped=${analysis.mapped} excluded=${analysis.excluded}`
            );
            if (analysis.mapped + analysis.excluded !== analysis.totalCustomers) {
                throw new Error('Hitungan pelanggan tidak konsisten');
            }
        }

        await assertNoLiveConflicts(db, analysis.keepIds, tenantId);
        console.log('Cek bentrok username/invoice_number (tenant lain): OK');

        if (opts.dryRun) {
            console.log('\n=== DRY-RUN selesai (tidak ada penulisan) ===');
            console.log('Lanjutkan dengan --execute jika angka di atas sudah benar.');
            return;
        }

        console.log('\nMembuat cadangan pra-restore...');
        const pre = await createBillingDbBackup(LIVE_DB, {
            prefix: 'pre_skynet_import',
            keepCount: 10,
            db,
        });
        console.log('Cadangan:', pre.filename);

        console.log('Purge data bisnis tenant (kecuali packages)...');
        await purgeTenantBusiness(db, tenantId);

        await run(db, 'PRAGMA foreign_keys=OFF');

        console.log('Import areas (remap ID, skip DEDICATED)...');
        const areaResult = await importAreas(db, tenantId);
        summary.push(`areas: ${areaResult.imported} (offset=${areaResult.offset})`);

        console.log('Import routers / odps / collectors / technicians / agents...');
        for (const table of ['routers', 'odps', 'collectors', 'technicians', 'agents']) {
            const r = await importSimpleTable(db, table, tenantId);
            if (r.imported != null) summary.push(`${table}: ${r.imported}`);
            else summary.push(`${table}: skip (${r.reason || ''})`);
        }

        console.log('Import customers...');
        const custR = await importCustomers(
            db,
            tenantId,
            analysis.keepIds,
            srcIdToTarget,
            areaResult.areaIdMap
        );
        summary.push(`customers: ${custR.imported}`);

        if (await tableExists(db, 'src', 'collector_areas')) {
            const destCols = await getColumns(db, 'main', 'collector_areas');
            const rows = await all(db, `SELECT * FROM src.collector_areas`);
            let n = 0;
            for (const row of rows) {
                // live may use area_name; src uses area
                const overrides = { tenant_id: tenantId };
                if (destCols.some((c) => c.name === 'area_name') && row.area != null) {
                    overrides.area_name = row.area;
                }
                n += await insertRow(db, 'collector_areas', destCols, row, {
                    tenantId,
                    overrides,
                });
            }
            summary.push(`collector_areas: ${n}`);
        }

        console.log('Import invoices / payments...');
        const invR = await importInvoices(db, tenantId, analysis.keepIds, srcIdToTarget);
        const payR = await importPayments(db, tenantId, analysis.keepIds);
        summary.push(`invoices: ${invR.imported}`);
        summary.push(`payments: ${payR.imported}`);

        const cpR = await importCollectorPayments(db, tenantId, analysis.keepIds);
        if (cpR.imported != null) summary.push(`collector_payments: ${cpR.imported}`);

        const crR = await importCableRoutes(db, analysis.keepIds);
        if (crR.imported != null) summary.push(`cable_routes: ${crR.imported}`);

        if (await tableExists(db, 'src', 'odp_connections') && (await tableExists(db, 'main', 'odp_connections'))) {
            const r = await importSimpleTable(db, 'odp_connections', tenantId);
            if (r.imported != null) summary.push(`odp_connections: ${r.imported}`);
        }

        for (const table of ['expenses', 'income']) {
            const r = await importSimpleTable(db, table, tenantId);
            if (r.imported != null) summary.push(`${table}: ${r.imported}`);
        }

        const ij = await importInstallationJobs(db, tenantId, analysis.keepIds, srcIdToTarget);
        if (ij.imported != null) {
            summary.push(`installation_jobs: ${ij.imported} (offset=${ij.offset || 0})`);
        }
        const tr = await importTroubleReports(db, tenantId, analysis.keepIds);
        if (tr.imported != null) summary.push(`trouble_reports: ${tr.imported}`);
        const ih = await importJobStatusHistory(db, tenantId, ij.jobIdMap || new Map());
        if (ih.imported != null) summary.push(`installation_job_status_history: ${ih.imported}`);

        console.log('Import absensi / gudang / karyawan / modul tambahan...');
        const curatedDone = new Set([
            ...IMPORT_TABLES,
            ...EXTRA_DATA_TABLES,
            'packages',
        ]);
        for (const table of EXTRA_DATA_TABLES) {
            try {
                const r = await importSimpleTable(db, table, tenantId);
                if (r.imported != null) summary.push(`${table}: ${r.imported}`);
                else if (r.skipped) summary.push(`${table}: skip (${r.reason || ''})`);
            } catch (err) {
                console.warn(`  WARN ${table}: ${err.message}`);
            }
        }

        // Ambil sisa tabel ber-tenant_id dari backup agar tidak ada modul yang terlewat
        const srcTables = await all(
            db,
            `SELECT name FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
        );
        for (const { name: table } of srcTables) {
            if (SKIP_IMPORT_TABLES.has(table) || curatedDone.has(table)) continue;
            if (!(await tableExists(db, 'main', table))) continue;
            const destCols = await getColumns(db, 'main', table);
            if (!destCols.some((c) => c.name === 'tenant_id')) continue;
            try {
                const r = await importSimpleTable(db, table, tenantId);
                if (r.imported) summary.push(`${table}: ${r.imported}`);
            } catch (err) {
                console.warn(`  WARN ${table}: ${err.message}`);
            }
        }

        await run(db, 'PRAGMA foreign_keys=ON');
        await run(db, 'PRAGMA wal_checkpoint(TRUNCATE)');

        let uploadStats = null;
        if (opts.copyUploads && opts.archive) {
            // Hanya foto karyawan — bukti transfer / field-completion / tiket tidak ikut
            console.log('\nMenyalin uploads karyawan (tanpa bukti transfer & foto instalasi/tiket)...');
            uploadStats = copyUploadsFromArchive(opts.archive, UPLOADS_DEST, {
                onlyEmployees: true,
            });
            console.log(`Uploads copied=${uploadStats.copied} skipped=${uploadStats.skipped}`);
        }

        const report = await verify(db, tenantId, {
            mapped: analysis.mapped,
            invoices: analysis.invoices,
            payments: analysis.payments,
        });

        console.log('\n=== Hasil impor ===');
        summary.forEach((line) => console.log(' ', line));
        console.log('\n=== Quality gate ===');
        console.log(`customers: ${report.customers} (expected ${report.expected.mapped})`);
        console.log(`invoices : ${report.invoices} (expected ${report.expected.invoices})`);
        console.log(`payments : ${report.payments} (expected ${report.expected.payments})`);
        console.log(`DEDICATED left: ${report.dedicatedLeft}`);
        console.log('Distribusi paket live:');
        report.dist.forEach((r) => console.log(`  ${r.name}: ${r.c}`));
        console.log('Areas tenant lain (harus utuh):');
        report.areasOther.forEach((a) => console.log(`  id=${a.id} tenant=${a.tenant_id} ${a.nama_area}`));
        console.log('Sample:');
        report.sample.forEach((s) => console.log(`  ${s.username} | ${s.name} | ${s.package_name}`));

        if (!report.ok) {
            console.error('\nQUALITY GATE GAGAL — restore dari cadangan:');
            console.error(`  cp "data/backup/${pre.filename}" data/billing.db`);
            process.exit(2);
        }

        console.log('\nQUALITY GATE LOLOS.');
        console.log('Restart PM2: pm2 restart billing-kalimasada');
    } finally {
        try {
            await run(db, 'DETACH DATABASE src');
        } catch (_) {
            /* ignore */
        }
        db.close();
        if (extractDir) {
            try {
                fs.rmSync(extractDir, { recursive: true, force: true });
            } catch (_) {
                /* ignore */
            }
        }
    }
}

main().catch((err) => {
    console.error('Import gagal:', err);
    process.exit(1);
});
