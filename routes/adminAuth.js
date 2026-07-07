const express = require('express');
const router = express.Router();
const { getSetting } = require('../config/settingsManager');
const { validateConfiguration, getValidationSummary, checkForDefaultSettings } = require('../config/configValidator');

// Cache untuk admin credentials (optional, untuk performance)
let adminCredentials = null;
let credentialsCacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 menit

function getAdminCredentials() {
  const now = Date.now();
  if (!adminCredentials || (now - credentialsCacheTime) > CACHE_DURATION) {
    adminCredentials = {
      username: getSetting('admin_username', 'admin'),
      password: getSetting('admin_password', 'admin')
    };
    credentialsCacheTime = now;
  }
  return adminCredentials;
}

// Middleware cek login admin
function adminAuth(req, res, next) {
  if (req.session && req.session.isAdmin) {
    const explicitTenant =
      req.query?.tenant ||
      req.get('X-Tenant') ||
      (req.body && req.body.tenant);
    if (req.tenantId && req.session.tenantId && Number(req.session.tenantId) !== Number(req.tenantId)) {
      if (explicitTenant) {
        req.session.tenantId = req.tenantId;
        if (req.tenant?.subdomain) req.session.tenantSubdomain = req.tenant.subdomain;
      } else {
        return req.session.destroy(() => {
          if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
            return res.status(403).json({ success: false, message: 'Sesi tidak valid untuk tenant ini.' });
          }
          return res.redirect('/login?error=tenant_session');
        });
      }
    } else if (req.tenantId) {
      req.session.tenantId = req.tenantId;
      if (req.tenant?.subdomain) req.session.tenantSubdomain = req.tenant.subdomain;
    }
    next();
  } else {
    // Check if this is an API request
    if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json') || ['DELETE', 'PUT', 'PATCH'].includes(req.method)) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
    } else {
      res.redirect('/login');
    }
  }
}

// GET: Halaman login admin
router.get('/login', async (req, res) => {
  res.redirect('/login');
});

// Test route untuk debugging
router.get('/test', (req, res) => {
  res.json({ message: 'Admin routes working!', timestamp: new Date().toISOString() });
});

// Route mobile login sudah dipindah ke app.js untuk menghindari konflik

// Route mobile login sudah dipindah ke app.js untuk menghindari konflik

// POST: Proses login admin - Optimized
router.post('/login', async (req, res) => {
  res.redirect('/login');
});

// GET: Redirect /admin to dashboard
router.get('/', (req, res) => {
  if (req.session && req.session.isAdmin) {
    res.redirect('/admin/dashboard');
  } else {
    res.redirect('/login');
  }
});

// GET: Logout admin
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = { router, adminAuth };
