'use strict';

const fs = require('fs');
const path = require('path');
const tenantStore = require('./tenantStore');
const platformSettings = require('./platformSettingsService');

const SETTINGS_KEY = 'nms_connection';
const DEFAULT_BASE_URL = 'https://nms.kalimasada-app.com';
const CACHE_MS = 45 * 1000;
const MAX_POINTS = 360;

let schemaReady = false;
const responseCache = new Map();

class NmsError extends Error {
    constructor(message, status = 502, code = 'NMS') {
        super(message);
        this.name = 'NmsError';
        this.status = status;
        this.code = code;
    }
}

function flag(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    return ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase());
}

function asInt(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
}

function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function cleanText(value, max = 200) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

function assertSafeId(value, label) {
    const s = cleanText(value, 128);
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(s)) {
        throw new NmsError(`${label} tidak valid.`, 400, 'BAD_ID');
    }
    return s;
}

function normalizeBaseUrl(raw) {
    let parsed;
    try {
        parsed = new URL(String(raw || '').trim());
    } catch (_) {
        throw new NmsError('Alamat NMS harus URL http atau https yang valid.', 400, 'BAD_URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new NmsError('Alamat NMS hanya boleh http atau https.', 400, 'BAD_URL');
    }
    if (parsed.username || parsed.password) {
        throw new NmsError('Alamat NMS tidak boleh berisi username atau password.', 400, 'BAD_URL');
    }
    if (parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
        throw new NmsError('Alamat NMS diisi origin saja, tanpa path. Contoh: https://nms.kalimasada-app.com', 400, 'BAD_URL');
    }
    return parsed.origin;
}

function formatStamp(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

function formatJakartaStamp(date) {
    return formatStamp(date, 'Asia/Jakarta');
}

function formatNmsStamp(date) {
    return formatStamp(date, 'UTC');
}

function jakartaDate(value, endOfDay) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const hour = endOfDay ? 23 : 0;
    const minute = endOfDay ? 59 : 0;
    const second = endOfDay ? 59 : 0;
    const date = new Date(Date.UTC(year, month - 1, day, hour - 7, minute, second));
    const expect = `${match[1]}-${match[2]}-${match[3]}T${endOfDay ? '23:59' : '00:00'}`;
    if (!formatJakartaStamp(date).startsWith(expect)) return null;
    return date;
}

function rangeWindow(range, query) {
    if (range === 'custom') {
        const from = jakartaDate(query && query.from, false);
        const to = jakartaDate(query && query.to, true);
        if (!from || !to) {
            throw new NmsError('Isi tanggal mulai dan tanggal akhir.', 400, 'BAD_RANGE');
        }
        if (from.getTime() > to.getTime()) {
            throw new NmsError('Tanggal mulai tidak boleh setelah tanggal akhir.', 400, 'BAD_RANGE');
        }
        const maxSpan = 366 * 24 * 60 * 60 * 1000;
        if (to.getTime() - from.getTime() > maxSpan) {
            throw new NmsError('Rentang custom maksimal 366 hari.', 400, 'BAD_RANGE');
        }
        return {
            range: 'custom',
            from: formatNmsStamp(from),
            to: formatNmsStamp(to),
            fromMs: from.getTime(),
            toMs: to.getTime(),
        };
    }
    const key = range === '7d' || range === '30d' ? range : '24h';
    const hours = key === '30d' ? 24 * 30 : key === '7d' ? 24 * 7 : 24;
    const to = new Date();
    const from = new Date(to.getTime() - hours * 60 * 60 * 1000);
    return {
        range: key,
        from: formatNmsStamp(from),
        to: formatNmsStamp(to),
        fromMs: from.getTime(),
        toMs: to.getTime(),
    };
}

function downsample(points, max = MAX_POINTS) {
    if (!Array.isArray(points) || points.length <= max) return points || [];
    const out = [];
    const step = (points.length - 1) / (max - 1);
    for (let i = 0; i < max; i += 1) out.push(points[Math.round(i * step)]);
    return out;
}

function normalizePoints(points, kind) {
    if (!Array.isArray(points)) return [];
    return points.map((p) => {
        const t = num(p?.t ?? p?.time ?? p?.ts);
        if (t == null) return null;
        if (kind === 'probe') return { t, v: num(p?.v ?? p?.value) };
        return {
            t,
            in: num(p?.in ?? p?.inbound ?? p?.rx),
            out: num(p?.out ?? p?.outbound ?? p?.tx),
        };
    }).filter(Boolean);
}

function summarize(values) {
    const nums = (values || []).filter((v) => v != null && Number.isFinite(v));
    if (!nums.length) return null;
    let min = nums[0];
    let max = nums[0];
    let sum = 0;
    nums.forEach((n) => {
        if (n < min) min = n;
        if (n > max) max = n;
        sum += n;
    });
    return { min, avg: sum / nums.length, max };
}

function mergeStats(apiStats, computed) {
    const src = apiStats && typeof apiStats === 'object' ? apiStats : {};
    const fill = computed || {};
    const pick = (key) => (num(src[key]) != null ? num(src[key]) : (fill[key] != null ? fill[key] : null));
    const out = {
        min: pick('min'),
        avg: pick('avg'),
        max: pick('max'),
        billed: num(src.billed),
    };
    if (out.min == null && out.avg == null && out.max == null && out.billed == null) return null;
    return out;
}

function thresholdPercent(style) {
    const pct = num(style?.thresholdPct);
    if (pct == null) return 95;
    return Math.min(100, Math.max(1, pct));
}

function normalizeGraph(raw, style) {
    const kind = raw?.kind === 'probe' ? 'probe' : 'interface';
    const fullPoints = normalizePoints(raw?.points, kind);
    const inbound = kind === 'interface'
        ? mergeStats(raw?.inbound, summarize(fullPoints.map((p) => p.in)))
        : null;
    const outbound = kind === 'interface'
        ? mergeStats(raw?.outbound, summarize(fullPoints.map((p) => p.out)))
        : null;
    const probeStats = kind === 'probe' ? summarize(fullPoints.map((p) => p.v)) : null;
    return {
        id: raw?.id != null ? String(raw.id) : '',
        name: cleanText(raw?.name || raw?.key || 'Graph', 160),
        kind,
        key: raw?.key != null ? cleanText(raw.key, 160) : '',
        unit: cleanText(raw?.unit || '', 32),
        threshold: num(raw?.threshold),
        thresholdPct: thresholdPercent(style),
        inbound,
        outbound,
        min: num(raw?.min) != null ? num(raw.min) : (probeStats ? probeStats.min : null),
        avg: num(raw?.avg) != null ? num(raw.avg) : (probeStats ? probeStats.avg : null),
        max: num(raw?.max) != null ? num(raw.max) : (probeStats ? probeStats.max : null),
        current: num(raw?.current),
        colorIn: style?.colorIn || '#1f8a3b',
        colorOut: style?.colorOut || '#1d4e89',
        colorThreshold: style?.colorThreshold || '#c42318',
        colorProbe: raw?.key === 'loss' ? (style?.colorLoss || '#b45309') : (style?.colorProbe || '#1f8a3b'),
        points: downsample(fullPoints),
    };
}

function normalizeMrtg(payload) {
    const style = payload?.style && typeof payload.style === 'object' ? payload.style : {};
    const graphs = Array.isArray(payload?.graphs) ? payload.graphs.map((g) => normalizeGraph(g, style)) : [];
    return {
        device: payload?.device || null,
        from: payload?.from || null,
        to: payload?.to || null,
        note: payload?.note || null,
        graphs,
    };
}

function findGraph(graphs, binding) {
    const id = String(binding.nms_graph_id || '');
    const key = String(binding.interface_key || '');
    const kind = binding.nms_graph_kind || '';
    return (graphs || []).find((g) => {
        if (id && g.id && g.id === id) return true;
        if (key && g.key === key && (!kind || g.kind === kind)) return true;
        return false;
    }) || null;
}

function publicConnection(conn) {
    return {
        baseUrl: conn.baseUrl,
        timeoutMs: conn.timeoutMs,
        tokenSet: Boolean(conn.token),
    };
}

async function ensureSchema() {
    if (schemaReady) return;
    await platformSettings.ensurePlatformSettingsSchema();
    const migrationPath = path.join(__dirname, '../../migrations/add_platform_nms.sql');
    if (fs.existsSync(migrationPath)) {
        const sql = fs.readFileSync(migrationPath, 'utf8');
        const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
        for (const stmt of statements) {
            try {
                await tenantStore.dbRun(stmt);
            } catch (err) {
                const msg = String(err.message || '').toLowerCase();
                if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
                    console.warn('[nmsService] migration warn:', err.message);
                }
            }
        }
    }
    schemaReady = true;
}

