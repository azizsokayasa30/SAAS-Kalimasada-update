'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const tenantStore = require('./tenantStore');

const execFileAsync = promisify(execFile);

let schemaReady = false;

const HANDSHAKE_ONLINE_SEC = 180;
const HANDSHAKE_STALE_SEC = 900;
const PING_TIMEOUT_SEC = 2;
const MAX_PEERS_PER_TENANT = 20;

async function runSqlMigrationFile(migrationPath) {
    if (!fs.existsSync(migrationPath)) return;
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
        try {
            await tenantStore.dbRun(stmt);
        } catch (err) {
            const msg = String(err.message || '').toLowerCase();
            if (
                !msg.includes('already exists')
                && !msg.includes('duplicate column')
                && !msg.includes('no such column')
            ) {
                console.warn('[vpnService] migration warn:', err.message);
            }
        }
    }
}

async function ensureVpnSchema() {
    if (schemaReady) return;
    await runSqlMigrationFile(path.join(__dirname, '../../migrations/add_platform_vpn.sql'));
    await runSqlMigrationFile(path.join(__dirname, '../../migrations/add_platform_vpn_l2tp.sql'));

    const alterColumns = [
        'ALTER TABLE platform_vpn_peers ADD COLUMN peer_private_key TEXT',
        'ALTER TABLE platform_vpn_peers ADD COLUMN tenant_id INTEGER',
        'ALTER TABLE platform_vpn_server ADD COLUMN ipsec_psk TEXT',
        'ALTER TABLE platform_vpn_server ADD COLUMN l2tp_enabled INTEGER DEFAULT 1',
        "ALTER TABLE platform_vpn_peers ADD COLUMN protocol TEXT DEFAULT 'wireguard'",
        'ALTER TABLE platform_vpn_peers ADD COLUMN routeros_version TEXT',
        'ALTER TABLE platform_vpn_peers ADD COLUMN l2tp_username TEXT',
        'ALTER TABLE platform_vpn_peers ADD COLUMN l2tp_password TEXT',
    ];
    for (const stmt of alterColumns) {
        try {
            await tenantStore.dbRun(stmt);
        } catch (err) {
            const msg = String(err.message || '').toLowerCase();
            if (!msg.includes('duplicate column') && !msg.includes('no such table')) {
                // ignore expected alter races
            }
        }
    }
    try {
        await tenantStore.dbRun(
            'CREATE INDEX IF NOT EXISTS idx_platform_vpn_peers_tenant ON platform_vpn_peers(tenant_id)'
        );
    } catch (_) {
        /* ignore */
    }
    try {
        await tenantStore.dbRun(
            'CREATE INDEX IF NOT EXISTS idx_platform_vpn_peers_protocol ON platform_vpn_peers(protocol)'
        );
    } catch (_) {
        /* ignore */
    }
    try {
        await tenantStore.dbRun(
            `UPDATE platform_vpn_peers SET protocol = 'wireguard' WHERE protocol IS NULL OR protocol = ''`
        );
    } catch (_) {
        /* ignore */
    }
    schemaReady = true;
}

function sanitizeNamePart(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '');
}

/**
 * Nama perangkat final: {namatenant}-{namarouter}
 * Prefix memakai subdomain tenant (contoh skynet).
 */
function buildTenantPeerName(tenantPrefix, routerName) {
    const prefix = sanitizeNamePart(tenantPrefix).toLowerCase();
    const router = sanitizeNamePart(routerName);
    if (!prefix) throw new Error('Identitas tenant tidak valid untuk nama perangkat.');
    if (!router) throw new Error('Nama router wajib diisi.');
    return `${prefix}-${router}`;
}

function isVpnServerReady(server) {
    return !!(server && String(server.public_endpoint || '').trim() && String(server.server_public_key || '').trim());
}

function isL2tpServerReady(server) {
    return !!(
        server
        && String(server.public_endpoint || '').trim()
        && String(server.ipsec_psk || '').trim()
        && Number(server.l2tp_enabled) !== 0
    );
}

function normalizeProtocol(value) {
    const p = String(value || '').trim().toLowerCase();
    return p === 'l2tp' ? 'l2tp' : 'wireguard';
}

function normalizeRouterOsVersion(value) {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'v6' || v === '6') return 'v6';
    if (v === 'v7' || v === '7') return 'v7';
    return null;
}

function protocolFromRouterOs(routerosVersion) {
    const v = normalizeRouterOsVersion(routerosVersion);
    if (v === 'v6') return 'l2tp';
    if (v === 'v7') return 'wireguard';
    throw new Error('Versi RouterOS wajib v6 atau v7.');
}

function isWireGuardPeer(peer) {
    return normalizeProtocol(peer?.protocol) === 'wireguard';
}

function isL2tpPeer(peer) {
    return normalizeProtocol(peer?.protocol) === 'l2tp';
}

function generatePassword(length = 16) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
}

function generateIpsecPsk() {
    return crypto.randomBytes(24).toString('base64url');
}

function l2tpPlaceholderPublicKey(username) {
    const safe = sanitizeNamePart(username || crypto.randomBytes(8).toString('hex')).toLowerCase() || 'user';
    return `l2tp:${safe}:${crypto.randomBytes(8).toString('hex')}`;
}

function stripIp(addr) {
    return String(addr || '').trim().split('/')[0];
}

function defaultAllowedIps(tunnelIp) {
    const ip = stripIp(tunnelIp);
    return ip ? `${ip}/32` : '';
}

function ipv4ToInt(ip) {
    const parts = String(ip || '').split('.').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        return null;
    }
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function intToIpv4(n) {
    return [
        (n >>> 24) & 255,
        (n >>> 16) & 255,
        (n >>> 8) & 255,
        n & 255,
    ].join('.');
}

