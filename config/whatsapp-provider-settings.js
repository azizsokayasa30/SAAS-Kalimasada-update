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

function getWhatsAppProviderSettings() {
    const legacyActiveProvider = getSetting('whatsapp_primary_gateway', null);
    const activeProvider = normalizeProvider(getSetting('whatsapp_active_provider', legacyActiveProvider || DEFAULTS.activeProvider));

    return {
        activeProvider,
        providers: PROVIDERS,
        baileys: {
            enabled: toBoolean(getSetting('baileys_enabled', DEFAULTS.baileys.enabled))
        },
        wablas: {
            enabled: toBoolean(getSetting('wablas_enabled', DEFAULTS.wablas.enabled)),
            apiUrl: getSetting('wablas_api_url', DEFAULTS.wablas.apiUrl),
            apiKey: getSetting('wablas_api_key', DEFAULTS.wablas.apiKey),
            secretKey: getSetting('wablas_secret_key', DEFAULTS.wablas.secretKey),
            deviceId: getSetting('wablas_device_id', DEFAULTS.wablas.deviceId),
            webhookSecret: getSetting('wablas_webhook_secret', DEFAULTS.wablas.webhookSecret),
            minDelay: toInteger(getSetting('wablas_min_delay', DEFAULTS.wablas.minDelay), DEFAULTS.wablas.minDelay),
            maxRetries: toInteger(getSetting('wablas_max_retries', DEFAULTS.wablas.maxRetries), DEFAULTS.wablas.maxRetries),
            retryDelay: toInteger(getSetting('wablas_retry_delay', DEFAULTS.wablas.retryDelay), DEFAULTS.wablas.retryDelay)
        },
        meta: {
            enabled: toBoolean(getSetting('meta_whatsapp_enabled', DEFAULTS.meta.enabled)),
            graphApiUrl: getSetting('meta_whatsapp_graph_api_url', DEFAULTS.meta.graphApiUrl),
            phoneNumberId: getSetting('meta_whatsapp_phone_number_id', DEFAULTS.meta.phoneNumberId),
            accessToken: getSetting('meta_whatsapp_access_token', DEFAULTS.meta.accessToken),
            businessAccountId: getSetting('meta_whatsapp_business_account_id', DEFAULTS.meta.businessAccountId),
            appSecret: getSetting('meta_whatsapp_app_secret', DEFAULTS.meta.appSecret),
            webhookVerifyToken: getSetting('meta_whatsapp_webhook_verify_token', DEFAULTS.meta.webhookVerifyToken)
        },
        qontak: {
            enabled: toBoolean(getSetting('qontak_whatsapp_enabled', DEFAULTS.qontak.enabled)),
            apiUrl: getSetting('qontak_whatsapp_api_url', DEFAULTS.qontak.apiUrl),
            accessToken: getSetting('qontak_whatsapp_access_token', DEFAULTS.qontak.accessToken),
            channelIntegrationId: getSetting('qontak_whatsapp_channel_integration_id', DEFAULTS.qontak.channelIntegrationId),
            namespace: getSetting('qontak_whatsapp_namespace', DEFAULTS.qontak.namespace),
            webhookSecret: getSetting('qontak_whatsapp_webhook_secret', DEFAULTS.qontak.webhookSecret)
        }
    };
}

function saveWhatsAppProviderSettings(input = {}) {
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

    setSetting('whatsapp_active_provider', activeProvider);
    setSetting('whatsapp_primary_gateway', activeProvider);

    setSetting('baileys_enabled', enabledByProvider.baileys);

    setSetting('wablas_enabled', enabledByProvider.wablas);
    setSetting('wablas_api_url', String(wablas.apiUrl || DEFAULTS.wablas.apiUrl).trim());
    setSetting('wablas_api_key', String(wablas.apiKey || '').trim());
    setSetting('wablas_secret_key', String(wablas.secretKey || ''));
    setSetting('wablas_device_id', String(wablas.deviceId || '').trim());
    setSetting('wablas_webhook_secret', String(wablas.webhookSecret || ''));
    setSetting('wablas_min_delay', toInteger(wablas.minDelay, DEFAULTS.wablas.minDelay));
    setSetting('wablas_max_retries', toInteger(wablas.maxRetries, DEFAULTS.wablas.maxRetries));
    setSetting('wablas_retry_delay', toInteger(wablas.retryDelay, DEFAULTS.wablas.retryDelay));

    setSetting('meta_whatsapp_enabled', enabledByProvider.meta);
    setSetting('meta_whatsapp_graph_api_url', String(meta.graphApiUrl || DEFAULTS.meta.graphApiUrl).trim());
    setSetting('meta_whatsapp_phone_number_id', String(meta.phoneNumberId || '').trim());
    setSetting('meta_whatsapp_access_token', String(meta.accessToken || ''));
    setSetting('meta_whatsapp_business_account_id', String(meta.businessAccountId || '').trim());
    setSetting('meta_whatsapp_app_secret', String(meta.appSecret || ''));
    setSetting('meta_whatsapp_webhook_verify_token', String(meta.webhookVerifyToken || ''));

    setSetting('qontak_whatsapp_enabled', enabledByProvider.qontak);
    setSetting('qontak_whatsapp_api_url', String(qontak.apiUrl || DEFAULTS.qontak.apiUrl).trim());
    setSetting('qontak_whatsapp_access_token', String(qontak.accessToken || ''));
    setSetting('qontak_whatsapp_channel_integration_id', String(qontak.channelIntegrationId || '').trim());
    setSetting('qontak_whatsapp_namespace', String(qontak.namespace || '').trim());
    setSetting('qontak_whatsapp_webhook_secret', String(qontak.webhookSecret || ''));

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
    saveWhatsAppProviderSettings,
    getActiveWhatsAppProvider,
    isProviderEnabled,
    validateProviderConfig,
    normalizeProvider,
    toBoolean
};
