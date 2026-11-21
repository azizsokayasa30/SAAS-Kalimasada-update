'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const bcrypt = require('bcrypt');
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const popService = require('./popService');
const tenantStore = require('./tenantStore');
const { restartFreeRADIUS } = require('../radiusClients');
const { getRadiusSqliteFileDiagnostics, getRadiusConnection } = require('../radiusSQLite');

const HOST_PROBE_TIMEOUT_MS = 1500;

function formatUptime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const mins = Math.floor((s % 3600) / 60);
    if (days > 0) return `${days} hari ${hours} jam`;
    if (hours > 0) return `${hours} jam ${mins} mnt`;
    return `${mins} mnt`;
}

function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / (1024 ** 2)).toFixed(1)} MB`;
    return `${(n / (1024 ** 3)).toFixed(2)} GB`;
}

function getLocalHostSet() {
    const hosts = new Set(['127.0.0.1', 'localhost', '::1']);
    try {
        const ifaces = os.networkInterfaces();
        for (const entries of Object.values(ifaces || {})) {
            for (const entry of entries || []) {
                if (entry && entry.address) hosts.add(String(entry.address).toLowerCase());
            }
        }
    } catch (_) {
        /* ignore */
    }
    return hosts;
}

function isLocalRadiusHost(host) {
    const h = String(host || '').trim().toLowerCase();
    if (!h) return false;
    return getLocalHostSet().has(h);
}

function probeHostPort(host, port) {
    return new Promise((resolve) => {
        const trimmed = String(host || '').trim();
        if (!trimmed) return resolve(false);
        const socket = new net.Socket();
        let settled = false;
        const done = (ok) => {
            if (settled) return;
            settled = true;
            try {
                socket.destroy();
            } catch (_) {
                /* ignore */
            }
            resolve(ok);
        };
        socket.setTimeout(HOST_PROBE_TIMEOUT_MS);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.connect(port, trimmed);
    });
}

async function pingHost(host) {
    const trimmed = String(host || '').trim();
    if (!trimmed) return false;
    const safeHost = trimmed.replace(/[^a-zA-Z0-9.:_-]/g, '');
    if (!safeHost || safeHost !== trimmed) return false;
    try {
        await execAsync(`ping -c 1 -W 1 ${safeHost}`, { timeout: 2500 });
        return true;
    } catch (_) {
        return false;
    }
}

async function checkRadiusServiceStatus() {
    if (process.platform === 'win32') {
        return { status: 'unknown', error: null, platform: 'windows' };
    }
    try {
        const { stdout } = await execAsync('systemctl is-active freeradius || true', { timeout: 5000 });
        const raw = String(stdout || '').trim();
        if (raw === 'active') return { status: 'running', error: null };
        if (raw === 'activating' || raw === 'auto-restart') {
            return { status: 'not_running', error: 'FreeRADIUS crash-loop (activating)' };
        }
        if (raw === 'inactive' || raw === 'failed') return { status: 'not_running', error: null };
        try {
            const { stdout: pg } = await execAsync(
                'pgrep -x freeradius >/dev/null && echo running || pgrep -x radiusd >/dev/null && echo running || echo not_running',
                { timeout: 3000 }
            );
            if (pg.trim() === 'running') return { status: 'running', error: null };
            return { status: 'not_running', error: raw || null };
        } catch (altError) {
            return { status: 'not_running', error: altError.message || raw || null };
        }
    } catch (error) {
        try {
            const { stdout } = await execAsync(
                'pgrep -x freeradius >/dev/null && echo running || pgrep -x radiusd >/dev/null && echo running || echo not_running',
                { timeout: 3000 }
            );
            if (stdout.trim() === 'running') return { status: 'running', error: null };
            return { status: 'not_running', error: error.message };
        } catch (altError) {
            return { status: 'not_running', error: altError.message || error.message };
        }
    }
}

function parseSystemdTimestamp(raw) {
    const text = String(raw || '').trim();
    if (!text || text === 'n/a' || text === '0') return null;
    const normalized = text
        .replace(/\s+[A-Z]{3,4}$/, '')
        .replace(/^[A-Za-z]{3}\s+/, '');
    const ms = Date.parse(normalized + ' UTC');
    if (Number.isFinite(ms)) return ms;
    const fallback = Date.parse(text);
    return Number.isFinite(fallback) ? fallback : null;
}

async function getFreeRadiusServiceMeta() {
    const meta = {
        activeState: 'unknown',
        subState: null,
        mainPid: null,
        restarts: null,
        startedAt: null,
        uptimeSec: null,
        uptimeLabel: null,
    };
    try {
        const { stdout } = await execAsync(
            'systemctl show freeradius -p ActiveState -p SubState -p MainPID -p NRestarts -p ActiveEnterTimestamp',
            { timeout: 4000 }
        );
        const map = {};
        String(stdout || '')
            .split('\n')
            .forEach((line) => {
                const idx = line.indexOf('=');
                if (idx > 0) map[line.slice(0, idx)] = line.slice(idx + 1).trim();
            });
        meta.activeState = map.ActiveState || meta.activeState;
        meta.subState = map.SubState || null;
        meta.mainPid = map.MainPID && map.MainPID !== '0' ? Number(map.MainPID) : null;
        meta.restarts = map.NRestarts != null ? Number(map.NRestarts) : null;
        const startedMs = parseSystemdTimestamp(map.ActiveEnterTimestamp);
        if (startedMs) {
            meta.startedAt = new Date(startedMs).toISOString();
            meta.uptimeSec = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
            meta.uptimeLabel = formatUptime(meta.uptimeSec);
        }
    } catch (_) {
        /* ignore */
    }
    return meta;
}

async function getFreeRadiusVersion() {
    try {
        const { stdout, stderr } = await execAsync('freeradius -v 2>&1 | head -n 1', { timeout: 4000 });
        const line = String(stdout || stderr || '').trim();
        const match = line.match(/FreeRADIUS Version\s+([0-9.]+)/i) || line.match(/Version\s+([0-9.]+)/i);
        return {
            label: match ? `FreeRADIUS ${match[1]}` : (line.slice(0, 80) || 'FreeRADIUS'),
            version: match ? match[1] : null,
        };
    } catch (_) {
        return { label: 'FreeRADIUS', version: null };
    }
}

const FREERADIUS_SQL_MOD = '/etc/freeradius/3.0/mods-enabled/sql';
const FREERADIUS_DB_CANDIDATES = [
    '/var/lib/freeradius/radius.db',
    '/var/lib/freeradius/freeradius.db',
];

function resolveFreeRadiusDbPath() {
    try {
        const sqlMod = fs.readFileSync(FREERADIUS_SQL_MOD, 'utf8');
        const match = sqlMod.match(/filename\s*=\s*"([^"]+)"/i) || sqlMod.match(/filename\s*=\s*'([^']+)'/i);
        if (match && match[1] && fs.existsSync(match[1])) return match[1];
    } catch (_) {
        /* ignore */
    }
    for (const candidate of FREERADIUS_DB_CANDIDATES) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function sqliteGet(dbPath, sql, params = []) {
    const sqlite3 = require('sqlite3').verbose();
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
            if (err) return reject(err);
            db.get(sql, params, (qErr, row) => {
                db.close(() => {
                    if (qErr) reject(qErr);
                    else resolve(row || null);
                });
            });
        });
    });
}

async function readLiveRadiusDbStats(preferredPath) {
    const dbPath = preferredPath || resolveFreeRadiusDbPath();
    if (!dbPath || !fs.existsSync(dbPath)) {
        return { ok: false, dbPath: null, error: 'File DB FreeRADIUS tidak ditemukan' };
    }
    try {
        fs.accessSync(dbPath, fs.constants.R_OK);
    } catch (_) {
        return { ok: false, dbPath, error: 'DB FreeRADIUS tidak bisa dibaca (permission)' };
    }

    const pwdSql = `
        SELECT COUNT(DISTINCT username) AS n FROM radcheck
        WHERE LOWER(TRIM(attribute)) IN (
            'cleartext-password','user-password','crypt-password','md5-password',
            'sha-password','smd5-password','mikrotik-password'
        )`;
    try {
        const [users, nas, size] = await Promise.all([
            sqliteGet(dbPath, pwdSql),
            sqliteGet(dbPath, 'SELECT COUNT(*) AS n FROM nas'),
            Promise.resolve(fs.statSync(dbPath).size),
        ]);
        return {
            ok: true,
            dbPath,
            pppoeUsers: users?.n != null ? Number(users.n) || 0 : null,
            nasCount: nas?.n != null ? Number(nas.n) || 0 : null,
            dbSizeBytes: size,
            error: null,
        };
    } catch (err) {
        return { ok: false, dbPath, error: err.message };
    }
}

async function countOpenRadacctSessions(conn) {
    try {
        const [rows] = await conn.execute(`
            SELECT COUNT(DISTINCT username) AS n
            FROM radacct
            WHERE acctstoptime IS NULL
               OR acctstoptime = ''
               OR acctstoptime = '0'
               OR acctstoptime = '0000-00-00 00:00:00'
        `);
        return Array.isArray(rows) && rows[0] ? Number(rows[0].n) || 0 : 0;
    } catch (_) {
        return null;
    }
}

/**
 * Sesi aktif nyata: accounting SQL FreeRADIUS sering dimatikan (auth-only),
 * jadi radacct bisa 0 meski ribuan PPPoE online. Utamakan /ppp/active MikroTik.
 */
async function countLiveActiveSessions() {
    try {
        const {
            getActivePppoeLoginNamesSetWithUptimeMap,
        } = require('../mikrotik');
        const { names, ok } = await getActivePppoeLoginNamesSetWithUptimeMap({
            namesOnly: true,
            maxWaitMs: 3500,
            mikrotikTimeoutMs: 3500,
        });
        if (ok || (names && names.size > 0)) {
            return {
                count: names ? names.size : 0,
                source: 'mikrotik',
                label: 'PPPoE online',
            };
        }
    } catch (err) {
        console.warn('[radiusManager] mikrotik active sessions:', err.message);
    }

    try {
        const {
            isRadiusAccountingOnMysql,
            getActiveSessionsFromMysqlRadacct,
        } = require('../radiusMysqlAccounting');
        if (isRadiusAccountingOnMysql()) {
            const rows = await getActiveSessionsFromMysqlRadacct([]);
            if (Array.isArray(rows) && rows.length) {
                const uniq = new Set(rows.map((r) => String(r.username || '').trim()).filter(Boolean));
                return { count: uniq.size, source: 'mysql', label: 'radacct MySQL' };
            }
        }
    } catch (_) {
        /* ignore */
    }

    try {
        const conn = await getRadiusConnection();
        try {
            const n = await countOpenRadacctSessions(conn);
            if (n != null) {
                return { count: n, source: 'sqlite', label: 'radacct SQLite' };
            }
        } finally {
            await conn.end();
        }
    } catch (_) {
        /* ignore */
    }

    return { count: 0, source: 'none', label: 'tidak tersedia' };
}

async function collectLocalEngineSnapshot() {
    const [service, serviceMeta, version, liveDb, activeInfo, appDiag] = await Promise.all([
        checkRadiusServiceStatus(),
        getFreeRadiusServiceMeta(),
        getFreeRadiusVersion(),
        readLiveRadiusDbStats(),
        countLiveActiveSessions(),
        getRadiusSqliteFileDiagnostics().catch((err) => ({ error: err.message, fileExists: false })),
    ]);

    const pppoeUsers = liveDb.ok
        ? liveDb.pppoeUsers
        : (appDiag?.radcheckPasswordUserCount ?? appDiag?.radcheckRowCount ?? null);
    const nasCount = liveDb.ok ? liveDb.nasCount : null;
    const dbPath = liveDb.ok ? liveDb.dbPath : (appDiag?.dbPath || null);
    const dbSizeBytes = liveDb.ok
        ? liveDb.dbSizeBytes
        : (appDiag?.fileSizeBytes != null ? appDiag.fileSizeBytes : null);
    const database = liveDb.ok || (appDiag?.fileExists && !appDiag?.error) ? 'connected' : 'error';

    // Fallback NAS dari app DB jika live FR DB gagal dibaca
    let resolvedNas = nasCount;
    if (resolvedNas == null && appDiag?.fileExists && !appDiag?.error) {
        try {
            const conn = await getRadiusConnection();
            try {
                const [nasRows] = await conn.execute('SELECT COUNT(*) AS n FROM nas');
                resolvedNas = Array.isArray(nasRows) && nasRows[0] ? Number(nasRows[0].n) || 0 : 0;
            } finally {
                await conn.end();
            }
        } catch (_) {
            /* ignore */
        }
    }

    const running = service.status === 'running';
    const noteParts = [];
    if (activeInfo.source === 'mikrotik') {
        noteParts.push('Sesi aktif dihitung dari PPPoE online di MikroTik (accounting SQL FR dimatikan).');
    } else if (activeInfo.source === 'sqlite' || activeInfo.source === 'mysql') {
        noteParts.push(`Sesi aktif dari ${activeInfo.label}.`);
    } else {
        noteParts.push('Sesi aktif belum tersedia — cek koneksi API MikroTik.');
    }

    return {
        scope: 'local',
        reachable: running,
        service: service.status,
        serviceDetail: service.error || (running ? 'Service aktif' : 'Service tidak berjalan'),
        version: version.label,
        versionNumber: version.version,
        uptimeLabel: serviceMeta.uptimeLabel || (running ? formatUptime(os.uptime()) : null),
        uptimeSec: serviceMeta.uptimeSec,
        hostUptimeLabel: formatUptime(os.uptime()),
        restarts: serviceMeta.restarts,
        mainPid: serviceMeta.mainPid,
        database,
        dbPath,
        dbSizeLabel: dbSizeBytes != null ? formatBytes(dbSizeBytes) : null,
        pppoeUsers,
        nasCount: resolvedNas,
        activeSessions: activeInfo.count,
        activeSessionsSource: activeInfo.source,
        activeSessionsLabel: activeInfo.label,
        canRestart: true,
        canTest: true,
        canBackup: true,
        canRestore: true,
        note: noteParts.join(' '),
    };
}

async function resolveStatusSecret(server) {
    const fromDb = String(server?.radius_secret || '').trim();
    if (fromDb) return fromDb;
    if (!isLocalRadiusHost(server?.host)) return '';
    try {
        const content = fs.readFileSync('/etc/freeradius/3.0/clients.conf', 'utf8');
        const match = content.match(/client\s+localhost(?:_ipv6)?\s*\{[\s\S]*?^\s*secret\s*=\s*([^\s#]+)/im);
        if (match) return String(match[1]).replace(/["']/g, '').trim();
    } catch (_) {
        /* ignore */
    }
    return 'testing123';
}

async function runStatusServerProbe(host, port, secret) {
    const safeHost = String(host || '').trim();
    const authPort = Number(port) || 1812;
    const sec = String(secret || '').trim();
    if (!safeHost || !sec) {
        return { ok: false, detail: 'RADIUS secret belum diisi — Status-Server dilewati' };
    }
    try {
        const { stdout, stderr } = await execFileAsync(
            'bash',
            [
                '-lc',
                `printf 'Message-Authenticator = 0x00\\n' | radclient -t 2 -r 1 ${JSON.stringify(`${safeHost}:${authPort}`)} status ${JSON.stringify(sec)}`,
            ],
            { timeout: 6000, maxBuffer: 64 * 1024 }
        );
        const out = `${stdout || ''}\n${stderr || ''}`;
        if (/Received\s+(Access-Accept|Access-Challenge|Status-Server)/i.test(out) || /Received/i.test(out)) {
            return { ok: true, detail: 'Status-Server merespons' };
        }
        return { ok: false, detail: 'Tidak ada respons Status-Server' };
    } catch (err) {
        const detail = String(err.stderr || err.stdout || err.message || 'Status-Server gagal')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 2)
            .join(' · ');
        return { ok: false, detail: detail || 'Status-Server gagal' };
    }
}

async function collectRemoteEngineSnapshot(server) {
    const host = String(server.host || '').trim();
    const authPort = Number(server.auth_port) || 1812;
    const [icmp, sshOpen] = await Promise.all([
        pingHost(host),
        probeHostPort(host, 22),
    ]);
    const secret = String(server.radius_secret || '').trim();
    let statusProbe = { ok: null, detail: secret ? null : 'Isi RADIUS secret untuk uji Status-Server' };
    if (secret) {
        statusProbe = await runStatusServerProbe(host, authPort, secret);
    }
    const reachable = icmp || sshOpen || statusProbe.ok === true;
    return {
        scope: 'remote',
        reachable,
        service: statusProbe.ok === true ? 'running' : (reachable ? 'unknown' : 'not_running'),
        serviceDetail: statusProbe.ok === true
            ? statusProbe.detail
            : (reachable ? 'Host merespons (metrik engine terbatas)' : 'Host tidak merespons'),
        version: null,
        versionNumber: null,
        uptimeLabel: null,
        uptimeSec: null,
        hostUptimeLabel: null,
        restarts: null,
        mainPid: null,
        database: 'remote',
        dbPath: null,
        dbSizeLabel: null,
        pppoeUsers: null,
        nasCount: null,
        activeSessions: null,
        canRestart: false,
        canTest: true,
        canBackup: false,
        canRestore: false,
        icmp,
        sshOpen,
        statusServer: statusProbe.ok,
        statusServerDetail: statusProbe.detail,
        note: 'Metrik detail (uptime/DB PPPoE) tersedia penuh untuk FreeRADIUS lokal di VPS ini.',
    };
}

async function probeServerLive(server) {
    const host = String(server.host || '').trim();
    const isActive = Number(server.is_active) === 1;
    if (!isActive) {
        return { status: 'down', detail: 'Nonaktif' };
    }
    if (isLocalRadiusHost(host)) {
        const service = await checkRadiusServiceStatus();
        const up = service.status === 'running';
        return {
            status: up ? 'up' : 'down',
            detail: up ? 'Service FreeRADIUS aktif' : 'Service FreeRADIUS tidak berjalan',
        };
    }
    const reachable = (await pingHost(host)) || (await probeHostPort(host, 22));
    return {
        status: reachable ? 'up' : 'down',
        detail: reachable ? 'Host FreeRADIUS merespons' : 'Host FreeRADIUS tidak merespons',
    };
}

async function listRadiusServersWithEngine() {
    try {
        await popService.ensureLocalRadiusServer();
    } catch (err) {
        console.warn('[radiusManager] ensureLocalRadiusServer:', err.message);
    }

    const servers = await popService.listRadiusServers();
    const needsLocal = servers.some((s) => Number(s.is_active) === 1 && isLocalRadiusHost(s.host));
    const localEngine = needsLocal ? await collectLocalEngineSnapshot() : null;

    const enriched = await Promise.all(
        servers.map(async (server) => {
            const live = await probeServerLive(server);
            let engine;
            if (Number(server.is_active) !== 1) {
                engine = {
                    scope: isLocalRadiusHost(server.host) ? 'local' : 'remote',
                    reachable: false,
                    service: 'disabled',
                    serviceDetail: 'Server dinonaktifkan',
                    version: null,
                    uptimeLabel: null,
                    pppoeUsers: null,
                    nasCount: null,
                    activeSessions: null,
                    database: null,
                    canRestart: false,
                    canTest: false,
                    canBackup: false,
                    canRestore: false,
                    note: null,
                };
            } else if (isLocalRadiusHost(server.host)) {
                engine = localEngine || (await collectLocalEngineSnapshot());
            } else {
                engine = await collectRemoteEngineSnapshot(server);
            }
            return {
                ...server,
                is_local: isLocalRadiusHost(server.host),
                live_status: live.status,
                live_detail: live.detail,
                engine,
            };
        })
    );

    const monitored = enriched.filter((s) => Number(s.is_active) === 1);
    const up = monitored.filter((s) => s.live_status === 'up').length;
    const down = monitored.filter((s) => s.live_status === 'down').length;

    return {
        servers: enriched,
        live: {
            total: monitored.length,
            up,
            down,
            inactive: enriched.length - monitored.length,
        },
    };
}

async function verifyPlatformAdminPassword(req, plain) {
    const submitted = String(plain ?? '').trim();
    const adminId = req?.session?.platformAdminId;
    if (!submitted || !adminId) return false;
    const row = await tenantStore.dbGet(
        'SELECT password_hash FROM super_admins WHERE id = ? AND is_active = 1',
        [adminId]
    );
    if (!row?.password_hash) return false;
    try {
        return await bcrypt.compare(submitted, row.password_hash);
    } catch (_) {
        return false;
    }
}

async function restartRadiusServerById(id) {
    const server = await popService.getRadiusServerById(id);
    if (!server) throw new Error('Radius manager tidak ditemukan.');
    if (Number(server.is_active) !== 1) throw new Error('Server nonaktif — aktifkan dulu sebelum restart.');
    if (!isLocalRadiusHost(server.host)) {
        throw new Error('Restart otomatis hanya untuk FreeRADIUS lokal di VPS ini. Restart remote harus dari host tersebut.');
    }
    const result = restartFreeRADIUS();
    if (!result?.success) {
        throw new Error(result?.message || 'Gagal restart FreeRADIUS');
    }
    return { server, message: result.message || 'FreeRADIUS berhasil direstart' };
}

async function testRadiusServerById(id) {
    const server = await popService.getRadiusServerById(id);
    if (!server) throw new Error('Radius manager tidak ditemukan.');
    if (Number(server.is_active) !== 1) {
        return { success: false, message: 'Server nonaktif', checks: [] };
    }

    const checks = [];
    const host = String(server.host || '').trim();
    const authPort = Number(server.auth_port) || 1812;
    const local = isLocalRadiusHost(host);

    if (local) {
        const service = await checkRadiusServiceStatus();
        checks.push({
            name: 'Service FreeRADIUS',
            ok: service.status === 'running',
            detail: service.status === 'running' ? 'active' : (service.error || service.status),
        });

        try {
            const diag = await getRadiusSqliteFileDiagnostics();
            const dbOk = Boolean(diag.fileExists && !diag.error);
            checks.push({
                name: 'Database RADIUS',
                ok: dbOk,
                detail: dbOk
                    ? `${diag.radcheckPasswordUserCount ?? 0} user PPPoE · ${formatBytes(diag.fileSizeBytes || 0)}`
                    : (diag.error || 'File DB tidak ditemukan'),
            });
            if (dbOk) {
                const conn = await getRadiusConnection();
                try {
                    const [rows] = await conn.execute('SELECT 1 AS test');
                    const ok = Array.isArray(rows) && rows[0]?.test === 1;
                    checks.push({ name: 'Query uji DB', ok, detail: ok ? 'SELECT 1 OK' : 'Gagal' });
                } finally {
                    await conn.end();
                }
            }
        } catch (err) {
            checks.push({ name: 'Database RADIUS', ok: false, detail: err.message });
        }
    } else {
        const icmp = await pingHost(host);
        const sshOpen = await probeHostPort(host, 22);
        checks.push({ name: 'Ping host', ok: icmp, detail: icmp ? 'Merespons' : 'Tidak merespons' });
        checks.push({ name: 'Port SSH (22)', ok: sshOpen, detail: sshOpen ? 'Terbuka' : 'Tertutup / tidak terjangkau' });
    }

    const secret = await resolveStatusSecret(server);
    const statusProbe = await runStatusServerProbe(host, authPort, secret);
    checks.push({
        name: 'Status-Server RADIUS',
        ok: statusProbe.ok,
        detail: statusProbe.detail,
    });

    const failed = checks.filter((c) => c.ok === false).length;
    const success = failed === 0;
    return {
        success,
        message: success
            ? `Tes ${server.name} berhasil — semua pemeriksaan OK`
            : `Tes ${server.name}: ${failed} pemeriksaan gagal`,
        host,
        authPort,
        scope: local ? 'local' : 'remote',
        checks,
    };
}

module.exports = {
    isLocalRadiusHost,
    listRadiusServersWithEngine,
    verifyPlatformAdminPassword,
    restartRadiusServerById,
    testRadiusServerById,
    collectLocalEngineSnapshot,
};
