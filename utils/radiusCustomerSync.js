const logger = require('../config/logger');
const {
    getUserAuthModeAsync,
    getRadiusConnection,
    resolvePppoeProfileHintToRadiusGroup,
    syncRadiusToFreeRadiusMysql
} = require('../config/mikrotik');

function pickFirstProfileHint(options, customer) {
    const vals = [options.pppoe_profile, customer?.pppoe_profile, customer?.package_pppoe_profile];
    for (const v of vals) {
        if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return null;
}

function sanitizeIp(value) {
    if (!value || typeof value !== 'string') return null;
    const ip = value.trim();
    if (!ip) return null;
    const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
    return ipv4.test(ip) ? ip : null;
}

/**
 * Sync customer PPPoE auth data from billing to RADIUS SQL tables.
 * - radcheck: Cleartext-Password
 * - radusergroup: package/profile mapping (hanya groupname yang ada di radgroupreply/radgroupcheck)
 * - radreply: Framed-IP-Address (optional)
 */
async function syncCustomerToRadius(customer, options = {}) {
    const pppoeUsername = String(customer?.pppoe_username || customer?.username || '').trim();
    // IMPORTANT: RADIUS PPPoE password must come from PPPoE password field,
    // never from portal login password.
    const pppoePassword = String(options.pppoe_password || customer?.pppoe_password || '').trim();
    const profileHint = pickFirstProfileHint(options, customer);
    const framedIp = sanitizeIp(options.static_ip || options.assigned_ip || customer?.static_ip || customer?.assigned_ip || null);
    /** Jangan timpa radusergroup ke profil paket saat pelanggan isolir — grup 'isolir' diatur suspendUserRadius / serviceSuspension */
    const effectiveStatus = String(customer?.status || options?.status || '').toLowerCase();
    const skipGroupAssign = effectiveStatus === 'suspended';

    if (!pppoeUsername) {
        return { success: false, skipped: true, message: 'PPPoE username kosong, skip sync RADIUS' };
    }

    const authMode = await getUserAuthModeAsync();
    if (authMode !== 'radius') {
        return { success: false, skipped: true, message: `Mode auth ${authMode}, sync RADIUS di-skip` };
    }

    let conn;
    try {
        conn = await getRadiusConnection();

        if (pppoePassword) {
            await conn.execute(
                "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?) ON CONFLICT(username, attribute) DO UPDATE SET op = excluded.op, value = excluded.value",
                [pppoeUsername, pppoePassword]
            );
        } else {
            const [existingPassword] = await conn.execute(
                "SELECT id FROM radcheck WHERE username = ? AND attribute = 'Cleartext-Password' LIMIT 1",
                [pppoeUsername]
            );
            if (!existingPassword || existingPassword.length === 0) {
                return {
                    success: false,
                    skipped: true,
                    message: `Password PPPoE untuk ${pppoeUsername} tidak tersedia, radcheck tidak bisa dibuat`
                };
            }
        }

        if (profileHint && !skipGroupAssign) {
            const resolvedGroup = await resolvePppoeProfileHintToRadiusGroup(conn, profileHint);
            if (resolvedGroup) {
                await conn.execute('DELETE FROM radusergroup WHERE username = ?', [pppoeUsername]);
                await conn.execute(
                    'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)',
                    [pppoeUsername, resolvedGroup]
                );
            } else {
                logger.warn(
                    `[RADIUS-SYNC] Profil tidak dikenali di RADIUS untuk ${pppoeUsername} (hint=${profileHint}); radusergroup tidak diubah`
                );
            }
        } else if (profileHint && skipGroupAssign) {
            logger.info(`[RADIUS-SYNC] Skip radusergroup untuk ${pppoeUsername} (status suspended, biarkan grup isolir)`);
        }

        if (framedIp) {
            await conn.execute(
                "INSERT INTO radreply (username, attribute, op, value) VALUES (?, 'Framed-IP-Address', ':=', ?) ON CONFLICT(username, attribute) DO UPDATE SET op = excluded.op, value = excluded.value",
                [pppoeUsername, framedIp]
            );
        }

        await syncRadiusToFreeRadiusMysql({ force: true });
        logger.info(`[RADIUS-SYNC] Synced billing customer ${pppoeUsername} to RADIUS (+ MySQL)`);
        return { success: true, username: pppoeUsername };
    } catch (error) {
        logger.error(`[RADIUS-SYNC] Failed sync for ${pppoeUsername}: ${error.message}`);
        return { success: false, message: error.message };
    } finally {
        if (conn) {
            try {
                if (typeof conn.end === 'function') await conn.end();
            } catch (_) {}
        }
    }
}

module.exports = {
    syncCustomerToRadius
};
