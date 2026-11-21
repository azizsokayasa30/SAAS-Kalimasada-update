'use strict';

const fs = require('fs');
const path = require('path');
const tenantStore = require('./tenantStore');
const { DEFAULT_CONFIG, applyDefaults } = require('../paymentGatewayConfig');

const DEFAULT_COMPANY = {
    company_name: 'PT. KALIMASADA INTI SARANA',
    company_header: 'PT. KALIMASADA INTI SARANA',
    company_slogan: 'Solusi Internet Terdepan',
    company_website: 'kalimasada.id',
    company_address: 'Banjarnegara',
    contact_phone: '0816411615',
    contact_email: 'kalimasadaskynet@gmail.com',
    contact_whatsapp: '0816411615',
    footer_info: 'Portal Management Billing Kalimasada',
    logo_path: '/img/logo.png',
};

async function ensurePlatformSettingsSchema() {
    const migrationPath = path.join(__dirname, '../../migrations/add_platform_settings.sql');
    if (!fs.existsSync(migrationPath)) return;
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
        try {
            await tenantStore.dbRun(stmt);
        } catch (err) {
            const msg = String(err.message || '').toLowerCase();
            if (!msg.includes('already exists')) {
                console.warn('[platformSettings] migration warn:', err.message);
            }
        }
    }
}

async function getSetting(key) {
    const row = await tenantStore.dbGet('SELECT value FROM platform_settings WHERE key = ?', [key]);
    if (!row) return null;
    try {
        return JSON.parse(row.value);
    } catch (_) {
        return row.value;
    }
}

async function setSetting(key, value) {
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    await tenantStore.dbRun(
        `INSERT INTO platform_settings (key, value, updated_at)
         VALUES (?, ?, datetime('now','localtime'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, json]
    );
}

async function getCompanyProfile() {
    const stored = await getSetting('company_profile');
    return { ...DEFAULT_COMPANY, ...(stored && typeof stored === 'object' ? stored : {}) };
}

async function saveCompanyProfile(data) {
    const profile = {
        company_name: String(data.company_name || '').trim(),
        company_header: String(data.company_header || '').trim(),
        company_slogan: String(data.company_slogan || '').trim(),
        company_website: String(data.company_website || '').trim(),
        company_address: String(data.company_address || '').trim(),
        contact_phone: String(data.contact_phone || '').trim(),
        contact_email: String(data.contact_email || '').trim(),
        contact_whatsapp: String(data.contact_whatsapp || '').trim(),
        footer_info: String(data.footer_info || '').trim(),
        logo_path: String(data.logo_path || DEFAULT_COMPANY.logo_path).trim() || DEFAULT_COMPANY.logo_path,
    };
    if (!profile.company_name) throw new Error('Nama perusahaan wajib diisi.');
    await setSetting('company_profile', profile);
    return profile;
}

const GATEWAY_KEYS = ['midtrans', 'xendit', 'tripay', 'duitku'];
const GATEWAY_REQUIRED = {
    midtrans: ['server_key', 'client_key'],
    xendit: ['api_key'],
    tripay: ['api_key', 'private_key', 'merchant_code'],
    duitku: ['merchant_code', 'api_key'],
};

function isGatewayReady(key, cfg = {}) {
    if (!cfg || !cfg.enabled) return false;
    const required = GATEWAY_REQUIRED[key] || [];
    return required.every((field) => String(cfg[field] || '').trim());
}

function pickReadyGateway(config, preferred) {
    if (preferred && GATEWAY_KEYS.includes(preferred) && isGatewayReady(preferred, config[preferred])) {
        return preferred;
    }
    const ready = GATEWAY_KEYS.find((key) => isGatewayReady(key, config[key]));
    return ready || preferred || config.active || 'midtrans';
}

async function getPlatformPaymentGateway() {
    const stored = await getSetting('payment_gateway');
    return applyDefaults(stored && typeof stored === 'object' ? stored : DEFAULT_CONFIG);
}

async function persistPlatformPaymentGateway(next) {
    await setSetting('payment_gateway', next);
    const { syncPlatformToAppSettings, reloadRuntimePaymentGateway } = require('./paymentGatewaySync');
    await syncPlatformToAppSettings(next);
    await reloadRuntimePaymentGateway();
    return next;
}

/** Perbaiki active yang macet (mis. Midtrans default) bila ada gateway lain yang sudah siap. */
async function healPlatformPaymentGatewayActive() {
    const current = await getPlatformPaymentGateway();
    if (isGatewayReady(current.active, current[current.active])) return { healed: false, payment: current };

    const ready = pickReadyGateway(current, null);
    if (!ready || ready === current.active || !isGatewayReady(ready, current[ready])) {
        return { healed: false, payment: current };
    }

    const next = { ...current, active: ready };
    await persistPlatformPaymentGateway(next);
    return { healed: true, payment: next, from: current.active, to: ready };
}

async function savePlatformPaymentGateway(data) {
    const current = await getPlatformPaymentGateway();
    const requestedActive = GATEWAY_KEYS.includes(data.active) ? data.active : current.active;
    const next = { ...current, active: requestedActive };

    for (const gw of GATEWAY_KEYS) {
        if (!data[gw]) continue;
        const raw = data[gw];
        next[gw] = {
            ...current[gw],
            enabled: ['1', 'true', 'on', 'yes'].includes(String(raw.enabled || '').toLowerCase()),
            production: ['1', 'true', 'on', 'yes'].includes(String(raw.production || '').toLowerCase()),
        };
        Object.keys(current[gw] || {}).forEach((k) => {
            if (k === 'enabled' || k === 'production') return;
            if (raw[k] !== undefined) next[gw][k] = String(raw[k] ?? '').trim();
        });
    }

    // Jika gateway utama belum siap tapi ada gateway lain yang siap, otomatis pindahkan.
    // Mencegah Midtrans (default) tetap "utama" saat user hanya mengaktifkan Duitku/dll.
    if (!isGatewayReady(next.active, next[next.active])) {
        next.active = pickReadyGateway(next, requestedActive);
    }

    return persistPlatformPaymentGateway(next);
}

module.exports = {
    ensurePlatformSettingsSchema,
    getSetting,
    setSetting,
    getCompanyProfile,
    saveCompanyProfile,
    getPlatformPaymentGateway,
    savePlatformPaymentGateway,
    healPlatformPaymentGatewayActive,
    isGatewayReady,
    GATEWAY_KEYS,
    DEFAULT_COMPANY,
};
