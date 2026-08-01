#!/usr/bin/env node
/**
 * Buat invoice bulan berjalan hanya untuk pelanggan aktif yang BELUM punya invoice bulan ini.
 * Berjalan per-tenant (isolasi multi-tenant).
 * Aman dijalankan setelah generate utama ada yang gagal (SQLITE_BUSY).
 *
 *   node scripts/generate-missing-monthly-invoices.js
 *   node scripts/generate-missing-monthly-invoices.js --confirm LENGKAPI-INVOICE
 */
process.env.TZ = process.env.TZ || 'Asia/Jakarta';
process.env.SKIP_INVOICE_SCHEDULER = '1';

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
    const { currentLocalMonthDateRange } = require('../utils/localDate');
    const db = new sqlite3.Database(dbPath);
    const monthRange = currentLocalMonthDateRange(new Date());
    const startStr = monthRange.startStr;
    const endStr = monthRange.endStr;

    const missing = await new Promise((res, rej) => {
        db.all(
            `SELECT c.id, c.username, c.name, c.tenant_id
             FROM customers c
             WHERE c.status = 'active' AND c.package_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM invoices i
               WHERE i.customer_id = c.id
                 AND i.tenant_id = c.tenant_id
                 AND DATE(i.created_at) >= DATE(?) AND DATE(i.created_at) <= DATE(?)
             )
             ORDER BY c.tenant_id, c.id`,
            [startStr, endStr],
            (err, rows) => (err ? rej(err) : res(rows || []))
        );
    });
    db.close();

    const totalInv = await new Promise((res, rej) => {
        billingManager.db.get('SELECT COUNT(*) AS n FROM invoices', [], (e, r) =>
            (e ? rej(e) : res(r.n)));
    });

    console.log('=== Lengkapi invoice bulan ini (per-tenant) ===\n');
    console.log(`Periode: ${startStr} s/d ${endStr}`);
    console.log(`Invoice di DB sekarang: ${totalInv}`);
    console.log(`Pelanggan aktif belum punya invoice bulan ini: ${missing.length}\n`);

    if (missing.length === 0) {
        console.log('Tidak ada yang perlu dilengkapi.');
        process.exit(0);
    }

    if (!confirmArg) {
        console.log('Contoh (max 10):');
        missing.slice(0, 10).forEach((r) =>
            console.log(`  - [tenant ${r.tenant_id}] ${r.name} (${r.username})`)
        );
        console.log(`\nJalankan:\n  node scripts/generate-missing-monthly-invoices.js --confirm ${CONFIRM}\n`);
        process.exit(0);
    }

    console.log('Menjalankan generate per-tenant (hanya yang belum punya tagihan akan dibuat)...\n');
    const run = await scheduler.runMonthlyInvoiceGenerationForAllTenants({
        skipNotifications: true,
        label: 'cli-auto-invoice'
    });
    if (run.skipped) {
        console.error('Generate di-skip:', run.reason);
        process.exit(1);
    }
    for (const r of run.results || []) {
        if (r.success) {
            console.log(`tenant #${r.tenant_id}:`, r.value || r);
        } else {
            console.error(`tenant #${r.tenant_id} FAILED:`, r.error);
        }
    }

    const missingAfter = await new Promise((res, rej) => {
        const db2 = new sqlite3.Database(dbPath);
        db2.get(
            `SELECT COUNT(*) AS n FROM customers c
             WHERE c.status = 'active' AND c.package_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM invoices i WHERE i.customer_id = c.id
                 AND i.tenant_id = c.tenant_id
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
