const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { verifyToken } = require('./auth');
const { tenantSqlFromRequest } = require('../../config/platform/tenantSqlHelpers');

const getDB = () => new sqlite3.Database(path.join(process.cwd(), 'data/billing.db'));

function getTenantRouter(db, id, req) {
    const t = tenantSqlFromRequest(req);
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM routers WHERE id = ?${t.and()}`, [id], (err, row) => {
            if (err) reject(err);
            else resolve(row || null);
        });
    });
}

// API: GET /api/routers
router.get('/', verifyToken, (req, res) => {
    const t = tenantSqlFromRequest(req);
    const db = getDB();
    const query = `SELECT id, name, nas_ip, location, pop FROM routers${t.where()} ORDER BY name`;

    db.all(query, [], (err, rows) => {
        db.close();
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json({ success: true, data: rows });
    });
});

// API: GET /api/routers/:id
router.get('/:id', verifyToken, async (req, res) => {
    const db = getDB();
    try {
        const row = await getTenantRouter(db, req.params.id, req);
        db.close();
        if (!row) {
            return res.status(404).json({ success: false, message: 'Router not found' });
        }
        res.json({ success: true, data: row });
    } catch (err) {
        db.close();
        return res.status(500).json({ success: false, message: err.message });
    }
});

// API: POST /api/routers/:id/reboot
router.post('/:id/reboot', verifyToken, async (req, res) => {
    try {
        const db = getDB();
        const routerObj = await getTenantRouter(db, req.params.id, req);
        db.close();

        if (!routerObj) {
            return res.status(404).json({ success: false, message: 'Router not found' });
        }

        const { getMikrotikConnectionForRouter } = require('../../config/mikrotik');
        const conn = await getMikrotikConnectionForRouter(routerObj);
        await conn.write('/system/reboot');

        res.json({ success: true, message: 'Router is rebooting...' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// API: POST /api/routers/:id/wifi
router.post('/:id/wifi', verifyToken, async (req, res) => {
    try {
        const { ssid, password, interface } = req.body;
        if (!ssid || !password) {
            return res.status(400).json({ success: false, message: 'SSID and Password are required' });
        }

        const db = getDB();
        const routerObj = await getTenantRouter(db, req.params.id, req);
        db.close();

        if (!routerObj) {
            return res.status(404).json({ success: false, message: 'Router not found' });
        }

        const { getMikrotikConnectionForRouter } = require('../../config/mikrotik');
        const conn = await getMikrotikConnectionForRouter(routerObj);

        const iface = interface || 'wlan1';

        await conn.write('/interface/wireless/set', [
            `=.id=${iface}`,
            `=ssid=${ssid}`
        ]);

        res.json({ success: true, message: `WiFi SSID updated to ${ssid}. (Password change may require security profile update)` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
