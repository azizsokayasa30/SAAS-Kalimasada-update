/**
 * Baileys Provider Implementation
 * Wrapper untuk Baileys agar kompatibel dengan WhatsAppProvider interface
 */
const WhatsAppProvider = require('../whatsapp-provider');
const logger = require('../logger');
const path = require('path');

class BaileysProvider extends WhatsAppProvider {
    constructor(sock = null) {
        super();
        this.sock = sock;
        this.status = {
            connected: false,
            phoneNumber: null,
            connectedSince: null,
            status: 'disconnected'
        };
    }

    /**
     * Set socket instance dari Baileys
     */
    setSock(sock) {
        this.sock = sock;
        
        if (sock) {
            this.status.connected = true;
            this.status.status = 'connected';
            this.status.connectedSince = new Date();
            
            // Idempotent: jangan attach listener berulang ke sock yang sama
            if (this._listenersSock !== sock) {
                this._setupBaileysListeners();
                this._listenersSock = sock;
            }
            
            logger.info('✅ BaileysProvider: Socket set and listeners attached');
        } else {
            this.status.connected = false;
            this.status.status = 'disconnected';
            this._listenersSock = null;
        }
    }

    /**
     * Kirim pesan teks
     */
    async sendMessage(phoneNumber, message, options = {}) {
        if (!this.sock) {
            logger.error('❌ BaileysProvider: Socket not available');
            return { success: false, error: 'Socket not available' };
        }

        try {
            const jid = this.createJID(phoneNumber);
            if (!jid) {
                throw new Error('Invalid phone number');
            }

            await this.sock.sendMessage(jid, { text: message }, options);
            logger.debug(`✅ Baileys: Message sent to ${phoneNumber}`);
            return { success: true };
        } catch (error) {
            logger.error(`❌ Baileys sendMessage error:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Kirim media
     */
    async sendMedia(phoneNumber, mediaPath, caption = '', options = {}) {
        if (!this.sock) {
            logger.error('❌ BaileysProvider: Socket not available');
            return { success: false, error: 'Socket not available' };
        }

        try {
            const fs = require('fs');
            const jid = this.createJID(phoneNumber);
            
            if (!jid) {
                throw new Error('Invalid phone number');
            }

            if (!fs.existsSync(mediaPath)) {
                throw new Error(`Media file not found: ${mediaPath}`);
            }

            // Tentukan tipe media berdasarkan ekstensi
            const fileExt = mediaPath.split('.').pop().toLowerCase();
            const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExt);
            const isPdf = fileExt === 'pdf';
            
            let mediaMessage;
            
            // Untuk PDF, gunakan document dengan mimetype yang benar
            if (isPdf) {
                mediaMessage = { 
                    document: { 
                        url: mediaPath 
                    }, 
                    mimetype: options.mimetype || 'application/pdf', 
                    caption: caption,
                    fileName: options.fileName || path.basename(mediaPath)
                };
            } else if (isImage) {
                mediaMessage = { image: { url: mediaPath }, caption: caption };
            } else {
                mediaMessage = { 
                    document: { url: mediaPath }, 
                    mimetype: options.mimetype || 'application/octet-stream', 
                    caption: caption,
                    fileName: options.fileName || path.basename(mediaPath)
                };
            }

            await this.sock.sendMessage(jid, mediaMessage, options);
            logger.debug(`✅ Baileys: Media sent to ${phoneNumber}`);
            return { success: true };
        } catch (error) {
            logger.error(`❌ Baileys sendMedia error:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Kirim pesan bulk
     */
    async sendBulkMessages(messages) {
        const results = { sent: 0, failed: 0, errors: [] };
        
        logger.info(`📤 Sending ${messages.length} bulk messages via Baileys...`);

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            try {
                const result = await this.sendMessage(msg.phone, msg.message, msg.options || {});
                if (result.success) {
                    results.sent++;
                } else {
                    results.failed++;
                    results.errors.push({ phone: msg.phone, error: result.error });
                }

                // Delay antar pesan
                if (i < messages.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            } catch (error) {
                results.failed++;
                results.errors.push({ phone: msg.phone, error: error.message });
            }
        }

        logger.info(`✅ Bulk send complete: ${results.sent} sent, ${results.failed} failed`);
        return results;
    }

    /**
     * Cek status koneksi
     */
    isConnected() {
        return this.sock && this.status.connected;
    }

    /**
     * Dapatkan status detail
     */
    getStatus() {
        return {
            ...this.status,
            provider: 'Baileys',
            hasSocket: !!this.sock
        };
    }

    /**
     * Setup event listeners untuk Baileys socket
     * @private
     */
    _setupBaileysListeners() {
        if (!this.sock || !this.sock.ev) {
            return;
        }

        // Listen untuk pesan masuk
        this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                try {
                    // Skip pesan dari bot sendiri
                    if (msg.key.fromMe) continue;

                    const remoteJid = msg.key.remoteJid;
                    const senderNumber = remoteJid.split('@')[0];
                    const messageText = msg.message?.conversation || 
                                      msg.message?.extendedTextMessage?.text || 
                                      '';

                    if (!messageText) continue;

                    const message = {
                        remoteJid: remoteJid,
                        senderNumber: senderNumber,
                        messageText: messageText,
                        timestamp: msg.messageTimestamp,
                        isGroup: remoteJid.includes('@g.us'),
                        isAdmin: false, // Akan dicek oleh handler
                        quoted: msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || null,
                        type: 'text'
                    };

                    this._triggerMessage(message);
                } catch (error) {
                    logger.error('❌ Error processing Baileys message:', error);
                }
            }
        });

        // Listen untuk update koneksi
        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (connection === 'close') {
                this.status.connected = false;
                this.status.status = 'disconnected';
            } else if (connection === 'open') {
                this.status.connected = true;
                this.status.status = 'connected';
                this.status.connectedSince = new Date();
            }

            this._triggerConnectionUpdate({
                connection: connection,
                lastDisconnect: lastDisconnect,
                qr: qr
            });
        });

        logger.debug('✅ Baileys event listeners attached');
    }

    /**
     * Cleanup
     */
    async cleanup() {
        await super.cleanup();
        
        if (this.sock && this.sock.ev) {
            this.sock.ev.removeAllListeners();
        }
        
        this.sock = null;
        this.status.connected = false;
        logger.info('🧹 BaileysProvider cleaned up');
    }
}

module.exports = BaileysProvider;

