'use strict';

const express = require('express');
const tenantStore = require('../config/platform/tenantStore');
const platformAdminService = require('../config/platform/platformAdminService');
const platformSettingsService = require('../config/platform/platformSettingsService');
const { platformAuth } = require('../middleware/platformAuth');
const { formatRupiah } = require('../config/platform/formatRupiah');
const managementMasterPackagesRouter = require('./managementMasterPackages');
const managementNginxRouter = require('./managementNginx');

const router = express.Router();

router.use(platformAuth);

router.use((req, res, next) => {
    res.locals.formatRupiah = formatRupiah;
    next();
});

router.use('/packages', managementMasterPackagesRouter);
router.use('/reverse-proxy', managementNginxRouter);

router.get('/', (req, res) => res.redirect('/management/settings/users'));

// ── User Manager ──
router.get('/users', async (req, res) => {
    try {
        const users = await platformAdminService.listSuperAdmins();
        res.render('platform/settings/users', {
            title: 'User Manager',
            active: 'settings-users',
            settingsSection: 'users',
            users,
            currentAdminId: req.session.platformAdminId,
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[platform] settings users:', err);
        res.status(500).send('Error loading users');
    }
});

router.post('/users', async (req, res) => {
    try {
        const user = await platformAdminService.createSuperAdmin(req.body);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'platform_user_created',
            details: { id: user.id, email: user.email },
            ip: req.ip,
        });
        res.redirect('/management/settings/users?success=created');
    } catch (err) {
        res.redirect(`/management/settings/users?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/users/:id', async (req, res) => {
    try {
        const isActive = req.body.is_active === '1' || req.body.is_active === 1 ? 1 : 0;
        const user = await platformAdminService.updateSuperAdmin(req.params.id, {
            ...req.body,
            is_active: isActive,
        });
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'platform_user_updated',
            details: { id: user.id, email: user.email },
            ip: req.ip,
        });
        res.redirect('/management/settings/users?success=updated');
    } catch (err) {
        res.redirect(`/management/settings/users?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/users/:id/deactivate', async (req, res) => {
    try {
        await platformAdminService.deactivateSuperAdmin(req.params.id, req.session.platformAdminId);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'platform_user_deactivated',
            details: { id: Number(req.params.id) },
            ip: req.ip,
        });
        res.redirect('/management/settings/users?success=deactivated');
    } catch (err) {
        res.redirect(`/management/settings/users?error=${encodeURIComponent(err.message)}`);
    }
});

// ── Company Profile ──
router.get('/company', async (req, res) => {
    try {
        const profile = await platformSettingsService.getCompanyProfile();
        res.render('platform/settings/company', {
            title: 'Company Profile',
            active: 'settings-company',
            settingsSection: 'company',
            profile,
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[platform] settings company:', err);
        res.status(500).send('Error loading company profile');
    }
});

router.post('/company', async (req, res) => {
    try {
        const profile = await platformSettingsService.saveCompanyProfile(req.body);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'platform_company_updated',
            details: { company_name: profile.company_name },
            ip: req.ip,
        });
        res.redirect('/management/settings/company?success=saved');
    } catch (err) {
        res.redirect(`/management/settings/company?error=${encodeURIComponent(err.message)}`);
    }
});

// ── Payment Manager ──
router.get('/payment', async (req, res) => {
    try {
        const payment = await platformSettingsService.getPlatformPaymentGateway();
        res.render('platform/settings/payment', {
            title: 'Payment Manager',
            active: 'settings-payment',
            settingsSection: 'payment',
            payment,
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[platform] settings payment:', err);
        res.status(500).send('Error loading payment settings');
    }
});

router.post('/payment', async (req, res) => {
    try {
        const body = req.body || {};
        const payload = {
            active: body.active,
            midtrans: body.midtrans,
            xendit: body.xendit,
            tripay: body.tripay,
            duitku: body.duitku,
        };
        const payment = await platformSettingsService.savePlatformPaymentGateway(payload);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'platform_payment_updated',
            details: { active: payment.active },
            ip: req.ip,
        });
        res.redirect('/management/settings/payment?success=saved');
    } catch (err) {
        res.redirect(`/management/settings/payment?error=${encodeURIComponent(err.message)}`);
    }
});

// ── Activity Logs ──
router.get('/activity-logs', async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = 30;
        const offset = (page - 1) * limit;
        const { rows, total } = await platformAdminService.listAuditLogs({
            limit,
            offset,
            action: req.query.action || '',
            actorId: req.query.actor_id || null,
            tenantId: req.query.tenant_id || null,
            from: req.query.from || '',
            to: req.query.to || '',
        });
        const users = await platformAdminService.listSuperAdmins();
        const totalPages = Math.max(Math.ceil(total / limit), 1);

        res.render('platform/settings/activity-logs', {
            title: 'Log Aktivitas',
            active: 'settings-logs',
            settingsSection: 'logs',
            logs: rows,
            users,
            filters: {
                action: req.query.action || '',
                actor_id: req.query.actor_id || '',
                tenant_id: req.query.tenant_id || '',
                from: req.query.from || '',
                to: req.query.to || '',
            },
            pagination: { page, totalPages, total },
            formatActionLabel: platformAdminService.formatActionLabel,
            adminName: req.session.platformAdminName,
        });
    } catch (err) {
        console.error('[platform] activity logs:', err);
        res.status(500).send('Error loading activity logs');
    }
});

router.get('/activity-logs/:id', async (req, res) => {
    try {
        const log = await platformAdminService.getAuditLogById(req.params.id);
        if (!log) return res.status(404).json({ success: false, message: 'Log tidak ditemukan' });
        res.json({
            success: true,
            log: {
                ...log,
                action_label: platformAdminService.formatActionLabel(log.action),
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
