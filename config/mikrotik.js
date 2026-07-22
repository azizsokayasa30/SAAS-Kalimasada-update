// Modul untuk koneksi dan operasi Mikrotik
const { RouterOSAPI } = require('node-routeros');
const logger = require('./logger');
const { getSetting } = require('./settingsManager');
const { getRadiusConnection: getRadiusConnectionSQLite } = require('./radiusSQLite');
const fs = require('fs');
const path = require('path');
const cacheManager = require('./cacheManager');
const { tenantCacheKey } = require('./platform/tenantCache');
const { hasTenantContext, getTenantId } = require('./platform/tenantContext');
const { looksLikePasswordHashNotCleartext } = require('../utils/passwordHashHeuristic');

let sock = null;
let mikrotikConnection = null;
let monitorInterval = null;
const MIN_MONITOR_INTERVAL_MS = 10 * 1000;

// Connection pool untuk router (reuse koneksi per router)
const routerConnections = new Map();
// Serialize concurrent connect attempts per router (hindari reconnect storm)
const routerConnectLocks = new Map();

// node-routeros: options.timeout is in SECONDS (socket.setTimeout(timeout * 1000)).
// Historically this codebase passed 10000 intending "10s ms" — that became ~2.7h idle timeout
// and made failed connects hang until OS/proxy gave up (flaky "tes koneksi").
const ROUTEROS_API_TIMEOUT_SEC = 15;
const POOL_HEALTH_TIMEOUT_MS = 8000;
const CONNECT_HARD_TIMEOUT_MS = 20000;

function getRouterApiPassword(routerObj) {
    // Prefer API password column; secret is legacy/RADIUS-adjacent and must not win over password
    return routerObj.password || routerObj.secret || '';
}

function formatMikrotikConnectError(host, port, err) {
    const msg = (err && err.message) ? String(err.message) : String(err || 'unknown');
    const lower = msg.toLowerCase();
    if (lower.includes('timeout') || lower.includes('etimedout') || lower.includes('timed out')) {
        return `Timeout ke ${host}:${port} (TCP RouterOS API). Pastikan VPN tunnel aktif, IP NAS = Tunnel IP, service api enabled, dan firewall mengizinkan TCP ${port} dari VPS.`;
    }
    if (lower.includes('econnrefused') || lower.includes('refused')) {
        return `Koneksi ditolak di ${host}:${port}. Service API MikroTik kemungkinan nonaktif atau port salah (default 8728).`;
    }
    if (lower.includes('ehostunreach') || lower.includes('enetunreach') || lower.includes('no route')) {
        return `Host ${host} tidak terjangkau dari VPS. Cek Tunnel IP NAS dan status VPN (bukan ping dari sisi MikroTik ke VPS).`;
    }
    if (lower.includes('cannot log in') || lower.includes('invalid user') || lower.includes('login failure') || lower.includes('authentication')) {
        return `Autentikasi gagal ke ${host}:${port}. Periksa username/password API MikroTik.`;
    }
    return `Gagal koneksi ke ${host}:${port} - ${msg}`;
}

async function withRouterConnectLock(routerKey, fn) {
    while (routerConnectLocks.has(routerKey)) {
        try {
            await routerConnectLocks.get(routerKey);
        } catch (_) {
            // previous connect failed; continue to try
        }
    }
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    routerConnectLocks.set(routerKey, gate);
    try {
        return await fn();
    } finally {
        routerConnectLocks.delete(routerKey);
        release();
    }
}

async function connectRouterOsApi({ host, port, user, password, keepalive = true }) {
    const conn = new RouterOSAPI({
        host,
        port,
        user,
        password,
        keepalive,
        timeout: ROUTEROS_API_TIMEOUT_SEC
    });
    const hardTimeout = new Promise((_, reject) => {
        setTimeout(
            () => reject(new Error(`Timeout koneksi TCP ke ${host}:${port} setelah ${Math.round(CONNECT_HARD_TIMEOUT_MS / 1000)} detik`)),
            CONNECT_HARD_TIMEOUT_MS
        );
    });
    await Promise.race([conn.connect(), hardTimeout]);
    return conn;
}

const PPPoe_EXCLUDE_CACHE_BASE = 'radius:pppoe:exclude_usernames';
const PPPoe_EXCLUDE_CACHE_TTL = 5 * 60 * 1000;
const ACTIVE_RADIUS_SESSIONS_CACHE_BASE = 'radius:pppoe:active_sessions';
const ACTIVE_RADIUS_SESSIONS_RADACCT_CACHE_BASE = 'radius:pppoe:active_sessions:radacct';
const ACTIVE_RADIUS_SESSIONS_CACHE_TTL = 45 * 1000;

function scopedRadiusCacheKey(base) {
    return tenantCacheKey(base);
}

/**
 * Append IN (...) filter for allowed usernames.
 * - null/undefined → no filter (caller intentionally wants all / platform)
 * - [] or empty after normalize → match nothing (prevents accidental full-table leak)
 */
function appendAllowedUsernamesSql(baseSql, params, allowedUsernames, columnExpr) {
    if (allowedUsernames == null) {
        return baseSql;
    }
    if (!Array.isArray(allowedUsernames)) {
        return `${baseSql} AND 1=0`;
    }
    const normalized = [
        ...new Set(
            allowedUsernames
                .map((u) => String(u).toLowerCase().trim())
                .filter(Boolean)
        )
    ];
    if (!normalized.length) {
        return `${baseSql} AND 1=0`;
    }
    const placeholders = normalized.map(() => '?').join(',');
    params.push(...normalized);
    return `${baseSql} AND LOWER(TRIM(${columnExpr})) IN (${placeholders})`;
}

async function getActiveSessionsFromSqliteRadacct(excludeUsernames = [], allowedUsernames = null) {
    const { getRadiusConnection } = require('./radiusSQLite');
    let conn;
    try {
        conn = await getRadiusConnection();
        const openAcct =
            `(acctstoptime IS NULL OR acctstoptime = '' OR acctstoptime = '0' OR acctstoptime = '0000-00-00 00:00:00')`;
        let sql = `
            SELECT username, framedipaddress, acctinputoctets, acctoutputoctets, nasipaddress,
                   CAST((julianday('now','localtime') - julianday(acctstarttime)) * 86400 AS INTEGER) AS session_time
            FROM radacct
            WHERE ${openAcct}
        `;
        const params = [];
        if (excludeUsernames.length > 0) {
            sql += ` AND username NOT IN (${excludeUsernames.map(() => '?').join(',')})`;
            params.push(...excludeUsernames);
        }
        sql = appendAllowedUsernamesSql(sql, params, allowedUsernames, 'username');
        sql += ' ORDER BY acctstarttime DESC';
        const [rows] = await conn.execute(sql, params);
        return Array.isArray(rows) ? rows : [];
    } catch (e) {
        logger.warn(`[PPPoE-RADIUS] SQLite radacct skip: ${e.message}`);
        return [];
    } finally {
        if (conn) {
            try {
                await conn.end();
            } catch (_) {
                /* ignore */
            }
        }
    }
}

/**
 * Username yang dikecualikan dari daftar PPPoE admin / query radcheck terkait:
 * - voucher_revenue (hotspot voucher)
 * - members.hotspot_username (login hotspot member)
 * Selalu mengembalikan daftar untuk NOT IN di query RADIUS.
 *
 * Penting: jika string yang sama dipakai sebagai PPPoE billing (customers.pppoe_username),
 * jangan ikut mengecualikan — bentrok nama sering terjadi (PPPoE "skynet" vs hotspot "skynet"),
 * dan menyembunyikan pelanggan ISP padahal baris radcheck ada.
 */
async function getPppoeRadcheckExcludeUsernames() {
    const cached = cacheManager.get(scopedRadiusCacheKey(PPPoe_EXCLUDE_CACHE_BASE));
    if (cached) {
        return cached;
    }

    const { hasTenantContext, getTenantId } = require('./platform/tenantContext');
    const _tId = hasTenantContext() ? getTenantId() : null;
    const tCust = _tId != null ? ' AND tenant_id = ?' : '';
    const tMember = _tId != null ? ' AND tenant_id = ?' : '';

    const sqlite3 = require('sqlite3').verbose();
    const dbPath = path.join(__dirname, '../data/billing.db');
    const db = new sqlite3.Database(dbPath);
    const norm = (u) => String(u || '').trim().toLowerCase();

    try {
        const vouchers = await new Promise((resolve) => {
            db.all('SELECT DISTINCT username AS u FROM voucher_revenue', [], (err, rows) => {
                if (err || !rows) return resolve([]);
                resolve(rows.map((r) => r.u).filter(Boolean));
            });
        });
        const hotspotOnly = await new Promise((resolve) => {
            db.all(
                `SELECT DISTINCT TRIM(hotspot_username) AS u FROM members
                 WHERE hotspot_username IS NOT NULL AND TRIM(hotspot_username) != ''${tMember}`,
                _tId != null ? [_tId] : [],
                (err, rows) => {
                    if (err || !rows) return resolve([]);
                    resolve(rows.map((r) => r.u).filter(Boolean));
                }
            );
        });
        const customerPppoe = await new Promise((resolve) => {
            db.all(
                `SELECT DISTINCT TRIM(pppoe_username) AS u FROM customers
                 WHERE pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''${tCust}`,
                _tId != null ? [_tId] : [],
                (err, rows) => {
                    if (err) {
                        logger.warn(`[PPPoE-exclude] customers.pppoe_username: ${err.message}`);
                        return resolve([]);
                    }
                    if (!rows) return resolve([]);
                    resolve(rows.map((r) => String(r.u).trim()).filter(Boolean));
                }
            );
        });

        const protect = new Set(customerPppoe.map(norm));
        const mergedRaw = [...new Set([...vouchers, ...hotspotOnly])];
        const merged = mergedRaw.filter((u) => !protect.has(norm(u)));
        const unblocked = mergedRaw.length - merged.length;
        if (unblocked > 0) {
            logger.info(
                `[PPPoE-exclude] ${mergedRaw.length} voucher/hotspot raw → ${merged.length} setelah jeda bentrok dengan customers.pppoe_username (${unblocked} tidak dikecualikan)`
            );
        } else {
            logger.info(`[PPPoE-exclude] voucher + hotspot_username: ${merged.length} username (tanpa bentrok pelanggan PPPoE)`);
        }
        cacheManager.set(scopedRadiusCacheKey(PPPoe_EXCLUDE_CACHE_BASE), merged, PPPoe_EXCLUDE_CACHE_TTL);
        return merged;
    } finally {
        db.close();
    }
}

// Fungsi untuk set instance sock
function setSock(sockInstance) {
    sock = sockInstance;
}

function isPppoeLoginLogoutWaEnabled() {
    try {
        const { isWaSystemMonitorEnabled } = require('./whatsappMonitoringSettings');
        return isWaSystemMonitorEnabled('pppoe_login_logout_wa');
    } catch (_) {
        return true;
    }
}

// Fungsi untuk koneksi ke Mikrotik
async function connectToMikrotik() {
    try {
        // Dapatkan konfigurasi Mikrotik
        const host = getSetting('mikrotik_host', '192.168.8.1');
        const port = parseInt(getSetting('mikrotik_port', '8728'));
        const user = getSetting('mikrotik_user', 'admin');
        const password = getSetting('mikrotik_password', 'admin');
        
        if (!host || !user || !password) {
            logger.error('Mikrotik configuration is incomplete');
            return null;
        }
        
        // Buat koneksi ke Mikrotik (timeout unit = detik di node-routeros)
        const conn = await connectRouterOsApi({
            host,
            port,
            user,
            password,
            keepalive: true
        });
        
        logger.info(`Connected to Mikrotik at ${host}:${port}`);
        
        // Set global connection
        mikrotikConnection = conn;
        
        return conn;
    } catch (error) {
        logger.error(`Error connecting to Mikrotik: ${error.message}`);
        return null;
    }
}

// Fungsi untuk mendapatkan koneksi Mikrotik
function _routersTenantWhereSql() {
    try {
        const { hasTenantContext, getTenantId } = require('./platform/tenantContext');
        if (!hasTenantContext()) return '';
        return ` WHERE tenant_id = ${parseInt(getTenantId(), 10)}`;
    } catch (_) {
        return '';
    }
}

async function getMikrotikConnection() {
    if (!mikrotikConnection) {
        // PRIORITAS: gunakan NAS (routers) milik tenant saat ini
        try {
            const sqlite3 = require('sqlite3').verbose();
            const db = new sqlite3.Database(require('path').join(__dirname, '../data/billing.db'));
            const whereSql = _routersTenantWhereSql();
            const router = await new Promise((resolve) => {
                db.get(`SELECT * FROM routers${whereSql} ORDER BY id LIMIT 1`, [], (err, row) => resolve(row || null));
            });
            db.close();
            if (router) {
                const conn = await getMikrotikConnectionForRouter(router);
                mikrotikConnection = conn;
                return conn;
            }
        } catch (e) {
            logger.warn('Connect via routers table failed: ' + e.message);
        }

        // Fallback terakhir: legacy settings.json (untuk kompatibilitas)
        let conn = await connectToMikrotik();
        if (conn) {
            mikrotikConnection = conn;
            return conn;
        }
        return null;
    }
    return mikrotikConnection;
}

// === MULTI-NAS helpers ===
async function getMikrotikConnectionForRouter(routerObj) {
    if (!routerObj || !routerObj.nas_ip || !routerObj.id) {
        throw new Error('Router data kurang lengkap: id atau nas_ip tidak ditemukan');
    }
    const host = routerObj.nas_ip;
    const port = parseInt(routerObj.port || routerObj.nas_port || 8728, 10);
    const user = routerObj.user || routerObj.nas_user || routerObj.username;
    const password = getRouterApiPassword(routerObj);
    
    // Buat key unik untuk router (untuk connection pooling)
    const routerKey = `${routerObj.id}_${host}_${port}_${user}`;

    return withRouterConnectLock(routerKey, async () => {
        // Cek apakah koneksi sudah ada di pool dan masih aktif
        if (routerConnections.has(routerKey)) {
            const existingConn = routerConnections.get(routerKey);
            try {
                const testPromise = existingConn.write('/system/identity/print');
                const testTimeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Connection test timeout')), POOL_HEALTH_TIMEOUT_MS)
                );
                await Promise.race([testPromise, testTimeout]);
                logger.debug(`[MIKROTIK] Reusing existing connection for router ${routerObj.id} (${host}:${port})`);
                return existingConn;
            } catch (error) {
                logger.warn(`[MIKROTIK] Existing connection for router ${routerObj.id} is dead, creating new one: ${error.message}`);
                routerConnections.delete(routerKey);
                try {
                    if (existingConn && typeof existingConn.close === 'function') {
                        existingConn.close();
                    }
                } catch (closeError) {
                    // Ignore close error
                }
            }
        }
        
        if (!host) throw new Error('Koneksi router gagal: IP address (nas_ip) tidak ditemukan');
        if (!user) throw new Error('Koneksi router gagal: Username tidak ditemukan');
        if (!password) throw new Error('Koneksi router gagal: Password tidak ditemukan');
        
        logger.info(`[MIKROTIK] Creating new connection to ${host}:${port} with user ${user}`);
        
        try {
            const conn = await connectRouterOsApi({
                host,
                port,
                user,
                password,
                keepalive: true
            });
            logger.info(`[MIKROTIK] ✓ Successfully connected to ${host}:${port}`);
            
            routerConnections.set(routerKey, conn);
            
            conn.on('close', () => {
                logger.debug(`[MIKROTIK] Connection closed for router ${routerObj.id}, removing from pool`);
                if (routerConnections.get(routerKey) === conn) {
                    routerConnections.delete(routerKey);
                }
            });
            
            conn.on('error', (error) => {
                logger.warn(`[MIKROTIK] Connection error for router ${routerObj.id}: ${error.message}, removing from pool`);
                if (routerConnections.get(routerKey) === conn) {
                    routerConnections.delete(routerKey);
                }
            });
            
            return conn;
        } catch (connectError) {
            logger.error(`[MIKROTIK] ✗ Failed to connect to ${host}:${port}:`, connectError.message);
            throw new Error(formatMikrotikConnectError(host, port, connectError));
        }
    });
}

/**
 * One-shot connection test (ephemeral, not pooled).
 * Avoids pool thrashing / concurrent close() races that make "tes koneksi" flaky.
 */
async function testMikrotikConnectionForRouter(routerObj) {
    if (!routerObj || !routerObj.nas_ip) {
        throw new Error('Router data kurang lengkap: nas_ip tidak ditemukan');
    }
    const host = String(routerObj.nas_ip).trim();
    const port = parseInt(routerObj.port || routerObj.nas_port || 8728, 10);
    const user = routerObj.user || routerObj.nas_user || routerObj.username;
    const password = getRouterApiPassword(routerObj);

    if (!host) throw new Error('IP address (nas_ip) tidak ditemukan');
    if (!user) throw new Error('Username tidak ditemukan');
    if (!password) throw new Error('Password tidak ditemukan');

    let conn = null;
    try {
        logger.info(`[MIKROTIK] Testing connection to ${host}:${port} with user ${user}`);
        conn = await connectRouterOsApi({
            host,
            port,
            user,
            password,
            keepalive: false
        });
        const identityRows = await Promise.race([
            conn.write('/system/identity/print'),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout membaca identity MikroTik')), POOL_HEALTH_TIMEOUT_MS)
            )
        ]);
        const identityName = identityRows && identityRows[0]
            ? (identityRows[0].name || identityRows[0]['name'] || 'connected')
            : 'connected';
        logger.info(`[MIKROTIK] ✓ Connection test OK ${host}:${port} identity=${identityName}`);
        return {
            success: true,
            identity: identityName,
            host,
            port
        };
    } catch (connectError) {
        logger.error(`[MIKROTIK] ✗ Connection test failed ${host}:${port}:`, connectError.message);
        throw new Error(formatMikrotikConnectError(host, port, connectError));
    } finally {
        if (conn) {
            try {
                if (typeof conn.close === 'function') conn.close();
            } catch (_) {
                // ignore
            }
        }
    }
}

// Fungsi untuk mendapatkan router object untuk customer (bukan connection)
async function getRouterForCustomer(customer) {
    if (!customer || !customer.id) throw new Error('Customer tidak ditemukan');
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(require('path').join(__dirname, '../data/billing.db'));
    const router = await new Promise((resolve, reject) => {
        db.get(
            'SELECT r.* FROM customer_router_map m JOIN routers r ON r.id = m.router_id WHERE m.customer_id = ? LIMIT 1',
            [customer.id],
            (err, row) => {
                if (err) return reject(err);
                resolve(row || null);
            }
        );
    });
    if (router) {
        db.close();
        return router;
    }
    // Fallback: router_id di object customer
    if (customer.router_id) {
        const byId = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM routers WHERE id = ?', [customer.router_id], (err, row) => {
                if (err) return reject(err);
                resolve(row || null);
            });
        });
        db.close();
        if (byId) return byId;
    } else {
        db.close();
    }
    throw new Error('Customer belum memilih router/NAS');
}

async function getMikrotikConnectionForCustomer(customer) {
    const router = await getRouterForCustomer(customer);
    return await getMikrotikConnectionForRouter(router);
}

// Fungsi untuk koneksi ke database RADIUS (SQLite)
async function getRadiusConnection() {
    try {
        return await getRadiusConnectionSQLite();
    } catch (error) {
        logger.error(`[RADIUS] Failed to get SQLite connection: ${error.message}`);
        throw error;
    }
}

/** Setelah tulis ke SQLite billing, salin ke MySQL jika FreeRADIUS memakai MySQL. */
async function syncRadiusToFreeRadiusMysql(options = {}) {
    try {
        const { syncRadiusSqliteToMysql } = require('./radiusMysqlSync');
        await syncRadiusSqliteToMysql({ force: options.force === true });
    } catch (e) {
        logger.debug(`[RADIUS] sync ke MySQL: ${e.message}`);
    }
    // Auth MikroTik ke FreeRADIUS POP — push user tables segera (debounced)
    if (options.skipPopSync !== true) {
        try {
            const { triggerRadiusPopSync } = require('../utils/radiusPopSync');
            triggerRadiusPopSync(options.popSyncReason || 'sqlite-write');
        } catch (e) {
            logger.debug(`[RADIUS-POP-SYNC] trigger skip: ${e.message}`);
        }
    }
}

// Predikat atribut sandi di radcheck (case-insensitive; dump FR/Mikrotik bervariasi).
function sqlRadcheckPasswordPredicate(alias) {
    return `LOWER(TRIM(${alias}.attribute)) IN (
        'cleartext-password',
        'user-password',
        'crypt-password',
        'md5-password',
        'sha-password',
        'smd5-password',
        'mikrotik-password'
    )`;
}

/** Ambil groupname dari radusergroup (opsional — tabel bisa tidak ada di DB minimal). */
async function getRadusergroupProfileMap(conn, usernames) {
    const map = new Map();
    if (!usernames || usernames.length === 0) return map;
    const unique = [...new Set(usernames.map((u) => String(u || '').trim()).filter(Boolean))];
    const chunkSize = 400;
    try {
        for (let i = 0; i < unique.length; i += chunkSize) {
            const slice = unique.slice(i, i + chunkSize);
            const ph = slice.map(() => '?').join(',');
            const [grows] = await conn.execute(
                `SELECT username, groupname FROM radusergroup WHERE username IN (${ph})`,
                slice
            );
            const list = Array.isArray(grows) ? grows : [];
            for (const g of list) {
                if (g && g.username != null && !map.has(g.username)) {
                    const gn = (g.groupname != null ? String(g.groupname).trim() : '') || 'default';
                    map.set(g.username, gn);
                }
            }
        }
    } catch (e) {
        logger.warn(`[PPPoE-RADIUS] radusergroup tidak dipakai (tabel hilang atau error): ${e.message}`);
    }
    return map;
}

/**
 * Samakan input profil (form admin) ke groupname persis di RADIUS agar radusergroup konsisten
 * dengan radgroupreply/radgroupcheck (hindari beda kapital/spasi vs label tampilan).
 */
const _radiusProfileGroupCache = new Map();
const RADIUS_PROFILE_GROUP_CACHE_MS = 120000;

async function resolveRadiusProfileGroupname(conn, profileInput) {
    const raw = (profileInput != null ? String(profileInput) : '').trim();
    if (!raw) return null;

    const cacheKey = raw.toLowerCase();
    const cached = _radiusProfileGroupCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < RADIUS_PROFILE_GROUP_CACHE_MS) {
        return cached.groupname;
    }

    const simplified = raw.toLowerCase().replace(/\s+/g, '_');
    const pick = (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        return list.length > 0 ? String(list[0].groupname) : null;
    };

    const [replyRows] = await conn.execute(
        `SELECT groupname FROM radgroupreply
         WHERE groupname IN (?, ?) OR LOWER(TRIM(groupname)) = LOWER(TRIM(?))
         LIMIT 1`,
        [raw, simplified, raw]
    );
    let found = pick(replyRows);
    if (!found) {
        try {
            const [checkRows] = await conn.execute(
                `SELECT groupname FROM radgroupcheck
                 WHERE groupname IN (?, ?) OR LOWER(TRIM(groupname)) = LOWER(TRIM(?))
                 LIMIT 1`,
                [raw, simplified, raw]
            );
            found = pick(checkRows);
        } catch (e) {
            logger.debug(`[resolveRadiusProfileGroupname] radgroupcheck: ${e.message}`);
        }
    }

    _radiusProfileGroupCache.set(cacheKey, { groupname: found, ts: Date.now() });
    return found;
}

/** Slug paket billing (paket_10mbps) — bukan grup RADIUS yang seharusnya untuk PPPoE pelanggan. */
const RADIUS_PAKET_SLUG_REGEX = /^paket[_-](\d+)mbps$/i;

/**
 * Samakan hint profil dari billing / legacy ke groupname RADIUS yang benar untuk PPPoE.
 * Jika hint memakai pola slug paket (paket_*mbps), utamakan grup profile-*mbps di RADIUS,
 * jangan mengembalikan grup limit paket walau barisnya ada di radgroupreply.
 */
async function resolvePppoeProfileHintToRadiusGroup(conn, profileHint) {
    const raw = profileHint != null ? String(profileHint).trim() : '';
    if (!raw) return null;
    const norm = raw.toLowerCase().replace(/\s+/g, '_');
    const paketMatch = RADIUS_PAKET_SLUG_REGEX.exec(norm);
    if (paketMatch) {
        const speed = paketMatch[1];
        const candidates = [`profile-${speed}mbps`, `profile_${speed}mbps`];
        for (const c of candidates) {
            const resolved = await resolveRadiusProfileGroupname(conn, c);
            if (resolved) return resolved;
        }
        return null;
    }
    const candidates = [raw, norm];
    const seen = new Set();
    for (const c of candidates) {
        if (!c || seen.has(c)) continue;
        seen.add(c);
        const resolved = await resolveRadiusProfileGroupname(conn, c);
        if (resolved) return resolved;
    }
    return null;
}

/** Sandi cleartext di radcheck untuk satu login PPPoE (RADIUS SQLite). */
async function getRadcheckCleartextPassword(username) {
    const u = (username && String(username).trim()) || '';
    if (!u) return null;
    let conn;
    const normalizeVal = (v) => {
        if (v == null) return '';
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return v.toString('utf8').trim();
        return String(v).trim();
    };
    try {
        conn = await getRadiusConnection();
        /** Abaikan value yang tampak hash (bcrypt/argon2) — sering salah isi di radcheck. */
        const pickFirstCleartext = (rows) => {
            if (!rows || !rows.length) return null;
            for (const row of rows) {
                const val = normalizeVal(row.value);
                if (val && !looksLikePasswordHashNotCleartext(val)) return val;
            }
            return null;
        };

        const tryAll = async (sql, params) => {
            const [rows] = await conn.execute(sql, params);
            return pickFirstCleartext(rows);
        };

        // Atribut di dump FreeRADIUS / tool impor bervariasi huruf besar-kecil.
        let v = await tryAll(
            `SELECT value FROM radcheck
             WHERE username = ? AND LOWER(TRIM(attribute)) IN ('cleartext-password', 'user-password')
             ORDER BY CASE LOWER(TRIM(attribute)) WHEN 'cleartext-password' THEN 0 ELSE 1 END, rowid ASC`,
            [u]
        );
        if (!v) {
            v = await tryAll(
                `SELECT value FROM radcheck
                 WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))
                   AND LOWER(TRIM(attribute)) IN ('cleartext-password', 'user-password')
                 ORDER BY CASE LOWER(TRIM(attribute)) WHEN 'cleartext-password' THEN 0 ELSE 1 END, rowid ASC`,
                [u]
            );
        }
        return v || null;
    } catch (e) {
        try {
            logger.warn('[RADIUS] getRadcheckCleartextPassword:', e.message);
        } catch (_) {}
        return null;
    } finally {
        try {
            if (conn && typeof conn.end === 'function') await conn.end();
        } catch (_) {}
    }
}

/** Cache `/ppp/secret/print` penuh per NAS — hindari spam saat banyak tugas; TTL pendek. */
const _pppSecretFullPrintCache = new Map();
const PPP_SECRET_FULL_CACHE_MS = 40000;

/** Cache `/ppp/active/print` per NAS — dipakai halaman admin Mikrotik. */
const _pppActivePrintCache = new Map();
const PPP_ACTIVE_PRINT_CACHE_MS = 40000;

async function getCachedFullPppSecrets(conn, cacheKey) {
    const key = cacheKey != null ? String(cacheKey) : '_';
    const now = Date.now();
    const hit = _pppSecretFullPrintCache.get(key);
    if (hit && now - hit.ts < PPP_SECRET_FULL_CACHE_MS) {
        return hit.rows;
    }
    let all;
    try {
        all = await conn.write('/ppp/secret/print', ['=.proplist=name,password,profile']);
    } catch (_) {
        all = await conn.write('/ppp/secret/print');
    }
    const rows = Array.isArray(all) ? all : [];
    _pppSecretFullPrintCache.set(key, { ts: now, rows });
    return rows;
}

async function getCachedPppActivePrint(conn, cacheKey) {
    const key = cacheKey != null ? String(cacheKey) : '_';
    const now = Date.now();
    const hit = _pppActivePrintCache.get(key);
    if (hit && now - hit.ts < PPP_ACTIVE_PRINT_CACHE_MS) {
        return hit.rows;
    }
    let all;
    try {
        all = await conn.write('/ppp/active/print', ['=.proplist=name']);
    } catch (_) {
        all = await conn.write('/ppp/active/print');
    }
    const rows = Array.isArray(all) ? all : [];
    _pppActivePrintCache.set(key, { ts: now, rows });
    return rows;
}

function clearPppPrintCachesForRouter(routerId) {
    const prefix = `r${routerId}`;
    for (const key of _pppSecretFullPrintCache.keys()) {
        if (String(key).startsWith(prefix) || String(key).includes(`admin_${routerId}`)) {
            _pppSecretFullPrintCache.delete(key);
        }
    }
    for (const key of _pppActivePrintCache.keys()) {
        if (String(key).startsWith(prefix) || String(key).includes(`admin_${routerId}`)) {
            _pppActivePrintCache.delete(key);
        }
    }
}

/**
 * Sandi cleartext dari /ppp/secret RouterOS — sumber yang sama dengan halaman admin
 * `/admin/mikrotik` saat mode autentikasi PPPoE **Mikrotik** (bukan RADIUS).
 * Memindai semua baris di `routers` (multi-NAS), lalu fallback satu koneksi default.
 *
 * Catatan: filter `?name=` kadang mengembalikan `!empty` / error di node-routeros atau
 * tidak cocok versi API — maka fallback ke print penuh (sama pola komentar di disconnectPPPoEUser).
 */
async function getPppSecretCleartextPasswordFromMikrotikRouters(username) {
    const u = (username && String(username).trim()) || '';
    if (!u) return null;
    const ul = u.toLowerCase();

    const pickFromSecrets = (secrets) => {
        if (!Array.isArray(secrets) || secrets.length === 0) return null;
        for (const sec of secrets) {
            if (!sec || sec.name == null) continue;
            const n = String(sec.name).trim();
            if (n !== u && n.toLowerCase() !== ul) continue;
            const val = sec.password != null ? String(sec.password).trim() : '';
            if (val && !looksLikePasswordHashNotCleartext(val)) return val;
        }
        return null;
    };

    const lookupOnConn = async (conn, cacheKey) => {
        if (!conn) return null;
        let filtered = [];
        try {
            filtered = await conn.write('/ppp/secret/print', ['?name=' + u]);
        } catch (e) {
            logger.debug(`[MIKROTIK] secret print ?name= skip (${u}): ${e.message}`);
            filtered = [];
        }
        if (!Array.isArray(filtered)) filtered = [];
        let found = pickFromSecrets(filtered);
        if (found) return found;
        try {
            const allRows = await getCachedFullPppSecrets(conn, cacheKey);
            return pickFromSecrets(allRows);
        } catch (e2) {
            logger.warn(`[MIKROTIK] secret print full (${cacheKey}): ${e2.message}`);
            return null;
        }
    };

    try {
        const routers = await getAllRoutersFromBillingDb();
        if (routers && routers.length > 0) {
            for (const r of routers) {
                try {
                    const conn = await getMikrotikConnectionForRouter(r);
                    const ck = `r${r.id}`;
                    const found = await lookupOnConn(conn, ck);
                    if (found) return found;
                } catch (e) {
                    logger.warn(`[MIKROTIK] PPP secret "${u}" (${r.name || r.id}): ${e.message}`);
                }
            }
            return null;
        }
        const conn = await getMikrotikConnection();
        return await lookupOnConn(conn, '_default');
    } catch (e) {
        logger.warn(`[MIKROTIK] getPppSecretCleartextPasswordFromMikrotikRouters: ${e.message}`);
        return null;
    }
}

// Fungsi untuk mendapatkan seluruh user PPPoE dari RADIUS (BUKAN hotspot voucher DAN BUKAN member hotspot)
async function getPPPoEUsersRadius(options = {}) {
    const {
        allowedUsernames = null,
        skipMikrotikActive = false,
        activeRouters = null,
        mikrotikTimeoutMs = 3000,
        forceRefreshActive = false
    } = options;
    let conn;
    try {
        conn = await getRadiusConnection();
    } catch (connErr) {
        logger.error(`[PPPoE-RADIUS] Koneksi database RADIUS gagal: ${connErr.message}`);
        return [];
    }

    const pMain = sqlRadcheckPasswordPredicate('rc');
    const pSub = sqlRadcheckPasswordPredicate('rc2');

    try {
        logger.info('Fetching PPPoE users from RADIUS database (excluding hotspot vouchers and members)...');

        const excludeUsernames = await getPppoeRadcheckExcludeUsernames();

        // Tanpa subquery ke radusergroup di SQL — file RADIUS minimal sering tidak punya radusergroup.
        let query = `
            SELECT rc.username, rc.value AS password
            FROM radcheck rc
            WHERE ${pMain}
            AND rc.rowid IN (
                SELECT MAX(rc2.rowid) FROM radcheck rc2
                WHERE ${pSub}
                GROUP BY LOWER(TRIM(rc2.username))
            )
        `;

        const params = [];
        if (excludeUsernames.length > 0) {
            const placeholders = excludeUsernames.map(() => '?').join(',');
            query += ` AND rc.username NOT IN (${placeholders})`;
            params.push(...excludeUsernames);
        }

        query = appendAllowedUsernamesSql(query, params, allowedUsernames, 'rc.username');
        query += ` ORDER BY LOWER(TRIM(rc.username))`;

        const [rows] = await conn.execute(query, params);
        const rowList = Array.isArray(rows) ? rows : [];

        logger.info(
            `[PPPoE-RADIUS] radcheck rows (password attrs): ${rowList.length} (exclude list: ${excludeUsernames.length})`
        );

        const profileMap = await getRadusergroupProfileMap(conn, rowList.map((r) => r.username));

        // Label profil = display_name di metadata (sama seperti /admin/mikrotik/profiles)
        const uniqueProfiles = [...new Set([...profileMap.values()].filter(Boolean))];
        const metaByExact = await getPPPoEProfilesMetadata(conn, uniqueProfiles);
        const metaByNorm = new Map();
        for (const [gn, meta] of Object.entries(metaByExact || {})) {
            metaByNorm.set(String(gn).toLowerCase().trim(), meta);
            metaByNorm.set(String(gn).toLowerCase().trim().replace(/\s+/g, '_'), meta);
        }
        // Juga ambil metadata lain bila groupname fisik beda huruf besar/kecil
        try {
            const [allMetaRows] = await conn.execute(
                `SELECT groupname, display_name FROM pppoe_profiles`
            );
            for (const row of Array.isArray(allMetaRows) ? allMetaRows : []) {
                if (!row || !row.groupname) continue;
                const k1 = String(row.groupname).toLowerCase().trim();
                const k2 = k1.replace(/\s+/g, '_');
                if (!metaByNorm.has(k1)) metaByNorm.set(k1, row);
                if (!metaByNorm.has(k2)) metaByNorm.set(k2, row);
            }
        } catch (_) { /* metadata optional */ }

        const resolveProfileLabel = (groupname) => {
            const gn = groupname != null ? String(groupname).trim() : '';
            if (!gn) return 'default';
            // Profil tenant-prefixed: tampilkan groupname fisik (bukan display_name legacy)
            if (/^t\d+_/i.test(gn)) return gn;
            const meta =
                metaByExact[gn] ||
                metaByNorm.get(gn.toLowerCase()) ||
                metaByNorm.get(gn.toLowerCase().replace(/\s+/g, '_'));
            return (meta && meta.display_name) ? String(meta.display_name).trim() : gn;
        };

        await conn.end();

        const activeSet = new Set();
        try {
            const activeConnections = await getActivePPPoEConnectionsRadius({
                skipMikrotik: skipMikrotikActive,
                routers: activeRouters,
                mikrotikTimeoutMs,
                forceRefresh: forceRefreshActive,
                allowedUsernames
            });
            const activeList = Array.isArray(activeConnections)
                ? activeConnections
                : activeConnections && activeConnections.success && Array.isArray(activeConnections.data)
                  ? activeConnections.data
                  : [];
            for (const c of activeList) {
                const n = c && (c.name || c.username);
                if (n) activeSet.add(String(n).toLowerCase().trim());
            }
        } catch (activeError) {
            logger.warn(`Failed to get active connections: ${activeError.message}`);
        }

        const users = rowList.map((row) => {
            const profile = profileMap.get(row.username) || 'default';
            return {
                name: row.username,
                password: row.password,
                profile,
                profile_display: resolveProfileLabel(profile),
                active: activeSet.has(String(row.username).toLowerCase().trim())
            };
        });

        logger.info(`Mapped ${users.length} PPPoE users successfully (${activeSet.size} active)`);
        return users;
    } catch (error) {
        await conn.end();
        logger.error(`Error getting PPPoE users from RADIUS: ${error.message}`);
        logger.error(`Error stack: ${error.stack}`);

        try {
            logger.info('[PPPoE-RADIUS] Fallback: query radcheck tanpa subquery rowid...');
            const conn2 = await getRadiusConnection();
            const excludeUsernames = await getPppoeRadcheckExcludeUsernames();
            const p = sqlRadcheckPasswordPredicate('r');
            let fallbackQuery = `SELECT r.username, r.value AS password FROM radcheck r WHERE ${p}`;
            const params = [];
            if (excludeUsernames.length > 0) {
                const placeholders = excludeUsernames.map(() => '?').join(',');
                fallbackQuery += ` AND r.username NOT IN (${placeholders})`;
                params.push(...excludeUsernames);
            }
            fallbackQuery = appendAllowedUsernamesSql(fallbackQuery, params, allowedUsernames, 'r.username');
            fallbackQuery += ' ORDER BY LOWER(TRIM(r.username))';

            const [fbRows] = await conn2.execute(fallbackQuery, params);
            const fbList = Array.isArray(fbRows) ? fbRows : [];

            const activeSetFb = new Set();
            try {
                const activeConnections = await getActivePPPoEConnectionsRadius({
                    skipMikrotik: skipMikrotikActive,
                    routers: activeRouters,
                    mikrotikTimeoutMs,
                    forceRefresh: forceRefreshActive,
                    allowedUsernames
                });
                const activeListFb = Array.isArray(activeConnections)
                    ? activeConnections
                    : activeConnections && activeConnections.success && Array.isArray(activeConnections.data)
                      ? activeConnections.data
                      : [];
                for (const c of activeListFb) {
                    const n = c && (c.name || c.username);
                    if (n) activeSetFb.add(String(n).toLowerCase().trim());
                }
            } catch (activeError) {
                logger.warn(`Failed to get active connections in fallback: ${activeError.message}`);
            }

            const profileMapFb = await getRadusergroupProfileMap(conn2, fbList.map((r) => r.username));

            await conn2.end();
            logger.info(`[PPPoE-RADIUS] Fallback found ${fbList.length} rows`);

            const byName = new Map();
            for (const row of fbList) {
                if (!row || row.username == null) continue;
                const key = String(row.username).trim();
                if (!byName.has(key)) {
                    byName.set(key, row);
                }
            }
            return [...byName.values()].map((row) => ({
                name: row.username,
                password: row.password,
                profile: profileMapFb.get(row.username) || 'default',
                active: activeSetFb.has(String(row.username).toLowerCase().trim())
            }));
        } catch (fallbackError) {
            logger.error(`[PPPoE-RADIUS] Fallback query also failed: ${fallbackError.message}`);
            return [];
        }
    }
}

/**
 * Semua sesi /ppp/active dari MikroTik (semua NAS) — sumber kebenaran status online.
 * @param {{ routers?: object[], timeoutMs?: number }} [options]
 * @returns {Promise<Map<string, object>>}
 */
async function collectMikrotikPppActiveSessionsByLoginMap(options = {}) {
    const byLogin = new Map();
    const mergeRow = (row) => {
        const n = row && row.name != null ? String(row.name).trim() : '';
        if (n) byLogin.set(n, row);
    };
    const timeoutMs = options.timeoutMs ?? 3000;
    const routers = options.routers ?? (await getAllRoutersFromBillingDb());

    const fetchActiveForRouter = async (r) => {
        const label = r ? `router ${r.name || r.id}` : 'single NAS';
        try {
            const active = await Promise.race([
                (async () => {
                    const conn = r ? await getMikrotikConnectionForRouter(r) : await getMikrotikConnection();
                    if (!conn) return [];
                    return await conn.write('/ppp/active/print');
                })(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)
                )
            ]);
            return active || [];
        } catch (e) {
            logger.warn(`[collectMikrotikPppActiveSessionsByLoginMap] ${label}: ${e.message}`);
            return [];
        }
    };

    if (!routers.length) {
        const rows = await fetchActiveForRouter(null);
        for (const row of rows) mergeRow(row);
        return byLogin;
    }

    const results = await Promise.all(routers.map((r) => fetchActiveForRouter(r)));
    for (const active of results) {
        for (const row of active) mergeRow(row);
    }
    return byLogin;
}

// Fungsi untuk mendapatkan active PPPoE connections dari RADIUS (BUKAN hotspot voucher DAN BUKAN member hotspot)
async function getActivePPPoEConnectionsRadius(options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const skipMikrotik = options.skipMikrotik === true;
    const cacheKey = scopedRadiusCacheKey(
        skipMikrotik ? ACTIVE_RADIUS_SESSIONS_RADACCT_CACHE_BASE : ACTIVE_RADIUS_SESSIONS_CACHE_BASE
    );
    if (!forceRefresh) {
        const cached = cacheManager.get(cacheKey);
        if (cached) {
            return cached;
        }
    }

    try {
        const excludeUsernames = await getPppoeRadcheckExcludeUsernames();
        const excludeSet = new Set(excludeUsernames);
        logger.info(`Excluding ${excludeUsernames.length} voucher/hotspot from active PPPoE connections`);

        let mikrotikByLogin = new Map();
        if (!skipMikrotik) {
            mikrotikByLogin = await collectMikrotikPppActiveSessionsByLoginMap({
                routers: options.routers,
                timeoutMs: options.mikrotikTimeoutMs
            });
        }

        let mysqlByLogin = new Map();
        try {
            const {
                isRadiusAccountingOnMysql,
                getActiveSessionsFromMysqlRadacct
            } = require('./radiusMysqlAccounting');
            if (isRadiusAccountingOnMysql()) {
                const mysqlRows = await getActiveSessionsFromMysqlRadacct(excludeUsernames);
                for (const row of mysqlRows) {
                    const u = row.username != null ? String(row.username).trim() : '';
                    if (u) mysqlByLogin.set(u, row);
                }
            }
        } catch (mysqlErr) {
            logger.warn(`[PPPoE-RADIUS] MySQL radacct skip: ${mysqlErr.message}`);
        }

        if (skipMikrotik && mysqlByLogin.size === 0) {
            const sqliteRows = await getActiveSessionsFromSqliteRadacct(
                excludeUsernames,
                options.allowedUsernames
            );
            for (const row of sqliteRows) {
                const u = row.username != null ? String(row.username).trim() : '';
                if (u) mysqlByLogin.set(u, row);
            }
        }

        const allowedSet =
            Array.isArray(options.allowedUsernames) && options.allowedUsernames.length > 0
                ? new Set(
                      options.allowedUsernames
                          .map((u) => String(u).toLowerCase().trim())
                          .filter(Boolean)
                  )
                : null;

        const seen = new Set();
        const result = [];

        if (!skipMikrotik) {
            for (const [name, mtRow] of mikrotikByLogin.entries()) {
                if (excludeSet.has(name)) continue;
                if (allowedSet && !allowedSet.has(String(name).toLowerCase().trim())) continue;
                seen.add(name);
                const mysqlRow = mysqlByLogin.get(name);
                const ip =
                    (mtRow.address && String(mtRow.address).trim()) ||
                    (mysqlRow && mysqlRow.framedipaddress) ||
                    'N/A';
                const uptimeRaw =
                    mtRow.uptime != null && mtRow.uptime !== ''
                        ? mtRow.uptime
                        : mysqlRow && mysqlRow.session_time != null
                          ? mysqlRow.session_time
                          : 0;
                result.push({
                    name,
                    ip,
                    uptime: uptimeRaw,
                    'bytes-in': mysqlRow?.acctinputoctets || mtRow['bytes-in'] || 0,
                    'bytes-out': mysqlRow?.acctoutputoctets || mtRow['bytes-out'] || 0,
                    nasip: mysqlRow?.nasipaddress || 'Mikrotik'
                });
            }
        }

        // Tambahan dari MySQL/SQLite radacct jika belum ada di Mikrotik (atau mode radacct-only)
        for (const [name, mysqlRow] of mysqlByLogin.entries()) {
            if (excludeSet.has(name)) continue;
            if (allowedSet && !allowedSet.has(String(name).toLowerCase().trim())) continue;
            if (!skipMikrotik && seen.has(name)) continue;
            result.push({
                name,
                ip: mysqlRow.framedipaddress || 'N/A',
                uptime: mysqlRow.session_time != null ? mysqlRow.session_time : 0,
                'bytes-in': mysqlRow.acctinputoctets || 0,
                'bytes-out': mysqlRow.acctoutputoctets || 0,
                nasip: mysqlRow.nasipaddress || 'RADIUS'
            });
        }

        cacheManager.set(cacheKey, result, ACTIVE_RADIUS_SESSIONS_CACHE_TTL);
        logger.info(
            `[PPPoE-RADIUS] Active sessions: ${result.length} (Mikrotik: ${mikrotikByLogin.size}, radacct: ${mysqlByLogin.size}, skipMikrotik: ${skipMikrotik})`
        );
        return result;
    } catch (error) {
        logger.error(`Error getting active PPPoE connections from RADIUS: ${error.message}`);
        return [];
    }
}

/**
 * Apakah login PPPoE sedang online — sama dengan kolom "active" di /admin/mikrotik
 * (nama di /ppp/active per NAS, atau username di sesi RADIUS radacct terbuka).
 */
async function getAllRoutersFromBillingDb() {
    const sqlite3 = require('sqlite3').verbose();
    const dbPath = path.join(__dirname, '../data/billing.db');
    const db = new sqlite3.Database(dbPath);
    const whereSql = _routersTenantWhereSql();
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM routers${whereSql} ORDER BY id`, [], (err, rows) => {
            db.close();
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

async function getPppoeLoginOnlineStatus(login) {
    const name = login != null ? String(login).trim() : '';
    if (!name) {
        return { online: false, authMode: null };
    }
    const authMode = await getUserAuthModeAsync();
    if (authMode === 'radius') {
        const mikrotikByLogin = await collectMikrotikPppActiveSessionsByLoginMap();
        if (mikrotikByLogin.has(name)) {
            return { online: true, authMode: 'radius' };
        }
        const active = await getActivePPPoEConnectionsRadius();
        const online = (active || []).some((a) => String(a.name) === name);
        return { online, authMode: 'radius' };
    }
    const routers = await getAllRoutersFromBillingDb();
    if (!routers.length) {
        try {
            const conn = await getMikrotikConnection();
            if (conn) {
                const active = await conn.write('/ppp/active/print');
                const online = (active || []).some((a) => String(a.name) === name);
                return { online, authMode: 'mikrotik' };
            }
        } catch (e) {
            logger.warn(`[getPppoeLoginOnlineStatus] single NAS: ${e.message}`);
        }
        return { online: false, authMode: 'mikrotik' };
    }
    const results = await Promise.all(
        routers.map(async (r) => {
            try {
                const conn = await getMikrotikConnectionForRouter(r);
                const active = await conn.write('/ppp/active/print');
                return (active || []).some((a) => String(a.name) === name);
            } catch (e) {
                logger.warn(`[getPppoeLoginOnlineStatus] router ${r.name}: ${e.message}`);
                return false;
            }
        })
    );
    return { online: results.some(Boolean), authMode: 'mikrotik' };
}

/**
 * Sama seperti mobileAdapter `toDhmsFromSeconds` + string RouterOS mentah — dipakai network-map & konsisten detail pelanggan.
 */
function formatPppActiveUptimeLikeCustomerDetail(rawUptime) {
    if (rawUptime == null || rawUptime === '') return null;
    if (typeof rawUptime === 'bigint') {
        const secs = Number(rawUptime);
        if (!Number.isFinite(secs) || secs < 0) return null;
        return formatPppActiveDhmsFromSeconds(secs);
    }
    if (typeof rawUptime === 'number' && Number.isFinite(rawUptime)) {
        return formatPppActiveDhmsFromSeconds(rawUptime);
    }
    const s = String(rawUptime).trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
        return formatPppActiveDhmsFromSeconds(Number(s)) || s;
    }
    return s;
}

function formatPppActiveDhmsFromSeconds(rawSeconds) {
    const secs = Number(rawSeconds);
    if (!Number.isFinite(secs) || secs < 0) return null;
    const total = Math.floor(secs);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

/** Uptime tampilan dari satu baris /ppp/active (MikroTik), selaras endpoint customers/:id/ppp-session. */
function pppActiveRowToUptimeDisplay(row) {
    if (!row) return null;
    const rawUptime =
        row.uptime != null && row.uptime !== ''
            ? row.uptime
            : row['session-time'] != null && row['session-time'] !== ''
              ? row['session-time']
              : row.session_time != null && row.session_time !== ''
                ? row.session_time
                : null;
    return formatPppActiveUptimeLikeCustomerDetail(rawUptime);
}

/**
 * Hanya dari MikroTik /ppp/active/print (semua router) — dipakai uptime network map; sama sumbernya detail pelanggan.
 */
async function collectMikrotikPppActiveUptimeByLoginMap() {
    const uptimeByLogin = Object.create(null);
    const mergeUptime = (row) => {
        const n = row && row.name != null ? String(row.name).trim() : '';
        if (!n) return;
        const disp = pppActiveRowToUptimeDisplay(row);
        if (disp) {
            uptimeByLogin[String(n).toLowerCase()] = disp;
        }
    };
    const routers = await getAllRoutersFromBillingDb();
    if (!routers.length) {
        try {
            const conn = await getMikrotikConnection();
            if (conn) {
                const active = await conn.write('/ppp/active/print');
                for (const row of active || []) mergeUptime(row);
            }
        } catch (e) {
            logger.warn(`[collectMikrotikPppActiveUptimeByLoginMap] single NAS: ${e.message}`);
        }
        return uptimeByLogin;
    }
    for (const r of routers) {
        try {
            const conn = await getMikrotikConnectionForRouter(r);
            const active = await conn.write('/ppp/active/print');
            for (const row of active || []) mergeUptime(row);
        } catch (e) {
            logger.warn(`[collectMikrotikPppActiveUptimeByLoginMap] router ${r.name}: ${e.message}`);
        }
    }
    return uptimeByLogin;
}

/** Cache singkat agar list pelanggan / network-map tidak menunggu reconnect MikroTik tiap request. */
const ACTIVE_PPPOE_CACHE_TTL_MS = 30000;
/** Cold start (belum ada cache): tunggu cukup lama agar badge mobile tidak kosong/offline. */
const ACTIVE_PPPOE_COLD_START_WAIT_MS = 10000;
/** Cache + inflight per tenant — hindari tenant A memakai set online tenant B (atau sebaliknya). */
const _activePppoeCacheByTenant = new Map();
const _activePppoeInflightByTenant = new Map();

function _activePppoeTenantCacheKey() {
    try {
        const { hasTenantContext, getTenantId } = require('./platform/tenantContext');
        if (hasTenantContext()) {
            const tid = parseInt(getTenantId(), 10);
            if (Number.isFinite(tid)) return `t${tid}`;
        }
    } catch (_) {
        /* ignore */
    }
    return 'global';
}

function cloneActivePppoeResult(result) {
    return {
        names: new Set(result.names || []),
        uptimeByLogin: { ...(result.uptimeByLogin || {}) },
    };
}

/**
 * Sekali panggil: himpunan login online (RADIUS radacct ATAU nama di /ppp/active) + uptime tampilan **hanya dari MikroTik /ppp/active**
 * (sama flow sumber uptime seperti GET customers/:id/ppp-session).
 * Dipakai mobile-adapter network-map (tanpa N+1 per pelanggan).
 * Nama login di Set selalu lowercase agar cocok dengan badge mobile.
 */
async function fetchActivePppoeLoginNamesSetWithUptimeMapUncached(options = {}) {
    const namesOnly = options.namesOnly === true;
    const set = new Set();
    const authMode = await getUserAuthModeAsync();

    if (authMode === 'radius') {
        // Satu poll (sama sumber /admin/mikrotik) — jangan poll /ppp/active kedua kali hanya untuk uptime.
        const active = await getActivePPPoEConnectionsRadius({
            mikrotikTimeoutMs: options.mikrotikTimeoutMs,
            forceRefresh: options.forceRefresh === true
        });
        const uptimeByLogin = Object.create(null);
        for (const a of active || []) {
            const n = a && a.name != null ? String(a.name).trim().toLowerCase() : '';
            if (!n) continue;
            set.add(n);
            if (!namesOnly) {
                const disp = formatPppActiveUptimeLikeCustomerDetail(a.uptime);
                if (disp) uptimeByLogin[n] = disp;
            }
        }
        return { names: set, uptimeByLogin };
    }

    const uptimeByLogin = Object.create(null);
    const mergeRow = (row) => {
        const n = row && row.name != null ? String(row.name).trim().toLowerCase() : '';
        if (!n) return;
        set.add(n);
        if (!namesOnly) {
            const disp = pppActiveRowToUptimeDisplay(row);
            if (disp) uptimeByLogin[n] = disp;
        }
    };
    const routers = await getAllRoutersFromBillingDb();
    if (!routers.length) {
        try {
            const conn = await getMikrotikConnection();
            if (conn) {
                const active = await conn.write('/ppp/active/print');
                for (const row of active || []) mergeRow(row);
            }
        } catch (e) {
            logger.warn(`[getActivePppoeLoginNamesSetWithUptimeMap] single NAS: ${e.message}`);
        }
        return { names: set, uptimeByLogin };
    }
    // Parallel per router — router down tidak ditunggu berantai.
    await Promise.all(
        routers.map(async (r) => {
            try {
                const conn = await getMikrotikConnectionForRouter(r);
                const active = await conn.write('/ppp/active/print');
                for (const row of active || []) mergeRow(row);
            } catch (e) {
                logger.warn(`[getActivePppoeLoginNamesSetWithUptimeMap] router ${r.name}: ${e.message}`);
            }
        })
    );
    return { names: set, uptimeByLogin };
}

async function getActivePppoeLoginNamesSetWithUptimeMap(options = {}) {
    const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : ACTIVE_PPPOE_CACHE_TTL_MS;
    const forceRefresh = options.forceRefresh === true;
    const maxWaitMs = Number.isFinite(options.maxWaitMs) ? options.maxWaitMs : 1200;
    const namesOnly = options.namesOnly === true;
    const cacheKey = `${_activePppoeTenantCacheKey()}:${namesOnly ? 'names' : 'full'}`;
    const now = Date.now();
    const cachedEntry = _activePppoeCacheByTenant.get(cacheKey) || null;

    if (!forceRefresh && cachedEntry && now - cachedEntry.at < ttlMs) {
        return cloneActivePppoeResult(cachedEntry.value);
    }

    const emptyResult = () => ({ names: new Set(), uptimeByLogin: Object.create(null) });

    const awaitWithBudget = async (promise, staleEntry) => {
        // Stale-while-revalidate: jangan blokir list pelanggan jika cache (meski expired) masih ada.
        if (staleEntry && !forceRefresh) {
            return cloneActivePppoeResult(staleEntry.value);
        }
        // Cold start: tunggu lebih lama — timeout pendek (ex: 800ms) membuat semua badge Offline di mobile.
        const waitMs =
            staleEntry || forceRefresh
                ? maxWaitMs
                : Math.max(maxWaitMs, ACTIVE_PPPOE_COLD_START_WAIT_MS);
        try {
            const value = await Promise.race([
                promise,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('active-pppoe-cache-wait-timeout')), waitMs)
                ),
            ]);
            return cloneActivePppoeResult(value);
        } catch (e) {
            if (e && e.message === 'active-pppoe-cache-wait-timeout') {
                if (staleEntry) {
                    return cloneActivePppoeResult(staleEntry.value);
                }
                logger.warn(
                    `[getActivePppoeLoginNamesSetWithUptimeMap] cold-start timeout ${waitMs}ms (${cacheKey})`
                );
                return emptyResult();
            }
            if (staleEntry) {
                return cloneActivePppoeResult(staleEntry.value);
            }
            throw e;
        }
    };

    const existingInflight = _activePppoeInflightByTenant.get(cacheKey);
    if (existingInflight) {
        return awaitWithBudget(existingInflight, cachedEntry);
    }

    const inflight = (async () => {
        try {
            const value = await fetchActivePppoeLoginNamesSetWithUptimeMapUncached({
                namesOnly,
                mikrotikTimeoutMs: options.mikrotikTimeoutMs,
                forceRefresh
            });
            _activePppoeCacheByTenant.set(cacheKey, { at: Date.now(), value });
            return value;
        } catch (e) {
            if (cachedEntry) {
                logger.warn(
                    `[getActivePppoeLoginNamesSetWithUptimeMap] refresh failed, using stale cache: ${e.message}`
                );
                return cachedEntry.value;
            }
            throw e;
        } finally {
            _activePppoeInflightByTenant.delete(cacheKey);
        }
    })();
    _activePppoeInflightByTenant.set(cacheKey, inflight);

    return awaitWithBudget(inflight, cachedEntry);
}

/**
 * Sekali panggil: himpunan nama login PPPoE yang sedang online (semua NAS / RADIUS).
 * Dipakai mobile-adapter (list pelanggan / network-map) agar tidak N+1 per pelanggan.
 */
async function getActivePppoeLoginNamesSet(options = {}) {
    const { names } = await getActivePppoeLoginNamesSetWithUptimeMap({
        ...options,
        namesOnly: true
    });
    return names;
}

// Fungsi untuk mendapatkan statistik RADIUS (total users, active, offline) - HANYA PPPoE milik tenant
async function getRadiusStatistics() {
    const conn = await getRadiusConnection();
    try {
        const { getTenantAllowedPppoeUsernames } = require('../utils/tenantPppoeOwnership');
        const allowedUsernames = await getTenantAllowedPppoeUsernames();

        // Tenant aktif tanpa user → 0 (jangan hitung seluruh radcheck bersama)
        if (allowedUsernames !== null && allowedUsernames.length === 0) {
            await conn.end();
            return { total: 0, active: 0, offline: 0 };
        }

        const excludeUsernames = await getPppoeRadcheckExcludeUsernames();
        const pwdC = sqlRadcheckPasswordPredicate('c');

        let totalQuery = `
            SELECT COUNT(DISTINCT c.username) as total
            FROM radcheck c
            WHERE ${pwdC}
        `;
        const params = [];
        if (excludeUsernames.length > 0) {
            const placeholders = excludeUsernames.map(() => '?').join(',');
            totalQuery += ` AND c.username NOT IN (${placeholders})`;
            params.push(...excludeUsernames);
        }
        totalQuery = appendAllowedUsernamesSql(totalQuery, params, allowedUsernames, 'c.username');

        const [totalRows] = await conn.execute(totalQuery, params);
        const totalRowList = Array.isArray(totalRows) ? totalRows : [];
        const totalUsers = totalRowList[0]?.total || 0;

        let activeConnections = 0;
        try {
            const activeList = await getActivePPPoEConnectionsRadius({
                forceRefresh: true,
                allowedUsernames: allowedUsernames === null ? null : allowedUsernames
            });
            let list = Array.isArray(activeList) ? activeList : [];
            if (Array.isArray(allowedUsernames) && allowedUsernames.length > 0) {
                const set = new Set(
                    allowedUsernames.map((u) => String(u).toLowerCase().trim()).filter(Boolean)
                );
                list = list.filter((u) => set.has(String(u?.name || u?.username || '').toLowerCase().trim()));
            }
            activeConnections = list.length;
        } catch (activeStatErr) {
            logger.warn(`[RADIUS stats] active sessions tidak dihitung: ${activeStatErr.message}`);
        }

        const offlineUsers = Math.max(totalUsers - activeConnections, 0);

        await conn.end();

        logger.info(
            `RADIUS Statistics - Total: ${totalUsers}, Active: ${activeConnections}, Offline: ${offlineUsers}` +
            (allowedUsernames === null
                ? ' (global)'
                : ` (tenant allowlist ${allowedUsernames.length})`)
        );

        return {
            total: totalUsers,
            active: activeConnections,
            offline: offlineUsers
        };
    } catch (error) {
        try { await conn.end(); } catch (_) {}
        logger.error(`Error getting RADIUS statistics: ${error.message}`);
        return {
            total: 0,
            active: 0,
            offline: 0
        };
    }
}

// Fungsi untuk menambah user PPPoE ke RADIUS
async function addPPPoEUserRadius({ username, password, profile = null }) {
    try {
        const conn = await getRadiusConnection();
        if (!conn) {
            logger.error(`[RADIUS] Failed to get RADIUS connection for user ${username}`);
            return { success: false, message: 'Koneksi ke database RADIUS gagal', error: 'Connection failed' };
        }

        logger.info(`[RADIUS] Adding PPPoE user ${username} with profile ${profile || 'default'}`);

        let profileToUse = null;
        if (profile) {
            profileToUse = await resolveRadiusProfileGroupname(conn, profile);
            if (!profileToUse) {
                return {
                    success: false,
                    message: `Profil "${String(profile).trim()}" tidak ditemukan di RADIUS (radgroupreply/radgroupcheck). Pilih profil yang valid.`,
                    error: 'unknown_profile'
                };
            }
        }

        const result = await conn.runInTransaction(async (db) => {
            await db.execute(
                "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?) ON CONFLICT(username, attribute) DO UPDATE SET value = excluded.value",
                [username, password]
            );
            if (profileToUse) {
                await db.execute('DELETE FROM radusergroup WHERE username = ?', [username]);
                await db.execute(
                    'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)',
                    [username, profileToUse]
                );
            }
            return { success: true, message: 'User berhasil ditambahkan ke RADIUS' };
        });

        logger.info(`[RADIUS] Successfully added PPPoE user ${username} to RADIUS database`);
        if (result && result.success) await syncRadiusToFreeRadiusMysql();
        return result;
    } catch (error) {
        logger.error(`[RADIUS] Error adding PPPoE user ${username} to RADIUS:`, error);
        logger.error(`[RADIUS] Error stack:`, error.stack);
        return { success: false, message: `Gagal menambahkan user ke RADIUS: ${error.message}`, error: error.message };
    }
}

// Fungsi untuk update password user PPPoE di RADIUS
async function updatePPPoEUserRadiusPassword({ username, password }) {
    const conn = await getRadiusConnection();
    try {
        await conn.execute(
            "UPDATE radcheck SET value = ? WHERE username = ? AND attribute = 'Cleartext-Password'",
            [password, username]
        );
        await conn.end();
        return { success: true, message: 'Password user berhasil diupdate di RADIUS' };
    } catch (error) {
        await conn.end();
        logger.error(`Error updating PPPoE user password in RADIUS: ${error.message}`);
        throw error;
    }
}

// Helper: Build rate-limit string untuk Mikrotik format
function buildMikrotikRateLimit({ upload_limit, download_limit, burst_limit_upload, burst_limit_download, burst_threshold, burst_time }) {
    if (!download_limit && !upload_limit) return null;
    
    const download = download_limit || '0';
    const upload = upload_limit || '0';
    let rateLimit = `${download}/${upload}`;
    
    // Jika ada burst, format Mikrotik: "download/upload download-burst/upload-burst [threshold/threshold] time/time"
    // Contoh: "30M/30M 40M/40M 30M/30M 10/10"
    // PENTING: burst_time harus dalam format "10/10" (detik tanpa unit), bukan "10s"
    if (burst_limit_download && burst_limit_upload && burst_time) {
        rateLimit += ` ${burst_limit_download}/${burst_limit_upload}`;
        
        // Threshold opsional - format: "download-threshold/upload-threshold"
        if (burst_threshold && burst_threshold.trim() !== '') {
            if (burst_threshold.includes('/')) {
                rateLimit += ` ${burst_threshold}`;
            } else {
                rateLimit += ` ${burst_threshold}/${burst_threshold}`;
            }
        }
        
        // burst_time wajib ada dan harus dalam format "10/10" (detik tanpa unit)
        // Convert dari format "10s" atau "10" menjadi "10/10"
        let burstTimeFormatted = burst_time;
        // Remove unit jika ada (s, m, h, d)
        burstTimeFormatted = burstTimeFormatted.replace(/[smhd]$/i, '');
        // Extract numeric value
        const timeValue = parseInt(burstTimeFormatted) || 10;
        // Format sebagai "time/time" untuk download dan upload
        rateLimit += ` ${timeValue}/${timeValue}`;
    } else if (burst_limit_download && burst_limit_upload && !burst_time) {
        // Jika ada burst_limit tapi tidak ada burst_time, log warning dan skip burst
        logger.warn(`Burst limit ditemukan tapi burst_time tidak ada. Mengabaikan burst untuk menghindari error Mikrotik.`);
    }
    
    return rateLimit;
}

// Fungsi untuk sync package limits ke RADIUS (radgroupreply)
async function syncPackageLimitsToRadius({ groupname, upload_limit, download_limit, burst_limit_upload, burst_limit_download, burst_threshold, burst_time }) {
    const {
        ensureExclusivePppoeProfileForTenant,
        claimTenantPppoeProfile,
        normalizeGroupname: normProfile
    } = require('../utils/tenantPppoeProfileOwnership');
    let exclusiveName = normProfile(groupname);
    try {
        const exclusive = await ensureExclusivePppoeProfileForTenant(exclusiveName);
        exclusiveName = exclusive.groupname || exclusiveName;
        await claimTenantPppoeProfile(exclusiveName);
    } catch (ownErr) {
        logger.warn(`[syncPackageLimitsToRadius] Ownership: ${ownErr.message}`);
        throw ownErr;
    }

    const conn = await getRadiusConnection();
    try {
        const normalizedGroupname = exclusiveName;
        
        // Hapus limit attributes yang lama untuk group ini
        await conn.execute(
            "DELETE FROM radgroupreply WHERE groupname = ? AND attribute IN ('MikroTik-Rate-Limit', 'MikroTik-Total-Limit')",
            [normalizedGroupname]
        );
        
        // Build rate-limit string: "download-limit/upload-limit" atau dengan burst
        let rateLimitStr = '';
        if (download_limit && upload_limit) {
            rateLimitStr = `${download_limit}/${upload_limit}`;
            
            // Jika ada burst, tambahkan burst info
            // Format Mikrotik RADIUS: "rx-rate[/tx-rate] [rx-burst-rate[/tx-burst-rate] [rx-burst-threshold[/tx-burst-threshold] [rx-burst-time[/tx-burst-time]]]]"
            // Contoh: "30M/30M 40M/40M 30M/30M 10/10"
            // PENTING: burst_time harus dalam format "10/10" (detik, tanpa unit), bukan "10s"
            if (burst_limit_download && burst_limit_upload && burst_time) {
                rateLimitStr += ` ${burst_limit_download}/${burst_limit_upload}`;
                
                // Threshold opsional - format: "download-threshold/upload-threshold"
                if (burst_threshold && burst_threshold.trim() !== '') {
                    // Jika threshold adalah single value, duplikasi untuk upload
                    if (burst_threshold.includes('/')) {
                        rateLimitStr += ` ${burst_threshold}`;
                    } else {
                        // Jika single value, gunakan untuk download dan upload
                        rateLimitStr += ` ${burst_threshold}/${burst_threshold}`;
                    }
                }
                
                // burst_time wajib ada dan harus dalam format "10/10" (detik tanpa unit)
                // Convert dari format "10s" atau "10" menjadi "10/10"
                let burstTimeFormatted = burst_time;
                // Remove unit jika ada (s, m, h, d)
                burstTimeFormatted = burstTimeFormatted.replace(/[smhd]$/i, '');
                // Extract numeric value
                const timeValue = parseInt(burstTimeFormatted) || 10;
                // Format sebagai "time/time" untuk download dan upload
                rateLimitStr += ` ${timeValue}/${timeValue}`;
            } else if (burst_limit_download && burst_limit_upload && !burst_time) {
                // Jika ada burst_limit tapi tidak ada burst_time, log warning dan skip burst
                logger.warn(`Burst limit ditemukan untuk group ${normalizedGroupname} tapi burst_time tidak ada. Mengabaikan burst untuk menghindari error Mikrotik.`);
            }
        } else if (download_limit) {
            rateLimitStr = `${download_limit}/${upload_limit || '0'}`;
        } else if (upload_limit) {
            rateLimitStr = `0/${upload_limit}`;
        }
        
        // Insert rate limit ke radgroupreply jika ada
        if (rateLimitStr) {
            await conn.execute(
                "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'MikroTik-Rate-Limit', ':=', ?)",
                [normalizedGroupname, rateLimitStr]
            );
            logger.info(`✅ Rate limit untuk group ${normalizedGroupname}: ${rateLimitStr}`);
        } else {
            // Pastikan profile tetap ada di radgroupreply agar muncul di UI
            const [existing] = await conn.execute(
                "SELECT COUNT(*) as count FROM radgroupreply WHERE groupname = ?",
                [normalizedGroupname]
            );
            if (existing[0].count === 0) {
                await conn.execute(
                    "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Reply-Message', ':=', 'Profile created from billing')",
                    [normalizedGroupname]
                );
                logger.info(`✅ Dummy attribute ditambahkan untuk group ${normalizedGroupname} agar muncul di UI`);
            }
        }
        
        await conn.end();
        return {
            success: true,
            message: `Package limits berhasil di-sync ke RADIUS group ${normalizedGroupname}`,
            groupname: normalizedGroupname
        };
    } catch (error) {
        await conn.end();
        logger.error(`Error syncing package limits to RADIUS: ${error.message}`);
        throw error;
    }
}

// Fungsi untuk assign user ke package/group di RADIUS
async function assignPackageRadius({ username, groupname }) {
    const conn = await getRadiusConnection();
    try {
        const resolved = await resolvePppoeProfileHintToRadiusGroup(conn, groupname);
        if (!resolved) {
            await conn.end();
            return {
                success: false,
                message: `Grup/profil "${String(groupname).trim()}" tidak ditemukan di RADIUS (radgroupreply/radgroupcheck).`
            };
        }

        // HAPUS SEMUA groupname untuk username ini terlebih dahulu untuk menghindari duplikasi
        await conn.execute(
            "DELETE FROM radusergroup WHERE username = ?",
            [username]
        );
        
        // Insert groupname yang baru
        await conn.execute(
            "INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)",
            [username, resolved]
        );
        
        await conn.end();
        return { success: true, message: `User berhasil di-assign ke package ${resolved}` };
    } catch (error) {
        await conn.end();
        logger.error(`Error assigning package in RADIUS: ${error.message}`);
        throw error;
    }
}

// Fungsi untuk memastikan profile isolir ada di RADIUS dengan konfigurasi yang benar
async function ensureIsolirProfileRadius() {
    const conn = await getRadiusConnection();
    try {
        // Cek group 'isolir' di radgroupreply ATAU radgroupcheck (admin/Mikrotik bisa isi salah satu saja)
        const [replyExisting] = await conn.execute(
            "SELECT COUNT(*) as count FROM radgroupreply WHERE groupname = 'isolir'"
        );
        const [checkExisting] = await conn.execute(
            "SELECT COUNT(*) as count FROM radgroupcheck WHERE groupname = 'isolir'"
        );
        const replyCount = replyExisting && replyExisting[0] ? Number(replyExisting[0].count) : 0;
        const checkCount = checkExisting && checkExisting[0] ? Number(checkExisting[0].count) : 0;

        if (replyCount > 0 || checkCount > 0) {
            // Profile isolir sudah ada, hapus rate-limit jika ada (biarkan loss untuk redirect web isolir)
            const [rateLimitRows] = await conn.execute(
                "SELECT value FROM radgroupreply WHERE groupname = 'isolir' AND attribute = 'MikroTik-Rate-Limit'"
            );
            
            // Hapus rate-limit jika ada (untuk isolir, biarkan loss saja untuk redirect web)
            if (rateLimitRows.length > 0) {
                logger.info('Profile isolir memiliki rate-limit, menghapus untuk biarkan loss (redirect web isolir)...');
                await conn.execute(
                    "DELETE FROM radgroupreply WHERE groupname = 'isolir' AND attribute = 'MikroTik-Rate-Limit'"
                );
                logger.info('✅ Rate-limit berhasil dihapus dari profile isolir');
            }
            
            // Cek apakah ada Framed-Pool atau Framed-IP-Address
            const [framedPoolRows] = await conn.execute(
                "SELECT value FROM radgroupreply WHERE groupname = 'isolir' AND attribute = 'Framed-Pool'"
            );
            const [framedIPRows] = await conn.execute(
                "SELECT value FROM radgroupreply WHERE groupname = 'isolir' AND attribute = 'Framed-IP-Address'"
            );
            
            // Jika tidak ada Framed-Pool atau Framed-IP-Address, tambahkan Framed-Pool default
            if (framedPoolRows.length === 0 && framedIPRows.length === 0) {
                logger.warn('Profile isolir tidak punya Framed-Pool atau Framed-IP-Address, menambahkan Framed-Pool default...');
                const isolirPool = getSetting('isolir_pool', 'isolir-pool');
                await conn.execute(
                    "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES ('isolir', 'Framed-Pool', ':=', ?) ON CONFLICT(groupname, attribute) DO UPDATE SET value = excluded.value",
                    [isolirPool]
                );
                logger.info(`Profile isolir sekarang menggunakan Framed-Pool: ${isolirPool}`);
            }
            
            await conn.end();
            return { success: true, message: 'Profile isolir sudah ada dan konfigurasinya benar' };
        }
        
        // Profile isolir belum ada, buat dengan konfigurasi yang benar
        logger.info('Profile isolir belum ada di RADIUS, membuat profile isolir...');
        
        // 1. Insert Simultaneous-Use (required); idempoten jika baris sudah ada
        await conn.execute(
            "INSERT INTO radgroupcheck (groupname, attribute, op, value) VALUES ('isolir', 'Simultaneous-Use', ':=', '1') ON CONFLICT(groupname, attribute) DO NOTHING"
        );
        
        // 2. JANGAN set Rate-Limit untuk isolir (biarkan loss saja untuk redirect web isolir)
        // Rate-limit tidak diperlukan karena isolir hanya untuk redirect web, bukan untuk limit speed
        
        // 3. JANGAN set Session-Timeout atau Idle-Timeout (biarkan kosong)
        // Karena timeout yang terlalu kecil bisa menyebabkan disconnect
        
        // 4. Set Framed-Pool untuk isolir (default: isolir-pool)
        // Pool ini biasanya dibuat dari script generator isolir Mikrotik
        const isolirPool = getSetting('isolir_pool', 'isolir-pool');
        await conn.execute(
            "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES ('isolir', 'Framed-Pool', ':=', ?) ON CONFLICT(groupname, attribute) DO UPDATE SET value = excluded.value",
            [isolirPool]
        );
        logger.info(`Profile isolir menggunakan Framed-Pool: ${isolirPool}`);
        
        // 5. Atau set Framed-IP-Address jika ada setting isolir IP range (alternatif)
        const isolirIpRange = getSetting('isolir_ip_range', null);
        if (isolirIpRange) {
            // Hapus Framed-Pool jika menggunakan IP range langsung
            await conn.execute(
                "DELETE FROM radgroupreply WHERE groupname = 'isolir' AND attribute = 'Framed-Pool'"
            );
            await conn.execute(
                "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES ('isolir', 'Framed-IP-Address', ':=', ?) ON CONFLICT(groupname, attribute) DO UPDATE SET value = excluded.value",
                [isolirIpRange]
            );
            logger.info(`Profile isolir menggunakan Framed-IP-Address: ${isolirIpRange}`);
        }
        
        await conn.end();
        logger.info('✅ Profile isolir berhasil dibuat di RADIUS dengan konfigurasi yang benar');
        return { success: true, message: 'Profile isolir berhasil dibuat di RADIUS' };
    } catch (error) {
        await conn.end();
        logger.error(`Error ensuring isolir profile in RADIUS: ${error.message}`);
        throw error;
    }
}

// Fungsi untuk suspend user (pindahkan ke group 'isolir')
async function suspendUserRadius(username, options = {}) {
    const skipEnsureIsolir = options.skipEnsureIsolir === true;
    const conn = await getRadiusConnection();
    try {
        if (!skipEnsureIsolir) {
            await ensureIsolirProfileRadius();
        }
        
        // Simpan group sebelumnya (jika ada) untuk bisa restore nanti
        // Ambil group yang BUKAN 'isolir' (untuk restore nanti)
        const [currentGroup] = await conn.execute(
            "SELECT groupname FROM radusergroup WHERE username = ? AND groupname != 'isolir' LIMIT 1",
            [username]
        );
        
        let previousGroupToSave = null;
        
        // Jika ada group sebelumnya, simpan
        if (currentGroup && currentGroup.length > 0) {
            previousGroupToSave = currentGroup[0].groupname;
            logger.info(`[RADIUS] Saving previous group for ${username}: ${previousGroupToSave}`);
        } else {
            // Jika tidak ada group di radusergroup, coba ambil dari billing database
            // untuk mendapatkan package yang seharusnya digunakan
            try {
                const billingManager = require('./billing');
                let customer = null;
                try {
                    customer = await billingManager.getCustomerByUsername(username);
                } catch (e) {
                    // Jika tidak ditemukan, coba cari dengan query langsung
                    try {
                        const db = billingManager.db;
                        customer = await new Promise((resolve, reject) => {
                            db.get(`
                                SELECT c.*, p.name as package_name, p.pppoe_profile as package_pppoe_profile
                                FROM customers c
                                LEFT JOIN packages p ON c.package_id = p.id
                                WHERE c.pppoe_username = ? OR c.username = ?
                                LIMIT 1
                            `, [username, username], (err, row) => {
                                if (err) reject(err);
                                else resolve(row);
                            });
                        });
                    } catch (dbError) {
                        logger.warn(`[RADIUS] Failed to query billing DB during suspend: ${dbError.message}`);
                    }
                }
                
                if (customer) {
                    // Hanya profil PPPoE dari billing — jangan pakai nama paket/slug (menghasilkan paket_* di RADIUS).
                    previousGroupToSave =
                        customer.pppoe_profile || customer.package_pppoe_profile || 'default';
                    logger.info(`[RADIUS] No group in radusergroup, using PPPoE profile from billing DB for ${username}: ${previousGroupToSave}`);
                } else {
                    previousGroupToSave = 'default';
                    logger.warn(`[RADIUS] No group found and customer not in billing DB, using 'default' for ${username}`);
                }
            } catch (billingError) {
                previousGroupToSave = 'default';
                logger.warn(`[RADIUS] Failed to get package from billing DB during suspend: ${billingError.message}, using 'default'`);
            }
        }

        if (previousGroupToSave && previousGroupToSave !== 'default') {
            const resolvedPrev = await resolvePppoeProfileHintToRadiusGroup(conn, previousGroupToSave);
            if (resolvedPrev) {
                previousGroupToSave = resolvedPrev;
            } else {
                logger.warn(
                    `[RADIUS] Tidak bisa resolve grup sebelum suspend untuk ${username} (hint=${previousGroupToSave}), simpan sebagai default`
                );
                previousGroupToSave = 'default';
            }
        }
        
        // HAPUS SEMUA group assignment untuk username ini (termasuk yang duplikat)
        await conn.execute(
            "DELETE FROM radusergroup WHERE username = ?",
            [username]
        );
        
        // Tambahkan group isolir
        await conn.execute(
            "INSERT INTO radusergroup (username, groupname, priority) VALUES (?, 'isolir', 1)",
            [username]
        );
        
        // Simpan group sebelumnya di radcheck dengan attribute khusus untuk restore nanti
        // Format: "PREVGROUP:groupname"
        if (previousGroupToSave) {
            // Hapus X-Previous-Group yang mungkin ada di radreply (jika ada)
            await conn.execute(
                "DELETE FROM radreply WHERE username = ? AND attribute = 'X-Previous-Group'",
                [username]
            );
            
            // Hapus PREVGROUP yang mungkin ada sebelumnya
            await conn.execute(
                "DELETE FROM radcheck WHERE username = ? AND attribute = 'NT-Password' AND value LIKE 'PREVGROUP:%'",
                [username]
            );
            
            // Simpan previous group di radcheck
            try {
                await conn.execute(
                    "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'NT-Password', ':=', ?)",
                    [username, `PREVGROUP:${previousGroupToSave}`]
                );
                logger.info(`[RADIUS] Saved previous group for ${username}: ${previousGroupToSave}`);
            } catch (e) {
                logger.error(`[RADIUS] Failed to save previous group for ${username}: ${e.message}`);
                // Jangan throw, karena suspend tetap harus berhasil
            }
        } else {
            logger.warn(`[RADIUS] No previous group to save for ${username}`);
        }
        
        await conn.end();
        await syncRadiusToFreeRadiusMysql({ force: true });
        const kick = await disconnectPPPoEUserAllRouters(username);
        if (kick.disconnected > 0) {
            logger.info(`[RADIUS] Kicked ${kick.disconnected} PPPoE session(s) for ${username} after isolir (routers: ${kick.routers.join(', ') || '-'})`);
        }
        return { success: true, message: 'User berhasil di-suspend (isolir)', disconnected: kick.disconnected };
    } catch (error) {
        await conn.end();
        logger.error(`Error suspending user in RADIUS: ${error.message}`);
        throw error;
    }
}

/**
 * Perbarui grup paket yang disimpan (PREVGROUP) untuk pelanggan yang masih di isolir.
 * Dipakai saat admin mengubah paket tanpa membuka isolir.
 */
async function updateIsolirPreviousGroupRadius(username, customer = null) {
    const conn = await getRadiusConnection();
    try {
        const [isolirRow] = await conn.execute(
            "SELECT groupname FROM radusergroup WHERE username = ? AND groupname = 'isolir' LIMIT 1",
            [username]
        );
        if (!isolirRow || isolirRow.length === 0) {
            await conn.end();
            return { success: false, skipped: true, message: 'User tidak sedang di grup isolir' };
        }

        let profileHint =
            customer?.pppoe_profile || customer?.package_pppoe_profile || null;
        if (!profileHint && customer?.package_id) {
            try {
                const billingManager = require('./billing');
                const pkg = await billingManager.getPackageById(customer.package_id);
                profileHint = pkg?.pppoe_profile || null;
            } catch (_) {}
        }
        if (!profileHint) {
            profileHint = 'default';
        }

        let groupToSave = profileHint;
        if (groupToSave && groupToSave !== 'default') {
            const resolved = await resolvePppoeProfileHintToRadiusGroup(conn, groupToSave);
            if (resolved) {
                groupToSave = resolved;
            } else {
                groupToSave = 'default';
            }
        }

        await conn.execute(
            "DELETE FROM radcheck WHERE username = ? AND attribute = 'NT-Password' AND value LIKE 'PREVGROUP:%'",
            [username]
        );
        await conn.execute(
            "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'NT-Password', ':=', ?)",
            [username, `PREVGROUP:${groupToSave}`]
        );

        await conn.end();
        logger.info(`[RADIUS] Updated PREVGROUP for suspended ${username} → ${groupToSave}`);
        return { success: true, previousGroup: groupToSave };
    } catch (error) {
        try {
            await conn.end();
        } catch (_) {}
        logger.error(`Error updating PREVGROUP for ${username}: ${error.message}`);
        throw error;
    }
}

// Fungsi untuk disable hotspot user di RADIUS
// Menggunakan kombinasi: hapus password dan tambahkan Auth-Type := Reject
async function disableHotspotUserRadius(username) {
    const conn = await getRadiusConnection();
    try {
        logger.info(`[RADIUS] Starting disable process for hotspot user: ${username}`);
        
        // Simpan password lama untuk restore nanti (simpan di radcheck dengan attribute khusus)
        const [passwordRows] = await conn.execute(
            "SELECT value FROM radcheck WHERE username = ? AND attribute = 'Cleartext-Password'",
            [username]
        );
        
        if (passwordRows && passwordRows.length > 0) {
            const oldPassword = passwordRows[0].value;
            // Simpan password lama dengan attribute khusus untuk restore nanti
            await conn.execute(
                "DELETE FROM radcheck WHERE username = ? AND attribute = 'X-Old-Password'",
                [username]
            );
            await conn.execute(
                "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'X-Old-Password', ':=', ?)",
                [username, oldPassword]
            );
            logger.info(`[RADIUS] Saved old password for ${username} (for restore later)`);
        }
        
        // Hapus password untuk disable user (tanpa password, user tidak bisa login)
        const [deletePasswordResult] = await conn.execute(
            "DELETE FROM radcheck WHERE username = ? AND attribute = 'Cleartext-Password'",
            [username]
        );
        logger.info(`[RADIUS] Deleted password for ${username} (${deletePasswordResult.affectedRows || 0} row(s) deleted)`);
        
        // Hapus Auth-Type yang mungkin sudah ada sebelumnya
        await conn.execute(
            "DELETE FROM radcheck WHERE username = ? AND attribute = 'Auth-Type'",
            [username]
        );
        
        // Tambahkan Auth-Type := Reject sebagai backup method
        const [insertResult] = await conn.execute(
            "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Auth-Type', ':=', 'Reject')",
            [username]
        );
        logger.info(`[RADIUS] Inserted Auth-Type := Reject for ${username}, insert ID: ${insertResult.insertId || 'N/A'}`);
        
        // Verifikasi bahwa password sudah dihapus dan Auth-Type sudah ditambahkan
        const [verifyResult] = await conn.execute(
            "SELECT username, attribute, op, value FROM radcheck WHERE username = ? AND (attribute = 'Auth-Type' OR attribute = 'Cleartext-Password')",
            [username]
        );
        
        const hasPassword = verifyResult && verifyResult.some(row => row.attribute === 'Cleartext-Password');
        const hasAuthTypeReject = verifyResult && verifyResult.some(row => row.attribute === 'Auth-Type' && row.value === 'Reject');
        
        if (!hasPassword && hasAuthTypeReject) {
            logger.info(`[RADIUS] ✅ Verified: User ${username} disabled successfully (password removed, Auth-Type := Reject added)`);
        } else {
            logger.warn(`[RADIUS] ⚠️ Verification: password exists=${hasPassword}, Auth-Type Reject exists=${hasAuthTypeReject}`);
        }
        
        await conn.end();
        logger.info(`[RADIUS] Hotspot user ${username} disabled (password removed + Auth-Type := Reject)`);
        return { success: true, message: 'Hotspot user disabled successfully' };
    } catch (error) {
        await conn.end();
        logger.error(`Error disabling hotspot user in RADIUS: ${error.message}`);
        logger.error(`Error stack: ${error.stack}`);
        throw error;
    }
}

// Fungsi untuk enable hotspot user di RADIUS (restore password dan hapus Auth-Type := Reject)
async function enableHotspotUserRadius(username) {
    const conn = await getRadiusConnection();
    try {
        logger.info(`[RADIUS] Starting enable process for hotspot user: ${username}`);
        
        // Restore password dari X-Old-Password jika ada
        const [oldPasswordRows] = await conn.execute(
            "SELECT value FROM radcheck WHERE username = ? AND attribute = 'X-Old-Password'",
            [username]
        );
        
        if (oldPasswordRows && oldPasswordRows.length > 0) {
            const oldPassword = oldPasswordRows[0].value;
            // Restore password
            await conn.execute(
                "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?) ON CONFLICT(username, attribute) DO UPDATE SET value = excluded.value",
                [username, oldPassword]
            );
            // Hapus X-Old-Password
            await conn.execute(
                "DELETE FROM radcheck WHERE username = ? AND attribute = 'X-Old-Password'",
                [username]
            );
            logger.info(`[RADIUS] Restored password for ${username}`);
        } else {
            // Jika tidak ada password tersimpan, coba ambil dari billing database
            try {
                const billingManager = require('./billing');
                const member = await billingManager.getMemberByHotspotUsername(username);
                if (member && member.hotspot_username) {
                    // Gunakan hotspot_username sebagai password default jika tidak ada password tersimpan
                    const defaultPassword = member.hotspot_username;
                    await conn.execute(
                        "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?) ON CONFLICT(username, attribute) DO UPDATE SET value = excluded.value",
                        [username, defaultPassword]
                    );
                    logger.info(`[RADIUS] Restored password from billing DB for ${username}`);
                } else {
                    logger.warn(`[RADIUS] No password found for ${username}, user may need password reset`);
                }
            } catch (billingError) {
                logger.warn(`[RADIUS] Failed to get password from billing DB: ${billingError.message}`);
            }
        }
        
        // Hapus Auth-Type := Reject
        await conn.execute(
            "DELETE FROM radcheck WHERE username = ? AND attribute = 'Auth-Type'",
            [username]
        );
        
        // Verifikasi bahwa password sudah ada dan Auth-Type sudah dihapus
        const [verifyResult] = await conn.execute(
            "SELECT username, attribute, op, value FROM radcheck WHERE username = ? AND (attribute = 'Auth-Type' OR attribute = 'Cleartext-Password')",
            [username]
        );
        
        const hasPassword = verifyResult && verifyResult.some(row => row.attribute === 'Cleartext-Password');
        const hasAuthTypeReject = verifyResult && verifyResult.some(row => row.attribute === 'Auth-Type' && row.value === 'Reject');
        
        if (hasPassword && !hasAuthTypeReject) {
            logger.info(`[RADIUS] ✅ Verified: User ${username} enabled successfully (password restored, Auth-Type Reject removed)`);
        } else {
            logger.warn(`[RADIUS] ⚠️ Verification: password exists=${hasPassword}, Auth-Type Reject exists=${hasAuthTypeReject}`);
        }
        
        await conn.end();
        logger.info(`[RADIUS] Hotspot user ${username} enabled (password restored + Auth-Type Reject removed)`);
        return { success: true, message: 'Hotspot user enabled successfully' };
    } catch (error) {
        await conn.end();
        logger.error(`Error enabling hotspot user in RADIUS: ${error.message}`);
        logger.error(`Error stack: ${error.stack}`);
        throw error;
    }
}

// Fungsi untuk unsuspend user (kembalikan ke package sebelumnya)
async function unsuspendUserRadius(username, customer = null) {
    const conn = await getRadiusConnection();
    try {
        let groupFromBilling = null;
        if (customer) {
            let profileHint = customer.pppoe_profile || customer.package_pppoe_profile || null;
            if (!profileHint && customer.package_id) {
                try {
                    const billingManager = require('./billing');
                    const pkg = await billingManager.getPackageById(customer.package_id);
                    profileHint = pkg?.pppoe_profile || null;
                } catch (_) {}
            }
            if (profileHint) {
                const resolvedBilling = await resolvePppoeProfileHintToRadiusGroup(conn, profileHint);
                if (resolvedBilling && resolvedBilling !== 'isolir') {
                    groupFromBilling = resolvedBilling;
                    logger.info(`[RADIUS] Restore ${username}: pakai profil billing ${groupFromBilling}`);
                }
            }
        }

        // Ambil group sebelumnya dari radcheck dengan format PREVGROUP:groupname
        const [prevGroup] = await conn.execute(
            "SELECT value FROM radcheck WHERE username = ? AND attribute = 'NT-Password' AND value LIKE 'PREVGROUP:%' LIMIT 1",
            [username]
        );
        
        await conn.execute(
            "DELETE FROM radusergroup WHERE username = ?",
            [username]
        );
        
        let previousGroup = groupFromBilling || null;
        
        if (!previousGroup && prevGroup && prevGroup.length > 0) {
            const prevGroupValue = prevGroup[0].value;
            if (prevGroupValue && prevGroupValue.startsWith('PREVGROUP:')) {
                previousGroup = prevGroupValue.substring('PREVGROUP:'.length);
            }
        }
        
        if (!previousGroup) {
            // Jika tidak ada group sebelumnya, coba ambil dari billing database
            // untuk mendapatkan package yang seharusnya digunakan
            try {
                const billingManager = require('./billing');
                // Cari customer berdasarkan pppoe_username atau username
                let customer = null;
                try {
                    customer = await billingManager.getCustomerByUsername(username);
                } catch (e) {
                    // Jika tidak ditemukan, coba cari dengan query langsung
                    try {
                        const db = billingManager.db;
                        customer = await new Promise((resolve, reject) => {
                            db.get(`
                                SELECT c.*, p.name as package_name, p.pppoe_profile as package_pppoe_profile
                                FROM customers c
                                LEFT JOIN packages p ON c.package_id = p.id
                                WHERE c.pppoe_username = ? OR c.username = ?
                                LIMIT 1
                            `, [username, username], (err, row) => {
                                if (err) reject(err);
                                else resolve(row);
                            });
                        });
                    } catch (dbError) {
                        logger.warn(`[RADIUS] Failed to query billing DB: ${dbError.message}`);
                    }
                }
                
                if (customer) {
                    previousGroup = customer.pppoe_profile || customer.package_pppoe_profile || null;

                    if (!previousGroup) {
                        previousGroup = 'default';
                        logger.warn(`[RADIUS] No PPPoE profile in billing DB for ${username}, using 'default'`);
                    } else {
                        logger.info(`[RADIUS] Using PPPoE profile from billing DB for ${username}: ${previousGroup}`);
                    }
                } else {
                    // Fallback ke default jika tidak ada data di billing
                    previousGroup = 'default';
                    logger.warn(`[RADIUS] Customer not found in billing DB for ${username}, using 'default'`);
                }
            } catch (billingError) {
                logger.warn(`[RADIUS] Failed to get package from billing DB for ${username}: ${billingError.message}`);
                previousGroup = 'default';
            }
        }

        let groupToAssign = previousGroup || 'default';
        if (groupToAssign && groupToAssign !== 'default') {
            const resolvedUn = await resolvePppoeProfileHintToRadiusGroup(conn, groupToAssign);
            if (resolvedUn) {
                groupToAssign = resolvedUn;
            } else {
                logger.warn(
                    `[RADIUS] Unsuspend: tidak bisa resolve grup "${groupToAssign}" untuk ${username}, fallback default`
                );
                groupToAssign = 'default';
            }
        }
        
        // Kembalikan ke group sebelumnya
        await conn.execute(
            "INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)",
            [username, groupToAssign]
        );
        
        // Hapus record previous group dari radcheck
        await conn.execute(
            "DELETE FROM radcheck WHERE username = ? AND attribute = 'NT-Password' AND value LIKE 'PREVGROUP:%'",
            [username]
        );

        // Pastikan tidak ada atribut isolir per-user yang menimpa grup paket
        await conn.execute(
            "DELETE FROM radreply WHERE username = ? AND attribute IN ('Framed-Pool', 'Framed-IP-Address') AND value LIKE '%isolir%'",
            [username]
        );
        
        await conn.end();
        await syncRadiusToFreeRadiusMysql({ force: true });

        const kick = await disconnectPPPoEUserAllRouters(username);
        if (kick.disconnected > 0) {
            logger.info(`[RADIUS] Kicked ${kick.disconnected} PPPoE session(s) for ${username} after restore (routers: ${kick.routers.join(', ') || '-'})`);
        } else {
            logger.info(`[RADIUS] No active PPPoE session to kick for ${username} after restore`);
        }

        return {
            success: true,
            message: `User di-un suspend ke package ${groupToAssign}`,
            previousGroup: groupToAssign,
            disconnected: kick.disconnected
        };
    } catch (error) {
        await conn.end();
        logger.error(`Error unsuspending user in RADIUS: ${error.message}`);
        throw error;
    }
}

// Fungsi untuk delete user PPPoE dari RADIUS
async function deletePPPoEUserRadius(username) {
    try {
        const { assertTenantOwnsPppoeUsername } = require('../utils/tenantPppoeOwnership');
        await assertTenantOwnsPppoeUsername(username);
    } catch (ownErr) {
        return { success: false, message: ownErr.message };
    }

    const conn = await getRadiusConnection();
    try {
        try {
            await disconnectPPPoEUser(username);
        } catch (disconnectErr) {
            logger.warn(`[RADIUS] Failed to disconnect PPPoE sessions for ${username}: ${disconnectErr.message}`);
        }

        const result = await conn.runInTransaction(async (db) => {
            await db.execute(
                "UPDATE radacct SET acctstoptime = datetime('now','localtime') WHERE username = ? AND (acctstoptime IS NULL OR acctstoptime = '' OR acctstoptime = '0' OR acctstoptime = '0000-00-00 00:00:00')",
                [username]
            );
            await db.execute('DELETE FROM radcheck WHERE username = ?', [username]);
            await db.execute('DELETE FROM radusergroup WHERE username = ?', [username]);
            await db.execute('DELETE FROM radreply WHERE username = ?', [username]);
            return { success: true, message: 'User berhasil dihapus dari RADIUS' };
        });
        if (result && result.success) await syncRadiusToFreeRadiusMysql();
        return result;
    } catch (error) {
        logger.error(`Error deleting PPPoE user from RADIUS: ${error.message}`);
        throw error;
    }
}

// Fungsi untuk edit user PPPoE di RADIUS (update password dan/atau package)
async function editPPPoEUserRadius({ oldUsername, username, password, profile = null }) {
    try {
        const { assertTenantOwnsPppoeUsername } = require('../utils/tenantPppoeOwnership');
        await assertTenantOwnsPppoeUsername(oldUsername || username);
    } catch (ownErr) {
        return { success: false, message: ownErr.message };
    }

    const conn = await getRadiusConnection();
    try {
        if (oldUsername && username && oldUsername !== username) {
            logger.info(`Renaming user from ${oldUsername} to ${username}`);

            let passwordToUse = password;
            let profileToUse = profile;
            if (!passwordToUse || !profileToUse) {
                const [legacyRows] = await conn.execute(
                    `SELECT
                        (SELECT value FROM radcheck WHERE username = ? AND attribute = 'Cleartext-Password' LIMIT 1) AS pwd,
                        (SELECT groupname FROM radusergroup WHERE username = ? LIMIT 1) AS grp`,
                    [oldUsername, oldUsername]
                );
                const legacy = legacyRows && legacyRows[0];
                if (!passwordToUse && legacy && legacy.pwd) passwordToUse = legacy.pwd;
                if (!profileToUse && legacy && legacy.grp) profileToUse = legacy.grp;
            }

            let resolvedGroup = null;
            if (profileToUse) {
                resolvedGroup = await resolveRadiusProfileGroupname(conn, profileToUse);
                if (!resolvedGroup) {
                    return {
                        success: false,
                        message: `Profil "${String(profileToUse).trim()}" tidak ditemukan di RADIUS (radgroupreply/radgroupcheck).`,
                        error: 'unknown_profile'
                    };
                }
            }

            return await conn.runInTransaction(async (db) => {
                if (passwordToUse) {
                    await db.execute(
                        "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?) ON CONFLICT(username, attribute) DO UPDATE SET value = excluded.value",
                        [username, passwordToUse]
                    );
                }
                if (resolvedGroup) {
                    await db.execute('DELETE FROM radusergroup WHERE username = ?', [username]);
                    await db.execute(
                        'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)',
                        [username, resolvedGroup]
                    );
                }
                await db.execute('DELETE FROM radcheck WHERE username = ?', [oldUsername]);
                await db.execute('DELETE FROM radusergroup WHERE username = ?', [oldUsername]);
                await db.execute('DELETE FROM radreply WHERE username = ?', [oldUsername]);
                _radiusProfileGroupCache.clear();
                return { success: true, message: `User berhasil di-rename dari ${oldUsername} ke ${username}` };
            }).then(async (r) => {
                if (r && r.success) {
                    await syncRadiusToFreeRadiusMysql({ force: true });
                    if (resolvedGroup) {
                        await disconnectPPPoEUserAllRouters(username);
                    }
                }
                return r;
            });
        }

        const usernameToUpdate = username || oldUsername;
        if (!usernameToUpdate) {
            return { success: false, message: 'Username tidak ditemukan' };
        }

        let resolvedProfile = null;
        if (profile) {
            resolvedProfile = await resolveRadiusProfileGroupname(conn, profile);
            if (!resolvedProfile) {
                return {
                    success: false,
                    message: `Profil "${String(profile).trim()}" tidak ditemukan di RADIUS (radgroupreply/radgroupcheck). Pilih profil dari daftar.`,
                    error: 'unknown_profile'
                };
            }
        }

        const needsWrite = Boolean(password) || Boolean(resolvedProfile);
        if (!needsWrite) {
            return { success: true, message: 'Tidak ada perubahan data user' };
        }

        return await conn.runInTransaction(async (db) => {
            if (password) {
                await db.execute(
                    "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?) ON CONFLICT(username, attribute) DO UPDATE SET value = excluded.value",
                    [usernameToUpdate, password]
                );
            }
            if (resolvedProfile) {
                await db.execute('DELETE FROM radusergroup WHERE username = ?', [usernameToUpdate]);
                await db.execute(
                    'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)',
                    [usernameToUpdate, resolvedProfile]
                );
            }
            _radiusProfileGroupCache.clear();
            return { success: true, message: 'User berhasil di-update di RADIUS' };
        }).then(async (r) => {
            if (r && r.success) {
                await syncRadiusToFreeRadiusMysql({ force: true });
                // Selalu kick agar sesi hidup re-auth ke grup baru (termasuk isolir) di RADIUS POP
                if (resolvedProfile) {
                    await disconnectPPPoEUserAllRouters(usernameToUpdate);
                }
            }
            return r;
        });
    } catch (error) {
        logger.error(`Error editing PPPoE user in RADIUS: ${error.message}`);
        const msg = String(error.message || '');
        if (error.code === 'SQLITE_BUSY' || /database is locked/i.test(msg)) {
            return {
                success: false,
                message:
                    'Database RADIUS sedang dipakai FreeRADIUS. Tunggu 2–3 detik lalu simpan lagi, atau kurangi beban auth di router.'
            };
        }
        throw error;
    }
}
function durationToSeconds(value, unit) {
    const numeric = parseInt(value, 10);
    if (isNaN(numeric) || numeric <= 0) {
        return null;
    }
    const normalizedUnit = typeof unit === 'string' ? unit.toLowerCase() : 's';
    switch (normalizedUnit) {
        case 'd':
            return numeric * 86400;
        case 'h':
            return numeric * 3600;
        case 'm':
            return numeric * 60;
        case 's':
        default:
            return numeric;
    }
}
function formatSecondsToDuration(secondsInput) {
    const seconds = parseInt(secondsInput, 10);
    if (isNaN(seconds) || seconds <= 0) {
        return null;
    }
    const units = [
        { unit: 'd', factor: 86400 },
        { unit: 'h', factor: 3600 },
        { unit: 'm', factor: 60 },
        { unit: 's', factor: 1 }
    ];
    for (const { unit, factor } of units) {
        if (seconds % factor === 0) {
            const value = seconds / factor;
            return {
                value,
                unit,
                string: `${value}${unit}`,
                seconds
            };
        }
    }
    return {
        value: seconds,
        unit: 's',
        string: `${seconds}s`,
        seconds
    };
}
// Fungsi untuk sync package limits ke Mikrotik PPPoE profile
async function syncPackageLimitsToMikrotik({ profile_name, upload_limit, download_limit, burst_limit_upload, burst_limit_download, burst_threshold, burst_time }, routerObj = null) {
    try {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }
        
        // Cari profile berdasarkan name
        const profiles = await conn.write('/ppp/profile/print', ['?name=' + profile_name]);
        if (!profiles || profiles.length === 0) {
            logger.warn(`Profile ${profile_name} tidak ditemukan di Mikrotik, skip sync limits`);
            if (routerObj && conn && typeof conn.close === 'function') {
                await conn.close();
            }
            return { success: false, message: `Profile ${profile_name} tidak ditemukan di Mikrotik` };
        }
        
        const profileId = profiles[0]['.id'];
        const rateLimit = buildMikrotikRateLimit({ upload_limit, download_limit, burst_limit_upload, burst_limit_download, burst_threshold, burst_time });
        
        const params = ['=.id=' + profileId];
        if (rateLimit) {
            params.push('=rate-limit=' + rateLimit);
        } else {
            // Hapus rate-limit jika tidak ada limit
            params.push('=rate-limit=');
        }
        
        await conn.write('/ppp/profile/set', params);
        
        if (routerObj && conn && typeof conn.close === 'function') {
            await conn.close();
        }
        
        return { success: true, message: `Package limits berhasil di-sync ke Mikrotik profile ${profile_name}` };
    } catch (error) {
        logger.error(`Error syncing package limits to Mikrotik: ${error.message}`);
        return { success: false, message: `Gagal sync limits ke Mikrotik: ${error.message}` };
    }
}

/**
 * Ensure PPPoE profile exists for a billing package (RADIUS group or MikroTik /ppp/profile).
 * Used when tenant selects a master package, binds NAS, or creates/updates a package.
 * Does not throw — failures return { success: false }.
 */
async function ensurePppoeProfileForPackage(pkg, options = {}) {
    try {
        if (!pkg || pkg.pppoe_profile == null || String(pkg.pppoe_profile).trim() === '') {
            return { success: true, skipped: true, message: 'Billing-only / no pppoe_profile' };
        }

        const profileName = String(pkg.pppoe_profile).trim();
        const authMode = await getUserAuthModeAsync();
        const limits = {
            upload_limit: pkg.upload_limit,
            download_limit: pkg.download_limit,
            burst_limit_upload: pkg.burst_limit_upload,
            burst_limit_download: pkg.burst_limit_download,
            burst_threshold: pkg.burst_threshold,
            burst_time: pkg.burst_time
        };

        if (authMode === 'radius') {
            const groupname = profileName.toLowerCase().replace(/\s+/g, '_');
            const syncResult = await syncPackageLimitsToRadius({
                groupname,
                ...limits
            });
            const syncedName = (syncResult && syncResult.groupname) || groupname;
            return {
                success: !!(syncResult && syncResult.success),
                mode: 'radius',
                profileName: syncedName,
                message: (syncResult && syncResult.message) || `Synced to RADIUS group ${syncedName}`
            };
        }

        let routerObj = options.routerObj || null;
        const routerId = pkg.router_id || options.router_id;
        if (!routerObj && routerId) {
            routerObj = await new Promise((resolve) => {
                const sqlite3 = require('sqlite3').verbose();
                const path = require('path');
                const dbPath = path.join(__dirname, '../data/billing.db');
                const db = new sqlite3.Database(dbPath);
                db.get('SELECT * FROM routers WHERE id = ?', [routerId], (err, row) => {
                    db.close();
                    if (err) {
                        logger.warn(`[ensurePppoeProfileForPackage] load router: ${err.message}`);
                        resolve(null);
                    } else {
                        resolve(row || null);
                    }
                });
            });
        }

        if (!routerObj) {
            return {
                success: true,
                skipped: true,
                mode: 'mikrotik',
                profileName,
                message: 'No router_id; deferred until NAS bind'
            };
        }

        const profilesResult = await getPPPoEProfiles(routerObj);
        const profileExists = profilesResult.success && profilesResult.data &&
            profilesResult.data.some(p => (p.name || p['name']) === profileName);

        if (profileExists) {
            const syncResult = await syncPackageLimitsToMikrotik({
                profile_name: profileName,
                ...limits
            }, routerObj);
            return {
                success: !!(syncResult && syncResult.success),
                mode: 'mikrotik',
                profileName,
                message: (syncResult && syncResult.message) || `Synced to Mikrotik profile ${profileName}`
            };
        }

        const rateLimit = buildMikrotikRateLimit(limits);
        const createResult = await addPPPoEProfile({
            name: profileName,
            'remote-address': options.remoteAddress || 'POOL-PPPOE-NEW',
            'rate-limit': rateLimit || undefined
        }, routerObj);

        return {
            success: !!(createResult && createResult.success),
            mode: 'mikrotik',
            profileName,
            message: (createResult && createResult.message) ||
                (createResult && createResult.success
                    ? `PPPoE profile created: ${profileName}`
                    : `Failed to create profile ${profileName}`)
        };
    } catch (error) {
        logger.warn(`[ensurePppoeProfileForPackage] ${error.message}`);
        return { success: false, message: error.message };
    }
}

// Async helper untuk get user_auth_mode dari database (prioritaskan database, fallback ke settings.json)
async function getUserAuthModeAsync() {
    try {
        const { getRadiusConfigValue } = require('./radiusConfig');
        const mode = await getRadiusConfigValue('user_auth_mode', null);
        if (mode !== null && mode !== undefined) return mode;
    } catch (e) {
        // Fallback ke settings.json jika database tidak bisa diakses
        logger.debug('Failed to get user_auth_mode from database, using settings.json fallback');
    }
    return getSetting('user_auth_mode', 'radius');
}

// Wrapper: Get active PPPoE connections (RADIUS atau Mikrotik API)
async function getActivePPPoEConnections() {
    const mode = await getUserAuthModeAsync();
    if (mode === 'radius') {
        return await getActivePPPoEConnectionsRadius();
    } else {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return [];
        }
        try {
            const active = await conn.write('/ppp/active/print');
            const activeNames = Array.isArray(active) ? active.map(s => s.name) : [];
            
            const secrets = await conn.write('/ppp/secret/print');
            return (Array.isArray(secrets) ? secrets : []).map(secret => ({
                name: secret.name,
                ip: secret.address || 'N/A',
                uptime: secret.uptime || '00:00:00',
                'bytes-in': secret['bytes-in'] || 0,
                'bytes-out': secret['bytes-out'] || 0
            })).filter(secret => activeNames.includes(secret.name));
        } catch (error) {
            logger.error(`Error getting active PPPoE connections: ${error.message}`);
            return [];
        } finally {
            if (conn && typeof conn.close === 'function') {
                conn.close();
            }
        }
    }
}

// Wrapper: Pilih mode autentikasi dari settings
async function getPPPoEUsers() {
    const mode = await getUserAuthModeAsync();
    if (mode === 'radius') {
        return await getPPPoEUsersRadius();
    } else {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return [];
        }
        // Ambil semua secret PPPoE
        const pppSecrets = await conn.write('/ppp/secret/print');
        // Ambil semua koneksi aktif
        const activeResult = await getActivePPPoEConnections();
        const activeNames = (activeResult && activeResult.success && Array.isArray(activeResult.data)) ? activeResult.data.map(c => c.name) : [];
        // Gabungkan data
        return pppSecrets.map(secret => ({
            id: secret['.id'],
            name: secret.name,
            password: secret.password,
            profile: secret.profile,
            active: activeNames.includes(secret.name)
        }));
    }
}

// Fungsi untuk edit user PPPoE (berdasarkan id untuk Mikrotik, atau username untuk RADIUS)
async function editPPPoEUser({ id, username, password, profile }) {
    const mode = await getUserAuthModeAsync();
    if (mode === 'radius') {
        // Mode RADIUS: id adalah username lama, username adalah username baru (atau sama jika tidak diubah)
        return await editPPPoEUserRadius({ oldUsername: id, username, password, profile });
    } else {
        // Mode Mikrotik: menggunakan id
        try {
            const conn = await getMikrotikConnection();
            if (!conn) throw new Error('Koneksi ke Mikrotik gagal');
            await conn.write('/ppp/secret/set', [
                '=.id=' + id,
                '=name=' + username,
                '=password=' + password,
                '=profile=' + profile
            ]);
            return { success: true };
        } catch (error) {
            logger.error(`Error editing PPPoE user: ${error.message}`);
            throw error;
        }
    }
}

// Fungsi untuk hapus user PPPoE (berdasarkan id untuk Mikrotik, atau username untuk RADIUS)
async function deletePPPoEUser(idOrUsername) {
    const mode = await getUserAuthModeAsync();
    if (mode === 'radius') {
        // Mode RADIUS: parameter adalah username
        return await deletePPPoEUserRadius(idOrUsername);
    } else {
        // Mode Mikrotik: parameter adalah id
        try {
            const conn = await getMikrotikConnection();
            if (!conn) throw new Error('Koneksi ke Mikrotik gagal');
            await conn.write('/ppp/secret/remove', [ '=.id=' + idOrUsername ]);
            return { success: true };
        } catch (error) {
            logger.error(`Error deleting PPPoE user: ${error.message}`);
            throw error;
        }
    }
}

// Fungsi untuk mendapatkan daftar koneksi PPPoE aktif
async function getActivePPPoEConnections() {
    try {
        // Check cache first
        const cacheKey = 'mikrotik:pppoe:active';
        const cachedData = cacheManager.get(cacheKey);
        
        if (cachedData) {
            logger.debug(`✅ Using cached active PPPoE connections (${cachedData.data.length} connections)`);
            return cachedData;
        }

        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: [] };
        }
        
        logger.debug('🔍 Fetching active PPPoE connections from Mikrotik API...');
        // Dapatkan daftar koneksi PPPoE aktif
        const pppConnections = await conn.write('/ppp/active/print');
        
        const result = {
            success: true,
            message: `Ditemukan ${pppConnections.length} koneksi PPPoE aktif`,
            data: pppConnections
        };
        
        // Cache the response for 1 minute (shorter TTL for real-time data)
        cacheManager.set(cacheKey, result, 1 * 60 * 1000);
        
        logger.debug(`✅ Found ${pppConnections.length} active PPPoE connections from API`);
        return result;
    } catch (error) {
        logger.error(`Error getting active PPPoE connections: ${error.message}`);
        return { success: false, message: `Gagal ambil data PPPoE: ${error.message}`, data: [] };
    }
}

// Fungsi untuk mendapatkan daftar user PPPoE offline
async function getOfflinePPPoEUsers() {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return [];
        }
        
        // Dapatkan semua secret PPPoE
        const pppSecrets = await conn.write('/ppp/secret/print');
        
        // Dapatkan koneksi aktif
        const activeConnections = await getActivePPPoEConnections();
        const activeUsers = activeConnections.map(conn => conn.name);
        
        // Filter user yang offline
        const offlineUsers = pppSecrets.filter(secret => !activeUsers.includes(secret.name));
        
        return offlineUsers;
    } catch (error) {
        logger.error(`Error getting offline PPPoE users: ${error.message}`);
        return [];
    }
}

// Fungsi untuk mendapatkan informasi user PPPoE yang tidak aktif (untuk whatsapp.js)
async function getInactivePPPoEUsers() {
    try {
        // Check cache first
        const cacheKey = 'mikrotik:pppoe:inactive';
        const cachedData = cacheManager.get(cacheKey);
        
        if (cachedData) {
            logger.debug(`✅ Using cached inactive PPPoE users (${cachedData.totalInactive} users)`);
            return cachedData;
        }

        logger.debug('🔍 Fetching inactive PPPoE users from Mikrotik API...');
        
        // Dapatkan semua secret PPPoE
        const pppSecrets = await getMikrotikConnection().then(conn => {
            if (!conn) return [];
            return conn.write('/ppp/secret/print');
        });
        
        // Dapatkan koneksi aktif
        let activeUsers = [];
        const activeConnectionsResult = await getActivePPPoEConnections();
        if (activeConnectionsResult && activeConnectionsResult.success && Array.isArray(activeConnectionsResult.data)) {
            activeUsers = activeConnectionsResult.data.map(conn => conn.name);
        }
        
        // Filter user yang offline
        const inactiveUsers = pppSecrets.filter(secret => !activeUsers.includes(secret.name));
        
        // Format hasil untuk whatsapp.js
        const result = {
            success: true,
            totalSecrets: pppSecrets.length,
            totalActive: activeUsers.length,
            totalInactive: inactiveUsers.length,
            data: inactiveUsers.map(user => ({
                name: user.name,
                comment: user.comment || '',
                profile: user.profile,
                lastLogout: user['last-logged-out'] || 'N/A'
            }))
        };
        
        // Cache the response for 1 minute (shorter TTL for real-time data)
        cacheManager.set(cacheKey, result, 1 * 60 * 1000);
        
        logger.debug(`✅ Found ${inactiveUsers.length} inactive PPPoE users from API`);
        return result;
    } catch (error) {
        logger.error(`Error getting inactive PPPoE users: ${error.message}`);
        return {
            success: false,
            message: error.message,
            totalSecrets: 0,
            totalActive: 0,
            totalInactive: 0,
            data: []
        };
    }
}

// Fungsi untuk mendapatkan resource router
async function getRouterResources(routerObj = null) {
    try {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return null;
        }

        // Dapatkan resource router
        const resources = await conn.write('/system/resource/print');

        if (!resources || !resources[0]) {
            logger.warn('No resource data returned from Mikrotik');
            return null;
        }

        const resourceData = resources[0];
        
        // Coba ambil temperature dari berbagai sumber
        let temperatureFound = null;
        let temperatureSource = null;
        
        // 1. Coba dari /system/health/print (prioritas tertinggi)
        try {
            const health = await conn.write('/system/health/print');
            if (health && health.length > 0) {
                const healthData = health[0];
                // Prioritaskan cpu-temperature jika ada (lebih akurat untuk monitoring)
                if (healthData['cpu-temperature'] !== undefined) {
                    const tempVal = safeNumber(healthData['cpu-temperature']);
                    if (tempVal > 0 && tempVal < 150) {
                        temperatureFound = tempVal;
                        temperatureSource = '/system/health (cpu-temperature)';
                    }
                } else if (healthData.temperature !== undefined) {
                    const tempVal = safeNumber(healthData.temperature);
                    if (tempVal > 0 && tempVal < 150) {
                        temperatureFound = tempVal;
                        temperatureSource = '/system/health (temperature)';
                    }
                }
            }
        } catch (e) {
            // /system/health/print tidak tersedia di semua router, ini normal
            logger.debug(`[TEMP] /system/health/print not available: ${e.message}`);
        }
        
        // 2. Coba dari /system/routerboard/print (beberapa router menyimpan temperature di sini)
        if (temperatureFound === null) {
            try {
                const rb = await conn.write('/system/routerboard/print');
                if (rb && rb.length > 0) {
                    const rbData = rb[0];
                    // Cek berbagai field temperature yang mungkin ada
                    const tempFields = ['temperature', 'cpu-temperature', 'board-temperature', 'thermal-temperature'];
                    for (const field of tempFields) {
                        if (rbData[field] !== undefined) {
                            const tempVal = safeNumber(rbData[field]);
                            if (tempVal > 0 && tempVal < 150) {
                                temperatureFound = tempVal;
                                temperatureSource = `/system/routerboard (${field})`;
                                break;
                            }
                        }
                    }
                }
            } catch (e) {
                logger.debug(`[TEMP] /system/routerboard/print error: ${e.message}`);
            }
        }
        
        // 3. Cek di resourceData untuk field temperature alternatif
        if (temperatureFound === null) {
            const tempFieldNames = [
                'temperature', 'cpu-temperature', 'board-temperature', 
                'thermal-temperature', 'sensor-temperature'
            ];
            for (const fieldName of tempFieldNames) {
                if (resourceData[fieldName] !== undefined && resourceData[fieldName] !== null) {
                    const tempVal = safeNumber(resourceData[fieldName]);
                    if (tempVal > 0 && tempVal < 150) {
                        temperatureFound = tempVal;
                        temperatureSource = `/system/resource (${fieldName})`;
                        break;
                    }
                }
            }
        }
        
        // Simpan temperature ke resourceData jika ditemukan
        if (temperatureFound !== null) {
            resourceData['temperature'] = temperatureFound;
            resourceData['cpu-temperature'] = temperatureFound;
            logger.info(`[TEMP] Temperature found: ${temperatureFound}°C (from ${temperatureSource})`);
        } else {
            // Tidak ada temperature sensor - ini normal untuk beberapa model router
            // Ubah dari warn ke debug untuk mengurangi log spam
            logger.debug('[TEMP] No temperature sensor available on this router (this is normal for some models)');
        }

        return resourceData;
    } catch (error) {
        logger.error(`Error getting router resources: ${error.message}`);
        return null;
    }
}

function safeNumber(val) {
    if (val === undefined || val === null) return 0;
    const n = Number(val);
    return isNaN(n) ? 0 : n;
}
// Format uptime dari Mikrotik (format: "1w2d3h4m5s" atau seconds)
function formatUptime(uptimeStr) {
    if (!uptimeStr || uptimeStr === 'N/A') return 'N/A';
    
    // Jika sudah berupa string formatted, return langsung
    if (typeof uptimeStr === 'string' && (uptimeStr.includes('w') || uptimeStr.includes('d') || uptimeStr.includes('h'))) {
        return uptimeStr;
    }
    
    // Jika berupa number (seconds), convert ke formatted string
    let seconds = 0;
    if (typeof uptimeStr === 'number') {
        seconds = uptimeStr;
    } else if (typeof uptimeStr === 'string') {
        // Parse format Mikrotik: "1w2d3h4m5s"
        const weeks = (uptimeStr.match(/(\d+)w/) || [0, 0])[1];
        const days = (uptimeStr.match(/(\d+)d/) || [0, 0])[1];
        const hours = (uptimeStr.match(/(\d+)h/) || [0, 0])[1];
        const minutes = (uptimeStr.match(/(\d+)m/) || [0, 0])[1];
        const secs = (uptimeStr.match(/(\d+)s/) || [0, 0])[1];
        seconds = parseInt(weeks || 0) * 604800 + 
                  parseInt(days || 0) * 86400 + 
                  parseInt(hours || 0) * 3600 + 
                  parseInt(minutes || 0) * 60 + 
                  parseInt(secs || 0);
        
        // Jika tidak ada format, coba parse sebagai angka
        if (seconds === 0) {
            seconds = parseInt(uptimeStr) || 0;
        }
    }
    
    if (seconds === 0) return 'N/A';
    
    const weeks = Math.floor(seconds / 604800);
    const days = Math.floor((seconds % 604800) / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    let result = [];
    if (weeks > 0) result.push(`${weeks}w`);
    if (days > 0) result.push(`${days}d`);
    if (hours > 0) result.push(`${hours}h`);
    if (minutes > 0) result.push(`${minutes}m`);
    if (secs > 0 || result.length === 0) result.push(`${secs}s`);
    
    return result.join('');
}

// Helper function untuk parsing memory dengan berbagai format
function parseMemoryValue(value) {
    if (!value) return 0;

    // Jika sudah berupa number, return langsung
    if (typeof value === 'number') return value;

    // Jika berupa string yang berisi angka
    if (typeof value === 'string') {
        // Coba parse sebagai integer dulu (untuk format bytes dari MikroTik)
        const intValue = parseInt(value);
        if (!isNaN(intValue)) return intValue;

        // Jika gagal, coba parse dengan unit
        const str = value.toString().toLowerCase();
        const numericPart = parseFloat(str.replace(/[^0-9.]/g, ''));
        if (isNaN(numericPart)) return 0;

        // Check for units
        if (str.includes('kib') || str.includes('kb')) {
            return numericPart * 1024;
        } else if (str.includes('mib') || str.includes('mb')) {
            return numericPart * 1024 * 1024;
        } else if (str.includes('gib') || str.includes('gb')) {
            return numericPart * 1024 * 1024 * 1024;
        } else {
            // Assume bytes if no unit
            return numericPart;
        }
    }

    return 0;
}

// Fungsi untuk mendapatkan informasi resource yang diformat
        // Fungsi untuk mendapatkan resource info per router
async function getResourceInfoForRouter(routerObj = null) {
    let routerboard = null; // Deklarasi di awal fungsi untuk akses global
    try {
        const resources = await getRouterResources(routerObj);
        if (!resources) {
            return { success: false, message: 'Resource router tidak ditemukan', data: null };
        }
        
        // Debug: Log semua field yang tersedia dari Mikrotik (hanya sekali per router)
        if (routerObj && routerObj.id) {
            logger.info(`[TEMP DEBUG] Router ${routerObj.name} (${routerObj.nas_ip}) - All resource fields:`, Object.keys(resources).sort());
            // Log semua nilai yang mungkin terkait temperature
            Object.keys(resources).forEach(key => {
                const val = resources[key];
                if (typeof val !== 'undefined' && val !== null && String(val).toLowerCase().includes('temp')) {
                    logger.info(`[TEMP DEBUG] Potential temp field: ${key} = ${val}`);
                }
            });
        }

        // Get connection untuk mengambil data tambahan (identity, routerboard, interfaces)
        // Buat koneksi sekali dan gunakan untuk semua operasi
        let conn = null;
        try {
            if (routerObj) {
                conn = await getMikrotikConnectionForRouter(routerObj);
            } else {
                conn = await getMikrotikConnection();
            }
        } catch (e) {
            logger.error(`Error getting connection for router ${routerObj ? routerObj.name : 'default'}: ${e.message}`);
        }
        
        // Jika tidak ada koneksi, return error
        if (!conn) {
            logger.error(`No connection available for router ${routerObj ? routerObj.name : 'default'}`);
            return { success: false, message: 'Tidak dapat membuat koneksi ke router', data: null };
        }
        
        // Get all interfaces traffic for total network in/out
        let totalRx = 0, totalTx = 0;
        let interfacesData = [];
        try {
            const interfaces = await conn.write('/interface/print');
            if (Array.isArray(interfaces)) {
                for (const iface of interfaces) {
                    if (iface.name && !iface.name.startsWith('<')) {
                        try {
                            // Get traffic rate (bits per second)
                            const monitor = await conn.write('/interface/monitor-traffic', [
                                `=interface=${iface.name}`,
                                '=once='
                            ]);
                            
                            if (monitor && monitor.length > 0) {
                                const m = monitor[0];
                                // rx-bits-per-second dan tx-bits-per-second sudah dalam bits per second
                                // Langsung convert ke Mbps (1 Mbps = 1,000,000 bits per second)
                                const rxBits = parseInt(m['rx-bits-per-second'] || 0);
                                const txBits = parseInt(m['tx-bits-per-second'] || 0);
                                // Konversi langsung dari bits/s ke Mbps
                                totalRx += rxBits; // Total dalam bits per second
                                totalTx += txBits; // Total dalam bits per second
                                
                                // Get cumulative bytes from interface
                                const rxByte = parseInt(iface['rx-byte'] || 0);
                                const txByte = parseInt(iface['tx-byte'] || 0);
                                
                                // Convert bits to bytes per second for interface data
                                const rxBytesPerSec = rxBits / 8;
                                const txBytesPerSec = txBits / 8;
                                
                                interfacesData.push({
                                    name: iface.name,
                                    rxBytesPerSec: rxBytesPerSec,
                                    txBytesPerSec: txBytesPerSec,
                                    rxBytesTotal: rxByte,
                                    txBytesTotal: txByte
                                });
                            }
                        } catch (e) {
                            // Skip interface yang error, tapi tetap ambil cumulative bytes jika ada
                            const rxByte = parseInt(iface['rx-byte'] || 0);
                            const txByte = parseInt(iface['tx-byte'] || 0);
                            if (rxByte > 0 || txByte > 0) {
                                interfacesData.push({
                                    name: iface.name,
                                    rxBytesPerSec: 0,
                                    txBytesPerSec: 0,
                                    rxBytesTotal: rxByte,
                                    txBytesTotal: txByte
                                });
                            }
                        }
                    }
                }
            }
        } catch (e) {
            logger.warn('Error getting interfaces traffic:', e.message);
        }

        // Parse memory berdasarkan field yang tersedia di debug
        const totalMem = parseMemoryValue(resources['total-memory']) || 0;
        const freeMem = parseMemoryValue(resources['free-memory']) || 0;
        const usedMem = totalMem > 0 && freeMem >= 0 ? totalMem - freeMem : 0;

        // Parse disk space berdasarkan field yang tersedia di debug
        const totalDisk = parseMemoryValue(resources['total-hdd-space']) || 0;
        const freeDisk = parseMemoryValue(resources['free-hdd-space']) || 0;
        const usedDisk = totalDisk > 0 && freeDisk >= 0 ? totalDisk - freeDisk : 0;

        // Parse CPU load (bisa dalam format percentage atau decimal)
        let cpuLoad = safeNumber(resources['cpu-load']);
        if (cpuLoad > 0 && cpuLoad <= 1) {
            cpuLoad = cpuLoad * 100; // Convert dari decimal ke percentage
        }

        // Parse temperature - ambil dari resourceData (sudah di-set dari health jika ada)
        let temperature = null;
        if (resources['temperature'] !== undefined && resources['temperature'] !== null) {
            const tempVal = safeNumber(resources['temperature']);
            if (tempVal > 0 && tempVal < 150) {
                temperature = tempVal;
            }
        } else if (resources['cpu-temperature'] !== undefined && resources['cpu-temperature'] !== null) {
            const tempVal = safeNumber(resources['cpu-temperature']);
            if (tempVal > 0 && tempVal < 150) {
                temperature = tempVal;
            }
        }
        
        // Ambil informasi tambahan: Identity, Routerboard, CPU, Version, Voltage
        let routerIdentity = null;
        let routerboardInfo = null;
        let voltage = null;
        
        if (conn) {
            try {
                // Ambil identity dari /system/identity/print
                const identityResult = await conn.write('/system/identity/print');
                if (identityResult && identityResult.length > 0 && identityResult[0].name) {
                    routerIdentity = identityResult[0].name;
                    logger.info(`[INFO] Router identity retrieved: ${routerIdentity} for router ${routerObj ? routerObj.name : 'default'}`);
                } else {
                    logger.warn(`[INFO] No identity found for router ${routerObj ? routerObj.name : 'default'}`);
                }
            } catch (e) {
                logger.error(`[INFO] /system/identity/print error for router ${routerObj ? routerObj.name : 'default'}: ${e.message}`);
            }
            
            // Ambil routerboard info
            try {
                const rb = await conn.write('/system/routerboard/print');
                if (rb && rb.length > 0) {
                    routerboardInfo = rb[0];
                    if (routerboardInfo['voltage'] !== undefined) {
                        voltage = safeNumber(routerboardInfo['voltage']);
                    }
                }
            } catch (e) {
                logger.debug(`[INFO] /system/routerboard/print error: ${e.message}`);
            }
        } else {
            logger.warn(`[INFO] No connection available for router ${routerObj ? routerObj.name : 'default'} to fetch identity and routerboard info`);
        }
        
        // Simpan informasi tambahan ke resources
        if (routerIdentity) {
            resources['identity'] = routerIdentity;
        }
        if (routerboardInfo) {
            if (routerboardInfo['board-name']) {
                resources['board-name'] = routerboardInfo['board-name'];
            }
            if (routerboardInfo['model']) {
                resources['model'] = routerboardInfo['model'];
            }
        }
        if (voltage !== null) {
            resources['voltage'] = voltage;
        }

        const data = {
            // System info
            routerId: routerObj ? routerObj.id : null,
            routerName: routerObj ? routerObj.name : 'Default Router',
            routerIp: routerObj ? routerObj.nas_ip : null,
            
            // CPU
            cpuLoad: Math.round(cpuLoad),
            cpuCount: safeNumber(resources['cpu-count']),
            cpuFrequency: safeNumber(resources['cpu-frequency']),
            
            // Memory
            memoryUsedMB: totalMem > 0 ? parseFloat((usedMem / 1024 / 1024).toFixed(2)) : 0,
            memoryFreeMB: totalMem > 0 ? parseFloat((freeMem / 1024 / 1024).toFixed(2)) : 0,
            totalMemoryMB: totalMem > 0 ? parseFloat((totalMem / 1024 / 1024).toFixed(2)) : 0,
            memoryUsedPercent: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
            
            // HDD
            diskUsedMB: totalDisk > 0 ? parseFloat((usedDisk / 1024 / 1024).toFixed(2)) : 0,
            diskFreeMB: totalDisk > 0 ? parseFloat((freeDisk / 1024 / 1024).toFixed(2)) : 0,
            totalDiskMB: totalDisk > 0 ? parseFloat((totalDisk / 1024 / 1024).toFixed(2)) : 0,
            diskUsedPercent: totalDisk > 0 ? Math.round((usedDisk / totalDisk) * 100) : 0,
            
            // Temperature
            temperature: temperature, // Sudah di-set dari /system/health atau resource
            
            // Network (aggregated from all interfaces)
            // totalRx dan totalTx sudah dalam bits per second, convert ke Mbps (divide by 1,000,000)
            totalNetworkInMbps: parseFloat((totalRx / 1000000).toFixed(2)),
            totalNetworkOutMbps: parseFloat((totalTx / 1000000).toFixed(2)),
            
            // Interfaces with Rx Bytes Total
            interfaces: interfacesData.sort((a, b) => b.rxBytesTotal - a.rxBytesTotal).slice(0, 10), // Top 10
            
            // Other info
            uptime: resources.uptime || 'N/A',
            uptimeFormatted: formatUptime(resources.uptime),
            version: resources.version || 'N/A',
            model: resources['model'] || resources['board-name'] || 'N/A',
            boardName: resources['board-name'] || 'N/A',
            platform: resources['platform'] || 'N/A',
            // Additional system info
            identity: resources['identity'] || routerIdentity || 'N/A', // Fallback ke routerIdentity jika belum di-set ke resources
            cpu: resources['cpu'] || resources['architecture-name'] || 'N/A',
            voltage: resources['voltage'] !== undefined && resources['voltage'] !== null ? safeNumber(resources['voltage']) : null
        };

        return {
            success: true,
            message: 'Berhasil mengambil info resource router',
            data
        };
    } catch (error) {
        logger.error(`Error getting resource info for router: ${error.message}`);
        return { success: false, message: `Gagal ambil resource router: ${error.message}`, data: null };
    }
}
async function getResourceInfo() {
    // Ambil traffic interface utama (default ether1)
    const interfaceName = getSetting('main_interface', 'ether1');
    let traffic = { rx: 0, tx: 0 };
    try {
        traffic = await getInterfaceTraffic(interfaceName);
    } catch (e) { traffic = { rx: 0, tx: 0 }; }

    try {
        const resources = await getRouterResources();
        if (!resources) {
            return { success: false, message: 'Resource router tidak ditemukan', data: null };
        }

        // Debug: Log raw resource data (bisa dinonaktifkan nanti)
        // logger.info('Raw MikroTik resource data:', JSON.stringify(resources, null, 2));

        // Parse memory berdasarkan field yang tersedia di debug
        // Berdasarkan debug: free-memory: 944705536, total-memory: 1073741824 (dalam bytes)
        const totalMem = parseMemoryValue(resources['total-memory']) || 0;
        const freeMem = parseMemoryValue(resources['free-memory']) || 0;
        const usedMem = totalMem > 0 && freeMem >= 0 ? totalMem - freeMem : 0;

        // Parse disk space berdasarkan field yang tersedia di debug
        // Berdasarkan debug: free-hdd-space: 438689792, total-hdd-space: 537133056 (dalam bytes)
        const totalDisk = parseMemoryValue(resources['total-hdd-space']) || 0;
        const freeDisk = parseMemoryValue(resources['free-hdd-space']) || 0;
        const usedDisk = totalDisk > 0 && freeDisk >= 0 ? totalDisk - freeDisk : 0;

        // Parse CPU load (bisa dalam format percentage atau decimal)
        let cpuLoad = safeNumber(resources['cpu-load']);
        if (cpuLoad > 0 && cpuLoad <= 1) {
            cpuLoad = cpuLoad * 100; // Convert dari decimal ke percentage
        }

        const data = {
            trafficRX: traffic && traffic.rx ? (traffic.rx / 1000000).toFixed(2) : '0.00',
            trafficTX: traffic && traffic.tx ? (traffic.tx / 1000000).toFixed(2) : '0.00',
            cpuLoad: Math.round(cpuLoad),
            cpuCount: safeNumber(resources['cpu-count']),
            cpuFrequency: safeNumber(resources['cpu-frequency']),
            architecture: resources['architecture-name'] || resources['cpu'] || 'N/A',
            model: resources['model'] || resources['board-name'] || 'N/A',
            serialNumber: resources['serial-number'] || 'N/A',
            firmware: resources['firmware-type'] || resources['version'] || 'N/A',
            voltage: resources['voltage'] || resources['board-voltage'] || 'N/A',
            temperature: resources['temperature'] || resources['board-temperature'] || 'N/A',
            badBlocks: resources['bad-blocks'] || 'N/A',
            // Konversi dari bytes ke MB dengan 2 decimal places
            memoryUsed: totalMem > 0 ? parseFloat((usedMem / 1024 / 1024).toFixed(2)) : 0,
            memoryFree: totalMem > 0 ? parseFloat((freeMem / 1024 / 1024).toFixed(2)) : 0,
            totalMemory: totalMem > 0 ? parseFloat((totalMem / 1024 / 1024).toFixed(2)) : 0,
            diskUsed: totalDisk > 0 ? parseFloat((usedDisk / 1024 / 1024).toFixed(2)) : 0,
            diskFree: totalDisk > 0 ? parseFloat((freeDisk / 1024 / 1024).toFixed(2)) : 0,
            totalDisk: totalDisk > 0 ? parseFloat((totalDisk / 1024 / 1024).toFixed(2)) : 0,
            uptime: resources.uptime || 'N/A',
            version: resources.version || 'N/A',
            boardName: resources['board-name'] || 'N/A',
            platform: resources['platform'] || 'N/A',
            // Debug info (bisa dihapus nanti)
            rawTotalMem: resources['total-memory'],
            rawFreeMem: resources['free-memory'],
            rawTotalDisk: resources['total-hdd-space'],
            rawFreeDisk: resources['free-hdd-space'],
            parsedTotalMem: totalMem,
            parsedFreeMem: freeMem,
            parsedTotalDisk: totalDisk,
            parsedFreeDisk: freeDisk
        };

        // Log parsed data for debugging (bisa dinonaktifkan nanti)
        // logger.info('Parsed memory data:', {
        //     totalMem: totalMem,
        //     freeMem: freeMem,
        //     usedMem: usedMem,
        //     totalMemMB: data.totalMemory,
        //     freeMemMB: data.memoryFree,
        //     usedMemMB: data.memoryUsed
        // });

        return {
            success: true,
            message: 'Berhasil mengambil info resource router',
            data
        };
    } catch (error) {
        logger.error(`Error getting formatted resource info: ${error.message}`);
        return { success: false, message: `Gagal ambil resource router: ${error.message}`, data: null };
    }
}

// Fungsi untuk mendapatkan daftar user hotspot aktif dari RADIUS (HANYA voucher hotspot, BUKAN PPPoE)
async function getActiveHotspotUsersRadius() {
    const conn = await getRadiusConnection();
    
    // Ambil daftar voucher usernames untuk filter
    const sqlite3 = require('sqlite3').verbose();
    const dbPath = require('path').join(__dirname, '../data/billing.db');
    const db = new sqlite3.Database(dbPath);
    
    const voucherUsernames = await new Promise((resolve, reject) => {
        db.all('SELECT DISTINCT username FROM voucher_revenue', [], (err, rows) => {
            if (err) {
                logger.warn(`Error getting voucher usernames for active hotspot: ${err.message}`);
                resolve([]);
            } else {
                resolve(rows.map(r => r.username));
            }
        });
    });
    db.close();
    
    // Jika tidak ada voucher, return empty
    if (voucherUsernames.length === 0) {
        await conn.end();
        return {
            success: true,
            message: 'Tidak ada voucher hotspot aktif',
            data: []
        };
    }
    
    // Ambil user yang sedang online dari radacct (acctstoptime IS NULL) HANYA untuk voucher
    // Filter: hanya session yang masih aktif (acctstoptime IS NULL) dan tidak terlalu lama (max 24 jam)
    // Ini untuk menghindari session yang "terjebak" karena acctstoptime tidak ter-update
    // Untuk hotspot, session yang lebih dari 24 jam tanpa acctstoptime dianggap tidak valid
    const placeholders = voucherUsernames.map(() => '?').join(',');
    const [rows] = await conn.execute(`
        SELECT DISTINCT username 
        FROM radacct 
        WHERE acctstoptime IS NULL 
        AND username IN (${placeholders})
        AND acctstarttime IS NOT NULL
        AND acctstarttime >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
    `, voucherUsernames);
    
    await conn.end();
    return {
        success: true,
        message: `Ditemukan ${rows.length} user hotspot aktif (RADIUS)` ,
        data: rows.map(row => ({ name: row.username, user: row.username }))
    };
}

// Fungsi untuk mendapatkan semua member dengan status online/offline dari RADIUS
async function getMembersWithStatusRadius() {
    const conn = await getRadiusConnection();
    try {
        logger.info('Fetching members with online/offline status from RADIUS database...');
        
        // Ambil semua member dari billing database
        const billingManager = require('./billing');
        const members = await billingManager.getAllMembers();
        
        logger.info(`Found ${members.length} members in billing database`);
        
        // Ambil daftar voucher usernames untuk exclude (karena kita hanya mau member, bukan voucher)
        const sqlite3 = require('sqlite3').verbose();
        const dbPath = require('path').join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        const voucherUsernames = await new Promise((resolve, reject) => {
            db.all('SELECT DISTINCT username FROM voucher_revenue', [], (err, rows) => {
                if (err) {
                    logger.warn(`Error getting voucher usernames: ${err.message}`);
                    resolve([]);
                } else {
                    resolve(rows.map(r => r.username));
                }
            });
        });
        db.close();
        
        // Ambil active connections dari radacct (acctstoptime IS NULL)
        // Exclude voucher usernames
        let activeQuery = `
            SELECT DISTINCT username
            FROM radacct
            WHERE acctstoptime IS NULL
        `;
        const activeParams = [];
        if (voucherUsernames.length > 0) {
            const placeholders = voucherUsernames.map(() => '?').join(',');
            activeQuery += ` AND username NOT IN (${placeholders})`;
            activeParams.push(...voucherUsernames);
        }
        
        const [activeRows] = await conn.execute(activeQuery, activeParams);
        const activeUsernames = new Set(activeRows.map(row => row.username));
        
        logger.info(`Found ${activeUsernames.size} active member connections in RADIUS`);
        
        // Map members dengan status online/offline
        const membersWithStatus = members.map(member => {
            const hotspotUsername = member.hotspot_username || member.username;
            const isActive = hotspotUsername ? activeUsernames.has(hotspotUsername) : false;
            
            return {
                id: member.id,
                name: member.name,
                username: member.username,
                hotspot_username: hotspotUsername,
                phone: member.phone,
                email: member.email,
                address: member.address,
                package_id: member.package_id,
                package_name: member.package_name || 'N/A',
                package_speed: member.package_speed || 'N/A',
                hotspot_profile: member.hotspot_profile || 'default',
                status: member.status,
                active: isActive,
                nas_name: 'RADIUS',
                nas_ip: 'RADIUS Server'
            };
        });
        
        await conn.end();
        
        logger.info(`Mapped ${membersWithStatus.length} members with status (${Array.from(activeUsernames).length} active)`);
        return membersWithStatus;
    } catch (error) {
        await conn.end();
        logger.error(`Error getting members with status from RADIUS: ${error.message}`);
        logger.error(`Error stack: ${error.stack}`);
        return [];
    }
}

// Fungsi untuk mengambil semua hotspot users dari RADIUS (HANYA voucher hotspot, BUKAN PPPoE users)
async function getHotspotUsersRadius() {
    const conn = await getRadiusConnection();
    try {
        logger.info('Fetching hotspot voucher users from RADIUS database (excluding PPPoE users)...');
        const sqlite3 = require('sqlite3').verbose();
        const dbPath = require('path').join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);

        await ensureVoucherRevenueColumns();
        const voucherMetadataRows = await new Promise((resolve, reject) => {
            db.all(`
                SELECT username,
                       MAX(created_at) as created_at,
                       MAX(price) as price,
                       MAX(status) as status,
                       MAX(server_name) as server_name,
                       MAX(server_metadata) as server_metadata
                FROM voucher_revenue
                GROUP BY username
            `, [], (err, rows) => {
                if (err) {
                    logger.warn(`Error getting voucher metadata for hotspot: ${err.message}`);
                    resolve([]);
                } else {
                    resolve(rows || []);
                }
            });
        });

        let voucherUsernames = [];
        const voucherMetadata = {};

        if (voucherMetadataRows.length > 0) {
            voucherUsernames = voucherMetadataRows.map(row => row.username);
            voucherMetadataRows.forEach(row => {
                if (row.username) {
                    let parsedMetadata = null;
                    if (row.server_metadata) {
                        try {
                            parsedMetadata = JSON.parse(row.server_metadata);
                        } catch (parseErr) {
                            logger.warn(`Failed to parse server_metadata for ${row.username}: ${parseErr.message}`);
                        }
                    }
                    const serverName = row.server_name || (parsedMetadata && parsedMetadata.name) || null;
                    if (parsedMetadata && !parsedMetadata.name && serverName) {
                        parsedMetadata.name = serverName;
                    }
                    voucherMetadata[row.username] = {
                        created_at: row.created_at || null,
                        price: row.price,
                        status: row.status,
                        server_name: serverName,
                        server_metadata: parsedMetadata || (serverName ? { name: serverName } : null)
                    };
                }
            });
        } else {
            voucherUsernames = await new Promise((resolve, reject) => {
                db.all('SELECT DISTINCT username FROM voucher_revenue', [], (err, rows) => {
                    if (err) {
                        logger.warn(`Error getting voucher usernames for hotspot: ${err.message}`);
                        resolve([]);
                    } else {
                        resolve(rows.map(r => r.username));
                    }
                });
            });
        }
        db.close();

        logger.info(`Found ${voucherUsernames.length} voucher usernames to include`);

        if (voucherUsernames.length === 0) {
            await conn.end();
            logger.info('No voucher users found in voucher_revenue table');
            return {
                success: true,
                data: []
            };
        }

        const placeholders = voucherUsernames.map(() => '?').join(',');
        const [userRows] = await conn.execute(`
            SELECT DISTINCT c.username,
                   c.value as password,
                   (SELECT groupname FROM radusergroup WHERE username = c.username LIMIT 1) as profile,
                   (SELECT value FROM radreply WHERE username = c.username AND attribute = 'Reply-Message' LIMIT 1) as comment
            FROM radcheck c
            WHERE c.attribute = 'Cleartext-Password'
              AND c.username IN (${placeholders})
            ORDER BY c.username
        `, voucherUsernames);

        logger.info(`Found ${userRows.length} hotspot voucher users in radcheck table`);

        const [limitRows] = await conn.execute(`
            SELECT username, attribute, value
            FROM radcheck
            WHERE username IN (${placeholders})
              AND attribute IN ('Max-All-Session', 'Expire-After')
        `, voucherUsernames);

        // Ambil Called-Station-Id untuk server hotspot binding
        const [serverRows] = await conn.execute(`
            SELECT username, value
            FROM radcheck
            WHERE username IN (${placeholders})
              AND attribute = 'Called-Station-Id'
        `, voucherUsernames);

        const [sessionRows] = await conn.execute(`
            SELECT username, value
            FROM radreply
            WHERE username IN (${placeholders})
              AND attribute = 'Session-Timeout'
        `, voucherUsernames);

        const [acctRows] = await conn.execute(`
            SELECT username,
                   SUM(IFNULL(acctsessiontime,0)) AS total_session,
                   MIN(acctstarttime) AS first_login,
                   MAX(acctstarttime) AS last_login,
                   MAX(acctstoptime) AS last_logout,
                   MIN(acctstarttime) AS start_time,
                   SUM(IFNULL(acctinputoctets,0)) AS total_input_octets,
                   SUM(IFNULL(acctoutputoctets,0)) AS total_output_octets,
                   MAX(CASE 
                       WHEN (acctstoptime IS NULL OR acctstoptime = '' OR acctstoptime = '0000-00-00 00:00:00')
                       AND acctstarttime IS NOT NULL
                       AND acctstarttime >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
                       THEN framedipaddress 
                       ELSE NULL 
                   END) AS active_ip,
                   MAX(framedipaddress) AS last_ip,
                   MAX(nasipaddress) AS router_ip,
                   MAX(calledstationid) AS server_identifier
            FROM radacct
            WHERE username IN (${placeholders})
            GROUP BY username
        `, voucherUsernames);

        await conn.end();

        const limitMap = {};
        limitRows.forEach(row => {
            if (!limitMap[row.username]) {
                limitMap[row.username] = {};
            }
            if (row.attribute === 'Max-All-Session') {
                const parsed = parseInt(row.value, 10);
                limitMap[row.username].maxAllSession = !isNaN(parsed) && parsed > 0 ? parsed : null;
            } else if (row.attribute === 'Expire-After') {
                const parsed = parseInt(row.value, 10);
                limitMap[row.username].expireAfter = !isNaN(parsed) && parsed > 0 ? parsed : null;
            }
        });

        // Map server hotspot dari Called-Station-Id
        const serverMap = {};
        serverRows.forEach(row => {
            serverMap[row.username] = row.value || null;
        });

        const sessionTimeoutMap = {};
        sessionRows.forEach(row => {
            const parsed = parseInt(row.value, 10);
            sessionTimeoutMap[row.username] = !isNaN(parsed) && parsed > 0 ? parsed : null;
        });

        const acctMap = {};
        acctRows.forEach(row => {
            const totalInputOctets = row.total_input_octets ? parseFloat(row.total_input_octets) : 0;
            const totalOutputOctets = row.total_output_octets ? parseFloat(row.total_output_octets) : 0;
            const octetToMb = (value) => value > 0 ? value / (1024 * 1024) : 0;
            acctMap[row.username] = {
                totalSession: row.total_session ? parseInt(row.total_session, 10) || 0 : 0,
                first_login: row.first_login || null,
                last_login: row.last_login || null,
                last_logout: row.last_logout || null,
                start_time: row.start_time || row.last_login || null,
                total_upload_mb: octetToMb(totalInputOctets),
                total_download_mb: octetToMb(totalOutputOctets),
                active_ip: row.active_ip || null,
                last_ip: row.last_ip || null,
                router_ip: row.router_ip || null,
                server_identifier: row.server_identifier || null
            };
        });

        return {
            success: true,
            data: userRows.map(row => {
                const meta = voucherMetadata[row.username] || {};
                const limits = limitMap[row.username] || {};
                const acct = acctMap[row.username] || {};
                const serverMetadata = meta.server_metadata || null;
                const serverNameFromMeta = meta.server_name || (serverMetadata && serverMetadata.name) || null;
                // Ambil server hotspot dari Called-Station-Id (prioritas) atau dari metadata
                const serverHotspotFromRadius = serverMap[row.username] || null;
                const serverHotspot = serverHotspotFromRadius || serverNameFromMeta || null;
                return {
                    name: row.username,
                    password: row.password || '',
                    profile: row.profile || 'default',
                    comment: row.comment || '',
                    created_at: meta.created_at || null,
                    price: meta.price || null,
                    status: meta.status || null,
                    nas_name: 'RADIUS',
                    nas_ip: 'RADIUS',
                    limit_seconds: limits.maxAllSession || null,
                    validity_seconds: limits.expireAfter || null,
                    session_timeout_seconds: sessionTimeoutMap[row.username] || null,
                    total_session_seconds: acct.totalSession || 0,
                    first_login: acct.first_login || null,
                    last_login: acct.last_login || null,
                    last_logout: acct.last_logout || null,
                    start_time: acct.start_time || null,
                    last_update: acct.last_update || null,
                    total_upload_mb: acct.total_upload_mb || 0,
                    total_download_mb: acct.total_download_mb || 0,
                    ip_address: acct.active_ip || acct.last_ip || null,
                    router_ip: acct.router_ip || null,
                    server_identifier: acct.server_identifier || serverHotspot || null,
                    server_metadata: serverMetadata,
                    server_name: serverNameFromMeta,
                    server_hotspot: serverHotspot  // Server hotspot dari Called-Station-Id
                };
            })
        };
    } catch (error) {
        await conn.end();
        logger.error(`Error getting hotspot users from RADIUS: ${error.message}`);
        return { success: false, message: error.message, data: [] };
    }
}
// Fungsi untuk menambah user hotspot ke RADIUS
async function addHotspotUserRadius(username, password, profile, comment = null, server = null, serverMetadata = null, limits = null) {
    const conn = await getRadiusConnection();
    try {
        const limitOptions = limits && typeof limits === 'object' ? limits : {};
        const uptimeSeconds = limitOptions.uptimeSeconds && !isNaN(parseInt(limitOptions.uptimeSeconds, 10)) && parseInt(limitOptions.uptimeSeconds, 10) > 0
            ? parseInt(limitOptions.uptimeSeconds, 10)
            : null;
        const validitySeconds = limitOptions.validitySeconds && !isNaN(parseInt(limitOptions.validitySeconds, 10)) && parseInt(limitOptions.validitySeconds, 10) > 0
            ? parseInt(limitOptions.validitySeconds, 10)
            : null;

        // Insert password ke radcheck
        await conn.execute(
            "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?) ON CONFLICT(username, attribute) DO UPDATE SET value = excluded.value",
            [username, password]
        );
        
        // Cek apakah profile exist di radgroupreply dengan case-sensitive
        // Jika tidak ada, coba dengan normalized version
        let profileToUse = profile || 'default';
        const [profileCheck] = await conn.execute(
            "SELECT DISTINCT groupname FROM radgroupreply WHERE groupname = ? LIMIT 1",
            [profileToUse]
        );
        
        // Jika profile tidak ditemukan dengan case-sensitive, coba normalized
        if (profileCheck.length === 0 && profile) {
            const normalizedProfile = profile.toLowerCase().replace(/\s+/g, '_');
            const [normalizedCheck] = await conn.execute(
                "SELECT DISTINCT groupname FROM radgroupreply WHERE groupname = ? LIMIT 1",
                [normalizedProfile]
            );
            
            if (normalizedCheck.length > 0) {
                profileToUse = normalizedProfile;
            } else {
                // Jika masih tidak ada, gunakan profile asli (case-sensitive)
                profileToUse = profile;
            }
        }
        
        // Assign user ke group (profile) di radusergroup
        // HAPUS SEMUA groupname untuk username ini terlebih dahulu untuk menghindari duplikasi
        await conn.execute(
            "DELETE FROM radusergroup WHERE username = ?",
            [username]
        );
        
        // PENTING: Pastikan rate limit dari hotspot profile metadata sudah di-sync ke radgroupreply
        // Cek apakah rate limit sudah ada di radgroupreply untuk groupname ini
        const [existingRateLimit] = await conn.execute(
            "SELECT value FROM radgroupreply WHERE groupname = ? AND attribute IN ('MikroTik-Rate-Limit', 'Mikrotik-Rate-Limit') LIMIT 1",
            [profileToUse]
        );
        
        // Jika rate limit belum ada, coba ambil dari hotspot_profiles metadata dan sync ke radgroupreply
        if (existingRateLimit.length === 0) {
            try {
                const metadata = await getHotspotProfileMetadata(conn, profileToUse);
                if (metadata && metadata.rate_limit_value && metadata.rate_limit_unit) {
                    // Build rate limit string dari metadata
                    const rateValue = metadata.rate_limit_value;
                    const rateUnit = (metadata.rate_limit_unit || 'M').toUpperCase();
                    const rateLimitStr = `${rateValue}${rateUnit}/${rateValue}${rateUnit}`;
                    
                    // Sync rate limit ke radgroupreply
                    await conn.execute(
                        "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'MikroTik-Rate-Limit', ':=', ?) ON CONFLICT(groupname, attribute) DO UPDATE SET value = excluded.value",
                        [profileToUse, rateLimitStr]
                    );
                    
                    logger.info(`✅ Synced rate limit from metadata to radgroupreply for profile ${profileToUse}: ${rateLimitStr}`);
                } else {
                    logger.warn(`⚠️ Profile ${profileToUse} has no rate limit in metadata, rate limit will not be applied`);
                }
            } catch (metadataError) {
                logger.warn(`Failed to sync rate limit from metadata for profile ${profileToUse}: ${metadataError.message}`);
            }
        }

        // Pastikan radgroupreply juga membawa Mikrotik-Group agar Mikrotik menggunakan hotspot profile yang benar.
        // Gunakan nama profile asli dari Mikrotik (parameter "profile") jika tersedia,
        // fallback ke profileToUse jika tidak ada.
        const mikrotikProfileName = profile || profileToUse;
        if (mikrotikProfileName) {
            await conn.execute(
                "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Mikrotik-Group', ':=', ?) ON CONFLICT(groupname, attribute) DO UPDATE SET value = excluded.value",
                [profileToUse, mikrotikProfileName]
            );
            logger.info(`✅ Ensured Mikrotik-Group=${mikrotikProfileName} for RADIUS profile/group ${profileToUse}`);
        }
        
        // Insert groupname yang baru
        await conn.execute(
            "INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)",
            [username, profileToUse]
        );
        
        // Add comment to radreply table if provided
        if (comment) {
            await conn.execute(
                "INSERT INTO radreply (username, attribute, op, value) VALUES (?, 'Reply-Message', ':=', ?) ON CONFLICT(username, attribute) DO UPDATE SET value = excluded.value",
                [username, comment]
            );
        }
        
        // Binding ke server hotspot tertentu (jika dipilih)
        const serverMeta = serverMetadata && typeof serverMetadata === 'object' ? { ...serverMetadata } : {};
        let sanitizedServer = '';
        if (serverMeta.name) {
            sanitizedServer = String(serverMeta.name).trim();
        } else if (typeof server === 'string') {
            sanitizedServer = server.trim();
        }

        const nasIdentifier = serverMeta.nasIdentifier || serverMeta.nas_identifier || null;
        const nasIp = serverMeta.nasIp || serverMeta.nas_ip || null;
        const routerName = serverMeta.nasName || serverMeta.nas_name || null;
        const nasPortId = serverMeta.interface || serverMeta.nasPortId || serverMeta['nas-port-id'] || null;

        const isGlobalServer = !sanitizedServer || ['all', 'semua', ''].includes(sanitizedServer.toLowerCase());

        // Bersihkan binding lama di radcheck (kondisi) dan radreply (reply)
        await conn.execute(
            "DELETE FROM radcheck WHERE username = ? AND attribute IN ('NAS-Identifier', 'NAS-IP-Address', 'Mikrotik-Host', 'NAS-Port-Id', 'Called-Station-Id', 'Max-All-Session', 'Expire-After')",
            [username]
        );
        await conn.execute(
            "DELETE FROM radreply WHERE username = ? AND attribute IN ('Mikrotik-Server', 'Session-Timeout')",
            [username]
        );

        if (!isGlobalServer) {
            if (nasPortId) {
                await conn.execute(
                    "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'NAS-Port-Id', '==', ?) ON CONFLICT(username, attribute) DO UPDATE SET value = excluded.value",
                    [username, nasPortId]
                );
            }

            await conn.execute(
                "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Called-Station-Id', '==', ?) ON CONFLICT(username, attribute) DO UPDATE SET value = excluded.value",
                [username, sanitizedServer]
            );

            await conn.execute(
                "INSERT INTO radreply (username, attribute, op, value) VALUES (?, 'Mikrotik-Server', ':=', ?) ON CONFLICT(username, attribute) DO UPDATE SET value = excluded.value",
                [username, sanitizedServer]
            );

            logger.info(`Voucher ${username} bound to server ${sanitizedServer} (NAS-Identifier=${nasIdentifier || 'n/a'}, NAS-IP=${nasIp || 'n/a'}, Router=${routerName || 'n/a'}, NAS-Port-Id=${nasPortId || 'n/a'})`);
        } else {
            logger.info(`Voucher ${username} created without specific Mikrotik server binding (server parameter: ${sanitizedServer || 'all'})`);
        }

        if (uptimeSeconds) {
            await conn.execute(
                "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Max-All-Session', ':=', ?) ON CONFLICT(username, attribute) DO UPDATE SET value = excluded.value",
                [username, uptimeSeconds.toString()]
            );
            logger.info(`Voucher ${username} uptime limit set to ${uptimeSeconds} seconds`);

            await conn.execute(
                "INSERT INTO radreply (username, attribute, op, value) VALUES (?, 'Session-Timeout', ':=', ?) ON CONFLICT(username, attribute) DO UPDATE SET value = excluded.value",
                [username, uptimeSeconds.toString()]
            );
            logger.info(`Voucher ${username} session timeout set to ${uptimeSeconds} seconds`);
        } else {
            await conn.execute(
                "DELETE FROM radreply WHERE username = ? AND attribute = 'Session-Timeout'",
                [username]
            );
        }

        if (validitySeconds) {
            await conn.execute(
                "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Expire-After', ':=', ?) ON CONFLICT(username, attribute) DO UPDATE SET value = excluded.value",
                [username, validitySeconds.toString()]
            );
            logger.info(`Voucher ${username} validity set to ${validitySeconds} seconds`);
        }

        logger.info(`Voucher ${username} created in RADIUS mode ${!isGlobalServer ? `with Mikrotik-Server=${sanitizedServer}` : 'without specific Mikrotik-Server'} (original server parameter: ${server || 'all'})${uptimeSeconds ? `, uptime limit=${uptimeSeconds}s` : ''}${validitySeconds ? `, validity=${validitySeconds}s` : ''}`);
        
        await conn.end();
        return { success: true, message: 'User hotspot berhasil ditambahkan ke RADIUS' };
    } catch (error) {
        await conn.end();
        logger.error(`Error adding hotspot user to RADIUS: ${error.message}`);
        throw error;
    }
}

// Wrapper: Pilih mode autentikasi dari settings
async function getActiveHotspotUsers(routerObj = null) {
    const mode = await getUserAuthModeAsync();
    if (mode === 'radius') {
        return await getActiveHotspotUsersRadius();
    } else {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: [] };
        }
        // Dapatkan daftar user hotspot aktif
        const hotspotUsers = await conn.write('/ip/hotspot/active/print');
        logger.info(`Found ${hotspotUsers.length} active hotspot users`);
        
        return {
            success: true,
            message: `Ditemukan ${hotspotUsers.length} user hotspot aktif`,
            data: hotspotUsers
        };
    }
}
// Fungsi untuk menambahkan user hotspot
async function addHotspotUser(username, password, profile, comment = null, customer = null, routerObj = null, price = null, server = null, serverMetadata = null, limits = null) {
    let conn = null;
    const mode = await getUserAuthModeAsync();
    const limitOptions = limits && typeof limits === 'object' ? limits : {};
    const uptimeSeconds = limitOptions.uptimeSeconds && !isNaN(parseInt(limitOptions.uptimeSeconds, 10)) && parseInt(limitOptions.uptimeSeconds, 10) > 0
        ? parseInt(limitOptions.uptimeSeconds, 10)
        : null;
    const validitySeconds = limitOptions.validitySeconds && !isNaN(parseInt(limitOptions.validitySeconds, 10)) && parseInt(limitOptions.validitySeconds, 10) > 0
        ? parseInt(limitOptions.validitySeconds, 10)
        : null;
    if (mode === 'radius') {
        let result = { success: false, message: 'Unknown error' };
        try {
            let serverInfo = serverMetadata;
            if (!serverInfo || typeof serverInfo !== 'object') {
                serverInfo = {};
            }
            if (server && typeof server === 'string') {
                server = server.trim();
                if (!serverInfo.name) serverInfo.name = server;
            }
            result = await addHotspotUserRadius(username, password, profile, comment, server, serverInfo, limits);
        } catch (radiusError) {
            logger.error(`Error in addHotspotUserRadius for ${username}: ${radiusError.message}`);
            // Tetap lanjutkan untuk membuat invoice, karena mungkin user sudah dibuat sebagian
            result = { success: false, message: radiusError.message };
        }
        
        // Simpan data voucher untuk laporan keuangan (TANPA membuat invoice)
        // Invoice hanya untuk pelanggan PPPoE, bukan untuk voucher
        let voucherRecordId = null;
        // Parse price dengan lebih robust: handle string, number, null, undefined
        let voucherPrice = 0;
        if (price !== null && price !== undefined && price !== '') {
            voucherPrice = parseFloat(price);
            if (isNaN(voucherPrice)) {
                voucherPrice = 0;
            }
        }
        const getServerNameForVoucher = () => {
            if (serverMetadata && typeof serverMetadata === 'object') {
                const raw = serverMetadata.name || serverMetadata.server || serverMetadata.nasName || serverMetadata.nas_name || serverMetadata.serverName;
                if (raw) return String(raw).trim();
            }
            if (typeof server === 'string') {
                return server.trim();
            }
            return null;
        };
        let serverNameForVoucher = getServerNameForVoucher();
        if (serverNameForVoucher && ['all', 'semua', ''].includes(serverNameForVoucher.toLowerCase())) {
            serverNameForVoucher = null;
        }
        let serverMetadataForStore = null;
        if (serverMetadata && typeof serverMetadata === 'object') {
            const metadataToStore = { ...serverMetadata };
            if (!metadataToStore.name && serverNameForVoucher) {
                metadataToStore.name = serverNameForVoucher;
            }
            try {
                serverMetadataForStore = JSON.stringify(metadataToStore);
            } catch (jsonErr) {
                logger.warn(`Failed to stringify server metadata for ${username}: ${jsonErr.message}`);
                serverMetadataForStore = null;
            }
        } else if (serverNameForVoucher) {
            serverMetadataForStore = JSON.stringify({ name: serverNameForVoucher });
        }
        await ensureVoucherRevenueColumns();
        logger.info(`Saving voucher revenue record for ${username} with price: ${voucherPrice} (original price param: ${price}, type: ${typeof price}) (RADIUS result: ${result.success ? 'success' : 'failed'})`);
        try {
            const sqlite3 = require('sqlite3').verbose();
            const dbPath = require('path').join(__dirname, '../data/billing.db');
            const db = new sqlite3.Database(dbPath);
            
            logger.info(`[DEBUG] Opening database: ${dbPath}`);
            
            await new Promise((resolve, reject) => {
                db.serialize(() => {
                    db.get(`SELECT id, server_name, server_metadata FROM voucher_revenue WHERE username = ?`, [username], async (selectErr, existing) => {
                        if (selectErr) {
                            logger.error(`Failed to query existing voucher revenue for ${username}: ${selectErr.message}`);
                            reject(selectErr);
                            return;
                        }

                        const runAsync = (sql, params) => new Promise((res, rej) => {
                            db.run(sql, params, function(err) {
                                if (err) {
                                    rej(err);
                                } else {
                                    res(this);
                                }
                            });
                        });

                        try {
                            let runResult = null;
                            if (existing && existing.id) {
                                runResult = await runAsync(`
                                    UPDATE voucher_revenue
                                    SET price = ?,
                                        profile = ?,
                                        status = ?,
                                        notes = ?,
                                        server_name = COALESCE(?, server_name),
                                        server_metadata = COALESCE(?, server_metadata)
                                    WHERE username = ?
                                `, [
                                    voucherPrice,
                                    profile,
                                    'unpaid',
                                    `Voucher Hotspot ${username} - Profile: ${profile}`,
                                    serverNameForVoucher,
                                    serverMetadataForStore,
                                    username
                                ]);
                                voucherRecordId = existing.id;
                                logger.info(`🔁 Voucher revenue record updated for ${username}: ID=${voucherRecordId}`);
                            } else {
                                runResult = await runAsync(`
                                    INSERT INTO voucher_revenue (username, price, profile, created_at, status, notes, server_name, server_metadata, tenant_id)
                                    VALUES (?, ?, ?, datetime('now','localtime'), ?, ?, ?, ?, ?)
                                `, [
                                    username,
                                    voucherPrice,
                                    profile,
                                    'unpaid',
                                    `Voucher Hotspot ${username} - Profile: ${profile}`,
                                    serverNameForVoucher,
                                    serverMetadataForStore,
                                    (hasTenantContext() ? getTenantId() : 1)
                                ]);
                                voucherRecordId = runResult ? runResult.lastID : null;
                                logger.info(`✅ Voucher revenue record saved for ${username}: ID=${voucherRecordId}, Price=Rp ${voucherPrice} - Status: unpaid (will be paid when voucher is used)`);
                            }

                            db.get(`SELECT username, price, status, server_name FROM voucher_revenue WHERE username = ?`, [username], (verifyErr, verifyRow) => {
                                if (verifyErr) {
                                    logger.error(`[DEBUG] Error verifying voucher revenue record: ${verifyErr.message}`);
                                } else if (verifyRow) {
                                    logger.info(`[DEBUG] Voucher revenue record verified: ${verifyRow.username}, price=${verifyRow.price}, status=${verifyRow.status}, server_name=${verifyRow.server_name}`);
                                } else {
                                    logger.error(`[DEBUG] Voucher revenue record not found after save! Username: ${username}`);
                                }
                            });

                            resolve();
                        } catch (runErr) {
                            reject(runErr);
                        }
                    });
                });
            });
            
            db.close();
            logger.info(`✅ Voucher revenue record creation completed for ${username}. Record ID: ${voucherRecordId || 'null'}`);
        } catch (voucherError) {
            // Log error dengan detail untuk debugging
            logger.error(`❌ CRITICAL: Error saving voucher revenue record for ${username}: ${voucherError.message}`);
            logger.error(`Voucher error stack: ${voucherError.stack}`);
            // Coba sekali lagi dengan retry logic
            try {
                logger.info(`Retrying voucher revenue record creation for ${username}...`);
                const sqlite3 = require('sqlite3').verbose();
                const dbPath = require('path').join(__dirname, '../data/billing.db');
                const db = new sqlite3.Database(dbPath);
                
                await new Promise((resolve, reject) => {
                    db.serialize(() => {
                        db.get(`SELECT id FROM voucher_revenue WHERE username = ?`, [username], async (selectErr, existing) => {
                            if (selectErr) {
                                reject(selectErr);
                                return;
                            }

                            const runAsync = (sql, params) => new Promise((res, rej) => {
                                db.run(sql, params, function(err) {
                                    if (err) {
                                        rej(err);
                                    } else {
                                        res(this);
                                    }
                                });
                            });

                            try {
                                if (existing && existing.id) {
                                    await runAsync(`
                                        UPDATE voucher_revenue
                                        SET price = ?, profile = ?, status = ?, notes = ?, server_name = COALESCE(?, server_name), server_metadata = COALESCE(?, server_metadata)
                                        WHERE username = ?
                                    `, [
                                        voucherPrice,
                                        profile,
                                        'unpaid',
                                        `Voucher Hotspot ${username} - Profile: ${profile}`,
                                        serverNameForVoucher,
                                        serverMetadataForStore,
                                        username
                                    ]);
                                    voucherRecordId = existing.id;
                                } else {
                                    const insertResult = await runAsync(`
                                        INSERT INTO voucher_revenue (username, price, profile, created_at, status, notes, server_name, server_metadata, tenant_id)
                                    VALUES (?, ?, ?, datetime('now','localtime'), ?, ?, ?, ?, ?)
                                    `, [
                                        username,
                                        voucherPrice,
                                        profile,
                                        'unpaid',
                                        `Voucher Hotspot ${username} - Profile: ${profile}`,
                                        serverNameForVoucher,
                                        serverMetadataForStore,
                                    (hasTenantContext() ? getTenantId() : 1)
                                    ]);
                                    voucherRecordId = insertResult ? insertResult.lastID : null;
                                }
                                resolve();
                            } catch (runErr) {
                                reject(runErr);
                            }
                        });
                    });
                });
                
                db.close();
            } catch (retryError) {
                logger.error(`❌ Retry also failed for ${username}: ${retryError.message}`);
            }
        }
        
        return { ...result, voucherRecordId };
    } else {
        if (customer) {
          conn = await getMikrotikConnectionForCustomer(customer);
        } else if (routerObj) {
          conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
          conn = await getMikrotikConnection();
        }
        if (!conn) throw new Error('Koneksi ke router gagal: Data router/NAS tidak ditemukan');
            // Prepare parameters
            const params = [
                '=name=' + username,
                '=password=' + password,
                '=profile=' + profile
            ];
            if (comment) {
                params.push('=comment=' + comment);
            }
            // Add server parameter if provided (untuk menentukan server instance)
            if (server && server.trim() !== '' && server !== 'all') {
                params.push('=server=' + server);
            }
            await conn.write('/ip/hotspot/user/add', params);

            if (uptimeSeconds || validitySeconds) {
                try {
                    const users = await conn.write('/ip/hotspot/user/print', ['?name=' + username]);
                    if (users && users.length > 0) {
                        const userId = users[0]['.id'];
                        if (uptimeSeconds) {
                            await conn.write('/ip/hotspot/user/set', ['=.id=' + userId, '=limit-uptime=' + uptimeSeconds + 's']);
                        }
                        if (validitySeconds) {
                            const validityInfo = `[validity:${validitySeconds}s]`;
                            await conn.write('/ip/hotspot/user/set', ['=.id=' + userId, '=comment=' + validityInfo]);
                        }
                    }
                } catch (limitErr) {
                    logger.warn(`Failed to apply per-user limits in Mikrotik mode for ${username}: ${limitErr.message}`);
                }
            }
            return { success: true, message: 'User hotspot berhasil ditambahkan' };
    }
}
// Fungsi untuk menghapus user hotspot
async function deleteHotspotUser(username, routerObj = null) {
    try {
        const mode = await getUserAuthModeAsync();
        if (mode === 'radius') {
            // Delete dari RADIUS database
            const conn = await getRadiusConnection();
            try {
                // Hapus dari radcheck
                await conn.execute(
                    "DELETE FROM radcheck WHERE username = ?",
                    [username]
                );
                // Hapus dari radusergroup
                await conn.execute(
                    "DELETE FROM radusergroup WHERE username = ?",
                    [username]
                );
                // Hapus dari radreply
                await conn.execute(
                    "DELETE FROM radreply WHERE username = ?",
                    [username]
                );
                await conn.end();
                
                // Hapus invoice terkait dari billing.db
                try {
                    const sqlite3 = require('sqlite3').verbose();
                    const dbPath = require('path').join(__dirname, '../data/billing.db');
                    const db = new sqlite3.Database(dbPath);
                    
                    await new Promise((resolve, reject) => {
                        // Cari invoice berdasarkan notes yang mengandung username
                        db.run(`
                            DELETE FROM invoices 
                            WHERE invoice_type = 'voucher' 
                            AND notes LIKE ?
                        `, [`Voucher Hotspot ${username}%`], function(err) {
                            if (err) {
                                logger.error(`Error deleting invoice for voucher ${username}: ${err.message}`);
                                reject(err);
                            } else {
                                if (this.changes > 0) {
                                    logger.info(`✅ Deleted ${this.changes} invoice(s) for voucher ${username}`);
                                }
                                resolve();
                            }
                        });
                    });
                    
                    db.close();
                } catch (invoiceError) {
                    logger.error(`Error deleting invoice for voucher ${username}: ${invoiceError.message}`);
                    // Jangan throw error, karena voucher sudah dihapus dari RADIUS
                }
                
                return { success: true, message: 'User hotspot berhasil dihapus dari RADIUS' };
            } catch (error) {
                await conn.end();
                logger.error(`Error deleting hotspot user from RADIUS: ${error.message}`);
                throw error;
            }
        } else {
            // Delete dari Mikrotik
            let conn = null;
            if (routerObj) {
                conn = await getMikrotikConnectionForRouter(routerObj);
            } else {
                conn = await getMikrotikConnection();
            }
            if (!conn) {
                logger.error('No Mikrotik connection available');
                return { success: false, message: 'Koneksi ke Mikrotik gagal' };
            }
            // Cari user hotspot
            const users = await conn.write('/ip/hotspot/user/print', [
                '?name=' + username
            ]);
            if (users.length === 0) {
                return { success: false, message: 'User hotspot tidak ditemukan' };
            }
            // Hapus user hotspot
            await conn.write('/ip/hotspot/user/remove', [
                '=.id=' + users[0]['.id']
            ]);
            return { success: true, message: 'User hotspot berhasil dihapus' };
        }
    } catch (error) {
        logger.error(`Error deleting hotspot user: ${error.message}`);
        return { success: false, message: `Gagal menghapus user hotspot: ${error.message}` };
    }
}
// Fungsi untuk menambahkan secret PPPoE
async function addPPPoESecret(username, password, profile, localAddress = '', conn) {
    try {
        if (!conn) {
            // Backward compatibility: fallback to global connection if no explicit conn provided
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }
        // Parameter untuk menambahkan secret
        const params = [
            '=name=' + username,
            '=password=' + password,
            '=profile=' + profile,
            '=service=pppoe'
        ];
        if (localAddress) {
            params.push('=local-address=' + localAddress);
        }
        // Tambahkan secret PPPoE
        await conn.write('/ppp/secret/add', params);
        return { success: true, message: 'Secret PPPoE berhasil ditambahkan' };
    } catch (error) {
        logger.error(`Error adding PPPoE secret: ${error.message}`);
        return { success: false, message: `Gagal menambah secret PPPoE: ${error.message}` };
    }
}
// Fungsi untuk menghapus secret PPPoE
async function deletePPPoESecret(username) {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }
        // Cari secret PPPoE
        const secrets = await conn.write('/ppp/secret/print', [
            '?name=' + username
        ]);
        if (secrets.length === 0) {
            return { success: false, message: 'Secret PPPoE tidak ditemukan' };
        }
        // Hapus secret PPPoE
        await conn.write('/ppp/secret/remove', [
            '=.id=' + secrets[0]['.id']
        ]);
        return { success: true, message: 'Secret PPPoE berhasil dihapus' };
    } catch (error) {
        logger.error(`Error deleting PPPoE secret: ${error.message}`);
        return { success: false, message: `Gagal menghapus secret PPPoE: ${error.message}` };
    }
}

// Fungsi helper untuk disconnect PPPoE user (dapat digunakan untuk router spesifik)
async function disconnectPPPoEUser(username, routerObj = null) {
    try {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', disconnected: 0 };
        }
        
        // Cari sesi aktif user.
        // Jangan pakai filter `?name=` karena saat tidak ada match Mikrotik bisa mengirim reply `!empty`
        // yang kadang memicu exception dari node-routeros.
        // Jadi: print semua sesi, lalu filter di sisi aplikasi.
        const allActiveSessions = await conn.write('/ppp/active/print');
        const activeSessions = (Array.isArray(allActiveSessions) ? allActiveSessions : [])
            .filter(s => String(s.name || '') === String(username));
        
        if (!activeSessions || activeSessions.length === 0) {
            return { success: true, message: `User ${username} tidak sedang online`, disconnected: 0 };
        }
        
        // Hapus semua sesi aktif user ini
        let disconnected = 0;
        for (const session of activeSessions) {
            try {
                await conn.write('/ppp/active/remove', [
                    `=.id=${session['.id']}`
                ]);
                disconnected++;
            } catch (removeError) {
                logger.warn(`Failed to remove session ${session['.id']} for ${username}: ${removeError.message}`);
            }
        }

        logger.info(`Disconnected ${disconnected} active PPPoE session(s) for ${username}`);
        return { success: true, message: `User ${username} berhasil diputus dari ${disconnected} sesi aktif`, disconnected: disconnected };
    } catch (error) {
        logger.error(`Error disconnecting PPPoE user ${username}: ${error.message}`);
        return { success: false, message: `Gagal memutus koneksi PPPoE: ${error.message}`, disconnected: 0 };
    }
}

/**
 * Putuskan sesi PPPoE user di SEMUA router NAS (penting untuk restore/isolir multi-NAS).
 */
async function disconnectPPPoEUserAllRouters(username) {
    const u = (username && String(username).trim()) || '';
    if (!u) {
        return { success: false, disconnected: 0, routers: [], message: 'Username kosong' };
    }
    const sqlite3 = require('sqlite3').verbose();
    const dbPath = require('path').join(__dirname, '../data/billing.db');
    const db = new sqlite3.Database(dbPath);
    const whereSql = _routersTenantWhereSql();
    const routers = await new Promise((resolve) =>
        db.all(`SELECT * FROM routers${whereSql} ORDER BY id`, (err, rows) => {
            db.close();
            resolve(rows || []);
        })
    );
    let totalDisconnected = 0;
    const routersHit = [];
    for (const router of routers) {
        try {
            const result = await disconnectPPPoEUser(u, router);
            if (result && result.disconnected > 0) {
                totalDisconnected += result.disconnected;
                routersHit.push(router.name || router.nas_ip || String(router.id));
            }
        } catch (e) {
            logger.warn(`[PPPoE] disconnect ${u} on ${router.name}: ${e.message}`);
        }
    }
    return {
        success: true,
        disconnected: totalDisconnected,
        routers: routersHit,
        message:
            totalDisconnected > 0
                ? `Diputus dari ${totalDisconnected} sesi di ${routersHit.length} router`
                : `User ${u} tidak sedang online di router manapun`
    };
}

// Fungsi untuk mengubah profile PPPoE
async function setPPPoEProfile(username, profile) {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }
        // Cari secret PPPoE
        const secrets = await conn.write('/ppp/secret/print', [
            '?name=' + username
        ]);
        if (secrets.length === 0) {
            return { success: false, message: 'Secret PPPoE tidak ditemukan' };
        }
        // Ubah profile PPPoE
        await conn.write('/ppp/secret/set', [
            '=.id=' + secrets[0]['.id'],
            '=profile=' + profile
        ]);

        // Tambahan: Kick user dari sesi aktif PPPoE
        // Cari sesi aktif
        const activeSessions = await conn.write('/ppp/active/print', [
            '?name=' + username
        ]);
        if (activeSessions.length > 0) {
            // Hapus semua sesi aktif user ini
            for (const session of activeSessions) {
                await conn.write('/ppp/active/remove', [
                    '=.id=' + session['.id']
                ]);
            }
            logger.info(`User ${username} di-kick dari sesi aktif PPPoE setelah ganti profile`);
        }

        return { success: true, message: 'Profile PPPoE berhasil diubah dan user di-kick dari sesi aktif' };
    } catch (error) {
        logger.error(`Error setting PPPoE profile: ${error.message}`);
        return { success: false, message: `Gagal mengubah profile PPPoE: ${error.message}` };
    }
}
// Fungsi untuk monitoring koneksi PPPoE
let lastActivePPPoE = [];
async function monitorPPPoEConnections() {
    try {
        if (!isPppoeLoginLogoutWaEnabled()) {
            if (monitorInterval) {
                clearInterval(monitorInterval);
                monitorInterval = null;
            }
            logger.info('Legacy PPPoE WA monitoring is disabled by master switch');
            return;
        }

        // Cek ENV untuk enable/disable monitoring
        const monitorEnableRaw = getSetting('pppoe_monitor_enable', true);
        const monitorEnable = typeof monitorEnableRaw === 'string'
            ? monitorEnableRaw.toLowerCase() === 'true'
            : Boolean(monitorEnableRaw);
        if (!monitorEnable) {
            logger.info('PPPoE monitoring is DISABLED by ENV');
            return;
        }
        // Dapatkan interval monitoring dari konfigurasi dalam menit, konversi ke milidetik
        const configuredIntervalMinutes = parseFloat(getSetting('pppoe_monitor_interval_minutes', '1'));
        const configuredIntervalMs = Number.isFinite(configuredIntervalMinutes) && configuredIntervalMinutes > 0
            ? configuredIntervalMinutes * 60 * 1000
            : 60 * 1000;
        const interval = Math.max(configuredIntervalMs, MIN_MONITOR_INTERVAL_MS);
        const intervalMinutes = interval / (60 * 1000);
        
        console.log(`📋 Starting PPPoE monitoring (interval: ${intervalMinutes} menit / ${interval/1000}s)`);
        
        // Bersihkan interval sebelumnya jika ada
        if (monitorInterval) {
            clearInterval(monitorInterval);
        }
        
        // Set interval untuk monitoring
        monitorInterval = setInterval(async () => {
            try {
                if (!isPppoeLoginLogoutWaEnabled()) {
                    logger.debug('Legacy PPPoE WA monitoring master switch is off, skipping check');
                    return;
                }

                // Dapatkan koneksi PPPoE aktif
                const connections = await getActivePPPoEConnections();
                if (!connections.success) {
                    logger.warn(`Monitoring PPPoE connections failed: ${connections.message}`);
                    return;
                }
                const activeNow = connections.data.map(u => u.name);
                // Deteksi login/logout
                const loginUsers = activeNow.filter(u => !lastActivePPPoE.includes(u));
                const logoutUsers = lastActivePPPoE.filter(u => !activeNow.includes(u));
                if (loginUsers.length > 0) {
                    // Ambil detail user login
                    const loginDetail = connections.data.filter(u => loginUsers.includes(u.name));
                    // Ambil daftar user offline
                    let offlineList = [];
                    try {
                        const conn = await getMikrotikConnection();
                        const pppSecrets = await conn.write('/ppp/secret/print');
                        offlineList = pppSecrets.filter(secret => !activeNow.includes(secret.name)).map(u => u.name);
                    } catch (e) {}
                    // Format pesan WhatsApp
                    let msg = `🔔 *PPPoE LOGIN*\n\n`;
                    loginDetail.forEach((u, i) => {
                        msg += `*${i+1}. ${u.name}*\n• Address: ${u.address || '-'}\n• Uptime: ${u.uptime || '-'}\n\n`;
                    });
                    msg += `🚫 *Pelanggan Offline* (${offlineList.length})\n`;
                    offlineList.forEach((u, i) => {
                        msg += `${i+1}. ${u}\n`;
                    });
                    // Kirim ke group WhatsApp
                    const technicianGroupId = getSetting('technician_group_id', '');
                    if (sock && technicianGroupId) {
                        try {
                            await sock.sendMessage(technicianGroupId, { text: msg });
                            logger.info(`PPPoE login notification sent to group: ${technicianGroupId}`);
                        } catch (e) {
                            logger.error('Gagal kirim notifikasi PPPoE ke WhatsApp group:', e);
                        }
                    } else {
                        logger.warn('No technician group configured for PPPoE notifications');
                    }
                    logger.info('PPPoE LOGIN:', loginUsers);
                }
                if (logoutUsers.length > 0) {
                    // Ambil detail user logout dari lastActivePPPoE (karena sudah tidak ada di connections.data)
                    let logoutDetail = logoutUsers.map(name => ({ name }));
                    // Ambil daftar user offline terbaru
                    let offlineList = [];
                    try {
                        const conn = await getMikrotikConnection();
                        const pppSecrets = await conn.write('/ppp/secret/print');
                        offlineList = pppSecrets.filter(secret => !activeNow.includes(secret.name)).map(u => u.name);
                    } catch (e) {}
                    // Format pesan WhatsApp
                    let msg = `🚪 *PPPoE LOGOUT*\n\n`;
                    logoutDetail.forEach((u, i) => {
                        msg += `*${i+1}. ${u.name}*\n\n`;
                    });
                    msg += `🚫 *Pelanggan Offline* (${offlineList.length})\n`;
                    offlineList.forEach((u, i) => {
                        msg += `${i+1}. ${u}\n`;
                    });
                    // Kirim ke group WhatsApp
                    const technicianGroupId = getSetting('technician_group_id', '');
                    if (sock && technicianGroupId) {
                        try {
                            await sock.sendMessage(technicianGroupId, { text: msg });
                            logger.info(`PPPoE logout notification sent to group: ${technicianGroupId}`);
                        } catch (e) {
                            logger.error('Gagal kirim notifikasi PPPoE LOGOUT ke WhatsApp group:', e);
                        }
                    } else {
                        logger.warn('No technician group configured for PPPoE notifications');
                    }
                    logger.info('PPPoE LOGOUT:', logoutUsers);
                }
                lastActivePPPoE = activeNow;
                logger.info(`Monitoring PPPoE connections: ${connections.data.length} active connections`);
            } catch (error) {
                logger.error(`Error in PPPoE monitoring: ${error.message}`);
            }
        }, interval);
        
        logger.info(`PPPoE monitoring started with interval ${interval}ms`);
    } catch (error) {
        logger.error(`Error starting PPPoE monitoring: ${error.message}`);
    }
}
// Fungsi untuk mendapatkan traffic interface
async function getInterfaceTraffic(interfaceName = 'ether1') {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) return { rx: 0, tx: 0 };
        const res = await conn.write('/interface/monitor-traffic', [
            `=interface=${interfaceName}`,
            '=once='
        ]);
        if (!res || !res[0]) return { rx: 0, tx: 0 };
        // RX/TX dalam bps
        return {
            rx: res[0]['rx-bits-per-second'] || 0,
            tx: res[0]['tx-bits-per-second'] || 0
        };
    } catch (error) {
        logger.error('Error getting interface traffic:', error.message, error);
        return { rx: 0, tx: 0 };
    }
}
// Fungsi untuk mendapatkan daftar interface dari router tertentu
async function getInterfacesForRouter(routerObj = null) {
    try {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: [] };
        }

        const interfaces = await conn.write('/interface/print');
        
        if (Array.isArray(interfaces)) {
            const interfaceList = interfaces
                .filter(iface => iface.name && !iface.name.startsWith('<'))
                .map(iface => ({
                    name: iface.name,
                    type: iface.type || '',
                    disabled: iface.disabled === 'true',
                    running: iface.running === 'true'
                }));
            
            return {
                success: true,
                message: `Ditemukan ${interfaceList.length} interface`,
                data: interfaceList
            };
        } else {
            return { success: false, message: 'Gagal mendapatkan interface', data: [] };
        }
    } catch (error) {
        logger.error(`Error getting interfaces: ${error.message}`);
        return { success: false, message: `Gagal ambil data interface: ${error.message}`, data: [] };
    }
}

// Fungsi untuk mendapatkan daftar address pool dari router tertentu
async function getAddressPoolsForRouter(routerObj = null) {
    try {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: [] };
        }

        const pools = await conn.write('/ip/pool/print');
        
        if (Array.isArray(pools)) {
            const poolList = pools.map(pool => ({
                name: pool.name,
                ranges: pool.ranges || '',
                comment: pool.comment || ''
            }));
            
            return {
                success: true,
                message: `Ditemukan ${poolList.length} address pool`,
                data: poolList
            };
        } else {
            return { success: false, message: 'Gagal mendapatkan address pool', data: [] };
        }
    } catch (error) {
        logger.error(`Error getting address pools: ${error.message}`);
        return { success: false, message: `Gagal ambil data address pool: ${error.message}`, data: [] };
    }
}

// Fungsi untuk mendapatkan daftar interface (legacy, untuk backward compatibility)
async function getInterfaces() {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: [] };
        }

        const interfaces = await conn.write('/interface/print');
        return {
            success: true,
            message: `Ditemukan ${interfaces.length} interface`,
            data: interfaces
        };
    } catch (error) {
        logger.error(`Error getting interfaces: ${error.message}`);
        return { success: false, message: `Gagal ambil data interface: ${error.message}`, data: [] };
    }
}

// Fungsi untuk mendapatkan detail interface tertentu
async function getInterfaceDetail(interfaceName) {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: null };
        }

        const interfaces = await conn.write('/interface/print', [
            `?name=${interfaceName}`
        ]);

        if (interfaces.length === 0) {
            return { success: false, message: 'Interface tidak ditemukan', data: null };
        }

        return {
            success: true,
            message: `Detail interface ${interfaceName}`,
            data: interfaces[0]
        };
    } catch (error) {
        logger.error(`Error getting interface detail: ${error.message}`);
        return { success: false, message: `Gagal ambil detail interface: ${error.message}`, data: null };
    }
}

// Fungsi untuk enable/disable interface
async function setInterfaceStatus(interfaceName, enabled) {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }

        // Cari interface
        const interfaces = await conn.write('/interface/print', [
            `?name=${interfaceName}`
        ]);

        if (interfaces.length === 0) {
            return { success: false, message: 'Interface tidak ditemukan' };
        }

        // Set status interface
        const action = enabled ? 'enable' : 'disable';
        await conn.write(`/interface/${action}`, [
            `=.id=${interfaces[0]['.id']}`
        ]);

        return {
            success: true,
            message: `Interface ${interfaceName} berhasil ${enabled ? 'diaktifkan' : 'dinonaktifkan'}`
        };
    } catch (error) {
        logger.error(`Error setting interface status: ${error.message}`);
        return { success: false, message: `Gagal mengubah status interface: ${error.message}` };
    }
}

// Fungsi untuk mendapatkan daftar IP address
async function getIPAddresses() {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: [] };
        }

        const addresses = await conn.write('/ip/address/print');
        return {
            success: true,
            message: `Ditemukan ${addresses.length} IP address`,
            data: addresses
        };
    } catch (error) {
        logger.error(`Error getting IP addresses: ${error.message}`);
        return { success: false, message: `Gagal ambil data IP address: ${error.message}`, data: [] };
    }
}

// Fungsi untuk menambah IP address
async function addIPAddress(interfaceName, address) {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }

        await conn.write('/ip/address/add', [
            `=interface=${interfaceName}`,
            `=address=${address}`
        ]);

        return { success: true, message: `IP address ${address} berhasil ditambahkan ke ${interfaceName}` };
    } catch (error) {
        logger.error(`Error adding IP address: ${error.message}`);
        return { success: false, message: `Gagal menambah IP address: ${error.message}` };
    }
}
// Fungsi untuk menghapus IP address
async function deleteIPAddress(interfaceName, address) {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }

        // Cari IP address
        const addresses = await conn.write('/ip/address/print', [
            `?interface=${interfaceName}`,
            `?address=${address}`
        ]);

        if (addresses.length === 0) {
            return { success: false, message: 'IP address tidak ditemukan' };
        }

        // Hapus IP address
        await conn.write('/ip/address/remove', [
            `=.id=${addresses[0]['.id']}`
        ]);

        return { success: true, message: `IP address ${address} berhasil dihapus dari ${interfaceName}` };
    } catch (error) {
        logger.error(`Error deleting IP address: ${error.message}`);
        return { success: false, message: `Gagal menghapus IP address: ${error.message}` };
    }
}

// Fungsi untuk mendapatkan routing table
async function getRoutes() {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: [] };
        }

        const routes = await conn.write('/ip/route/print');
        return {
            success: true,
            message: `Ditemukan ${routes.length} route`,
            data: routes
        };
    } catch (error) {
        logger.error(`Error getting routes: ${error.message}`);
        return { success: false, message: `Gagal ambil data route: ${error.message}`, data: [] };
    }
}

// Fungsi untuk menambah route
async function addRoute(destination, gateway, distance = '1') {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }

        await conn.write('/ip/route/add', [
            `=dst-address=${destination}`,
            `=gateway=${gateway}`,
            `=distance=${distance}`
        ]);

        return { success: true, message: `Route ${destination} via ${gateway} berhasil ditambahkan` };
    } catch (error) {
        logger.error(`Error adding route: ${error.message}`);
        return { success: false, message: `Gagal menambah route: ${error.message}` };
    }
}

// Fungsi untuk menghapus route
async function deleteRoute(destination) {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }

        // Cari route
        const routes = await conn.write('/ip/route/print', [
            `?dst-address=${destination}`
        ]);

        if (routes.length === 0) {
            return { success: false, message: 'Route tidak ditemukan' };
        }

        // Hapus route
        await conn.write('/ip/route/remove', [
            `=.id=${routes[0]['.id']}`
        ]);

        return { success: true, message: `Route ${destination} berhasil dihapus` };
    } catch (error) {
        logger.error(`Error deleting route: ${error.message}`);
        return { success: false, message: `Gagal menghapus route: ${error.message}` };
    }
}

// Fungsi untuk mendapatkan DHCP leases
async function getDHCPLeases() {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: [] };
        }

        const leases = await conn.write('/ip/dhcp-server/lease/print');
        return {
            success: true,
            message: `Ditemukan ${leases.length} DHCP lease`,
            data: leases
        };
    } catch (error) {
        logger.error(`Error getting DHCP leases: ${error.message}`);
        return { success: false, message: `Gagal ambil data DHCP lease: ${error.message}`, data: [] };
    }
}
// Fungsi untuk mendapatkan DHCP server
async function getDHCPServers() {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: [] };
        }

        const servers = await conn.write('/ip/dhcp-server/print');
        return {
            success: true,
            message: `Ditemukan ${servers.length} DHCP server`,
            data: servers
        };
    } catch (error) {
        logger.error(`Error getting DHCP servers: ${error.message}`);
        return { success: false, message: `Gagal ambil data DHCP server: ${error.message}`, data: [] };
    }
}

// Fungsi untuk ping
async function pingHost(host, count = '4') {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: null };
        }

        const pingCount = parseInt(count) || 4;
        const pingResults = [];
        
        // Untuk ping di Mikrotik, kita perlu menggunakan streaming karena ping mengembalikan multiple responses
        logger.info(`Starting ping to ${host} with count ${pingCount}`);
        
        return new Promise((resolve, reject) => {
            try {
                // Gunakan stream untuk mendapatkan hasil ping real-time
                const pingStream = conn.stream('/ping', [
                    `=address=${host}`,
                    `=count=${pingCount}`
                ]);
                
                let receivedCount = 0;
                const timeout = setTimeout(() => {
                    pingStream.close();
                    // Jika masih kurang dari count, tambahkan timeout untuk yang belum ada
                    while (pingResults.length < pingCount) {
                        pingResults.push({
                            seq: pingResults.length + 1,
                            host: host,
                            status: 'timeout',
                            time: 'N/A',
                            ttl: 'N/A',
                            size: 'N/A'
                        });
                    }
                    resolve({
                        success: true,
                        message: `Ping ke ${host} selesai`,
                        data: pingResults
                    });
                }, (pingCount * 2 + 2) * 1000); // Timeout: (count * 2 + 2) detik
                
                pingStream.on('data', (data) => {
                    receivedCount++;
                    logger.info(`Ping data received (${receivedCount}/${pingCount}):`, data);
                    
                    if (data && Array.isArray(data)) {
                        data.forEach((pingData) => {
                            // Parse hasil ping dari Mikrotik
                            const time = pingData.time || pingData['avg-rtt'] || pingData['min-rtt'] || pingData.rtt || 'N/A';
                            const ttl = pingData.ttl || 'N/A';
                            const size = pingData.size || pingData['packet-size'] || '64';
                            const seq = pingData.seq || (pingResults.length + 1);
                            
                            pingResults.push({
                                seq: seq,
                                host: pingData.host || pingData.address || host,
                                time: typeof time === 'number' ? `${time}ms` : (typeof time === 'string' ? time : 'N/A'),
                                ttl: String(ttl),
                                size: String(size),
                                status: 'ok'
                            });
                        });
                    } else if (data) {
                        // Jika data bukan array, parse sebagai single result
                        const time = data.time || data['avg-rtt'] || data['min-rtt'] || data.rtt || 'N/A';
                        const ttl = data.ttl || 'N/A';
                        const size = data.size || data['packet-size'] || '64';
                        
                        pingResults.push({
                            seq: pingResults.length + 1,
                            host: data.host || data.address || host,
                            time: typeof time === 'number' ? `${time}ms` : (typeof time === 'string' ? time : 'N/A'),
                            ttl: String(ttl),
                            size: String(size),
                            status: 'ok'
                        });
                    }
                    
                    // Jika sudah menerima semua response
                    if (receivedCount >= pingCount || pingResults.length >= pingCount) {
                        clearTimeout(timeout);
                        pingStream.close();
                        // Jika masih kurang, tambahkan timeout
                        while (pingResults.length < pingCount) {
                            pingResults.push({
                                seq: pingResults.length + 1,
                                host: host,
                                status: 'timeout',
                                time: 'N/A',
                                ttl: 'N/A',
                                size: 'N/A'
                            });
                        }
                        resolve({
                            success: true,
                            message: `Ping ke ${host} selesai`,
                            data: pingResults
                        });
                    }
                });
                
                pingStream.on('error', (error) => {
                    clearTimeout(timeout);
                    logger.error(`Error in ping stream: ${error.message}`);
                    
                    // Jika error tapi sudah ada beberapa hasil, return hasil yang ada
                    if (pingResults.length > 0) {
                        while (pingResults.length < pingCount) {
                            pingResults.push({
                                seq: pingResults.length + 1,
                                host: host,
                                status: 'timeout',
                                time: 'N/A',
                                ttl: 'N/A',
                                size: 'N/A'
                            });
                        }
                        resolve({
                            success: true,
                            message: `Ping ke ${host} selesai (beberapa timeout)`,
                            data: pingResults
                        });
                    } else {
                        // Jika tidak ada hasil sama sekali, semua timeout
                        for (let i = 0; i < pingCount; i++) {
                            pingResults.push({
                                seq: i + 1,
                                host: host,
                                status: 'timeout',
                                time: 'N/A',
                                ttl: 'N/A',
                                size: 'N/A',
                                error: error.message
                            });
                        }
                        resolve({
                            success: true,
                            message: `Ping ke ${host} selesai (semua timeout)`,
                            data: pingResults
                        });
                    }
                });
                
                pingStream.on('close', () => {
                    clearTimeout(timeout);
                    // Jika masih kurang dari count, tambahkan timeout untuk yang belum ada
                    while (pingResults.length < pingCount) {
                        pingResults.push({
                            seq: pingResults.length + 1,
                            host: host,
                            status: 'timeout',
                            time: 'N/A',
                            ttl: 'N/A',
                            size: 'N/A'
                        });
                    }
                    resolve({
                        success: true,
                        message: `Ping ke ${host} selesai`,
                        data: pingResults
                    });
                });
            } catch (error) {
                logger.error(`Error setting up ping stream: ${error.message}`);
                reject(error);
            }
        });
    } catch (error) {
        logger.error(`Error pinging host: ${error.message}`);
        return { success: false, message: `Gagal ping ke ${host}: ${error.message}`, data: null };
    }
}

// Fungsi untuk mendapatkan system logs
async function getSystemLogs(topics = '', count = '50') {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: [] };
        }

        const params = [];
        if (topics) {
            params.push(`?topics~${topics}`);
        }

        const logs = await conn.write('/log/print', params);

        // Batasi jumlah log yang dikembalikan
        const limitedLogs = logs.slice(0, parseInt(count));

        return {
            success: true,
            message: `Ditemukan ${limitedLogs.length} log entries`,
            data: limitedLogs
        };
    } catch (error) {
        logger.error(`Error getting system logs: ${error.message}`);
        return { success: false, message: `Gagal ambil system logs: ${error.message}`, data: [] };
    }
}

// Fungsi untuk mendapatkan daftar profile PPPoE
// options.mergeAssignedGroups (RADIUS): true = sertakan grup dari radusergroup yang belum ada di radgroupreply (hanya untuk dropdown edit user PPPoE).
async function getPPPoEProfiles(routerObj = null, options = {}) {
    // Check auth mode
    const mode = await getUserAuthModeAsync();
    if (mode === 'radius') {
        return await getPPPoEProfilesRadius(options);
    }
    
    // Mikrotik API mode
    let conn = null;
    try {
        if (routerObj) {
            logger.info(`Connecting to router for PPPoE profiles: ${routerObj.name} (${routerObj.nas_ip}:${routerObj.port || 8728})`);
            try {
                conn = await getMikrotikConnectionForRouter(routerObj);
            } catch (connError) {
                logger.error(`Connection failed to ${routerObj.name}:`, connError.message);
                return { success: false, message: `Koneksi gagal ke ${routerObj.name}: ${connError.message}`, data: [] };
            }
        } else {
            logger.info('Using default Mikrotik connection for PPPoE profiles');
            conn = await getMikrotikConnection();
        }
        
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: [] };
        }

        logger.info('Fetching PPPoE profiles from Mikrotik...');
        const profiles = await conn.write('/ppp/profile/print');
        logger.info(`Successfully retrieved ${profiles ? profiles.length : 0} PPPoE profiles from ${routerObj ? routerObj.name : 'default'}`);
        
        // Attach router info to profiles if routerObj is provided
        if (Array.isArray(profiles) && routerObj) {
            profiles.forEach(prof => {
                if (prof) {
                    prof.nas_id = routerObj.id;
                    prof.nas_name = routerObj.name;
                    prof.nas_ip = routerObj.nas_ip;
                }
            });
        }
        
        return {
            success: true,
            message: `Ditemukan ${profiles ? profiles.length : 0} PPPoE profile`,
            data: profiles || []
        };
    } catch (error) {
        logger.error(`Error getting PPPoE profiles from ${routerObj ? routerObj.name : 'default'}: ${error.message}`);
        return { success: false, message: `Gagal ambil data PPPoE profile: ${error.message}`, data: [] };
    }
}
// Fungsi untuk mendapatkan detail profile PPPoE
async function getPPPoEProfileDetail(id) {
    try {
        // Check auth mode - if id is a groupname (string), it's RADIUS mode
        const mode = await getUserAuthModeAsync();
        if (mode === 'radius' || (typeof id === 'string' && !id.match(/^\d+$/))) {
            return await getPPPoEProfileDetailRadius(id);
        }
        
        // Mikrotik API mode
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: null };
        }

        const profiles = await conn.write('/ppp/profile/print', [`?.id=${id}`]);
        if (profiles.length === 0) {
            return { success: false, message: 'Profile tidak ditemukan', data: null };
        }

        return {
            success: true,
            message: 'Detail profile berhasil diambil',
            data: profiles[0]
        };
    } catch (error) {
        logger.error(`Error getting PPPoE profile detail: ${error.message}`);
        return { success: false, message: `Gagal ambil detail profile: ${error.message}`, data: null };
    }
}
// Fungsi untuk mendapatkan daftar profile hotspot
async function getHotspotProfiles(routerObj = null) {
    let conn = null;
    try {
        if (routerObj) {
            logger.info(`Connecting to router: ${routerObj.name} (${routerObj.nas_ip}:${routerObj.port || 8728})`);
            try {
                conn = await getMikrotikConnectionForRouter(routerObj);
            } catch (connError) {
                logger.error(`Connection failed to ${routerObj.name}:`, connError.message);
                return { success: false, message: `Koneksi gagal ke ${routerObj.name}: ${connError.message}`, data: [] };
            }
        } else {
            logger.info('Using default Mikrotik connection');
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal: Tidak dapat membuat koneksi', data: [] };
        }
        
        logger.info('Fetching hotspot profiles from Mikrotik...');
        const profiles = await conn.write('/ip/hotspot/user/profile/print');
        logger.info(`Successfully retrieved ${profiles ? profiles.length : 0} profiles from ${routerObj ? routerObj.name : 'default'}`);
        
        // Parse and validate profiles, attach router info if provided
        const validProfiles = [];
        if (Array.isArray(profiles)) {
            profiles.forEach((prof, idx) => {
                if (prof && (prof.name || prof['name'])) {
                    // Attach router info to profile for tracking
                    if (routerObj) {
                        prof.nas_id = routerObj.id;
                        prof.nas_name = routerObj.name;
                        prof.nas_ip = routerObj.nas_ip;
                    }
                    validProfiles.push(prof);
                    logger.debug(`  Profile ${idx + 1}: ${prof.name || prof['name']} (Rate: ${prof['rate-limit'] || 'none'}, Session: ${prof['session-timeout'] || 'none'}, Idle: ${prof['idle-timeout'] || 'none'})`);
                }
            });
        }
        logger.info(`Valid profiles after parsing: ${validProfiles.length}`);
        
        // Don't close connection here - let it be managed by connection pool or caller
        // Connection will be reused or closed automatically
        
        return {
            success: true,
            message: `Ditemukan ${validProfiles.length} profile hotspot`,
            data: validProfiles
        };
    } catch (error) {
        logger.error(`Error getting hotspot profiles from ${routerObj ? routerObj.name : 'default'}:`, error.message);
        logger.error('Error stack:', error.stack);
        
        // Don't close connection on error - might be reused
        // Connection will be managed by connection pool
        
        return { success: false, message: `Gagal ambil data profile hotspot: ${error.message}`, data: [] };
    }
}
// Fungsi untuk mendapatkan detail profile hotspot
// Catatan PENTING:
//   - Untuk halaman /admin/mikrotik/hotspot-profiles kita SELALU ambil langsung ke Mikrotik,
//     tidak lagi mengacu ke RADIUS, terlepas dari user_auth_mode.
async function getHotspotProfileDetail(id, routerObj = null) {
    try {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: null };
        }
        
        const result = await conn.write('/ip/hotspot/user/profile/print', [
            '?.id=' + id
        ]);
        
        if (result && result.length > 0) {
            return { success: true, data: result[0] };
        } else {
            return { success: false, message: 'Profile tidak ditemukan', data: null };
        }
    } catch (error) {
        logger.error(`Error getting hotspot profile detail: ${error.message}`);
        return { success: false, message: error.message, data: null };
    }
}
// Fungsi untuk mendapatkan daftar server hotspot
async function getHotspotServers(routerObj = null) {
    try {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: [] };
        }
        
        const result = await conn.write('/ip/hotspot/print');
        
        if (result && Array.isArray(result)) {
            const servers = result.map(server => ({
                id: server['.id'],
                name: server.name,
                interface: server.interface,
                profile: server.profile || '',
                addressPool: server['address-pool'] || '',
                address: server['address-pool'] || '', // Alias untuk kompatibilitas
                disabled: server.disabled === 'true',
                nas_id: routerObj ? routerObj.id : null,
                nas_name: routerObj ? routerObj.name : null,
                nas_ip: routerObj ? routerObj.nas_ip : null,
                nas_identifier: routerObj ? (routerObj.nas_identifier || routerObj.nasIdentifier || null) : null
            }));
            return { success: true, data: servers };
        } else {
            return { success: false, message: 'Gagal mendapatkan server hotspot', data: [] };
        }
    } catch (error) {
        logger.error(`Error getting hotspot servers: ${error.message}`);
        return { success: false, message: error.message, data: [] };
    }
}
// Fungsi untuk menambah Server Hotspot ke Mikrotik
async function addHotspotServer(serverData, routerObj = null) {
    try {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }

        const { name, interface: interfaceName, profile, addressPool, disabled } = serverData;

        if (!name || !name.trim()) {
            return { success: false, message: 'Nama server hotspot harus diisi' };
        }

        if (!interfaceName || !interfaceName.trim()) {
            return { success: false, message: 'Interface harus dipilih' };
        }

        const params = [
            '=name=' + String(name).trim(),
            '=interface=' + String(interfaceName).trim()
        ];

        if (profile && String(profile).trim() !== '') {
            params.push('=profile=' + String(profile).trim());
        }

        if (addressPool && String(addressPool).trim() !== '') {
            params.push('=address-pool=' + String(addressPool).trim());
        }

        if (disabled === 'true' || disabled === true) {
            params.push('=disabled=yes');
        }

        await conn.write('/ip/hotspot/add', params);

        logger.info(`Successfully added hotspot server: ${name} on interface ${interfaceName}`);
        return { success: true, message: `Server hotspot "${name}" berhasil ditambahkan` };
    } catch (error) {
        logger.error(`Error adding hotspot server: ${error.message}`);
        return { success: false, message: `Gagal menambah server hotspot: ${error.message}` };
    }
}

// Fungsi untuk mengedit Server Hotspot di Mikrotik
async function editHotspotServer(serverId, serverData, routerObj = null) {
    try {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }

        const { name, interface: interfaceName, profile, addressPool, disabled } = serverData;

        const params = ['=.id=' + serverId];

        if (name && String(name).trim() !== '') {
            params.push('=name=' + String(name).trim());
        }

        if (interfaceName && String(interfaceName).trim() !== '') {
            params.push('=interface=' + String(interfaceName).trim());
        }

        if (profile !== undefined) {
            if (profile && String(profile).trim() !== '') {
                params.push('=profile=' + String(profile).trim());
            } else {
                params.push('=profile=');
            }
        }

        if (addressPool !== undefined) {
            if (addressPool && String(addressPool).trim() !== '') {
                params.push('=address-pool=' + String(addressPool).trim());
            } else {
                params.push('=address-pool=');
            }
        }

        if (disabled !== undefined) {
            params.push(disabled === 'true' || disabled === true ? '=disabled=yes' : '=disabled=no');
        }

        await conn.write('/ip/hotspot/set', params);

        logger.info(`Successfully updated hotspot server: ID ${serverId}`);
        return { success: true, message: 'Server hotspot berhasil diupdate' };
    } catch (error) {
        logger.error(`Error editing hotspot server: ${error.message}`);
        return { success: false, message: `Gagal update server hotspot: ${error.message}` };
    }
}

// Fungsi untuk menghapus Server Hotspot dari Mikrotik
async function deleteHotspotServer(serverId, routerObj = null) {
    try {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }

        await conn.write('/ip/hotspot/remove', ['=.id=' + serverId]);

        logger.info(`Successfully deleted hotspot server: ID ${serverId}`);
        return { success: true, message: 'Server hotspot berhasil dihapus' };
    } catch (error) {
        logger.error(`Error deleting hotspot server: ${error.message}`);
        return { success: false, message: `Gagal menghapus server hotspot: ${error.message}` };
    }
}
// Fungsi untuk mendapatkan detail Server Hotspot dari Mikrotik
async function getHotspotServerDetail(serverId, routerObj = null) {
    try {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: null };
        }

        const result = await conn.write('/ip/hotspot/print', ['?.id=' + serverId]);

        if (result && Array.isArray(result) && result.length > 0) {
            const server = result[0];
            return {
                success: true,
                data: {
                    id: server['.id'],
                    name: server.name,
                    interface: server.interface,
                    profile: server.profile || '',
                    addressPool: server['address-pool'] || '',
                    disabled: server.disabled === 'true',
                    nas_id: routerObj ? routerObj.id : null,
                    nas_name: routerObj ? routerObj.name : null,
                    nas_ip: routerObj ? routerObj.nas_ip : null,
                    nas_identifier: routerObj ? (routerObj.nas_identifier || routerObj.nasIdentifier || null) : null
                }
            };
        } else {
            return { success: false, message: 'Server hotspot tidak ditemukan', data: null };
        }
    } catch (error) {
        logger.error(`Error getting hotspot server detail: ${error.message}`);
        return { success: false, message: error.message, data: null };
    }
}
// Fungsi untuk menambah Server Profile Hotspot ke Mikrotik
async function addHotspotServerProfileMikrotik(profileData, routerObj = null) {
    let conn = null;
    try {
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }

        const { name, 'hotspot-address': hotspotAddress, 'dns-name': dnsName,
                'html-directory': htmlDirectory, 'html-directory-override': htmlDirectoryOverride,
                'rate-limit': rateLimit, 'http-proxy': httpProxy, 'http-proxy-port': httpProxyPort,
                'smtp-server': smtpServer, 'login-by': loginBy, 'mac-auth-mode': macAuthMode,
                'mac-auth-password': macAuthPassword, 'http-cookie-lifetime': httpCookieLifetime,
                'ssl-certificate': sslCertificate, 'https-redirect': httpsRedirect,
                'split-user-domain': splitUserDomain, 'trial-uptime-limit': trialUptimeLimit,
                'trial-uptime-reset': trialUptimeReset, 'trial-user-profile': trialUserProfile,
                'use-radius': useRadius, 'default-domain': defaultDomain, 'location-id': locationId,
                'location-name': locationName, 'mac-format': macFormat, 'accounting': accounting,
                'interim-update': interimUpdate, 'nas-port-type': nasPortType,
                disabled, comment } = profileData;

        if (!name || !name.trim()) {
            return { success: false, message: 'Nama server profile harus diisi' };
        }

        const params = ['=name=' + String(name).trim()];

        // Parameter wajib untuk Server Profile di RouterOS v6.49
        if (hotspotAddress && String(hotspotAddress).trim() !== '') {
            params.push('=hotspot-address=' + String(hotspotAddress).trim());
        }

        if (dnsName && String(dnsName).trim() !== '') {
            params.push('=dns-name=' + String(dnsName).trim());
        }

        // General Tab Parameters
        if (htmlDirectory && String(htmlDirectory).trim() !== '') {
            params.push('=html-directory=' + String(htmlDirectory).trim());
        }

        if (htmlDirectoryOverride && String(htmlDirectoryOverride).trim() !== '') {
            params.push('=html-directory-override=' + String(htmlDirectoryOverride).trim());
        }

        if (rateLimit && String(rateLimit).trim() !== '') {
            params.push('=rate-limit=' + String(rateLimit).trim());
        }

        if (httpProxy && String(httpProxy).trim() !== '') {
            params.push('=http-proxy=' + String(httpProxy).trim());
        }

        if (httpProxyPort !== undefined && httpProxyPort !== null && String(httpProxyPort).trim() !== '') {
            params.push('=http-proxy-port=' + String(httpProxyPort).trim());
        }

        if (smtpServer && String(smtpServer).trim() !== '') {
            params.push('=smtp-server=' + String(smtpServer).trim());
        }

        // CATATAN: Parameter berikut ini TIDAK DIDUKUNG untuk Server Profile di RouterOS v6.49:
        // - login-by (hanya untuk User Profile)
        // - mac-auth-mode (hanya untuk User Profile)
        // - mac-auth-password (hanya untuk User Profile)
        // - http-cookie-lifetime (hanya untuk User Profile)
        // - ssl-certificate (hanya untuk User Profile atau Server Hotspot)
        // - https-redirect (hanya untuk User Profile)
        // - split-user-domain (hanya untuk User Profile)
        // - trial-uptime-limit (hanya untuk User Profile)
        // - trial-uptime-reset (hanya untuk User Profile)
        // - trial-user-profile (hanya untuk User Profile)
        // - use-radius (hanya untuk User Profile atau Server Hotspot, bukan Server Profile)
        // - default-domain (hanya untuk User Profile)
        // - location-id (hanya untuk User Profile)
        // - location-name (hanya untuk User Profile)
        // - mac-format (hanya untuk User Profile)
        // - accounting (hanya untuk User Profile atau Server Hotspot, bukan Server Profile)
        // - interim-update (hanya untuk User Profile)
        // - nas-port-type (hanya untuk User Profile)
        // 
        // CATATAN: Parameter Login Tab dan RADIUS Tab tidak didukung untuk Server Profile di RouterOS v6.49
        // Hanya parameter General Tab yang didukung

        // Common Parameters
        if (comment && String(comment).trim() !== '') {
            params.push('=comment=' + String(comment).trim());
        }

        // Untuk RouterOS v6.49, gunakan /ip/hotspot/profile/add (Server Profile)
        // JANGAN gunakan /ip/hotspot/user/profile/add karena itu untuk User Profile, bukan Server Profile!
        logger.info(`Attempting to add server profile "${name}" to router ${routerObj ? routerObj.name : 'default'}`);
        logger.info(`Parameters to send: ${JSON.stringify(params)}`);
        
        try {
            await conn.write('/ip/hotspot/profile/add', params);
            logger.info(`Successfully added hotspot server profile: ${name} (using /ip/hotspot/profile/add)`);
            
            // Delay sebentar untuk memastikan perubahan tersimpan
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // Verify profile was created by querying it
            try {
                const verifyProfiles = await conn.write('/ip/hotspot/profile/print', ['?name=' + String(name).trim()]);
                if (verifyProfiles && verifyProfiles.length > 0) {
                    logger.info(`Profile "${name}" verified successfully in Mikrotik`);
                } else {
                    logger.warn(`Profile "${name}" created but not found during verification`);
                }
            } catch (verifyError) {
                logger.warn(`Could not verify profile after creation: ${verifyError.message}`);
            }
            
            // Close connection if created for this router
            if (routerObj && conn && typeof conn.close === 'function') {
                try {
                    await conn.close();
                } catch (closeError) {
                    logger.warn('Error closing connection:', closeError.message);
                }
            }
            
            return { success: true, message: `Server profile "${name}" berhasil ditambahkan` };
        } catch (cmdError) {
            logger.error(`Command /ip/hotspot/profile/add tidak tersedia atau gagal: ${cmdError.message}`);
            logger.error(`Parameters that failed: ${JSON.stringify(params)}`);
            
            // Close connection on error
            if (routerObj && conn && typeof conn.close === 'function') {
                try {
                    await conn.close();
                } catch (closeError) {
                    // Ignore
                }
            }
            
            // Berikan error message yang lebih informatif
            let errorMsg = `Gagal menambah server profile: ${cmdError.message}`;
            if (cmdError.message.includes('unknown parameter')) {
                errorMsg += `. Pastikan semua parameter yang digunakan didukung oleh RouterOS v6.49. Parameter yang dikirim: ${params.join(', ')}`;
            }
            
            return { 
                success: false, 
                message: errorMsg
            };
        }
    } catch (error) {
        logger.error(`Error adding hotspot server profile: ${error.message}`);
        
        // Close connection on error
        if (routerObj && conn && typeof conn.close === 'function') {
            try {
                await conn.close();
            } catch (closeError) {
                // Ignore
            }
        }
        
        return { success: false, message: `Gagal menambah server profile: ${error.message}` };
    }
}
// Fungsi untuk mengedit Server Profile Hotspot di Mikrotik
async function editHotspotServerProfileMikrotik(profileId, profileData, routerObj = null) {
    let conn = null;
    try {
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }

        const { name, 'hotspot-address': hotspotAddress, 'dns-name': dnsName,
                'html-directory': htmlDirectory, 'html-directory-override': htmlDirectoryOverride,
                'rate-limit': rateLimit, 'http-proxy': httpProxy, 'http-proxy-port': httpProxyPort,
                'smtp-server': smtpServer, 'login-by': loginBy, 'mac-auth-mode': macAuthMode,
                'mac-auth-password': macAuthPassword, 'http-cookie-lifetime': httpCookieLifetime,
                'ssl-certificate': sslCertificate, 'https-redirect': httpsRedirect,
                'split-user-domain': splitUserDomain, 'trial-uptime-limit': trialUptimeLimit,
                'trial-uptime-reset': trialUptimeReset, 'trial-user-profile': trialUserProfile,
                'use-radius': useRadius, 'default-domain': defaultDomain, 'location-id': locationId,
                'location-name': locationName, 'mac-format': macFormat, 'accounting': accounting,
                'interim-update': interimUpdate, 'nas-port-type': nasPortType,
                disabled, comment } = profileData;

        const params = ['=.id=' + profileId];

        if (name && String(name).trim() !== '') {
            params.push('=name=' + String(name).trim());
        }

        // Parameter yang didukung untuk Server Profile di RouterOS v6.49
        // Hanya kirim jika nilainya tidak kosong
        if (hotspotAddress !== undefined && hotspotAddress !== null && String(hotspotAddress).trim() !== '') {
            params.push('=hotspot-address=' + String(hotspotAddress).trim());
        }

        if (dnsName !== undefined && dnsName !== null && String(dnsName).trim() !== '') {
            params.push('=dns-name=' + String(dnsName).trim());
        }

        // General Tab Parameters - hanya kirim jika ada nilai
        if (htmlDirectory !== undefined && htmlDirectory !== null && String(htmlDirectory).trim() !== '') {
            params.push('=html-directory=' + String(htmlDirectory).trim());
        }

        if (htmlDirectoryOverride !== undefined && htmlDirectoryOverride !== null && String(htmlDirectoryOverride).trim() !== '') {
            params.push('=html-directory-override=' + String(htmlDirectoryOverride).trim());
        }

        if (rateLimit !== undefined && rateLimit !== null && String(rateLimit).trim() !== '') {
            params.push('=rate-limit=' + String(rateLimit).trim());
        }

        if (httpProxy !== undefined && httpProxy !== null && String(httpProxy).trim() !== '') {
            params.push('=http-proxy=' + String(httpProxy).trim());
        }

        if (httpProxyPort !== undefined && httpProxyPort !== null && String(httpProxyPort).trim() !== '' && httpProxyPort !== '0') {
            params.push('=http-proxy-port=' + String(httpProxyPort).trim());
        }

        if (smtpServer !== undefined && smtpServer !== null && String(smtpServer).trim() !== '') {
            params.push('=smtp-server=' + String(smtpServer).trim());
        }

        // CATATAN: Parameter berikut ini MUNGKIN TIDAK DIDUKUNG untuk Server Profile di RouterOS v6.49:
        // - login-by (hanya untuk User Profile)
        // - mac-auth-mode (hanya untuk User Profile)
        // - mac-auth-password (hanya untuk User Profile)
        // - http-cookie-lifetime (hanya untuk User Profile)
        // - ssl-certificate (hanya untuk User Profile atau Server Hotspot)
        // - https-redirect (hanya untuk User Profile)
        // - split-user-domain (hanya untuk User Profile)
        // - trial-uptime-limit (hanya untuk User Profile)
        // - trial-uptime-reset (hanya untuk User Profile)
        // - trial-user-profile (hanya untuk User Profile)
        // - use-radius (hanya untuk User Profile atau Server Hotspot, bukan Server Profile)
        // - default-domain (hanya untuk User Profile)
        // - location-id (hanya untuk User Profile)
        // - location-name (hanya untuk User Profile)
        // - mac-format (hanya untuk User Profile)
        // - accounting (hanya untuk User Profile atau Server Hotspot, bukan Server Profile)
        // - interim-update (hanya untuk User Profile)
        // - nas-port-type (hanya untuk User Profile)
        // 
        // CATATAN: Parameter Login Tab dan RADIUS Tab tidak didukung untuk Server Profile di RouterOS v6.49
        // Hanya parameter General Tab yang didukung

        // Common Parameters
        if (comment !== undefined && comment !== null && String(comment).trim() !== '') {
            params.push('=comment=' + String(comment).trim());
        }

        // Untuk RouterOS v6.49, gunakan /ip/hotspot/profile/set (Server Profile)
        // JANGAN gunakan /ip/hotspot/user/profile/set karena itu untuk User Profile!
        logger.info(`Attempting to edit server profile ID ${profileId} for router ${routerObj ? routerObj.name : 'default'}`);
        logger.info(`Parameters to send: ${JSON.stringify(params)}`);
        
        try {
            await conn.write('/ip/hotspot/profile/set', params);
            logger.info(`Successfully updated hotspot server profile: ID ${profileId} (using /ip/hotspot/profile/set)`);
            
            // Close connection if created for this router
            if (routerObj && conn && typeof conn.close === 'function') {
                try {
                    await conn.close();
                } catch (closeError) {
                    logger.warn('Error closing connection:', closeError.message);
                }
            }
            
            return { success: true, message: 'Server profile berhasil diupdate' };
        } catch (cmdError) {
            logger.error(`Command /ip/hotspot/profile/set tidak tersedia atau gagal: ${cmdError.message}`);
            logger.error(`Parameters that failed: ${JSON.stringify(params)}`);
            
            // Close connection on error
            if (routerObj && conn && typeof conn.close === 'function') {
                try {
                    await conn.close();
                } catch (closeError) {
                    // Ignore
                }
            }
            
            // Berikan error message yang lebih informatif
            let errorMsg = `Gagal update server profile: ${cmdError.message}`;
            if (cmdError.message.includes('unknown parameter')) {
                errorMsg += `. Pastikan semua parameter yang digunakan didukung oleh RouterOS v6.49. Parameter yang dikirim: ${params.join(', ')}`;
            }
            
            return { 
                success: false, 
                message: errorMsg
            };
        }
    } catch (error) {
        logger.error(`Error editing hotspot server profile: ${error.message}`);
        
        // Close connection on error
        if (routerObj && conn && typeof conn.close === 'function') {
            try {
                await conn.close();
            } catch (closeError) {
                // Ignore
            }
        }
        
        return { success: false, message: `Gagal update server profile: ${error.message}` };
    }
}
// Fungsi untuk menghapus Server Profile Hotspot dari Mikrotik
async function deleteHotspotServerProfileMikrotik(profileId, routerObj = null) {
    let conn = null;
    try {
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }

        // Untuk RouterOS v6.49, gunakan /ip/hotspot/profile/remove (Server Profile)
        // JANGAN gunakan /ip/hotspot/user/profile/remove karena itu untuk User Profile!
        try {
            await conn.write('/ip/hotspot/profile/remove', ['=.id=' + profileId]);
            logger.info(`Successfully deleted hotspot server profile: ID ${profileId} (using /ip/hotspot/profile/remove)`);
            
            // Close connection if created for this router
            if (routerObj && conn && typeof conn.close === 'function') {
                try {
                    await conn.close();
                } catch (closeError) {
                    logger.warn('Error closing connection:', closeError.message);
                }
            }
            
            return { success: true, message: 'Server profile berhasil dihapus' };
        } catch (cmdError) {
            logger.error(`Command /ip/hotspot/profile/remove tidak tersedia atau gagal: ${cmdError.message}`);
            
            // Close connection on error
            if (routerObj && conn && typeof conn.close === 'function') {
                try {
                    await conn.close();
                } catch (closeError) {
                    // Ignore
                }
            }
            
            // JANGAN fallback ke /ip/hotspot/user/profile karena itu bukan Server Profile!
            return { 
                success: false, 
                message: `Gagal menghapus server profile: Command /ip/hotspot/profile/remove tidak tersedia. Pastikan RouterOS versi 6.49 atau lebih baru. Error: ${cmdError.message}` 
            };
        }
    } catch (error) {
        logger.error(`Error deleting hotspot server profile: ${error.message}`);
        
        // Close connection on error
        if (routerObj && conn && typeof conn.close === 'function') {
            try {
                await conn.close();
            } catch (closeError) {
                // Ignore
            }
        }
        
        return { success: false, message: `Gagal menghapus server profile: ${error.message}` };
    }
}

// Fungsi untuk memutus koneksi user hotspot aktif
async function disconnectHotspotUser(username, routerObj = null) {
    try {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }
        
        // Cari ID koneksi aktif berdasarkan username
        const activeUsers = await conn.write('/ip/hotspot/active/print', [
            '?user=' + username
        ]);
        
        if (!activeUsers || activeUsers.length === 0) {
            return { success: false, message: `User ${username} tidak ditemukan atau tidak aktif` };
        }
        
        // Putus koneksi user dengan ID yang ditemukan
        await conn.write('/ip/hotspot/active/remove', [
            '=.id=' + activeUsers[0]['.id']
        ]);
        
        logger.info(`Disconnected hotspot user: ${username}`);
        return { success: true, message: `User ${username} berhasil diputus` };
    } catch (error) {
        logger.error(`Error disconnecting hotspot user: ${error.message}`);
        return { success: false, message: error.message };
    }
}
// Fungsi untuk menambah profile hotspot
async function addHotspotProfile(profileData, routerObj = null) {
    try {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }
        
        const {
            name,
            comment,
            rateLimit,
            rateLimitUnit,
            sessionTimeout,
            sessionTimeoutUnit,
            idleTimeout,
            idleTimeoutUnit,
            localAddress,
            remoteAddress,
            dnsServer,
            parentQueue,
            addressList,
            sharedUsers,
            limitUptimeValue,
            limitUptimeUnit,
            validityValue,
            validityUnit
        } = profileData;
        
        // PENTING: Gunakan hanya parameter yang didukung oleh /ip/hotspot/user/profile/add
        // Beberapa parameter mungkin menyebabkan "unknown parameter" error pada versi ROS tertentu
        
        const params = [
            '=name=' + String(name).trim()
        ];
        
        // Comment - safe field
        if (comment && comment.trim()) {
            params.push('=comment=' + String(comment).trim());
        }
        
        // Rate limit: format 'upload/download' (same value for both if only one provided)
        if (rateLimit && rateLimitUnit && String(rateLimit).trim() !== '' && String(rateLimitUnit).trim() !== '') {
            const rateLimitValue = String(rateLimit).trim();
            let rateLimitUnitValue = String(rateLimitUnit).trim().toLowerCase();
            if (['k', 'm', 'g', 'K', 'M', 'G'].includes(rateLimitUnitValue)) {
                if (rateLimitUnitValue === 'm' || rateLimitUnitValue === 'M') rateLimitUnitValue = 'M';
                else if (rateLimitUnitValue === 'g' || rateLimitUnitValue === 'G') rateLimitUnitValue = 'G';
                else if (rateLimitUnitValue === 'k' || rateLimitUnitValue === 'K') rateLimitUnitValue = 'K';
                const numValue = parseInt(rateLimitValue);
                if (!isNaN(numValue) && numValue > 0) {
                    // Format: upload/download (same value for both)
                    const rateLimitFormatted = numValue + rateLimitUnitValue + '/' + numValue + rateLimitUnitValue;
                    params.push('=rate-limit=' + rateLimitFormatted);
                }
            }
        }
        
        // Session timeout: only add if both value and unit are valid
        if (sessionTimeout && sessionTimeoutUnit && String(sessionTimeout).trim() !== '' && String(sessionTimeoutUnit).trim() !== '') {
            const sessionTimeoutValue = String(sessionTimeout).trim();
            let sessionTimeoutUnitValue = String(sessionTimeoutUnit).trim().toLowerCase();
            const timeoutUnitMap = { 'detik': 's', 's': 's', 'menit': 'm', 'men': 'm', 'm': 'm', 'jam': 'h', 'h': 'h', 'hari': 'd', 'd': 'd' };
            if (timeoutUnitMap[sessionTimeoutUnitValue]) {
                sessionTimeoutUnitValue = timeoutUnitMap[sessionTimeoutUnitValue];
                const numValue = parseInt(sessionTimeoutValue);
                if (!isNaN(numValue) && numValue > 0) {
                    params.push('=session-timeout=' + numValue + sessionTimeoutUnitValue);
                }
            }
        }
        
        // Idle timeout: only add if both value and unit are valid
        if (idleTimeout && idleTimeoutUnit && String(idleTimeout).trim() !== '' && String(idleTimeoutUnit).trim() !== '') {
            const idleTimeoutValue = String(idleTimeout).trim();
            let idleTimeoutUnitValue = String(idleTimeoutUnit).trim().toLowerCase();
            const timeoutUnitMap = { 'detik': 's', 's': 's', 'menit': 'm', 'men': 'm', 'm': 'm', 'jam': 'h', 'h': 'h', 'hari': 'd', 'd': 'd' };
            if (timeoutUnitMap[idleTimeoutUnitValue]) {
                idleTimeoutUnitValue = timeoutUnitMap[idleTimeoutUnitValue];
                const numValue = parseInt(idleTimeoutValue);
                if (!isNaN(numValue) && numValue > 0) {
                    params.push('=idle-timeout=' + numValue + idleTimeoutUnitValue);
                }
            }
        }
        
        // SKIP: local-address, remote-address, dns-server, parent-queue, address-list
        // These parameters may not be supported or cause "unknown parameter" error
        
        // Shared users: valid field - only if value is valid positive integer
        if (sharedUsers !== undefined && sharedUsers !== null && String(sharedUsers).trim() !== '' && String(sharedUsers).trim() !== '0') {
            const sharedUsersValue = parseInt(String(sharedUsers).trim());
            if (!isNaN(sharedUsersValue) && sharedUsersValue > 0) {
                params.push('=shared-users=' + sharedUsersValue);
            }
        }
        
        // Limit uptime: valid field - only if value is valid positive integer
        if (limitUptimeValue !== undefined && limitUptimeValue !== null && String(limitUptimeValue).trim() !== '' && String(limitUptimeValue).trim() !== '0') {
            const limitUptimeValueValue = parseInt(String(limitUptimeValue).trim());
            if (!isNaN(limitUptimeValueValue) && limitUptimeValueValue > 0) {
                params.push('=limit-uptime=' + limitUptimeValueValue);
            }
        }
        
        // Validity: valid field - only if value is valid positive integer
        if (validityValue !== undefined && validityValue !== null && String(validityValue).trim() !== '' && String(validityValue).trim() !== '0') {
            const validityValueValue = parseInt(String(validityValue).trim());
            if (!isNaN(validityValueValue) && validityValueValue > 0) {
                params.push('=validity=' + validityValueValue);
            }
        }
        
        logger.info(`Adding hotspot profile with params: ${JSON.stringify(params)}`);
        
        await conn.write('/ip/hotspot/user/profile/add', params);
        
        logger.info(`Hotspot profile '${String(profileData.name).trim()}' berhasil ditambahkan`);
        return { success: true, message: 'Profile hotspot berhasil ditambahkan' };
    } catch (error) {
        logger.error(`Error adding hotspot profile: ${error.message}`);
        return { success: false, message: error.message || 'Gagal menambahkan profile hotspot' };
    }
}

// Fungsi untuk edit profile hotspot
async function editHotspotProfile(profileData, routerObj = null) {
    try {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }
        
        const {
            id,
            name,
            comment,
            // rateLimit boleh berupa string langsung (mis. "2M/5M 5M/10M")
            // atau legacy: angka + unit
            rateLimit,
            rateLimitUnit,
            sessionTimeout,
            sessionTimeoutUnit,
            idleTimeout,
            idleTimeoutUnit,
            localAddress,
            remoteAddress,
            dnsServer,
            parentQueue,
            addressList,
            sharedUsers,
            limitUptimeValue,
            limitUptimeUnit,
            validityValue,
            validityUnit
        } = profileData;
        
        const params = [
            '=.id=' + id,
            '=name=' + name
        ];
        
        // Comment - safe parameter
        if (comment !== undefined && comment !== null && String(comment).trim() !== '') {
            params.push('=comment=' + String(comment).trim());
        }
        
        // Rate limit:
        // - Jika user kirim string lengkap (mis. "2M/5M 5M/10M"), kirim apa adanya.
        // - Jika tidak, fallback ke format legacy angka + unit.
        if (rateLimit && String(rateLimit).trim() !== '') {
            const rateLimitStr = String(rateLimit).trim();
            if (/[kKmMgG]/.test(rateLimitStr) || rateLimitStr.includes('/')) {
                // Sudah dalam format Mikrotik
                params.push('=rate-limit=' + rateLimitStr);
                logger.info(`Rate limit (raw edit) dikirim: ${rateLimitStr}`);
            } else if (rateLimitUnit && String(rateLimitUnit).trim() !== '') {
                const rateLimitValue = rateLimitStr;
                let rateLimitUnitValue = String(rateLimitUnit).trim().toLowerCase();
                if (['k', 'm', 'g'].includes(rateLimitUnitValue)) {
                    if (rateLimitUnitValue === 'm') rateLimitUnitValue = 'M';
                    if (rateLimitUnitValue === 'g') rateLimitUnitValue = 'G';
                    if (rateLimitUnitValue === 'k') rateLimitUnitValue = 'K';
                    const numValue = parseInt(rateLimitValue);
                    if (!isNaN(numValue) && numValue > 0) {
                        const rateLimitFormatted = numValue + rateLimitUnitValue + '/' + numValue + rateLimitUnitValue;
                        params.push('=rate-limit=' + rateLimitFormatted);
                        logger.info(`Rate limit formatted (edit legacy): ${rateLimitFormatted}`);
                    } else {
                        logger.warn(`Invalid rate limit value (edit): ${rateLimitValue} (not a valid number)`);
                    }
                } else {
                    logger.warn(`Invalid rate limit unit (edit): ${rateLimitUnitValue} (expected k/m/g)`);
                }
            }
        } else if (rateLimit === '' || rateLimit === null || rateLimit === undefined) {
            // Allow clearing rate limit
            params.push('=rate-limit=');
            logger.info('Rate limit cleared (empty value)');
        }
        
        // Session timeout: hanya kirim jika nilai dan unit valid (>0)
        // Jika input kosong, TIDAK mengirim parameter ini sama sekali (biarkan nilai lama di Mikrotik).
        if (sessionTimeout && sessionTimeoutUnit && String(sessionTimeout).trim() !== '' && String(sessionTimeoutUnit).trim() !== '') {
            const sessionTimeoutValue = String(sessionTimeout).trim();
            let sessionTimeoutUnitValue = String(sessionTimeoutUnit).trim().toLowerCase();
            const timeoutUnitMap = { 'detik': 's', 's': 's', 'menit': 'm', 'men': 'm', 'm': 'm', 'jam': 'h', 'h': 'h', 'hari': 'd', 'd': 'd' };
            if (timeoutUnitMap[sessionTimeoutUnitValue]) {
                sessionTimeoutUnitValue = timeoutUnitMap[sessionTimeoutUnitValue];
                const numValue = parseInt(sessionTimeoutValue);
                if (!isNaN(numValue) && numValue > 0) {
                    params.push('=session-timeout=' + numValue + sessionTimeoutUnitValue);
                }
            }
        }
        
        // Idle timeout: hanya kirim jika nilai dan unit valid (>0)
        // Jika input kosong, TIDAK mengirim parameter ini sama sekali.
        if (idleTimeout && idleTimeoutUnit && String(idleTimeout).trim() !== '' && String(idleTimeoutUnit).trim() !== '') {
            const idleTimeoutValue = String(idleTimeout).trim();
            let idleTimeoutUnitValue = String(idleTimeoutUnit).trim().toLowerCase();
            const timeoutUnitMap = { 'detik': 's', 's': 's', 'menit': 'm', 'men': 'm', 'm': 'm', 'jam': 'h', 'h': 'h', 'hari': 'd', 'd': 'd' };
            if (timeoutUnitMap[idleTimeoutUnitValue]) {
                idleTimeoutUnitValue = timeoutUnitMap[idleTimeoutUnitValue];
                const numValue = parseInt(idleTimeoutValue);
                if (!isNaN(numValue) && numValue > 0) {
                    params.push('=idle-timeout=' + numValue + idleTimeoutUnitValue);
                }
            }
        }
        // SKIP: local-address, remote-address, dns-server, parent-queue, address-list
        // These parameters are NOT supported for hotspot user profile in Mikrotik
        // They may cause "unknown parameter" error
        
        // Shared users: valid field - only if value is valid positive integer
        if (sharedUsers !== undefined && sharedUsers !== null && String(sharedUsers).trim() !== '' && String(sharedUsers).trim() !== '0') {
            const sharedUsersValue = parseInt(String(sharedUsers).trim());
            if (!isNaN(sharedUsersValue) && sharedUsersValue > 0) {
                params.push('=shared-users=' + sharedUsersValue);
            }
        }
        
        // Limit uptime: valid field - only if value is valid positive integer
        if (limitUptimeValue !== undefined && limitUptimeValue !== null && String(limitUptimeValue).trim() !== '' && String(limitUptimeValue).trim() !== '0') {
            const limitUptimeValueValue = parseInt(String(limitUptimeValue).trim());
            if (!isNaN(limitUptimeValueValue) && limitUptimeValueValue > 0) {
                params.push('=limit-uptime=' + limitUptimeValueValue);
            }
        }
        
        // Validity: valid field - only if value is valid positive integer
        if (validityValue !== undefined && validityValue !== null && String(validityValue).trim() !== '' && String(validityValue).trim() !== '0') {
            const validityValueValue = parseInt(String(validityValue).trim());
            if (!isNaN(validityValueValue) && validityValueValue > 0) {
                params.push('=validity=' + validityValueValue);
            }
        }
        
        // Log parameters for debugging
        logger.info('=== Editing Hotspot Profile ===');
        logger.info('Profile ID:', id);
        logger.info('Name:', name);
        logger.info('Router:', routerObj ? `${routerObj.name} (${routerObj.nas_ip}:${routerObj.port || 8728})` : 'default');
        logger.info('Total params:', params.length);
        logger.info('Raw params:', JSON.stringify(params));
        params.forEach((p, idx) => {
            logger.info(`  Param ${idx + 1}: ${p}`);
        });
        
        try {
            await conn.write('/ip/hotspot/user/profile/set', params);
            logger.info('✓ Successfully updated hotspot profile:', name);
            
            // Close connection if created for this request
            if (routerObj && conn && typeof conn.close === 'function') {
                try {
                    await conn.close();
                } catch (closeError) {
                    logger.warn('Error closing connection:', closeError.message);
                }
            }
            
            return { success: true, message: 'Profile hotspot berhasil diupdate' };
        } catch (apiError) {
            logger.error('✗ Mikrotik API Error:', apiError.message);
            logger.error('Error stack:', apiError.stack);
            logger.error('Parameters that were sent:', JSON.stringify(params));
            
            // If error mentions "unknown parameter", try updating one by one
            if (apiError.message && apiError.message.toLowerCase().includes('unknown parameter')) {
                logger.warn('=== Unknown parameter error, trying step-by-step update ===');
                
                // Try updating with minimal parameters first (name, comment only)
                try {
                    logger.info('Attempt 1: Name and comment only');
                    const minimalParams = ['=.id=' + id, '=name=' + name];
                    if (comment !== undefined && comment !== null && String(comment).trim() !== '') {
                        minimalParams.push('=comment=' + String(comment).trim());
                    }
                    await conn.write('/ip/hotspot/user/profile/set', minimalParams);
                    logger.info('✓ Success with minimal params, now updating with other params one by one');
                    
                    // Update rate-limit
                    if (rateLimit && rateLimitUnit && String(rateLimit).trim() !== '' && String(rateLimitUnit).trim() !== '') {
                        const rateLimitValue = String(rateLimit).trim();
                        let rateLimitUnitValue = String(rateLimitUnit).trim().toLowerCase();
                        if (['k', 'm', 'g', 'K', 'M', 'G'].includes(rateLimitUnitValue)) {
                            if (rateLimitUnitValue === 'm' || rateLimitUnitValue === 'M') rateLimitUnitValue = 'M';
                            else if (rateLimitUnitValue === 'g' || rateLimitUnitValue === 'G') rateLimitUnitValue = 'G';
                            else if (rateLimitUnitValue === 'k' || rateLimitUnitValue === 'K') rateLimitUnitValue = 'K';
                            const numValue = parseInt(rateLimitValue);
                            if (!isNaN(numValue) && numValue > 0) {
                                const rateLimitFormatted = numValue + rateLimitUnitValue + '/' + numValue + rateLimitUnitValue;
                                try {
                                    await conn.write('/ip/hotspot/user/profile/set', ['=.id=' + id, '=rate-limit=' + rateLimitFormatted]);
                                    logger.info(`✓ Rate limit updated: ${rateLimitFormatted}`);
                                } catch (e) {
                                    logger.warn(`✗ Failed to update rate limit: ${e.message}`);
                                }
                            }
                        }
                    }
                    
                    // Update session-timeout
                    if (sessionTimeout && sessionTimeoutUnit && String(sessionTimeout).trim() !== '' && String(sessionTimeoutUnit).trim() !== '') {
                        const sessionTimeoutValue = String(sessionTimeout).trim();
                        let sessionTimeoutUnitValue = String(sessionTimeoutUnit).trim().toLowerCase();
                        // Map ke format standar Mikrotik: S, m, h, d
                        const timeoutUnitMap = { 
                            's': 's', 'detik': 's',           // detik
                            'm': 'm', 'menit': 'm', 'men': 'm', // menit (lowercase)
                            'h': 'h', 'jam': 'h',              // jam
                            'd': 'd', 'hari': 'd'              // hari
                        };
                        if (timeoutUnitMap[sessionTimeoutUnitValue]) {
                            sessionTimeoutUnitValue = timeoutUnitMap[sessionTimeoutUnitValue];
                            const numValue = parseInt(sessionTimeoutValue);
                            if (!isNaN(numValue) && numValue > 0) {
                                try {
                                    await conn.write('/ip/hotspot/user/profile/set', ['=.id=' + id, '=session-timeout=' + numValue + sessionTimeoutUnitValue]);
                                    logger.info(`✓ Session timeout updated: ${numValue}${sessionTimeoutUnitValue}`);
                                } catch (e) {
                                    logger.warn(`✗ Failed to update session timeout: ${e.message}`);
                                }
                            }
                        }
                    }
                    
                    // Update idle-timeout
                    if (idleTimeout && idleTimeoutUnit && String(idleTimeout).trim() !== '' && String(idleTimeoutUnit).trim() !== '') {
                        const idleTimeoutValue = String(idleTimeout).trim();
                        let idleTimeoutUnitValue = String(idleTimeoutUnit).trim().toLowerCase();
                        // Map ke format standar Mikrotik: S, m, h, d
                        const timeoutUnitMap = { 
                            's': 's', 'detik': 's',           // detik
                            'm': 'm', 'menit': 'm', 'men': 'm', // menit (lowercase)
                            'h': 'h', 'jam': 'h',              // jam
                            'd': 'd', 'hari': 'd'              // hari
                        };
                        if (timeoutUnitMap[idleTimeoutUnitValue]) {
                            idleTimeoutUnitValue = timeoutUnitMap[idleTimeoutUnitValue];
                            const numValue = parseInt(idleTimeoutValue);
                            if (!isNaN(numValue) && numValue > 0) {
                                try {
                                    await conn.write('/ip/hotspot/user/profile/set', ['=.id=' + id, '=idle-timeout=' + numValue + idleTimeoutUnitValue]);
                                    logger.info(`✓ Idle timeout updated: ${numValue}${idleTimeoutUnitValue}`);
                                } catch (e) {
                                    logger.warn(`✗ Failed to update idle timeout: ${e.message}`);
                                }
                            }
                        }
                    }
                    
                    // Update shared-users
                    if (sharedUsers !== undefined && sharedUsers !== null && String(sharedUsers).trim() !== '' && String(sharedUsers).trim() !== '0') {
                        const sharedUsersValue = parseInt(String(sharedUsers).trim());
                        if (!isNaN(sharedUsersValue) && sharedUsersValue > 0) {
                            try {
                                await conn.write('/ip/hotspot/user/profile/set', ['=.id=' + id, '=shared-users=' + sharedUsersValue]);
                                logger.info(`✓ Shared users updated: ${sharedUsersValue}`);
                            } catch (e) {
                                logger.warn(`✗ Failed to update shared users: ${e.message}`);
                            }
                        }
                    }
                    
                    // Update limit-uptime
                    if (limitUptimeValue !== undefined && limitUptimeValue !== null && String(limitUptimeValue).trim() !== '' && String(limitUptimeValue).trim() !== '0') {
                        const limitUptimeValueValue = parseInt(String(limitUptimeValue).trim());
                        if (!isNaN(limitUptimeValueValue) && limitUptimeValueValue > 0) {
                            try {
                                await conn.write('/ip/hotspot/user/profile/set', ['=.id=' + id, '=limit-uptime=' + limitUptimeValueValue]);
                                logger.info(`✓ Limit uptime updated: ${limitUptimeValueValue}`);
                            } catch (e) {
                                logger.warn(`✗ Failed to update limit uptime: ${e.message}`);
                            }
                        }
                    }
                    
                    // Update validity
                    if (validityValue !== undefined && validityValue !== null && String(validityValue).trim() !== '' && String(validityValue).trim() !== '0') {
                        const validityValueValue = parseInt(String(validityValue).trim());
                        if (!isNaN(validityValueValue) && validityValueValue > 0) {
                            try {
                                await conn.write('/ip/hotspot/user/profile/set', ['=.id=' + id, '=validity=' + validityValueValue]);
                                logger.info(`✓ Validity updated: ${validityValueValue}`);
                            } catch (e) {
                                logger.warn(`✗ Failed to update validity: ${e.message}`);
                            }
                        }
                    }
                    
                    logger.info('✓ Successfully updated profile step by step');
                    
                    // Close connection if created for this request
                    if (routerObj && conn && typeof conn.close === 'function') {
                        try {
                            await conn.close();
                        } catch (closeError) {
                            logger.warn('Error closing connection:', closeError.message);
                        }
                    }
                    
                    return { success: true, message: 'Profile hotspot berhasil diupdate' };
                } catch (fallbackError) {
                    logger.error(`Fallback approach also failed: ${fallbackError.message}`);
                    
                    // Close connection on error
                    if (routerObj && conn && typeof conn.close === 'function') {
                        try {
                            await conn.close();
                        } catch (closeError) {
                            // Ignore
                        }
                    }
                    
                    return { success: false, message: `Gagal mengupdate profile: ${fallbackError.message}. Coba dengan parameter yang lebih sederhana atau pastikan koneksi ke router berhasil.` };
                }
            }
            
            // Close connection before throwing
            if (routerObj && conn && typeof conn.close === 'function') {
                try {
                    await conn.close();
                } catch (closeError) {
                    // Ignore
                }
            }
            
            throw apiError;
        } finally {
            // Ensure connection is closed if it was created for this request
            if (routerObj && conn && typeof conn.close === 'function') {
                try {
                    await conn.close();
                } catch (closeError) {
                    // Ignore close errors
                }
            }
        }
    } catch (error) {
        logger.error(`Error editing hotspot profile: ${error.message}`);
        logger.error(`Error stack:`, error.stack);
        return { success: false, message: `Gagal mengupdate profile: ${error.message}` };
    }
}

// Fungsi untuk hapus profile hotspot
async function deleteHotspotProfile(id, routerObj = null) {
    try {
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }
        
        await conn.write('/ip/hotspot/user/profile/remove', [
            '=.id=' + id
        ]);
        
        return { success: true, message: 'Profile hotspot berhasil dihapus' };
    } catch (error) {
        logger.error(`Error deleting hotspot profile: ${error.message}`);
        return { success: false, message: `Gagal menghapus profile: ${error.message}` };
    }
}

// Fungsi untuk mendapatkan firewall rules
async function getFirewallRules(chain = '') {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: [] };
        }

        const params = [];
        if (chain) {
            params.push(`?chain=${chain}`);
        }

        const rules = await conn.write('/ip/firewall/filter/print', params);
        return {
            success: true,
            message: `Ditemukan ${rules.length} firewall rule${chain ? ` untuk chain ${chain}` : ''}`,
            data: rules
        };
    } catch (error) {
        logger.error(`Error getting firewall rules: ${error.message}`);
        return { success: false, message: `Gagal ambil data firewall rule: ${error.message}`, data: [] };
    }
}

// Fungsi untuk restart router
async function restartRouter() {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }

        await conn.write('/system/reboot');
        return { success: true, message: 'Router akan restart dalam beberapa detik' };
    } catch (error) {
        logger.error(`Error restarting router: ${error.message}`);
        return { success: false, message: `Gagal restart router: ${error.message}` };
    }
}

// Fungsi untuk mendapatkan identity router
async function getRouterIdentity() {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: null };
        }

        const identity = await conn.write('/system/identity/print');
        return {
            success: true,
            message: 'Identity router berhasil diambil',
            data: identity[0]
        };
    } catch (error) {
        logger.error(`Error getting router identity: ${error.message}`);
        return { success: false, message: `Gagal ambil identity router: ${error.message}`, data: null };
    }
}
// Fungsi untuk set identity router
async function setRouterIdentity(name) {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        }

        await conn.write('/system/identity/set', [
            `=name=${name}`
        ]);

        return { success: true, message: `Identity router berhasil diubah menjadi: ${name}` };
    } catch (error) {
        logger.error(`Error setting router identity: ${error.message}`);
        return { success: false, message: `Gagal mengubah identity router: ${error.message}` };
    }
}

// Fungsi untuk mendapatkan clock router
async function getRouterClock() {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: null };
        }

        const clock = await conn.write('/system/clock/print');
        return {
            success: true,
            message: 'Clock router berhasil diambil',
            data: clock[0]
        };
    } catch (error) {
        logger.error(`Error getting router clock: ${error.message}`);
        return { success: false, message: `Gagal ambil clock router: ${error.message}`, data: null };
    }
}

// Fungsi untuk mendapatkan semua user (hotspot + PPPoE)
async function getAllUsers() {
    try {
        // Ambil user hotspot
        const hotspotResult = await getActiveHotspotUsers();
        const hotspotUsers = hotspotResult.success ? hotspotResult.data : [];

        // Ambil user PPPoE aktif
        const pppoeResult = await getActivePPPoEConnections();
        const pppoeUsers = pppoeResult.success ? pppoeResult.data : [];

        // Ambil user PPPoE offline
        const offlineResult = await getInactivePPPoEUsers();
        const offlineUsers = offlineResult.success ? offlineResult.data : [];

        return {
            success: true,
            message: `Total: ${hotspotUsers.length} hotspot aktif, ${pppoeUsers.length} PPPoE aktif, ${offlineUsers.length} PPPoE offline`,
            data: {
                hotspotActive: hotspotUsers,
                pppoeActive: pppoeUsers,
                pppoeOffline: offlineUsers,
                totalActive: hotspotUsers.length + pppoeUsers.length,
                totalOffline: offlineUsers.length
            }
        };
    } catch (error) {
        logger.error(`Error getting all users: ${error.message}`);
        return { success: false, message: `Gagal ambil data semua user: ${error.message}`, data: null };
    }
}

// ...
// Fungsi tambah user PPPoE (alias addPPPoESecret)
async function addPPPoEUser({ username, password, profile, customer = null, routerObj = null }) {
    try {
        const mode = await getUserAuthModeAsync();
        logger.info(`[addPPPoEUser] Mode: ${mode}, username: ${username}, profile: ${profile}`);
        
        if (mode === 'radius') {
            logger.info(`[addPPPoEUser] Using RADIUS mode for user ${username}`);
            return await addPPPoEUserRadius({ username, password, profile });
        } else {
            logger.info(`[addPPPoEUser] Using Mikrotik API mode for user ${username}`);
            let conn = null;
            if (customer) {
                logger.info(`[addPPPoEUser] Getting connection for customer ID: ${customer.id}`);
                conn = await getMikrotikConnectionForCustomer(customer);
            } else if (routerObj) {
                logger.info(`[addPPPoEUser] Getting connection for router: ${routerObj.name || routerObj.nas_ip}`);
                conn = await getMikrotikConnectionForRouter(routerObj);
            } else {
                logger.info(`[addPPPoEUser] Using fallback connection`);
                conn = await getMikrotikConnection(); // fallback lama ONLY for admin use
            }
            if (!conn) {
                const errorMsg = 'Koneksi ke router gagal: Data router/NAS tidak ditemukan';
                logger.error(`[addPPPoEUser] ${errorMsg}`);
                return { success: false, message: errorMsg, error: errorMsg };
            }
            logger.info(`[addPPPoEUser] Connection established, calling addPPPoESecret`);
            const result = await addPPPoESecret(username, password, profile, '', conn);
            logger.info(`[addPPPoEUser] Result:`, JSON.stringify(result));
            return result;
        }
    } catch (error) {
        logger.error(`[addPPPoEUser] Error:`, error);
        logger.error(`[addPPPoEUser] Error stack:`, error.stack);
        return { success: false, message: `Gagal menambahkan user PPPoE: ${error.message}`, error: error.message };
    }
}
// Update user hotspot (password dan profile)
async function updateHotspotUser(username, password, profile) {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) throw new Error('Koneksi ke Mikrotik gagal');
        // Cari .id user berdasarkan username
        const users = await conn.write('/ip/hotspot/user/print', [
            '?name=' + username
        ]);
        if (!users.length) throw new Error('User tidak ditemukan');
        const id = users[0]['.id'];
        // Update password dan profile
        await conn.write('/ip/hotspot/user/set', [
            '=numbers=' + id,
            '=password=' + password,
            '=profile=' + profile
        ]);
        return true;
    } catch (err) {
        throw err;
    }
}
// Fungsi untuk generate voucher hotspot secara massal (versi lama - dihapus)
// Fungsi ini diganti dengan fungsi generateHotspotVouchers yang lebih lengkap di bawah
// Fungsi untuk mendapatkan daftar profile Hotspot dari RADIUS (yang digunakan oleh voucher users)
async function getHotspotProfilesRadius() {
    const conn = await getRadiusConnection();
    try {
        // Ambil daftar groupname yang digunakan oleh hotspot voucher users (yang ada di voucher_revenue)
        const sqlite3 = require('sqlite3').verbose();
        const dbPath = require('path').join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        const voucherUsernames = await new Promise((resolve, reject) => {
            db.all('SELECT DISTINCT username FROM voucher_revenue', [], (err, rows) => {
                if (err) {
                    logger.warn(`Error getting voucher usernames for hotspot profiles: ${err.message}`);
                    resolve([]);
                } else {
                    resolve(rows.map(r => r.username));
                }
            });
        });
        db.close();
        
        logger.info(`Found ${voucherUsernames.length} voucher usernames for hotspot profile filtering`);
        
        let groupnames = [];
        if (voucherUsernames.length > 0) {
            const placeholders = voucherUsernames.map(() => '?').join(',');
            const [groupRows] = await conn.execute(`
                SELECT DISTINCT groupname
                FROM radusergroup
                WHERE username IN (${placeholders})
                AND groupname IS NOT NULL AND groupname != ''
            `, voucherUsernames);
            groupnames = groupRows.map(row => row.groupname);
        }
        
        // Ambil groupname yang digunakan oleh member hotspot users (BUKAN PPPoE customers)
        let memberUsernames = [];
        try {
            const sqlite3 = require('sqlite3').verbose();
            const dbPath = require('path').join(__dirname, '../data/billing.db');
            const db = new sqlite3.Database(dbPath);
            
            memberUsernames = await new Promise((resolve, reject) => {
                db.all('SELECT DISTINCT hotspot_username FROM members WHERE hotspot_username IS NOT NULL AND hotspot_username != ""', [], (err, rows) => {
                    if (err) {
                        logger.warn(`Error getting member usernames: ${err.message}`);
                        resolve([]);
                    } else {
                        const usernames = rows.map(r => r.hotspot_username).filter(Boolean);
                        // Juga ambil username biasa jika hotspot_username tidak ada
                        db.all('SELECT DISTINCT username FROM members WHERE (hotspot_username IS NULL OR hotspot_username = "") AND username IS NOT NULL AND username != ""', [], (err2, rows2) => {
                            if (err2) {
                                resolve(usernames);
                            } else {
                                const additionalUsernames = rows2.map(r => r.username).filter(Boolean);
                                resolve([...usernames, ...additionalUsernames]);
                            }
                        });
                    }
                });
            });
            db.close();
        } catch (memberErr) {
            logger.warn(`Error getting member usernames for hotspot profiles: ${memberErr.message}`);
        }
        
        // Ambil groupname yang digunakan oleh PPPoE customers untuk di-exclude
        let pppoeUsernames = [];
        try {
            const sqlite3 = require('sqlite3').verbose();
            const dbPath = require('path').join(__dirname, '../data/billing.db');
            const db = new sqlite3.Database(dbPath);
            
            pppoeUsernames = await new Promise((resolve, reject) => {
                db.all('SELECT DISTINCT username FROM customers WHERE username IS NOT NULL AND username != ""', [], (err, rows) => {
                    if (err) {
                        logger.warn(`Error getting PPPoE customer usernames: ${err.message}`);
                        resolve([]);
                    } else {
                        resolve(rows.map(r => r.username).filter(Boolean));
                    }
                });
            });
            db.close();
        } catch (pppoeErr) {
            logger.warn(`Error getting PPPoE customer usernames: ${pppoeErr.message}`);
        }
        
        // Ambil groupname yang digunakan oleh PPPoE users untuk di-exclude
        let pppoeGroupnames = [];
        if (pppoeUsernames.length > 0) {
            const placeholders = pppoeUsernames.map(() => '?').join(',');
            const [pppoeGroupRows] = await conn.execute(`
                SELECT DISTINCT groupname
                FROM radusergroup
                WHERE username IN (${placeholders})
                AND groupname IS NOT NULL AND groupname != ''
            `, pppoeUsernames);
            pppoeGroupnames = pppoeGroupRows.map(row => row.groupname);
        }
        
        // Ambil groupname yang digunakan oleh member hotspot users
        let memberGroupnames = [];
        const allHotspotUsernames = [...new Set([...voucherUsernames, ...memberUsernames])];
        if (allHotspotUsernames.length > 0) {
            const placeholders = allHotspotUsernames.map(() => '?').join(',');
            const [memberGroupRows] = await conn.execute(`
                SELECT DISTINCT groupname
                FROM radusergroup
                WHERE username IN (${placeholders})
                AND groupname IS NOT NULL AND groupname != ''
            `, allHotspotUsernames);
            memberGroupnames = memberGroupRows.map(row => row.groupname);
        }
        
        // Ambil groupname dari hotspot_profiles metadata table (HANYA Hotspot Profile)
        let metadataGroupnames = [];
        try {
            if (await ensureHotspotProfilesMetadataTable(conn)) {
                const [metadataRows] = await conn.execute(`
                    SELECT groupname
                    FROM hotspot_profiles
                    WHERE groupname IS NOT NULL AND groupname != ''
                `);
                metadataGroupnames = metadataRows.map(row => row.groupname);
            }
        } catch (metaErr) {
            logger.warn(`Failed to load hotspot profile metadata groupnames: ${metaErr.message}`);
        }
        
        // Ambil groupname yang memiliki attribute khas Hotspot (MikroTik-Rate-Limit atau Session-Timeout)
        // Tapi exclude yang digunakan oleh PPPoE
        const [hotspotAttributeRows] = await conn.execute(`
            SELECT DISTINCT groupname
            FROM radgroupreply
            WHERE attribute IN ('MikroTik-Rate-Limit', 'Mikrotik-Rate-Limit', 'Session-Timeout')
            AND groupname IS NOT NULL AND groupname != ''
        `);
        
        // PENTING: Ambil semua groupname yang memiliki attribute khas PPPoE untuk di-exclude
        // Attribute khas PPPoE: Service-Type = Framed-User, Framed-Protocol = PPP, Framed-Pool, Framed-IP-Address
        const [pppoeAttributeRows] = await conn.execute(`
            SELECT DISTINCT groupname
            FROM radgroupreply
            WHERE attribute IN ('Service-Type', 'Framed-Protocol', 'Framed-Pool', 'Framed-IP-Address')
            AND (
                (attribute = 'Service-Type' AND value = 'Framed-User')
                OR (attribute = 'Framed-Protocol' AND value = 'PPP')
                OR attribute = 'Framed-Pool'
                OR attribute = 'Framed-IP-Address'
            )
            AND groupname IS NOT NULL AND groupname != ''
        `);
        const pppoeAttributeGroupnames = pppoeAttributeRows.map(r => r.groupname);
        
        // PENTING: Cek metadata pppoe_profiles untuk profil yang dibuat di /admin/mikrotik/profiles
        // Profil PPPoE yang dibuat di admin panel akan tersimpan di tabel pppoe_profiles
        let pppoeMetadataGroupnames = [];
        try {
            if (await ensurePPPoEProfilesMetadataTable(conn)) {
                const [pppoeMetaRows] = await conn.execute(`
                    SELECT DISTINCT groupname
                    FROM pppoe_profiles
                    WHERE groupname IS NOT NULL AND groupname != ''
                `);
                pppoeMetadataGroupnames = pppoeMetaRows.map(row => row.groupname);
            }
        } catch (pppoeMetaErr) {
            logger.warn(`Failed to load PPPoE profile metadata: ${pppoeMetaErr.message}`);
        }
        
        // PENTING: Gabungkan groupname yang digunakan oleh hotspot users (voucher + member)
        // Ini adalah prioritas TERTINGGI - jika profile digunakan oleh voucher/member, maka itu adalah Hotspot Profile
        const allHotspotUserGroupnames = [...new Set([...groupnames, ...memberGroupnames])];
        
        // Gabungkan semua groupname yang harus di-exclude (dari users + dari attributes + dari metadata)
        // TAPI: Jangan exclude jika profile digunakan oleh hotspot users (prioritas tinggi)
        const allPPPoEGroupnames = [...new Set([...pppoeGroupnames, ...pppoeAttributeGroupnames, ...pppoeMetadataGroupnames])].filter(groupname => {
            // Jangan exclude jika profile digunakan oleh hotspot users (prioritas tinggi)
            return !allHotspotUserGroupnames.includes(groupname);
        });
        
        logger.info(`Found ${pppoeAttributeGroupnames.length} PPPoE profiles from attributes (Service-Type=Framed-User, Framed-Protocol=PPP, Framed-Pool, Framed-IP-Address), ${pppoeMetadataGroupnames.length} from pppoe_profiles metadata (excluding ${pppoeMetadataGroupnames.filter(g => allHotspotUserGroupnames.includes(g)).length} that are used by hotspot users)`);
        
        // Gabungkan groupname dari hotspot users (voucher + member) dan metadata
        // PRIORITAS: Profile yang digunakan oleh hotspot users ATAU memiliki attribute khas Hotspot selalu include
        const hotspotAttributeGroupnames = hotspotAttributeRows.map(r => r.groupname);
        const hotspotGroupnames = [...new Set([
            ...groupnames,
            ...memberGroupnames,
            ...metadataGroupnames,
            ...hotspotAttributeGroupnames
        ])].filter(groupname => {
            // PRIORITAS 1: Jika digunakan oleh hotspot users (voucher/member), selalu include
            // Meskipun ada di pppoe_profiles metadata, jika digunakan oleh hotspot users, tetap Hotspot Profile
            if (allHotspotUserGroupnames.includes(groupname)) {
                logger.debug(`Including profile "${groupname}" in hotspot profiles (used by hotspot users - priority)`);
                return true;
            }
            // PRIORITAS 2: Jika ada di pppoe_profiles metadata, EXCLUDE dari Hotspot Profiles
            // Profile yang dibuat di /admin/mikrotik/profiles adalah PPPoE Profile, bukan Hotspot Profile
            // Ini adalah penanda yang paling kuat - jika dibuat di PPPoE profiles, maka itu PPPoE Profile
            if (pppoeMetadataGroupnames.includes(groupname)) {
                logger.debug(`Excluding profile "${groupname}" from hotspot profiles (created in /admin/mikrotik/profiles - PPPoE profile)`);
                return false;
            }
            // PRIORITAS 3: Jika memiliki attribute khas Hotspot (MikroTik-Rate-Limit, Session-Timeout), include
            // TAPI hanya jika TIDAK ada di pppoe_profiles metadata (sudah di-exclude di PRIORITAS 2)
            if (hotspotAttributeGroupnames.includes(groupname)) {
                logger.debug(`Including profile "${groupname}" in hotspot profiles (has hotspot attributes)`);
                return true;
            }
            // Exclude jika digunakan oleh PPPoE users ATAU memiliki attribute khas PPPoE
            if (allPPPoEGroupnames.includes(groupname)) {
                logger.debug(`Excluding profile "${groupname}" from hotspot profiles (PPPoE profile)`);
                return false;
            }
            return true;
        });
        
        const allGroupnames = hotspotGroupnames;

        logger.info(`Found ${allGroupnames.length} Hotspot User Profile groupnames (${groupnames.length} from vouchers, ${memberGroupnames.length} from members, ${metadataGroupnames.length} from metadata, ${hotspotAttributeRows.length} with hotspot attributes, excluded ${allPPPoEGroupnames.length} PPPoE profiles: ${pppoeGroupnames.length} from users + ${pppoeAttributeGroupnames.length} from attributes + ${pppoeMetadataGroupnames.length} from pppoe_profiles metadata)`);

        const metadataMap = await getHotspotProfilesMetadata(conn, allGroupnames);

        const profiles = [];
        for (const rawGroupname of allGroupnames) {
            const groupname = rawGroupname;

            const [replyRows] = await conn.execute(`
                SELECT attribute, value
                FROM radgroupreply
                WHERE groupname = ?
                ORDER BY attribute
            `, [groupname]);

            const [checkRows] = await conn.execute(`
                SELECT attribute, value
                FROM radgroupcheck
                WHERE groupname = ?
                ORDER BY attribute
            `, [groupname]);

            const meta = metadataMap[groupname] || null;

            // Nama tampilan: utamakan groupname fisik ber-prefix tenant (t16_profil_…)
            // agar tidak tertimpa display_name legacy ("Profil 50 Mbps").
            const gnStr = String(groupname || '').trim();
            const isTenantPrefixed = /^t\d+_/i.test(gnStr);
            const profile = {
                name: isTenantPrefixed ? gnStr : (meta?.display_name || groupname),
                '.id': groupname,
                groupname: groupname,
                'rate-limit': null,
                'session-timeout': null,
                'idle-timeout': null,
                'limit-uptime': null,
                'shared-users': meta?.shared_users || null,
                limitUptimeValue: meta?.limit_uptime_value || null,
                limitUptimeUnit: meta?.limit_uptime_unit || null,
                limitUptimeSeconds: null,
                validityValue: meta?.validity_value || null,
                validityUnit: meta?.validity_unit || null,
                validitySeconds: null,
                validityString: null,
                comment: meta?.comment || '',
                localAddress: meta?.local_address || '',
                remoteAddress: meta?.remote_address || '',
                dnsServer: meta?.dns_server || '',
                parentQueue: meta?.parent_queue || '',
                addressList: meta?.address_list || '',
                nas_name: 'RADIUS',
                nas_ip: 'RADIUS Server',
                is_radius: true
            };

            [...replyRows, ...checkRows].forEach(attr => {
                switch (attr.attribute) {
                    case 'MikroTik-Rate-Limit':
                    case 'Mikrotik-Rate-Limit':
                        profile['rate-limit'] = attr.value;
                        break;
                    case 'Session-Timeout': {
                        const formatted = formatSecondsToDuration(attr.value);
                        if (formatted) {
                            profile.sessionTimeout = formatted.value;
                            profile.sessionTimeoutUnit = formatted.unit;
                            profile['session-timeout'] = formatted.string;
                        } else {
                            const parsed = parseTimeoutValue(attr.value);
                            profile.sessionTimeout = parsed.raw;
                            profile.sessionTimeoutUnit = parsed.unit;
                            profile['session-timeout'] = attr.value;
                        }
                        break;
                    }
                    case 'Max-All-Session': {
                        const formatted = formatSecondsToDuration(attr.value);
                        if (formatted) {
                            profile.limitUptimeSeconds = formatted.seconds;
                            profile.limitUptimeValue = formatted.value;
                            profile.limitUptimeUnit = formatted.unit;
                            profile['limit-uptime'] = formatted.string;
                        }
                        break;
                    }
                    case 'Idle-Timeout': {
                        const formatted = formatSecondsToDuration(attr.value);
                        if (formatted) {
                            profile.idleTimeout = formatted.value;
                            profile.idleTimeoutUnit = formatted.unit;
                            profile['idle-timeout'] = formatted.string;
                        } else {
                            const parsed = parseTimeoutValue(attr.value);
                            profile.idleTimeout = parsed.raw;
                            profile.idleTimeoutUnit = parsed.unit;
                            profile['idle-timeout'] = attr.value;
                        }
                        break;
                    }
                    case 'Expire-After': {
                        const formatted = formatSecondsToDuration(attr.value);
                        if (formatted) {
                            profile.validitySeconds = formatted.seconds;
                            profile.validityValue = formatted.value;
                            profile.validityUnit = formatted.unit;
                            profile.validityString = formatted.string;
                        }
                        break;
                    }
                    case 'Mikrotik-Shared-Users':
                    case 'MikroTik-Shared-Users':
                    case 'Simultaneous-Use':
                        profile['shared-users'] = attr.value;
                        break;
                }
            });

            if (meta) {
                const rateUnit = meta.rate_limit_unit ? meta.rate_limit_unit.toUpperCase() : '';
                if (meta.rate_limit_value && rateUnit) {
                    const formatted = `${meta.rate_limit_value}${rateUnit}/${meta.rate_limit_value}${rateUnit}`;
                    if (!profile['rate-limit']) {
                        profile['rate-limit'] = formatted;
                    }
                    profile.rateLimit = meta.rate_limit_value;
                    profile.rateLimitUnit = rateUnit;
                }

                if (meta.shared_users) {
                    profile.sharedUsers = meta.shared_users;
                    profile['shared-users'] = meta.shared_users;
                }

                const limitUnit = meta.limit_uptime_unit ? meta.limit_uptime_unit.toLowerCase() : '';
                if (meta.limit_uptime_value && limitUnit) {
                    const formatted = `${meta.limit_uptime_value}${limitUnit}`;
                    profile.limitUptimeValue = meta.limit_uptime_value;
                    profile.limitUptimeUnit = limitUnit;
                    profile['limit-uptime'] = formatted;
                    const seconds = durationToSeconds(meta.limit_uptime_value, limitUnit);
                    if (seconds) {
                        profile.limitUptimeSeconds = seconds;
                    }
                }

                const validityUnit = meta.validity_unit ? meta.validity_unit.toLowerCase() : '';
                if (meta.validity_value && validityUnit) {
                    const formatted = `${meta.validity_value}${validityUnit}`;
                    profile.validityValue = meta.validity_value;
                    profile.validityUnit = validityUnit;
                    profile.validityString = formatted;
                    const seconds = durationToSeconds(meta.validity_value, validityUnit);
                    if (seconds) {
                        profile.validitySeconds = seconds;
                    }
                }
            }

            if (profile['limit-uptime']) {
                profile.limitUptimeString = profile['limit-uptime'];
            }
            if (profile.validityString) {
                profile['validity-period'] = profile.validityString;
            }

            profiles.push(profile);
        }

        // Deduplicate profiles by groupname (case-insensitive)
        const dedupedProfiles = [];
        const seenKeys = new Set();
        profiles.forEach(profile => {
            const key = String(profile.groupname || profile.name || '').trim().toLowerCase();
            if (!key) {
                dedupedProfiles.push(profile);
                return;
            }
            if (seenKeys.has(key)) {
                logger.debug(`Skipping duplicate hotspot profile detected for groupname: ${profile.groupname}`);
                return;
            }
            seenKeys.add(key);
            dedupedProfiles.push(profile);
        });

        await conn.end();
        return {
            success: true,
            message: `Ditemukan ${dedupedProfiles.length} profile hotspot dari RADIUS`,
            data: dedupedProfiles
        };
    } catch (error) {
        await conn.end();
        logger.error(`Error getting hotspot profiles from RADIUS: ${error.message}`);
        return { success: false, message: `Gagal ambil data profile hotspot dari RADIUS: ${error.message}`, data: [] };
    }
}

// ============================================
// HOTSPOT SERVER PROFILE FUNCTIONS
// ============================================

async function getHotspotServerProfiles(routerObj = null) {
    let conn = null;
    try {
        if (routerObj) {
            logger.info(`Connecting to router for server profiles: ${routerObj.name} (${routerObj.nas_ip}:${routerObj.port || 8728})`);
            try {
                conn = await getMikrotikConnectionForRouter(routerObj);
            } catch (connError) {
                logger.error(`Connection failed to ${routerObj.name}:`, connError.message);
                return { success: false, message: `Koneksi gagal ke ${routerObj.name}: ${connError.message}`, data: [] };
            }
        } else {
            logger.info('Using default Mikrotik connection for server profiles');
            conn = await getMikrotikConnection();
        }
        
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal: Tidak dapat membuat koneksi', data: [] };
        }
        
        logger.info('Fetching hotspot server profiles from Mikrotik...');
        try {
            let profiles = null;
            try {
                profiles = await conn.write('/ip/hotspot/profile/print');
                logger.info(`Command /ip/hotspot/profile/print berhasil, mendapatkan ${profiles ? profiles.length : 0} profiles`);
            } catch (cmdError) {
                logger.error(`Command /ip/hotspot/profile/print tidak tersedia: ${cmdError.message}`);
                throw cmdError;
            }
            
            if (!profiles) {
                return { success: false, message: 'Tidak ada data profile yang ditemukan', data: [] };
            }
            
            logger.info(`Successfully retrieved ${profiles ? profiles.length : 0} server profiles from ${routerObj ? routerObj.name : 'default'}`);
            
            const validProfiles = [];
            if (Array.isArray(profiles)) {
                profiles.forEach((prof, idx) => {
                    if (prof && (prof.name || prof['name'])) {
                        const normalizedProfile = {
                            id: prof['.id'] || prof.id || '',
                            name: prof.name || prof['name'] || '',
                            'hotspot-address': prof['hotspot-address'] || prof['hotspot-address'] || '',
                            'dns-name': prof['dns-name'] || prof['dns-name'] || '',
                            'html-directory': prof['html-directory'] || prof['html-directory'] || '',
                            'html-directory-override': prof['html-directory-override'] || prof['html-directory-override'] || '',
                            'rate-limit': prof['rate-limit'] || prof['rate-limit'] || '',
                            'http-proxy': prof['http-proxy'] || prof['http-proxy'] || '',
                            'http-proxy-port': prof['http-proxy-port'] || prof['http-proxy-port'] || '',
                            'smtp-server': prof['smtp-server'] || prof['smtp-server'] || '',
                            'session-timeout': prof['session-timeout'] || '',
                            'idle-timeout': prof['idle-timeout'] || '',
                            'shared-users': prof['shared-users'] || '1',
                            'open-status-page': prof['open-status-page'] || '',
                            comment: prof.comment || '',
                            disabled: prof.disabled === 'true' || prof.disabled === true
                        };
                        
                        if (routerObj) {
                            normalizedProfile.nas_id = routerObj.id;
                            normalizedProfile.nas_name = routerObj.name;
                            normalizedProfile.nas_ip = routerObj.nas_ip;
                        }
                        
                        validProfiles.push(normalizedProfile);
                        logger.debug(`  Server Profile ${idx + 1}: ${normalizedProfile.name} (hotspot-address: ${normalizedProfile['hotspot-address']}, dns-name: ${normalizedProfile['dns-name']})`);
                    }
                });
            }
            logger.info(`Valid server profiles after parsing: ${validProfiles.length}`);
            
            if (routerObj && conn && typeof conn.close === 'function') {
                try {
                    await conn.close();
                } catch (closeError) {
                    logger.warn('Error closing connection:', closeError.message);
                }
            }
            
            return {
                success: true,
                message: `Ditemukan ${validProfiles.length} server profile hotspot`,
                data: validProfiles
            };
        } catch (cmdError) {
            logger.error(`Command tidak tersedia di router ${routerObj ? routerObj.name : 'default'}: ${cmdError.message}`);
            
            if (routerObj && conn && typeof conn.close === 'function') {
                try {
                    await conn.close();
                } catch (closeError) {
                    // Ignore
                }
            }
            
            return { 
                success: false, 
                message: `Router tidak mendukung fitur Server Profile Hotspot atau versi RouterOS tidak kompatibel: ${cmdError.message}`, 
                data: [] 
            };
        }
    } catch (error) {
        logger.error(`Error getting hotspot server profiles from ${routerObj ? routerObj.name : 'default'}: ${error.message}`);
        
        if (routerObj && conn && typeof conn.close === 'function') {
            try {
                await conn.close();
            } catch (closeError) {
                // Ignore
            }
        }
        
        return { success: false, message: `Gagal ambil server profile hotspot: ${error.message}`, data: [] };
    }
}

// Fungsi untuk memastikan tabel hotspot_server_profiles ada
async function ensureHotspotServerProfilesTable(conn) {
    try {
        const [tableCheck] = await conn.execute(`
            SELECT name as count FROM sqlite_master WHERE type='table' AND name='hotspot_server_profiles'
        `);
        
        if (!tableCheck || tableCheck.length === 0) {
            logger.info('Tabel hotspot_server_profiles belum ada, mencoba membuat...');
            try {
                await conn.execute(`
                    CREATE TABLE IF NOT EXISTS hotspot_server_profiles (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name TEXT NOT NULL UNIQUE,
                        rate_limit TEXT NULL,
                        session_timeout INTEGER NULL,
                        idle_timeout INTEGER NULL,
                        shared_users INTEGER DEFAULT 1,
                        open_status_page BOOLEAN DEFAULT 1,
                        http_cookie_lifetime INTEGER NULL,
                        split_user_domain BOOLEAN DEFAULT 0,
                        status_autorefresh INTEGER NULL,
                        copy_from TEXT NULL,
                        disabled BOOLEAN DEFAULT 0,
                        comment TEXT NULL,
                        created_at DATETIME DEFAULT (datetime('now','localtime')),
                        updated_at DATETIME DEFAULT (datetime('now','localtime'))
                    )
                `);
                logger.info('✅ Tabel hotspot_server_profiles berhasil dibuat');
            } catch (createError) {
                logger.error(`❌ Gagal membuat tabel hotspot_server_profiles: ${createError.message}`);
                // Jangan throw error, biarkan fungsi tetap berjalan
            }
        }
    } catch (error) {
        logger.error(`Error checking/creating hotspot_server_profiles table: ${error.message}`);
        // Jangan throw error, biarkan fungsi tetap berjalan
    }
}

async function getHotspotServerProfilesRadius() {
    const conn = await getRadiusConnection();
    try {
        // Cek dan buat tabel jika belum ada
        await ensureHotspotServerProfilesTable(conn);
        
        const [rows] = await conn.execute(`
            SELECT id, name, rate_limit, session_timeout, idle_timeout, shared_users,
                   open_status_page, http_cookie_lifetime, split_user_domain,
                   status_autorefresh, copy_from, disabled, comment,
                   created_at, updated_at
            FROM hotspot_server_profiles
            WHERE disabled = 0
            ORDER BY name
        `);
        
        const profiles = rows.map(row => ({
            '.id': row.id.toString(),
            id: row.id,
            name: row.name,
            'rate-limit': row.rate_limit || '',
            'session-timeout': row.session_timeout || '',
            'idle-timeout': row.idle_timeout || '',
            'shared-users': row.shared_users || 1,
            'open-status-page': row.open_status_page || 'http-login',
            'http-cookie-lifetime': row.http_cookie_lifetime || 0,
            'split-user-domain': row.split_user_domain ? 'yes' : 'no',
            'status-autorefresh': row.status_autorefresh || 'none',
            'copy-from': row.copy_from || '',
            disabled: row.disabled ? 'true' : 'false',
            comment: row.comment || '',
            nas_name: 'RADIUS',
            nas_ip: 'RADIUS Server',
            created_at: row.created_at,
            updated_at: row.updated_at
        }));
        
        await conn.end();
        return {
            success: true,
            message: `Ditemukan ${profiles.length} server profile hotspot dari RADIUS`,
            data: profiles
        };
    } catch (error) {
        await conn.end();
        logger.error(`Error getting hotspot server profiles from RADIUS: ${error.message}`);
        return { success: false, message: `Gagal ambil server profile hotspot dari RADIUS: ${error.message}`, data: [] };
    }
}

async function addHotspotServerProfileRadius(profileData) {
    const conn = await getRadiusConnection();
    try {
        // Cek dan buat tabel jika belum ada
        await ensureHotspotServerProfilesTable(conn);
        
        const name = (profileData.name || '').trim().toLowerCase().replace(/\s+/g, '-');
        
        if (!name || name === '') {
            await conn.end();
            return { success: false, message: 'Nama server profile tidak boleh kosong' };
        }
        
        const [existing] = await conn.execute(`
            SELECT COUNT(*) as count FROM hotspot_server_profiles WHERE name = ?
        `, [name]);
        
        if (existing && existing.length > 0 && existing[0].count > 0) {
            await conn.end();
            return { success: false, message: `Server profile dengan nama \"${name}\" sudah ada` };
        }
        
        await conn.execute(`
            INSERT INTO hotspot_server_profiles (
                name, rate_limit, session_timeout, idle_timeout, shared_users,
                open_status_page, http_cookie_lifetime, split_user_domain,
                status_autorefresh, copy_from, disabled, comment
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            name,
            profileData['rate-limit'] || null,
            profileData['session-timeout'] || null,
            profileData['idle-timeout'] || null,
            parseInt(profileData['shared-users']) || 1,
            profileData['open-status-page'] || 'http-login',
            parseInt(profileData['http-cookie-lifetime']) || 0,
            profileData['split-user-domain'] === 'yes' ? 1 : 0,
            profileData['status-autorefresh'] || 'none',
            profileData['copy-from'] || null,
            profileData.disabled === 'true' ? 1 : 0,
            profileData.comment || null
        ]);
        
        await conn.end();
        logger.info(`Successfully added hotspot server profile to RADIUS: ${name}`);
        return { success: true, message: `Server profile \"${name}\" berhasil ditambahkan ke RADIUS` };
    } catch (error) {
        await conn.end();
        logger.error(`Error adding hotspot server profile to RADIUS: ${error.message}`);
        return { success: false, message: `Gagal menambah server profile: ${error.message}` };
    }
}

async function editHotspotServerProfileRadius(id, profileData) {
    const conn = await getRadiusConnection();
    try {
        const name = (profileData.name || '').trim().toLowerCase().replace(/\s+/g, '-');
        
        if (!name || name === '') {
            await conn.end();
            return { success: false, message: 'Nama server profile tidak boleh kosong' };
        }
        
        const [existing] = await conn.execute(`
            SELECT COUNT(*) as count FROM hotspot_server_profiles WHERE name = ? AND id != ?
        `, [name, id]);
        
        if (existing && existing.length > 0 && existing[0].count > 0) {
            await conn.end();
            return { success: false, message: `Server profile dengan nama \"${name}\" sudah ada` };
        }
        
        await conn.execute(`
            UPDATE hotspot_server_profiles SET
                name = ?, rate_limit = ?, session_timeout = ?, idle_timeout = ?,
                shared_users = ?, open_status_page = ?, http_cookie_lifetime = ?,
                split_user_domain = ?, status_autorefresh = ?, copy_from = ?,
                disabled = ?, comment = ?, updated_at = datetime('now','localtime')
            WHERE id = ?
        `, [
            name,
            profileData['rate-limit'] || null,
            profileData['session-timeout'] || null,
            profileData['idle-timeout'] || null,
            parseInt(profileData['shared-users']) || 1,
            profileData['open-status-page'] || 'http-login',
            parseInt(profileData['http-cookie-lifetime']) || 0,
            profileData['split-user-domain'] === 'yes' ? 1 : 0,
            profileData['status-autorefresh'] || 'none',
            profileData['copy-from'] || null,
            profileData.disabled === 'true' ? 1 : 0,
            profileData.comment || null,
            id
        ]);
        
        await conn.end();
        logger.info(`Successfully updated hotspot server profile in RADIUS: ${name}`);
        return { success: true, message: `Server profile \"${name}\" berhasil diupdate` };
    } catch (error) {
        await conn.end();
        logger.error(`Error updating hotspot server profile in RADIUS: ${error.message}`);
        return { success: false, message: `Gagal update server profile: ${error.message}` };
    }
}

async function deleteHotspotServerProfileRadius(id) {
    const conn = await getRadiusConnection();
    try {
        await conn.execute(`
            UPDATE hotspot_server_profiles SET disabled = 1, updated_at = datetime('now','localtime') WHERE id = ?
        `, [id]);
        
        await conn.end();
        logger.info(`Successfully disabled hotspot server profile in RADIUS: ID ${id}`);
        return { success: true, message: 'Server profile berhasil dihapus (disabled)' };
    } catch (error) {
        await conn.end();
        logger.error(`Error deleting hotspot server profile from RADIUS: ${error.message}`);
        return { success: false, message: `Gagal menghapus server profile: ${error.message}` };
    }
}

async function getHotspotServerProfileDetailRadius(id) {
    const conn = await getRadiusConnection();
    try {
        const [rows] = await conn.execute(`
            SELECT id, name, rate_limit, session_timeout, idle_timeout, shared_users,
                   open_status_page, http_cookie_lifetime, split_user_domain,
                   status_autorefresh, copy_from, disabled, comment,
                   created_at, updated_at
            FROM hotspot_server_profiles
            WHERE id = ?
        `, [id]);
        
        if (rows.length === 0) {
            await conn.end();
            return { success: false, message: 'Server profile tidak ditemukan', data: null };
        }
        
        const row = rows[0];
        const profile = {
            '.id': row.id.toString(),
            id: row.id,
            name: row.name,
            'rate-limit': row.rate_limit || '',
            'session-timeout': row.session_timeout || '',
            'idle-timeout': row.idle_timeout || '',
            'shared-users': row.shared_users || 1,
            'open-status-page': row.open_status_page || 'http-login',
            'http-cookie-lifetime': row.http_cookie_lifetime || 0,
            'split-user-domain': row.split_user_domain ? 'yes' : 'no',
            'status-autorefresh': row.status_autorefresh || 'none',
            'copy-from': row.copy_from || '',
            disabled: row.disabled ? 'true' : 'false',
            comment: row.comment || '',
            nas_name: 'RADIUS',
            nas_ip: 'RADIUS Server',
            created_at: row.created_at,
            updated_at: row.updated_at
        };
        
        await conn.end();
        return { success: true, data: profile };
    } catch (error) {
        await conn.end();
        logger.error(`Error getting hotspot server profile detail from RADIUS: ${error.message}`);
        return { success: false, message: `Gagal ambil detail server profile: ${error.message}`, data: null };
    }
}
let hotspotProfilesColumnsCache = null;
let hotspotProfilesPermissionWarningLogged = false;
let hotspotProfilesPermissionDenied = false; // Flag untuk menandai bahwa permission denied sudah terjadi

async function ensureHotspotProfilesMetadataTable(conn) {
    try {
        const [tableCheck] = await conn.execute(`
            SELECT name as count FROM sqlite_master WHERE type='table' AND name='hotspot_profiles'
        `);

        if (!tableCheck || tableCheck.length === 0) {
            logger.info('Tabel hotspot_profiles belum ada, mencoba membuat...');
            try {
                // Buat tabel hotspot_profiles dengan struktur dasar
                await conn.execute(`
                    CREATE TABLE IF NOT EXISTS hotspot_profiles (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        groupname TEXT NOT NULL UNIQUE,
                        display_name TEXT NOT NULL,
                        comment TEXT NULL,
                        rate_limit_value TEXT NULL,
                        rate_limit_unit TEXT NULL,
                        burst_limit_value TEXT NULL,
                        burst_limit_unit TEXT NULL,
                        session_timeout_value INTEGER DEFAULT NULL,
                        session_timeout_unit TEXT NULL,
                        idle_timeout_value INTEGER DEFAULT NULL,
                        idle_timeout_unit TEXT NULL,
                        limit_uptime_value INTEGER DEFAULT NULL,
                        limit_uptime_unit TEXT NULL,
                        validity_value INTEGER DEFAULT NULL,
                        validity_unit TEXT NULL,
                        shared_users INTEGER DEFAULT 1,
                        local_address TEXT NULL,
                        remote_address TEXT NULL,
                        dns_server TEXT NULL,
                        parent_queue TEXT NULL,
                        address_list TEXT NULL,
                        created_at DATETIME DEFAULT (datetime('now','localtime')),
                        updated_at DATETIME DEFAULT (datetime('now','localtime'))
                    )
                `);
                logger.info('✅ Tabel hotspot_profiles berhasil dibuat');
                // Set cache untuk kolom yang baru dibuat
                const [newColumnRows] = await conn.execute(`PRAGMA table_info(hotspot_profiles)`);
                hotspotProfilesColumnsCache = new Set(
                    (newColumnRows || []).map(row => String(row.name).toLowerCase())
                );
                return true;
            } catch (createError) {
                logger.error(`❌ Gagal membuat tabel hotspot_profiles: ${createError.message}`);
                logger.warn('⚠️ Metadata profil hotspot tidak akan disimpan, tapi profil tetap berfungsi di radgroupreply');
                return false;
            }
        }

        // Pastikan kolom-kolom terbaru tersedia (untuk kompatibilitas versi lama)
        const requiredColumns = [
            { name: 'rate_limit_value', definition: 'VARCHAR(32)' },
            { name: 'rate_limit_unit', definition: 'VARCHAR(10)' },
            { name: 'burst_limit_value', definition: 'VARCHAR(32)' },
            { name: 'burst_limit_unit', definition: 'VARCHAR(10)' },
            { name: 'session_timeout_value', definition: 'INT DEFAULT NULL' },
            { name: 'session_timeout_unit', definition: 'VARCHAR(10)' },
            { name: 'idle_timeout_value', definition: 'INT DEFAULT NULL' },
            { name: 'idle_timeout_unit', definition: 'VARCHAR(10)' },
            { name: 'limit_uptime_value', definition: 'INT DEFAULT NULL' },
            { name: 'limit_uptime_unit', definition: 'VARCHAR(10)' },
            { name: 'validity_value', definition: 'INT DEFAULT NULL' },
            { name: 'validity_unit', definition: 'VARCHAR(10)' },
            { name: 'shared_users', definition: 'INT DEFAULT 1' },
            { name: 'local_address', definition: 'VARCHAR(64)' },
            { name: 'remote_address', definition: 'VARCHAR(64)' },
            { name: 'dns_server', definition: 'VARCHAR(255)' },
            { name: 'parent_queue', definition: 'VARCHAR(64)' },
            { name: 'address_list', definition: 'VARCHAR(64)' }
        ];

        // Use SQLite PRAGMA (not MySQL information_schema which doesn't exist in SQLite)
        const [columnRows] = await conn.execute(`PRAGMA table_info(hotspot_profiles)`);

        const existingColumns = new Set(
            (columnRows || []).map(row => String(row.name).toLowerCase())
        );
        hotspotProfilesColumnsCache = existingColumns;

        // Skip penambahan kolom jika permission sudah pernah denied
        if (hotspotProfilesPermissionDenied) {
            // Jika permission sudah pernah denied, langsung return tanpa mencoba lagi
            hotspotProfilesColumnsCache = existingColumns;
            return true;
        }

        for (const col of requiredColumns) {
            if (!existingColumns.has(col.name.toLowerCase())) {
                try {
                    await conn.execute(`ALTER TABLE hotspot_profiles ADD COLUMN ${col.name} ${col.definition}`);
                    logger.info(`Menambahkan kolom hotspot_profiles.${col.name} untuk kompatibilitas`);
                    existingColumns.add(col.name.toLowerCase());
                    hotspotProfilesColumnsCache = existingColumns;
                    // Reset flag jika berhasil menambahkan kolom (berarti permission sudah ada)
                    hotspotProfilesPermissionDenied = false;
                } catch (alterError) {
                    // Cek apakah error karena permission denied
                    const errorMsg = alterError.message || '';
                    if (errorMsg.includes('denied') || errorMsg.includes('permission') || errorMsg.includes('Access denied')) {
                        // Set flag bahwa permission denied
                        hotspotProfilesPermissionDenied = true;
                        // Hanya log sekali untuk menghindari spam log
                        if (!hotspotProfilesPermissionWarningLogged) {
                            logger.warn(`User database tidak memiliki permission ALTER TABLE untuk hotspot_profiles. Kolom tidak dapat ditambahkan otomatis.`);
                            logger.warn(`Untuk memperbaiki, jalankan: sudo bash scripts/grant_alter_permission.sh`);
                            logger.warn(`Atau sebagai root MySQL: GRANT ALTER ON radius.hotspot_profiles TO 'billing'@'localhost'; FLUSH PRIVILEGES;`);
                            hotspotProfilesPermissionWarningLogged = true;
                        }
                        // Break loop karena semua kolom akan gagal dengan alasan yang sama
                        break;
                    } else {
                        logger.warn(`Gagal menambahkan kolom hotspot_profiles.${col.name}: ${alterError.message}`);
                    }
                }
            }
        }

        hotspotProfilesColumnsCache = existingColumns;
        return true;
    } catch (error) {
        logger.error(`Error checking hotspot_profiles table: ${error.message}`);
        hotspotProfilesColumnsCache = null;
        return false;
    }
}

async function getHotspotProfilesMetadata(conn, groupnames = []) {
    if (!groupnames || groupnames.length === 0) return {};
    const exists = await ensureHotspotProfilesMetadataTable(conn);
    if (!exists) return {};

    const columnsSet = hotspotProfilesColumnsCache;
    let selectColumns = [];

    const addColumn = (columnName, required = false) => {
        if (
            required ||
            !columnsSet ||
            columnsSet.size === 0 ||
            columnsSet.has(columnName.toLowerCase())
        ) {
            selectColumns.push(columnName);
        }
    };

    addColumn('groupname', true);
    addColumn('display_name');
    addColumn('comment');
    addColumn('rate_limit_value');
    addColumn('rate_limit_unit');
    addColumn('burst_limit_value');
    addColumn('burst_limit_unit');
    addColumn('session_timeout_value');
    addColumn('session_timeout_unit');
    addColumn('idle_timeout_value');
    addColumn('idle_timeout_unit');
    addColumn('limit_uptime_value');
    addColumn('limit_uptime_unit');
    addColumn('validity_value');
    addColumn('validity_unit');
    addColumn('shared_users');
    addColumn('local_address');
    addColumn('remote_address');
    addColumn('dns_server');
    addColumn('parent_queue');
    addColumn('address_list');

    if (selectColumns.length === 0) {
        selectColumns = ['groupname'];
    }

    const placeholders = groupnames.map(() => '?').join(',');
    const sql = `
        SELECT ${selectColumns.join(', ')}
        FROM hotspot_profiles
        WHERE groupname IN (${placeholders})
    `;
    const [rows] = await conn.execute(sql, groupnames);

    const map = {};
    const list = Array.isArray(rows) ? rows : [];
    list.forEach((row) => {
        const key = row.groupname || row.GROUPNAME || null;
        if (key) {
            map[key] = row;
        }
    });
    return map;
}
async function getHotspotProfileMetadata(conn, groupname) {
    if (!groupname) return null;
    const exists = await ensureHotspotProfilesMetadataTable(conn);
    if (!exists) return null;

    const columnsSet = hotspotProfilesColumnsCache;
    let selectColumns = [];

    const addColumn = (columnName, required = false) => {
        if (
            required ||
            !columnsSet ||
            columnsSet.size === 0 ||
            columnsSet.has(columnName.toLowerCase())
        ) {
            selectColumns.push(columnName);
        }
    };

    addColumn('groupname', true);
    addColumn('display_name');
    addColumn('comment');
    addColumn('rate_limit_value');
    addColumn('rate_limit_unit');
    addColumn('burst_limit_value');
    addColumn('burst_limit_unit');
    addColumn('session_timeout_value');
    addColumn('session_timeout_unit');
    addColumn('idle_timeout_value');
    addColumn('idle_timeout_unit');
    addColumn('limit_uptime_value');
    addColumn('limit_uptime_unit');
    addColumn('validity_value');
    addColumn('validity_unit');
    addColumn('shared_users');
    addColumn('local_address');
    addColumn('remote_address');
    addColumn('dns_server');
    addColumn('parent_queue');
    addColumn('address_list');

    if (selectColumns.length === 0) {
        selectColumns = ['groupname'];
    }

    const sql = `
        SELECT ${selectColumns.join(', ')}
        FROM hotspot_profiles
        WHERE groupname = ?
        LIMIT 1
    `;
    const [rows] = await conn.execute(sql, [groupname]);

    return rows && rows.length > 0 ? rows[0] : null;
}

async function saveHotspotProfileMetadata(conn, metadata) {
    const exists = await ensureHotspotProfilesMetadataTable(conn);
    if (!exists) return false;

    const columnsSet = hotspotProfilesColumnsCache;
    const insertColumns = [];
    const placeholders = [];
    const values = [];
    const updateClauses = [];

    const addColumn = (columnName, value, options = {}) => {
        const { required = false, includeInUpdate = true } = options;
        if (
            required ||
            !columnsSet ||
            columnsSet.size === 0 ||
            columnsSet.has(columnName.toLowerCase())
        ) {
            insertColumns.push(columnName);
            placeholders.push('?');
            values.push(value !== undefined ? value : null);
            if (includeInUpdate) {
                updateClauses.push(`${columnName} = excluded.${columnName}`);
            }
        }
    };

    addColumn('groupname', metadata.groupname, { required: true, includeInUpdate: false });
    addColumn('display_name', metadata.displayName || metadata.groupname);
    addColumn('comment', metadata.comment || null);
    addColumn('rate_limit_value', metadata.rateLimitValue);
    addColumn('rate_limit_unit', metadata.rateLimitUnit);
    addColumn('burst_limit_value', metadata.burstLimitValue);
    addColumn('burst_limit_unit', metadata.burstLimitUnit);
    addColumn('session_timeout_value', metadata.sessionTimeoutValue);
    addColumn('session_timeout_unit', metadata.sessionTimeoutUnit);
    addColumn('idle_timeout_value', metadata.idleTimeoutValue);
    addColumn('idle_timeout_unit', metadata.idleTimeoutUnit);
    addColumn('limit_uptime_value', metadata.limitUptimeValue);
    addColumn('limit_uptime_unit', metadata.limitUptimeUnit);
    addColumn('validity_value', metadata.validityValue);
    addColumn('validity_unit', metadata.validityUnit);
    addColumn('shared_users', metadata.sharedUsers);
    addColumn('local_address', metadata.localAddress);
    addColumn('remote_address', metadata.remoteAddress);
    addColumn('dns_server', metadata.dnsServer);
    addColumn('parent_queue', metadata.parentQueue);
    addColumn('address_list', metadata.addressList);

    if (insertColumns.length === 0) {
        return false;
    }

    if (updateClauses.length === 0) {
        updateClauses.push('groupname = excluded.groupname');
    }

    const sql = `
        INSERT INTO hotspot_profiles (${insertColumns.join(', ')})
        VALUES (${placeholders.join(', ')})
        ON CONFLICT(groupname) DO UPDATE SET ${updateClauses.join(', ')}
    `;

    await conn.execute(sql, values);

    return true;
}

async function deleteHotspotProfileMetadata(conn, groupname) {
    const exists = await ensureHotspotProfilesMetadataTable(conn);
    if (!exists) return false;
    await conn.execute('DELETE FROM hotspot_profiles WHERE groupname = ?', [groupname]);
    return true;
}
async function ensurePPPoEProfilesMetadataTable(conn) {
    try {
        const [tableCheck] = await conn.execute(`
            SELECT name as count FROM sqlite_master WHERE type='table' AND name='pppoe_profiles'
        `);

        if (!tableCheck || tableCheck.length === 0) {
            logger.info('Tabel pppoe_profiles belum ada, mencoba membuat...');
            try {
                await conn.execute(`
                    CREATE TABLE IF NOT EXISTS pppoe_profiles (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        groupname TEXT NOT NULL UNIQUE,
                        display_name TEXT NOT NULL,
                        comment TEXT NULL,
                        rate_limit TEXT NULL,
                        local_address TEXT NULL,
                        remote_address TEXT NULL,
                        dns_server TEXT NULL,
                        parent_queue TEXT NULL,
                        address_list TEXT NULL,
                        bridge_learning TEXT NOT NULL DEFAULT 'default',
                        use_mpls TEXT NOT NULL DEFAULT 'default',
                        use_compression TEXT NOT NULL DEFAULT 'default',
                        use_encryption TEXT NOT NULL DEFAULT 'default',
                        only_one TEXT NOT NULL DEFAULT 'default',
                        change_tcp_mss TEXT NOT NULL DEFAULT 'default',
                        use_upnp TEXT NOT NULL DEFAULT 'default',
                        created_at DATETIME DEFAULT (datetime('now','localtime')),
                        updated_at DATETIME DEFAULT (datetime('now','localtime'))
                    )
                `);
                logger.info('✅ Tabel pppoe_profiles berhasil dibuat');
                return true;
            } catch (createError) {
                logger.error(`❌ Gagal membuat tabel pppoe_profiles: ${createError.message}`);
                logger.warn('⚠️ Metadata profil tidak akan disimpan, tapi profil tetap berfungsi di radgroupreply');
                return false;
            }
        }

        return true;
    } catch (error) {
        logger.error(`Error checking pppoe_profiles table: ${error.message}`);
        return false;
    }
}

async function getPPPoEProfilesMetadata(conn, groupnames = []) {
    if (!groupnames || groupnames.length === 0) return {};
    const exists = await ensurePPPoEProfilesMetadataTable(conn);
    if (!exists) return {};

    const placeholders = groupnames.map(() => '?').join(',');
    const [rows] = await conn.execute(`
        SELECT groupname, display_name, comment, rate_limit,
               local_address, remote_address, dns_server,
               parent_queue, address_list,
               bridge_learning, use_mpls, use_compression,
               use_encryption, only_one, change_tcp_mss, use_upnp
        FROM pppoe_profiles
        WHERE groupname IN (${placeholders})
    `, groupnames);

    const map = {};
    const list = Array.isArray(rows) ? rows : [];
    list.forEach((row) => {
        map[row.groupname] = row;
    });
    return map;
}

async function getPPPoEProfileMetadata(conn, groupname) {
    if (!groupname) return null;
    const exists = await ensurePPPoEProfilesMetadataTable(conn);
    if (!exists) return null;

    const [rows] = await conn.execute(`
        SELECT groupname, display_name, comment, rate_limit,
               local_address, remote_address, dns_server,
               parent_queue, address_list,
               bridge_learning, use_mpls, use_compression,
               use_encryption, only_one, change_tcp_mss, use_upnp
        FROM pppoe_profiles
        WHERE groupname = ?
        LIMIT 1
    `, [groupname]);

    return rows && rows.length > 0 ? rows[0] : null;
}

async function savePPPoEProfileMetadata(conn, metadata) {
    const exists = await ensurePPPoEProfilesMetadataTable(conn);
    if (!exists) return false;

    await conn.execute(`
        INSERT INTO pppoe_profiles (
            groupname, display_name, comment, rate_limit,
            local_address, remote_address, dns_server,
            parent_queue, address_list,
            bridge_learning, use_mpls, use_compression,
            use_encryption, only_one, change_tcp_mss, use_upnp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(groupname) DO UPDATE SET
            display_name = excluded.display_name,
            comment = excluded.comment,
            rate_limit = excluded.rate_limit,
            local_address = excluded.local_address,
            remote_address = excluded.remote_address,
            dns_server = excluded.dns_server,
            parent_queue = excluded.parent_queue,
            address_list = excluded.address_list,
            bridge_learning = excluded.bridge_learning,
            use_mpls = excluded.use_mpls,
            use_compression = excluded.use_compression,
            use_encryption = excluded.use_encryption,
            only_one = excluded.only_one,
            change_tcp_mss = excluded.change_tcp_mss,
            use_upnp = excluded.use_upnp
    `, [
        metadata.groupname,
        metadata.displayName,
        metadata.comment,
        metadata.rateLimit,
        metadata.localAddress,
        metadata.remoteAddress,
        metadata.dnsServer,
        metadata.parentQueue,
        metadata.addressList,
        metadata.bridgeLearning,
        metadata.useMpls,
        metadata.useCompression,
        metadata.useEncryption,
        metadata.onlyOne,
        metadata.changeTcpMss,
        metadata.useUpnp
    ]);

    return true;
}

async function deletePPPoEProfileMetadata(conn, groupname) {
    const exists = await ensurePPPoEProfilesMetadataTable(conn);
    if (!exists) return false;
    await conn.execute('DELETE FROM pppoe_profiles WHERE groupname = ?', [groupname]);
    return true;
}
// Fungsi untuk mendapatkan detail profile hotspot (RADIUS)
async function getHotspotProfileDetailRadius(groupname) {
    const conn = await getRadiusConnection();
    try {
        if (!groupname) {
            await conn.end();
            return { success: false, message: 'Nama profile tidak boleh kosong', data: null };
        }

        const normalizedGroupname = String(groupname).trim();

        const [replyRows] = await conn.execute(`
            SELECT attribute, value
            FROM radgroupreply
            WHERE groupname = ?
            ORDER BY attribute
        `, [normalizedGroupname]);

        const [checkRows] = await conn.execute(`
            SELECT attribute, value
            FROM radgroupcheck
            WHERE groupname = ?
            ORDER BY attribute
        `, [normalizedGroupname]);

        const metadata = await getHotspotProfileMetadata(conn, normalizedGroupname);

        if ((!replyRows || replyRows.length === 0) && (!checkRows || checkRows.length === 0) && !metadata) {
            await conn.end();
            return { success: false, message: 'Profile tidak ditemukan', data: null };
        }

        const profile = {
            name: metadata?.display_name || normalizedGroupname,
            '.id': normalizedGroupname,
            groupname: normalizedGroupname,
            comment: metadata?.comment || '',
            disabled: false,
            rateLimit: null,
            sessionTimeout: null,
            idleTimeout: null,
            'limit-uptime': null,
            'shared-users': metadata?.shared_users || null,
            limitUptimeValue: metadata?.limit_uptime_value || null,
            limitUptimeUnit: metadata?.limit_uptime_unit || null,
            limitUptimeSeconds: null,
            validityValue: metadata?.validity_value || null,
            validityUnit: metadata?.validity_unit || null,
            validitySeconds: null,
            validityString: null,
            rateLimitUnit: null,
            sessionTimeoutUnit: null,
            idleTimeoutUnit: null,
            localAddress: metadata?.local_address || '',
            remoteAddress: metadata?.remote_address || '',
            dnsServer: metadata?.dns_server || '',
            parentQueue: metadata?.parent_queue || '',
            addressList: metadata?.address_list || '',
            nas_name: 'RADIUS',
            nas_ip: 'RADIUS Server',
            is_radius: true,
            'rate-limit': null,
            'session-timeout': null,
            'idle-timeout': null
        };

        const parseTimeoutValue = (value) => {
            if (!value) return { raw: null, unit: null };
            const match = String(value).match(/^(\d+)([a-zA-Z]*)$/);
            if (match) {
                return {
                    raw: match[1],
                    unit: match[2] || null
                };
            }
            return { raw: value, unit: null };
        };

        const parseRateLimit = (value) => {
            if (!value) return { raw: null, unit: null };
            const parts = String(value).split('/');
            if (parts.length >= 1) {
                const match = parts[0].match(/^(\d+)([kKmMgG]?)$/);
                if (match) {
                    return {
                        raw: match[1],
                        unit: match[2] ? match[2].toUpperCase() : null
                    };
                }
            }
            return { raw: value, unit: null };
        };

        [...replyRows, ...checkRows].forEach(attr => {
            switch (attr.attribute) {
                case 'MikroTik-Rate-Limit':
                case 'Mikrotik-Rate-Limit': {
                    profile['rate-limit'] = attr.value;
                    const parsed = parseRateLimit(attr.value);
                    profile.rateLimit = parsed.raw;
                    profile.rateLimitUnit = parsed.unit;
                    break;
                }
                case 'Session-Timeout': {
                    const formatted = formatSecondsToDuration(attr.value);
                    if (formatted) {
                        profile.sessionTimeout = formatted.value;
                        profile.sessionTimeoutUnit = formatted.unit;
                        profile['session-timeout'] = formatted.string;
                    } else {
                        const parsed = parseTimeoutValue(attr.value);
                        profile.sessionTimeout = parsed.raw;
                        profile.sessionTimeoutUnit = parsed.unit;
                        profile['session-timeout'] = attr.value;
                    }
                    break;
                }
                case 'Max-All-Session': {
                    const formatted = formatSecondsToDuration(attr.value);
                    if (formatted) {
                        profile.limitUptimeSeconds = formatted.seconds;
                        profile.limitUptimeValue = formatted.value;
                        profile.limitUptimeUnit = formatted.unit;
                        profile['limit-uptime'] = formatted.string;
                    }
                    break;
                }
                case 'Idle-Timeout': {
                    const formatted = formatSecondsToDuration(attr.value);
                    if (formatted) {
                        profile.idleTimeout = formatted.value;
                        profile.idleTimeoutUnit = formatted.unit;
                        profile['idle-timeout'] = formatted.string;
                    } else {
                        const parsed = parseTimeoutValue(attr.value);
                        profile.idleTimeout = parsed.raw;
                        profile.idleTimeoutUnit = parsed.unit;
                        profile['idle-timeout'] = attr.value;
                    }
                    break;
                }
                case 'Expire-After': {
                    const formatted = formatSecondsToDuration(attr.value);
                    if (formatted) {
                        profile.validitySeconds = formatted.seconds;
                        profile.validityValue = formatted.value;
                        profile.validityUnit = formatted.unit;
                        profile.validityString = formatted.string;
                    }
                    break;
                }
                case 'Mikrotik-Shared-Users':
                case 'MikroTik-Shared-Users':
                case 'Simultaneous-Use': {
                    profile['shared-users'] = attr.value;
                    break;
                }
                case 'Mikrotik-Address-List':
                case 'MikroTik-Address-List': {
                    profile.addressList = attr.value;
                    break;
                }
                case 'Mikrotik-Rate-Limit-Comment':
                case 'Comment': {
                    profile.comment = attr.value;
                    break;
                }
                default:
                    break;
            }
        });

        if (metadata) {
            const sessionUnit = metadata.session_timeout_unit ? metadata.session_timeout_unit.toLowerCase() : '';
            if (metadata.session_timeout_value && sessionUnit) {
                const formatted = `${metadata.session_timeout_value}${sessionUnit}`;
                profile.sessionTimeout = metadata.session_timeout_value;
                profile.sessionTimeoutUnit = sessionUnit;
                profile['session-timeout'] = formatted;
            }

            const idleUnit = metadata.idle_timeout_unit ? metadata.idle_timeout_unit.toLowerCase() : '';
            if (metadata.idle_timeout_value && idleUnit) {
                const formatted = `${metadata.idle_timeout_value}${idleUnit}`;
                profile.idleTimeout = metadata.idle_timeout_value;
                profile.idleTimeoutUnit = idleUnit;
                profile['idle-timeout'] = formatted;
            }

            const rateUnit = metadata.rate_limit_unit ? metadata.rate_limit_unit.toUpperCase() : '';
            if (metadata.rate_limit_value && rateUnit) {
                const formatted = `${metadata.rate_limit_value}${rateUnit}/${metadata.rate_limit_value}${rateUnit}`;
                if (!profile['rate-limit']) {
                    profile['rate-limit'] = formatted;
                }
                profile.rateLimit = metadata.rate_limit_value;
                profile.rateLimitUnit = rateUnit;
            }

            if (metadata.shared_users) {
                profile.sharedUsers = metadata.shared_users;
                profile['shared-users'] = metadata.shared_users;
            }

            const limitUnit = metadata.limit_uptime_unit ? metadata.limit_uptime_unit.toLowerCase() : '';
            if (metadata.limit_uptime_value && limitUnit) {
                const formatted = `${metadata.limit_uptime_value}${limitUnit}`;
                profile.limitUptimeValue = metadata.limit_uptime_value;
                profile.limitUptimeUnit = limitUnit;
                profile['limit-uptime'] = formatted;
                const seconds = durationToSeconds(metadata.limit_uptime_value, limitUnit);
                if (seconds) {
                    profile.limitUptimeSeconds = seconds;
                }
            }

            const validityUnit = metadata.validity_unit ? metadata.validity_unit.toLowerCase() : '';
            if (metadata.validity_value && validityUnit) {
                const formatted = `${metadata.validity_value}${validityUnit}`;
                profile.validityValue = metadata.validity_value;
                profile.validityUnit = validityUnit;
                profile.validityString = formatted;
                const seconds = durationToSeconds(metadata.validity_value, validityUnit);
                if (seconds) {
                    profile.validitySeconds = seconds;
                }
            }
        }

        if (profile['limit-uptime']) {
            profile.limitUptimeString = profile['limit-uptime'];
        }
        if (profile.validityString) {
            profile['validity-period'] = profile.validityString;
        }

        await conn.end();
        return {
            success: true,
            message: 'Detail profile berhasil diambil',
            data: profile
        };
    } catch (error) {
        await conn.end();
        logger.error(`Error getting hotspot profile detail from RADIUS: ${error.message}`);
        return { success: false, message: `Gagal ambil detail profile: ${error.message}`, data: null };
    }
}
// Fungsi untuk mendapatkan daftar profile PPPoE dari RADIUS (yang digunakan oleh PPPoE users, BUKAN voucher)
async function getPPPoEProfilesRadius(options = {}) {
    const mergeAssignedGroups = options.mergeAssignedGroups === true;
    const conn = await getRadiusConnection();
    try {
        // Daftar profil = DISTINCT groupname di radgroupreply (sumber kebenaran RADIUS).
        // Jangan exclude groupname hanya karena dipakai user voucher di radusergroup — voucher dan PPPoE
        // sering memakai profile rate-limit yang sama (profile-10mbps, dll.); exclude itu membuat semua profil ISP hilang.
        // Filter hotspot vs PPPoE hanya lewat hotspot_profiles metadata di bawah.

        let query = `
            SELECT DISTINCT groupname
            FROM radgroupreply
            WHERE groupname IS NOT NULL AND groupname != ''
            AND groupname NOT IN ('default')
            ORDER BY groupname ASC
        `;

        logger.info('[PPPoE profiles RADIUS] Query distinct groupname dari radgroupreply (tanpa exclude grup voucher)');

        const [groupRows] = await conn.execute(query, []);

        const groupRowList = Array.isArray(groupRows) ? groupRows : [];
        logger.info(`Ditemukan ${groupRowList.length} groupname dari radgroupreply`);

        const groupnames = groupRowList.map((row) => row.groupname).filter(Boolean);

        // Jangan tampilkan profile yang dibuat untuk hotspot. Profile hotspot disimpan
        // di tabel metadata `hotspot_profiles`, jadi gunakan itu sebagai penanda.
        // CRITICAL: Profil PPPoE harus dibedakan dengan profil Hotspot
        const hotspotMetadataMap = await getHotspotProfilesMetadata(conn, groupnames);
        
        logger.info(`🔍 Filtering: Ditemukan ${Object.keys(hotspotMetadataMap).length} profil hotspot dari ${groupnames.length} total profil`);

        const filteredGroupnames = groupnames.filter(name => {
            // Jangan filter profil isolir (profil sistem)
            if (name === 'isolir') {
                logger.debug(`✅ Profile "${name}" adalah profil isolir (sistem), akan ditampilkan`);
                return true;
            }
            if (hotspotMetadataMap[name]) {
                logger.info(`⏭️  SKIP: Profile "${name}" adalah profil HOTSPOT, tidak ditampilkan di daftar PPPoE`);
                return false;
            }
            logger.debug(`✅ Profile "${name}" adalah profil PPPoE, akan ditampilkan`);
            return true;
        });
        
        logger.info(`📋 Hasil filter: ${filteredGroupnames.length} profil PPPoE (dari ${groupnames.length} total, ${Object.keys(hotspotMetadataMap).length} adalah hotspot)`);

        // Isolasi multi-tenant: hanya tampilkan profil milik tenant (allowlist)
        let tenantProfileAllowSet = null; // null = tanpa konteks tenant
        let normPppoeGroupFn = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, '_');
        let systemPppoeProfiles = new Set(['isolir', 'default']);
        try {
            const {
                getTenantAllowedPppoeProfileSet,
                SYSTEM_PROFILES,
                normalizeGroupname: normPppoeGroup
            } = require('../utils/tenantPppoeProfileOwnership');
            normPppoeGroupFn = normPppoeGroup;
            systemPppoeProfiles = SYSTEM_PROFILES;
            const allowedSet = await getTenantAllowedPppoeProfileSet();
            tenantProfileAllowSet = allowedSet;
            if (allowedSet !== null) {
                const before = filteredGroupnames.length;
                const kept = filteredGroupnames.filter((name) => {
                    const key = normPppoeGroup(name);
                    if (SYSTEM_PROFILES.has(key)) return true;
                    return allowedSet.has(key);
                });
                filteredGroupnames.length = 0;
                filteredGroupnames.push(...kept);
                logger.info(
                    `[PPPoE profiles] Tenant allowlist: ${before} → ${filteredGroupnames.length} (owned=${allowedSet.size})`
                );
            }
        } catch (allowErr) {
            logger.warn(`[PPPoE profiles] Tenant filter skip: ${allowErr.message}`);
        }

        // Grup RADIUS untuk suspensi selalu 'isolir' (radusergroup); bisa punya baris hanya di radgroupcheck.
        // Tanpa ini, profil tidak muncul di halaman PPPoE bila belum ada radgroupreply untuk 'isolir'.
        const radiusIsolirGroup = 'isolir';
        if (!filteredGroupnames.includes(radiusIsolirGroup)) {
            const [isolirReply] = await conn.execute(
                `SELECT 1 FROM radgroupreply WHERE groupname = ? LIMIT 1`,
                [radiusIsolirGroup]
            );
            const [isolirCheck] = await conn.execute(
                `SELECT 1 FROM radgroupcheck WHERE groupname = ? LIMIT 1`,
                [radiusIsolirGroup]
            );
            if ((isolirReply && isolirReply.length > 0) || (isolirCheck && isolirCheck.length > 0)) {
                filteredGroupnames.push(radiusIsolirGroup);
                filteredGroupnames.sort((a, b) => String(a).localeCompare(String(b)));
                logger.info(`✅ Menambahkan '${radiusIsolirGroup}' ke daftar profil (ada di RADIUS, sebelumnya tidak dari radgroupreply DISTINCT)`);
            }
        }

        // Dedup case variants (GRATIS vs gratis) — SQLite DISTINCT is case-sensitive.
        // Prefer lowercase/normalized name when both exist so UI shows one row.
        {
            const byKey = new Map();
            for (const name of filteredGroupnames) {
                const key = String(name || '').trim().toLowerCase();
                if (!key) continue;
                const prev = byKey.get(key);
                if (!prev) {
                    byKey.set(key, name);
                    continue;
                }
                const preferCurrent =
                    String(name) === key ||
                    (String(prev) !== key && String(name).localeCompare(String(prev)) < 0);
                if (preferCurrent) byKey.set(key, name);
                else {
                    logger.debug(
                        `[PPPoE profiles] Skip case-duplicate groupname "${name}" (keep "${prev}")`
                    );
                }
            }
            const beforeDedup = filteredGroupnames.length;
            filteredGroupnames.length = 0;
            filteredGroupnames.push(...byKey.values());
            if (beforeDedup !== filteredGroupnames.length) {
                logger.info(
                    `[PPPoE profiles] Case-dedupe: ${beforeDedup} → ${filteredGroupnames.length}`
                );
            }
        }

        // Dedup logical name per tenant: "Profil 100 Mbps" + "profil_100_mbps" + "t2_profil_100_mbps"
        // punya display_name sama — tampilkan satu saja.
        try {
            const { hasTenantContext, getTenantId } = require('./platform/tenantContext');
            if (hasTenantContext() && filteredGroupnames.length > 1) {
                const {
                    stripTenantProfilePrefix,
                    normalizeGroupname: normLogical
                } = require('../utils/tenantPppoeProfileOwnership');
                const tid = getTenantId();
                const billingDb = require('./billing').db;
                const refRows = await new Promise((resolve) => {
                    billingDb.all(
                        `SELECT DISTINCT TRIM(pppoe_profile) AS p FROM packages
                         WHERE tenant_id = ? AND pppoe_profile IS NOT NULL AND TRIM(pppoe_profile) != ''
                         UNION
                         SELECT DISTINCT TRIM(pppoe_profile) AS p FROM customers
                         WHERE tenant_id = ? AND pppoe_profile IS NOT NULL AND TRIM(pppoe_profile) != ''`,
                        [tid, tid],
                        (err, rows) => resolve(err ? [] : rows || [])
                    );
                });
                const exactRefs = new Set(
                    (refRows || []).map((r) => String(r.p || '').trim()).filter(Boolean)
                );
                const normRefs = new Set(
                    [...exactRefs].map((p) => normLogical(p)).filter(Boolean)
                );

                const byLogical = new Map(); // logicalKey -> [physical names]
                for (const name of filteredGroupnames) {
                    const norm = normLogical(name);
                    if (!norm) continue;
                    const logical = stripTenantProfilePrefix(norm, tid) || norm;
                    if (!byLogical.has(logical)) byLogical.set(logical, []);
                    byLogical.get(logical).push(name);
                }

                const pickKeeper = (candidates) => {
                    if (candidates.length === 1) return candidates[0];
                    const prefix = `t${tid}_`;
                    // 1) Exact match ke referensi paket/pelanggan (biasanya t{tid}_…)
                    for (const c of candidates) {
                        if (exactRefs.has(String(c).trim())) return c;
                    }
                    // 2) Normalized match ke referensi — utamakan nama ber-prefix tenant
                    const normHits = candidates.filter((c) => normRefs.has(normLogical(c)));
                    if (normHits.length === 1) return normHits[0];
                    if (normHits.length > 1) {
                        const prefixed = normHits.filter((c) =>
                            normLogical(c).startsWith(prefix)
                        );
                        const pool = prefixed.length ? prefixed : normHits;
                        pool.sort((a, b) => String(a).localeCompare(String(b)));
                        return pool[0];
                    }
                    // 3) Utamakan groupname ber-prefix t{tid}_ (sesuai halaman paket)
                    const prefixed = candidates.filter((c) =>
                        normLogical(c).startsWith(prefix)
                    );
                    const pool = prefixed.length ? prefixed : candidates;
                    pool.sort((a, b) => String(a).localeCompare(String(b)));
                    return pool[0];
                };

                const keptLogical = [];
                let dropped = 0;
                for (const [, candidates] of byLogical) {
                    const keeper = pickKeeper(candidates);
                    keptLogical.push(keeper);
                    dropped += candidates.length - 1;
                    if (candidates.length > 1) {
                        logger.info(
                            `[PPPoE profiles] Logical-dedupe tenant ${tid}: keep "${keeper}" drop [${candidates
                                .filter((c) => c !== keeper)
                                .join(', ')}]`
                        );
                    }
                }
                if (dropped > 0) {
                    filteredGroupnames.length = 0;
                    filteredGroupnames.push(...keptLogical);
                    logger.info(
                        `[PPPoE profiles] Logical-dedupe: dropped ${dropped} duplicate(s) for tenant ${tid}`
                    );
                }
            }
        } catch (logicalErr) {
            logger.warn(`[PPPoE profiles] Logical dedupe skip: ${logicalErr.message}`);
        }

        const metadataMap = await getPPPoEProfilesMetadata(conn, filteredGroupnames);

        const profiles = [];
        // Gunakan filteredGroupnames untuk memastikan hanya profil yang valid yang ditampilkan
        logger.info(`Memproses ${filteredGroupnames.length} profil setelah filter hotspot`);
        
        for (const groupname of filteredGroupnames) {
            // Double check: skip jika ini adalah hotspot profile (kecuali isolir)
            if (groupname !== 'isolir' && hotspotMetadataMap[groupname]) {
                logger.debug(`Skipping hotspot profile "${groupname}" dari loop`);
                continue;
            }
            
            const meta = metadataMap[groupname] || null;
            
            const [attrRowsReply] = await conn.execute(`
                SELECT attribute, value
                FROM radgroupreply
                WHERE groupname = ?
                ORDER BY attribute
            `, [groupname]);
            const [attrRowsCheck] = await conn.execute(`
                SELECT attribute, value
                FROM radgroupcheck
                WHERE groupname = ?
                ORDER BY attribute
            `, [groupname]);

            let attrRows = attrRowsReply && attrRowsReply.length ? [...attrRowsReply] : [];
            if (groupname === radiusIsolirGroup && attrRowsCheck && attrRowsCheck.length > 0) {
                const seen = new Set(attrRows.map((r) => r.attribute));
                for (const row of attrRowsCheck) {
                    if (!seen.has(row.attribute)) {
                        attrRows.push(row);
                        seen.add(row.attribute);
                    }
                }
            }

            if (!attrRows || attrRows.length === 0) {
                if (groupname === radiusIsolirGroup) {
                    const isolirPool = getSetting('isolir_pool', 'isolir-pool');
                    profiles.push({
                        name: 'isolir',
                        '.id': 'isolir',
                        groupname: 'isolir',
                        'rate-limit': null,
                        'session-timeout': null,
                        'idle-timeout': null,
                        'limit-uptime': null,
                        'shared-users': '1',
                        comment: 'Profile sistem isolir (lengkapi radgroupreply di RADIUS bila perlu)',
                        localAddress: '',
                        remoteAddress: isolirPool,
                        dnsServer: '',
                        parentQueue: '',
                        addressList: '',
                        nas_name: 'RADIUS',
                        nas_ip: 'RADIUS Server',
                        is_radius: true,
                        is_isolir: true,
                        is_system_profile: true,
                        'remote-address': isolirPool,
                        'local-address': ''
                    });
                    logger.info(`📌 Profile isolir ditampilkan (placeholder: belum ada atribut di radgroupreply/radgroupcheck)`);
                } else {
                    logger.warn(`⚠️ Profile ${groupname} tidak memiliki attribute di radgroupreply, skip`);
                }
                continue;
            }
            
            // Build profile object
            const isIsolirProfile = groupname === 'isolir';
            const gnStr = String(groupname || '').trim();
            const isTenantPrefixed = /^t\d+_/i.test(gnStr);
            const profile = {
                name: isTenantPrefixed ? gnStr : (meta?.display_name || groupname),
                '.id': groupname, // Use groupname as ID for RADIUS
                groupname: groupname,
                'rate-limit': null,
                'session-timeout': null,
                'idle-timeout': null,
                'limit-uptime': null,
                'shared-users': null,
                comment: meta?.comment || (isIsolirProfile ? 'Profile sistem untuk isolir/suspension' : ''),
                localAddress: meta?.local_address || '',
                remoteAddress: meta?.remote_address || '',
                dnsServer: meta?.dns_server || '',
                parentQueue: meta?.parent_queue || '',
                addressList: meta?.address_list || '',
                nas_name: 'RADIUS',
                nas_ip: 'RADIUS Server',
                is_radius: true,
                is_isolir: isIsolirProfile, // Flag khusus untuk profil isolir
                is_system_profile: isIsolirProfile, // Flag untuk profil sistem (tidak bisa diedit/dihapus)
                limitUptimeValue: meta?.limit_uptime_value || null,
                limitUptimeUnit: meta?.limit_uptime_unit || null,
                limitUptimeSeconds: null,
                validityValue: meta?.validity_value || null,
                validityUnit: meta?.validity_unit || null,
                validitySeconds: null,
                validityString: null
            };
            
            // Parse attributes
            attrRows.forEach((attr) => {
                switch (attr.attribute) {
                    case 'MikroTik-Rate-Limit':
                    case 'Mikrotik-Rate-Limit':
                        profile['rate-limit'] = attr.value;
                        break;
                    case 'Session-Timeout': {
                        const formatted = formatSecondsToDuration(attr.value);
                        if (formatted) {
                            profile.sessionTimeout = formatted.value;
                            profile.sessionTimeoutUnit = formatted.unit;
                            profile['session-timeout'] = formatted.string;
                        } else {
                            const parsed = parseTimeoutValue(attr.value);
                            profile.sessionTimeout = parsed.raw;
                            profile.sessionTimeoutUnit = parsed.unit;
                            profile['session-timeout'] = attr.value;
                        }
                        break;
                    }
                    case 'Max-All-Session': {
                        const formatted = formatSecondsToDuration(attr.value);
                        if (formatted) {
                            profile.limitUptimeSeconds = formatted.seconds;
                            profile.limitUptimeValue = formatted.value;
                            profile.limitUptimeUnit = formatted.unit;
                            profile['limit-uptime'] = formatted.string;
                        }
                        break;
                    }
                    case 'Idle-Timeout': {
                        const formatted = formatSecondsToDuration(attr.value);
                        if (formatted) {
                            profile.idleTimeout = formatted.value;
                            profile.idleTimeoutUnit = formatted.unit;
                            profile['idle-timeout'] = formatted.string;
                        } else {
                            const parsed = parseTimeoutValue(attr.value);
                            profile.idleTimeout = parsed.raw;
                            profile.idleTimeoutUnit = parsed.unit;
                            profile['idle-timeout'] = attr.value;
                        }
                        break;
                    }
                    case 'Expire-After': {
                        const formatted = formatSecondsToDuration(attr.value);
                        if (formatted) {
                            profile.validitySeconds = formatted.seconds;
                            profile.validityValue = formatted.value;
                            profile.validityUnit = formatted.unit;
                            profile.validityString = formatted.string;
                        }
                        break;
                    }
                    case 'Mikrotik-Shared-Users':
                    case 'MikroTik-Shared-Users':
                    case 'Simultaneous-Use':
                        profile['shared-users'] = attr.value;
                        break;
                    case 'Framed-IP-Address':
                        // Framed-IP-Address bisa untuk local address (single IP) atau remote address (IP range)
                        // Deteksi: jika mengandung "-" berarti IP range (remote address)
                        // Jika tidak mengandung "-" berarti single IP (local address)
                        const ipRangePattern = /^\d+\.\d+\.\d+\.\d+-\d+\.\d+\.\d+\.\d+$/;
                        const isIpRange = ipRangePattern.test(attr.value);
                        
                        if (isIpRange) {
                            // IP range = remote address
                            profile.remoteAddress = attr.value;
                            logger.debug(`📝 Framed-IP-Address "${attr.value}" terdeteksi sebagai IP range (remote address)`);
                        } else {
                            // Single IP = local address
                            if (!profile.localAddress || profile.localAddress === '') {
                                profile.localAddress = attr.value;
                                logger.debug(`📝 Framed-IP-Address "${attr.value}" terdeteksi sebagai single IP (local address)`);
                            }
                        }
                        break;
                    case 'Framed-Pool':
                        // Framed-Pool adalah untuk remote address (pool name)
                        // Selalu gunakan dari attribute karena ini sumber kebenaran untuk RADIUS
                        profile.remoteAddress = attr.value;
                        break;
                    case 'MS-Primary-DNS-Server':
                        // Combine dengan secondary DNS jika ada
                        if (!profile.dnsServer || profile.dnsServer === '') {
                            profile.dnsServer = attr.value;
                        } else {
                            profile.dnsServer = attr.value + ',' + (profile.dnsServer.split(',')[1] || '');
                        }
                        break;
                    case 'MS-Secondary-DNS-Server':
                        // Combine dengan primary DNS jika ada
                        if (!profile.dnsServer || profile.dnsServer === '') {
                            profile.dnsServer = attr.value;
                        } else {
                            const primary = profile.dnsServer.split(',')[0] || profile.dnsServer;
                            profile.dnsServer = primary + ',' + attr.value;
                        }
                        break;
                    case 'MikroTik-Address-List':
                        profile.addressList = attr.value;
                        break;
                    case 'MikroTik-Parent-Queue':
                        profile.parentQueue = attr.value;
                        break;
                }
            });
            
            // Override dengan metadata hanya jika attribute tidak ada (fallback)
            if (meta && !profile['rate-limit'] && meta.rate_limit) {
                profile['rate-limit'] = meta.rate_limit;
            }
            
            // Override dengan metadata hanya jika attribute tidak ada (fallback)
            if (meta) {
                if (!profile.localAddress && meta.local_address) {
                    profile.localAddress = meta.local_address;
                }
                if (!profile.remoteAddress && meta.remote_address) {
                    profile.remoteAddress = meta.remote_address;
                }
                if (!profile.dnsServer && meta.dns_server) {
                    profile.dnsServer = meta.dns_server;
                }
                if (!profile.parentQueue && meta.parent_queue) {
                    profile.parentQueue = meta.parent_queue;
                }
                if (!profile.addressList && meta.address_list) {
                    profile.addressList = meta.address_list;
                }
            }
            
            if (profile['limit-uptime']) {
                profile.limitUptimeString = profile['limit-uptime'];
            }
            if (profile.validityString) {
                profile['validity-period'] = profile.validityString;
            }
            
            // CRITICAL: Map camelCase fields to kebab-case for UI compatibility
            // UI menggunakan profile['remote-address'], tapi kita set remoteAddress
            if (profile.remoteAddress) {
                profile['remote-address'] = profile.remoteAddress;
            }
            if (profile.localAddress) {
                profile['local-address'] = profile.localAddress;
            }
            if (profile.dnsServer) {
                profile['dns-server'] = profile.dnsServer;
            }
            if (profile.parentQueue) {
                profile['parent-queue'] = profile.parentQueue;
            }
            if (profile.addressList) {
                profile['address-list'] = profile.addressList;
            }
            
            logger.debug(`📋 Profile ${groupname} - remoteAddress: "${profile.remoteAddress}", 'remote-address': "${profile['remote-address']}"`);

            profiles.push(profile);
        }

        // Hanya untuk dropdown "edit user PPPoE" — jangan dipakai halaman daftar profil (supaya grup paket/pelanggan tidak tercampur profil RADIUS).
        if (mergeAssignedGroups) {
            const existingGroupKeys = new Set(
                profiles.map((p) => String(p.groupname || p['.id'] || '').trim()).filter(Boolean)
            );
            const excludeUsernames = await getPppoeRadcheckExcludeUsernames();
            const pwdPred = sqlRadcheckPasswordPredicate('rc');

            // Isolasi multi-tenant: jangan merge grup dari user tenant lain
            // (tanpa filter ini, profil tenant lain ikut masuk dropdown edit/tambah user).
            let tenantUsernamesForMerge = null; // null = tanpa konteks tenant
            let skipAssignedMerge = false;
            try {
                const { getTenantAllowedPppoeUsernames } = require('../utils/tenantPppoeOwnership');
                tenantUsernamesForMerge = await getTenantAllowedPppoeUsernames();
                if (tenantUsernamesForMerge !== null && tenantUsernamesForMerge.length === 0) {
                    skipAssignedMerge = true;
                    logger.info('[PPPoE profiles RADIUS] mergeAssigned: skip (tenant tidak punya user PPPoE)');
                }
            } catch (tenantMergeErr) {
                logger.warn(
                    `[PPPoE profiles RADIUS] merge tenant username filter skip: ${tenantMergeErr.message}`
                );
            }

            if (!skipAssignedMerge) {
            try {
                const assignedList = [];
                const usernameChunks =
                    Array.isArray(tenantUsernamesForMerge) && tenantUsernamesForMerge.length > 0
                        ? (() => {
                              const chunks = [];
                              const chunkSize = 200;
                              for (let i = 0; i < tenantUsernamesForMerge.length; i += chunkSize) {
                                  chunks.push(tenantUsernamesForMerge.slice(i, i + chunkSize));
                              }
                              return chunks;
                          })()
                        : [null]; // satu query tanpa filter username (mode non-tenant)

                for (const userChunk of usernameChunks) {
                    let assignedGroupsSql = `
            SELECT DISTINCT TRIM(rug.groupname) AS gn
            FROM radusergroup rug
            INNER JOIN radcheck rc ON rc.username = rug.username AND ${pwdPred}
            WHERE rug.groupname IS NOT NULL AND TRIM(rug.groupname) != ''
        `;
                    const assignedParams = [];
                    if (excludeUsernames.length > 0) {
                        const ph = excludeUsernames.map(() => '?').join(',');
                        assignedGroupsSql += ` AND rc.username NOT IN (${ph})`;
                        assignedParams.push(...excludeUsernames);
                    }
                    if (userChunk) {
                        const ph = userChunk.map(() => '?').join(',');
                        assignedGroupsSql += ` AND rug.username IN (${ph})`;
                        assignedParams.push(...userChunk);
                    }
                    const [assignedRows] = await conn.execute(assignedGroupsSql, assignedParams);
                    if (Array.isArray(assignedRows)) assignedList.push(...assignedRows);
                }

                const missingGn = [];
                for (const row of assignedList) {
                    const gn = row && row.gn != null ? String(row.gn).trim() : '';
                    if (!gn || existingGroupKeys.has(gn)) continue;
                    // Safety net: jangan inject profil milik tenant lain ke dropdown
                    if (tenantProfileAllowSet !== null) {
                        const key = normPppoeGroupFn(gn);
                        if (!systemPppoeProfiles.has(key) && !tenantProfileAllowSet.has(key)) {
                            continue;
                        }
                    }
                    existingGroupKeys.add(gn);
                    missingGn.push(gn);
                }
                if (missingGn.length > 0) {
                    const orphanMetaMap = await getPPPoEProfilesMetadata(conn, missingGn);
                    for (const gn of missingGn) {
                        const om = orphanMetaMap[gn] || null;
                        profiles.push({
                            name: om?.display_name || gn,
                            '.id': gn,
                            groupname: gn,
                            'rate-limit': om?.rate_limit || null,
                            'session-timeout': null,
                            'idle-timeout': null,
                            'limit-uptime': null,
                            'shared-users': null,
                            comment:
                                om?.comment ||
                                'Penugasan user (radusergroup). Lengkapi radgroupreply bila ini profil RADIUS.',
                            localAddress: om?.local_address || '',
                            remoteAddress: om?.remote_address || '',
                            dnsServer: om?.dns_server || '',
                            parentQueue: om?.parent_queue || '',
                            addressList: om?.address_list || '',
                            nas_name: 'RADIUS',
                            nas_ip: 'RADIUS Server',
                            is_radius: true,
                            assigned_only: true
                        });
                    }
                    logger.info(
                        `[PPPoE profiles RADIUS] mergeAssigned: +${missingGn.length} grup dari radusergroup untuk dropdown user: ${missingGn.join(', ')}`
                    );
                }
            } catch (mergeErr) {
                logger.warn(`[PPPoE profiles RADIUS] merge radusergroup: ${mergeErr.message}`);
            }
            }
        }

        profiles.sort((a, b) =>
            String(a.groupname || a.name || '').localeCompare(String(b.groupname || b.name || ''), undefined, {
                sensitivity: 'base'
            })
        );

        logger.info(`✅ Total ${profiles.length} profil PPPoE yang akan ditampilkan (dari ${filteredGroupnames.length} setelah filter)`);

        await conn.end();
        return {
            success: true,
            message: `Ditemukan ${profiles.length} profile PPPoE dari RADIUS`,
            data: profiles
        };
    } catch (error) {
        await conn.end();
        logger.error(`Error getting PPPoE profiles from RADIUS: ${error.message}`);
        return { success: false, message: `Gagal ambil data profile PPPoE dari RADIUS: ${error.message}`, data: [] };
    }
}
// Fungsi untuk menambah profile PPPoE ke RADIUS (radgroupreply)
async function addPPPoEProfileRadius(profileData) {
    const {
        claimTenantPppoeProfile,
        releaseTenantPppoeProfile,
        normalizeGroupname: normProfile
    } = require('../utils/tenantPppoeProfileOwnership');

    const conn = await getRadiusConnection();
    try {
        // Normalize groupname: lowercase, underscore-separated
        const requestedName = normProfile(profileData.name || '');
        const displayNameRaw = String(profileData.name || '').trim();
        
        if (!requestedName || requestedName === '') {
            await conn.end();
            return { success: false, message: 'Nama profile tidak boleh kosong' };
        }
        
        // Prevent creating reserved profiles
        const reservedNames = ['isolir', 'default'];
        if (reservedNames.includes(requestedName)) {
            await conn.end();
            const isolirHint =
                requestedName === 'isolir'
                    ? ' Grup ini dibuat otomatis saat isolir pelanggan (RADIUS) dan muncul di halaman Profile PPPoE bila sudah ada di database — tidak perlu ditambah manual.'
                    : '';
            return {
                success: false,
                message: `Profile dengan nama "${requestedName}" adalah profile sistem yang tidak dapat dibuat dari form ini.${isolirHint}`
            };
        }

        let groupname = requestedName;
        try {
            const claim = await claimTenantPppoeProfile(requestedName);
            groupname = normProfile(claim.groupname || requestedName);
        } catch (claimErr) {
            await conn.end();
            return { success: false, message: claimErr.message };
        }
        
        // Check if physical groupname already exists in RADIUS
        const [existing] = await conn.execute(`
            SELECT COUNT(*) as count
            FROM radgroupreply
            WHERE groupname = ?
        `, [groupname]);
        
        if (existing && existing.length > 0 && existing[0].count > 0) {
            // Nama fisik sudah ada — isolasi ke salinan tenant (RADIUS shared, tanpa tenant_id)
            const { getTenantId, hasTenantContext } = require('./platform/tenantContext');
            if (!hasTenantContext()) {
                await conn.end();
                return { success: false, message: `Profile dengan nama "${groupname}" sudah ada di database RADIUS` };
            }
            const tid = getTenantId();
            const privateName = normProfile(`t${tid}_${requestedName}`);
            if (privateName === groupname) {
                await conn.end();
                return { success: false, message: `Profile dengan nama "${groupname}" sudah ada di database RADIUS` };
            }
            const [privExists] = await conn.execute(`
                SELECT COUNT(*) as count FROM radgroupreply WHERE groupname = ?
            `, [privateName]);
            if (privExists && privExists.length > 0 && privExists[0].count > 0) {
                await conn.end();
                return { success: false, message: `Profile dengan nama "${requestedName}" sudah ada untuk tenant ini` };
            }
            try {
                await claimTenantPppoeProfile(privateName);
                // Lepas klaim nama awal agar tidak ada dual-ownership (requested + t{tid}_…)
                if (normProfile(requestedName) !== privateName) {
                    await releaseTenantPppoeProfile(requestedName).catch(() => {});
                }
            } catch (e) {
                await conn.end();
                return { success: false, message: e.message };
            }
            groupname = privateName;
            logger.info(`[addPPPoEProfileRadius] Auto-isolated RADIUS create: "${requestedName}" → "${groupname}"`);
        }
        
        const sanitize = (value) => {
            if (value === undefined || value === null) return null;
            const trimmed = String(value).trim();
            return trimmed === '' ? null : trimmed;
        };

        // Build rate-limit string
        let rateLimitStr = '';
        if (profileData['rate-limit']) {
            rateLimitStr = profileData['rate-limit'];
        } else if (profileData.rateLimit) {
            // Handle format from UI
            const upload = profileData.uploadLimit || '0';
            const download = profileData.downloadLimit || '0';
            rateLimitStr = `${download}/${upload}`;
            
            // Add burst if provided
            if (profileData.burstLimitDownload && profileData.burstLimitUpload && profileData.burstTime) {
                const burstTime = parseInt(profileData.burstTime.replace(/[smhd]/i, '')) || 10;
                rateLimitStr += ` ${profileData.burstLimitDownload}/${profileData.burstLimitUpload}`;
                if (profileData.burstThreshold) {
                    rateLimitStr += ` ${profileData.burstThreshold}/${profileData.burstThreshold}`;
                }
                rateLimitStr += ` ${burstTime}/${burstTime}`;
            }
        }
        
        // Convert timeout to seconds
        const convertToSeconds = (value, unit) => {
            if (!value) return null;
            const num = parseInt(value);
            if (isNaN(num)) return null;
            const unitLower = String(unit || 's').toLowerCase();
            const multipliers = { 's': 1, 'm': 60, 'h': 3600, 'd': 86400 };
            return num * (multipliers[unitLower] || 1);
        };
        
        const sessionTimeout = profileData['session-timeout'] || 
                             (profileData.sessionTimeout ? convertToSeconds(profileData.sessionTimeout, profileData.sessionTimeoutUnit) : null);
        const idleTimeout = profileData['idle-timeout'] || 
                          (profileData.idleTimeout ? convertToSeconds(profileData.idleTimeout, profileData.idleTimeoutUnit) : null);
        
        // Insert Simultaneous-Use (required)
        await conn.execute(`
            INSERT INTO radgroupcheck (groupname, attribute, op, value)
            VALUES (?, 'Simultaneous-Use', ':=', ?)
        `, [groupname, profileData['simultaneous-use'] || '1']);
        
        // Insert Framed-Protocol and Service-Type for PPPoE (required by Mikrotik RADIUS)
        await conn.execute(`
            INSERT INTO radgroupreply (groupname, attribute, op, value)
            VALUES (?, 'Framed-Protocol', ':=', 'PPP')
        `, [groupname]);
        
        await conn.execute(`
            INSERT INTO radgroupreply (groupname, attribute, op, value)
            VALUES (?, 'Service-Type', ':=', 'Framed-User')
        `, [groupname]);
        
        // Insert Rate-Limit if provided
        if (rateLimitStr) {
            await conn.execute(`
                INSERT INTO radgroupreply (groupname, attribute, op, value)
                VALUES (?, 'MikroTik-Rate-Limit', ':=', ?)
            `, [groupname, rateLimitStr]);
        }
        
        // Insert Session-Timeout if provided
        if (sessionTimeout) {
            await conn.execute(`
                INSERT INTO radgroupreply (groupname, attribute, op, value)
                VALUES (?, 'Session-Timeout', ':=', ?)
            `, [groupname, sessionTimeout.toString()]);
        }
        
        // Insert Idle-Timeout if provided
        if (idleTimeout) {
            await conn.execute(`
                INSERT INTO radgroupreply (groupname, attribute, op, value)
                VALUES (?, 'Idle-Timeout', ':=', ?)
            `, [groupname, idleTimeout.toString()]);
        }
        
        // Insert Local-Address (Framed-IP-Address) if provided
        const localAddress = sanitize(profileData['local-address']);
        if (localAddress) {
            await conn.execute(`
                INSERT INTO radgroupreply (groupname, attribute, op, value)
                VALUES (?, 'Framed-IP-Address', ':=', ?)
            `, [groupname, localAddress]);
        }
        
        // Insert Remote-Address (Framed-Pool) if provided
        const remoteAddress = sanitize(profileData['remote-address']);
        if (remoteAddress) {
            // Deteksi apakah ini IP range/address atau pool name
            // IP range format: 192.168.10.100-192.168.10.200 atau 192.168.10.50
            // Pool name format: pool_pppoe, hs-pool-5, dhcp_vlan-GenieAcs, dll
            const ipRangePattern = /^\d+\.\d+\.\d+\.\d+(-\d+\.\d+\.\d+\.\d+)?$/;
            const isIpRange = ipRangePattern.test(remoteAddress);
            
            if (isIpRange) {
                // IP range atau single IP - gunakan Framed-IP-Address
                await conn.execute(`
                    INSERT INTO radgroupreply (groupname, attribute, op, value)
                    VALUES (?, 'Framed-IP-Address', ':=', ?)
                `, [groupname, remoteAddress]);
            } else {
                // Pool name - gunakan Framed-Pool
                await conn.execute(`
                    INSERT INTO radgroupreply (groupname, attribute, op, value)
                    VALUES (?, 'Framed-Pool', ':=', ?)
                `, [groupname, remoteAddress]);
            }
        }
        
        // Insert DNS Server if provided
        const dnsServer = sanitize(profileData['dns-server']);
        if (dnsServer) {
            // Split multiple DNS servers (comma or space separated)
            const dnsServers = dnsServer.split(/[,\s]+/).filter(d => d.trim());
            if (dnsServers.length > 0) {
                // Primary DNS
                await conn.execute(`
                    INSERT INTO radgroupreply (groupname, attribute, op, value)
                    VALUES (?, 'MS-Primary-DNS-Server', ':=', ?)
                `, [groupname, dnsServers[0].trim()]);
                
                // Secondary DNS if provided
                if (dnsServers.length > 1) {
                    await conn.execute(`
                        INSERT INTO radgroupreply (groupname, attribute, op, value)
                        VALUES (?, 'MS-Secondary-DNS-Server', ':=', ?)
                    `, [groupname, dnsServers[1].trim()]);
                }
            }
        }
        
        // Insert Address-List (MikroTik-Address-List) if provided
        const addressList = sanitize(profileData['address-list']);
        if (addressList) {
            await conn.execute(`
                INSERT INTO radgroupreply (groupname, attribute, op, value)
                VALUES (?, 'MikroTik-Address-List', ':=', ?)
            `, [groupname, addressList]);
        }
        
        // Insert Parent-Queue (MikroTik-Parent-Queue) if provided
        const parentQueue = sanitize(profileData['parent-queue']);
        if (parentQueue) {
            await conn.execute(`
                INSERT INTO radgroupreply (groupname, attribute, op, value)
                VALUES (?, 'MikroTik-Parent-Queue', ':=', ?)
            `, [groupname, parentQueue]);
        }
        
        await savePPPoEProfileMetadata(conn, {
            groupname,
            // Tampilkan nama yang diminta user; groupname fisik bisa ber-prefix tenant
            displayName: displayNameRaw || requestedName || groupname,
            comment: sanitize(profileData.comment),
            rateLimit: sanitize(profileData['rate-limit'] || profileData.rateLimit),
            localAddress: sanitize(profileData['local-address']),
            remoteAddress: sanitize(profileData['remote-address']),
            dnsServer: sanitize(profileData['dns-server']),
            parentQueue: sanitize(profileData['parent-queue']),
            addressList: sanitize(profileData['address-list']),
            bridgeLearning: sanitize(profileData['bridge-learning']) || 'default',
            useMpls: sanitize(profileData['use-mpls']) || 'default',
            useCompression: sanitize(profileData['use-compression']) || 'default',
            useEncryption: sanitize(profileData['use-encryption']) || 'default',
            onlyOne: sanitize(profileData['only-one']) || 'default',
            changeTcpMss: sanitize(profileData['change-tcp-mss']) || 'default',
            useUpnp: sanitize(profileData['use-upnp']) || 'default'
        });
        
        // Verifikasi bahwa profil benar-benar tersimpan
        const [verifyRows] = await conn.execute(`
            SELECT COUNT(*) as count
            FROM radgroupreply
            WHERE groupname = ?
        `, [groupname]);
        const count = verifyRows && verifyRows.length > 0 ? verifyRows[0].count : 0;
        logger.info(`✅ Verifikasi: Profile ${groupname} memiliki ${count} attribute(s) di radgroupreply`);
        
        await conn.end();
        logger.info(`✅ Profile RADIUS berhasil ditambahkan: ${groupname}`);
        return { success: true, message: `Profile ${displayNameRaw || requestedName} berhasil ditambahkan ke RADIUS`, groupname };
    } catch (error) {
        await conn.end();
        logger.error(`Error adding PPPoE profile to RADIUS: ${error.message}`);
        return { success: false, message: `Gagal menambahkan profile ke RADIUS: ${error.message}` };
    }
}
// Fungsi untuk edit profile PPPoE di RADIUS (radgroupreply)
async function editPPPoEProfileRadius(profileData) {
    const {
        assertTenantOwnsPppoeProfile,
        ensureExclusivePppoeProfileForTenant,
        renameTenantPppoeProfile,
        normalizeGroupname: normProfile,
        stripTenantProfilePrefix
    } = require('../utils/tenantPppoeProfileOwnership');
    const { hasTenantContext: hasTid, getTenantId } = require('./platform/tenantContext');

    // Ownership / clone-on-conflict SEBELUM buka koneksi utama
    let oldGroupname = normProfile(profileData.groupname || profileData.id || profileData.name);
    const requestedNewName = profileData.name ? normProfile(profileData.name) : oldGroupname;
    let newGroupname = requestedNewName;
    const displayNameRaw = String(profileData.name || '').trim();

    if (!oldGroupname) {
        return { success: false, message: 'Groupname tidak ditemukan' };
    }

    try {
        await assertTenantOwnsPppoeProfile(oldGroupname);
        const exclusive = await ensureExclusivePppoeProfileForTenant(oldGroupname);
        if (exclusive.cloned && exclusive.groupname) {
            oldGroupname = exclusive.groupname;
            if (!profileData.name || normProfile(profileData.name) === normProfile(exclusive.from || '')) {
                newGroupname = exclusive.groupname;
            }
        }
    } catch (ownErr) {
        return { success: false, message: ownErr.message };
    }

    // Nama di form = nama logis dari profil terisolasi (t{tid}_xxx) → jangan rename fisik
    if (hasTid() && newGroupname && newGroupname !== oldGroupname) {
        const tid = getTenantId();
        if (stripTenantProfilePrefix(oldGroupname, tid) === newGroupname) {
            newGroupname = oldGroupname;
        }
    }

    const conn = await getRadiusConnection();
    try {
        const sanitize = (value) => {
            if (value === undefined || value === null) return null;
            const trimmed = String(value).trim();
            return trimmed === '' ? null : trimmed;
        };
        
        // Check if old groupname exists
        const [existing] = await conn.execute(`
            SELECT COUNT(*) as count
            FROM radgroupreply
            WHERE groupname = ?
        `, [oldGroupname]);
        
        if (!existing || existing.length === 0 || existing[0].count === 0) {
            await conn.end();
            return { success: false, message: `Profile dengan nama ${oldGroupname} tidak ditemukan` };
        }
        
        // Jika nama berubah, perlu rename groupname di semua tabel terkait
        if (newGroupname && newGroupname !== oldGroupname && newGroupname !== '') {
            logger.info(`Renaming profile from ${oldGroupname} to ${newGroupname}`);

            // Klaim kepemilikan dulu (auto-isolasi / display-only jika bentrok)
            try {
                const renameResult = await renameTenantPppoeProfile(oldGroupname, newGroupname);
                if (renameResult.displayOnly || renameResult.groupname === oldGroupname) {
                    // Pertahankan groupname fisik; display_name tetap dari input user
                    logger.info(
                        `[editPPPoEProfileRadius] Keep physical "${oldGroupname}", display="${displayNameRaw || requestedNewName}"` +
                        (renameResult.conflict ? ` (conflict=${renameResult.conflict})` : '')
                    );
                    newGroupname = oldGroupname;
                } else if (renameResult.groupname) {
                    newGroupname = normProfile(renameResult.groupname);
                    if (renameResult.isolated) {
                        logger.info(
                            `[editPPPoEProfileRadius] Auto-isolated rename: "${requestedNewName}" → "${newGroupname}"`
                        );
                    }
                }
            } catch (renameOwnErr) {
                await conn.end();
                return { success: false, message: renameOwnErr.message };
            }
        }

        // Rename fisik hanya jika nama benar-benar berubah setelah resolusi kepemilikan
        if (newGroupname && newGroupname !== oldGroupname && newGroupname !== '') {
            // Jika target fisik sudah ada di RADIUS (bukan profil lama), isolasi lagi
            const [newExists] = await conn.execute(`
                SELECT COUNT(*) as count
                FROM radgroupreply
                WHERE groupname = ?
            `, [newGroupname]);

            if (newExists && newExists.length > 0 && newExists[0].count > 0) {
                if (!hasTid()) {
                    await conn.end();
                    return { success: false, message: `Profile dengan nama ${newGroupname} sudah ada` };
                }
                const tid = getTenantId();
                const privateName = normProfile(`t${tid}_${requestedNewName}`);
                const {
                    claimTenantPppoeProfile,
                    releaseTenantPppoeProfile
                } = require('../utils/tenantPppoeProfileOwnership');

                const revertOwnershipToOld = async (claimedName) => {
                    if (!claimedName || claimedName === oldGroupname) return;
                    try {
                        await releaseTenantPppoeProfile(claimedName);
                        await claimTenantPppoeProfile(oldGroupname);
                    } catch (revErr) {
                        logger.warn(`[editPPPoEProfileRadius] revert ownership: ${revErr.message}`);
                    }
                };

                if (!privateName || privateName === newGroupname || privateName === oldGroupname) {
                    logger.warn(
                        `[editPPPoEProfileRadius] RADIUS name busy, keep physical "${oldGroupname}"`
                    );
                    await revertOwnershipToOld(newGroupname);
                    newGroupname = oldGroupname;
                } else {
                    const [privExists] = await conn.execute(`
                        SELECT COUNT(*) as count FROM radgroupreply WHERE groupname = ?
                    `, [privateName]);
                    if (privExists && privExists.length > 0 && privExists[0].count > 0) {
                        logger.warn(
                            `[editPPPoEProfileRadius] Isolated name busy, keep physical "${oldGroupname}"`
                        );
                        await revertOwnershipToOld(newGroupname);
                        newGroupname = oldGroupname;
                    } else {
                        try {
                            const renameResult = await renameTenantPppoeProfile(newGroupname, privateName);
                            if (renameResult.displayOnly || renameResult.groupname === oldGroupname) {
                                await revertOwnershipToOld(newGroupname);
                                newGroupname = oldGroupname;
                            } else {
                                newGroupname = privateName;
                                logger.info(
                                    `[editPPPoEProfileRadius] RADIUS conflict → isolated "${requestedNewName}" to "${newGroupname}"`
                                );
                            }
                        } catch (_) {
                            await releaseTenantPppoeProfile(newGroupname).catch(() => {});
                            await claimTenantPppoeProfile(privateName);
                            newGroupname = privateName;
                        }
                    }
                }
            }
        }

        if (newGroupname && newGroupname !== oldGroupname && newGroupname !== '') {
            // 1. Copy semua data dari old groupname ke new groupname
            // Copy dari radgroupreply
            const [oldReplyRows] = await conn.execute(`
                SELECT attribute, op, value
                FROM radgroupreply
                WHERE groupname = ?
            `, [oldGroupname]);
            
            for (const row of oldReplyRows) {
                // Skip attributes yang akan diupdate
                if (['MikroTik-Rate-Limit', 'Mikrotik-Rate-Limit', 'Session-Timeout', 'Idle-Timeout',
                     'Framed-IP-Address', 'Framed-Pool',
                     'MS-Primary-DNS-Server', 'MS-Secondary-DNS-Server',
                     'MikroTik-Address-List', 'MikroTik-Parent-Queue'].includes(row.attribute)) {
                    continue; // Akan diinsert dengan nilai baru nanti
                }
                
                await conn.execute(`
                    INSERT INTO radgroupreply (groupname, attribute, op, value)
                    VALUES (?, ?, ?, ?)
                `, [newGroupname, row.attribute, row.op, row.value]);
            }
            
            // Copy dari radgroupcheck
            const [oldCheckRows] = await conn.execute(`
                SELECT attribute, op, value
                FROM radgroupcheck
                WHERE groupname = ?
            `, [oldGroupname]);
            
            for (const row of oldCheckRows) {
                await conn.execute(`
                    INSERT INTO radgroupcheck (groupname, attribute, op, value)
                    VALUES (?, ?, ?, ?)
                `, [newGroupname, row.attribute, row.op, row.value]);
            }
            
            // 2. Update radusergroup HANYA untuk user milik tenant ini (bukan global)
            if (hasTid()) {
                const { getTenantAllowedPppoeUsernames } = require('../utils/tenantPppoeOwnership');
                const allowedUsers = await getTenantAllowedPppoeUsernames();
                if (Array.isArray(allowedUsers) && allowedUsers.length > 0) {
                    const chunkSize = 200;
                    for (let i = 0; i < allowedUsers.length; i += chunkSize) {
                        const chunk = allowedUsers.slice(i, i + chunkSize);
                        const placeholders = chunk.map(() => '?').join(',');
                        await conn.execute(
                            `UPDATE radusergroup SET groupname = ?
                             WHERE groupname = ? AND username IN (${placeholders})`,
                            [newGroupname, oldGroupname, ...chunk]
                        );
                    }
                }
            } else {
                await conn.execute(
                    `UPDATE radusergroup SET groupname = ? WHERE groupname = ?`,
                    [newGroupname, oldGroupname]
                );
            }

            // 3. Hapus groupname lama hanya jika tidak ada user RADIUS yang masih memakai
            const [stillUsed] = await conn.execute(
                `SELECT COUNT(*) AS c FROM radusergroup WHERE groupname = ?`,
                [oldGroupname]
            );
            const stillCount = stillUsed && stillUsed[0] ? stillUsed[0].c : 0;
            if (!stillCount) {
                await conn.execute(`DELETE FROM radgroupreply WHERE groupname = ?`, [oldGroupname]);
                await conn.execute(`DELETE FROM radgroupcheck WHERE groupname = ?`, [oldGroupname]);
                await deletePPPoEProfileMetadata(conn, oldGroupname);
            } else {
                logger.info(
                    `Rename profil: menyisakan "${oldGroupname}" di RADIUS (${stillCount} user tenant lain masih memakai)`
                );
            }
        }
        
        // Gunakan groupname yang baru untuk update attributes
        const groupnameToUpdate = (newGroupname && newGroupname !== oldGroupname && newGroupname !== '') ? newGroupname : oldGroupname;
        
        // Delete old attributes yang akan diupdate
        await conn.execute(`
            DELETE FROM radgroupreply
            WHERE groupname = ?
            AND attribute IN (
                'MikroTik-Rate-Limit', 'Mikrotik-Rate-Limit', 
                'Session-Timeout', 'Idle-Timeout',
                'Framed-IP-Address', 'Framed-Pool',
                'MS-Primary-DNS-Server', 'MS-Secondary-DNS-Server',
                'MikroTik-Address-List', 'MikroTik-Parent-Queue',
                'Framed-Protocol', 'Service-Type'
            )
        `, [groupnameToUpdate]);
        
        // Build rate-limit string
        let rateLimitStr = '';
        if (profileData['rate-limit']) {
            rateLimitStr = profileData['rate-limit'];
        } else if (profileData.rateLimit) {
            const upload = profileData.uploadLimit || '0';
            const download = profileData.downloadLimit || '0';
            rateLimitStr = `${download}/${upload}`;
            
            if (profileData.burstLimitDownload && profileData.burstLimitUpload && profileData.burstTime) {
                const burstTime = parseInt(profileData.burstTime.replace(/[smhd]/i, '')) || 10;
                rateLimitStr += ` ${profileData.burstLimitDownload}/${profileData.burstLimitUpload}`;
                if (profileData.burstThreshold) {
                    rateLimitStr += ` ${profileData.burstThreshold}/${profileData.burstThreshold}`;
                }
                rateLimitStr += ` ${burstTime}/${burstTime}`;
            }
        }
        
        // Convert timeout to seconds
        const convertToSeconds = (value, unit) => {
            if (!value) return null;
            const num = parseInt(value);
            if (isNaN(num)) return null;
            const unitLower = String(unit || 's').toLowerCase();
            const multipliers = { 's': 1, 'm': 60, 'h': 3600, 'd': 86400 };
            return num * (multipliers[unitLower] || 1);
        };
        
        const sessionTimeout = profileData['session-timeout'] || 
                             (profileData.sessionTimeout ? convertToSeconds(profileData.sessionTimeout, profileData.sessionTimeoutUnit) : null);
        const idleTimeout = profileData['idle-timeout'] || 
                          (profileData.idleTimeout ? convertToSeconds(profileData.idleTimeout, profileData.idleTimeoutUnit) : null);
        
        // Re-insert Framed-Protocol and Service-Type for PPPoE
        await conn.execute(`
            INSERT INTO radgroupreply (groupname, attribute, op, value)
            VALUES (?, 'Framed-Protocol', ':=', 'PPP')
        `, [groupnameToUpdate]);
        
        await conn.execute(`
            INSERT INTO radgroupreply (groupname, attribute, op, value)
            VALUES (?, 'Service-Type', ':=', 'Framed-User')
        `, [groupnameToUpdate]);

        // Insert updated attributes
        if (rateLimitStr) {
            await conn.execute(`
                INSERT INTO radgroupreply (groupname, attribute, op, value)
                VALUES (?, 'MikroTik-Rate-Limit', ':=', ?)
            `, [groupnameToUpdate, rateLimitStr]);
        }
        
        if (sessionTimeout) {
            await conn.execute(`
                INSERT INTO radgroupreply (groupname, attribute, op, value)
                VALUES (?, 'Session-Timeout', ':=', ?)
            `, [groupnameToUpdate, sessionTimeout.toString()]);
        }
        
        if (idleTimeout) {
            await conn.execute(`
                INSERT INTO radgroupreply (groupname, attribute, op, value)
                VALUES (?, 'Idle-Timeout', ':=', ?)
            `, [groupnameToUpdate, idleTimeout.toString()]);
        }
        
        // Update Simultaneous-Use if provided
        if (profileData['simultaneous-use'] !== undefined) {
            await conn.execute(`
                DELETE FROM radgroupcheck
                WHERE groupname = ? AND attribute = 'Simultaneous-Use'
            `, [groupnameToUpdate]);
            
            await conn.execute(`
                INSERT INTO radgroupcheck (groupname, attribute, op, value)
                VALUES (?, 'Simultaneous-Use', ':=', ?)
            `, [groupnameToUpdate, profileData['simultaneous-use']]);
        }
        
        // Insert/Update Local-Address (Framed-IP-Address) if provided
        // Hapus dulu Framed-IP-Address yang mungkin untuk local address
        // Tapi hati-hati: Framed-IP-Address juga bisa untuk remote address (IP range)
        // Solusi: Hapus semua Framed-IP-Address, lalu insert ulang sesuai kebutuhan
        const localAddress = sanitize(profileData['local-address']);
        const remoteAddress = sanitize(profileData['remote-address']);
        
        logger.info(`🔍 Edit Profile - Remote Address: "${remoteAddress}" (type: ${typeof remoteAddress})`);
        
        // Deteksi remote address type
        let remoteIsIpRange = false;
        if (remoteAddress) {
            const ipRangePattern = /^\d+\.\d+\.\d+\.\d+(-\d+\.\d+\.\d+\.\d+)?$/;
            remoteIsIpRange = ipRangePattern.test(remoteAddress);
            logger.info(`🔍 Remote Address Detection: "${remoteAddress}" -> isIpRange: ${remoteIsIpRange}`);
        } else {
            logger.warn(`⚠️  Remote Address kosong atau null!`);
        }
        
        // Hapus Framed-IP-Address yang lama (untuk local address atau remote address IP range)
        // Tapi hanya jika kita akan insert yang baru
        if (localAddress || (remoteAddress && remoteIsIpRange)) {
            // Hapus semua Framed-IP-Address yang ada
            // Catatan: Ini akan menghapus baik yang untuk local maupun remote
            // Tapi kita akan insert ulang sesuai kebutuhan
            await conn.execute(`
                DELETE FROM radgroupreply
                WHERE groupname = ? AND attribute = 'Framed-IP-Address'
            `, [groupnameToUpdate]);
        }
        
        // Insert Local-Address jika ada
        if (localAddress) {
            await conn.execute(`
                INSERT INTO radgroupreply (groupname, attribute, op, value)
                VALUES (?, 'Framed-IP-Address', ':=', ?)
            `, [groupnameToUpdate, localAddress]);
        }
        
        // Insert/Update Remote-Address
        if (remoteAddress) {
            if (remoteIsIpRange) {
                // IP range atau single IP - gunakan Framed-IP-Address
                // Catatan: Jika local address juga ada, ini akan menimpa
                // Tapi biasanya local address dan remote address IP range tidak digunakan bersamaan
                logger.info(`💾 Menyimpan remote address (IP range): ${remoteAddress} sebagai Framed-IP-Address`);
                await conn.execute(`
                    INSERT INTO radgroupreply (groupname, attribute, op, value)
                    VALUES (?, 'Framed-IP-Address', ':=', ?)
                `, [groupnameToUpdate, remoteAddress]);
            } else {
                // Pool name - gunakan Framed-Pool
                // Hapus dulu Framed-Pool yang lama
                logger.info(`💾 Menyimpan remote address (pool name): ${remoteAddress} sebagai Framed-Pool`);
                await conn.execute(`
                    DELETE FROM radgroupreply
                    WHERE groupname = ? AND attribute = 'Framed-Pool'
                `, [groupnameToUpdate]);
                
                await conn.execute(`
                    INSERT INTO radgroupreply (groupname, attribute, op, value)
                    VALUES (?, 'Framed-Pool', ':=', ?)
                `, [groupnameToUpdate, remoteAddress]);
                logger.info(`✅ Framed-Pool berhasil disimpan: ${groupnameToUpdate} = ${remoteAddress}`);
            }
        } else {
            // Jika remote address kosong, hapus Framed-Pool yang ada
            logger.info(`🗑️ Menghapus Framed-Pool karena remote address kosong`);
            await conn.execute(`
                DELETE FROM radgroupreply
                WHERE groupname = ? AND attribute = 'Framed-Pool'
            `, [groupnameToUpdate]);
        }
        
        // Insert/Update DNS Server if provided
        const dnsServer = sanitize(profileData['dns-server']);
        if (dnsServer) {
            // Split multiple DNS servers (comma or space separated)
            const dnsServers = dnsServer.split(/[,\s]+/).filter(d => d.trim());
            if (dnsServers.length > 0) {
                // Primary DNS
                await conn.execute(`
                    INSERT INTO radgroupreply (groupname, attribute, op, value)
                    VALUES (?, 'MS-Primary-DNS-Server', ':=', ?)
                `, [groupnameToUpdate, dnsServers[0].trim()]);
                
                // Secondary DNS if provided
                if (dnsServers.length > 1) {
                    await conn.execute(`
                        INSERT INTO radgroupreply (groupname, attribute, op, value)
                        VALUES (?, 'MS-Secondary-DNS-Server', ':=', ?)
                    `, [groupnameToUpdate, dnsServers[1].trim()]);
                }
            }
        }
        
        // Insert/Update Address-List (MikroTik-Address-List) if provided
        const addressList = sanitize(profileData['address-list']);
        if (addressList) {
            await conn.execute(`
                INSERT INTO radgroupreply (groupname, attribute, op, value)
                VALUES (?, 'MikroTik-Address-List', ':=', ?)
            `, [groupnameToUpdate, addressList]);
        }
        
        // Insert/Update Parent-Queue (MikroTik-Parent-Queue) if provided
        const parentQueue = sanitize(profileData['parent-queue']);
        if (parentQueue) {
            await conn.execute(`
                INSERT INTO radgroupreply (groupname, attribute, op, value)
                VALUES (?, 'MikroTik-Parent-Queue', ':=', ?)
            `, [groupnameToUpdate, parentQueue]);
        }

        await savePPPoEProfileMetadata(conn, {
            groupname: groupnameToUpdate,
            displayName: displayNameRaw || requestedNewName || groupnameToUpdate,
            comment: sanitize(profileData.comment),
            rateLimit: rateLimitStr ? rateLimitStr.trim() : sanitize(profileData['rate-limit'] || profileData.rateLimit),
            localAddress: sanitize(profileData['local-address']),
            remoteAddress: sanitize(profileData['remote-address']),
            dnsServer: sanitize(profileData['dns-server']),
            parentQueue: sanitize(profileData['parent-queue']),
            addressList: sanitize(profileData['address-list']),
            bridgeLearning: sanitize(profileData['bridge-learning']) || 'default',
            useMpls: sanitize(profileData['use-mpls']) || 'default',
            useCompression: sanitize(profileData['use-compression']) || 'default',
            useEncryption: sanitize(profileData['use-encryption']) || 'default',
            onlyOne: sanitize(profileData['only-one']) || 'default',
            changeTcpMss: sanitize(profileData['change-tcp-mss']) || 'default',
            useUpnp: sanitize(profileData['use-upnp']) || 'default'
        });
        
        await conn.end();
        const finalGroupname = (newGroupname && newGroupname !== oldGroupname && newGroupname !== '') ? newGroupname : oldGroupname;
        const finalDisplay = displayNameRaw || requestedNewName || finalGroupname;
        logger.info(`✅ Profile RADIUS berhasil diupdate: ${finalGroupname} (display: ${finalDisplay})`);
        return { success: true, message: `Profile ${finalDisplay} berhasil diupdate di RADIUS`, groupname: finalGroupname };
    } catch (error) {
        await conn.end();
        logger.error(`Error editing PPPoE profile in RADIUS: ${error.message}`);
        return { success: false, message: `Gagal mengupdate profile di RADIUS: ${error.message}` };
    }
}
// Fungsi untuk hapus profile PPPoE dari RADIUS (radgroupreply)
async function deletePPPoEProfileRadius(groupname) {
    const {
        assertTenantOwnsPppoeProfile,
        releaseTenantPppoeProfile,
        normalizeGroupname: normProfile
    } = require('../utils/tenantPppoeProfileOwnership');

    const normalized = normProfile(groupname);
    try {
        await assertTenantOwnsPppoeProfile(normalized);
    } catch (ownErr) {
        return { success: false, message: ownErr.message };
    }

    const conn = await getRadiusConnection();
    try {
        if (!normalized) {
            await conn.end();
            return { success: false, message: 'Groupname tidak boleh kosong' };
        }

        if (normalized === 'isolir' || normalized === 'default') {
            await conn.end();
            return { success: false, message: `Profile sistem "${normalized}" tidak dapat dihapus` };
        }
        
        // Check if groupname is used by any user (case-insensitive — GRATIS/gratis)
        const [userCheck] = await conn.execute(`
            SELECT COUNT(*) as count
            FROM radusergroup
            WHERE LOWER(TRIM(groupname)) = LOWER(TRIM(?))
        `, [normalized]);
        
        if (userCheck && userCheck.length > 0 && userCheck[0].count > 0) {
            await conn.end();
            return { success: false, message: `Profile ${normalized} masih digunakan oleh ${userCheck[0].count} user. Pindahkan user ke profile lain terlebih dahulu.` };
        }
        
        // Delete from radgroupreply / radgroupcheck (semua variasi huruf besar-kecil)
        await conn.execute(`
            DELETE FROM radgroupreply
            WHERE LOWER(TRIM(groupname)) = LOWER(TRIM(?))
        `, [normalized]);
        
        await conn.execute(`
            DELETE FROM radgroupcheck
            WHERE LOWER(TRIM(groupname)) = LOWER(TRIM(?))
        `, [normalized]);
        
        await deletePPPoEProfileMetadata(conn, normalized);
        await releaseTenantPppoeProfile(normalized);

        await conn.end();
        logger.info(`✅ Profile RADIUS berhasil dihapus: ${normalized}`);
        return { success: true, message: `Profile ${normalized} berhasil dihapus dari RADIUS` };
    } catch (error) {
        await conn.end();
        logger.error(`Error deleting PPPoE profile from RADIUS: ${error.message}`);
        return { success: false, message: `Gagal menghapus profile dari RADIUS: ${error.message}` };
    }
}
// Fungsi untuk mendapatkan detail profile PPPoE dari RADIUS
async function getPPPoEProfileDetailRadius(groupname) {
    const {
        assertTenantOwnsPppoeProfile,
        normalizeGroupname: normProfile
    } = require('../utils/tenantPppoeProfileOwnership');

    const normalized = normProfile(groupname);
    try {
        await assertTenantOwnsPppoeProfile(normalized);
    } catch (ownErr) {
        return { success: false, message: ownErr.message, data: null };
    }

    const conn = await getRadiusConnection();
    try {
        if (!normalized) {
            await conn.end();
            return { success: false, message: 'Groupname tidak boleh kosong', data: null };
        }
        
        // Get all attributes for this group
        const [attrRows] = await conn.execute(`
            SELECT attribute, value
            FROM radgroupreply
            WHERE groupname = ?
            ORDER BY attribute
        `, [normalized]);
        
        const [checkRows] = await conn.execute(`
            SELECT attribute, value
            FROM radgroupcheck
            WHERE groupname = ?
            ORDER BY attribute
        `, [normalized]);

        const metadata = await getPPPoEProfileMetadata(conn, normalized);
        
        if (attrRows.length === 0 && checkRows.length === 0 && !metadata) {
            await conn.end();
            return { success: false, message: 'Profile tidak ditemukan', data: null };
        }
        
        // Build profile object
        // Inisialisasi dengan metadata, tapi attribute dari radgroupreply akan override
        const profile = {
            name: metadata?.display_name || normalized,
            '.id': normalized,
            groupname: normalized,
            'rate-limit': null,
            'session-timeout': null,
            'idle-timeout': null,
            'limit-uptime': null,
            'shared-users': metadata?.shared_users || null,
            limitUptimeValue: metadata?.limit_uptime_value || null,
            limitUptimeUnit: metadata?.limit_uptime_unit || null,
            limitUptimeSeconds: null,
            validityValue: metadata?.validity_value || null,
            validityUnit: metadata?.validity_unit || null,
            validitySeconds: null,
            validityString: null,
            comment: metadata?.comment || '',
            // Inisialisasi kosong, akan diisi dari attribute (prioritas utama untuk RADIUS)
            localAddress: '',
            remoteAddress: '',
            dnsServer: '',
            parentQueue: '',
            addressList: '',
            nas_name: 'RADIUS',
            nas_ip: 'RADIUS Server',
            is_radius: true
        };
        
        // Parse attributes
        [...attrRows, ...checkRows].forEach(attr => {
            switch (attr.attribute) {
                case 'MikroTik-Rate-Limit':
                case 'Mikrotik-Rate-Limit':
                    profile['rate-limit'] = attr.value;
                    break;
                case 'Session-Timeout': {
                    const formatted = formatSecondsToDuration(attr.value);
                    if (formatted) {
                        profile.sessionTimeout = formatted.value;
                        profile.sessionTimeoutUnit = formatted.unit;
                        profile['session-timeout'] = formatted.string;
                    } else {
                        const parsed = parseTimeoutValue(attr.value);
                        profile.sessionTimeout = parsed.raw;
                        profile.sessionTimeoutUnit = parsed.unit;
                        profile['session-timeout'] = attr.value;
                    }
                    break;
                }
                case 'Max-All-Session': {
                    const formatted = formatSecondsToDuration(attr.value);
                    if (formatted) {
                        profile.limitUptimeSeconds = formatted.seconds;
                        profile.limitUptimeValue = formatted.value;
                        profile.limitUptimeUnit = formatted.unit;
                        profile['limit-uptime'] = formatted.string;
                    }
                    break;
                }
                case 'Idle-Timeout': {
                    const formatted = formatSecondsToDuration(attr.value);
                    if (formatted) {
                        profile.idleTimeout = formatted.value;
                        profile.idleTimeoutUnit = formatted.unit;
                        profile['idle-timeout'] = formatted.string;
                    } else {
                        const parsed = parseTimeoutValue(attr.value);
                        profile.idleTimeout = parsed.raw;
                        profile.idleTimeoutUnit = parsed.unit;
                        profile['idle-timeout'] = attr.value;
                    }
                    break;
                }
                case 'Expire-After': {
                    const formatted = formatSecondsToDuration(attr.value);
                    if (formatted) {
                        profile.validitySeconds = formatted.seconds;
                        profile.validityValue = formatted.value;
                        profile.validityUnit = formatted.unit;
                        profile.validityString = formatted.string;
                    }
                    break;
                }
                case 'Mikrotik-Shared-Users':
                case 'MikroTik-Shared-Users':
                case 'Simultaneous-Use':
                    profile['shared-users'] = attr.value;
                    break;
                case 'Framed-IP-Address':
                    // Framed-IP-Address bisa untuk local address (single IP) atau remote address (IP range)
                    // Deteksi: jika mengandung "-" berarti IP range (remote address)
                    // Jika tidak mengandung "-" berarti single IP (local address)
                    const ipRangePatternDetail = /^\d+\.\d+\.\d+\.\d+-\d+\.\d+\.\d+\.\d+$/;
                    const isIpRangeDetail = ipRangePatternDetail.test(attr.value);
                    
                    if (isIpRangeDetail) {
                        // IP range = remote address
                        profile.remoteAddress = attr.value;
                        logger.debug(`📝 [Detail] Framed-IP-Address "${attr.value}" terdeteksi sebagai IP range (remote address)`);
                    } else {
                        // Single IP = local address
                        if (!profile.localAddress || profile.localAddress === '') {
                            profile.localAddress = attr.value;
                            logger.debug(`📝 [Detail] Framed-IP-Address "${attr.value}" terdeteksi sebagai single IP (local address)`);
                        } else {
                            // Jika localAddress sudah ada, update dengan yang baru
                            profile.localAddress = attr.value;
                        }
                    }
                    break;
                case 'Framed-Pool':
                    // Framed-Pool adalah untuk remote address (pool name)
                    // Selalu gunakan dari attribute karena ini sumber kebenaran untuk RADIUS
                    profile.remoteAddress = attr.value;
                    break;
                case 'MS-Primary-DNS-Server':
                    // Combine dengan secondary DNS jika ada
                    if (!profile.dnsServer || profile.dnsServer === '') {
                        profile.dnsServer = attr.value;
                    } else {
                        profile.dnsServer = attr.value + ',' + (profile.dnsServer.split(',')[1] || '');
                    }
                    break;
                case 'MS-Secondary-DNS-Server':
                    // Combine dengan primary DNS jika ada
                    if (!profile.dnsServer || profile.dnsServer === '') {
                        profile.dnsServer = attr.value;
                    } else {
                        const primary = profile.dnsServer.split(',')[0] || profile.dnsServer;
                        profile.dnsServer = primary + ',' + attr.value;
                    }
                    break;
                case 'MikroTik-Address-List':
                    profile.addressList = attr.value;
                    break;
                case 'MikroTik-Parent-Queue':
                    profile.parentQueue = attr.value;
                    break;
            }
        });

        // Override dengan metadata hanya jika attribute tidak ada
        if (!profile['rate-limit'] && metadata?.rate_limit) {
            profile['rate-limit'] = metadata.rate_limit;
        }
        
        // Override dengan metadata hanya jika attribute tidak ada (fallback)
        if (!profile.localAddress && metadata?.local_address) {
            profile.localAddress = metadata.local_address;
        }
        if (!profile.remoteAddress && metadata?.remote_address) {
            profile.remoteAddress = metadata.remote_address;
        }
        if (!profile.dnsServer && metadata?.dns_server) {
            profile.dnsServer = metadata.dns_server;
        }
        if (!profile.parentQueue && metadata?.parent_queue) {
            profile.parentQueue = metadata.parent_queue;
        }
        if (!profile.addressList && metadata?.address_list) {
            profile.addressList = metadata.address_list;
        }
        
        // CRITICAL: Map camelCase fields to kebab-case for UI compatibility
        // UI menggunakan profile['remote-address'], tapi kita set remoteAddress
        if (profile.remoteAddress) {
            profile['remote-address'] = profile.remoteAddress;
        }
        if (profile.localAddress) {
            profile['local-address'] = profile.localAddress;
        }
        if (profile.dnsServer) {
            profile['dns-server'] = profile.dnsServer;
        }
        if (profile.parentQueue) {
            profile['parent-queue'] = profile.parentQueue;
        }
        if (profile.addressList) {
            profile['address-list'] = profile.addressList;
        }
        
        logger.debug(`📋 [Detail] Profile ${groupname} - remoteAddress: "${profile.remoteAddress}", 'remote-address': "${profile['remote-address']}"`);
        
        const idleUnit = metadata.idle_timeout_unit ? metadata.idle_timeout_unit.toLowerCase() : '';
        if (metadata.idle_timeout_value && idleUnit) {
            const formatted = `${metadata.idle_timeout_value}${idleUnit}`;
            profile.idleTimeout = metadata.idle_timeout_value;
            profile.idleTimeoutUnit = idleUnit;
            profile['idle-timeout'] = formatted;
        }

        const limitUnit = metadata.limit_uptime_unit ? metadata.limit_uptime_unit.toLowerCase() : '';
        if (metadata.limit_uptime_value && limitUnit) {
            const formatted = `${metadata.limit_uptime_value}${limitUnit}`;
            profile.limitUptimeValue = metadata.limit_uptime_value;
            profile.limitUptimeUnit = limitUnit;
            profile['limit-uptime'] = formatted;
            const seconds = durationToSeconds(metadata.limit_uptime_value, limitUnit);
            if (seconds) {
                profile.limitUptimeSeconds = seconds;
            }
        }

        const validityUnit = metadata.validity_unit ? metadata.validity_unit.toLowerCase() : '';
        if (metadata.validity_value && validityUnit) {
            const formatted = `${metadata.validity_value}${validityUnit}`;
            profile.validityValue = metadata.validity_value;
            profile.validityUnit = validityUnit;
            profile.validityString = formatted;
            const seconds = durationToSeconds(metadata.validity_value, validityUnit);
            if (seconds) {
                profile.validitySeconds = seconds;
            }
        }
        
        if (profile['limit-uptime']) {
            profile.limitUptimeString = profile['limit-uptime'];
        }
        if (profile.validityString) {
            profile['validity-period'] = profile.validityString;
        }
        
        await conn.end();
        return {
            success: true,
            message: 'Detail profile berhasil diambil',
            data: profile
        };
    } catch (error) {
        await conn.end();
        logger.error(`Error getting PPPoE profile detail from RADIUS: ${error.message}`);
        return { success: false, message: `Gagal ambil detail profile: ${error.message}`, data: null };
    }
}
// Fungsi untuk menambah profile PPPoE
async function addPPPoEProfile(profileData, routerObj = null) {
    try {
        // Check auth mode
        const mode = await getUserAuthModeAsync();
        if (mode === 'radius') {
            return await addPPPoEProfileRadius(profileData);
        }
        
        // Mikrotik API mode
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
            logger.info(`Connecting to router for addPPPoEProfile: ${routerObj.name} (${routerObj.nas_ip}:${routerObj.port || 8728})`);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) throw new Error('Koneksi ke Mikrotik gagal');
        
        const params = [
            '=name=' + profileData.name
        ];
        
        // Tambahkan field opsional jika ada
        if (profileData['rate-limit']) params.push('=rate-limit=' + profileData['rate-limit']);
        if (profileData['local-address']) params.push('=local-address=' + profileData['local-address']);
        if (profileData['remote-address']) params.push('=remote-address=' + profileData['remote-address']);
        if (profileData['dns-server']) params.push('=dns-server=' + profileData['dns-server']);
        if (profileData['parent-queue']) params.push('=parent-queue=' + profileData['parent-queue']);
        if (profileData['address-list']) params.push('=address-list=' + profileData['address-list']);
        if (profileData.comment) params.push('=comment=' + profileData.comment);
        if (profileData['bridge-learning'] && profileData['bridge-learning'] !== 'default') params.push('=bridge-learning=' + profileData['bridge-learning']);
        if (profileData['use-mpls'] && profileData['use-mpls'] !== 'default') params.push('=use-mpls=' + profileData['use-mpls']);
        if (profileData['use-compression'] && profileData['use-compression'] !== 'default') params.push('=use-compression=' + profileData['use-compression']);
        if (profileData['use-encryption'] && profileData['use-encryption'] !== 'default') params.push('=use-encryption=' + profileData['use-encryption']);
        if (profileData['only-one'] && profileData['only-one'] !== 'default') params.push('=only-one=' + profileData['only-one']);
        if (profileData['change-tcp-mss'] && profileData['change-tcp-mss'] !== 'default') params.push('=change-tcp-mss=' + profileData['change-tcp-mss']);
        await conn.write('/ppp/profile/add', params);
        
        return { success: true };
    } catch (error) {
        logger.error(`Error adding PPPoE profile: ${error.message}`);
        return { success: false, message: error.message };
    }
}
// Fungsi untuk edit profile PPPoE
async function editPPPoEProfile(profileData, routerObj = null) {
    try {
        // Check auth mode
        const mode = await getUserAuthModeAsync();
        if (mode === 'radius') {
            return await editPPPoEProfileRadius(profileData);
        }
        
        // Mikrotik API mode
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
            logger.info(`Connecting to router for editPPPoEProfile: ${routerObj.name} (${routerObj.nas_ip}:${routerObj.port || 8728})`);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) throw new Error('Koneksi ke Mikrotik gagal');
        
        const params = [
            '=.id=' + profileData.id
        ];
        
        // Tambahkan field yang akan diupdate
        if (profileData.name) params.push('=name=' + profileData.name);
        if (profileData['rate-limit'] !== undefined) params.push('=rate-limit=' + profileData['rate-limit']);
        if (profileData['local-address'] !== undefined) params.push('=local-address=' + profileData['local-address']);
        if (profileData['remote-address'] !== undefined) params.push('=remote-address=' + profileData['remote-address']);
        if (profileData['dns-server'] !== undefined) params.push('=dns-server=' + profileData['dns-server']);
        if (profileData['parent-queue'] !== undefined) params.push('=parent-queue=' + profileData['parent-queue']);
        if (profileData['address-list'] !== undefined) params.push('=address-list=' + profileData['address-list']);
        if (profileData.comment !== undefined) params.push('=comment=' + profileData.comment);
        if (profileData['bridge-learning'] !== undefined) params.push('=bridge-learning=' + profileData['bridge-learning']);
        if (profileData['use-mpls'] !== undefined) params.push('=use-mpls=' + profileData['use-mpls']);
        if (profileData['use-compression'] !== undefined) params.push('=use-compression=' + profileData['use-compression']);
        if (profileData['use-encryption'] !== undefined) params.push('=use-encryption=' + profileData['use-encryption']);
        if (profileData['only-one'] !== undefined) params.push('=only-one=' + profileData['only-one']);
        if (profileData['change-tcp-mss'] !== undefined) params.push('=change-tcp-mss=' + profileData['change-tcp-mss']);
        
        await conn.write('/ppp/profile/set', params);
        
        return { success: true };
    } catch (error) {
        logger.error(`Error editing PPPoE profile: ${error.message}`);
        return { success: false, message: error.message };
    }
}

// Fungsi untuk hapus profile PPPoE
async function deletePPPoEProfile(id, routerObj = null) {
    try {
        // Check auth mode - if id is a groupname (string), it's RADIUS mode
        const mode = await getUserAuthModeAsync();
        if (mode === 'radius' || (typeof id === 'string' && !id.match(/^\d+$/))) {
            return await deletePPPoEProfileRadius(id);
        }
        
        // Mikrotik API mode
        let conn = null;
        if (routerObj) {
            conn = await getMikrotikConnectionForRouter(routerObj);
            logger.info(`Connecting to router for deletePPPoEProfile: ${routerObj.name} (${routerObj.nas_ip}:${routerObj.port || 8728})`);
        } else {
            conn = await getMikrotikConnection();
        }
        if (!conn) throw new Error('Koneksi ke Mikrotik gagal');
        
        await conn.write('/ppp/profile/remove', [ '=.id=' + id ]);
        
        return { success: true };
    } catch (error) {
        logger.error(`Error deleting PPPoE profile: ${error.message}`);
        return { success: false, message: error.message };
    }
}
// Fungsi untuk generate hotspot vouchers
async function generateHotspotVouchers(count, prefix, profile, server, limits = {}, price, charType = 'alphanumeric', routerObj = null) {
    try {
        // Check auth mode - RADIUS atau Mikrotik API
        const mode = await getUserAuthModeAsync();
        const isRadiusMode = mode === 'radius';
        
        // Harga voucher diambil dari input form "Harga" di /admin/hotspot/voucher
        // Invoice SELALU dibuat untuk voucher, bahkan jika harga 0 atau tidak diisi
        // Parse price dengan lebih robust: handle string, number, null, undefined, empty string
        let finalPrice = 0;
        if (price !== null && price !== undefined && price !== '') {
            const parsedPrice = parseFloat(price);
            if (!isNaN(parsedPrice)) {
                finalPrice = parsedPrice;
            }
        }
        logger.info(`generateHotspotVouchers: Parsed price from ${price} (type: ${typeof price}) to ${finalPrice} for ${count} vouchers`);
        
        // Normalisasi metadata server
        let serverMetadata = {};
        let serverName = 'all';
        if (server && typeof server === 'object' && !Array.isArray(server)) {
            serverMetadata = { ...server };
            serverName = (serverMetadata.name || serverMetadata.server || 'all').toString().trim() || 'all';
        } else if (typeof server === 'string') {
            serverName = server.trim() || 'all';
            serverMetadata = { name: serverName };
        } else {
            serverMetadata = { name: 'all' };
        }
        serverMetadata.name = serverName;
        
        // Untuk mode Mikrotik API, validasi koneksi terlebih dahulu
        if (!isRadiusMode) {
            let conn = null;
            if (routerObj) {
                conn = await getMikrotikConnectionForRouter(routerObj);
                logger.info(`Connecting to router: ${routerObj.name} (${routerObj.nas_ip}:${routerObj.port || 8728}) for voucher generation`);
            } else {
                conn = await getMikrotikConnection();
            }
            if (!conn) {
                logger.error('Tidak dapat terhubung ke Mikrotik');
                return { success: false, message: 'Tidak dapat terhubung ke Mikrotik', vouchers: [] };
            }
        }
        
        // Get voucher generation settings from database
        const voucherSettings = await getVoucherGenerationSettings();
        
        // Fungsi untuk generate random string berdasarkan jenis karakter
        function randomString(length, charType = 'alphanumeric') {
            let chars;
            switch (charType) {
                case 'numeric':
                    chars = '0123456789';
                    break;
                case 'alphabetic':
                    chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
                    break;
                case 'alphanumeric':
                default:
                    chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
                    break;
            }
            let str = '';
            for (let i = 0; i < length; i++) {
                str += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return str;
        }
        
        const limitOptions = limits && typeof limits === 'object' ? limits : {};
        const validitySeconds = limitOptions.validitySeconds && !isNaN(parseInt(limitOptions.validitySeconds, 10)) && parseInt(limitOptions.validitySeconds, 10) > 0
            ? parseInt(limitOptions.validitySeconds, 10)
            : null;
        const uptimeSeconds = limitOptions.uptimeSeconds && !isNaN(parseInt(limitOptions.uptimeSeconds, 10)) && parseInt(limitOptions.uptimeSeconds, 10) > 0
            ? parseInt(limitOptions.uptimeSeconds, 10)
            : null;

        const vouchers = [];
        
        // Log untuk debugging
        logger.info(`Generating ${count} vouchers with prefix ${prefix} and profile ${profile} (Mode: ${isRadiusMode ? 'RADIUS' : 'Mikrotik API'}) - Server: ${serverName}`);
        
        for (let i = 0; i < count; i++) {
            // Generate username and password based on settings
            const usernameLength = parseInt(voucherSettings.username_length || 4);
            const charTypeSetting = voucherSettings.char_type || charType;
            const accountType = voucherSettings.account_type || 'voucher';
            
            const username = prefix + randomString(usernameLength, charTypeSetting);
            
            // Generate password berdasarkan tipe akun
            let password;
            if (accountType === 'voucher') {
                // Voucher: password sama dengan username
                password = username;
            } else {
                // Member: password berbeda dari username
                const passwordLength = parseInt(voucherSettings.password_length_separate || 6);
                password = randomString(passwordLength, 'alphanumeric');
            }
            
            try {
                // Tambahkan user hotspot menggunakan addHotspotUser (otomatis handle RADIUS/Mikrotik)
                // Di mode RADIUS, routerObj akan diabaikan oleh addHotspotUser
                // Pass finalPrice ke addHotspotUser untuk menyimpan ke voucher_revenue (TANPA membuat invoice)
                // Invoice hanya untuk pelanggan PPPoE, bukan untuk voucher
                // Pass server parameter untuk menentukan server instance (jika dipilih)
                const addResult = await addHotspotUser(
                    username,
                    password,
                    profile,
                    'voucher',
                    null,
                    routerObj,
                    finalPrice,
                    serverName,
                    serverMetadata,
                    { validitySeconds, uptimeSeconds }
                );
                
                // Voucher revenue record sudah dibuat di dalam addHotspotUser untuk mode RADIUS
                // Untuk mode Mikrotik API, simpan ke voucher_revenue di bawah ini jika belum dibuat
                let voucherRecordId = addResult.voucherRecordId || null;
                if (!voucherRecordId && !isRadiusMode && addResult.success) {
                    try {
                        await ensureVoucherRevenueColumns();
                        const sqlite3 = require('sqlite3').verbose();
                        const dbPath = require('path').join(__dirname, '../data/billing.db');
                        const db = new sqlite3.Database(dbPath);
                        let apiServerNameForVoucher = serverName && ['all', 'semua', ''].includes(serverName.toLowerCase()) ? null : serverName;
                        let apiServerMetadataForStore = null;
                        if (serverMetadata && typeof serverMetadata === 'object') {
                            const metadataToStore = { ...serverMetadata };
                            if (!metadataToStore.name && apiServerNameForVoucher) {
                                metadataToStore.name = apiServerNameForVoucher;
                            }
                            try {
                                apiServerMetadataForStore = JSON.stringify(metadataToStore);
                            } catch (jsonErr) {
                                logger.warn(`Failed to stringify server metadata for voucher ${username}: ${jsonErr.message}`);
                            }
                        } else if (apiServerNameForVoucher) {
                            apiServerMetadataForStore = JSON.stringify({ name: apiServerNameForVoucher });
                        }
                        await new Promise((resolve, reject) => {
                            db.serialize(() => {
                                db.get(`SELECT id FROM voucher_revenue WHERE username = ?`, [username], async (selectErr, existing) => {
                                    if (selectErr) {
                                        reject(selectErr);
                                        return;
                                    }

                                    const runAsync = (sql, params) => new Promise((res, rej) => {
                                        db.run(sql, params, function(err) {
                                            if (err) {
                                                rej(err);
                                            } else {
                                                res(this);
                                            }
                                        });
                                    });

                                    try {
                                        if (existing && existing.id) {
                                            await runAsync(`
                                                UPDATE voucher_revenue
                                                SET price = ?, profile = ?, status = ?, notes = ?, server_name = COALESCE(?, server_name), server_metadata = COALESCE(?, server_metadata)
                                                WHERE username = ?
                                            `, [
                                                finalPrice,
                                                profile,
                                                'unpaid',
                                                `Voucher Hotspot ${username} - Profile: ${profile}`,
                                                apiServerNameForVoucher,
                                                apiServerMetadataForStore,
                                                username
                                            ]);
                                            voucherRecordId = existing.id;
                                        } else {
                                            const insertResult = await runAsync(`
                                                INSERT INTO voucher_revenue (username, price, profile, created_at, status, notes, server_name, server_metadata, tenant_id)
                                    VALUES (?, ?, ?, datetime('now','localtime'), ?, ?, ?, ?, ?)
                                            `, [
                                                username,
                                                finalPrice,
                                                profile,
                                                'unpaid',
                                                `Voucher Hotspot ${username} - Profile: ${profile}`,
                                                apiServerNameForVoucher,
                                                apiServerMetadataForStore,
                                                (hasTenantContext() ? getTenantId() : 1)
                                            ]);
                                            voucherRecordId = insertResult ? insertResult.lastID : null;
                                        }
                                        resolve();
                                    } catch (runErr) {
                                        reject(runErr);
                                    }
                                });
                            });
                        });
                        
                        db.close();
                    } catch (voucherError) {
                        // Log error tapi jangan gagalkan pembuatan voucher
                        logger.error(`Error saving voucher revenue record for ${username}: ${voucherError.message}`);
                    }
                }
                
                // Tambahkan ke array vouchers
                vouchers.push({
                    username,
                    password,
                    profile,
                    server: serverName,
                    nas_name: isRadiusMode ? 'RADIUS' : (routerObj ? routerObj.name : 'default'),
                    nas_ip: isRadiusMode ? 'RADIUS' : (routerObj ? routerObj.nas_ip : ''),
                    createdAt: new Date(),
                    price: finalPrice, // Tambahkan harga ke data voucher
                    account_type: accountType, // Tambahkan tipe akun
                    voucher_record_id: voucherRecordId, // Tambahkan voucher revenue record ID jika ada
                    validitySeconds,
                    uptimeSeconds
                });
                
                logger.info(`${accountType === 'voucher' ? 'Voucher' : 'Member'} created: ${username} (password: ${password}) on ${isRadiusMode ? 'RADIUS' : (routerObj ? routerObj.name : 'default')}${voucherRecordId ? ` - Voucher Revenue Record: ${voucherRecordId} (Amount: Rp ${finalPrice})` : ' - NO VOUCHER RECORD CREATED!'}`);
            } catch (err) {
                logger.error(`Failed to create voucher ${username}: ${err.message}`);
                // Lanjutkan ke voucher berikutnya
            }
        }
        
        logger.info(`Successfully generated ${vouchers.length} vouchers`);
        
        return {
            success: true,
            message: `Berhasil membuat ${vouchers.length} voucher`,
            vouchers: vouchers
        };
    } catch (error) {
        logger.error(`Error generating vouchers: ${error.message}`);
        return {
            success: false,
            message: `Gagal generate voucher: ${error.message}`,
            vouchers: []
        };
    }
}

// Fungsi untuk mengambil pengaturan generate voucher dari database
async function getVoucherGenerationSettings() {
    try {
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('./data/billing.db');
        
        return new Promise((resolve, reject) => {
            db.all("SELECT setting_key, setting_value FROM voucher_generation_settings", (err, rows) => {
                if (err) {
                    console.log('⚠️ voucher_generation_settings table not found, using defaults');
                    resolve({});
                    return;
                }
                
                const settings = {};
                rows.forEach(row => {
                    settings[row.setting_key] = row.setting_value;
                });
                
                db.close();
                resolve(settings);
            });
        });
    } catch (error) {
        console.error('Error getting voucher generation settings:', error);
        return {};
    }
}
// Fungsi untuk test generate voucher (tanpa menyimpan ke Mikrotik)
async function generateTestVoucher(settings) {
    try {
        // Fungsi untuk generate random string berdasarkan jenis karakter
        function randomString(length, charType = 'alphanumeric') {
            let chars;
            switch (charType) {
                case 'numeric':
                    chars = '0123456789';
                    break;
                case 'alphabetic':
                    chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
                    break;
                case 'alphanumeric':
                default:
                    chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
                    break;
            }
            let str = '';
            for (let i = 0; i < length; i++) {
                str += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return str;
        }

        // Generate username berdasarkan format
        let username;
        const usernameLength = parseInt(settings.username_length || 4);
        const charType = settings.char_type || 'alphanumeric';
        const usernameFormat = settings.username_format || 'V{timestamp}';

        switch (usernameFormat) {
            case 'V{timestamp}':
                const timestamp = Date.now().toString().slice(-6);
                username = 'V' + timestamp + randomString(usernameLength, charType);
                break;
            case 'V{random}':
                username = 'V' + randomString(usernameLength, charType);
                break;
            case '{random}':
                username = randomString(usernameLength, charType);
                break;
            default:
                username = 'V' + randomString(usernameLength, charType);
        }

        // Generate password berdasarkan tipe akun
        let password;
        const accountType = settings.account_type || 'voucher';
        
        if (accountType === 'voucher') {
            // Voucher: password sama dengan username
            password = username;
        } else {
            // Member: password berbeda dari username
            const passwordLength = parseInt(settings.password_length_separate || 6);
            password = randomString(passwordLength, 'alphanumeric');
        }

        return {
            success: true,
            username: username,
            password: password,
            account_type: accountType,
            message: `Test generate ${accountType} berhasil`
        };

    } catch (error) {
        return {
            success: false,
            message: 'Gagal test generate voucher: ' + error.message
        };
    }
}

// --- Watcher settings.json untuk reset koneksi Mikrotik jika setting berubah ---
const settingsPath = path.join(process.cwd(), 'settings.json');
let lastMikrotikConfig = {};

function getCurrentMikrotikConfig() {
    return {
        host: getSetting('mikrotik_host', '192.168.8.1'),
        port: getSetting('mikrotik_port', '8728'),
        user: getSetting('mikrotik_user', 'admin'),
        password: getSetting('mikrotik_password', 'admin')
    };
}

function mikrotikConfigChanged(newConfig, oldConfig) {
    return (
        newConfig.host !== oldConfig.host ||
        newConfig.port !== oldConfig.port ||
        newConfig.user !== oldConfig.user ||
        newConfig.password !== oldConfig.password
    );
}
// Inisialisasi config awal
lastMikrotikConfig = getCurrentMikrotikConfig();

fs.watchFile(settingsPath, { interval: 2000 }, (curr, prev) => {
    try {
        const newConfig = getCurrentMikrotikConfig();
        if (mikrotikConfigChanged(newConfig, lastMikrotikConfig)) {
            logger.info('Konfigurasi Mikrotik di settings.json berubah, reset koneksi Mikrotik...');
            mikrotikConnection = null;
            lastMikrotikConfig = newConfig;
        }
    } catch (e) {
        logger.error('Gagal cek perubahan konfigurasi Mikrotik:', e.message);
    }
});
let voucherRevenueColumnsChecked = false;
async function ensureVoucherRevenueColumns() {
    if (voucherRevenueColumnsChecked) return true;
    try {
        const sqlite3 = require('sqlite3').verbose();
        const dbPath = require('path').join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        const columns = await new Promise((resolve, reject) => {
            db.all("PRAGMA table_info(voucher_revenue)", [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
        const columnNames = new Set(columns.map(col => (col.name || '').toLowerCase()));
        const runAlter = async (sql) => {
            await new Promise((resolve, reject) => {
                db.run(sql, err => {
                    if (err) {
                        logger.warn(`Failed to alter voucher_revenue table with SQL: ${sql} -> ${err.message}`);
                        resolve();
                    } else {
                        resolve();
                    }
                });
            });
        };
        if (!columnNames.has('server_name')) {
            await runAlter("ALTER TABLE voucher_revenue ADD COLUMN server_name TEXT");
        }
        if (!columnNames.has('server_metadata')) {
            await runAlter("ALTER TABLE voucher_revenue ADD COLUMN server_metadata TEXT");
        }
        db.close();
        voucherRevenueColumnsChecked = true;
        return true;
    } catch (error) {
        logger.warn(`ensureVoucherRevenueColumns failed: ${error.message}`);
        return false;
    }
}

// Fungsi untuk mendapatkan RouterOS version
async function getRouterOSVersion(routerObj) {
    try {
        const conn = await getMikrotikConnectionForRouter(routerObj);
        if (!conn) {
            throw new Error('Gagal koneksi ke router');
        }
        
        try {
            const resources = await conn.write('/system/resource/print');
            if (resources && resources[0] && resources[0].version) {
                const version = resources[0].version;
                // Parse version: "7.15" -> 7, "6.49.10" -> 6
                const majorVersion = parseInt(version.split('.')[0]);
                conn.close();
                return { success: true, version: version, major: majorVersion };
            }
        } catch (e) {
            logger.warn('Failed to get version from /system/resource:', e.message);
        }
        
        conn.close();
        return { success: false, version: null, major: null };
    } catch (error) {
        logger.error('Error getting RouterOS version:', error);
        return { success: false, version: null, major: null, error: error.message };
    }
}

// Fungsi untuk execute script Mikrotik (kompatibel ROS 6.x dan 7.x)
async function executeMikrotikScript(script, routerObj, rosVersion = null) {
    let conn = null;
    try {
        // Connect ke router
        conn = await getMikrotikConnectionForRouter(routerObj);
        if (!conn) {
            throw new Error('Gagal koneksi ke router');
        }
        
        // Detect ROS version jika tidak diberikan
        let detectedVersion = null;
        if (!rosVersion || rosVersion === 'auto') {
            const versionInfo = await getRouterOSVersion(routerObj);
            if (versionInfo.success && versionInfo.major) {
                detectedVersion = versionInfo.major;
                logger.info(`Detected RouterOS version: ${versionInfo.version} (major: ${detectedVersion})`);
            } else {
                // Default ke ROS 7 jika tidak bisa detect
                detectedVersion = 7;
                logger.warn('Could not detect ROS version, defaulting to ROS 7');
            }
        } else {
            detectedVersion = parseInt(rosVersion);
        }
        
        // Parse script menjadi commands
        const lines = script.split('\n');
        const commands = [];
        
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            
            // Skip empty lines dan comments
            if (!line || line.startsWith('#') || line.startsWith('//')) {
                continue;
            }
            
            // Handle multi-line commands (ending with \)
            if (line.endsWith('\\')) {
                let fullCommand = line.slice(0, -1).trim();
                i++;
                while (i < lines.length) {
                    const nextLine = lines[i].trim();
                    if (!nextLine || nextLine.startsWith('#')) {
                        i--;
                        break;
                    }
                    if (nextLine.endsWith('\\')) {
                        fullCommand += ' ' + nextLine.slice(0, -1).trim();
                        i++;
                    } else {
                        fullCommand += ' ' + nextLine.trim();
                        break;
                    }
                }
                line = fullCommand.trim();
            }
            
            // Skip :put, :log, echo commands (tidak perlu execute)
            if (line.startsWith(':put') || line.startsWith(':log') || line.startsWith('echo')) {
                continue;
            }
            
            // Skip print commands (hanya untuk melihat data, tidak perlu execute)
            // Check berbagai format: /ip ... print, print where, etc.
            if (line.includes('/print') || line.match(/\s+print\s+/i) || line.trim().endsWith('print')) {
                logger.debug(`Skipping print/verification command: ${line}`);
                continue;
            }
            
            // Parse command: /ip firewall nat add chain=dstnat ...
            // Extract path dan params
            if (line.startsWith('/')) {
                // Check jika line mengandung "print" SEBELUM split (untuk catch semua format)
                // Command seperti "/ip firewall address-list print where" harus di-skip
                if (line.includes(' print ') || line.includes(' print where') || line.match(/\s+print\s+/i) || line.toLowerCase().includes(' print')) {
                    logger.debug(`Skipping print command (pre-check): ${line}`);
                    continue;
                }
                
                // Split line dengan regex yang lebih robust untuk handle multiple spaces
                // Gunakan split dengan regex untuk handle multiple spaces/tabs
                const parts = line.split(/\s+/).filter(p => p && p.trim() !== '');
                
                // Build full path: /ip firewall nat add -> /ip/firewall/nat/add
                // Tapi stop jika menemukan "print" atau action (add, set, remove, etc.)
                let pathParts = [];
                let paramsStartIndex = 0;
                let isPrintCommand = false;
                
                for (let j = 0; j < parts.length; j++) {
                    const part = parts[j].toLowerCase();
                    // Stop jika menemukan "print" atau action
                    if (part === 'print' || part === 'add' || part === 'set' || part === 'remove' || part === 'enable' || part === 'disable') {
                        if (part === 'print') {
                            // Ini adalah print command, skip
                            logger.debug(`Skipping print command (found 'print' in path): ${line}`);
                            isPrintCommand = true;
                            break; // Break dari loop j
                        }
                        // Ini adalah action, jadi path berakhir di sini
                        pathParts.push(parts[j]);
                        paramsStartIndex = j + 1;
                        break;
                    }
                    pathParts.push(parts[j]);
                }
                
                // Skip command ini jika adalah print command
                if (isPrintCommand) {
                    continue; // Continue ke line berikutnya (skip command ini)
                }
                
                // Jika tidak ada action ditemukan, semua adalah path
                if (paramsStartIndex === 0) {
                    paramsStartIndex = pathParts.length;
                }
                
                const path = pathParts.join('/');
                const params = parts.slice(paramsStartIndex);
                
                // Normalize params: remove empty strings dan trim
                const normalizedParams = params.filter(p => p && p.trim() !== '').map(p => p.trim());
                
                logger.info(`[PARSE] Parsed command - Path: ${path}, Params count: ${normalizedParams.length}, Params:`, normalizedParams);
                
                // Parse params menjadi object
                // Handle parameter dengan format: key=value atau key="value with spaces"
                // Value bisa mengandung = atau / (seperti IP dengan CIDR: 172.30.0.0/32)
                const paramObj = {};
                let currentKey = null;
                let currentValue = '';
                let inQuotes = false;
                
                // Iterate through normalized params
                for (let j = 0; j < normalizedParams.length; j++) {
                    const param = normalizedParams[j];
                    const equalsIndex = param.indexOf('=');
                    
                    if (equalsIndex > 0 && !inQuotes) {
                        // Save previous key-value
                        if (currentKey) {
                            paramObj[currentKey] = currentValue.trim() || true;
                        }
                        
                        // New key-value pair
                        currentKey = param.substring(0, equalsIndex);
                        currentValue = param.substring(equalsIndex + 1);
                        
                        // Check if value starts with quote
                        if (currentValue.startsWith('"')) {
                            inQuotes = true;
                            currentValue = currentValue.slice(1);
                            // Check if quote ends in same param (e.g., list="isolir-users")
                            // Perlu check length > 0 untuk handle kasus list="" (empty string dalam quotes)
                            if (currentValue.endsWith('"')) {
                                inQuotes = false;
                                // Strip closing quote
                                currentValue = currentValue.slice(0, -1);
                            }
                        }
                    } else if (inQuotes) {
                        // Continue building quoted value
                        currentValue += ' ' + param;
                        if (param.endsWith('"')) {
                            inQuotes = false;
                            currentValue = currentValue.slice(0, -1);
                            // Setelah quotes ditutup, save currentKey dan reset untuk parameter berikutnya
                            if (currentKey) {
                                paramObj[currentKey] = currentValue.trim();
                                currentKey = null;
                                currentValue = '';
                            }
                            // Setelah quotes ditutup, parameter berikutnya akan di-parse di iterasi berikutnya
                            // Tapi kita perlu handle kasus jika ada parameter lagi di iterasi yang sama
                            // (tidak mungkin karena kita sudah di akhir param yang mengandung closing quote)
                        }
                    } else if (currentKey) {
                        // Value continuation (untuk kasus seperti IP dengan CIDR: 172.30.0.0/32)
                        // Hanya tambahkan jika bukan key baru (tidak mengandung =)
                        if (equalsIndex < 0) {
                            // Ini adalah continuation dari value sebelumnya (bukan key baru)
                            currentValue += ' ' + param;
                        } else {
                            // Ini adalah key baru, save yang sebelumnya dulu
                            paramObj[currentKey] = currentValue.trim() || true;
                            currentKey = param.substring(0, equalsIndex);
                            currentValue = param.substring(equalsIndex + 1);
                            if (currentValue.startsWith('"')) {
                                inQuotes = true;
                                currentValue = currentValue.slice(1);
                                if (currentValue.endsWith('"')) {
                                    inQuotes = false;
                                    currentValue = currentValue.slice(0, -1);
                                }
                            }
                        }
                    } else {
                        // Tidak ada currentKey dan tidak dalam quotes, ini seharusnya key baru
                        // Tapi jika tidak ada =, ini mungkin parameter flag (tanpa value)
                        if (equalsIndex < 0) {
                            // Parameter flag (tanpa value)
                            paramObj[param] = true;
                        } else {
                            // Key-value pair baru
                            currentKey = param.substring(0, equalsIndex);
                            currentValue = param.substring(equalsIndex + 1);
                            if (currentValue.startsWith('"')) {
                                inQuotes = true;
                                currentValue = currentValue.slice(1);
                                if (currentValue.endsWith('"')) {
                                    inQuotes = false;
                                    currentValue = currentValue.slice(0, -1);
                                }
                            }
                        }
                    }
                }
                
                // Save last key-value
                if (currentKey) {
                    const finalValue = currentValue.trim();
                    // Jika value kosong atau hanya whitespace, set sebagai true (flag parameter)
                    // Tapi jika value adalah string kosong setelah trim quotes, tetap set sebagai empty string
                    paramObj[currentKey] = finalValue === '' ? true : finalValue;
                }
                
                // Convert paramObj ke array format untuk RouterOSAPI
                // Format node-routeros: =key=value atau =key (untuk flag)
                const paramArray = [];
                for (const [key, value] of Object.entries(paramObj)) {
                    if (value === true || value === '') {
                        // Flag parameter (tanpa value)
                        paramArray.push(`=${key}`);
                    } else {
                        // Key-value parameter dengan format =key=value
                        paramArray.push(`=${key}=${value}`);
                    }
                }
                
                // Debug: log parameter yang akan dikirim (gunakan info untuk visibility)
                logger.info(`[PARSE] Command: ${path}`);
                logger.info(`[PARSE] Normalized params (${normalizedParams.length}):`, normalizedParams);
                logger.info(`[PARSE] Parsed paramObj:`, JSON.stringify(paramObj, null, 2));
                logger.info(`[PARSE] Final paramArray (${paramArray.length}):`, paramArray);
                
                // Skip jika path mengandung /print (untuk verifikasi, tidak perlu execute)
                // Check berbagai format: /ip ... print, print where, etc.
                if (path.includes('/print') || path.endsWith('/print') || line.includes(' print ') || line.includes(' print where')) {
                    logger.debug(`Skipping print command: ${line}`);
                    continue;
                }
                
                commands.push({ path, params: paramArray, original: line });
            }
        }
        
        logger.info(`Executing ${commands.length} commands to router ${routerObj.name} (${routerObj.nas_ip})`);
        
        // Filter out any print commands that might have slipped through
        const executableCommands = commands.filter(cmd => {
            // Check berbagai format print command
            const isPrint = cmd.path.includes('/print') || 
                           cmd.path.endsWith('/print') || 
                           cmd.original.includes(' print ') || 
                           cmd.original.includes(' print where') ||
                           cmd.original.match(/\s+print\s+/i) ||
                           cmd.original.toLowerCase().includes('print');
            if (isPrint) {
                logger.debug(`Filtering out print command: ${cmd.original} (path: ${cmd.path})`);
                return false;
            }
            return true;
        });
        
        logger.info(`After filtering print commands: ${executableCommands.length} commands to execute (filtered ${commands.length - executableCommands.length} print commands)`);
        
        // Execute commands
        let executed = 0;
        let failed = 0;
        const errors = [];
        
        for (const cmd of executableCommands) {
            try {
                // Double check: skip print commands (seharusnya sudah di-skip di parsing, tapi untuk safety)
                // Check berbagai format print command
                if (cmd.path.includes('/print') || cmd.path.endsWith('/print') || 
                    cmd.original.includes(' print ') || cmd.original.includes(' print where') ||
                    cmd.original.match(/\s+print\s+/i)) {
                    logger.debug(`Skipping print command: ${cmd.path} (original: ${cmd.original})`);
                    continue;
                }
                
                logger.info(`[EXEC] Executing command: ${cmd.path}`);
                logger.info(`[EXEC] Command params (${cmd.params.length}):`, cmd.params);
                logger.info(`[EXEC] Original command: ${cmd.original}`);
                
                // Handle different command types
                if (cmd.path.includes('/remove')) {
                    // Remove command: /ip firewall nat remove [find ...]
                    // Extract find condition
                    const findMatch = cmd.original.match(/\[find\s+(.+?)\]/);
                    if (findMatch) {
                        const findCondition = findMatch[1];
                        // Parse find condition dan execute
                        const findParams = [];
                        if (findCondition.includes('where')) {
                            // ROS 7 format: [find where ...]
                            const whereMatch = findCondition.match(/where\s+(.+)/);
                            if (whereMatch) {
                                const whereClause = whereMatch[1];
                                // Parse where clause
                                if (whereClause.includes('comment~')) {
                                    const commentMatch = whereClause.match(/comment~"(.+?)"/);
                                    if (commentMatch) {
                                        findParams.push(`?comment~${commentMatch[1]}`);
                                    }
                                } else if (whereClause.includes('name=')) {
                                    const nameMatch = whereClause.match(/name="(.+?)"/);
                                    if (nameMatch) {
                                        findParams.push(`?name=${nameMatch[1]}`);
                                    }
                                }
                            }
                        } else {
                            // ROS 6 format: [find ...]
                            if (findCondition.includes('comment~')) {
                                const commentMatch = findCondition.match(/comment~"(.+?)"/);
                                if (commentMatch) {
                                    findParams.push(`?comment~${commentMatch[1]}`);
                                }
                            }
                        }
                        
                        const results = await conn.write(cmd.path.replace('/remove', '/print'), findParams);
                        if (results && results.length > 0) {
                            for (const item of results) {
                                await conn.write(cmd.path, [`=.id=${item['.id']}`]);
                            }
                        }
                    } else {
                        // Simple remove with ID
                        await conn.write(cmd.path, cmd.params);
                    }
                } else if (cmd.path.includes('/add')) {
                    // Add command
                    // Pastikan params adalah array dan tidak kosong
                    const addParams = Array.isArray(cmd.params) ? cmd.params : [];
                    if (addParams.length > 0) {
                        await conn.write(cmd.path, addParams);
                    } else {
                        logger.warn(`Add command with no params, skipping: ${cmd.path}`);
                        continue;
                    }
                } else if (cmd.path.includes('/set')) {
                    // Set command - need .id
                    const setParams = Array.isArray(cmd.params) ? cmd.params : [];
                    if (setParams.length > 0) {
                        await conn.write(cmd.path, setParams);
                    } else {
                        logger.warn(`Set command with no params, skipping: ${cmd.path}`);
                        continue;
                    }
                } else {
                    // Other commands - skip print commands (sudah di-skip di parsing)
                    if (cmd.path.includes('/print')) {
                        logger.debug(`Skipping print command: ${cmd.path}`);
                        continue;
                    }
                    // Pastikan params adalah array
                    const otherParams = Array.isArray(cmd.params) ? cmd.params : [];
                    await conn.write(cmd.path, otherParams);
                }
                
                executed++;
            } catch (cmdError) {
                // Check jika error adalah "already exists" atau "already have such entry"
                // Error ini tidak fatal karena berarti settingan sudah ada
                const errorMsg = cmdError.message || '';
                const isNonFatalError = 
                    errorMsg.includes('already have such entry') ||
                    errorMsg.includes('already exists') ||
                    errorMsg.includes('profile with the same name already exists') ||
                    errorMsg.includes('entry already exists');
                
                if (isNonFatalError) {
                    // Hanya log sebagai info, tidak dihitung sebagai failed
                    logger.info(`⚠️  Command skipped (already exists): ${cmd.original} - ${errorMsg}`);
                    executed++; // Tetap dihitung sebagai executed karena settingan sudah ada (tujuan tercapai)
                } else {
                    failed++;
                    errors.push(`Command failed: ${cmd.original} - ${errorMsg}`);
                    logger.warn(`Command failed: ${cmd.original}`, cmdError);
                }
                // Continue dengan command berikutnya
            }
        }
        
        conn.close();
        
        if (failed > 0) {
            logger.warn(`Script execution completed with ${failed} failed commands out of ${executableCommands.length}`);
            return {
                success: true,
                commands_executed: executed,
                commands_failed: failed,
                total_commands: executableCommands.length,
                ros_version: detectedVersion,
                warnings: errors
            };
        }
        
        return {
            success: true,
            commands_executed: executed,
            commands_failed: 0,
            total_commands: executableCommands.length,
            ros_version: detectedVersion,
            message: `Script berhasil dijalankan: ${executed} commands executed`
        };
    } catch (error) {
        if (conn) {
            try {
                conn.close();
            } catch (e) {
                // Ignore
            }
        }
        logger.error('Error executing Mikrotik script:', error);
        return {
            success: false,
            message: error.message || 'Gagal menjalankan script ke Mikrotik'
        };
    }
}

/**
 * Online check for static IP via ARP (+ optional DHCP).
 * Returns Set of IP strings that appear online on the given router.
 * Cached singkat agar halaman users tidak sering blank/timeout.
 */
const staticIpOnlineCache = new Map(); // key -> { at, set }

async function getStaticIpOnlineSetForRouter(router, ips = []) {
    const wanted = new Set((ips || []).map((ip) => String(ip || '').trim()).filter(Boolean));
    const online = new Set();
    if (!router || wanted.size === 0) return online;

    const shortKey = `r${router.id}:${wanted.size}:${simpleHash([...wanted].sort().join('|'))}`;
    const cached = staticIpOnlineCache.get(shortKey);
    if (cached && Date.now() - cached.at < 45000) {
        for (const ip of cached.set) {
            if (wanted.has(ip)) online.add(ip);
        }
        return online;
    }

    const withTimeout = async (promise, ms) => {
        let timer;
        try {
            return await Promise.race([
                promise,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
                })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    };

    try {
        const conn = await getMikrotikConnectionForRouter(router);

        // 1) ARP — sumber utama status online static IP
        try {
            const arps = await withTimeout(
                conn.write('/ip/arp/print', [
                    '=.proplist=address,mac-address,status,complete'
                ]),
                12000
            );
            for (const row of arps || []) {
                const ip = String(row.address || '').trim();
                if (!wanted.has(ip)) continue;
                const status = String(row.status || '').toLowerCase();
                if (status === 'failed') continue;
                const mac = String(row['mac-address'] || '').trim();
                const complete = row.complete === 'true' || row.complete === true;
                const live =
                    complete ||
                    status === 'reachable' ||
                    status === 'stale' ||
                    status === 'delay' ||
                    status === 'permanent' ||
                    status === '' ||
                    !status;
                // Banyak RouterOS tampilkan ARP aktif cukup dengan mac-address
                if (mac || live) online.add(ip);
            }
        } catch (e) {
            logger.warn(`[STATIC-IP-ARP] arp print failed: ${e.message}`);
        }

        // 2) DHCP lease bound (opsional, cepat) — skip connection tracking (sering lambat/timeout)
        if (online.size < wanted.size) {
            try {
                const leases = await withTimeout(
                    conn.write('/ip/dhcp-server/lease/print', [
                        '=.proplist=address,status,active-mac-address'
                    ]),
                    4000
                );
                for (const row of leases || []) {
                    const ip = String(row.address || '').trim();
                    if (!wanted.has(ip)) continue;
                    const status = String(row.status || '').toLowerCase();
                    const activeMac = String(row['active-mac-address'] || '').trim();
                    if (status === 'bound' || activeMac) online.add(ip);
                }
            } catch (_) {
                /* DHCP optional */
            }
        }

        staticIpOnlineCache.set(shortKey, { at: Date.now(), set: new Set(online) });
        // batasi cache entries
        if (staticIpOnlineCache.size > 40) {
            const oldest = [...staticIpOnlineCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (oldest) staticIpOnlineCache.delete(oldest[0]);
        }
    } catch (e) {
        logger.warn(`[STATIC-IP-ARP] router connect failed: ${e.message}`);
        // pakai cache lama jika ada meski expired (grace)
        if (cached && cached.set) {
            for (const ip of cached.set) {
                if (wanted.has(ip)) online.add(ip);
            }
        }
    }
    return online;
}

function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return String(h);
}

// Export all functions
module.exports = {
    setSock,
    connectToMikrotik,
    getMikrotikConnection,
    getMikrotikConnectionForRouter,
    testMikrotikConnectionForRouter,
    getCachedFullPppSecrets,
    getCachedPppActivePrint,
    clearPppPrintCachesForRouter,
    getMikrotikConnectionForCustomer,
    getRouterForCustomer,
    getStaticIpOnlineSetForRouter,
    getPPPoEUsers,
    addPPPoEUser,
    editPPPoEUser,
    deletePPPoEUser,
    getActivePPPoEConnections,
    formatUptime,
    getInactivePPPoEUsers,
    getRouterResources,
    getResourceInfo,
    getResourceInfoForRouter,
    getActiveHotspotUsers,
    addHotspotUser,
    deleteHotspotUser,
    addPPPoESecret,
    deletePPPoESecret,
    setPPPoEProfile,
    disconnectPPPoEUser,
    disconnectPPPoEUserAllRouters,
    monitorPPPoEConnections,
    getInterfaces,
    getInterfacesForRouter,
    getAddressPoolsForRouter,
    getInterfaceDetail,
    setInterfaceStatus,
    getIPAddresses,
    addIPAddress,
    deleteIPAddress,
    getRoutes,
    addRoute,
    deleteRoute,
    getDHCPLeases,
    getDHCPServers,
    pingHost,
    getSystemLogs,
    // PPPoE/Hotspot profile helpers (needed by /admin/mikrotik)
    getPPPoEProfiles,
    getPPPoEProfileDetail,
    addPPPoEProfile,
    editPPPoEProfile,
    deletePPPoEProfile,
    // RADIUS profile functions
    getPPPoEProfilesRadius,
    addPPPoEProfileRadius,
    editPPPoEProfileRadius,
    deletePPPoEProfileRadius,
    getPPPoEProfileDetailRadius,
    getHotspotProfiles,
    getHotspotProfilesRadius,
    getHotspotProfileDetail,
    getHotspotProfileDetailRadius,
    saveHotspotProfileMetadata,
    deleteHotspotProfileMetadata,
    addHotspotProfile,
    editHotspotProfile,
    deleteHotspotProfile,
    getHotspotServerProfiles,
    getHotspotServerProfilesRadius,
    getHotspotServerProfileDetailRadius,
    addHotspotServerProfileRadius,
    editHotspotServerProfileRadius,
    deleteHotspotServerProfileRadius,
    addHotspotServerProfileMikrotik,
    editHotspotServerProfileMikrotik,
    deleteHotspotServerProfileMikrotik,
    getHotspotUsersRadius,
    getMembersWithStatusRadius,
    addHotspotUserRadius,
    getHotspotServers,
    addHotspotServer,
    editHotspotServer,
    deleteHotspotServer,
    getHotspotServerDetail,
    disconnectHotspotUser,
    disableHotspotUserRadius,
    enableHotspotUserRadius,
    generateHotspotVouchers,
    getInterfaceTraffic,
    // RADIUS functions
    getRadiusConnection,
    syncRadiusToFreeRadiusMysql,
    getRadcheckCleartextPassword,
    getPppSecretCleartextPasswordFromMikrotikRouters,
    resolveRadiusProfileGroupname,
    resolvePppoeProfileHintToRadiusGroup,
    getUserAuthModeAsync,
    getRadiusStatistics,
    getPPPoEUsersRadius,
    getActivePPPoEConnectionsRadius,
    getActivePppoeLoginNamesSet,
    getActivePppoeLoginNamesSetWithUptimeMap,
    collectMikrotikPppActiveSessionsByLoginMap,
    getPppoeLoginOnlineStatus,
    updatePPPoEUserRadiusPassword,
    assignPackageRadius,
    ensureIsolirProfileRadius,
    suspendUserRadius,
    updateIsolirPreviousGroupRadius,
    unsuspendUserRadius,
    syncPackageLimitsToRadius,
    syncPackageLimitsToMikrotik,
    ensurePppoeProfileForPackage,
    buildMikrotikRateLimit,
    formatSecondsToDuration,
    durationToSeconds,
    executeMikrotikScript,
    getRouterOSVersion
};