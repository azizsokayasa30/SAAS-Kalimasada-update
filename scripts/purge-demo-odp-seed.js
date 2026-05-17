#!/usr/bin/env node
/**
 * Hapus ODP demo bawaan migrasi lama (yang sering muncul kembali setelah dihapus).
 * Usage: node scripts/purge-demo-odp-seed.js
 *        node scripts/purge-demo-odp-seed.js --dry-run
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../data/billing.db');
const dryRun = process.argv.includes('--dry-run');

const DEMO_ODP_NAMES = [
    'ODP-Central-01',
    'ODP-Branch-01',
    'ODP-Residential-01',
    'ODP-Industrial-01',
    'ODP-Commercial-01'
];

const DEMO_SEGMENT_NAMES = [
    'Backbone-Central-Branch',
    'Distribution-Branch-Residential',
    'Backbone-Central-Industrial',
    'Distribution-Industrial-Commercial'
];

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ changes: this.changes });
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

async function main() {
    const db = new sqlite3.Database(dbPath);
    db.run('PRAGMA foreign_keys = ON');

    try {
        const demoOdps = await all(
            db,
            `SELECT id, name, code FROM odps WHERE name IN (${DEMO_ODP_NAMES.map(() => '?').join(',')})`,
            DEMO_ODP_NAMES
        );

        if (!demoOdps.length) {
            console.log('✅ Tidak ada ODP demo di database.');
            return;
        }

        console.log(`${dryRun ? '[dry-run] ' : ''}Menemukan ${demoOdps.length} ODP demo:`);
        demoOdps.forEach((o) => console.log(`  - ${o.name} (${o.code}) id=${o.id}`));

        const ids = demoOdps.map((o) => o.id);
        const ph = ids.map(() => '?').join(',');

        if (dryRun) {
            console.log('Dry-run selesai. Jalankan tanpa --dry-run untuk menghapus.');
            return;
        }

        await run(db, `DELETE FROM odp_connections WHERE from_odp_id IN (${ph}) OR to_odp_id IN (${ph})`, [...ids, ...ids]);
        await run(
            db,
            `DELETE FROM network_segments WHERE name IN (${DEMO_SEGMENT_NAMES.map(() => '?').join(',')})`,
            DEMO_SEGMENT_NAMES
        );
        await run(
            db,
            `DELETE FROM network_segments WHERE start_odp_id IN (${ph}) OR end_odp_id IN (${ph})`,
            [...ids, ...ids]
        );
        const del = await run(db, `DELETE FROM odps WHERE id IN (${ph})`, ids);
        console.log(`✅ Dihapus ${del.changes} ODP demo.`);
    } finally {
        db.close();
    }
}

main().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
});
