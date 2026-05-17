const WhatsAppProvider = require('../whatsapp-provider');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { getWhatsAppProviderSettings } = require('../whatsapp-provider-settings');

class MetaProvider extends WhatsAppProvider {
    constructor() {
        super();
        this.config = getWhatsAppProviderSettings().meta;
        this.status = {
            connected: false,
            phoneNumber: null,
            connectedSince: null,
            status: 'disconnected'
        };
    }

    async initialize() {
        await super.initialize();
        if (!this.config.accessToken || !this.config.phoneNumberId) {
            throw new Error('Meta Cloud API access token atau phone number ID belum dikonfigurasi');
        }

        this.status.connected = true;
        this.status.status = 'connected';
        this.status.connectedSince = new Date();
        logger.info('✅ MetaProvider configured and ready');
    }

    async sendMessage(phoneNumber, message, options = {}) {
        try {
            const formattedPhone = this.formatPhoneNumber(phoneNumber);
            const url = `${this.config.graphApiUrl}/${this.config.phoneNumberId}/messages`;
            const response = await axios.post(url, {
                messaging_product: 'whatsapp',
                recipient_type: options.recipientType || 'individual',
                to: formattedPhone,
                type: 'text',
                text: {
                    preview_url: !!options.previewUrl,
                    body: message
                }
            }, {
                headers: {
                    Authorization: `Bearer ${this.config.accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });

            return {
                success: true,
                messageId: response.data?.messages?.[0]?.id
            };
        } catch (error) {
            logger.error(`❌ Meta sendMessage error to ${phoneNumber}:`, error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || error.message
            };
        }
    }

    async sendMedia(phoneNumber, mediaPath, caption = '', options = {}) {
        try {
            if (!fs.existsSync(mediaPath)) {
                throw new Error(`Media file not found: ${mediaPath}`);
            }

            const mediaId = await this._uploadMedia(mediaPath, options);
            const formattedPhone = this.formatPhoneNumber(phoneNumber);
            const fileExt = path.extname(mediaPath).replace('.', '').toLowerCase();
            const mediaType = ['jpg', 'jpeg', 'png', 'webp'].includes(fileExt) ? 'image' : 'document';
            const url = `${this.config.graphApiUrl}/${this.config.phoneNumberId}/messages`;
            const payload = {
                messaging_product: 'whatsapp',
                to: formattedPhone,
                type: mediaType
            };

            payload[mediaType] = {
                id: mediaId
            };
            if (caption) {
                payload[mediaType].caption = caption;
            }
            if (mediaType === 'document') {
                payload.document.filename = options.fileName || path.basename(mediaPath);
            }

            const response = await axios.post(url, payload, {
                headers: {
                    Authorization: `Bearer ${this.config.accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });

            return {
                success: true,
                messageId: response.data?.messages?.[0]?.id
            };
        } catch (error) {
            logger.error(`❌ Meta sendMedia error to ${phoneNumber}:`, error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || error.message
            };
        }
    }

    async sendBulkMessages(messages) {
        const results = { sent: 0, failed: 0, errors: [] };
        for (const msg of messages) {
            const result = await this.sendMessage(msg.phone, msg.message, msg.options || {});
            if (result.success) {
                results.sent++;
            } else {
                results.failed++;
                results.errors.push({ phone: msg.phone, error: result.error });
            }
        }
        return results;
    }

    isConnected() {
        return this.status.connected && !!this.config.accessToken && !!this.config.phoneNumberId;
    }

    getStatus() {
        return {
            ...this.status,
            provider: 'Meta Cloud API',
            phoneNumberId: this.config.phoneNumberId || 'not configured'
        };
    }

    async _uploadMedia(mediaPath, options = {}) {
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('file', fs.createReadStream(mediaPath));
        if (options.mimetype) {
            form.append('type', options.mimetype);
        }

        const response = await axios.post(`${this.config.graphApiUrl}/${this.config.phoneNumberId}/media`, form, {
            headers: {
                Authorization: `Bearer ${this.config.accessToken}`,
                ...form.getHeaders()
            },
            timeout: 60000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        const mediaId = response.data?.id;
        if (!mediaId) {
            throw new Error('Meta media upload did not return media id');
        }
        return mediaId;
    }
}

module.exports = MetaProvider;
