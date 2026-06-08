'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const tenantStore = require('../config/platform/tenantStore');
const mobileAppManager = require('../config/platform/mobileAppManager');
const { getTenantHostname, getTenantBaseDomain } = require('../config/platform/tenantUrls');

const router = express.Router();

router.get('/', async (req, res) => {
    try {
        const tenants = await tenantStore.listTenants();
        const rows = mobileAppManager.listTenantRows(tenants);
        const flutter = await mobileAppManager.getFlutterStatus();
        res.render('platform/mobile/index', {
            title: 'Mobile App Management',
            rows,
            flutter,
            baseDomain: getTenantBaseDomain(),
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[management/mobile] index:', err);
        res.status(500).send('Gagal memuat halaman mobile app');
    }
});

router.get('/tenants/:id', async (req, res) => {
    try {
        const tenant = await tenantStore.getTenantById(req.params.id);
        if (!tenant) return res.status(404).send('Tenant tidak ditemukan');

        const cfg = mobileAppManager.getTenantConfig(tenant);
        const flutter = await mobileAppManager.getFlutterStatus();
        const ws = mobileAppManager.getTenantWorkspaceDir(tenant.subdomain);
        const envPath = path.join(ws, '.env');
        const envPreview = fs.existsSync(envPath)
            ? fs.readFileSync(envPath, 'utf8')
            : `API_URL=${cfg.apiUrl}\n`;

        let buildLog = '';
        const logPath = path.join(ws, 'logs', 'last-build.log');
        if (fs.existsSync(logPath)) {
            buildLog = fs.readFileSync(logPath, 'utf8').slice(-8000);
        }

        const outputFiles = [];
        const outputDir = path.join(ws, 'output');
        if (fs.existsSync(outputDir)) {
            outputFiles.push(...fs.readdirSync(outputDir).filter((f) => f.endsWith('.apk')).sort().reverse());
        }

        res.render('platform/mobile/tenant', {
            title: `Mobile App — ${tenant.name}`,
            tenant,
            cfg,
            flutter,
            hostname: getTenantHostname(tenant.subdomain),
            envPreview,
            buildLog,
            outputFiles,
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[management/mobile] tenant:', err);
        res.status(500).send('Gagal memuat konfigurasi mobile');
    }
});

router.post('/tenants/:id/save', async (req, res) => {
    try {
        const tenant = await tenantStore.getTenantById(req.params.id);
        if (!tenant) return res.redirect('/management/mobile-app?error=Tenant+tidak+ditemukan');

        mobileAppManager.saveTenantConfig(tenant, {
            appName: req.body.app_name,
            apiUrl: req.body.api_url,
            packageId: req.body.package_id,
            releaseNotes: req.body.release_notes,
        });

        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'mobile_app_config_saved',
            details: { tenantId: tenant.id, subdomain: tenant.subdomain },
            ip: req.ip,
        });

        return res.redirect(`/management/mobile-app/tenants/${tenant.id}?success=saved`);
    } catch (err) {
        return res.redirect(`/management/mobile-app/tenants/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/tenants/:id/generate', async (req, res) => {
    try {
        const tenant = await tenantStore.getTenantById(req.params.id);
        if (!tenant) return res.redirect('/management/mobile-app?error=Tenant+tidak+ditemukan');

        mobileAppManager.saveTenantConfig(tenant, {
            appName: req.body.app_name,
            apiUrl: req.body.api_url,
            packageId: req.body.package_id,
            releaseNotes: req.body.release_notes,
        });
        mobileAppManager.generateWorkspace(tenant);

        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'mobile_app_workspace_generated',
            details: { tenantId: tenant.id, subdomain: tenant.subdomain },
            ip: req.ip,
        });

        return res.redirect(`/management/mobile-app/tenants/${tenant.id}?success=generated`);
    } catch (err) {
        return res.redirect(`/management/mobile-app/tenants/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/tenants/:id/build', async (req, res) => {
    try {
        const tenant = await tenantStore.getTenantById(req.params.id);
        if (!tenant) return res.redirect('/management/mobile-app?error=Tenant+tidak+ditemukan');

        if (req.body.app_name || req.body.api_url) {
            mobileAppManager.saveTenantConfig(tenant, {
                appName: req.body.app_name,
                apiUrl: req.body.api_url,
                packageId: req.body.package_id,
                releaseNotes: req.body.release_notes,
            });
        }

        const result = await mobileAppManager.runBuild(tenant);

        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'mobile_app_build',
            details: {
                tenantId: tenant.id,
                subdomain: tenant.subdomain,
                ok: result.ok,
                pending: !!result.pending,
            },
            ip: req.ip,
        });

        if (result.ok) {
            return res.redirect(`/management/mobile-app/tenants/${tenant.id}?success=built&apk=${encodeURIComponent(result.apk || '')}`);
        }
        if (result.pending) {
            return res.redirect(`/management/mobile-app/tenants/${tenant.id}?success=generated&pending=1`);
        }
        return res.redirect(`/management/mobile-app/tenants/${tenant.id}?error=${encodeURIComponent(result.message)}`);
    } catch (err) {
        return res.redirect(`/management/mobile-app/tenants/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    }
});

router.get('/tenants/:id/download/:filename', async (req, res) => {
    try {
        const tenant = await tenantStore.getTenantById(req.params.id);
        if (!tenant) return res.status(404).send('Tenant tidak ditemukan');

        const filename = path.basename(req.params.filename);
        if (!filename.endsWith('.apk')) return res.status(400).send('File tidak valid');

        const filePath = path.join(mobileAppManager.getTenantWorkspaceDir(tenant.subdomain), 'output', filename);
        if (!fs.existsSync(filePath)) return res.status(404).send('APK tidak ditemukan');

        res.download(filePath, filename);
    } catch (err) {
        res.status(500).send('Gagal mengunduh APK');
    }
});

module.exports = router;
