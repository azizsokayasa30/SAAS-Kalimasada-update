'use strict';

const express = require('express');
const multer = require('multer');
const tenantStore = require('../config/platform/tenantStore');
const tenantBackup = require('../config/platform/tenantBackup');
const dashboardMetrics = require('../config/platform/dashboardMetrics');
const { platformAuth, platformGuest } = require('../middleware/platformAuth');
const {
    getTenantBaseDomain,
    getTenantHostname,
    getTenantLoginUrl,
    getDevTenantLoginUrl,
} = require('../config/platform/tenantUrls');
const managementMobileRouter = require('./managementMobile');
const managementSettingsRouter = require('./managementSettings');
const managementFinanceRouter = require('./managementFinance');
const managementPopRouter = require('./managementPop');
const managementVpnRouter = require('./managementVpn');
const nginxManager = require('../config/platform/nginxManager');
const { formatRupiah, formatRupiahShort } = require('../config/platform/formatRupiah');
const masterTenantService = require('../config/platform/masterTenantService');

const router = express.Router();

const tenantRestoreUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter(req, file, cb) {
        const name = String(file.originalname || '').toLowerCase();
        if (name.endsWith('.json')) cb(null, true);
        else cb(new Error('Hanya file JSON backup yang diizinkan'));
    },
});

const tenantExcelUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter(req, file, cb) {
        const name = String(file.originalname || '').toLowerCase();
        if (name.endsWith('.xlsx')) cb(null, true);
        else cb(new Error('Hanya file Excel (.xlsx) yang diizinkan'));
    },
});

function tenantsListUrl(query = '') {
    return `/management/tenants${query ? (query.startsWith('?') ? query : `?${query}`) : ''}`;
}

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

router.use((req, res, next) => {
    res.locals.formatRupiah = formatRupiah;
    res.locals.formatRupiahShort = formatRupiahShort;
    next();
});

router.use(async (req, res, next) => {
    try {
        const platformSettingsService = require('../config/platform/platformSettingsService');
        res.locals.platformCompany = await platformSettingsService.getCompanyProfile();
    } catch (_) {
        const platformSettingsService = require('../config/platform/platformSettingsService');
        res.locals.platformCompany = platformSettingsService.DEFAULT_COMPANY;
    }
    next();
});

router.get('/reverse-proxy', (req, res) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(`/management/settings/reverse-proxy${qs}`);
});
router.get('/reverse-proxy/*', (req, res) => {
    const rest = req.params[0] || '';
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(`/management/settings/reverse-proxy/${rest}${qs}`);
});
router.use('/mobile-app', managementMobileRouter);
router.use('/settings', managementSettingsRouter);
router.get('/master-packages', (req, res) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(`/management/settings/packages${qs}`);
});
router.get('/master-packages/*', (req, res) => {
    const rest = req.params[0] || '';
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(`/management/settings/packages/${rest}${qs}`);
});
router.use('/finance', managementFinanceRouter);
router.use('/pop', managementPopRouter);
router.use('/vpn', managementVpnRouter);

router.get('/dashboard', async (req, res) => {
    try {
        const stats = await tenantStore.getExtendedGlobalStats();
        const tenants = await tenantStore.listOperationalTenants();
        const recent = await Promise.all(
            tenants.slice(0, 5).map(async (t) => ({
                ...t,
                usage: await tenantStore.getTenantStats(t.id),
            }))
        );
        const radius = await dashboardMetrics.getRadiusHealth();
        res.render('platform/dashboard', {
            title: 'Dashboard',
            stats,
            radius,
            recentTenants: recent,
            adminName: req.session.platformAdminName,
        });
    } catch (err) {
        console.error('[platform] dashboard:', err);
        res.status(500).send('Error loading dashboard');
    }
});

router.get('/dashboard/api/metrics', async (req, res) => {
    try {
        const payload = await dashboardMetrics.getDashboardMetrics();
        res.json(payload);
    } catch (err) {
        console.error('[platform] dashboard metrics:', err);
        res.status(500).json({
            success: false,
            message: err.message || 'Gagal memuat metrik dashboard',
        });
    }
});

