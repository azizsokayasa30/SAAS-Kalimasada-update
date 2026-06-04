#!/usr/bin/env node
/**
 * Buat invoice bulan berjalan hanya untuk pelanggan aktif yang BELUM punya invoice bulan ini.
 * Aman dijalankan setelah generate utama ada yang gagal (SQLITE_BUSY).
 *
 *   node scripts/generate-missing-monthly-invoices.js
 *   node scripts/generate-missing-monthly-invoices.js --confirm LENGKAPI-INVOICE
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const CONFIRM = 'LENGKAPI-INVOICE';
const confirmArg = process.argv.includes('--confirm') &&
    (process.argv.includes(`--confirm=${CONFIRM}`) ||
        process.argv[process.argv.indexOf('--confirm') + 1] === CONFIRM);

const dbPath = path.join(__dirname, '../data/billing.db');

(async () => {
    const billingManager = require('../config/billing');
    const scheduler = require('../config/scheduler');

    const db = new sqlite3.Database(dbPath);
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const startStr = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const endStr = new Date(y, m + 1, 0).toISOString().split('T')[0];

    const missing = await new Promise((res, rej) => {
        db.all(
            `SELECT c.id, c.username, c.name
             FROM customers c
             WHERE c.status = 'active' AND c.package_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM invoices i
               WHERE i.customer_id = c.id
                 AND DATE(i.created_at) >= DATE(?) AND DATE(i.created_at) <= DATE(?)
             )
             ORDER BY c.id`,
            [startStr, endStr],
            (err, rows) => (err ? rej(err) : res(rows || []))
        );
    });
    db.close();

    const totalInv = await new Promise((res, rej) => {
        billingManager.db.get('SELECT COUNT(*) AS n FROM invoices', [], (e, r) =>
            (e ? rej(e) : res(r.n)));
    });

    console.log('=== Lengkapi invoice bulan ini ===\n');
    console.log(`Periode: ${startStr} s/d ${endStr}`);
    console.log(`Invoice di DB sekarang: ${totalInv}`);
    console.log(`Pelanggan aktif belum punya invoice bulan ini: ${missing.length}\n`);

    if (missing.length === 0) {
        console.log('Tidak ada yang perlu dilengkapi.');
        process.exit(0);
    }

    if (!confirmArg) {
        console.log('Contoh (max 10):');
        missing.slice(0, 10).forEach((r) => console.log(`  - ${r.name} (${r.username})`));
        console.log(`\nJalankan:\n  node scripts/generate-missing-monthly-invoices.js --confirm ${CONFIRM}\n`);
        process.exit(0);
    }

    console.log('Menjalankan generate (hanya yang belum punya tagihan akan dibuat)...\n');
    const result = await scheduler.triggerMonthlyInvoices({ skipNotifications: true });
    const stats = result.stats || {};
    console.log('Hasil:', stats);

    const missingAfter = await new Promise((res, rej) => {
        const db2 = new sqlite3.Database(dbPath);
        db2.get(
            `SELECT COUNT(*) AS n FROM customers c
             WHERE c.status = 'active' AND c.package_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM invoices i WHERE i.customer_id = c.id
                 AND DATE(i.created_at) >= DATE(?) AND DATE(i.created_at) <= DATE(?)
             )`,
            [startStr, endStr],
            (err, row) => {
                db2.close();
                if (err) rej(err);
                else res(row.n);
            }
        );
    });
    console.log(`\nSisa belum punya invoice: ${missingAfter}`);
    process.exit(missingAfter > 0 ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
