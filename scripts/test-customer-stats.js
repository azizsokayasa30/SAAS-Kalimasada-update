#!/usr/bin/env node
'use strict';

const billingManager = require('../config/billing');
const { runWithTenant } = require('../config/platform/tenantContext');

const tenant = { id: 2, slug: 'tenant1', name: 'Tenant1' };

(async () => {
    for (const [month, year, label] of [
        [7, 2026, 'July 2026'],
        [6, 2026, 'June 2026'],
    ]) {
        const stats = await runWithTenant(tenant, () =>
            billingManager.getCustomerStatsByMonth(month, year, {})
        );
        console.log(`\n${label}:`, {
            total: stats.total,
            total_tagihan: stats.total_tagihan,
            lunas: stats.lunas,
            belum_lunas: stats.belum_lunas,
            baru: stats.baru,
        });
    }
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
