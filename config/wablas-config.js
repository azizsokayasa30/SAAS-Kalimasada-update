/**
 * Konfigurasi Wablas API
 */
const { getSetting } = require('./settingsManager');
const logger = require('./logger');

const DEFAULT_API_URL = 'https://bdg.wablas.com';

function toBool(setting) {
    if (typeof setting === 'boolean') return setting;
    if (typeof setting === 'string') return setting.toLowerCase() === 'true';
    return false;
}

/**
 * Bangun config Wablas dari object settings (tenant / flat keys / nested wablas).
 * @param {object} source
 * @returns {object}
 */
function getWablasConfigFromObject(source = {}) {
    const nested = source.wablas && typeof source.wablas === 'object' ? source.wablas : {};
    const apiKey = nested.apiKey != null
        ? nested.apiKey
        : (source.wablas_api_key != null ? source.wablas_api_key : '');
    const secretKey = nested.secretKey != null
        ? nested.secretKey
        : (source.wablas_secret_key != null ? source.wablas_secret_key : '');
    const apiUrl = nested.apiUrl != null
        ? nested.apiUrl
        : (source.wablas_api_url != null ? source.wablas_api_url : DEFAULT_API_URL);
    const enabledRaw = nested.enabled != null
        ? nested.enabled
        : (source.wablas_enabled != null ? source.wablas_enabled : false);
    const deviceId = nested.deviceId != null
        ? nested.deviceId
        : (source.wablas_device_id != null ? source.wablas_device_id : '');
    const webhookSecret = nested.webhookSecret != null
        ? nested.webhookSecret
        : (source.wablas_webhook_secret != null ? source.wablas_webhook_secret : '');
    const minDelay = nested.minDelay != null
        ? nested.minDelay
        : (source.wablas_min_delay != null ? source.wablas_min_delay : 1000);
    const maxRetries = nested.maxRetries != null
        ? nested.maxRetries
        : (source.wablas_max_retries != null ? source.wablas_max_retries : 3);
    const retryDelay = nested.retryDelay != null
        ? nested.retryDelay
        : (source.wablas_retry_delay != null ? source.wablas_retry_delay : 2000);

    return {
        apiKey: String(apiKey || process.env.WABLAS_API_KEY || '').trim(),
        secretKey: String(secretKey || process.env.WABLAS_SECRET_KEY || ''),
        apiUrl: String(apiUrl || process.env.WABLAS_API_URL || DEFAULT_API_URL).trim().replace(/\/$/, ''),
        webhookSecret: String(webhookSecret || process.env.WABLAS_WEBHOOK_SECRET || ''),
        enabled: toBool(enabledRaw),
        deviceId: String(deviceId || process.env.WABLAS_DEVICE_ID || '').trim(),
        minDelay: parseInt(minDelay, 10) || 1000,
        maxRetries: parseInt(maxRetries, 10) || 3,
        retryDelay: parseInt(retryDelay, 10) || 2000
    };
}

/**
 * Dapatkan konfigurasi Wablas dari settings.json global
 * @returns {object} Konfigurasi Wablas
 */
function getWablasConfig() {
    return getWablasConfigFromObject({
        wablas_api_key: getSetting('wablas_api_key', process.env.WABLAS_API_KEY || ''),
        wablas_secret_key: getSetting('wablas_secret_key', process.env.WABLAS_SECRET_KEY || ''),
        wablas_api_url: getSetting('wablas_api_url', process.env.WABLAS_API_URL || DEFAULT_API_URL),
        wablas_webhook_secret: getSetting('wablas_webhook_secret', process.env.WABLAS_WEBHOOK_SECRET || ''),
        wablas_enabled: getSetting('wablas_enabled', 'false'),
        wablas_device_id: getSetting('wablas_device_id', process.env.WABLAS_DEVICE_ID || ''),
        wablas_min_delay: getSetting('wablas_min_delay', process.env.WABLAS_MIN_DELAY || '1000'),
        wablas_max_retries: getSetting('wablas_max_retries', process.env.WABLAS_MAX_RETRIES || '3'),
        wablas_retry_delay: getSetting('wablas_retry_delay', process.env.WABLAS_RETRY_DELAY || '2000')
    });
}

/**
 * Validasi konfigurasi Wablas
 * @param {object|null} config
 * @returns {boolean} True jika valid
 */
function validateWablasConfig(config = null) {
    const cfg = config || getWablasConfig();
    const errors = [];

    if (!cfg.apiKey) {
        errors.push('Wablas API key tidak dikonfigurasi');
    }

    if (!cfg.apiUrl) {
        errors.push('Wablas API URL tidak dikonfigurasi');
    }

    if (errors.length > 0) {
        logger.warn('⚠️ Wablas configuration errors:', errors);
        return false;
    }

    return true;
}

/**
 * Cek apakah Wablas enabled dan valid
 * @param {object|null} config
 * @returns {boolean}
 */
function isWablasEnabled(config = null) {
    const cfg = config || getWablasConfig();
    return cfg.enabled && validateWablasConfig(cfg);
}

module.exports = {
    getWablasConfig,
    getWablasConfigFromObject,
    validateWablasConfig,
    isWablasEnabled
};
