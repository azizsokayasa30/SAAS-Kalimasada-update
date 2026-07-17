const express = require('express');
const router = express.Router();
const { verifyToken } = require('./auth');
const { 
    generateHotspotVouchers, 
    getActiveHotspotUsers, 
    getHotspotProfiles,
    getMikrotikConnectionForRouter,
    getUserAuthModeAsync,
    getHotspotProfilesRadius,
    getHotspotUsersRadius
} = require('../../config/mikrotik');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { tenantSqlFromRequest } = require('../../config/platform/tenantSqlHelpers');

const getDB = () => new sqlite3.Database(path.join(process.cwd(), 'data/billing.db'));

// API: POST /api/vouchers/generate
router.post('/generate', verifyToken, async (req, res) => {
    try {
        const { 
            router_id, 
            qty, 
            profile, 
            prefix, 
            length, 
            user_type, 
            limit_uptime, 
            limit_bytes, 
            validity 
        } = req.body;

        if (!qty || !profile) {
            return res.status(400).json({ success: false, message: 'Quantity and Profile are required' });
        }

        const authMode = await getUserAuthModeAsync();
        let routerObj = null;
        const t = tenantSqlFromRequest(req);

        if (authMode !== 'radius') {
            if (!router_id) {
                return res.status(400).json({ success: false, message: 'router_id is required in Mikrotik mode' });
            }
            const db = getDB();
            routerObj = await new Promise((resolve) => {
                db.get(`SELECT * FROM routers WHERE id = ?${t.and()}`, [router_id], (err, row) => {
                    db.close();
                    resolve(row || null);
                });
            });

            if (!routerObj) {
                return res.status(404).json({ success: false, message: 'Router not found' });
            }
        }

        const result = await generateHotspotVouchers({
            routerObj,
            qty: parseInt(qty),
            profile,
            prefix: prefix || '',
            length: parseInt(length) || 6,
            userType: user_type || 'vc',
            limitUptime: limit_uptime || null,
            limitBytes: limit_bytes || null,
            validity: validity || null
        });

        if (result.success) {
            res.json({ 
                success: true, 
                message: `${qty} vouchers generated successfully`,
                vouchers: result.vouchers
            });
        } else {
            res.status(500).json({ success: false, message: result.message });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// API: GET /api/vouchers/profiles
router.get('/profiles', verifyToken, async (req, res) => {
    try {
        const { router_id } = req.query;
        const authMode = await getUserAuthModeAsync();

        if (authMode === 'radius') {
            const result = await getHotspotProfilesRadius();
            return res.json(result);
        }

        const t = tenantSqlFromRequest(req);
        const db = getDB();
        const routers = await new Promise((resolve) => {
            db.all(`SELECT * FROM routers${t.where()}`, [], (err, rows) => {
                db.close();
                resolve(rows || []);
            });
        });

        let allProfiles = [];
        for (const r of routers) {
            if (router_id && parseInt(router_id) !== r.id) continue;
            try {
                const profileRes = await getHotspotProfiles(r);
                if (profileRes.success) {
                    allProfiles = allProfiles.concat(profileRes.data.map(p => ({ ...p, router_id: r.id, router_name: r.name })));
                }
            } catch (e) { /* skip failed routers */ }
        }

        res.json({ success: true, data: allProfiles });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
