'use strict';

const express = require('express');
const tenantStore = require('../config/platform/tenantStore');
const { platformAuth, platformGuest } = require('../middleware/platformAuth');
const {
    getTenantBaseDomain,
    getTenantHostname,
    getTenantLoginUrl,
    getDevTenantLoginUrl,
} = require('../config/platform/tenantUrls');
const managementNginxRouter = require('./managementNginx');
const managementMobileRouter = require('./managementMobile');
const nginxManager = require('../config/platform/nginxManager');

const router = express.Router();

function tenantUrlContext(subdomain) {
    return {
        tenantHostname: getTenantHostname(subdomain),
        tenantLoginUrl: getTenantLoginUrl(subdomain),
        tenantDevLoginUrl: getDevTenantLoginUrl(subdomain),
        tenantBaseDomain: getTenantBaseDomain(),
    };
}

router.get('/', (req, res) => {
    if (req.session?.isPlatformAdmin) return res.redirect('/management/dashboard');
    return res.redirect('/management/login');
});

router.get('/login', platformGuest, (req, res) => {
    res.render('platform/login', {
        layout: false,
        title: 'Kalimasada Management Portal',
        error: req.query.error || null,
        success: req.query.success || null,
    });
});

router.post('/login', platformGuest, async (req, res) => {
    try {
        const { email, password } = req.body;
        const admin = await tenantStore.verifySuperAdmin(email, password);
        if (!admin) {
            return res.render('platform/login', {
                layout: false,
                title: 'Kalimasada Management Portal',
                error: 'Email atau password tidak valid.',
                success: null,
            });
        }
        req.session.isPlatformAdmin = true;
        req.session.platformAdminId = admin.id;
        req.session.platformAdminEmail = admin.email;
        req.session.platformAdminName = admin.name;
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: admin.id,
            action: 'platform_login',
            ip: req.ip,
        });
        return req.session.save(() => res.redirect('/management/dashboard'));
    } catch (err) {
        console.error('[platform] login error:', err);
        return res.status(500).render('platform/login', {
            layout: false,
            title: 'Kalimasada Management Portal',
            error: 'Terjadi kesalahan sistem.',
            success: null,
        });
    }
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('admin_session');
        res.redirect('/management/login');
    });
});

router.use(platformAuth);

router.use('/reverse-proxy', managementNginxRouter);
router.use('/mobile-app', managementMobileRouter);

router.get('/dashboard', async (req, res) => {
    try {
        const stats = await tenantStore.getGlobalStats();
        const tenants = await tenantStore.listTenants();
        const recent = tenants.slice(0, 5);
        res.render('platform/dashboard', {
            title: 'Dashboard',
            stats,
            recentTenants: recent,
            adminName: req.session.platformAdminName,
        });
    } catch (err) {
        console.error('[platform] dashboard:', err);
        res.status(500).send('Error loading dashboard');
    }
});

