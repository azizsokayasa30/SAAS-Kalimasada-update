/**
 * Sync static IP pool allow/block lists to MikroTik.
 * Unused CIDR → redirect ke halaman isolir (bukan hard-drop internet).
 * Active assigned IPs = allowed. Isolir tunggakan tetap pakai isolir_customer.
 */
const logger = require('./logger');
const { getMikrotikConnectionForRouter } = require('./mikrotik');
const {
    getPoolById,
    listPools,
    mikrotikRangeAddress,
    getUsedIpsForPool,
    parseReserved
} = require('./staticIpPool');
const { getTenantId } = require('./platform/tenantContext');
const { getSetting } = require('./settingsManager');
const { getPublicAppBaseUrl } = require('./public-endpoint');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const LIST_BLOCKED = 'static_pool_blocked';
const LIST_ALLOWED = 'static_pool_allowed';
const LIST_ALLOWED_DST = 'isolir-allowed-dst';
const COMMENT_PREFIX = 'STATIC-POOL';

async function getRouterById(routerId, tenantId = null) {
    const db = new sqlite3.Database(path.join(__dirname, '../data/billing.db'));
    try {
        const row = await new Promise((resolve, reject) => {
            if (tenantId != null) {
                db.get(
                    'SELECT * FROM routers WHERE id = ? AND tenant_id = ?',
                    [routerId, tenantId],
                    (err, r) => (err ? reject(err) : resolve(r || null))
                );
            } else {
                db.get('SELECT * FROM routers WHERE id = ?', [routerId], (err, r) =>
                    err ? reject(err) : resolve(r || null)
                );
            }
        });
        return row;
    } finally {
        db.close();
    }
}

function isIpAddress(value) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(value || '').trim());
}

function getIsolirAccessConfig() {
    let host = String(getSetting('server_host', '') || '').trim();
    let port = String(getSetting('server_port', process.env.PORT || 4555));
    try {
        const url = new URL(getPublicAppBaseUrl());
        host = url.hostname || host;
        port = url.port || (url.protocol === 'https:' ? '443' : '80');
    } catch (_) {}

    const billingServerIp =
        String(process.env.ISOLIR_BILLING_SERVER_IP || '').trim() ||
        String(getSetting('isolir_billing_server_ip', '') || '').trim() ||
        String(getSetting('billing_server_ip', '') || '').trim() ||
        (isIpAddress(host) ? host : '');

    return {
        billingServerIp,
        billingHost: host,
        billingPorts: Array.from(
            new Set(
                [
                    String(process.env.ISOLIR_PORT || getSetting('isolir_page_port', 8899)),
                    String(port || ''),
                    '80',
                    '443'
                ].filter(Boolean)
            )
        ).join(','),
        isolirPort: String(process.env.ISOLIR_PORT || getSetting('isolir_page_port', 8899)),
        whatsappHosts: [
            'wa.me',
            'whatsapp.com',
            'web.whatsapp.com',
            'api.whatsapp.com',
            'static.whatsapp.net',
            'whatsapp.net',
            'graph.whatsapp.com',
            'mmg.whatsapp.net',
            'pps.whatsapp.net',
            'media.whatsapp.net',
            'facebook.com',
            'fbcdn.net',
            'fbsbx.com'
        ]
    };
}

async function findByComment(mikrotik, menu, comment) {
    try {
        const rows = await mikrotik.write(`${menu}/print`, [`?comment=${comment}`]);
        return rows || [];
    } catch (_) {
        return [];
    }
}

async function removeByComment(mikrotik, menu, comment) {
    const rows = await findByComment(mikrotik, menu, comment);
    for (const row of rows) {
        try {
            await mikrotik.write(`${menu}/remove`, [`=.id=${row['.id']}`]);
        } catch (e) {
            logger.warn(`[STATIC-POOL-SYNC] remove ${menu} "${comment}": ${e.message}`);
        }
    }
}

