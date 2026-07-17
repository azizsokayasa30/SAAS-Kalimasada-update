/**
 * Wablas Provider Implementation
 * Implementasi WhatsAppProvider menggunakan Wablas API
 */
const WhatsAppProvider = require('../whatsapp-provider');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const dns = require('dns');
const logger = require('../logger');
const { getWablasConfig } = require('../wablas-config');

// Set DNS server ke Google DNS untuk avoid DNS issue
try {
    dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
    logger.debug('✅ DNS servers set to Google DNS and Cloudflare');
} catch (error) {
    logger.warn('⚠️ Failed to set DNS servers:', error.message);
}

class WablasProvider extends WhatsAppProvider {
    constructor(config = null) {
        super();
        this.config = config || getWablasConfig();
        this.status = {
            connected: false,
            phoneNumber: null,
            connectedSince: null,
            status: 'disconnected'
        };
        this.rateLimiter = {
            lastRequest: 0,
            minDelay: this.config.minDelay || 1000
        };
        this.requestQueue = [];
        this.processingQueue = false;
    }

    /** Update kredensial runtime (mis. setelah simpan gateway tenant). */
    setConfig(config) {
        if (!config || typeof config !== 'object') return;
        this.config = { ...this.config, ...config };
        this.rateLimiter.minDelay = this.config.minDelay || 1000;
    }

    /**
     * Inisialisasi provider
     */
    async initialize() {
        await super.initialize();
        
        if (!this.config.apiKey) {
            throw new Error('Wablas API key tidak dikonfigurasi');
        }

        if (!this.config.apiUrl) {
            throw new Error('Wablas API URL tidak dikonfigurasi');
        }

        // Test koneksi dengan cek status device
        try {
            await this._checkConnection();
            this.status.connected = true;
            this.status.status = 'connected';
            this.status.connectedSince = new Date();
            
            // Update global status untuk kompatibilitas dengan UI
            if (typeof global !== 'undefined') {
                global.whatsappStatus = {
                    ...global.whatsappStatus,
                    connected: true,
                    status: 'connected',
                    connectedSince: this.status.connectedSince,
                    provider: 'Wablas',
                    phoneNumber: this.status.phoneNumber
                };
            }
            
            logger.info('✅ WablasProvider initialized and connected');
        } catch (error) {
            logger.warn(`⚠️ WablasProvider initialized but connection check failed: ${error.message}`);
            this.status.connected = false;
            this.status.status = 'error';
            
            // Update global status
            if (typeof global !== 'undefined') {
                global.whatsappStatus = {
                    ...global.whatsappStatus,
                    connected: false,
                    status: 'error',
                    provider: 'Wablas'
                };
            }
        }

        this._triggerConnectionUpdate({
            connection: this.status.connected ? 'open' : 'close',
            lastDisconnect: null,
            qr: null
        });
    }

    /** Authorization header: token.secret_key (trim penting — spasi bikin "secret key invalid") */
    _authHeader() {
        const token = String(this.config.apiKey || '').trim();
        const secret = String(this.config.secretKey || '').trim();
        if (!token) return '';
        return secret ? `${token}.${secret}` : token;
    }

