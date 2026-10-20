const express = require('express');
const router = express.Router();
const { getSetting } = require('../config/settingsManager');
const { validateConfiguration, getValidationSummary, checkForDefaultSettings } = require('../config/configValidator');
const billingManager = require('../config/billing');

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

function isAdminSession(req) {
  return !!(req.session && req.session.isAdmin);
}

function isAreaManagerSession(req) {
  return !!(req.session && req.session.isAreaManager && req.session.areaManagerId);
}

function hasAdminPanelAccess(req) {
  return isAdminSession(req) || isAreaManagerSession(req);
}

async function attachAreaManagerContext(req, res) {
  if (!isAreaManagerSession(req)) {
    req.isAreaManager = false;
    if (res && res.locals) {
      res.locals.isAreaManager = false;
      res.locals.isFullAdmin = isAdminSession(req);
      res.locals.executiveJabatan = (req.session && req.session.executiveJabatan) || '';
      res.locals.executiveName = (req.session && req.session.executiveName) || '';
    }
    return;
  }
  const tenantId = req.session.tenantId || req.tenantId || null;
  const areaIds = await billingManager.getAreaManagerAreaIds(req.session.areaManagerId, tenantId);
  req.isAreaManager = true;
  req.areaManagerId = req.session.areaManagerId;
  req.areaManagerAreaIds = areaIds;
  if (res && res.locals) {
    res.locals.isAreaManager = true;
    res.locals.isFullAdmin = false;
    res.locals.areaManagerName = req.session.areaManagerName || '';
    res.locals.areaManagerAreaIds = areaIds;
    res.locals.executiveJabatan = '';
    res.locals.executiveName = '';
  }
}

// Middleware cek login admin ATAU Manager Area
function adminAuth(req, res, next) {
  if (!hasAdminPanelAccess(req)) {
    const wantsJson =
      req.path.startsWith('/api/') ||
      req.headers.accept?.includes('application/json') ||
      String(req.headers['content-type'] || '').includes('application/json') ||
      ['DELETE', 'PUT', 'PATCH'].includes(req.method);
    if (wantsJson) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    return res.redirect('/login');
  }

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

  attachAreaManagerContext(req, res)
    .then(() => next())
    .catch((err) => {
      console.error('adminAuth area manager context:', err);
      next(err);
    });
}

/** Hanya admin utama (bukan Manager Area). */
function requireFullAdmin(req, res, next) {
  if (isAdminSession(req) && !isAreaManagerSession(req)) {
    return next();
  }
  const wantsJson =
    req.path.startsWith('/api/') ||
    req.headers.accept?.includes('application/json') ||
    String(req.headers['content-type'] || '').includes('application/json') ||
    ['DELETE', 'PUT', 'PATCH'].includes(req.method);
  if (wantsJson) {
    return res.status(403).json({
      success: false,
      message: 'Akses ditolak: hanya Admin utama yang diizinkan.',
    });
  }
  return res.status(403).render('error', {
    message: 'Akses ditolak: hanya Admin utama yang diizinkan.',
    error: {},
  });
}

// GET: Halaman login admin
router.get('/login', async (req, res) => {
  res.redirect('/login');
});

// POST: Proses login admin - Optimized
router.post('/login', async (req, res) => {
  res.redirect('/login');
});

// GET: Redirect /admin to dashboard
router.get('/', (req, res) => {
  if (hasAdminPanelAccess(req)) {
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

module.exports = {
  router,
  adminAuth,
  requireFullAdmin,
  hasAdminPanelAccess,
  isAdminSession,
  isAreaManagerSession,
};
