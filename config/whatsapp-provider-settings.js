const { getSetting, setSetting } = require('./settingsManager');

const PROVIDERS = [
    { id: 'baileys', label: 'Baileys', type: 'session' },
    { id: 'wablas', label: 'Wablas', type: 'api' },
    { id: 'meta', label: 'Meta Cloud API', type: 'api' },
    { id: 'qontak', label: 'Qontak', type: 'api' }
];

const DEFAULTS = {
    activeProvider: 'baileys',
    baileys: {
        enabled: false
    },
    wablas: {
        enabled: false,
        apiUrl: 'https://bdg.wablas.com',
        apiKey: '',
        secretKey: '',
        deviceId: '',
        webhookSecret: '',
        minDelay: 1000,
        maxRetries: 3,
        retryDelay: 2000
    },
    meta: {
        enabled: false,
        graphApiUrl: 'https://graph.facebook.com/v19.0',
        phoneNumberId: '',
        accessToken: '',
        businessAccountId: '',
        appSecret: '',
        webhookVerifyToken: ''
    },
    qontak: {
        enabled: false,
        apiUrl: 'https://service-chat.qontak.com',
        accessToken: '',
        channelIntegrationId: '',
        namespace: '',
        webhookSecret: ''
    }
};

function toBoolean(value, defaultValue = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.toLowerCase();
        if (normalized === 'true' || normalized === 'on' || normalized === '1') return true;
        if (normalized === 'false' || normalized === 'off' || normalized === '0') return false;
    }
    if (typeof value === 'number') return value === 1;
    return defaultValue;
}

function toInteger(value, defaultValue) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

function normalizeProvider(value) {
    const provider = String(value || '').toLowerCase();
    return PROVIDERS.some((item) => item.id === provider) ? provider : DEFAULTS.activeProvider;
}

function readSetting(source, key, defaultValue) {
    if (source && source[key] !== undefined && source[key] !== null && source[key] !== '') {
        return source[key];
    }
    return defaultValue;
}

function buildWhatsAppProviderSettings(source = {}) {
    const legacyActiveProvider = readSetting(source, 'whatsapp_primary_gateway', null);
    const activeProvider = normalizeProvider(readSetting(source, 'whatsapp_active_provider', legacyActiveProvider || DEFAULTS.activeProvider));

    return {
        activeProvider,
        providers: PROVIDERS,
        baileys: {
            enabled: toBoolean(readSetting(source, 'baileys_enabled', DEFAULTS.baileys.enabled))
        },
        wablas: {
            enabled: toBoolean(readSetting(source, 'wablas_enabled', DEFAULTS.wablas.enabled)),
            apiUrl: readSetting(source, 'wablas_api_url', DEFAULTS.wablas.apiUrl),
            apiKey: readSetting(source, 'wablas_api_key', DEFAULTS.wablas.apiKey),
            secretKey: readSetting(source, 'wablas_secret_key', DEFAULTS.wablas.secretKey),
            deviceId: readSetting(source, 'wablas_device_id', DEFAULTS.wablas.deviceId),
            webhookSecret: readSetting(source, 'wablas_webhook_secret', DEFAULTS.wablas.webhookSecret),
            minDelay: toInteger(readSetting(source, 'wablas_min_delay', DEFAULTS.wablas.minDelay), DEFAULTS.wablas.minDelay),
            maxRetries: toInteger(readSetting(source, 'wablas_max_retries', DEFAULTS.wablas.maxRetries), DEFAULTS.wablas.maxRetries),
            retryDelay: toInteger(readSetting(source, 'wablas_retry_delay', DEFAULTS.wablas.retryDelay), DEFAULTS.wablas.retryDelay)
        },
        meta: {
            enabled: toBoolean(readSetting(source, 'meta_whatsapp_enabled', DEFAULTS.meta.enabled)),
            graphApiUrl: readSetting(source, 'meta_whatsapp_graph_api_url', DEFAULTS.meta.graphApiUrl),
            phoneNumberId: readSetting(source, 'meta_whatsapp_phone_number_id', DEFAULTS.meta.phoneNumberId),
            accessToken: readSetting(source, 'meta_whatsapp_access_token', DEFAULTS.meta.accessToken),
            businessAccountId: readSetting(source, 'meta_whatsapp_business_account_id', DEFAULTS.meta.businessAccountId),
            appSecret: readSetting(source, 'meta_whatsapp_app_secret', DEFAULTS.meta.appSecret),
            webhookVerifyToken: readSetting(source, 'meta_whatsapp_webhook_verify_token', DEFAULTS.meta.webhookVerifyToken)
        },
        qontak: {
            enabled: toBoolean(readSetting(source, 'qontak_whatsapp_enabled', DEFAULTS.qontak.enabled)),
            apiUrl: readSetting(source, 'qontak_whatsapp_api_url', DEFAULTS.qontak.apiUrl),
            accessToken: readSetting(source, 'qontak_whatsapp_access_token', DEFAULTS.qontak.accessToken),
            channelIntegrationId: readSetting(source, 'qontak_whatsapp_channel_integration_id', DEFAULTS.qontak.channelIntegrationId),
            namespace: readSetting(source, 'qontak_whatsapp_namespace', DEFAULTS.qontak.namespace),
            webhookSecret: readSetting(source, 'qontak_whatsapp_webhook_secret', DEFAULTS.qontak.webhookSecret)
        }
    };
}

