/**
 * Master switch notifikasi WhatsApp otomatis.
 * Disimpan per tenant di tenants.settings:
 *   - whatsapp_system_monitors
 *   - whatsapp_monitor_settings (interval / threshold)
 * Tanpa tenant (instalasi lama) tetap memakai settings.json.
 * Jangan pernah membaca settings.json global saat tenant sudah diketahui —
 * itu sumber kebocoran toggle antar tenant.
 */
const { getSetting, setSetting } = require('./settingsManager');

const MONITOR_DEFINITIONS = [
    {
        id: 'pppoe_login_logout_wa',
        category: 'PPPoE & MikroTik',
        title: 'Login / logout PPPoE',
        description: 'Pesan ke admin & teknisi saat user PPPoE login atau logout (monitor interval).'
    },
    {
        id: 'rx_power_threshold_wa',
        category: 'GenieACS & RX',
        title: 'Peringatan RX power (ambang)',
        description: 'Notifikasi perangkat dengan redaman/RX mendekati kritis (interval rxPowerMonitor).'
    },
    {
        id: 'genieacs_rx_recap_wa',
        category: 'GenieACS & RX',
        title: 'Rekap redaman RX (GenieACS)',
        description: 'Ringkasan periodik perangkat RX rendah dari GenieACS ke teknisi.'
    },
    {
        id: 'genieacs_offline_digest_wa',
        category: 'GenieACS & RX',
        title: 'Digest perangkat offline',
        description: 'Ringkasan periodik ONU/perangkat offline ke teknisi.'
    },
    {
        id: 'billing_daily_due_wa',
        category: 'Billing',
        title: 'Jadwal WA tagihan (harian 09:00)',
        description: 'Tagihan baru H-X, pengingat H-Y, dan peringatan hari H — sesuai jadwal di WhatsApp Settings.'
    },
    {
        id: 'billing_scheduler_invoice_wa',
        category: 'Billing',
        title: 'WA tagihan baru (kirim manual / test)',
        description: 'Hanya untuk tombol test atau kirim manual dari admin — bukan saat invoice dibuat otomatis.'
    },
    {
        id: 'payment_received_wa',
        category: 'Billing',
        title: 'WA pembayaran diterima',
        description: 'Pesan otomatis ke pelanggan saat pembayaran/tagihan ditandai lunas.'
    },
    {
        id: 'customer_welcome_wa',
        category: 'Pelanggan',
        title: 'WA welcome pelanggan baru',
        description: 'Pesan sambutan otomatis setelah pelanggan dibuat/diaktifkan.'
    },
    {
        id: 'isolir_suspension_wa',
        category: 'Isolir & layanan',
        title: 'WA saat layanan diisolir',
        description: 'Notifikasi WhatsApp ke pelanggan saat isolir/suspensi otomatis.'
    },
    {
        id: 'isolir_restore_wa',
        category: 'Isolir & layanan',
        title: 'WA saat layanan dipulihkan',
        description: 'Notifikasi saat layanan diaktifkan kembali setelah pembayaran / restore.'
    },
    {
        id: 'member_isolir_wa',
        category: 'Isolir & layanan',
        title: 'WA isolir member hotspot',
        description: 'Pesan ke member hotspot saat proses isolir member.'
    },
    {
        id: 'trouble_report_routing_wa',
        category: 'Laporan gangguan',
        title: 'WA laporan gangguan',
        description: 'Notifikasi tiket baru ke grup teknisi dan update status ke pelanggan (selain toggle per-template).'
    },
    {
        id: 'installation_job_wa',
        category: 'Teknisi & instalasi',
        title: 'WA tugas instalasi / PSB',
        description: 'Pesan otomatis ke teknisi untuk assignment, update status, dan penyelesaian job instalasi.'
    },
    {
        id: 'broadcast_group_wa',
        category: 'Grup & broadcast',
        title: 'Kirim ke grup WA terdaftar',
        description: 'Saat broadcast gangguan/pengumuman atau alur yang memakai daftar group billing — kirim salinan ke grup.'
    }
];

const MONITOR_IDS = new Set(MONITOR_DEFINITIONS.map((m) => m.id));

const LEGACY_BOOLEAN_KEYS = {
    pppoe_login_logout_wa: ['pppoe_monitor_enable', 'pppoe_notifications.enabled'],
    rx_power_threshold_wa: ['rx_power_notification_enable'],
    genieacs_rx_recap_wa: ['rxpower_recap_enable'],
    genieacs_offline_digest_wa: ['offline_notification_enable']
};

const CACHE_TTL_MS = 10000;
/** @type {Map<number, { monitors: object, exp: number }>} */
const monitorCache = new Map();
/** @type {Map<string, number>} */
const lastRunAt = new Map();

