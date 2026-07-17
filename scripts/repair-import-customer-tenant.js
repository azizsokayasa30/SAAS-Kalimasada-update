#!/usr/bin/env node
'use strict';

/**
 * Perbaiki pelanggan hasil import yang salah tenant_id (biasanya tertulis ke tenant 1).
 *
 * Contoh:
 *   node scripts/repair-import-customer-tenant.js --tenant=8
 *   node scripts/repair-import-customer-tenant.js --tenant=8 --operation-id=import_123_abc
 *   node scripts/repair-import-customer-tenant.js --tenant=8 --ids=101,102,103
 */

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, '../data/billing.db');

function parseArgs(argv) {
    const out = { tenant: null, operationId: null, ids: null, dryRun: false };
    for (const arg of argv) {
        if (arg === '--dry-run') out.dryRun = true;
        else if (arg.startsWith('--tenant=')) out.tenant = parseInt(arg.split('=')[1], 10);
        else if (arg.startsWith('--operation-id=')) out.operationId = arg.split('=')[1];
        else if (arg.startsWith('--ids=')) {
            out.ids = arg.split('=')[1]
                .split(',')
                .map((v) => parseInt(v.trim(), 10))
                .filter(Number.isFinite);
        }
    }
    return out;
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!Number.isFinite(opts.tenant) || opts.tenant < 1) {
        console.error('Wajib: --tenant=<id>');
        process.exit(1);
    }

    const db = new sqlite3.Database(dbPath);
    try {
        let ids = opts.ids || [];

        if (!ids.length && opts.operationId) {
            const op = await dbAll(
                db,
                'SELECT created_ids_json FROM import_customer_operations WHERE id = ? LIMIT 1',
                [opts.operationId]
            );
            if (!op.length) {
                console.error(`Operasi import tidak ditemukan: ${opts.operationId}`);
                process.exit(1);
            }
            ids = JSON.parse(op[0].created_ids_json || '[]').filter(Number.isFinite);
        }

        if (!ids.length) {
            const ops = await dbAll(
                db,
                `SELECT id, created_ids_json, created_at
                 FROM import_customer_operations
                 ORDER BY created_at DESC
                 LIMIT 5`
            );
            for (const op of ops) {
                const created = JSON.parse(op.created_ids_json || '[]').filter(Number.isFinite);
                if (!created.length) continue;
                const placeholders = created.map(() => '?').join(',');
                const wrong = await dbAll(
                    db,
                    `SELECT id FROM customers WHERE id IN (${placeholders}) AND tenant_id != ?`,
                    [...created, opts.tenant]
                );
                if (wrong.length) {
                    ids = created;
                    console.log(`Memakai operasi import terakhir yang relevan: ${op.id} (${op.created_at})`);
                    break;
                }
            }
        }

        if (!ids.length) {
            console.log('Tidak ada pelanggan yang perlu diperbaiki.');
            return;
        }

        const placeholders = ids.map(() => '?').join(',');
        const rows = await dbAll(
            db,
            `SELECT id, name, phone, tenant_id, pppoe_username
             FROM customers
             WHERE id IN (${placeholders})`,
            ids
        );

        const toFix = rows.filter((r) => r.tenant_id !== opts.tenant);
        if (!toFix.length) {
            console.log('Semua pelanggan pada daftar ID sudah memiliki tenant_id yang benar.');
            return;
        }

        console.log(`Akan memperbaiki ${toFix.length} pelanggan → tenant_id=${opts.tenant}`);
        toFix.forEach((r) => {
            console.log(`  #${r.id} ${r.name} (${r.phone}) tenant_id ${r.tenant_id} → ${opts.tenant}`);
        });

        if (opts.dryRun) {
            console.log('Dry run — tidak ada perubahan disimpan.');
            return;
        }

        await dbRun(db, 'BEGIN IMMEDIATE');
        try {
            const fixPlaceholders = toFix.map(() => '?').join(',');
            await dbRun(
                db,
                `UPDATE customers SET tenant_id = ? WHERE id IN (${fixPlaceholders})`,
                [opts.tenant, ...toFix.map((r) => r.id)]
            );
            await dbRun(db, 'COMMIT');
            console.log(`Berhasil memperbaiki ${toFix.length} pelanggan.`);
        } catch (err) {
            await dbRun(db, 'ROLLBACK');
            throw err;
        }
    } finally {
        db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