function getWhatsAppProviderSettings() {
    return buildWhatsAppProviderSettings({
        whatsapp_primary_gateway: getSetting('whatsapp_primary_gateway', null),
        whatsapp_active_provider: getSetting('whatsapp_active_provider', null),
        baileys_enabled: getSetting('baileys_enabled', DEFAULTS.baileys.enabled),
        wablas_enabled: getSetting('wablas_enabled', DEFAULTS.wablas.enabled),
        wablas_api_url: getSetting('wablas_api_url', DEFAULTS.wablas.apiUrl),
        wablas_api_key: getSetting('wablas_api_key', DEFAULTS.wablas.apiKey),
        wablas_secret_key: getSetting('wablas_secret_key', DEFAULTS.wablas.secretKey),
        wablas_device_id: getSetting('wablas_device_id', DEFAULTS.wablas.deviceId),
        wablas_webhook_secret: getSetting('wablas_webhook_secret', DEFAULTS.wablas.webhookSecret),
        wablas_min_delay: getSetting('wablas_min_delay', DEFAULTS.wablas.minDelay),
        wablas_max_retries: getSetting('wablas_max_retries', DEFAULTS.wablas.maxRetries),
        wablas_retry_delay: getSetting('wablas_retry_delay', DEFAULTS.wablas.retryDelay),
        meta_whatsapp_enabled: getSetting('meta_whatsapp_enabled', DEFAULTS.meta.enabled),
        meta_whatsapp_graph_api_url: getSetting('meta_whatsapp_graph_api_url', DEFAULTS.meta.graphApiUrl),
        meta_whatsapp_phone_number_id: getSetting('meta_whatsapp_phone_number_id', DEFAULTS.meta.phoneNumberId),
        meta_whatsapp_access_token: getSetting('meta_whatsapp_access_token', DEFAULTS.meta.accessToken),
        meta_whatsapp_business_account_id: getSetting('meta_whatsapp_business_account_id', DEFAULTS.meta.businessAccountId),
        meta_whatsapp_app_secret: getSetting('meta_whatsapp_app_secret', DEFAULTS.meta.appSecret),
        meta_whatsapp_webhook_verify_token: getSetting('meta_whatsapp_webhook_verify_token', DEFAULTS.meta.webhookVerifyToken),
        qontak_whatsapp_enabled: getSetting('qontak_whatsapp_enabled', DEFAULTS.qontak.enabled),
        qontak_whatsapp_api_url: getSetting('qontak_whatsapp_api_url', DEFAULTS.qontak.apiUrl),
        qontak_whatsapp_access_token: getSetting('qontak_whatsapp_access_token', DEFAULTS.qontak.accessToken),
        qontak_whatsapp_channel_integration_id: getSetting('qontak_whatsapp_channel_integration_id', DEFAULTS.qontak.channelIntegrationId),
        qontak_whatsapp_namespace: getSetting('qontak_whatsapp_namespace', DEFAULTS.qontak.namespace),
        qontak_whatsapp_webhook_secret: getSetting('qontak_whatsapp_webhook_secret', DEFAULTS.qontak.webhookSecret)
    });
}

function getWhatsAppProviderSettingsFromObject(settingsObj = {}) {
    return buildWhatsAppProviderSettings(settingsObj || {});
}

