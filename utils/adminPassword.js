'use strict';

const bcrypt = require('bcrypt');

function isBcryptHash(value) {
    return /^\$2[aby]\$\d{2}\$/.test(String(value || ''));
}

async function verifyAdminPassword(plain, stored) {
    const input = String(plain || '');
    const saved = String(stored || '');
    if (!input || !saved) return false;
    if (isBcryptHash(saved)) {
        try {
            return await bcrypt.compare(input, saved);
        } catch (_) {
            return false;
        }
    }
    return input === saved;
}

async function hashAdminPassword(plain) {
    return bcrypt.hash(String(plain), 10);
}

/**
 * Password konfirmasi aksi sensitif (batalkan pembayaran, hapus data, dll.) — dipakai web & mobile.
 * Tenant: `super_admin_password` tenant bila diisi, selain itu password login admin tenant.
 * Tanpa tenant: pengaturan host (`super_admin_password` lalu `admin_password`).
 */
async function verifySuperAdminPassword(plain, req) {
    const submitted = String(plain ?? '').trim();
    if (!submitted) return false;

    let expected = '';
    let inTenant = false;
    try {
        const { getTenant, hasTenantContext } = require('../config/platform/tenantContext');
        const tenant = req?.tenant || (hasTenantContext() ? getTenant() : null);
        inTenant = Boolean(tenant);
        const settings = tenant?.settings && typeof tenant.settings === 'object' ? tenant.settings : null;
        if (settings) {
            const dedicated = String(settings.super_admin_password || '').trim();
            expected = dedicated || String(settings.admin_password || '').trim();
        }
        if (!expected && tenant) {
            expected = String(tenant.admin_password || '').trim();
        }
    } catch (_) {
        expected = '';
    }

    if (inTenant && !expected) return false;

    if (!expected) {
        const { getSetting } = require('../config/settingsManager');
        const dedicated = String(getSetting('super_admin_password', '') || '').trim();
        expected = dedicated || String(getSetting('admin_password', 'admin') || 'admin').trim();
    }

    return verifyAdminPassword(submitted, expected);
}

module.exports = {
    isBcryptHash,
    verifyAdminPassword,
    hashAdminPassword,
    verifySuperAdminPassword,
};
