/**
 * Guard untuk operasi yang menyentuh database RADIUS bersama (semua tenant).
 * Tenant admin TIDAK boleh backup penuh / restore / hapus orphan global.
 */
const { hasTenantContext } = require('../config/platform/tenantContext');

function canManageSharedRadius(req) {
    if (req?.session?.isPlatformAdmin) return true;
    // Host tanpa konteks tenant (mis. portal utama) + admin login
    if (!hasTenantContext() && req?.session?.isAdmin) return true;
    return false;
}

function requireSharedRadiusAdmin(req, res, next) {
    if (canManageSharedRadius(req)) return next();

    const msg =
        'Operasi ini mengubah database RADIUS bersama (semua tenant). ' +
        'Hanya platform admin yang diizinkan. Hubungi admin platform.';

    if (req.xhr || req.headers.accept?.includes('application/json') || req.path.startsWith('/api/')) {
        return res.status(403).json({ success: false, message: msg });
    }

    return res.redirect('/admin/radius?error=' + encodeURIComponent(msg));
}

module.exports = {
    canManageSharedRadius,
    requireSharedRadiusAdmin
};
