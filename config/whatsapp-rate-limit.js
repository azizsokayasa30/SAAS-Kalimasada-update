'use strict';

/**
 * Rate limit WhatsApp per tenant.
 * Jangan simpan di settings.json global: broadcast menulis ulang file itu
 * dan pengaturan tenant lain saling menimpa.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
    maxMessagesPerBatch: 10,
    delayBetweenBatches: 30,
    delayBetweenMessages: 2,
    maxRetries: 2,
    dailyMessageLimit: 0,
    enabled: true
};

const USAGE_PATH = path.join(__dirname, '../data/wa-daily-usage.json');
const DOTTED_KEYS = [
    'whatsapp_rate_limit.maxMessagesPerBatch',
    'whatsapp_rate_limit.delayBetweenBatches',
    'whatsapp_rate_limit.delayBetweenMessages',
    'whatsapp_rate_limit.maxRetries',
    'whatsapp_rate_limit.dailyMessageLimit',
    'whatsapp_rate_limit.enabled'
];

let usageCache = null;
let usageChain = Promise.resolve();

function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function normalizeTenantId(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function parseEnabled(value, fallback) {
    if (value === true || value === 'true' || value === 1 || value === '1') return true;
    if (value === false || value === 'false' || value === 0 || value === '0') return false;
    return fallback;
}

function normalizeRateLimit(input) {
    const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return {
        maxMessagesPerBatch: clampInt(src.maxMessagesPerBatch, 1, 100, DEFAULTS.maxMessagesPerBatch),
        delayBetweenBatches: clampInt(src.delayBetweenBatches, 1, 300, DEFAULTS.delayBetweenBatches),
        delayBetweenMessages: clampInt(src.delayBetweenMessages, 0, 10, DEFAULTS.delayBetweenMessages),
        maxRetries: clampInt(src.maxRetries, 0, 5, DEFAULTS.maxRetries),
        dailyMessageLimit: clampInt(src.dailyMessageLimit, 0, 1000, DEFAULTS.dailyMessageLimit),
        enabled: parseEnabled(src.enabled, DEFAULTS.enabled)
    };
}

function fromSettingsObject(settings) {
    const src = settings && typeof settings === 'object' ? settings : {};
    const nested = src.whatsapp_rate_limit;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        return normalizeRateLimit(nested);
    }
    return normalizeRateLimit({
        maxMessagesPerBatch: src['whatsapp_rate_limit.maxMessagesPerBatch'],
        delayBetweenBatches: src['whatsapp_rate_limit.delayBetweenBatches'],
        delayBetweenMessages: src['whatsapp_rate_limit.delayBetweenMessages'],
        maxRetries: src['whatsapp_rate_limit.maxRetries'],
        dailyMessageLimit: src['whatsapp_rate_limit.dailyMessageLimit'],
        enabled: src['whatsapp_rate_limit.enabled']
    });
}

function todayJakarta() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date());
    const pick = (type) => (parts.find((p) => p.type === type) || {}).value || '00';
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function usageKey(tenantId) {
    const tid = normalizeTenantId(tenantId);
    return `${tid ? `t${tid}` : 'global'}:${todayJakarta()}`;
}

function loadUsage() {
    if (usageCache) return usageCache;
    try {
        const raw = fs.readFileSync(USAGE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        usageCache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        usageCache = {};
    }
    return usageCache;
}

function pruneUsage(data) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 21);
    const cutoffKey = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(cutoff);
    Object.keys(data).forEach((key) => {
        const day = String(key).split(':').pop();
        if (day && day < cutoffKey) delete data[key];
    });
}

function withUsage(fn) {
    const run = usageChain.then(fn, fn);
    usageChain = run.then(() => {}, () => {});
    return run;
}

function persistUsage(data) {
    fs.mkdirSync(path.dirname(USAGE_PATH), { recursive: true });
    const tmp = `${USAGE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, USAGE_PATH);
    usageCache = data;
}

async function getDailyUsed(tenantId) {
    return withUsage(async () => {
        const data = loadUsage();
        return Number(data[usageKey(tenantId)] || 0);
    });
}

async function incrementDailyUsed(tenantId) {
    return withUsage(async () => {
        const data = loadUsage();
        const key = usageKey(tenantId);
        data[key] = Number(data[key] || 0) + 1;
        pruneUsage(data);
        persistUsage(data);
        return data[key];
    });
}

async function getRateLimit(tenantId) {
    const tid = normalizeTenantId(tenantId);
    if (tid) {
        const { getFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
        const settings = await getFullSettingsForTenantId(tid);
        return fromSettingsObject(settings);
    }
    const { getSetting } = require('./settingsManager');
    const nested = getSetting('whatsapp_rate_limit', null);
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        return normalizeRateLimit(nested);
    }
    return normalizeRateLimit({
        maxMessagesPerBatch: getSetting('whatsapp_rate_limit.maxMessagesPerBatch', DEFAULTS.maxMessagesPerBatch),
        delayBetweenBatches: getSetting('whatsapp_rate_limit.delayBetweenBatches', DEFAULTS.delayBetweenBatches),
        delayBetweenMessages: getSetting('whatsapp_rate_limit.delayBetweenMessages', DEFAULTS.delayBetweenMessages),
        maxRetries: getSetting('whatsapp_rate_limit.maxRetries', DEFAULTS.maxRetries),
        dailyMessageLimit: getSetting('whatsapp_rate_limit.dailyMessageLimit', DEFAULTS.dailyMessageLimit),
        enabled: getSetting('whatsapp_rate_limit.enabled', DEFAULTS.enabled)
    });
}

async function saveRateLimit(tenantId, input) {
    const parsed = normalizeRateLimit(input);
    const tid = normalizeTenantId(tenantId);
    if (tid) {
        const { saveFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
        await saveFullSettingsForTenantId(tid, { whatsapp_rate_limit: parsed });
        return parsed;
    }

    const { setSettings } = require('./settingsManager');
    const patch = { whatsapp_rate_limit: parsed };
    DOTTED_KEYS.forEach((key) => {
        const field = key.split('.').pop();
        patch[key] = parsed[field];
    });
    if (!setSettings(patch)) {
        throw new Error('Gagal menyimpan rate limit');
    }
    return parsed;
}

function tenantIdFromRequest(req) {
    return normalizeTenantId(req?.session?.tenantId || req?.tenantId || req?.tenant?.id);
}

module.exports = {
    DEFAULTS,
    normalizeRateLimit,
    fromSettingsObject,
    getRateLimit,
    saveRateLimit,
    getDailyUsed,
    incrementDailyUsed,
    tenantIdFromRequest,
    todayJakarta
};
