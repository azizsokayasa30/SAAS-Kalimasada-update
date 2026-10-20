/**
 * Middleware akses Manager Area:
 * - blockSettingsForAreaManager: tolak Settingan / payment-settings / restart
 */

const SETTINGS_PATH_PATTERNS = [
    /^\/admin\/settings(\/|$)/i,
    /^\/admin\/radius(\/|$)/i,
    /^\/admin\/connection-settings(\/|$)/i,
    /^\/admin\/genieacs-setting(\/|$)/i,
    /^\/admin\/cache(\/|$)/i,
    /^\/admin\/billing\/whatsapp-/i,
    /^\/admin\/billing\/email-settings(\/|$)/i,
    /^\/admin\/billing\/payment-settings(\/|$)/i,
    /^\/admin\/billing\/settings(\/|$)/i,
    /^\/admin\/area-managers(\/|$)/i,
];

function isSettingsPath(req) {
    const path = String(req.originalUrl || req.path || '').split('?')[0];
    return SETTINGS_PATH_PATTERNS.some((re) => re.test(path));
}

function isRestartRequest(req) {
    const path = String(req.originalUrl || req.path || '').split('?')[0];
    const bodyAction = String(req.body?.action || req.query?.action || '').toLowerCase();
    return /\/admin\/.*restart/i.test(path) || bodyAction === 'restart' || /restart-billing|restartsystem/i.test(path);
}

function wantsJson(req) {
    return (
        req.path.startsWith('/api/') ||
        (req.originalUrl || '').includes('/api/') ||
        req.headers.accept?.includes('application/json') ||
        String(req.headers['content-type'] || '').includes('application/json') ||
        ['DELETE', 'PUT', 'PATCH'].includes(req.method)
    );
}

function deny(req, res, message) {
    if (wantsJson(req)) {
        return res.status(403).json({ success: false, message });
    }
    return res.status(403).render('error', {
        message,
        error: {},
    });
}

/**
 * Blokir Manager Area dari Settingan aplikasi, payment gateway, restart, dan CRUD Manager Area.
 */
function blockSettingsForAreaManager(req, res, next) {
    if (!(req.session && req.session.isAreaManager) || req.session.isAdmin) {
        return next();
    }
    if (isSettingsPath(req) || isRestartRequest(req)) {
        return deny(req, res, 'Akses ditolak: Manager Area tidak dapat mengakses pengaturan aplikasi.');
    }
    return next();
}

/**
 * Helper: tambahkan area_ids ke filter objek jika requester adalah Manager Area.
 */
function applyAreaManagerCustomerFilter(req, filters = {}) {
    if (req.isAreaManager || (req.session && req.session.isAreaManager)) {
        const ids = req.areaManagerAreaIds;
        filters.area_ids = Array.isArray(ids) ? ids : [];
    }
    return filters;
}

module.exports = {
    blockSettingsForAreaManager,
    applyAreaManagerCustomerFilter,
    isSettingsPath,
};
