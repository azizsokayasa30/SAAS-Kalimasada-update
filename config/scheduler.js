const cron = require('node-cron');
const billingManager = require('./billing');
const logger = require('./logger');
const { getServerTimezone } = require('./settingsManager');
const {
    getDaysUntilDueDate,
    getBillingNotifySchedule,
    resolveBillingWaNotificationKind
} = require('./billing-wa-schedule');

class InvoiceScheduler {
    constructor() {
        this.initScheduler();
    }

    initScheduler() {
        // Schedule monthly invoice generation on 1st of every month at 08:00
        cron.schedule('0 8 1 * *', async () => {
            try {
                logger.info('Starting automatic monthly invoice generation (08:00)...');
                await this.generateMonthlyInvoices();
                logger.info('Automatic monthly invoice generation completed');
            } catch (error) {
                logger.error('Error in automatic monthly invoice generation:', error);
            }
        }, {
            scheduled: true,
            timezone: getServerTimezone()
        });

        logger.info('Invoice scheduler initialized - will run on 1st of every month at 08:00');
        
        // Daily invoice generation by billing_day is disabled as per policy (only monthly on the 1st)
        logger.info('Daily invoice-by-billing_day scheduler is DISABLED (only monthly on the 1st)');
        
        // Schedule daily due date reminders at 09:00
        cron.schedule('0 9 * * *', async () => {
            try {
                logger.info('Starting daily due date reminders...');
                await this.sendDueDateReminders();
                logger.info('Daily due date reminders completed');
            } catch (error) {
                logger.error('Error in daily due date reminders:', error);
            }
        }, {
            scheduled: true,
            timezone: getServerTimezone()
        });
        
        logger.info('Due date reminder scheduler initialized - will run daily at 09:00');

        // Schedule voucher cleanup every 6 hours
        cron.schedule('0 */6 * * *', async () => {
            try {
                logger.info('Starting voucher cleanup...');
                await this.cleanupExpiredVoucherInvoices();
                logger.info('Voucher cleanup completed');
            } catch (error) {
                logger.error('Error in voucher cleanup:', error);
            }
        }, {
            scheduled: true,
            timezone: getServerTimezone()
        });
        
        logger.info('Voucher cleanup scheduler initialized - will run every 6 hours');

        // Schedule monthly summary generation on 1st of every month at 23:59
        cron.schedule('59 23 1 * *', async () => {
            try {
                logger.info('Starting monthly summary generation...');
                await this.generateMonthlySummary();
                logger.info('Monthly summary generation completed');
            } catch (error) {
                logger.error('Error in monthly summary generation:', error);
            }
        }, {
            scheduled: true,
            timezone: getServerTimezone()
        });
        
        logger.info('Monthly summary scheduler initialized - will run on 1st of every month at 23:59');

        // Schedule monthly reset on 1st of every month at 00:01 (after summary generation)
        cron.schedule('1 0 1 * *', async () => {
            try {
                logger.info('Starting monthly reset process...');
                await this.performMonthlyReset();
                logger.info('Monthly reset process completed');
            } catch (error) {
                logger.error('Error in monthly reset process:', error);
            }
        }, {
            scheduled: true,
            timezone: getServerTimezone()
        });
        
        logger.info('Monthly reset scheduler initialized - will run on 1st of every month at 00:01');

        // Schedule service suspension check daily at 10:00 (hanya eksekusi isolir di tanggal yang dikonfigurasi, default tgl 25)
        cron.schedule('0 10 * * *', async () => {
            try {
                const serviceSuspension = require('./serviceSuspension');
                const suspensionDay = serviceSuspension.getAutoSuspensionDay();
                logger.info(`Starting service suspension check (default global tgl ${suspensionDay}, per pelanggan sesuai auto_suspension_day)...`);
                await serviceSuspension.checkAndSuspendOverdueCustomers();
                await serviceSuspension.checkAndSuspendOverdueMembers();
                logger.info('Service suspension check completed');
            } catch (error) {
                logger.error('Error in daily service suspension check:', error);
            }
        }, {
            scheduled: true,
            timezone: getServerTimezone()
        });

        // Schedule daily service restoration check at 11:00
        cron.schedule('0 11 * * *', async () => {
            try {
                logger.info('Starting daily service restoration check...');
                const serviceSuspension = require('./serviceSuspension');
                await serviceSuspension.checkAndRestorePaidCustomers();
                logger.info('Daily service restoration check completed');
            } catch (error) {
                logger.error('Error in daily service restoration check:', error);
            }
        }, {
            scheduled: true,
            timezone: getServerTimezone()
        });

        // Schedule sync suspended status to RADIUS every 30 minutes
        cron.schedule('*/30 * * * *', async () => {
            try {
                logger.info('Starting sync suspended status to RADIUS...');
                const serviceSuspension = require('./serviceSuspension');
                const result = await serviceSuspension.syncSuspendedStatusToRadius();
                logger.info(`Sync suspended status completed: synced=${result.synced}, alreadyIsolir=${result.alreadyIsolir}, errors=${result.errors}`);
            } catch (error) {
                logger.error('Error in sync suspended status to RADIUS:', error);
            }
        }, {
            scheduled: true,
            timezone: getServerTimezone()
        });
        
        logger.info('Sync suspended status scheduler initialized - will run every 30 minutes');

        logger.info('Service suspension/restoration scheduler initialized - suspension on configured day (default 25) at 10:00, restoration daily at 11:00');

        // Schedule RADIUS Auto Backup every day at 02:00 AM
        cron.schedule('0 2 * * *', async () => {
            try {
                logger.info('Checking RADIUS Auto Backup settings...');
                const { getSettingsWithCache } = require('./settingsManager');
                const db = require('./billing').db;
                
                // Retrieve app settings
                const appSettings = await new Promise((resolve) => {
                    db.all('SELECT key, value FROM app_settings', (err, rows) => {
                        const settingsObj = {};
                        if (!err && rows) {
                            rows.forEach(row => { settingsObj[row.key] = row.value; });
                        }
                        resolve(settingsObj);
                    });
                });
                
                if (appSettings.radius_autobackup_enabled === 'true') {
                    const interval = parseInt(appSettings.radius_autobackup_interval) || 7;
                    
                    const { listBackups, backupRadius } = require('../utils/radiusBackup');
                    const backups = await listBackups();
                    
                    let shouldBackup = true;
                    
                    if (backups && backups.length > 0) {
                        // listBackups sorts by creation date descending (newest first)
                        const newestBackupDate = new Date(backups[0].created);
                        const now = new Date();
                        const diffTime = Math.abs(now - newestBackupDate);
                        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
                        
                        if (diffDays < interval) {
                            shouldBackup = false;
                            logger.info(`RADIUS Auto Backup skipped. Last backup was ${diffDays} days ago, interval is ${interval} days.`);
                        }
                    }
                    
                    if (shouldBackup) {
                        logger.info(`Starting RADIUS Auto Backup (Interval: ${interval} days)...`);
                        const result = await backupRadius();
                        if (result.success) {
                            logger.info(`✅ RADIUS Auto Backup completed successfully: ${result.fileName}`);
                        } else {
                            logger.error(`❌ RADIUS Auto Backup failed: ${result.message}`);
                        }
                    }
                } else {
                    logger.debug('RADIUS Auto Backup is disabled.');
                }

                // Billing database auto backup
                if (appSettings.billing_autobackup_enabled === 'true') {
                    const billingInterval = parseInt(appSettings.billing_autobackup_interval, 10) || 7;
                    const { runBillingAutoBackupIfEnabled } = require('../utils/billingDbBackup');
                    const { logActivity } = require('./activityLogger');
                    const billingResult = await runBillingAutoBackupIfEnabled({ db });

                    if (billingResult.ran) {
                        logger.info(`✅ Billing Auto Backup completed: ${billingResult.filename}`);
                        try {
                            await logActivity({
                                userType: 'system',
                                userId: 'scheduler',
                                action: 'database_backup_auto',
                                description: `Auto backup database: ${billingResult.filename} (interval ${billingInterval} hari)`
                            });
                        } catch (logErr) {
                            logger.warn(`[billing-backup] Gagal catat activity log: ${logErr.message}`);
                        }
                    } else if (billingResult.reason === 'interval') {
                        logger.info(
                            `Billing Auto Backup skipped. Last backup ${billingResult.daysSinceLast} hari lalu, interval ${billingResult.interval} hari.`
                        );
                    }
                } else {
                    logger.debug('Billing Auto Backup is disabled.');
                }
            } catch (error) {
                logger.error('Error in RADIUS Auto Backup scheduler:', error);
            }
        }, {
            scheduled: true,
            timezone: getServerTimezone()
        });
        
        logger.info('RADIUS Auto Backup scheduler initialized - will run daily at 02:00 AM');

        // Schedule voucher cleanup every 6 hours (00:00, 06:00, 12:00, 18:00)
        cron.schedule('0 0,6,12,18 * * *', async () => {
            try {
                logger.info('Starting automatic voucher cleanup...');

                // Make HTTP request to cleanup endpoint
                const https = require('http');

                const options = {
                    hostname: 'localhost',
                    port: process.env.PORT || 3004,
                    path: '/voucher/cleanup-expired',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                };

                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    res.on('end', () => {
                        try {
                            const result = JSON.parse(data);
                            if (result.success) {
                                logger.info(`Automatic voucher cleanup completed: ${result.message}`);
                                if (result.details) {
                                    logger.info(`Database deleted: ${result.details.database_deleted}, Mikrotik deleted: ${result.details.mikrotik_deleted}`);
                                }
                            } else {
                                logger.error('Automatic voucher cleanup failed:', result.message);
                            }
                        } catch (e) {
                            logger.error('Error parsing voucher cleanup response:', e);
                        }
                    });
                });

                req.on('error', (e) => {
                    logger.error('Error in automatic voucher cleanup request:', e.message);
                });

                req.write(JSON.stringify({}));
                req.end();

            } catch (error) {
                logger.error('Error in automatic voucher cleanup:', error);
            }
        }, {
            scheduled: true,
            timezone: getServerTimezone()
        });

        logger.info('Voucher cleanup scheduler initialized - will run every 6 hours');
        

    }

    async sendDueDateReminders() {
        try {
            const { isWaSystemMonitorEnabled } = require('./whatsappMonitoringSettings');
            if (!isWaSystemMonitorEnabled('billing_daily_due_wa')) {
                logger.info('Master switch billing_daily_due_wa off — skip pengingat jatuh tempo harian');
                return;
            }

            const whatsappNotifications = require('./whatsapp-notifications');
            const invoices = await billingManager.getInvoices();
            const schedule = getBillingNotifySchedule();

            const dueInvoices = invoices.filter((invoice) => {
                if (invoice.status !== 'unpaid' || !invoice.due_date) return false;
                const daysUntilDue = getDaysUntilDueDate(invoice.due_date);
                return resolveBillingWaNotificationKind(daysUntilDue, schedule) != null;
            });

            logger.info(
                `Jadwal WA tagihan: ${dueInvoices.length} invoice ` +
                `(tagihan baru H-${schedule.invoice_notify_days_before}, ` +
                `pengingat H-${schedule.reminder_days_before}, ` +
                `${schedule.send_on_due_day ? 'hari H' : 'tanpa hari H'})`
            );

            for (const invoice of dueInvoices) {
                try {
                    const daysUntilDue = getDaysUntilDueDate(invoice.due_date);
                    const kind = resolveBillingWaNotificationKind(daysUntilDue, schedule);
                    if (!kind) continue;

                    if (invoice.member_id) {
                        if (kind === 'invoice_created') {
                            await whatsappNotifications.sendMemberInvoiceCreatedNotification(
                                invoice.member_id,
                                invoice.id,
                                { fromSchedule: true }
                            );
                        } else {
                            const reminderType = kind === 'reminder_today' ? 'today' : 'before';
                            await whatsappNotifications.sendMemberDueDateReminder(
                                invoice.id,
                                { reminderType }
                            );
                        }
                    } else if (invoice.customer_id) {
                        if (kind === 'invoice_created') {
                            await whatsappNotifications.sendInvoiceCreatedNotification(
                                invoice.customer_id,
                                invoice.id,
                                { fromSchedule: true }
                            );
                        } else {
                            const reminderType = kind === 'reminder_today' ? 'today' : 'before';
                            await whatsappNotifications.sendDueDateReminder(
                                invoice.id,
                                { reminderType }
                            );
                        }
                    }

                    const dayLabel = daysUntilDue === 0 ? 'hari H' : `H-${daysUntilDue}`;
                    logger.info(`WA tagihan (${kind}, ${dayLabel}) invoice ${invoice.invoice_number}`);
                } catch (error) {
                    logger.error(`Error sending scheduled billing WA for invoice ${invoice.invoice_number}:`, error);
                }
            }
        } catch (error) {
            logger.error('Error in sendDueDateReminders:', error);
            throw error;
        }
    }

    /**
     * WA + email lambat (jaringan); jangan blokir loop generate ratusan invoice.
     * Tetap dijalankan setelah commit DB; error hanya di-log.
     */
    _enqueueCustomerInvoiceNotifications(customerId, invoiceId) {
        void (async () => {
            // WA tagihan baru mengikuti jadwal harian (H-X), bukan saat invoice dibuat
            try {
                const { isWaSystemMonitorEnabled } = require('./whatsappMonitoringSettings');
                if (isWaSystemMonitorEnabled('billing_scheduler_invoice_wa')) {
                    logger.info(
                        `WA tagihan baru invoice ${invoiceId} ditunda ke jadwal harian ` +
                        `(H-${getBillingNotifySchedule().invoice_notify_days_before}, pengingat, hari H)`
                    );
                }
            } catch (_) { /* ignore */ }
            try {
                const emailNotifications = require('./email-notifications');
                await emailNotifications.sendInvoiceCreatedNotification(customerId, invoiceId);
                logger.info(`Email notification queued/sent for invoice id ${invoiceId}`);
            } catch (notificationError) {
                logger.error(`Async Email notification failed for invoice id ${invoiceId}:`, notificationError);
            }
        })().catch((e) => logger.error('Unhandled async customer invoice notifications:', e));
    }

    _enqueueMemberInvoiceNotifications(memberId, invoiceId) {
        void (async () => {
            try {
                const { isWaSystemMonitorEnabled } = require('./whatsappMonitoringSettings');
                if (isWaSystemMonitorEnabled('billing_scheduler_invoice_wa')) {
                    logger.info(
                        `WA tagihan member invoice ${invoiceId} ditunda ke jadwal harian`
                    );
                }
            } catch (_) { /* ignore */ }
            try {
                const emailNotifications = require('./email-notifications');
                await emailNotifications.sendMemberInvoiceCreatedNotification(memberId, invoiceId);
                logger.info(`Email notification queued/sent for member invoice id ${invoiceId}`);
            } catch (notificationError) {
                logger.error(`Async Email notification failed for member invoice id ${invoiceId}:`, notificationError);
            }
        })().catch((e) => logger.error('Unhandled async member invoice notifications:', e));
    }

    async generateMonthlyInvoices() {
        try {
            // Get all active customers
            const customers = await billingManager.getCustomers();
            const activeCustomers = customers.filter(customer => 
                customer.status === 'active' && customer.package_id
            );

            logger.info(`Found ${activeCustomers.length} active customers for invoice generation`);

            const currentDate = new Date();
            const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
            const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);

            const [packageById, customersWithInvoiceThisMonth] = await Promise.all([
                billingManager.getAllPackagesByIdMap(),
                billingManager.getDistinctCustomerUsernamesWithInvoicesBetween(startOfMonth, endOfMonth)
            ]);

            for (const customer of activeCustomers) {
                try {
                    const packageData = packageById.get(customer.package_id);
                    if (!packageData) {
                        logger.warn(`Package not found for customer ${customer.username}`);
                        continue;
                    }

                    if (customersWithInvoiceThisMonth.has(customer.username)) {
                        logger.info(`Invoice already exists for customer ${customer.username} this month`);
                        continue;
                    }

                    // Set due date based on customer's renewal type
                    let dueDate;
                    const renewalType = customer.renewal_type || 'renewal';
                    
                    if (renewalType === 'fix_date') {
                        // Fix Date: Use fix_date or billing_day
                        const fixDate = customer.fix_date || customer.billing_day || 15;
                        const targetDay = Math.min(fixDate, 28);
                        const lastDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
                        const finalDay = Math.min(targetDay, lastDayOfMonth);
                        dueDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), finalDay);
                    } else {
                        // Renewal: Use billing_day (default behavior)
                        const billingDay = (() => {
                            const v = parseInt(customer.billing_day, 10);
                            if (Number.isFinite(v)) return Math.min(Math.max(v, 1), 28);
                            return 15;
                        })();
                        const lastDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
                        const targetDay = Math.min(billingDay, lastDayOfMonth);
                        dueDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), targetDay);
                    }

                    // Create invoice data with PPN calculation
                    const basePrice = packageData.price;
                    const taxRate = (packageData.tax_rate === 0 || (typeof packageData.tax_rate === 'number' && packageData.tax_rate > -1))
                        ? Number(packageData.tax_rate)
                        : 11.00; // Default 11% only when undefined/null/invalid
                    const amountWithTax = billingManager.calculatePriceWithTax(basePrice, taxRate);
                    
                    const invoiceData = {
                        customer_id: customer.id,
                        package_id: customer.package_id,
                        amount: amountWithTax, // Use price with tax
                        base_amount: basePrice, // Store base price for reference
                        tax_rate: taxRate, // Store tax rate for reference
                        due_date: dueDate.toISOString().split('T')[0],
                        notes: `Tagihan bulanan ${currentDate.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })} - ${renewalType === 'fix_date' ? 'Fix Date' : 'Renewal'} type`,
                        invoice_type: 'monthly',
                        package_name: packageData.name
                    };

                    // Create the invoice
                    const newInvoice = await billingManager.createInvoice(invoiceData);
                    logger.info(`Created invoice ${newInvoice.invoice_number} for customer ${customer.username}`);
                    customersWithInvoiceThisMonth.add(customer.username);
                    this._enqueueCustomerInvoiceNotifications(customer.id, newInvoice.id);

                } catch (error) {
                    logger.error(`Error creating invoice for customer ${customer.username}:`, error);
                }
            }

            // Generate invoices for members
            await this.generateMonthlyInvoicesForMembers();

        } catch (error) {
            logger.error('Error in generateMonthlyInvoices:', error);
            throw error;
        }
    }

    async generateMonthlyInvoicesForMembers() {
        try {
            // Get all active members
            const members = await billingManager.getAllMembers({ status: 'active' });
            const activeMembers = members.filter(member => 
                member.status === 'active' && member.package_id
            );

            logger.info(`Found ${activeMembers.length} active members for invoice generation`);

            const currentDate = new Date();
            const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
            const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);

            const [allMemberPackages, memberKeysWithInvoice] = await Promise.all([
                billingManager.getAllMemberPackages(false),
                billingManager.getMemberIdentityKeysWithInvoicesBetween(startOfMonth, endOfMonth)
            ]);
            const memberPackageById = new Map(allMemberPackages.map((p) => [p.id, p]));

            for (const member of activeMembers) {
                try {
                    const packageData = memberPackageById.get(member.package_id);
                    if (!packageData) {
                        logger.warn(`Package not found for member ${member.hotspot_username || member.name}`);
                        continue;
                    }

                    const memberUsername = member.hotspot_username || member.username;
                    if (!memberUsername) {
                        logger.warn(`Member ${member.name} has no hotspot_username or username, skipping`);
                        continue;
                    }

                    if (memberKeysWithInvoice.has(String(memberUsername).trim())) {
                        logger.info(`Invoice already exists for member ${memberUsername} this month`);
                        continue;
                    }

                    // Set due date based on member's billing_day
                    const billingDay = (() => {
                        const v = parseInt(member.billing_day, 10);
                        if (Number.isFinite(v)) return Math.min(Math.max(v, 1), 28);
                        return 15;
                    })();
                    const lastDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
                    const targetDay = Math.min(billingDay, lastDayOfMonth);
                    const dueDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), targetDay);

                    // Create invoice data with PPN calculation
                    const basePrice = packageData.price;
                    const taxRate = (packageData.tax_rate === 0 || (typeof packageData.tax_rate === 'number' && packageData.tax_rate > -1))
                        ? Number(packageData.tax_rate)
                        : 11.00;
                    const amountWithTax = billingManager.calculatePriceWithTax(basePrice, taxRate);
                    
                    const invoiceData = {
                        member_id: member.id,
                        package_id: member.package_id,
                        amount: amountWithTax,
                        base_amount: basePrice,
                        tax_rate: taxRate,
                        due_date: dueDate.toISOString().split('T')[0],
                        notes: `Tagihan bulanan member ${currentDate.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })}`,
                        invoice_type: 'monthly',
                        package_name: packageData.name,
                        description: `Tagihan paket ${packageData.name}`
                    };

                    // Create the invoice
                    const newInvoice = await billingManager.createInvoice(invoiceData);
                    logger.info(`Created invoice ${newInvoice.invoice_number} for member ${memberUsername}`);
                    memberKeysWithInvoice.add(String(memberUsername).trim());
                    this._enqueueMemberInvoiceNotifications(member.id, newInvoice.id);

                } catch (error) {
                    logger.error(`Error creating invoice for member ${member.hotspot_username || member.name}:`, error);
                }
            }

        } catch (error) {
            logger.error('Error in generateMonthlyInvoicesForMembers:', error);
            throw error;
        }
    }

    // Generate invoices daily for customers whose billing_day is today
    async generateDailyInvoicesByBillingDay() {
        try {
            // Get all active customers
            const customers = await billingManager.getCustomers();
            const activeCustomers = customers.filter(customer => 
                customer.status === 'active' && customer.package_id
            );

            const today = new Date();
            const todayDay = today.getDate();
            const currentYear = today.getFullYear();
            const currentMonth = today.getMonth();

            // Compute start and end of current month for duplicate checks
            const startOfMonth = new Date(currentYear, currentMonth, 1);
            const endOfMonth = new Date(currentYear, currentMonth + 1, 0);

            // For each active customer whose billing_day == today (capped 1-28)
            for (const customer of activeCustomers) {
                try {
                    const normalizedBillingDay = (() => {
                        const v = parseInt(customer.billing_day, 10);
                        if (Number.isFinite(v)) return Math.min(Math.max(v, 1), 28);
                        return 15;
                    })();

                    // If today matches the customer's billing day (allowing month shorter than 31)
                    if (todayDay !== normalizedBillingDay) {
                        continue;
                    }

                    // Get package
                    const packageData = await billingManager.getPackageById(customer.package_id);
                    if (!packageData) {
                        logger.warn(`Package not found for customer ${customer.username}`);
                        continue;
                    }

                    // Check if invoice already exists for this month
                    const existingInvoices = await billingManager.getInvoicesByCustomerAndDateRange(
                        customer.username,
                        startOfMonth,
                        endOfMonth
                    );
                    if (existingInvoices.length > 0) {
                        logger.info(`Invoice already exists for customer ${customer.username} this month (daily generator)`);
                        continue;
                    }

                    // Set due date to today's date (which equals billing_day)
                    const dueDate = new Date(currentYear, currentMonth, normalizedBillingDay)
                        .toISOString()
                        .split('T')[0];

                    // Calculate amount with tax
                    const basePrice = packageData.price;
                    const taxRate = (packageData.tax_rate === 0 || (typeof packageData.tax_rate === 'number' && packageData.tax_rate > -1))
                        ? Number(packageData.tax_rate)
                        : 11.00;
                    const amountWithTax = billingManager.calculatePriceWithTax(basePrice, taxRate); // Sudah include rounding

                    const invoiceData = {
                        customer_id: customer.id,
                        package_id: customer.package_id,
                        amount: amountWithTax,
                        base_amount: basePrice,
                        tax_rate: taxRate,
                        due_date: dueDate,
                        notes: `Tagihan bulanan ${today.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })}`
                    };

                    const newInvoice = await billingManager.createInvoice(invoiceData);
                    logger.info(`(Daily) Created invoice ${newInvoice.invoice_number} for customer ${customer.username}`);
                    this._enqueueCustomerInvoiceNotifications(customer.id, newInvoice.id);

                } catch (error) {
                    logger.error(`(Daily) Error creating invoice for customer ${customer.username}:`, error);
                }
            }
        } catch (error) {
            logger.error('Error in generateDailyInvoicesByBillingDay:', error);
            throw error;
        }
    }

    // Manual trigger for testing
    async triggerMonthlyInvoices() {
        try {
            logger.info('Triggering monthly invoice generation manually...');
            await this.generateMonthlyInvoices();
            logger.info('Manual monthly invoice generation completed');
            return { success: true, message: 'Monthly invoices generated successfully' };
        } catch (error) {
            logger.error('Error in manual monthly invoice generation:', error);
            throw error;
        }
    }

    // Manual trigger for monthly reset
    async triggerMonthlyReset() {
        try {
            logger.info('Triggering monthly reset manually...');
            const result = await this.performMonthlyReset();
            logger.info('Manual monthly reset completed');
            return result;
        } catch (error) {
            logger.error('Error in manual monthly reset:', error);
            throw error;
        }
    }

    async cleanupExpiredVoucherInvoices() {
        try {
            logger.info('Starting voucher cleanup process...');
            const result = await billingManager.cleanupExpiredVoucherInvoices();
            
            if (result.success) {
                if (result.cleaned > 0) {
                    logger.info(`Voucher cleanup completed: ${result.message}`);
                } else {
                    logger.info('Voucher cleanup completed: No expired invoices found');
                }
            } else {
                logger.error('Voucher cleanup failed:', result.message);
            }
            
            return result;
        } catch (error) {
            logger.error('Error in cleanupExpiredVoucherInvoices:', error);
            throw error;
        }
    }

    async generateMonthlySummary() {
        try {
            logger.info('Starting monthly summary generation...');
            const result = await billingManager.generateMonthlySummary();
            
            if (result.success) {
                logger.info(`Monthly summary generated: ${result.message}`);
            } else {
                logger.error('Monthly summary generation failed:', result.message);
            }
            
            return result;
        } catch (error) {
            logger.error('Error in generateMonthlySummary:', error);
            throw error;
        }
    }

    async performMonthlyReset() {
        try {
            logger.info('Starting monthly reset process...');
            const result = await billingManager.performMonthlyReset();
            
            if (result.success) {
                logger.info(`Monthly reset completed: ${result.message}`);
                logger.info(`Summary saved for ${result.previousYear}-${result.previousMonth}`);
                logger.info(`Reset for ${result.year}-${result.month}`);
                logger.info(`Processed ${result.collectorsProcessed} collectors`);
            } else {
                logger.error('Monthly reset failed:', result.message);
            }
            
            return result;
        } catch (error) {
            logger.error('Error in performMonthlyReset:', error);
            throw error;
        }
    }


}

module.exports = new InvoiceScheduler(); 