function normalizeTenantId(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function resolveContextTenantId(explicit) {
    const fromArg = normalizeTenantId(explicit);
    if (fromArg) return fromArg;
    try {
        const { hasTenantContext, getTenantId } = require('./platform/tenantContext');
        if (hasTenantContext()) return normalizeTenantId(getTenantId());
    } catch (_) { /* ignore */ }
    return null;
}

function isEnabledValue(value) {
    if (value === false || value === 0) return false;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'false' || normalized === '0' || normalized === 'off' || normalized === 'no') return false;
    }
    return true;
}

function blankMonitors() {
    const o = {};
    MONITOR_DEFINITIONS.forEach((m) => {
        o[m.id] = true;
    });
    return o;
}

/**
 * Hanya objek whatsapp_system_monitors milik settings ini.
 * Legacy default (pppoe_monitor_enable: false di template tenant) tidak dipakai,
 * supaya default bersama tidak mematikan toggle tenant yang belum menyimpan.
 */
function mergeMonitorsFromRaw(raw) {
    const base = blankMonitors();
    const saved = raw && raw.whatsapp_system_monitors;
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        Object.keys(saved).forEach((k) => {
            if (MONITOR_IDS.has(k)) base[k] = isEnabledValue(saved[k]);
        });
    }
    return base;
}

function getMergedMonitors() {
    return mergeMonitorsFromRaw(getSettingsWithCacheSafe());
}

function getSettingsWithCacheSafe() {
    try {
        const { getSettingsWithCache } = require('./settingsManager');
        return getSettingsWithCache() || {};
    } catch (_) {
        return {};
    }
}

function invalidateTenantMonitorCache(tenantId = null) {
    const tid = normalizeTenantId(tenantId);
    if (tid) monitorCache.delete(tid);
    else monitorCache.clear();
}

async function loadRawTenantSettings(tenantId) {
    const tid = normalizeTenantId(tenantId);
    if (!tid) return {};
    const tenantStore = require('./platform/tenantStore');
    const tenant = await tenantStore.getTenantById(tid);
    const settings = tenant && tenant.settings && typeof tenant.settings === 'object' ? tenant.settings : {};
    return settings;
}

async function getMergedMonitorsForTenant(tenantId) {
    const tid = resolveContextTenantId(tenantId);
    if (!tid) return getMergedMonitors();
    const hit = monitorCache.get(tid);
    if (hit && hit.exp > Date.now()) return { ...hit.monitors };
    const raw = await loadRawTenantSettings(tid);
    const monitors = mergeMonitorsFromRaw(raw);
    monitorCache.set(tid, { monitors, exp: Date.now() + CACHE_TTL_MS });
    return { ...monitors };
}

async function isWaSystemMonitorEnabled(id, tenantId = null) {
    if (!MONITOR_IDS.has(id)) return true;
    const monitors = await getMergedMonitorsForTenant(tenantId);
    return monitors[id] !== false;
}

function buildLegacyPatch(monitors, raw) {
    const prevPppoe = raw && raw.pppoe_notifications && typeof raw.pppoe_notifications === 'object' && !Array.isArray(raw.pppoe_notifications)
        ? raw.pppoe_notifications
        : {};
    const patch = {};
    Object.entries(LEGACY_BOOLEAN_KEYS).forEach(([monitorId, keys]) => {
        const enabled = monitors[monitorId] !== false;
        keys.forEach((key) => {
            if (!key.includes('.')) patch[key] = enabled;
        });
    });
    const pppoeOn = monitors.pppoe_login_logout_wa !== false;
    patch.pppoe_notifications = {
        loginNotifications: pppoeOn,
        logoutNotifications: pppoeOn,
        includeOfflineList: prevPppoe.includeOfflineList !== undefined ? prevPppoe.includeOfflineList : true,
        maxOfflineListCount: prevPppoe.maxOfflineListCount !== undefined ? prevPppoe.maxOfflineListCount : '20',
        monitorInterval: prevPppoe.monitorInterval,
        enabled: pppoeOn
    };
    return patch;
}

function patchLiveTenantSettings(tenantId, patch) {
    try {
        const { hasTenantContext, getTenant } = require('./platform/tenantContext');
        if (!hasTenantContext()) return;
        const tenant = getTenant();
        if (!tenant || normalizeTenantId(tenant.id) !== normalizeTenantId(tenantId)) return;
        if (!tenant.settings || typeof tenant.settings !== 'object') tenant.settings = {};
        Object.keys(patch || {}).forEach((key) => {
            const val = patch[key];
            if (val && typeof val === 'object' && !Array.isArray(val)
                && tenant.settings[key] && typeof tenant.settings[key] === 'object' && !Array.isArray(tenant.settings[key])) {
                tenant.settings[key] = { ...tenant.settings[key], ...val };
            } else {
                tenant.settings[key] = val;
            }
        });
    } catch (_) { /* ignore */ }
}