router.get('/tenants', async (req, res) => {
    try {
        const period = tenantStore.resolveStatsPeriod({
            month: req.query.month,
            year: req.query.year,
        });
        const tenants = await tenantStore.listOperationalTenants();
        const withStats = await Promise.all(
            tenants.map(async (t) => ({
                ...t,
                usage: await tenantStore.getTenantStats(t.id, {
                    month: period.month,
                    year: period.year,
                    periodFilter: true,
                }),
            }))
        );
        const backups = tenantBackup.listTenantBackups();
        res.render('platform/tenants/index', {
            title: 'Kelola Tenant',
            tenants: withStats,
            backups,
            filters: {
                month: period.month,
                year: period.year,
                label: period.label,
                isFullYear: period.isFullYear,
            },
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[platform] tenants list:', err);
        res.status(500).send('Error loading tenants');
    }
});

router.get('/tenants/backup/download', async (req, res) => {
    try {
        const { payload, filename } = await tenantBackup.exportTenantBackup();
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'tenant_registry_backup',
            details: { filename, tenant_count: payload.tenant_count },
            ip: req.ip,
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(JSON.stringify(payload, null, 2));
    } catch (err) {
        console.error('[platform] tenant backup:', err);
        res.redirect(tenantsListUrl(`error=${encodeURIComponent(err.message)}`));
    }
});

router.get('/tenants/backup/excel', async (req, res) => {
    try {
        const buffer = await tenantBackup.buildTenantExcelBuffer({ includeData: true });
        const filename = `tenants_export_${new Date().toISOString().slice(0, 10)}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(Buffer.from(buffer));
    } catch (err) {
        console.error('[platform] tenant excel export:', err);
        res.redirect(tenantsListUrl(`error=${encodeURIComponent(err.message)}`));
    }
});

router.get('/tenants/backup/template', async (req, res) => {
    try {
        const buffer = await tenantBackup.buildTenantExcelBuffer({ templateOnly: true });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="template_import_tenant.xlsx"');
        res.send(Buffer.from(buffer));
    } catch (err) {
        console.error('[platform] tenant excel template:', err);
        res.redirect(tenantsListUrl(`error=${encodeURIComponent(err.message)}`));
    }
});

router.get('/tenants/backup/file/:filename', async (req, res) => {
    try {
        const full = tenantBackup.getBackupFilePath(req.params.filename);
        res.download(full);
    } catch (err) {
        res.status(404).send(err.message);
    }
});

router.post('/tenants/backup/restore', (req, res) => {
    tenantRestoreUpload.single('backup_file')(req, res, async (uploadErr) => {
        try {
            if (uploadErr) {
                return res.redirect(tenantsListUrl(`error=${encodeURIComponent(uploadErr.message)}`));
            }
            if (!req.file) {
                return res.redirect(tenantsListUrl('error=' + encodeURIComponent('Pilih file backup JSON terlebih dahulu')));
            }

            let payload;
            try {
                payload = tenantBackup.validateBackupPayload(JSON.parse(req.file.buffer.toString('utf8')));
            } catch (parseErr) {
                return res.redirect(tenantsListUrl(`error=${encodeURIComponent(parseErr.message)}`));
            }

            const mode = req.body.mode === 'merge' ? 'merge' : 'create_only';
            const result = await tenantBackup.restoreTenantBackup(payload, { mode });

            await tenantStore.auditLog({
                actorType: 'SuperAdmin',
                actorId: req.session.platformAdminId,
                action: 'tenant_registry_restore',
                details: { mode, source: 'upload', ...result },
                ip: req.ip,
            });

            try {
                await nginxManager.syncTenantsAndApply();
            } catch (e) {
                console.warn('[platform] nginx sync after tenant restore:', e.message);
            }

            const errQ = result.errors.length
                ? `&warn=${encodeURIComponent(`${result.errors.length} baris gagal`)}`
                : '';
            res.redirect(tenantsListUrl(
                `success=restored&created=${result.created}&updated=${result.updated}&skipped=${result.skipped}${errQ}`
            ));
        } catch (err) {
            console.error('[platform] tenant restore upload:', err);
            res.redirect(tenantsListUrl(`error=${encodeURIComponent(err.message)}`));
        }
    });
});

router.post('/tenants/backup/restore/:filename', async (req, res) => {
    try {
        const payload = tenantBackup.readBackupFile(req.params.filename);
        const mode = req.body.mode === 'create_only' ? 'create_only' : 'merge';
        const result = await tenantBackup.restoreTenantBackup(payload, { mode });

        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'tenant_registry_restore',
            details: { source: req.params.filename, mode, ...result },
            ip: req.ip,
        });

        try {
            await nginxManager.syncTenantsAndApply();
        } catch (e) {
            console.warn('[platform] nginx sync after tenant restore:', e.message);
        }

        res.redirect(tenantsListUrl(
            `success=restored&created=${result.created}&updated=${result.updated}&skipped=${result.skipped}`
        ));
    } catch (err) {
        console.error('[platform] tenant restore file:', err);
        res.redirect(tenantsListUrl(`error=${encodeURIComponent(err.message)}`));
    }
});

router.post('/tenants/backup/import-excel', (req, res) => {
    tenantExcelUpload.single('excel_file')(req, res, async (uploadErr) => {
        try {
            if (uploadErr) {
                return res.redirect(tenantsListUrl(`error=${encodeURIComponent(uploadErr.message)}`));
            }
            if (!req.file) {
                return res.redirect(tenantsListUrl('error=' + encodeURIComponent('Pilih file Excel (.xlsx) terlebih dahulu')));
            }

            const rows = await tenantBackup.parseTenantsFromExcel(req.file.buffer);
            const mode = req.body.mode === 'merge' ? 'merge' : 'create_only';
            const result = await tenantBackup.restoreTenantRegistry(rows, { mode });

            await tenantStore.auditLog({
                actorType: 'SuperAdmin',
                actorId: req.session.platformAdminId,
                action: 'tenant_excel_import',
                details: { mode, filename: req.file.originalname, ...result },
                ip: req.ip,
            });

            try {
                await nginxManager.syncTenantsAndApply();
            } catch (e) {
                console.warn('[platform] nginx sync after tenant excel import:', e.message);
            }

            const errQ = result.errors.length
                ? `&warn=${encodeURIComponent(`${result.errors.length} baris gagal`)}`
                : '';
            res.redirect(tenantsListUrl(
                `success=imported&created=${result.created}&updated=${result.updated}&skipped=${result.skipped}${errQ}`
            ));
        } catch (err) {
            console.error('[platform] tenant excel import:', err);
            res.redirect(tenantsListUrl(`error=${encodeURIComponent(err.message)}`));
        }
    });
});

router.get('/tenants/new', async (req, res) => {
    res.render('platform/tenants/form', {
        title: 'Tambah Tenant',
        tenant: null,
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
        return res.status(400).render('platform/tenants/form', {
            title: 'Tambah Tenant',
            tenant: req.body,
            tenantBaseDomain: getTenantBaseDomain(),
            adminName: req.session.platformAdminName,
            error: err.message,
        });
    }
});

router.get('/tenants/:id', async (req, res) => {
    try {
        const tenant = await tenantStore.getTenantById(req.params.id);
        if (!tenant || tenant.is_master) return res.status(404).send('Tenant tidak ditemukan');
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
    if (!tenant || tenant.is_master) return res.status(404).send('Tenant tidak ditemukan');
    const { getFullSettingsForTenantId } = require('../config/platform/tenantSettingsManager');
    const tenantSettings = await getFullSettingsForTenantId(tenant.id);
    res.render('platform/tenants/form', {
        title: `Edit ${tenant.name}`,
        tenant: { ...tenant, settings: tenantSettings },
        tenantBaseDomain: getTenantBaseDomain(),
        adminName: req.session.platformAdminName,
        error: null,
    });
});

router.post('/tenants/:id', async (req, res) => {
    try {
        const existing = await tenantStore.getTenantById(req.params.id);
        if (!existing || existing.is_master) {
            return res.status(404).send('Tenant tidak ditemukan');
        }
        const tenant = await tenantStore.updateTenant(req.params.id, {
            name: req.body.name,
            owner_name: req.body.owner_name,
            owner_email: req.body.owner_email,
            owner_phone: req.body.owner_phone,
            subdomain: req.body.subdomain,
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
        return res.status(400).render('platform/tenants/form', {
            title: 'Edit Tenant',
            tenant: { ...req.body, id: req.params.id },
            tenantBaseDomain: getTenantBaseDomain(),
            adminName: req.session.platformAdminName,
            error: err.message,
        });
    }
});

router.post('/tenants/:id/credentials', async (req, res) => {
    try {
        const creds = await tenantStore.updateTenantAdminCredentials(req.params.id, {
            admin_username: req.body.admin_username,
            admin_password: req.body.admin_password,
        });
        await tenantStore.auditLog({
            tenantId: Number(req.params.id),
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'tenant_credentials_updated',
            details: { admin_username: creds.admin_username },
            ip: req.ip,
        });
        return res.redirect(`/management/tenants/${req.params.id}?success=credentials`);
    } catch (err) {
        return res.redirect(`/management/tenants/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    }
});

function tenantActionRedirect(req, id, query = '') {
    const base = req.body.redirect === 'list' ? '/management/tenants' : `/management/tenants/${id}`;
    return query ? `${base}?${query}` : base;
}

router.post('/tenants/:id/delete', async (req, res) => {
    try {
        const existing = await tenantStore.getTenantById(req.params.id);
        if (!existing || existing.is_master) {
            return res.redirect('/management/tenants?error=Tenant+tidak+ditemukan');
        }
        await tenantStore.deleteTenant(req.params.id);
        await tenantStore.auditLog({
            tenantId: Number(req.params.id),
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'tenant_deleted',
            ip: req.ip,
        });
        try {
            await nginxManager.syncTenantsAndApply();
        } catch (e) {
            console.warn('[platform] nginx sync after delete:', e.message);
        }
        res.redirect('/management/tenants?success=deleted');
    } catch (err) {
        res.redirect(`/management/tenants/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    }
});

router.get('/master-tenant', async (req, res) => {
    try {
        const master = await tenantStore.getMasterTenant();
        if (!master) {
            return res.redirect('/management/master-tenant/setup');
        }
        const overview = await masterTenantService.getMasterOverview();
        res.render('platform/master-tenant/index', {
            title: 'Master Tenant',
            master,
            overview,
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[platform] master tenant:', err);
        res.status(500).send('Error loading master tenant');
    }
});

router.get('/master-tenant/setup', async (req, res) => {
    try {
        const master = await tenantStore.getMasterTenant();
        if (master) {
            return res.redirect('/management/master-tenant');
        }
        res.render('platform/master-tenant/setup', {
            title: 'Setup Master Tenant',
            adminName: req.session.platformAdminName,
            error: req.query.error || null,
        });
    } catch (err) {
        console.error('[platform] master tenant setup:', err);
        res.status(500).send('Error loading setup');
    }
});

router.post('/master-tenant/setup', async (req, res) => {
    try {
        const master = await tenantStore.ensureMasterTenant({
            name: req.body.name,
            owner_name: req.body.owner_name,
            owner_email: req.body.owner_email,
            owner_phone: req.body.owner_phone,
        });
        masterTenantService.bustOverviewCache();
        await tenantStore.auditLog({
            tenantId: master.id,
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'master_tenant_created',
            ip: req.ip,
        });
        return res.redirect('/management/master-tenant?success=created');
    } catch (err) {
        return res.redirect(`/management/master-tenant/setup?error=${encodeURIComponent(err.message)}`);
    }
});

router.get('/master-tenant/children/:id', async (req, res) => {
    try {
        const master = await tenantStore.getMasterTenant();
        if (!master) {
            return res.redirect('/management/master-tenant/setup');
        }
        const child = await masterTenantService.getChildTenantById(req.params.id);
        if (!child) return res.status(404).send('Tenant child tidak ditemukan');

        const page = req.query.page || 1;
        const tab = req.query.tab === 'invoices' ? 'invoices' : 'customers';
        const usage = await tenantStore.getTenantStats(child.id);
        const customers = tab === 'customers'
            ? await masterTenantService.getChildCustomers(child.id, { page })
            : null;
        const invoices = tab === 'invoices'
            ? await masterTenantService.getChildInvoices(child.id, { page })
            : null;

        res.render('platform/master-tenant/child', {
            title: `${child.name} — Master Tenant`,
            master,
            child,
            usage,
            tab,
            customers,
            invoices,
            ...tenantUrlContext(child.subdomain),
            adminName: req.session.platformAdminName,
        });
    } catch (err) {
        console.error('[platform] master tenant child:', err);
        res.status(500).send('Error loading child tenant');
    }
});

module.exports = router;
