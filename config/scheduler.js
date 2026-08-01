const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const billingManager = require('./billing');
const logger = require('./logger');
const { getServerTimezone } = require('./settingsManager');
const { toLocalDateString, currentLocalMonthDateRange } = require('../utils/localDate');
const {
    getDaysUntilDueDate,
    getBillingNotifySchedule,
    resolveBillingWaNotificationKind
} = require('./billing-wa-schedule');

const MONTHLY_INVOICE_LOCK = path.join(__dirname, '..', 'data', '.monthly-invoice.lock');
const MONTHLY_INVOICE_LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const TENANT_INVOICE_LOCK_DIR = path.join(__dirname, '..', 'data');

class InvoiceScheduler {
    constructor() {
        this._monthlyGenerateRunning = false;
        // CLI repair/generate: set SKIP_INVOICE_SCHEDULER=1 agar tidak daftar cron ganda
        if (process.env.SKIP_INVOICE_SCHEDULER === '1') {
            logger.info('Invoice scheduler cron skipped (SKIP_INVOICE_SCHEDULER=1)');
        } else {
            this.initScheduler();
        }
    }

    /** Lock lintas-proses: cegah 2 instance Node (PM2 + nohup) generate bersamaan → tagihan dobel. */
    _tryAcquireMonthlyInvoiceLock() {
        try {
            const fd = fs.openSync(MONTHLY_INVOICE_LOCK, 'wx');
            fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
            fs.closeSync(fd);
            return true;
        } catch (err) {
            if (err && err.code === 'EEXIST') {
                try {
                    const raw = fs.readFileSync(MONTHLY_INVOICE_LOCK, 'utf8');
                    const lines = String(raw).split('\n');
                    const lockPid = parseInt(lines[0], 10);
                    const lockAt = parseInt(lines[1], 10);
                    const stale = !Number.isFinite(lockAt) || (Date.now() - lockAt) > MONTHLY_INVOICE_LOCK_STALE_MS;
                    let alive = false;
                    if (Number.isFinite(lockPid) && lockPid > 0) {
                        try {
                            process.kill(lockPid, 0);
                            alive = true;
                        } catch (_) {
                            alive = false;
                        }
                    }
                    if (stale || !alive) {
                        fs.unlinkSync(MONTHLY_INVOICE_LOCK);
                        return this._tryAcquireMonthlyInvoiceLock();
                    }
                } catch (_) {
                    /* ignore parse errors */
                }
                return false;
            }
            throw err;
        }
    }

    _releaseMonthlyInvoiceLock() {
        try {
            if (fs.existsSync(MONTHLY_INVOICE_LOCK)) {
                const raw = fs.readFileSync(MONTHLY_INVOICE_LOCK, 'utf8');
                const lockPid = parseInt(String(raw).split('\n')[0], 10);
                if (!Number.isFinite(lockPid) || lockPid === process.pid) {
                    fs.unlinkSync(MONTHLY_INVOICE_LOCK);
                }
            }
        } catch (_) {
            /* ignore */
        }
    }

    _tenantInvoiceLockPath(tenantId) {
        return path.join(TENANT_INVOICE_LOCK_DIR, `.monthly-invoice-tenant-${tenantId}.lock`);
    }

    _tryAcquireTenantInvoiceLock(tenantId) {
        const lockPath = this._tenantInvoiceLockPath(tenantId);
        try {
            const fd = fs.openSync(lockPath, 'wx');
            fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
            fs.closeSync(fd);
            return true;
        } catch (err) {
            if (err && err.code === 'EEXIST') {
                try {
                    const raw = fs.readFileSync(lockPath, 'utf8');
                    const lines = String(raw).split('\n');
                    const lockPid = parseInt(lines[0], 10);
                    const lockAt = parseInt(lines[1], 10);
                    const stale = !Number.isFinite(lockAt) || (Date.now() - lockAt) > MONTHLY_INVOICE_LOCK_STALE_MS;
                    let alive = false;
                    if (Number.isFinite(lockPid) && lockPid > 0) {
                        try {
                            process.kill(lockPid, 0);
                            alive = true;
                        } catch (_) {
                            alive = false;
                        }
                    }
                    if (stale || !alive) {
                        fs.unlinkSync(lockPath);
                        return this._tryAcquireTenantInvoiceLock(tenantId);
                    }
                } catch (_) {
                    /* ignore */
                }
                return false;
            }
            throw err;
        }
    }

