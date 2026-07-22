#!/usr/bin/env node
/**
 * Sync billing customers → RADIUS for specific tenants.
 * Passwords: Mikrotik PPP secrets (tenant routers, then all routers) → existing radcheck.
 *
 * Usage:
 *   RADIUS_SQLITE_PATH=/var/lib/freeradius/radius.db \
 *     node scripts/sync-tenants-users-to-radius.js --tenants=24,17,10,9,7,6
 */
process.env.RADIUS_SQLITE_PATH = process.env.RADIUS_SQLITE_PATH || '/var/lib/freeradius/radius.db';

// node-routeros can emit UNKNOWNREPLY(!empty) outside the write() promise on empty lists
process.on('uncaughtException', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (err?.errno === 'UNKNOWNREPLY' || /!empty/i.test(msg)) {
        console.warn(`[warn] swallowed RouterOS UNKNOWNREPLY: ${msg}`);
        return;
    }
    console.error('Uncaught:', err);
    process.exit(1);
});

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const {
    getMikrotikConnectionForRouter,
    getRadiusConnection,
    resolvePppoeProfileHintToRadiusGroup,
    syncRadiusToFreeRadiusMysql
} = require('../config/mikrotik');

const billingDbPath = path.join(__dirname, '../data/billing.db');

function parseTenants() {
    const arg = process.argv.find((a) => a.startsWith('--tenants='));
    if (!arg) return [24, 17, 10, 9, 7, 6];
    return arg
        .slice('--tenants='.length)
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n));
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

async function fetchPppSecrets(router) {
    const conn = await getMikrotikConnectionForRouter(router);
    const timeoutMs = 25000;
    const writePromise = conn.write('/ppp/secret/print').then(
        (rows) => (Array.isArray(rows) ? rows : []),
        (e) => {
            const msg = String(e && e.message ? e.message : e);
            if (e?.errno === 'UNKNOWNREPLY' || /!empty/i.test(msg)) return [];
            throw e;
        }
    );
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`ppp/secret/print timeout ${timeoutMs}ms`)), timeoutMs);
    });
    try {
        return await Promise.race([writePromise, timeoutPromise]);
    } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        if (e?.errno === 'UNKNOWNREPLY' || /!empty/i.test(msg)) return [];
        throw e;
    }
}

function mergeSecretsIntoMap(map, secrets, source) {
    for (const s of secrets || []) {
        const name = String(s.name || '').trim();
        if (!name) continue;
        const password = String(s.password || '').trim();
        const key = name.toLowerCase();
        if (!password) continue;
        const existing = map.get(key);
        // Prefer first non-empty; do not overwrite with empty
        if (!existing || !existing.password) {
            map.set(key, { username: name, password, profile: s.profile || null, source });
        }
    }
}

async function loadPasswordMap(db, tenantIds) {
    const map = new Map();
    const tenantRouters = await dbAll(
        db,
        `SELECT * FROM routers WHERE tenant_id IN (${tenantIds.map(() => '?').join(',')})`,
        tenantIds
    );
    const allRouters = await dbAll(db, 'SELECT * FROM routers ORDER BY id');

    console.log(`Fetching PPP secrets from ${tenantRouters.length} tenant router(s)...`);
    for (const r of tenantRouters) {
        try {
            const secrets = await fetchPppSecrets(r);
            mergeSecretsIntoMap(map, secrets, `router:${r.id}:${r.name}`);
            console.log(`  [OK] t${r.tenant_id} ${r.name}: ${(secrets || []).length} secrets`);
        } catch (e) {
            console.log(`  [FAIL] t${r.tenant_id} ${r.name}: ${e.message}`);
        }
    }

    // Optional: scan remaining routers for tenants that have no NAS of their own
    const scanAll = process.argv.includes('--scan-all-routers');
    const scannedIds = new Set(tenantRouters.map((r) => r.id));
    if (scanAll) {
        const extras = allRouters.filter((r) => !scannedIds.has(r.id));
        if (extras.length) {
            console.log(`Scanning ${extras.length} other router(s) for missing passwords...`);
            for (const r of extras) {
                try {
                    const secrets = await fetchPppSecrets(r);
                    mergeSecretsIntoMap(map, secrets, `router:${r.id}:${r.name}`);
                    console.log(`  [OK] t${r.tenant_id} ${r.name}: ${(secrets || []).length} secrets`);
                } catch (e) {
                    console.log(`  [FAIL] t${r.tenant_id} ${r.name}: ${e.message}`);
                }
            }
        }
    } else {
        console.log('Skip other routers (pass --scan-all-routers to search all NAS).');
    }

    return map;
}