async function getConnection() {
    await ensureSchema();
    const stored = await platformSettings.getSetting(SETTINGS_KEY);
    const src = stored && typeof stored === 'object' ? stored : {};
    let baseUrl = DEFAULT_BASE_URL;
    if (src.baseUrl) {
        try {
            baseUrl = normalizeBaseUrl(src.baseUrl);
        } catch (_) {
            baseUrl = DEFAULT_BASE_URL;
        }
    }
    let timeoutMs = Number(src.timeoutMs);
    if (!Number.isFinite(timeoutMs)) timeoutMs = 8000;
    timeoutMs = Math.min(20000, Math.max(1000, Math.round(timeoutMs)));
    return {
        baseUrl,
        token: typeof src.token === 'string' ? src.token : '',
        timeoutMs,
    };
}

async function getPublicConnection() {
    return publicConnection(await getConnection());
}

async function saveConnection(input = {}) {
    const current = await getConnection();
    const baseUrl = normalizeBaseUrl(input.baseUrl || current.baseUrl);
    let timeoutMs = Number(input.timeoutMs ?? current.timeoutMs);
    if (!Number.isFinite(timeoutMs)) timeoutMs = 8000;
    timeoutMs = Math.min(20000, Math.max(1000, Math.round(timeoutMs)));
    let token = current.token;
    if (flag(input.clearToken)) token = '';
    else if (input.token != null && String(input.token).trim() !== '') token = String(input.token).trim();
    if (token.length > 512) throw new NmsError('Token API terlalu panjang.', 400, 'BAD_TOKEN');
    await platformSettings.setSetting(SETTINGS_KEY, { baseUrl, token, timeoutMs });
    responseCache.clear();
    return publicConnection({ baseUrl, token, timeoutMs });
}

