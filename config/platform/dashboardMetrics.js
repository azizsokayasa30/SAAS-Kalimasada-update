'use strict';

const net = require('net');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const tenantStore = require('./tenantStore');
const { getMikrotikConnectionForRouter } = require('../mikrotik');
const { getRadiusSqliteFileDiagnostics } = require('../radiusSQLite');
const { getSetting } = require('../settingsManager');

const ROUTER_PROBE_TIMEOUT_MS = 2200;
const DEFAULT_MAIN_INTERFACE = 'SFP+1';
const HOST_PROBE_TIMEOUT_MS = 1500;

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

async function listRadiusNasRows() {
    try {
        const { getRadiusConnection } = require('../radiusSQLite');
        const conn = await getRadiusConnection();
        const [rows] = await conn.execute(
            'SELECT nasname, shortname, description FROM nas ORDER BY nasname ASC'
        );
        await conn.end();
        return Array.isArray(rows) ? rows : [];
    } catch (_) {
        return [];
    }
}

async function buildRadiusServerStats(networkNas) {
    const nasRows = await listRadiusNasRows();
    const probeByIp = new Map();
    for (const item of networkNas?.items || []) {
        const ip = String(item.nas_ip || '').trim();
        if (ip) probeByIp.set(ip, item);
    }

    let items = [];
    if (nasRows.length) {
        items = await Promise.all(
            nasRows.map(async (row) => {
                const ip = String(row.nasname || '').trim();
                const name = row.shortname || row.description || ip || 'RADIUS Server';
                const matched = probeByIp.get(ip);
                if (matched) {
                    return {
                        ip,
                        name,
                        status: matched.status === 'online' ? 'up' : 'down',
                    };
                }
                const reachable = await probeHostPort(ip, 8728);
                return { ip, name, status: reachable ? 'up' : 'down' };
            })
        );
    } else {
        items = (networkNas?.items || []).map((item) => ({
            ip: item.nas_ip,
            name: item.name,
            status: item.status === 'online' ? 'up' : 'down',
        }));
    }

    const up = items.filter((item) => item.status === 'up').length;
    const down = items.filter((item) => item.status === 'down').length;

    return {
        total: items.length,
        up,
        down,
        items,
    };
}

function bitsToMbps(bits) {
    const n = Number(bits);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return parseFloat((n / 1_000_000).toFixed(2));
}

function normalizeIfaceKey(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/sfp-sfpplus/g, 'sfp+')
        .replace(/sfpplus/g, 'sfp+');
}

function ifaceAliasCandidates(preferred) {
    const p = String(preferred || '').trim();
    const key = normalizeIfaceKey(p);
    const out = [];
    const add = (v) => {
        if (v && !out.includes(v)) out.push(v);
    };
    add(p);
    if (key === 'ether1-isp' || key === 'ether1' || (key.includes('isp') && key.includes('ether1'))) {
        add('SFP+1');
        add('sfp-sfpplus1');
        add('ether1');
    }
    if (key === 'sfp-sfpplus1' || key === 'sfp+1' || key === 'sfpplus1') {
        add('SFP+1');
        add('sfp-sfpplus1');
        add('sfpplus1');
    }
    if (key === 'sfp-sfpplus2' || key === 'sfp+2' || key === 'sfpplus2') {
        add('SFP+2');
        add('sfp-sfpplus2');
    }
    return out;
}

async function resolveExistingInterface(conn, preferred) {
    let names = [];
    try {
        const ifaces = await conn.write('/interface/print');
        names = (Array.isArray(ifaces) ? ifaces : [])
            .map((i) => (i && i.name != null ? String(i.name).trim() : ''))
            .filter((n) => n && !n.startsWith('<'));
    } catch (_) {
        return preferred;
    }
    if (!names.length) return preferred;

    const byKey = new Map();
    for (const n of names) byKey.set(normalizeIfaceKey(n), n);

    for (const cand of ifaceAliasCandidates(preferred)) {
        const hit = byKey.get(normalizeIfaceKey(cand));
        if (hit) return hit;
    }

    const physical = names.filter((n) => {
        const k = n.toLowerCase();
        return k.startsWith('sfp') || /^ether\d+/i.test(n);
    });
    const sfp = physical.find((n) => /^sfp\+/i.test(n) || /^sfp-sfpplus/i.test(n));
    return sfp || physical[0] || preferred;
}

