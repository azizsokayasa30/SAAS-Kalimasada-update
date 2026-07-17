const WhatsAppProvider = require('../whatsapp-provider');
const axios = require('axios');
const logger = require('../logger');
const { getWhatsAppProviderSettings } = require('../whatsapp-provider-settings');

class QontakProvider extends WhatsAppProvider {
    constructor(config = null) {
        super();
        this.config = config || getWhatsAppProviderSettings().qontak;
        this.status = {
            connected: false,
            phoneNumber: null,
            connectedSince: null,
            status: 'disconnected'
        };
    }

    async initialize() {
        await super.initialize();
        if (!this.config.accessToken || !this.config.channelIntegrationId) {
            throw new Error('Qontak access token atau channel integration ID belum dikonfigurasi');
        }

        this.status.connected = true;
        this.status.status = 'connected';
        this.status.connectedSince = new Date();
        logger.info('✅ QontakProvider configured and ready');
    }

    async sendMessage(phoneNumber, message, options = {}) {
        try {
            const formattedPhone = this.formatPhoneNumber(phoneNumber);
            const url = `${this.config.apiUrl}/api/open/v1/messages/whatsapp`;
            const payload = {
                to_number: formattedPhone,
                to_name: options.toName || formattedPhone,
                channel_integration_id: this.config.channelIntegrationId,
                message: message
            };

            const response = await axios.post(url, payload, {
                headers: {
                    Authorization: `Bearer ${this.config.accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });

            return {
                success: true,
                messageId: response.data?.data?.id || response.data?.id
            };
        } catch (error) {
            logger.error(`❌ Qontak sendMessage error to ${phoneNumber}:`, error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || error.response?.data?.message || error.message
            };
        }
    }

    async sendMedia(phoneNumber, mediaPath, caption = '', options = {}) {
        const message = caption || options.message || 'Lampiran';
        return this.sendMessage(phoneNumber, message, options);
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
        return this.status.connected && !!this.config.accessToken && !!this.config.channelIntegrationId;
    }

    getStatus() {
        return {
            ...this.status,
            provider: 'Qontak',
            apiUrl: this.config.apiUrl,
            channelIntegrationId: this.config.channelIntegrationId || 'not configured'
        };
    }
}

module.exports = QontakProvider;
