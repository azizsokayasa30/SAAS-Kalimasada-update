const express = require('express');
const router = express.Router();
const { getSetting } = require('../config/settingsManager');

function jsonAfterSessionSave(req, res, payload) {
    req.session.save((err) => {
        if (err) {
            console.error('Unified login session save failed:', err);
            return res.status(500).json({ success: false, message: 'Gagal menyimpan sesi. Silakan coba lagi.' });
        }
        res.json(payload);
    });
}

// GET: Unified Login Page
router.get('/', async (req, res) => {
    try {
        const logoFilename = getSetting('logo_filename', 'logo.png');
        const companyHeader = getSetting('company_header', 'Billing System');
        const appSettings = {
            logo_filename: logoFilename,
            company_header: companyHeader,
            company_name: getSetting('company_name', 'Billing System'),
            footer_info: getSetting('footer_info', '© 2025 CV Lintas Multimedia'),
            contact_phone: getSetting('contact_phone', ''),
        };

        res.render('login-unified', {
            appSettings,
            timedOut: req.query.timeout === '1',
            error: null,
            success: null
        });
    } catch (error) {
        console.error('Error rendering unified login:', error);
        res.status(500).send('Internal Server Error');
    }
});

// POST: Unified Login Process
router.post('/', async (req, res) => {
    const { username, password } = req.body;

    try {
        const adminUsername = getSetting('admin_username', 'admin');
        const adminPassword = getSetting('admin_password', 'admin');

        if (username === adminUsername && password === adminPassword) {
            req.session.isAdmin = true;
            req.session.adminUser = username;
            req.session.lastActivityAt = Date.now();
            return jsonAfterSessionSave(req, res, { success: true, redirect: '/admin/dashboard' });
        }

        return res.status(401).json({ success: false, message: 'Username atau password admin tidak valid' });

    } catch (error) {
        console.error('Unified login error:', error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem' });
    }
});

module.exports = router;
