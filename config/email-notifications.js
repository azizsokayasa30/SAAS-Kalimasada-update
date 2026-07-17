const { getSetting, setSetting } = require('./settingsManager');
const billingManager = require('./billing');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');
const { getCompanyHeader } = require('./message-templates');
const nodemailer = require('nodemailer');

class EmailNotificationManager {
    constructor() {
        this.templatesFile = path.join(__dirname, '../data/email-templates.json');
        this.transporter = null;
        this.templates = this.loadTemplates() || {
            invoice_created: {
                title: 'Tagihan Baru',
                subject: 'Tagihan Baru - {invoice_number}',
                template: `<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0; }
        .content { background: #f8f9fa; padding: 20px; border-radius: 0 0 10px 10px; }
        .invoice-box { background: white; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #667eea; }
        .footer { text-align: center; margin-top: 20px; color: #6c757d; font-size: 12px; }
        .btn { display: inline-block; padding: 10px 20px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>📋 Tagihan Baru</h2>
        </div>
        <div class="content">
            <p>Halo <strong>{customer_name}</strong>,</p>
            <p>Tagihan bulanan Anda telah dibuat:</p>
            <div class="invoice-box">
                <p><strong>No. Invoice:</strong> {invoice_number}</p>
                <p><strong>Jumlah:</strong> Rp {amount}</p>
                <p><strong>Jatuh Tempo:</strong> {due_date}</p>
                <p><strong>Paket:</strong> {package_name} ({package_speed})</p>
                <p><strong>Catatan:</strong> {notes}</p>
            </div>
            <p>Silakan lakukan pembayaran sebelum tanggal jatuh tempo untuk menghindari denda keterlambatan.</p>
            <p>Terima kasih atas kepercayaan Anda.</p>
        </div>
        <div class="footer">
            <p>{company_header}</p>
            <p>{footer_info}</p>
        </div>
    </div>
</body>
</html>`,
                enabled: true
            },
            due_date_reminder: {
                title: 'Peringatan Jatuh Tempo',
                subject: 'Peringatan Jatuh Tempo - {invoice_number}',
                template: `<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #ffc107 0%, #fd7e14 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0; }
        .content { background: #f8f9fa; padding: 20px; border-radius: 0 0 10px 10px; }
        .invoice-box { background: white; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #ffc107; }
        .footer { text-align: center; margin-top: 20px; color: #6c757d; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>⚠️ Peringatan Jatuh Tempo</h2>
        </div>
        <div class="content">
            <p>Halo <strong>{customer_name}</strong>,</p>
            <p>Tagihan Anda akan jatuh tempo dalam <strong>{days_remaining} hari</strong>:</p>
            <div class="invoice-box">
                <p><strong>No. Invoice:</strong> {invoice_number}</p>
                <p><strong>Jumlah:</strong> Rp {amount}</p>
                <p><strong>Jatuh Tempo:</strong> {due_date}</p>
                <p><strong>Paket:</strong> {package_name} ({package_speed})</p>
            </div>
            <p>Silakan lakukan pembayaran segera untuk menghindari denda keterlambatan.</p>
            <p>Terima kasih.</p>
        </div>
        <div class="footer">
            <p>{company_header}</p>
            <p>{footer_info}</p>
        </div>
    </div>
</body>
</html>`,
                enabled: true
            },
            payment_received: {
                title: 'Pembayaran Diterima',
                subject: 'Pembayaran Diterima - {invoice_number}',
                template: `<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0; }
        .content { background: #f8f9fa; padding: 20px; border-radius: 0 0 10px 10px; }
        .invoice-box { background: white; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #28a745; }
        .footer { text-align: center; margin-top: 20px; color: #6c757d; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>✅ Pembayaran Diterima</h2>
        </div>
        <div class="content">
            <p>Halo <strong>{customer_name}</strong>,</p>
            <p>Terima kasih! Pembayaran Anda telah kami terima:</p>
            <div class="invoice-box">
                <p><strong>No. Invoice:</strong> {invoice_number}</p>
                <p><strong>Jumlah:</strong> Rp {amount}</p>
                <p><strong>Metode Pembayaran:</strong> {payment_method}</p>
                <p><strong>Tanggal Pembayaran:</strong> {payment_date}</p>
                <p><strong>No. Referensi:</strong> {reference_number}</p>
            </div>
            <p>Layanan internet Anda akan tetap aktif. Terima kasih atas kepercayaan Anda.</p>
        </div>
        <div class="footer">
            <p>{company_header}</p>
            <p>{footer_info}</p>
        </div>
    </div>
</body>
</html>`,
                enabled: true
            },
            service_disruption: {
                title: 'Gangguan Layanan',
                subject: 'Gangguan Layanan - {disruption_type}',
                template: `<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #dc3545 0%, #e83e8c 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0; }
        .content { background: #f8f9fa; padding: 20px; border-radius: 0 0 10px 10px; }
        .alert-box { background: white; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #dc3545; }
        .footer { text-align: center; margin-top: 20px; color: #6c757d; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>🚨 Gangguan Layanan</h2>
        </div>
        <div class="content">
            <p>Halo Pelanggan Setia,</p>
            <p>Kami informasikan bahwa sedang terjadi gangguan pada jaringan internet:</p>
            <div class="alert-box">
                <p><strong>Jenis Gangguan:</strong> {disruption_type}</p>
                <p><strong>Area Terdampak:</strong> {affected_area}</p>
                <p><strong>Perkiraan Selesai:</strong> {estimated_resolution}</p>
                <p><strong>Hotline:</strong> {support_phone}</p>
            </div>
            <p>Kami sedang bekerja untuk mengatasi masalah ini secepat mungkin. Mohon maaf atas ketidaknyamanannya.</p>
            <p>Terima kasih atas pengertian Anda.</p>
        </div>
        <div class="footer">
            <p>{company_header}</p>
            <p>{footer_info}</p>
        </div>
    </div>
</body>
</html>`,
                enabled: true
            },
            service_announcement: {
                title: 'Pengumuman Layanan',
                subject: 'Pengumuman Layanan',
                template: `<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #17a2b8 0%, #138496 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0; }
        .content { background: #f8f9fa; padding: 20px; border-radius: 0 0 10px 10px; }
        .announcement-box { background: white; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #17a2b8; }
        .footer { text-align: center; margin-top: 20px; color: #6c757d; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>📢 Pengumuman Layanan</h2>
        </div>
        <div class="content">
            <p>Halo Pelanggan Setia,</p>
            <div class="announcement-box">
                {announcement_content}
            </div>
            <p>Terima kasih atas perhatian Anda.</p>
        </div>
        <div class="footer">
            <p>{company_header}</p>
            <p>{footer_info}</p>
        </div>
    </div>
</body>
</html>`,
                enabled: true
            },
            service_suspension: {
                title: 'Service Suspension',
                subject: 'Layanan Internet Dinonaktifkan',
                template: `<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #ffc107 0%, #fd7e14 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0; }
        .content { background: #f8f9fa; padding: 20px; border-radius: 0 0 10px 10px; }
        .alert-box { background: white; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #ffc107; }
        .footer { text-align: center; margin-top: 20px; color: #6c757d; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>⚠️ Layanan Internet Dinonaktifkan</h2>
        </div>
        <div class="content">
            <p>Halo <strong>{customer_name}</strong>,</p>
            <p>Layanan internet Anda telah dinonaktifkan karena:</p>
            <div class="alert-box">
                <p><strong>Alasan:</strong> {reason}</p>
            </div>
            <p><strong>Cara Mengaktifkan Kembali:</strong></p>
            <ol>
                <li>Lakukan pembayaran tagihan yang tertunggak</li>
                <li>Layanan akan aktif otomatis setelah pembayaran dikonfirmasi</li>
            </ol>
            <p><strong>Butuh Bantuan?</strong><br>
            Hubungi kami di: {support_phone}</p>
            <p>{company_header}</p>
            <p>Terima kasih atas perhatian Anda.</p>
        </div>
        <div class="footer">
            <p>{footer_info}</p>
        </div>
    </div>
</body>
</html>`,
                enabled: true
            },
            service_restoration: {
                title: 'Service Restoration',
                subject: 'Layanan Internet Diaktifkan',
                template: `<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0; }
        .content { background: #f8f9fa; padding: 20px; border-radius: 0 0 10px 10px; }
        .info-box { background: white; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #28a745; }
        .footer { text-align: center; margin-top: 20px; color: #6c757d; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>✅ Layanan Internet Diaktifkan</h2>
        </div>
        <div class="content">
            <p>Halo <strong>{customer_name}</strong>,</p>
            <p>Selamat! Layanan internet Anda telah diaktifkan kembali.</p>
            <div class="info-box">
                <p><strong>Status:</strong> AKTIF ✅</p>
                <p><strong>Paket:</strong> {package_name}</p>
                <p><strong>Kecepatan:</strong> {package_speed}</p>
            </div>
            <p>Terima kasih telah melakukan pembayaran tepat waktu.</p>
            <p>{company_header}</p>
            <p>Info: {support_phone}</p>
        </div>
        <div class="footer">
            <p>{footer_info}</p>
        </div>
    </div>
</body>
</html>`,
                enabled: true
            },
            welcome_message: {
                title: 'Welcome Message',
                subject: 'Selamat Datang - {customer_name}',
                template: `<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0; }
        .content { background: #f8f9fa; padding: 20px; border-radius: 0 0 10px 10px; }
        .info-box { background: white; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #667eea; }
        .footer { text-align: center; margin-top: 20px; color: #6c757d; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>👋 Selamat Datang</h2>
        </div>
        <div class="content">
            <p>Halo <strong>{customer_name}</strong>,</p>
            <p>Selamat datang di layanan internet kami!</p>
            <div class="info-box">
                <p><strong>Paket:</strong> {package_name} ({package_speed})</p>
                <p><strong>PPPoE Username:</strong> {pppoe_username}</p>
                <p><strong>PPPoE Password:</strong> {pppoe_password}</p>
                <p><strong>Support:</strong> {support_phone}</p>
            </div>
            <p>Terima kasih telah memilih layanan kami.</p>
        </div>
        <div class="footer">
            <p>{company_header}</p>
            <p>{footer_info}</p>
        </div>
    </div>
</body>
</html>`,
                enabled: true
            }
        };
        this.initTransporter();
    }

