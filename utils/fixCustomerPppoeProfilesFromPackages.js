/**
 * Perbaiki profil PPPoE pelanggan dari paket tenant (billing + RADIUS).
 * Pelanggan tanpa pppoe_username (dan tanpa sandi PPPoE di RADIUS) dianggap static.
 */

const logger = require('../config/logger');

function packageUsesPPPoEProfile(pkg) {
    if (!pkg || pkg.pppoe_profile == null) return false;
    return String(pkg.pppoe_profile).trim() !== '';
}

function normalizePackageName(v) {
    return String(v || '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ');
}

function normalizePackageCompact(v) {
    return normalizePackageName(v).replace(/\s+/g, '');
}

/**
 * @param {number} tenantId
 * @param {{ skipStandardize?: boolean }} [options]
 */
async function fixCustomerPppoeProfilesFromPackages(tenantId, options = {}) {
    const tid = parseInt(tenantId, 10);
    if (!Number.isFinite(tid) || tid <= 0) {
        throw new Error('tenantId tidak valid');
    }

    const {
        standardizeTenantPppoeProfileNames
    } = require('./tenantPppoeProfileOwnership');

    let standardizeResult = null;
    if (!options.skipStandardize) {
        try {
            standardizeResult = await standardizeTenantPppoeProfileNames({ tenantId: tid });
        } catch (stdErr) {
            logger.warn(`[FIX-PPPOE-PROFILE] standardize tenant=${tid}: ${stdErr.message}`);
        }
    }

    const db = require('../config/billing').db;
    const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
    const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });

    const tenantPackages = await dbAll(
        `SELECT id, name, pppoe_profile, upload_limit, download_limit,
                burst_limit_upload, burst_limit_download, burst_threshold, burst_time, router_id
         FROM packages WHERE tenant_id = ?`,
        [tid]
    );
    const packageById = new Map();
    const packageByName = new Map();
    const packageByCompact = new Map();
    for (const pkg of tenantPackages) {
        if (!pkg || pkg.id == null) continue;
        packageById.set(Number(pkg.id), pkg);
        const norm = normalizePackageName(pkg.name);
        const compact = normalizePackageCompact(pkg.name);
        if (norm && !packageByName.has(norm)) packageByName.set(norm, pkg);
        if (compact && !packageByCompact.has(compact)) packageByCompact.set(compact, pkg);
    }

    // Semua pelanggan tenant (termasuk tanpa username → static)
    const customers = await dbAll(
        `SELECT c.id AS customer_id,
                c.name AS customer_name,
                c.status AS customer_status,
                c.pppoe_username,
                c.pppoe_profile AS customer_profile,
                c.package_id,
                c.static_ip,
                p.name AS package_name,
                p.tenant_id AS package_tenant_id,
                p.pppoe_profile AS linked_package_profile
         FROM customers c
         LEFT JOIN packages p ON p.id = c.package_id
         WHERE c.tenant_id = ?`,
        [tid]
    );

    const {
        assignPackageRadius,
        syncPackageLimitsToRadius,
        syncRadiusToFreeRadiusMysql,
        getRadiusConnection
    } = require('../config/mikrotik');

    const usernames = customers
        .map((c) => String(c.pppoe_username || '').trim())
        .filter(Boolean);

    const radiusGroupByUser = new Map();
    const radiusHasPassword = new Set();
    if (usernames.length > 0) {
        let conn = null;
        try {
            conn = await getRadiusConnection();
            const chunkSize = 200;
            for (let i = 0; i < usernames.length; i += chunkSize) {
                const chunk = usernames.slice(i, i + chunkSize);
                const ph = chunk.map(() => '?').join(',');
                const chunkLower = chunk.map((u) => String(u).toLowerCase());
                const [groups] = await conn.execute(
                    `SELECT username, groupname FROM radusergroup WHERE username IN (${ph})`,
                    chunk
                );
                for (const row of groups || []) {
                    const key = String(row.username || '').toLowerCase().trim();
                    if (key) radiusGroupByUser.set(key, String(row.groupname || '').trim());
                }
                // Case-insensitive: LOWER(username) IN (...)
                const [anyCheck] = await conn.execute(
                    `SELECT DISTINCT LOWER(TRIM(username)) AS u FROM radcheck
                     WHERE LOWER(TRIM(username)) IN (${ph})`,
                    chunkLower
                );
                for (const row of anyCheck || []) {
                    const key = String(row.u || '').toLowerCase().trim();
                    if (key) radiusHasPassword.add(key);
                }
            }
        } catch (radiusPrefetchErr) {
            logger.warn(`[FIX-PPPOE-PROFILE] RADIUS prefetch tenant=${tid}: ${radiusPrefetchErr.message}`);
        } finally {
            if (conn && typeof conn.end === 'function') {
                try { await conn.end(); } catch (_) { /* ignore */ }
            }
        }
    }

    const ensuredProfiles = new Set();
    let billingUpdated = 0;
    let packageRemapped = 0;
    let radiusUpdated = 0;
    let staticMarked = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    for (const row of customers) {
        const username = String(row.pppoe_username || '').trim();
        const userKey = username.toLowerCase();
        const hasPppoePassword = username ? radiusHasPassword.has(userKey) : false;

        // Tanpa username PPPoE (dan tanpa sandi di RADIUS) → pelanggan static
        if (!username) {
            try {
                const hasProfile = String(row.customer_profile || '').trim() !== '';
                if (hasProfile) {
                    const result = await dbRun(
                        `UPDATE customers SET pppoe_profile = NULL WHERE id = ? AND tenant_id = ?`,
                        [row.customer_id, tid]
                    );
                    if (result && result.changes > 0) staticMarked++;
                    else skipped++;
                } else {
                    staticMarked++;
                }
            } catch (staticErr) {
                failed++;
                errors.push({
                    username: '(static)',
                    customer_id: row.customer_id,
                    error: staticErr.message
                });
            }
            continue;
        }

        // Username ada tapi tidak ada sandi PPPoE di RADIUS → anggap belum siap PPPoE / static-like
        if (!hasPppoePassword) {
            skipped++;
            continue;
        }

        const status = String(row.customer_status || '').toLowerCase().trim();
        if (status === 'isolir' || status === 'suspended') {
            skipped++;
            continue;
        }

        const currentRadiusGroup = radiusGroupByUser.get(userKey) || '';
        if (currentRadiusGroup.toLowerCase() === 'isolir') {
            skipped++;
            continue;
        }

        let targetPkg = null;
        const linkedId = row.package_id != null ? Number(row.package_id) : null;
        if (linkedId != null && packageById.has(linkedId)) {
            targetPkg = packageById.get(linkedId);
        } else if (row.package_name) {
            const norm = normalizePackageName(row.package_name);
            const compact = normalizePackageCompact(row.package_name);
            targetPkg = packageByName.get(norm) || packageByCompact.get(compact) || null;
        }

        if (!targetPkg || !packageUsesPPPoEProfile(targetPkg)) {
            skipped++;
            continue;
        }

        const targetProfile = String(targetPkg.pppoe_profile).trim();
        const billingProfile = String(row.customer_profile || '').trim();
        const needsPackageRemap = linkedId == null || Number(linkedId) !== Number(targetPkg.id);
        const needsBillingProfile =
            !billingProfile ||
            billingProfile.toLowerCase() === 'default' ||
            billingProfile.toLowerCase() !== targetProfile.toLowerCase();
        const needsRadius =
            !currentRadiusGroup ||
            currentRadiusGroup.toLowerCase() === 'default' ||
            currentRadiusGroup.toLowerCase() !== targetProfile.toLowerCase();

        if (!needsPackageRemap && !needsBillingProfile && !needsRadius) {
            skipped++;
            continue;
        }

        try {
            if (needsPackageRemap || needsBillingProfile) {
                const result = await dbRun(
                    `UPDATE customers
                     SET package_id = ?, pppoe_profile = ?
                     WHERE id = ? AND tenant_id = ?`,
                    [targetPkg.id, targetProfile, row.customer_id, tid]
                );
                if (result && result.changes > 0) {
                    if (needsPackageRemap) packageRemapped++;
                    if (needsBillingProfile) billingUpdated++;
                }
            }

            if (needsRadius) {
                if (!ensuredProfiles.has(targetProfile.toLowerCase())) {
                    try {
                        await syncPackageLimitsToRadius({
                            groupname: targetProfile,
                            upload_limit: targetPkg.upload_limit,
                            download_limit: targetPkg.download_limit,
                            burst_limit_upload: targetPkg.burst_limit_upload,
                            burst_limit_download: targetPkg.burst_limit_download,
                            burst_threshold: targetPkg.burst_threshold,
                            burst_time: targetPkg.burst_time
                        });
                    } catch (ensureErr) {
                        logger.warn(
                            `[FIX-PPPOE-PROFILE] ensure RADIUS profile ${targetProfile}: ${ensureErr.message}`
                        );
                    }
                    ensuredProfiles.add(targetProfile.toLowerCase());
                }

                const assignRes = await assignPackageRadius({
                    username,
                    groupname: targetProfile
                });
                if (assignRes && assignRes.success) {
                    radiusUpdated++;
                    radiusGroupByUser.set(userKey, targetProfile);
                } else {
                    failed++;
                    errors.push({
                        username,
                        error: (assignRes && assignRes.message) || 'Gagal assign profil RADIUS'
                    });
                }
            }
        } catch (rowErr) {
            failed++;
            errors.push({ username, error: rowErr.message || String(rowErr) });
            logger.warn(`[FIX-PPPOE-PROFILE] tenant=${tid} ${username}: ${rowErr.message}`);
        }
    }

    if (radiusUpdated > 0) {
        try {
            await syncRadiusToFreeRadiusMysql({ force: true });
        } catch (syncErr) {
            logger.warn(`[FIX-PPPOE-PROFILE] syncRadiusToFreeRadiusMysql: ${syncErr.message}`);
        }
    }

    const touched =
        billingUpdated +
        packageRemapped +
        radiusUpdated +
        staticMarked +
        (standardizeResult?.renames || 0);

    logger.info(
        `[FIX-PPPOE-PROFILE] tenant=${tid} billing=${billingUpdated} remap=${packageRemapped} radius=${radiusUpdated} static=${staticMarked} skipped=${skipped} failed=${failed}`
    );

    return {
        success: failed === 0 || touched > 0,
        tenant_id: tid,
        updated: touched,
        billing_updated: billingUpdated,
        package_remapped: packageRemapped,
        radius_updated: radiusUpdated,
        static_marked: staticMarked,
        profiles_standardized: standardizeResult?.renames || 0,
        skipped,
        failed,
        total_candidates: customers.length,
        errors: errors.slice(0, 20),
        message: touched > 0
            ? `Selesai: seragamkan ${standardizeResult?.renames || 0}, billing ${billingUpdated}, remap ${packageRemapped}, RADIUS ${radiusUpdated}, static ${staticMarked}` +
              (failed ? `, gagal ${failed}` : '') + '.'
            : (failed
                ? `Gagal memperbaiki profil (${failed} error).`
                : 'Tidak ada pelanggan yang perlu diperbaiki.')
    };
}

