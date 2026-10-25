'use strict';

const express = require('express');
const nms = require('../config/platform/nmsService');

const router = express.Router();

function sendError(res, err) {
    const status = err instanceof nms.NmsError && err.status ? err.status : 500;
    if (status >= 500) console.error('[nms]', err);
    return res.status(status).json({ success: false, message: err.message || 'Gagal memproses permintaan NMS' });
}

router.get('/', (req, res) => {
    res.redirect('/management/settings/api');
});

router.get('/api/connection', async (req, res) => {
    try {
        const connection = await nms.getPublicConnection();
        return res.json({ success: true, connection });
    } catch (err) {
        return sendError(res, err);
    }
});

router.post('/connection', async (req, res) => {
    try {
        const connection = await nms.saveConnection(req.body || {});
        return res.json({ success: true, connection, message: 'Koneksi NMS disimpan.' });
    } catch (err) {
        return sendError(res, err);
    }
});

router.post('/test', async (req, res) => {
    try {
        if (req.body && (req.body.baseUrl || req.body.token || req.body.timeoutMs || req.body.clearToken)) {
            await nms.saveConnection(req.body);
        }
        const result = await nms.testConnection();
        return res.json(result);
    } catch (err) {
        return res.json({ success: false, message: err.message || 'Uji koneksi gagal', health: null, devices: null });
    }
});

router.get('/api/devices', async (req, res) => {
    try {
        const devices = await nms.listDevices();
        return res.json({ success: true, devices });
    } catch (err) {
        return sendError(res, err);
    }
});

router.get('/api/devices/:id/catalog', async (req, res) => {
    try {
        const catalog = await nms.getDeviceCatalog(req.params.id);
        return res.json({ success: true, catalog });
    } catch (err) {
        return sendError(res, err);
    }
});

router.get('/api/tenants', async (req, res) => {
    try {
        const tenants = await nms.listTenantsForMapping();
        return res.json({ success: true, tenants });
    } catch (err) {
        return sendError(res, err);
    }
});

router.get('/api/routers', async (req, res) => {
    try {
        const routers = await nms.listRoutersForTenant(req.query.tenant_id);
        return res.json({ success: true, routers });
    } catch (err) {
        return sendError(res, err);
    }
});

router.get('/api/bindings', async (req, res) => {
    try {
        const bindings = await nms.listBindings();
        return res.json({ success: true, bindings });
    } catch (err) {
        return sendError(res, err);
    }
});

router.post('/api/bindings', async (req, res) => {
    try {
        const binding = await nms.createBinding(req.body || {});
        return res.json({ success: true, binding, message: 'Pemetaan graph disimpan.' });
    } catch (err) {
        return sendError(res, err);
    }
});

router.post('/api/bindings/:id', async (req, res) => {
    try {
        const binding = await nms.updateBinding(req.params.id, req.body || {});
        return res.json({ success: true, binding });
    } catch (err) {
        return sendError(res, err);
    }
});

router.delete('/api/bindings/:id', async (req, res) => {
    try {
        await nms.deleteBinding(req.params.id);
        return res.json({ success: true, message: 'Pemetaan dihapus dari portal.' });
    } catch (err) {
        return sendError(res, err);
    }
});

router.get('/api/dashboard', async (req, res) => {
    try {
        const data = await nms.loadManagementGraphs(req.query.range, req.query);
        return res.json(data);
    } catch (err) {
        console.error('[nms] dashboard', err);
        return res.json({ success: false, graphs: [], message: err.message || 'Gagal memuat graph MRTG' });
    }
});

module.exports = router;
