// Functions untuk manage FreeRADIUS clients.conf
// Sekarang menggunakan RADIUS SQLite database sebagai primary storage
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./logger');

const CLIENTS_CONF_PATH = '/etc/freeradius/3.0/clients.conf';
const APP_ROOT = path.join(__dirname, '..');
const CLIENTS_CONF_MIRROR = path.join(APP_ROOT, 'data', 'clients.conf.mirror');

/** Terakhir hasil baca clients.conf (untuk pesan di UI) */
let _clientsConfReadDiag = {
    ok: false,
    sourcePath: null,
    attempted: [],
    hint: null
};

function getRadiusClientsConfReadDiagnostics() {
    return { ..._clientsConfReadDiag };
}

// Import RADIUS connection
const { getRadiusConnection } = require('./radiusSQLite');
const { hasTenantContext, getTenantId } = require('./platform/tenantContext');

const SYSTEM_NAS_IPS = new Set(['127.0.0.1', '::1']);
const SYSTEM_NAS_NAMES = new Set(['localhost', 'localhost_ipv6']);

function isSystemNasClient(client) {
    const ip = String(client?.ipaddr || client?.nasname || '').trim();
    const name = String(client?.name || client?.shortname || '').trim();
    return SYSTEM_NAS_IPS.has(ip) || SYSTEM_NAS_NAMES.has(name);
}

function resolveTenantIdForNas(explicitTenantId = null) {
    if (explicitTenantId != null && Number.isFinite(Number(explicitTenantId))) {
        return parseInt(explicitTenantId, 10);
    }
    if (hasTenantContext()) {
        return parseInt(getTenantId(), 10);
    }
    return null;
}

function clientBelongsToTenant(client, tenantId) {
    if (tenantId == null) return true;
    if (isSystemNasClient(client)) return false;
    const tid = client?.tenant_id;
    return tid != null && Number(tid) === Number(tenantId);
}

function filterClientsForTenant(clients, tenantId = null) {
    const tid = resolveTenantIdForNas(tenantId);
    if (tid == null) return clients || [];
    return (clients || []).filter((c) => clientBelongsToTenant(c, tid));
}

/**
 * Merge perubahan client milik satu tenant tanpa menghapus client tenant lain / system.
 */
