#!/usr/bin/env node
/**
 * Isi password login portal pelanggan yang masih kosong dengan default 123456 (bcrypt).
 *
 * Hanya mengubah kolom customers.password.
 * Tidak menyentuh PPPoE, RADIUS, username, telepon, atau field lain.
 * Tidak menimpa password yang sudah terisi.
 *
 * Usage:
 *   node scripts/backfill-customer-portal-passwords.js           # dry-run (default)
 *   node scripts/backfill-customer-portal-passwords.js --apply   # tulis ke database
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

const DEFAULT_PORTAL_PASSWORD = '123456';
const BCRYPT_ROUNDS = 10;
const SAMPLE_VERIFY_LIMIT = 5;
const PREVIEW_LIMIT = 25;
const EMPTY_PASSWORD_SQL = `(password IS NULL OR TRIM(password) = '')`;
const DB_PATH = path.join(__dirname, '../data/billing.db');

const apply = process.argv.includes('--apply');
const dryRun = !apply;

function openDatabase(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
            if (err) reject(err);
            else resolve(db);
        });
    });
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
            else resolve(this);
        });
    });
}

function closeDatabase(db) {
    return new Promise((resolve, reject) => {
        db.close((err) => (err ? reject(err) : resolve()));
    });
}

function formatCustomerLine(row) {
    const username = row.username || '-';
    const phone = row.phone || '-';
    const status = row.status || '-';
    const tenantId = row.tenant_id != null ? row.tenant_id : '-';
    return `  id=${row.id}  tenant=${tenantId}  username=${username}  phone=${phone}  status=${status}`;
}

async function main() {
    console.log('Backfill password portal pelanggan');
    console.log(`Mode: ${dryRun ? 'DRY-RUN (tidak menulis database)' : 'APPLY'}`);
    console.log(`Database: ${DB_PATH}\n`);

    if (!fs.existsSync(DB_PATH)) {
        throw new Error(`Database tidak ditemukan: ${DB_PATH}`);
    }

    const db = await openDatabase(DB_PATH);

    try {
        const columns = await dbAll(db, 'PRAGMA table_info(customers)');
        const hasPassword = columns.some((col) => col.name === 'password');
        if (!hasPassword) {
            throw new Error('Kolom customers.password tidak ada');
        }

        const totals = await dbGet(
            db,
            `SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN password IS NULL OR TRIM(password) = '' THEN 1 ELSE 0 END) AS empty_count,
                SUM(CASE WHEN password IS NOT NULL AND TRIM(password) != '' THEN 1 ELSE 0 END) AS has_password
             FROM customers`
        );

        const emptyRows = await dbAll(
            db,
            `SELECT id, tenant_id, username, phone, status
             FROM customers
             WHERE ${EMPTY_PASSWORD_SQL}
             ORDER BY id ASC`
        );

        const total = Number(totals && totals.total) || 0;
        const emptyCount = Number(totals && totals.empty_count) || emptyRows.length;
        const hasPasswordCount = Number(totals && totals.has_password) || (total - emptyCount);

        console.log(`Total pelanggan     : ${total}`);
        console.log(`Sudah punya password: ${hasPasswordCount}`);
        console.log(`Belum punya password: ${emptyCount}`);

        if (emptyRows.length === 0) {
            console.log('\nTidak ada pelanggan yang perlu diisi. Selesai.');
            return;
        }

        console.log(`\nContoh ${Math.min(PREVIEW_LIMIT, emptyRows.length)} pelanggan yang akan diisi:`);
        emptyRows.slice(0, PREVIEW_LIMIT).forEach((row) => {
            console.log(formatCustomerLine(row));
        });
        if (emptyRows.length > PREVIEW_LIMIT) {
            console.log(`  ... dan ${emptyRows.length - PREVIEW_LIMIT} lainnya`);
        }

        if (dryRun) {
            console.log('\nDry-run selesai. Database tidak diubah.');
            console.log('Jalankan dengan --apply untuk menulis password default 123456.');
            return;
        }

        const HASH_CONCURRENCY = 8;
        const hashesById = new Map();
        console.log(`\nMembuat hash bcrypt (rounds=${BCRYPT_ROUNDS}, concurrency=${HASH_CONCURRENCY})...`);
        for (let i = 0; i < emptyRows.length; i += HASH_CONCURRENCY) {
            const batch = emptyRows.slice(i, i + HASH_CONCURRENCY);
            const hashed = await Promise.all(
                batch.map(() => bcrypt.hash(DEFAULT_PORTAL_PASSWORD, BCRYPT_ROUNDS))
            );
            batch.forEach((row, idx) => hashesById.set(row.id, hashed[idx]));
            const done = Math.min(i + HASH_CONCURRENCY, emptyRows.length);
            if (done === emptyRows.length || done % 400 === 0) {
                console.log(`  hash ${done}/${emptyRows.length}`);
            }
        }

        await dbRun(db, 'BEGIN IMMEDIATE');
        let updated = 0;
        const updatedIds = [];

        try {
            for (const row of emptyRows) {
                const hashedPassword = hashesById.get(row.id);
                const result = await dbRun(
                    db,
                    `UPDATE customers
                     SET password = ?
                     WHERE id = ?
                       AND ${EMPTY_PASSWORD_SQL}`,
                    [hashedPassword, row.id]
                );
                if (result.changes > 0) {
                    updated += 1;
                    updatedIds.push(row.id);
                }
            }
            await dbRun(db, 'COMMIT');
        } catch (err) {
            try {
                await dbRun(db, 'ROLLBACK');
            } catch (_) {
                /* ignore rollback errors */
            }
            throw err;
        }

        console.log(`\nBerhasil mengisi password portal: ${updated} pelanggan`);

        const remaining = await dbGet(
            db,
            `SELECT COUNT(*) AS remaining FROM customers WHERE ${EMPTY_PASSWORD_SQL}`
        );
        console.log(`Sisa tanpa password: ${Number(remaining && remaining.remaining) || 0}`);

        if (updatedIds.length > 0) {
            const placeholders = updatedIds.slice(0, SAMPLE_VERIFY_LIMIT).map(() => '?').join(', ');
            const sampleIds = updatedIds.slice(0, SAMPLE_VERIFY_LIMIT);
            const samples = await dbAll(
                db,
                `SELECT id, password FROM customers WHERE id IN (${placeholders})`,
                sampleIds
            );
            let verified = 0;
            for (const sample of samples) {
                const ok = await bcrypt.compare(DEFAULT_PORTAL_PASSWORD, sample.password);
                if (!ok) {
                    throw new Error(`Verifikasi bcrypt gagal untuk customer id=${sample.id}`);
                }
                verified += 1;
            }
            console.log(`Verifikasi sample bcrypt.compare('123456'): ${verified}/${samples.length} OK`);
        }

        console.log('\nSelesai. Hanya kolom customers.password yang diubah.');
    } finally {
        await closeDatabase(db);
    }
}

main().catch((err) => {
    console.error('Backfill gagal:', err.message || err);
    process.exit(1);
});