    /**
     * Cek status device di Wablas (connected/disconnected + quota).
     */
    async fetchDeviceInfo() {
        const authHeader = this._authHeader();
        if (!authHeader) {
            return { ok: false, connected: false, error: 'API key kosong' };
        }

        const base = String(this.config.apiUrl || 'https://bdg.wablas.com').replace(/\/$/, '');
        const candidates = [
            { url: `${base}/api/device/info`, headers: { Authorization: authHeader } },
            { url: `${base}/api/device/info?token=${encodeURIComponent(authHeader)}`, headers: {} },
            { url: `${base}/api/device/info?token=${encodeURIComponent(String(this.config.apiKey || '').trim())}`, headers: {} }
        ];

        let lastError = 'Gagal cek device info';
        for (const req of candidates) {
            try {
                const response = await axios.get(req.url, {
                    headers: req.headers,
                    timeout: 15000,
                    family: 4
                });
                const body = response.data || {};
                // Beberapa response Wablas: { status: false, message: "secret key invalid" }
                if (body.status === false || body.status === 'false') {
                    lastError = body.message || 'Autentikasi Wablas ditolak';
                    continue;
                }
                const data = body.data && typeof body.data === 'object' ? body.data : body;
                const statusRaw = String(data.status || body.device_status || '').toLowerCase();
                const connected = statusRaw === 'connected' || statusRaw === 'connect' || data.connected === true;
                // Jika body hanya message error tanpa status device
                if (!statusRaw && body.message && /invalid|unauthorized|token|secret/i.test(String(body.message))) {
                    lastError = body.message;
                    continue;
                }
                return {
                    ok: true,
                    connected,
                    status: connected ? 'connected' : (statusRaw || 'disconnected'),
                    quota: data.quota,
                    expired_date: data.expired_date || data.expiredDate,
                    phone: data.phone || data.sender || data.number || null,
                    device: data.device || data.serial || this.config.deviceId || null,
                    raw: data
                };
            } catch (err) {
                lastError = err.response?.data?.message || err.message;
            }
        }
        return { ok: false, connected: false, error: lastError, status: 'error' };
    }

    /**
     * Kirim pesan teks
     * Format sesuai dokumentasi Wablas: https://bdg.wablas.com/documentation/api
     */
    async sendMessage(phoneNumber, message, options = {}) {
        try {
            // Rate limiting
            await this._waitForRateLimit();

            const formattedPhone = this.formatPhoneNumber(phoneNumber);
            if (!formattedPhone) {
                throw new Error('Invalid phone number');
            }

            // URL API V2 sesuai dokumentasi
            const url = `${this.config.apiUrl}/api/v2/send-message`;
            
            // Format payload sesuai dokumentasi API V2
            // Dokumentasi: { "data": [{ "phone": "...", "message": "...", "isGroup": "true" }] }
            const messageData = {
                phone: formattedPhone,
                message: message
            };

            // Tambahkan isGroup jika dikonfigurasi (untuk group message)
            if (options.isGroup === true) {
                messageData.isGroup = 'true'; // Dokumentasi: isGroup harus string 'true', bukan boolean
            }

            // Wrap dalam data array sesuai format API V2
            const payload = {
                data: [messageData]
            };

            const authHeader = this._authHeader();
            if (!authHeader) {
                throw new Error('Wablas API key tidak dikonfigurasi');
            }

            const response = await axios.post(url, payload, {
                headers: {
                    'Authorization': authHeader, // Format: token.secret_key (bukan Bearer)
                    'Content-Type': 'application/json'
                },
                timeout: 30000,
                family: 4 // Force IPv4
            });

            const raw = response.data || {};
            const messages = Array.isArray(raw.data)
                ? raw.data
                : (Array.isArray(raw.data?.messages) ? raw.data.messages : []);
            const first = messages[0] || {};
            const topStatus = raw.status;
            const itemStatus = String(first.status || '').toLowerCase();
            const topMessage = String(raw.message || '');
            const isPending = itemStatus === 'pending'
                || topStatus === 'pending'
                || /pending/i.test(topMessage);
            const isAccepted = topStatus === true
                || topStatus === 'success'
                || topStatus === 'pending'
                || isPending
                || !!first.id
                || !!first.message_id;

            logger.info(
                `Wablas send result phone=${formattedPhone} accepted=${isAccepted} ` +
                `status=${JSON.stringify(topStatus)} itemStatus=${itemStatus || '-'} ` +
                `msg="${topMessage.substring(0, 120)}" id=${first.id || first.message_id || '-'}`
            );

            if (isAccepted) {
                return {
                    success: true,
                    pending: isPending,
                    messageId: first.id || first.message_id || null,
                    wablasStatus: itemStatus || (isPending ? 'pending' : 'accepted'),
                    wablasMessage: topMessage || (isPending
                        ? 'Pesan masuk antrian Wablas (pending). Jika device WhatsApp disconnect, pesan tidak akan terkirim.'
                        : 'Pesan diterima Wablas')
                };
            }

            const errorMsg = topMessage || 'Failed to send message';
            throw new Error(errorMsg);
        } catch (error) {
            const apiMsg = error.response?.data?.message || error.message;
            logger.error(`❌ Wablas sendMessage error to ${phoneNumber}:`, apiMsg);
            
            // Retry logic
            if (options.retry !== false && this.config.maxRetries > 0) {
                return await this._retrySend(() => 
                    this.sendMessage(phoneNumber, message, { ...options, retry: false })
                );
            }

            return { 
                success: false, 
                error: apiMsg
            };
        }
    }

