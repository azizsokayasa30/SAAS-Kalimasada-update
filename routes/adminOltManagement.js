const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const oltService = require('../services/olt/OltService');
const OltRepository = require('../services/olt/repositories/OltRepository');
const logger = require('../config/logger');

const repository = new OltRepository();

function jsonError(res, error, status = 500) {
    logger.error('[admin-olt] error:', error);
    return res.status(status).json({ success: false, message: error.message, code: error.code });
}

router.get('/olt-management', adminAuth, async (req, res) => {
    try {
        const [dashboard, olts, profiles] = await Promise.all([
            oltService.getDashboard(),
            oltService.listOlts({}),
            oltService.listApiProfiles()
        ]);
        res.render('admin/olt-management/index', {
            title: 'OLT Management',
            page: 'olt-management',
            dashboard,
            olts,
            profiles
        });
    } catch (error) {
        res.status(500).render('error', { error: error.message, message: 'Failed to load OLT Management' });
    }
});

router.get('/olt-management/onus', adminAuth, async (req, res) => {
    try {
        const [onus, olts] = await Promise.all([
            oltService.listOnus(req.query),
            oltService.listOlts({})
        ]);
        res.render('admin/olt-management/onus', {
            title: 'ONU Management',
            page: 'onu-management',
            onus,
            olts,
            filters: req.query
        });
    } catch (error) {
        res.status(500).render('error', { error: error.message, message: 'Failed to load ONU Management' });
    }
});

router.get('/olt-management/:id', adminAuth, async (req, res) => {
    try {
        const [olt, onus] = await Promise.all([
            oltService.getOlt(req.params.id),
            oltService.listOnus({ olt_id: req.params.id, limit: 1000 })
        ]);
        if (!olt) return res.status(404).render('error', { error: 'OLT not found', message: 'OLT not found' });
        res.render('admin/olt-management/detail', {
            title: `OLT ${olt.name}`,
            page: 'olt-management',
            olt,
            onus
        });
    } catch (error) {
        res.status(500).render('error', { error: error.message, message: 'Failed to load OLT detail' });
    }
});

router.get('/api/olt-management/dashboard', adminAuth, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.getDashboard() });
    } catch (error) {
        jsonError(res, error);
    }
});

router.get('/api/olt-management/olts', adminAuth, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.listOlts(req.query) });
    } catch (error) {
        jsonError(res, error);
    }
});

router.post('/api/olt-management/olts', adminAuth, async (req, res) => {
    try {
        const olt = await oltService.createOlt(req.body);
        res.json({ success: true, data: olt });
    } catch (error) {
        jsonError(res, error, 400);
    }
});

router.put('/api/olt-management/olts/:id', adminAuth, async (req, res) => {
    try {
        const olt = await oltService.updateOlt(req.params.id, req.body);
        if (!olt) return res.status(404).json({ success: false, message: 'OLT not found' });
        res.json({ success: true, data: olt });
    } catch (error) {
        jsonError(res, error, 400);
    }
});

router.delete('/api/olt-management/olts/:id', adminAuth, async (req, res) => {
    try {
        await oltService.deleteOlt(req.params.id);
        res.json({ success: true });
    } catch (error) {
        jsonError(res, error);
    }
});

router.post('/api/olt-management/olts/:id/test', adminAuth, async (req, res) => {
    try {
        res.json(await oltService.testConnection(req.params.id));
    } catch (error) {
        jsonError(res, error);
    }
});

router.post('/api/olt-management/olts/:id/connect', adminAuth, async (req, res) => {
    try {
        res.json(await oltService.testConnection(req.params.id));
    } catch (error) {
        jsonError(res, error);
    }
});

router.post('/api/olt-management/olts/:id/disconnect', adminAuth, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.disconnect(req.params.id) });
    } catch (error) {
        jsonError(res, error);
    }
});

router.post('/api/olt-management/olts/:id/sync', adminAuth, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.enqueueSync(req.params.id, true) });
    } catch (error) {
        jsonError(res, error);
    }
});

router.get('/api/olt-management/sync-jobs/:id', adminAuth, async (req, res) => {
    try {
        const status = await repository.getSyncJobStatus(req.params.id);
        if (!status) return res.status(404).json({ success: false, message: 'Sync job not found' });
        res.json({ success: true, data: status });
    } catch (error) {
        jsonError(res, error);
    }
});

router.get('/api/olt-management/onus', adminAuth, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.listOnus(req.query) });
    } catch (error) {
        jsonError(res, error);
    }
});

router.get('/api/olt-management/onus/:id', adminAuth, async (req, res) => {
    try {
        const onu = await oltService.getOnu(req.params.id);
        if (!onu) return res.status(404).json({ success: false, message: 'ONU not found' });
        res.json({ success: true, data: onu });
    } catch (error) {
        jsonError(res, error);
    }
});

router.put('/api/olt-management/onus/:id', adminAuth, async (req, res) => {
    try {
        const onu = await oltService.updateOnu(req.params.id, req.body);
        if (!onu) return res.status(404).json({ success: false, message: 'ONU not found' });
        res.json({ success: true, data: onu });
    } catch (error) {
        jsonError(res, error, 400);
    }
});

router.post('/api/olt-management/onus/:id/enable', adminAuth, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.enableOnu(req.params.id) });
    } catch (error) {
        jsonError(res, error, error.code === 'unsupported_driver_operation' ? 422 : 500);
    }
});

router.post('/api/olt-management/onus/:id/disable', adminAuth, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.disableOnu(req.params.id) });
    } catch (error) {
        jsonError(res, error, error.code === 'unsupported_driver_operation' ? 422 : 500);
    }
});

router.post('/api/olt-management/onus/:id/reboot', adminAuth, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.rebootOnu(req.params.id) });
    } catch (error) {
        jsonError(res, error, error.code === 'unsupported_driver_operation' ? 422 : 500);
    }
});

router.post('/api/olt-management/onus/:id/unregister', adminAuth, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.unregisterOnu(req.params.id, req.body.confirmation) });
    } catch (error) {
        const status = ['unsupported_driver_operation', 'invalid_unregister_confirmation', 'missing_olt_cli_credentials'].includes(error.code) ? 422 : 500;
        jsonError(res, error, status);
    }
});

router.post('/api/olt-management/onus/:id/refresh', adminAuth, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.refreshOnu(req.params.id) });
    } catch (error) {
        jsonError(res, error);
    }
});

router.post('/api/olt-management/customers/:customerId/map-onu/:onuId', adminAuth, async (req, res) => {
    try {
        res.json({ success: true, data: await repository.mapCustomerToOnu(req.params.customerId, req.params.onuId) });
    } catch (error) {
        jsonError(res, error, 400);
    }
});

module.exports = router;
