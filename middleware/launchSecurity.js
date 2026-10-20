'use strict';

const helmet = require('helmet');
const logger = require('../config/logger');

const BLOCKED_ROUTES = [
    /^\/admin\/test\/?$/i,
    /^\/admin\/debug(\/|$)/i,
    /^\/voucher\/test\/?$/i,
    /^\/customer\/trouble\/test\/?$/i,
    /^\/technician\/api\/test-mapping-data\/?$/i,
    /^\/teknisi\/api\/test-mapping-data\/?$/i,
];

const loginBuckets = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX = 12;

function normalizePath(raw) {
    let value = String(raw || '');
    try {
        value = decodeURIComponent(value);
    } catch (_) {
        /* path rusak tetap diblokir di bawah */
    }
    return value.toLowerCase();
}

function isSensitiveRequest(req) {
    const pathName = normalizePath(req.path);
    if (!pathName || pathName.includes('..') || pathName.includes('\\') || pathName.includes('\0')) {
        return true;
    }
    if (BLOCKED_ROUTES.some((pattern) => pattern.test(pathName))) return true;
    if (/\/(\.env|\.git|settings\.json|ecosystem\.config|docker-compose\.yml)(\/|$)/.test(pathName)) {
        return true;
    }
    if (/\.(db|sqlite|sqlite3|bak|pem|env)$/.test(pathName)) return true;
    return false;
}

function isLoginAttempt(req) {
    if (req.method !== 'POST') return false;
    const pathName = String(req.path || '');
    return pathName === '/login'
        || pathName.endsWith('/login')
        || pathName.endsWith('/login/mobile')
        || pathName.includes('/request-otp')
        || pathName.includes('/auth/login');
}

function loginRateLimit(req, res, next) {
    if (!isLoginAttempt(req)) return next();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = loginBuckets.get(ip);
    if (!bucket || now - bucket.start > LOGIN_WINDOW_MS) {
        bucket = { start: now, count: 0 };
        loginBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (loginBuckets.size > 5000) {
        for (const [key, value] of loginBuckets) {
            if (now - value.start > LOGIN_WINDOW_MS) loginBuckets.delete(key);
        }
    }
    if (bucket.count > LOGIN_MAX) {
        const message = 'Terlalu banyak percobaan login. Tunggu beberapa menit lalu coba lagi.';
        res.setHeader('Retry-After', '600');
        if (req.xhr || String(req.headers.accept || '').includes('application/json') || String(req.headers['content-type'] || '').includes('application/json')) {
            return res.status(429).json({ success: false, message });
        }
        return res.status(429).type('text/plain').send(message);
    }
    return next();
}

function warnWeakSecrets() {
    if (process.env.NODE_ENV !== 'production') {
        logger.error('[SECURITY] NODE_ENV bukan production. Jangan jalankan server publik dalam mode development.');
    }
    try {
        const { getSetting } = require('../config/settingsManager');
        const sessionSecret = process.env.SESSION_SECRET || String(getSetting('session_secret', '') || '');
        const jwtSecret = process.env.JWT_SECRET || String(getSetting('jwt_secret', '') || '');
        if (!sessionSecret || sessionSecret.length < 24 || /ganti|kalimasada-billing-secret/i.test(sessionSecret)) {
            logger.error('[SECURITY] SESSION_SECRET kosong atau masih default. Isi string acak panjang di .env lalu restart PM2.');
        }
        if (!jwtSecret || jwtSecret.length < 24 || /alijaya-billing-secret|ganti/i.test(jwtSecret)) {
            logger.error('[SECURITY] JWT_SECRET kosong atau masih default. Isi string acak panjang di .env lalu restart PM2.');
        }
        const adminPassword = String(getSetting('admin_password', 'admin') || '');
        if (!adminPassword || adminPassword === 'admin' || (adminPassword.length < 8 && !adminPassword.startsWith('$2'))) {
            logger.error('[SECURITY] Password admin global masih default atau terlalu pendek. Ganti dari halaman pengaturan.');
        }
    } catch (err) {
        logger.warn('[SECURITY] Pemeriksaan rahasia dilewati:', err.message);
    }
}

function applyLaunchSecurity(app) {
    app.disable('x-powered-by');
    app.use(helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: false,
        originAgentCluster: false,
    }));
    app.use((req, res, next) => {
        if (isSensitiveRequest(req)) {
            return res.status(404).type('text/plain').send('Not found');
        }
        return next();
    });
    app.use(loginRateLimit);
    warnWeakSecrets();
}

function installSecurityErrorHandler(app) {
    app.use((err, req, res, next) => {
        if (res.headersSent) return next(err);
        const prod = process.env.NODE_ENV === 'production';
        const uploadError = err && (
            err.name === 'MulterError'
            || /unggah|gambar|file ditolak|ukuran file/i.test(String(err.message || ''))
        );
        const status = uploadError ? 400 : (Number(err.status || err.statusCode) || 500);
        if (status >= 500) {
            logger.error(`[SECURITY] ${req.method} ${req.path}: ${err.message}`);
        }
        const message = prod && status >= 500
            ? 'Terjadi kesalahan pada server.'
            : (err.message || 'Terjadi kesalahan');
        const wantsJson = req.xhr
            || String(req.path || '').startsWith('/api/')
            || String(req.headers.accept || '').includes('application/json')
            || String(req.headers['content-type'] || '').includes('application/json');
        if (wantsJson) {
            return res.status(status).json({ success: false, message });
        }
        return res.status(status).type('text/plain').send(message);
    });
}

module.exports = {
    applyLaunchSecurity,
    installSecurityErrorHandler,
};
