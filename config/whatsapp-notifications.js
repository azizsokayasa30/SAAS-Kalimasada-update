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

    // Get provider instance
    getProvider() {
        if (!this.providerManager) {
            this.providerManager = getProviderManager();
        }
        
        if (!this.providerManager.isInitialized()) {
            logger.warn('⚠️ ProviderManager not initialized in WhatsAppNotificationManager');
            return null;
        }
        
        return this.providerManager.getProvider();
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

    // Helper method to get invoice image path with fallback handling
    getInvoiceImagePath() {
        const customFilename = getSetting('billing_qr_filename', null);

        const imagePaths = [];

        if (customFilename) {
            imagePaths.push(path.resolve(__dirname, '../public/img', customFilename));
        }

        imagePaths.push(
            path.resolve(__dirname, '../public/img/tagihan.jpg'),
            path.resolve(__dirname, '../public/img/tagihan.png'),
            path.resolve(__dirname, '../public/img/invoice.jpg'),
            path.resolve(__dirname, '../public/img/invoice.png'),
            path.resolve(__dirname, '../public/img/logo.png')
        );
        
        for (const imagePath of imagePaths) {
            if (imagePath && fs.existsSync(imagePath)) {
                logger.info(`📸 Using invoice image: ${imagePath}`);
                return imagePath;
            }
        }

        logger.warn('⚠️ No invoice image found, will send text-only notification');
        return null;
    }

    // Replace template variables with actual data
    replaceTemplateVariables(template, data) {
        let message = template;
        for (const [key, value] of Object.entries(data)) {
            const placeholder = `{${key}}`;
            message = message.replace(new RegExp(placeholder, 'g'), value || '');
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

    // Send notification with header and footer (refactored to use provider)
    async sendNotification(phoneNumber, message, options = {}) {
        try {
            // Check rate limiting
            const settings = this.getRateLimitSettings();
            if (settings.enabled && !this.checkDailyMessageLimit()) {
                logger.warn(`Daily message limit reached (${settings.dailyMessageLimit}), skipping notification to ${phoneNumber}`);
                return { success: false, error: 'Daily message limit reached' };
            }

            const formattedNumber = this.formatPhoneNumber(phoneNumber);

            // Add header and footer
            const companyHeader = getSetting('company_header', '📱 SISTEM BILLING 📱\n\n');
            const footerSeparator = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            const footerInfo = footerSeparator + getSetting('footer_info', 'Powered by Alijaya Digital Network');
            
            const fullMessage = `${companyHeader}${message}${footerInfo}`;
            
            // Try to use provider first
            const provider = this.getProvider();
            if (provider) {
                // If imagePath provided and exists, try to send as image with caption
                if (options.imagePath) {
                    try {
                        const imagePath = options.imagePath;
                        logger.info(`📸 Mencoba mengirim dengan gambar: ${imagePath}`);
                        
                        if (fs.existsSync(imagePath)) {
                            const result = await provider.sendMedia(formattedNumber, imagePath, fullMessage, options);
                            if (result.success) {
                                logger.info(`✅ WhatsApp image notification sent to ${phoneNumber} with image via provider`);
                                this.incrementDailyMessageCount();
                                return { success: true, withImage: true };
                            } else {
                                logger.warn(`⚠️ Provider failed to send image, falling back to text: ${result.error}`);
                            }
                        } else {
                            logger.warn(`⚠️ Image not found at path: ${imagePath}, falling back to text message`);
                        }
                    } catch (imgErr) {
                        logger.error(`❌ Failed sending image to ${phoneNumber}, falling back to text:`, imgErr);
                    }
                }

                // Send as text message via provider
                const result = await provider.sendMessage(formattedNumber, fullMessage, options);
                if (result.success) {
                    logger.info(`✅ WhatsApp text notification sent to ${phoneNumber} via provider`);
                    this.incrementDailyMessageCount();
                    return { success: true, withImage: false };
                } else {
                    logger.warn(`⚠️ Provider failed to send message, falling back to sock: ${result.error}`);
                }
            }

            // Fallback ke sock langsung untuk backward compatibility
            if (!this.sock) {
                logger.error('WhatsApp sock not initialized and provider not available');
                return { success: false, error: 'WhatsApp not connected' };
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

            const companyHeader = getSetting('company_header', '📱 SISTEM BILLING 📱\n\n');
            const footerSeparator = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            const footerInfo = footerSeparator + getSetting('footer_info', 'Powered by Alijaya Digital Network');
            const fullMessage = `${companyHeader}${message}${footerInfo}`;

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

    // Send invoice created notification
    async sendInvoiceCreatedNotification(customerId, invoiceId) {
        try {
            if (!this.isSystemMonitorEnabled('billing_scheduler_invoice_wa')) {
                logger.info('billing_scheduler_invoice_wa off — skip invoice created notification');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            // Check if template is enabled
            if (!this.isTemplateEnabled('invoice_created')) {
                logger.info('Invoice created notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const customer = await billingManager.getCustomerById(customerId);
            const invoice = await billingManager.getInvoiceById(invoiceId);
            const packageData = await billingManager.getPackageById(invoice.package_id);

            if (!customer || !invoice || !packageData) {
                logger.error('Missing data for invoice notification');
                return { success: false, error: 'Missing data' };
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

            const message = this.replaceTemplateVariables(
                this.templates.invoice_created.template,
                data
            );

            // Attach invoice banner image if available
            const imagePath = this.getInvoiceImagePath();
            return await this.sendNotification(customer.phone, message, { imagePath });
        } catch (error) {
            logger.error('Error sending invoice created notification:', error);
            return { success: false, error: error.message };
        }
    }

    // Send due date reminder
    async sendDueDateReminder(invoiceId) {
        try {
            if (!this.isSystemMonitorEnabled('billing_daily_due_wa')) {
                logger.info('billing_daily_due_wa off — skip due date reminder notification');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            // Check if template is enabled
            if (!this.isTemplateEnabled('due_date_reminder')) {
                logger.info('Due date reminder notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const invoice = await billingManager.getInvoiceById(invoiceId);
            const customer = await billingManager.getCustomerById(invoice.customer_id);
            const packageData = await billingManager.getPackageById(invoice.package_id);

            if (!customer || !invoice || !packageData) {
                logger.error('Missing data for due date reminder');
                return { success: false, error: 'Missing data' };
            }

            const dueDate = new Date(invoice.due_date);
            const today = new Date();
            const daysRemaining = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));

            const data = {
                customer_name: customer.name,
                invoice_number: invoice.invoice_number,
                amount: this.formatCurrency(invoice.amount),
                due_date: this.formatDate(invoice.due_date),
                days_remaining: daysRemaining,
                package_name: packageData.name,
                package_speed: packageData.speed
            };

            const message = this.replaceTemplateVariables(
                this.templates.due_date_reminder.template,
                data
            );

            // Attach same invoice banner image
            const imagePath = this.getInvoiceImagePath();
            return await this.sendNotification(customer.phone, message, { imagePath });
        } catch (error) {
            logger.error('Error sending due date reminder:', error);
            return { success: false, error: error.message };
        }
    }

    // Send member invoice created notification
    async sendMemberInvoiceCreatedNotification(memberId, invoiceId) {
        try {
            if (!this.isSystemMonitorEnabled('billing_scheduler_invoice_wa')) {
                logger.info('billing_scheduler_invoice_wa off — skip member invoice created notification');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            if (!this.isTemplateEnabled('invoice_created')) {
                logger.info('Member invoice created notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const member = await billingManager.getMemberById(memberId);
            const invoice = await billingManager.getInvoiceById(invoiceId);
            const packageData = await billingManager.getMemberPackageById(invoice.package_id);

            if (!member || !invoice || !packageData) {
                logger.error('Missing data for member invoice notification');
                return { success: false, error: 'Missing data' };
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

            const message = this.replaceTemplateVariables(
                this.templates.invoice_created.template,
                data
            );

            const imagePath = this.getInvoiceImagePath();
            return await this.sendNotification(member.phone, message, { imagePath });
        } catch (error) {
            logger.error('Error sending member invoice created notification:', error);
            return { success: false, error: error.message };
        }
    }

    // Send member due date reminder
    async sendMemberDueDateReminder(invoiceId) {
        try {
            if (!this.isSystemMonitorEnabled('billing_daily_due_wa')) {
                logger.info('billing_daily_due_wa off — skip member due date reminder notification');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            if (!this.isTemplateEnabled('due_date_reminder')) {
                logger.info('Member due date reminder notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const invoice = await billingManager.getInvoiceById(invoiceId);
            const member = await billingManager.getMemberById(invoice.member_id);
            const packageData = await billingManager.getMemberPackageById(invoice.package_id);

            if (!member || !invoice || !packageData) {
                logger.error('Missing data for member due date reminder');
                return { success: false, error: 'Missing data' };
            }

            const dueDate = new Date(invoice.due_date);
            const today = new Date();
            const daysRemaining = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));

            const data = {
                customer_name: member.name,
                invoice_number: invoice.invoice_number,
                amount: this.formatCurrency(invoice.amount),
                due_date: this.formatDate(invoice.due_date),
                days_remaining: daysRemaining,
                package_name: packageData.name,
                package_speed: packageData.speed
            };

            const message = this.replaceTemplateVariables(
                this.templates.due_date_reminder.template,
                data
            );

            const imagePath = this.getInvoiceImagePath();
            return await this.sendNotification(member.phone, message, { imagePath });
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

            // Check if template is enabled
            if (!this.isTemplateEnabled('payment_received')) {
                logger.info('Payment received notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            let phone, notificationData, invoice;

            // If data is provided, use it directly (for member or custom notification)
            if (data && typeof paymentIdOrPhone === 'string') {
                phone = paymentIdOrPhone;
                notificationData = data;
                // Try to get invoice from data if available
                if (data.invoice_id) {
                    invoice = await billingManager.getInvoiceById(data.invoice_id);
                }
            } else {
                // Legacy: get payment by ID
                const payment = await billingManager.getPaymentById(paymentIdOrPhone);
                invoice = await billingManager.getInvoiceById(payment.invoice_id);
                const isMemberInvoice = invoice.member_id !== null && invoice.member_id !== undefined;

                if (isMemberInvoice) {
                    // Handle member payment
                    const member = await billingManager.getMemberById(invoice.member_id);
                    const packageData = await billingManager.getMemberPackageById(invoice.package_id);

                    if (!member || !invoice) {
                        logger.error('Missing data for member payment notification');
                        return { success: false, error: 'Missing data' };
                    }

                    phone = member.phone;
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

            const message = this.replaceTemplateVariables(
                this.templates.payment_received.template,
                notificationData
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
                    
                    // Kirim PDF sebagai dokumen
                    const provider = this.getProvider();
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
            return await this.sendNotification(phone, message);
        } catch (error) {
            logger.error('Error sending payment received notification:', error);
            return { success: false, error: error.message };
        }
    }

    // Send service disruption notification
    async sendServiceDisruptionNotification(disruptionData) {
        try {
            // Check if template is enabled
            if (!this.isTemplateEnabled('service_disruption')) {
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

            const message = this.replaceTemplateVariables(
                this.templates.service_disruption.template,
                data
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
            // Check if template is enabled
            if (!this.isTemplateEnabled('service_announcement')) {
                logger.info('Service announcement notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const customers = await billingManager.getCustomers();
            const activeCustomers = customers.filter(c => c.status === 'active' && c.phone);

            const data = {
                announcement_content: announcementData.content || 'Tidak ada konten pengumuman'
            };

            const message = this.replaceTemplateVariables(
                this.templates.service_announcement.template,
                data
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

    // Save templates to file
    saveTemplates() {
        try {
            // Ensure data directory exists
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

    getTemplates() {
        return this.templates;
    }

    // Update template
    updateTemplate(templateKey, newTemplate) {
        const defaults = getBuiltInWhatsAppTemplates();
        if (!defaults[templateKey]) return false;
        if (!this.templates[templateKey]) {
            this.templates[templateKey] = { ...defaults[templateKey] };
        }
        this.templates[templateKey] = {
            title: newTemplate.title != null ? newTemplate.title : this.templates[templateKey].title,
            template: newTemplate.template !== undefined ? newTemplate.template : this.templates[templateKey].template,
            enabled: newTemplate.enabled !== undefined ? !!newTemplate.enabled : this.templates[templateKey].enabled
        };
        this.saveTemplates();
        return true;
    }

    // Update multiple templates at once
    updateTemplates(templatesData) {
        const allowed = new Set(Object.keys(getBuiltInWhatsAppTemplates()));
        let updated = 0;
        Object.keys(templatesData).forEach(key => {
            if (!allowed.has(key)) return;
            const incoming = templatesData[key];
            if (!this.templates[key]) {
                this.templates[key] = { ...getBuiltInWhatsAppTemplates()[key] };
            }
            this.templates[key] = {
                title: incoming.title != null ? incoming.title : this.templates[key].title,
                template: incoming.template !== undefined ? incoming.template : this.templates[key].template,
                enabled: incoming.enabled !== undefined ? !!incoming.enabled : this.templates[key].enabled
            };
            updated++;
        });

        if (updated > 0) {
            this.saveTemplates();
        }

        return updated;
    }

    // Check if template is enabled
    isTemplateEnabled(templateKey) {
        return this.templates[templateKey] && this.templates[templateKey].enabled !== false;
    }

    // Test notification to specific number
    async testNotification(phoneNumber, templateKey, testData = {}) {
        try {
            if (!this.templates[templateKey]) {
                return { success: false, error: 'Template not found' };
            }

            const message = this.replaceTemplateVariables(
                this.templates[templateKey].template,
                testData
            );

            return await this.sendNotification(phoneNumber, message);
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

            // Check if template is enabled
            if (!this.isTemplateEnabled('service_suspension')) {
                logger.info('Service suspension notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            if (!customer.phone) {
                logger.warn(`Customer ${customer.username} has no phone number for suspension notification`);
                return { success: false, error: 'No phone number' };
            }

            const message = this.replaceTemplateVariables(
                this.templates.service_suspension.template,
                {
                    customer_name: customer.name,
                    reason: reason
                }
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

            // Check if template is enabled
            if (!this.isTemplateEnabled('service_restoration')) {
                logger.info('Service restoration notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            if (!customer.phone) {
                logger.warn(`Customer ${customer.username} has no phone number for restoration notification`);
                return { success: false, error: 'No phone number' };
            }

            const message = this.replaceTemplateVariables(
                this.templates.service_restoration.template,
                {
                    customer_name: customer.name,
                    package_name: customer.package_name || 'N/A',
                    package_speed: customer.package_speed || 'N/A',
                    reason: reason || ''
                }
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
                    wifi_password: 'N/A'
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

            // Check if template is enabled
            if (!this.isTemplateEnabled('welcome_message')) {
                logger.info('Welcome message notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            if (!customer.phone) {
                logger.warn(`Customer ${customer.username} has no phone number for welcome message`);
                return { success: false, error: 'No phone number' };
            }

            const message = this.replaceTemplateVariables(
                this.templates.welcome_message.template,
                {
                    customer_name: customer.name,
                    package_name: customer.package_name || 'N/A',
                    package_speed: customer.package_speed || 'N/A',
                    pppoe_username: customer.pppoe_username || 'N/A',
                    pppoe_password: customer.pppoe_password || 'N/A',
                    wifi_password: customer.wifi_password || 'N/A',
                    support_phone: getSetting('support_phone', '0813-6888-8498')
                }
            );

            const result = await this.sendNotification(customer.phone, message);
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

    // Send installation job assignment notification to technician
    async sendInstallationJobNotification(technician, installationJob, customer, packageData) {
        try {
            if (!this.isSystemMonitorEnabled('installation_job_wa')) {
                logger.info('installation_job_wa off — skip installation job notification');
                return { success: true, skipped: true, reason: 'System monitor disabled' };
            }

            // Check if template is enabled
            if (!this.isTemplateEnabled('installation_job_assigned')) {
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

            const message = this.replaceTemplateVariables(
                this.templates.installation_job_assigned.template,
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
                }
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

            // Check if template is enabled
            if (!this.isTemplateEnabled('installation_status_update')) {
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

            const message = this.replaceTemplateVariables(
                this.templates.installation_status_update.template,
                {
                    technician_name: technician.name,
                    job_number: installationJob.job_number || 'N/A',
                    customer_name: customer.name || installationJob.customer_name || 'N/A',
                    new_status: statusText,
                    update_time: new Date().toLocaleString('id-ID'),
                    notes: notes || 'Tidak ada catatan'
                }
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

            // Check if template is enabled
            if (!this.isTemplateEnabled('installation_completed')) {
                logger.info('Installation completion notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            if (!technician.phone) {
                logger.warn(`Technician ${technician.name} has no phone number for completion notification`);
                return { success: false, error: 'No phone number' };
            }

            const message = this.replaceTemplateVariables(
                this.templates.installation_completed.template,
                {
                    technician_name: technician.name,
                    job_number: installationJob.job_number || 'N/A',
                    customer_name: customer.name || installationJob.customer_name || 'N/A',
                    completion_time: new Date().toLocaleString('id-ID'),
                    completion_notes: completionNotes || 'Tidak ada catatan tambahan'
                }
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

            if (!this.isTemplateEnabled('sales_order_new_customer')) {
                logger.info('Sales Order WhatsApp notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const message = this.replaceTemplateVariables(
                this.templates.sales_order_new_customer.template,
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
                }
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