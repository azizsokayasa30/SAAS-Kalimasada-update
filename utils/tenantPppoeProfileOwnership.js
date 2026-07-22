/**
 * Kepemilikan profil PPPoE RADIUS per tenant.
 *
 * FreeRADIUS (radgroupreply / pppoe_profiles) tidak punya tenant_id.
 * Isolasi di layer app via allowlist — sama pola tenant_pppoe_users.
 *
 * Uniqueness kepemilikan: UNIQUE(tenant_id, groupname).
 * Jika nama fisik sudah dipakai tenant lain, klaim otomatis memakai
 * salinan `t{tenantId}_{name}` (RADIUS group fisik tetap unik) sambil
 * menyimpan display_name sesuai nama yang diminta di UI.
 *
 * Sumber klaim:
 * - packages.pppoe_profile (tenant_id)
 * - customers.pppoe_profile (tenant_id)
 * - klaim eksplisit saat create/sync profil
 *
 * Jika beberapa tenant memakai groupname yang sama, migrasi menduplikasi
 * grup RADIUS untuk tenant sekunder agar edit tidak saling timpa.
 */

const logger = require('../config/logger');
const { getTenantId, hasTenantContext } = require('../config/platform/tenantContext');

const TABLE = 'tenant_pppoe_profiles';
const SYSTEM_PROFILES = new Set(['isolir', 'default']);
let _ensurePromise = null;
let _migratePromise = null;

