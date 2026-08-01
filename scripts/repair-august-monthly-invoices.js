#!/usr/bin/env node
/**
 * Perbaiki tagihan bulanan yang rusak karena:
 * - 2 proses Node menjalankan cron bersamaan (tagihan dobel)
 * - nomor invoice INV-YYYYMM-#### habis (max 10000) → banyak pelanggan gagal create
 *
 * Langkah:
 * 1) Hapus duplikat unpaid bulan berjalan (keep id terkecil per customer)
 * 2) Generate ulang untuk yang belum punya tagihan
 *
 *   node scripts/repair-august-monthly-invoices.js
 *   node scripts/repair-august-monthly-invoices.js --confirm PERBAIKI-TAGIHAN
 */
process.env.TZ = process.env.TZ || 'Asia/Jakarta';
process.env.SKIP_INVOICE_SCHEDULER = '1';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const CONFIRM = 'PERBAIKI-TAGIHAN';
const confirmArg = process.argv.includes('--confirm') &&
    (process.argv.includes(`--confirm=${CONFIRM}`) ||
        process.argv[process.argv.indexOf('--confirm') + 1] === CONFIRM);

const dbPath = path.join(__dirname, '../data/billing.db');

function openDb() {
    return new sqlite3.Database(dbPath);
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

(async () => {
    const { currentLocalMonthDateRange } = require('../utils/localDate');
    const monthRange = currentLocalMonthDateRange(new Date());
    const ym = monthRange.ymKey;

    const db = openDb();
    await run(db, 'PRAGMA busy_timeout = 30000');

    const dupCustomers = await get(db, `
        SELECT COUNT(*) AS c FROM (
            SELECT customer_id FROM invoices
            WHERE customer_id IS NOT NULL
              AND strftime('%Y-%m', created_at) = ?
              AND (invoice_type IS NULL OR invoice_type != 'voucher')
              AND status = 'unpaid'
            GROUP BY tenant_id, customer_id
            HAVING COUNT(*) > 1
        )
    `, [ym]);

    const dupInvoiceCount = await get(db, `
        SELECT COALESCE(SUM(cnt - 1), 0) AS c FROM (
            SELECT COUNT(*) AS cnt FROM invoices
            WHERE customer_id IS NOT NULL
              AND strftime('%Y-%m', created_at) = ?
              AND (invoice_type IS NULL OR invoice_type != 'voucher')
              AND status = 'unpaid'
            GROUP BY tenant_id, customer_id
            HAVING COUNT(*) > 1
        )
    `, [ym]);

    const missing = await get(db, `
        SELECT COUNT(*) AS c FROM customers c
        WHERE c.status = 'active' AND c.package_id IS NOT NULL
        AND NOT EXISTS (
            SELECT 1 FROM invoices i
            WHERE i.customer_id = c.id
              AND i.tenant_id = c.tenant_id
              AND strftime('%Y-%m', i.created_at) = ?
              AND (i.invoice_type IS NULL OR i.invoice_type != 'voucher')
        )
    `, [ym]);

    console.log('=== Perbaiki tagihan bulanan ===\n');
    console.log(`Periode: ${ym} (${monthRange.startStr} s/d ${monthRange.endStr})`);
    console.log(`Pelanggan dengan tagihan dobel (unpaid): ${dupCustomers.c}`);
    console.log(`Invoice ekstra yang akan dihapus: ${dupInvoiceCount.c}`);
    console.log(`Pelanggan aktif belum punya tagihan: ${missing.c}\n`);

    if (!confirmArg) {
        console.log(`Jalankan:\n  node scripts/repair-august-monthly-invoices.js --confirm ${CONFIRM}\n`);
        db.close();
        process.exit(0);
    }

    // 1) Hapus duplikat — keep MIN(id)
    const del = await run(db, `
        DELETE FROM invoices
        WHERE id IN (
            SELECT i.id
            FROM invoices i
            INNER JOIN (
                SELECT tenant_id, customer_id, MIN(id) AS keep_id
                FROM invoices
                WHERE customer_id IS NOT NULL
                  AND strftime('%Y-%m', created_at) = ?
                  AND (invoice_type IS NULL OR invoice_type != 'voucher')
                  AND status = 'unpaid'
                GROUP BY tenant_id, customer_id
                HAVING COUNT(*) > 1
            ) d ON i.tenant_id = d.tenant_id AND i.customer_id = d.customer_id
            WHERE i.id != d.keep_id
              AND strftime('%Y-%m', i.created_at) = ?
              AND (i.invoice_type IS NULL OR i.invoice_type != 'voucher')
              AND i.status = 'unpaid'
        )
    `, [ym, ym]);
    console.log(`Duplikat dihapus: ${del.changes} invoice`);
    db.close();

    // 2) Generate missing
    const scheduler = require('../config/scheduler');
    console.log('\nGenerate tagihan yang hilang...\n');
    const runGen = await scheduler.runMonthlyInvoiceGenerationForAllTenants({
        skipNotifications: true,
        label: 'repair-auto-invoice'
    });
    if (runGen.skipped) {
        console.error('Generate di-skip:', runGen.reason);
        process.exit(1);
    }

    let created = 0;
    let failed = 0;
    for (const r of runGen.results || []) {
        if (r.success) {
            const s = r.value || {};
            created += Number(s.created || 0);
            failed += Number(s.failed || 0);
            console.log(`tenant #${r.tenant_id}: created=${s.created || 0} skipped=${s.skipped || 0} failed=${s.failed || 0}`);
        } else {
            failed += 1;
            console.error(`tenant #${r.tenant_id} FAILED:`, r.error);
        }
    }

    const db2 = openDb();
    const missingAfter = await get(db2, `
        SELECT COUNT(*) AS c FROM customers c
        WHERE c.status = 'active' AND c.package_id IS NOT NULL
        AND NOT EXISTS (
            SELECT 1 FROM invoices i
            WHERE i.customer_id = c.id
              AND i.tenant_id = c.tenant_id
              AND strftime('%Y-%m', i.created_at) = ?
              AND (i.invoice_type IS NULL OR i.invoice_type != 'voucher')
        )
    `, [ym]);
    const dupAfter = await get(db2, `
        SELECT COUNT(*) AS c FROM (
            SELECT customer_id FROM invoices
            WHERE customer_id IS NOT NULL
              AND strftime('%Y-%m', created_at) = ?
              AND (invoice_type IS NULL OR invoice_type != 'voucher')
            GROUP BY tenant_id, customer_id
            HAVING COUNT(*) > 1
        )
    `, [ym]);
    db2.close();

    console.log(`\nSelesai. created_total≈${created}, failed_total≈${failed}`);
    console.log(`Sisa belum punya tagihan: ${missingAfter.c}`);
    console.log(`Sisa pelanggan dobel: ${dupAfter.c}`);
    process.exit(missingAfter.c > 0 || dupAfter.c > 0 ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
