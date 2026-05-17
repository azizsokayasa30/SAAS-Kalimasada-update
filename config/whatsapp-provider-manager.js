/**
 * WhatsApp Provider Manager
 * Singleton untuk mengelola provider aktif (Baileys, Wablas, Meta, atau Qontak)
 */
const WhatsAppProvider = require('./whatsapp-provider');
const BaileysProvider = require('./providers/baileys-provider');
const WablasProvider = require('./providers/wablas-provider');
const MetaProvider = require('./providers/meta-provider');
const QontakProvider = require('./providers/qontak-provider');
const { getWablasConfig, validateWablasConfig, isWablasEnabled } = require('./wablas-config');
const {
    getActiveWhatsAppProvider,
    isProviderEnabled,
    validateProviderConfig,
    normalizeProvider
} = require('./whatsapp-provider-settings');
const logger = require('./logger');

class WhatsAppProviderManager {
    constructor() {
        this.provider = null;
        this.providerType = null; // 'baileys' | 'wablas' | 'meta' | 'qontak'
        this.initialized = false;
    }

    async _createProvider(type, options = {}) {
        if (type === 'wablas') {
            if (!validateWablasConfig()) {
                throw new Error('Wablas config is invalid');
            }
            this.provider = new WablasProvider();
            this.providerType = 'wablas';
            await this.provider.initialize();
            return this.provider;
        }

        if (type === 'meta') {
            if (!validateProviderConfig('meta')) {
                throw new Error('Meta Cloud API config is invalid');
            }
            this.provider = new MetaProvider();
            this.providerType = 'meta';
            await this.provider.initialize();
            return this.provider;
        }

        if (type === 'qontak') {
            if (!validateProviderConfig('qontak')) {
                throw new Error('Qontak config is invalid');
            }
            this.provider = new QontakProvider();
            this.providerType = 'qontak';
            await this.provider.initialize();
            return this.provider;
        }

        if (type === 'baileys') {
            this.provider = new BaileysProvider(options.baileysSock || options.sock || null);
            this.providerType = 'baileys';
            if (options.baileysSock || options.sock) {
                this.provider.setSock(options.baileysSock || options.sock);
            }
            return this.provider;
        }

        throw new Error(`Unknown provider type: ${type}`);
    }

    /**
     * Inisialisasi provider berdasarkan konfigurasi
     * @param {object} options - Opsi inisialisasi
     * @param {object} options.baileysSock - Socket Baileys (jika ingin menggunakan Baileys)
     * @param {string} options.forceProvider - Force provider tertentu ('baileys' | 'wablas' | 'meta' | 'qontak')
     */
    async initialize(options = {}) {
        if (this.initialized) {
            logger.warn('⚠️ ProviderManager already initialized');
            return this.provider;
        }

        const { baileysSock, forceProvider } = options;

        // Jika ada forceProvider, gunakan itu
        if (forceProvider) {
            const forcedProvider = normalizeProvider(forceProvider);
            logger.info(`🚀 Initializing WhatsApp provider (forced): ${forcedProvider}`);
            await this._createProvider(forcedProvider, options);
            this.initialized = true;
            logger.info(`✅ ${this.providerType} provider initialized`);
            return this.provider;
        }

        if (baileysSock) {
            logger.info('🚀 Initializing BaileysProvider (forced or socket provided)...');
            await this._createProvider('baileys', { baileysSock });
            this.initialized = true;
            logger.info('✅ BaileysProvider initialized');
            return this.provider;
        }

        // Auto-select berdasarkan provider aktif
        const activeProvider = getActiveWhatsAppProvider();
        if (validateProviderConfig(activeProvider)) {
            try {
                logger.info(`🚀 Initializing ${activeProvider} provider (active setting)...`);
                await this._createProvider(activeProvider, options);
                this.initialized = true;
                logger.info(`✅ ${activeProvider} provider initialized`);
                return this.provider;
            } catch (error) {
                logger.error(`❌ Failed to initialize active WhatsApp provider (${activeProvider}):`, error);
            }
        }

        // Backward compatibility: pakai Wablas jika legacy setting aktif
        if (isWablasEnabled()) {
            try {
                logger.info('🚀 Initializing WablasProvider (legacy auto-selected)...');
                await this._createProvider('wablas', options);
                this.initialized = true;
                logger.info('✅ WablasProvider initialized');
                return this.provider;
            } catch (error) {
                logger.error('❌ Failed to initialize WablasProvider, falling back:', error);
            }
        }

        // Fallback ke provider API lain yang valid
        for (const fallbackProvider of ['meta', 'qontak']) {
            if (!isProviderEnabled(fallbackProvider) || !validateProviderConfig(fallbackProvider)) continue;
            try {
                logger.info(`🚀 Initializing ${fallbackProvider} provider (fallback)...`);
                await this._createProvider(fallbackProvider, options);
                this.initialized = true;
                return this.provider;
            } catch (error) {
                logger.error(`❌ Failed to initialize fallback provider ${fallbackProvider}:`, error);
            }
        }

        // Fallback ke Baileys (hanya jika enabled)
        const { isBaileysEnabled } = require('./baileys-config');
        if (isBaileysEnabled()) {
            logger.info('🚀 Initializing BaileysProvider (fallback)...');
            await this._createProvider('baileys', options);
            this.initialized = true;
            logger.info('✅ BaileysProvider initialized (fallback mode - requires socket to be set later)');
            return this.provider;
        } else {
            logger.warn('⚠️ Baileys disabled, cannot fallback to BaileysProvider');
            throw new Error('No WhatsApp provider available');
        }
    }

