#!/usr/bin/env node
'use strict';

/**
 * Initialize Kalimasada SaaS platform tables + super admin.
 * Usage: node scripts/init-platform-saas.js
 */

try {
    require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
} catch (_) { /* dotenv optional for init script */ }

const tenantStore = require('../config/platform/tenantStore');

(async () => {
    try {
        await tenantStore.initPlatform();
        console.log('✅ Platform SaaS siap.');
        console.log('   Portal: /management/login');
        console.log('   Super Admin: management@kalimasada / kalimasada123');
        process.exit(0);
    } catch (err) {
        console.error('❌ Init platform gagal:', err);
        process.exit(1);
    }
})();
