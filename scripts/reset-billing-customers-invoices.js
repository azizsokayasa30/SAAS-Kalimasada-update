#!/usr/bin/env node
/**
 * Reset data pelanggan + tagihan (mulai dari nol).
 * TIDAK menghapus: paket, router, area, kolektor, ODP, member, pengaturan app.
 *
 * Usage:
 *   node scripts/reset-billing-customers-invoices.js
 *   node scripts/reset-billing-customers-invoices.js --confirm RESET-PELANGGAN-INVOICE
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const CONFIRM_PHRASE = 'RESET-PELANGGAN-INVOICE';
const confirmArg = process.argv.find((a) => a === `--confirm=${CONFIRM_PHRASE}`)
    || (process.argv.includes('--confirm') && process.argv[process.argv.indexOf('--confirm') + 1] === CONFIRM_PHRASE
        ? CONFIRM_PHRASE
        : null);

const dbPath = path.join(__dirname, '../data/billing.db');
const backupDir = path.join(__dirname, '../data/backup');

const TABLES_IN_ORDER = [
    { label: 'payment_gateway_transactions', sql: 'DELETE FROM payment_gateway_transactions' },
    { label: 'payments', sql: 'DELETE FROM payments' },
    { label: 'invoices', sql: 'DELETE FROM invoices' },
    { label: 'invoices_new', sql: 'DELETE FROM invoices_new' },
    { label: 'collector_payments', sql: 'DELETE FROM collector_payments' },
    { label: 'collector_assignments (pelanggan)', sql: 'DELETE FROM collector_assignments WHERE customer_id IS NOT NULL' },
    { label: 'customer_router_map', sql: 'DELETE FROM customer_router_map' },
    { label: 'cable_routes', sql: 'DELETE FROM cable_routes' },
    { label: 'trouble_reports', sql: 'DELETE FROM trouble_reports' },
    { label: 'customer_portal_package_requests', sql: 'DELETE FROM customer_portal_package_requests' },
    { label: 'import_customer_operations', sql: 'DELETE FROM import_customer_operations' },
    { label: 'monthly_summary', sql: 'DELETE FROM monthly_summary' },
    { label: 'customers', sql: 'DELETE FROM customers' }
];

const UNLINK_SQL = [
    { label: 'onu_devices.customer_id', sql: 'UPDATE onu_devices SET customer_id = NULL WHERE customer_id IS NOT NULL' },
    { label: 'installation_jobs.customer_id', sql: 'UPDATE installation_jobs SET customer_id = NULL WHERE customer_id IS NOT NULL' }
];

function openDb() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) reject(err);
            else resolve(db);
        });
    });
}

function run(db, sql) {
    return new Promise((resolve, reject) => {
        db.run(sql, function (err) {
            if (err) reject(err);
            else resolve(this.changes || 0);
        });
    });
}

function get(db, sql) {
    return new Promise((resolve, reject) => {
        db.get(sql, [], (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function backupDatabase() {
    if (!fs.existsSync(dbPath)) {
        throw new Error(`Database tidak ditemukan: ${dbPath}`);
    }
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(backupDir, `billing_backup_sebelum_reset_${stamp}.db`);
    fs.copyFileSync(dbPath, dest);
    return dest;
}

async function countSnapshot(db) {
    const snap = {};
    for (const { label } of TABLES_IN_ORDER) {
        const table = label.split(' ')[0];
        try {
            const row = await get(db, `SELECT COUNT(*) AS n FROM ${table}`);
            snap[label] = row.n;
        } catch (_) {
            snap[label] = '(tabel tidak ada)';
        }
    }
    return snap;
}

(async () => {
    console.log('=== Reset pelanggan & invoice (billing.db) ===\n');
    console.log('Yang TETAP: paket, router, area, kolektor, ODP, member, goods_invoices, pengaturan.\n');

    if (!confirmArg) {
        console.log('Mode dry-run (belum menghapus apa pun).\n');
        console.log(`Untuk eksekusi, jalankan:\n  node scripts/reset-billing-customers-invoices.js --confirm ${CONFIRM_PHRASE}\n`);
    }

    const db = await openDb();
    try {
        const before = await countSnapshot(db);
        console.log('Jumlah baris saat ini:');
        Object.entries(before).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

        if (!confirmArg) {
            console.log('\nSetelah reset, impor pelanggan dari Excel (Restore) lalu buat tagihan / catat pembayaran manual.');
            process.exit(0);
        }

        const backupPath = backupDatabase();
        console.log(`\nBackup disimpan: ${backupPath}\n`);

        await run(db, 'PRAGMA foreign_keys = OFF');
        await run(db, 'BEGIN IMMEDIATE');

        const results = [];
        for (const step of UNLINK_SQL) {
            const n = await run(db, step.sql);
            results.push({ step: step.label, deleted: n });
            console.log(`  ${step.label}: ${n} baris diubah`);
        }
        for (const step of TABLES_IN_ORDER) {
            const n = await run(db, step.sql);
            results.push({ step: step.label, deleted: n });
            console.log(`  ${step.label}: ${n} baris dihapus`);
        }

        try {
            await run(db, "DELETE FROM sqlite_sequence WHERE name IN ('customers','invoices','payments')");
        } catch (_) {
            /* opsional */
        }

        await run(db, 'COMMIT');
        await run(db, 'PRAGMA foreign_keys = ON');

        const after = await countSnapshot(db);
        console.log('\nSelesai. Jumlah setelah reset:');
        Object.entries(after).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
        console.log('\nLangkah berikutnya:');
        console.log('  1. Restart aplikasi (pm2 restart / service restart)');
        console.log('  2. Restore pelanggan dari Excel (sekali saja, PPPoE Username konsisten)');
        console.log('  3. Auto Invoice atau buat tagihan bulan berjalan');
        console.log('  4. Input pembayaran manual sesuai catatan Anda');
    } catch (err) {
        try {
            await run(db, 'ROLLBACK');
        } catch (_) {
            /* ignore */
        }
        console.error('\nGAGAL — tidak ada perubahan (rollback):', err.message);
        process.exit(1);
    } finally {
        db.close();
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