function normalizeGroupname(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_');
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

/**
 * Migrasi constraint: UNIQUE(groupname) → UNIQUE(tenant_id, groupname).
 * Nama fisik RADIUS tetap diisolasi di layer klaim (auto-prefix t{tid}_)
 * agar edit antar-tenant tidak saling timpa.
 */
async function migrateTenantPppoeProfilesUniqueToTenantScoped(db) {
    const flag = await dbGet(
        db,
        `SELECT value FROM app_settings WHERE key = ? LIMIT 1`,
        ['tenant_pppoe_profiles_unique_tenant_v1']
    ).catch(() => null);
    if (flag && String(flag.value) === '1') return;

    const tableInfo = await dbAll(db, `PRAGMA table_info(${TABLE})`).catch(() => []);
    if (!tableInfo.length) return;

    const idxList = await dbAll(db, `PRAGMA index_list(${TABLE})`).catch(() => []);
    let needsRebuild = false;
    for (const idx of idxList || []) {
        if (!idx.unique) continue;
        const cols = await dbAll(db, `PRAGMA index_info(${idx.name})`).catch(() => []);
        const colNames = (cols || []).map((c) => String(c.name || '').toLowerCase());
        // Unique lama hanya di groupname (tanpa tenant_id)
        if (colNames.length === 1 && colNames[0] === 'groupname') {
            needsRebuild = true;
            break;
        }
    }

    if (needsRebuild) {
        const tmp = `${TABLE}_tenant_scoped`;
        await dbRun(db, `DROP TABLE IF EXISTS ${tmp}`);
        await dbRun(
            db,
            `CREATE TABLE ${tmp} (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id INTEGER NOT NULL,
                groupname TEXT NOT NULL,
                created_at DATETIME DEFAULT (datetime('now','localtime')),
                UNIQUE(tenant_id, groupname COLLATE NOCASE)
            )`
        );
        await dbRun(
            db,
            `INSERT INTO ${tmp} (tenant_id, groupname, created_at)
             SELECT tenant_id, groupname, COALESCE(created_at, datetime('now','localtime'))
             FROM ${TABLE}
             GROUP BY tenant_id, LOWER(TRIM(groupname))`
        );
        await dbRun(db, `DROP TABLE ${TABLE}`);
        await dbRun(db, `ALTER TABLE ${tmp} RENAME TO ${TABLE}`);
        logger.info(`[tenantPppoeProfileOwnership] Rebuilt ${TABLE} with UNIQUE(tenant_id, groupname)`);
    }

    await dbRun(
        db,
        `CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant_id ON ${TABLE}(tenant_id)`
    );
    await dbRun(
        db,
        `CREATE INDEX IF NOT EXISTS idx_${TABLE}_groupname ON ${TABLE}(groupname)`
    );

    try {
        await dbRun(
            db,
            `INSERT INTO app_settings (key, value, tenant_id) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')`,
            ['tenant_pppoe_profiles_unique_tenant_v1', '1', 1]
        );
    } catch (_) {
        await dbRun(
            db,
            `INSERT OR REPLACE INTO app_settings (key, value, tenant_id) VALUES (?, ?, ?)`,
            ['tenant_pppoe_profiles_unique_tenant_v1', '1', 1]
        ).catch(() => {});
    }
}

async function ensureTenantPppoeProfilesTable() {
    if (_ensurePromise) return _ensurePromise;
    _ensurePromise = (async () => {
        const db = getBillingDb();
        await dbRun(
            db,
            `CREATE TABLE IF NOT EXISTS ${TABLE} (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id INTEGER NOT NULL,
                groupname TEXT NOT NULL,
                created_at DATETIME DEFAULT (datetime('now','localtime')),
                UNIQUE(tenant_id, groupname COLLATE NOCASE)
            )`
        );
        await migrateTenantPppoeProfilesUniqueToTenantScoped(db);
        await dbRun(
            db,
            `CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant_id ON ${TABLE}(tenant_id)`
        );
        await dbRun(
            db,
            `CREATE INDEX IF NOT EXISTS idx_${TABLE}_groupname ON ${TABLE}(groupname)`
        );
    })().catch((err) => {
        _ensurePromise = null;
        throw err;
    });
    return _ensurePromise;
}

async function markProfilesMigrated(db) {
    try {
        await dbRun(
            db,
            `INSERT INTO app_settings (key, value, tenant_id) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')`,
            ['tenant_pppoe_profiles_migrated', '1', 1]
        );
    } catch (_) {
        try {
            await dbRun(
                db,
                `INSERT OR REPLACE INTO app_settings (key, value, tenant_id) VALUES (?, ?, ?)`,
                ['tenant_pppoe_profiles_migrated', '1', 1]
            );
        } catch (e2) {
            logger.warn(`[tenantPppoeProfileOwnership] Could not set migrate flag: ${e2.message}`);
        }
    }
}

async function cloneRadiusGroupAttributes(conn, sourceGroup, destGroup) {
    const [replyRows] = await conn.execute(
        `SELECT attribute, op, value FROM radgroupreply WHERE groupname = ?`,
        [sourceGroup]
    );
    for (const row of replyRows || []) {
        await conn.execute(
            `INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, ?, ?, ?)`,
            [destGroup, row.attribute, row.op || ':=', row.value]
        );
    }

    const [checkRows] = await conn.execute(
        `SELECT attribute, op, value FROM radgroupcheck WHERE groupname = ?`,
        [sourceGroup]
    );
    for (const row of checkRows || []) {
        await conn.execute(
            `INSERT INTO radgroupcheck (groupname, attribute, op, value) VALUES (?, ?, ?, ?)`,
            [destGroup, row.attribute, row.op || ':=', row.value]
        );
    }

    try {
        const [metaRows] = await conn.execute(
            `SELECT * FROM pppoe_profiles WHERE groupname = ? LIMIT 1`,
            [sourceGroup]
        );
        const meta = metaRows && metaRows[0];
        if (meta) {
            await conn.execute(
                `INSERT OR REPLACE INTO pppoe_profiles (
                    groupname, display_name, comment, rate_limit, local_address, remote_address,
                    dns_server, parent_queue, address_list, bridge_learning, use_mpls,
                    use_compression, use_encryption, only_one, change_tcp_mss, use_upnp,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`,
                [
                    destGroup,
                    meta.display_name || destGroup,
                    meta.comment || null,
                    meta.rate_limit || null,
                    meta.local_address || null,
                    meta.remote_address || null,
                    meta.dns_server || null,
                    meta.parent_queue || null,
                    meta.address_list || null,
                    meta.bridge_learning || 'default',
                    meta.use_mpls || 'default',
                    meta.use_compression || 'default',
                    meta.use_encryption || 'default',
                    meta.only_one || 'default',
                    meta.change_tcp_mss || 'default',
                    meta.use_upnp || 'default'
                ]
            );
        }
    } catch (metaErr) {
        logger.warn(`[tenantPppoeProfileOwnership] Clone metadata skip: ${metaErr.message}`);
    }
}

async function remountTenantUsersToGroup(conn, tenantId, oldGroup, newGroup) {
    const db = getBillingDb();
    const userRows = await dbAll(
        db,
        `SELECT DISTINCT TRIM(pppoe_username) AS u FROM customers
         WHERE tenant_id = ?
           AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''`,
        [tenantId]
    );
    const usernames = (userRows || []).map((r) => String(r.u || '').trim()).filter(Boolean);
    if (!usernames.length) return 0;

    let updated = 0;
    const chunkSize = 200;
    for (let i = 0; i < usernames.length; i += chunkSize) {
        const chunk = usernames.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        const [result] = await conn.execute(
            `UPDATE radusergroup SET groupname = ?
             WHERE groupname = ? AND username IN (${placeholders})`,
            [newGroup, oldGroup, ...chunk]
        );
        updated += result?.affectedRows || result?.changes || 0;
    }
    return updated;
}

async function updateTenantProfileReferences(tenantId, oldGroup, newGroup) {
    const db = getBillingDb();
    await dbRun(
        db,
        `UPDATE packages SET pppoe_profile = ?
         WHERE tenant_id = ? AND LOWER(TRIM(REPLACE(pppoe_profile, ' ', '_'))) = ?`,
        [newGroup, tenantId, oldGroup]
    );
    await dbRun(
        db,
        `UPDATE customers SET pppoe_profile = ?
         WHERE tenant_id = ? AND LOWER(TRIM(REPLACE(pppoe_profile, ' ', '_'))) = ?`,
        [newGroup, tenantId, oldGroup]
    );
}

/**
 * Migrasi sekali: klaim profil dari packages/customers; duplikasi RADIUS jika bentrok antar tenant.
 */
async function migrateTenantPppoeProfilesOnce() {
    if (_migratePromise) return _migratePromise;
    _migratePromise = (async () => {
        await ensureTenantPppoeProfilesTable();
        const db = getBillingDb();

        const flag = await dbGet(
            db,
            `SELECT value FROM app_settings WHERE key = ? LIMIT 1`,
            ['tenant_pppoe_profiles_migrated']
        ).catch(() => null);
        if (flag && String(flag.value) === '1') return { skipped: true };

        const pkgRows = await dbAll(
            db,
            `SELECT tenant_id, LOWER(TRIM(REPLACE(pppoe_profile, ' ', '_'))) AS g, COUNT(*) AS cnt
             FROM packages
             WHERE tenant_id IS NOT NULL
               AND pppoe_profile IS NOT NULL AND TRIM(pppoe_profile) != ''
             GROUP BY tenant_id, g`
        );
        const custRows = await dbAll(
            db,
            `SELECT tenant_id, LOWER(TRIM(REPLACE(pppoe_profile, ' ', '_'))) AS g, COUNT(*) AS cnt
             FROM customers
             WHERE tenant_id IS NOT NULL
               AND pppoe_profile IS NOT NULL AND TRIM(pppoe_profile) != ''
             GROUP BY tenant_id, g`
        );

        /** @type {Map<string, Map<number, number>>} */
        const usage = new Map();
        const addUsage = (rows) => {
            for (const r of rows || []) {
                const g = normalizeGroupname(r.g);
                const tid = parseInt(r.tenant_id, 10);
                if (!g || !tid || SYSTEM_PROFILES.has(g)) continue;
                if (!usage.has(g)) usage.set(g, new Map());
                const m = usage.get(g);
                m.set(tid, (m.get(tid) || 0) + (parseInt(r.cnt, 10) || 0));
            }
        };
        addUsage(pkgRows);
        addUsage(custRows);

        let claimed = 0;
        let cloned = 0;
        let radiusConn = null;

        try {
            const { getRadiusConnection } = require('../config/radiusSQLite');
            radiusConn = await getRadiusConnection();
        } catch (err) {
            logger.warn(`[tenantPppoeProfileOwnership] RADIUS unavailable for migrate: ${err.message}`);
        }

        try {
            for (const [groupname, tenantMap] of usage.entries()) {
                const ranked = Array.from(tenantMap.entries()).sort((a, b) => b[1] - a[1]);
                if (!ranked.length) continue;

                const [primaryTenantId] = ranked[0];
                const existing = await dbGet(
                    db,
                    `SELECT id, tenant_id FROM ${TABLE} WHERE LOWER(TRIM(groupname)) = ? LIMIT 1`,
                    [groupname]
                );

                if (!existing) {
                    await dbRun(
                        db,
                        `INSERT INTO ${TABLE} (tenant_id, groupname) VALUES (?, ?)`,
                        [primaryTenantId, groupname]
                    );
                    claimed += 1;
                }

                const ownerId = existing
                    ? parseInt(existing.tenant_id, 10)
                    : primaryTenantId;

                for (const [tenantId] of ranked) {
                    if (tenantId === ownerId) continue;

                    const privateName = `t${tenantId}_${groupname}`;
                    const already = await dbGet(
                        db,
                        `SELECT id FROM ${TABLE} WHERE LOWER(TRIM(groupname)) = ? LIMIT 1`,
                        [privateName]
                    );
                    if (already) {
                        await updateTenantProfileReferences(tenantId, groupname, privateName);
                        continue;
                    }

                    if (radiusConn) {
                        try {
                            const [existsDest] = await radiusConn.execute(
                                `SELECT COUNT(*) AS c FROM radgroupreply WHERE groupname = ?`,
                                [privateName]
                            );
                            const destCount = existsDest && existsDest[0] ? existsDest[0].c : 0;
                            if (!destCount) {
                                await cloneRadiusGroupAttributes(radiusConn, groupname, privateName);
                            }
                            await remountTenantUsersToGroup(radiusConn, tenantId, groupname, privateName);
                        } catch (cloneErr) {
                            logger.warn(
                                `[tenantPppoeProfileOwnership] Clone ${groupname}→${privateName}: ${cloneErr.message}`
                            );
                        }
                    }

                    try {
                        await dbRun(
                            db,
                            `INSERT INTO ${TABLE} (tenant_id, groupname) VALUES (?, ?)`,
                            [tenantId, privateName]
                        );
                        claimed += 1;
                        cloned += 1;
                    } catch (insErr) {
                        if (!String(insErr.message || '').includes('UNIQUE')) {
                            logger.warn(`[tenantPppoeProfileOwnership] Claim ${privateName}: ${insErr.message}`);
                        }
                    }

                    await updateTenantProfileReferences(tenantId, groupname, privateName);
                    logger.info(
                        `[tenantPppoeProfileOwnership] Isolated "${groupname}" for tenant ${tenantId} → "${privateName}"`
                    );
                }
            }

            // Klaim orphan groupname di RADIUS ke tenant dengan pelanggan PPPoE terbanyak
            if (radiusConn) {
                try {
                    const [radiusGroups] = await radiusConn.execute(
                        `SELECT DISTINCT TRIM(groupname) AS g FROM radgroupreply
                         WHERE groupname IS NOT NULL AND TRIM(groupname) != ''`
                    );
                    const ownerRow = await dbGet(
                        db,
                        `SELECT tenant_id, COUNT(*) AS cnt FROM customers
                         WHERE tenant_id IS NOT NULL
                           AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''
                         GROUP BY tenant_id
                         ORDER BY cnt DESC
                         LIMIT 1`
                    );
                    const orphanOwner = ownerRow ? parseInt(ownerRow.tenant_id, 10) : null;
                    if (orphanOwner) {
                        for (const row of radiusGroups || []) {
                            const g = normalizeGroupname(row.g);
                            if (!g || SYSTEM_PROFILES.has(g)) continue;
                            const owned = await dbGet(
                                db,
                                `SELECT id FROM ${TABLE} WHERE LOWER(TRIM(groupname)) = ? LIMIT 1`,
                                [g]
                            );
                            if (owned) continue;
                            // Skip jika jelas profil hotspot
                            try {
                                const [hs] = await radiusConn.execute(
                                    `SELECT 1 FROM hotspot_profiles WHERE groupname = ? LIMIT 1`,
                                    [g]
                                );
                                if (hs && hs.length) continue;
                            } catch (_) {}
                            await dbRun(
                                db,
                                `INSERT INTO ${TABLE} (tenant_id, groupname) VALUES (?, ?)`,
                                [orphanOwner, g]
                            );
                            claimed += 1;
                        }
                    }
                } catch (orphanErr) {
                    logger.warn(`[tenantPppoeProfileOwnership] Orphan claim: ${orphanErr.message}`);
                }
            }
        } finally {
            if (radiusConn && typeof radiusConn.end === 'function') {
                try {
                    await radiusConn.end();
                } catch (_) {}
            }
        }

        await markProfilesMigrated(db);
        logger.info(
            `[tenantPppoeProfileOwnership] Migrated profiles: claimed=${claimed}, cloned=${cloned}`
        );
        return { claimed, cloned };
    })().catch((err) => {
        _migratePromise = null;
        logger.error(`[tenantPppoeProfileOwnership] Migrate failed: ${err.message}`);
        throw err;
    });
    return _migratePromise;
}

/**
 * null = tanpa konteks tenant (jangan filter).
 * [] = tenant tanpa profil (hanya tampilkan isolir di UI).
 */
/**
 * Bersihkan dual-ownership per tenant: bare + underscore + t{tid}_ untuk logical name yang sama.
 * Juga hapus grup RADIUS yatim (tidak ada owner, tidak ada user) hasil clone/duplikat.
 */
let _dedupePromise = null;
async function dedupeTenantPppoeProfileOwnershipOnce() {
    if (_dedupePromise) return _dedupePromise;
    _dedupePromise = (async () => {
        await ensureTenantPppoeProfilesTable();
        const db = getBillingDb();

        const flag = await dbGet(
            db,
            `SELECT value FROM app_settings WHERE key = ? LIMIT 1`,
            ['tenant_pppoe_profiles_deduped_v1']
        ).catch(() => null);
        if (flag && String(flag.value) === '1') return { skipped: true };

        const ownedRows = await dbAll(
            db,
            `SELECT id, tenant_id, TRIM(groupname) AS groupname FROM ${TABLE}
             WHERE groupname IS NOT NULL AND TRIM(groupname) != ''`
        );

        /** @type {Map<number, Map<string, Array<{id:number, groupname:string}>>>} */
        const byTenantLogical = new Map();
        for (const row of ownedRows || []) {
            const tid = parseInt(row.tenant_id, 10);
            const physical = String(row.groupname || '').trim();
            if (!tid || !physical || SYSTEM_PROFILES.has(normalizeGroupname(physical))) continue;
            const logical = stripTenantProfilePrefix(normalizeGroupname(physical), tid);
            if (!logical) continue;
            if (!byTenantLogical.has(tid)) byTenantLogical.set(tid, new Map());
            const m = byTenantLogical.get(tid);
            if (!m.has(logical)) m.set(logical, []);
            m.get(logical).push({ id: row.id, groupname: physical });
        }

        let released = 0;
        const releasedNames = []; // {tid, groupname}

        for (const [tid, logicalMap] of byTenantLogical) {
            const refRows = await dbAll(
                db,
                `SELECT DISTINCT TRIM(pppoe_profile) AS p FROM packages
                 WHERE tenant_id = ? AND pppoe_profile IS NOT NULL AND TRIM(pppoe_profile) != ''
                 UNION
                 SELECT DISTINCT TRIM(pppoe_profile) AS p FROM customers
                 WHERE tenant_id = ? AND pppoe_profile IS NOT NULL AND TRIM(pppoe_profile) != ''`,
                [tid, tid]
            );
            const exactRefs = new Set(
                (refRows || []).map((r) => String(r.p || '').trim()).filter(Boolean)
            );
            const normRefs = new Set(
                [...exactRefs].map((p) => normalizeGroupname(p)).filter(Boolean)
            );

            for (const [, candidates] of logicalMap) {
                if (candidates.length < 2) continue;

                const pick = () => {
                    for (const c of candidates) {
                        if (exactRefs.has(c.groupname)) return c;
                    }
                    const normHits = candidates.filter((c) =>
                        normRefs.has(normalizeGroupname(c.groupname))
                    );
                    const pool0 = normHits.length ? normHits : candidates;
                    const prefix = `t${tid}_`;
                    const bare = pool0.filter(
                        (c) => !normalizeGroupname(c.groupname).startsWith(prefix)
                    );
                    const pool1 = bare.length ? bare : pool0;
                    const spaced = pool1.filter((c) => String(c.groupname).includes(' '));
                    const pool = spaced.length ? spaced : pool1;
                    pool.sort((a, b) =>
                        String(a.groupname).localeCompare(String(b.groupname))
                    );
                    return pool[0];
                };

                const keeper = pick();
                for (const c of candidates) {
                    if (c.id === keeper.id) continue;
                    await dbRun(db, `DELETE FROM ${TABLE} WHERE id = ?`, [c.id]);
                    released += 1;
                    releasedNames.push({ tid, groupname: c.groupname });
                    logger.info(
                        `[tenantPppoeProfileOwnership] Dedupe tenant ${tid}: keep "${keeper.groupname}" release "${c.groupname}"`
                    );
                }
            }
        }

        // Hapus grup RADIUS yatim: tidak ada owner, tidak ada radusergroup
        let radiusDeleted = 0;
        let radiusConn = null;
        try {
            const { getRadiusConnection } = require('../config/radiusSQLite');
            radiusConn = await getRadiusConnection();

            const candidatesToMaybeDelete = new Set();
            for (const r of releasedNames) {
                candidatesToMaybeDelete.add(r.groupname);
            }
            // Juga orphan t{tid}_* / underscore duplikat yang tidak punya ownership
            const [allGroups] = await radiusConn.execute(
                `SELECT DISTINCT groupname FROM radgroupreply
                 WHERE groupname IS NOT NULL AND TRIM(groupname) != ''`
            );
            for (const row of allGroups || []) {
                const gn = String(row.groupname || '').trim();
                if (!gn || SYSTEM_PROFILES.has(normalizeGroupname(gn))) continue;
                // Hanya kandidat yang terlihat seperti duplikat isolasi / underscore
                if (/^t\d+_/i.test(gn) || (gn === normalizeGroupname(gn) && gn.includes('_mbps'))) {
                    candidatesToMaybeDelete.add(gn);
                }
            }

            for (const gn of candidatesToMaybeDelete) {
                const stillOwned = await dbGet(
                    db,
                    `SELECT id FROM ${TABLE} WHERE LOWER(TRIM(groupname)) = ? LIMIT 1`,
                    [normalizeGroupname(gn)]
                );
                // Juga cek exact (bisa beda spasi)
                const stillOwnedExact = stillOwned
                    ? stillOwned
                    : await dbGet(
                          db,
                          `SELECT id FROM ${TABLE} WHERE TRIM(groupname) = ? LIMIT 1`,
                          [gn]
                      );
                if (stillOwnedExact) continue;

                const [userRows] = await radiusConn.execute(
                    `SELECT COUNT(*) AS c FROM radusergroup WHERE groupname = ?`,
                    [gn]
                );
                const userCount = userRows && userRows[0] ? Number(userRows[0].c) || 0 : 0;
                if (userCount > 0) continue;

                // Jangan hapus nama "Profil X Mbps" (shared legacy) — hanya clone/underscore
                const norm = normalizeGroupname(gn);
                const isIsolated = /^t\d+_/i.test(norm);
                const isUnderscoreDup =
                    gn === norm && (norm.includes('_mbps') || norm.startsWith('profil_'));
                if (!isIsolated && !isUnderscoreDup) continue;

                await radiusConn.execute(`DELETE FROM radgroupreply WHERE groupname = ?`, [gn]);
                await radiusConn.execute(`DELETE FROM radgroupcheck WHERE groupname = ?`, [gn]);
                try {
                    await radiusConn.execute(`DELETE FROM pppoe_profiles WHERE groupname = ?`, [gn]);
                } catch (_) {}
                radiusDeleted += 1;
                logger.info(
                    `[tenantPppoeProfileOwnership] Deleted orphan RADIUS profile "${gn}"`
                );
            }
        } catch (radiusErr) {
            logger.warn(
                `[tenantPppoeProfileOwnership] RADIUS orphan cleanup skip: ${radiusErr.message}`
            );
        } finally {
            if (radiusConn && typeof radiusConn.end === 'function') {
                try {
                    await radiusConn.end();
                } catch (_) {}
            }
        }

        try {
            await dbRun(
                db,
                `INSERT INTO app_settings (key, value, tenant_id) VALUES (?, ?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')`,
                ['tenant_pppoe_profiles_deduped_v1', '1', 1]
            );
        } catch (_) {
            await dbRun(
                db,
                `INSERT OR REPLACE INTO app_settings (key, value, tenant_id) VALUES (?, ?, ?)`,
                ['tenant_pppoe_profiles_deduped_v1', '1', 1]
            ).catch(() => {});
        }

        logger.info(
            `[tenantPppoeProfileOwnership] Dedupe done: released=${released}, radiusDeleted=${radiusDeleted}`
        );
        return { released, radiusDeleted };
    })().catch((err) => {
        _dedupePromise = null;
        logger.error(`[tenantPppoeProfileOwnership] Dedupe failed: ${err.message}`);
        throw err;
    });
    return _dedupePromise;
}

async function getTenantAllowedPppoeProfiles() {
    await ensureTenantPppoeProfilesTable();
    await migrateTenantPppoeProfilesOnce().catch(() => {});
    await dedupeTenantPppoeProfileOwnershipOnce().catch(() => {});

    if (!hasTenantContext()) return null;

    const tenantId = getTenantId();
    const db = getBillingDb();
    const names = new Set();

    const owned = await dbAll(
        db,
        `SELECT DISTINCT TRIM(groupname) AS g FROM ${TABLE}
         WHERE tenant_id = ?
           AND groupname IS NOT NULL AND TRIM(groupname) != ''`,
        [tenantId]
    );
    for (const r of owned) {
        const g = normalizeGroupname(r.g);
        if (g) names.add(g);
    }

    // Juga sertakan nama yang masih direferensikan paket/pelanggan tenant ini
    // (jika migrasi rename belum sempat — agar dropdown tidak kosong).
    const refs = await dbAll(
        db,
        `SELECT DISTINCT LOWER(TRIM(REPLACE(pppoe_profile, ' ', '_'))) AS g FROM packages
         WHERE tenant_id = ? AND pppoe_profile IS NOT NULL AND TRIM(pppoe_profile) != ''
         UNION
         SELECT DISTINCT LOWER(TRIM(REPLACE(pppoe_profile, ' ', '_'))) AS g FROM customers
         WHERE tenant_id = ? AND pppoe_profile IS NOT NULL AND TRIM(pppoe_profile) != ''`,
        [tenantId, tenantId]
    );
    for (const r of refs) {
        const g = normalizeGroupname(r.g);
        if (!g || SYSTEM_PROFILES.has(g)) continue;
        const owner = await dbGet(
            db,
            `SELECT tenant_id FROM ${TABLE}
             WHERE LOWER(TRIM(groupname)) = ?
             ORDER BY CASE WHEN tenant_id = ? THEN 0 ELSE 1 END
             LIMIT 1`,
            [g, tenantId]
        );
        if (!owner || parseInt(owner.tenant_id, 10) === tenantId) {
            names.add(g);
            if (!owner) {
                try {
                    await dbRun(
                        db,
                        `INSERT INTO ${TABLE} (tenant_id, groupname) VALUES (?, ?)`,
                        [tenantId, g]
                    );
                } catch (_) {}
            }
        }
    }

    return Array.from(names);
}

async function getTenantAllowedPppoeProfileSet() {
    const names = await getTenantAllowedPppoeProfiles();
    if (names === null) return null;
    return new Set(names.map(normalizeGroupname).filter(Boolean));
}

function stripTenantProfilePrefix(groupname, tenantId) {
    const name = normalizeGroupname(groupname);
    const tid = tenantId != null ? parseInt(tenantId, 10) : null;
    if (!name || !tid) return name;
    const prefix = `t${tid}_`;
    if (name.startsWith(prefix) && name.length > prefix.length) {
        return name.slice(prefix.length);
    }
    return name;
}

async function claimTenantPppoeProfile(groupname, tenantId = null) {
    await ensureTenantPppoeProfilesTable();
    const name = normalizeGroupname(groupname);
    if (!name) throw new Error('Nama profil PPPoE kosong');
    if (SYSTEM_PROFILES.has(name)) {
        return { success: true, system: true, groupname: name };
    }

    const tid = tenantId != null ? parseInt(tenantId, 10) : hasTenantContext() ? getTenantId() : null;
    if (!tid) throw new Error('Konteks tenant tidak tersedia untuk klaim profil PPPoE');

    const db = getBillingDb();

    // Sudah milik tenant ini (nama fisik sama)
    const ownedByMe = await dbGet(
        db,
        `SELECT id FROM ${TABLE} WHERE tenant_id = ? AND LOWER(TRIM(groupname)) = ? LIMIT 1`,
        [tid, name]
    );
    if (ownedByMe) {
        return { success: true, alreadyOwned: true, groupname: name };
    }

    // Tenant lain memakai nama fisik yang sama di RADIUS → isolasi otomatis
    // (FreeRADIUS tidak punya tenant_id; groupname fisik harus unik)
    const ownedByOther = await dbGet(
        db,
        `SELECT id, tenant_id FROM ${TABLE}
         WHERE LOWER(TRIM(groupname)) = ? AND tenant_id != ?
         LIMIT 1`,
        [name, tid]
    );

    let claimName = name;
    let isolated = false;
    if (ownedByOther) {
        claimName = normalizeGroupname(`t${tid}_${name}`);
        isolated = true;
        if (claimName === name) {
            // Nama sudah ber-prefix tenant ini — klaim apa adanya
            isolated = false;
        } else {
            const alreadyPrivate = await dbGet(
                db,
                `SELECT id FROM ${TABLE} WHERE tenant_id = ? AND LOWER(TRIM(groupname)) = ? LIMIT 1`,
                [tid, claimName]
            );
            if (alreadyPrivate) {
                return {
                    success: true,
                    alreadyOwned: true,
                    groupname: claimName,
                    isolated: true,
                    logicalName: name
                };
            }
        }
    }

    try {
        await dbRun(db, `INSERT INTO ${TABLE} (tenant_id, groupname) VALUES (?, ?)`, [tid, claimName]);
    } catch (insErr) {
        const msg = String(insErr.message || '');
        if (msg.includes('UNIQUE')) {
            const again = await dbGet(
                db,
                `SELECT tenant_id FROM ${TABLE} WHERE LOWER(TRIM(groupname)) = ? LIMIT 1`,
                [claimName]
            );
            if (again && parseInt(again.tenant_id, 10) === tid) {
                return {
                    success: true,
                    alreadyOwned: true,
                    groupname: claimName,
                    isolated,
                    logicalName: isolated ? name : undefined
                };
            }
            // Race / sisa unique global: isolasi ke nama privat
            if (!isolated) {
                return claimTenantPppoeProfile(`t${tid}_${name}`, tid).then((r) => ({
                    ...r,
                    isolated: true,
                    logicalName: name
                }));
            }
        }
        throw insErr;
    }

    if (isolated) {
        logger.info(
            `[tenantPppoeProfileOwnership] Auto-isolated claim for tenant ${tid}: "${name}" → "${claimName}"`
        );
    }
    return {
        success: true,
        claimed: true,
        groupname: claimName,
        isolated,
        logicalName: isolated ? name : undefined
    };
}

async function releaseTenantPppoeProfile(groupname, tenantId = null) {
    await ensureTenantPppoeProfilesTable();
    const name = normalizeGroupname(groupname);
    if (!name || SYSTEM_PROFILES.has(name)) return { success: true };
    const tid = tenantId != null ? parseInt(tenantId, 10) : hasTenantContext() ? getTenantId() : null;
    if (!tid) return { success: false, message: 'No tenant context' };

    const db = getBillingDb();
    await dbRun(
        db,
        `DELETE FROM ${TABLE} WHERE tenant_id = ? AND LOWER(TRIM(groupname)) = ?`,
        [tid, name]
    );
    return { success: true };
}

async function renameTenantPppoeProfile(oldName, newName, tenantId = null) {
    const oldG = normalizeGroupname(oldName);
    const newG = normalizeGroupname(newName);
    if (!oldG || !newG || oldG === newG) {
        return { success: true, groupname: oldG || newG };
    }

    const tid = tenantId != null ? parseInt(tenantId, 10) : hasTenantContext() ? getTenantId() : null;

    // Profil fisik sudah terisolasi (t{tid}_nama) — nama di form adalah nama logis yang sama
    if (tid && stripTenantProfilePrefix(oldG, tid) === newG) {
        return {
            success: true,
            groupname: oldG,
            displayOnly: true,
            logicalName: newG
        };
    }

    if (tid) {
        await ensureTenantPppoeProfilesTable();
        const db = getBillingDb();

        // Target nama fisik sudah dipakai profil LAIN milik tenant ini
        const existingMine = await dbGet(
            db,
            `SELECT id FROM ${TABLE} WHERE tenant_id = ? AND LOWER(TRIM(groupname)) = ? LIMIT 1`,
            [tid, newG]
        );
        if (existingMine) {
            // Jangan gagalkan edit: pertahankan groupname fisik, UI pakai display_name
            return {
                success: true,
                groupname: oldG,
                displayOnly: true,
                logicalName: newG,
                conflict: 'same_tenant'
            };
        }

        // Bentuk terisolasi sudah ada (profil lain) → juga display-only
        const privateName = normalizeGroupname(`t${tid}_${newG}`);
        if (privateName !== newG && privateName !== oldG) {
            const existingPrivate = await dbGet(
                db,
                `SELECT id FROM ${TABLE} WHERE tenant_id = ? AND LOWER(TRIM(groupname)) = ? LIMIT 1`,
                [tid, privateName]
            );
            if (existingPrivate) {
                return {
                    success: true,
                    groupname: oldG,
                    displayOnly: true,
                    logicalName: newG,
                    conflict: 'same_tenant_isolated'
                };
            }
        }
    }

    const claim = await claimTenantPppoeProfile(newG, tenantId);
    const actualNew = normalizeGroupname(claim.groupname || newG);

    // Klaim mengarah ke nama fisik yang sama dengan profil yang sedang diedit → tidak perlu rename
    if (!actualNew || actualNew === oldG) {
        return {
            success: true,
            groupname: oldG,
            displayOnly: true,
            isolated: !!claim.isolated,
            logicalName: claim.logicalName || newG
        };
    }

    // Auto-isolasi kena profil lain yang sudah ada → jangan timpa; update display saja
    if (claim.alreadyOwned && claim.isolated) {
        return {
            success: true,
            groupname: oldG,
            displayOnly: true,
            logicalName: newG,
            conflict: 'isolated_exists'
        };
    }

    await releaseTenantPppoeProfile(oldG, tenantId);
    if (tid) {
        await updateTenantProfileReferences(tid, oldG, actualNew);
    }
    return {
        success: true,
        groupname: actualNew,
        isolated: !!claim.isolated,
        logicalName: claim.logicalName || newG
    };
}

async function tenantOwnsPppoeProfile(groupname) {
    if (!hasTenantContext()) return true;
    const name = normalizeGroupname(groupname);
    if (!name) return false;
    if (SYSTEM_PROFILES.has(name)) return true;
    const set = await getTenantAllowedPppoeProfileSet();
    if (!set) return true;
    return set.has(name);
}

async function assertTenantOwnsPppoeProfile(groupname) {
    if (!hasTenantContext()) return;
    const name = normalizeGroupname(groupname);
    if (!name) throw new Error('Nama profil PPPoE kosong');
    if (SYSTEM_PROFILES.has(name)) return;
    const owns = await tenantOwnsPppoeProfile(name);
    if (!owns) {
        throw new Error(`Profil PPPoE "${name}" tidak ditemukan atau bukan milik tenant ini`);
    }
}

/**
 * Pastikan tenant punya salinan eksklusif sebelum mutate RADIUS.
 * Jika tenant lain masih mereferensikan groupname yang sama → clone.
 */
async function ensureExclusivePppoeProfileForTenant(groupname, tenantId = null) {
    await ensureTenantPppoeProfilesTable();
    const name = normalizeGroupname(groupname);
    if (!name || SYSTEM_PROFILES.has(name)) return { groupname: name, cloned: false };

    const tid = tenantId != null ? parseInt(tenantId, 10) : hasTenantContext() ? getTenantId() : null;
    if (!tid) return { groupname: name, cloned: false };

    const db = getBillingDb();
    const ownedByMe = await dbGet(
        db,
        `SELECT tenant_id FROM ${TABLE} WHERE tenant_id = ? AND LOWER(TRIM(groupname)) = ? LIMIT 1`,
        [tid, name]
    );
    const ownedByOther = await dbGet(
        db,
        `SELECT tenant_id FROM ${TABLE}
         WHERE LOWER(TRIM(groupname)) = ? AND tenant_id != ?
         LIMIT 1`,
        [name, tid]
    );

    if (ownedByMe && !ownedByOther) {
        // Cek apakah tenant lain masih mereferensikan nama yang sama di paket/pelanggan
        const otherRef = await dbGet(
            db,
            `SELECT tenant_id FROM packages
             WHERE tenant_id IS NOT NULL AND tenant_id != ?
               AND LOWER(TRIM(REPLACE(pppoe_profile, ' ', '_'))) = ?
             LIMIT 1`,
            [tid, name]
        );
        const otherCust = otherRef
            ? otherRef
            : await dbGet(
                  db,
                  `SELECT tenant_id FROM customers
                   WHERE tenant_id IS NOT NULL AND tenant_id != ?
                     AND LOWER(TRIM(REPLACE(pppoe_profile, ' ', '_'))) = ?
                   LIMIT 1`,
                  [tid, name]
              );
        if (!otherCust && !otherRef) {
            return { groupname: name, cloned: false };
        }
    } else if (ownedByOther) {
        // Sudah milik tenant lain — wajib pakai nama privat
    } else if (!ownedByMe) {
        // Belum ada owner untuk tenant ini — klaim (auto-isolate jika bentrok)
        const otherRef = await dbGet(
            db,
            `SELECT tenant_id FROM packages
             WHERE tenant_id IS NOT NULL AND tenant_id != ?
               AND LOWER(TRIM(REPLACE(pppoe_profile, ' ', '_'))) = ?
             LIMIT 1`,
            [tid, name]
        );
        if (!otherRef) {
            const claim = await claimTenantPppoeProfile(name, tid);
            return {
                groupname: claim.groupname || name,
                cloned: !!claim.isolated,
                from: claim.isolated ? name : undefined
            };
        }
    }

    const privateName = normalizeGroupname(`t${tid}_${name}`);
    if (privateName === name) {
        const claim = await claimTenantPppoeProfile(name, tid);
        return { groupname: claim.groupname || name, cloned: false };
    }

    let radiusConn = null;
    try {
        const { getRadiusConnection } = require('../config/radiusSQLite');
        radiusConn = await getRadiusConnection();
        const [existsDest] = await radiusConn.execute(
            `SELECT COUNT(*) AS c FROM radgroupreply WHERE groupname = ?`,
            [privateName]
        );
        if (!(existsDest && existsDest[0] && existsDest[0].c > 0)) {
            await cloneRadiusGroupAttributes(radiusConn, name, privateName);
        }
        await remountTenantUsersToGroup(radiusConn, tid, name, privateName);
    } finally {
        if (radiusConn && typeof radiusConn.end === 'function') {
            try {
                await radiusConn.end();
            } catch (_) {}
        }
    }

    await claimTenantPppoeProfile(privateName, tid);
    // Lepas klaim nama bersama agar dropdown/list tidak menampilkan ganda
    // (bare + t{tid}_…) untuk tenant yang sama.
    if (privateName !== name) {
        await releaseTenantPppoeProfile(name, tid);
    }
    await updateTenantProfileReferences(tid, name, privateName);
    logger.info(
        `[tenantPppoeProfileOwnership] Exclusive copy for tenant ${tid}: ${name} → ${privateName}`
    );
    return { groupname: privateName, cloned: true, from: name };
}

/**
 * Update radusergroup hanya untuk username milik tenant (saat rename profil).
 */
async function remountTenantRadusergroupOnRename(oldGroupname, newGroupname, tenantId = null) {
    const oldG = normalizeGroupname(oldGroupname);
    const newG = normalizeGroupname(newGroupname);
    if (!oldG || !newG || oldG === newG) return { updated: 0 };

    const tid = tenantId != null ? parseInt(tenantId, 10) : hasTenantContext() ? getTenantId() : null;
    if (!tid) {
        // Tanpa tenant: perilaku lama berbahaya — jangan update global dari sini
        return { updated: 0, skipped: true };
    }

    let conn = null;
    try {
        const { getRadiusConnection } = require('../config/radiusSQLite');
        conn = await getRadiusConnection();
        const updated = await remountTenantUsersToGroup(conn, tid, oldG, newG);
        // Juga coba nama fisik lama dengan spasi (Profil 50 Mbps)
        if (oldGroupname && normalizeGroupname(oldGroupname) !== String(oldGroupname).trim()) {
            const extra = await remountTenantUsersToGroup(conn, tid, String(oldGroupname).trim(), newG);
            return { updated: updated + extra };
        }
        return { updated };
    } finally {
        if (conn && typeof conn.end === 'function') {
            try {
                await conn.end();
            } catch (_) {}
        }
    }
}

/**
 * Ambil angka Mbps dari string profil/speed (Profil 50 Mbps, 50Mbps/50Mbps, profile-10mbps, …).
 */
function extractSpeedMbps(text) {
    const s = String(text || '');
    const m =
        s.match(/(?:profil|profile)[_\s-]*(\d+)\s*[_\s-]*mbps/i) ||
        s.match(/(\d+)\s*mbps\s*\/\s*\d+\s*mbps/i) ||
        s.match(/(\d+)\s*m\s*\/\s*\d+\s*m\b/i) ||
        s.match(/(\d+)\s*mbps/i) ||
        s.match(/(\d+)\s*[mM]\b/);
    return m ? String(parseInt(m[1], 10)) : null;
}

/**
 * Canonical fisik: t{tenantId}_profil_{N}_mbps atau t{tenantId}_gratis.
 * Return null untuk isolir / kosong / default tanpa hint speed.
 */
function toCanonicalTenantPppoeProfile(tenantId, profileName, speedHint = null) {
    const tid = parseInt(tenantId, 10);
    if (!Number.isFinite(tid) || tid <= 0) return null;
    const raw = String(profileName || '').trim();
    if (!raw) return null;

    const norm = normalizeGroupname(raw);
    if (norm === 'isolir') return null;

    const prefix = `t${tid}_`;
    if (norm === 'default') {
        const sp = extractSpeedMbps(speedHint);
        return sp ? `${prefix}profil_${sp}_mbps` : null;
    }

    // Sudah canonical milik tenant ini
    if (norm.startsWith(prefix)) {
        const restOwn = norm.slice(prefix.length);
        if (restOwn === 'gratis' || restOwn === 'free') return `${prefix}gratis`;
        const spOwn = extractSpeedMbps(restOwn);
        if (spOwn) return `${prefix}profil_${spOwn}_mbps`;
        return norm;
    }

    // Buang prefix tenant lain / prefix generik
    let rest = norm.replace(/^t\d+_/, '');
    if (rest === 'gratis' || rest === 'free') return `${prefix}gratis`;

    const sp =
        extractSpeedMbps(rest) ||
        extractSpeedMbps(raw) ||
        extractSpeedMbps(speedHint);
    if (sp) return `${prefix}profil_${sp}_mbps`;

    return `${prefix}${rest}`;
}

async function findRadiusGroupPhysicalName(conn, candidates) {
    for (const c of candidates) {
        if (!c) continue;
        const [exact] = await conn.execute(
            `SELECT groupname FROM radgroupreply WHERE groupname = ? LIMIT 1`,
            [c]
        );
        if (exact && exact[0] && exact[0].groupname) return String(exact[0].groupname);

        const norm = normalizeGroupname(c);
        const [fuzzy] = await conn.execute(
            `SELECT groupname FROM radgroupreply
             WHERE LOWER(TRIM(REPLACE(groupname, ' ', '_'))) = ?
             LIMIT 1`,
            [norm]
        );
        if (fuzzy && fuzzy[0] && fuzzy[0].groupname) return String(fuzzy[0].groupname);
    }
    return null;
}

/**
 * Seragamkan nama profil ke t{tenantId}_profil_* (dan t*_gratis) untuk satu/semua tenant.
 * Update packages + customers + clone/remount RADIUS.
 *
 * @param {{ tenantId?: number|null }} options - null/omit = semua tenant
 */
async function standardizeTenantPppoeProfileNames(options = {}) {
    await ensureTenantPppoeProfilesTable();
    const db = getBillingDb();
    const onlyTid =
        options.tenantId != null && Number.isFinite(Number(options.tenantId))
            ? parseInt(options.tenantId, 10)
            : null;

    const packages = await dbAll(
        db,
        onlyTid
            ? `SELECT id, tenant_id, name, speed, pppoe_profile FROM packages
               WHERE tenant_id = ? AND pppoe_profile IS NOT NULL AND TRIM(pppoe_profile) != ''`
            : `SELECT id, tenant_id, name, speed, pppoe_profile FROM packages
               WHERE tenant_id IS NOT NULL AND pppoe_profile IS NOT NULL AND TRIM(pppoe_profile) != ''`,
        onlyTid ? [onlyTid] : []
    );

    /** @type {Map<string, { tenantId: number, from: string, to: string, packageIds: number[] }>} */
    const renames = new Map();
    for (const pkg of packages || []) {
        const tid = parseInt(pkg.tenant_id, 10);
        if (!tid) continue;
        const fromRaw = String(pkg.pppoe_profile || '').trim();
        const to = toCanonicalTenantPppoeProfile(tid, fromRaw, pkg.speed);
        if (!to) continue;
        const fromNorm = normalizeGroupname(fromRaw);
        if (fromNorm === to || fromRaw === to) continue;
        const key = `${tid}::${fromNorm}::${to}`;
        if (!renames.has(key)) {
            renames.set(key, { tenantId: tid, from: fromRaw, fromNorm, to, packageIds: [] });
        }
        renames.get(key).packageIds.push(pkg.id);
    }

    // Juga seragamkan customers yang profilnya non-canonical (meski paket sudah canonical)
    const customerProfiles = await dbAll(
        db,
        onlyTid
            ? `SELECT DISTINCT tenant_id, pppoe_profile FROM customers
               WHERE tenant_id = ?
                 AND pppoe_profile IS NOT NULL AND TRIM(pppoe_profile) != ''
                 AND LOWER(TRIM(pppoe_profile)) NOT IN ('isolir', 'default')`
            : `SELECT DISTINCT tenant_id, pppoe_profile FROM customers
               WHERE tenant_id IS NOT NULL
                 AND pppoe_profile IS NOT NULL AND TRIM(pppoe_profile) != ''
                 AND LOWER(TRIM(pppoe_profile)) NOT IN ('isolir', 'default')`,
        onlyTid ? [onlyTid] : []
    );
    for (const row of customerProfiles || []) {
        const tid = parseInt(row.tenant_id, 10);
        const fromRaw = String(row.pppoe_profile || '').trim();
        const to = toCanonicalTenantPppoeProfile(tid, fromRaw, null);
        if (!to) continue;
        const fromNorm = normalizeGroupname(fromRaw);
        if (fromNorm === to || fromRaw === to) continue;
        const key = `${tid}::${fromNorm}::${to}`;
        if (!renames.has(key)) {
            renames.set(key, { tenantId: tid, from: fromRaw, fromNorm, to, packageIds: [] });
        }
    }

    let radiusConn = null;
    try {
        const { getRadiusConnection } = require('../config/radiusSQLite');
        radiusConn = await getRadiusConnection();
    } catch (err) {
        logger.warn(`[standardizeTenantPppoeProfileNames] RADIUS unavailable: ${err.message}`);
    }

    let packagesUpdated = 0;
    let customersUpdated = 0;
    let radiusRemounted = 0;
    let groupsEnsured = 0;
    const details = [];

    try {
        for (const item of renames.values()) {
            const { tenantId: tid, from, fromNorm, to } = item;
            try {
                if (radiusConn) {
                    const sourcePhysical = await findRadiusGroupPhysicalName(radiusConn, [
                        from,
                        fromNorm,
                        to
                    ]);
                    const destExists = await findRadiusGroupPhysicalName(radiusConn, [to]);
                    if (!destExists && sourcePhysical && normalizeGroupname(sourcePhysical) !== to) {
                        await cloneRadiusGroupAttributes(radiusConn, sourcePhysical, to);
                        groupsEnsured++;
                    } else if (!destExists) {
                        // Buat grup minimal agar assign tidak gagal
                        await radiusConn.execute(
                            `INSERT INTO radgroupreply (groupname, attribute, op, value)
                             VALUES (?, 'Reply-Message', ':=', ?)`,
                            [to, `Profile standardized for tenant ${tid}`]
                        );
                        groupsEnsured++;
                    }

                    // Remount dari semua alias lama
                    for (const oldAlias of [from, fromNorm, sourcePhysical].filter(Boolean)) {
                        try {
                            radiusRemounted += await remountTenantUsersToGroup(
                                radiusConn,
                                tid,
                                oldAlias,
                                to
                            );
                        } catch (_) {
                            /* ignore per-alias */
                        }
                    }
                }

                // Update packages: match exact + normalized space form
                const pkgRes1 = await dbRun(
                    db,
                    `UPDATE packages SET pppoe_profile = ?
                     WHERE tenant_id = ? AND TRIM(pppoe_profile) = ?`,
                    [to, tid, from]
                );
                const pkgRes2 = await dbRun(
                    db,
                    `UPDATE packages SET pppoe_profile = ?
                     WHERE tenant_id = ?
                       AND LOWER(TRIM(REPLACE(pppoe_profile, ' ', '_'))) = ?
                       AND TRIM(pppoe_profile) != ?`,
                    [to, tid, fromNorm, to]
                );
                packagesUpdated += (pkgRes1?.changes || 0) + (pkgRes2?.changes || 0);

                const custRes1 = await dbRun(
                    db,
                    `UPDATE customers SET pppoe_profile = ?
                     WHERE tenant_id = ? AND TRIM(pppoe_profile) = ?`,
                    [to, tid, from]
                );
                const custRes2 = await dbRun(
                    db,
                    `UPDATE customers SET pppoe_profile = ?
                     WHERE tenant_id = ?
                       AND LOWER(TRIM(REPLACE(pppoe_profile, ' ', '_'))) = ?
                       AND TRIM(pppoe_profile) != ?`,
                    [to, tid, fromNorm, to]
                );
                customersUpdated += (custRes1?.changes || 0) + (custRes2?.changes || 0);

                try {
                    await claimTenantPppoeProfile(to, tid);
                    if (fromNorm !== to) {
                        await releaseTenantPppoeProfile(fromNorm, tid).catch(() => {});
                        await releaseTenantPppoeProfile(from, tid).catch(() => {});
                    }
                } catch (claimErr) {
                    logger.warn(
                        `[standardizeTenantPppoeProfileNames] claim ${to}: ${claimErr.message}`
                    );
                }

                details.push({ tenant_id: tid, from, to });
                logger.info(
                    `[standardizeTenantPppoeProfileNames] tenant=${tid} "${from}" → "${to}"`
                );
            } catch (itemErr) {
                logger.warn(
                    `[standardizeTenantPppoeProfileNames] tenant=${tid} ${from}→${to}: ${itemErr.message}`
                );
                details.push({ tenant_id: tid, from, to, error: itemErr.message });
            }
        }
    } finally {
        if (radiusConn && typeof radiusConn.end === 'function') {
            try {
                await radiusConn.end();
            } catch (_) {}
        }
    }

    // Sinkron display_name metadata + bersihkan klaim ownership non-canonical
    const syncMeta = await syncCanonicalPppoeProfileDisplayNames({ tenantId: onlyTid });

    return {
        success: true,
        renames: renames.size,
        packages_updated: packagesUpdated,
        customers_updated: customersUpdated,
        radius_remounted: radiusRemounted,
        groups_ensured: groupsEnsured,
        display_names_synced: syncMeta.updated || 0,
        ownership_cleaned: syncMeta.ownership_cleaned || 0,
        details: details.slice(0, 100)
    };
}

/**
 * Samakan pppoe_profiles.display_name = groupname untuk profil t{tid}_*,
 * dan hapus klaim ownership sampah (50mbps/50mbps, Profil …, dll.).
 */
async function syncCanonicalPppoeProfileDisplayNames(options = {}) {
    const onlyTid =
        options.tenantId != null && Number.isFinite(Number(options.tenantId))
            ? parseInt(options.tenantId, 10)
            : null;

    let updated = 0;
    let ownershipCleaned = 0;
    let conn = null;
    try {
        const { getRadiusConnection } = require('../config/radiusSQLite');
        conn = await getRadiusConnection();
        const [rows] = await conn.execute(
            `SELECT groupname, display_name FROM pppoe_profiles
             WHERE groupname LIKE 't%_%'`
        );
        for (const row of rows || []) {
            const gn = String(row.groupname || '').trim();
            if (!/^t\d+_/i.test(gn)) continue;
            if (onlyTid != null) {
                const m = gn.match(/^t(\d+)_/i);
                if (!m || parseInt(m[1], 10) !== onlyTid) continue;
            }
            const dn = row.display_name != null ? String(row.display_name).trim() : '';
            if (dn === gn) continue;
            await conn.execute(
                `UPDATE pppoe_profiles SET display_name = ?, updated_at = datetime('now','localtime')
                 WHERE groupname = ?`,
                [gn, gn]
            );
            updated++;
        }
    } catch (err) {
        logger.warn(`[syncCanonicalPppoeProfileDisplayNames] RADIUS: ${err.message}`);
    } finally {
        if (conn && typeof conn.end === 'function') {
            try {
                await conn.end();
            } catch (_) {}
        }
    }

    try {
        await ensureTenantPppoeProfilesTable();
        const db = getBillingDb();
        const junk = await dbAll(
            db,
            onlyTid
                ? `SELECT id, tenant_id, groupname FROM ${TABLE}
                   WHERE tenant_id = ?
                     AND LOWER(TRIM(groupname)) NOT IN ('isolir', 'default')
                     AND groupname NOT LIKE 't' || tenant_id || '_%'`
                : `SELECT id, tenant_id, groupname FROM ${TABLE}
                   WHERE LOWER(TRIM(groupname)) NOT IN ('isolir', 'default')
                     AND groupname NOT LIKE 't' || tenant_id || '_%'`
            ,
            onlyTid ? [onlyTid] : []
        );
        for (const row of junk || []) {
            const tid = parseInt(row.tenant_id, 10);
            const canonical = toCanonicalTenantPppoeProfile(tid, row.groupname, null);
            // Hanya klaim ulang jika hasilnya profil/speed atau gratis (hindari t10_test, t10_100, dll.)
            const looksCanonical =
                canonical &&
                (/^t\d+_profil_\d+_mbps$/i.test(canonical) || /^t\d+_gratis$/i.test(canonical));
            if (looksCanonical && canonical !== normalizeGroupname(row.groupname)) {
                try {
                    await claimTenantPppoeProfile(canonical, tid);
                } catch (_) {
                    /* ignore */
                }
            }
            await dbRun(db, `DELETE FROM ${TABLE} WHERE id = ?`, [row.id]);
            ownershipCleaned++;
            logger.info(
                `[syncCanonicalPppoeProfileDisplayNames] drop ownership tenant=${tid} "${row.groupname}"` +
                    (looksCanonical ? ` (ensure ${canonical})` : '')
            );
        }
    } catch (ownErr) {
        logger.warn(`[syncCanonicalPppoeProfileDisplayNames] ownership: ${ownErr.message}`);
    }

    return { updated, ownership_cleaned: ownershipCleaned };
}

module.exports = {
    SYSTEM_PROFILES,
    ensureTenantPppoeProfilesTable,
    migrateTenantPppoeProfilesOnce,
    dedupeTenantPppoeProfileOwnershipOnce,
    getTenantAllowedPppoeProfiles,
    getTenantAllowedPppoeProfileSet,
    claimTenantPppoeProfile,
    releaseTenantPppoeProfile,
    renameTenantPppoeProfile,
    tenantOwnsPppoeProfile,
    assertTenantOwnsPppoeProfile,
    ensureExclusivePppoeProfileForTenant,
    remountTenantRadusergroupOnRename,
    normalizeGroupname,
    stripTenantProfilePrefix,
    extractSpeedMbps,
    toCanonicalTenantPppoeProfile,
    standardizeTenantPppoeProfileNames,
    syncCanonicalPppoeProfileDisplayNames
};
