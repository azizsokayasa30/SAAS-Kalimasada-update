#!/usr/bin/env node
'use strict';

/**
 * Restore isi file backup SQLite (single-tenant / tanpa tenants) ke satu tenant SaaS.
 *
 * Usage:
 *   node scripts/restore-backup-to-tenant.js <path-to-backup.db> [tenant-slug]
 *
 * Contoh:
 *   node scripts/restore-backup-to-tenant.js "C:/Users/.../billing_backup.db" tenant1
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { createBillingDbBackup } = require('../utils/billingDbBackup');

const LIVE_DB = path.join(__dirname, '../data/billing.db');

const SKIP_TABLES = new Set([
    'tenants',
    'subscription_plans',
    'super_admins',
    'platform_audit_logs',
    'tenant_provisioning_logs',
    'sqlite_sequence',
    'migrations',
]);

/** Urutan impor: parent → child (menghindari FK error). */
const IMPORT_ORDER = [
    'areas',
    'finance_categories',
    'attendance_branches',
    'attendance_settings',
    'attendance_shifts',
    'packages',
    'member_packages',
    'routers',
    'nas',
    'olts',
    'olts_legacy_1781714650224',
    'pon_ports',
    'olt_api_profiles',
    'genieacs_servers',
    'hotspot_servers',
    'hotspot_profiles',
    'pppoe_profiles',
    'odps',
    'warehouse_items',
    'warehouse_inbound_batches',
    'warehouse_units',
    'collectors',
    'technicians',
    'employees',
    'agents',
    'members',
    'customers',
    'collector_areas',
    'collector_assignments',
    'customer_router_map',
    'collector_payments',
    'collector_remittance_receipts',
    'collector_remittances',
    'invoices',
    'invoices_new',
    'payments',
    'payment_gateway_transactions',
    'expenses',
    'income',
    'goods_invoices',
    'goods_invoice_items',
    'voucher_revenue',
    'agent_balances',
    'agent_balance_requests',
    'agent_payments',
    'agent_transactions',
    'agent_voucher_sales',
    'agent_monthly_payments',
    'installation_jobs',
    'installation_job_status_history',
    'installation_job_equipment',
    'trouble_reports',
    'technician_activities',
    'technician_field_notifications',
    'collector_field_notifications',
    'employee_attendance',
    'employee_leave_requests',
    'employee_payroll',
    'network_segments',
    'odp_connections',
    'cable_routes',
    'cable_maintenance_logs',
    'onus',
    'onu_devices',
    'onu_histories',
    'olt_sync_jobs',
    'olt_sync_runs',
    'import_customer_operations',
    'customer_portal_broadcasts',
    'customer_portal_package_requests',
    'admin_notifications',
    'agent_notifications',
    'alerts',
    'monthly_summary',
    'activity_logs',
    'app_settings',
    'license',
    'radcheck',
    'radreply',
    'radgroupcheck',
    'radgroupreply',
    'radusergroup',
    'radacct',
    'radpostauth',
];

/** Tabel tanpa tenant_id — kosongkan seluruhnya sebelum impor (data bisnis tunggal dari backup). */
const FULL_REPLACE_NO_TENANT = new Set([
    'customer_router_map',
    'network_segments',
    'odp_connections',
    'cable_routes',
    'cable_maintenance_logs',
    'onus',
    'onu_devices',
    'onu_histories',
    'olt_sync_jobs',
    'olt_sync_runs',
    'installation_job_equipment',
    'installation_job_status_history',
    'goods_invoice_items',
    'collector_assignments',
    'collector_areas',
    'radcheck',
    'radreply',
    'radgroupcheck',
    'radgroupreply',
    'radusergroup',
    'radacct',
    'radpostauth',
]);

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

