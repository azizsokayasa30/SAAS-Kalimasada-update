'use strict';

/**
 * Compat shim: isolasi Baileys sekarang via sesi per-tenant (registry).
 * Soft-lock owner global tidak lagi memblokir kirim antar tenant.
 */
const fs = require('fs');
const path = require('path');
const { getSetting } = require('./settingsManager');
const { normalizeTenantId, sessionPathFor, getBaseSessionPath } = require('./baileys-config');
const logger = require('./logger');

function getOwnerFilePath() {
    return path.join(getBaseSessionPath(), 'owner-tenant.json');
}

function getOwnerTenantId() {
    // Prefer registry-connected tenant if only one; else legacy file (post-migration usually absent)
    try {
        const registry = require('./baileys-session-registry');
        const active = registry.listActive().filter((a) => a.tenantId);
        if (active.length === 1) return active[0].tenantId;
    } catch (_) { /* ignore */ }

    if (typeof global !== 'undefined' && global.baileysOwnerTenantId != null) {
        return normalizeTenantId(global.baileysOwnerTenantId);
    }
    try {
        const file = getOwnerFilePath();
        if (!fs.existsSync(file)) return null;
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return normalizeTenantId(raw && raw.tenantId);
    } catch (_) {
        return null;
    }
}

function setOwnerTenantId(tenantId, meta = {}) {
    const id = normalizeTenantId(tenantId);
    if (!id) return null;
    if (typeof global !== 'undefined') {
        global.baileysOwnerTenantId = id;
        global.__pendingBaileysOwnerTenantId = null;
    }
    try {
        const dir = sessionPathFor(id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'owner-tenant.json'),
            JSON.stringify({
                tenantId: id,
                claimedAt: new Date().toISOString(),
                ...meta
            }, null, 2),
            'utf8'
        );
    } catch (err) {
        logger.warn('⚠️ setOwnerTenantId meta failed:', err.message);
    }
    return id;
}

function clearOwnerTenantId(reason = '') {
    if (typeof global !== 'undefined') {
        global.baileysOwnerTenantId = null;
        global.__pendingBaileysOwnerTenantId = null;
    }
    try {
        const file = getOwnerFilePath();
        if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (_) { /* ignore */ }
    if (reason) logger.info(`🔓 Baileys legacy owner cleared (${reason})`);
}

function setPendingOwnerTenantId(tenantId) {
    const id = normalizeTenantId(tenantId);
    if (typeof global !== 'undefined') global.__pendingBaileysOwnerTenantId = id;
    return id;
}

function getPendingOwnerTenantId() {
    if (typeof global === 'undefined') return null;
    return normalizeTenantId(global.__pendingBaileysOwnerTenantId);
}

function commitPendingOwnerOnConnect() {
    const pending = getPendingOwnerTenantId();
    if (pending) return setOwnerTenantId(pending, { source: 'connect_open' });
    return getOwnerTenantId();
}

/** Multi-tenant sessions: setiap tenant boleh memakai sesi miliknya sendiri. */
function canTenantUseBaileysSession(tenantId) {
    const tid = normalizeTenantId(tenantId);
    if (!tid) return { allowed: true, ownerTenantId: null };
    return { allowed: true, ownerTenantId: tid };
}

function canTenantClaimOrUseBaileysConnect(tenantId, _isConnected) {
    const tid = normalizeTenantId(tenantId);
    if (!tid) return { allowed: true, ownerTenantId: null };
    return { allowed: true, ownerTenantId: tid };
}

module.exports = {
    normalizeTenantId,
    getOwnerTenantId,
    setOwnerTenantId,
    clearOwnerTenantId,
    setPendingOwnerTenantId,
    getPendingOwnerTenantId,
    commitPendingOwnerOnConnect,
    canTenantUseBaileysSession,
    canTenantClaimOrUseBaileysConnect,
    getOwnerFilePath
};