function parseCidr(cidr) {
    const raw = String(cidr || '').trim();
    const [ipPart, prefixPart] = raw.split('/');
    const base = ipv4ToInt(stripIp(ipPart));
    const prefix = Number(prefixPart);
    if (base == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
    const network = (base & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    return { network, broadcast, prefix };
}

/**
 * Ambil tunnel IP berikutnya yang belum dipakai (skip network, broadcast, IP server, peer existing).
 * Prioritas subnet: CIDR dari tunnel_address server, lalu network_subnet.
 */
async function allocateNextTunnelIp(excludePeerId = null) {
    await ensureVpnSchema();
    const server = await getServer();
    const tunnelCidr = String(server.tunnel_address || '').trim();
    const subnetHint = String(server.network_subnet || '').trim();
    const cidrCandidate = tunnelCidr.includes('/')
        ? tunnelCidr
        : (subnetHint.includes('/') ? subnetHint : `${stripIp(tunnelCidr || subnetHint || '10.10.0.0')}/24`);
    const parsed = parseCidr(cidrCandidate);
    if (!parsed) throw new Error('Network subnet / tunnel address server tidak valid.');

    const used = new Set();
    const serverIp = stripIp(server.tunnel_address);
    if (serverIp) used.add(serverIp);

    const peers = await listPeers();
    for (const peer of peers) {
        if (excludePeerId != null && Number(peer.id) === Number(excludePeerId)) continue;
        if (peer.tunnel_ip) used.add(stripIp(peer.tunnel_ip));
    }

    for (let n = parsed.network + 1; n < parsed.broadcast; n++) {
        const candidate = intToIpv4(n >>> 0);
        if (!used.has(candidate)) return candidate;
    }
    throw new Error('Tidak ada Tunnel IP tersisa di subnet VPN.');
}

async function assertTunnelIpAvailable(tunnelIp, excludePeerId = null) {
    const ip = stripIp(tunnelIp);
    if (!ip) throw new Error('Tunnel IP wajib diisi.');

    const server = await getServer();
    const serverIp = stripIp(server.tunnel_address);
    if (serverIp && ip === serverIp) {
        throw new Error(`Tunnel IP ${ip} dipakai server WireGuard.`);
    }

    const params = excludePeerId != null ? [ip, excludePeerId] : [ip];
    const sql = excludePeerId != null
        ? 'SELECT id, name FROM platform_vpn_peers WHERE tunnel_ip = ? AND id != ?'
        : 'SELECT id, name FROM platform_vpn_peers WHERE tunnel_ip = ?';
    const dup = await tenantStore.dbGet(sql, params);
    if (dup) throw new Error(`Tunnel IP ${ip} sudah dipakai oleh "${dup.name}".`);
    return ip;
}

function generateKeypairFallback() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
        publicKeyEncoding: { type: 'spki', format: 'der' },
    });
    return {
        privateKey: Buffer.from(privateKey).slice(-32).toString('base64'),
        publicKey: Buffer.from(publicKey).slice(-32).toString('base64'),
    };
}

async function generateKeypair() {
    try {
        const { stdout: priv } = await execFileAsync('wg', ['genkey'], { timeout: 5000 });
        const privateKey = String(priv || '').trim();
        const { stdout: pub } = await execFileAsync('wg', ['pubkey'], {
            timeout: 5000,
            input: privateKey + '\n',
        });
        return { privateKey, publicKey: String(pub || '').trim() };
    } catch (_) {
        return generateKeypairFallback();
    }
}

async function getServer() {
    await ensureVpnSchema();
    let row = await tenantStore.dbGet('SELECT * FROM platform_vpn_server ORDER BY id ASC LIMIT 1');
    if (!row) {
        const result = await tenantStore.dbRun(
            `INSERT INTO platform_vpn_server (
                public_endpoint, listen_port, wan_interface, tunnel_address,
                network_subnet, interface_name
             ) VALUES (?, ?, ?, ?, ?, ?)`,
            ['', 51820, 'eth0', '10.10.0.1/24', '10.10.0.0/24', 'wg0']
        );
        row = await tenantStore.dbGet('SELECT * FROM platform_vpn_server WHERE id = ?', [result.id]);
    }
    return row;
}

async function saveServer(data) {
    await ensureVpnSchema();
    const existing = await getServer();
    const publicEndpoint = String(data.public_endpoint || '').trim();
    const listenPort = Number(data.listen_port) || 51820;
    const wanInterface = String(data.wan_interface || 'eth0').trim() || 'eth0';
    const tunnelAddress = String(data.tunnel_address || '10.10.0.1/24').trim() || '10.10.0.1/24';
    const networkSubnet = String(data.network_subnet || '10.10.0.0/24').trim() || '10.10.0.0/24';
    const interfaceName = String(data.interface_name || 'wg0').trim() || 'wg0';

    let serverPublicKey = String(data.server_public_key || '').trim();
    let serverPrivateKey = String(data.server_private_key || '').trim();

    // Keep existing private key if form sent blank (masked) or omitted
    if (!serverPrivateKey && existing.server_private_key) {
        serverPrivateKey = existing.server_private_key;
    }
    if (!serverPublicKey && existing.server_public_key) {
        serverPublicKey = existing.server_public_key;
    }

    let ipsecPsk = String(data.ipsec_psk || '').trim();
    if (!ipsecPsk && existing.ipsec_psk) {
        ipsecPsk = existing.ipsec_psk;
    }
    const l2tpEnabled =
        data.l2tp_enabled === undefined || data.l2tp_enabled === null || data.l2tp_enabled === ''
            ? (existing.l2tp_enabled == null ? 1 : Number(existing.l2tp_enabled) ? 1 : 0)
            : (data.l2tp_enabled === '0' || data.l2tp_enabled === 0 || data.l2tp_enabled === false ? 0 : 1);

    await tenantStore.dbRun(
        `UPDATE platform_vpn_server SET
            public_endpoint = ?, listen_port = ?, wan_interface = ?, tunnel_address = ?,
            network_subnet = ?, server_public_key = ?, server_private_key = ?,
            interface_name = ?, ipsec_psk = ?, l2tp_enabled = ?,
            updated_at = datetime('now', 'localtime')
         WHERE id = ?`,
        [
            publicEndpoint || null,
            listenPort,
            wanInterface,
            tunnelAddress,
            networkSubnet,
            serverPublicKey || null,
            serverPrivateKey || null,
            interfaceName,
            ipsecPsk || null,
            l2tpEnabled,
            existing.id,
        ]
    );
    return getServer();
}

async function generateAndSaveKeys() {
    const keys = await generateKeypair();
    const existing = await getServer();
    await tenantStore.dbRun(
        `UPDATE platform_vpn_server SET
            server_public_key = ?, server_private_key = ?,
            updated_at = datetime('now', 'localtime')
         WHERE id = ?`,
        [keys.publicKey, keys.privateKey, existing.id]
    );
    return getServer();
}

async function generateAndSaveIpsecPsk() {
    const psk = generateIpsecPsk();
    const existing = await getServer();
    await tenantStore.dbRun(
        `UPDATE platform_vpn_server SET
            ipsec_psk = ?, l2tp_enabled = 1,
            updated_at = datetime('now', 'localtime')
         WHERE id = ?`,
        [psk, existing.id]
    );
    return getServer();
}

async function listPeers({ tenantId = null } = {}) {
    await ensureVpnSchema();
    if (tenantId != null) {
        return tenantStore.dbAll(
            `SELECT p.*, t.name AS tenant_name, t.subdomain AS tenant_subdomain
             FROM platform_vpn_peers p
             LEFT JOIN tenants t ON t.id = p.tenant_id
             WHERE p.tenant_id = ?
             ORDER BY p.name ASC`,
            [tenantId]
        );
    }
    return tenantStore.dbAll(
        `SELECT p.*, t.name AS tenant_name, t.subdomain AS tenant_subdomain
         FROM platform_vpn_peers p
         LEFT JOIN tenants t ON t.id = p.tenant_id
         ORDER BY p.name ASC`
    );
}

