const { getSetting, setSetting } = require('./settingsManager');
const billingManager = require('./billing');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');
const { getCompanyHeader } = require('./message-templates');
const { getProviderManager } = require('./whatsapp-provider-manager');
const { getBuiltInWhatsAppTemplates, mergeWhatsAppTemplatesFromFile } = require('./whatsapp-template-registry');

class WhatsAppNotificationManager {
    constructor() {
        this.sock = null; // Keep for backward compatibility
        this.providerManager = null;
        this.templatesFile = path.join(__dirname, '../data/whatsapp-templates.json');
        /** @type {Map<number, { templates: object, exp: number }>} */
        this._tenantTplCache = new Map();
        this._rebuildTemplatesFromDisk();
    }

    _rebuildTemplatesFromDisk() {
        let fileData = {};
        try {
            if (fs.existsSync(this.templatesFile)) {
                fileData = JSON.parse(fs.readFileSync(this.templatesFile, 'utf8'));
            }
        } catch (error) {
            logger.error('❌ [WHATSAPP] Error reading templates file:', error);
        }
        this.templates = mergeWhatsAppTemplatesFromFile(getBuiltInWhatsAppTemplates(), fileData);
    }

    _normalizeTenantId(value) {
        const n = parseInt(value, 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    /**
     * Resolve tenant id from explicit candidates, then ALS HTTP context.
     * Returns null when no tenant can be determined (legacy global file mode).
     */
    resolveTenantId(...candidates) {
        for (const c of candidates) {
            const id = this._normalizeTenantId(c);
            if (id) return id;
        }
        try {
            const { hasTenantContext, getTenantId } = require('./platform/tenantContext');
            if (hasTenantContext()) {
                return this._normalizeTenantId(getTenantId());
            }
        } catch (_) { /* ignore */ }
        return null;
    }

    invalidateTenantTemplatesCache(tenantId = null) {
        const tid = this._normalizeTenantId(tenantId);
        if (tid) this._tenantTplCache.delete(tid);
        else this._tenantTplCache.clear();
    }

    /**
     * Load templates for a tenant (from tenant.settings.whatsapp_templates)
     * or global file when tenantId is null.
     * Tenant without saved overrides gets built-in defaults (not the shared global file).
     */
    async getResolvedTemplates(tenantId = null) {
        const tid = this._normalizeTenantId(tenantId);
        if (tid) {
            const cached = this._tenantTplCache.get(tid);
            if (cached && cached.exp > Date.now()) {
                return cached.templates;
            }
            const { getFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
            const settings = await getFullSettingsForTenantId(tid);
            const overrides = settings && typeof settings.whatsapp_templates === 'object'
                ? settings.whatsapp_templates
                : {};
            const templates = mergeWhatsAppTemplatesFromFile(getBuiltInWhatsAppTemplates(), overrides);
            this._tenantTplCache.set(tid, { templates, exp: Date.now() + 5000 });
            return templates;
        }
        this._rebuildTemplatesFromDisk();
        return this.templates;
    }

    /**
     * Resolve templates for send path: explicit candidates → ALS → global file.
     */
    async resolveTemplatesForSend(...tenantCandidates) {
        const tid = this.resolveTenantId(...tenantCandidates);
        return {
            tenantId: tid,
            templates: await this.getResolvedTemplates(tid)
        };
    }

    _serializeTemplatesForStorage(templates) {
        const out = {};
        Object.keys(templates || {}).forEach((key) => {
            const t = templates[key];
            if (!t || typeof t !== 'object') return;
            out[key] = {
                title: t.title,
                template: t.template,
                enabled: t.enabled !== false
            };
        });
        return out;
    }

    setSock(sockInstance) {
        this.sock = sockInstance; // Keep for backward compatibility
    }

    isSystemMonitorEnabled(monitorId) {
        try {
            const { isWaSystemMonitorEnabled } = require('./whatsappMonitoringSettings');
            return isWaSystemMonitorEnabled(monitorId);
        } catch (_) {
            return true;
        }
    }

    // Get provider instance (global singleton — prefer resolveSendProvider for tenant sends)
    getProvider() {
        if (!this.providerManager) {
            this.providerManager = getProviderManager();
        }
        
        if (!this.providerManager.isInitialized()) {
            logger.warn('⚠️ ProviderManager not initialized in WhatsAppNotificationManager');
            return null;
        }
        
        try {
            return this.providerManager.getProvider();
        } catch (e) {
            logger.warn('⚠️ getProvider failed:', e.message);
            return null;
        }
    }

    /**
     * Find live Baileys sock for a tenant (or legacy when tenantId is null).
     */
    _resolveBaileysSock(tenantId = null) {
        const tid = this._normalizeTenantId(tenantId);
        try {
            const registry = require('./baileys-session-registry');
            const sock = registry.getSock(tid);
            if (sock) return sock;
        } catch (_) { /* optional */ }

        // Legacy / bot path only when no tenant scope
        if (!tid) {
            if (this.sock) return this.sock;
            if (typeof global !== 'undefined' && global.whatsappSocket) return global.whatsappSocket;
            try {
                const core = require('./whatsapp-core');
                if (typeof core.getSock === 'function') {
                    const s = core.getSock();
                    if (s) return s;
                }
            } catch (_) { /* optional */ }
            try {
                const globalType = (this.providerManager && this.providerManager.getProviderType()) || null;
                const globalProvider = this.getProvider();
                if (globalType === 'baileys' && globalProvider && globalProvider.sock) {
                    return globalProvider.sock;
                }
            } catch (_) { /* optional */ }
        }
        return null;
    }

    /**
     * Resolve provider for sending using tenant gateway settings when available.
     * API providers (Wablas/Meta/Qontak) are created per-send with tenant credentials
     * so multi-tenant configs don't share the wrong global keys.
     * With a tenantId, never fall back to the process-wide global API provider.
     */
    async resolveSendProvider(tenantId = null) {
        const tid = this._normalizeTenantId(tenantId) ?? this.resolveTenantId();
        let providerSettings = null;

        try {
            if (tid) {
                const { getFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
                const { getWhatsAppProviderSettingsFromObject } = require('./whatsapp-provider-settings');
                const ts = await getFullSettingsForTenantId(tid);
                providerSettings = getWhatsAppProviderSettingsFromObject(ts);
            } else {
                const { getWhatsAppProviderSettings } = require('./whatsapp-provider-settings');
                providerSettings = getWhatsAppProviderSettings();
            }
        } catch (err) {
            logger.warn('⚠️ resolveSendProvider settings load failed:', err.message);
        }

        if (providerSettings) {
            const active = providerSettings.activeProvider;
            try {
                if (active === 'wablas') {
                    if (providerSettings.wablas?.apiKey) {
                        const { getWablasConfigFromObject, validateWablasConfig } = require('./wablas-config');
                        const WablasProvider = require('./providers/wablas-provider');
                        const cfg = getWablasConfigFromObject(providerSettings);
                        if (validateWablasConfig(cfg)) {
                            const provider = new WablasProvider(cfg);
                            provider.status.connected = true;
                            provider.status.status = 'connected';
                            return { provider, kind: 'api', type: 'wablas', tenantId: tid };
                        }
                    }
                    if (tid) {
                        return {
                            provider: null,
                            kind: 'api',
                            type: 'wablas',
                            tenantId: tid,
                            error: 'Wablas belum dikonfigurasi untuk tenant ini (API key/secret/URL wajib diisi)'
                        };
                    }
                }
                if (active === 'meta') {
                    if (providerSettings.meta?.accessToken && providerSettings.meta?.phoneNumberId) {
                        const MetaProvider = require('./providers/meta-provider');
                        const provider = new MetaProvider(providerSettings.meta);
                        provider.status.connected = true;
                        provider.status.status = 'connected';
                        return { provider, kind: 'api', type: 'meta', tenantId: tid };
                    }
                    if (tid) {
                        return {
                            provider: null,
                            kind: 'api',
                            type: 'meta',
                            tenantId: tid,
                            error: 'Meta WhatsApp belum dikonfigurasi untuk tenant ini (access token & phone number ID wajib)'
                        };
                    }
                }
                if (active === 'qontak') {
                    if (providerSettings.qontak?.accessToken && providerSettings.qontak?.channelIntegrationId) {
                        const QontakProvider = require('./providers/qontak-provider');
                        const provider = new QontakProvider(providerSettings.qontak);
                        provider.status.connected = true;
                        provider.status.status = 'connected';
                        return { provider, kind: 'api', type: 'qontak', tenantId: tid };
                    }
                    if (tid) {
                        return {
                            provider: null,
                            kind: 'api',
                            type: 'qontak',
                            tenantId: tid,
                            error: 'Qontak WhatsApp belum dikonfigurasi untuk tenant ini (access token & channel integration ID wajib)'
                        };
                    }
                }
                if (active === 'baileys') {
                    const registry = require('./baileys-session-registry');
                    let sock = this._resolveBaileysSock(tid);
                    if (!sock && tid && registry.hasCreds(tid)) {
                        // Lazy connect — jangan blok lama; caller bisa retry
                        registry.connect(tid).catch((err) => {
                            logger.warn(`⚠️ Lazy Baileys connect tenant ${tid}: ${err.message}`);
                        });
                        return {
                            provider: null,
                            kind: 'session',
                            type: 'baileys',
                            tenantId: tid,
                            error: 'Baileys sedang menghubungkan sesi tenant ini — coba kirim ulang sebentar lagi'
                        };
                    }
                    if (!sock && tid) {
                        // Kick connect for QR/setup if no creds yet
                        registry.connect(tid).catch(() => {});
                        return {
                            provider: null,
                            kind: 'session',
                            type: 'baileys',
                            tenantId: tid,
                            error: 'Baileys belum terhubung — buka WhatsApp Settings tenant ini, pastikan Baileys Enable, lalu scan QR'
                        };
                    }
                    if (sock) {
                        const BaileysProvider = require('./providers/baileys-provider');
                        const provider = new BaileysProvider(sock);
                        provider.status.connected = true;
                        provider.status.status = 'connected';
                        return {
                            provider,
                            kind: 'session',
                            type: 'baileys',
                            tenantId: tid
                        };
                    }
                    if (tid) {
                        return {
                            provider: null,
                            kind: 'session',
                            type: 'baileys',
                            tenantId: tid,
                            error: 'Baileys belum terhubung — buka WhatsApp Settings, pastikan Baileys Enable, lalu scan QR'
                        };
                    }
                }
            } catch (err) {
                logger.warn(`⚠️ Failed creating tenant ${active} provider:`, err.message);
                if (tid) {
                    return {
                        provider: null,
                        kind: null,
                        type: active || null,
                        tenantId: tid,
                        error: `Gagal inisialisasi provider ${active}: ${err.message}`
                    };
                }
            }
        }

        // Legacy / non-tenant only: use process-wide provider
        if (!tid) {
            const globalProvider = this.getProvider();
            if (globalProvider) {
                const type = (this.providerManager && this.providerManager.getProviderType()) || 'unknown';
                const kind = type === 'baileys' ? 'session' : 'api';
                return { provider: globalProvider, kind, type, tenantId: tid };
            }
            return { provider: null, kind: null, type: null, tenantId: tid };
        }

        const active = providerSettings?.activeProvider || 'unknown';
        return {
            provider: null,
            kind: null,
            type: active,
            tenantId: tid,
            error: providerSettings
                ? `Provider WhatsApp "${active}" tidak siap untuk tenant ini`
                : 'Pengaturan WhatsApp tenant tidak ditemukan'
        };
    }

    // Format phone number for WhatsApp
    formatPhoneNumber(number) {
        let cleaned = number.replace(/\D/g, '');
        if (cleaned.startsWith('0')) {
            cleaned = '62' + cleaned.slice(1);
        }
        if (!cleaned.startsWith('62')) {
            cleaned = '62' + cleaned;
        }
        return cleaned;
    }

    // Helper: billing QR image path — hanya jika diunggah di pengaturan tenant
    async getInvoiceImagePath(tenantId = null) {
        let customFilename = null;

        try {
            if (tenantId) {
                const { getFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
                const settings = await getFullSettingsForTenantId(tenantId);
                customFilename = settings?.billing_qr_filename;
            } else {
                customFilename = getSetting('billing_qr_filename', null);
            }
        } catch (err) {
            logger.warn('⚠️ Gagal membaca billing_qr_filename:', err.message);
            return null;
        }

        if (!customFilename || !String(customFilename).trim()) {
            return null;
        }

        const imagePath = path.resolve(__dirname, '../public/img', customFilename);
        if (fs.existsSync(imagePath)) {
            logger.info(`📸 Using billing QR image: ${imagePath}`);
            return imagePath;
        }

        logger.warn(`⚠️ Billing QR file not found: ${imagePath}, will send text-only notification`);
        return null;
    }

    /**
     * URL login portal pelanggan untuk tenant (https://{subdomain}.domain/customer-app/login).
     */
    async getCustomerPortalLoginUrlForTenant(tenantId = null) {
        const tid = this._normalizeTenantId(tenantId) ?? this.resolveTenantId();
        let subdomain = null;

        try {
            if (tid) {
                const tenantStore = require('./platform/tenantStore');
                const tenant = await tenantStore.getTenantById(tid);
                subdomain = tenant?.subdomain || tenant?.slug || null;
            }
        } catch (err) {
            logger.warn('⚠️ Gagal resolve subdomain untuk customer_portal_url:', err.message);
        }

        if (!subdomain) {
            try {
                const { hasTenantContext, getTenant } = require('./platform/tenantContext');
                if (hasTenantContext()) {
                    const t = getTenant();
                    subdomain = t?.subdomain || t?.slug || null;
                }
            } catch (_) { /* ignore */ }
        }

        if (subdomain) {
            const { getCustomerPortalLoginUrl } = require('./platform/tenantUrls');
            return getCustomerPortalLoginUrl(subdomain);
        }

        const fallback = getSetting('customer_portal_login_url', '')
            || getSetting('company_website', '');
        return fallback ? String(fallback).replace(/\/$/, '') : '';
    }

    /**
     * Format teks rekening dari setting Billing & Pembayaran
     * (payment_bank_name / payment_account_number / payment_account_holder / cash).
     */
    formatRekeningPembayaranFromSettings(settings = {}) {
        const bankName = String(settings.payment_bank_name || '').trim();
        const accountNumber = String(settings.payment_account_number || '').trim();
        const accountHolder = String(settings.payment_account_holder || '').trim();
        const cashAddress = String(settings.payment_cash_address || '').trim();
        const cashHours = String(settings.payment_cash_hours || '').trim();

        const lines = [];
        if (bankName || accountNumber) {
            if (bankName) lines.push(`Bank: ${bankName}`);
            if (accountNumber) lines.push(`No. Rekening: ${accountNumber}`);
            if (accountHolder) lines.push(`A/N: ${accountHolder}`);
        }
        if (cashAddress) {
            if (lines.length) lines.push('');
            lines.push(`Tunai: ${cashAddress}`);
            if (cashHours) lines.push(`Jam: ${cashHours}`);
        }
        return lines.join('\n');
    }

    /**
     * Rekening pembayaran per tenant (Setting Umum → Billing & Pembayaran).
     * Digunakan oleh variabel template {Rekening_Pembayaran}.
     */
    async getRekeningPembayaranForTenant(tenantId = null) {
        const tid = this._normalizeTenantId(tenantId) ?? this.resolveTenantId();
        try {
            if (tid) {
                const { getFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
                const settings = await getFullSettingsForTenantId(tid);
                return this.formatRekeningPembayaranFromSettings(settings || {});
            }
        } catch (err) {
            logger.warn('⚠️ Gagal resolve Rekening_Pembayaran dari tenant settings:', err.message);
        }

        try {
            const { getTenantSetting } = require('./platform/tenantSettings');
            return this.formatRekeningPembayaranFromSettings({
                payment_bank_name: getTenantSetting('payment_bank_name', '') || getSetting('payment_bank_name', ''),
                payment_account_number: getTenantSetting('payment_account_number', '') || getSetting('payment_account_number', ''),
                payment_account_holder: getTenantSetting('payment_account_holder', '') || getSetting('payment_account_holder', ''),
                payment_cash_address: getTenantSetting('payment_cash_address', '') || getSetting('payment_cash_address', ''),
                payment_cash_hours: getTenantSetting('payment_cash_hours', '') || getSetting('payment_cash_hours', '')
            });
        } catch (_) {
            return this.formatRekeningPembayaranFromSettings({
                payment_bank_name: getSetting('payment_bank_name', ''),
                payment_account_number: getSetting('payment_account_number', ''),
                payment_account_holder: getSetting('payment_account_holder', ''),
                payment_cash_address: getSetting('payment_cash_address', ''),
                payment_cash_hours: getSetting('payment_cash_hours', '')
            });
        }
    }

    /**
     * Lengkapi data template: portal URL per tenant + rekening pembayaran + default paket kosong
     * agar {package_name}/{package_speed}/{customer_portal_url}/{Rekening_Pembayaran} aman dipakai.
     */
    async buildTemplateData(tenantId, data = {}) {
        const portalUrl = (data && data.customer_portal_url)
            || await this.getCustomerPortalLoginUrlForTenant(tenantId);
        const rekeningPembayaran = (data && data.Rekening_Pembayaran)
            || await this.getRekeningPembayaranForTenant(tenantId);
        return {
            package_name: '',
            package_speed: '',
            Rekening_Pembayaran: '',
            ...data,
            customer_portal_url: portalUrl,
            Rekening_Pembayaran: rekeningPembayaran
        };
    }

    async renderTemplate(template, data = {}, tenantId = null) {
        const enriched = await this.buildTemplateData(tenantId, data);
        return this.replaceTemplateVariables(template, enriched);
    }

    // Replace template variables with actual data
    replaceTemplateVariables(template, data) {
        let message = template;
        for (const [key, value] of Object.entries(data)) {
            const placeholder = `{${key}}`;
            message = message.replace(new RegExp(placeholder, 'g'), value == null ? '' : String(value));
        }
        return message;
    }

    // Format currency
    formatCurrency(amount) {
        return new Intl.NumberFormat('id-ID').format(amount);
    }

    // Format date
    formatDate(date) {
        return new Date(date).toLocaleDateString('id-ID', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    }

    // Get rate limit settings
    getRateLimitSettings() {
        return {
            maxMessagesPerBatch: getSetting('whatsapp_rate_limit.maxMessagesPerBatch', 10),
            delayBetweenBatches: getSetting('whatsapp_rate_limit.delayBetweenBatches', 30),
            delayBetweenMessages: getSetting('whatsapp_rate_limit.delayBetweenMessages', 2),
            maxRetries: getSetting('whatsapp_rate_limit.maxRetries', 2),
            dailyMessageLimit: getSetting('whatsapp_rate_limit.dailyMessageLimit', 0),
            enabled: getSetting('whatsapp_rate_limit.enabled', true)
        };
    }

    // Check daily message limit
    checkDailyMessageLimit() {
        const settings = this.getRateLimitSettings();
        if (settings.dailyMessageLimit <= 0) return true; // No limit
        
        const today = new Date().toISOString().split('T')[0];
        const dailyCount = getSetting(`whatsapp_daily_count.${today}`, 0);
        
        return dailyCount < settings.dailyMessageLimit;
    }

    // Increment daily message count
    incrementDailyMessageCount() {
        const today = new Date().toISOString().split('T')[0];
        const currentCount = getSetting(`whatsapp_daily_count.${today}`, 0);
        setSetting(`whatsapp_daily_count.${today}`, currentCount + 1);
    }

    // Send notification (isi template saja, tanpa header/footer otomatis)
    async sendNotification(phoneNumber, message, options = {}) {
        try {
            // Check rate limiting
            const settings = this.getRateLimitSettings();
            if (settings.enabled && !this.checkDailyMessageLimit()) {
                logger.warn(`Daily message limit reached (${settings.dailyMessageLimit}), skipping notification to ${phoneNumber}`);
                return { success: false, error: 'Daily message limit reached' };
            }

            const formattedNumber = this.formatPhoneNumber(phoneNumber);

            // Kirim isi template saja — tanpa header/footer tenant otomatis
            const fullMessage = message;

            const resolved = await this.resolveSendProvider(options.tenantId);
            const provider = resolved.provider;
            let providerError = resolved.error || null;

            // Tenant isolation: surface config/connection errors without silent global fallback
            if (!provider && resolved.error) {
                logger.warn(`⚠️ resolveSendProvider: ${resolved.error}`);
                return { success: false, error: resolved.error };
            }
            
            // Try to use provider first
            if (provider) {
                // If imagePath provided and exists, try to send as image with caption
                if (options.imagePath) {
                    try {
                        const imagePath = options.imagePath;
                        logger.info(`📸 Mencoba mengirim dengan gambar: ${imagePath}`);
                        
                        if (fs.existsSync(imagePath)) {
                            const result = await provider.sendMedia(formattedNumber, imagePath, fullMessage, options);
                            if (result.success) {
                                logger.info(`✅ WhatsApp image notification sent to ${phoneNumber} with image via ${resolved.type || 'provider'}`);
                                this.incrementDailyMessageCount();
                                return { success: true, withImage: true };
                            } else {
                                providerError = result.error || 'Provider media send failed';
                                logger.warn(`⚠️ Provider failed to send image: ${providerError}`);
                            }
                        } else {
                            logger.warn(`⚠️ Image not found at path: ${imagePath}, falling back to text message`);
                        }
                    } catch (imgErr) {
                        providerError = imgErr.message;
                        logger.error(`❌ Failed sending image to ${phoneNumber}, falling back to text:`, imgErr);
                    }
                }

                // Send as text message via provider
                const result = await provider.sendMessage(formattedNumber, fullMessage, options);
                if (result.success) {
                    logger.info(`✅ WhatsApp text notification sent to ${phoneNumber} via ${resolved.type || 'provider'}`);
                    this.incrementDailyMessageCount();
                    return {
                        success: true,
                        withImage: false,
                        pending: !!result.pending,
                        wablasStatus: result.wablasStatus || null,
                        wablasMessage: result.wablasMessage || null,
                        messageId: result.messageId || null
                    };
                } else {
                    providerError = result.error || 'Provider send failed';
                    logger.warn(`⚠️ Provider failed to send message: ${providerError}`);
                }

                // API gateway (Wablas/Meta/Qontak): jangan mask error dengan Baileys sock
                if (resolved.kind === 'api') {
                    return {
                        success: false,
                        error: providerError || `Gagal kirim via ${resolved.type || 'WhatsApp API'}`
                    };
                }
            }

            // Fallback ke sock langsung HANYA untuk mode legacy (tanpa tenant).
            // Dengan tenantId, jangan pernah kirim lewat sock bersama milik tenant lain.
            const sendTenantId = this._normalizeTenantId(options.tenantId);
            if (sendTenantId) {
                return {
                    success: false,
                    error: providerError || 'WhatsApp gateway tenant tidak siap (isolasi tenant aktif)'
                };
            }

            if (!this.sock) {
                logger.error('WhatsApp sock not initialized and provider not available');
                return {
                    success: false,
                    error: providerError || 'WhatsApp not connected'
                };
            }

            const jid = `${formattedNumber}@s.whatsapp.net`;
            
            // If imagePath provided and exists, try to send as image with caption
            if (options.imagePath) {
                try {
                    const imagePath = options.imagePath;
                    logger.info(`📸 Mencoba mengirim dengan gambar (fallback): ${imagePath}`);
                    
                    if (fs.existsSync(imagePath)) {
                        await this.sock.sendMessage(jid, { image: { url: imagePath }, caption: fullMessage });
                        logger.info(`✅ WhatsApp image notification sent to ${phoneNumber} with image (fallback)`);
                        this.incrementDailyMessageCount();
                        return { success: true, withImage: true };
                    }
                } catch (imgErr) {
                    logger.error(`❌ Failed sending image to ${phoneNumber}:`, imgErr);
                }
            }

            // Send as text message (fallback)
            await this.sock.sendMessage(jid, { text: fullMessage }, options);
            logger.info(`✅ WhatsApp text notification sent to ${phoneNumber} (fallback)`);
            this.incrementDailyMessageCount();
            return { success: true, withImage: false };
        } catch (error) {
            logger.error(`Error sending WhatsApp notification to ${phoneNumber}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Send bulk notifications with rate limiting
    async sendBulkNotifications(notifications) {
        try {
            const settings = this.getRateLimitSettings();
            
            if (!settings.enabled) {
                logger.info('Rate limiting disabled, sending all notifications immediately');
                return await this.sendAllNotifications(notifications);
            }

            logger.info(`Sending ${notifications.length} notifications with rate limiting enabled`);
            logger.info(`Settings: ${settings.maxMessagesPerBatch} per batch, ${settings.delayBetweenBatches}s between batches, ${settings.delayBetweenMessages}s between messages`);

            const results = {
                success: 0,
                failed: 0,
                skipped: 0,
                errors: []
            };

            // Process notifications in batches
            for (let i = 0; i < notifications.length; i += settings.maxMessagesPerBatch) {
                const batch = notifications.slice(i, i + settings.maxMessagesPerBatch);
                logger.info(`Processing batch ${Math.floor(i / settings.maxMessagesPerBatch) + 1}/${Math.ceil(notifications.length / settings.maxMessagesPerBatch)} (${batch.length} messages)`);

                // Check daily limit before processing batch
                if (!this.checkDailyMessageLimit()) {
                    logger.warn(`Daily message limit reached, skipping remaining ${notifications.length - i} notifications`);
                    results.skipped += notifications.length - i;
                    break;
                }

                // Process each notification in the batch
                for (let j = 0; j < batch.length; j++) {
                    const notification = batch[j];
                    
                    // Check daily limit for each message
                    if (!this.checkDailyMessageLimit()) {
                        logger.warn(`Daily message limit reached, skipping remaining ${batch.length - j} messages in current batch`);
                        results.skipped += batch.length - j;
                        break;
                    }

                    try {
                        const result = await this.sendNotificationWithRetry(notification.phoneNumber, notification.message, notification.options);
                        
                        if (result.success) {
                            results.success++;
                        } else {
                            results.failed++;
                            results.errors.push(`${notification.phoneNumber}: ${result.error}`);
                        }
                    } catch (error) {
                        results.failed++;
                        results.errors.push(`${notification.phoneNumber}: ${error.message}`);
                        logger.error(`Error sending notification to ${notification.phoneNumber}:`, error);
                    }

                    // Add delay between messages within batch
                    if (j < batch.length - 1 && settings.delayBetweenMessages > 0) {
                        await this.delay(settings.delayBetweenMessages * 1000);
                    }
                }

                // Add delay between batches
                if (i + settings.maxMessagesPerBatch < notifications.length && settings.delayBetweenBatches > 0) {
                    logger.info(`Waiting ${settings.delayBetweenBatches} seconds before next batch...`);
                    await this.delay(settings.delayBetweenBatches * 1000);
                }
            }

            logger.info(`Bulk notification completed: ${results.success} success, ${results.failed} failed, ${results.skipped} skipped`);
            return results;

        } catch (error) {
            logger.error('Error in sendBulkNotifications:', error);
            return {
                success: 0,
                failed: notifications.length,
                skipped: 0,
                errors: [`Bulk send error: ${error.message}`]
            };
        }
    }

    // Send message to configured WhatsApp groups (no template replacements here)
    async sendToConfiguredGroups(message) {
        try {
            const { isWaSystemMonitorEnabled } = require('./whatsappMonitoringSettings');
            if (!isWaSystemMonitorEnabled('broadcast_group_wa')) {
                logger.info('broadcast_group_wa off — skip kirim pesan ke grup WA terdaftar');
                return { success: true, sent: 0, failed: 0, skipped: 0 };
            }

            const enabled = getSetting('whatsapp_groups.enabled', true);
            if (!enabled) {
                return { success: true, sent: 0, failed: 0, skipped: 0 };
            }

            let ids = getSetting('whatsapp_groups.ids', []);
            if (!Array.isArray(ids)) {
                // collect numeric keys for compatibility
                const asObj = getSetting('whatsapp_groups', {});
                ids = [];
                Object.keys(asObj).forEach(k => {
                    if (k.match(/^ids\.\d+$/)) {
                        ids.push(asObj[k]);
                    }
                });
            }

            // Pesan grup sesuai isi yang dikirim (tanpa header/footer otomatis)
            const fullMessage = message;

            let sent = 0;
            let failed = 0;

            // Coba gunakan provider dulu
            const provider = this.getProvider();
            if (provider) {
                for (const gid of ids) {
                    try {
                        // Format group ID untuk provider (extract nomor dari JID jika perlu)
                        let groupId = gid;
                        if (typeof gid === 'string' && gid.includes('@')) {
                            groupId = gid.split('@')[0];
                        }
                        
                        const result = await provider.sendMessage(groupId, fullMessage, { isGroup: true });
                        if (result && result.success) {
                            sent++;
                            logger.info(`✅ Group message sent to ${gid} via provider`);
                        } else {
                            failed++;
                            logger.error(`Failed sending to group ${gid} via provider: ${result?.error || 'Unknown error'}`);
                        }
                        // small delay between group messages to avoid rate limit
                        await this.delay(1000);
                    } catch (e) {
                        failed++;
                        logger.error(`Failed sending to group ${gid}:`, e);
                    }
                }
            } else if (this.sock) {
                // Fallback ke sock
                for (const gid of ids) {
                    try {
                        await this.sock.sendMessage(gid, { text: fullMessage });
                        sent++;
                        // small delay between group messages to avoid rate limit
                        await this.delay(1000);
                    } catch (e) {
                        failed++;
                        logger.error(`Failed sending to group ${gid}:`, e);
                    }
                }
            } else {
                logger.error('WhatsApp provider and sock not initialized');
                return { success: false, sent: 0, failed: ids.length, skipped: 0, error: 'WhatsApp not connected' };
            }

            return { success: true, sent, failed, skipped: 0 };
        } catch (error) {
            logger.error('Error sending to configured groups:', error);
            return { success: false, sent: 0, failed: 0, skipped: 0, error: error.message };
        }
    }

    // Send notification with retry logic
    async sendNotificationWithRetry(phoneNumber, message, options = {}, retryCount = 0) {
        const settings = this.getRateLimitSettings();
        const maxRetries = settings.maxRetries;

        try {
            const result = await this.sendNotification(phoneNumber, message, options);
            
            if (result.success) {
                return result;
            }

            // Retry if failed and retry count not exceeded
            if (retryCount < maxRetries) {
                logger.warn(`Retry ${retryCount + 1}/${maxRetries} for ${phoneNumber}: ${result.error}`);
                await this.delay(2000 * (retryCount + 1)); // Exponential backoff
                return await this.sendNotificationWithRetry(phoneNumber, message, options, retryCount + 1);
            }

            return result;
        } catch (error) {
            if (retryCount < maxRetries) {
                logger.warn(`Retry ${retryCount + 1}/${maxRetries} for ${phoneNumber}: ${error.message}`);
                await this.delay(2000 * (retryCount + 1)); // Exponential backoff
                return await this.sendNotificationWithRetry(phoneNumber, message, options, retryCount + 1);
            }

            return { success: false, error: error.message };
        }
    }

    // Send all notifications without rate limiting
    async sendAllNotifications(notifications) {
        const results = {
            success: 0,
            failed: 0,
            skipped: 0,
            errors: []
        };

        for (const notification of notifications) {
            try {
                const result = await this.sendNotification(notification.phoneNumber, notification.message, notification.options);
                
                if (result.success) {
                    results.success++;
                } else {
                    results.failed++;
                    results.errors.push(`${notification.phoneNumber}: ${result.error}`);
                }
            } catch (error) {
                results.failed++;
                results.errors.push(`${notification.phoneNumber}: ${error.message}`);
                logger.error(`Error sending notification to ${notification.phoneNumber}:`, error);
            }
        }

        return results;
    }

    // Utility function for delays
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Send invoice created notification (jadwal: H-X sebelum jatuh tempo; manual/test: monitor terpisah)
    async sendInvoiceCreatedNotification(customerId, invoiceId, options = {}) {
        try {
            const monitorId = options.fromSchedule ? 'billing_daily_due_wa' : 'billing_scheduler_invoice_wa';
            if (!this.isSystemMonitorEnabled(monitorId)) {
                logger.info(`${monitorId} off — skip invoice created notification`);
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            const customer = await billingManager.getCustomerById(customerId);
            const invoice = await billingManager.getInvoiceById(invoiceId);
            const packageData = await billingManager.getPackageById(invoice.package_id);

            if (!customer || !invoice || !packageData) {
                logger.error('Missing data for invoice notification');
                return { success: false, error: 'Missing data' };
            }

            const { templates, tenantId } = await this.resolveTemplatesForSend(invoice.tenant_id, customer.tenant_id);
            if (!this.isTemplateEnabled('invoice_created', templates)) {
                logger.info('Invoice created notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const data = {
                customer_name: customer.name,
                invoice_number: invoice.invoice_number,
                amount: this.formatCurrency(invoice.amount),
                due_date: this.formatDate(invoice.due_date),
                package_name: packageData.name,
                package_speed: packageData.speed,
                notes: invoice.notes || 'Tagihan bulanan'
            };

            const message = await this.renderTemplate(
                templates.invoice_created.template,
                data,
                tenantId || invoice.tenant_id || customer.tenant_id
            );

            // Attach invoice banner image if available
            const imagePath = await this.getInvoiceImagePath(invoice.tenant_id || customer.tenant_id);
            return await this.sendNotification(customer.phone, message, {
                imagePath,
                tenantId: tenantId || invoice.tenant_id || customer.tenant_id
            });
        } catch (error) {
            logger.error('Error sending invoice created notification:', error);
            return { success: false, error: error.message };
        }
    }

    _resolveDueReminderTemplateKey(reminderType = 'before') {
        return reminderType === 'today' ? 'due_date_reminder_today' : 'due_date_reminder';
    }

    _calcDaysRemaining(dueDateStr) {
        return Math.max(0, this._calcDaysRemainingSigned(dueDateStr));
    }

    _calcDaysRemainingSigned(dueDateStr) {
        const raw = String(dueDateStr || '').slice(0, 10);
        const parts = raw.split('-').map((n) => parseInt(n, 10));
        if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return 0;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const due = new Date(parts[0], parts[1] - 1, parts[2]);
        due.setHours(0, 0, 0, 0);
        return Math.round((due - today) / (1000 * 60 * 60 * 24));
    }

    /**
     * Resolve which WhatsApp template to use for a manual invoice send from admin UI.
     * @returns {{ templateKey: string, reminderType?: string }}
     */
    resolveManualInvoiceTemplateKey(invoice) {
        if (!invoice) return { templateKey: 'invoice_created' };
        if (String(invoice.status).toLowerCase() === 'paid') {
            return { templateKey: 'payment_received' };
        }
        const days = this._calcDaysRemainingSigned(invoice.due_date);
        if (days === 0) {
            return { templateKey: 'due_date_reminder_today', reminderType: 'today' };
        }
        return { templateKey: 'due_date_reminder', reminderType: 'before' };
    }

    async _getCompanyHeaderFooter(tenantId = null) {
        let companyHeader = getSetting('company_header', '📱 SISTEM BILLING 📱\n\n');
        let footerInfo = getSetting('footer_info', 'Powered by Alijaya Digital Network');
        const tid = this._normalizeTenantId(tenantId);
        if (tid) {
            try {
                const { getFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
                const ts = await getFullSettingsForTenantId(tid);
                if (ts?.company_header != null && String(ts.company_header).length) {
                    companyHeader = ts.company_header;
                }
                if (ts?.footer_info != null && String(ts.footer_info).length) {
                    footerInfo = ts.footer_info;
                }
            } catch (err) {
                logger.warn('⚠️ Gagal load header/footer tenant:', err.message);
            }
        }
        return { companyHeader, footerInfo };
    }

    async wrapMessageWithHeaderFooter(message, tenantId = null) {
        // Tidak lagi menambahkan header/footer tenant otomatis —
        // pesan harus sesuai template yang diedit di WhatsApp Settings.
        return message == null ? '' : String(message);
    }

    /**
     * Build preview (and optional send payload) for invoice WhatsApp using tenant templates.
     */
    async buildManualInvoiceWhatsAppPayload(invoiceId, options = {}) {
        const invoice = await billingManager.getInvoiceById(invoiceId);
        if (!invoice) {
            return { success: false, error: 'Invoice tidak ditemukan' };
        }

        const isMemberInvoice = invoice.member_id !== null && invoice.member_id !== undefined;
        let phone;
        let customerName;
        let packageData;
        let partyTenantId = null;

        if (isMemberInvoice) {
            const member = await billingManager.getMemberById(invoice.member_id);
            if (!member) return { success: false, error: 'Member tidak ditemukan' };
            packageData = await billingManager.getMemberPackageById(invoice.package_id);
            phone = member.phone;
            customerName = member.name;
            partyTenantId = member.tenant_id;
        } else {
            const customer = await billingManager.getCustomerById(invoice.customer_id);
            if (!customer) return { success: false, error: 'Customer tidak ditemukan' };
            packageData = await billingManager.getPackageById(invoice.package_id);
            phone = customer.phone;
            customerName = customer.name;
            partyTenantId = customer.tenant_id;
        }

        if (!phone) {
            return { success: false, error: 'Nomor telepon tidak ditemukan' };
        }

        const { templates, tenantId } = await this.resolveTemplatesForSend(
            options.tenantId,
            invoice.tenant_id,
            partyTenantId
        );
        const resolvedTenantId = tenantId || invoice.tenant_id || partyTenantId || options.tenantId || null;
        const { templateKey } = this.resolveManualInvoiceTemplateKey(invoice);

        if (!this.isTemplateEnabled(templateKey, templates)) {
            return {
                success: false,
                error: `Template WhatsApp "${templateKey}" nonaktif di pengaturan tenant`
            };
        }

        const tpl = templates[templateKey];
        if (!tpl || !tpl.template) {
            return { success: false, error: `Template WhatsApp "${templateKey}" tidak ditemukan` };
        }

        const daysSigned = this._calcDaysRemainingSigned(invoice.due_date);
        const data = {
            customer_name: customerName,
            invoice_number: invoice.invoice_number,
            amount: this.formatCurrency(invoice.amount),
            due_date: this.formatDate(invoice.due_date),
            days_remaining: String(Math.max(0, daysSigned)),
            package_name: packageData?.name || '-',
            package_speed: packageData?.speed || '-',
            notes: invoice.notes || 'Tagihan bulanan',
            payment_method: options.payment_method || 'Manual Admin',
            payment_date: options.payment_date || this.formatDate(new Date()),
            reference_number: options.reference_number || '-'
        };

        if (templateKey === 'payment_received') {
            try {
                const payments = await billingManager.getPaymentsByInvoiceId
                    ? await billingManager.getPaymentsByInvoiceId(invoice.id)
                    : (await billingManager.getPayments()).filter((p) => p.invoice_id === invoice.id);
                const payment = Array.isArray(payments) ? payments[0] : null;
                if (payment) {
                    data.payment_method = payment.payment_method || data.payment_method;
                    data.payment_date = payment.payment_date
                        ? this.formatDate(payment.payment_date)
                        : data.payment_date;
                    data.reference_number = payment.reference_number || data.reference_number;
                    data.amount = this.formatCurrency(payment.amount != null ? payment.amount : invoice.amount);
                }
            } catch (_) { /* keep defaults */ }
        }

        const body = await this.renderTemplate(tpl.template, data, resolvedTenantId);
        const fullMessage = body;

        return {
            success: true,
            phone,
            customerName,
            templateKey,
            templateTitle: tpl.title || templateKey,
            body,
            fullMessage,
            tenantId: resolvedTenantId,
            invoice,
            data
        };
    }

    /**
     * Manual send from invoice list — uses tenant WhatsApp templates + tenant provider.
     * Does not depend on scheduled system monitors.
     */
    async sendManualInvoiceWhatsApp(invoiceId, options = {}) {
        try {
            const payload = await this.buildManualInvoiceWhatsAppPayload(invoiceId, options);
            if (!payload.success) {
                return { success: false, error: payload.error };
            }

            const imagePath = await this.getInvoiceImagePath(payload.tenantId);
            const result = await this.sendNotification(payload.phone, payload.body, {
                imagePath,
                tenantId: payload.tenantId
            });

            if (result.success) {
                return {
                    ...result,
                    templateKey: payload.templateKey,
                    phone: payload.phone
                };
            }
            return result;
        } catch (error) {
            logger.error('Error sending manual invoice WhatsApp:', error);
            return { success: false, error: error.message };
        }
    }

    // Send due date reminder (before jatuh tempo atau hari H)
    async sendDueDateReminder(invoiceId, options = {}) {
        try {
            if (!options.fromManual && !this.isSystemMonitorEnabled('billing_daily_due_wa')) {
                logger.info('billing_daily_due_wa off — skip due date reminder notification');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            const reminderType = options.reminderType === 'today' ? 'today' : 'before';
            const templateKey = this._resolveDueReminderTemplateKey(reminderType);

            const invoice = await billingManager.getInvoiceById(invoiceId);
            const customer = await billingManager.getCustomerById(invoice.customer_id);
            const packageData = await billingManager.getPackageById(invoice.package_id);

            if (!customer || !invoice || !packageData) {
                logger.error('Missing data for due date reminder');
                return { success: false, error: 'Missing data' };
            }

            const { templates, tenantId } = await this.resolveTemplatesForSend(invoice.tenant_id, customer.tenant_id);
            if (!this.isTemplateEnabled(templateKey, templates)) {
                logger.info(`Template ${templateKey} disabled, skipping...`);
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const daysRemaining = this._calcDaysRemaining(invoice.due_date);

            const data = {
                customer_name: customer.name,
                invoice_number: invoice.invoice_number,
                amount: this.formatCurrency(invoice.amount),
                due_date: this.formatDate(invoice.due_date),
                days_remaining: daysRemaining,
                package_name: packageData.name,
                package_speed: packageData.speed
            };

            const tpl = templates[templateKey];
            const message = await this.renderTemplate(
                tpl.template,
                data,
                tenantId || invoice.tenant_id || customer.tenant_id
            );

            const imagePath = await this.getInvoiceImagePath(invoice.tenant_id || customer.tenant_id);
            return await this.sendNotification(customer.phone, message, {
                imagePath,
                tenantId: tenantId || invoice.tenant_id || customer.tenant_id
            });
        } catch (error) {
            logger.error('Error sending due date reminder:', error);
            return { success: false, error: error.message };
        }
    }

    // Send member invoice created notification
    async sendMemberInvoiceCreatedNotification(memberId, invoiceId, options = {}) {
        try {
            const monitorId = options.fromSchedule ? 'billing_daily_due_wa' : 'billing_scheduler_invoice_wa';
            if (!this.isSystemMonitorEnabled(monitorId)) {
                logger.info(`${monitorId} off — skip member invoice created notification`);
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            const member = await billingManager.getMemberById(memberId);
            const invoice = await billingManager.getInvoiceById(invoiceId);
            const packageData = await billingManager.getMemberPackageById(invoice.package_id);

            if (!member || !invoice || !packageData) {
                logger.error('Missing data for member invoice notification');
                return { success: false, error: 'Missing data' };
            }

            const { templates, tenantId } = await this.resolveTemplatesForSend(invoice.tenant_id, member.tenant_id);
            if (!this.isTemplateEnabled('invoice_created', templates)) {
                logger.info('Member invoice created notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const data = {
                customer_name: member.name,
                invoice_number: invoice.invoice_number,
                amount: this.formatCurrency(invoice.amount),
                due_date: this.formatDate(invoice.due_date),
                package_name: packageData.name,
                package_speed: packageData.speed,
                notes: invoice.notes || 'Tagihan bulanan member'
            };

            const message = await this.renderTemplate(
                templates.invoice_created.template,
                data,
                tenantId || invoice.tenant_id || member.tenant_id
            );

            const imagePath = await this.getInvoiceImagePath(invoice.tenant_id || member.tenant_id);
            return await this.sendNotification(member.phone, message, {
                imagePath,
                tenantId: tenantId || invoice.tenant_id || member.tenant_id
            });
        } catch (error) {
            logger.error('Error sending member invoice created notification:', error);
            return { success: false, error: error.message };
        }
    }

    // Send member due date reminder
    async sendMemberDueDateReminder(invoiceId, options = {}) {
        try {
            if (!this.isSystemMonitorEnabled('billing_daily_due_wa')) {
                logger.info('billing_daily_due_wa off — skip member due date reminder notification');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            const reminderType = options.reminderType === 'today' ? 'today' : 'before';
            const templateKey = this._resolveDueReminderTemplateKey(reminderType);

            const invoice = await billingManager.getInvoiceById(invoiceId);
            const member = await billingManager.getMemberById(invoice.member_id);
            const packageData = await billingManager.getMemberPackageById(invoice.package_id);

            if (!member || !invoice || !packageData) {
                logger.error('Missing data for member due date reminder');
                return { success: false, error: 'Missing data' };
            }

            const { templates, tenantId } = await this.resolveTemplatesForSend(invoice.tenant_id, member.tenant_id);
            if (!this.isTemplateEnabled(templateKey, templates)) {
                logger.info(`Member template ${templateKey} disabled, skipping...`);
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const daysRemaining = this._calcDaysRemaining(invoice.due_date);

            const data = {
                customer_name: member.name,
                invoice_number: invoice.invoice_number,
                amount: this.formatCurrency(invoice.amount),
                due_date: this.formatDate(invoice.due_date),
                days_remaining: daysRemaining,
                package_name: packageData.name,
                package_speed: packageData.speed
            };

            const tpl = templates[templateKey];
            const message = await this.renderTemplate(
                tpl.template,
                data,
                tenantId || invoice.tenant_id || member.tenant_id
            );

            const imagePath = await this.getInvoiceImagePath(invoice.tenant_id || member.tenant_id);
            return await this.sendNotification(member.phone, message, {
                imagePath,
                tenantId: tenantId || invoice.tenant_id || member.tenant_id
            });
        } catch (error) {
            logger.error('Error sending member due date reminder:', error);
            return { success: false, error: error.message };
        }
    }

    // Send member isolir notification
    async sendMemberIsolirNotification(memberId, reason = 'Telat bayar') {
        try {
            const member = await billingManager.getMemberById(memberId);
            if (!member) {
                logger.error('Member not found for isolir notification');
                return { success: false, error: 'Member not found' };
            }

            const message = `🚨 *AKUN ANDA DIISOLIR*

Halo ${member.name},

Akun hotspot Anda telah diisolir karena:
${reason}

📋 *Informasi Akun:*
👤 Username: ${member.hotspot_username || '-'}
📦 Paket: ${member.package_name || '-'}
📅 Status: ISOLIR

Silakan lakukan pembayaran tagihan yang tertunggak untuk mengaktifkan kembali layanan Anda.

Terima kasih.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CV Lintas Multimedia
Internet Tanpa Batas`;

            return await this.sendNotification(member.phone, message);
        } catch (error) {
            logger.error('Error sending member isolir notification:', error);
            return { success: false, error: error.message };
        }
    }

    // Send payment received notification (overload: by paymentId or by phone + data)
    async sendPaymentReceivedNotification(paymentIdOrPhone, data = null) {
        try {
            if (!this.isSystemMonitorEnabled('payment_received_wa')) {
                logger.info('payment_received_wa off — skip payment received notification');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            let phone, notificationData, invoice;
            let tenantHint = null;

            // If data is provided, use it directly (for member or custom notification)
            if (data && typeof paymentIdOrPhone === 'string') {
                phone = paymentIdOrPhone;
                notificationData = data;
                tenantHint = data.tenant_id;
                // Try to get invoice from data if available
                if (data.invoice_id) {
                    invoice = await billingManager.getInvoiceById(data.invoice_id);
                    if (!tenantHint && invoice) tenantHint = invoice.tenant_id;
                }
            } else {
                // Legacy: get payment by ID
                const payment = await billingManager.getPaymentById(paymentIdOrPhone);
                invoice = await billingManager.getInvoiceById(payment.invoice_id);
                const isMemberInvoice = invoice.member_id !== null && invoice.member_id !== undefined;
                tenantHint = payment?.tenant_id || invoice?.tenant_id;

                if (isMemberInvoice) {
                    // Handle member payment
                    const member = await billingManager.getMemberById(invoice.member_id);
                    const packageData = await billingManager.getMemberPackageById(invoice.package_id);

                    if (!member || !invoice) {
                        logger.error('Missing data for member payment notification');
                        return { success: false, error: 'Missing data' };
                    }

                    phone = member.phone;
                    tenantHint = tenantHint || member.tenant_id;
                    notificationData = {
                        customer_name: member.name,
                        invoice_number: invoice.invoice_number,
                        amount: this.formatCurrency(payment.amount),
                        payment_method: payment.payment_method,
                        payment_date: this.formatDate(payment.payment_date),
                        reference_number: payment.reference_number || 'N/A',
                        package_name: packageData?.name || '-',
                        package_speed: packageData?.speed || '-'
                    };
                } else {
                    // Handle customer payment
                    const customer = await billingManager.getCustomerById(invoice.customer_id);
                    const packageData = await billingManager.getPackageById(invoice.package_id);

                    if (!payment || !invoice || !customer) {
                        logger.error('Missing data for payment notification');
                        return { success: false, error: 'Missing data' };
                    }

                    phone = customer.phone;
                    tenantHint = tenantHint || customer.tenant_id;
                    notificationData = {
                        customer_name: customer.name,
                        invoice_number: invoice.invoice_number,
                        amount: this.formatCurrency(payment.amount),
                        payment_method: payment.payment_method,
                        payment_date: this.formatDate(payment.payment_date),
                        reference_number: payment.reference_number || 'N/A',
                        package_name: packageData?.name || '-',
                        package_speed: packageData?.speed || '-'
                    };
                }
            }

            const { templates, tenantId } = await this.resolveTemplatesForSend(tenantHint, invoice?.tenant_id);
            if (!this.isTemplateEnabled('payment_received', templates)) {
                logger.info('Payment received notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const message = await this.renderTemplate(
                templates.payment_received.template,
                notificationData,
                tenantId || tenantHint || invoice?.tenant_id
            );

            // Generate dan kirim invoice PDF (hanya jika invoice tersedia)
            let pdfPath = null;
            try {
                if (invoice && invoice.id) {
                    const { generateInvoicePdf } = require('./invoicePdf');
                    const pdfResult = await generateInvoicePdf(invoice.id);
                    
                    // Simpan PDF ke temporary file
                    const tempDir = path.join(__dirname, '../temp');
                    if (!fs.existsSync(tempDir)) {
                        fs.mkdirSync(tempDir, { recursive: true });
                    }
                    
                    pdfPath = path.join(tempDir, pdfResult.fileName);
                    fs.writeFileSync(pdfPath, pdfResult.buffer);
                    logger.info(`📄 Invoice PDF generated: ${pdfPath}`);
                    
                    // Kirim PDF sebagai dokumen (pakai kredensial gateway tenant)
                    const resolvedPdf = await this.resolveSendProvider(tenantId || tenantHint || invoice?.tenant_id);
                    const provider = resolvedPdf.provider;
                    if (provider) {
                        const formattedNumber = this.formatPhoneNumber(phone);
                        const result = await provider.sendMedia(
                            formattedNumber, 
                            pdfPath, 
                            message, 
                            { 
                                mimetype: 'application/pdf',
                                fileName: pdfResult.fileName
                            }
                        );
                        
                        if (result.success) {
                            logger.info(`✅ Payment notification with PDF sent to ${phone}`);
                            this.incrementDailyMessageCount();
                            
                            // Hapus temporary file setelah berhasil dikirim
                            try {
                                if (fs.existsSync(pdfPath)) {
                                    fs.unlinkSync(pdfPath);
                                    logger.debug(`🗑️ Temporary PDF file deleted: ${pdfPath}`);
                                }
                            } catch (deleteError) {
                                logger.warn(`⚠️ Failed to delete temporary PDF: ${deleteError.message}`);
                            }
                            
                            return { success: true, withPdf: true };
                        } else {
                            logger.warn(`⚠️ Failed to send PDF, falling back to text: ${result.error}`);
                            // Hapus file meskipun gagal dikirim untuk mencegah penumpukan file
                            try {
                                if (fs.existsSync(pdfPath)) {
                                    fs.unlinkSync(pdfPath);
                                    logger.debug(`🗑️ Temporary PDF file deleted after failed send: ${pdfPath}`);
                                }
                            } catch (deleteError) {
                                logger.warn(`⚠️ Failed to delete temporary PDF: ${deleteError.message}`);
                            }
                        }
                    } else {
                        // Provider tidak tersedia, hapus file
                        try {
                            if (fs.existsSync(pdfPath)) {
                                fs.unlinkSync(pdfPath);
                                logger.debug(`🗑️ Temporary PDF file deleted (no provider): ${pdfPath}`);
                            }
                        } catch (deleteError) {
                            logger.warn(`⚠️ Failed to delete temporary PDF: ${deleteError.message}`);
                        }
                    }
                }
            } catch (pdfError) {
                logger.error('Error generating/sending invoice PDF:', pdfError);
                // Pastikan file dihapus jika ada error
                if (pdfPath && fs.existsSync(pdfPath)) {
                    try {
                        fs.unlinkSync(pdfPath);
                        logger.debug(`🗑️ Temporary PDF file deleted after error: ${pdfPath}`);
                    } catch (deleteError) {
                        logger.warn(`⚠️ Failed to delete temporary PDF after error: ${deleteError.message}`);
                    }
                }
                // Fallback: kirim text message saja jika PDF gagal
            }

            // Fallback: kirim text message jika PDF gagal atau provider tidak tersedia
            return await this.sendNotification(phone, message, {
                tenantId: tenantId || tenantHint || invoice?.tenant_id
            });
        } catch (error) {
            logger.error('Error sending payment received notification:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Notifikasi WA untuk pelunasan beberapa invoice sekaligus (kolektor).
     * Memakai template payment_received dengan nomor invoice digabung + PDF resi batch.
     */
    async sendCollectorBatchPaymentReceivedNotification(paymentIds) {
        try {
            const ids = [...new Set((paymentIds || [])
                .map((v) => parseInt(String(v), 10))
                .filter((id) => Number.isFinite(id) && id > 0))];
            if (!ids.length) {
                return { success: false, error: 'No payment ids' };
            }
            if (ids.length === 1) {
                return this.sendPaymentReceivedNotification(ids[0]);
            }
            if (!this.isSystemMonitorEnabled('payment_received_wa')) {
                logger.info('payment_received_wa off — skip batch payment received notification');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            const rows = [];
            for (const paymentId of ids) {
                const payment = await billingManager.getPaymentById(paymentId);
                if (!payment) continue;
                const invoice = await billingManager.getInvoiceById(payment.invoice_id);
                if (!invoice) continue;
                rows.push({ payment, invoice });
            }
            if (!rows.length) {
                return { success: false, error: 'Missing payment/invoice data' };
            }

            const primary = rows[0];
            const isMember = primary.invoice.member_id != null;
            let phone;
            let customerName;
            let tenantHint = primary.payment?.tenant_id || primary.invoice?.tenant_id;

            if (isMember) {
                const member = await billingManager.getMemberById(primary.invoice.member_id);
                if (!member) return { success: false, error: 'Missing member' };
                phone = member.phone;
                customerName = member.name;
                tenantHint = tenantHint || member.tenant_id;
            } else {
                const customer = await billingManager.getCustomerById(primary.invoice.customer_id);
                if (!customer) return { success: false, error: 'Missing customer' };
                phone = customer.phone;
                customerName = customer.name;
                tenantHint = tenantHint || customer.tenant_id;
            }

            const invoiceNumbers = rows.map((r) => r.invoice.invoice_number || `#${r.invoice.id}`);
            const packageLabels = [];
            for (const r of rows) {
                let pkg = null;
                if (r.invoice.member_id != null) {
                    pkg = await billingManager.getMemberPackageById(r.invoice.package_id);
                } else {
                    pkg = await billingManager.getPackageById(r.invoice.package_id);
                }
                const label = [pkg?.name, pkg?.speed].filter(Boolean).join(' ').trim();
                if (label) packageLabels.push(label);
            }

            let gross = 0;
            let discount = 0;
            for (const r of rows) {
                const invAmt = Number(r.invoice.amount) || Number(r.payment.amount) || 0;
                const disc = Number(r.payment.discount_amount) || 0;
                gross += invAmt;
                discount += disc;
            }
            const netPaid = Math.max(0, gross - discount);
            const paymentMethod = primary.payment.payment_method || '';
            const paymentDate = rows
                .map((r) => r.payment.payment_date)
                .filter(Boolean)
                .sort()
                .slice(-1)[0] || primary.payment.payment_date;
            const refs = rows
                .map((r) => r.payment.reference_number)
                .filter((v) => v && String(v).trim() && String(v).trim() !== 'N/A');

            const notificationData = {
                customer_name: customerName,
                invoice_number: invoiceNumbers.join(', '),
                amount: this.formatCurrency(netPaid),
                payment_method: paymentMethod,
                payment_date: this.formatDate(paymentDate),
                reference_number: refs.length ? refs.join(', ') : 'N/A',
                package_name: packageLabels.length ? `${rows.length} tagihan: ${packageLabels.join('; ')}` : `${rows.length} tagihan`,
                package_speed: ''
            };

            const { templates, tenantId } = await this.resolveTemplatesForSend(
                tenantHint,
                primary.invoice?.tenant_id
            );
            if (!this.isTemplateEnabled('payment_received', templates)) {
                logger.info('Payment received notification is disabled, skipping batch...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const message = await this.renderTemplate(
                templates.payment_received.template,
                notificationData,
                tenantId || tenantHint || primary.invoice?.tenant_id
            );

            let pdfPath = null;
            try {
                const { generateCollectorBatchReceiptPdf } = require('./invoicePdf');
                const pdfResult = await generateCollectorBatchReceiptPdf(
                    rows.map((r) => r.invoice.id)
                );
                const tempDir = path.join(__dirname, '../temp');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }
                pdfPath = path.join(tempDir, pdfResult.fileName || `Resi-${rows.length}-invoice.pdf`);
                fs.writeFileSync(pdfPath, pdfResult.buffer);

                const resolvedPdf = await this.resolveSendProvider(
                    tenantId || tenantHint || primary.invoice?.tenant_id
                );
                const provider = resolvedPdf.provider;
                if (provider) {
                    const formattedNumber = this.formatPhoneNumber(phone);
                    const result = await provider.sendMedia(formattedNumber, pdfPath, message, {
                        mimetype: 'application/pdf',
                        fileName: pdfResult.fileName || `Resi-${rows.length}-invoice.pdf`
                    });
                    if (result.success) {
                        logger.info(`✅ Batch payment notification with PDF sent to ${phone}`);
                        this.incrementDailyMessageCount();
                        try {
                            if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
                        } catch (_) {
                            /* ignore */
                        }
                        return { success: true, withPdf: true, batch: true };
                    }
                    logger.warn(`⚠️ Failed to send batch PDF, falling back to text: ${result.error}`);
                }
            } catch (pdfError) {
                logger.error('Error generating/sending batch payment PDF:', pdfError);
            } finally {
                if (pdfPath && fs.existsSync(pdfPath)) {
                    try {
                        fs.unlinkSync(pdfPath);
                    } catch (_) {
                        /* ignore */
                    }
                }
            }

            return await this.sendNotification(phone, message, {
                tenantId: tenantId || tenantHint || primary.invoice?.tenant_id
            });
        } catch (error) {
            logger.error('Error sending batch payment received notification:', error);
            return { success: false, error: error.message };
        }
    }

    // Send service disruption notification
    async sendServiceDisruptionNotification(disruptionData) {
        try {
            const { templates, tenantId } = await this.resolveTemplatesForSend(disruptionData?.tenant_id);
            if (!this.isTemplateEnabled('service_disruption', templates)) {
                logger.info('Service disruption notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const customers = await billingManager.getCustomers();
            const activeCustomers = customers.filter(c => c.status === 'active' && c.phone);

            const data = {
                disruption_type: disruptionData.type || 'Gangguan Jaringan',
                affected_area: disruptionData.area || 'Seluruh Area',
                estimated_resolution: disruptionData.estimatedTime || 'Sedang dalam penanganan',
                support_phone: getSetting('support_phone', '0813-6888-8498')
            };

            const message = await this.renderTemplate(
                templates.service_disruption.template,
                data,
                tenantId || disruptionData?.tenant_id
            );

            // Prepare notifications for bulk sending
            const notifications = activeCustomers.map(customer => ({
                phoneNumber: customer.phone,
                message: message,
                options: {}
            }));

            // Use bulk notifications with rate limiting
            const result = await this.sendBulkNotifications(notifications);

            // Also send to configured groups
            const groupMessage = message;
            const groupRes = await this.sendToConfiguredGroups(groupMessage);

            return {
                success: true,
                sent: result.success + (groupRes.sent || 0),
                failed: result.failed + (groupRes.failed || 0),
                skipped: result.skipped + (groupRes.skipped || 0),
                total: activeCustomers.length,
                errors: result.errors,
                customer_sent: result.success,
                customer_failed: result.failed,
                group_sent: groupRes.sent || 0,
                group_failed: groupRes.failed || 0
            };
        } catch (error) {
            logger.error('Error sending service disruption notification:', error);
            return { success: false, error: error.message };
        }
    }

    // Send service announcement
    async sendServiceAnnouncement(announcementData) {
        try {
            const { templates, tenantId } = await this.resolveTemplatesForSend(announcementData?.tenant_id);
            if (!this.isTemplateEnabled('service_announcement', templates)) {
                logger.info('Service announcement notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const customers = await billingManager.getCustomers();
            const activeCustomers = customers.filter(c => c.status === 'active' && c.phone);

            const data = {
                announcement_content: announcementData.content || 'Tidak ada konten pengumuman'
            };

            const message = await this.renderTemplate(
                templates.service_announcement.template,
                data,
                tenantId || announcementData?.tenant_id
            );

            // Prepare notifications for bulk sending
            const notifications = activeCustomers.map(customer => ({
                phoneNumber: customer.phone,
                message: message,
                options: {}
            }));

            // Use bulk notifications with rate limiting
            const result = await this.sendBulkNotifications(notifications);

            // Also send to configured groups
            const groupMessage = message;
            const groupRes = await this.sendToConfiguredGroups(groupMessage);

            return {
                success: true,
                sent: result.success + (groupRes.sent || 0),
                failed: result.failed + (groupRes.failed || 0),
                skipped: result.skipped + (groupRes.skipped || 0),
                total: activeCustomers.length,
                errors: result.errors,
                customer_sent: result.success,
                customer_failed: result.failed,
                group_sent: groupRes.sent || 0,
                group_failed: groupRes.failed || 0
            };
        } catch (error) {
            logger.error('Error sending service announcement:', error);
            return { success: false, error: error.message };
        }
    }

    /** Merge file JSON with built-in defaults (e.g. after adding new template keys). */
    loadTemplates() {
        this._rebuildTemplatesFromDisk();
        return this.templates;
    }

    // Save templates to global file (legacy / non-tenant)
    saveTemplates() {
        try {
            const dataDir = path.dirname(this.templatesFile);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            fs.writeFileSync(this.templatesFile, JSON.stringify(this.templates, null, 2));
            console.log('✅ [WHATSAPP] Templates saved to file');
            return true;
        } catch (error) {
            console.error('❌ [WHATSAPP] Error saving templates:', error);
            return false;
        }
    }

    /**
     * @param {number|null} [tenantId]
     * @returns {Promise<object>}
     */
    async getTemplates(tenantId = null) {
        const tid = this._normalizeTenantId(tenantId) ?? this.resolveTenantId();
        return this.getResolvedTemplates(tid);
    }

    /**
     * Update one template for tenant (or global file if no tenant).
     * @returns {Promise<boolean>}
     */
    async updateTemplate(templateKey, newTemplate, tenantId = null) {
        const defaults = getBuiltInWhatsAppTemplates();
        if (!defaults[templateKey]) return false;
        const result = await this.updateTemplates({ [templateKey]: newTemplate }, tenantId);
        return result > 0;
    }

    /**
     * Update multiple templates. Isolated per tenant when tenantId / ALS is available.
     * @returns {Promise<number>} number of keys updated
     */
    async updateTemplates(templatesData, tenantId = null) {
        const allowed = new Set(Object.keys(getBuiltInWhatsAppTemplates()));
        const incoming = templatesData && typeof templatesData === 'object' ? templatesData : {};
        const tid = this._normalizeTenantId(tenantId) ?? this.resolveTenantId();

        let updated = 0;
        const applyIncoming = (base) => {
            const next = { ...base };
            Object.keys(incoming).forEach((key) => {
                if (!allowed.has(key)) return;
                const src = incoming[key] || {};
                if (!next[key]) next[key] = { ...getBuiltInWhatsAppTemplates()[key] };
                next[key] = {
                    title: src.title != null ? src.title : next[key].title,
                    template: src.template !== undefined ? src.template : next[key].template,
                    enabled: src.enabled !== undefined ? !!src.enabled : next[key].enabled
                };
                updated++;
            });
            return next;
        };

        if (tid) {
            const current = await this.getResolvedTemplates(tid);
            const next = applyIncoming(current);
            if (updated === 0) return 0;
            const { saveFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
            await saveFullSettingsForTenantId(tid, {
                whatsapp_templates: this._serializeTemplatesForStorage(next)
            });
            this.invalidateTenantTemplatesCache(tid);
            return updated;
        }

        const next = applyIncoming(this.templates);
        this.templates = next;
        if (updated > 0) this.saveTemplates();
        return updated;
    }

    /**
     * @param {string} templateKey
     * @param {object|null} [templates] resolved map; defaults to in-memory global
     */
    isTemplateEnabled(templateKey, templates = null) {
        const map = templates || this.templates;
        return !!(map && map[templateKey] && map[templateKey].enabled !== false);
    }

    // Test notification to specific number
    async testNotification(phoneNumber, templateKey, testData = {}, tenantId = null) {
        try {
            const tid = this._normalizeTenantId(tenantId) ?? this.resolveTenantId();
            const templates = await this.getResolvedTemplates(tid);
            if (!templates[templateKey]) {
                return { success: false, error: 'Template not found' };
            }

            const message = await this.renderTemplate(
                templates[templateKey].template,
                testData,
                tid
            );

            return await this.sendNotification(phoneNumber, message, { tenantId: tid });
        } catch (error) {
            logger.error('Error sending test notification:', error);
            return { success: false, error: error.message };
        }
    }

    // Send service suspension notification
    async sendServiceSuspensionNotification(customer, reason) {
        try {
            if (!this.isSystemMonitorEnabled('isolir_suspension_wa')) {
                logger.info('isolir_suspension_wa off — skip service suspension notification');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            const { templates, tenantId } = await this.resolveTemplatesForSend(customer?.tenant_id);
            if (!this.isTemplateEnabled('service_suspension', templates)) {
                logger.info('Service suspension notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            if (!customer.phone) {
                logger.warn(`Customer ${customer.username} has no phone number for suspension notification`);
                return { success: false, error: 'No phone number' };
            }

            const message = await this.renderTemplate(
                templates.service_suspension.template,
                {
                    customer_name: customer.name,
                    reason: reason,
                    username: customer.username || customer.pppoe_username || '',
                    package_name: customer.package_name || '',
                    package_speed: customer.package_speed || customer.speed || '',
                    due_date: customer.due_date ? this.formatDate(customer.due_date) : '',
                    amount: customer.amount != null ? this.formatCurrency(customer.amount) : '',
                    days_overdue: customer.days_overdue != null ? String(customer.days_overdue) : ''
                },
                tenantId || customer.tenant_id
            );

            const result = await this.sendNotification(customer.phone, message);
            if (result.success) {
                logger.info(`Service suspension notification sent to ${customer.name} (${customer.phone})`);
            } else {
                logger.error(`Failed to send service suspension notification to ${customer.name}:`, result.error);
            }
            
            return result;
        } catch (error) {
            logger.error(`Error sending service suspension notification to ${customer.name}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Send service restoration notification
    async sendServiceRestorationNotification(customer, reason) {
        try {
            if (!this.isSystemMonitorEnabled('isolir_restore_wa')) {
                logger.info('isolir_restore_wa off — skip service restoration notification');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            const { templates, tenantId } = await this.resolveTemplatesForSend(customer?.tenant_id);
            if (!this.isTemplateEnabled('service_restoration', templates)) {
                logger.info('Service restoration notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            if (!customer.phone) {
                logger.warn(`Customer ${customer.username} has no phone number for restoration notification`);
                return { success: false, error: 'No phone number' };
            }

            const message = await this.renderTemplate(
                templates.service_restoration.template,
                {
                    customer_name: customer.name,
                    package_name: customer.package_name || 'N/A',
                    package_speed: customer.package_speed || 'N/A',
                    reason: reason || '',
                    username: customer.username || customer.pppoe_username || ''
                },
                tenantId || customer.tenant_id
            );

            const result = await this.sendNotification(customer.phone, message);
            if (result.success) {
                logger.info(`Service restoration notification sent to ${customer.name} (${customer.phone})`);
            } else {
                logger.error(`Failed to send service restoration notification to ${customer.name}:`, result.error);
            }
            
            return result;
        } catch (error) {
            logger.error(`Error sending service restoration notification to ${customer.name}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Resolve customer record from installation job (by customer_id or phone, fallback to job fields)
    async resolveCustomerFromInstallationJob(installationJob) {
        if (!installationJob) return null;

        try {
            let customer = null;
            const custId =
                installationJob.customer_id != null ? parseInt(installationJob.customer_id, 10) : NaN;
            if (Number.isFinite(custId) && custId > 0) {
                customer = await billingManager.getCustomerById(custId);
            }
            if (!customer && installationJob.customer_phone) {
                customer = await billingManager.getCustomerByPhone(installationJob.customer_phone);
            }
            if (customer) {
                return {
                    ...customer,
                    phone: customer.phone || installationJob.customer_phone,
                    package_speed: customer.package_speed || customer.speed || 'N/A',
                    pppoe_password: customer.pppoe_password || customer.wifi_password || 'N/A'
                };
            }
            if (installationJob.customer_phone) {
                return {
                    name: installationJob.customer_name || 'Pelanggan',
                    phone: installationJob.customer_phone,
                    package_name: installationJob.package_name || 'N/A',
                    package_speed: installationJob.package_speed || 'N/A',
                    pppoe_username: installationJob.pppoe_username || 'N/A',
                    pppoe_password: 'N/A',
                    wifi_password: 'N/A',
                    tenant_id: installationJob.tenant_id || null
                };
            }
            return null;
        } catch (error) {
            logger.error('Error resolving customer from installation job:', error);
            return null;
        }
    }

    // Send welcome message to customer when installation job is marked complete
    async sendWelcomeMessageOnInstallComplete(installationJob) {
        const customer = await this.resolveCustomerFromInstallationJob(installationJob);
        if (!customer) {
            logger.warn('[WA] Install complete: tidak ada data pelanggan untuk welcome message');
            return { success: false, error: 'No customer data' };
        }
        logger.info(`[WA] Mengirim welcome message ke ${customer.name} setelah instalasi selesai`);
        return this.sendWelcomeMessage(customer);
    }

    // Send welcome message notification
    async sendWelcomeMessage(customer) {
        try {
            if (!this.isSystemMonitorEnabled('customer_welcome_wa')) {
                logger.info('customer_welcome_wa off — skip welcome message notification');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            const { templates, tenantId } = await this.resolveTemplatesForSend(customer?.tenant_id);
            if (!this.isTemplateEnabled('welcome_message', templates)) {
                logger.info('Welcome message notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            if (!customer.phone) {
                logger.warn(`Customer ${customer.username} has no phone number for welcome message`);
                return { success: false, error: 'No phone number' };
            }

            const tid = tenantId || customer.tenant_id || null;
            let companyHeader = getSetting('company_header', 'CV Lintas Multimedia');
            let footerInfo = getSetting('footer_info', 'Internet Tanpa Batas');
            let supportPhone = getSetting('support_phone', '') || getSetting('contact_whatsapp', '0813-6888-8498');
            try {
                if (tid) {
                    const { getFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
                    const ts = await getFullSettingsForTenantId(tid);
                    if (ts?.company_header != null && String(ts.company_header).trim()) {
                        companyHeader = String(ts.company_header).trim();
                    }
                    if (ts?.footer_info != null && String(ts.footer_info).trim()) {
                        footerInfo = String(ts.footer_info).trim();
                    }
                    if (ts?.support_phone || ts?.contact_whatsapp) {
                        supportPhone = ts.support_phone || ts.contact_whatsapp || supportPhone;
                    }
                }
            } catch (_) { /* keep defaults */ }

            const message = await this.renderTemplate(
                templates.welcome_message.template,
                {
                    customer_name: customer.name,
                    package_name: customer.package_name || 'N/A',
                    package_speed: customer.package_speed || 'N/A',
                    pppoe_username: customer.pppoe_username || 'N/A',
                    pppoe_password: customer.pppoe_password || 'N/A',
                    wifi_password: customer.wifi_password || 'N/A',
                    support_phone: supportPhone,
                    username: customer.username || customer.pppoe_username || '',
                    company_header: companyHeader,
                    footer_info: footerInfo
                },
                tid
            );

            // Template sudah berisi company_header/footer_info bila diisi di template
            const result = await this.sendNotification(customer.phone, message, {
                tenantId: tid
            });
            if (result.success) {
                logger.info(`Welcome message sent to ${customer.name} (${customer.phone})`);
            } else {
                logger.error(`Failed to send welcome message to ${customer.name}:`, result.error);
            }
            
            return result;
        } catch (error) {
            logger.error(`Error sending welcome message to ${customer.name}:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Preview teks welcome pelanggan baru (template tenant) tanpa mengirim.
     */
    async buildWelcomeMessagePreview(customer, options = {}) {
        try {
            const { templates, tenantId } = await this.resolveTemplatesForSend(
                options.tenantId,
                customer?.tenant_id
            );
            if (!templates.welcome_message) {
                return { success: false, error: 'Template welcome_message tidak ditemukan' };
            }
            const tid = tenantId || customer?.tenant_id || options.tenantId || null;
            let companyHeader = getSetting('company_header', 'CV Lintas Multimedia');
            let footerInfo = getSetting('footer_info', 'Internet Tanpa Batas');
            let supportPhone = getSetting('support_phone', '') || getSetting('contact_whatsapp', '0813-6888-8498');
            try {
                if (tid) {
                    const { getFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
                    const ts = await getFullSettingsForTenantId(tid);
                    if (ts?.company_header != null && String(ts.company_header).trim()) {
                        companyHeader = String(ts.company_header).trim();
                    }
                    if (ts?.footer_info != null && String(ts.footer_info).trim()) {
                        footerInfo = String(ts.footer_info).trim();
                    }
                    if (ts?.support_phone || ts?.contact_whatsapp) {
                        supportPhone = ts.support_phone || ts.contact_whatsapp || supportPhone;
                    }
                }
            } catch (_) { /* keep defaults */ }

            const body = await this.renderTemplate(
                templates.welcome_message.template,
                {
                    customer_name: customer?.name || 'Pelanggan',
                    package_name: customer?.package_name || 'N/A',
                    package_speed: customer?.package_speed || 'N/A',
                    pppoe_username: customer?.pppoe_username || 'N/A',
                    pppoe_password: customer?.pppoe_password || 'N/A',
                    wifi_password: customer?.wifi_password || 'N/A',
                    support_phone: supportPhone,
                    username: customer?.username || customer?.pppoe_username || '',
                    company_header: companyHeader,
                    footer_info: footerInfo
                },
                tid
            );

            return {
                success: true,
                preview: body,
                templateKey: 'welcome_message',
                templateTitle: templates.welcome_message.title || 'WA welcome pelanggan baru',
                enabled: templates.welcome_message.enabled !== false,
                phone: customer?.phone || null
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Send installation job assignment notification to technician
    async sendInstallationJobNotification(technician, installationJob, customer, packageData) {
        try {
            if (!this.isSystemMonitorEnabled('installation_job_wa')) {
                logger.info('installation_job_wa off — skip installation job notification');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            const { templates, tenantId } = await this.resolveTemplatesForSend(
                installationJob?.tenant_id,
                customer?.tenant_id,
                technician?.tenant_id
            );
            if (!this.isTemplateEnabled('installation_job_assigned', templates)) {
                logger.info('Installation job notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            if (!technician.phone) {
                logger.warn(`Technician ${technician.name} has no phone number for installation job notification`);
                return { success: false, error: 'No phone number' };
            }

            // Format installation date
            const installationDate = installationJob.installation_date ? 
                new Date(installationJob.installation_date).toLocaleDateString('id-ID') : 'TBD';

            const message = await this.renderTemplate(
                templates.installation_job_assigned.template,
                {
                    technician_name: technician.name,
                    job_number: installationJob.job_number || 'N/A',
                    customer_name: customer.name || installationJob.customer_name || 'N/A',
                    customer_phone: customer.phone || installationJob.customer_phone || 'N/A',
                    customer_address: customer.address || installationJob.customer_address || 'N/A',
                    pppoe_username: customer.pppoe_username || 'N/A',
                    pppoe_password: customer.pppoe_password || 'N/A',
                    package_name: packageData.name || installationJob.package_name || 'N/A',
                    package_price: packageData.price ? new Intl.NumberFormat('id-ID').format(packageData.price) : 
                                  installationJob.package_price ? new Intl.NumberFormat('id-ID').format(installationJob.package_price) : 'N/A',
                    installation_date: installationDate,
                    installation_time: installationJob.installation_time || 'TBD',
                    notes: installationJob.notes || 'Tidak ada catatan',
                    equipment_needed: installationJob.equipment_needed || 'Standard equipment',
                    priority: installationJob.priority || 'Normal'
                },
                tenantId || installationJob?.tenant_id || customer?.tenant_id
            );

            const result = await this.sendNotification(technician.phone, message);
            if (result.success) {
                logger.info(`Installation job notification sent to technician ${technician.name} (${technician.phone}) for job ${installationJob.job_number}`);
            } else {
                logger.error(`Failed to send installation job notification to technician ${technician.name}:`, result.error);
            }
            
            return result;
        } catch (error) {
            logger.error(`Error sending installation job notification to technician ${technician.name}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Send installation status update notification to technician
    async sendInstallationStatusUpdateNotification(technician, installationJob, customer, newStatus, notes) {
        try {
            if (!this.isSystemMonitorEnabled('installation_job_wa')) {
                logger.info('installation_job_wa off — skip installation status update notification');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            const { templates, tenantId } = await this.resolveTemplatesForSend(
                installationJob?.tenant_id,
                customer?.tenant_id,
                technician?.tenant_id
            );
            if (!this.isTemplateEnabled('installation_status_update', templates)) {
                logger.info('Installation status update notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            if (!technician.phone) {
                logger.warn(`Technician ${technician.name} has no phone number for status update notification`);
                return { success: false, error: 'No phone number' };
            }

            // Format status text
            const statusText = {
                'scheduled': 'Terjadwal',
                'assigned': 'Ditugaskan',
                'in_progress': 'Sedang Berlangsung',
                'completed': 'Selesai',
                'cancelled': 'Dibatalkan'
            }[newStatus] || newStatus;

            const message = await this.renderTemplate(
                templates.installation_status_update.template,
                {
                    technician_name: technician.name,
                    job_number: installationJob.job_number || 'N/A',
                    customer_name: customer.name || installationJob.customer_name || 'N/A',
                    new_status: statusText,
                    update_time: new Date().toLocaleString('id-ID'),
                    notes: notes || 'Tidak ada catatan'
                },
                tenantId || installationJob?.tenant_id || customer?.tenant_id
            );

            const result = await this.sendNotification(technician.phone, message);
            if (result.success) {
                logger.info(`Installation status update notification sent to technician ${technician.name} for job ${installationJob.job_number}`);
            } else {
                logger.error(`Failed to send status update notification to technician ${technician.name}:`, result.error);
            }
            
            return result;
        } catch (error) {
            logger.error(`Error sending installation status update notification to technician ${technician.name}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Send installation completion notification to technician
    async sendInstallationCompletionNotification(technician, installationJob, customer, completionNotes) {
        try {
            if (!this.isSystemMonitorEnabled('installation_job_wa')) {
                logger.info('installation_job_wa off — skip installation completion notification');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            const { templates, tenantId } = await this.resolveTemplatesForSend(
                installationJob?.tenant_id,
                customer?.tenant_id,
                technician?.tenant_id
            );
            if (!this.isTemplateEnabled('installation_completed', templates)) {
                logger.info('Installation completion notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            if (!technician.phone) {
                logger.warn(`Technician ${technician.name} has no phone number for completion notification`);
                return { success: false, error: 'No phone number' };
            }

            const message = await this.renderTemplate(
                templates.installation_completed.template,
                {
                    technician_name: technician.name,
                    job_number: installationJob.job_number || 'N/A',
                    customer_name: customer.name || installationJob.customer_name || 'N/A',
                    completion_time: new Date().toLocaleString('id-ID'),
                    completion_notes: completionNotes || 'Tidak ada catatan tambahan'
                },
                tenantId || installationJob?.tenant_id || customer?.tenant_id
            );

            const result = await this.sendNotification(technician.phone, message);
            if (result.success) {
                logger.info(`Installation completion notification sent to technician ${technician.name} for job ${installationJob.job_number}`);
            } else {
                logger.error(`Failed to send completion notification to technician ${technician.name}:`, result.error);
            }
            
            return result;
        } catch (error) {
            logger.error(`Error sending installation completion notification to technician ${technician.name}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Send Sales Order notification to technicians
    async sendSalesOrderNotification(customer) {
        try {
            if (!this.isSystemMonitorEnabled('installation_job_wa')) {
                logger.info('installation_job_wa off — skip sales order notification to technicians');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            if (!customer) {
                logger.warn('No customer data provided for Sales Order notification');
                return { success: false, error: 'No customer data' };
            }

            // Get active technicians
            const db = require('./billing').db;
            const technicians = await new Promise((resolve, reject) => {
                db.all('SELECT phone, name FROM technicians WHERE is_active = 1 AND phone IS NOT NULL AND phone != ""', [], (err, rows) => {
                    if (err) {
                        if (err.message.includes('no such table')) {
                            resolve([]);
                        } else {
                            reject(err);
                        }
                    } else {
                        resolve(rows || []);
                    }
                });
            });

            if (technicians.length === 0) {
                logger.info('No active technicians found for Sales Order notification');
                return { success: true, skipped: true, reason: 'No active technicians' };
            }

            const { templates, tenantId } = await this.resolveTemplatesForSend(customer.tenant_id);
            if (!this.isTemplateEnabled('sales_order_new_customer', templates)) {
                logger.info('Sales Order WhatsApp notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const message = await this.renderTemplate(
                templates.sales_order_new_customer.template,
                {
                    customer_id: String(customer.customer_id || 'N/A'),
                    customer_name: customer.name || 'N/A',
                    customer_phone: customer.phone || 'N/A',
                    customer_email: customer.email || 'Tidak diisi',
                    customer_address: customer.address || 'Tidak diisi',
                    package_name: customer.package_name || 'N/A',
                    package_speed: customer.package_speed || 'N/A',
                    pppoe_username: customer.pppoe_username || 'N/A',
                    pppoe_password: customer.pppoe_password || 'N/A',
                    pppoe_profile: customer.pppoe_profile || 'default'
                },
                tenantId || customer.tenant_id
            );

            // Send to all active technicians
            let sentCount = 0;
            let failedCount = 0;

            for (const technician of technicians) {
                try {
                    const result = await this.sendNotification(technician.phone, message);
                    if (result && result.success) {
                        sentCount++;
                        logger.info(`Sales Order notification sent to technician ${technician.name} (${technician.phone})`);
                    } else {
                        failedCount++;
                        logger.warn(`Failed to send Sales Order notification to technician ${technician.name}: ${result?.error || 'Unknown error'}`);
                    }
                } catch (techError) {
                    failedCount++;
                    logger.error(`Error sending Sales Order notification to technician ${technician.name}:`, techError);
                }
            }

            return {
                success: sentCount > 0,
                sent: sentCount,
                failed: failedCount,
                total: technicians.length
            };
        } catch (error) {
            logger.error('Error sending Sales Order notification to technicians:', error);
            return { success: false, error: error.message };
        }
    }
}

module.exports = new WhatsAppNotificationManager(); 