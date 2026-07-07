'use strict';

const tenantStore = require('../config/platform/tenantStore');
const { runWithTenant, runAsCentral } = require('../config/platform/tenantContext');
const { mergeSettings, loadMinimalTenantDefaults } = require('../config/platform/tenantSettingsManager');

const enrichedSettingsCache = new Map();
const ENRICHED_SETTINGS_TTL_MS = 60 * 1000;

function enrichTenantSettings(tenant) {
    if (!tenant) return tenant;
    const cacheKey = String(tenant.id);
    const hit = enrichedSettingsCache.get(cacheKey);
    if (hit && (Date.now() - hit.ts) < ENRICHED_SETTINGS_TTL_MS) {
        tenant.settings = hit.settings;
        return tenant;
    }
    const merged = mergeSettings(loadMinimalTenantDefaults(), tenant.settings || {});
    tenant.settings = merged;
    enrichedSettingsCache.set(cacheKey, { settings: merged, ts: Date.now() });
    return tenant;
}

const { getTenantBaseDomain } = require('../config/platform/tenantUrls');
const BASE_DOMAIN = getTenantBaseDomain();
const CENTRAL_PREFIX = process.env.KALIMASADA_CENTRAL_SUBDOMAIN || 'manage';

const SKIP_PREFIXES = [
    '/management',
    '/health',
    '/payment',
    '/voucher',
    '/api/public',
    '/public',
    '/vendor',
    '/img',
];

function normalizeHost(host) {
    return String(host || '').toLowerCase().split(':')[0];
}

function extractSubdomain(host) {
    const h = normalizeHost(host);
    if (!BASE_DOMAIN) return null;
    const base = BASE_DOMAIN.toLowerCase();
    if (h === base) return null;
    const suffix = `.${base}`;
    if (!h.endsWith(suffix)) return null;
    const sub = h.slice(0, -suffix.length);
    if (!sub || sub.includes('.')) return null;
    return sub;
}

function isCentralHost(host) {
    const sub = extractSubdomain(host);
    if (sub === CENTRAL_PREFIX) return true;
    const h = normalizeHost(host);
    return h === 'manage.localhost' || h.startsWith('manage.');
}

function shouldSkipTenant(pathname) {
    return SKIP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isIpAddress(host) {
    const h = normalizeHost(host);
    if (!h) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
    if (h.includes(':')) return true;
    return false;
}

/** Akses tanpa subdomain resmi (IP LAN, localhost, atau hostname lokal). */
function isDirectHostAccess(host) {
    const h = normalizeHost(host);
    if (!h) return false;
    if (h === 'localhost' || h === '127.0.0.1' || isIpAddress(h)) return true;
    const base = (BASE_DOMAIN || '').toLowerCase();
    if (base && (h === base || h.endsWith(`.${base}`))) return false;
    if (h === CENTRAL_PREFIX || h.startsWith(`${CENTRAL_PREFIX}.`)) return false;
    return !h.includes('.');
}

function getDefaultTenantSubdomain() {
    return String(
        process.env.KALIMASADA_DEFAULT_TENANT
        || process.env.KALIMASADA_IP_DEFAULT_TENANT
        || 'default'
    ).toLowerCase().trim();
}

async function resolveTenantForDirectHost(req, headerTenant) {
    const slug = String(
        headerTenant
        || req.query?.tenant
        || req.session?.tenantSubdomain
        || getDefaultTenantSubdomain()
    ).toLowerCase().trim();
    if (!slug) return null;
    return tenantStore.getTenantBySubdomain(slug);
}

function resolveTenantMiddleware(req, res, next) {
    if (shouldSkipTenant(req.path)) {
        if (req.path.startsWith('/management') || req.path.startsWith('/platform')) {
            return runAsCentral(() => next());
        }
        return next();
    }

    if (isCentralHost(req.get('host'))) {
        return runAsCentral(() => next());
    }

    const run = async () => {
        let tenant = null;

        const headerTenant = req.get('X-Tenant')
            || req.query.tenant
            || (req.body && req.body.tenant);
        if (headerTenant) {
            tenant = await tenantStore.getTenantBySubdomain(String(headerTenant).toLowerCase());
        }

        if (!tenant) {
            const sub = extractSubdomain(req.get('host'));
            if (sub && sub !== CENTRAL_PREFIX) {
                tenant = await tenantStore.getTenantBySubdomain(sub);
            }
        }

        // IP LAN / localhost: ?tenant= / X-Tenant lebih dulu dari sesi (hindari tab tenant berbeda pakai sesi lama)
        if (!tenant && isDirectHostAccess(req.get('host'))) {
            tenant = await resolveTenantForDirectHost(req, headerTenant);
        }

        // Sesi admin tenant (setelah login via ?tenant=slug) — fallback bila host tidak membawa slug
        if (!tenant && req.session?.tenantSubdomain) {
            tenant = await tenantStore.getTenantBySubdomain(req.session.tenantSubdomain);
        }
        if (!tenant && req.session?.tenantId) {
            tenant = await tenantStore.getTenantById(req.session.tenantId);
        }

        // Fallback legacy single-tenant hanya untuk request tanpa sesi tenant
        if (!tenant && !req.path.startsWith('/login') && !req.session?.tenantId) {
            tenant = await tenantStore.getTenantById(1);
        }

        if (!tenant) {
            if (req.path.startsWith('/login')) {
                return next();
            }
            return res.status(404).render('platform/errors/tenant-not-found', {
                title: 'Tenant Tidak Ditemukan',
            });
        }

        enrichTenantSettings(tenant);
        req.tenant = tenant;
        req.tenantId = tenant.id;

        if (tenant.status === 'suspended' && !req.path.startsWith('/login')) {
            return res.status(403).render('platform/errors/tenant-suspended', {
                title: 'Tenant Disuspend',
                tenant,
            });
        }

        if (tenant.status !== 'active' && tenant.status !== 'suspended' && !req.path.startsWith('/login')) {
            return res.status(503).render('platform/errors/tenant-unavailable', {
                title: 'Tenant Tidak Tersedia',
                tenant,
            });
        }

        return runWithTenant(tenant, () => next());
    };

    run().catch(next);
}

module.exports = {
    resolveTenantMiddleware,
    isCentralHost,
    extractSubdomain,
    isDirectHostAccess,
    isIpAddress,
    getDefaultTenantSubdomain,
};
