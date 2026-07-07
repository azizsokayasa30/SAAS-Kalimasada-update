#!/usr/bin/env node
'use strict';

const billingManager = require('../config/billing');

(async () => {
    const stats = await billingManager.getCustomerStatsByMonth(7, 2026, {});
    console.log('July WITHOUT tenant context:', stats);
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