async function countPeersByTenant(tenantId) {
    await ensureVpnSchema();
    const row = await tenantStore.dbGet(
        'SELECT COUNT(*) AS total FROM platform_vpn_peers WHERE tenant_id = ?',
        [tenantId]
    );
    return Number(row?.total) || 0;
}

async function getPeerById(id) {
    await ensureVpnSchema();
    return tenantStore.dbGet(
        `SELECT p.*, t.name AS tenant_name, t.subdomain AS tenant_subdomain
         FROM platform_vpn_peers p
         LEFT JOIN tenants t ON t.id = p.tenant_id
         WHERE p.id = ?`,
        [id]
    );
}

async function getPeerByIdForTenant(id, tenantId) {
    const peer = await getPeerById(id);
    if (!peer || Number(peer.tenant_id) !== Number(tenantId)) return null;
    return peer;
}

function normalizePeerInput(data, { requireTunnelIp = true, requirePublicKey = true } = {}) {
    const name = String(data.name || '').trim();
    const tunnelIp = stripIp(data.tunnel_ip);
    const peerPublicKey = String(data.peer_public_key || '').trim();
    const peerPrivateKey = String(data.peer_private_key || '').trim() || null;
    const allowedIps = String(data.allowed_ips || '').trim() || (tunnelIp ? defaultAllowedIps(tunnelIp) : '');
    const keepalive = Number(data.persistent_keepalive);
    const notes = String(data.notes || '').trim() || null;
    const isActive = data.is_active === '0' || data.is_active === 0 ? 0 : 1;
    const tenantIdRaw = data.tenant_id;
    const tenantId =
        tenantIdRaw === '' || tenantIdRaw == null || tenantIdRaw === undefined
            ? null
            : Number(tenantIdRaw);
    const protocol = normalizeProtocol(data.protocol);
    const routerosVersion = normalizeRouterOsVersion(data.routeros_version)
        || (protocol === 'l2tp' ? 'v6' : 'v7');
    const l2tpUsername = String(data.l2tp_username || '').trim() || null;
    const l2tpPassword = String(data.l2tp_password || '').trim() || null;

    if (!name) throw new Error('Nama perangkat wajib diisi.');
    if (requireTunnelIp && !tunnelIp) throw new Error('Tunnel IP wajib diisi.');
    if (requirePublicKey && !peerPublicKey) throw new Error('Public key peer wajib diisi.');

    return {
        name,
        tunnelIp: tunnelIp || null,
        peerPublicKey: peerPublicKey || null,
        peerPrivateKey,
        allowedIps,
        keepalive: Number.isFinite(keepalive) && keepalive >= 0 ? keepalive : 25,
        notes,
        isActive,
        tenantId: Number.isFinite(tenantId) && tenantId > 0 ? tenantId : null,
        protocol,
        routerosVersion,
        l2tpUsername,
        l2tpPassword,
    };
}

async function assertPeerNameAvailable(name, excludePeerId = null) {
    const params = excludePeerId != null ? [name, excludePeerId] : [name];
    const sql = excludePeerId != null
        ? 'SELECT id FROM platform_vpn_peers WHERE name = ? AND id != ?'
        : 'SELECT id FROM platform_vpn_peers WHERE name = ?';
    const dup = await tenantStore.dbGet(sql, params);
    if (dup) throw new Error(`Nama perangkat "${name}" sudah terdaftar.`);
}

async function assertL2tpUsernameAvailable(username, excludePeerId = null) {
    if (!username) return;
    const params = excludePeerId != null ? [username, excludePeerId] : [username];
    const sql = excludePeerId != null
        ? 'SELECT id, name FROM platform_vpn_peers WHERE l2tp_username = ? AND id != ?'
        : 'SELECT id, name FROM platform_vpn_peers WHERE l2tp_username = ?';
    const dup = await tenantStore.dbGet(sql, params);
    if (dup) throw new Error(`Username L2TP "${username}" sudah dipakai oleh "${dup.name}".`);
}

