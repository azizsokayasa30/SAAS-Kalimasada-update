'use strict';

const fs = require('fs');
const path = require('path');
const tenantStore = require('./tenantStore');
const { loadMinimalTenantDefaults } = require('./tenantMinimalDefaults');

const TEMPLATE_PATH = path.join(__dirname, '../../settings.server.template.json');

let templateCache = null;

function loadTemplateDefaults() {
    if (templateCache) return { ...templateCache };
    try {
        if (fs.existsSync(TEMPLATE_PATH)) {
            templateCache = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
            return { ...templateCache };
        }
    } catch (e) {
        console.warn('[tenantSettings] template load failed:', e.message);
    }
    templateCache = {};
    return {};
}

function mergeSettings(defaults, overrides) {
    const base = { ...defaults };
    if (!overrides || typeof overrides !== 'object') return base;
    Object.keys(overrides).forEach((key) => {
        const val = overrides[key];
        if (val !== null && typeof val === 'object' && !Array.isArray(val)
            && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
            base[key] = { ...base[key], ...val };
        } else if (val !== undefined) {
            base[key] = val;
        }
    });
    return base;
}

function buildTenantOverrides(tenant) {
    const { DEFAULT_COMPANY_HEADER } = require('../companyBranding');
    return {
        company_header: DEFAULT_COMPANY_HEADER,
        company_name: DEFAULT_COMPANY_HEADER,
        app_name: DEFAULT_COMPANY_HEADER,
        contact_phone: tenant.owner_phone,
        contact_whatsapp: tenant.owner_phone,
        footer_info: `© ${new Date().getFullYear()} ${DEFAULT_COMPANY_HEADER}`,
        admin_username: tenant.settings?.admin_username || 'admin',
        admin_password: tenant.settings?.admin_password,
    };
}

async function getFullSettingsForTenantId(tenantId) {
    const tenant = await tenantStore.getTenantById(tenantId);
    if (!tenant) return loadMinimalTenantDefaults();
    const merged = mergeSettings(loadMinimalTenantDefaults(), {
        ...buildTenantOverrides(tenant),
        ...(tenant.settings || {}),
    });
    try {
        const { pickCompanyHeaderFromSettings } = require('../companyBranding');
        merged.company_header = pickCompanyHeaderFromSettings(merged, tenant);
        if (!merged.company_name) merged.company_name = merged.company_header;
    } catch (_) { /* keep merged as-is */ }
    return merged;
}

async function saveFullSettingsForTenantId(tenantId, updates) {
    const tenant = await tenantStore.getTenantById(tenantId);
    if (!tenant) throw new Error('Tenant tidak ditemukan');

    const current = mergeSettings(loadMinimalTenantDefaults(), tenant.settings || {});
    const merged = mergeSettings(current, updates);

    // Simpan hanya key yang berbeda dari template + kredensial admin (hemat kolom JSON)
    const toStore = { ...(tenant.settings || {}) };
    Object.keys(merged).forEach((key) => {
        toStore[key] = merged[key];
    });
    if (toStore.admin_password === undefined && tenant.settings?.admin_password) {
        toStore.admin_password = tenant.settings.admin_password;
    }
    if (toStore.admin_username === undefined) {
        toStore.admin_username = merged.admin_username || 'admin';
    }

    await tenantStore.updateTenantSettings(tenantId, toStore);
    try {
        const { invalidateEnrichedSettingsCache } = require('../../middleware/resolveTenant');
        invalidateEnrichedSettingsCache(tenantId);
    } catch (_) {}
    return merged;
}

function seedSettingsForNewTenant(tenant) {
    const adminUsername = tenant.settings?.admin_username
        || tenant.admin_username
        || 'admin';
    const adminPassword = tenant.settings?.admin_password
        || tenant.admin_password;
    const { DEFAULT_COMPANY_HEADER } = require('../companyBranding');
    return {
        company_header: DEFAULT_COMPANY_HEADER,
        company_name: DEFAULT_COMPANY_HEADER,
        app_name: DEFAULT_COMPANY_HEADER,
        contact_phone: tenant.owner_phone || '',
        contact_whatsapp: tenant.owner_phone || '',
        footer_info: `© ${new Date().getFullYear()} ${DEFAULT_COMPANY_HEADER}`,
        admin_username: adminUsername,
        admin_password: adminPassword,
        timezone: 'Asia/Jakarta',
        user_auth_mode: 'radius',
        server_port: String(process.env.PORT || '3003'),
    };
}

/** Reset pengaturan tenant ke seed awal (branding + kredensial admin saja). */
async function resetTenantSettingsToSeed(tenantId) {
    const tenant = await tenantStore.getTenantById(tenantId);
    if (!tenant) throw new Error('Tenant tidak ditemukan.');
    const seeded = seedSettingsForNewTenant(tenant);
    await tenantStore.updateTenantSettings(tenantId, seeded);
    return seeded;
}

module.exports = {
    loadTemplateDefaults,
    loadMinimalTenantDefaults,
    mergeSettings,
    getFullSettingsForTenantId,
    saveFullSettingsForTenantId,
    seedSettingsForNewTenant,
    resetTenantSettingsToSeed,
    buildTenantOverrides,
};