function applyWhatsAppProviderInput(target = {}, input = {}) {
    const out = { ...target };
    const activeProvider = normalizeProvider(input.activeProvider || input.whatsapp_active_provider);
    const settings = input.settings && typeof input.settings === 'object' ? input.settings : input;

    const baileys = settings.baileys || {};
    const wablas = settings.wablas || {};
    const meta = settings.meta || {};
    const qontak = settings.qontak || {};

    const enabledByProvider = {
        baileys: toBoolean(baileys.enabled, activeProvider === 'baileys'),
        wablas: toBoolean(wablas.enabled, activeProvider === 'wablas'),
        meta: toBoolean(meta.enabled, activeProvider === 'meta'),
        qontak: toBoolean(qontak.enabled, activeProvider === 'qontak')
    };
    enabledByProvider[activeProvider] = true;

    out.whatsapp_active_provider = activeProvider;
    out.whatsapp_primary_gateway = activeProvider;
    out.baileys_enabled = enabledByProvider.baileys;
    out.wablas_enabled = enabledByProvider.wablas;
    out.wablas_api_url = String(wablas.apiUrl || DEFAULTS.wablas.apiUrl).trim();
    out.wablas_api_key = String(wablas.apiKey || '').trim();
    out.wablas_secret_key = String(wablas.secretKey || '').trim();
    out.wablas_device_id = String(wablas.deviceId || '').trim();
    out.wablas_webhook_secret = String(wablas.webhookSecret || '').trim();
    out.wablas_min_delay = toInteger(wablas.minDelay, DEFAULTS.wablas.minDelay);
    out.wablas_max_retries = toInteger(wablas.maxRetries, DEFAULTS.wablas.maxRetries);
    out.wablas_retry_delay = toInteger(wablas.retryDelay, DEFAULTS.wablas.retryDelay);
    out.meta_whatsapp_enabled = enabledByProvider.meta;
    out.meta_whatsapp_graph_api_url = String(meta.graphApiUrl || DEFAULTS.meta.graphApiUrl).trim();
    out.meta_whatsapp_phone_number_id = String(meta.phoneNumberId || '').trim();
    out.meta_whatsapp_access_token = String(meta.accessToken || '');
    out.meta_whatsapp_business_account_id = String(meta.businessAccountId || '').trim();
    out.meta_whatsapp_app_secret = String(meta.appSecret || '');
    out.meta_whatsapp_webhook_verify_token = String(meta.webhookVerifyToken || '');
    out.qontak_whatsapp_enabled = enabledByProvider.qontak;
    out.qontak_whatsapp_api_url = String(qontak.apiUrl || DEFAULTS.qontak.apiUrl).trim();
    out.qontak_whatsapp_access_token = String(qontak.accessToken || '');
    out.qontak_whatsapp_channel_integration_id = String(qontak.channelIntegrationId || '').trim();
    out.qontak_whatsapp_namespace = String(qontak.namespace || '').trim();
    out.qontak_whatsapp_webhook_secret = String(qontak.webhookSecret || '');
    return out;
}

function saveWhatsAppProviderSettingsToObject(settingsObj = {}, input = {}) {
    return applyWhatsAppProviderInput(settingsObj, input);
}

function saveWhatsAppProviderSettings(input = {}) {
    const merged = applyWhatsAppProviderInput({}, input);
    Object.entries(merged).forEach(([key, val]) => setSetting(key, val));
    return getWhatsAppProviderSettings();
}

function getActiveWhatsAppProvider() {
    return getWhatsAppProviderSettings().activeProvider;
}

function isProviderEnabled(provider) {
    const settings = getWhatsAppProviderSettings();
    return !!(settings[normalizeProvider(provider)] && settings[normalizeProvider(provider)].enabled);
}

function validateProviderConfig(provider) {
    const settings = getWhatsAppProviderSettings();
    const id = normalizeProvider(provider);
    const cfg = settings[id] || {};

    if (id === 'baileys') return cfg.enabled;
    if (id === 'wablas') return cfg.enabled && !!cfg.apiKey && !!cfg.apiUrl;
    if (id === 'meta') return cfg.enabled && !!cfg.graphApiUrl && !!cfg.phoneNumberId && !!cfg.accessToken;
    if (id === 'qontak') return cfg.enabled && !!cfg.apiUrl && !!cfg.accessToken && !!cfg.channelIntegrationId;
    return false;
}

module.exports = {
    PROVIDERS,
    getWhatsAppProviderSettings,
    getWhatsAppProviderSettingsFromObject,
    saveWhatsAppProviderSettings,
    saveWhatsAppProviderSettingsToObject,
    getActiveWhatsAppProvider,
    isProviderEnabled,
    validateProviderConfig,
    normalizeProvider,
    toBoolean
};
