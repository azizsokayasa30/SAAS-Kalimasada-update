#!/usr/bin/env node
'use strict';

/**
 * Set RADIUS config di billing.db (app_settings) dari CLI deploy script.
 * Usage:
 *   node scripts/cli-set-radius-config.js --mode radius --host localhost --database /var/lib/freeradius/radius.db
 */

const path = require('path');

try {
    require('dotenv').config({ path: path.join(__dirname, '../.env') });
} catch (_) { /* optional */ }

const { saveRadiusConfig } = require('../config/radiusConfig');

function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            out[key] = true;
        } else {
            out[key] = next;
            i++;
        }
    }
    return out;
}

(async () => {
    const args = parseArgs(process.argv);
    const config = {
        user_auth_mode: args.mode || args['auth-mode'] || 'radius',
        radius_host: args.host || 'localhost',
        radius_user: args.user || 'radius',
        radius_password: args.password || '',
        radius_database: args.database || 'radius'
    };

    await saveRadiusConfig(config);
    console.log('OK: radius config saved to billing.db');
    console.log(JSON.stringify(config, null, 2));
})().catch((err) => {
    console.error('GAGAL:', err.message);
    process.exit(1);
});
