'use strict';

const express = require('express');
const multer = require('multer');
const masterPackageService = require('../config/platform/masterPackageService');
const masterPackageBackup = require('../config/platform/masterPackageBackup');
const tenantStore = require('../config/platform/tenantStore');
const { platformAuth } = require('../middleware/platformAuth');
const { formatRupiah } = require('../config/platform/formatRupiah');

const router = express.Router();

const BASE_PATH = '/management/settings/packages';

function packagesUrl(query = '') {
    return `${BASE_PATH}${query ? (query.startsWith('?') ? query : `?${query}`) : ''}`;
}

const restoreUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter(req, file, cb) {
        const name = String(file.originalname || '').toLowerCase();
        if (name.endsWith('.json')) cb(null, true);
        else cb(new Error('Hanya file JSON backup yang diizinkan'));
    },
});

router.use(platformAuth);

router.use((req, res, next) => {
    res.locals.formatRupiah = formatRupiah;
    next();
});

router.get('/', async (req, res) => {
    try {
        const packages = await masterPackageService.listMasterPackages({ includeInactive: true });
        const backups = masterPackageBackup.listMasterPackageBackups();
        res.render('platform/master-packages/index', {
            title: 'Master Paket',
            active: 'settings-packages',
            settingsSection: 'packages',
            basePath: BASE_PATH,
            packages,
            backups,
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[platform] master packages:', err);
        res.status(500).send('Error loading master packages');
    }
});

router.get('/backup/download', async (req, res) => {
    try {
        const { payload, filename } = await masterPackageBackup.exportMasterPackagesBackup();
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'master_package_backup',
            details: { filename, package_count: payload.package_count },
            ip: req.ip,
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(JSON.stringify(payload, null, 2));
    } catch (err) {
        console.error('[platform] master package backup:', err);
        res.redirect(packagesUrl(`error=${encodeURIComponent(err.message)}`));
    }
});

router.get('/backup/file/:filename', async (req, res) => {
    try {
        const full = masterPackageBackup.getBackupFilePath(req.params.filename);
        res.download(full);
    } catch (err) {
        res.status(404).send(err.message);
    }
});

router.post('/backup/restore', (req, res) => {
    restoreUpload.single('backup_file')(req, res, async (uploadErr) => {
        try {
            if (uploadErr) {
                return res.redirect(packagesUrl(`error=${encodeURIComponent(uploadErr.message)}`));
            }
            if (!req.file) {
                return res.redirect(packagesUrl('error=' + encodeURIComponent('Pilih file backup JSON terlebih dahulu')));
            }

            let payload;
            try {
                payload = masterPackageBackup.validateBackupPayload(JSON.parse(req.file.buffer.toString('utf8')));
            } catch (parseErr) {
                return res.redirect(packagesUrl(`error=${encodeURIComponent(parseErr.message)}`));
            }

            const mode = req.body.mode === 'merge' ? 'merge' : 'replace';
            const result = await masterPackageBackup.restoreMasterPackagesBackup(payload, { mode });

            await tenantStore.auditLog({
                actorType: 'SuperAdmin',
                actorId: req.session.platformAdminId,
                action: 'master_package_restore',
                details: { mode, ...result },
                ip: req.ip,
            });

            res.redirect(packagesUrl(`success=restored&count=${result.restored_packages}`));
        } catch (err) {
            console.error('[platform] master package restore upload:', err);
            res.redirect(packagesUrl(`error=${encodeURIComponent(err.message)}`));
        }
    });
});

router.post('/backup/restore/:filename', async (req, res) => {
    try {
        const payload = masterPackageBackup.readBackupFile(req.params.filename);
        const mode = req.body.mode === 'merge' ? 'merge' : 'replace';
        const result = await masterPackageBackup.restoreMasterPackagesBackup(payload, { mode });

        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'master_package_restore',
            details: { source: req.params.filename, mode, ...result },
            ip: req.ip,
        });

        res.redirect(packagesUrl(`success=restored&count=${result.restored_packages}`));
    } catch (err) {
        console.error('[platform] master package restore file:', err);
        res.redirect(packagesUrl(`error=${encodeURIComponent(err.message)}`));
    }
});

router.post('/', async (req, res) => {
    try {
        const pkg = await masterPackageService.createMasterPackage(req.body);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'master_package_created',
            details: { id: pkg.id, name: pkg.name },
            ip: req.ip,
        });
        res.redirect(packagesUrl('success=created'));
    } catch (err) {
        res.redirect(packagesUrl(`error=${encodeURIComponent(err.message)}`));
    }
});

router.post('/:id', async (req, res) => {
    try {
        const pkg = await masterPackageService.updateMasterPackage(req.params.id, req.body);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'master_package_updated',
            details: { id: pkg.id, name: pkg.name },
            ip: req.ip,
        });
        res.redirect(packagesUrl('success=updated'));
    } catch (err) {
        res.redirect(packagesUrl(`error=${encodeURIComponent(err.message)}`));
    }
});

router.post('/:id/delete', async (req, res) => {
    try {
        await masterPackageService.deleteMasterPackage(req.params.id);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'master_package_deleted',
            details: { id: Number(req.params.id) },
            ip: req.ip,
        });
        res.redirect(packagesUrl('success=deleted'));
    } catch (err) {
        res.redirect(packagesUrl(`error=${encodeURIComponent(err.message)}`));
    }
});

module.exports = router;
