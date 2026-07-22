#!/usr/bin/env node
/**
 * Mengosongkan database SQLite RADIUS (user PPPoE, grup, NAS, accounting, post-auth, metadata profil).
 * Skema tabel dipertahankan; hanya baris data yang dihapus.
 *
 * Path file mengikuti aplikasi: env RADIUS_SQLITE_PATH → resolveRadiusSqliteDbPath()
 * (sama seperti billing-kalimasada).
 *
 * Usage:
 *   node scripts/reset-radius-sqlite.js --yes
 *   node scripts/reset-radius-sqlite.js --yes --backup
 *
 * Disarankan: hentikan PM2 proses billing dulu agar tidak SQLITE_BUSY:
 *   pm2 stop billing-kalimasada
 *   node scripts/reset-radius-sqlite.js --yes --backup
 *   pm2 start billing-kalimasada
 */
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '..');

const TABLES_IN_DELETE_ORDER = [
    'radacct',
    'radpostauth',
    'radusergroup',
    'radcheck',
    'radreply',
    'radgroupcheck',
    'radgroupreply',
    'nas',
    'pppoe_profiles',
    'hotspot_profiles'
];

function openDb(dbPath) {
    return new sqlite3.Database(dbPath);
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this.changes);
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

async function tableExists(db, name) {
    const row = await get(
        db,
        `SELECT 1 AS o FROM sqlite_master WHERE type='table' AND name=?`,
        [name]
    );
    return !!row;
}

async function main() {
    const args = new Set(process.argv.slice(2));
    if (!args.has('--yes') || !args.has('--i-understand-shared-db')) {
        console.log(`
Reset database RADIUS (SQLite): hapus semua DATA di tabel user/NAS/profil/accounting
untuk SEMUA TENANT (database bersama).

Wajib kedua flag:
  --yes
  --i-understand-shared-db

Opsi:
  --backup   Salin file .db ke backups/radius/ sebelum mengosongkan.

Contoh:
  node scripts/reset-radius-sqlite.js --yes --i-understand-shared-db --backup
`);
        process.exit(1);
    }

    process.chdir(ROOT);
    const { resolveRadiusSqliteDbPath } = require('../config/radiusSQLite');
    const resolved = await resolveRadiusSqliteDbPath();
    const dbPath = resolved.dbPath;

    console.log('File target:', dbPath);
    console.log('Sumber path :', resolved.source);

    if (!fs.existsSync(dbPath)) {
        console.error('File database tidak ada. Tidak ada yang di-reset.');
        process.exit(1);
    }

    if (args.has('--backup')) {
        const backupDir = path.join(ROOT, 'backups', 'radius');
        fs.mkdirSync(backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const dest = path.join(backupDir, `radius-before-reset-${stamp}.db`);
        fs.copyFileSync(dbPath, dest);
        console.log('Backup disalin ke:', dest);
    }

    const db = openDb(dbPath);
    db.configure('busyTimeout', 8000);

    try {
        await run(db, 'BEGIN IMMEDIATE');
        for (const t of TABLES_IN_DELETE_ORDER) {
            if (await tableExists(db, t)) {
                const n = await run(db, `DELETE FROM "${t}"`);
                console.log(`  DELETE FROM ${t}  →  ${n} baris`);
            } else {
                console.log(`  (lewati ${t} — tabel tidak ada)`);
            }
        }
        if (await tableExists(db, 'sqlite_sequence')) {
            await run(
                db,
                `DELETE FROM sqlite_sequence WHERE name IN (${TABLES_IN_DELETE_ORDER.map(() => '?').join(',')})`,
                TABLES_IN_DELETE_ORDER
            );
        }
        await run(db, 'COMMIT');
        console.log('\nSelesai. Database RADIUS kosong (skema tetap). Isi ulang lewat aplikasi billing-kalimasada.');
    } catch (e) {
        await run(db, 'ROLLBACK').catch(() => {});
        console.error('\nGagal:', e.message);
        process.exit(1);
    } finally {
        db.close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
