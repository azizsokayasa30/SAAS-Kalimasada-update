'use strict';

/**
 * Walled-garden isolir di MikroTik: pasang ulang filter/NAT dengan urutan yang benar.
 *
 * Masalah yang diperbaiki:
 * - place-before rule dinamis (dummy fasttrack) gagal → rule jatuh ke bawah fasttrack
 * - drop isolir dipasang di atas allow (halaman isolir ter-drop)
 * - sync "add if missing" tidak memperbaiki urutan / IP billing yang sudah salah
 * - NAT harus ke IP yang bisa dijangkau NAS (prioritas IP publik server_host; VPN tunnel opsional)
 * - bypass dstnat TCP semua port (termasuk 80) mengalahkan redirect HTTP captive portal
 * - static IP: drop chain=input memblokir DNS ke router; tidak ada hijack DNS captive
 */
const logger = require('./logger');
const { getSetting } = require('./settingsManager');
const { getTenantSetting } = require('./platform/tenantSettings');
const { getPublicAppBaseUrl } = require('./public-endpoint');

const ISOLIR_DNS_PORT = parseInt(process.env.ISOLIR_DNS_PORT || '5353', 10) || 5353;

const COMMENT_TAG = 'BILLING-ISOLIR';
const COMMENT_PPP = 'BILLING-ISOLIR pppoe';
const COMMENT_STATIC = 'BILLING-ISOLIR static';

const WHATSAPP_HOSTS = [
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
    'mmg-fna.whatsapp.net',
    'g.whatsapp.net',
    'facebook.com',
    'fbcdn.net',
    'fbsbx.com'
];

const CAPTIVE_HOSTS = [
    'captive.apple.com',
    'www.apple.com',
    'connectivitycheck.gstatic.com',
    'clients3.google.com',
    'www.msftconnecttest.com',
    'dns.msftncsi.com',
    'detectportal.firefox.com',
    'neverssl.com',
    'example.com'
];

function isIpAddress(value) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(value || '').trim());
}

function isDynamicRow(row) {
    const d = row && row.dynamic;
    return d === true || d === 'true' || d === 'yes';
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

async function getVpnTunnelIp() {
    try {
        const vpnService = require('./platform/vpnService');
        const server = await vpnService.getServer();
        const ip = String(server?.tunnel_address || '').split('/')[0].trim();
        if (isIpAddress(ip)) return ip;
    } catch (_) {}
    return '10.10.0.1';
}

/**
 * IP yang dipakai dst-nat to-addresses. Harus IP, bukan domain.
 * Prioritas IP publik (banyak NAS connect langsung, bukan lewat VPN).
 * Tunnel VPN hanya fallback jika server_host belum berupa IP.
 *
 * Override per-tenant: setting isolir_billing_server_ip / env ISOLIR_BILLING_SERVER_IP
 * (isi 10.10.0.1 jika tenant khusus hanya lewat WireGuard).
 */
async function resolveBillingServerIp() {
    const envIp = String(process.env.ISOLIR_BILLING_SERVER_IP || '').trim();
    const settingIp = String(settingOrGlobal('isolir_billing_server_ip', '') || '').trim();
    const billingIp = String(settingOrGlobal('billing_server_ip', '') || '').trim();
    const globalHost = String(getSetting('server_host', '') || '').trim();
    const tenantHost = String(settingOrGlobal('server_host', globalHost) || '').trim();
    const vpnIp = await getVpnTunnelIp();

    // Publik dulu (server_host), VPN terakhir — cocok multi-tenant campuran publik/VPN.
    const candidates = [envIp, settingIp, billingIp, tenantHost, globalHost, vpnIp];
    for (const value of candidates) {
        if (isIpAddress(value)) return value;
    }
    return '';
}

async function getIsolirAccessConfig() {
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

    const billingServerIp = await resolveBillingServerIp();
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
        billingPorts: Array.from(new Set([isolirPort, billingAppPort, String(ISOLIR_DNS_PORT), '80', '443', '53'].filter(Boolean))).join(','),
        isolirDnsPort: String(ISOLIR_DNS_PORT),
        poolRange: cidrToPoolRange(isolirRange),
        localAddress: gatewayFromCidr(isolirRange),
        vpnTunnelIp: await getVpnTunnelIp(),
        whatsappHosts: WHATSAPP_HOSTS,
        captiveHosts: CAPTIVE_HOSTS
    };
}