    _releaseTenantInvoiceLock(tenantId) {
        try {
            const lockPath = this._tenantInvoiceLockPath(tenantId);
            if (fs.existsSync(lockPath)) {
                const raw = fs.readFileSync(lockPath, 'utf8');
                const lockPid = parseInt(String(raw).split('\n')[0], 10);
                if (!Number.isFinite(lockPid) || lockPid === process.pid) {
                    fs.unlinkSync(lockPath);
                }
            }
        } catch (_) {
            /* ignore */
        }
    }

    async runMonthlyInvoiceGenerationForAllTenants(options = {}) {
        const { skipNotifications = true, label = 'auto-invoice' } = options;
        if (this._monthlyGenerateRunning) {
            logger.warn(`[${label}] generate bulanan sudah berjalan di proses ini — skip`);
            return { skipped: true, reason: 'in-process' };
        }
        if (!this._tryAcquireMonthlyInvoiceLock()) {
            logger.warn(`[${label}] generate bulanan di-skip — lock dipegang proses lain (cegah tagihan dobel)`);
            return { skipped: true, reason: 'locked' };
        }
        this._monthlyGenerateRunning = true;
        try {
            const { forEachOperationalTenant } = require('./platform/tenantJobs');
            logger.info(`[${label}] Starting monthly invoice generation (per-tenant)...`);
            const results = await forEachOperationalTenant(async (tenant) => {
                logger.info(`[${label}] tenant #${tenant.id} (${tenant.subdomain || tenant.name})`);
                return this.generateMonthlyInvoices({ skipNotifications });
            }, { label });
            const ok = results.filter((r) => r.success).length;
            logger.info(`[${label}] Monthly invoice generation completed for ${ok}/${results.length} tenants`);
            return { skipped: false, results };
        } finally {
            this._monthlyGenerateRunning = false;
            this._releaseMonthlyInvoiceLock();
        }
    }

