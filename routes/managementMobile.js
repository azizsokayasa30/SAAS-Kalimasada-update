'use strict';

const express = require('express');
const mobileAndroidBuild = require('../utils/mobileAndroidBuild');
const tenantStore = require('../config/platform/tenantStore');

const router = express.Router();

router.get('/', (req, res) => {
    res.render('platform/mobile/index', {
        title: 'Mobile App — Build & OTA',
        adminName: req.session.platformAdminName,
    });
});

router.get('/api/config', (req, res) => {
    try {
        const config = mobileAndroidBuild.readMobileBuildConfig();
        res.json({ success: true, data: config });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || 'Gagal membaca konfigurasi' });
    }
});

router.get('/api/readiness', (req, res) => {
    try {
        res.json({ success: true, data: mobileAndroidBuild.readBuildReadiness() });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || 'Gagal cek kesiapan' });
    }
});

router.post('/api/config', async (req, res) => {
    try {
        const body = req.body || {};
        const saved = mobileAndroidBuild.saveMobileBuildConfig({
            api_url: body.api_url,
            app_name: body.app_name,
            version_name: body.version_name,
            version_code: body.version_code,
            release_notes: body.release_notes,
            force_update: body.force_update === true || body.force_update === 'true' || body.force_update === 1,
            flutter_path: body.flutter_path,
            apk_file_name: body.apk_file_name,
            update_manifest: true,
        });

        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'mobile_app_config_saved',
            details: {
                version: `${saved.version_name}+${saved.version_code}`,
                api_url: saved.api_url,
            },
            ip: req.ip,
        });

        res.json({ success: true, message: 'Konfigurasi mobile tersimpan', data: saved });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message || 'Gagal menyimpan' });
    }
});

router.post('/api/keystore/bootstrap', async (req, res) => {
    try {
        const body = req.body || {};
        const status = mobileAndroidBuild.bootstrapKeystore({ force: body.force === true });
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'mobile_app_keystore_bootstrap',
            details: { sha256: status.sha256, matches: status.matches_production },
            ip: req.ip,
        });
        res.json({
            success: true,
            message: status.matches_production
                ? 'Keystore siap dipakai untuk build & OTA'
                : (status.message || 'Keystore diproses'),
            data: status,
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message || 'Gagal membuat keystore' });
    }
});

router.post('/api/keystore/adopt', async (req, res) => {
    try {
        const status = mobileAndroidBuild.adoptCurrentKeystoreAsBaseline();
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'mobile_app_keystore_adopted',
            details: { sha256: status.sha256 },
            ip: req.ip,
        });
        res.json({
            success: true,
            message: 'SHA keystore diadopsi sebagai baseline OTA server ini',
            data: status,
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message || 'Gagal mengadopsi keystore' });
    }
});

router.get('/api/build-status', (req, res) => {
    try {
        const status = mobileAndroidBuild.readBuildStatus();
        res.json({ success: true, data: status });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/build', async (req, res) => {
    try {
        const body = req.body || {};
        const readiness = mobileAndroidBuild.readBuildReadiness();
        if (!readiness.can_build) {
            const missing = readiness.items.filter((i) => !i.ready).map((i) => i.label);
            return res.status(400).json({
                success: false,
                message: 'Server belum siap build: ' + missing.join(', '),
                data: readiness,
            });
        }

        if (body.api_url || body.app_name || body.version_name) {
            mobileAndroidBuild.saveMobileBuildConfig({
                api_url: body.api_url,
                app_name: body.app_name,
                version_name: body.version_name,
                version_code: body.version_code,
                release_notes: body.release_notes,
                force_update: body.force_update,
                flutter_path: body.flutter_path,
                update_manifest: false,
            });
        }

        res.json({
            success: true,
            message: 'Build dimulai di server. Pantau log di bawah.',
            data: mobileAndroidBuild.readBuildStatus(),
        });

        setImmediate(() => {
            mobileAndroidBuild.startAndroidApkBuild(body).catch((err) => {
                console.error('[management/mobile] build failed:', err.message);
            });
        });

        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'mobile_app_build_started',
            details: {
                version: `${body.version_name || ''}+${body.version_code || ''}`,
            },
            ip: req.ip,
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message || 'Gagal memulai build' });
    }
});

router.post('/api/build-cancel', (req, res) => {
    const cancelled = mobileAndroidBuild.cancelActiveBuild();
    res.json({
        success: true,
        cancelled,
        message: cancelled ? 'Build dibatalkan' : 'Tidak ada build aktif',
    });
});

/** Legacy per-tenant routes — redirect ke halaman unified */
router.get('/tenants/:id', (req, res) => res.redirect('/management/mobile-app'));
router.get('/tenants/:id/download/:filename', (req, res) => res.redirect('/management/mobile-app'));
router.post('/tenants/:id/save', (req, res) => res.redirect('/management/mobile-app'));
router.post('/tenants/:id/generate', (req, res) => res.redirect('/management/mobile-app'));
router.post('/tenants/:id/build', (req, res) => res.redirect('/management/mobile-app'));

module.exports = router;