/**
 * Jalankan untuk banyak tenant.
 * @param {{ excludeTenantIds?: number[] }} [options]
 */
async function fixCustomerPppoeProfilesForTenants(options = {}) {
    const exclude = new Set(
        (options.excludeTenantIds || []).map((id) => parseInt(id, 10)).filter(Number.isFinite)
    );
    const db = require('../config/billing').db;
    const tenants = await new Promise((resolve, reject) => {
        db.all(
            `SELECT id, name FROM tenants ORDER BY id`,
            [],
            (err, rows) => (err ? reject(err) : resolve(rows || []))
        );
    });

    const results = [];
    for (const t of tenants) {
        const tid = parseInt(t.id, 10);
        if (exclude.has(tid)) {
            results.push({ tenant_id: tid, name: t.name, skipped_tenant: true });
            continue;
        }
        try {
            const r = await fixCustomerPppoeProfilesFromPackages(tid);
            results.push({ ...r, name: t.name });
        } catch (err) {
            logger.error(`[FIX-PPPOE-PROFILE] tenant=${tid} fatal: ${err.message}`);
            results.push({
                tenant_id: tid,
                name: t.name,
                success: false,
                error: err.message
            });
        }
    }
    return results;
}

module.exports = {
    fixCustomerPppoeProfilesFromPackages,
    fixCustomerPppoeProfilesForTenants
};