    initScheduler() {
        // Schedule monthly invoice generation on 1st of every month at 08:00 (per-tenant)
        cron.schedule('0 8 1 * *', async () => {
            try {
                await this.runMonthlyInvoiceGenerationForAllTenants({
                    skipNotifications: true,
                    label: 'auto-invoice'
                });
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
                const { forEachOperationalTenant } = require('./platform/tenantJobs');
                const serviceSuspension = require('./serviceSuspension');
                logger.info('Starting service suspension check (per-tenant)...');
                const results = await forEachOperationalTenant(async (tenant) => {
                    const day = serviceSuspension.getAutoSuspensionDay();
                    logger.info(`[isolir] tenant #${tenant.id} (${tenant.subdomain || tenant.name}) day=${day}`);
                    const customers = await serviceSuspension.checkAndSuspendOverdueCustomers();
                    const members = await serviceSuspension.checkAndSuspendOverdueMembers();
                    return { customers, members };
                }, { label: 'auto-isolir' });
                const ok = results.filter((r) => r.success).length;
                logger.info(`Service suspension check completed for ${ok}/${results.length} tenants`);
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
                logger.info('Starting daily service restoration check (per-tenant)...');
                const { forEachOperationalTenant } = require('./platform/tenantJobs');
                const serviceSuspension = require('./serviceSuspension');
                const results = await forEachOperationalTenant(async (tenant) => {
                    logger.info(`[restore] tenant #${tenant.id} (${tenant.subdomain || tenant.name})`);
                    return serviceSuspension.checkAndRestorePaidCustomers();
                }, { label: 'auto-restore' });
                const ok = results.filter((r) => r.success).length;
                logger.info(`Daily service restoration check completed for ${ok}/${results.length} tenants`);
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
                logger.info('Starting sync suspended status to RADIUS (per-tenant)...');
                const { forEachOperationalTenant } = require('./platform/tenantJobs');
                const serviceSuspension = require('./serviceSuspension');
                const results = await forEachOperationalTenant(async (tenant) => {
                    const result = await serviceSuspension.syncSuspendedStatusToRadius();
                    const inactiveResult = await serviceSuspension.syncInactiveStatusToNetwork();
                    logger.info(
                        `[radius-sync] tenant #${tenant.id}: isolir synced=${result.synced}, alreadyIsolir=${result.alreadyIsolir}, errors=${result.errors}; inactive synced=${inactiveResult.synced}, errors=${inactiveResult.errors}`
                    );
                    return { isolir: result, inactive: inactiveResult };
                }, { label: 'radius-isolir-sync' });
                const ok = results.filter((r) => r.success).length;
                logger.info(`Sync suspended/inactive status completed for ${ok}/${results.length} tenants`);
            } catch (error) {
                logger.error('Error in sync suspended status to RADIUS:', error);
            }
        }, {
            scheduled: true,
            timezone: getServerTimezone()
        });
        
        logger.info('Sync suspended status scheduler initialized - will run every 30 minutes');

        logger.info('Service suspension/restoration scheduler initialized - suspension on configured day (default 25) at 10:00, restoration daily at 11:00 (per-tenant isolated)');

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

                // Per-tenant billing ZIP auto backup (bukan full billing.db)
                try {
                    const tenantStore = require('./platform/tenantStore');
                    const { runTenantAutoBackupIfEnabled } = require('../utils/tenantBillingBackup');
                    const { logActivity } = require('./activityLogger');

                    const getExactTenantAutoBackupSettings = (tenantId) =>
                        new Promise((resolve) => {
                            db.all(
                                `SELECT key, value FROM app_settings
                                 WHERE tenant_id = ?
                                   AND key IN ('billing_autobackup_enabled', 'billing_autobackup_interval')`,
                                [tenantId],
                                (err, rows) => {
                                    const settingsObj = {};
                                    if (!err && rows) {
                                        rows.forEach((row) => {
                                            settingsObj[row.key] = row.value;
                                        });
                                    }
                                    resolve(settingsObj);
                                }
                            );
                        });

                    const tenants = await tenantStore.listTenants({ operationalOnly: true });
                    let ranCount = 0;
                    for (const tenant of tenants || []) {
                        const tid = Number(tenant.id);
                        if (!Number.isFinite(tid)) continue;
                        try {
                            const result = await runTenantAutoBackupIfEnabled(
                                db,
                                tid,
                                getExactTenantAutoBackupSettings
                            );
                            if (result.ran) {
                                ranCount += 1;
                                logger.info(
                                    `✅ Tenant ${tid} auto backup ZIP: ${result.filename}`
                                );
                                try {
                                    await logActivity({
                                        userType: 'system',
                                        userId: 'scheduler',
                                        action: 'database_backup_auto',
                                        description: `Auto backup tenant ${tid}: ${result.filename} (interval ${result.interval} hari)`,
                                        tenantId: tid
                                    });
                                } catch (logErr) {
                                    logger.warn(
                                        `[tenant-backup] Gagal catat activity log tenant ${tid}: ${logErr.message}`
                                    );
                                }
                            } else if (result.reason === 'interval') {
                                logger.debug(
                                    `Tenant ${tid} auto backup skipped (interval ${result.interval} hari, last ${result.daysSinceLast} hari).`
                                );
                            }
                        } catch (tenantErr) {
                            logger.error(
                                `❌ Tenant ${tid} auto backup failed: ${tenantErr.message}`
                            );
                        }
                    }
                    if (ranCount === 0) {
                        logger.debug('Tenant ZIP auto backup: tidak ada tenant yang perlu di-backup saat ini.');
                    }
                } catch (tenantBackupErr) {
                    logger.error('Error in tenant ZIP auto backup scheduler:', tenantBackupErr);
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

    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /** SQLite sibuk saat bulk generate + akses web bersamaan — retry singkat. */
    async _createInvoiceWithRetry(invoiceData, maxAttempts = 10) {
        let lastErr;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                return await billingManager.createInvoice(invoiceData);
            } catch (err) {
                lastErr = err;
                const msg = String(err && err.message ? err.message : err);
                const busy = msg.includes('SQLITE_BUSY') || msg.includes('database is locked');
                const uniqueInv = msg.includes('UNIQUE') && msg.includes('invoice');
                if (!busy && !uniqueInv) throw err;
                await this._sleep(40 * (attempt + 1) + Math.floor(Math.random() * 30));
            }
        }
        throw lastErr;
    }

