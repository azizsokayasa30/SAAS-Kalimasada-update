#!/usr/bin/env node
/**
 * Terapkan index & PRAGMA performa ke database RADIUS SQLite yang sudah ada.
 * Aman dijalankan saat operasi normal (WAL mode).
 *
 * Usage: node scripts/optimize-radius-sqlite.js
 */
const { getRadiusConnection, resolveRadiusSqliteDbPath } = require('../config/radiusSQLite');

const EXTRA_INDEXES = [
    'CREATE INDEX IF NOT EXISTS idx_radacct_stoptime ON radacct (acctstoptime)',
    'CREATE INDEX IF NOT EXISTS idx_radacct_username_stoptime ON radacct (username, acctstoptime)',
    'CREATE INDEX IF NOT EXISTS idx_radcheck_username_attr ON radcheck (username, attribute)',
    'CREATE INDEX IF NOT EXISTS idx_radacct_sessionid ON radacct (acctsessionid)'
];

async function main() {
    const resolved = await resolveRadiusSqliteDbPath();
    console.log(`Optimizing RADIUS SQLite: ${resolved.dbPath}`);

    const conn = await getRadiusConnection();
    for (const sql of EXTRA_INDEXES) {
        await conn.execute(sql);
        console.log(`  OK: ${sql.split('IF NOT EXISTS ')[1] || sql}`);
    }

    await conn.execute('ANALYZE');
    console.log('  OK: ANALYZE');
    await conn.end();

    console.log('Selesai. Restart FreeRADIUS tidak wajib untuk index baru.');
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
