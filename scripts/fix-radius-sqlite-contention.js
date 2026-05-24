#!/usr/bin/env node
/**
 * Kurangi SQLITE_BUSY / timeout Mikrotik: bersihkan radpostauth & sesi radacct basi,
 * checkpoint WAL, index performa.
 *
 * Jalankan saat beban rendah jika memungkinkan. Untuk hasil terbaik:
 *   pm2 stop billing-kalimasada
 *   node scripts/fix-radius-sqlite-contention.js --yes
 *   sudo bash scripts/optimize-freeradius-mass-auth.sh
 *   pm2 start billing-kalimasada
 *
 * Usage:
 *   node scripts/fix-radius-sqlite-contention.js --yes
 *   node scripts/fix-radius-sqlite-contention.js --yes --vacuum
 */
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { resolveRadiusSqliteDbPath } = require('../config/radiusSQLite');

const BATCH = 25000;
const PRAGMAS = [
    'PRAGMA busy_timeout=120000',
    'PRAGMA journal_mode=WAL',
    'PRAGMA synchronous=NORMAL',
    'PRAGMA wal_autocheckpoint=500'
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

async function batchDelete(db, label, sql, params) {
    let total = 0;
    for (;;) {
        const n = await run(db, sql, params);
        total += n;
        if (n > 0) process.stdout.write(`  ${label}: +${n} (total ${total})\r`);
        if (n < BATCH) break;
        await new Promise((r) => setTimeout(r, 50));
    }
    if (total > 0) console.log(`  ${label}: ${total} baris dihapus/diperbarui`);
    return total;
}

async function main() {
    const args = new Set(process.argv.slice(2));
    if (!args.has('--yes')) {
        console.log(`
Perbaikan kontensi SQLite RADIUS (radpostauth besar, radacct basi, WAL checkpoint).

Wajib: --yes

Opsi:
  --keep-postauth-days N   Simpan log post-auth N hari (default 3)
  --aggressive             Sama dengan --keep-postauth-days 1
  --close-stale-acct-days N Tutup sesi radacct tanpa stoptime lebih tua dari N hari (default 7)
  --purge-acct-days N      Hapus riwayat radacct yang sudah stop lebih tua dari N hari (default 0 = tidak hapus)
  --vacuum                 VACUUM penuh (butuh lock eksklusif; hentikan FreeRADIUS dulu)

Contoh:
  node scripts/fix-radius-sqlite-contention.js --yes
`);
        process.exit(1);
    }

    const keepPostauth = args.has('--aggressive')
        ? 1
        : Number(process.argv.find((a, i) => process.argv[i - 1] === '--keep-postauth-days') || 3);
    const closeStale = Number(process.argv.find((a, i) => process.argv[i - 1] === '--close-stale-acct-days') || 7);
    const purgeAcct = Number(process.argv.find((a, i) => process.argv[i - 1] === '--purge-acct-days') || 0);

    const { dbPath } = await resolveRadiusSqliteDbPath();
    console.log(`Database: ${dbPath}`);

    const db = openDb(dbPath);
    try {
        for (const p of PRAGMAS) await run(db, p);

        const counts = {};
        for (const [t, q] of [
            ['radpostauth', 'SELECT COUNT(*) AS n FROM radpostauth'],
            ['radacct', 'SELECT COUNT(*) AS n FROM radacct'],
            ['radacct_open', "SELECT COUNT(*) AS n FROM radacct WHERE acctstoptime IS NULL OR acctstoptime = ''"]
        ]) {
            const row = await get(db, q);
            counts[t] = row.n;
        }
        console.log('Sebelum:', counts);

        await run(
            db,
            'CREATE INDEX IF NOT EXISTS idx_radpostauth_authdate ON radpostauth (authdate)'
        );

        const postauthCutoff = `datetime('now', 'localtime', '-${keepPostauth} days')`;
        await batchDelete(
            db,
            'radpostauth lama',
            `DELETE FROM radpostauth WHERE rowid IN (
                SELECT rowid FROM radpostauth
                WHERE authdate < ${postauthCutoff}
                LIMIT ${BATCH}
            )`
        );

        const staleCutoff = `datetime('now', 'localtime', '-${closeStale} days')`;
        const closed = await batchDelete(
            db,
            'radacct sesi basi',
            `UPDATE radacct SET acctstoptime = COALESCE(acctupdatetime, acctstarttime, datetime('now','localtime')),
                acctterminatecause = 'Stale-Session-Cleanup'
             WHERE rowid IN (
                SELECT rowid FROM radacct
                WHERE (acctstoptime IS NULL OR acctstoptime = '')
                  AND acctstarttime < ${staleCutoff}
                LIMIT ${BATCH}
            )`
        );

        if (purgeAcct > 0) {
            const acctCutoff = `datetime('now', 'localtime', '-${purgeAcct} days')`;
            await batchDelete(
                db,
                'radacct riwayat lama',
                `DELETE FROM radacct WHERE rowid IN (
                    SELECT rowid FROM radacct
                    WHERE acctstoptime IS NOT NULL AND acctstoptime != ''
                      AND acctstoptime < ${acctCutoff}
                    LIMIT ${BATCH}
                )`
            );
        }

        await run(db, 'ANALYZE');
        console.log('ANALYZE selesai');

        try {
            const ck = await get(db, 'PRAGMA wal_checkpoint(TRUNCATE)');
            console.log('WAL checkpoint:', ck);
        } catch (e) {
            console.warn('WAL checkpoint dilewati (biasanya karena FreeRADIUS sedang menulis):', e.message);
        }

        if (args.has('--vacuum')) {
            console.log('VACUUM... (bisa beberapa menit)');
            await run(db, 'VACUUM');
            console.log('VACUUM selesai');
        }

        const after = {};
        for (const [t, q] of [
            ['radpostauth', 'SELECT COUNT(*) AS n FROM radpostauth'],
            ['radacct', 'SELECT COUNT(*) AS n FROM radacct'],
            ['radacct_open', "SELECT COUNT(*) AS n FROM radacct WHERE acctstoptime IS NULL OR acctstoptime = ''"]
        ]) {
            const row = await get(db, q);
            after[t] = row.n;
        }
        console.log('Sesudah:', after);
        console.log(`Sesi basi ditutup: ${closed}`);
        console.log('\nLangkah berikutnya (root): sudo bash scripts/optimize-freeradius-mass-auth.sh');
    } finally {
        db.close();
    }
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
