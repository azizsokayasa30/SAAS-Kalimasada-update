const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('./logger');

const dbPath = path.join(__dirname, '../data/billing.db');

const RADIUS_KEYS = [
    'user_auth_mode',
    'radius_host',
    'radius_user',
    'radius_password',
    'radius_database',
];

const DEFAULTS = {
    user_auth_mode: 'radius',
    radius_host: 'localhost',
    radius_user: 'radius',
    radius_password: 'radius',
    radius_database: 'radius',
};

function withDefaults(config = {}) {
    return {
        user_auth_mode: config.user_auth_mode || DEFAULTS.user_auth_mode,
        radius_host: config.radius_host || DEFAULTS.radius_host,
        radius_user: config.radius_user || DEFAULTS.radius_user,
        radius_password: config.radius_password || DEFAULTS.radius_password,
        radius_database: config.radius_database || DEFAULTS.radius_database,
    };
}

function getActiveTenantId() {
    try {
        const { hasTenantContext, getTenantId } = require('./platform/tenantContext');
        if (hasTenantContext()) return getTenantId();
    } catch (_) {
        /* ignore */
    }
    return null;
}

function invalidateTenantSettingsCache(tenantId, payload = null) {
    try {
        const { invalidateEnrichedSettingsCache } = require('../middleware/resolveTenant');
        if (typeof invalidateEnrichedSettingsCache === 'function') {
            invalidateEnrichedSettingsCache(tenantId);
        }
    } catch (_) {
        /* ignore */
    }
    try {
        const { getTenant } = require('./platform/tenantContext');
        const tenant = getTenant();
        if (tenant && Number(tenant.id) === Number(tenantId) && tenant.settings && payload) {
            Object.assign(tenant.settings, payload);
        }
    } catch (_) {
        /* ignore */
    }
}

// Ensure app_settings table exists
function ensureAppSettingsTable() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        db.run(`
            CREATE TABLE IF NOT EXISTS app_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT UNIQUE NOT NULL,
                value TEXT,
                created_at DATETIME DEFAULT (datetime('now','localtime')),
                updated_at DATETIME DEFAULT (datetime('now','localtime'))
            )
        `, (err) => {
            db.close();
            if (err) reject(err);
            else resolve();
        });
    });
}

async function getRadiusConfigFromTenant(tenantId) {
    const { getFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
    const settings = await getFullSettingsForTenantId(tenantId);
    const config = {};
    for (const key of RADIUS_KEYS) {
        if (settings[key] !== undefined && settings[key] !== null && settings[key] !== '') {
            config[key] = settings[key];
        }
    }
    return withDefaults(config);
}

async function saveRadiusConfigToTenant(tenantId, config) {
    const { saveFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
    const payload = withDefaults(config);
    const merged = await saveFullSettingsForTenantId(tenantId, payload);
    invalidateTenantSettingsCache(tenantId, payload);
    return merged;
}

// Get radius configuration (tenant settings first, fallback app_settings)
async function getRadiusConfig() {
    const tenantId = getActiveTenantId();
    if (tenantId) {
        try {
            return await getRadiusConfigFromTenant(tenantId);
        } catch (err) {
            logger.warn(`Error getting radius config for tenant #${tenantId}: ${err.message}`);
        }
    }

    await ensureAppSettingsTable();

    return new Promise((resolve) => {
        const db = new sqlite3.Database(dbPath);
        const config = {};

        db.all(
            `SELECT key, value FROM app_settings WHERE key IN (?, ?, ?, ?, ?)`,
            RADIUS_KEYS,
            (err, rows) => {
                db.close();

                if (err) {
                    logger.error(`Error getting radius config from database: ${err.message}`);
                    resolve(withDefaults());
                    return;
                }

                (rows || []).forEach((row) => {
                    config[row.key] = row.value;
                });

                resolve(withDefaults(config));
            }
        );
    });
}

// Save radius configuration to tenant settings or global app_settings
async function saveRadiusConfig(config) {
    const tenantId = getActiveTenantId();
    if (tenantId) {
        await saveRadiusConfigToTenant(tenantId, config);
        logger.info(`Radius configuration saved for tenant #${tenantId}`);
        return true;
    }

    await ensureAppSettingsTable();

    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        const normalized = withDefaults(config);
        const entries = RADIUS_KEYS.map((key) => [key, normalized[key]]);

        db.serialize(() => {
            db.run('BEGIN TRANSACTION');

            entries.forEach(([key, value]) => {
                db.run(
                    `INSERT OR REPLACE INTO app_settings (key, value, updated_at)
                     VALUES (?, ?, datetime('now','localtime'))`,
                    [key, value],
                    (err) => {
                        if (err) {
                            logger.error(`Error saving ${key} to database: ${err.message}`);
                        }
                    }
                );
            });

            db.run('COMMIT', (err) => {
                db.close();
                if (err) {
                    logger.error(`Error committing radius config: ${err.message}`);
                    reject(err);
                } else {
                    logger.info('Radius configuration saved to database successfully');
                    resolve(true);
                }
            });
        });
    });
}

// Get single radius config value
async function getRadiusConfigValue(key, defaultValue = null) {
    const tenantId = getActiveTenantId();
    if (tenantId) {
        try {
            const config = await getRadiusConfigFromTenant(tenantId);
            if (config[key] !== undefined && config[key] !== null && config[key] !== '') {
                return config[key];
            }
            return defaultValue;
        } catch (_) {
            return defaultValue;
        }
    }

    await ensureAppSettingsTable();

    return new Promise((resolve) => {
        const db = new sqlite3.Database(dbPath);

        db.get(
            'SELECT value FROM app_settings WHERE key = ?',
            [key],
            (err, row) => {
                db.close();

                if (err || !row) {
                    resolve(defaultValue);
                } else {
                    resolve(row.value || defaultValue);
                }
            }
        );
    });
}

module.exports = {
    getRadiusConfig,
    saveRadiusConfig,
    getRadiusConfigValue,
    ensureAppSettingsTable,
    DEFAULTS,
};