async function readMainInterfaceMbps(conn, preferredIface) {
    if (!conn) return { rx_mbps: 0, tx_mbps: 0, interface: preferredIface || null };
    const resolved = await resolveExistingInterface(conn, preferredIface);
    const tryNames = [...new Set([resolved, ...ifaceAliasCandidates(preferredIface)])];
    for (const ifaceName of tryNames) {
        try {
            const monitor = await conn.write('/interface/monitor-traffic', [
                `=interface=${ifaceName}`,
                '=once=',
            ]);
            const m = monitor && monitor[0] ? monitor[0] : null;
            if (!m) continue;
            return {
                rx_mbps: bitsToMbps(m['rx-bits-per-second']),
                tx_mbps: bitsToMbps(m['tx-bits-per-second']),
                interface: ifaceName,
            };
        } catch (_) {
            /* try next */
        }
    }
    return { rx_mbps: 0, tx_mbps: 0, interface: resolved || preferredIface };
}

async function probeRouter(router, preferredInterface) {
    const name = router.name || router.nas_identifier || router.nas_ip || `NAS ${router.id}`;
    const base = {
        id: router.id,
        name,
        tenant_id: router.tenant_id || null,
        tenant_name: router.tenant_name || '—',
        tenant_subdomain: router.tenant_subdomain || '',
        nas_ip: router.nas_ip || null,
        status: 'offline',
        rx_mbps: 0,
        tx_mbps: 0,
        main_interface: preferredInterface,
        active_sessions: 0,
        error: null,
    };

    try {
        const conn = await Promise.race([
            getMikrotikConnectionForRouter(router),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), ROUTER_PROBE_TIMEOUT_MS)
            ),
        ]);
        if (!conn) {
            base.error = 'Koneksi gagal';
            return base;
        }

        const [actives, traffic] = await Promise.all([
            conn.write('/ppp/active/print').catch(() => []),
            readMainInterfaceMbps(conn, preferredInterface),
        ]);

        base.status = 'online';
        base.active_sessions = Array.isArray(actives) ? actives.length : 0;
        base.rx_mbps = Number(traffic.rx_mbps) || 0;
        base.tx_mbps = Number(traffic.tx_mbps) || 0;
        base.main_interface = traffic.interface || preferredInterface;
        return base;
    } catch (err) {
        base.error = err.message || 'Tidak merespons';
        return base;
    }
}

async function listRoutersWithTenants() {
    const db = tenantStore.getDb();
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT r.*, t.name AS tenant_name, t.subdomain AS tenant_subdomain, t.status AS tenant_status
             FROM routers r
             LEFT JOIN tenants t ON t.id = r.tenant_id
             WHERE t.deleted_at IS NULL OR r.tenant_id IS NULL
             ORDER BY t.name ASC, r.name ASC`,
            [],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
}

async function checkRadiusServiceStatus() {
    if (process.platform === 'win32') {
        return { status: 'unknown', error: null, platform: 'windows' };
    }
    try {
        const { stdout } = await execAsync('systemctl is-active freeradius', { timeout: 5000 });
        const raw = stdout.trim();
        if (raw === 'active') return { status: 'running', error: null };
        if (raw === 'inactive' || raw === 'failed') return { status: 'not_running', error: null };
        return { status: 'unknown', error: null };
    } catch (error) {
        try {
            const { stdout } = await execAsync('pgrep -x freeradius || echo "not_running"', { timeout: 3000 });
            if (stdout.trim() === 'not_running') {
                return { status: 'not_running', error: error.message };
            }
            return { status: 'running', error: null };
        } catch (altError) {
            return { status: 'not_running', error: altError.message || error.message };
        }
    }
}

async function getRadiusHealth() {
    const service = await checkRadiusServiceStatus();
    let dbStatus = 'unknown';
    let dbError = null;
    let nasRegistered = 0;
    let radcheckUsers = 0;
    let dbPath = null;

    try {
        const diag = await getRadiusSqliteFileDiagnostics();
        dbPath = diag.dbPath || null;
        if (diag.error) {
            dbStatus = 'error';
            dbError = diag.error;
        } else if (diag.fileExists) {
            dbStatus = 'connected';
            radcheckUsers = diag.radcheckPasswordUserCount ?? diag.radcheckRowCount ?? 0;
            try {
                const { getRadiusConnection } = require('../radiusSQLite');
                const conn = await getRadiusConnection();
                const [nasRows] = await conn.execute('SELECT COUNT(*) as n FROM nas');
                nasRegistered = Array.isArray(nasRows) && nasRows[0] ? nasRows[0].n : 0;
                await conn.end();
            } catch (_) {
                nasRegistered = 0;
            }
        } else {
            dbStatus = 'error';
            dbError = 'File database RADIUS tidak ditemukan';
        }
    } catch (error) {
        dbStatus = 'error';
        dbError = error.message;
    }

    let overallStatus = 'unknown';
    let message = 'Status RADIUS tidak diketahui';

    if (service.status === 'running' && dbStatus === 'connected') {
        overallStatus = 'running';
        message = 'RADIUS berjalan normal';
    } else if (service.platform === 'windows' && dbStatus === 'connected') {
        overallStatus = 'degraded';
        message = 'Database RADIUS siap (service dicek di server Linux)';
    } else if (service.status === 'not_running') {
        overallStatus = 'not_running';
        message = 'Service FreeRADIUS tidak berjalan';
    } else if (dbStatus === 'error') {
        overallStatus = 'error';
        message = dbError || 'Database RADIUS bermasalah';
    } else if (service.status === 'running' && dbStatus === 'connected') {
        overallStatus = 'running';
        message = 'RADIUS berjalan normal';
    } else {
        overallStatus = 'error';
        message = service.error || dbError || 'Ada masalah pada RADIUS';
    }

    return {
        status: overallStatus,
        message,
        service: service.status,
        database: dbStatus,
        nasRegistered,
        radcheckUsers,
        dbPath,
    };
}

async function getCustomerCountByTenant() {
    const db = tenantStore.getDb();
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT tenant_id, COUNT(*) AS customers
             FROM customers
             WHERE tenant_id IS NOT NULL
             GROUP BY tenant_id`,
            [],
            (err, rows) => {
                if (err) reject(err);
                else {
                    const map = new Map();
                    for (const row of rows || []) map.set(row.tenant_id, row.customers || 0);
                    resolve(map);
                }
            }
        );
    });
}