    _computeCustomerDueDate(customer, currentDate) {
        const renewalType = customer.renewal_type || 'renewal';
        const lastDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
        if (renewalType === 'fix_date') {
            const fixDate = customer.fix_date || customer.billing_day || 15;
            const targetDay = Math.min(parseInt(fixDate, 10) || 15, 28);
            const finalDay = Math.min(targetDay, lastDayOfMonth);
            return new Date(currentDate.getFullYear(), currentDate.getMonth(), finalDay);
        }
        const billingDay = (() => {
            const v = parseInt(customer.billing_day, 10);
            if (Number.isFinite(v)) return Math.min(Math.max(v, 1), 28);
            return 15;
        })();
        const targetDay = Math.min(billingDay, lastDayOfMonth);
        return new Date(currentDate.getFullYear(), currentDate.getMonth(), targetDay);
    }

    /**
     * Generate invoice bulan ini untuk pelanggan/member aktif tenant saat ini yang belum punya invoice.
     * WAJIB dijalankan di dalam runWithTenant / forEachOperationalTenant.
     * @param {object} options
     * @param {boolean} options.skipNotifications — tidak kirim email per invoice (bulk)
     * @param {function} options.onProgress — ({ processed, total, created, skipped, failed, phase })
     */
    async generateMonthlyInvoices(options = {}) {
        const { hasTenantContext, getTenantId } = require('./platform/tenantContext');
        if (!hasTenantContext()) {
            throw new Error(
                'generateMonthlyInvoices membutuhkan konteks tenant — gunakan forEachOperationalTenant / runWithTenant'
            );
        }
        const tenantId = getTenantId();
        if (!this._tryAcquireTenantInvoiceLock(tenantId)) {
            throw new Error(
                `Generate tagihan tenant #${tenantId} sedang berjalan — cegah tagihan dobel, coba lagi nanti`
            );
        }
        const { skipNotifications = false, onProgress } = options;
        const stats = {
            tenant_id: tenantId,
            customers_total: 0,
            customers_created: 0,
            customers_skipped: 0,
            customers_failed: 0,
            members_created: 0,
            members_skipped: 0,
            members_failed: 0,
            created: 0,
            skipped: 0,
            failed: 0
        };

        try {
            const activeCustomers = await billingManager.getActiveCustomersForInvoiceGeneration();
            stats.customers_total = activeCustomers.length;
            logger.info(
                `[auto-invoice] tenant #${tenantId}: ${activeCustomers.length} active customers for invoice generation`
            );

            const currentDate = new Date();
            const monthRange = currentLocalMonthDateRange(currentDate);
            const startOfMonth = monthRange.startStr;
            const endOfMonth = monthRange.endStr;

            const [packageById, customersWithInvoiceThisMonth] = await Promise.all([
                billingManager.getAllPackagesByIdMap(),
                billingManager.getDistinctCustomerIdsWithInvoicesBetween(startOfMonth, endOfMonth)
            ]);

            const monthLabel = currentDate.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
            let processed = 0;
            const report = () => {
                if (typeof onProgress === 'function') {
                    onProgress({
                        phase: 'customers',
                        processed,
                        total: activeCustomers.length,
                        created: stats.created,
                        skipped: stats.skipped,
                        failed: stats.failed
                    });
                }
            };
            report();

            for (const customer of activeCustomers) {
                processed++;
                try {
                    // Defense-in-depth: jangan buat invoice untuk pelanggan tenant lain
                    if (customer.tenant_id != null && Number(customer.tenant_id) !== Number(tenantId)) {
                        stats.customers_skipped++;
                        stats.skipped++;
                        logger.warn(
                            `[auto-invoice] skip customer #${customer.id} — tenant_id=${customer.tenant_id} != context ${tenantId}`
                        );
                        continue;
                    }

                    const packageData = packageById.get(customer.package_id);
                    if (!packageData) {
                        stats.customers_failed++;
                        stats.failed++;
                        continue;
                    }

                    // Paket GRATIS / harga 0 — tidak dibuatkan invoice
                    if (!billingManager.isBillablePackage(packageData)) {
                        stats.customers_skipped++;
                        stats.skipped++;
                        if (processed % 50 === 0) report();
                        continue;
                    }

                    if (customersWithInvoiceThisMonth.has(customer.id)) {
                        stats.customers_skipped++;
                        stats.skipped++;
                        if (processed % 50 === 0) report();
                        continue;
                    }

                    // Cek ulang ke DB (race / generate ulang)
                    const already = await billingManager.customerHasMonthlyInvoiceInMonth(
                        customer.id,
                        monthRange.year,
                        monthRange.month
                    );
                    if (already) {
                        customersWithInvoiceThisMonth.add(customer.id);
                        stats.customers_skipped++;
                        stats.skipped++;
                        continue;
                    }

                    const dueDate = this._computeCustomerDueDate(customer, currentDate);
                    const basePrice = packageData.price;
                    const taxRate = billingManager.resolvePackageTaxRate(packageData);
                    const amountWithTax = billingManager.calculatePriceWithTax(basePrice, taxRate);
                    const renewalType = customer.renewal_type || 'renewal';

                    const newInvoice = await this._createInvoiceWithRetry({
                        customer_id: customer.id,
                        package_id: customer.package_id,
                        amount: amountWithTax,
                        base_amount: basePrice,
                        tax_rate: taxRate,
                        due_date: toLocalDateString(dueDate),
                        notes: `Tagihan bulanan ${monthLabel} - ${renewalType === 'fix_date' ? 'Fix Date' : 'Renewal'} type`,
                        invoice_type: 'monthly',
                        package_name: packageData.name,
                        tenant_id: tenantId
                    });

                    customersWithInvoiceThisMonth.add(customer.id);
                    stats.customers_created++;
                    stats.created++;
                    if (!skipNotifications) {
                        this._enqueueCustomerInvoiceNotifications(customer.id, newInvoice.id);
                    }
                } catch (error) {
                    stats.customers_failed++;
                    stats.failed++;
                    logger.error(`Error creating invoice for customer ${customer.username}:`, error);
                }
                if (processed % 25 === 0) {
                    await this._sleep(15);
                }
                if (processed % 50 === 0 || processed === activeCustomers.length) report();
            }

            const memberStats = await this.generateMonthlyInvoicesForMembers({
                skipNotifications
            });

            stats.members_created = memberStats.members_created;
            stats.members_skipped = memberStats.members_skipped;
            stats.members_failed = memberStats.members_failed;
            stats.created = stats.customers_created + stats.members_created;
            stats.skipped = stats.customers_skipped + stats.members_skipped;
            stats.failed = stats.customers_failed + stats.members_failed;

            logger.info(
                `[auto-invoice] tenant #${tenantId} done: created=${stats.created}, skipped=${stats.skipped}, failed=${stats.failed}`
            );
            return stats;
        } catch (error) {
            logger.error(`Error in generateMonthlyInvoices (tenant #${tenantId}):`, error);
            throw error;
        } finally {
            this._releaseTenantInvoiceLock(tenantId);
        }
    }

