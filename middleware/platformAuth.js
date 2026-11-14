'use strict';

const ACTIVE_CHECK_TTL_MS = 15000;
const activeCache = new Map();

async function isAdminStillActive(adminId) {
    const id = Number(adminId);
    if (!id) return false;
    const cached = activeCache.get(id);
    if (cached && Date.now() - cached.at < ACTIVE_CHECK_TTL_MS) return cached.active;
    const tenantStore = require('../config/platform/tenantStore');
    const row = await tenantStore.dbGet('SELECT is_active FROM super_admins WHERE id = ?', [id]);
    const active = !!(row && Number(row.is_active) === 1);
    activeCache.set(id, { active, at: Date.now() });
    return active;
}

function denyPlatform(req, res) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    return res.redirect('/management/login');
}

async function platformAuth(req, res, next) {
    if (!req.session?.isPlatformAdmin) return denyPlatform(req, res);
    try {
        if (!(await isAdminStillActive(req.session.platformAdminId))) {
            delete req.session.isPlatformAdmin;
            delete req.session.platformAdminId;
            delete req.session.platformAdminEmail;
            delete req.session.platformAdminName;
            return req.session.save(() => denyPlatform(req, res));
        }
    } catch (err) {
        console.error('[platformAuth] cek status admin gagal:', err.message);
    }
    return next();
}

function platformGuest(req, res, next) {
    if (req.session?.isPlatformAdmin) {
        return res.redirect('/management/dashboard');
    }
    return next();
}

module.exports = { platformAuth, platformGuest };
