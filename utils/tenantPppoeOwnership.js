/**
 * Kepemilikan user PPPoE RADIUS per tenant.
 *
 * FreeRADIUS (radcheck) tidak punya tenant_id. Isolasi wajib di layer app:
 * - Pelanggan: customers.pppoe_username (sudah di-scope tenant_id)
 * - User manual/gratis: tabel tenant_pppoe_users
 *
 * Listing harus ALLOWLIST (hanya username milik tenant ini), bukan denylist.
 */

const path = require('path');
const logger = require('../config/logger');
const { getTenantId, hasTenantContext } = require('../config/platform/tenantContext');

const TABLE = 'tenant_pppoe_users';
let _ensurePromise = null;
let _orphanMigratePromise = null;

function normalizeUsername(username) {
    return String(username || '').trim();
}

function normalizeKey(username) {
    return normalizeUsername(username).toLowerCase();
}

function getBillingDb() {
    return require('../config/billing').db;
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row || null);
        });
    });
}

async function ensureTenantPppoeUsersTable() {
    if (_ensurePromise) return _ensurePromise;
    _ensurePromise = (async () => {
        const db = getBillingDb();
        await dbRun(
            db,
            `CREATE TABLE IF NOT EXISTS ${TABLE} (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                created_at DATETIME DEFAULT (datetime('now','localtime')),
                UNIQUE(username COLLATE NOCASE)
            )`
        );
        await dbRun(
            db,
            `CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant_id ON ${TABLE}(tenant_id)`
        );
        await dbRun(
            db,
            `CREATE INDEX IF NOT EXISTS idx_${TABLE}_username ON ${TABLE}(username)`
        );
    })().catch((err) => {
        _ensurePromise = null;
        throw err;
    });
    return _ensurePromise;
}

/**
 * Satu kali: klaim user RADIUS yang tidak terhubung ke customers.pppoe_username
 * ke tenant historis yang punya pelanggan paling banyak (biasanya tenant ISP utama),
 * agar akun gratis tidak hilang setelah switch ke allowlist — tanpa bocor ke tenant lain.
 */
async function migrateOrphanRadiusUsersOnce() {
    if (_orphanMigratePromise) return _orphanMigratePromise;
    _orphanMigratePromise = (async () => {
        await ensureTenantPppoeUsersTable();
        const db = getBillingDb();

        const flag = await dbGet(
            db,
            `SELECT value FROM app_settings WHERE key = ? LIMIT 1`,
            ['tenant_pppoe_orphan_migrated']
        ).catch(() => null);
        if (flag && String(flag.value) === '1') return { skipped: true };

        let radiusUsernames = [];
        try {
            const { getRadiusConnection } = require('../config/radiusSQLite');
            const conn = await getRadiusConnection();
            try {
                const [rows] = await conn.execute(
                    `SELECT DISTINCT TRIM(username) AS u FROM radcheck
                     WHERE attribute = 'Cleartext-Password'
                       AND username IS NOT NULL AND TRIM(username) != ''`
                );
                radiusUsernames = (rows || []).map((r) => normalizeUsername(r.u)).filter(Boolean);
            } finally {
                try {
                    if (conn && typeof conn.end === 'function') await conn.end();
                } catch (_) {}
            }
        } catch (err) {
            logger.warn(`[tenantPppoeOwnership] Skip orphan migrate (RADIUS): ${err.message}`);
            return { skipped: true, reason: err.message };
        }

        if (!radiusUsernames.length) {
            await markOrphanMigrated(db);
            return { claimed: 0 };
        }

        const linkedRows = await dbAll(
            db,
            `SELECT DISTINCT LOWER(TRIM(pppoe_username)) AS u FROM customers
             WHERE pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''`
        );
        const linked = new Set((linkedRows || []).map((r) => r.u).filter(Boolean));

        const orphans = radiusUsernames.filter((u) => !linked.has(normalizeKey(u)));
        if (!orphans.length) {
            await markOrphanMigrated(db);
            return { claimed: 0 };
        }

        const ownerRow = await dbGet(
            db,
            `SELECT tenant_id, COUNT(*) AS cnt FROM customers
             WHERE tenant_id IS NOT NULL
               AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''
             GROUP BY tenant_id
             ORDER BY cnt DESC
             LIMIT 1`
        );
        const ownerTenantId = ownerRow ? parseInt(ownerRow.tenant_id, 10) : null;
        if (!ownerTenantId) {
            logger.warn('[tenantPppoeOwnership] No tenant with PPPoE customers; orphans left unclaimed');
            await markOrphanMigrated(db);
            return { claimed: 0, unclaimed: orphans.length };
        }

        let claimed = 0;
        for (const username of orphans) {
            try {
                const existing = await dbGet(
                    db,
                    `SELECT id, tenant_id FROM ${TABLE} WHERE LOWER(TRIM(username)) = ? LIMIT 1`,
                    [normalizeKey(username)]
                );
                if (existing) continue;
                await dbRun(
                    db,
                    `INSERT INTO ${TABLE} (tenant_id, username) VALUES (?, ?)`,
                    [ownerTenantId, username]
                );
                claimed += 1;
            } catch (err) {
                if (!String(err.message || '').includes('UNIQUE')) {
                    logger.warn(`[tenantPppoeOwnership] Claim ${username} failed: ${err.message}`);
                }
            }
        }

        await markOrphanMigrated(db);
        logger.info(
            `[tenantPppoeOwnership] Migrated ${claimed} orphan RADIUS users → tenant ${ownerTenantId}`
        );
        return { claimed, ownerTenantId, orphanTotal: orphans.length };
    })().catch((err) => {
        _orphanMigratePromise = null;
        logger.error(`[tenantPppoeOwnership] Orphan migrate failed: ${err.message}`);
        throw err;
    });
    return _orphanMigratePromise;
}