    async generateMonthlyInvoicesForMembers(options = {}) {
        const { skipNotifications = false } = options;
        const { hasTenantContext, getTenantId } = require('./platform/tenantContext');
        const tenantId = hasTenantContext() ? getTenantId() : null;
        const stats = {
            members_created: 0,
            members_skipped: 0,
            members_failed: 0
        };

        try {
            const members = await billingManager.getAllMembers({ status: 'active' });
            const activeMembers = members.filter((member) =>
                member.status === 'active' && member.package_id
            );

            logger.info(
                `[auto-invoice] tenant #${tenantId}: ${activeMembers.length} active members for invoice generation`
            );

            const currentDate = new Date();
            const monthRange = currentLocalMonthDateRange(currentDate);
            const startOfMonth = monthRange.startStr;
            const endOfMonth = monthRange.endStr;
            const monthLabel = currentDate.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });

            const [allMemberPackages, memberKeysWithInvoice] = await Promise.all([
                billingManager.getAllMemberPackages(false),
                billingManager.getMemberIdentityKeysWithInvoicesBetween(startOfMonth, endOfMonth)
            ]);
            const memberPackageById = new Map(allMemberPackages.map((p) => [p.id, p]));

            for (const member of activeMembers) {
                try {
                    if (
                        tenantId != null &&
                        member.tenant_id != null &&
                        Number(member.tenant_id) !== Number(tenantId)
                    ) {
                        stats.members_skipped++;
                        continue;
                    }

                    const packageData = memberPackageById.get(member.package_id);
                    if (!packageData) {
                        stats.members_failed++;
                        continue;
                    }

                    if (!billingManager.isBillablePackage(packageData)) {
                        stats.members_skipped++;
                        continue;
                    }

                    const memberUsername = member.hotspot_username || member.username;
                    if (!memberUsername) {
                        stats.members_failed++;
                        continue;
                    }

                    if (memberKeysWithInvoice.has(String(memberUsername).trim())) {
                        stats.members_skipped++;
                        continue;
                    }

                    const billingDay = (() => {
                        const v = parseInt(member.billing_day, 10);
                        if (Number.isFinite(v)) return Math.min(Math.max(v, 1), 28);
                        return 15;
                    })();
                    const lastDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
                    const targetDay = Math.min(billingDay, lastDayOfMonth);
                    const dueDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), targetDay);

