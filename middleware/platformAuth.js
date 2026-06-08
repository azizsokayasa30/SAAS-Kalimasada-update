'use strict';

function platformAuth(req, res, next) {
    if (req.session?.isPlatformAdmin) {
        return next();
    }
    if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    return res.redirect('/management/login');
}

function platformGuest(req, res, next) {
    if (req.session?.isPlatformAdmin) {
        return res.redirect('/management/dashboard');
    }
    return next();
}

module.exports = { platformAuth, platformGuest };