async function purgeTenantData(db, tenantId) {
    const tables = await all(
        db,
        `SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    );

    await run(db, 'PRAGMA foreign_keys=OFF');

    const junctionDeletes = [
        `DELETE FROM customer_router_map WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)`,
        `DELETE FROM collector_assignments WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)`,
        `DELETE FROM collector_assignments WHERE collector_id IN (SELECT id FROM collectors WHERE tenant_id = ?)`,
        `DELETE FROM collector_areas WHERE collector_id IN (SELECT id FROM collectors WHERE tenant_id = ?)`,
        `DELETE FROM collector_payments WHERE collector_id IN (SELECT id FROM collectors WHERE tenant_id = ?)`,
        `DELETE FROM collector_payments WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)`,
        `DELETE FROM installation_job_equipment WHERE job_id IN (SELECT id FROM installation_jobs WHERE tenant_id = ?)`,
        `DELETE FROM installation_job_status_history WHERE job_id IN (SELECT id FROM installation_jobs WHERE tenant_id = ?)`,
        `DELETE FROM goods_invoice_items WHERE goods_invoice_id IN (SELECT id FROM goods_invoices WHERE tenant_id = ?)`,
    ];

    for (const sql of junctionDeletes) {
        const table = sql.match(/FROM (\w+)/)?.[1];
        if (!table || !(await tableExists(db, 'main', table))) continue;
        try {
            await run(db, sql, [tenantId]);
        } catch (_) {
            /* tabel opsional */
        }
    }

    for (const { name: table } of tables) {
        if (SKIP_TABLES.has(table)) continue;
        const cols = await getColumns(db, 'main', table);
        if (!cols.some((c) => c.name === 'tenant_id')) continue;
        await run(db, `DELETE FROM main.${table} WHERE tenant_id = ?`, [tenantId]);
    }

    // Data operasional yang salah tenant (mis. tenant_id=1 padahal milik tenant1 bisnis)
    for (const table of ['installation_jobs', 'trouble_reports', 'activity_logs']) {
        if (!(await tableExists(db, 'main', table))) continue;
        const cols = await getColumns(db, 'main', table);
        if (!cols.some((c) => c.name === 'tenant_id')) continue;
        const row = await get(db, `SELECT COUNT(*) AS c FROM main.${table} WHERE tenant_id = 1`);
        const row2 = await get(db, `SELECT COUNT(*) AS c FROM main.${table} WHERE tenant_id = ?`, [tenantId]);
        if ((row?.c || 0) > 0 && (row2?.c || 0) === 0) {
            await run(db, `UPDATE main.${table} SET tenant_id = ? WHERE tenant_id = 1`, [tenantId]);
        }
    }

    for (const table of FULL_REPLACE_NO_TENANT) {
        if (!(await tableExists(db, 'main', table))) continue;
        await run(db, `DELETE FROM main.${table}`);
    }

    // app_settings global (tanpa tenant_id di skema lama)
    if (await tableExists(db, 'main', 'app_settings')) {
        const cols = await getColumns(db, 'main', 'app_settings');
        if (!cols.some((c) => c.name === 'tenant_id')) {
            await run(db, 'DELETE FROM main.app_settings');
        }
    }

    await run(db, 'PRAGMA foreign_keys=ON');
}

async function importTable(db, table, tenantId) {
    if (!(await tableExists(db, 'src', table))) return { table, skipped: true, reason: 'not in backup' };
    if (!(await tableExists(db, 'main', table))) return { table, skipped: true, reason: 'not in live db' };

    const srcCols = await getColumns(db, 'src', table);
    const destCols = await getColumns(db, 'main', table);
    const destNames = new Set(destCols.map((c) => c.name));
    const srcNames = new Set(srcCols.map((c) => c.name));

    let insertCols = destCols
        .map((c) => c.name)
        .filter((name) => name !== 'rowid' && srcNames.has(name));

    const destHasTenant = destNames.has('tenant_id');
    const srcHasTenant = srcNames.has('tenant_id');

    if (destHasTenant && !srcHasTenant && !insertCols.includes('tenant_id')) {
        insertCols.push('tenant_id');
    }

    if (insertCols.length === 0) {
        return { table, skipped: true, reason: 'no common columns' };
    }

    const selectExprs = insertCols.map((col) => {
        if (col === 'tenant_id' && destHasTenant && !srcHasTenant) {
            return `${tenantId} AS tenant_id`;
        }
        return `src.${table}.${col}`;
    });

    const sql = `INSERT OR REPLACE INTO main.${table} (${insertCols.join(', ')})
                 SELECT ${selectExprs.join(', ')} FROM src.${table}`;

    const result = await run(db, sql);
    return { table, imported: result.changes };
}

async function main() {
    const backupPath = path.resolve(process.argv[2] || '');
    const tenantSlug = process.argv[3] || 'tenant1';

    if (!backupPath || !fs.existsSync(backupPath)) {
        console.error('File backup tidak ditemukan:', backupPath);
        process.exit(1);
    }
    if (!isValidSqliteFile(backupPath)) {
        console.error('File bukan database SQLite valid:', backupPath);
        process.exit(1);
    }
    if (!fs.existsSync(LIVE_DB)) {
        console.error('Database live tidak ditemukan:', LIVE_DB);
        process.exit(1);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupCopy = path.join(__dirname, '../data/backup', `import_source_${stamp}.db`);
    fs.mkdirSync(path.dirname(backupCopy), { recursive: true });
    fs.copyFileSync(backupPath, backupCopy);
    console.log('Salinan backup:', backupCopy);

    const db = new sqlite3.Database(LIVE_DB);

    try {
        await run(db, 'PRAGMA wal_checkpoint(TRUNCATE)');
        const pre = await createBillingDbBackup(LIVE_DB, { prefix: 'pre_tenant_restore', db });
        console.log('Cadangan pra-restore:', pre.filename);

        await run(db, `ATTACH DATABASE ? AS src`, [backupPath.replace(/\\/g, '/')]);

        const tenant = await get(db, `SELECT id, slug, name FROM main.tenants WHERE slug = ?`, [tenantSlug]);
        if (!tenant) {
            throw new Error(`Tenant "${tenantSlug}" tidak ditemukan`);
        }
        const tenantId = tenant.id;
        console.log(`Target tenant: ${tenant.name} (${tenant.slug}, id=${tenantId})`);

        const srcCustomers = await get(db, 'SELECT COUNT(*) AS c FROM src.customers');
        console.log(`Backup berisi ${srcCustomers.c} pelanggan`);

        console.log('Menghapus data tenant lama...');
        await purgeTenantData(db, tenantId);

        const srcTables = await all(
            db,
            `SELECT name FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
        );
        const srcSet = new Set(srcTables.map((r) => r.name));
        const ordered = [
            ...IMPORT_ORDER.filter((t) => srcSet.has(t)),
            ...[...srcSet].filter((t) => !SKIP_TABLES.has(t) && !IMPORT_ORDER.includes(t)).sort(),
        ];

        console.log('Mengimpor data dari backup...');
        const summary = [];
        await run(db, 'PRAGMA foreign_keys=OFF');
        for (const table of ordered) {
            if (SKIP_TABLES.has(table)) continue;
            try {
                const result = await importTable(db, table, tenantId);
                if (result.imported) summary.push(`${table}: ${result.imported}`);
                else if (result.skipped && result.reason !== 'not in backup') {
                    console.log(`  skip ${table} (${result.reason})`);
                }
            } catch (err) {
                console.warn(`  WARN ${table}: ${err.message}`);
            }
        }
        await run(db, 'PRAGMA foreign_keys=ON');
        await run(db, 'PRAGMA wal_checkpoint(TRUNCATE)');

        const liveCustomers = await get(
            db,
            'SELECT COUNT(*) AS c FROM main.customers WHERE tenant_id = ?',
            [tenantId]
        );
        const liveInvoices = await get(
            db,
            'SELECT COUNT(*) AS c FROM main.invoices WHERE tenant_id = ?',
            [tenantId]
        );
        const liveJobs = await get(
            db,
            'SELECT COUNT(*) AS c FROM main.installation_jobs WHERE tenant_id = ?',
            [tenantId]
        );

        console.log('\n=== Restore selesai ===');
        console.log(`Pelanggan tenant ${tenantSlug}: ${liveCustomers.c}`);
        console.log(`Invoice tenant ${tenantSlug}: ${liveInvoices.c}`);
        console.log(`Installation jobs tenant ${tenantSlug}: ${liveJobs.c}`);
        console.log('Tabel diimpor:', summary.length);
        summary.slice(0, 25).forEach((line) => console.log(' ', line));
        if (summary.length > 25) console.log(`  ... +${summary.length - 25} tabel lainnya`);
        console.log('\nRestart server Node.js agar cache settings/tenant ter-refresh.');
    } finally {
        try {
            await run(db, 'DETACH DATABASE src');
        } catch (_) {
            /* ignore */
        }
        db.close();
    }
}

main().catch((err) => {
    console.error('Restore gagal:', err);
    process.exit(1);
});