    /**
     * Get provider aktif
     * @returns {WhatsAppProvider}
     */
    getProvider() {
        if (!this.provider) {
            throw new Error('Provider not initialized. Call initialize() first.');
        }
        return this.provider;
    }

    /**
     * Switch provider (untuk testing/migrasi bertahap)
     * @param {string} type - 'baileys' | 'wablas' | 'meta' | 'qontak'
     * @param {object} options - Opsi tambahan
     */
    async switchProvider(type, options = {}) {
        if (this.provider) {
            await this.provider.cleanup();
        }

        const providerType = normalizeProvider(type);
        await this._createProvider(providerType, options);
        logger.info(`🔄 Switched to ${providerType} provider`);

        this.initialized = true;
    }

    /**
     * Set Baileys socket (untuk kompatibilitas dengan kode lama)
     * @param {object} sock - Baileys socket
     */
    setBaileysSocket(sock) {
        if (this.providerType === 'baileys' && this.provider instanceof BaileysProvider) {
            this.provider.setSock(sock);
            logger.info('✅ Baileys socket set');
        } else {
            logger.warn('⚠️ Cannot set Baileys socket: current provider is not BaileysProvider');
        }
    }

    /**
     * Get provider type
     * @returns {string} 'baileys' | 'wablas' | 'meta' | 'qontak' | null
     */
    getProviderType() {
        return this.providerType;
    }

    /**
     * Cek apakah provider sudah diinisialisasi
     * @returns {boolean}
     */
    isInitialized() {
        return this.initialized;
    }

    /**
     * Cleanup semua provider
     */
    async cleanup() {
        if (this.provider) {
            await this.provider.cleanup();
        }
        this.provider = null;
        this.providerType = null;
        this.initialized = false;
        logger.info('🧹 ProviderManager cleaned up');
    }
}

// Singleton instance
let instance = null;

/**
 * Get singleton instance dari ProviderManager
 * @returns {WhatsAppProviderManager}
 */
function getProviderManager() {
    if (!instance) {
        instance = new WhatsAppProviderManager();
    }
    return instance;
}

/**
 * Reset singleton (untuk testing)
 */
function resetProviderManager() {
    if (instance) {
        instance.cleanup();
    }
    instance = null;
}

module.exports = {
    WhatsAppProviderManager,
    getProviderManager,
    resetProviderManager
};

