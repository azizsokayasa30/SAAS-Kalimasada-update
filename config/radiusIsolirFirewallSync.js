'use strict';

/**
 * Sync walled-garden isolir PPPoE/RADIUS ke MikroTik.
 * Berbeda dari static IP (address-list isolir_customer):
 * - RADIUS memberi Framed-Pool = isolir-pool
 * - MikroTik membatasi src-address range pool isolir + redirect HTTP ke portal isolir
 */
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const logger = require('./logger');
const { getMikrotikConnectionForRouter } = require('./mikrotik');
const { getSetting } = require('./settingsManager');
const { getTenantSetting } = require('./platform/tenantSettings');
const { getPublicAppBaseUrl } = require('./public-endpoint');

const COMMENT_TAG = 'BILLING-ISOLIR';
const COMMENT_PPP = 'BILLING-ISOLIR pppoe';

function isIpAddress(value) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(value || '').trim());
}

function settingOrGlobal(key, defaultValue = '') {
    try {
        return getTenantSetting(key, getSetting(key, defaultValue));
    } catch (_) {
        return getSetting(key, defaultValue);
    }
}

function normalizeCidr(value, fallback = '192.168.200.0/24') {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    if (raw.includes('/')) return raw;
    if (raw.includes('-')) {
        const first = raw.split('-')[0].trim();
        const parts = first.split('.');
        return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : fallback;
    }
    if (isIpAddress(raw)) {
        const parts = raw.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
    return fallback;
}

function cidrToPoolRange(cidrOrRange) {
    const raw = String(cidrOrRange || '').trim();
    if (raw.includes('-')) return raw;
    if (!raw.includes('/')) {
        const parts = raw.split('.');
        return parts.length === 4
            ? `${parts[0]}.${parts[1]}.${parts[2]}.2-${parts[0]}.${parts[1]}.${parts[2]}.254`
            : '192.168.200.2-192.168.200.254';
    }
    const [ip, prefixRaw] = raw.split('/');
    const prefix = parseInt(prefixRaw, 10);
    const parts = ip.split('.').map((n) => parseInt(n, 10));
    if (parts.length !== 4 || !Number.isFinite(prefix) || prefix < 8 || prefix > 30) {
        return '192.168.200.2-192.168.200.254';
    }
    const hostCount = 2 ** (32 - prefix);
    const start = [...parts];
    const end = [...parts];
    start[3] = Math.min(start[3] + 2, 254);
    end[3] = Math.min(parts[3] + hostCount - 2, 254);
    return `${start.join('.')}-${end.join('.')}`;
}

function gatewayFromCidr(cidr) {
    const raw = String(cidr || '').split('/')[0];
    const parts = raw.split('.').map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return '192.168.200.1';
    parts[3] = Math.min(parts[3] + 1, 254);
    return parts.join('.');
}

function getPppoeIsolirAccessConfig() {
    const globalServerHost = String(getSetting('server_host', '') || '').trim();
    let host = String(settingOrGlobal('server_host', globalServerHost) || '').trim() || globalServerHost;
    let port = String(settingOrGlobal('server_port', process.env.PORT || 4555));
    try {
        const url = new URL(getPublicAppBaseUrl());
        if (url.hostname) host = url.hostname;
        if (url.port) port = url.port;
        else if (url.protocol === 'https:') port = '443';
        else if (url.protocol === 'http:') port = port || '80';
    } catch (_) {}

    const billingServerIp =
        String(process.env.ISOLIR_BILLING_SERVER_IP || '').trim() ||
        String(settingOrGlobal('isolir_billing_server_ip', '') || '').trim() ||
        String(settingOrGlobal('billing_server_ip', '') || '').trim() ||
        (isIpAddress(host) ? host : '') ||
        (isIpAddress(globalServerHost) ? globalServerHost : '');

    const isolirRange = normalizeCidr(
        settingOrGlobal('isolir_ip_range', settingOrGlobal('isolir_pool_range', '192.168.200.0/24'))
    );
    const isolirPort = String(process.env.ISOLIR_PORT || settingOrGlobal('isolir_page_port', 8899));
    const billingAppPort = String(port || settingOrGlobal('server_port', process.env.PORT || 4555));

    return {
        billingServerIp,
        billingHost: host,
        isolirRange,
        isolirPoolName: String(settingOrGlobal('isolir_pool', 'isolir-pool') || 'isolir-pool'),
        isolirProfile: String(settingOrGlobal('isolir_profile', 'isolir') || 'isolir'),
        isolirPort,
        billingAppPort,
        billingPorts: Array.from(new Set([isolirPort, billingAppPort, '80', '443'].filter(Boolean))).join(','),
        poolRange: cidrToPoolRange(isolirRange),
        localAddress: gatewayFromCidr(isolirRange),
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
        ],
        captiveHosts: [
            'captive.apple.com',
            'www.apple.com',
            'connectivitycheck.gstatic.com',
            'clients3.google.com',
            'www.msftconnecttest.com',
            'dns.msftncsi.com',
            'detectportal.firefox.com',
            'neverssl.com',
            'example.com'
        ]
    };
}

