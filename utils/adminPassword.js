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

module.exports = {
    isBcryptHash,
    verifyAdminPassword,
    hashAdminPassword,
};