async function createPeer(data) {
    await ensureVpnSchema();

    let protocol = normalizeProtocol(data.protocol);
    if (data.routeros_version && !data.protocol) {
        protocol = protocolFromRouterOs(data.routeros_version);
    }
    const routerosVersion = normalizeRouterOsVersion(data.routeros_version)
        || (protocol === 'l2tp' ? 'v6' : 'v7');

    // Tunnel IP otomatis jika kosong
    let tunnelIp = stripIp(data.tunnel_ip);
    if (!tunnelIp) {
        tunnelIp = await allocateNextTunnelIp();
    } else {
        tunnelIp = await assertTunnelIpAvailable(tunnelIp);
    }

    let peerPublicKey = String(data.peer_public_key || '').trim();
    let peerPrivateKey = String(data.peer_private_key || '').trim() || null;
    let l2tpUsername = String(data.l2tp_username || '').trim() || null;
    let l2tpPassword = String(data.l2tp_password || '').trim() || null;

    if (protocol === 'l2tp') {
        if (!l2tpUsername) {
            l2tpUsername = sanitizeNamePart(data.name || 'l2tp-user').toLowerCase() || `l2tp-${Date.now()}`;
        }
        if (!l2tpPassword) l2tpPassword = generatePassword(16);
        await assertL2tpUsernameAvailable(l2tpUsername);
        if (!peerPublicKey) peerPublicKey = l2tpPlaceholderPublicKey(l2tpUsername);
        peerPrivateKey = null;
    } else if (!peerPublicKey) {
        const keys = await generateKeypair();
        peerPublicKey = keys.publicKey;
        peerPrivateKey = keys.privateKey;
    }

    const p = normalizePeerInput({
        ...data,
        protocol,
        routeros_version: routerosVersion,
        tunnel_ip: tunnelIp,
        peer_public_key: peerPublicKey,
        peer_private_key: peerPrivateKey,
        l2tp_username: l2tpUsername,
        l2tp_password: l2tpPassword,
        allowed_ips: String(data.allowed_ips || '').trim() || defaultAllowedIps(tunnelIp),
    }, { requirePublicKey: protocol === 'wireguard' });

    await assertPeerNameAvailable(p.name);

    if (p.protocol === 'wireguard') {
        const dupKey = await tenantStore.dbGet(
            'SELECT id FROM platform_vpn_peers WHERE peer_public_key = ?',
            [p.peerPublicKey]
        );
        if (dupKey) throw new Error('Public key peer sudah terdaftar.');
    }

    const result = await tenantStore.dbRun(
        `INSERT INTO platform_vpn_peers
            (name, tunnel_ip, peer_public_key, peer_private_key, allowed_ips, persistent_keepalive,
             notes, is_active, tenant_id, protocol, routeros_version, l2tp_username, l2tp_password)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            p.name,
            p.tunnelIp,
            p.peerPublicKey,
            p.peerPrivateKey,
            p.allowedIps,
            p.keepalive,
            p.notes,
            p.isActive,
            p.tenantId,
            p.protocol,
            p.routerosVersion,
            p.l2tpUsername,
            p.l2tpPassword,
        ]
    );

    const peer = await getPeerById(result.id);
    if (isWireGuardPeer(peer)) {
        await syncPeerToLiveWg(peer).catch((err) => {
            console.warn('[vpnService] sync peer to wg:', err.message);
        });
    } else {
        await syncL2tpSecrets().catch((err) => {
            console.warn('[vpnService] sync l2tp secrets:', err.message);
        });
    }
    return peer;
}

/**
 * Request peer dari tenant admin: auto name, keys/creds, tunnel IP, bind tenant_id.
 * RouterOS v7 → WireGuard, v6 → L2TP/IPsec.
 */
async function createPeerForTenant({ tenantId, tenantPrefix, routerName, routerosVersion, notes = null }) {
    await ensureVpnSchema();
    const server = await getServer();
    const protocol = protocolFromRouterOs(routerosVersion);

    if (protocol === 'wireguard') {
        if (!isVpnServerReady(server)) {
            throw new Error('VPN platform belum siap — hubungi Kalimasada untuk mengaktifkan WireGuard.');
        }
    } else if (!isL2tpServerReady(server)) {
        throw new Error('VPN platform belum siap — hubungi Kalimasada untuk mengaktifkan L2TP/IPsec.');
    }

    const tid = Number(tenantId);
    if (!Number.isFinite(tid) || tid <= 0) throw new Error('Tenant tidak valid.');

    const count = await countPeersByTenant(tid);
    if (count >= MAX_PEERS_PER_TENANT) {
        throw new Error(`Batas maksimal ${MAX_PEERS_PER_TENANT} perangkat VPN per tenant tercapai.`);
    }

    const name = buildTenantPeerName(tenantPrefix, routerName);
    return createPeer({
        name,
        tenant_id: tid,
        protocol,
        routeros_version: normalizeRouterOsVersion(routerosVersion),
        notes: notes || `Diminta dari tenant ${sanitizeNamePart(tenantPrefix)} (${protocol})`,
        is_active: 1,
        l2tp_username: protocol === 'l2tp' ? sanitizeNamePart(name).toLowerCase() : null,
    });
}

async function updatePeer(id, data) {
    await ensureVpnSchema();
    const existing = await getPeerById(id);
    if (!existing) throw new Error('Peer tidak ditemukan.');

    const protocol = data.protocol != null
        ? normalizeProtocol(data.protocol)
        : normalizeProtocol(existing.protocol);
    const routerosVersion = normalizeRouterOsVersion(data.routeros_version)
        || existing.routeros_version
        || (protocol === 'l2tp' ? 'v6' : 'v7');

    const tunnelIp = await assertTunnelIpAvailable(
        stripIp(data.tunnel_ip) || existing.tunnel_ip,
        id
    );

    let peerPublicKey = String(data.peer_public_key || '').trim() || existing.peer_public_key;
    let peerPrivateKey =
        String(data.peer_private_key || '').trim() || existing.peer_private_key || null;
    let l2tpUsername = String(data.l2tp_username || '').trim() || existing.l2tp_username || null;
    let l2tpPassword = String(data.l2tp_password || '').trim() || existing.l2tp_password || null;

    if (protocol === 'l2tp') {
        if (!l2tpUsername) {
            l2tpUsername = sanitizeNamePart(data.name || existing.name).toLowerCase();
        }
        if (!l2tpPassword) l2tpPassword = generatePassword(16);
        await assertL2tpUsernameAvailable(l2tpUsername, id);
        if (!peerPublicKey || isWireGuardPeer(existing) || !String(peerPublicKey).startsWith('l2tp:')) {
            peerPublicKey = l2tpPlaceholderPublicKey(l2tpUsername);
        }
        peerPrivateKey = null;
    } else {
        const pCheck = normalizePeerInput({
            ...data,
            name: data.name || existing.name,
            tunnel_ip: tunnelIp,
            peer_public_key: peerPublicKey,
            peer_private_key: peerPrivateKey,
            protocol,
        });
        peerPublicKey = pCheck.peerPublicKey;
        peerPrivateKey = pCheck.peerPrivateKey;
    }

    const p = normalizePeerInput({
        ...data,
        name: data.name || existing.name,
        tunnel_ip: tunnelIp,
        peer_public_key: peerPublicKey,
        peer_private_key: peerPrivateKey,
        protocol,
        routeros_version: routerosVersion,
        l2tp_username: l2tpUsername,
        l2tp_password: l2tpPassword,
        allowed_ips: String(data.allowed_ips || '').trim() || existing.allowed_ips || defaultAllowedIps(tunnelIp),
        persistent_keepalive: data.persistent_keepalive != null
            ? data.persistent_keepalive
            : existing.persistent_keepalive,
        notes: data.notes !== undefined ? data.notes : existing.notes,
        is_active: data.is_active !== undefined ? data.is_active : existing.is_active,
    }, { requirePublicKey: protocol === 'wireguard' });

    if (p.protocol === 'wireguard') {
        const dupKey = await tenantStore.dbGet(
            'SELECT id FROM platform_vpn_peers WHERE peer_public_key = ? AND id != ?',
            [p.peerPublicKey, id]
        );
        if (dupKey) throw new Error('Public key peer sudah terdaftar.');
    }

    // Keep existing private key if public key unchanged and form didn't send a new private key
    let privateKey = p.peerPrivateKey;
    if (p.protocol === 'wireguard') {
        if (p.peerPublicKey === existing.peer_public_key && !String(data.peer_private_key || '').trim()) {
            privateKey = existing.peer_private_key || null;
        } else if (p.peerPublicKey !== existing.peer_public_key && !String(data.peer_private_key || '').trim()) {
            privateKey = null;
        }
    } else {
        privateKey = null;
    }

    const tenantId =
        data.tenant_id === undefined
            ? (existing.tenant_id != null ? Number(existing.tenant_id) : null)
            : (data.tenant_id === '' || data.tenant_id == null
                ? null
                : Number(data.tenant_id));

    await assertPeerNameAvailable(p.name, id);

    await tenantStore.dbRun(
        `UPDATE platform_vpn_peers SET
            name = ?, tunnel_ip = ?, peer_public_key = ?, peer_private_key = ?, allowed_ips = ?,
            persistent_keepalive = ?, notes = ?, is_active = ?, tenant_id = ?,
            protocol = ?, routeros_version = ?, l2tp_username = ?, l2tp_password = ?,
            updated_at = datetime('now', 'localtime')
         WHERE id = ?`,
        [
            p.name,
            p.tunnelIp,
            p.peerPublicKey,
            privateKey,
            p.allowedIps,
            p.keepalive,
            p.notes,
            p.isActive,
            Number.isFinite(tenantId) && tenantId > 0 ? tenantId : null,
            p.protocol,
            p.routerosVersion,
            p.l2tpUsername,
            p.l2tpPassword,
            id,
        ]
    );

    const peer = await getPeerById(id);

    if (isWireGuardPeer(existing) && existing.peer_public_key) {
        if (!isWireGuardPeer(peer) || existing.peer_public_key !== peer.peer_public_key) {
            await removePeerFromLiveWg(existing.peer_public_key).catch(() => {});
        }
    }
    if (isWireGuardPeer(peer)) {
        await syncPeerToLiveWg(peer).catch((err) => {
            console.warn('[vpnService] sync peer to wg:', err.message);
        });
    }
    if (isL2tpPeer(existing) || isL2tpPeer(peer)) {
        await syncL2tpSecrets().catch((err) => {
            console.warn('[vpnService] sync l2tp secrets:', err.message);
        });
    }
    return peer;
}

async function deletePeer(id) {
    await ensureVpnSchema();
    const existing = await getPeerById(id);
    if (existing && isWireGuardPeer(existing) && existing.peer_public_key) {
        await removePeerFromLiveWg(existing.peer_public_key).catch(() => {});
    }
    await tenantStore.dbRun('DELETE FROM platform_vpn_peers WHERE id = ?', [id]);
    if (existing && isL2tpPeer(existing)) {
        await syncL2tpSecrets().catch((err) => {
            console.warn('[vpnService] sync l2tp secrets after delete:', err.message);
        });
    }
}

const CHAP_SECRETS_MARKER_START = '# BEGIN platform-vpn-l2tp';
const CHAP_SECRETS_MARKER_END = '# END platform-vpn-l2tp';
const CHAP_SECRETS_PATH = '/etc/ppp/chap-secrets';

function buildChapSecretsBlock(peers) {
    const lines = [CHAP_SECRETS_MARKER_START];
    for (const peer of peers || []) {
        if (!peer.is_active || !isL2tpPeer(peer) || !peer.l2tp_username || !peer.l2tp_password) continue;
        const user = String(peer.l2tp_username).replace(/\s+/g, '');
        const pass = String(peer.l2tp_password).replace(/\s+/g, '');
        const ip = stripIp(peer.tunnel_ip) || '*';
        lines.push(`# ${peer.name}`);
        lines.push(`${user}\t*\t${pass}\t${ip}`);
    }
    lines.push(CHAP_SECRETS_MARKER_END);
    return lines.join('\n');
}

