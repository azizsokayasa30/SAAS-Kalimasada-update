'use strict';

const express = require('express');
const tenantStore = require('../config/platform/tenantStore');
const popService = require('../config/platform/popService');
const { platformAuth } = require('../middleware/platformAuth');

const router = express.Router();

router.use(platformAuth);

// ── Switch Manager (routes spesifik harus sebelum /:id) ──
router.get('/switches', async (req, res) => {
    try {
        const [switches, pops] = await Promise.all([
            popService.listSwitches(),
            popService.listPops(),
        ]);
        res.render('platform/pop/switches', {
            title: 'Switch Manager',
            active: 'pop-switches',
            popSection: 'switches',
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
        const [radiusServers, pops] = await Promise.all([
            popService.listRadiusServers(),
            popService.listPops(),
        ]);
        res.render('platform/pop/radius', {
            title: 'Radius Manager',
            active: 'pop-radius',
            popSection: 'radius',
            radiusServers,
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

router.post('/radius/:id/delete', async (req, res) => {
    try {
        await popService.deleteRadiusServer(req.params.id);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'pop_radius_deleted',
            details: { id: Number(req.params.id) },
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
            popSection: 'list',
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