router.get('/tenants', async (req, res) => {
    try {
        const tenants = await tenantStore.listTenants();
        const withStats = await Promise.all(
            tenants.map(async (t) => ({
                ...t,
                usage: await tenantStore.getTenantStats(t.id),
            }))
        );
        res.render('platform/tenants/index', {
            title: 'Kelola Tenant',
            tenants: withStats,
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[platform] tenants list:', err);
        res.status(500).send('Error loading tenants');
    }
});

router.get('/tenants/new', async (req, res) => {
    const plans = await tenantStore.listSubscriptionPlans();
    res.render('platform/tenants/form', {
        title: 'Tambah Tenant',
        tenant: null,
        plans,
        tenantBaseDomain: getTenantBaseDomain(),
        adminName: req.session.platformAdminName,
        error: null,
    });
});

router.post('/tenants', async (req, res) => {
    try {
        const tenant = await tenantStore.createTenant({
            name: req.body.name,
            owner_name: req.body.owner_name,
            owner_email: req.body.owner_email,
            owner_phone: req.body.owner_phone,
            subdomain: req.body.subdomain,
            subscription_plan_id: Number(req.body.subscription_plan_id),
            subscription_months: Number(req.body.subscription_months) || 1,
            admin_username: req.body.admin_username,
            admin_password: req.body.admin_password,
        });
        await tenantStore.auditLog({
            tenantId: tenant.id,
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'tenant_created',
            details: { subdomain: tenant.subdomain },
            ip: req.ip,
        });
        let nginxQ = '';
        try {
            const syncResult = await nginxManager.syncTenantsAndApply();
            if (!syncResult.ok) {
                console.warn('[platform] nginx sync after create:', syncResult.message);
                nginxQ = `&nginx_warn=${encodeURIComponent(syncResult.message)}`;
            }
        } catch (e) {
            console.warn('[platform] nginx sync after create:', e.message);
            nginxQ = `&nginx_warn=${encodeURIComponent(e.message)}`;
        }
        return res.redirect(`/management/tenants/${tenant.id}?success=created${nginxQ}`);
    } catch (err) {
        const plans = await tenantStore.listSubscriptionPlans();
        return res.status(400).render('platform/tenants/form', {
            title: 'Tambah Tenant',
            tenant: req.body,
            plans,
            tenantBaseDomain: getTenantBaseDomain(),
            adminName: req.session.platformAdminName,
            error: err.message,
        });
    }
});

router.get('/tenants/:id', async (req, res) => {
    try {
        const tenant = await tenantStore.getTenantById(req.params.id);
        if (!tenant) return res.status(404).send('Tenant tidak ditemukan');
        const { getFullSettingsForTenantId } = require('../config/platform/tenantSettingsManager');
        const tenantSettings = await getFullSettingsForTenantId(tenant.id);
        const usage = await tenantStore.getTenantStats(tenant.id);
        const logs = await tenantStore.getDb().all
            ? await new Promise((resolve) => {
                tenantStore.getDb().all(
                    'SELECT * FROM tenant_provisioning_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT 20',
                    [tenant.id],
                    (_, rows) => resolve(rows || [])
                );
            })
            : [];
        res.render('platform/tenants/show', {
            title: tenant.name,
            tenant: { ...tenant, settings: tenantSettings },
            usage,
            logs,
            ...tenantUrlContext(tenant.subdomain),
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[platform] tenant show:', err);
        res.status(500).send('Error loading tenant');
    }
});

router.get('/tenants/:id/edit', async (req, res) => {
    const tenant = await tenantStore.getTenantById(req.params.id);
    if (!tenant) return res.status(404).send('Tenant tidak ditemukan');
    const { getFullSettingsForTenantId } = require('../config/platform/tenantSettingsManager');
    const tenantSettings = await getFullSettingsForTenantId(tenant.id);
    const plans = await tenantStore.listSubscriptionPlans();
    res.render('platform/tenants/form', {
        title: `Edit ${tenant.name}`,
        tenant: { ...tenant, settings: tenantSettings },
        plans,
        tenantBaseDomain: getTenantBaseDomain(),
        adminName: req.session.platformAdminName,
        error: null,
    });
});

router.post('/tenants/:id', async (req, res) => {
    try {
        const tenant = await tenantStore.updateTenant(req.params.id, {
            name: req.body.name,
            owner_name: req.body.owner_name,
            owner_email: req.body.owner_email,
            owner_phone: req.body.owner_phone,
            subdomain: req.body.subdomain,
            subscription_plan_id: Number(req.body.subscription_plan_id),
            subscription_months: req.body.subscription_months ? Number(req.body.subscription_months) : null,
            admin_username: req.body.admin_username,
            admin_password: req.body.admin_password,
        });
        await tenantStore.auditLog({
            tenantId: tenant.id,
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'tenant_updated',
            ip: req.ip,
        });
        let nginxQ = '';
        try {
            const syncResult = await nginxManager.syncTenantsAndApply();
            if (!syncResult.ok) {
                console.warn('[platform] nginx sync after update:', syncResult.message);
                nginxQ = `&nginx_warn=${encodeURIComponent(syncResult.message)}`;
            }
        } catch (e) {
            console.warn('[platform] nginx sync after update:', e.message);
            nginxQ = `&nginx_warn=${encodeURIComponent(e.message)}`;
        }
        return res.redirect(`/management/tenants/${tenant.id}?success=updated${nginxQ}`);
    } catch (err) {
        const plans = await tenantStore.listSubscriptionPlans();
        return res.status(400).render('platform/tenants/form', {
            title: 'Edit Tenant',
            tenant: { ...req.body, id: req.params.id },
            plans,
            tenantBaseDomain: getTenantBaseDomain(),
            adminName: req.session.platformAdminName,
            error: err.message,
        });
    }
});

function tenantActionRedirect(req, id, query = '') {
    const base = req.body.redirect === 'list' ? '/management/tenants' : `/management/tenants/${id}`;
    return query ? `${base}?${query}` : base;
}

router.post('/tenants/:id/suspend', async (req, res) => {
    try {
        await tenantStore.suspendTenant(req.params.id, req.body.reason || 'Suspended by Super Admin');
        await tenantStore.auditLog({
            tenantId: Number(req.params.id),
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'tenant_suspended',
            ip: req.ip,
        });
        res.redirect(tenantActionRedirect(req, req.params.id, 'success=suspended'));
    } catch (err) {
        res.redirect(tenantActionRedirect(req, req.params.id, `error=${encodeURIComponent(err.message)}`));
    }
});

router.post('/tenants/:id/activate', async (req, res) => {
    try {
        await tenantStore.activateTenant(req.params.id);
        await tenantStore.auditLog({
            tenantId: Number(req.params.id),
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'tenant_activated',
            ip: req.ip,
        });
        res.redirect(tenantActionRedirect(req, req.params.id, 'success=activated'));
    } catch (err) {
        res.redirect(tenantActionRedirect(req, req.params.id, `error=${encodeURIComponent(err.message)}`));
    }
});

router.post('/tenants/:id/delete', async (req, res) => {
    try {
        if (Number(req.params.id) === 1) {
            return res.redirect(`/management/tenants/${req.params.id}?error=Tenant+default+tidak+bisa+dihapus`);
        }
        await tenantStore.deleteTenant(req.params.id);
        await tenantStore.auditLog({
            tenantId: Number(req.params.id),
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'tenant_deleted',
            ip: req.ip,
        });
        res.redirect('/management/tenants?success=deleted');
    } catch (err) {
        res.redirect(`/management/tenants/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    }
});

module.exports = router;
