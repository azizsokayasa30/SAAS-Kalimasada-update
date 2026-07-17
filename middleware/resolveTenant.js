'use strict';

const tenantStore = require('../config/platform/tenantStore');
const { runWithTenant, runAsCentral } = require('../config/platform/tenantContext');
const { mergeSettings, loadMinimalTenantDefaults } = require('../config/platform/tenantSettingsManager');

const enrichedSettingsCache = new Map();
const ENRICHED_SETTINGS_TTL_MS = 60 * 1000;

function invalidateEnrichedSettingsCache(tenantId = null) {
    if (tenantId == null) {
        enrichedSettingsCache.clear();
        return;
    }
    enrichedSettingsCache.delete(String(tenantId));
}

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
const CENTRAL_PREFIX = process.env.KALIMASADA_CENTRAL_SUBDOMAIN || 'manage';
const MOBILE_API_PREFIX = process.env.KALIMASADA_MOBILE_API_SUBDOMAIN || 'mobile';

const SKIP_PREFIXES = [
    '/management',
    '/health',
    '/payment',
    '/voucher',
    '/api/public',
    '/public',
    '/vendor',
    '/img',
    '/css',
    '/js',
    '/fonts',
    '/customer-app',
    '/field-completion',
    '/mobile-app',
];

/** Path di host mobile yang boleh tanpa X-Tenant. */
const MOBILE_PUBLIC_PREFIXES = [
    '/api/public',
    '/api/mobile-adapter/app-update/manifest',
    '/api/mobile-adapter/health',
    '/health',
    '/mobile-app',
    '/img',
    '/vendor',
    '/css',
    '/js',
    '/fonts',
    '/public',
];

function normalizeHost(host) {
    return String(host || '').toLowerCase().split(':')[0];
}

function extractSubdomain(host) {
    const h = normalizeHost(host);
    const base = getTenantBaseDomain();
    if (!base) return null;
    const baseLower = base.toLowerCase();
    if (h === baseLower) return null;
    const suffix = `.${baseLower}`;
    if (!h.endsWith(suffix)) return null;
    const sub = h.slice(0, -suffix.length);
    if (!sub || sub.includes('.')) return null;
    return sub;
}

function getMobileApiSubdomain() {
    return String(process.env.KALIMASADA_MOBILE_API_SUBDOMAIN || MOBILE_API_PREFIX)
        .toLowerCase()
        .trim() || 'mobile';
}

function isCentralHost(host) {
    const central = String(process.env.KALIMASADA_CENTRAL_SUBDOMAIN || CENTRAL_PREFIX).toLowerCase().trim();
    const sub = extractSubdomain(host);
    if (sub === central) return true;
    const h = normalizeHost(host);
    return h === 'manage.localhost' || h.startsWith('manage.');
}

function isMobileApiHost(host) {
    const mobile = getMobileApiSubdomain();
    const sub = extractSubdomain(host);
    if (sub === mobile) return true;
    const h = normalizeHost(host);
    return h === `${mobile}.localhost` || h.startsWith(`${mobile}.`);
}

function shouldSkipTenant(pathname) {
    return SKIP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isMobilePublicPath(pathname) {
    return MOBILE_PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
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
    const base = getTenantBaseDomain().toLowerCase();
    if (base && (h === base || h.endsWith(`.${base}`))) return false;
    if (h === CENTRAL_PREFIX || h.startsWith(`${CENTRAL_PREFIX}.`)) return false;
    const mobile = getMobileApiSubdomain();
    if (h === mobile || h.startsWith(`${mobile}.`)) return false;
    return !h.includes('.');
}

function getDefaultTenantSubdomain() {
    return String(
        process.env.KALIMASADA_DEFAULT_TENANT
        || process.env.KALIMASADA_IP_DEFAULT_TENANT
        || ''
    ).toLowerCase().trim();
}

function readTenantSlugFromRequest(req) {
    return String(
        req.get('X-Tenant')
        || req.query?.tenant
        || (req.body && req.body.tenant)
        || ''
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

function attachTenantToRequest(req, tenant) {
    enrichTenantSettings(tenant);
    req.tenant = tenant;
    req.tenantId = tenant.id;
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

    if (isMobileApiHost(req.get('host'))) {
        return resolveMobileApiHost(req, res, next);
    }

    const run = async () => {
        let tenant = null;

        const headerTenant = readTenantSlugFromRequest(req);
        if (headerTenant) {
            tenant = await tenantStore.getTenantBySubdomain(headerTenant);
        }

        if (!tenant) {
            const sub = extractSubdomain(req.get('host'));
            if (sub && sub !== CENTRAL_PREFIX && sub !== getMobileApiSubdomain()) {
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

        if (!tenant) {
            if (req.path.startsWith('/login')) {
                return next();
            }
            return res.status(404).render('platform/errors/tenant-not-found', {
                title: 'Tenant Tidak Ditemukan',
            });
        }

        attachTenantToRequest(req, tenant);

        if (tenant.is_master) {
            return res.status(404).render('platform/errors/tenant-not-found', {
                title: 'Tenant Tidak Ditemukan',
            });
        }

        const blockedStatuses = new Set(['provisioning', 'pending', 'failed']);
        if (blockedStatuses.has(tenant.status) && !req.path.startsWith('/login')) {
            return res.status(503).render('platform/errors/tenant-unavailable', {
                title: 'Tenant Tidak Tersedia',
                tenant,
            });
        }

        return runWithTenant(tenant, () => next());
    };

    run().catch(next);
}

function resolveMobileApiHost(req, res, next) {
    const pathname = req.path || '/';

    if (isMobilePublicPath(pathname)) {
        return next();
    }

    if (!pathname.startsWith('/api')) {
        return res.status(404).json({
            success: false,
            message: 'Host ini khusus API mobile. Gunakan https://manage.' + getTenantBaseDomain() + ' untuk portal management.',
            host: 'mobile-api',
        });
    }

    const run = async () => {
        const slug = readTenantSlugFromRequest(req);
        if (!slug) {
            return res.status(400).json({
                success: false,
                message: 'Header X-Tenant (atau ?tenant=) wajib untuk API mobile.',
            });
        }

        const tenant = await tenantStore.getTenantBySubdomain(slug);
        if (!tenant || tenant.is_master) {
            return res.status(404).json({
                success: false,
                message: `Tenant "${slug}" tidak ditemukan.`,
            });
        }

        const blockedStatuses = new Set(['provisioning', 'pending', 'failed', 'deleted']);
        if (blockedStatuses.has(tenant.status)) {
            return res.status(503).json({
                success: false,
                message: `Tenant "${slug}" tidak tersedia (status: ${tenant.status}).`,
            });
        }

        attachTenantToRequest(req, tenant);
        return runWithTenant(tenant, () => next());
    };

    run().catch(next);
}

module.exports = {
    resolveTenantMiddleware,
    isCentralHost,
    isMobileApiHost,
    getMobileApiSubdomain,
    extractSubdomain,
    isDirectHostAccess,
    isIpAddress,
    getDefaultTenantSubdomain,
    invalidateEnrichedSettingsCache,
};