async function findByComment(mikrotik, menu, comment) {
    try {
        return (await mikrotik.write(`${menu}/print`, [`?comment=${comment}`])) || [];
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
            logger.warn(`[RADIUS-ISOLIR-SYNC] remove ${menu} "${comment}": ${e.message}`);
        }
    }
}

async function ensureCommentRule(mikrotik, menu, comment, params) {
    const existing = await findByComment(mikrotik, menu, comment);
    if (existing.length) return 'exists';
    try {
        const first = await mikrotik.write(`${menu}/print`, []);
        const firstId = first && first[0] && first[0]['.id'];
        try {
            await mikrotik.write(`${menu}/add`, [
                ...params,
                `=comment=${comment}`,
                ...(firstId ? [`=place-before=${firstId}`] : [])
            ]);
        } catch (_) {
            await mikrotik.write(`${menu}/add`, [...params, `=comment=${comment}`]);
        }
        logger.info(`[RADIUS-ISOLIR-SYNC] ${menu} added: ${comment}`);
        return 'added';
    } catch (e) {
        logger.warn(`[RADIUS-ISOLIR-SYNC] add ${menu} "${comment}": ${e.message}`);
        return 'error';
    }
}

async function ensureAddressListEntry(mikrotik, list, address, comment) {
    if (!address || address === 'GANTI_IP_SERVER_BILLING') return;
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
        logger.warn(`[RADIUS-ISOLIR-SYNC] address-list ${list} ${address}: ${e.message}`);
    }
}

async function ensurePoolAndProfile(mikrotik, access) {
    // Pool
    try {
        const pools = await mikrotik.write('/ip/pool/print', [`?name=${access.isolirPoolName}`]);
        if (pools && pools.length) {
            await mikrotik.write('/ip/pool/set', [
                `=.id=${pools[0]['.id']}`,
                `=ranges=${access.poolRange}`,
                `=comment=${COMMENT_TAG} pool`
            ]);
        } else {
            await mikrotik.write('/ip/pool/add', [
                `=name=${access.isolirPoolName}`,
                `=ranges=${access.poolRange}`,
                `=comment=${COMMENT_TAG} pool`
            ]);
        }
    } catch (e) {
        logger.warn(`[RADIUS-ISOLIR-SYNC] pool: ${e.message}`);
    }

    // PPP profile (berguna untuk mode Mikrotik API; RADIUS tetap butuh pool di NAS)
    try {
        const profiles = await mikrotik.write('/ppp/profile/print', [`?name=${access.isolirProfile}`]);
        if (profiles && profiles.length) {
            await mikrotik.write('/ppp/profile/set', [
                `=.id=${profiles[0]['.id']}`,
                `=local-address=${access.localAddress}`,
                `=remote-address=${access.isolirPoolName}`,
                `=dns-server=${access.localAddress}`,
                '=only-one=yes',
                `=comment=${COMMENT_PPP} profile`
            ]);
        } else {
            await mikrotik.write('/ppp/profile/add', [
                `=name=${access.isolirProfile}`,
                `=local-address=${access.localAddress}`,
                `=remote-address=${access.isolirPoolName}`,
                `=dns-server=${access.localAddress}`,
                '=only-one=yes',
                `=comment=${COMMENT_PPP} profile`
            ]);
        }
    } catch (e) {
        logger.warn(`[RADIUS-ISOLIR-SYNC] ppp profile: ${e.message}`);
    }
}

async function ensureCaptiveDns(mikrotik, access) {
    if (!access.billingServerIp) return;
    for (const host of access.captiveHosts) {
        const comment = `${COMMENT_TAG} captive ${host}`;
        try {
            const existing = await findByComment(mikrotik, '/ip/dns/static', comment);
            if (existing.length) continue;
            await mikrotik.write('/ip/dns/static/add', [
                `=name=${host}`,
                `=address=${access.billingServerIp}`,
                '=ttl=30s',
                `=comment=${comment}`
            ]);
        } catch (e) {
            logger.warn(`[RADIUS-ISOLIR-SYNC] dns static ${host}: ${e.message}`);
        }
    }
    try {
        await mikrotik.write('/ip/dns/set', ['=allow-remote-requests=yes']);
    } catch (_) {}
}

/**
 * Pasang/perbarui firewall+NAT isolir PPPoE/RADIUS pada satu koneksi MikroTik.
 */
