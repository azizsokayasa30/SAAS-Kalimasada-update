/**
 * Konfigurasi Baileys WhatsApp Gateway (multi-tenant aware)
 */
const path = require('path');
const fs = require('fs');
const { getSetting } = require('./settingsManager');
const logger = require('./logger');

function normalizeTenantId(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Cek apakah Baileys enabled (global settings)
 * @returns {boolean}
 */
function isBaileysEnabled() {
    const setting = getSetting('baileys_enabled', 'false');
    if (typeof setting === 'boolean') return setting;
    if (typeof setting === 'string') return setting.toLowerCase() === 'true';
    return false;
}

function getBaseSessionPath() {
    const raw = getSetting('whatsapp_session_path', './whatsapp-session');
    return path.isAbsolute(raw) ? raw : path.resolve(__dirname, '..', raw);
}

/**
 * Session directory for a tenant (or legacy root when tenantId is null).
 * Tenant → whatsapp-session/tenant-{id}/
 * Legacy → whatsapp-session/
 */
function sessionPathFor(tenantId = null) {
    const base = getBaseSessionPath();
    const tid = normalizeTenantId(tenantId);
    if (!tid) return base;
    return path.join(base, `tenant-${tid}`);
}

function sessionKeyFor(tenantId = null) {
    const tid = normalizeTenantId(tenantId);
    return tid ? `tenant-${tid}` : 'legacy';
}

/**
 * True if any tenant selected Baileys as their WhatsApp provider.
 * @returns {Promise<boolean>}
 */
async function anyTenantUsesBaileys() {
    const ids = await listBaileysTenantIds();
    return ids.length > 0;
}

/**
 * List tenant IDs that use Baileys as active WhatsApp provider.
 * @returns {Promise<number[]>}
 */
async function listBaileysTenantIds() {
    try {
        const sqlite3 = require('sqlite3').verbose();
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        const rows = await new Promise((resolve, reject) => {
            db.all(
                `SELECT id FROM tenants
                 WHERE lower(coalesce(json_extract(settings, '$.whatsapp_active_provider'), '')) = 'baileys'
                    OR lower(coalesce(json_extract(settings, '$.whatsapp_primary_gateway'), '')) = 'baileys'`,
                (err, r) => (err ? reject(err) : resolve(r || []))
            );
        });
        await new Promise((resolve) => db.close(() => resolve()));
        return rows
            .map((r) => normalizeTenantId(r.id))
            .filter(Boolean);
    } catch (err) {
        logger.warn('⚠️ listBaileysTenantIds failed:', err.message);
        return [];
    }
}

/**
 * Dapatkan konfigurasi Baileys
 * @param {number|null} tenantId
 * @returns {object}
 */
function getBaileysConfig(tenantId = null) {
    return {
        enabled: isBaileysEnabled(),
        sessionPath: sessionPathFor(tenantId),
        baseSessionPath: getBaseSessionPath(),
        logLevel: getSetting('whatsapp_log_level', 'silent'),
        tenantId: normalizeTenantId(tenantId)
    };
}

function ensureSessionDir(tenantId = null) {
    const dir = sessionPathFor(tenantId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

module.exports = {
    isBaileysEnabled,
    anyTenantUsesBaileys,
    listBaileysTenantIds,
    getBaileysConfig,
    getBaseSessionPath,
    sessionPathFor,
    sessionKeyFor,
    normalizeTenantId,
    ensureSessionDir
};
