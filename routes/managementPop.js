'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const tenantStore = require('../config/platform/tenantStore');
const popService = require('../config/platform/popService');
const radiusManagerService = require('../config/platform/radiusManagerService');
const { backupRadius, restoreRadius, listBackups } = require('../utils/radiusBackup');
const { platformAuth } = require('../middleware/platformAuth');

const router = express.Router();

router.use(platformAuth);

const radiusBackupUpload = multer({
    dest: path.join(__dirname, '../temp/uploads'),
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter(req, file, cb) {
        const name = String(file.originalname || '').toLowerCase();
        if (
            file.mimetype === 'application/gzip' ||
            file.mimetype === 'application/x-gzip' ||
            file.mimetype === 'application/octet-stream' ||
            name.endsWith('.tar.gz') ||
            name.endsWith('.gz')
        ) {
            cb(null, true);
        } else {
            cb(new Error('Hanya file backup (.tar.gz) yang diizinkan'));
        }
    },
});

function safeRadiusBackupFilename(raw) {
    const base = path.basename(String(raw || ''));
    if (!base || base.includes('..') || !base.endsWith('.tar.gz')) {
        throw new Error('Nama file backup tidak valid');
    }
    return base;
}

async function assertLocalRadiusServer(id) {
    const server = await popService.getRadiusServerById(id);
    if (!server) throw new Error('Radius manager tidak ditemukan.');
    if (!radiusManagerService.isLocalRadiusHost(server.host)) {
        throw new Error('Backup/restore DB hanya untuk FreeRADIUS lokal di VPS ini.');
    }
    return server;
}