async function safeWrite(mikrotik, path, params = []) {
    try {
        return (await mikrotik.write(path, params)) || [];
    } catch (e) {
        const msg = String(e && e.message || e || '');
        const errno = e && e.errno;
        if (errno === 'UNKNOWNREPLY' || msg.includes('!empty') || msg.includes('unknown reply') || /empty/i.test(msg)) {
            return [];
        }
        throw e;
    }
}

/**
 * Patch node-routeros: RouterOS kadang balas !empty (bukan !done) saat hasil kosong.
 * Library melempar uncaughtException — treat !empty sebagai done kosong.
 */
function patchNodeRouterosEmptyReply() {
    try {
        const { Channel } = require('node-routeros/dist/Channel');
        if (!Channel || Channel.prototype.__isolirEmptyPatched) return;
        const orig = Channel.prototype.processPacket;
        Channel.prototype.processPacket = function isolirProcessPacket(packet) {
            if (!packet || !packet.length) return orig.call(this, packet);
            // RouterOS 7 kadang kirim !empty lalu !done. Abaikan !empty, tunggu !done.
            if (packet[0] === '!empty') {
                return;
            }
            return orig.call(this, packet);
        };
        Channel.prototype.__isolirEmptyPatched = true;
        logger.info('[ISOLIR-FW] node-routeros patched: ignore !empty');
    } catch (e) {
        logger.warn(`[ISOLIR-FW] gagal patch node-routeros: ${e.message}`);
    }
}

function hardenMikrotikConnection(mikrotik) {
    patchNodeRouterosEmptyReply();
    if (!mikrotik || mikrotik.__isolirHardened) return mikrotik;
    mikrotik.__isolirHardened = true;
    if (typeof mikrotik.on === 'function') {
        mikrotik.on('error', (err) => {
            const msg = String(err && err.message || err || '');
            if ((err && err.errno === 'UNKNOWNREPLY') || msg.includes('!empty')) return;
            logger.warn(`[ISOLIR-FW] mikrotik conn error: ${msg}`);
        });
    }
    return mikrotik;
}

async function printMenu(mikrotik, menu, query = []) {
    return safeWrite(mikrotik, `${menu}/print`, query);
}

/**
 * ID rule statis pertama pada chain tertentu — lewati dummy dynamic fasttrack.
 */
function firstStaticIdFromRows(rows, chain) {
    for (const row of rows || []) {
        if (isDynamicRow(row)) continue;
        if (chain && String(row.chain || '') !== String(chain)) continue;
        return row['.id'] || null;
    }
    return null;
}

async function findFirstStaticId(mikrotik, menu, chain) {
    return firstStaticIdFromRows(await printMenu(mikrotik, menu), chain);
}

function commentMatchesCleanup(comment, kind) {
    const c = String(comment || '');
    if (!c) return false;
    if (c.includes('STATIC-POOL')) return false;
    if (kind === 'static') {
        return c.includes(COMMENT_STATIC) || c === 'Block suspended customers (static IP)'
            || c === 'Block suspended customers from accessing router (static IP)';
    }
    // pppoe: rule pppoe + script generator lama (BILLING-ISOLIR tanpa tag static)
    if (c.includes(COMMENT_STATIC)) return false;
    return c.includes(COMMENT_TAG);
}

async function removeMatchingFromRows(mikrotik, menu, rows, kind) {
    let removed = 0;
    for (const row of rows || []) {
        if (isDynamicRow(row)) continue;
        if (!commentMatchesCleanup(row.comment, kind)) continue;
        try {
            await safeWrite(mikrotik, `${menu}/remove`, [`=.id=${row['.id']}`]);
            removed++;
        } catch (e) {
            const msg = String(e && e.message || '');
            if (!(e && e.errno === 'UNKNOWNREPLY') && !msg.includes('!empty')) {
                logger.warn(`[ISOLIR-FW] remove ${menu} "${row.comment}": ${e.message}`);
            }
        }
    }
    return removed;
}

