/**
 * Trafik PPPoE per pelanggan (detail pelanggan mobile): kecepatan saat ini + pemakaian sesi.
 * Sumber: interface dinamis MikroTik `<pppoe-LOGIN>` di router tempat sesi aktif.
 * Dari sisi router: rx = upload pelanggan, tx = download pelanggan.
 */
const logger = require('./logger');
const { getLocalTimestamp } = require('./settingsManager');

const ROUTER_LOCATE_TTL_MS = 2 * 60 * 1000;
const RESULT_TTL_MS = 2000;
const ROUTER_TIMEOUT_MS = 4000;

/** key tenant:login -> { routerId, ts } */
const routerByLogin = new Map();
/** key tenant:login -> { ts, data } */
const resultCache = new Map();
/** key tenant:login -> Promise */
const inflight = new Map();

function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label}: timeout ${ms}ms`)), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

function toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** "2w4d20h35m50s" / "20:35:50" / "1d02:03:04" -> detik */
function routerOsDurationToSeconds(raw) {
    if (raw == null || raw === '') return null;
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) return Number(s);
    let total = 0;
    let matched = false;
    const re = /(\d+)(w|d|h|m|s)(?!s)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        matched = true;
        const n = Number(m[1]);
        total += { w: 604800, d: 86400, h: 3600, m: 60, s: 1 }[m[2]] * n;
    }
    const clock = s.match(/(\d+):(\d{2}):(\d{2})$/);
    if (clock) {
        matched = true;
        total += Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
    }
    return matched ? total : null;
}

function formatDuration(secs) {
    if (secs == null) return null;
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (d > 0) return `${d} hari ${h} jam ${m} mnt`;
    if (h > 0) return `${h} jam ${m} mnt`;
    if (m > 0) return `${m} mnt ${s} dtk`;
    return `${s} dtk`;
}

function loadTenantRouters(tenantId) {
    const { db } = require('./billing');
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM routers WHERE tenant_id = ? ORDER BY id', [tenantId], (err, rows) =>
            err ? reject(err) : resolve(rows || [])
        );
    });
}

async function locateRouter(tenantId, login, routers) {
    const key = `${tenantId}:${login}`;
    const hit = routerByLogin.get(key);
    if (hit && Date.now() - hit.ts < ROUTER_LOCATE_TTL_MS) {
        const r = routers.find((x) => Number(x.id) === Number(hit.routerId));
        if (r) return r;
    }
    const { getMikrotikConnectionForRouter, getCachedPppActivePrint } = require('./mikrotik');
    const found = await Promise.all(
        routers.map(async (r) => {
            try {
                const rows = await withTimeout(
                    (async () => {
                        const conn = await getMikrotikConnectionForRouter(r);
                        return getCachedPppActivePrint(conn, `r${r.id}_traffic`);
                    })(),
                    ROUTER_TIMEOUT_MS,
                    `router ${r.name || r.id}`
                );
                return (rows || []).some((row) => String(row.name || '').trim() === login) ? r : null;
            } catch (e) {
                logger.warn(`[pppoe-traffic] locate ${r.name || r.id}: ${e.message}`);
                return null;
            }
        })
    );
    const router = found.find(Boolean) || null;
    if (router) routerByLogin.set(key, { routerId: router.id, ts: Date.now() });
    else routerByLogin.delete(key);
    return router;
}

async function readSessionTraffic(router, login) {
    const { getMikrotikConnectionForRouter } = require('./mikrotik');
    const conn = await getMikrotikConnectionForRouter(router);
    const ifaceName = `<pppoe-${login}>`;

    // monitor-traffic membalas !trap (bukan !empty) bila interface tidak ada — aman untuk cek sesi.
    let mon;
    try {
        mon = await withTimeout(
            conn.write('/interface/monitor-traffic', [`=interface=${ifaceName}`, '=once=']),
            ROUTER_TIMEOUT_MS,
            'monitor-traffic'
        );
    } catch (e) {
        return null;
    }
    const rate = (Array.isArray(mon) && mon[0]) || {};

    const [ifRows, actRows] = await Promise.all([
        withTimeout(
            conn.write('/interface/print', [`?name=${ifaceName}`, '=.proplist=name,rx-byte,tx-byte']),
            ROUTER_TIMEOUT_MS,
            'interface print'
        ).catch(() => []),
        withTimeout(
            conn.write('/ppp/active/print', [`?name=${login}`, '=.proplist=name,uptime,address']),
            ROUTER_TIMEOUT_MS,
            'ppp active'
        ).catch(() => [])
    ]);
    const iface = (Array.isArray(ifRows) && ifRows[0]) || {};
    const act = (Array.isArray(actRows) && actRows[0]) || {};

    const uploadBytes = toNumber(iface['rx-byte']);
    const downloadBytes = toNumber(iface['tx-byte']);
    const totalBytes = uploadBytes + downloadBytes;
    const uptimeSeconds = routerOsDurationToSeconds(act.uptime);
    const days = uptimeSeconds != null ? Math.max(1, uptimeSeconds / 86400) : 1;
    const startedAt =
        uptimeSeconds != null ? getLocalTimestamp(new Date(Date.now() - uptimeSeconds * 1000)) : null;

    return {
        online: true,
        login,
        router_name: router.name || null,
        ip_address: act.address || null,
        uptime: formatDuration(uptimeSeconds),
        uptime_seconds: uptimeSeconds,
        session_started_at: startedAt,
        download_bytes: downloadBytes,
        upload_bytes: uploadBytes,
        total_bytes: totalBytes,
        avg_daily_bytes: Math.round(totalBytes / days),
        rate: {
            download_bps: toNumber(rate['tx-bits-per-second']),
            upload_bps: toNumber(rate['rx-bits-per-second'])
        },
        sampled_at: getLocalTimestamp()
    };
}

/**
 * @param {{ pppoe_username?: string, username?: string }} customer
 * @param {number} tenantId
 */
async function getCustomerPppoeTraffic(customer, tenantId) {
    const login =
        (customer?.pppoe_username && String(customer.pppoe_username).trim()) ||
        (customer?.username && String(customer.username).trim()) ||
        '';
    if (!login) return { online: false, login: '', reason: 'no_login' };
    const tid = parseInt(tenantId, 10);
    if (!Number.isFinite(tid)) throw new Error('Konteks tenant wajib');

    const key = `${tid}:${login}`;
    const cached = resultCache.get(key);
    if (cached && Date.now() - cached.ts < RESULT_TTL_MS) return cached.data;
    if (inflight.has(key)) return inflight.get(key);

    const job = (async () => {
        const routers = await loadTenantRouters(tid);
        let router = await locateRouter(tid, login, routers);
        let data = router ? await readSessionTraffic(router, login) : null;
        if (!data && router) {
            // Sesi mungkin pindah router / reconnect: cari ulang sekali tanpa cache lokasi.
            routerByLogin.delete(key);
            router = await locateRouter(tid, login, routers);
            data = router ? await readSessionTraffic(router, login) : null;
        }
        const result = data || { online: false, login };
        if (resultCache.size > 500) resultCache.clear();
        if (routerByLogin.size > 2000) routerByLogin.clear();
        resultCache.set(key, { ts: Date.now(), data: result });
        return result;
    })().finally(() => inflight.delete(key));

    inflight.set(key, job);
    return job;
}

module.exports = { getCustomerPppoeTraffic, routerOsDurationToSeconds };
