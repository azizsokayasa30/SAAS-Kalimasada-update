const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const { checkLicenseStatus, activateLicense, generateLicenseKey } = require('../config/licenseManager');
const { getSettingsWithCache } = require('../config/settingsManager');
const { getVersionInfo, getVersionBadge } = require('../config/version-utils');

// GET: Halaman aktivasi license
router.get('/license', async (req, res) => {
    try {
        const licenseStatus = await checkLicenseStatus();
        const settings = getSettingsWithCache();
        
        res.render('admin/license', {
            licenseStatus,
            error: req.query.error || null,
            success: req.query.success || null,
            settings,
            versionInfo: getVersionInfo(),
            versionBadge: getVersionBadge()
        });
    } catch (error) {
        console.error('Error loading license page:', error);
        res.status(500).render('error', {
            message: 'Error loading license page',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// POST: Aktivasi license
router.post('/license/activate', async (req, res) => {
    try {
        const { license_key } = req.body;
        
        if (!license_key || license_key.trim() === '') {
            return res.redirect('/admin/license?error=License+key+tidak+boleh+kosong');
        }
        
        const result = await activateLicense(license_key.trim());
        
        if (result.success) {
            return res.redirect('/admin/license?success=License+berhasil+diaktivasi');
        } else {
            return res.redirect(`/admin/license?error=${encodeURIComponent(result.message)}`);
        }
    } catch (error) {
        console.error('Error activating license:', error);
        return res.redirect('/admin/license?error=Terjadi+kesalahan+saat+mengaktivasi+license');
    }
});

// GET: API untuk check license status
router.get('/license/status', async (req, res) => {
    try {
        const status = await checkLicenseStatus();
        res.json({ success: true, status });
    } catch (error) {
        console.error('Error checking license status:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET: Generate license key (untuk development/testing)
router.get('/license/generate', adminAuth, async (req, res) => {
    try {
        const key = generateLicenseKey();
        res.json({ success: true, license_key: key });
    } catch (error) {
        console.error('Error generating license key:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