async function syncL2tpSecrets() {
    const peers = await listPeers();
    const block = buildChapSecretsBlock(peers);
    const writeViaShell = async (cmd, args) => {
        await execFileAsync(cmd, args, { timeout: 8000 });
    };

    try {
        // Skip silently if PPP stack not installed yet (script VPS will create it)
        const pppDir = path.dirname(CHAP_SECRETS_PATH);
        if (!fs.existsSync(pppDir)) {
            return;
        }

        let existing = '';
        try {
            existing = fs.readFileSync(CHAP_SECRETS_PATH, 'utf8');
        } catch (_) {
            existing = '';
        }
        const start = existing.indexOf(CHAP_SECRETS_MARKER_START);
        const end = existing.indexOf(CHAP_SECRETS_MARKER_END);
        let next;
        if (start >= 0 && end > start) {
            next = existing.slice(0, start).replace(/\s+$/, '')
                + '\n' + block + '\n'
                + existing.slice(end + CHAP_SECRETS_MARKER_END.length).replace(/^\s+/, '');
        } else {
            next = (existing ? existing.replace(/\s+$/, '') + '\n\n' : '') + block + '\n';
        }
        const tmp = `/tmp/platform-vpn-chap-secrets-${process.pid}.tmp`;
        fs.writeFileSync(tmp, next, { mode: 0o600 });
        try {
            fs.copyFileSync(tmp, CHAP_SECRETS_PATH);
            fs.chmodSync(CHAP_SECRETS_PATH, 0o600);
        } catch (_) {
            await writeViaShell('sudo', ['cp', tmp, CHAP_SECRETS_PATH]);
            await writeViaShell('sudo', ['chmod', '600', CHAP_SECRETS_PATH]);
        }
        try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    } catch (err) {
        throw new Error(`Gagal sync chap-secrets: ${err.message}`);
    }
}

async function syncPeerToLiveWg(peer) {
    if (!peer || !peer.is_active || !peer.peer_public_key || !isWireGuardPeer(peer)) return;
    if (String(peer.peer_public_key).startsWith('l2tp:')) return;
    const server = await getServer();
    const iface = server.interface_name || 'wg0';
    const allowed = peer.allowed_ips || defaultAllowedIps(peer.tunnel_ip);
    const keepalive = String(peer.persistent_keepalive != null ? peer.persistent_keepalive : 25);
    const args = [
        'set', iface,
        'peer', peer.peer_public_key,
        'allowed-ips', allowed,
        'persistent-keepalive', keepalive,
    ];
    try {
        await execFileAsync('wg', args, { timeout: 5000 });
    } catch (_) {
        await execFileAsync('sudo', ['wg', ...args], { timeout: 5000 });
    }
}

async function removePeerFromLiveWg(publicKey) {
    if (!publicKey) return;
    const server = await getServer();
    const iface = server.interface_name || 'wg0';
    try {
        await execFileAsync('wg', ['set', iface, 'peer', publicKey, 'remove'], { timeout: 5000 });
    } catch (_) {
        try {
            await execFileAsync('sudo', ['wg', 'set', iface, 'peer', publicKey, 'remove'], { timeout: 5000 });
        } catch (__) {
            /* ignore if wg not running */
        }
    }
}