function mergeTenantClientsIntoAll(allClients, tenantClients, tenantId) {
    const tid = resolveTenantIdForNas(tenantId);
    if (tid == null) {
        return tenantClients;
    }
    const others = (allClients || []).filter((c) => !clientBelongsToTenant(c, tid));
    const owned = (tenantClients || []).map((c) => ({
        ...c,
        tenant_id: tid
    }));
    return [...others, ...owned].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

async function ensureNasTenantColumn(conn) {
    try {
        const [cols] = await conn.execute('PRAGMA table_info(nas)');
        const hasTenant = Array.isArray(cols) && cols.some((c) => String(c.name).toLowerCase() === 'tenant_id');
        if (hasTenant) return;
        await conn.execute('ALTER TABLE nas ADD COLUMN tenant_id INTEGER');
        logger.info('[RADIUS-CLIENTS] Kolom tenant_id ditambahkan ke tabel nas');
    } catch (e) {
        const msg = String(e.message || e);
        if (!/duplicate column|already exists/i.test(msg)) {
            logger.debug(`[RADIUS-CLIENTS] ensureNasTenantColumn: ${msg}`);
        }
    }
}

async function backfillNasTenantIdsFromRouters(conn) {
    try {
        const sqlite3 = require('sqlite3').verbose();
        const path = require('path');
        const billingPath = path.join(__dirname, '../data/billing.db');
        const routers = await new Promise((resolve) => {
            const db = new sqlite3.Database(billingPath);
            db.all('SELECT nas_ip, tenant_id FROM routers WHERE nas_ip IS NOT NULL AND tenant_id IS NOT NULL', [], (err, rows) => {
                db.close();
                resolve(err ? [] : (rows || []));
            });
        });
        if (!routers.length) return;

        const byIp = new Map();
        for (const r of routers) {
            const ip = String(r.nas_ip || '').trim();
            if (ip) byIp.set(ip, parseInt(r.tenant_id, 10));
        }

        const [rows] = await conn.execute(
            'SELECT id, nasname, tenant_id FROM nas WHERE tenant_id IS NULL OR tenant_id = 0'
        );
        for (const row of Array.isArray(rows) ? rows : []) {
            const ip = String(row.nasname || '').trim();
            if (SYSTEM_NAS_IPS.has(ip)) continue;
            const tid = byIp.get(ip);
            if (tid == null) continue;
            await conn.execute('UPDATE nas SET tenant_id = ? WHERE id = ?', [tid, row.id]);
        }
    } catch (e) {
        logger.warn(`[RADIUS-CLIENTS] Backfill tenant_id nas gagal: ${e.message}`);
    }
}

/**
 * Initialize clients management using existing FreeRADIUS nas table
 * The nas table is already created in radiusSQLite.js schema
 */
async function initializeClientsTable() {
    try {
        const conn = await getRadiusConnection();
        await ensureNasTenantColumn(conn);
        await backfillNasTenantIdsFromRouters(conn);
        const result = await conn.execute('SELECT COUNT(*) as count FROM nas');
        logger.info('[RADIUS-CLIENTS] Clients table ready - using nas table from FreeRADIUS schema');
        await conn.end();
        return true;
    } catch (error) {
        logger.error('[RADIUS-CLIENTS] Error verifying clients table:', error.message);
        return false;
    }
}

// Initialize table on load (non-blocking)
initializeClientsTable().catch(err => {
    logger.warn('[RADIUS-CLIENTS] Table initialization warning:', err.message);
    // Don't fail startup if initialization has issues
});

/**
 * Parse clients: gabungan tabel nas (SQLite) + /etc/freeradius/3.0/clients.conf.
 * - Tampilan aplikasi = union keduanya (dedupe per IP / nama).
 * - Jika nas kosong tetapi clients.conf berisi client, isi ulang nas otomatis agar konsisten dengan FR.
 * - Simpan dari UI menulis clients.conf DAN nas (lihat writeClientsConfToDB).
 */
async function parseClientsConfFromDB(options = {}) {
    const tenantId = options.tenantId !== undefined
        ? options.tenantId
        : resolveTenantIdForNas();
    let dbRows = [];
    try {
        const conn = await getRadiusConnection();
        await ensureNasTenantColumn(conn);
        const [rows] = await conn.execute(`
            SELECT id, nasname, shortname, type, secret, description, tenant_id
            FROM nas
            ORDER BY nasname
        `);
        dbRows = Array.isArray(rows) ? rows : [];
        await conn.end();
    } catch (error) {
        // Fallback jika kolom tenant_id belum ada di instalasi lama
        try {
            const conn = await getRadiusConnection();
            const [rows] = await conn.execute(`
                SELECT id, nasname, shortname, type, secret, description
                FROM nas
                ORDER BY nasname
            `);
            dbRows = Array.isArray(rows) ? rows : [];
            await conn.end();
        } catch (e2) {
            logger.warn(`[RADIUS-CLIENTS] Gagal baca nas: ${e2.message}`);
            dbRows = [];
        }
    }

    const dbClients = dbRows.map(mapNasRowToClient);
    const fileClients = await parseClientsConfFromFile();
    const merged = mergeClientsFromDbAndFile(dbClients, fileClients);

    if (dbRows.length === 0 && fileClients.length > 0) {
        try {
            await replaceNasTable(merged);
            logger.info(
                `[RADIUS-CLIENTS] nas kosong — disinkronkan dari clients.conf (${merged.length} client)`
            );
        } catch (e) {
            logger.warn(`[RADIUS-CLIENTS] Auto-sync nas dari file gagal: ${e.message}`);
        }
    }

    if (merged.length > 0) {
        logger.info(`[RADIUS-CLIENTS] Daftar gabungan: ${merged.length} client (nas + clients.conf)`);
    }

    if (options.all === true || tenantId == null) {
        return merged;
    }
    return filterClientsForTenant(merged, tenantId);
}

/**
 * Baca teks clients.conf: mirror (bisa dibaca PM2) → /etc → sudo -n cat.
 * Proses Node biasanya bukan root sehingga /etc/... sering EACCES tanpa mirror atau NOPASSWD sudo.
 */
function readRadiusClientsConfTextWithMeta() {
    const attempted = [];
    const candidates = [];
    const envMirror = process.env.RADIUS_CLIENTS_CONF_MIRROR && String(process.env.RADIUS_CLIENTS_CONF_MIRROR).trim();
    if (envMirror) {
        candidates.push(path.resolve(envMirror));
    }
    candidates.push(CLIENTS_CONF_MIRROR);
    candidates.push(CLIENTS_CONF_PATH);

    for (const p of candidates) {
        if (!p) continue;
        attempted.push(p);
        try {
            if (fs.existsSync(p)) {
                fs.accessSync(p, fs.constants.R_OK);
                const content = fs.readFileSync(p, 'utf8');
                if (content && content.includes('client ')) {
                    _clientsConfReadDiag = {
                        ok: true,
                        sourcePath: p,
                        attempted: [...attempted],
                        hint: null
                    };
                    return { content, diag: _clientsConfReadDiag };
                }
            }
        } catch (e) {
            logger.debug(`[RADIUS-CLIENTS] Lewati baca ${p}: ${e.message}`);
        }
    }

    try {
        const out = execSync(`sudo -n cat ${CLIENTS_CONF_PATH}`, {
            encoding: 'utf8',
            maxBuffer: 2 * 1024 * 1024,
            timeout: 5000
        });
        if (out && out.includes('client ')) {
            _clientsConfReadDiag = {
                ok: true,
                sourcePath: `${CLIENTS_CONF_PATH} (sudo -n)`,
                attempted: [...attempted, 'sudo -n cat'],
                hint: null
            };
            return { content: out, diag: _clientsConfReadDiag };
        }
    } catch (e) {
        attempted.push(`sudo -n cat (${e.message})`);
    }

    const hint =
        'Billing (PM2) tidak bisa membaca /etc/freeradius/3.0/clients.conf. Salin mirror ke folder aplikasi (sekali setelah ubah FR), lalu restart PM2:\n' +
        `  npm run radius:mirror-clients\n` +
        'atau manual:\n' +
        `  sudo cp ${CLIENTS_CONF_PATH} ${CLIENTS_CONF_MIRROR} && sudo chown $(whoami):$(whoami) ${CLIENTS_CONF_MIRROR} && chmod 640 ${CLIENTS_CONF_MIRROR}\n` +
        'Opsi: set env RADIUS_CLIENTS_CONF_MIRROR ke path file salinan yang bisa dibaca user proses Node.';
    _clientsConfReadDiag = { ok: false, sourcePath: null, attempted, hint };
    logger.warn(`[RADIUS-CLIENTS] clients.conf tidak terbaca oleh proses Node. ${hint.split('\n')[0]}`);
    return { content: null, diag: _clientsConfReadDiag };
}

function parseClientsConfContent(content) {
    if (!content || typeof content !== 'string') return [];

    const clients = [];
    let currentClient = null;
    let inClientBlock = false;
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith('#') || line === '') {
            continue;
        }

        const clientMatch = line.match(/^client\s+([^\s{]+)\s*\{/);
        if (clientMatch) {
            if (currentClient) {
                clients.push(currentClient);
            }
            currentClient = {
                name: clientMatch[1],
                ipaddr: null,
                addrType: 'ipaddr',
                secret: null,
                nas_type: 'other',
                require_message_authenticator: 'no',
                comment: null,
                rawLines: []
            };
            inClientBlock = true;
            currentClient.rawLines.push(lines[i]);
            continue;
        }

        if (line === '}' && inClientBlock) {
            if (currentClient) {
                currentClient.rawLines.push(lines[i]);
                clients.push(currentClient);
                currentClient = null;
                inClientBlock = false;
            }
            continue;
        }

        if (inClientBlock && currentClient) {
            currentClient.rawLines.push(lines[i]);

            const addrMatch = line.match(/(ipaddr|ipv4addr|ipv6addr)\s*=\s*(.+)/);
            if (addrMatch) {
                currentClient.addrType = addrMatch[1].trim();
                currentClient.ipaddr = addrMatch[2].trim();
            }

            const secretMatch = line.match(/secret\s*=\s*(.+)/);
            if (secretMatch) {
                currentClient.secret = secretMatch[1].trim();
            }

            const nasTypeMatch = line.match(/nas_type\s*=\s*(.+)/);
            if (nasTypeMatch) {
                currentClient.nas_type = nasTypeMatch[1].trim();
            }

            const msgAuthMatch = line.match(/require_message_authenticator\s*=\s*(.+)/);
            if (msgAuthMatch) {
                currentClient.require_message_authenticator = msgAuthMatch[1].trim();
            }

            if (line.startsWith('#')) {
                currentClient.comment = line.substring(1).trim();
            }
        }
    }

    if (currentClient) {
        clients.push(currentClient);
    }

    return clients.map((c) => ({
        name: c.name,
        ipaddr: c.ipaddr,
        addrType: c.addrType || 'ipaddr',
        secret: c.secret,
        nas_type: c.nas_type || 'other',
        require_message_authenticator: c.require_message_authenticator || 'no',
        comment: c.comment
    }));
}

/**
 * Parse clients.conf (isi dari mirror atau /etc atau sudo -n).
 */
async function parseClientsConfFromFile() {
    try {
        const { content } = readRadiusClientsConfTextWithMeta();
        if (!content) return [];
        return parseClientsConfContent(content);
    } catch (error) {
        logger.error(`Error parsing clients.conf: ${error.message}`);
        return [];
    }
}

function isLikelyIpv4(ip) {
    return /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test((ip || '').trim());
}

/** Kunci deduplikasi: IP bila valid, else nama client */
function clientDedupeKey(c) {
    const ip = (c.ipaddr || '').trim();
    if (ip && (isLikelyIpv4(ip) || ip.includes(':'))) return `ip:${ip}`;
    const n = (c.name || '').trim();
    return n ? `name:${n}` : '';
}

function mapNasRowToClient(row) {
    const nn = (row.nasname || '').trim();
    const sn = (row.shortname || '').trim();
    const ipaddr = isLikelyIpv4(nn) || (nn && nn.includes(':')) ? nn : '';
    return {
        id: row.id,
        name: sn || nn || 'client',
        ipaddr: ipaddr || nn,
        secret: row.secret || '',
        nas_type: row.type || 'other',
        require_message_authenticator: 'no',
        comment: row.description || null,
        tenant_id: row.tenant_id != null ? Number(row.tenant_id) : null,
        fromDB: true
    };
}

/**
 * Gabungkan klien dari tabel nas (SQLite) + clients.conf (FreeRADIUS).
 * Untuk IP yang sama, data dari DB menimpa file (nilai di aplikasi diutamakan).
 */
function mergeClientsFromDbAndFile(dbClients, fileClients) {
    const m = new Map();
    for (const c of fileClients) {
        if (!c || !c.name) continue;
        const k = clientDedupeKey(c);
        if (!k) continue;
        m.set(k, {
            name: c.name,
            ipaddr: c.ipaddr || null,
            secret: c.secret || '',
            nas_type: c.nas_type || 'other',
            require_message_authenticator: c.require_message_authenticator || 'no',
            comment: c.comment || null,
            addrType: c.addrType || 'ipaddr',
            tenant_id: c.tenant_id != null ? Number(c.tenant_id) : null
        });
    }
    for (const c of dbClients) {
        const k = clientDedupeKey(c);
        if (!k) continue;
        const prev = m.get(k) || {};
        m.set(k, {
            ...prev,
            id: c.id,
            name: c.name,
            ipaddr: c.ipaddr || prev.ipaddr,
            secret: c.secret != null && c.secret !== '' ? c.secret : prev.secret,
            nas_type: c.nas_type || prev.nas_type,
            require_message_authenticator:
                c.require_message_authenticator || prev.require_message_authenticator || 'no',
            comment: c.comment != null ? c.comment : prev.comment,
            addrType: c.addrType || prev.addrType || 'ipaddr',
            tenant_id: c.tenant_id != null ? Number(c.tenant_id) : (prev.tenant_id != null ? Number(prev.tenant_id) : null),
            fromDB: true
        });
    }
    return [...m.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Hanya isi ulang tabel nas (tanpa menulis clients.conf) — dipakai auto-heal + writeClientsConfToDB */
async function replaceNasTable(clients) {
    const conn = await getRadiusConnection();
    await ensureNasTenantColumn(conn);
    await conn.execute('DELETE FROM nas');
    const seenIps = new Set();
    for (const client of clients) {
        if (!client.name || !client.secret) {
            logger.warn(`[RADIUS-CLIENTS] Lewati client tidak lengkap: ${client.name}`);
            continue;
        }
        let ip = String(client.ipaddr || '').trim();
        const ipv4Port = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
        if (ipv4Port) ip = ipv4Port[1];
        if (!ip) {
            logger.warn(`[RADIUS-CLIENTS] Lewati client tanpa IP: ${client.name}`);
            continue;
        }
        if (seenIps.has(ip)) {
            logger.warn(`[RADIUS-CLIENTS] Lewati IP duplikat ${ip} (${client.name})`);
            continue;
        }
        seenIps.add(ip);
        const shortname = String(client.name || '').trim();
        if (!isValidClientName(shortname)) {
            logger.warn(`[RADIUS-CLIENTS] Lewati nama ilegal "${client.name}" — harus tanpa spasi/karakter aneh`);
            continue;
        }
        if (!isValidClientIp(ip)) {
            logger.warn(`[RADIUS-CLIENTS] Lewati IP ilegal ${ip} (${shortname})`);
            continue;
        }
        const tenantId = client.tenant_id != null && Number.isFinite(Number(client.tenant_id))
            ? parseInt(client.tenant_id, 10)
            : null;
        await conn.execute(
            `INSERT INTO nas (nasname, shortname, type, secret, description, tenant_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [ip, shortname, client.nas_type || 'other', client.secret, client.comment || null, tenantId]
        );
    }
    logger.info(`[RADIUS-CLIENTS] Tabel nas diisi ulang (${clients.length} entri masukan)`);
    await conn.end();
}

/**
 * Simpan daftar client milik tenant (merge aman: client tenant lain & system tetap utuh).
 */
async function writeTenantClientsConfToDB(tenantClients, tenantId = null) {
    const tid = resolveTenantIdForNas(tenantId);
    const allClients = await parseClientsConfFromDB({ all: true });
    const merged = mergeTenantClientsIntoAll(allClients, tenantClients, tid);
    return writeClientsConfToDB(merged);
}

/**
 * Upsert satu NAS RADIUS dari data router billing (sinkron Setting Mikrotik / NAS).
 */
async function upsertRadiusNasFromRouter(router, tenantId = null) {
    const ip = String(router?.nas_ip || '').trim();
    if (!ip || ip.toUpperCase() === 'RADIUS') return { success: false, message: 'IP NAS tidak valid' };
    if (!isValidClientIp(ip)) {
        return {
            success: false,
            message: 'IP NAS tidak valid untuk RADIUS (jangan sertakan port, contoh: 10.10.0.5)'
        };
    }
    const tid = resolveTenantIdForNas(tenantId != null ? tenantId : router?.tenant_id);
    const rawName = String(router?.name || ip).trim();
    if (!isValidClientName(rawName)) {
        const suggested = sanitizeClientName(rawName) || 'NAS_1';
        return {
            success: false,
            message: `Nama NAS tidak valid untuk RADIUS (tanpa spasi/karakter aneh). Gunakan misalnya: ${suggested}`
        };
    }
    const name = rawName;
    const secret = String(router?.secret || router?.password || 'testing123').trim() || 'testing123';

    const all = await parseClientsConfFromDB({ all: true });
    const idx = all.findIndex((c) => String(c.ipaddr || '').trim() === ip);
    const next = {
        name,
        ipaddr: ip,
        secret,
        nas_type: 'other',
        require_message_authenticator: 'no',
        comment: router?.location || router?.nas_identifier || null,
        tenant_id: tid
    };
    if (idx >= 0) {
        // Jangan timpa milik tenant lain
        if (tid != null && all[idx].tenant_id != null && Number(all[idx].tenant_id) !== Number(tid)) {
            return { success: false, message: 'NAS IP sudah dipakai tenant lain di RADIUS' };
        }
        all[idx] = { ...all[idx], ...next, tenant_id: tid != null ? tid : all[idx].tenant_id };
    } else {
        all.push(next);
    }
    await writeClientsConfToDB(all);
    return { success: true };
}

async function removeRadiusNasByIp(nasIp, tenantId = null) {
    const ip = String(nasIp || '').trim();
    if (!ip) return { success: false, message: 'IP kosong' };
    const tid = resolveTenantIdForNas(tenantId);
    const all = await parseClientsConfFromDB({ all: true });
    const filtered = all.filter((c) => {
        if (String(c.ipaddr || '').trim() !== ip) return true;
        if (tid == null) return false;
        return !clientBelongsToTenant(c, tid);
    });
    if (filtered.length === all.length) {
        return { success: false, message: 'NAS RADIUS tidak ditemukan / bukan milik tenant' };
    }
    await writeClientsConfToDB(filtered);
    return { success: true };
}

function readClientsConfHeader() {
    const sources = [];
    const envMirror = process.env.RADIUS_CLIENTS_CONF_MIRROR && String(process.env.RADIUS_CLIENTS_CONF_MIRROR).trim();
    if (envMirror) sources.push(path.resolve(envMirror));
    sources.push(CLIENTS_CONF_MIRROR, CLIENTS_CONF_PATH);

    for (const p of sources) {
        try {
            if (!p || !fs.existsSync(p)) continue;
            fs.accessSync(p, fs.constants.R_OK);
            const originalContent = fs.readFileSync(p, 'utf8');
            const headerMatch = originalContent.match(/^([\s\S]*?)(?=^client\s)/m);
            if (headerMatch) return headerMatch[1];
        } catch (e) {
            logger.debug(`[RADIUS-CLIENTS] Lewati header dari ${p}: ${e.message}`);
        }
    }

    try {
        const out = execSync(`sudo -n cat ${CLIENTS_CONF_PATH}`, {
            encoding: 'utf8',
            maxBuffer: 2 * 1024 * 1024,
            timeout: 5000
        });
        const headerMatch = out.match(/^([\s\S]*?)(?=^client\s)/m);
        if (headerMatch) return headerMatch[1];
    } catch (e) {
        logger.debug(`[RADIUS-CLIENTS] Lewati header sudo: ${e.message}`);
    }

    return `## clients.conf -- client configuration directives
##
##	\$Id\$

#######################################################################
#
#  Define RADIUS clients (usually a NAS, Access Point, etc.).
#
#  Clients configured via CVLMEDIA Web Interface
#  Generated: ${new Date().toISOString()}
#

`;
}

/** Nama client FreeRADIUS tidak boleh spasi / karakter aneh (syntax `client NAME {`). */
const CLIENT_NAME_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sanitizeClientName(name) {
    return String(name || '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[._-]+|[._-]+$/g, '');
}

/** true hanya jika nama sudah aman untuk FreeRADIUS (tanpa perlu dinormalisasi). */
function isValidClientName(name) {
    const raw = String(name || '').trim();
    return raw.length > 0 && raw.length <= 64 && CLIENT_NAME_SAFE_RE.test(raw);
}

function isIpv6Literal(addr) {
    const s = String(addr || '').trim();
    if (!s) return false;
    // IPv4 or IPv4/prefix must stay ipaddr (avoid treating "a.b.c.d:port" as IPv6)
    if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(s)) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) return false;
    return s.includes(':');
}

function isValidClientIp(ipaddr) {
    const raw = String(ipaddr || '').trim();
    if (!raw) return false;
    if (/^(\d{1,3}\.){3}\d{1,3}:\d+$/.test(raw)) return false;
    const ipv4 = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
    if (ipv4.test(raw)) {
        const parts = raw.split('/')[0].split('.').map(Number);
        return parts.every((n) => n >= 0 && n <= 255);
    }
    return isIpv6Literal(raw);
}

function buildClientBlocks(clients) {
    let clientsSection = '';

    (clients || []).forEach((client) => {
        const c = { ...client };
        c.name = sanitizeClientName(c.name);
        if (!c.name) return;
        if (c.name === 'localhost_ipv6' && !c.ipaddr) {
            c.ipaddr = '::1';
            c.addrType = 'ipv6addr';
        }

        clientsSection += `client ${c.name} {\n`;

        if (c.ipaddr) {
            let addr = String(c.ipaddr).trim();
            // Strip mistaken ":port" on IPv4 (bukan field FreeRADIUS client)
            const ipv4Port = addr.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
            if (ipv4Port) addr = ipv4Port[1];

            let keyword = c.addrType || 'ipaddr';
            if (isIpv6Literal(addr)) keyword = 'ipv6addr';
            else if (keyword === 'ipv6addr' && !isIpv6Literal(addr)) keyword = 'ipaddr';
            clientsSection += `\t${keyword} = ${addr}\n`;
        } else if (c.name === 'localhost') {
            clientsSection += `\tipaddr = 127.0.0.1\n`;
        }

        if (c.secret) clientsSection += `\tsecret = ${c.secret}\n`;
        if (c.nas_type) clientsSection += `\tnas_type = ${c.nas_type}\n`;
        if (c.require_message_authenticator) {
            clientsSection += `\trequire_message_authenticator = ${c.require_message_authenticator}\n`;
        }
        if (c.comment) clientsSection += `\t# ${c.comment}\n`;
        clientsSection += `}\n\n`;
    });

    return clientsSection;
}

function buildClientsConfContent(clients) {
    return readClientsConfHeader() + buildClientBlocks(clients);
}

function canWritePath(targetPath) {
    try {
        fs.accessSync(targetPath, fs.constants.W_OK);
        return true;
    } catch (e) {
        return false;
    }
}

/** Tulis salinan mirror (bisa dibaca proses Node tanpa root). */
function writeClientsConfMirror(clients) {
    const fullContent = buildClientsConfContent(clients);
    const mirrorDir = path.dirname(CLIENTS_CONF_MIRROR);
    if (!fs.existsSync(mirrorDir)) {
        fs.mkdirSync(mirrorDir, { recursive: true });
    }
    fs.writeFileSync(CLIENTS_CONF_MIRROR, fullContent, 'utf8');
    try {
        fs.chmodSync(CLIENTS_CONF_MIRROR, 0o640);
    } catch (e) {
        logger.debug(`[RADIUS-CLIENTS] chmod mirror: ${e.message}`);
    }
    logger.info(`[RADIUS-CLIENTS] Mirror diperbarui: ${CLIENTS_CONF_MIRROR}`);
    return true;
}

/**
 * Write clients array back to clients.conf file (best-effort).
 * FreeRADIUS di server ini memakai read_clients=yes dari tabel nas —
 * file clients.conf hanya untuk localhost (hindari duplicate client).
 */
function writeClientsConf(clients) {
    let systemOnly = (clients || []).filter((c) => isSystemNasClient(c));
    if (systemOnly.length === 0) {
        systemOnly = [
            {
                name: 'localhost',
                ipaddr: '127.0.0.1',
                secret: 'testing123',
                nas_type: 'other',
                require_message_authenticator: 'no'
            },
            {
                name: 'localhost_ipv6',
                ipaddr: '::1',
                secret: 'testing123',
                nas_type: 'other',
                require_message_authenticator: 'no'
            }
        ];
    }
    const fullContent =
        `# -*- text -*-
## clients.conf — hanya localhost; NAS produksi di tabel SQLite nas (read_clients=yes)
## Jangan duplikasi NAS di file ini (bentrok dengan FreeRADIUS).
## Generated: ${new Date().toISOString()}

` + buildClientBlocks(systemOnly);
    const backupPath = `${CLIENTS_CONF_PATH}.backup.${Date.now()}`;
    let backupCreated = false;

    try {
        if (fs.existsSync(CLIENTS_CONF_PATH)) {
            try {
                if (canWritePath(CLIENTS_CONF_PATH)) {
                    fs.copyFileSync(CLIENTS_CONF_PATH, backupPath);
                    backupCreated = true;
                } else {
                    execSync(`sudo -n cp ${CLIENTS_CONF_PATH} ${backupPath}`, {
                        encoding: 'utf8',
                        timeout: 5000
                    });
                    backupCreated = true;
                }
            } catch (copyError) {
                logger.warn(`[RADIUS-CLIENTS] Backup clients.conf dilewati: ${copyError.message}`);
            }
        }
    } catch (backupError) {
        logger.warn(`[RADIUS-CLIENTS] Backup gagal: ${backupError.message}`);
    }

    if (backupCreated) {
        logger.info(`[RADIUS-CLIENTS] Backup: ${backupPath}`);
    }

    if (canWritePath(CLIENTS_CONF_PATH)) {
        fs.writeFileSync(CLIENTS_CONF_PATH, fullContent, 'utf8');
    } else {
        const tempFile = `/tmp/clients.conf.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tempFile, fullContent, 'utf8');
        try {
            execSync(`sudo -n cp ${tempFile} ${CLIENTS_CONF_PATH}`, {
                encoding: 'utf8',
                timeout: 5000
            });
        } finally {
            try {
                fs.unlinkSync(tempFile);
            } catch (e) {
                /* ignore */
            }
        }
    }

    try {
        if (canWritePath(CLIENTS_CONF_PATH)) {
            fs.chmodSync(CLIENTS_CONF_PATH, 0o660);
        } else {
            execSync(`sudo -n chmod 660 ${CLIENTS_CONF_PATH}`, { encoding: 'utf8', timeout: 5000 });
        }
    } catch (chmodError) {
        logger.warn(`[RADIUS-CLIENTS] chmod clients.conf: ${chmodError.message}`);
    }

    logger.info(`[RADIUS-CLIENTS] clients.conf diperbarui (${clients.length} client)`);
    return true;
}

/**
 * Restart FreeRADIUS service
 */
function restartFreeRADIUS() {
    try {
        // Cegah crash-loop: tolak restart jika config/nas tidak valid
        try {
            execSync('freeradius -CX', {
                encoding: 'utf8',
                timeout: 20000,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (cxErr) {
            const detail = String(cxErr.stderr || cxErr.stdout || cxErr.message || '')
                .split('\n')
                .filter((l) => /error|fail|expecting|duplicate/i.test(l))
                .slice(0, 4)
                .join(' | ');
            logger.error(`[RADIUS-CLIENTS] freeradius -CX gagal, restart dibatalkan: ${detail || cxErr.message}`);
            return {
                success: false,
                message:
                    'Konfigurasi FreeRADIUS tidak valid — restart dibatalkan agar service tidak crash-loop. Perbaiki nama/IP NAS (tanpa spasi) lalu simpan lagi.' +
                    (detail ? ` Detail: ${detail}` : ''),
                error: detail || cxErr.message
            };
        }

        // Check if systemctl exists
        try {
            execSync('command -v systemctl', { stdio: 'ignore' });
        } catch (e) {
            logger.warn('systemctl not found. If running in Docker, please restart FreeRADIUS on the host manually.');
            return { 
                success: false, 
                message: 'systemctl tidak ditemukan. Jika Anda menggunakan Docker, silakan restart FreeRADIUS secara manual di host Ubuntu: sudo systemctl restart freeradius'
            };
        }

        try {
            execSync('sudo -n systemctl restart freeradius', { encoding: 'utf8', timeout: 10000 });
            logger.info('FreeRADIUS restarted successfully (sudo -n)');
            return { success: true, message: 'FreeRADIUS berhasil direstart' };
        } catch (sudoError) {
            try {
                execSync('systemctl restart freeradius', { encoding: 'utf8', timeout: 10000 });
                logger.info('FreeRADIUS restarted successfully (without sudo)');
                return { success: true, message: 'FreeRADIUS berhasil direstart' };
            } catch (directError) {
                logger.warn('FreeRADIUS restart failed — restart manual: sudo systemctl restart freeradius');
                return {
                    success: false,
                    message:
                        'Gagal restart FreeRADIUS otomatis. Jalankan manual: sudo systemctl restart freeradius',
                    error: directError.message
                };
            }
        }
    } catch (error) {
        logger.error(`Error restarting FreeRADIUS: ${error.message}`);
        return { 
            success: false, 
            message: `Gagal restart FreeRADIUS: ${error.message}`,
            error: error.message
        };
    }
}

/**
 * Validate client data — tolak input ilegal (jangan dinormalisasi diam-diam).
 */
function validateClient(client) {
    const errors = [];
    const rawName = client?.name != null ? String(client.name).trim() : '';

    if (!rawName) {
        errors.push('Client name diperlukan');
    } else if (!isValidClientName(rawName)) {
        const suggested = sanitizeClientName(rawName);
        errors.push(
            suggested
                ? `Nama client tidak valid (tanpa spasi/karakter aneh). Gunakan hanya huruf, angka, titik, strip, underscore. Contoh: ${suggested}`
                : 'Nama client tidak valid. Gunakan hanya huruf, angka, titik, strip, underscore (tanpa spasi).'
        );
    }

    if (!client.ipaddr || String(client.ipaddr).trim() === '') {
        errors.push('IP address diperlukan');
    } else {
        const raw = String(client.ipaddr).trim();
        if (/^(\d{1,3}\.){3}\d{1,3}:\d+$/.test(raw)) {
            errors.push('IP address tidak boleh menyertakan port (contoh benar: 10.10.0.2)');
        } else if (!isValidClientIp(raw)) {
            errors.push('Format IP address tidak valid');
        }
    }

    if (!client.secret || String(client.secret).trim() === '') {
        errors.push('Secret diperlukan');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Tulis daftar client ke tabel nas (SQLite, dibaca FreeRADIUS via read_clients=yes).
 * Sinkron clients.conf + mirror bersifat best-effort (proses Node biasanya tidak punya akses /etc).
 */
async function writeClientsConfToDB(clients) {
    const result = {
        nasWritten: false,
        clientsConfWritten: false,
        mirrorWritten: false,
        warning: null
    };

    try {
        await replaceNasTable(clients);
        result.nasWritten = true;
        logger.info(`[RADIUS-CLIENTS] Disimpan ${clients.length} client ke tabel nas`);
    } catch (error) {
        logger.error(`[RADIUS-CLIENTS] Gagal tulis nas: ${error.message}`);
        throw error;
    }

    try {
        writeClientsConfMirror(clients);
        result.mirrorWritten = true;
    } catch (mirrorError) {
        logger.warn(`[RADIUS-CLIENTS] Mirror gagal: ${mirrorError.message}`);
    }

    try {
        writeClientsConf(clients);
        result.clientsConfWritten = true;
    } catch (fileError) {
        result.warning =
            'NAS tersimpan di database RADIUS. clients.conf tidak bisa ditulis tanpa sudo — ' +
            'FreeRADIUS memakai tabel nas (read_clients=yes). Opsional: npm run radius:mirror-clients atau ' +
            'pasang sudoers NOPASSWD untuk sinkron file.';
        logger.warn(`[RADIUS-CLIENTS] clients.conf tidak ditulis: ${fileError.message}`);
    }

    return result;
}

/**
 * Wrapper sync function untuk backward compatibility (deprecated - gunakan async version)
 */
function parseClientsConf() {
    logger.warn('[RADIUS-CLIENTS] parseClientsConf() is deprecated. Use parseClientsConfFromDB() instead');
    // Return empty array or try read from file as fallback
    if (fs.existsSync(CLIENTS_CONF_PATH)) {
        try {
            const content = fs.readFileSync(CLIENTS_CONF_PATH, 'utf8');
            // Simple parse dari file
            const clients = [];
            let currentClient = null;
            const lines = content.split('\n');
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('client ') && trimmed.endsWith('{')) {
                    const nameMatch = trimmed.match(/^client\s+([^\s{]+)\s*\{/);
                    if (nameMatch) {
                        currentClient = {
                            name: nameMatch[1],
                            ipaddr: null,
                            secret: null,
                            nas_type: 'other',
                            require_message_authenticator: 'no'
                        };
                    }
                } else if (trimmed === '}' && currentClient) {
                    clients.push(currentClient);
                    currentClient = null;
                } else if (currentClient) {
                    const ipMatch = trimmed.match(/(ipaddr|ipv4addr|ipv6addr)\s*=\s*(.+)/);
                    if (ipMatch) currentClient.ipaddr = ipMatch[2].trim();
                    
                    const secretMatch = trimmed.match(/secret\s*=\s*(.+)/);
                    if (secretMatch) currentClient.secret = secretMatch[1].trim();
                    
                    const typeMatch = trimmed.match(/nas_type\s*=\s*(.+)/);
                    if (typeMatch) currentClient.nas_type = typeMatch[1].trim();
                }
            }
            
            logger.info(`[RADIUS-CLIENTS] Loaded ${clients.length} clients from file (sync fallback)`);
            return clients;
        } catch (error) {
            logger.error(`[RADIUS-CLIENTS] Error reading file sync: ${error.message}`);
            return [];
        }
    }
    return [];
}

module.exports = {
    initializeClientsTable,
    parseClientsConf,
    parseClientsConfFromDB,
    parseClientsConfFromFile,
    buildClientsConfContent,
    writeClientsConf,
    writeClientsConfMirror,
    writeClientsConfToDB,
    writeTenantClientsConfToDB,
    upsertRadiusNasFromRouter,
    removeRadiusNasByIp,
    filterClientsForTenant,
    clientBelongsToTenant,
    isSystemNasClient,
    mergeTenantClientsIntoAll,
    restartFreeRADIUS,
    validateClient,
    sanitizeClientName,
    isValidClientName,
    isValidClientIp,
    getRadiusClientsConfReadDiagnostics,
    CLIENTS_CONF_PATH,
    CLIENTS_CONF_MIRROR
};