                    const basePrice = packageData.price;
                    const taxRate = billingManager.resolvePackageTaxRate(packageData);
                    const amountWithTax = billingManager.calculatePriceWithTax(basePrice, taxRate);

                    const newInvoice = await this._createInvoiceWithRetry({
                        member_id: member.id,
                        package_id: member.package_id,
                        amount: amountWithTax,
                        base_amount: basePrice,
                        tax_rate: taxRate,
                        due_date: toLocalDateString(dueDate),
                        notes: `Tagihan bulanan member ${monthLabel}`,
                        invoice_type: 'monthly',
                        package_name: packageData.name,
                        description: `Tagihan paket ${packageData.name}`,
                        tenant_id: tenantId
                    });

                    memberKeysWithInvoice.add(String(memberUsername).trim());
                    stats.members_created++;
                    if (!skipNotifications) {
                        this._enqueueMemberInvoiceNotifications(member.id, newInvoice.id);
                    }
                } catch (error) {
                    stats.members_failed++;
                    logger.error(`Error creating invoice for member ${member.hotspot_username || member.name}:`, error);
                }
            }

            return stats;
        } catch (error) {
            logger.error('Error in generateMonthlyInvoicesForMembers:', error);
            throw error;
        }
    }

    // Generate invoices daily for customers whose billing_day is today
    async generateDailyInvoicesByBillingDay() {
        try {
            const { hasTenantContext, getTenantId } = require('./platform/tenantContext');
            if (!hasTenantContext()) {
                throw new Error(
                    'generateDailyInvoicesByBillingDay membutuhkan konteks tenant — gunakan forEachOperationalTenant'
                );
            }
            const tenantId = getTenantId();
            // Get active customers of current tenant only
            const customers = await billingManager.getCustomers();
            const activeCustomers = customers.filter(customer => 
                customer.status === 'active' && customer.package_id
            );

            const today = new Date();
            const todayDay = today.getDate();
            const currentYear = today.getFullYear();
            const currentMonth = today.getMonth();

            // Compute start and end of current month for duplicate checks (kalender lokal)
            const monthRange = currentLocalMonthDateRange(today);
            const startOfMonth = new Date(currentYear, currentMonth, 1);
            const endOfMonth = new Date(currentYear, currentMonth + 1, 0, 23, 59, 59, 999);

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
                    if (!billingManager.isBillablePackage(packageData)) {
                        continue;
                    }

                    // Check if invoice already exists for this month
                    if (await billingManager.customerHasMonthlyInvoiceInMonth(customer.id, monthRange.year, monthRange.month)) {
                        logger.info(`Invoice already exists for customer ${customer.username} this month (daily generator)`);
                        continue;
                    }
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
                    const dueDate = toLocalDateString(new Date(currentYear, currentMonth, normalizedBillingDay));

                    // Calculate amount with tax
                    const basePrice = packageData.price;
                    const taxRate = billingManager.resolvePackageTaxRate(packageData);
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

                    const newInvoice = await this._createInvoiceWithRetry(invoiceData);
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

    // Manual trigger — satu proses untuk semua pelanggan (tanpa notifikasi email per baris)
    async triggerMonthlyInvoices(options = {}) {
        try {
            logger.info('Triggering monthly invoice generation manually...');
            const stats = await this.generateMonthlyInvoices({
                skipNotifications: options.skipNotifications !== false,
                onProgress: options.onProgress
            });
            logger.info('Manual monthly invoice generation completed', stats);
            return {
                success: true,
                message: 'Monthly invoices generated successfully',
                stats
            };
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