async function getExistingRadiusPassword(conn, username) {
    const [rows] = await conn.execute(
        `SELECT value FROM radcheck
         WHERE LOWER(username) = LOWER(?) AND LOWER(attribute) = 'cleartext-password'
         LIMIT 1`,
        [username]
    );
    if (!rows || !rows.length) return null;
    const v = rows[0].value;
    return v != null ? String(v).trim() : null;
}

async function syncOne(conn, customer, passwordMap) {
    const username = String(customer.pppoe_username || '').trim();
    if (!username) return { status: 'skipped', reason: 'no username' };

    const fromMt = passwordMap.get(username.toLowerCase());
    let password = fromMt?.password || '';
    let passwordSource = fromMt ? 'mikrotik' : null;

    if (!password) {
        password = (await getExistingRadiusPassword(conn, username)) || '';
        if (password) passwordSource = 'radius-existing';
    }

    if (!password) {
        return { status: 'skipped', reason: 'no password (mikrotik/radius)' };
    }

    await conn.execute(
        `INSERT INTO radcheck (username, attribute, op, value)
         VALUES (?, 'Cleartext-Password', ':=', ?)
         ON CONFLICT(username, attribute) DO UPDATE SET op = excluded.op, value = excluded.value`,
        [username, password]
    );

    const status = String(customer.status || '').toLowerCase();
    if (status === 'suspended') {
        return { status: 'synced', passwordSource, note: 'password ok; skip group (suspended)' };
    }

    const profileHint = String(customer.pppoe_profile || customer.package_pppoe_profile || '').trim();
    if (profileHint) {
        const resolvedGroup = await resolvePppoeProfileHintToRadiusGroup(conn, profileHint);
        if (resolvedGroup) {
            await conn.execute('DELETE FROM radusergroup WHERE username = ?', [username]);
            await conn.execute(
                'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)',
                [username, resolvedGroup]
            );
            return { status: 'synced', passwordSource, group: resolvedGroup };
        }
        return { status: 'synced', passwordSource, note: `password ok; group unresolved (${profileHint})` };
    }

    return { status: 'synced', passwordSource, note: 'password ok; no profile hint' };
}

async function main() {
    const tenantIds = parseTenants();
    console.log(`Sync tenants → RADIUS: ${tenantIds.join(', ')}`);
    console.log(`RADIUS DB: ${process.env.RADIUS_SQLITE_PATH}`);

    const db = new sqlite3.Database(billingDbPath);
    const passwordMap = await loadPasswordMap(db, tenantIds);
    console.log(`Password map size: ${passwordMap.size}`);

    const customers = await dbAll(
        db,
        `SELECT c.id, c.tenant_id, c.pppoe_username, c.pppoe_profile, c.status,
                p.pppoe_profile AS package_pppoe_profile
         FROM customers c
         LEFT JOIN packages p ON c.package_id = p.id
         WHERE c.tenant_id IN (${tenantIds.map(() => '?').join(',')})
           AND c.pppoe_username IS NOT NULL
           AND TRIM(c.pppoe_username) != ''
         ORDER BY c.tenant_id, c.id`,
        tenantIds
    );
    db.close();

    console.log(`Customers with PPPoE username: ${customers.length}`);

    const conn = await getRadiusConnection();
    const summary = {};
    for (const tid of tenantIds) {
        summary[tid] = { synced: 0, skipped: 0, failed: 0, reasons: {} };
    }

    for (const customer of customers) {
        const tid = customer.tenant_id;
        if (!summary[tid]) summary[tid] = { synced: 0, skipped: 0, failed: 0, reasons: {} };
        try {
            const result = await syncOne(conn, customer, passwordMap);
            if (result.status === 'synced') {
                summary[tid].synced++;
            } else {
                summary[tid].skipped++;
                const r = result.reason || 'other';
                summary[tid].reasons[r] = (summary[tid].reasons[r] || 0) + 1;
            }
        } catch (e) {
            summary[tid].failed++;
            const r = e.message || 'error';
            summary[tid].reasons[r] = (summary[tid].reasons[r] || 0) + 1;
            console.log(`[FAIL] t${tid} ${customer.pppoe_username}: ${e.message}`);
        }
    }

    try {
        if (typeof conn.end === 'function') await conn.end();
    } catch (_) {}

    console.log('\nPushing RADIUS SQLite → MySQL / POP...');
    await syncRadiusToFreeRadiusMysql({ force: true, popSyncReason: 'tenant-batch-sync' });

    console.log('\n=== Summary per tenant ===');
    for (const tid of tenantIds) {
        const s = summary[tid];
        console.log(
            `tenant ${tid}: synced=${s.synced} skipped=${s.skipped} failed=${s.failed}` +
                (Object.keys(s.reasons).length ? ` reasons=${JSON.stringify(s.reasons)}` : '')
        );
    }
}

main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
});
