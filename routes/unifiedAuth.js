const express = require('express');
const router = express.Router();
const { getSetting } = require('../config/settingsManager');
const { getTenantSetting, getTenantBranding } = require('../config/platform/tenantSettings');
const { getTenant, hasTenantContext } = require('../config/platform/tenantContext');
const {
    extractSubdomain,
    isDirectHostAccess,
    getDefaultTenantSubdomain,
} = require('../middleware/resolveTenant');
const tenantStore = require('../config/platform/tenantStore');
const { logAdminActivity } = require('../config/activityLogger');

const CENTRAL_SUBDOMAIN = process.env.KALIMASADA_CENTRAL_SUBDOMAIN || 'manage';

function resolveTenantSlugFromRequest(req) {
    const fromBody = String(req.body?.tenant || req.query?.tenant || '').toLowerCase().trim();
    if (fromBody) return fromBody;

    if (hasTenantContext()) {
        const sub = getTenant()?.subdomain;
        if (sub) return String(sub).toLowerCase();
    }

    const hostSub = extractSubdomain(req.get('host'));
    if (hostSub && hostSub !== CENTRAL_SUBDOMAIN) return hostSub;

    if (isDirectHostAccess(req.get('host'))) {
        return getDefaultTenantSubdomain();
    }

    return '';
}

async function resolveLoginCredentials(req) {
    const tenantSlug = resolveTenantSlugFromRequest(req);

    if (tenantSlug) {
        const tenant = await tenantStore.getTenantBySubdomain(tenantSlug);
        if (!tenant || tenant.deleted_at) {
            return { error: 'Tenant tidak ditemukan.' };
        }
        if (tenant.status !== 'active') {
            return { error: 'Tenant tidak aktif atau disuspend.' };
        }
        return {
            tenant,
            adminUsername: String(tenant.settings?.admin_username || 'admin').trim(),
            adminPassword: String(tenant.settings?.admin_password || 'admin').trim(),
        };
    }

    return {
        tenant: null,
        adminUsername: String(getSetting('admin_username', 'admin')).trim(),
        adminPassword: String(getSetting('admin_password', 'admin')).trim(),
    };
}

function jsonAfterSessionSave(req, res, payload) {
    req.session.save((err) => {
        if (err) {
            console.error('Unified login session save failed:', err);
            return res.status(500).json({ success: false, message: 'Gagal menyimpan sesi. Silakan coba lagi.' });
        }
        res.json(payload);
    });
}

// GET: Unified Login Page
router.get('/', async (req, res) => {
    try {
        const branding = getTenantBranding();
        const appSettings = {
            logo_filename: branding.logo_filename,
            company_header: branding.company_header,
            company_name: branding.company_name,
            footer_info: branding.footer_info,
            contact_phone: branding.contact_phone,
        };

        const tenantSlug = resolveTenantSlugFromRequest(req);

        res.render('login-unified', {
            appSettings,
            tenantSlug,
            directHostAccess: isDirectHostAccess(req.get('host')),
            timedOut: req.query.timeout === '1',
            error: req.query.error === 'tenant_session' ? 'Sesi tidak valid untuk tenant ini. Silakan login kembali.' : null,
            success: null
        });
    } catch (error) {
        console.error('Error rendering unified login:', error);
        res.status(500).send('Internal Server Error');
    }
});

// POST: Unified Login Process
router.post('/', async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '').trim();

    try {
        const creds = await resolveLoginCredentials(req);
        if (creds.error) {
            return res.status(401).json({ success: false, message: creds.error });
        }

        const { adminUsername, adminPassword, tenant } = creds;

        if (username === adminUsername && password === adminPassword) {
            req.session.isAdmin = true;
            req.session.adminUser = username;
            req.session.lastActivityAt = Date.now();
            if (tenant?.id) {
                req.session.tenantId = tenant.id;
                req.session.tenantSubdomain = tenant.subdomain;
            } else if (hasTenantContext()) {
                req.session.tenantId = getTenant().id;
                req.session.tenantSubdomain = getTenant().subdomain;
            }
            await logAdminActivity(req, 'admin_login', `Login admin: ${username}${tenant ? ` (tenant ${tenant.subdomain})` : ''}`);
            return jsonAfterSessionSave(req, res, { success: true, redirect: '/admin/dashboard' });
        }

        return res.status(401).json({ success: false, message: 'Username atau password admin tidak valid' });

    } catch (error) {
        console.error('Unified login error:', error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem' });
    }
});

module.exports = router;
