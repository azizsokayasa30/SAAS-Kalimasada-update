#!/usr/bin/env node
/**
 * Remount radusergroup yang masih mengarah ke prefix tenant lain
 * (contoh: user tenant 26 masih di t9_profil_50_mbps).
 *
 * Usage:
 *   node scripts/repair-foreign-tenant-radusergroup.js --dry-run
 *   node scripts/repair-foreign-tenant-radusergroup.js
 *   node scripts/repair-foreign-tenant-radusergroup.js --tenant=26
 */

const path = require('path');
const fs = require('fs');

// Load .env agar RADIUS_SQLITE_PATH = /var/lib/freeradius/radius.db
(function loadEnv() {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        const key = m[1];
        let val = m[2].trim();
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        if (process.env[key] == null || process.env[key] === '') process.env[key] = val;
    }
})();

require('../config/logger');

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const tenantArg = args.find((a) => a.startsWith('--tenant='));
    const tenantId = tenantArg ? parseInt(tenantArg.split('=')[1], 10) : null;

    console.log(
        `[repair-foreign-radusergroup] RADIUS_SQLITE_PATH=${process.env.RADIUS_SQLITE_PATH || '(default)'}`
    );

    require('../config/billing');
    await new Promise((r) => setTimeout(r, 800));

    const {
        repairForeignTenantRadusergroupAssignments
    } = require('../utils/tenantPppoeProfileOwnership');

    console.log(
        `[repair-foreign-radusergroup] start dryRun=${dryRun}` +
            (tenantId ? ` tenant=${tenantId}` : ' tenants=ALL')
    );

    const result = await repairForeignTenantRadusergroupAssignments({
        tenantId: Number.isFinite(tenantId) ? tenantId : null,
        dryRun
    });

    console.log(JSON.stringify(result, null, 2));
    console.log(
        `[repair-foreign-radusergroup] done foreign_found=${result.foreign_found}` +
            ` remounted=${result.remounted}` +
            ` skipped_shared=${result.skipped_shared_username}` +
            ` groups_ensured=${result.groups_ensured}` +
            ` cust_fixed=${result.customers_profile_fixed}` +
            ` pkg_fixed=${result.packages_profile_fixed}`
    );
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('[repair-foreign-radusergroup] FAILED:', err);
        process.exit(1);
    });
