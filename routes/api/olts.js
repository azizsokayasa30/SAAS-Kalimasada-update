const express = require('express');
const router = express.Router();
const { verifyToken } = require('./auth');
const oltService = require('../../services/olt/OltService');

function handleError(res, error) {
    const status = error.code === 'unsupported_driver_operation' ? 422 : 500;
    res.status(status).json({ success: false, message: error.message, code: error.code });
}

router.get('/olts', verifyToken, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.listOlts(req.query) });
    } catch (error) {
        handleError(res, error);
    }
});

router.get('/olts/:id', verifyToken, async (req, res) => {
    try {
        const olt = await oltService.getOlt(req.params.id);
        if (!olt) return res.status(404).json({ success: false, message: 'OLT not found' });
        res.json({ success: true, data: olt });
    } catch (error) {
        handleError(res, error);
    }
});

router.get('/olts/:id/onus', verifyToken, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.listOnus({ ...req.query, olt_id: req.params.id }) });
    } catch (error) {
        handleError(res, error);
    }
});

router.post('/olts', verifyToken, async (req, res) => {
    try {
        res.status(201).json({ success: true, data: await oltService.createOlt(req.body) });
    } catch (error) {
        handleError(res, error);
    }
});

router.put('/olts/:id', verifyToken, async (req, res) => {
    try {
        const olt = await oltService.updateOlt(req.params.id, req.body);
        if (!olt) return res.status(404).json({ success: false, message: 'OLT not found' });
        res.json({ success: true, data: olt });
    } catch (error) {
        handleError(res, error);
    }
});

router.delete('/olts/:id', verifyToken, async (req, res) => {
    try {
        await oltService.deleteOlt(req.params.id);
        res.json({ success: true });
    } catch (error) {
        handleError(res, error);
    }
});

router.post('/olts/:id/sync', verifyToken, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.enqueueSync(req.params.id, true) });
    } catch (error) {
        handleError(res, error);
    }
});

router.get('/onus', verifyToken, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.listOnus(req.query) });
    } catch (error) {
        handleError(res, error);
    }
});

router.get('/onus/:id', verifyToken, async (req, res) => {
    try {
        const onu = await oltService.getOnu(req.params.id);
        if (!onu) return res.status(404).json({ success: false, message: 'ONU not found' });
        res.json({ success: true, data: onu });
    } catch (error) {
        handleError(res, error);
    }
});

router.post('/onus/:id/enable', verifyToken, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.enableOnu(req.params.id) });
    } catch (error) {
        handleError(res, error);
    }
});

router.post('/onus/:id/disable', verifyToken, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.disableOnu(req.params.id) });
    } catch (error) {
        handleError(res, error);
    }
});

router.post('/onus/:id/reboot', verifyToken, async (req, res) => {
    try {
        res.json({ success: true, data: await oltService.rebootOnu(req.params.id) });
    } catch (error) {
        handleError(res, error);
    }
});

module.exports = router;
