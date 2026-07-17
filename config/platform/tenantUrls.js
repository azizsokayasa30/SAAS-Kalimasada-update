'use strict';

const DEFAULT_BASE_DOMAIN = 'kalimasada-app.com';

function getTenantBaseDomain() {
    const raw = process.env.KALIMASADA_BASE_DOMAIN || DEFAULT_BASE_DOMAIN;
    return String(raw).toLowerCase().replace(/^\.+/, '').trim();
}

function getTenantAppScheme() {
    try {
        const nginxManager = require('./nginxManager');
        const cfg = nginxManager.loadConfig();
        if (cfg.ssl_enabled) return 'https';
        if (cfg.ssl_enabled === false) return 'http';
    } catch (_) { /* ignore */ }
    const scheme = (process.env.KALIMASADA_APP_SCHEME || process.env.PUBLIC_APP_SCHEME || 'http')
        .toLowerCase()
        .replace(/:?\/?$/, '');
    return scheme === 'https' ? 'https' : 'http';
}

function getTenantHostname(subdomain) {
    const sub = String(subdomain || '').toLowerCase().trim();
    return `${sub}.${getTenantBaseDomain()}`;
}

function getTenantLoginUrl(subdomain) {
    return `${getTenantAppScheme()}://${getTenantHostname(subdomain)}/login`;
}

/** Portal pelanggan (customer-app) per subdomain tenant. */
function getCustomerPortalLoginUrl(subdomain) {
    return `${getTenantAppScheme()}://${getTenantHostname(subdomain)}/customer-app/login`;
}

function getDevTenantLoginUrl(subdomain) {
    try {
        const { getPublicAppBaseUrl } = require('../public-endpoint');
        const publicBase = (getPublicAppBaseUrl() || '').replace(/\/$/, '');
        if (publicBase) {
            return `${publicBase}/login?tenant=${encodeURIComponent(subdomain)}`;
        }
    } catch (_) { /* ignore */ }
    const port = process.env.PORT || '4555';
    return `http://127.0.0.1:${port}/login?tenant=${encodeURIComponent(subdomain)}`;
}

module.exports = {
    DEFAULT_BASE_DOMAIN,
    getTenantBaseDomain,
    getTenantAppScheme,
    getTenantHostname,
    getTenantLoginUrl,
    getCustomerPortalLoginUrl,
    getDevTenantLoginUrl,
};