function formatBytes(n) {
    const num = Number(n) || 0;
    if (num < 1024) return `${num} B`;
    if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
    if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
    return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function classifyHandshake(latestHandshake) {
    const hs = Number(latestHandshake) || 0;
    if (!hs) return { status: 'offline', label: 'Offline', handshakeAgeSec: null };
    const age = Math.floor(Date.now() / 1000) - hs;
    if (age <= HANDSHAKE_ONLINE_SEC) {
        return { status: 'online', label: 'Online', handshakeAgeSec: age };
    }
    if (age <= HANDSHAKE_STALE_SEC) {
        return { status: 'stale', label: 'Stale', handshakeAgeSec: age };
    }
    return { status: 'offline', label: 'Offline', handshakeAgeSec: age };
}

function classifyPing(latencyMs, ok) {
    if (!ok || latencyMs == null) {
        return { quality: 'timeout', label: 'Timeout', latencyMs: null };
    }
    if (latencyMs < 50) return { quality: 'good', label: 'Baik', latencyMs };
    if (latencyMs < 150) return { quality: 'fair', label: 'Sedang', latencyMs };
    return { quality: 'poor', label: 'Buruk', latencyMs };
}

async function pingHost(ip) {
    const target = stripIp(ip);
    if (!target) return { ok: false, latencyMs: null };
    try {
        const { stdout } = await execFileAsync(
            'ping',
            ['-c', '1', '-W', String(PING_TIMEOUT_SEC), target],
            { timeout: (PING_TIMEOUT_SEC + 1) * 1000 }
        );
        const match = String(stdout).match(/time[=<]([\d.]+)\s*ms/i);
        const latencyMs = match ? Math.round(parseFloat(match[1])) : null;
        return { ok: true, latencyMs };
    } catch (_) {
        return { ok: false, latencyMs: null };
    }
}

/**
 * Parse `wg show <iface> dump` output into a map keyed by peer public key.
 * Dump format:
 *   iface: private-key\tpublic-key\tlisten-port\tfwmark
 *   peer:  public-key\tpreshared-key\tendpoint\tallowed-ips\tlatest-handshake\trx\ttx\tkeepalive
 */
async function readWgDump(interfaceName) {
    const iface = String(interfaceName || 'wg0').trim() || 'wg0';
    const tryCmds = [
        ['wg', ['show', iface, 'dump']],
        ['sudo', ['wg', 'show', iface, 'dump']],
        ['wg', ['show', 'all', 'dump']],
    ];

    let stdout = '';
    let usedIface = iface;
    let lastErr = null;

    for (const [cmd, args] of tryCmds) {
        try {
            const result = await execFileAsync(cmd, args, { timeout: 5000 });
            stdout = String(result.stdout || '');
            if (args.includes('all')) usedIface = 'all';
            lastErr = null;
            break;
        } catch (err) {
            lastErr = err;
        }
    }

    if (lastErr && !stdout) {
        return { available: false, peers: new Map(), error: lastErr.message, interfaceName: iface };
    }

    const peers = new Map();
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
        const parts = line.split('\t');
        // Peer lines have 8 fields; interface lines have 4
        if (parts.length >= 8) {
            const [
                publicKey,
                ,
                endpoint,
                allowedIps,
                latestHandshake,
                transferRx,
                transferTx,
                persistentKeepalive,
            ] = parts;
            peers.set(publicKey, {
                publicKey,
                endpoint: endpoint === '(none)' ? null : endpoint,
                allowedIps,
                latestHandshake: Number(latestHandshake) || 0,
                transferRx: Number(transferRx) || 0,
                transferTx: Number(transferTx) || 0,
                persistentKeepalive: Number(persistentKeepalive) || 0,
            });
        }
    }

    return { available: true, peers, error: null, interfaceName: usedIface };
}

function formatHandshakeAge(ageSec) {
    if (ageSec == null) return '—';
    if (ageSec < 60) return `${ageSec}s lalu`;
    if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m lalu`;
    if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}j lalu`;
    return `${Math.floor(ageSec / 86400)}h lalu`;
}

async function getDevicesStatus({ tenantId = null } = {}) {
    const [server, peers] = await Promise.all([
        getServer(),
        listPeers(tenantId != null ? { tenantId } : {}),
    ]);
    const dump = await readWgDump(server.interface_name);

    const devices = [];
    for (const peer of peers) {
        const protocol = normalizeProtocol(peer.protocol);
        const ping = await pingHost(peer.tunnel_ip);
        const pingClass = classifyPing(ping.latencyMs, ping.ok);

        let connectionStatus;
        let connectionLabel;
        let handshakeAgeSec = null;
        let handshakeAgeLabel = '—';
        let endpoint = null;
        let transferRx = 0;
        let transferTx = 0;
        let transferLabel = '—';

        if (protocol === 'l2tp') {
            connectionStatus = ping.ok ? 'online' : 'offline';
            connectionLabel = ping.ok ? 'Online (ping)' : 'Offline';
        } else {
            const live = dump.peers.get(peer.peer_public_key) || null;
            const hs = classifyHandshake(live ? live.latestHandshake : 0);
            connectionStatus = hs.status;
            connectionLabel = hs.label;
            handshakeAgeSec = hs.handshakeAgeSec;
            handshakeAgeLabel = formatHandshakeAge(hs.handshakeAgeSec);
            endpoint = live ? live.endpoint : null;
            transferRx = live ? live.transferRx : 0;
            transferTx = live ? live.transferTx : 0;
            transferLabel = live
                ? `↓ ${formatBytes(live.transferRx)} / ↑ ${formatBytes(live.transferTx)}`
                : '—';
            if (!dump.available) {
                connectionStatus = ping.ok ? 'online' : 'offline';
                connectionLabel = ping.ok ? 'Online (ping)' : 'Offline';
            }
        }

        devices.push({
            ...peer,
            protocol,
            wgAvailable: dump.available,
            connectionStatus,
            connectionLabel,
            handshakeAgeSec,
            handshakeAgeLabel,
            endpoint,
            transferRx,
            transferTx,
            transferLabel,
            pingQuality: pingClass.quality,
            pingLabel: pingClass.label,
            pingMs: pingClass.latencyMs,
        });
    }

    return {
        wgAvailable: dump.available,
        wgError: dump.error,
        interfaceName: server.interface_name,
        devices,
    };
}

function buildVpsSetupScript(server, peers) {
    const iface = server.interface_name || 'wg0';
    const port = server.listen_port || 51820;
    const wan = server.wan_interface || 'eth0';
    const tunnel = server.tunnel_address || '10.10.0.1/24';
    const subnet = server.network_subnet || '10.10.0.0/24';
    const priv = server.server_private_key || 'REPLACE_WITH_PRIVATE_KEY';
    const activePeers = (peers || []).filter((p) => p.is_active && isWireGuardPeer(p) && p.peer_public_key && !String(p.peer_public_key).startsWith('l2tp:'));

    const peerBlocks = activePeers
        .map(
            (p) => `[Peer]
# ${p.name}
PublicKey = ${p.peer_public_key}
AllowedIPs = ${p.allowed_ips || defaultAllowedIps(p.tunnel_ip)}
PersistentKeepalive = ${p.persistent_keepalive || 25}`
        )
        .join('\n\n');

    return `#!/bin/bash
# ===========================================
# Script Konfigurasi VPS WireGuard (SaaS Management)
# Generated: ${new Date().toISOString()}
# ===========================================
set -euo pipefail

echo "Menginstall WireGuard..."
sudo apt update
sudo apt install -y wireguard net-tools iputils-ping

sudo mkdir -p /etc/wireguard
umask 077

# Gunakan private key dari portal (atau ganti manual)
PRIVATE_KEY='${priv}'
echo "$PRIVATE_KEY" | sudo tee /etc/wireguard/private.key > /dev/null
sudo cat /etc/wireguard/private.key | wg pubkey | sudo tee /etc/wireguard/public.key > /dev/null

sudo tee /etc/wireguard/${iface}.conf > /dev/null <<'WGEOF'
[Interface]
Address = ${tunnel}
ListenPort = ${port}
PrivateKey = ${priv}
SaveConfig = false
PostUp = iptables -A FORWARD -i ${iface} -j ACCEPT; iptables -t nat -A POSTROUTING -o ${wan} -j MASQUERADE
PostDown = iptables -D FORWARD -i ${iface} -j ACCEPT; iptables -t nat -D POSTROUTING -o ${wan} -j MASQUERADE

${peerBlocks}
WGEOF

# Perbaiki PrivateKey di conf (heredoc quoted menahan literal — rewrite)
sudo sed -i "s|^PrivateKey = .*|PrivateKey = $PRIVATE_KEY|" /etc/wireguard/${iface}.conf

echo "net.ipv4.ip_forward=1" | sudo tee /etc/sysctl.d/99-wireguard.conf
sudo sysctl --system

sudo ufw allow ${port}/udp || true
sudo systemctl enable --now wg-quick@${iface}

echo "==========================================="
echo "WireGuard ${iface} aktif."
echo "Public key server:"
sudo cat /etc/wireguard/public.key
echo "Subnet: ${subnet}"
echo "==========================================="
`;
}

