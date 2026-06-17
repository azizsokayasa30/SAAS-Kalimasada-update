#!/usr/bin/env node
/**
 * Hapus semua data demo (kolektor + ODP) bawaan migrasi/script lama.
 * Usage: node scripts/purge-demo-seed-data.js
 *        node scripts/purge-demo-seed-data.js --dry-run
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
        const hasCollectors = result.collectors.length > 0;
        const hasOdps = result.odps.length > 0;

        if (!hasCollectors && !hasOdps) {
            console.log('✅ Tidak ada data demo kolektor/ODP di database.');
            return;
        }

        if (hasCollectors) {
            console.log(`${dryRun ? '[dry-run] ' : ''}Kolektor demo (${result.collectors.length}):`);
            result.collectors.forEach((c) => console.log(`  - ${c.name} (${c.phone}) id=${c.id}`));
        }
        if (hasOdps) {
            console.log(`${dryRun ? '[dry-run] ' : ''}ODP demo (${result.odps.length}):`);
            result.odps.forEach((o) => console.log(`  - ${o.name} (${o.code}) id=${o.id}`));
        }

        if (dryRun) {
            console.log('Dry-run selesai. Jalankan tanpa --dry-run untuk menghapus.');
            return;
        }

        if (result.collectorsRemoved) {
            console.log(`✅ Dihapus ${result.collectorsRemoved} kolektor demo.`);
        }
        if (result.odpsRemoved) {
            console.log(`✅ Dihapus ${result.odpsRemoved} ODP demo.`);
        }
    } finally {
        db.close();
    }
}

main().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
});