    // Initialize email transporter
    initTransporter() {
        try {
            const smtpConfig = {
                host: getSetting('smtp_host', ''),
                port: parseInt(getSetting('smtp_port', '587')),
                secure: getSetting('smtp_secure', 'false') === 'true' || getSetting('smtp_secure', false) === true,
                auth: {
                    user: getSetting('smtp_user', ''),
                    pass: getSetting('smtp_password', '')
                },
                tls: {
                    rejectUnauthorized: getSetting('smtp_reject_unauthorized', 'true') !== 'false'
                }
            };

            // Check if SMTP is configured
            if (!smtpConfig.host || !smtpConfig.auth.user || !smtpConfig.auth.pass) {
                logger.warn('[EMAIL] SMTP not configured. Email notifications will be disabled.');
                this.transporter = null;
                return;
            }

            this.transporter = nodemailer.createTransport(smtpConfig);
            logger.info('[EMAIL] Email transporter initialized successfully');
        } catch (error) {
            logger.error('[EMAIL] Error initializing transporter:', error);
            this.transporter = null;
        }
    }

    // Reload transporter (useful when SMTP settings change)
    reloadTransporter() {
        this.initTransporter();
    }

    // Check if email is configured
    isConfigured() {
        return this.transporter !== null;
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

    // Send email notification
    async sendNotification(emailAddress, subject, htmlContent, options = {}) {
        try {
            if (!this.transporter) {
                logger.warn('[EMAIL] Cannot send email: SMTP not configured');
                return { success: false, error: 'SMTP not configured' };
            }

            if (!emailAddress || !emailAddress.includes('@')) {
                logger.warn(`[EMAIL] Invalid email address: ${emailAddress}`);
                return { success: false, error: 'Invalid email address' };
            }

            const fromEmail = getSetting('smtp_from_email', getSetting('smtp_user', 'noreply@example.com'));
            const fromName = getSetting('smtp_from_name', getSetting('company_name', 'Sistem Billing'));

            const mailOptions = {
                from: `"${fromName}" <${fromEmail}>`,
                to: emailAddress,
                subject: subject,
                html: htmlContent,
                ...options
            };

            const info = await this.transporter.sendMail(mailOptions);
            logger.info(`[EMAIL] Email sent successfully to ${emailAddress}: ${info.messageId}`);
            return { success: true, messageId: info.messageId };
        } catch (error) {
            logger.error(`[EMAIL] Error sending email to ${emailAddress}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Test email connection
    async testConnection() {
        try {
            if (!this.transporter) {
                return { success: false, error: 'SMTP not configured' };
            }

            await this.transporter.verify();
            return { success: true, message: 'SMTP connection successful' };
        } catch (error) {
            logger.error('[EMAIL] SMTP connection test failed:', error);
            return { success: false, error: error.message };
        }
    }

    // Load templates from file
    loadTemplates() {
        try {
            if (fs.existsSync(this.templatesFile)) {
                const data = fs.readFileSync(this.templatesFile, 'utf8');
                logger.info('[EMAIL] Loaded templates from file');
                return JSON.parse(data);
            }
        } catch (error) {
            logger.error('[EMAIL] Error loading templates:', error);
        }
        return null;
    }

    // Save templates to file
    saveTemplates() {
        try {
            const dataDir = path.dirname(this.templatesFile);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            
            fs.writeFileSync(this.templatesFile, JSON.stringify(this.templates, null, 2));
            logger.info('[EMAIL] Templates saved to file');
            return true;
        } catch (error) {
            logger.error('[EMAIL] Error saving templates:', error);
            return false;
        }
    }

    getTemplates() {
        return this.templates;
    }

    // Update template
    updateTemplate(templateKey, newTemplate) {
        if (this.templates[templateKey]) {
            this.templates[templateKey] = newTemplate;
            this.saveTemplates();
            return true;
        }
        return false;
    }

    // Update multiple templates at once
    updateTemplates(templatesData) {
        let updated = 0;
        Object.keys(templatesData).forEach(key => {
            if (this.templates[key]) {
                this.templates[key] = templatesData[key];
                updated++;
            }
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

    // Send invoice created notification
    async sendInvoiceCreatedNotification(customerId, invoiceId) {
        try {
            if (!this.isTemplateEnabled('invoice_created')) {
                logger.info('[EMAIL] Invoice created notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const customer = await billingManager.getCustomerById(customerId);
            const invoice = await billingManager.getInvoiceById(invoiceId);
            const packageData = await billingManager.getPackageById(invoice.package_id);

            if (!customer || !invoice || !packageData) {
                logger.error('[EMAIL] Missing data for invoice notification');
                return { success: false, error: 'Missing data' };
            }

            if (!customer.email) {
                logger.warn(`[EMAIL] Customer ${customer.name} has no email address`);
                return { success: false, error: 'No email address' };
            }

            const data = {
                customer_name: customer.name,
                invoice_number: invoice.invoice_number,
                amount: this.formatCurrency(invoice.amount),
                due_date: this.formatDate(invoice.due_date),
                package_name: packageData.name,
                package_speed: packageData.speed,
                notes: invoice.notes || 'Tagihan bulanan',
                company_header: getCompanyHeader(),
                footer_info: getSetting('footer_info', 'Powered by Alijaya Digital Network')
            };

            const subject = this.replaceTemplateVariables(
                this.templates.invoice_created.subject,
                data
            );
            const htmlContent = this.replaceTemplateVariables(
                this.templates.invoice_created.template,
                data
            );

            return await this.sendNotification(customer.email, subject, htmlContent);
        } catch (error) {
            logger.error('[EMAIL] Error sending invoice created notification:', error);
            return { success: false, error: error.message };
        }
    }

    // Send due date reminder
    async sendDueDateReminder(invoiceId) {
        try {
            if (!this.isTemplateEnabled('due_date_reminder')) {
                logger.info('[EMAIL] Due date reminder notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const invoice = await billingManager.getInvoiceById(invoiceId);
            const customer = await billingManager.getCustomerById(invoice.customer_id);
            const packageData = await billingManager.getPackageById(invoice.package_id);

            if (!customer || !invoice || !packageData) {
                logger.error('[EMAIL] Missing data for due date reminder');
                return { success: false, error: 'Missing data' };
            }

            if (!customer.email) {
                logger.warn(`[EMAIL] Customer ${customer.name} has no email address`);
                return { success: false, error: 'No email address' };
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
                package_speed: packageData.speed,
                company_header: getCompanyHeader(),
                footer_info: getSetting('footer_info', 'Powered by Alijaya Digital Network')
            };

            const subject = this.replaceTemplateVariables(
                this.templates.due_date_reminder.subject,
                data
            );
            const htmlContent = this.replaceTemplateVariables(
                this.templates.due_date_reminder.template,
                data
            );

            return await this.sendNotification(customer.email, subject, htmlContent);
        } catch (error) {
            logger.error('[EMAIL] Error sending due date reminder:', error);
            return { success: false, error: error.message };
        }
    }

    // Send payment received notification
    async sendPaymentReceivedNotification(paymentId) {
        try {
            if (!this.isTemplateEnabled('payment_received')) {
                logger.info('[EMAIL] Payment received notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const payment = await billingManager.getPaymentById(paymentId);
            const invoice = await billingManager.getInvoiceById(payment.invoice_id);
            const customer = await billingManager.getCustomerById(invoice.customer_id);

            if (!payment || !invoice || !customer) {
                logger.error('[EMAIL] Missing data for payment notification');
                return { success: false, error: 'Missing data' };
            }

            if (!customer.email) {
                logger.warn(`[EMAIL] Customer ${customer.name} has no email address`);
                return { success: false, error: 'No email address' };
            }

            const data = {
                customer_name: customer.name,
                invoice_number: invoice.invoice_number,
                amount: this.formatCurrency(payment.amount),
                payment_method: payment.payment_method,
                payment_date: this.formatDate(payment.payment_date),
                reference_number: payment.reference_number || 'N/A',
                company_header: getCompanyHeader(),
                footer_info: getSetting('footer_info', 'Powered by Alijaya Digital Network')
            };

            const subject = this.replaceTemplateVariables(
                this.templates.payment_received.subject,
                data
            );
            const htmlContent = this.replaceTemplateVariables(
                this.templates.payment_received.template,
                data
            );

            // Generate dan attach invoice PDF
            let pdfPath = null;
            try {
                const { generateInvoicePdf } = require('./invoicePdf');
                const pdfResult = await generateInvoicePdf(invoice.id);
                
                // Simpan PDF ke temporary file
                const tempDir = path.join(__dirname, '../temp');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }
                
                pdfPath = path.join(tempDir, pdfResult.fileName);
                fs.writeFileSync(pdfPath, pdfResult.buffer);
                logger.info(`[EMAIL] 📄 Invoice PDF generated: ${pdfPath}`);
                
                // Kirim email dengan attachment PDF
                const result = await this.sendNotification(
                    customer.email, 
                    subject, 
                    htmlContent,
                    {
                        attachments: [
                            {
                                filename: pdfResult.fileName,
                                path: pdfPath,
                                contentType: 'application/pdf'
                            }
                        ]
                    }
                );
                
                // Hapus temporary file setelah dikirim
                try {
                    if (fs.existsSync(pdfPath)) {
                        fs.unlinkSync(pdfPath);
                        logger.debug(`[EMAIL] 🗑️ Temporary PDF file deleted: ${pdfPath}`);
                    }
                } catch (deleteError) {
                    logger.warn(`[EMAIL] ⚠️ Failed to delete temporary PDF: ${deleteError.message}`);
                }
                
                if (result.success) {
                    logger.info(`[EMAIL] ✅ Payment notification with PDF sent to ${customer.email}`);
                    return { success: true, withPdf: true, messageId: result.messageId };
                } else {
                    // Jika email gagal, tetap hapus file
                    try {
                        if (fs.existsSync(pdfPath)) {
                            fs.unlinkSync(pdfPath);
                        }
                    } catch (deleteError) {
                        logger.warn(`[EMAIL] ⚠️ Failed to delete temporary PDF: ${deleteError.message}`);
                    }
                    return result;
                }
            } catch (pdfError) {
                logger.error('[EMAIL] Error generating/sending invoice PDF:', pdfError);
                // Hapus file jika ada error
                if (pdfPath && fs.existsSync(pdfPath)) {
                    try {
                        fs.unlinkSync(pdfPath);
                        logger.debug(`[EMAIL] 🗑️ Temporary PDF file deleted after error: ${pdfPath}`);
                    } catch (deleteError) {
                        logger.warn(`[EMAIL] ⚠️ Failed to delete temporary PDF after error: ${deleteError.message}`);
                    }
                }
                // Fallback: kirim email tanpa PDF jika generate PDF gagal
                logger.info('[EMAIL] Falling back to email without PDF attachment');
                return await this.sendNotification(customer.email, subject, htmlContent);
            }
        } catch (error) {
            logger.error('[EMAIL] Error sending payment received notification:', error);
            return { success: false, error: error.message };
        }
    }

    /** Email pelunasan multi-invoice (kolektor) — satu email merekap semua nomor invoice. */
    async sendCollectorBatchPaymentReceivedNotification(paymentIds) {
        try {
            const ids = [...new Set((paymentIds || [])
                .map((v) => parseInt(String(v), 10))
                .filter((id) => Number.isFinite(id) && id > 0))];
            if (!ids.length) return { success: false, error: 'No payment ids' };
            if (ids.length === 1) return this.sendPaymentReceivedNotification(ids[0]);
            if (!this.isTemplateEnabled('payment_received')) {
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const rows = [];
            for (const paymentId of ids) {
                const payment = await billingManager.getPaymentById(paymentId);
                if (!payment) continue;
                const invoice = await billingManager.getInvoiceById(payment.invoice_id);
                if (!invoice) continue;
                rows.push({ payment, invoice });
            }
            if (!rows.length) return { success: false, error: 'Missing data' };

            const customer = await billingManager.getCustomerById(rows[0].invoice.customer_id);
            if (!customer?.email) {
                return { success: false, error: 'No email address' };
            }

            let gross = 0;
            let discount = 0;
            for (const r of rows) {
                gross += Number(r.invoice.amount) || Number(r.payment.amount) || 0;
                discount += Number(r.payment.discount_amount) || 0;
            }
            const data = {
                customer_name: customer.name,
                invoice_number: rows.map((r) => r.invoice.invoice_number || `#${r.invoice.id}`).join(', '),
                amount: this.formatCurrency(Math.max(0, gross - discount)),
                payment_method: rows[0].payment.payment_method,
                payment_date: this.formatDate(rows[0].payment.payment_date),
                reference_number: 'N/A',
                company_header: getCompanyHeader(),
                footer_info: getSetting('footer_info', 'Powered by Alijaya Digital Network')
            };

            const subject = this.replaceTemplateVariables(this.templates.payment_received.subject, data);
            const htmlContent = this.replaceTemplateVariables(this.templates.payment_received.template, data);

            let pdfPath = null;
            try {
                const { generateCollectorBatchReceiptPdf } = require('./invoicePdf');
                const pdfResult = await generateCollectorBatchReceiptPdf(rows.map((r) => r.invoice.id));
                const tempDir = path.join(__dirname, '../temp');
                if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
                pdfPath = path.join(tempDir, pdfResult.fileName || `Resi-${rows.length}-invoice.pdf`);
                fs.writeFileSync(pdfPath, pdfResult.buffer);
                const result = await this.sendNotification(customer.email, subject, htmlContent, {
                    attachments: [{
                        filename: pdfResult.fileName || `Resi-${rows.length}-invoice.pdf`,
                        path: pdfPath,
                        contentType: 'application/pdf'
                    }]
                });
                try {
                    if (pdfPath && fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
                } catch (_) { /* ignore */ }
                return result;
            } catch (pdfError) {
                logger.warn('[EMAIL] Batch PDF failed, sending without attachment:', pdfError.message);
                if (pdfPath && fs.existsSync(pdfPath)) {
                    try { fs.unlinkSync(pdfPath); } catch (_) { /* ignore */ }
                }
                return await this.sendNotification(customer.email, subject, htmlContent);
            }
        } catch (error) {
            logger.error('[EMAIL] Error sending batch payment received notification:', error);
            return { success: false, error: error.message };
        }
    }

    // Send service disruption notification
    async sendServiceDisruptionNotification(disruptionData) {
        try {
            if (!this.isTemplateEnabled('service_disruption')) {
                logger.info('[EMAIL] Service disruption notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const customers = await billingManager.getCustomers();
            const activeCustomers = customers.filter(c => c.status === 'active' && c.email);

            const data = {
                disruption_type: disruptionData.type || 'Gangguan Jaringan',
                affected_area: disruptionData.area || 'Seluruh Area',
                estimated_resolution: disruptionData.estimatedTime || 'Sedang dalam penanganan',
                support_phone: getSetting('support_phone', '0813-6888-8498'),
                company_header: getCompanyHeader(),
                footer_info: getSetting('footer_info', 'Powered by Alijaya Digital Network')
            };

            const subject = this.replaceTemplateVariables(
                this.templates.service_disruption.subject,
                data
            );
            const htmlContent = this.replaceTemplateVariables(
                this.templates.service_disruption.template,
                data
            );

            const results = {
                success: 0,
                failed: 0,
                errors: []
            };

            // Send to all active customers with email
            for (const customer of activeCustomers) {
                try {
                    const result = await this.sendNotification(customer.email, subject, htmlContent);
                    if (result.success) {
                        results.success++;
                    } else {
                        results.failed++;
                        results.errors.push(`${customer.email}: ${result.error}`);
                    }
                } catch (error) {
                    results.failed++;
                    results.errors.push(`${customer.email}: ${error.message}`);
                }
            }

            return {
                success: true,
                sent: results.success,
                failed: results.failed,
                total: activeCustomers.length,
                errors: results.errors
            };
        } catch (error) {
            logger.error('[EMAIL] Error sending service disruption notification:', error);
            return { success: false, error: error.message };
        }
    }

    // Send service announcement
    async sendServiceAnnouncement(announcementData) {
        try {
            if (!this.isTemplateEnabled('service_announcement')) {
                logger.info('[EMAIL] Service announcement notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            const customers = await billingManager.getCustomers();
            const activeCustomers = customers.filter(c => c.status === 'active' && c.email);

            const data = {
                announcement_content: announcementData.content || 'Tidak ada konten pengumuman',
                company_header: getCompanyHeader(),
                footer_info: getSetting('footer_info', 'Powered by Alijaya Digital Network')
            };

            const subject = this.replaceTemplateVariables(
                this.templates.service_announcement.subject,
                data
            );
            const htmlContent = this.replaceTemplateVariables(
                this.templates.service_announcement.template,
                data
            );

            const results = {
                success: 0,
                failed: 0,
                errors: []
            };

            // Send to all active customers with email
            for (const customer of activeCustomers) {
                try {
                    const result = await this.sendNotification(customer.email, subject, htmlContent);
                    if (result.success) {
                        results.success++;
                    } else {
                        results.failed++;
                        results.errors.push(`${customer.email}: ${result.error}`);
                    }
                } catch (error) {
                    results.failed++;
                    results.errors.push(`${customer.email}: ${error.message}`);
                }
            }

            return {
                success: true,
                sent: results.success,
                failed: results.failed,
                total: activeCustomers.length,
                errors: results.errors
            };
        } catch (error) {
            logger.error('[EMAIL] Error sending service announcement:', error);
            return { success: false, error: error.message };
        }
    }

    // Send service suspension notification
    async sendServiceSuspensionNotification(customer, reason) {
        try {
            if (!this.isTemplateEnabled('service_suspension')) {
                logger.info('[EMAIL] Service suspension notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            if (!customer.email) {
                logger.warn(`[EMAIL] Customer ${customer.username} has no email address for suspension notification`);
                return { success: false, error: 'No email address' };
            }

            const data = {
                customer_name: customer.name,
                reason: reason,
                support_phone: getSetting('support_phone', '0813-6888-8498'),
                company_header: getCompanyHeader(),
                footer_info: getSetting('footer_info', 'Powered by Alijaya Digital Network')
            };

            const subject = this.replaceTemplateVariables(
                this.templates.service_suspension.subject,
                data
            );
            const htmlContent = this.replaceTemplateVariables(
                this.templates.service_suspension.template,
                data
            );

            const result = await this.sendNotification(customer.email, subject, htmlContent);
            if (result.success) {
                logger.info(`[EMAIL] Service suspension notification sent to ${customer.name} (${customer.email})`);
            } else {
                logger.error(`[EMAIL] Failed to send service suspension notification to ${customer.name}:`, result.error);
            }
            
            return result;
        } catch (error) {
            logger.error(`[EMAIL] Error sending service suspension notification to ${customer.name}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Send service restoration notification
    async sendServiceRestorationNotification(customer, reason) {
        try {
            if (!this.isTemplateEnabled('service_restoration')) {
                logger.info('[EMAIL] Service restoration notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            if (!customer.email) {
                logger.warn(`[EMAIL] Customer ${customer.username} has no email address for restoration notification`);
                return { success: false, error: 'No email address' };
            }

            const data = {
                customer_name: customer.name,
                package_name: customer.package_name || 'N/A',
                package_speed: customer.package_speed || 'N/A',
                support_phone: getSetting('support_phone', '0813-6888-8498'),
                company_header: getCompanyHeader(),
                footer_info: getSetting('footer_info', 'Powered by Alijaya Digital Network')
            };

            const subject = this.replaceTemplateVariables(
                this.templates.service_restoration.subject,
                data
            );
            const htmlContent = this.replaceTemplateVariables(
                this.templates.service_restoration.template,
                data
            );

            const result = await this.sendNotification(customer.email, subject, htmlContent);
            if (result.success) {
                logger.info(`[EMAIL] Service restoration notification sent to ${customer.name} (${customer.email})`);
            } else {
                logger.error(`[EMAIL] Failed to send service restoration notification to ${customer.name}:`, result.error);
            }
            
            return result;
        } catch (error) {
            logger.error(`[EMAIL] Error sending service restoration notification to ${customer.name}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Send welcome message notification
    async sendWelcomeMessage(customer) {
        try {
            if (!this.isTemplateEnabled('welcome_message')) {
                logger.info('[EMAIL] Welcome message notification is disabled, skipping...');
                return { success: true, skipped: true, reason: 'Template disabled' };
            }

            if (!customer.email) {
                logger.warn(`[EMAIL] Customer ${customer.username} has no email address for welcome message`);
                return { success: false, error: 'No email address' };
            }

            const data = {
                customer_name: customer.name,
                package_name: customer.package_name || 'N/A',
                package_speed: customer.package_speed || 'N/A',
                pppoe_username: customer.pppoe_username || 'N/A',
                pppoe_password: customer.pppoe_password || 'N/A',
                wifi_password: customer.wifi_password || 'N/A',
                support_phone: getSetting('support_phone', '0813-6888-8498'),
                company_header: getCompanyHeader(),
                footer_info: getSetting('footer_info', 'Powered by Alijaya Digital Network')
            };

            const subject = this.replaceTemplateVariables(
                this.templates.welcome_message.subject,
                data
            );
            const htmlContent = this.replaceTemplateVariables(
                this.templates.welcome_message.template,
                data
            );

            const result = await this.sendNotification(customer.email, subject, htmlContent);
            if (result.success) {
                logger.info(`[EMAIL] Welcome message sent to ${customer.name} (${customer.email})`);
            } else {
                logger.error(`[EMAIL] Failed to send welcome message to ${customer.name}:`, result.error);
            }
            
            return result;
        } catch (error) {
            logger.error(`[EMAIL] Error sending welcome message to ${customer.name}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Test notification to specific email
    async testNotification(emailAddress, templateKey, testData = {}) {
        try {
            if (!this.templates[templateKey]) {
                return { success: false, error: 'Template not found' };
            }

            const defaultData = {
                customer_name: 'Test Customer',
                invoice_number: 'INV-TEST-001',
                amount: '100.000',
                due_date: new Date().toLocaleDateString('id-ID'),
                package_name: 'Paket Test',
                package_speed: '10 Mbps',
                notes: 'Test notification',
                company_header: getCompanyHeader(),
                footer_info: getSetting('footer_info', 'Powered by Alijaya Digital Network'),
                ...testData
            };

            const subject = this.replaceTemplateVariables(
                this.templates[templateKey].subject,
                defaultData
            );
            const htmlContent = this.replaceTemplateVariables(
                this.templates[templateKey].template,
                defaultData
            );

            return await this.sendNotification(emailAddress, subject, htmlContent);
        } catch (error) {
            logger.error('[EMAIL] Error sending test notification:', error);
            return { success: false, error: error.message };
        }
    }
}

module.exports = new EmailNotificationManager();