function buildVpsL2tpSetupScript(server, peers) {
    const wan = server.wan_interface || 'eth0';
    const serverIp = stripIp(server.tunnel_address) || '10.10.0.1';
    const subnet = server.network_subnet || '10.10.0.0/24';
    const endpoint = server.public_endpoint || '<VPS_PUBLIC_IP>';
    const psk = server.ipsec_psk || 'REPLACE_WITH_IPSEC_PSK';
    const activePeers = (peers || []).filter(
        (p) => p.is_active && isL2tpPeer(p) && p.l2tp_username && p.l2tp_password
    );
    const chapBlock = buildChapSecretsBlock(activePeers);
    const ipRangeStart = (() => {
        const parts = serverIp.split('.').map(Number);
        if (parts.length !== 4) return '10.10.0.2';
        return `${parts[0]}.${parts[1]}.${parts[2]}.2`;
    })();
    const ipRangeEnd = (() => {
        const parsed = parseCidr(subnet.includes('/') ? subnet : `${subnet}/24`);
        if (!parsed) return '10.10.0.254';
        return intToIpv4((parsed.broadcast - 1) >>> 0);
    })();

    return `#!/bin/bash
# ===========================================
# Script Konfigurasi VPS L2TP/IPsec (SaaS Management)
# Generated: ${new Date().toISOString()}
# Endpoint: ${endpoint}
# ===========================================
set -euo pipefail

echo "Menginstall strongSwan + xl2tpd..."
sudo apt update
sudo apt install -y strongswan xl2tpd ppp net-tools iputils-ping

echo "net.ipv4.ip_forward=1" | sudo tee /etc/sysctl.d/99-l2tp.conf
sudo sysctl --system

# IPsec (strongSwan)
# mark=%unique + connmark: demux beberapa L2TP client di belakang NAT/public IP yang sama
sudo tee /etc/ipsec.conf > /dev/null <<'EOF'
config setup
    uniqueids=never

conn L2TP-PSK
    authby=secret
    auto=add
    keyexchange=ikev1
    type=transport
    left=%any
    leftprotoport=17/1701
    right=%any
    rightprotoport=17/%any
    ike=aes256-sha1-modp2048,aes128-sha1-modp2048,aes256-sha1-modp1024,aes128-sha1-modp1024,3des-sha1-modp1024!
    # MikroTik L2TP client (use-ipsec=yes) minta ESP + PFS modp1024
    esp=aes256-sha1-modp1024,aes192-sha1-modp1024,aes128-sha1-modp1024,aes256-sha1,aes128-sha1,3des-sha1!
    forceencaps=yes
    mark=%unique
    dpdaction=clear
    dpddelay=30s
    dpdtimeout=120s
EOF

sudo tee /etc/ipsec.secrets > /dev/null <<EOF
: PSK "${psk}"
EOF
sudo chmod 600 /etc/ipsec.secrets

# xl2tpd
sudo tee /etc/xl2tpd/xl2tpd.conf > /dev/null <<EOF
[global]
ipsec saref = yes
listen-addr = 0.0.0.0

[lns default]
ip range = ${ipRangeStart}-${ipRangeEnd}
local ip = ${serverIp}
require chap = yes
refuse pap = yes
require authentication = yes
name = platform-l2tp
ppp debug = no
pppoptfile = /etc/ppp/options.xl2tpd
length bit = yes
EOF

sudo tee /etc/ppp/options.xl2tpd > /dev/null <<'EOF'
ipcp-accept-local
ipcp-accept-remote
ms-dns 8.8.8.8
noccp
auth
mtu 1280
mru 1280
nodefaultroute
proxyarp
connect-delay 5000
EOF

# PPP secrets (managed block)
CHAP=/etc/ppp/chap-secrets
if [ -f "\$CHAP" ]; then
  sudo cp "\$CHAP" "\$CHAP.bak.\$(date +%s)" || true
fi
TMP=\$(mktemp)
if [ -f "\$CHAP" ]; then
  sudo awk '/^# BEGIN platform-vpn-l2tp\$/{skip=1} /^# END platform-vpn-l2tp\$/{skip=0; next} !skip{print}' "\$CHAP" > "\$TMP" || true
fi
cat >> "\$TMP" <<'CHAPEOF'
${chapBlock}
CHAPEOF
sudo cp "\$TMP" "\$CHAP"
sudo chmod 600 "\$CHAP"
rm -f "\$TMP"

sudo ufw allow 500/udp || true
sudo ufw allow 4500/udp || true
sudo ufw allow 1701/udp || true

# Forward / NAT for PPP interfaces
sudo iptables -C FORWARD -i ppp+ -j ACCEPT 2>/dev/null || sudo iptables -A FORWARD -i ppp+ -j ACCEPT
sudo iptables -t nat -C POSTROUTING -o ${wan} -j MASQUERADE 2>/dev/null || sudo iptables -t nat -A POSTROUTING -o ${wan} -j MASQUERADE

# CONNMARK needed so mark=%unique can demux multi-client same-NAT
sudo modprobe xt_connmark 2>/dev/null || true

sudo systemctl enable --now strongswan-starter 2>/dev/null || sudo systemctl enable --now strongswan 2>/dev/null || true
sudo systemctl enable --now xl2tpd
sudo ipsec restart || sudo systemctl restart strongswan-starter || true
sudo systemctl restart xl2tpd

echo "==========================================="
echo "L2TP/IPsec aktif."
echo "Server tunnel IP: ${serverIp}"
echo "Subnet: ${subnet}"
echo "Active L2TP peers: ${activePeers.length}"
echo "==========================================="
`;
}

