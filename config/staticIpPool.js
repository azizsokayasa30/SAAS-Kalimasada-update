/**
 * Static IP pool inventory (gateway + range → used / unused).
 * Does not touch RADIUS / PPPoE.
 */
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const logger = require('./logger');
const { getTenantId } = require('./platform/tenantContext');
const { sanitizeIp, getCustomerStaticIp } = require('./staticIPProvisioning');

const DB_PATH = path.join(__dirname, '../data/billing.db');

function openDb() {
    return new sqlite3.Database(DB_PATH);
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function ipToInt(ip) {
    const parts = String(ip).split('.').map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function intToIp(n) {
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function parseReserved(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(sanitizeIp).filter(Boolean);
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(sanitizeIp).filter(Boolean);
    } catch (_) {
        /* CSV */
    }
    return String(raw)
        .split(/[,;\s]+/)
        .map(sanitizeIp)
        .filter(Boolean);
}

/**
 * Parse CIDR (e.g. 10.10.10.0/24) → network, broadcast, usable hosts, suggested gateway.
 */
function parseCidr(cidrRaw) {
    const raw = String(cidrRaw || '').trim();
    const m = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s*\/\s*(\d{1,2})$/);
    if (!m) return null;
    const base = sanitizeIp(m[1]);
    const prefix = parseInt(m[2], 10);
    if (!base || prefix < 8 || prefix > 30) return null;
    const baseInt = ipToInt(base);
    if (baseInt == null) return null;
    const hostBits = 32 - prefix;
    const size = 2 ** hostBits;
    const mask = size - 1;
    const network = (baseInt & (~mask >>> 0)) >>> 0;
    const broadcast = (network + size - 1) >>> 0;
    const firstHost = prefix <= 30 ? (network + 1) >>> 0 : network;
    const lastHost = prefix <= 30 ? (broadcast - 1) >>> 0 : broadcast;
    if (firstHost > lastHost) return null;
    return {
        cidr: `${intToIp(network)}/${prefix}`,
        network: intToIp(network),
        broadcast: intToIp(broadcast),
        gateway: intToIp(firstHost),
        range_start: intToIp(firstHost),
        range_end: intToIp(lastHost),
        prefix
    };
}

function reservedToStore(list) {
    return JSON.stringify([...new Set((list || []).map(sanitizeIp).filter(Boolean))]);
}

function expandPoolRange(pool, { maxIps = 4096 } = {}) {
    const start = sanitizeIp(pool.range_start);
    const end = sanitizeIp(pool.range_end);
    if (!start || !end) throw new Error('range_start / range_end tidak valid');
    const a = ipToInt(start);
    const b = ipToInt(end);
    if (a == null || b == null || a > b) throw new Error('Range IP tidak valid');
    const count = b - a + 1;
    if (count > maxIps) {
        throw new Error(`Range terlalu besar (${count} IP). Maksimal ${maxIps} per pool.`);
    }
    const ips = [];
    for (let i = a; i <= b; i++) ips.push(intToIp(i));
    return ips;
}

function mikrotikRangeAddress(pool) {
    const start = sanitizeIp(pool.range_start);
    const end = sanitizeIp(pool.range_end);
    if (!start || !end) return null;
    if (pool.network_cidr && String(pool.network_cidr).includes('/')) {
        return String(pool.network_cidr).trim();
    }
    return start === end ? start : `${start}-${end}`;
}

function ipInPoolRange(ip, pool) {
    const clean = sanitizeIp(ip);
    if (!clean) return false;
    const n = ipToInt(clean);
    const a = ipToInt(pool.range_start);
    const b = ipToInt(pool.range_end);
    if (n == null || a == null || b == null) return false;
    return n >= a && n <= b;
}

async function ensureStaticIpSchema(db) {
    await run(
        db,
        `CREATE TABLE IF NOT EXISTS static_ip_pools (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id INTEGER NOT NULL DEFAULT 1,
            router_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            gateway TEXT,
            range_start TEXT NOT NULL,
            range_end TEXT NOT NULL,
            network_cidr TEXT,
            reserved_ips TEXT,
            enabled INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT (datetime('now','localtime')),
            updated_at DATETIME DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (router_id) REFERENCES routers(id)
        )`
    );
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_static_ip_pools_tenant ON static_ip_pools(tenant_id)');
    await run(db, `ALTER TABLE customers ADD COLUMN connection_type TEXT DEFAULT 'pppoe'`).catch((err) => {
        if (!String(err.message || '').includes('duplicate column')) {
            logger.warn(`[STATIC-IP-POOL] connection_type: ${err.message}`);
        }
    });
    await run(
        db,
        `UPDATE customers SET connection_type = 'static_ip'
         WHERE (IFNULL(TRIM(pppoe_username),'') = '')
           AND (IFNULL(TRIM(static_ip),'') != '' OR IFNULL(TRIM(assigned_ip),'') != '')
           AND (connection_type IS NULL OR connection_type = '' OR connection_type = 'pppoe')`
    ).catch((err) => logger.warn(`[STATIC-IP-POOL] backfill connection_type: ${err.message}`));
}

async function withDb(fn) {
    const db = openDb();
    try {
        await ensureStaticIpSchema(db);
        return await fn(db);
    } finally {
        db.close();
    }
}

async function listPools(tenantId = getTenantId()) {
    return withDb((db) =>
        all(
            db,
            `SELECT p.*, r.name AS router_name, r.nas_ip AS router_nas_ip
             FROM static_ip_pools p
             LEFT JOIN routers r ON r.id = p.router_id
             WHERE p.tenant_id = ?
             ORDER BY p.id DESC`,
            [tenantId]
        )
    );
}

async function getPoolById(id, tenantId = getTenantId()) {
    return withDb((db) =>
        get(
            db,
            `SELECT p.*, r.name AS router_name, r.nas_ip AS router_nas_ip
             FROM static_ip_pools p
             LEFT JOIN routers r ON r.id = p.router_id
             WHERE p.id = ? AND p.tenant_id = ?`,
            [id, tenantId]
        )
    );
}

async function getPoolsByRouterId(routerId, tenantId = getTenantId()) {
    return withDb((db) =>
        all(
            db,
            `SELECT * FROM static_ip_pools WHERE tenant_id = ? AND router_id = ? AND enabled = 1`,
            [tenantId, routerId]
        )
    );
}

function normalizePoolInput(data) {
    const name = String(data.name || '').trim();
    const routerId = parseInt(data.router_id, 10);
    const cidrInfo = parseCidr(data.network_cidr || data.cidr || '');
    let gateway = sanitizeIp(data.gateway) || null;
    let rangeStart = sanitizeIp(data.range_start);
    let rangeEnd = sanitizeIp(data.range_end);
    let networkCidr = data.network_cidr ? String(data.network_cidr).trim() : null;

    if (cidrInfo) {
        networkCidr = cidrInfo.cidr;
        if (!rangeStart) rangeStart = cidrInfo.range_start;
        if (!rangeEnd) rangeEnd = cidrInfo.range_end;
        if (!gateway) gateway = cidrInfo.gateway;
    }

    if (!name) throw new Error('Nama wajib');
    if (!routerId) throw new Error('Router wajib');
    if (!rangeStart || !rangeEnd) {
        throw new Error('CIDR atau range IP wajib (contoh CIDR: 10.10.10.0/24)');
    }
    const a = ipToInt(rangeStart);
    const b = ipToInt(rangeEnd);
    if (a == null || b == null || a > b) throw new Error('Range IP tidak valid');
    if (b - a + 1 > 4096) throw new Error('Range maksimal 4096 IP');

    // Gateway otomatis reserved; kolom reserved manual dihapus dari UI.
    const reserved = parseReserved(data.reserved_ips);
    if (gateway && !reserved.includes(gateway)) reserved.push(gateway);

    return {
        name,
        router_id: routerId,
        gateway,
        range_start: rangeStart,
        range_end: rangeEnd,
        network_cidr: networkCidr || (cidrInfo ? cidrInfo.cidr : null),
        reserved_ips: reservedToStore(reserved),
        enabled: data.enabled === 0 || data.enabled === false || data.enabled === '0' ? 0 : 1
    };
}

async function assertRouterOwnsTenant(routerId, tenantId, db) {
    const row = await get(
        db,
        `SELECT id, tenant_id, name FROM routers WHERE id = ? AND tenant_id = ?`,
        [routerId, tenantId]
    );
    if (!row) {
        throw new Error('Router tidak valid untuk tenant ini (isolasi antar-tenant)');
    }
    return row;
}

async function createPool(data, tenantId = getTenantId()) {
    const row = normalizePoolInput(data);
    return withDb(async (db) => {
        await assertRouterOwnsTenant(row.router_id, tenantId, db);
        const result = await run(
            db,
            `INSERT INTO static_ip_pools
             (tenant_id, router_id, name, gateway, range_start, range_end, network_cidr, reserved_ips, enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                tenantId,
                row.router_id,
                row.name,
                row.gateway,
                row.range_start,
                row.range_end,
                row.network_cidr,
                row.reserved_ips,
                row.enabled
            ]
        );
        return get(db, 'SELECT * FROM static_ip_pools WHERE id = ? AND tenant_id = ?', [
            result.lastID,
            tenantId
        ]);
    });
}

async function updatePool(id, data, tenantId = getTenantId()) {
    const existing = await getPoolById(id, tenantId);
    if (!existing) throw new Error('Pool tidak ditemukan');
    const row = normalizePoolInput({ ...existing, ...data });
    await withDb(async (db) => {
        await assertRouterOwnsTenant(row.router_id, tenantId, db);
        await run(
            db,
            `UPDATE static_ip_pools SET
                router_id = ?, name = ?, gateway = ?, range_start = ?, range_end = ?,
                network_cidr = ?, reserved_ips = ?, enabled = ?,
                updated_at = datetime('now','localtime')
             WHERE id = ? AND tenant_id = ?`,
            [
                row.router_id,
                row.name,
                row.gateway,
                row.range_start,
                row.range_end,
                row.network_cidr,
                row.reserved_ips,
                row.enabled,
                id,
                tenantId
            ]
        );
    });
    return getPoolById(id, tenantId);
}

async function deletePool(id, tenantId = getTenantId()) {
    return withDb((db) => run(db, `DELETE FROM static_ip_pools WHERE id = ? AND tenant_id = ?`, [id, tenantId]));
}

async function listStaticIpCustomers(tenantId = getTenantId()) {
    return withDb(async (db) => {
        const rows = await all(
            db,
            `SELECT c.*,
                    TRIM(c.name) AS customer_name,
                    p.name AS package_name, p.upload_limit, p.download_limit, p.speed,
                    p.pppoe_profile AS package_profile,
                    m.router_id, r.name AS router_name
             FROM customers c
             LEFT JOIN packages p ON p.id = c.package_id
             LEFT JOIN customer_router_map m ON m.customer_id = c.id
             LEFT JOIN routers r ON r.id = m.router_id
             WHERE c.tenant_id = ?
               AND (
                 c.connection_type = 'static_ip'
                 OR (
                   IFNULL(TRIM(c.pppoe_username),'') = ''
                   AND (IFNULL(TRIM(c.static_ip),'') != '' OR IFNULL(TRIM(c.assigned_ip),'') != '')
                 )
               )
             ORDER BY TRIM(c.name) COLLATE NOCASE`,
            [tenantId]
        );
        // Pastikan field name = nama pelanggan (bukan phone/username)
        return rows.map((r) => {
            const customerName = String(r.customer_name || r.name || '').trim();
            return {
                ...r,
                customer_name: customerName,
                name: customerName
            };
        });
    });
}

async function getUsedIpsForPool(pool, tenantId = getTenantId()) {
    const customers = await listStaticIpCustomers(tenantId);
    const used = [];
    for (const c of customers) {
        const ip = getCustomerStaticIp(c);
        if (!ip || !ipInPoolRange(ip, pool)) continue;
        if (c.router_id && pool.router_id && Number(c.router_id) !== Number(pool.router_id)) continue;
        used.push({
            ip,
            customer_id: c.id,
            name: c.customer_name || c.name,
            status: c.status,
            package_name: c.package_name || null
        });
    }
    return used;
}

async function analyzePool(pool, tenantId = getTenantId()) {
    const allIps = expandPoolRange(pool);
    const reserved = new Set(parseReserved(pool.reserved_ips));
    if (pool.gateway) reserved.add(pool.gateway);
    const usedRows = await getUsedIpsForPool(pool, tenantId);
    const usedMap = new Map(usedRows.map((u) => [u.ip, u]));
    const used = [];
    const unused = [];
    for (const ip of allIps) {
        if (reserved.has(ip)) continue;
        if (usedMap.has(ip)) used.push(usedMap.get(ip));
        else unused.push({ ip, blocked: true });
    }
    return {
        total: allIps.length,
        reserved: [...reserved],
        used,
        unused,
        mikrotik_block_address: mikrotikRangeAddress(pool),
        allowed_ips: used.filter((u) => String(u.status || '').toLowerCase() === 'active').map((u) => u.ip)
    };
}

async function findPoolForIp(ip, routerId = null, tenantId = getTenantId()) {
    const pools = await listPools(tenantId);
    return (
        pools.find((p) => {
            if (!p.enabled) return false;
            if (routerId && Number(p.router_id) !== Number(routerId)) return false;
            return ipInPoolRange(ip, p);
        }) || null
    );
}

async function assertIpAvailable(ip, { routerId, excludeCustomerId, tenantId = getTenantId() } = {}) {
    const clean = sanitizeIp(ip);
    if (!clean) throw new Error('IP tidak valid');
    const pool = await findPoolForIp(clean, routerId, tenantId);
    if (pool) {
        const reserved = new Set(parseReserved(pool.reserved_ips));
        if (pool.gateway) reserved.add(pool.gateway);
        if (reserved.has(clean)) throw new Error('IP reserved (gateway/infra)');
    }
    const customers = await listStaticIpCustomers(tenantId);
    for (const c of customers) {
        if (excludeCustomerId && Number(c.id) === Number(excludeCustomerId)) continue;
        if (getCustomerStaticIp(c) === clean) {
            throw new Error(`IP sudah dipakai pelanggan ${c.name}`);
        }
    }
    return { ok: true, pool };
}

module.exports = {
    ensureStaticIpSchema,
    ipToInt,
    intToIp,
    parseReserved,
    parseCidr,
    expandPoolRange,
    mikrotikRangeAddress,
    ipInPoolRange,
    listPools,
    getPoolById,
    getPoolsByRouterId,
    createPool,
    updatePool,
    deletePool,
    listStaticIpCustomers,
    getUsedIpsForPool,
    analyzePool,
    findPoolForIp,
    assertIpAvailable,
    withDb,
    openDb
};
