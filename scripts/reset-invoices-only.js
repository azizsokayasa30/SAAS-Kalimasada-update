#!/usr/bin/env node
/**
 * Hapus SEMUA tagihan (invoice) + pembayaran terkait.
 * Pelanggan, paket, router, area, kolektor TIDAK dihapus.
 *
 * Usage:
 *   node scripts/reset-invoices-only.js
 *   node scripts/reset-invoices-only.js --confirm RESET-INVOICES-ONLY
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const CONFIRM_PHRASE = 'RESET-INVOICES-ONLY';
const confirmArg = process.argv.find((a) => a === `--confirm=${CONFIRM_PHRASE}`)
    || (process.argv.includes('--confirm') && process.argv[process.argv.indexOf('--confirm') + 1] === CONFIRM_PHRASE
        ? CONFIRM_PHRASE
        : null);

const dbPath = path.join(__dirname, '../data/billing.db');
const backupDir = path.join(__dirname, '../data/backup');

/** Urutan hapus: anak dulu, invoices terakhir. */
const DELETE_STEPS = [
    { label: 'collector_payments', sql: 'DELETE FROM collector_payments' },
    { label: 'payment_gateway_transactions', sql: 'DELETE FROM payment_gateway_transactions' },
    { label: 'agent_payments', sql: 'DELETE FROM agent_payments' },
    { label: 'agent_monthly_payments', sql: 'DELETE FROM agent_monthly_payments' },
    { label: 'technician_activities (invoice)', sql: 'DELETE FROM technician_activities WHERE invoice_id IS NOT NULL' },
    { label: 'payments', sql: 'DELETE FROM payments' },
    { label: 'invoices', sql: 'DELETE FROM invoices' },
    { label: 'invoices_new', sql: 'DELETE FROM invoices_new' },
    { label: 'monthly_summary', sql: 'DELETE FROM monthly_summary' }
];

const COUNT_TABLES = ['invoices', 'payments', 'collector_payments', 'payment_gateway_transactions'];

function openDb() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => (err ? reject(err) : resolve(db)));
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

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function backupDatabase() {
    if (!fs.existsSync(dbPath)) {
        throw new Error(`Database tidak ditemukan: ${dbPath}`);
    }
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(backupDir, `billing_backup_sebelum_hapus_invoice_${stamp}.db`);
    fs.copyFileSync(dbPath, dest);
    return dest;
}

async function snapshot(db) {
    const snap = {};
    for (const table of COUNT_TABLES) {
        try {
            const row = await get(db, `SELECT COUNT(*) AS n FROM ${table}`);
            snap[table] = row.n;
        } catch (_) {
            snap[table] = 0;
        }
    }
    try {
        const cust = await get(db, 'SELECT COUNT(*) AS n FROM customers');
        snap.customers_preserved = cust.n;
    } catch (_) {
        snap.customers_preserved = '?';
    }
    try {
        const may31 = await get(
            db,
            `SELECT COUNT(*) AS n FROM invoices WHERE date(due_date) = date('2026-05-31')`
        );
        snap.invoices_due_2026_05_31 = may31.n;
    } catch (_) {
        snap.invoices_due_2026_05_31 = 0;
    }
    return snap;
}

(async () => {
    console.log('=== Hapus semua invoice (pelanggan tetap) ===\n');

    if (!confirmArg) {
        console.log('Mode dry-run. Untuk eksekusi:\n');
        console.log(`  node scripts/reset-invoices-only.js --confirm ${CONFIRM_PHRASE}\n`);
    }

    const db = await openDb();
    try {
        const before = await snapshot(db);
        console.log('Sebelum:');
        Object.entries(before).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

        if (!confirmArg) {
            console.log('\nSetelah hapus invoice:');
            console.log('  1. Update jatuh tempo: menu Isolir & Jatuh Tempo → bulk per wilayah');
            console.log('  2. Auto Invoice → Generate Invoice Bulan Ini (satu klik, tunggu selesai)');
            process.exit(0);
        }

        const backupPath = backupDatabase();
        console.log(`\nBackup: ${backupPath}\n`);

        await run(db, 'PRAGMA foreign_keys = OFF');
        await run(db, 'BEGIN IMMEDIATE');

        for (const step of DELETE_STEPS) {
            try {
                const n = await run(db, step.sql);
                console.log(`  ${step.label}: ${n} baris`);
            } catch (err) {
                if (String(err.message || '').includes('no such table')) {
                    console.log(`  ${step.label}: (tabel tidak ada, dilewati)`);
                } else {
                    throw err;
                }
            }
        }

        try {
            await run(
                db,
                `DELETE FROM sqlite_sequence WHERE name IN ('invoices','payments','collector_payments','payment_gateway_transactions')`
            );
        } catch (_) { /* opsional */ }

        await run(db, 'COMMIT');
        await run(db, 'PRAGMA foreign_keys = ON');

        const after = await snapshot(db);
        console.log('\nSesudah:');
        Object.entries(after).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
        console.log('\nSelesai. Pelanggan tidak dihapus.');
    } catch (err) {
        try {
            await run(db, 'ROLLBACK');
        } catch (_) { /* ignore */ }
        console.error('\nGAGAL (rollback):', err.message);
        process.exit(1);
    } finally {
        db.close();
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
