#!/usr/bin/env node
/**
 * Nonaktifkan akses jaringan untuk semua pelanggan status inactive (Auth-Type Reject / secret disabled).
 *
 *   node scripts/disable-inactive-customers-network.js
 *   node scripts/disable-inactive-customers-network.js --confirm NONAKTIF-DISABLE
 */
process.env.TZ = process.env.TZ || 'Asia/Jakarta';
process.env.SKIP_INVOICE_SCHEDULER = '1';

const CONFIRM = 'NONAKTIF-DISABLE';
const confirmArg = process.argv.includes('--confirm') &&
    (process.argv.includes(`--confirm=${CONFIRM}`) ||
        process.argv[process.argv.indexOf('--confirm') + 1] === CONFIRM);

(async () => {
    const billingManager = require('../config/billing');
    const serviceSuspension = require('../config/serviceSuspension');
    const { forEachOperationalTenant } = require('../config/platform/tenantJobs');

    const dbCount = await new Promise((resolve, reject) => {
        billingManager.db.get(
            `SELECT COUNT(*) AS c FROM customers WHERE LOWER(status) = 'inactive'`,
            [],
            (err, row) => (err ? reject(err) : resolve(row?.c || 0))
        );
    });

    console.log('=== Disable network untuk pelanggan Nonaktif ===\n');
    console.log(`Total pelanggan inactive di DB: ${dbCount}\n`);

    if (!confirmArg) {
        console.log(`Jalankan:\n  node scripts/disable-inactive-customers-network.js --confirm ${CONFIRM}\n`);
        process.exit(0);
    }

    const results = await forEachOperationalTenant(async (tenant) => {
        const r = await serviceSuspension.syncInactiveStatusToNetwork();
        console.log(`tenant #${tenant.id}: synced=${r.synced} errors=${r.errors} total=${r.total}`);
        return r;
    }, { label: 'disable-inactive' });

    const ok = results.filter((r) => r.success).length;
    console.log(`\nSelesai: ${ok}/${results.length} tenant`);
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