async function ensurePppoeIsolirFirewallOnConnection(mikrotik) {
    const access = getPppoeIsolirAccessConfig();
    const natResults = { added: 0, exists: 0, skipped: false, error: null };

    await ensurePoolAndProfile(mikrotik, access);

    // Address lists
    await ensureAddressListEntry(
        mikrotik,
        'isolir-users',
        access.isolirRange,
        `${COMMENT_TAG} users range`
    );
    await ensureAddressListEntry(
        mikrotik,
        'isolir-allowed-dst',
        access.billingServerIp,
        `${COMMENT_TAG} billing server`
    );
    if (access.billingHost && !isIpAddress(access.billingHost)) {
        await ensureAddressListEntry(
            mikrotik,
            'isolir-allowed-dst',
            access.billingHost,
            `${COMMENT_TAG} billing host DNS`
        );
    }
    for (const host of access.whatsappHosts) {
        await ensureAddressListEntry(
            mikrotik,
            'isolir-allowed-dst',
            host,
            `${COMMENT_TAG} whatsapp ${host}`
        );
    }

    await ensureCaptiveDns(mikrotik, access);

    // Filter: drop dulu, lalu allow di atasnya via place-before
    await ensureCommentRule(mikrotik, '/ip/firewall/filter', `${COMMENT_PPP} drop other`, [
        '=chain=forward',
        `=src-address=${access.isolirRange}`,
        '=action=drop'
    ]);
    await ensureCommentRule(mikrotik, '/ip/firewall/filter', `${COMMENT_PPP} allow dns udp fwd`, [
        '=chain=forward',
        `=src-address=${access.isolirRange}`,
        '=protocol=udp',
        '=dst-port=53',
        '=action=accept'
    ]);
    await ensureCommentRule(mikrotik, '/ip/firewall/filter', `${COMMENT_PPP} allow dns tcp fwd`, [
        '=chain=forward',
        `=src-address=${access.isolirRange}`,
        '=protocol=tcp',
        '=dst-port=53',
        '=action=accept'
    ]);
    await ensureCommentRule(mikrotik, '/ip/firewall/filter', `${COMMENT_PPP} allow dns udp in`, [
        '=chain=input',
        `=src-address=${access.isolirRange}`,
        '=protocol=udp',
        '=dst-port=53',
        '=action=accept'
    ]);
    await ensureCommentRule(mikrotik, '/ip/firewall/filter', `${COMMENT_PPP} allow dns tcp in`, [
        '=chain=input',
        `=src-address=${access.isolirRange}`,
        '=protocol=tcp',
        '=dst-port=53',
        '=action=accept'
    ]);
    await ensureCommentRule(mikrotik, '/ip/firewall/filter', `${COMMENT_PPP} allow whatsapp`, [
        '=chain=forward',
        `=src-address=${access.isolirRange}`,
        '=dst-address-list=isolir-allowed-dst',
        '=protocol=tcp',
        '=dst-port=80,443,5222,5223,5228,4244',
        '=action=accept'
    ]);
    if (access.billingServerIp) {
        await ensureCommentRule(mikrotik, '/ip/firewall/filter', `${COMMENT_PPP} allow billing`, [
            '=chain=forward',
            `=src-address=${access.isolirRange}`,
            `=dst-address=${access.billingServerIp}`,
            '=protocol=tcp',
            `=dst-port=${access.billingPorts}`,
            '=action=accept'
        ]);
    }
    await ensureCommentRule(mikrotik, '/ip/firewall/filter', `${COMMENT_PPP} allow established`, [
        '=chain=forward',
        '=connection-state=established,related',
        '=action=accept'
    ]);

    // NAT redirect
    const trackNat = async (comment, params) => {
        const r = await ensureCommentRule(mikrotik, '/ip/firewall/nat', comment, params);
        if (r === 'added') natResults.added++;
        else if (r === 'exists') natResults.exists++;
        else if (r === 'error') natResults.error = comment;
        return r;
    };

    if (access.billingServerIp) {
        await trackNat(`${COMMENT_PPP} masquerade billing`, [
            '=chain=srcnat',
            `=src-address=${access.isolirRange}`,
            `=dst-address=${access.billingServerIp}`,
            '=action=masquerade'
        ]);
        await trackNat(`${COMMENT_PPP} bypass allowed dst`, [
            '=chain=dstnat',
            `=src-address=${access.isolirRange}`,
            '=dst-address-list=isolir-allowed-dst',
            '=protocol=tcp',
            '=action=accept'
        ]);
        await trackNat(`${COMMENT_PPP} redirect http isolir`, [
            '=chain=dstnat',
            `=src-address=${access.isolirRange}`,
            '=protocol=tcp',
            '=dst-port=80,8080,8000,8888',
            '=action=dst-nat',
            `=to-addresses=${access.billingServerIp}`,
            `=to-ports=${access.isolirPort}`
        ]);
        await trackNat(`${COMMENT_PPP} force dns udp`, [
            '=chain=dstnat',
            `=src-address=${access.isolirRange}`,
            '=protocol=udp',
            '=dst-port=53',
            '=action=redirect',
            '=to-ports=53'
        ]);
        await trackNat(`${COMMENT_PPP} force dns tcp`, [
            '=chain=dstnat',
            `=src-address=${access.isolirRange}`,
            '=protocol=tcp',
            '=dst-port=53',
            '=action=redirect',
            '=to-ports=53'
        ]);
    } else {
        natResults.skipped = true;
        logger.warn(
            '[RADIUS-ISOLIR-SYNC] billingServerIp kosong — NAT redirect tidak dipasang. Set server_host (IP) di portal management.'
        );
    }

    // Pastikan group RADIUS isolir ada (best-effort)
    try {
        const { ensureIsolirProfileRadius } = require('./mikrotik');
        await ensureIsolirProfileRadius();
    } catch (e) {
        logger.warn(`[RADIUS-ISOLIR-SYNC] ensureIsolirProfileRadius: ${e.message}`);
    }

    return {
        success: !natResults.skipped,
        billing_server_ip: access.billingServerIp || null,
        isolir_port: access.isolirPort,
        isolir_range: access.isolirRange,
        isolir_pool: access.isolirPoolName,
        nat: natResults
    };
}