    /**
     * Kirim media (gambar/dokumen)
     */
    async sendMedia(phoneNumber, mediaPath, caption = '', options = {}) {
        try {
            await this._waitForRateLimit();

            const formattedPhone = this.formatPhoneNumber(phoneNumber);
            if (!formattedPhone) {
                throw new Error('Invalid phone number');
            }

            if (!fs.existsSync(mediaPath)) {
                throw new Error(`Media file not found: ${mediaPath}`);
            }

            const form = new FormData();
            form.append('phone', formattedPhone);
            if (caption) {
                form.append('caption', caption);
            }
            form.append('file', fs.createReadStream(mediaPath));

            // Tentukan endpoint berdasarkan tipe file
            const fileExt = mediaPath.split('.').pop().toLowerCase();
            const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExt);
            const endpoint = isImage ? 'send-image' : 'send-document';

            const url = `${this.config.apiUrl}/api/v2/${endpoint}`;
            const authHeader = this._authHeader();
            if (!authHeader) {
                throw new Error('Wablas API key tidak dikonfigurasi');
            }
            
            const response = await axios.post(url, form, {
                headers: {
                    'Authorization': authHeader,
                    ...form.getHeaders()
                },
                timeout: 60000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                family: 4 // Force IPv4
            });

            if (response.data && response.data.status === 'success') {
                logger.info(`✅ Wablas: Media sent to ${formattedPhone}`);
                return { 
                    success: true, 
                    messageId: response.data.data?.id || response.data.data?.message_id 
                };
            } else {
                const errorMsg = response.data?.message || 'Failed to send media';
                throw new Error(errorMsg);
            }
        } catch (error) {
            logger.error(`❌ Wablas sendMedia error to ${phoneNumber}:`, error.message);
            
            if (options.retry !== false && this.config.maxRetries > 0) {
                return await this._retrySend(() => 
                    this.sendMedia(phoneNumber, mediaPath, caption, { ...options, retry: false })
                );
            }

            return { 
                success: false, 
                error: error.response?.data?.message || error.message 
            };
        }
    }

    /**
     * Kirim pesan bulk dengan rate limiting
     * Menggunakan API V2 Multiple Send untuk efisiensi
     */
    async sendBulkMessages(messages) {
        const results = { sent: 0, failed: 0, errors: [] };
        
        logger.info(`📤 Sending ${messages.length} bulk messages via Wablas...`);

        // Format Authorization sesuai dokumentasi: token.secret_key
        let authHeader;
        if (this.config.secretKey) {
            authHeader = `${this.config.apiKey}.${this.config.secretKey}`;
        } else {
            authHeader = this.config.apiKey;
        }

        // API V2 mendukung multiple send dalam satu request
        // Bagi messages menjadi batch untuk menghindari payload terlalu besar
        const batchSize = 100; // Max 100 messages per request (sesuai best practice)
        
        for (let i = 0; i < messages.length; i += batchSize) {
            const batch = messages.slice(i, i + batchSize);
            
            try {
                // Format payload sesuai dokumentasi API V2 Multiple Send
                const messageDataArray = batch.map(msg => {
                    const formattedPhone = this.formatPhoneNumber(msg.phone);
                    if (!formattedPhone) {
                        throw new Error(`Invalid phone number: ${msg.phone}`);
                    }

                    const data = {
                        phone: formattedPhone,
                        message: msg.message
                    };

                    // Tambahkan isGroup jika dikonfigurasi
                    if (msg.options?.isGroup === true) {
                        data.isGroup = 'true';
                    }

                    return data;
                });

                const payload = {
                    data: messageDataArray
                };

                const url = `${this.config.apiUrl}/api/v2/send-message`;
                
                const response = await axios.post(url, payload, {
                    headers: {
                        'Authorization': authHeader,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000, // Timeout lebih lama untuk bulk
                    family: 4 // Force IPv4
                });

                if (response.data && response.data.status === 'success') {
                    // Response bisa berupa array atau single object
                    const responseData = Array.isArray(response.data.data) 
                        ? response.data.data 
                        : [response.data.data];
                    
                    responseData.forEach((result, index) => {
                        if (result && result.id) {
                            results.sent++;
                        } else {
                            results.failed++;
                            results.errors.push({ 
                                phone: batch[index].phone, 
                                error: 'No message ID returned' 
                            });
                        }
                    });
                } else {
                    // Jika batch gagal, mark semua sebagai failed
                    batch.forEach(msg => {
                        results.failed++;
                        results.errors.push({ 
                            phone: msg.phone, 
                            error: response.data?.message || 'Batch send failed' 
                        });
                    });
                }

                // Delay antar batch untuk rate limiting
                if (i + batchSize < messages.length) {
                    await new Promise(resolve => setTimeout(resolve, this.rateLimiter.minDelay));
                }
            } catch (error) {
                // Jika batch error, mark semua sebagai failed
                batch.forEach(msg => {
                    results.failed++;
                    results.errors.push({ 
                        phone: msg.phone, 
                        error: error.message 
                    });
                });
            }
        }

        logger.info(`✅ Bulk send complete: ${results.sent} sent, ${results.failed} failed`);
        return results;
    }

    /**
     * Handle incoming webhook dari Wablas
     * Dipanggil oleh webhook handler
     */
    handleIncomingWebhook(webhookData) {
        try {
            // Parse payload Wablas (sesuaikan dengan format Wablas)
            // Format contoh:
            // {
            //   "phone": "6281234567890",
            //   "message": "Hello",
            //   "timestamp": 1234567890,
            //   "type": "text",
            //   "from_me": false
            // }

            const phone = webhookData.phone || webhookData.from || webhookData.sender;
            const messageText = webhookData.message || webhookData.text || webhookData.body;
            const timestamp = webhookData.timestamp || webhookData.time || Date.now();

            if (!phone || !messageText) {
                logger.warn('⚠️ Invalid webhook data:', webhookData);
                return;
            }

            const message = {
                remoteJid: this.createJID(phone),
                senderNumber: this.formatPhoneNumber(phone),
                messageText: messageText,
                timestamp: timestamp,
                isGroup: false, // Wablas biasanya tidak support group
                isAdmin: false, // Akan dicek oleh handler
                quoted: webhookData.quoted || null,
                type: webhookData.type || 'text'
            };

            logger.debug(`📥 Received message from ${message.senderNumber}: ${messageText.substring(0, 50)}`);
            this._triggerMessage(message);
        } catch (error) {
            logger.error('❌ Error processing Wablas webhook:', error);
        }
    }

    /**
     * Cek status koneksi
     */
    isConnected() {
        return this.status.connected && !!this.config.apiKey;
    }

    /**
     * Dapatkan status detail
     */
    getStatus() {
        return {
            ...this.status,
            provider: 'Wablas',
            apiUrl: this.config.apiUrl,
            deviceId: this.config.deviceId || 'not configured'
        };
    }

    /**
     * Diagnosa lengkap koneksi Wablas (kredensial + status device).
     * Dipakai UI settings agar indikator Connected jujur.
     */
    async diagnoseConnection() {
        const issues = [];
        const hints = [];
        const apiUrl = String(this.config.apiUrl || '').trim();
        const apiKey = String(this.config.apiKey || '').trim();
        const secretKey = String(this.config.secretKey || '').trim();

        if (!apiUrl) issues.push('API URL kosong');
        if (!apiKey) issues.push('API Key / Token kosong');
        if (!secretKey) {
            issues.push('Secret Key kosong');
            hints.push('Generate Secret Key di pengaturan device Wablas, lalu paste tanpa spasi.');
        }

        if (issues.length) {
            return {
                ok: false,
                connected: false,
                authOk: false,
                status: 'incomplete',
                label: 'Belum lengkap',
                issues,
                hints,
                device: null
            };
        }

        const info = await this.fetchDeviceInfo();
        if (!info.ok) {
            const err = String(info.error || 'Gagal menghubungi Wablas');
            const lower = err.toLowerCase();
            if (lower.includes('secret') || lower.includes('token') || lower.includes('unauthorized') || lower.includes('auth')) {
                issues.push(`Autentikasi gagal: ${err}`);
                hints.push('Pastikan Token dan Secret Key pasangan yang sama (baru digenerate bersama).');
                hints.push('Pastikan API URL sesuai server device (contoh https://bdg.wablas.com).');
            } else {
                issues.push(`Tidak bisa cek device: ${err}`);
                hints.push('Cek koneksi server ke internet / firewall ke domain Wablas.');
            }
            return {
                ok: false,
                connected: false,
                authOk: false,
                status: 'error',
                label: 'Error koneksi',
                issues,
                hints,
                device: info,
                error: err
            };
        }

        if (!info.connected) {
            issues.push(`Device Wablas status: ${info.status || 'disconnected'} (belum Connected)`);
            hints.push('Buka dashboard Wablas → Device → pastikan status Connected.');
            hints.push('Jika disconnect, scan ulang QR dari menu device Wablas.');
            hints.push('Pesan yang berstatus PENDING di laporan Wablas tidak akan sampai sampai device Connected.');
            return {
                ok: true,
                connected: false,
                authOk: true,
                status: info.status || 'disconnected',
                label: 'Token OK · Device offline',
                issues,
                hints,
                device: info,
                phone: info.phone,
                quota: info.quota,
                expired_date: info.expired_date
            };
        }

        return {
            ok: true,
            connected: true,
            authOk: true,
            status: 'connected',
            label: 'Connected',
            issues: [],
            hints: [],
            device: info,
            phone: info.phone,
            quota: info.quota,
            expired_date: info.expired_date
        };
    }

    /**
     * Cek koneksi dengan API Wablas (status device nyata)
     * @private
     */
    async _checkConnection() {
        if (!String(this.config.apiKey || '').trim()) {
            return false;
        }

        const diagnosis = await this.diagnoseConnection();
        if (diagnosis.connected) {
            this.status.phoneNumber = diagnosis.phone || this.status.phoneNumber;
            logger.info(`✅ Wablas device connected${diagnosis.phone ? ` (${diagnosis.phone})` : ''}`);
            return true;
        }

        this.status.status = diagnosis.status || 'disconnected';
        if (diagnosis.issues?.length) {
            logger.warn(`⚠️ Wablas belum siap: ${diagnosis.issues.join('; ')}`);
        }
        return false;
    }

    /**
     * Rate limiting helper
     * @private
     */
    async _waitForRateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.rateLimiter.lastRequest;
        
        if (timeSinceLastRequest < this.rateLimiter.minDelay) {
            const waitTime = this.rateLimiter.minDelay - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        this.rateLimiter.lastRequest = Date.now();
    }

    /**
     * Retry mechanism
     * @private
     */
    async _retrySend(sendFn, retries = null) {
        const maxRetries = retries !== null ? retries : this.config.maxRetries;
        
        for (let i = 0; i < maxRetries; i++) {
            try {
                await new Promise(resolve => setTimeout(resolve, this.config.retryDelay * (i + 1)));
                return await sendFn();
            } catch (error) {
                if (i === maxRetries - 1) {
                    return { success: false, error: error.message };
                }
            }
        }
        
        return { success: false, error: 'Max retries exceeded' };
    }
}

module.exports = WablasProvider;