async function ensureCommentRule(mikrotik, menu, comment, params) {
    const existing = await findByComment(mikrotik, menu, comment);
    if (existing.length) return;
    await mikrotik.write(`${menu}/add`, [...params, `=comment=${comment}`]);
}

async function ensureAddressListEntry(mikrotik, list, address, comment) {
    if (!address) return;
    try {
        const all = await mikrotik.write('/ip/firewall/address-list/print', [`?list=${list}`]);
        const found = (all || []).some((r) => String(r.address || '').trim() === String(address).trim());
        if (!found) {
            await mikrotik.write('/ip/firewall/address-list/add', [
                `=list=${list}`,
                `=address=${address}`,
                `=comment=${comment}`
            ]);
        }
    } catch (e) {
        logger.warn(`[STATIC-POOL-SYNC] address-list ${list} ${address}: ${e.message}`);
    }
}

/**
 * Unused IP: redirect ke halaman isolir + walled garden (bukan hard-drop).
 * Migrasi: hapus rule lama "STATIC-POOL drop blocked".
 */
async function ensurePoolFirewall(mikrotik) {
    const access = getIsolirAccessConfig();
    const acceptComment = `${COMMENT_PREFIX} accept allowed`;
    const legacyDropComment = `${COMMENT_PREFIX} drop blocked`;

    // Hapus hard-drop lama agar diganti redirect isolir
    await removeByComment(mikrotik, '/ip/firewall/filter', legacyDropComment);

    // 1) IP aktif tetap lolos
    await ensureCommentRule(mikrotik, '/ip/firewall/filter', acceptComment, [
        '=chain=forward',
        `=src-address-list=${LIST_ALLOWED}`,
        '=action=accept'
    ]);

    // 2) Walled garden destination (shared dengan isolir pelanggan)
    await ensureAddressListEntry(
        mikrotik,
        LIST_ALLOWED_DST,
        access.billingServerIp,
        'BILLING-ISOLIR billing server'
    );
    if (access.billingHost && !isIpAddress(access.billingHost)) {
        await ensureAddressListEntry(
            mikrotik,
            LIST_ALLOWED_DST,
            access.billingHost,
            'BILLING-ISOLIR billing host'
        );
    }
    for (const host of access.whatsappHosts) {
        await ensureAddressListEntry(
            mikrotik,
            LIST_ALLOWED_DST,
            host,
            `BILLING-ISOLIR whatsapp ${host}`
        );
    }

    // 3) Allow DNS / billing / WhatsApp dari unused pool
    await ensureCommentRule(mikrotik, '/ip/firewall/filter', `${COMMENT_PREFIX} allow dns udp`, [
        '=chain=forward',
        `=src-address-list=${LIST_BLOCKED}`,
        '=protocol=udp',
        '=dst-port=53',
        '=action=accept'
    ]);
    await ensureCommentRule(mikrotik, '/ip/firewall/filter', `${COMMENT_PREFIX} allow dns tcp`, [
        '=chain=forward',
        `=src-address-list=${LIST_BLOCKED}`,
        '=protocol=tcp',
        '=dst-port=53',
        '=action=accept'
    ]);
    if (access.billingServerIp) {
        await ensureCommentRule(mikrotik, '/ip/firewall/filter', `${COMMENT_PREFIX} allow billing`, [
            '=chain=forward',
            `=src-address-list=${LIST_BLOCKED}`,
            `=dst-address=${access.billingServerIp}`,
            '=protocol=tcp',
            `=dst-port=${access.billingPorts}`,
            '=action=accept'
        ]);
    }
    await ensureCommentRule(mikrotik, '/ip/firewall/filter', `${COMMENT_PREFIX} allow whatsapp`, [
        '=chain=forward',
        `=src-address-list=${LIST_BLOCKED}`,
        `=dst-address-list=${LIST_ALLOWED_DST}`,
        '=protocol=tcp',
        '=dst-port=80,443,5222,5223,5228,4244',
        '=action=accept'
    ]);

    // 4) NAT: HTTP → halaman isolir
    if (access.billingServerIp) {
        await ensureCommentRule(
            mikrotik,
            '/ip/firewall/nat',
            `${COMMENT_PREFIX} bypass allowed dst`,
            [
                '=chain=dstnat',
                `=src-address-list=${LIST_BLOCKED}`,
                `=dst-address-list=${LIST_ALLOWED_DST}`,
                '=protocol=tcp',
                '=action=accept'
            ]
        );
        await ensureCommentRule(
            mikrotik,
            '/ip/firewall/nat',
            `${COMMENT_PREFIX} redirect http isolir`,
            [
                '=chain=dstnat',
                `=src-address-list=${LIST_BLOCKED}`,
                '=protocol=tcp',
                '=dst-port=80,8080,8000,8888',
                '=action=dst-nat',
                `=to-addresses=${access.billingServerIp}`,
                `=to-ports=${access.isolirPort}`
            ]
        );
        await ensureCommentRule(
            mikrotik,
            '/ip/firewall/nat',
            `${COMMENT_PREFIX} masquerade billing`,
            [
                '=chain=srcnat',
                `=src-address-list=${LIST_BLOCKED}`,
                `=dst-address=${access.billingServerIp}`,
                '=action=masquerade'
            ]
        );
    } else {
        logger.warn(
            '[STATIC-POOL-SYNC] billingServerIp kosong — redirect isolir tidak bisa dipasang. Set isolir_billing_server_ip.'
        );
    }

    // 5) Sisa traffic unused tetap di-drop (HTTPS dll), setelah allow + NAT
    await ensureCommentRule(mikrotik, '/ip/firewall/filter', `${COMMENT_PREFIX} drop other`, [
        '=chain=forward',
        `=src-address-list=${LIST_BLOCKED}`,
        '=action=drop'
    ]);
}

