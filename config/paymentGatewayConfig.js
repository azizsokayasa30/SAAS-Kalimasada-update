const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('./logger');
const { ensureAppSettingsTable } = require('./radiusConfig');
const { getSettingsWithCache, deleteSetting } = require('./settingsManager');

const dbPath = path.join(__dirname, '../data/billing.db');

const DEFAULT_CONFIG = {
    active: 'midtrans',
    midtrans: {
        enabled: false,
        production: false,
        server_key: '',
        client_key: '',
        merchant_id: '',
        base_url: ''
    },
    xendit: {
        enabled: false,
        production: false,
        api_key: '',
        callback_token: '',
        base_url: ''
    },
    tripay: {
        enabled: false,
        production: false,
        api_key: '',
        private_key: '',
        merchant_code: '',
        base_url: ''
    },
    duitku: {
        enabled: false,
        production: false,
        merchant_code: '',
        api_key: '',
        base_url: '',
        expiry_period: 60,
        invoice_endpoint: '/webapi/api/merchant/v2/inquiry',
        default_method: 'VA'
    }
};

function normalizeBoolean(value, defaultValue = false) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'on' || value === '1') return true;
    if (value === 'false' || value === 'off' || value === '0') return false;
    return defaultValue;
}

function applyDefaults(rawConfig = {}) {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

    if (rawConfig && typeof rawConfig === 'object') {
        config.active = rawConfig.active || config.active;

        if (rawConfig.midtrans) {
            config.midtrans = {
                ...config.midtrans,
                ...rawConfig.midtrans,
                enabled: normalizeBoolean(rawConfig.midtrans.enabled, config.midtrans.enabled),
                production: normalizeBoolean(rawConfig.midtrans.production, config.midtrans.production)
            };
        }

        if (rawConfig.xendit) {
            config.xendit = {
                ...config.xendit,
                ...rawConfig.xendit,
                enabled: normalizeBoolean(rawConfig.xendit.enabled, config.xendit.enabled),
                production: normalizeBoolean(rawConfig.xendit.production, config.xendit.production)
            };
        }

        if (rawConfig.tripay) {
            config.tripay = {
                ...config.tripay,
                ...rawConfig.tripay,
                enabled: normalizeBoolean(rawConfig.tripay.enabled, config.tripay.enabled),
                production: normalizeBoolean(rawConfig.tripay.production, config.tripay.production)
            };
        }

        if (rawConfig.duitku) {
            config.duitku = {
                ...config.duitku,
                ...rawConfig.duitku,
                enabled: normalizeBoolean(rawConfig.duitku.enabled, config.duitku.enabled),
                production: normalizeBoolean(rawConfig.duitku.production, config.duitku.production)
            };
        }
    }

    return config;
}

async function loadFromSettingsJson() {
    try {
        const settings = getSettingsWithCache();
        if (settings && settings.payment_gateway) {
            const config = applyDefaults(settings.payment_gateway);
            // Remove legacy payment_gateway entry from settings.json
            deleteSetting('payment_gateway');
            return config;
        }
    } catch (error) {
        logger?.warn?.('[PAYMENT_GATEWAY_CONFIG] Failed to load legacy payment_gateway from settings.json:', error.message);
    }
    return null;
}

async function getPaymentGatewayConfig() {
    await ensureAppSettingsTable();

    return new Promise((resolve) => {
        const db = new sqlite3.Database(dbPath);
        db.get(
            'SELECT value FROM app_settings WHERE key = ? LIMIT 1',
            ['payment_gateway'],
            async (err, row) => {
                db.close();

                if (err) {
                    logger?.error?.('[PAYMENT_GATEWAY_CONFIG] Error loading payment gateway config:', err.message);
                }

                if (row && row.value) {
                    try {
                        const parsed = JSON.parse(row.value);
                        return resolve(applyDefaults(parsed));
                    } catch (parseError) {
                        logger?.error?.('[PAYMENT_GATEWAY_CONFIG] Failed to parse payment gateway config:', parseError.message);
                    }
                }

                const legacyConfig = await loadFromSettingsJson();
                if (legacyConfig) {
                    await savePaymentGatewayConfig(legacyConfig);
                    return resolve(legacyConfig);
                }

                resolve(applyDefaults());
            }
        );
    });
}

async function savePaymentGatewayConfig(config) {
    await ensureAppSettingsTable();

    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        const normalized = applyDefaults(config);
        db.run(
            `INSERT OR REPLACE INTO app_settings (key, value, updated_at)
             VALUES (?, ?, datetime('now','localtime'))`,
            ['payment_gateway', JSON.stringify(normalized)],
            (err) => {
                db.close();
                if (err) {
                    logger?.error?.('[PAYMENT_GATEWAY_CONFIG] Failed to save config:', err.message);
                    return reject(err);
                }
                // Ensure legacy entry removed
                deleteSetting('payment_gateway');
                resolve(normalized);
            }
        );
    });
}

async function setActivePaymentGateway(activeGateway) {
    const config = await getPaymentGatewayConfig();
    config.active = activeGateway || config.active;
    await savePaymentGatewayConfig(config);
    return config;
}

async function updatePaymentGatewayConfig(gateway, updates) {
    const config = await getPaymentGatewayConfig();
    if (!config[gateway]) {
        config[gateway] = {};
    }

    const merged = {
        ...config[gateway],
        ...updates
    };

    if ('enabled' in merged) {
        merged.enabled = normalizeBoolean(merged.enabled, config[gateway]?.enabled ?? false);
    }
    if ('production' in merged) {
        merged.production = normalizeBoolean(merged.production, config[gateway]?.production ?? false);
    }

    config[gateway] = merged;
    await savePaymentGatewayConfig(config);
    return merged;
}

module.exports = {
    getPaymentGatewayConfig,
    savePaymentGatewayConfig,
    setActivePaymentGateway,
    updatePaymentGatewayConfig,
    DEFAULT_CONFIG,
    applyDefaults
};