async function markOrphanMigrated(db) {
    try {
        await dbRun(
            db,
            `INSERT INTO app_settings (key, value, tenant_id) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')`,
            ['tenant_pppoe_orphan_migrated', '1', 1]
        );
    } catch (err) {
        try {
            await dbRun(
                db,
                `INSERT OR REPLACE INTO app_settings (key, value, tenant_id) VALUES (?, ?, ?)`,
                ['tenant_pppoe_orphan_migrated', '1', 1]
            );
        } catch (e2) {
            logger.warn(`[tenantPppoeOwnership] Could not set migrate flag: ${e2.message}`);
        }
    }
}

/**
 * Username PPPoE yang boleh dilihat/dikelola tenant saat ini.
 * null = tidak ada konteks tenant (jangan filter / perilaku platform).
 * [] = tenant punya 0 user (WAJIB tampil kosong, jangan load semua RADIUS).
 */
async function getTenantAllowedPppoeUsernames() {
    await ensureTenantPppoeUsersTable();
    await migrateOrphanRadiusUsersOnce().catch(() => {});

    if (!hasTenantContext()) return null;

    const tenantId = getTenantId();
    const db = getBillingDb();
    const names = new Set();

    const customerRows = await dbAll(
        db,
        `SELECT DISTINCT TRIM(pppoe_username) AS u FROM customers
         WHERE tenant_id = ?
           AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''`,
        [tenantId]
    );
    for (const r of customerRows) {
        if (r.u) names.add(normalizeUsername(r.u));
    }

    const ownedRows = await dbAll(
        db,
        `SELECT DISTINCT TRIM(username) AS u FROM ${TABLE}
         WHERE tenant_id = ?
           AND username IS NOT NULL AND TRIM(username) != ''`,
        [tenantId]
    );
    for (const r of ownedRows) {
        if (r.u) names.add(normalizeUsername(r.u));
    }

    return Array.from(names);
}

async function getTenantAllowedPppoeUsernameSet() {
    const names = await getTenantAllowedPppoeUsernames();
    if (names === null) return null;
    return new Set(names.map(normalizeKey).filter(Boolean));
}