function describeFetchError(err) {
    const cause = err?.cause;
    const code = cause?.code || err?.code || '';
    const detail = cause?.message || err?.message || 'Gagal menghubungi NMS';
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || /altname|certificate/i.test(detail)) {
        return 'Sertifikat NMS tidak cocok dengan alamat yang diisi. Pakai hostname bersertifikat, misalnya https://nms.kalimasada-app.com';
    }
    if (code === 'ENOTFOUND') return 'Hostname NMS tidak ditemukan.';
    if (code === 'ECONNREFUSED') return 'Koneksi ke NMS ditolak.';
    if (err?.name === 'AbortError' || code === 'ABORT_ERR') return 'NMS tidak merespons dalam batas waktu.';
    return detail;
}

async function nmsFetch(pathname, { auth = true } = {}) {
    const conn = await getConnection();
    if (!pathname.startsWith('/api/')) throw new NmsError('Path API NMS tidak diizinkan.', 400, 'BAD_PATH');
    const url = `${conn.baseUrl}${pathname}`;
    if (!url.startsWith(`${conn.baseUrl}/`)) throw new NmsError('URL NMS tidak valid.', 400, 'BAD_URL');
    const headers = { Accept: 'application/json' };
    if (auth) {
        if (!conn.token) throw new NmsError('Token API NMS belum diisi.', 400, 'NO_TOKEN');
        headers.Authorization = `Bearer ${conn.token}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs);
    try {
        const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
        const text = await res.text();
        let body = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch (_) {
            body = { message: text.slice(0, 180) };
        }
        if (!res.ok) {
            const message = body?.message || `NMS membalas ${res.status}`;
            throw new NmsError(message, 502, res.status === 401 ? 'NMS_AUTH' : 'NMS_HTTP');
        }
        return body;
    } catch (err) {
        if (err instanceof NmsError) throw err;
        throw new NmsError(describeFetchError(err), 502, 'NMS_NET');
    } finally {
        clearTimeout(timer);
    }
}

async function testConnection() {
    const health = await nmsFetch('/api/health', { auth: false });
    let devices = null;
    let deviceError = null;
    try {
        const data = await nmsFetch('/api/devices?limit=1', { auth: true });
        const list = Array.isArray(data?.devices) ? data.devices : [];
        devices = { total: Number.isFinite(Number(data?.total)) ? Number(data.total) : list.length };
    } catch (err) {
        deviceError = err.message;
    }
    const healthUp = health?.api === 'up';
    return {
        success: healthUp && !deviceError,
        health: {
            api: health?.api || null,
            database: health?.database || null,
            zabbix: health?.zabbix || null,
            zabbixVersion: health?.zabbixVersion || null,
        },
        devices,
        message: deviceError || (healthUp ? 'Terhubung ke NMS.' : 'API NMS tidak dalam status up.'),
    };
}

function mapDevice(d) {
    return {
        id: d?.id != null ? String(d.id) : '',
        name: cleanText(d?.name || '', 160),
        ipAddress: cleanText(d?.ipAddress || d?.ip || '', 64),
        location: cleanText(d?.location || '', 160),
        status: cleanText(d?.status || d?.availability || '', 32),
    };
}

async function listDevices() {
    const data = await nmsFetch('/api/devices?limit=500');
    const list = Array.isArray(data?.devices) ? data.devices : [];
    return list.map(mapDevice).filter((d) => d.id);
}

function mapOption(item, kind) {
    return {
        key: item?.key != null ? cleanText(item.key, 160) : '',
        name: cleanText(item?.name || item?.key || kind, 160),
        unit: cleanText(item?.unit || '', 32),
        kind,
        added: Boolean(item?.added),
    };
}

async function getDeviceCatalog(deviceId) {
    const id = assertSafeId(deviceId, 'Perangkat NMS');
    const [options, mrtg] = await Promise.all([
        nmsFetch(`/api/devices/${encodeURIComponent(id)}/mrtg/options`).catch(() => ({ interfaces: [], probes: [] })),
        getDeviceMrtg(id, rangeWindow('24h')).catch(() => ({ graphs: [] })),
    ]);
    return {
        deviceId: id,
        interfaces: Array.isArray(options?.interfaces) ? options.interfaces.map((i) => mapOption(i, 'interface')).filter((i) => i.key) : [],
        probes: Array.isArray(options?.probes) ? options.probes.map((i) => mapOption(i, 'probe')).filter((i) => i.key) : [],
        graphs: (mrtg.graphs || []).map((g) => ({
            id: g.id,
            name: g.name,
            kind: g.kind,
            key: g.key,
            unit: g.unit,
        })),
    };
}

async function getDeviceMrtg(deviceId, window) {
    const id = assertSafeId(deviceId, 'Perangkat NMS');
    const from = window?.from;
    const to = window?.to;
    if (!from || !to) throw new NmsError('Rentang waktu graph tidak valid.', 400, 'BAD_RANGE');
    const cacheKey = `${id}|${from}|${to}`;
    const hit = responseCache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const qs = new URLSearchParams({ from, to });
    const payload = await nmsFetch(`/api/devices/${encodeURIComponent(id)}/mrtg?${qs.toString()}`);
    const value = normalizeMrtg(payload);
    responseCache.set(cacheKey, { at: Date.now(), value });
    return value;
}

async function listTenantsForMapping() {
    await ensureSchema();
    const rows = await tenantStore.listOperationalTenants();
    return rows.map((t) => ({
        id: t.id,
        name: t.name,
        subdomain: t.subdomain,
    }));
}

async function listRoutersForTenant(tenantId) {
    await ensureSchema();
    const tid = asInt(tenantId);
    if (!tid) throw new NmsError('Tenant wajib dipilih.', 400, 'BAD_TENANT');
    return tenantStore.dbAll(
        `SELECT id, name, nas_ip, location, tenant_id
         FROM routers
         WHERE tenant_id = ?
         ORDER BY name COLLATE NOCASE`,
        [tid]
    );
}

const BINDING_SELECT = `
    SELECT b.*,
           t.name AS tenant_name,
           t.subdomain AS tenant_subdomain,
           r.name AS router_name,
           r.nas_ip AS router_ip,
           CASE WHEN r.id IS NULL THEN 1 ELSE 0 END AS router_missing
    FROM platform_nms_graph_bindings b
    LEFT JOIN tenants t ON t.id = b.tenant_id
    LEFT JOIN routers r ON r.id = b.router_id
`;

async function listBindings() {
    await ensureSchema();
    return tenantStore.dbAll(`${BINDING_SELECT} ORDER BY b.sort_order ASC, b.id DESC`);
}

async function createBinding(input = {}) {
    await ensureSchema();
    const tenantId = asInt(input.tenant_id);
    const routerId = asInt(input.router_id);
    if (!tenantId || !routerId) throw new NmsError('Tenant dan router wajib diisi.', 400, 'BAD_BINDING');
    const tenant = await tenantStore.dbGet(
        'SELECT id FROM tenants WHERE id = ? AND deleted_at IS NULL',
        [tenantId]
    );
    if (!tenant) throw new NmsError('Tenant tidak ditemukan.', 400, 'BAD_TENANT');
    const router = await tenantStore.dbGet(
        'SELECT id, tenant_id, name, nas_ip FROM routers WHERE id = ?',
        [routerId]
    );
    if (!router || Number(router.tenant_id) !== tenantId) {
        throw new NmsError('Router tidak termasuk tenant yang dipilih.', 400, 'BAD_ROUTER');
    }
    const deviceId = assertSafeId(input.nms_device_id, 'Perangkat NMS');
    const kind = input.nms_graph_kind === 'probe' ? 'probe' : 'interface';
    const interfaceKey = cleanText(input.interface_key || '', 160);
    let graphId = cleanText(input.nms_graph_id || '', 128);
    if (graphId && !/^[A-Za-z0-9_.:-]{1,128}$/.test(graphId)) {
        throw new NmsError('ID graph NMS tidak valid.', 400, 'BAD_ID');
    }
    if (!graphId && interfaceKey) {
        graphId = `${kind}:${interfaceKey}`.replace(/[^\w.:-]+/g, '_').slice(0, 128);
    }
    if (!graphId) throw new NmsError('Pilih graph atau interface NMS.', 400, 'BAD_BINDING');
    const showManagement = flag(input.show_on_management, true);
    const showTenant = flag(input.show_on_tenant, true);
    if (!showManagement && !showTenant) {
        throw new NmsError('Pilih minimal satu tampilan: dashboard management atau tenant.', 400, 'BAD_BINDING');
    }
    const dup = await tenantStore.dbGet(
        `SELECT id FROM platform_nms_graph_bindings
         WHERE tenant_id = ? AND router_id = ? AND nms_device_id = ?
           AND (
             nms_graph_id = ?
             OR (interface_key != '' AND interface_key = ? AND nms_graph_kind = ?)
           )`,
        [tenantId, routerId, deviceId, graphId, interfaceKey, kind]
    );
    if (dup) throw new NmsError('Graph ini sudah dipetakan ke router tersebut.', 400, 'DUP_BINDING');
    const result = await tenantStore.dbRun(
        `INSERT INTO platform_nms_graph_bindings (
            tenant_id, router_id, nms_device_id, nms_device_name, nms_device_ip,
            nms_graph_id, nms_graph_name, nms_graph_kind, interface_key,
            show_on_management, show_on_tenant, sort_order, is_active, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now','localtime'))`,
        [
            tenantId,
            routerId,
            deviceId,
            cleanText(input.nms_device_name, 160),
            cleanText(input.nms_device_ip, 64),
            graphId,
            cleanText(input.nms_graph_name, 160),
            kind,
            interfaceKey,
            showManagement ? 1 : 0,
            showTenant ? 1 : 0,
            asInt(input.sort_order) || 0,
        ]
    );
    return tenantStore.dbGet(`${BINDING_SELECT} WHERE b.id = ?`, [result.id]);
}

async function updateBinding(id, input = {}) {
    await ensureSchema();
    const bindingId = asInt(id);
    if (!bindingId) throw new NmsError('Binding tidak ditemukan.', 404, 'NOT_FOUND');
    const current = await tenantStore.dbGet('SELECT * FROM platform_nms_graph_bindings WHERE id = ?', [bindingId]);
    if (!current) throw new NmsError('Binding tidak ditemukan.', 404, 'NOT_FOUND');
    const showManagement = input.show_on_management === undefined
        ? current.show_on_management
        : (flag(input.show_on_management) ? 1 : 0);
    const showTenant = input.show_on_tenant === undefined
        ? current.show_on_tenant
        : (flag(input.show_on_tenant) ? 1 : 0);
    const isActive = input.is_active === undefined ? current.is_active : (flag(input.is_active) ? 1 : 0);
    await tenantStore.dbRun(
        `UPDATE platform_nms_graph_bindings
         SET show_on_management = ?, show_on_tenant = ?, is_active = ?, updated_at = datetime('now','localtime')
         WHERE id = ?`,
        [showManagement, showTenant, isActive, bindingId]
    );
    return tenantStore.dbGet(`${BINDING_SELECT} WHERE b.id = ?`, [bindingId]);
}

async function deleteBinding(id) {
    await ensureSchema();
    const bindingId = asInt(id);
    if (!bindingId) throw new NmsError('Binding tidak ditemukan.', 404, 'NOT_FOUND');
    const result = await tenantStore.dbRun('DELETE FROM platform_nms_graph_bindings WHERE id = ?', [bindingId]);
    if (!result.changes) throw new NmsError('Binding tidak ditemukan.', 404, 'NOT_FOUND');
    return { id: bindingId };
}

function bindingMeta(row) {
    return {
        bindingId: row.id,
        tenantId: row.tenant_id,
        tenantName: row.tenant_name || '',
        tenantSubdomain: row.tenant_subdomain || '',
        routerId: row.router_id,
        routerName: row.router_name || '',
        routerIp: row.router_ip || '',
        deviceId: row.nms_device_id,
        deviceName: row.nms_device_name || '',
        deviceIp: row.nms_device_ip || '',
        graphId: row.nms_graph_id,
        graphName: row.nms_graph_name || '',
        kind: row.nms_graph_kind || 'interface',
        interfaceKey: row.interface_key || '',
    };
}

function graphPayload(window, extra) {
    return {
        range: window.range,
        from: window.from,
        to: window.to,
        fromMs: window.fromMs,
        toMs: window.toMs,
        ...extra,
    };
}

async function loadGraphsForBindings(rows, range, query) {
    const window = range && typeof range === 'object' && range.from
        ? range
        : rangeWindow(range, query);
    if (!rows.length) {
        return graphPayload(window, { success: true, graphs: [], message: null });
    }
    const conn = await getConnection();
    if (!conn.token) {
        return graphPayload(window, {
            success: false,
            graphs: [],
            message: 'Token API NMS belum diisi di portal management.',
        });
    }
    const deviceIds = [...new Set(rows.map((r) => r.nms_device_id))];
    const payloads = new Map();
    await Promise.all(deviceIds.map(async (deviceId) => {
        try {
            payloads.set(deviceId, { ok: true, data: await getDeviceMrtg(deviceId, window) });
        } catch (err) {
            payloads.set(deviceId, { ok: false, message: err.message || 'Gagal memuat graph NMS' });
        }
    }));
    const graphs = rows.map((row) => {
        const meta = bindingMeta(row);
        const pack = payloads.get(row.nms_device_id);
        if (!pack?.ok) return { ...meta, error: pack?.message || 'Gagal memuat graph NMS', points: [] };
        const graph = findGraph(pack.data.graphs, row);
        if (!graph) {
            return {
                ...meta,
                error: 'Graph belum aktif di NMS untuk perangkat ini.',
                points: [],
            };
        }
        return {
            ...meta,
            name: graph.name || meta.graphName,
            kind: graph.kind,
            unit: graph.unit,
            threshold: graph.threshold,
            thresholdPct: graph.thresholdPct,
            inbound: graph.inbound,
            outbound: graph.outbound,
            min: graph.min,
            avg: graph.avg,
            max: graph.max,
            current: graph.current,
            colorIn: graph.colorIn,
            colorOut: graph.colorOut,
            colorThreshold: graph.colorThreshold,
            colorProbe: graph.colorProbe,
            points: graph.points,
            note: pack.data.note || null,
            error: null,
        };
    });
    const allFailed = graphs.every((g) => g.error);
    return graphPayload(window, {
        success: !allFailed,
        graphs,
        message: allFailed ? (graphs[0]?.error || 'Gagal memuat graph NMS') : null,
    });
}

async function loadManagementGraphs(range, query) {
    await ensureSchema();
    const window = rangeWindow(range, query);
    const rows = await tenantStore.dbAll(
        `${BINDING_SELECT}
         WHERE b.is_active = 1 AND b.show_on_management = 1 AND r.id IS NOT NULL
         ORDER BY b.sort_order ASC, b.id ASC`
    );
    return loadGraphsForBindings(rows, window);
}

async function loadTenantGraphs(tenantId, range) {
    await ensureSchema();
    const tid = asInt(tenantId);
    if (!tid) {
        return {
            success: true,
            range: rangeWindow(range).range,
            graphs: [],
            message: null,
        };
    }
    const rows = await tenantStore.dbAll(
        `${BINDING_SELECT}
         WHERE b.is_active = 1 AND b.show_on_tenant = 1
           AND b.tenant_id = ? AND r.tenant_id = ?
         ORDER BY b.sort_order ASC, b.id ASC`,
        [tid, tid]
    );
    return loadGraphsForBindings(rows, range);
}

module.exports = {
    NmsError,
    ensureSchema,
    getPublicConnection,
    saveConnection,
    testConnection,
    listDevices,
    getDeviceCatalog,
    listTenantsForMapping,
    listRoutersForTenant,
    listBindings,
    createBinding,
    updateBinding,
    deleteBinding,
    loadManagementGraphs,
    loadTenantGraphs,
    normalizeBaseUrl,
    normalizeMrtg,
    findGraph,
    rangeWindow,
};
