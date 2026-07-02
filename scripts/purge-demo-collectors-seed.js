#!/usr/bin/env node
/**
 * Hapus kolektor demo bawaan migrasi lama.
 * Usage: node scripts/purge-demo-collectors-seed.js
 *        node scripts/purge-demo-collectors-seed.js --dry-run
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
        if (!result.collectors.length) {
            console.log('✅ Tidak ada kolektor demo di database.');
            return;
        }
        console.log(`${dryRun ? '[dry-run] ' : ''}Menemukan ${result.collectors.length} kolektor demo:`);
        result.collectors.forEach((c) => console.log(`  - ${c.name} (${c.phone}) id=${c.id}`));
        if (dryRun) {
            console.log('Dry-run selesai. Jalankan tanpa --dry-run untuk menghapus.');
            return;
        }
        console.log(`✅ Dihapus ${result.collectorsRemoved} kolektor demo.`);
    } finally {
        db.close();
    }
}

main().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
});