// ── Switch Manager (routes spesifik harus sebelum /:id) ──
router.get('/switches', async (req, res) => {
    try {
        const [switches, pops] = await Promise.all([
            popService.listSwitches(),
            popService.listPops(),
        ]);
        res.render('platform/pop/switches', {
            title: 'Switch Manager',
            active: 'settings-switches',
            settingsSection: 'switches',
            switches,
            pops,
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[management/pop] switches:', err);
        res.status(500).send('Error loading switches');
    }
});

router.post('/switches', async (req, res) => {
    try {
        const sw = await popService.createSwitch(req.body);
        try {
            await tenantStore.auditLog({
                actorType: 'SuperAdmin',
                actorId: req.session.platformAdminId,
                action: 'pop_switch_created',
                details: { id: sw.id, name: sw.name, pop_id: sw.pop_id },
                ip: req.ip,
            });
        } catch (auditErr) {
            console.warn('[management/pop] audit switch create:', auditErr.message);
        }
        res.redirect('/management/pop/switches?success=created');
    } catch (err) {
        console.error('[management/pop] create switch:', err);
        res.redirect(`/management/pop/switches?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/switches/:id', async (req, res) => {
    try {
        const sw = await popService.updateSwitch(req.params.id, req.body);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'pop_switch_updated',
            details: { id: sw.id, name: sw.name },
            ip: req.ip,
        });
        res.redirect('/management/pop/switches?success=updated');
    } catch (err) {
        res.redirect(`/management/pop/switches?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/switches/:id/delete', async (req, res) => {
    try {
        await popService.deleteSwitch(req.params.id);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'pop_switch_deleted',
            details: { id: Number(req.params.id) },
            ip: req.ip,
        });
        res.redirect('/management/pop/switches?success=deleted');
    } catch (err) {
        res.redirect(`/management/pop/switches?error=${encodeURIComponent(err.message)}`);
    }
});

// ── Radius Manager ──
router.get('/radius', async (req, res) => {
    try {
        const [{ servers, live }, pops, backups] = await Promise.all([
            radiusManagerService.listRadiusServersWithEngine(),
            popService.listPops(),
            listBackups().catch(() => []),
        ]);

        res.render('platform/pop/radius', {
            title: 'Radius Manager',
            active: 'settings-radius',
            settingsSection: 'radius',
            radiusServers: servers,
            radiusLive: live,
            radiusBackups: Array.isArray(backups) ? backups.slice(0, 8) : [],
            pops,
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[management/pop] radius:', err);
        res.status(500).send('Error loading radius managers');
    }
});

router.post('/radius', async (req, res) => {
    try {
        const server = await popService.createRadiusServer(req.body);
        try {
            await tenantStore.auditLog({
                actorType: 'SuperAdmin',
                actorId: req.session.platformAdminId,
                action: 'pop_radius_created',
                details: { id: server.id, name: server.name, pop_id: server.pop_id },
                ip: req.ip,
            });
        } catch (auditErr) {
            console.warn('[management/pop] audit radius create:', auditErr.message);
        }
        res.redirect('/management/pop/radius?success=created');
    } catch (err) {
        console.error('[management/pop] create radius:', err);
        res.redirect(`/management/pop/radius?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/radius/:id', async (req, res) => {
    try {
        const server = await popService.updateRadiusServer(req.params.id, req.body);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'pop_radius_updated',
            details: { id: server.id, name: server.name },
            ip: req.ip,
        });
        res.redirect('/management/pop/radius?success=updated');
    } catch (err) {
        res.redirect(`/management/pop/radius?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/radius/:id/restart', async (req, res) => {
    try {
        const { server, message } = await radiusManagerService.restartRadiusServerById(req.params.id);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'pop_radius_restarted',
            details: { id: server.id, name: server.name, host: server.host },
            ip: req.ip,
        });
        res.redirect(`/management/pop/radius?success=restarted&msg=${encodeURIComponent(message)}`);
    } catch (err) {
        res.redirect(`/management/pop/radius?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/radius/:id/test', async (req, res) => {
    try {
        const result = await radiusManagerService.testRadiusServerById(req.params.id);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message, checks: [] });
    }
});

router.get('/radius/:id/backup', async (req, res) => {
    try {
        const server = await assertLocalRadiusServer(req.params.id);
        const result = await backupRadius();
        if (!result?.success || !result.filePath) {
            return res.redirect(
                `/management/pop/radius?error=${encodeURIComponent(result?.message || 'Gagal membuat backup RADIUS')}`
            );
        }
        try {
            await tenantStore.auditLog({
                actorType: 'SuperAdmin',
                actorId: req.session.platformAdminId,
                action: 'pop_radius_backup',
                details: {
                    id: server.id,
                    name: server.name,
                    fileName: result.fileName,
                    size: result.size || null,
                },
                ip: req.ip,
            });
        } catch (_) {
            /* ignore */
        }
        return res.download(result.filePath, result.fileName, (err) => {
            if (err && !res.headersSent) {
                console.error('[management/pop] radius backup download:', err);
                res.redirect(
                    `/management/pop/radius?error=${encodeURIComponent('Gagal mengirim file backup')}`
                );
            }
        });
    } catch (err) {
        res.redirect(`/management/pop/radius?error=${encodeURIComponent(err.message)}`);
    }
});

router.get('/radius/backups/:filename', async (req, res) => {
    try {
        const fileName = safeRadiusBackupFilename(req.params.filename);
        const full = path.join(__dirname, '../backups/radius', fileName);
        if (!fs.existsSync(full)) {
            return res.redirect(
                `/management/pop/radius?error=${encodeURIComponent('File backup tidak ditemukan')}`
            );
        }
        return res.download(full, fileName);
    } catch (err) {
        res.redirect(`/management/pop/radius?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/radius/:id/restore', (req, res) => {
    radiusBackupUpload.single('backupFile')(req, res, async (uploadErr) => {
        const cleanupUpload = async () => {
            if (req.file?.path) {
                try {
                    await fs.promises.unlink(req.file.path);
                } catch (_) {
                    /* ignore */
                }
            }
        };
        try {
            if (uploadErr) {
                await cleanupUpload();
                return res.redirect(
                    `/management/pop/radius?error=${encodeURIComponent(uploadErr.message)}`
                );
            }
            const server = await assertLocalRadiusServer(req.params.id);
            const passwordOk = await radiusManagerService.verifyPlatformAdminPassword(
                req,
                req.body?.confirm_password
            );
            if (!passwordOk) {
                await cleanupUpload();
                return res.redirect(
                    `/management/pop/radius?error=${encodeURIComponent('Password konfirmasi salah. Restore dibatalkan.')}`
                );
            }
            if (!req.file) {
                return res.redirect(
                    `/management/pop/radius?error=${encodeURIComponent('Pilih file backup (.tar.gz) terlebih dahulu')}`
                );
            }

            const result = await restoreRadius(req.file.path);
            await cleanupUpload();

            if (!result?.success) {
                return res.redirect(
                    `/management/pop/radius?error=${encodeURIComponent(result?.message || 'Restore gagal')}`
                );
            }

            try {
                await tenantStore.auditLog({
                    actorType: 'SuperAdmin',
                    actorId: req.session.platformAdminId,
                    action: 'pop_radius_restore',
                    details: {
                        id: server.id,
                        name: server.name,
                        originalName: req.file.originalname || null,
                    },
                    ip: req.ip,
                });
            } catch (_) {
                /* ignore */
            }

            return res.redirect(
                `/management/pop/radius?success=restored&msg=${encodeURIComponent(result.message || 'Restore berhasil')}`
            );
        } catch (err) {
            await cleanupUpload();
            res.redirect(`/management/pop/radius?error=${encodeURIComponent(err.message)}`);
        }
    });
});

router.post('/radius/:id/delete', async (req, res) => {
    try {
        const passwordOk = await radiusManagerService.verifyPlatformAdminPassword(
            req,
            req.body?.confirm_password
        );
        if (!passwordOk) {
            return res.redirect(
                `/management/pop/radius?error=${encodeURIComponent('Password konfirmasi salah. Penghapusan dibatalkan.')}`
            );
        }
        const existing = await popService.getRadiusServerById(req.params.id);
        await popService.deleteRadiusServer(req.params.id);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'pop_radius_deleted',
            details: {
                id: Number(req.params.id),
                name: existing?.name || null,
                host: existing?.host || null,
            },
            ip: req.ip,
        });
        res.redirect('/management/pop/radius?success=deleted');
    } catch (err) {
        res.redirect(`/management/pop/radius?error=${encodeURIComponent(err.message)}`);
    }
});

// ── Daftar POP/CABANG ──
router.get('/', async (req, res) => {
    try {
        const pops = await popService.listPops();
        res.render('platform/pop/index', {
            title: 'Daftar POP/CABANG',
            active: 'pop-list',
            pops,
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[management/pop] list:', err);
        res.status(500).send('Error loading POP/CABANG');
    }
});

router.post('/', async (req, res) => {
    try {
        const pop = await popService.createPop(req.body);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'pop_created',
            details: { id: pop.id, code: pop.code },
            ip: req.ip,
        });
        res.redirect('/management/pop?success=created');
    } catch (err) {
        res.redirect(`/management/pop?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/:id', async (req, res) => {
    try {
        const pop = await popService.updatePop(req.params.id, req.body);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'pop_updated',
            details: { id: pop.id, code: pop.code },
            ip: req.ip,
        });
        res.redirect('/management/pop?success=updated');
    } catch (err) {
        res.redirect(`/management/pop?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/:id/delete', async (req, res) => {
    try {
        await popService.deletePop(req.params.id);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'pop_deleted',
            details: { id: Number(req.params.id) },
            ip: req.ip,
        });
        res.redirect('/management/pop?success=deleted');
    } catch (err) {
        res.redirect(`/management/pop?error=${encodeURIComponent(err.message)}`);
    }
});

module.exports = router;