function buildMikrotikWireGuardScript(server, peer) {
    const endpoint = server.public_endpoint || '<VPS_PUBLIC_IP>';
    const port = server.listen_port || 51820;
    const serverPub = server.server_public_key || '<SERVER_PUBLIC_KEY>';
    const serverTunnelIp = stripIp(server.tunnel_address) || '10.10.0.1';
    const subnet = server.network_subnet || '10.10.0.0/24';
    const peerIp = stripIp(peer.tunnel_ip);
    const keepalive = peer.persistent_keepalive || 25;
    const ifaceName = 'wg-vps';
    const peerPriv = peer.peer_private_key || null;
    const peerNameSafe = String(peer.name || '').replace(/"/g, '');

    const ifaceBlock = peerPriv
        ? `# Interface WireGuard dengan private key dari portal
/interface wireguard
:if ([:len [/interface wireguard find where name="${ifaceName}"]] > 0) do={
    set [find where name="${ifaceName}"] private-key="${peerPriv}" listen-port=${port}
} else={
    add name="${ifaceName}" private-key="${peerPriv}" listen-port=${port}
}`
        : `# Interface WireGuard (key digenerate MikroTik — salin public key ke portal)
/interface wireguard
:if ([:len [/interface wireguard find where name="${ifaceName}"]] = 0) do={
    add name="${ifaceName}" listen-port=${port}
}`;

    const footer = peerPriv
        ? `:put "==========================================="
:put ("Peer: " . $peerName)
:put ("Tunnel IP: ${peerIp}")
:put "Public key sudah terdaftar di portal (digenerate otomatis)."
:put "==========================================="`
        : `:put "==========================================="
:put ("Peer: " . $peerName)
:put ("Tunnel IP: ${peerIp}")
:put "Public key interface ${ifaceName}:"
:put [/interface wireguard get [find name="${ifaceName}"] public-key]
:put "Tempel public key di atas ke portal VPN Management."
:put "==========================================="`;

    return `# ===========================================
# MikroTik WireGuard — ${peer.name}
# Generated: ${new Date().toISOString()}
# ===========================================
# Public key peer ${peerPriv ? 'sudah digenerate di portal' : 'perlu disalin dari MikroTik ke portal'}.

:local peerName "${peerNameSafe}"

${ifaceBlock}

# Peer ke VPS
/interface wireguard peers
:if ([:len [/interface wireguard peers find where interface="${ifaceName}" and comment=$peerName]] > 0) do={
    remove [find where interface="${ifaceName}" and comment=$peerName]
}
add interface="${ifaceName}" \\
    public-key="${serverPub}" \\
    endpoint-address=${endpoint} \\
    endpoint-port=${port} \\
    allowed-address=${serverTunnelIp}/32,${subnet} \\
    persistent-keepalive=${keepalive}s \\
    comment=$peerName

# IP tunnel lokal
/ip address
:if ([:len [/ip address find where interface="${ifaceName}" and address~"${peerIp}"]] = 0) do={
    add address=${peerIp}/24 interface="${ifaceName}" comment="WireGuard VPS"
}

# Route ke server tunnel
/ip route
:if ([:len [/ip route find where dst-address="${serverTunnelIp}/32"]] = 0) do={
    add dst-address=${serverTunnelIp}/32 gateway="${ifaceName}" comment="WG to VPS"
}

${footer}
`;
}

function buildMikrotikL2tpScript(server, peer) {
    const endpoint = server.public_endpoint || '<VPS_PUBLIC_IP>';
    const psk = server.ipsec_psk || '<IPSEC_PSK>';
    const serverTunnelIp = stripIp(server.tunnel_address) || '10.10.0.1';
    const peerIp = stripIp(peer.tunnel_ip);
    const username = peer.l2tp_username || '<USERNAME>';
    const password = peer.l2tp_password || '<PASSWORD>';
    const peerNameSafe = String(peer.name || '').replace(/"/g, '');
    const ifaceName = 'l2tp-vps';

    return `# ===========================================
# MikroTik L2TP/IPsec Client — ${peer.name}
# RouterOS v6 compatible
# Generated: ${new Date().toISOString()}
# ===========================================
# Tunnel IP yang diharapkan dari server: ${peerIp}
# Username: ${username}

:local peerName "${peerNameSafe}"

/interface l2tp-client
:if ([:len [/interface l2tp-client find where name="${ifaceName}"]] > 0) do={
    set [find where name="${ifaceName}"] \\
        connect-to=${endpoint} \\
        user="${username}" \\
        password="${password}" \\
        use-ipsec=yes \\
        ipsec-secret="${psk}" \\
        disabled=no \\
        add-default-route=no \\
        allow=pap,chap,mschap1,mschap2 \\
        profile=default \\
        comment=$peerName
} else={
    add name="${ifaceName}" \\
        connect-to=${endpoint} \\
        user="${username}" \\
        password="${password}" \\
        use-ipsec=yes \\
        ipsec-secret="${psk}" \\
        disabled=no \\
        add-default-route=no \\
        allow=pap,chap,mschap1,mschap2 \\
        profile=default \\
        comment=$peerName
}

# Route ke server tunnel via L2TP
/ip route
:if ([:len [/ip route find where dst-address="${serverTunnelIp}/32" and comment="L2TP to VPS"]] > 0) do={
    set [find where dst-address="${serverTunnelIp}/32" and comment="L2TP to VPS"] gateway="${ifaceName}"
} else={
    add dst-address=${serverTunnelIp}/32 gateway="${ifaceName}" comment="L2TP to VPS"
}

:put "==========================================="
:put ("Peer: " . $peerName)
:put ("Expected Tunnel IP: ${peerIp}")
:put ("L2TP interface: ${ifaceName}")
:put "Pastikan status L2TP client Running, lalu pakai Tunnel IP sebagai NAS IP."
:put "==========================================="
`;
}

function buildMikrotikScript(server, peer) {
    if (isL2tpPeer(peer)) return buildMikrotikL2tpScript(server, peer);
    return buildMikrotikWireGuardScript(server, peer);
}

async function getVpsSetupScript() {
    const [server, peers] = await Promise.all([getServer(), listPeers()]);
    return { server, script: buildVpsSetupScript(server, peers) };
}

async function getVpsL2tpSetupScript() {
    const [server, peers] = await Promise.all([getServer(), listPeers()]);
    return { server, script: buildVpsL2tpSetupScript(server, peers) };
}

async function getMikrotikScript(peerId) {
    const [server, peer] = await Promise.all([getServer(), getPeerById(peerId)]);
    if (!peer) throw new Error('Peer tidak ditemukan.');
    return { server, peer, script: buildMikrotikScript(server, peer) };
}

module.exports = {
    ensureVpnSchema,
    getServer,
    saveServer,
    generateAndSaveKeys,
    generateAndSaveIpsecPsk,
    generateKeypair,
    generateIpsecPsk,
    allocateNextTunnelIp,
    assertTunnelIpAvailable,
    listPeers,
    countPeersByTenant,
    getPeerById,
    getPeerByIdForTenant,
    createPeer,
    createPeerForTenant,
    updatePeer,
    deletePeer,
    getDevicesStatus,
    getVpsSetupScript,
    getVpsL2tpSetupScript,
    getMikrotikScript,
    buildVpsSetupScript,
    buildVpsL2tpSetupScript,
    buildMikrotikScript,
    buildTenantPeerName,
    sanitizeNamePart,
    isVpnServerReady,
    isL2tpServerReady,
    protocolFromRouterOs,
    normalizeProtocol,
    normalizeRouterOsVersion,
    syncPeerToLiveWg,
    syncL2tpSecrets,
    MAX_PEERS_PER_TENANT,
};
