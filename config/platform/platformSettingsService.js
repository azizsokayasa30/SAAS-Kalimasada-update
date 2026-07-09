'use strict';

const fs = require('fs');
const path = require('path');
const tenantStore = require('./tenantStore');
const { DEFAULT_CONFIG, applyDefaults } = require('../paymentGatewayConfig');

const DEFAULT_COMPANY = {
    company_name: 'PT. KALIMASADA INTI SARANA',
    company_header: 'KALIMASADA INTI SARANA',
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

async function getPlatformPaymentGateway() {
    const stored = await getSetting('payment_gateway');
    return applyDefaults(stored && typeof stored === 'object' ? stored : DEFAULT_CONFIG);
}

async function savePlatformPaymentGateway(data) {
    const current = await getPlatformPaymentGateway();
    const active = data.active || current.active;
    const gateways = ['midtrans', 'xendit', 'tripay', 'duitku'];
    const next = { active, ...current };

    for (const gw of gateways) {
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

    await setSetting('payment_gateway', next);

    const { syncPlatformToAppSettings, reloadRuntimePaymentGateway } = require('./paymentGatewaySync');
    await syncPlatformToAppSettings(next);
    await reloadRuntimePaymentGateway();

    return next;
}

module.exports = {
    ensurePlatformSettingsSchema,
    getCompanyProfile,
    saveCompanyProfile,
    getPlatformPaymentGateway,
    savePlatformPaymentGateway,
    DEFAULT_COMPANY,
};