async function getLiveNetworkMetrics() {
    const preferredInterface = getSetting('main_interface', DEFAULT_MAIN_INTERFACE);
    const [routers, customerMap] = await Promise.all([
        listRoutersWithTenants(),
        getCustomerCountByTenant(),
    ]);
    const probes = await Promise.all(
        routers.map((router) => probeRouter(router, preferredInterface))
    );

    const online = probes.filter((p) => p.status === 'online');
    const offline = probes.filter((p) => p.status === 'offline');

    const traffic = probes.reduce(
        (acc, item) => {
            if (item.status !== 'online') return acc;
            acc.rx_mbps += Number(item.rx_mbps) || 0;
            acc.tx_mbps += Number(item.tx_mbps) || 0;
            acc.reporting += 1;
            return acc;
        },
        { rx_mbps: 0, tx_mbps: 0, reporting: 0 }
    );

    traffic.rx_mbps = parseFloat(traffic.rx_mbps.toFixed(2));
    traffic.tx_mbps = parseFloat(traffic.tx_mbps.toFixed(2));
    traffic.interface = preferredInterface;

    const tenantMap = new Map();
    for (const item of probes) {
        const key = item.tenant_id || 'unassigned';
        if (!tenantMap.has(key)) {
            tenantMap.set(key, {
                tenant_id: item.tenant_id,
                tenant_name: item.tenant_name,
                tenant_subdomain: item.tenant_subdomain,
                customers: customerMap.get(item.tenant_id) || 0,
                routers: 0,
                nas_online: 0,
                nas_offline: 0,
                active_sessions: 0,
                rx_mbps: 0,
                tx_mbps: 0,
            });
        }
        const row = tenantMap.get(key);
        row.routers += 1;
        if (item.status === 'online') {
            row.nas_online += 1;
            row.active_sessions += item.active_sessions || 0;
            row.rx_mbps += Number(item.rx_mbps) || 0;
            row.tx_mbps += Number(item.tx_mbps) || 0;
        } else {
            row.nas_offline += 1;
        }
    }

    const tenantBreakdown = [...tenantMap.values()]
        .map((row) => ({
            ...row,
            rx_mbps: parseFloat(row.rx_mbps.toFixed(2)),
            tx_mbps: parseFloat(row.tx_mbps.toFixed(2)),
        }))
        .sort((a, b) => b.routers - a.routers);

    return {
        nas: {
            total: probes.length,
            online: online.length,
            offline: offline.length,
            items: probes,
        },
        traffic,
        tenantBreakdown,
        main_interface: preferredInterface,
        updatedAt: new Date().toISOString(),
    };
}

async function getDashboardMetrics() {
    const [stats, radius, network] = await Promise.all([
        tenantStore.getExtendedGlobalStats(),
        getRadiusHealth(),
        getLiveNetworkMetrics(),
    ]);

    const servers = await buildRadiusServerStats(network.nas);

    return {
        success: true,
        updatedAt: network.updatedAt,
        stats,
        radius: {
            ...radius,
            servers,
        },
        network,
    };
}

module.exports = {
    getDashboardMetrics,
    getRadiusHealth,
    getLiveNetworkMetrics,
};
