#!/usr/bin/env node
/**
 * Hapus ODP demo bawaan migrasi lama (yang sering muncul kembali setelah dihapus).
 * Usage: node scripts/purge-demo-odp-seed.js
 *        node scripts/purge-demo-odp-seed.js --dry-run
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { purgeDemoSeedData } = require('../utils/demoSeedData');

const dbPath = path.join(__dirname, '../data/billing.db');
const dryRun = process.argv.includes('--dry-run');

async function main() {
    const db = new sqlite3.Database(dbPath);
    try {
        const result = await purgeDemoSeedData(db, { dryRun });
        if (!result.odps.length) {
            console.log('✅ Tidak ada ODP demo di database.');
            return;
        }

        console.log(`${dryRun ? '[dry-run] ' : ''}Menemukan ${result.odps.length} ODP demo:`);
        result.odps.forEach((o) => console.log(`  - ${o.name} (${o.code}) id=${o.id}`));

        if (dryRun) {
            console.log('Dry-run selesai. Jalankan tanpa --dry-run untuk menghapus.');
            return;
        }

        console.log(`✅ Dihapus ${result.odpsRemoved} ODP demo.`);
    } finally {
        db.close();
    }
}

main().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
});