async function removeMatching(mikrotik, menu, kind) {
    return removeMatchingFromRows(mikrotik, menu, await printMenu(mikrotik, menu), kind);
}

/**
 * Tambah rule di atas anchor tetap (satu print untuk anchor).
 * Urutan pemanggilan = urutan akhir dari atas ke bawah di atas anchor.
 */
async function addBeforeAnchor(mikrotik, menu, params, comment, anchorId) {
    const withComment = [...params, `=comment=${comment}`];
    try {
        await safeWrite(
            mikrotik,
            `${menu}/add`,
            anchorId ? [...withComment, `=place-before=${anchorId}`] : withComment
        );
        return 'added';
    } catch (e1) {
        try {
            await safeWrite(mikrotik, `${menu}/add`, withComment);
            logger.warn(`[ISOLIR-FW] place-before gagal untuk "${comment}", dipasang di akhir: ${e1.message}`);
            return 'added-end';
        } catch (e2) {
            logger.warn(`[ISOLIR-FW] add ${menu} "${comment}": ${e2.message}`);
            return 'error';
        }
    }
}

async function addAtTopOfChain(mikrotik, menu, chain, params, comment) {
    const placeId = await findFirstStaticId(mikrotik, menu, chain);
    return addBeforeAnchor(mikrotik, menu, params, comment, placeId);
}

async function ensureAddressListEntry(mikrotik, list, address, comment, existingRows = null) {
    if (!address || address === 'GANTI_IP_SERVER_BILLING') return;
    try {
        const all = existingRows || (await safeWrite(mikrotik, '/ip/firewall/address-list/print', [`?list=${list}`])) || [];
        const found = all.some((r) => String(r.address || '').trim() === String(address).trim());
        if (!found) {
            await safeWrite(mikrotik, '/ip/firewall/address-list/add', [
                `=list=${list}`,
                `=address=${address}`,
                `=comment=${comment}`
            ]);
            all.push({ address, list, comment });
        }
    } catch (e) {
        logger.warn(`[ISOLIR-FW] address-list ${list} ${address}: ${e.message}`);
    }
}

async function refreshSharedAllowLists(mikrotik, access) {
    let allowedRows = [];
    try {
        allowedRows = (await safeWrite(mikrotik, '/ip/firewall/address-list/print', []))
            .filter((r) => String(r.list || '') === 'isolir-allowed-dst');
    } catch (_) {
        allowedRows = [];
    }
    await ensureAddressListEntry(
        mikrotik,
        'isolir-allowed-dst',
        access.billingServerIp,
        `${COMMENT_TAG} billing server`,
        allowedRows
    );
    if (access.billingHost && !isIpAddress(access.billingHost)) {
        await ensureAddressListEntry(
            mikrotik,
            'isolir-allowed-dst',
            access.billingHost,
            `${COMMENT_TAG} billing host DNS`,
            allowedRows
        );
    }
    for (const host of access.whatsappHosts || []) {
        await ensureAddressListEntry(
            mikrotik,
            'isolir-allowed-dst',
            host,
            `${COMMENT_TAG} whatsapp ${host}`,
            allowedRows
        );
    }
}

async function refreshCaptiveDns(mikrotik, access) {
    // Jangan pasang DNS static global (bisa mengganggu pelanggan non-isolir yang pakai DNS router).
    // DNS klien isolir di-NAT ke sinkhole udp/5353 di server billing.
    const existing = await printMenu(mikrotik, '/ip/dns/static');
    for (const row of existing) {
        const c = String(row.comment || '');
        if (!c.includes(`${COMMENT_TAG} captive`)) continue;
        try {
            await mikrotik.write('/ip/dns/static/remove', [`=.id=${row['.id']}`]);
        } catch (_) {}
    }
    try {
        await safeWrite(mikrotik, '/ip/dns/set', ['=allow-remote-requests=yes']);
    } catch (_) {}
}

/**
 * Pasang filter+NAT isolir.
 * kind: 'pppoe' (src-address range pool) | 'static' (address-list isolir_customer)
 *
 * Optimasi: print filter/nat sekali, hapus rule lama, pasang ulang dengan 1 anchor place-before.
 * Urutan add = urutan akhir dari atas ke bawah (allow dulu, drop terakhir).
 */