/**
 * Klaim kepemilikan user manual/gratis untuk tenant saat ini.
 * Gagal jika username sudah dimiliki tenant lain.
 */
async function claimTenantPppoeUsername(username, tenantId = null) {
    await ensureTenantPppoeUsersTable();
    const name = normalizeUsername(username);
    if (!name) throw new Error('Username PPPoE kosong');

    const tid = tenantId != null ? parseInt(tenantId, 10) : (hasTenantContext() ? getTenantId() : null);
    if (!tid) throw new Error('Konteks tenant tidak tersedia untuk klaim user PPPoE');

    const db = getBillingDb();
    const key = normalizeKey(name);

    const linkedOther = await dbGet(
        db,
        `SELECT id, tenant_id FROM customers
         WHERE LOWER(TRIM(pppoe_username)) = ?
           AND tenant_id IS NOT NULL AND tenant_id != ?
         LIMIT 1`,
        [key, tid]
    );
    if (linkedOther) {
        throw new Error(`Username "${name}" sudah dipakai pelanggan tenant lain`);
    }

    const owned = await dbGet(
        db,
        `SELECT id, tenant_id FROM ${TABLE} WHERE LOWER(TRIM(username)) = ? LIMIT 1`,
        [key]
    );
    if (owned && parseInt(owned.tenant_id, 10) !== tid) {
        throw new Error(`Username "${name}" sudah dimiliki tenant lain`);
    }
    if (owned) return { success: true, alreadyOwned: true };

    await dbRun(db, `INSERT INTO ${TABLE} (tenant_id, username) VALUES (?, ?)`, [tid, name]);
    return { success: true, claimed: true };
}

async function releaseTenantPppoeUsername(username, tenantId = null) {
    await ensureTenantPppoeUsersTable();
    const name = normalizeUsername(username);
    if (!name) return { success: true };
    const tid = tenantId != null ? parseInt(tenantId, 10) : (hasTenantContext() ? getTenantId() : null);
    if (!tid) return { success: false, message: 'No tenant context' };

    const db = getBillingDb();
    await dbRun(
        db,
        `DELETE FROM ${TABLE} WHERE tenant_id = ? AND LOWER(TRIM(username)) = ?`,
        [tid, normalizeKey(name)]
    );
    return { success: true };
}

async function renameTenantPppoeUsername(oldUsername, newUsername, tenantId = null) {
    const oldName = normalizeUsername(oldUsername);
    const newName = normalizeUsername(newUsername);
    if (!oldName || !newName || normalizeKey(oldName) === normalizeKey(newName)) {
        return { success: true };
    }
    await claimTenantPppoeUsername(newName, tenantId);
    await releaseTenantPppoeUsername(oldName, tenantId);
    return { success: true };
}

/**
 * true jika username boleh dikelola tenant saat ini (pelanggan atau owned manual).
 * Tanpa konteks tenant → true (platform/CLI).
 */
async function tenantOwnsPppoeUsername(username) {
    if (!hasTenantContext()) return true;
    const set = await getTenantAllowedPppoeUsernameSet();
    if (!set) return true;
    return set.has(normalizeKey(username));
}

/**
 * Assert ownership sebelum edit/delete. Melempar Error jika bukan milik tenant.
 */
async function assertTenantOwnsPppoeUsername(username) {
    if (!hasTenantContext()) return;
    const name = normalizeUsername(username);
    if (!name) throw new Error('Username PPPoE kosong');
    const owns = await tenantOwnsPppoeUsername(name);
    if (!owns) {
        throw new Error(`User PPPoE "${name}" tidak ditemukan atau bukan milik tenant ini`);
    }
}

module.exports = {
    ensureTenantPppoeUsersTable,
    migrateOrphanRadiusUsersOnce,
    getTenantAllowedPppoeUsernames,
    getTenantAllowedPppoeUsernameSet,
    claimTenantPppoeUsername,
    releaseTenantPppoeUsername,
    renameTenantPppoeUsername,
    tenantOwnsPppoeUsername,
    assertTenantOwnsPppoeUsername,
    normalizeUsername,
    normalizeKey
};
