'use strict';

/**
 * Nama company untuk branding WhatsApp / UI.
 * Jangan pakai nama tenant (subdomain) — yang ditampilkan adalah nama perusahaan.
 */
const DEFAULT_COMPANY_HEADER = 'PT. KALIMASADA INTI SARANA';

const STALE_PLATFORM_HEADERS = [
    'PT. KALIMASADA INTI SARANA',
    'PT KALIMASADA INTI SARANA',
    'KALIMASADA INTI SARANA',
    'Kalimasada Inti Sarana',
    'Kalimasada Billing',
    'CV Lintas Multimedia',
    'JINOM-HOMENET',
    'GEMBOK-BILLING',
    'SISTEM BILLING',
    'ISP Monitor',
    'ISP Test'
];

const PLACEHOLDER_HEADERS = new Set([
    'CV LINTAS MULTIMEDIA',
    'JINOM HOMENET',
    'GEMBOK BILLING',
    'KALIMASADA BILLING',
    'SISTEM BILLING',
    'ISP MONITOR',
    'ISP TEST',
    'KALIMASADA',
    'GEMBOK'
]);

function normalizeCompanyName(value) {
    if (value == null) return '';
    return String(value)
        .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function compactName(name) {
    return normalizeCompanyName(name).replace(/[.]/g, '').replace(/\s+/g, ' ').toUpperCase();
}

function isKalimasadaBrand(name) {
    return compactName(name).includes('KALIMASADA INTI SARANA');
}

function isTenantLabel(name, tenant = null) {
    const n = compactName(name);
    if (!n) return false;
    const labels = [tenant?.name, tenant?.subdomain, tenant?.slug]
        .map(compactName)
        .filter(Boolean);
    return labels.includes(n);
}

function isPlaceholderHeader(name) {
    return PLACEHOLDER_HEADERS.has(compactName(name));
}

function isUsableCompanyHeader(name, tenant = null) {
    const n = normalizeCompanyName(name);
    if (!n) return false;
    if (isTenantLabel(n, tenant)) return false;
    if (isPlaceholderHeader(n)) return false;
    return true;
}

function finalizeCompanyHeader(name) {
    const n = normalizeCompanyName(name);
    if (!n) return DEFAULT_COMPANY_HEADER;
    if (isKalimasadaBrand(n)) return DEFAULT_COMPANY_HEADER;
    return n;
}

/**
 * Nama company untuk pesan WhatsApp: company_header / company_name.
 * Tidak pernah memakai nama tenant.
 */
function pickCompanyHeaderFromSettings(settings = {}, tenant = null, fromGlobalFallback = false) {
    const candidates = [
        settings.company_header,
        settings.company_name,
        settings.app_name
    ]
        .map(normalizeCompanyName)
        .filter((value) => isUsableCompanyHeader(value, tenant));

    if (!candidates.length) {
        if (fromGlobalFallback) return DEFAULT_COMPANY_HEADER;
        try {
            const { getSetting } = require('./settingsManager');
            return pickCompanyHeaderFromSettings({
                company_header: getSetting('company_header', DEFAULT_COMPANY_HEADER),
                company_name: getSetting('company_name', ''),
                app_name: getSetting('app_name', '')
            }, null, true);
        } catch (_) {
            return DEFAULT_COMPANY_HEADER;
        }
    }

    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
        const current = candidates[i];
        if (current.toLowerCase().includes(best.toLowerCase()) && current.length > best.length) {
            best = current;
        }
    }
    return finalizeCompanyHeader(best);
}

function getCompanyHeaderSync(defaultHeader = DEFAULT_COMPANY_HEADER) {
    try {
        const { hasTenantContext, getTenant } = require('./platform/tenantContext');
        if (hasTenantContext()) {
            const tenant = getTenant();
            const name = pickCompanyHeaderFromSettings(tenant?.settings || {}, tenant);
            if (name) return name;
        }
    } catch (_) { /* no tenant context */ }

    try {
        const { getSettingsWithCache } = require('./settingsManager');
        return pickCompanyHeaderFromSettings(getSettingsWithCache() || {}) || defaultHeader;
    } catch (_) {
        return defaultHeader;
    }
}

function getFooterInfoSync(defaultFooter = 'Terima kasih') {
    try {
        const { hasTenantContext, getTenant } = require('./platform/tenantContext');
        if (hasTenantContext()) {
            const tenant = getTenant();
            const footer = tenant?.settings?.footer_info;
            if (footer != null && String(footer).trim()) return String(footer).trim();
        }
    } catch (_) { /* no tenant context */ }

    try {
        const { getSetting } = require('./settingsManager');
        return getSetting('footer_info', defaultFooter);
    } catch (_) {
        return defaultFooter;
    }
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeWhatsAppTemplateCompanyHeader(template) {
    let text = String(template == null ? '' : template);
    if (!text) return text;
    for (const stale of STALE_PLATFORM_HEADERS) {
        const re = new RegExp(`\\*?${escapeRegExp(stale)}\\*?`, 'gi');
        text = text.replace(re, '{company_header}');
    }
    return text;
}

module.exports = {
    DEFAULT_COMPANY_HEADER,
    STALE_PLATFORM_HEADERS,
    normalizeCompanyName,
    isTenantLabel,
    isUsableCompanyHeader,
    pickCompanyHeaderFromSettings,
    getCompanyHeaderSync,
    getFooterInfoSync,
    sanitizeWhatsAppTemplateCompanyHeader
};