async function applyIsolirWalledGarden(mikrotik, kind, access) {
    const isStatic = kind === 'static';
    const tag = isStatic ? COMMENT_STATIC : COMMENT_PPP;
    const srcParam = isStatic
        ? '=src-address-list=isolir_customer'
        : `=src-address=${access.isolirRange}`;
    const natResults = { added: 0, exists: 0, skipped: false, error: null, removed: 0 };

    const [filterRows, natRows] = await Promise.all([
        printMenu(mikrotik, '/ip/firewall/filter'),
        printMenu(mikrotik, '/ip/firewall/nat')
    ]);
    natResults.removed += await removeMatchingFromRows(mikrotik, '/ip/firewall/filter', filterRows, kind);
    natResults.removed += await removeMatchingFromRows(mikrotik, '/ip/firewall/nat', natRows, kind);

    // Setelah remove, ambil ulang anchor (hindari place-before id yang sudah dihapus)
    const [filterAfter, natAfter] = await Promise.all([
        printMenu(mikrotik, '/ip/firewall/filter'),
        printMenu(mikrotik, '/ip/firewall/nat')
    ]);
    const forwardAnchor = firstStaticIdFromRows(filterAfter, 'forward');
    const inputAnchor = firstStaticIdFromRows(filterAfter, 'input');
    const srcnatAnchor = firstStaticIdFromRows(natAfter, 'srcnat');
    const dstnatAnchor = firstStaticIdFromRows(natAfter, 'dstnat');

    if (!isStatic) {
        let userRows = [];
        try {
            userRows = (await safeWrite(mikrotik, '/ip/firewall/address-list/print', []))
                .filter((r) => String(r.list || '') === 'isolir-users');
        } catch (_) {}
        await ensureAddressListEntry(
            mikrotik,
            'isolir-users',
            access.isolirRange,
            `${COMMENT_TAG} users range`,
            userRows
        );
    }

    await refreshSharedAllowLists(mikrotik, access);
    await refreshCaptiveDns(mikrotik, access);

    const track = async (menu, params, comment, anchorId) => {
        const r = await addBeforeAnchor(mikrotik, menu, params, comment, anchorId);
        if (r === 'added' || r === 'added-end') natResults.added++;
        else if (r === 'error') natResults.error = comment;
        return r;
    };

    // FILTER forward — urutan akhir: established … drop (add dari atas ke bawah sebelum anchor)
    await track('/ip/firewall/filter', [
        '=chain=forward', srcParam, '=connection-state=established,related', '=action=accept'
    ], `${tag} allow established`, forwardAnchor);

    await track('/ip/firewall/filter', [
        '=chain=forward', srcParam, '=protocol=udp', '=dst-port=53', '=action=accept'
    ], `${tag} allow dns udp fwd`, forwardAnchor);

    await track('/ip/firewall/filter', [
        '=chain=forward', srcParam, '=protocol=tcp', '=dst-port=53', '=action=accept'
    ], `${tag} allow dns tcp fwd`, forwardAnchor);

    if (access.billingServerIp) {
        await track('/ip/firewall/filter', [
            '=chain=forward', srcParam, `=dst-address=${access.billingServerIp}`,
            '=protocol=udp', `=dst-port=53,${access.isolirDnsPort || ISOLIR_DNS_PORT}`, '=action=accept'
        ], `${tag} allow billing dns`, forwardAnchor);

        await track('/ip/firewall/filter', [
            '=chain=forward', srcParam, `=dst-address=${access.billingServerIp}`,
            '=protocol=tcp', `=dst-port=${access.billingPorts}`, '=action=accept'
        ], `${tag} allow billing`, forwardAnchor);
    }

    await track('/ip/firewall/filter', [
        '=chain=forward', srcParam, '=protocol=tcp',
        '=dst-port=80,443,5222,5223,5228,4244',
        '=dst-address-list=isolir-allowed-dst', '=action=accept'
    ], `${tag} allow whatsapp`, forwardAnchor);

    await track('/ip/firewall/filter', [
        '=chain=forward', srcParam, '=protocol=tcp', '=dst-port=443',
        '=action=reject', '=reject-with=tcp-reset'
    ], `${tag} reject https`, forwardAnchor);

    await track('/ip/firewall/filter', [
        '=chain=forward', srcParam, '=protocol=udp', '=dst-port=853', '=action=drop'
    ], `${tag} drop dot udp`, forwardAnchor);

    await track('/ip/firewall/filter', [
        '=chain=forward', srcParam, '=protocol=tcp', '=dst-port=853',
        '=action=reject', '=reject-with=tcp-reset'
    ], `${tag} reject dot tcp`, forwardAnchor);

    await track('/ip/firewall/filter', [
        '=chain=forward', srcParam, '=action=drop'
    ], `${tag} drop other`, forwardAnchor);

    // INPUT
    await track('/ip/firewall/filter', [
        '=chain=input', srcParam, '=protocol=udp', '=dst-port=53', '=action=accept'
    ], `${tag} allow dns udp in`, inputAnchor);

    await track('/ip/firewall/filter', [
        '=chain=input', srcParam, '=protocol=tcp', '=dst-port=53', '=action=accept'
    ], `${tag} allow dns tcp in`, inputAnchor);

    await track('/ip/firewall/filter', [
        '=chain=input', srcParam, '=action=drop'
    ], `${tag} drop input`, inputAnchor);

    if (!access.billingServerIp) {
        natResults.skipped = true;
        logger.warn(
            '[ISOLIR-FW] billingServerIp kosong — NAT redirect tidak dipasang. Set server_host (IP publik) atau isolir_billing_server_ip di settings.'
        );
        return {
            success: false,
            billing_server_ip: null,
            isolir_port: access.isolirPort,
            isolir_range: access.isolirRange,
            isolir_pool: access.isolirPoolName,
            nat: natResults
        };
    }

    // NAT — urutan akhir: force dns … redirect http … bypass … masquerade
    await track('/ip/firewall/nat', [
        '=chain=srcnat', srcParam, `=dst-address=${access.billingServerIp}`, '=action=masquerade'
    ], `${tag} masquerade billing`, srcnatAnchor);

    await track('/ip/firewall/nat', [
        '=chain=dstnat', srcParam, '=protocol=udp', '=dst-port=53',
        '=action=dst-nat', `=to-addresses=${access.billingServerIp}`,
        `=to-ports=${access.isolirDnsPort || ISOLIR_DNS_PORT}`
    ], `${tag} force dns udp`, dstnatAnchor);

    await track('/ip/firewall/nat', [
        '=chain=dstnat', srcParam, '=protocol=tcp', '=dst-port=53',
        '=action=dst-nat', `=to-addresses=${access.billingServerIp}`,
        `=to-ports=${access.isolirDnsPort || ISOLIR_DNS_PORT}`
    ], `${tag} force dns tcp`, dstnatAnchor);

    await track('/ip/firewall/nat', [
        '=chain=dstnat', srcParam, '=protocol=tcp', '=dst-port=80,8080,8000,8888',
        '=action=dst-nat', `=to-addresses=${access.billingServerIp}`,
        `=to-ports=${access.isolirPort}`
    ], `${tag} redirect http isolir`, dstnatAnchor);

    await track('/ip/firewall/nat', [
        '=chain=dstnat', srcParam, '=dst-address-list=isolir-allowed-dst',
        '=protocol=tcp', '=dst-port=443,5222,5223,5228,4244', '=action=accept'
    ], `${tag} bypass allowed dst`, dstnatAnchor);

    return {
        success: !natResults.error,
        billing_server_ip: access.billingServerIp,
        isolir_port: access.isolirPort,
        isolir_range: access.isolirRange,
        isolir_pool: access.isolirPoolName,
        nat: natResults
    };
}

module.exports = {
    COMMENT_TAG,
    COMMENT_PPP,
    COMMENT_STATIC,
    isIpAddress,
    normalizeCidr,
    cidrToPoolRange,
    gatewayFromCidr,
    getVpnTunnelIp,
    resolveBillingServerIp,
    getIsolirAccessConfig,
    applyIsolirWalledGarden,
    ensureAddressListEntry,
    safeWrite,
    hardenMikrotikConnection,
    patchNodeRouterosEmptyReply
};