async function reconcileAddressList(mikrotik, listName, desiredAddresses, commentTag) {
    const desired = new Set((desiredAddresses || []).filter(Boolean).map(String));
    let existing = [];
    try {
        existing = await mikrotik.write('/ip/firewall/address-list/print', [`?list=${listName}`]);
    } catch (e) {
        logger.warn(`[STATIC-POOL-SYNC] print ${listName}: ${e.message}`);
        existing = [];
    }
    const byAddress = new Map();
    for (const row of existing || []) {
        const addr = String(row.address || '').trim();
        if (!addr) continue;
        if (!byAddress.has(addr)) byAddress.set(addr, []);
        byAddress.get(addr).push(row);
    }

    let added = 0;
    let removed = 0;

    for (const [addr, rows] of byAddress.entries()) {
        if (!desired.has(addr)) {
            for (const row of rows) {
                try {
                    await mikrotik.write('/ip/firewall/address-list/remove', [`=.id=${row['.id']}`]);
                    removed++;
                } catch (e) {
                    logger.warn(`[STATIC-POOL-SYNC] remove ${listName} ${addr}: ${e.message}`);
                }
            }
        } else if (rows.length > 1) {
            for (const row of rows.slice(1)) {
                try {
                    await mikrotik.write('/ip/firewall/address-list/remove', [`=.id=${row['.id']}`]);
                    removed++;
                } catch (_) {}
            }
        }
    }

    for (const addr of desired) {
        if (byAddress.has(addr)) continue;
        try {
            await mikrotik.write('/ip/firewall/address-list/add', [
                `=list=${listName}`,
                `=address=${addr}`,
                `=comment=${commentTag}`
            ]);
            added++;
        } catch (e) {
            logger.warn(`[STATIC-POOL-SYNC] add ${listName} ${addr}: ${e.message}`);
        }
    }

    return { added, removed, desired: desired.size };
}