async function setMonitorsPartialForTenant(tenantId, partial) {
    const tid = normalizeTenantId(tenantId);
    if (!tid) return setMonitorsPartial(partial);
    const { saveFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
    const raw = await loadRawTenantSettings(tid);
    const current = mergeMonitorsFromRaw(raw);
    if (partial && typeof partial === 'object') {
        Object.keys(partial).forEach((k) => {
            if (MONITOR_IDS.has(k)) current[k] = isEnabledValue(partial[k]);
        });
    }
    const patch = {
        whatsapp_system_monitors: current,
        ...buildLegacyPatch(current, raw)
    };
    await saveFullSettingsForTenantId(tid, patch);
    monitorCache.set(tid, { monitors: { ...current }, exp: Date.now() + CACHE_TTL_MS });
    patchLiveTenantSettings(tid, patch);
    return { ...current };
}

function setMonitorsPartial(partial) {
    const current = getMergedMonitors();
    if (partial && typeof partial === 'object') {
        Object.keys(partial).forEach((k) => {
            if (MONITOR_IDS.has(k)) current[k] = isEnabledValue(partial[k]);
        });
    }
    setSetting('whatsapp_system_monitors', current);
    syncLegacyBooleanSettings(current);
    invalidateTenantMonitorCache();
    return getMergedMonitors();
}

function syncLegacyBooleanSettings(monitors) {
    const patch = buildLegacyPatch(monitors, getSettingsWithCacheSafe());
    Object.keys(patch).forEach((key) => {
        if (key === 'pppoe_notifications') return;
        setSetting(key, patch[key]);
    });
    const currentPppoe = getSetting('pppoe_notifications', {});
    const base = currentPppoe && typeof currentPppoe === 'object' && !Array.isArray(currentPppoe) ? currentPppoe : {};
    setSetting('pppoe_notifications', { ...base, ...patch.pppoe_notifications });
}

function readOwn(obj, key) {
    if (!obj || typeof obj !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
        return obj[key];
    }
    return undefined;
}

/**
 * Nilai interval/threshold. Dalam konteks tenant hanya dari whatsapp_monitor_settings
 * tenant itu, bukan settings.json dan bukan default template tenant lain.
 */
function readScopedSetting(key, defaultValue) {
    try {
        const { hasTenantContext, getTenant } = require('./platform/tenantContext');
        if (hasTenantContext()) {
            const bag = getTenant()?.settings?.whatsapp_monitor_settings;
            const own = readOwn(bag, key);
            if (own !== undefined) return own;
            return defaultValue;
        }
    } catch (_) { /* ignore */ }
    const globalValue = getSetting(key, undefined);
    return globalValue !== undefined ? globalValue : defaultValue;
}

async function readMonitorFieldValues(tenantId, fields) {
    const tid = normalizeTenantId(tenantId);
    const values = {};
    if (!tid) {
        (fields || []).forEach((field) => {
            values[field.key] = getSetting(field.key, field.defaultValue);
        });
        return values;
    }
    const raw = await loadRawTenantSettings(tid);
    const bag = raw.whatsapp_monitor_settings && typeof raw.whatsapp_monitor_settings === 'object'
        ? raw.whatsapp_monitor_settings
        : {};
    (fields || []).forEach((field) => {
        const own = readOwn(bag, field.key);
        values[field.key] = own !== undefined ? own : field.defaultValue;
    });
    return values;
}

function coerceFieldValue(field, rawValue) {
    if (field.type === 'boolean') {
        return rawValue === true || rawValue === 'true' || rawValue === 'on' || rawValue === 1 || rawValue === '1';
    }
    return String(rawValue ?? '').trim();
}

async function writeMonitorFieldValues(tenantId, fields, incoming) {
    const tid = normalizeTenantId(tenantId);
    const src = incoming && typeof incoming === 'object' ? incoming : {};
    if (!tid) {
        (fields || []).forEach((field) => {
            if (!(field.key in src)) return;
            setSetting(field.key, coerceFieldValue(field, src[field.key]));
        });
        applyDerivedIntervals(null);
        return readMonitorFieldValues(null, fields);
    }

    const raw = await loadRawTenantSettings(tid);
    const bag = {
        ...(raw.whatsapp_monitor_settings && typeof raw.whatsapp_monitor_settings === 'object' ? raw.whatsapp_monitor_settings : {})
    };
    (fields || []).forEach((field) => {
        if (!(field.key in src)) return;
        bag[field.key] = coerceFieldValue(field, src[field.key]);
    });

    const prevPppoe = raw.pppoe_notifications && typeof raw.pppoe_notifications === 'object' ? raw.pppoe_notifications : {};
    const pppoePatch = { ...prevPppoe };
    if ('pppoe_notifications.includeOfflineList' in bag) {
        pppoePatch.includeOfflineList = bag['pppoe_notifications.includeOfflineList'];
    }
    if ('pppoe_notifications.maxOfflineListCount' in bag) {
        pppoePatch.maxOfflineListCount = bag['pppoe_notifications.maxOfflineListCount'];
    }
    const minutes = parseFloat(bag.pppoe_monitor_interval_minutes);
    if (Number.isFinite(minutes) && minutes > 0) {
        pppoePatch.monitorInterval = Math.round(minutes * 60 * 1000);
    }

    const patch = {
        whatsapp_monitor_settings: bag,
        pppoe_notifications: pppoePatch
    };
    const derived = derivedIntervalPatch(bag);
    Object.assign(patch, derived);

    const { saveFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
    await saveFullSettingsForTenantId(tid, patch);
    patchLiveTenantSettings(tid, patch);
    invalidateTenantMonitorCache(tid);
    return readMonitorFieldValues(tid, fields);
}

function derivedIntervalPatch(bag) {
    const rxWarnHours = parseInt(bag.rx_power_notification_interval_hours, 10);
    const rxRecapHours = parseInt(bag.rxpower_recap_interval_hours, 10);
    const offlineHours = parseInt(bag.offline_notification_interval_hours, 10);
    const patch = {};
    if (Number.isFinite(rxWarnHours) && rxWarnHours > 0) {
        patch.rx_power_warning_interval = String(rxWarnHours * 60 * 60 * 1000);
    }
    if (Number.isFinite(rxRecapHours) && rxRecapHours > 0) {
        patch.rxpower_recap_interval = String(rxRecapHours * 60 * 60 * 1000);
    }
    if (Number.isFinite(offlineHours) && offlineHours > 0) {
        patch.offline_notification_interval = String(offlineHours * 60 * 60 * 1000);
    }
    return patch;
}

function applyDerivedIntervals() {
    const rxWarnHours = parseInt(getSetting('rx_power_notification_interval_hours', '1'), 10);
    const rxRecapHours = parseInt(getSetting('rxpower_recap_interval_hours', '6'), 10);
    const offlineHours = parseInt(getSetting('offline_notification_interval_hours', '12'), 10);
    setSetting('rx_power_warning_interval', String(Math.max(rxWarnHours || 1, 1) * 60 * 60 * 1000));
    setSetting('rxpower_recap_interval', String(Math.max(rxRecapHours || 6, 1) * 60 * 60 * 1000));
    setSetting('offline_notification_interval', String(Math.max(offlineHours || 12, 1) * 60 * 60 * 1000));
}

/**
 * true jika tick ini boleh jalan untuk tenant tersebut.
 * intervalMs dihitung dari pengaturan tenant, bukan dari tenant lain.
 */
function claimTenantMonitorRun(tenantId, monitorId, intervalMs) {
    const tid = normalizeTenantId(tenantId) || 0;
    const wait = Number(intervalMs);
    const gap = Number.isFinite(wait) && wait > 0 ? wait : 60000;
    const key = `${tid}:${monitorId}`;
    const now = Date.now();
    const prev = lastRunAt.get(key) || 0;
    if (prev && (now - prev) < gap) return false;
    lastRunAt.set(key, now);
    return true;
}

/**
 * Jalankan fn di dalam runWithTenant untuk setiap tenant yang menyalakan monitor.
 * Tenant yang mematikan toggle tidak ikut, dan tidak memakai nilai tenant lain.
 */
async function runForEnabledTenants(monitorId, fn) {
    const tenantStore = require('./platform/tenantStore');
    const tenants = await tenantStore.listTenants({ operationalOnly: true });
    if (!tenants || !tenants.length) {
        if (await isWaSystemMonitorEnabled(monitorId, null)) await fn(null);
        return;
    }
    const { forEachOperationalTenant } = require('./platform/tenantJobs');
    await forEachOperationalTenant(async (tenant) => {
        if (!(await isWaSystemMonitorEnabled(monitorId, tenant.id))) return;
        await fn(tenant);
    }, { label: `wa-mon:${monitorId}` });
}

module.exports = {
    MONITOR_DEFINITIONS,
    getMergedMonitors,
    getMergedMonitorsForTenant,
    isWaSystemMonitorEnabled,
    setMonitorsPartial,
    setMonitorsPartialForTenant,
    syncLegacyBooleanSettings,
    readScopedSetting,
    readMonitorFieldValues,
    writeMonitorFieldValues,
    claimTenantMonitorRun,
    runForEnabledTenants,
    invalidateTenantMonitorCache,
    mergeMonitorsFromRaw
};