async function listRoutersForTenant(tenantId) {
    const tid = parseInt(tenantId, 10);
    const db = new sqlite3.Database(path.join(__dirname, '../data/billing.db'));
    try {
        const cols = `id, name, nas_ip, port, tenant_id, user, password, secret, location, pop`;
        return await new Promise((resolve) => {
            if (Number.isFinite(tid) && tid > 0) {
                db.all(
                    `SELECT ${cols} FROM routers WHERE tenant_id = ? ORDER BY name`,
                    [tid],
                    (err, rows) => resolve(err ? [] : rows || [])
                );
            } else {
                db.all(`SELECT ${cols} FROM routers ORDER BY name`, [], (err, rows) =>
                    resolve(err ? [] : rows || [])
                );
            }
        });
    } finally {
        db.close();
    }
}

async function syncPppoeIsolirFirewallForTenant(tenantId) {
    const access = getPppoeIsolirAccessConfig();
    const routers = await listRoutersForTenant(tenantId);
    const results = [];

    if (!routers.length) {
        return {
            success: false,
            message: 'Tidak ada router untuk tenant ini',
            billing_server_ip: access.billingServerIp || null,
            results: []
        };
    }

    for (const router of routers) {
        try {
            const mikrotik = await getMikrotikConnectionForRouter(router);
            const sync = await ensurePppoeIsolirFirewallOnConnection(mikrotik);
            results.push({
                success: true,
                router_id: router.id,
                router_name: router.name,
                nas_ip: router.nas_ip,
                billing_server_ip: sync.billing_server_ip,
                isolir_range: sync.isolir_range,
                isolir_pool: sync.isolir_pool,
                nat: sync.nat
            });
        } catch (e) {
            logger.warn(`[RADIUS-ISOLIR-SYNC] sync router ${router.id} (${router.name}): ${e.message}`);
            results.push({
                success: false,
                router_id: router.id,
                router_name: router.name,
                nas_ip: router.nas_ip,
                error: e.message
            });
        }
    }

    const ok = results.filter((r) => r.success).length;
    const failed = results.length - ok;
    return {
        success: failed === 0,
        message: failed
            ? `Sync selesai: ${ok} berhasil, ${failed} gagal`
            : `Sync berhasil ke ${ok} router`,
        billing_server_ip: access.billingServerIp || null,
        isolir_range: access.isolirRange,
        isolir_pool: access.isolirPoolName,
        results
    };
}

function getPppoeIsolirInfo() {
    const access = getPppoeIsolirAccessConfig();
    return {
        method: 'radius_framed_pool',
        isolir_profile: access.isolirProfile,
        isolir_pool: access.isolirPoolName,
        isolir_range: access.isolirRange,
        billing_server_ip: access.billingServerIp || null,
        isolir_port: access.isolirPort,
        description:
            'PPPoE/RADIUS isolir memakai group isolir + Framed-Pool; MikroTik redirect range pool ke halaman isolir'
    };
}

module.exports = {
    getPppoeIsolirAccessConfig,
    getPppoeIsolirInfo,
    ensurePppoeIsolirFirewallOnConnection,
    syncPppoeIsolirFirewallForTenant,
    listRoutersForTenant
};