async function collectRouterPoolTargets(routerId, tenantId) {
    const poolsOnRouter = (await listPools(tenantId)).filter(
        (p) => p.enabled && Number(p.router_id) === Number(routerId)
    );
    const blockAddresses = [];
    const seenBlock = new Set();
    const allowedSet = new Set();

    for (const p of poolsOnRouter) {
        const blockAddr = mikrotikRangeAddress(p);
        if (blockAddr && !seenBlock.has(blockAddr)) {
            seenBlock.add(blockAddr);
            blockAddresses.push(blockAddr);
        }
        const used = await getUsedIpsForPool(p, tenantId);
        const reserved = new Set(parseReserved(p.reserved_ips));
        if (p.gateway) reserved.add(p.gateway);
        for (const u of used) {
            if (!u.ip || reserved.has(u.ip)) continue;
            if (String(u.status || '').toLowerCase() !== 'active') continue;
            allowedSet.add(u.ip);
        }
    }

    return { poolsOnRouter, blockAddresses, allowedSet };
}

async function syncPoolToMikrotik(poolOrId, tenantId = getTenantId()) {
    const pool = typeof poolOrId === 'object' ? poolOrId : await getPoolById(poolOrId, tenantId);
    if (!pool) throw new Error('Pool tidak ditemukan');
    if (!pool.enabled) {
        return { success: true, skipped: true, message: 'Pool disabled' };
    }

    const router = await getRouterById(pool.router_id, tenantId);
    if (!router) {
        throw new Error(
            `Router id=${pool.router_id} tidak ditemukan / bukan milik tenant ini. Edit CIDR dan pilih router yang benar.`
        );
    }

    const { blockAddresses, allowedSet } = await collectRouterPoolTargets(pool.router_id, tenantId);
    if (!blockAddresses.length) throw new Error('Tidak bisa menentukan address block range');

    logger.info(
        `[STATIC-POOL-SYNC] start pool=${pool.id} router=${router.id}(${router.nas_ip}:${router.port || 8728}) blocks=${blockAddresses.length} allowed=${allowedSet.size} mode=isolir-redirect`
    );

    const mikrotik = await getMikrotikConnectionForRouter(router);
    await ensurePoolFirewall(mikrotik);

    const blockResult = await reconcileAddressList(
        mikrotik,
        LIST_BLOCKED,
        blockAddresses,
        `${COMMENT_PREFIX} range`
    );

    const allowResult = await reconcileAddressList(
        mikrotik,
        LIST_ALLOWED,
        [...allowedSet],
        `${COMMENT_PREFIX} allowed`
    );

    logger.info(
        `[STATIC-POOL-SYNC] ok pool=${pool.id} router=${router.id} blocked=[${blockAddresses.join(',')}] allowed=${allowedSet.size}`
    );

    return {
        success: true,
        pool_id: pool.id,
        mode: 'isolir-redirect',
        blocked: blockResult,
        allowed: allowResult,
        block_addresses: blockAddresses,
        allowed_count: allowedSet.size,
        router: { id: router.id, name: router.name, nas_ip: router.nas_ip }
    };
}

async function syncPoolsForRouter(routerId, tenantId = getTenantId()) {
    const router = await getRouterById(routerId, tenantId);
    if (!router) {
        return [{ success: false, error: `Router ${routerId} bukan milik tenant / tidak ditemukan` }];
    }
    const pools = (await listPools(tenantId)).filter((p) => Number(p.router_id) === Number(routerId));
    if (!pools.length) return [];
    try {
        return [await syncPoolToMikrotik(pools[0], tenantId)];
    } catch (e) {
        return [{ success: false, pool_id: pools[0].id, error: e.message }];
    }
}

async function syncAllPools(tenantId = getTenantId()) {
    const pools = await listPools(tenantId);
    const byRouter = new Map();
    for (const p of pools) {
        if (!p.enabled) continue;
        if (!byRouter.has(p.router_id)) byRouter.set(p.router_id, []);
        byRouter.get(p.router_id).push(p);
    }
    const results = [];
    for (const [, list] of byRouter) {
        try {
            results.push(await syncPoolToMikrotik(list[0], tenantId));
        } catch (e) {
            results.push({ success: false, error: e.message });
        }
    }
    return results;
}

module.exports = {
    LIST_BLOCKED,
    LIST_ALLOWED,
    ensurePoolFirewall,
    syncPoolToMikrotik,
    syncPoolsForRouter,
    syncAllPools
};
