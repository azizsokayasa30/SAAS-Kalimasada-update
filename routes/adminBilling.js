const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const billingManager = require('../config/billing');
const logger = require('../config/logger');
const { syncCustomerToRadius } = require('../utils/radiusCustomerSync');
const serviceSuspension = require('../config/serviceSuspension');
const { getSetting, getSettingsWithCache, setSetting, clearSettingsCache } = require('../config/settingsManager');
const { getPaymentGatewayConfig, setActivePaymentGateway, updatePaymentGatewayConfig: updatePaymentGatewayConfigStore } = require('../config/paymentGatewayConfig');
const { exec } = require('child_process');
const multer = require('multer');
const upload = multer();
const ExcelJS = require('exceljs');
const { adminAuth } = require('./adminAuth');
const { adminBillingActivityMiddleware } = require('../config/activityLogger');

router.use(adminBillingActivityMiddleware);

/** Password konfirmasi aksi sensitif: `super_admin_password` di settings jika diisi, else `admin_password`. */
function verifySuperAdminPassword(plain) {
    const dedicated = String(getSetting('super_admin_password', '') || '').trim();
    const expected =
        dedicated.length > 0 ? dedicated : String(getSetting('admin_password', 'admin'));
    const a = Buffer.from(String(plain ?? ''), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(a, b);
    } catch (_) {
        return false;
    }
}

// Configure multer for image uploads
const imageStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, '../public/img/'));
    },
    filename: function (req, file, cb) {
        // Generate unique filename with timestamp
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'package-' + uniqueSuffix + '.jpg');
    }
});

const imageUpload = multer({ 
    storage: imageStorage,
    limits: {
        fileSize: 2 * 1024 * 1024 // 2MB limit
    },
    fileFilter: function (req, file, cb) {
        // Accept only JPG files
        if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg') {
            cb(null, true);
        } else {
            cb(new Error('Only JPG files are allowed'));
        }
    }
});

// Configure multer for customer photo uploads
const customerPhotoStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, '../public/img/'));
    },
    filename: function (req, file, cb) {
        const phone = req.body.phone || req.params.phone || 'unknown';
        const type = file.fieldname === 'ktp_photo' ? 'ktp' : 'house';
        const ext = path.extname(file.originalname) || '.jpg';
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `customer-${phone}-${type}-${uniqueSuffix}${ext}`);
    }
});

const customerPhotoUpload = multer({ 
    storage: customerPhotoStorage,
    limits: {
        fileSize: 20 * 1024 * 1024 // 20MB limit
    },
    fileFilter: function (req, file, cb) {
        // Accept only image files
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Hanya file gambar yang diizinkan (JPG, PNG, GIF)'));
        }
    }
});

// Ensure JSON body parsing for this router
router.use(express.json());
// Enable form submissions (application/x-www-form-urlencoded)
router.use(express.urlencoded({ extended: true }));

// One-time bypass import mode:
// - Active by default for the next single customer import request
// - After consumed once, automatically returns to normal import rules
let oneTimeImportBypassRemaining = 1;
const consumeOneTimeImportBypass = () => {
    if (oneTimeImportBypassRemaining > 0) {
        oneTimeImportBypassRemaining -= 1;
        return true;
    }
    return false;
};

// Helper: validate optional base URL (allow empty, otherwise must start with http/https)
const isValidOptionalHttpUrl = (v) => {
    const s = String(v ?? '').trim();
    if (!s) return true;
    return /^https?:\/\//i.test(s);
};

/** True jika paket punya profil PPPoE/RADIUS (kolom pppoe_profile terisi). Paket billing-only menyimpan NULL di kolom ini. */
function packageUsesPPPoEProfile(pkg) {
    if (!pkg || pkg.pppoe_profile == null) return false;
    return String(pkg.pppoe_profile).trim() !== '';
}

/** Gabungan profil dari form + definisi paket; paket non-PPPoE menghasilkan null (bukan string 'default'). */
function resolveCustomerPppoeProfile(explicitProfile, packageRow, fallbackCustomerProfile) {
    const ex = explicitProfile != null ? String(explicitProfile).trim() : '';
    if (ex) return ex;
    if (packageRow && packageUsesPPPoEProfile(packageRow)) {
        return String(packageRow.pppoe_profile).trim();
    }
    const fb = fallbackCustomerProfile != null ? String(fallbackCustomerProfile).trim() : '';
    return fb || null;
}

/** Impor pelanggan: normalisasi join_date ke YYYY-MM-DD. Mendukung dd-mm-yy, serial Excel, tanggal JS, dan dd-MonthName-yyyy (mis. 01-October-2024). */
function parseCustomerImportJoinDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date && !isNaN(value.getTime())) {
        return value.toISOString().slice(0, 10);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        const jsDate = new Date(Math.round((value - 25569) * 86400 * 1000));
        return isNaN(jsDate.getTime()) ? null : jsDate.toISOString().slice(0, 10);
    }
    const asString = String(value).trim();
    if (!asString) return null;

    // e.g. 01-October-2024, 1-Oct-2024 (English month; case-insensitive)
    const dMonthYear = asString.match(/^(\d{1,2})-([A-Za-z]+)-(\d{4})$/);
    if (dMonthYear) {
        const day = parseInt(dMonthYear[1], 10);
        const monthKey = dMonthYear[2].toLowerCase();
        const year = parseInt(dMonthYear[3], 10);
        const MONTHS = {
            january: 1,
            february: 2,
            march: 3,
            april: 4,
            may: 5,
            june: 6,
            july: 7,
            august: 8,
            september: 9,
            october: 10,
            november: 11,
            december: 12,
            jan: 1,
            feb: 2,
            mar: 3,
            apr: 4,
            jun: 6,
            jul: 7,
            aug: 8,
            sep: 9,
            oct: 10,
            nov: 11,
            dec: 12
        };
        const month = MONTHS[monthKey];
        if (month && year >= 1900 && year <= 2100 && day >= 1 && day <= 31) {
            const parsed = new Date(Date.UTC(year, month - 1, day));
            if (
                !isNaN(parsed.getTime()) &&
                parsed.getUTCFullYear() === year &&
                parsed.getUTCMonth() === month - 1 &&
                parsed.getUTCDate() === day
            ) {
                return `${year.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            }
        }
        return null;
    }

    const ddmmyyyySlash = asString.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (ddmmyyyySlash) {
        const day = parseInt(ddmmyyyySlash[1], 10);
        const month = parseInt(ddmmyyyySlash[2], 10);
        const year = parseInt(ddmmyyyySlash[3], 10);
        const parsedSlash = new Date(Date.UTC(year, month - 1, day));
        if (
            !isNaN(parsedSlash.getTime()) &&
            parsedSlash.getUTCFullYear() === year &&
            parsedSlash.getUTCMonth() === month - 1 &&
            parsedSlash.getUTCDate() === day
        ) {
            return `${year.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
    }

    const ddmmyy = asString.match(/^(\d{2})-(\d{2})-(\d{2})$/);
    if (ddmmyy) {
        const day = parseInt(ddmmyy[1], 10);
        const month = parseInt(ddmmyy[2], 10);
        const yy = parseInt(ddmmyy[3], 10);
        const fullYear = yy >= 70 ? (1900 + yy) : (2000 + yy);
        const parsedDdmmyy = new Date(Date.UTC(fullYear, month - 1, day));
        if (
            !isNaN(parsedDdmmyy.getTime()) &&
            parsedDdmmyy.getUTCFullYear() === fullYear &&
            parsedDdmmyy.getUTCMonth() === month - 1 &&
            parsedDdmmyy.getUTCDate() === day
        ) {
            return `${fullYear.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
    }

    const parsed = new Date(asString);
    if (!isNaN(parsed.getTime())) {
        return parsed.toISOString().slice(0, 10);
    }
    return null;
}

/** Tolak tanggal join dari Excel yang di masa depan (sering salah parse billing_day/fix date). */
function sanitizeImportJoinDate(value) {
    const parsed = parseCustomerImportJoinDate(value);
    if (!parsed) return null;
    const today = new Date().toISOString().slice(0, 10);
    return parsed > today ? null : parsed;
}

/** Simpan join_date/created_at ke format DB (WIB). */
function formatCustomerJoinDateStored(isoYmd) {
    if (isoYmd && /^\d{4}-\d{2}-\d{2}$/.test(String(isoYmd).slice(0, 10))) {
        return `${String(isoYmd).slice(0, 10)}T12:00:00+07:00`;
    }
    const { getLocalTimestamp } = require('../config/settingsManager');
    const ts = getLocalTimestamp();
    return `${String(ts).replace(/ /, 'T')}+07:00`;
}

function resolveImportJoinDate(getVal, row) {
    const joinRaw = getVal(row, 'join_date');
    const createdRaw = getVal(row, 'created_at');
    const preferred = (joinRaw !== '' && joinRaw != null) ? joinRaw : createdRaw;
    return sanitizeImportJoinDate(preferred);
}

async function applyCustomerJoinAndCreatedDates(db, customerId, isoJoinDate) {
    if (!customerId || !isoJoinDate) return;
    const stored = formatCustomerJoinDateStored(isoJoinDate);
    await new Promise((resolve, reject) => {
        db.run(
            `UPDATE customers SET join_date = ?, created_at = ? WHERE id = ?`,
            [stored, stored, customerId],
            (err) => (err ? reject(err) : resolve())
        );
    });
}

// Ensure import can accept duplicate phone numbers by removing UNIQUE constraint on customers.phone.
// This migration is idempotent and only runs when the table definition still enforces UNIQUE(phone).
const ensureCustomersPhoneNonUnique = async (db) => {
    const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
    const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve(this);
        });
    });

    const tableInfo = await dbGet(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customers'`
    );
    const currentSql = String((tableInfo && tableInfo.sql) || '');
    if (!/phone\s+TEXT\s+UNIQUE\s+NOT\s+NULL/i.test(currentSql)) return;

    const migratedSql = currentSql.replace(
        /phone\s+TEXT\s+UNIQUE\s+NOT\s+NULL/i,
        'phone TEXT NOT NULL'
    );
    if (migratedSql === currentSql) return;

    await dbRun('BEGIN IMMEDIATE');
    try {
        await dbRun('PRAGMA foreign_keys = OFF');
        await dbRun(`ALTER TABLE customers RENAME TO customers_backup_phone_unique_mig`);
        await dbRun(migratedSql);

        const cols = await new Promise((resolve, reject) => {
            db.all(`PRAGMA table_info(customers_backup_phone_unique_mig)`, [], (err, rows) => {
                if (err) return reject(err);
                resolve((rows || []).map((r) => r.name).filter(Boolean));
            });
        });
        const colList = cols.map((c) => `"${c}"`).join(', ');
        await dbRun(`INSERT INTO customers (${colList}) SELECT ${colList} FROM customers_backup_phone_unique_mig`);
        await dbRun(`DROP TABLE customers_backup_phone_unique_mig`);
        await dbRun('PRAGMA foreign_keys = ON');
        await dbRun('COMMIT');
        logger.warn('[IMPORT] Migrasi customers.phone UNIQUE -> non-UNIQUE selesai');
    } catch (err) {
        try { await dbRun('ROLLBACK'); } catch (_) {}
        throw err;
    }
};

// Helper: resolve period from month/year (fallback ke current month)
const resolveMonthYearRange = (query = {}) => {
    const now = new Date();
    const parsedMonth = parseInt(query.month, 10);
    const parsedYear = parseInt(query.year, 10);
    const month = Number.isInteger(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12 ? parsedMonth : (now.getMonth() + 1);
    const year = Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100 ? parsedYear : now.getFullYear();
    const startDate = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];
    return { month, year, startDate, endDate };
};

// Middleware untuk mendapatkan pengaturan aplikasi
const getAppSettings = (req, res, next) => {
    req.appSettings = {
        companyHeader: getSetting('company_header', 'ISP Monitor'),
        footerInfo: getSetting('footer_info', ''),
        logoFilename: getSetting('logo_filename', 'logo.png'),
        company_slogan: getSetting('company_slogan', ''),
        company_website: getSetting('company_website', ''),
        invoice_notes: getSetting('invoice_notes', ''),
        payment_bank_name: getSetting('payment_bank_name', ''),
        payment_account_number: getSetting('payment_account_number', ''),
        payment_account_holder: getSetting('payment_account_holder', ''),
        payment_cash_address: getSetting('payment_cash_address', ''),
        payment_cash_hours: getSetting('payment_cash_hours', ''),
        contact_phone: getSetting('contact_phone', ''),
        contact_email: getSetting('contact_email', ''),
        contact_address: getSetting('contact_address', ''),
        contact_whatsapp: getSetting('contact_whatsapp', ''),
        suspension_grace_period_days: getSetting('suspension_grace_period_days', '3'),
        isolir_profile: getSetting('isolir_profile', 'isolir')
    };
    next();
};

// Mobile Admin Billing Dashboard
router.get('/mobile', getAppSettings, async (req, res) => {
    try {
        // Get basic stats for mobile dashboard
        const totalCustomers = await billingManager.getTotalCustomers();
        const totalInvoices = await billingManager.getTotalInvoices();
        const totalRevenue = await billingManager.getTotalRevenue();
        const pendingPayments = await billingManager.getPendingPayments();
        
        // Redirect to responsive desktop dashboard
        res.redirect('/admin/billing/dashboard');
    } catch (error) {
        logger.error('Error loading mobile billing dashboard:', error);
        res.status(500).render('error', { 
            message: 'Error loading mobile billing dashboard',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// Mobile Customers Management
// Mobile Customers - Redirect to responsive desktop version
router.get('/mobile/customers', getAppSettings, async (req, res) => {
    try {
        // Redirect to responsive desktop version
        res.redirect('/admin/billing/customers');
    } catch (error) {
        logger.error('Error loading mobile customers:', error);
        res.status(500).render('error', { 
            message: 'Error loading mobile customers',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// Mobile Invoices - Redirect to responsive desktop version
router.get('/mobile/invoices', getAppSettings, async (req, res) => {
    try {
        // Redirect to responsive desktop version
        res.redirect('/admin/billing/invoices');
    } catch (error) {
        logger.error('Error loading mobile invoices:', error);
        res.status(500).render('error', { 
            message: 'Error loading mobile invoices',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// Mobile Payments - Redirect to responsive desktop version
router.get('/mobile/payments', getAppSettings, async (req, res) => {
    try {
        // Redirect to responsive desktop version
        res.redirect('/admin/billing/payments');
    } catch (error) {
        logger.error('Error loading mobile payments:', error);
        res.status(500).render('error', { 
            message: 'Error loading mobile payments',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// Monthly Reset Management
router.post('/api/monthly-reset', adminAuth, async (req, res) => {
    try {
        console.log('🔄 Manual monthly reset requested...');
        
        const MonthlyResetSystem = require('../scripts/monthly-reset-simple');
        const resetSystem = new MonthlyResetSystem();
        
        const result = await resetSystem.runMonthlyReset();
        
        res.json({
            success: true,
            message: 'Monthly reset completed successfully',
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error in manual monthly reset:', error);
        res.status(500).json({
            success: false,
            message: 'Error in monthly reset: ' + error.message
        });
    }
});

// Get monthly reset status
router.get('/api/monthly-reset-status', adminAuth, async (req, res) => {
    try {
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Get last reset date
        const lastReset = await new Promise((resolve, reject) => {
            db.get(`
                SELECT value FROM system_settings 
                WHERE key = 'monthly_reset_date'
            `, (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.value : null);
            });
        });
        
        // Get current month stats
        const currentStats = await new Promise((resolve, reject) => {
            const MonthlyResetSystem = require('../scripts/monthly-reset-simple');
            const resetSystem = new MonthlyResetSystem();
            resetSystem.getCurrentStatistics()
                .then(stats => resolve(stats))
                .catch(err => reject(err));
        });
        
        db.close();
        
        res.json({
            success: true,
            data: {
                lastReset: lastReset,
                currentStats: currentStats,
                nextReset: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error getting monthly reset status:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting reset status: ' + error.message
        });
    }
});

// Mobile Collector Management
router.get('/mobile/collector', getAppSettings, async (req, res) => {
    try {
        // Get collectors list for mobile
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Get collectors with statistics - dengan validasi data
        const collectors = await new Promise((resolve, reject) => {
            db.all(`
                SELECT c.*, 
                       COUNT(cp.id) as total_payments,
                       COALESCE(SUM(cp.payment_amount), 0) as total_collected,
                       COALESCE(SUM(cp.commission_amount), 0) as total_commission
                FROM collectors c
                LEFT JOIN collector_payments cp ON c.id = cp.collector_id 
                    AND cp.status = 'completed'
                GROUP BY c.id
                ORDER BY c.name
            `, (err, rows) => {
                if (err) reject(err);
                else {
                    // Validasi dan format data collectors
                    const validCollectors = (rows || []).map(row => ({
                        ...row,
                        commission_rate: Math.max(0, Math.min(100, parseFloat(row.commission_rate !== null && row.commission_rate !== undefined ? row.commission_rate : 5))),
                        total_payments: parseInt(row.total_payments || 0),
                        total_collected: Math.round(parseFloat(row.total_collected || 0)),
                        total_commission: Math.round(parseFloat(row.total_commission || 0)),
                        name: row.name || 'Unknown Collector',
                        status: row.status || 'active'
                    }));
                    resolve(validCollectors);
                }
            });
        });
        
        // Calculate statistics
        const today = new Date();
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
        
        const todayPayments = await new Promise((resolve, reject) => {
            db.get(`
                SELECT COALESCE(SUM(payment_amount), 0) as total
                FROM collector_payments 
                WHERE collected_at >= ? AND collected_at < ? AND status = 'completed'
            `, [startOfDay.toISOString(), endOfDay.toISOString()], (err, row) => {
                if (err) reject(err);
                else resolve(Math.round(parseFloat(row ? row.total : 0))); // Rounding untuk konsistensi
            });
        });
        
        const totalCollectors = collectors.length;
        
        db.close();
        
        res.render('admin/billing/mobile-collector', {
            title: 'Tukang Tagih - Mobile',
            appSettings: req.appSettings,
            collectors: collectors,
            statistics: {
                totalCollectors: totalCollectors,
                todayPayments: todayPayments
            }
        });
    } catch (error) {
        logger.error('Error loading mobile collectors:', error);
        res.status(500).render('error', { 
            message: 'Error loading mobile collectors',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// API: Get customer invoices for collector payment
router.get('/api/customer-invoices/:customerId', adminAuth, async (req, res) => {
    try {
        const { customerId } = req.params;
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        const invoices = await new Promise((resolve, reject) => {
            db.all(`
                SELECT i.*, p.name as package_name
                FROM invoices i
                LEFT JOIN packages p ON i.package_id = p.id
                WHERE i.customer_id = ? AND i.status = 'unpaid'
                ORDER BY i.created_at DESC
            `, [customerId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        
        db.close();
        
        res.json({
            success: true,
            data: invoices
        });
        
    } catch (error) {
        console.error('Error getting customer invoices:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting customer invoices: ' + error.message
        });
    }
});

// API: Submit collector payment
router.post('/api/collector-payment', adminAuth, async (req, res) => {
    try {
        const { collector_id, customer_id, payment_amount, payment_method, notes, invoice_ids } = req.body;
        
        if (!collector_id || !customer_id || !payment_amount) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }
        
        // Validasi jumlah pembayaran
        const paymentAmountNum = Number(payment_amount);
        if (paymentAmountNum <= 0 || paymentAmountNum > 999999999) {
            return res.status(400).json({
                success: false,
                message: 'Jumlah pembayaran tidak valid (harus > 0 dan < 999,999,999)'
            });
        }
        
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Mulai transaction untuk operasi kompleks
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        try {
            // Get collector commission rate
        const collector = await new Promise((resolve, reject) => {
            db.get('SELECT commission_rate FROM collectors WHERE id = ?', [collector_id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        if (!collector) {
            return res.status(400).json({
                success: false,
                message: 'Collector not found'
            });
        }
        
        const commissionRate = collector.commission_rate !== null && collector.commission_rate !== undefined ? collector.commission_rate : 5;
        
        // Validasi commission rate
        if (commissionRate < 0 || commissionRate > 100) {
            return res.status(400).json({
                success: false,
                message: 'Rate komisi tidak valid (harus antara 0-100%)'
            });
        }
        
        const commissionAmount = Math.round((paymentAmountNum * commissionRate) / 100); // Rounding untuk komisi
        
        // Insert collector payment (ensure legacy 'amount' column is populated)
        const paymentId = await new Promise((resolve, reject) => {
            db.run(`
                INSERT INTO collector_payments (
                    collector_id, customer_id, amount, payment_amount, commission_amount,
                    payment_method, notes, status, collected_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', datetime('now','localtime'))
            `, [collector_id, customer_id, paymentAmountNum, paymentAmountNum, commissionAmount, payment_method, notes], function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            });
        });
        
        // Update invoices if specified, else auto-allocate to oldest unpaid invoices
        if (invoice_ids && invoice_ids.length > 0) {
            for (const invoiceId of invoice_ids) {
                // Tandai invoice lunas
                await billingManager.updateInvoiceStatus(Number(invoiceId), 'paid', payment_method);
                // Catat entri payment sesuai nilai invoice dengan collector info
                const inv = await billingManager.getInvoiceById(Number(invoiceId));
                const invAmount = parseFloat(inv?.amount || 0) || 0;
                await billingManager.recordCollectorPayment({
                    invoice_id: Number(invoiceId),
                    amount: invAmount,
                    payment_method,
                    reference_number: '',
                    notes: notes && String(notes).trim() ? String(notes).trim() : '',
                    collector_id: collector_id,
                    commission_amount: Math.round((invAmount * commissionRate) / 100)
                });
            }
        } else {
            // Auto allocate payment to unpaid invoices (oldest first)
            let remaining = Number(payment_amount) || 0;
            if (remaining > 0) {
                const unpaidInvoices = await new Promise((resolve, reject) => {
                    db.all(`
                        SELECT id, amount FROM invoices 
                        WHERE customer_id = ? AND status = 'unpaid'
                        ORDER BY due_date ASC, id ASC
                    `, [customer_id], (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows || []);
                    });
                });
                for (const inv of unpaidInvoices) {
                    const invAmount = Number(inv.amount) || 0;
                    if (remaining >= invAmount && invAmount > 0) {
                        await billingManager.updateInvoiceStatus(inv.id, 'paid', payment_method);
                        await billingManager.recordCollectorPayment({
                            invoice_id: inv.id,
                            amount: invAmount,
                            payment_method,
                            reference_number: '',
                            notes: notes && String(notes).trim() ? String(notes).trim() : '',
                            collector_id: collector_id,
                            commission_amount: Math.round((invAmount * commissionRate) / 100)
                        });
                        remaining -= invAmount;
                        if (remaining <= 0) break;
                    } else {
                        break; // skip partial for now
                    }
                }
            }
        }
        
            // Commit transaction jika semua operasi berhasil
            await new Promise((resolve, reject) => {
                db.run('COMMIT', (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            
        } catch (error) {
            // Rollback transaction jika ada error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw error;
        } finally {
            db.close();
        }

        setImmediate(() => {
            (async () => {
                try {
                    const cfn = require('../config/collectorFieldNotifications');
                    const cust = await billingManager.getCustomerById(Number(customer_id));
                    await cfn.notifyAdminRecordedCollectorPayment(
                        Number(collector_id),
                        paymentId,
                        cust && cust.name ? String(cust.name) : '',
                        paymentAmountNum
                    );
                } catch (e) {
                    try {
                        logger.warn('[admin collector-payment] collector notify:', e.message);
                    } catch (_) {}
                }
            })();
        });

        res.json({
            success: true,
            message: 'Payment recorded successfully',
            payment_id: paymentId,
            commission_amount: commissionAmount
        });
        
    } catch (error) {
        console.error('Error recording collector payment:', error);
        res.status(500).json({
            success: false,
            message: 'Error recording payment: ' + error.message
        });
    }
});

// Mobile Collector Payment Input
router.get('/mobile/collector/payment', getAppSettings, async (req, res) => {
    try {
        // Get collectors and customers for payment form
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        const [collectors, customers] = await Promise.all([
            new Promise((resolve, reject) => {
                db.all('SELECT * FROM collectors WHERE status = "active" ORDER BY name', (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                });
            }),
            new Promise((resolve, reject) => {
                db.all('SELECT * FROM customers WHERE status = "active" ORDER BY name', (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                });
            })
        ]);
        
        db.close();
        
        res.render('admin/billing/mobile-collector-payment', {
            title: 'Input Pembayaran - Mobile',
            appSettings: req.appSettings,
            collectors: collectors,
            customers: customers
        });
    } catch (error) {
        logger.error('Error loading collector payment form:', error);
        res.status(500).render('error', { 
            message: 'Error loading payment form',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// Collector Reports
router.get('/collector-reports', getAppSettings, async (req, res) => {
    try {
        const { collector, month, year } = req.query;
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Check if collectors table exists
        const tableExists = await new Promise((resolve, reject) => {
            db.get(`
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name='collectors'
            `, (err, row) => {
                if (err) reject(err);
                else resolve(!!row);
            });
        });
        
        const currentYear = new Date().getFullYear();
        const currentMonth = new Date().getMonth() + 1;
        const filterYear = parseInt(year) || currentYear;
        const filterMonth = parseInt(month) || currentMonth;
        
        const startDate = `${filterYear}-${String(filterMonth).padStart(2, '0')}-01`;
        const endDate = new Date(filterYear, filterMonth, 0).toISOString().split('T')[0];
        
        if (!tableExists) {
            db.close();
            return res.render('admin/billing/collector-reports', {
                title: 'Laporan Kolektor',
                appSettings: req.appSettings,
                collectors: [],
                summary: {
                    total_tagihan: 0,
                    total_lunas: 0,
                    total_belum_lunas: 0,
                    total_komisi: 0
                },
                filters: {
                    month: filterMonth,
                    year: filterYear,
                    collector: collector || ''
                },
                error: 'Tabel kolektor belum tersedia. Silakan tambahkan kolektor terlebih dahulu.'
            });
        }
        
        // Build date filter
        const dateFilter = `AND cp.collected_at >= '${startDate}' AND cp.collected_at <= '${endDate} 23:59:59'`;
        
        // Build collector filter
        const collectorFilter = collector ? `AND c.id = ${collector}` : '';
        
        // Get collectors with statistics based on mapped areas
        const collectors = await new Promise((resolve, reject) => {
            const sql = `
                SELECT c.*, 
                       (
                           SELECT COALESCE(SUM(i.amount), 0)
                           FROM invoices i
                           JOIN customers cust ON i.customer_id = cust.id
                           JOIN collector_areas ca ON cust.area = ca.area
                           WHERE ca.collector_id = c.id 
                           AND DATE(i.created_at) >= '${startDate}' AND DATE(i.created_at) <= '${endDate}'
                       ) as total_tagihan_area,
                       (
                           SELECT COALESCE(SUM(i.amount), 0)
                           FROM invoices i
                           JOIN customers cust ON i.customer_id = cust.id
                           JOIN collector_areas ca ON cust.area = ca.area
                           WHERE ca.collector_id = c.id 
                           AND i.status = 'paid'
                           AND DATE(i.created_at) >= '${startDate}' AND DATE(i.created_at) <= '${endDate}'
                       ) as total_lunas_area,
                       (
                           SELECT COALESCE(SUM(i.amount), 0)
                           FROM invoices i
                           JOIN customers cust ON i.customer_id = cust.id
                           JOIN collector_areas ca ON cust.area = ca.area
                           WHERE ca.collector_id = c.id 
                           AND i.status = 'unpaid'
                           AND DATE(i.created_at) >= '${startDate}' AND DATE(i.created_at) <= '${endDate}'
                       ) as total_belum_lunas_amount,
                       (
                           SELECT COUNT(i.id)
                           FROM invoices i
                           JOIN customers cust ON i.customer_id = cust.id
                           JOIN collector_areas ca ON cust.area = ca.area
                           WHERE ca.collector_id = c.id 
                           AND i.status = 'unpaid'
                           AND DATE(i.created_at) >= '${startDate}' AND DATE(i.created_at) <= '${endDate}'
                       ) as total_belum_lunas_count,
                       COALESCE(SUM(cp.payment_amount), 0) as total_payment_amount,
                       COALESCE(SUM(cp.commission_amount), 0) as total_commission
                FROM collectors c
                LEFT JOIN collector_payments cp ON c.id = cp.collector_id 
                    AND cp.status = 'completed'
                    ${dateFilter}
                WHERE c.status = 'active' ${collectorFilter}
                GROUP BY c.id
                ORDER BY c.name
            `;
            db.all(sql, (err, rows) => {
                if (err) {
                    console.error('Error in collectors query:', err);
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
        
        // Compute summary manually from the returned rows to perfectly match the cards
        let summary = {
            total_tagihan: 0,
            total_lunas: 0,
            total_belum_lunas: 0,
            total_komisi: 0
        };
        
        collectors.forEach(c => {
            summary.total_tagihan += (c.total_tagihan_area || 0);
            summary.total_lunas += (c.total_lunas_area || 0);
            summary.total_belum_lunas += (c.total_belum_lunas_amount || 0);
            summary.total_komisi += (c.total_commission || 0);
        });
        
        db.close();
        
        const settings = getSettingsWithCache();
        res.render('admin/billing/collector-reports', {
            title: 'Laporan Kolektor',
            appSettings: req.appSettings,
            collectors: collectors,
            summary: summary,
            filters: {
                month: filterMonth,
                year: filterYear,
                collector: collector || ''
            },
            settings: settings,
            page: 'collector-reports'
        });
        
    } catch (error) {
        logger.error('❌ Error loading collector reports:', error);
        if (error.stack) console.error(error.stack);

        res.status(500).render('error', { 
            message: 'Terjadi kesalahan saat memuat laporan kolektor. Pastikan tabel database sudah sinkron.',
            error: process.env.NODE_ENV === 'development' ? error : { 
                status: 500, 
                stack: 'Internal Server Error (Detail logged to server console)' 
            }
        });
    }
});

// Export Collector Reports to Excel
router.get('/collector-reports/export', getAppSettings, async (req, res) => {
    try {
        const { dateFrom, dateTo, collector } = req.query;
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        const now = new Date();
        const startDate = dateFrom || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const endDate = dateTo || new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
        
        let collectorFilter = '';
        const params = [startDate, endDate + ' 23:59:59'];
        
        if (collector) {
            collectorFilter = ' AND c.id = ?';
            params.push(collector);
        }

        const collectors = await new Promise((resolve, reject) => {
            db.all(`
                SELECT 
                    c.*,
                    COUNT(cp.id) as payment_count,
                    COALESCE(SUM(cp.payment_amount), 0) as total_payment,
                    COALESCE(SUM(cp.commission_amount), 0) as total_commission,
                    COALESCE(SUM(cp.payment_amount - cp.commission_amount), 0) as total_setoran
                FROM collectors c
                LEFT JOIN collector_payments cp ON c.id = cp.collector_id 
                    AND cp.status = 'completed'
                    AND cp.collected_at >= ? AND cp.collected_at <= ?
                WHERE c.status = 'active' ${collectorFilter}
                GROUP BY c.id
                ORDER BY c.name
            `, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        db.close();

        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Laporan Kolektor');

        worksheet.columns = [
            { header: 'Nama Kolektor', key: 'name', width: 25 },
            { header: 'Telepon', key: 'phone', width: 15 },
            { header: 'Email', key: 'email', width: 25 },
            { header: 'Jml Transaksi', key: 'payment_count', width: 15 },
            { header: 'Total Penagihan', key: 'total_payment', width: 20 },
            { header: 'Total Komisi', key: 'total_commission', width: 20 },
            { header: 'Total Setoran', key: 'total_setoran', width: 20 }
        ];

        collectors.forEach(c => {
            worksheet.addRow({
                name: c.name,
                phone: c.phone,
                email: c.email || '-',
                payment_count: c.payment_count,
                total_payment: c.total_payment,
                total_commission: c.total_commission,
                total_setoran: c.total_setoran
            });
        });

        worksheet.getColumn('total_payment').numFmt = '"Rp" #,##0.00';
        worksheet.getColumn('total_commission').numFmt = '"Rp" #,##0.00';
        worksheet.getColumn('total_setoran').numFmt = '"Rp" #,##0.00';

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=laporan-kolektor-${startDate}-to-${endDate}.xlsx`);
        
        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        logger.error('Error exporting collector reports:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Collector Details
router.get('/collector-details/:id', getAppSettings, async (req, res) => {
    try {
        const { id } = req.params;
        const { month, year } = req.query;
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        const currentYear = new Date().getFullYear();
        const currentMonth = new Date().getMonth() + 1;
        const filterYear = parseInt(year) || currentYear;
        const filterMonth = parseInt(month) || currentMonth;
        const isEmbed = req.query.embed === '1';
        
        const startDate = `${filterYear}-${String(filterMonth).padStart(2, '0')}-01`;
        const endDate = new Date(filterYear, filterMonth, 0).toISOString().split('T')[0];
        
        // Get collector details
        const collector = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM collectors WHERE id = ?', [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        if (!collector) {
            db.close();
            return res.status(404).render('error', { 
                message: 'Kolektor tidak ditemukan',
                error: {}
            });
        }
        
        // Get collector payments with date filter
        const payments = await new Promise((resolve, reject) => {
            db.all(`
                SELECT cp.*, c.name as customer_name, c.phone as customer_phone
                FROM collector_payments cp
                LEFT JOIN customers c ON cp.customer_id = c.id
                WHERE cp.collector_id = ? 
                AND cp.collected_at >= ? 
                AND cp.collected_at <= ?
                ORDER BY cp.collected_at DESC
            `, [id, startDate, endDate + ' 23:59:59'], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        
        // Get collector statistics based on mapped areas
        const stats = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 
                       (
                           SELECT COALESCE(SUM(i.amount), 0)
                           FROM invoices i
                           JOIN customers cust ON i.customer_id = cust.id
                           JOIN collector_areas ca ON cust.area = ca.area
                           WHERE ca.collector_id = ? 
                           AND DATE(i.created_at) >= ? AND DATE(i.created_at) <= ?
                       ) as total_tagihan_area,
                       (
                           SELECT COALESCE(SUM(i.amount), 0)
                           FROM invoices i
                           JOIN customers cust ON i.customer_id = cust.id
                           JOIN collector_areas ca ON cust.area = ca.area
                           WHERE ca.collector_id = ? 
                           AND i.status = 'paid'
                           AND DATE(i.created_at) >= ? AND DATE(i.created_at) <= ?
                       ) as total_lunas_area,
                       (
                           SELECT COALESCE(SUM(i.amount), 0)
                           FROM invoices i
                           JOIN customers cust ON i.customer_id = cust.id
                           JOIN collector_areas ca ON cust.area = ca.area
                           WHERE ca.collector_id = ? 
                           AND i.status = 'unpaid'
                           AND DATE(i.created_at) >= ? AND DATE(i.created_at) <= ?
                       ) as total_belum_lunas_amount,
                       (
                           SELECT COUNT(i.id)
                           FROM invoices i
                           JOIN customers cust ON i.customer_id = cust.id
                           JOIN collector_areas ca ON cust.area = ca.area
                           WHERE ca.collector_id = ? 
                           AND i.status = 'unpaid'
                           AND DATE(i.created_at) >= ? AND DATE(i.created_at) <= ?
                       ) as total_belum_lunas_count,
                       (
                           SELECT COALESCE(SUM(commission_amount), 0) 
                           FROM collector_payments 
                           WHERE collector_id = ? 
                           AND collected_at >= ? AND collected_at <= ? 
                           AND status = 'completed'
                       ) as total_komisi
            `, [
                id, startDate, endDate, 
                id, startDate, endDate,
                id, startDate, endDate,
                id, startDate, endDate,
                id, startDate, endDate + ' 23:59:59'
            ], (err, row) => {
                if (err) reject(err);
                else resolve(row || {
                    total_tagihan_area: 0,
                    total_lunas_area: 0,
                    total_belum_lunas_amount: 0,
                    total_belum_lunas_count: 0,
                    total_komisi: 0
                });
            });
        });
        
        db.close();
        
        const settings = getSettingsWithCache();
        res.render('admin/billing/collector-details', {
            title: `Detail Kolektor - ${collector.name}`,
            appSettings: req.appSettings,
            collector: collector,
            payments: payments,
            stats: stats,
            filters: {
                month: filterMonth,
                year: filterYear
            },
            settings: settings,
            page: 'collector-reports',
            embed: isEmbed
        });
        
    } catch (error) {
        logger.error('Error loading collector details:', error);
        res.status(500).render('error', { 
            message: 'Error loading collector details',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// Export Collector Details to Excel
router.get('/collector-details/:id/export', getAppSettings, async (req, res) => {
    try {
        const { id } = req.params;
        const { dateFrom, dateTo } = req.query;
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        const now = new Date();
        const startDate = dateFrom || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const endDate = dateTo || new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
        
        const collector = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM collectors WHERE id = ?', [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        if (!collector) {
            db.close();
            return res.status(404).send('Collector not found');
        }
        
        const payments = await new Promise((resolve, reject) => {
            db.all(`
                SELECT cp.*, c.name as customer_name
                FROM collector_payments cp
                LEFT JOIN customers c ON cp.customer_id = c.id
                WHERE cp.collector_id = ? 
                AND cp.collected_at >= ? 
                AND cp.collected_at <= ?
                ORDER BY cp.collected_at DESC
            `, [id, startDate, endDate + ' 23:59:59'], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        
        db.close();

        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('History Penagihan');

        worksheet.columns = [
            { header: 'Tanggal', key: 'collected_at', width: 20 },
            { header: 'Pelanggan', key: 'customer_name', width: 25 },
            { header: 'Invoice', key: 'invoice_id', width: 15 },
            { header: 'Jumlah Bayar', key: 'payment_amount', width: 20 },
            { header: 'Komisi', key: 'commission_amount', width: 20 },
            { header: 'Setoran', key: 'setoran', width: 20 },
            { header: 'Metode', key: 'payment_method', width: 15 },
            { header: 'Status', key: 'status', width: 15 }
        ];

        payments.forEach(p => {
            worksheet.addRow({
                collected_at: new Date(p.collected_at).toLocaleString('id-ID'),
                customer_name: p.customer_name || '-',
                invoice_id: p.invoice_id,
                payment_amount: p.payment_amount,
                commission_amount: p.commission_amount,
                setoran: p.payment_amount - p.commission_amount,
                payment_method: p.payment_method,
                status: p.status
            });
        });

        worksheet.getColumn('payment_amount').numFmt = '"Rp" #,##0.00';
        worksheet.getColumn('commission_amount').numFmt = '"Rp" #,##0.00';
        worksheet.getColumn('setoran').numFmt = '"Rp" #,##0.00';

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=penagihan-${collector.name.replace(/\s+/g, '-')}-${startDate}-to-${endDate}.xlsx`);
        
        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        logger.error('Error exporting collector details:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Collector Remittance
router.get('/collector-remittance', getAppSettings, async (req, res) => {
    try {
        const today = new Date();
        const month = req.query.month !== undefined ? req.query.month : (today.getMonth() + 1).toString();
        const year = req.query.year !== undefined ? req.query.year : today.getFullYear().toString();
        
        const filterMonth = month === 'all' ? null : month;
        const filterYear = year === 'all' ? null : year;

        const collectorsPending = await billingManager.getCollectorsWithPendingAmounts(filterMonth, filterYear);
        const { rows: reportRows, summary } = await billingManager.getCollectorReportsAreaRowsAndSummary(
            filterMonth,
            filterYear,
            null
        );
        const reportById = new Map((reportRows || []).map((r) => [r.id, r]));
        const collectors = collectorsPending.map((c) => {
            const extra = reportById.get(c.id) || {};
            return { ...c, ...extra };
        });

        const historyCollectorRaw = req.query.history_collector;
        const historyCollectorId =
            historyCollectorRaw != null &&
            String(historyCollectorRaw).trim() !== '' &&
            String(historyCollectorRaw) !== 'all'
                ? parseInt(String(historyCollectorRaw), 10)
                : null;

        // Riwayat = log penerimaan setoran kasir (seluruh bulan sesuai filter, bukan potongan 80 baris)
        const remittances = await billingManager.getCollectorRemittanceReceipts({
            month: filterMonth != null ? filterMonth : month,
            year: filterYear != null ? filterYear : year,
            collector_id: Number.isFinite(historyCollectorId) ? historyCollectorId : null,
            limit: 10000
        });

        const settings = getSettingsWithCache();
        res.render('admin/billing/collector-remittance', {
            title: 'Terima Setoran Kolektor',
            appSettings: req.appSettings,
            collectors,
            summary,
            remittances,
            settings: settings,
            filters: {
                month,
                year,
                history_collector:
                    historyCollectorRaw != null && String(historyCollectorRaw).trim() !== ''
                        ? String(historyCollectorRaw)
                        : 'all'
            },
            page: 'collector-remittance'
        });
        
    } catch (error) {
        logger.error('Error loading collector remittance:', error);
        res.status(500).render('error', { 
            message: 'Gagal memuat data setoran kolektor',
            error: error.message 
        });
    }
});

/** Export laporan halaman Terima Setoran (Excel / CSV). */
function remitExportCsvEscape(value) {
    const s = value == null ? '' : String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}
function remitExportCsvRow(cells) {
    return cells.map(remitExportCsvEscape).join(',') + '\r\n';
}

router.get('/collector-remittance/export.xlsx', getAppSettings, adminAuth, async (req, res) => {
    try {
        const month = req.query.month !== undefined ? req.query.month : '';
        const year = req.query.year !== undefined ? req.query.year : '';
        const filterMonth = month === 'all' || month === '' ? null : month;
        const filterYear = year === 'all' || year === '' ? null : year;

        const collectorsPending = await billingManager.getCollectorsWithPendingAmounts(filterMonth, filterYear);
        const { rows: reportRows, summary } = await billingManager.getCollectorReportsAreaRowsAndSummary(
            filterMonth,
            filterYear,
            null
        );
        const reportById = new Map((reportRows || []).map((r) => [r.id, r]));
        const collectors = collectorsPending.map((c) => ({ ...c, ...(reportById.get(c.id) || {}) }));

        const exportCollectorId =
            req.query.collector_id != null &&
            String(req.query.collector_id).trim() !== '' &&
            String(req.query.collector_id) !== 'all'
                ? parseInt(String(req.query.collector_id), 10)
                : null;

        const remittances = await billingManager.getCollectorRemittanceReceiptsExported({
            month: filterMonth != null ? String(filterMonth) : 'all',
            year: filterYear != null ? String(filterYear) : 'all',
            collector_id: Number.isFinite(exportCollectorId) ? exportCollectorId : null,
            limit: 12000
        });

        const workbook = new ExcelJS.Workbook();
        workbook.created = new Date();

        const wsRing = workbook.addWorksheet('Ringkasan', { views: [{ state: 'frozen', ySplit: 5 }] });
        wsRing.getColumn(1).width = 28;
        wsRing.getColumn(2).width = 22;
        const periodLabel =
            filterMonth && filterYear
                ? `Periode filter (kartu kolektor): ${String(filterMonth).padStart(2, '0')}/${filterYear}`
                : 'Periode filter: semua waktu';
        wsRing.addRow(['Laporan', 'Terima Setoran Kolektor']);
        wsRing.addRow(['Diekspor', new Date().toISOString().slice(0, 19).replace('T', ' ')]);
        wsRing.addRow([periodLabel, '']);
        wsRing.addRow([]);
        wsRing.addRow(['Total tagihan (area)', Number(summary.total_tagihan) || 0]);
        wsRing.addRow(['Total lunas (area)', Number(summary.total_lunas) || 0]);
        wsRing.addRow(['Belum lunas (area)', Number(summary.total_belum_lunas) || 0]);
        wsRing.addRow(['Komisi kolektor (bruto)', Number(summary.total_komisi) || 0]);
        wsRing.getCell('B5').numFmt = '"Rp" #,##0';
        wsRing.getCell('B6').numFmt = '"Rp" #,##0';
        wsRing.getCell('B7').numFmt = '"Rp" #,##0';
        wsRing.getCell('B8').numFmt = '"Rp" #,##0';

        const wsKol = workbook.addWorksheet('Kolektor', { views: [{ state: 'frozen', ySplit: 1 }] });
        wsKol.columns = [
            { header: 'Nama', key: 'name', width: 26 },
            { header: 'Telepon', key: 'phone', width: 16 },
            { header: 'Komisi %', key: 'rate', width: 10 },
            { header: 'Total tagihan area (Rp)', key: 'tta', width: 22 },
            { header: 'Jml tagihan', key: 'ct', width: 12 },
            { header: 'Belum lunas (Rp)', key: 'blrp', width: 18 },
            { header: 'Belum lunas (jml)', key: 'blc', width: 14 },
            { header: 'Sudah lunas area (Rp)', key: 'tlrp', width: 20 },
            { header: 'Jml lunas', key: 'cl', width: 11 },
            { header: 'Lunas kolektor tunai (Rp)', key: 'tlg', width: 24 },
            { header: 'Lunas transfer (Rp)', key: 'tlt', width: 18 },
            { header: 'Sudah setor (Rp)', key: 'ss', width: 18 },
            { header: 'Komisi (Rp)', key: 'kom', width: 16 },
            { header: 'Belum setor (Rp)', key: 'pend', width: 18 }
        ];
        collectors.forEach((c) => {
            wsKol.addRow({
                name: c.name || '',
                phone: c.phone || '',
                rate: c.commission_rate != null ? Number(c.commission_rate) : 5,
                tta: Number(c.total_tagihan_area) || 0,
                ct: Number(c.count_tagihan_area) || 0,
                blrp: Number(c.total_belum_lunas_amount) || 0,
                blc: Number(c.total_belum_lunas_count) || 0,
                tlrp: Number(c.total_lunas_area) || 0,
                cl: Number(c.count_lunas_area) || 0,
                tlg: Number(c.total_lunas_gross) || 0,
                tlt: Number(c.total_lunas_transfer) || 0,
                ss: Number(c.sudah_setor) || 0,
                kom: Number(c.total_commission_cash != null ? c.total_commission_cash : c.total_commission) || 0,
                pend: Number(c.pending_amount) || 0
            });
        });
        ['tta', 'blrp', 'tlrp', 'tlg', 'tlt', 'ss', 'kom', 'pend'].forEach((k) => {
            wsKol.getColumn(k).numFmt = '"Rp" #,##0';
        });

        const wsRiw = workbook.addWorksheet('Riwayat terima', { views: [{ state: 'frozen', ySplit: 1 }] });
        wsRiw.columns = [
            { header: 'ID', key: 'id', width: 8 },
            { header: 'Kolektor', key: 'cn', width: 26 },
            { header: 'Waktu terima', key: 'dt', width: 20 },
            { header: 'Metode', key: 'pm', width: 14 },
            { header: 'Catatan', key: 'nt', width: 28 },
            { header: 'Jumlah (Rp)', key: 'am', width: 18 },
            { header: 'Status', key: 'st', width: 12 }
        ];
        remittances.forEach((r) => {
            let dt = '';
            try {
                dt = r.received_at ? new Date(r.received_at).toLocaleString('id-ID') : '';
            } catch (_) {
                dt = String(r.received_at || '');
            }
            wsRiw.addRow({
                id: r.id,
                cn: r.collector_name || '',
                dt,
                pm: (r.payment_method || '').toString(),
                nt: r.notes || '',
                am: Number(r.amount) || 0,
                st: 'Diterima'
            });
        });
        wsRiw.getColumn('am').numFmt = '"Rp" #,##0';

        const fn = `setoran-kolektor-${new Date().toISOString().slice(0, 10)}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        logger.error('Error exporting collector remittance xlsx:', error);
        res.status(500).send(error.message || 'Export gagal');
    }
});

router.get('/collector-remittance/export.csv', getAppSettings, adminAuth, async (req, res) => {
    try {
        const table = String(req.query.table || 'riwayat').toLowerCase();
        const month = req.query.month !== undefined ? req.query.month : '';
        const year = req.query.year !== undefined ? req.query.year : '';
        const filterMonth = month === 'all' || month === '' ? null : month;
        const filterYear = year === 'all' || year === '' ? null : year;

        let body = '\uFEFF';
        let filename = 'setoran-kolektor.csv';

        if (table === 'kolektor') {
            filename = 'setoran-kolektor-snapshot.csv';
            const collectorsPending = await billingManager.getCollectorsWithPendingAmounts(filterMonth, filterYear);
            const { rows: reportRows } = await billingManager.getCollectorReportsAreaRowsAndSummary(
                filterMonth,
                filterYear,
                null
            );
            const reportById = new Map((reportRows || []).map((r) => [r.id, r]));
            const collectors = collectorsPending.map((c) => ({ ...c, ...(reportById.get(c.id) || {}) }));
            body += remitExportCsvRow([
                'Nama',
                'Telepon',
                'Komisi_%',
                'Total_tagihan_area_Rp',
                'Jml_tagihan',
                'Belum_lunas_Rp',
                'Belum_lunas_jml',
                'Sudah_lunas_area_Rp',
                'Jml_lunas',
                'Lunas_kolektor_tunai_Rp',
                'Lunas_transfer_Rp',
                'Sudah_setor_Rp',
                'Komisi_Rp',
                'Belum_setor_Rp'
            ]);
            collectors.forEach((c) => {
                body += remitExportCsvRow([
                    c.name || '',
                    c.phone || '',
                    c.commission_rate != null ? c.commission_rate : 5,
                    Number(c.total_tagihan_area) || 0,
                    Number(c.count_tagihan_area) || 0,
                    Number(c.total_belum_lunas_amount) || 0,
                    Number(c.total_belum_lunas_count) || 0,
                    Number(c.total_lunas_area) || 0,
                    Number(c.count_lunas_area) || 0,
                    Number(c.total_lunas_gross) || 0,
                    Number(c.total_lunas_transfer) || 0,
                    Number(c.sudah_setor) || 0,
                    Number(c.total_commission_cash != null ? c.total_commission_cash : c.total_commission) || 0,
                    Number(c.pending_amount) || 0
                ]);
            });
        } else {
            filename = 'setoran-kolektor-riwayat-terima.csv';
            const exportCollectorId =
                req.query.collector_id != null &&
                String(req.query.collector_id).trim() !== '' &&
                String(req.query.collector_id) !== 'all'
                    ? parseInt(String(req.query.collector_id), 10)
                    : null;
            const remittances = await billingManager.getCollectorRemittanceReceiptsExported({
                month: filterMonth != null ? String(filterMonth) : 'all',
                year: filterYear != null ? String(filterYear) : 'all',
                collector_id: Number.isFinite(exportCollectorId) ? exportCollectorId : null,
                limit: 12000
            });
            body += remitExportCsvRow(['ID', 'Kolektor', 'Waktu_terima', 'Metode', 'Catatan', 'Jumlah_Rp', 'Status']);
            remittances.forEach((r) => {
                let dt = '';
                try {
                    dt = r.received_at ? new Date(r.received_at).toISOString() : '';
                } catch (_) {
                    dt = String(r.received_at || '');
                }
                body += remitExportCsvRow([
                    r.id,
                    r.collector_name || '',
                    dt,
                    (r.payment_method || '').toString(),
                    r.notes || '',
                    Number(r.amount) || 0,
                    'Diterima'
                ]);
            });
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(body);
    } catch (error) {
        logger.error('Error exporting collector remittance csv:', error);
        res.status(500).send(error.message || 'Export gagal');
    }
});

// API: Koreksi riwayat setoran (edit entri log penerimaan)
router.put('/api/collector-remittance/:id', adminAuth, async (req, res) => {
    try {
        const receiptId = parseInt(String(req.params.id), 10);
        if (!Number.isFinite(receiptId) || receiptId <= 0) {
            return res.status(400).json({ success: false, message: 'ID riwayat tidak valid' });
        }
        const { collector_id, amount, remittance_amount, payment_method, notes, received_at, remittance_date } =
            req.body || {};
        const amountVal = remittance_amount != null ? remittance_amount : amount;
        const dateVal = received_at != null ? received_at : remittance_date;

        const result = await billingManager.updateCollectorRemittanceReceipt(receiptId, {
            collector_id,
            amount: amountVal,
            payment_method,
            notes,
            received_at: dateVal
        });

        res.json({
            success: true,
            message: 'Riwayat setoran berhasil diperbarui',
            data: result
        });
    } catch (error) {
        console.error('Error updating collector remittance receipt:', error);
        const msg = error && error.message ? error.message : String(error);
        const isBiz =
            msg.includes('tidak ditemukan') ||
            msg.includes('tidak valid') ||
            msg.includes('wajib') ||
            msg.includes('melebihi') ||
            msg.includes('Tidak ada sisa') ||
            msg.includes('Koreksi') ||
            msg.includes('Alokasi');
        res.status(isBiz ? 400 : 500).json({
            success: false,
            message: isBiz ? msg : 'Gagal memperbarui riwayat: ' + msg
        });
    }
});

// API: Hapus riwayat setoran
router.delete('/api/collector-remittance/:id', adminAuth, async (req, res) => {
    try {
        const receiptId = parseInt(String(req.params.id), 10);
        if (!Number.isFinite(receiptId) || receiptId <= 0) {
            return res.status(400).json({ success: false, message: 'ID riwayat tidak valid' });
        }

        const result = await billingManager.deleteCollectorRemittanceReceipt(receiptId);

        res.json({
            success: true,
            message: 'Riwayat setoran berhasil dihapus',
            data: result
        });
    } catch (error) {
        console.error('Error deleting collector remittance receipt:', error);
        const msg = error && error.message ? error.message : String(error);
        const isBiz =
            msg.includes('tidak ditemukan') ||
            msg.includes('tidak valid') ||
            msg.includes('Koreksi') ||
            msg.includes('Alokasi') ||
            msg.includes('Gagal menghapus');
        res.status(isBiz ? 400 : 500).json({
            success: false,
            message: isBiz ? msg : 'Gagal menghapus riwayat: ' + msg
        });
    }
});

router.get('/api/collector-remittance/:id', adminAuth, async (req, res) => {
    try {
        const receiptId = parseInt(String(req.params.id), 10);
        if (!Number.isFinite(receiptId) || receiptId <= 0) {
            return res.status(400).json({ success: false, message: 'ID riwayat tidak valid' });
        }
        const row = await billingManager.getCollectorRemittanceReceiptById(receiptId);
        if (!row) {
            return res.status(404).json({ success: false, message: 'Riwayat setoran tidak ditemukan' });
        }
        res.json({ success: true, data: row });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || 'Gagal memuat riwayat' });
    }
});

// API: Record Collector Remittance
router.post('/api/collector-remittance', adminAuth, async (req, res) => {
    try {
        const { collector_id, remittance_amount, payment_method, notes, remittance_date } = req.body;
        
        if (!collector_id || !remittance_amount || !payment_method) {
            return res.status(400).json({
                success: false,
                message: 'Semua field wajib diisi'
            });
        }
        
        const result = await billingManager.recordCollectorRemittance({
            collector_id,
            amount: parseFloat(remittance_amount),
            payment_method,
            notes: notes || '',
            remittance_date: remittance_date || new Date().toISOString()
        });

        res.json({
            success: true,
            message: 'Setoran berhasil diterima',
            data: result
        });
    } catch (error) {
        console.error('Error recording collector remittance:', error);
        const msg = error && error.message ? error.message : String(error);
        const isBiz =
            msg.includes('melebihi') ||
            msg.includes('Tidak ada sisa') ||
            msg.includes('tidak valid') ||
            msg.includes('Alokasi');
        res.status(isBiz ? 400 : 500).json({
            success: false,
            message: isBiz ? msg : 'Error recording remittance: ' + msg
        });
    }
});

// Mobile Map Management - Now using responsive mapping-new.ejs
router.get('/mobile/map', getAppSettings, async (req, res) => {
    try {
        // Redirect to main mapping page (responsive)
        res.redirect('/admin/billing/mapping');
    } catch (error) {
        logger.error('Error loading mobile map:', error);
        res.status(500).render('error', { 
            message: 'Error loading mobile map',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// GET: Redirect untuk cable routes ke cable-network
router.get('/cables', adminAuth, (req, res) => {
    res.redirect('/admin/cable-network/cables');
});

// GET: Redirect untuk ODP ke cable-network
router.get('/odp', adminAuth, (req, res) => {
    res.redirect('/admin/cable-network/odp');
});

// Dashboard Billing — Dialihkan ke dashboard terpadu
router.get('/dashboard', adminAuth, (req, res) => {
    // Redirect ke dashboard admin terpadu yang sekarang juga menampilkan billing stats
    return res.redirect('/admin/dashboard');
});

// [LEGACY] Handler lama disimpan sebagai referensi — tidak aktif
router.get('/dashboard-legacy', getAppSettings, async (req, res) => {
    // Set timeout untuk mencegah ERR_CONNECTION_TIMED_OUT
    req.setTimeout(30000); // 30 detik timeout
    
    // Timeout wrapper untuk setiap query
    const withTimeout = (promise, timeoutMs = 10000, errorMessage = 'Query timeout') => {
        return Promise.race([
            promise,
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
            )
        ]);
    };
    
    try {
        // Hapus cleanupDataConsistency() dari sini karena terlalu berat untuk dijalankan setiap kali dashboard dibuka
        // Cleanup seharusnya dijalankan secara berkala atau manual, bukan setiap request
        // await billingManager.cleanupDataConsistency();
        
        // Jalankan query secara parallel dengan timeout protection
        const [stats, overdueInvoices, recentInvoices] = await Promise.all([
            withTimeout(billingManager.getBillingStats(), 15000, 'getBillingStats timeout'),
            withTimeout(billingManager.getOverdueInvoices(10), 10000, 'getOverdueInvoices timeout'),
            withTimeout(billingManager.getInvoices(null, 10, 0), 10000, 'getInvoices timeout')
        ]);
        
        const { getVersionInfo } = require('../config/version-utils');
        const settings = getSettingsWithCache();
        
        res.render('admin/billing/dashboard', {
            title: 'Dashboard Billing',
            stats,
            overdueInvoices: overdueInvoices || [], // Fallback ke array kosong jika error
            recentInvoices: recentInvoices || [], // Fallback ke array kosong jika error
            appSettings: req.appSettings,
            settings: settings,
            versionInfo: getVersionInfo(),
            page: 'billing'
        });
    } catch (error) {
        logger.error('Error loading billing dashboard:', error);
        
        // Jika timeout, berikan response cepat dengan data minimal
        if (error.message.includes('timeout')) {
            logger.warn('Dashboard billing timeout - returning minimal data');
            const { getVersionInfo } = require('../config/version-utils');
            const settings = getSettingsWithCache();
            
            return res.render('admin/billing/dashboard', {
                title: 'Dashboard Billing',
                stats: {
                    total_customers: 0,
                    active_customers: 0,
                    total_invoices: 0,
                    paid_invoices: 0,
                    unpaid_invoices: 0,
                    total_revenue: 0,
                    total_unpaid: 0
                },
                overdueInvoices: [],
                recentInvoices: [],
                appSettings: req.appSettings,
                settings: settings,
                versionInfo: getVersionInfo(),
                error: 'Data sedang dimuat, silakan refresh halaman dalam beberapa saat.'
            });
        }
        
        res.status(500).render('error', { 
            message: 'Gagal memuat dashboard billing',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Laporan Keuangan
const { normalizeFinancialReportForView } = require('../utils/financialReportForView');

router.get('/financial-report', getAppSettings, async (req, res) => {
    try {
        const { start_date, end_date, type } = req.query;
        const period = resolveMonthYearRange(req.query);
        const startDate = start_date || period.startDate;
        const endDate = end_date || period.endDate;
        
        const rawFinancialData = await billingManager.getFinancialReport(startDate, endDate, type);
        const financialData = await normalizeFinancialReportForView(rawFinancialData, startDate, endDate);
        
        res.render('admin/billing/financial-report', {
            title: 'Laporan Keuangan',
            financialData,
            startDate,
            endDate,
            month: period.month,
            year: period.year,
            type: type || 'all',
            appSettings: req.appSettings,
            page: 'financial-report'
        });
    } catch (error) {
        logger.error('❌ Error loading financial report:', error);
        if (error.stack) console.error(error.stack);

        res.status(500).render('error', { 
            message: 'Gagal memuat laporan keuangan. Pastikan tabel voucher_revenue sudah ada.',
            error: process.env.NODE_ENV === 'development' ? error : { 
                status: 500, 
                stack: 'Internal Server Error (Detail logged to server console)' 
            }
        });
    }
});

// API untuk data laporan keuangan
router.get('/api/financial-report', async (req, res) => {
    try {
        const { start_date, end_date, type } = req.query;
        const period = resolveMonthYearRange(req.query);
        const startDate = start_date || period.startDate;
        const endDate = end_date || period.endDate;
        const rawFinancialData = await billingManager.getFinancialReport(startDate, endDate, type);
        const financialData = await normalizeFinancialReportForView(rawFinancialData, startDate, endDate);
        res.json({ success: true, data: financialData });
    } catch (error) {
        logger.error('Error getting financial report data:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Laporan Keuangan Voucher
router.get('/reports/voucher', getAppSettings, adminAuth, async (req, res) => {
    try {
        const { start_date, end_date, status } = req.query;
        const period = resolveMonthYearRange(req.query);
        const startDate = start_date || period.startDate;
        const endDate = end_date || period.endDate;
        
        logger.info(`Voucher report query: startDate=${startDate}, endDate=${endDate}, status=${status || 'all'}`);
        
        // Catatan: Auto-update dihapus untuk performa
        // Script update_voucher_invoices_on_use.js sebaiknya dijalankan via cron job
        // atau manual via tombol "Update Status" di UI
        
        const allInvoices = await billingManager.getVoucherInvoices(startDate, endDate);
        const filteredInvoices = billingManager.filterVoucherInvoicesByStatus(allInvoices, status || 'all');
        const stats = billingManager.calculateVoucherStats(filteredInvoices);
        
        logger.info(`Found ${filteredInvoices.length} voucher invoices for date range ${startDate} to ${endDate} (status=${status || 'all'})`);
        
        res.render('admin/billing/report-voucher', {
            title: 'Laporan Keuangan Voucher',
            stats,
            invoices: filteredInvoices,
            startDate,
            endDate,
            month: period.month,
            year: period.year,
            status: status || 'all',
            appSettings: req.appSettings,
            page: 'report-voucher'
        });
    } catch (error) {
        logger.error('❌ Error loading voucher report:', error);
        if (error.stack) console.error(error.stack);

        res.status(500).render('error', { 
            message: 'Gagal memuat laporan keuangan voucher. Pastikan tabel voucher_revenue sudah ada.',
            error: process.env.NODE_ENV === 'development' ? error : { 
                status: 500, 
                stack: 'Internal Server Error (Detail logged to server console)' 
            }
        });
    }
});

// Laporan Keuangan PPPoE
router.get('/reports/pppoe', getAppSettings, adminAuth, async (req, res) => {
    try {
        const { start_date, end_date, status } = req.query;
        const period = resolveMonthYearRange(req.query);
        const startDate = start_date || period.startDate;
        const endDate = end_date || period.endDate;
        
        const stats = await billingManager.getPPPoEReportStats(startDate, endDate);
        const invoices = await billingManager.getPPPoEInvoices(startDate, endDate, status || null);
        
        res.render('admin/billing/report-pppoe', {
            title: 'Laporan Keuangan PPPoE',
            stats,
            invoices,
            startDate,
            endDate,
            month: period.month,
            year: period.year,
            status: status || 'all',
            appSettings: req.appSettings,
            page: 'report-pppoe'
        });
    } catch (error) {
        logger.error('Error loading PPPoE report:', error);
        res.status(500).render('error', { 
            message: 'Gagal memuat laporan keuangan PPPoE',
            error: error.message 
        });
    }
});

// API untuk create missing voucher invoices retroaktif
router.post('/api/create-missing-voucher-invoices', adminAuth, async (req, res) => {
    try {
        const { getAllVouchersFromRadius, getVoucherInvoices, createInvoiceForVoucher } = require('../scripts/create_missing_voucher_invoices');
        
        // Get all vouchers from RADIUS
        const vouchers = await getAllVouchersFromRadius();
        
        // Get existing invoice usernames
        const existingInvoices = await getVoucherInvoices();
        
        // Filter vouchers yang belum punya invoice
        const vouchersWithoutInvoice = vouchers.filter(v => {
            return !existingInvoices.includes(v.username);
        });
        
        if (vouchersWithoutInvoice.length === 0) {
            return res.json({ 
                success: true, 
                message: 'Semua voucher sudah punya invoice',
                created: 0
            });
        }
        
        // Create invoices untuk voucher yang belum punya
        let successCount = 0;
        let errorCount = 0;
        const errors = [];
        
        for (const voucher of vouchersWithoutInvoice) {
            try {
                await createInvoiceForVoucher(voucher.username, voucher.profile);
                successCount++;
            } catch (error) {
                errorCount++;
                errors.push({ username: voucher.username, error: error.message });
                logger.error(`Error creating invoice for ${voucher.username}:`, error);
            }
        }
        
        // Refresh stats
        const stats = await billingManager.getBillingStats();
        
        res.json({ 
            success: true, 
            message: `Berhasil membuat ${successCount} invoice untuk voucher yang belum punya invoice`,
            created: successCount,
            errors: errorCount,
            errorDetails: errors.length > 0 ? errors : null,
            stats
        });
    } catch (error) {
        logger.error('Error creating missing voucher invoices:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Gagal membuat invoice untuk voucher: ' + error.message 
        });
    }
});

// API untuk update invoice voucher menjadi paid saat voucher digunakan
router.post('/api/update-voucher-invoices', adminAuth, async (req, res) => {
    try {
        const { updateVoucherInvoiceToPaid } = require('../scripts/update_voucher_invoices_on_use');
        const { getUsedVouchers } = require('../scripts/update_voucher_invoices_on_use');
        
        // Get vouchers that have been used
        const usedVouchers = await getUsedVouchers();
        
        if (usedVouchers.length === 0) {
            return res.json({ 
                success: true, 
                message: 'Tidak ada voucher yang digunakan saat ini',
                updated: 0
            });
        }
        
        // Update invoices
        let updatedCount = 0;
        for (const username of usedVouchers) {
            try {
                const result = await updateVoucherInvoiceToPaid(username);
                if (result) {
                    updatedCount++;
                }
            } catch (error) {
                logger.error(`Error updating invoice for ${username}:`, error);
            }
        }
        
        // Refresh stats
        const stats = await billingManager.getBillingStats();
        
        res.json({ 
            success: true, 
            message: `Berhasil update ${updatedCount} invoice voucher`,
            updated: updatedCount,
            stats
        });
    } catch (error) {
        logger.error('Error updating voucher invoices:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// API untuk cleanup data konsistensi
router.post('/api/cleanup-data', adminAuth, async (req, res) => {
    try {
        await billingManager.cleanupDataConsistency();
        const stats = await billingManager.getBillingStats();
        
        res.json({ 
            success: true, 
            message: 'Data konsistensi berhasil diperbaiki',
            stats 
        });
    } catch (error) {
        logger.error('Error cleaning up data:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// API untuk mendapatkan statistik real-time
router.get('/api/stats', adminAuth, async (req, res) => {
    try {
        const stats = await billingManager.getBillingStats();
        res.json({ success: true, data: stats });
    } catch (error) {
        logger.error('Error getting billing stats:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Revenue summary API (payments-based)
router.get('/api/revenue/summary', adminAuth, async (req, res) => {
    try {
        const { from, to } = req.query;
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);

        function getDateStr(d) { return new Date(d).toISOString().split('T')[0]; }
        const todayStr = getDateStr(new Date());
        const weekAgoStr = getDateStr(new Date(Date.now() - 6 * 24 * 3600 * 1000));

        const dateFrom = from || weekAgoStr;
        const dateTo = to || todayStr;

        const [todayRevenue, weekRevenue, monthRevenue] = await Promise.all([
            new Promise((resolve, reject) => {
                db.get(`
                    SELECT COALESCE(SUM(amount),0) AS total
                    FROM payments
                    WHERE date(payment_date) = date(?)
                `, [todayStr], (err, row) => err ? reject(err) : resolve(row?.total || 0));
            }),
            new Promise((resolve, reject) => {
                db.get(`
                    SELECT COALESCE(SUM(amount),0) AS total
                    FROM payments
                    WHERE date(payment_date) BETWEEN date(?) AND date(?)
                `, [weekAgoStr, todayStr], (err, row) => err ? reject(err) : resolve(row?.total || 0));
            }),
            new Promise((resolve, reject) => {
                db.get(`
                    SELECT COALESCE(SUM(amount),0) AS total
                    FROM payments
                    WHERE strftime('%Y-%m', payment_date) = strftime('%Y-%m', 'now', 'localtime')
                `, [], (err, row) => err ? reject(err) : resolve(row?.total || 0));
            }),
        ]);

        db.close();
        res.json({ success: true, data: { todayRevenue, weekRevenue, monthRevenue, dateFrom, dateTo } });
    } catch (error) {
        logger.error('Error getting revenue summary:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Halaman Semua Invoice (Invoice List)
router.get('/invoice-list', getAppSettings, async (req, res) => {
    try {
        const { page = 1, limit = 50, status, customer_username, search, type } = req.query;
        const offset = (page - 1) * limit;
        const searchTerm = String(search || customer_username || '').trim();
        
        // Prepare filters object
        const filters = {};
        if (status) filters.status = status;
        if (searchTerm) filters.customer_username = searchTerm;
        if (type) filters.type = type;
        
        filters.listMode = true;

        const [invoices, totalCount, summary] = await Promise.all([
            billingManager.getInvoicesWithFilters(filters, limit, offset),
            billingManager.getInvoicesCountWithFilters(filters),
            billingManager.getInvoiceListSummaryWithFilters(filters)
        ]);
        
        res.render('admin/billing/invoice-list', {
            title: 'Semua Invoice',
            invoices,
            summary: summary || { total: totalCount, paid: 0, unpaid: 0, overdue: 0 },
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalCount / limit),
                totalCount,
                limit: parseInt(limit)
            },
            filters: {
                status: status || '',
                customer_username: searchTerm || '',
                type: type || ''
            },
            appSettings: req.appSettings,
            page: 'invoices'
        });
    } catch (error) {
        logger.error('Error loading invoice list:', error);
        res.status(500).render('error', {
            message: 'Error loading invoice list',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Halaman Invoice by Type
router.get('/invoices-by-type', adminAuth, async (req, res) => {
    try {
        // Get invoices by type
        const monthlyInvoices = await billingManager.getInvoicesByType('monthly');
        const voucherInvoices = await billingManager.getInvoicesByType('voucher');
        const manualInvoices = await billingManager.getInvoicesByType('manual');
        
        // Get stats by type
        const monthlyStats = await billingManager.getInvoiceStatsByType('monthly');
        const voucherStats = await billingManager.getInvoiceStatsByType('voucher');
        const manualStats = await billingManager.getInvoiceStatsByType('manual');
        
        res.render('admin/billing/invoices-by-type', {
            title: 'Invoice by Type',
            monthlyInvoices: monthlyInvoices.slice(0, 50), // Limit to 50 per type
            voucherInvoices: voucherInvoices.slice(0, 50),
            manualInvoices: manualInvoices.slice(0, 50),
            monthlyStats,
            voucherStats,
            manualStats
        });
    } catch (error) {
        logger.error('Error loading invoices by type:', error);
        res.status(500).render('error', { 
            message: 'Gagal memuat halaman invoice by type',
            error: error.message 
        });
    }
});

// API untuk cleanup voucher manual
router.post('/api/voucher-cleanup', adminAuth, async (req, res) => {
    try {
        const result = await billingManager.cleanupExpiredVoucherInvoices();
        
        res.json({
            success: result.success,
            message: result.message,
            cleaned: result.cleaned,
            expiredInvoices: result.expiredInvoices || []
        });
    } catch (error) {
        logger.error('Error in manual voucher cleanup:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal melakukan cleanup voucher',
            error: error.message
        });
    }
});

// API untuk melihat expired voucher invoices
router.get('/api/expired-vouchers', adminAuth, async (req, res) => {
    try {
        const expiredInvoices = await billingManager.getExpiredVoucherInvoices();
        
        res.json({
            success: true,
            data: expiredInvoices,
            count: expiredInvoices.length
        });
    } catch (error) {
        logger.error('Error getting expired voucher invoices:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data expired voucher',
            error: error.message
        });
    }
});

// Halaman Monthly Summary
router.get('/monthly-summary', adminAuth, async (req, res) => {
    try {
        const summaries = await billingManager.getAllMonthlySummaries(24); // Last 24 months
        
        res.render('admin/billing/monthly-summary', {
            title: 'Summary Bulanan',
            summaries,
            appSettings: req.appSettings,
            page: 'monthly-summary'
        });
    } catch (error) {
        logger.error('Error loading monthly summary:', error);
        res.status(500).render('error', { 
            message: 'Gagal memuat summary bulanan',
            error: error.message 
        });
    }
});

// API untuk generate summary bulanan manual
router.post('/api/generate-monthly-summary', adminAuth, async (req, res) => {
    try {
        const result = await billingManager.generateMonthlySummary();
        
        res.json({
            success: result.success,
            message: result.message,
            year: result.year,
            month: result.month,
            stats: result.stats
        });
    } catch (error) {
        logger.error('Error generating monthly summary:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal generate summary bulanan',
            error: error.message
        });
    }
});

// API untuk manual monthly reset
router.post('/api/monthly-reset', adminAuth, async (req, res) => {
    try {
        const result = await billingManager.performMonthlyReset();
        
        res.json({
            success: result.success,
            message: result.message,
            year: result.year,
            month: result.month,
            previousYear: result.previousYear,
            previousMonth: result.previousMonth,
            collectorsProcessed: result.collectorsProcessed
        });
    } catch (error) {
        logger.error('Error performing monthly reset:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal melakukan monthly reset',
            error: error.message
        });
    }
});

// API untuk manual trigger monthly reset via scheduler
router.post('/api/trigger-monthly-reset', adminAuth, async (req, res) => {
    try {
        const scheduler = require('../config/scheduler');
        const result = await scheduler.triggerMonthlyReset();
        
        res.json({
            success: result.success,
            message: result.message,
            year: result.year,
            month: result.month,
            previousYear: result.previousYear,
            previousMonth: result.previousMonth,
            collectorsProcessed: result.collectorsProcessed
        });
    } catch (error) {
        logger.error('Error triggering monthly reset:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal trigger monthly reset',
            error: error.message
        });
    }
});

// API untuk mendapatkan summary bulanan
router.get('/api/monthly-summary', adminAuth, async (req, res) => {
    try {
        const { year, month } = req.query;
        
        if (year && month) {
            const summary = await billingManager.getMonthlySummary(parseInt(year), parseInt(month));
            res.json({
                success: true,
                data: summary
            });
        } else {
            const summaries = await billingManager.getAllMonthlySummaries(12);
            res.json({
                success: true,
                data: summaries
            });
        }
    } catch (error) {
        logger.error('Error getting monthly summary:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil summary bulanan',
            error: error.message
        });
    }
});

// Export laporan keuangan bulanan ke Excel
router.get('/export/monthly-summary.xlsx', adminAuth, async (req, res) => {
    try {
        const ExcelJS = require('exceljs');
        const summaries = await billingManager.getAllMonthlySummaries(24);
        
        // Buat workbook Excel
        const workbook = new ExcelJS.Workbook();
        
        // Sheet 1: Summary Data
        const summarySheet = workbook.addWorksheet('Summary Bulanan');
        summarySheet.columns = [
            { header: 'Tahun', key: 'year', width: 8 },
            { header: 'Bulan', key: 'month', width: 10 },
            { header: 'Total Pelanggan', key: 'total_customers', width: 15 },
            { header: 'Pelanggan Aktif', key: 'active_customers', width: 15 },
            { header: 'Invoice Bulanan', key: 'monthly_invoices', width: 15 },
            { header: 'Invoice Voucher', key: 'voucher_invoices', width: 15 },
            { header: 'Lunas Bulanan', key: 'paid_monthly_invoices', width: 15 },
            { header: 'Lunas Voucher', key: 'paid_voucher_invoices', width: 15 },
            { header: 'Belum Lunas Bulanan', key: 'unpaid_monthly_invoices', width: 18 },
            { header: 'Belum Lunas Voucher', key: 'unpaid_voucher_invoices', width: 18 },
            { header: 'Pendapatan Bulanan', key: 'monthly_revenue', width: 18 },
            { header: 'Pendapatan Voucher', key: 'voucher_revenue', width: 18 },
            { header: 'Total Pendapatan', key: 'total_revenue', width: 18 },
            { header: 'Belum Dibayar', key: 'total_unpaid', width: 15 },
            { header: 'Tanggal Generate', key: 'created_at', width: 20 }
        ];
        
        // Tambahkan data summary
        summaries.forEach(summary => {
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            summarySheet.addRow({
                year: summary.year,
                month: monthNames[summary.month - 1],
                total_customers: summary.total_customers,
                active_customers: summary.active_customers,
                monthly_invoices: summary.monthly_invoices,
                voucher_invoices: summary.voucher_invoices,
                paid_monthly_invoices: summary.paid_monthly_invoices,
                paid_voucher_invoices: summary.paid_voucher_invoices,
                unpaid_monthly_invoices: summary.unpaid_monthly_invoices,
                unpaid_voucher_invoices: summary.unpaid_voucher_invoices,
                monthly_revenue: summary.monthly_revenue,
                voucher_revenue: summary.voucher_revenue,
                total_revenue: summary.total_revenue,
                total_unpaid: summary.total_unpaid,
                created_at: new Date(summary.created_at).toLocaleDateString('id-ID')
            });
        });
        
        // Format currency untuk kolom revenue
        summarySheet.getColumn('monthly_revenue').numFmt = '"Rp" #,##0.00';
        summarySheet.getColumn('voucher_revenue').numFmt = '"Rp" #,##0.00';
        summarySheet.getColumn('total_revenue').numFmt = '"Rp" #,##0.00';
        summarySheet.getColumn('total_unpaid').numFmt = '"Rp" #,##0.00';
        
        // Sheet 2: Analisis Trend
        const trendSheet = workbook.addWorksheet('Analisis Trend');
        trendSheet.columns = [
            { header: 'Metrik', key: 'metric', width: 25 },
            { header: 'Nilai Terbaru', key: 'latest', width: 20 },
            { header: 'Nilai Sebelumnya', key: 'previous', width: 20 },
            { header: 'Growth (%)', key: 'growth', width: 15 },
            { header: 'Status', key: 'status', width: 15 }
        ];
        
        if (summaries.length >= 2) {
            const latest = summaries[0];
            const previous = summaries[1];
            
            const metrics = [
                { name: 'Total Revenue', latest: latest.total_revenue, previous: previous.total_revenue },
                { name: 'Monthly Revenue', latest: latest.monthly_revenue, previous: previous.monthly_revenue },
                { name: 'Voucher Revenue', latest: latest.voucher_revenue, previous: previous.voucher_revenue },
                { name: 'Total Customers', latest: latest.total_customers, previous: previous.total_customers },
                { name: 'Active Customers', latest: latest.active_customers, previous: previous.active_customers },
                { name: 'Monthly Invoices', latest: latest.monthly_invoices, previous: previous.monthly_invoices },
                { name: 'Voucher Invoices', latest: latest.voucher_invoices, previous: previous.voucher_invoices }
            ];
            
            metrics.forEach(metric => {
                const growth = ((metric.latest - metric.previous) / metric.previous * 100).toFixed(1);
                let status = 'Stable';
                if (growth > 5) status = 'Growth';
                else if (growth < -5) status = 'Decline';
                
                trendSheet.addRow({
                    metric: metric.name,
                    latest: metric.latest,
                    previous: metric.previous,
                    growth: growth + '%',
                    status: status
                });
            });
        }
        
        // Sheet 3: KPI Summary
        const kpiSheet = workbook.addWorksheet('KPI Summary');
        kpiSheet.columns = [
            { header: 'KPI', key: 'kpi', width: 30 },
            { header: 'Nilai', key: 'value', width: 20 },
            { header: 'Keterangan', key: 'description', width: 40 }
        ];
        
        if (summaries.length > 0) {
            const latest = summaries[0];
            const avgRevenue = summaries.reduce((sum, s) => sum + s.total_revenue, 0) / summaries.length;
            const bestMonth = summaries.reduce((max, s) => s.total_revenue > max.total_revenue ? s : max);
            
            const kpis = [
                { kpi: 'Total Revenue Terbaru', value: `Rp ${latest.total_revenue.toLocaleString('id-ID')}`, description: 'Pendapatan total bulan terbaru' },
                { kpi: 'Rata-rata Revenue', value: `Rp ${avgRevenue.toLocaleString('id-ID')}`, description: 'Rata-rata pendapatan per bulan' },
                { kpi: 'Bulan Terbaik', value: `${bestMonth.month}/${bestMonth.year}`, description: `Rp ${bestMonth.total_revenue.toLocaleString('id-ID')}` },
                { kpi: 'Total Pelanggan', value: latest.total_customers, description: 'Jumlah pelanggan terdaftar' },
                { kpi: 'Pelanggan Aktif', value: latest.active_customers, description: 'Pelanggan dengan status aktif' },
                { kpi: 'Collection Rate', value: `${((latest.paid_monthly_invoices + latest.paid_voucher_invoices) / (latest.monthly_invoices + latest.voucher_invoices) * 100).toFixed(1)}%`, description: 'Persentase invoice yang dibayar' }
            ];
            
            kpis.forEach(kpi => {
                kpiSheet.addRow(kpi);
            });
        }
        
        // Set response header
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=laporan-keuangan-bulanan-${new Date().toISOString().split('T')[0]}.xlsx`);
        
        // Write to response
        await workbook.xlsx.write(res);
        res.end();
        
    } catch (error) {
        logger.error('Error exporting monthly summary:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Export laporan keuangan ke Excel
router.get('/export/financial-report.xlsx', async (req, res) => {
    try {
        const { start_date, end_date, type } = req.query;
        const period = resolveMonthYearRange(req.query);
        const startDate = start_date || period.startDate;
        const endDate = end_date || period.endDate;
        const rawFinancialData = await billingManager.getFinancialReport(startDate, endDate, type);
        const financialData = await normalizeFinancialReportForView(rawFinancialData, startDate, endDate);
        
        // Buat workbook Excel
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Laporan Keuangan');
        
        // Set header
        worksheet.columns = [
            { header: 'Tanggal', key: 'date', width: 15 },
            { header: 'Tipe', key: 'type', width: 12 },
            { header: 'Jumlah', key: 'amount', width: 15 },
            { header: 'Metode Pembayaran', key: 'payment_method', width: 20 },
            { header: 'Gateway', key: 'gateway_name', width: 15 },
            { header: 'No. Invoice', key: 'invoice_number', width: 20 },
            { header: 'Pelanggan', key: 'customer_name', width: 25 },
            { header: 'Telepon', key: 'customer_phone', width: 15 }
        ];
        
        // Tambahkan data transaksi
        financialData.transactions.forEach(transaction => {
            worksheet.addRow({
                date: new Date(transaction.date).toLocaleDateString('id-ID'),
                type: transaction.type === 'income' ? 'Pemasukan' : 'Pengeluaran',
                amount: transaction.amount || 0,
                payment_method: transaction.payment_method || '-',
                gateway_name: transaction.gateway_name || '-',
                invoice_number: transaction.invoice_number || '-',
                customer_name: transaction.customer_name || '-',
                customer_phone: transaction.customer_phone || '-'
            });
        });
        
        // Tambahkan summary di sheet terpisah
        const summarySheet = workbook.addWorksheet('Ringkasan');
        summarySheet.columns = [
            { header: 'Item', key: 'item', width: 25 },
            { header: 'Nilai', key: 'value', width: 20 }
        ];
        
        summarySheet.addRow({ item: 'Total Pemasukan', value: `Rp ${financialData.summary.totalIncome.toLocaleString('id-ID')}` });
        summarySheet.addRow({ item: 'Total Pengeluaran', value: `Rp ${financialData.summary.totalExpense.toLocaleString('id-ID')}` });
        summarySheet.addRow({ item: 'Laba Bersih', value: `Rp ${financialData.summary.netProfit.toLocaleString('id-ID')}` });
        summarySheet.addRow({ item: 'Jumlah Transaksi', value: financialData.summary.transactionCount });
        summarySheet.addRow({ item: 'Periode', value: `${financialData.dateRange.startDate} - ${financialData.dateRange.endDate}` });
        
        // Set response header
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=laporan-keuangan-${startDate}-${endDate}.xlsx`);
        
        // Write to response
        await workbook.xlsx.write(res);
        res.end();
        
    } catch (error) {
        logger.error('Error exporting financial report:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});
// Customers list for live table updates
router.get('/customers/list', async (req, res) => {
    try {
        const customers = await billingManager.getCustomers();
        return res.json({ success: true, customers });
    } catch (error) {
        logger.error('Error loading customers list:', error);
        return res.status(500).json({ success: false, message: 'Error loading customers list', error: error.message });
    }
});

// Customers summary for live updates
router.get('/customers/summary', async (req, res) => {
    try {
        const customers = await billingManager.getCustomers();
        const total = customers.length;
        const paid = customers.filter(c => c.payment_status === 'paid').length;
        const unpaid = customers.filter(c => c.payment_status === 'unpaid').length;
        const noInvoice = customers.filter(c => c.payment_status === 'no_invoice').length;
        const active = customers.filter(c => ['active', 'suspended', 'isolir'].includes(c.status)).length;
        const isolir = customers.filter(c => c.status === 'suspended' || c.status === 'isolir').length;

        return res.json({
            success: true,
            data: { total, paid, unpaid, noInvoice, active, isolir }
        });
    } catch (error) {
        logger.error('Error loading customers summary:', error);
        return res.status(500).json({ success: false, message: 'Error loading customers summary', error: error.message });
    }
});

// Bulk delete customers
router.post('/customers/bulk-delete', async (req, res) => {
    try {
        const { ids, phones } = req.body || {};
        
        // Support backward compatibility (phones) or new standard (ids)
        const items = ids || phones;
        const isUsingIds = !!ids;

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: 'Daftar pelanggan kosong atau tidak valid' });
        }

        const results = [];
        let success = 0;
        let failed = 0;

        for (const item of items) {
            try {
                let deleted;
                if (isUsingIds) {
                    deleted = await billingManager.deleteCustomerById(item);
                } else {
                    deleted = await billingManager.deleteCustomer(String(item));
                }
                results.push({ phone: item, success: true });
                success++;
            } catch (e) {
                // Map known errors to friendly messages
                let msg = e.message || 'Gagal menghapus';
                if (msg.includes('invoice(s) still exist')) {
                    msg = 'Masih memiliki tagihan, hapus tagihan terlebih dahulu';
                } else if (msg.includes('Customer not found') || msg.includes('Pelanggan tidak ditemukan')) {
                    msg = 'Pelanggan tidak ditemukan';
                }
                results.push({ phone: item, success: false, message: msg });
                failed++;
            }
        }

        return res.json({ success: true, summary: { success, failed, total: items.length }, results });
    } catch (error) {
        logger.error('Error bulk deleting customers:', error);
        return res.status(500).json({ success: false, message: 'Gagal melakukan hapus massal pelanggan', error: error.message });
    }
});

function formatCustomerExportDate(val) {
    if (val == null || val === '') return '';
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return String(val);
    return d.toLocaleDateString('id-ID');
}

/**
 * Setelah baris import lolos validasi: perbaiki hanya Excel (852→0852).
 * 628… dan 085… tetap berbeda — untuk bedakan 2 langganan nomor "sama" format beda.
 */
function parsePhoneFromSpreadsheetCell(val) {
    if (val == null || val === '') return '';
    return billingManager.fixExcelStrippedPhoneForStorage(val);
}

/** Batch router + sandi PPPoE (hindari ribuan koneksi RADIUS per baris). */
async function enrichCustomersForExport(customers) {
    const db = require('../config/billing').db;
    const { getUserAuthModeAsync, getRadiusConnection } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();

    const routerByCustomerId = await new Promise((resolve, reject) => {
        db.all('SELECT customer_id, router_id FROM customer_router_map', [], (err, rows) => {
            if (err) reject(err);
            else {
                const map = new Map();
                for (const r of rows || []) {
                    if (r.customer_id != null && !map.has(r.customer_id)) {
                        map.set(r.customer_id, r.router_id);
                    }
                }
                resolve(map);
            }
        });
    });

    const passwordByPppoe = new Map();
    if (authMode === 'radius') {
        const usernames = [...new Set(
            customers.map((c) => (c.pppoe_username && String(c.pppoe_username).trim()) || '').filter(Boolean)
        )];
        if (usernames.length > 0) {
            let conn;
            try {
                conn = await getRadiusConnection();
                const chunkSize = 400;
                for (let i = 0; i < usernames.length; i += chunkSize) {
                    const chunk = usernames.slice(i, i + chunkSize);
                    const placeholders = chunk.map(() => '?').join(',');
                    const [rows] = await conn.execute(
                        `SELECT username, value AS password FROM radcheck
                         WHERE LOWER(TRIM(attribute)) = 'cleartext-password'
                           AND username IN (${placeholders})`,
                        chunk
                    );
                    for (const r of rows || []) {
                        if (r.username) passwordByPppoe.set(r.username, r.password);
                    }
                }
            } finally {
                if (conn) {
                    try {
                        await conn.end();
                    } catch (_) {
                        /* abaikan */
                    }
                }
            }
        }
    }

    return customers.map((c) => {
        const pppoe = (c.pppoe_username && String(c.pppoe_username).trim()) || '';
        return {
            ...c,
            router_id: routerByCustomerId.get(c.id) || '',
            pppoe_password: pppoe ? (passwordByPppoe.get(pppoe) || '') : ''
        };
    });
}

/** Filter export/backup pelanggan — selaras query halaman Kelola Pelanggan. */
function parseCustomerExportFilters(req) {
    const filters = {};
    const month = req.query.month ? parseInt(req.query.month, 10) : null;
    const year = req.query.year ? parseInt(req.query.year, 10) : null;
    if (Number.isFinite(month) && month >= 1 && month <= 12 && Number.isFinite(year) && year >= 2000) {
        filters.month = month;
        filters.year = year;
    }
    if (req.query.search) filters.search = String(req.query.search).trim();
    if (req.query.status) filters.status = String(req.query.status).trim();
    if (req.query.package_id) filters.package_id = req.query.package_id;
    if (req.query.area) filters.area = req.query.area;
    if (req.query.collector_id) filters.collector_id = req.query.collector_id;
    if (req.query.payment_status) filters.payment_status = req.query.payment_status;
    if (req.query.customer_type) filters.customer_type = req.query.customer_type;
    if (req.query.router) filters.router_id = parseInt(req.query.router, 10);
    return filters;
}

async function loadCustomersForExport(req) {
    const joinMonth = req.query.join_month ? parseInt(req.query.join_month, 10) : null;
    const joinYear = req.query.join_year ? parseInt(req.query.join_year, 10) : null;
    const listFilters = parseCustomerExportFilters(req);

    if (Number.isFinite(joinMonth) && joinMonth >= 1 && joinMonth <= 12
        && Number.isFinite(joinYear) && joinYear >= 2000
        && !listFilters.month) {
        return {
            customers: await billingManager.getCustomers({ joinMonth, joinYear }),
            joinMonth,
            joinYear,
            listFilters: null
        };
    }

    if (listFilters.month && listFilters.year) {
        return {
            customers: await billingManager.getCustomersFiltered(listFilters),
            joinMonth: null,
            joinYear: null,
            listFilters
        };
    }

    return {
        customers: await billingManager.getCustomers(),
        joinMonth: null,
        joinYear: null,
        listFilters: null
    };
}

const CUSTOMER_EXPORT_COLUMNS = [
    { header: 'ID DB', key: 'id', width: 8 },
    { header: 'Kode Pelanggan', key: 'customer_id', width: 16 },
    { header: 'Username', key: 'username', width: 16 },
    { header: 'Nama', key: 'name', width: 28 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Area', key: 'area', width: 18 },
    { header: 'Kolektor', key: 'collector_name', width: 20 },
    { header: 'Paket', key: 'package_name', width: 22 },
    { header: 'Harga Paket', key: 'package_price', width: 14 },
    { header: 'Status Layanan', key: 'status', width: 14 },
    { header: 'Status Bayar', key: 'payment_status', width: 14 },
    { header: 'PPPoE Username', key: 'pppoe_username', width: 20 },
    { header: 'PPPoE Password', key: 'pppoe_password', width: 18 },
    { header: 'PPPoE Profile', key: 'pppoe_profile', width: 16 },
    { header: 'Router', key: 'router_name', width: 16 },
    { header: 'Router ID', key: 'router_id', width: 10 },
    { header: 'Email', key: 'email', width: 24 },
    { header: 'Alamat', key: 'address', width: 36 },
    { header: 'Latitude', key: 'latitude', width: 12 },
    { header: 'Longitude', key: 'longitude', width: 12 },
    { header: 'Package ID', key: 'package_id', width: 10 },
    { header: 'Auto Suspension', key: 'auto_suspension', width: 14 },
    { header: 'Billing Day', key: 'billing_day', width: 12 },
    { header: 'Join Date', key: 'join_date', width: 14 },
    { header: 'Created At', key: 'created_at', width: 14 }
];

/** Kolom tambahan khusus restore/import (tidak ada di export ringkas). */
const CUSTOMER_IMPORT_EXTRA_COLUMNS = [
    { header: 'Login Password', key: 'login_password', width: 18 },
    { header: 'ODP ID', key: 'odp_id', width: 10 },
    { header: 'Renewal Type', key: 'renewal_type', width: 14 },
    { header: 'Fix Date', key: 'fix_date', width: 12 },
    { header: 'Tipe Kabel', key: 'cable_type', width: 14 },
    { header: 'Panjang Kabel', key: 'cable_length', width: 14 },
    { header: 'Nomor Port', key: 'port_number', width: 12 },
    { header: 'Status Kabel', key: 'cable_status', width: 14 },
    { header: 'Catatan Kabel', key: 'cable_notes', width: 28 }
];

const CUSTOMER_TEMPLATE_COLUMNS = [
    ...CUSTOMER_EXPORT_COLUMNS,
    ...CUSTOMER_IMPORT_EXTRA_COLUMNS
];

/** Alias header Excel (export / template / import lama) → field internal. */
const CUSTOMER_IMPORT_HEADER_ALIASES = {
    name: 'name',
    nama: 'name',
    phone: 'phone',
    telepon: 'phone',
    'nomor hp': 'phone',
    username: 'username',
    'login password': 'login_password',
    'password login': 'login_password',
    'kata sandi login': 'login_password',
    login_password: 'login_password',
    email: 'email',
    address: 'address',
    alamat: 'address',
    latitude: 'latitude',
    longitude: 'longitude',
    lintang: 'latitude',
    bujur: 'longitude',
    package: 'package_name',
    'package name': 'package_name',
    package_name: 'package_name',
    paket: 'package_name',
    'nama paket': 'package_name',
    'harga paket': 'package_price',
    'package id': 'package_id',
    'id paket': 'package_id',
    package_id: 'package_id',
    'id db': 'id',
    id: 'id',
    'kode pelanggan': 'customer_id',
    customer_id: 'customer_id',
    area: 'area',
    wilayah: 'area',
    kolektor: 'collector_name',
    collector_name: 'collector_name',
    'status layanan': 'status',
    status: 'status',
    'status bayar': 'payment_status',
    payment_status: 'payment_status',
    'pppoe username': 'pppoe_username',
    pppoe_username: 'pppoe_username',
    'pppoe password': 'pppoe_password',
    pppoe_password: 'pppoe_password',
    'pppoe profile': 'pppoe_profile',
    pppoe_profile: 'pppoe_profile',
    router: 'router_name',
    router_name: 'router_name',
    'router id': 'router_id',
    router_id: 'router_id',
    'auto suspension': 'auto_suspension',
    auto_suspension: 'auto_suspension',
    'billing day': 'billing_day',
    billing_day: 'billing_day',
    'join date': 'join_date',
    join_date: 'join_date',
    'tanggal gabung': 'join_date',
    'created at': 'created_at',
    created_at: 'created_at',
    'odp id': 'odp_id',
    odp_id: 'odp_id',
    'id odp': 'odp_id',
    'renewal type': 'renewal_type',
    renewal_type: 'renewal_type',
    'fix date': 'fix_date',
    fix_date: 'fix_date',
    'tipe kabel': 'cable_type',
    cable_type: 'cable_type',
    'panjang kabel': 'cable_length',
    cable_length: 'cable_length',
    port: 'port_number',
    'nomor port': 'port_number',
    port_number: 'port_number',
    'status kabel': 'cable_status',
    cable_status: 'cable_status',
    'catatan kabel': 'cable_notes',
    cable_notes: 'cable_notes'
};

function buildCustomerImportUnifiedHeaderMap(headerRow) {
    const headerMap = {};
    headerRow.eachCell((cell, colNumber) => {
        const key = String(cell.value || '').toLowerCase().trim();
        if (key) headerMap[key] = colNumber;
    });
    const unifiedHeaderMap = {};
    Object.keys(headerMap).forEach((key) => {
        const normalizedKey = CUSTOMER_IMPORT_HEADER_ALIASES[key] || key;
        unifiedHeaderMap[normalizedKey] = headerMap[key];
    });
    return unifiedHeaderMap;
}

function getCustomerImportWorksheet(workbook) {
    return workbook.getWorksheet('Pelanggan') || workbook.worksheets[0] || null;
}

async function buildCustomerImportTemplateWorkbook() {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Pelanggan');
    try {
        ws.views = [{ state: 'frozen', ySplit: 1 }];
    } catch (_) {
        /* opsional */
    }

    ws.columns = CUSTOMER_TEMPLATE_COLUMNS.map((col) => ({ ...col }));

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE8F5E9' }
    };

    ws.addRow({
        id: '',
        customer_id: '',
        username: '',
        name: 'Contoh Pelanggan',
        phone: '6281234567890',
        area: 'Wilayah A',
        collector_name: '',
        package_name: 'Paket 10 Mbps',
        package_price: 150000,
        status: 'active',
        payment_status: '',
        pppoe_username: 'userpppoe',
        pppoe_password: 'rahasiaPPP',
        pppoe_profile: 'default',
        router_name: '',
        router_id: '',
        email: 'nama@email.com',
        address: 'Jl. Contoh No. 1',
        latitude: -6.253011,
        longitude: 107.923009,
        package_id: '',
        auto_suspension: 1,
        billing_day: 15,
        join_date: '01/06/2020',
        created_at: '01/06/2020',
        login_password: '',
        odp_id: '',
        renewal_type: 'renewal',
        fix_date: '',
        cable_type: 'Fiber Optic',
        cable_length: 85,
        port_number: 1,
        cable_status: 'connected',
        cable_notes: 'Baris contoh — hapus sebelum import produksi'
    });

    const priceCol = ws.getColumn('package_price');
    if (priceCol) priceCol.numFmt = '#,##0';
    const phoneCol = ws.getColumn('phone');
    if (phoneCol) phoneCol.numFmt = '@';

    const help = workbook.addWorksheet('Petunjuk');
    help.getColumn(1).width = 28;
    help.getColumn(2).width = 88;
    const rows = [
        ['Kolom', 'Penjelasan'],
        ['Nama *', 'Nama lengkap pelanggan (wajib). Sama dengan kolom export.'],
        ['Phone *', 'Nomor HP (wajib). 628… dan 085… disimpan apa adanya (bisa beda langganan). Hanya angka 852… (tanpa 0/62) diperbaiki jadi 0852… karena Excel.'],
        ['Paket *', 'Nama paket sesuai menu Paket (wajib). Boleh isi Package ID sebagai alternatif.'],
        ['Username', 'Username login portal. Kosong = digenerate dari nomor HP.'],
        ['Login Password', 'Password login portal (bukan PPPoE).'],
        ['Area', 'Nama wilayah / cluster.'],
        ['PPPoE Username / Password', 'Login PPPoE; jika diisi sistem push ke RADIUS/Mikrotik.'],
        ['Router ID', 'ID router (angka) atau kosong untuk mode RADIUS.'],
        ['Status Layanan', 'active, suspended, register, isolir, dll. Default active.'],
        ['Auto Suspension', '1/ya = aktif, 0/tidak = nonaktif.'],
        ['Billing Day', 'Tanggal tagih 1–28. Default 15.'],
        ['Join Date / Created At', 'Tanggal bergabung pelanggan (dd/mm/yyyy). Join Date dan Created At harus sama; import memakai Join Date, jika kosong pakai Created At.'],
        ['ODP ID, Tipe/Panjang Kabel, Port, Status Kabel', 'Opsional; untuk data jalur kabel saat pelanggan baru.'],
        ['Kode Pelanggan, Kolektor, Harga Paket, Status Bayar', 'Kolom dari export — boleh diisi, diabaikan saat import.'],
        ['', 'Baris 2 sheet Pelanggan adalah CONTOH — hapus sebelum import produksi.'],
        ['', 'Format kolom sama dengan Export XLSX agar mudah bandingkan / restore data.']
    ];
    rows.forEach((r, i) => {
        const row = help.addRow(r);
        if (i === 0) row.font = { bold: true };
    });

    return workbook;
}

// Export customers to XLSX
router.get('/export/customers.xlsx', async (req, res) => {
    try {
        const { customers, joinMonth, joinYear, listFilters } = await loadCustomersForExport(req);
        const enrichedCustomers = await enrichCustomersForExport(customers);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Pelanggan');
        try {
            worksheet.views = [{ state: 'frozen', ySplit: 1 }];
        } catch (_) {
            /* opsional */
        }

        worksheet.columns = CUSTOMER_EXPORT_COLUMNS.map((col) => ({ ...col }));

        const headerRow = worksheet.getRow(1);
        headerRow.font = { bold: true };
        headerRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE6E6FA' }
        };

        for (const c of enrichedCustomers) {
            const row = worksheet.addRow({
                id: c.id || '',
                customer_id: c.customer_id || '',
                username: c.username || '',
                name: c.name || '',
                phone: c.phone || '',
                area: c.area || '',
                collector_name: c.collector_name || '',
                package_name: c.package_name || '',
                package_price: c.package_price != null ? Number(c.package_price) : '',
                status: c.status || '',
                payment_status: c.payment_status || '',
                pppoe_username: c.pppoe_username || '',
                pppoe_password: c.pppoe_password || '',
                pppoe_profile: c.pppoe_profile || 'default',
                router_name: c.router_name || '',
                router_id: c.router_id || '',
                email: c.email || '',
                address: c.address || '',
                latitude: c.latitude || '',
                longitude: c.longitude || '',
                package_id: c.package_id || '',
                auto_suspension: typeof c.auto_suspension !== 'undefined' ? c.auto_suspension : 1,
                billing_day: c.billing_day || 15,
                join_date: formatCustomerExportDate(c.join_date),
                created_at: formatCustomerExportDate(c.created_at || c.join_date)
            });
            if (c.latitude && c.longitude) {
                row.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFF0F8FF' }
                };
            }
        }

        const priceCol = worksheet.getColumn('package_price');
        if (priceCol) priceCol.numFmt = '#,##0';
        const phoneColExport = worksheet.getColumn('phone');
        if (phoneColExport) phoneColExport.numFmt = '@';

        const summarySheet = workbook.addWorksheet('Summary');
        const monthNames = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
        summarySheet.addRow(['Ringkasan Export Pelanggan']);
        if (listFilters && listFilters.month && listFilters.year) {
            const endDay = new Date(listFilters.year, listFilters.month, 0).getDate();
            summarySheet.addRow([
                'Periode (s/d akhir bulan)',
                `${monthNames[listFilters.month] || listFilters.month} ${listFilters.year} (${endDay} ${monthNames[listFilters.month] || listFilters.month} ${listFilters.year})`
            ]);
            if (listFilters.customer_type) summarySheet.addRow(['Jenis Pelanggan', listFilters.customer_type]);
            if (listFilters.payment_status) summarySheet.addRow(['Status Bayar', listFilters.payment_status]);
        } else if (joinMonth && joinYear) {
            summarySheet.addRow(['Filter Join Date', `${monthNames[joinMonth] || joinMonth} ${joinYear}`]);
        }
        summarySheet.addRow(['Total Pelanggan', enrichedCustomers.length]);
        summarySheet.addRow(['Dengan Koordinat', enrichedCustomers.filter((c) => c.latitude && c.longitude).length]);
        summarySheet.addRow(['Dengan Sandi PPPoE', enrichedCustomers.filter((c) => c.pppoe_password).length]);
        summarySheet.addRow(['Total Harga Paket', enrichedCustomers.reduce((s, c) => s + (Number(c.package_price) || 0), 0)]);
        summarySheet.addRow(['Tanggal Export', new Date().toLocaleString('id-ID')]);

        const stamp = new Date().toISOString().slice(0, 10);
        let monthPart = '';
        if (listFilters && listFilters.month && listFilters.year) {
            monthPart = `-${String(listFilters.year)}-${String(listFilters.month).padStart(2, '0')}`;
        } else if (joinMonth && joinYear) {
            monthPart = `-join-${String(joinMonth).padStart(2, '0')}-${joinYear}`;
        }
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="export-pelanggan${monthPart}-${stamp}.xlsx"`);
        await workbook.xlsx.write(res);
        if (!res.writableEnded) res.end();
    } catch (error) {
        logger.error('Error exporting customers (XLSX):', error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Error exporting customers (XLSX)', error: error.message });
        }
    }
});

/** Template impor / restore pelanggan — format kolom selaras export XLSX. */
router.get('/import/customers/template', async (req, res) => {
    try {
        const workbook = await buildCustomerImportTemplateWorkbook();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="template-import-pelanggan.xlsx"');
        await workbook.xlsx.write(res);
        if (!res.writableEnded) res.end();
    } catch (error) {
        logger.error('Error generating customer import template:', error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Gagal membuat template', error: error.message });
        }
    }
});

const IMPORT_STAGING_DIR = path.join(__dirname, '../tmp/customer-import-staging');
const importCommitJobs = new Map();
const IMPORT_COMMIT_JOB_DIR = path.join(IMPORT_STAGING_DIR, 'jobs');

function ensureImportStagingDir() {
    if (!fs.existsSync(IMPORT_STAGING_DIR)) {
        fs.mkdirSync(IMPORT_STAGING_DIR, { recursive: true });
    }
    if (!fs.existsSync(IMPORT_COMMIT_JOB_DIR)) {
        fs.mkdirSync(IMPORT_COMMIT_JOB_DIR, { recursive: true });
    }
}

function isValidStageId(stageId) {
    return /^[a-zA-Z0-9_-]{16,80}$/.test(String(stageId || ''));
}

function getStageFilePaths(stageId) {
    return {
        metaPath: path.join(IMPORT_STAGING_DIR, `${stageId}.json`),
        dataPath: path.join(IMPORT_STAGING_DIR, `${stageId}.bin`)
    };
}

function cleanupExpiredImportStages(maxAgeMs = 24 * 60 * 60 * 1000) {
    try {
        ensureImportStagingDir();
        const now = Date.now();
        const files = fs.readdirSync(IMPORT_STAGING_DIR);
        for (const file of files) {
            const fullPath = path.join(IMPORT_STAGING_DIR, file);
            try {
                const st = fs.statSync(fullPath);
                if ((now - st.mtimeMs) > maxAgeMs) {
                    fs.unlinkSync(fullPath);
                }
            } catch (_) {
                // ignore malformed file while cleaning
            }
        }
    } catch (_) {
        // ignore cleanup errors
    }
}

function cleanupExpiredCommitJobs(maxAgeMs = 6 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [jobId, job] of importCommitJobs.entries()) {
        const createdAtMs = new Date(job.created_at || now).getTime();
        if (!Number.isFinite(createdAtMs) || (now - createdAtMs) > maxAgeMs) {
            importCommitJobs.delete(jobId);
        }
    }
    try {
        ensureImportStagingDir();
        const files = fs.readdirSync(IMPORT_COMMIT_JOB_DIR);
        for (const file of files) {
            const p = path.join(IMPORT_COMMIT_JOB_DIR, file);
            try {
                const st = fs.statSync(p);
                if ((now - st.mtimeMs) > maxAgeMs) fs.unlinkSync(p);
            } catch (_) {
                // ignore cleanup issue
            }
        }
    } catch (_) {
        // ignore cleanup issue
    }
}

function getCommitJobFilePath(jobId) {
    return path.join(IMPORT_COMMIT_JOB_DIR, `${jobId}.json`);
}

function persistCommitJob(job) {
    try {
        ensureImportStagingDir();
        fs.writeFileSync(getCommitJobFilePath(job.job_id), JSON.stringify(job));
    } catch (e) {
        logger.warn('Failed to persist commit job status:', e.message);
    }
}

function loadCommitJob(jobId) {
    try {
        const p = getCommitJobFilePath(jobId);
        if (!fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && parsed.job_id ? parsed : null;
    } catch (_) {
        return null;
    }
}

/** Gabung progress dari memori + disk (hindari persen mundur saat polling). */
function mergeImportProgress(a, b) {
    if (!a) return b || null;
    if (!b) return a || null;
    const processedA = Number(a.processed_rows || 0);
    const processedB = Number(b.processed_rows || 0);
    return processedB >= processedA ? b : a;
}

function getCommitJobState(jobId) {
    const fromMap = importCommitJobs.get(jobId) || null;
    const fromDisk = loadCommitJob(jobId);
    if (!fromMap && !fromDisk) return null;
    const merged = { ...(fromDisk || {}), ...(fromMap || {}) };
    merged.progress = mergeImportProgress(fromMap && fromMap.progress, fromDisk && fromDisk.progress);
    importCommitJobs.set(jobId, merged);
    return merged;
}

function createImportCaptureResponse() {
    const capture = {
        headersSent: false,
        statusCode: 200,
        body: null,
        status(code) {
            capture.statusCode = code;
            return capture;
        },
        setHeader() {
            return capture;
        },
        end() {},
        json(payload) {
            capture.body = payload;
        }
    };
    return capture;
}

async function runStagedCustomerImport(req, { buffer, meta, jobId }) {
    const priorFile = req.file;
    const headerBackup = {
        fast: req.headers['x-import-fast-mode'],
        job: req.headers['x-import-job-id'],
        total: req.headers['x-import-total-rows'],
        bypass: req.headers['x-import-bypass-once']
    };
    try {
        req.file = {
            buffer,
            originalname: meta.original_name || `import.${meta.source_type}`,
            mimetype: meta.mime_type || ''
        };
        req.headers['x-import-fast-mode'] = '1';
        req.headers['x-import-job-id'] = jobId;
        req.headers['x-import-total-rows'] = String(meta.total_rows || 0);
        if (headerBackup.bypass === undefined) {
            req.headers['x-import-bypass-once'] = '';
        }

        const capture = createImportCaptureResponse();
        if (meta.source_type === 'xlsx') {
            await runCustomerXlsxImport(req, capture);
        } else if (meta.source_type === 'json') {
            await runCustomerJsonImport(req, capture);
        } else {
            throw new Error('Jenis file import tidak didukung');
        }

        if (capture.statusCode >= 400 || !capture.body || !capture.body.success) {
            const msg = (capture.body && (capture.body.message || capture.body.error))
                || `Import gagal (HTTP ${capture.statusCode})`;
            throw new Error(msg);
        }
        return capture.body;
    } finally {
        req.file = priorFile;
        if (headerBackup.fast === undefined) delete req.headers['x-import-fast-mode'];
        else req.headers['x-import-fast-mode'] = headerBackup.fast;
        if (headerBackup.job === undefined) delete req.headers['x-import-job-id'];
        else req.headers['x-import-job-id'] = headerBackup.job;
        if (headerBackup.total === undefined) delete req.headers['x-import-total-rows'];
        else req.headers['x-import-total-rows'] = headerBackup.total;
        if (headerBackup.bypass === undefined) delete req.headers['x-import-bypass-once'];
        else req.headers['x-import-bypass-once'] = headerBackup.bypass;
    }
}

function updateCommitJob(jobId, patch = {}) {
    if (!jobId) return null;
    const fromMap = importCommitJobs.get(jobId) || null;
    const base = fromMap || loadCommitJob(jobId);
    if (!base) return null;
    const next = { ...base, ...patch };
    importCommitJobs.set(jobId, next);
    persistCommitJob(next);
    return next;
}

async function parseImportFileSummary({ sourceType, buffer }) {
    if (sourceType === 'xlsx') {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const worksheet = getCustomerImportWorksheet(workbook);
        if (!worksheet) {
            throw new Error('Worksheet tidak ditemukan dalam file XLSX');
        }
        let totalRows = 0;
        for (let i = 2; i <= worksheet.rowCount; i++) {
            const row = worksheet.getRow(i);
            let hasValue = false;
            row.eachCell({ includeEmpty: false }, (cell) => {
                const val = cell.value;
                if (val !== null && val !== undefined && String(val).trim() !== '') hasValue = true;
            });
            if (hasValue) totalRows++;
        }
        return { total_rows: totalRows };
    }

    const content = buffer.toString('utf8');
    let payload;
    try {
        payload = JSON.parse(content);
    } catch (_) {
        throw new Error('Format JSON tidak valid');
    }
    const items = Array.isArray(payload) ? payload : (payload.customers || []);
    if (!Array.isArray(items)) {
        throw new Error('Format JSON tidak valid (harus array atau { customers: [] })');
    }
    return { total_rows: items.length };
}

router.post('/import/customers/stage', upload.single('file'), async (req, res) => {
    try {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ success: false, message: 'File import tidak ditemukan' });
        }

        cleanupExpiredImportStages();
        ensureImportStagingDir();

        const originalName = String(req.file.originalname || 'import-file').trim();
        const lowerName = originalName.toLowerCase();
        const sourceType = lowerName.endsWith('.xlsx') ? 'xlsx' : (lowerName.endsWith('.json') ? 'json' : null);
        if (!sourceType) {
            return res.status(400).json({ success: false, message: 'Format file harus .xlsx atau .json' });
        }

        const summary = await parseImportFileSummary({ sourceType, buffer: req.file.buffer });
        const stageId = `stg_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
        const createdAtIso = new Date().toISOString();
        const expiresAtIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const { metaPath, dataPath } = getStageFilePaths(stageId);

        const meta = {
            stage_id: stageId,
            source_type: sourceType,
            original_name: originalName,
            mime_type: req.file.mimetype || '',
            byte_size: req.file.buffer.length,
            total_rows: summary.total_rows || 0,
            created_at: createdAtIso,
            expires_at: expiresAtIso
        };

        fs.writeFileSync(dataPath, req.file.buffer);
        fs.writeFileSync(metaPath, JSON.stringify(meta));

        return res.json({
            success: true,
            stage_id: stageId,
            source_type: sourceType,
            original_name: originalName,
            total_rows: meta.total_rows,
            created_at: createdAtIso,
            expires_at: expiresAtIso
        });
    } catch (error) {
        logger.error('Error staging customer import file:', error);
        return res.status(500).json({
            success: false,
            message: 'Gagal upload file ke staging',
            error: error.message
        });
    }
});

router.post('/import/customers/commit/:stageId', async (req, res) => {
    try {
        const stageId = String(req.params.stageId || '').trim();
        if (!isValidStageId(stageId)) {
            return res.status(400).json({ success: false, message: 'stage_id tidak valid' });
        }

        ensureImportStagingDir();
        const { metaPath, dataPath } = getStageFilePaths(stageId);
        if (!fs.existsSync(metaPath) || !fs.existsSync(dataPath)) {
            return res.status(404).json({ success: false, message: 'Data staging tidak ditemukan atau sudah kedaluwarsa' });
        }

        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const sourceType = meta && meta.source_type;
        if (sourceType !== 'xlsx' && sourceType !== 'json') {
            return res.status(400).json({ success: false, message: 'Jenis staging file tidak didukung' });
        }

        cleanupExpiredCommitJobs();
        const existingJobEntry = Array.from(importCommitJobs.values()).find(
            (j) => j && j.stage_id === stageId && (j.status === 'queued' || j.status === 'running')
        );
        if (existingJobEntry) {
            return res.json({
                success: true,
                queued: true,
                stage_id: stageId,
                source_type: sourceType,
                job_id: existingJobEntry.job_id
            });
        }

        const jobId = `job_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        const job = {
            job_id: jobId,
            stage_id: stageId,
            source_type: sourceType,
            status: 'queued',
            created_at: new Date().toISOString(),
            started_at: null,
            finished_at: null,
            result: null,
            error: null,
            progress: {
                total_rows: Number(meta.total_rows || 0),
                processed_rows: 0,
                success_rows: 0,
                failed_rows: 0,
                percentage: 0
            }
        };
        importCommitJobs.set(jobId, job);
        persistCommitJob(job);

        setImmediate(async () => {
            job.status = 'running';
            job.started_at = new Date().toISOString();
            persistCommitJob(job);
            try {
                const dataBuffer = fs.readFileSync(dataPath);
                const upstreamJson = await runStagedCustomerImport(req, {
                    buffer: dataBuffer,
                    meta,
                    jobId
                });

                job.status = 'finished';
                job.result = {
                    success: true,
                    stage_id: stageId,
                    source_type: sourceType,
                    ...upstreamJson
                };
                persistCommitJob(job);
                try {
                    fs.unlinkSync(metaPath);
                    fs.unlinkSync(dataPath);
                } catch (_) {
                    // non-fatal
                }
            } catch (err) {
                job.status = 'failed';
                job.error = String(err && err.message ? err.message : err);
                persistCommitJob(job);
                logger.error('Background import commit failed:', err);
            } finally {
                job.finished_at = new Date().toISOString();
                persistCommitJob(job);
            }
        });

        return res.json({
            success: true,
            queued: true,
            stage_id: stageId,
            source_type: sourceType,
            job_id: jobId
        });
    } catch (error) {
        logger.error('Error committing staged customer import:', error);
        return res.status(500).json({
            success: false,
            message: 'Gagal memproses import dari staging',
            error: error.message
        });
    }
});

router.get('/import/customers/commit-status/:jobId', async (req, res) => {
    try {
        const jobId = String(req.params.jobId || '').trim();
        if (!jobId) {
            return res.status(400).json({ success: false, message: 'job_id wajib diisi' });
        }
        const job = getCommitJobState(jobId);
        if (!job) {
            return res.status(404).json({ success: false, message: 'Job import tidak ditemukan atau sudah kedaluwarsa' });
        }

        if (job.status === 'finished') {
            return res.json({
                success: true,
                status: 'finished',
                ...job.result,
                progress: job.progress || null,
                job_id: jobId
            });
        }

        if (job.status === 'failed') {
            return res.json({
                success: false,
                status: 'failed',
                message: job.error || 'Job import gagal',
                progress: job.progress || null,
                job_id: jobId
            });
        }

        return res.json({
            success: true,
            status: job.status,
            stage_id: job.stage_id,
            source_type: job.source_type,
            progress: job.progress || null,
            job_id: jobId
        });
    } catch (error) {
        logger.error('Error getting commit job status:', error);
        return res.status(500).json({
            success: false,
            message: 'Gagal mengambil status commit import',
            error: error.message
        });
    }
});

// Import customers from XLSX file
async function runCustomerXlsxImport(req, res) {
    let db = null;
    let dbRun = null;
    let transactionStarted = false;
    try {
        const importFastMode = String(req.headers['x-import-fast-mode'] || '').trim() === '1';
        const bypassRequested = String(req.headers['x-import-bypass-once'] || '').trim() === '1';
        const importBypassMode = bypassRequested ? consumeOneTimeImportBypass() : false;
        const importJobId = String(req.headers['x-import-job-id'] || '').trim();
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'File XLSX tidak ditemukan' });
        }

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(req.file.buffer);
        const worksheet = getCustomerImportWorksheet(workbook);
        if (!worksheet) {
            return res.status(400).json({ success: false, message: 'Worksheet tidak ditemukan dalam file' });
        }

        const headerRow = worksheet.getRow(1);
        const unifiedHeaderMap = buildCustomerImportUnifiedHeaderMap(headerRow);

        const getVal = (row, key) => {
            const col = unifiedHeaderMap[key];
            return col ? (row.getCell(col).value ?? '') : '';
        };

        db = require('../config/billing').db;
        await ensureCustomersPhoneNonUnique(db);
        dbRun = (sql, params = []) => new Promise((resolve, reject) => {
            db.run(sql, params, function (err) {
                if (err) return reject(err);
                resolve(this);
            });
        });
        const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
        });

        // Revert log table for import operations
        await dbRun(`
            CREATE TABLE IF NOT EXISTS import_customer_operations (
                id TEXT PRIMARY KEY,
                source_type TEXT NOT NULL,
                created_count INTEGER NOT NULL DEFAULT 0,
                updated_count INTEGER NOT NULL DEFAULT 0,
                failed_count INTEGER NOT NULL DEFAULT 0,
                created_ids_json TEXT NOT NULL DEFAULT '[]',
                updated_before_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            )
        `);
        const useAtomicImport = !importFastMode;
        if (useAtomicImport) {
            await dbRun('BEGIN IMMEDIATE');
            transactionStarted = true;
        }

        let created = 0, updated = 0, failed = 0;
        const errors = [];
        const radiusSync = { attempted: 0, success: 0, failed: 0, skipped: 0 };
        const opCreatedIds = [];
        const opUpdatedBefore = [];
        const stagedTotal = parseInt(String(req.headers['x-import-total-rows'] || ''), 10);
        const totalRowsForProgress = (Number.isFinite(stagedTotal) && stagedTotal > 0)
            ? stagedTotal
            : Math.max(worksheet.rowCount - 1, 0);
        let processedRows = 0;
        let successRows = 0;
        const reportProgress = (force = false) => {
            if (!importJobId) return;
            if (!force && processedRows % 5 !== 0 && processedRows !== totalRowsForProgress) return;
            const percentage = totalRowsForProgress > 0
                ? Math.min(99, Math.floor((processedRows / totalRowsForProgress) * 100))
                : 99;
            updateCommitJob(importJobId, {
                progress: {
                    total_rows: totalRowsForProgress,
                    processed_rows: processedRows,
                    success_rows: successRows,
                    failed_rows: failed,
                    percentage
                }
            });
        };

        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // skip header
            try {
                const name = String(getVal(row, 'name') || '').trim();
                const phoneRawVal = getVal(row, 'phone');
                const phoneRawDigits = (() => {
                    if (phoneRawVal == null || phoneRawVal === '') return '';
                    if (typeof phoneRawVal === 'number' && Number.isFinite(phoneRawVal)) {
                        return String(Math.trunc(phoneRawVal));
                    }
                    return String(phoneRawVal).replace(/\D/g, '');
                })();
                if (!name || !phoneRawDigits || phoneRawDigits.length < 9) {
                    failed++; errors.push({ row: rowNumber, name, phone: phoneRawDigits, error: 'Nama/Phone wajib' }); return;
                }
                if (/^contoh\b/i.test(name)) {
                    return;
                }

                const cellStr = (key) => String(getVal(row, key) ?? '').trim();
                const cellNum = (key) => {
                    const v = getVal(row, key);
                    if (v === '' || v === null || v === undefined) return null;
                    const n = Number(String(v).replace(',', '.'));
                    return Number.isFinite(n) ? n : null;
                };
                const raw = {
                    name,
                    phone: phoneRawVal,
                    username: cellStr('username'),
                    login_password: cellStr('login_password') || cellStr('billing_password'),
                    pppoe_username: String(getVal(row, 'pppoe_username') || '').trim(),
                    pppoe_password: String(getVal(row, 'pppoe_password') || '').trim(),
                    email: String(getVal(row, 'email') || '').trim(),
                    address: String(getVal(row, 'address') || '').trim(),
                    latitude: cellNum('latitude'),
                    longitude: cellNum('longitude'),
                    package_id: getVal(row, 'package_id') ? Number(getVal(row, 'package_id')) : null,
                    package_name: cellStr('package_name') || cellStr('package'),
                    odp_id: cellNum('odp_id'),
                    area: cellStr('area'),
                    join_date: resolveImportJoinDate(getVal, row),
                    pppoe_profile: String(getVal(row, 'pppoe_profile') || 'default').trim(),
                    status: String(getVal(row, 'status') || 'active').trim(),
                    router_id: getVal(row, 'router_id') ? (isNaN(getVal(row, 'router_id')) ? getVal(row, 'router_id') : Number(getVal(row, 'router_id'))) : null,
                    auto_suspension: (() => {
                        const v = String(getVal(row, 'auto_suspension') ?? '').trim().toLowerCase();
                        if (v === '') return 1;
                        if (['ya', 'yes', 'y', 'true', 'aktif', 'on', '1'].includes(v)) return 1;
                        if (['tidak', 'no', 'n', 'false', 'nonaktif', 'off', '0'].includes(v)) return 0;
                        const n = parseInt(v, 10);
                        return Number.isFinite(n) ? (n ? 1 : 0) : 1;
                    })(),
                    billing_day: (() => {
                        const rawVal = getVal(row, 'billing_day');
                        const rawStr = String(rawVal ?? '').trim();
                        if (rawStr === '') return 15;
                        const v = parseInt(rawStr, 10);
                        return Number.isFinite(v) ? Math.min(Math.max(v, 1), 28) : 15;
                    })(),
                    renewal_type: cellStr('renewal_type') || undefined,
                    fix_date: cellNum('fix_date'),
                    cable_type: cellStr('cable_type') || undefined,
                    cable_length: cellNum('cable_length'),
                    port_number: cellNum('port_number'),
                    cable_status: cellStr('cable_status') || undefined,
                    cable_notes: cellStr('cable_notes') || undefined
                };

                // Process upsert
                // Wrap in async using IIFE pattern not available here; queue in array then Promise.all is complex.
                // For simplicity, push to pending array.
                row._pending = raw; // temp store
            } catch (e) {
                failed++;
                errors.push({ row: rowNumber, error: e.message });
            }
        });

        const normalizePackageName = (v) => String(v || '')
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ');
        const normalizePackageCompact = (v) => normalizePackageName(v).replace(/\s+/g, '');

        const activePackages = await billingManager.getPackages();
        const allPackagesByIdMap = await billingManager.getAllPackagesByIdMap();
        const allPackages = Array.from(allPackagesByIdMap.values());
        const packageCandidates = allPackages.length ? allPackages : activePackages;
        const packageByName = new Map();
        const packageByCompactName = new Map();
        const packageById = new Map();
        packageCandidates
            .filter(pkg => pkg && pkg.id != null)
            .forEach((pkg) => {
                packageById.set(Number(pkg.id), pkg);
                const norm = normalizePackageName(pkg.name);
                const compact = normalizePackageCompact(pkg.name);
                if (norm) packageByName.set(norm, pkg);
                if (compact) packageByCompactName.set(compact, pkg);
            });

        const resolveAreaIdByName = async (areaName) => {
            const area = String(areaName || '').trim();
            if (!area) return null;
            return await new Promise((resolve) => {
                db.get(
                    `SELECT id FROM areas WHERE LOWER(TRIM(nama_area)) = LOWER(TRIM(?)) LIMIT 1`,
                    [area],
                    (err, row) => {
                        if (err) return resolve(null);
                        resolve(row && row.id ? row.id : null);
                    }
                );
            });
        };

        // Now sequentially process rows for DB ops
        for (let r = 2; r <= worksheet.rowCount; r++) {
            const row = worksheet.getRow(r);
            const raw = row._pending;
            if (!raw) continue;
            try {
                // Validasi data wajib
                if (!raw.name || raw.phone == null || raw.phone === '') {
                    failed++;
                    errors.push({ row: r, name: raw.name || '', phone: raw.phone || '', error: 'Nama dan nomor telepon wajib diisi' });
                    continue;
                }

                // Validasi nomor telepon format (nilai mentah dari Excel — belum diperbaiki)
                const phoneForFormatCheck = typeof raw.phone === 'number'
                    ? String(Math.trunc(raw.phone))
                    : String(raw.phone).trim();
                const phoneRegex = /^[0-9+\-\s()]+$/;
                if (!phoneRegex.test(phoneForFormatCheck)) {
                    failed++;
                    errors.push({ row: r, name: raw.name || '', phone: phoneForFormatCheck, error: 'Format nomor telepon tidak valid' });
                    continue;
                }

                // Setelah lolos validasi: perbaiki hanya kasus Excel (852→0852), 628/085 tetap beda
                const phoneStored = parsePhoneFromSpreadsheetCell(raw.phone);
                if (!phoneStored) {
                    failed++;
                    errors.push({ row: r, name: raw.name || '', phone: phoneForFormatCheck, error: 'Nomor telepon tidak valid' });
                    continue;
                }

                let resolvedPackageId = null;
                if (raw.package_id != null && Number.isFinite(raw.package_id) && packageById.has(Number(raw.package_id))) {
                    resolvedPackageId = raw.package_id;
                } else if (raw.package_name) {
                    const packageText = String(raw.package_name).trim();
                    // fallback: user accidentally puts numeric id in package column
                    const numericFromText = Number(packageText);
                    if (Number.isFinite(numericFromText) && packageById.has(numericFromText)) {
                        resolvedPackageId = numericFromText;
                    } else {
                        const pkg =
                            packageByName.get(normalizePackageName(packageText)) ||
                            packageByCompactName.get(normalizePackageCompact(packageText));
                        if (pkg && pkg.id) {
                            resolvedPackageId = pkg.id;
                        }
                    }
                }
                if (!resolvedPackageId) {
                    failed++;
                    errors.push({
                        row: r,
                        name: raw.name || '',
                        phone: raw.phone || '',
                        error: `Paket tidak ditemukan: "${raw.package_name || raw.package_id || ''}". Gunakan nama paket yang sesuai.`
                    });
                    processedRows++;
                    reportProgress();
                    continue;
                }

                const resolvedAreaId = await resolveAreaIdByName(raw.area);

                const pppoeUsernameKey = String(raw.pppoe_username || '').trim();
                if (!pppoeUsernameKey) {
                    failed++;
                    errors.push({
                        row: r,
                        name: raw.name || '',
                        phone: raw.phone || '',
                        error: 'PPPoE username wajib diisi'
                    });
                    processedRows++;
                    reportProgress();
                    continue;
                }
                const existing = await dbGet(
                    `SELECT * FROM customers WHERE TRIM(COALESCE(pppoe_username, '')) = ? LIMIT 1`,
                    [pppoeUsernameKey]
                );
                const customerData = {
                    name: raw.name.trim(),
                    phone: phoneStored,
                    pppoe_username: raw.pppoe_username ? raw.pppoe_username.trim() : '',
                    pppoe_password: raw.pppoe_password ? raw.pppoe_password.trim() : '',
                    email: raw.email ? raw.email.trim() : '',
                    address: raw.address ? raw.address.trim() : '',
                    package_id: resolvedPackageId,
                    pppoe_profile: raw.pppoe_profile || 'default',
                    status: raw.status || 'active',
                    auto_suspension: typeof raw.auto_suspension !== 'undefined' ? parseInt(raw.auto_suspension, 10) : 1,
                    billing_day: raw.billing_day ? Math.min(Math.max(parseInt(raw.billing_day, 10), 1), 28) : 15
                };
                if (importFastMode) {
                    customerData.__skip_genieacs_sync = true;
                    customerData.__skip_radius_sync = true;
                }
                if (raw.username) customerData.username = raw.username.trim();
                if (raw.login_password) customerData.password = raw.login_password;
                if (raw.latitude != null) customerData.latitude = raw.latitude;
                if (raw.longitude != null) customerData.longitude = raw.longitude;
                if (raw.area) customerData.area = raw.area;
                if (resolvedAreaId != null) customerData.area_id = resolvedAreaId;
                if (raw.odp_id != null) customerData.odp_id = raw.odp_id;
                if (raw.renewal_type) customerData.renewal_type = raw.renewal_type;
                if (raw.fix_date != null) customerData.fix_date = raw.fix_date;
                if (raw.cable_type) customerData.cable_type = raw.cable_type;
                if (raw.cable_length != null) customerData.cable_length = raw.cable_length;
                if (raw.port_number != null) customerData.port_number = raw.port_number;
                if (raw.cable_status) customerData.cable_status = raw.cable_status;
                if (raw.cable_notes) customerData.cable_notes = raw.cable_notes;

                let result;
                if (existing) {
                    const beforeSnapshot = importFastMode ? null : await dbGet(`SELECT * FROM customers WHERE id = ?`, [existing.id]);
                    result = await billingManager.updateCustomer(existing.phone, customerData);
                    if (raw.join_date) {
                        await applyCustomerJoinAndCreatedDates(db, existing.id, raw.join_date);
                    }
                    if (beforeSnapshot) opUpdatedBefore.push(beforeSnapshot);
                    updated++;
                    successRows++;
                    logger.info(`Updated customer: ${raw.name} (${phoneStored})`);
                } else {
                    if (raw.join_date) customerData.join_date = raw.join_date;
                    result = await billingManager.createCustomer(customerData);
                    if (raw.join_date && result && result.id) {
                        await applyCustomerJoinAndCreatedDates(db, result.id, raw.join_date);
                    }
                    if (result && result.id) opCreatedIds.push(result.id);
                    created++;
                    successRows++;
                    logger.info(`Created customer: ${raw.name} (${raw.phone}) with ID: ${result.id}`);
                }

                // Handle PPPoE user creation/update if pppoe_username and password provided
                if (!importFastMode && raw.pppoe_username && raw.pppoe_password) {
                    try {
                        const pppoe_username = String(raw.pppoe_username).trim();
                        const pppoe_password = String(raw.pppoe_password).trim();
                        const pppoe_profile = raw.pppoe_profile || 'default';
                        const router_id = raw.router_id || null;

                        if (pppoe_username && pppoe_password) {
                            const { addPPPoEUser, getUserAuthModeAsync } = require('../config/mikrotik');
                            
                            // Helper function untuk get router by ID
                            const getRouterById = async (routerId) => {
                                try {
                                    const db = require('../config/billing').db;
                                    return new Promise((resolve, reject) => {
                                        db.get('SELECT * FROM routers WHERE id = ?', [parseInt(routerId)], (err, row) => {
                                            if (err) reject(err);
                                            else resolve(row || null);
                                        });
                                    });
                                } catch (err) {
                                    logger.warn(`Failed to get router by ID ${routerId}: ${err.message}`);
                                    return null;
                                }
                            };

                            // Get customer data after create/update to ensure we have the ID
                            const customer = await billingManager.getCustomerByPhone(raw.phone);
                            if (!customer || !customer.id) {
                                logger.error(`[IMPORT] Customer not found or missing ID for phone ${raw.phone}`);
                                throw new Error(`Customer not found or missing ID for phone ${raw.phone}`);
                            }

                            const authMode = await getUserAuthModeAsync();
                            logger.info(`[IMPORT] Creating/updating PPPoE user ${pppoe_username} with profile ${pppoe_profile} (Mode: ${authMode}) for customer ${customer.id}`);

                            // Handle router_id: jika "RADIUS", set routerObj ke null
                            let routerObj = null;
                            if (router_id && router_id !== '' && router_id !== 'RADIUS' && router_id !== 'radius') {
                                routerObj = await getRouterById(router_id);
                                if (routerObj) {
                                    logger.info(`[IMPORT] Using router: ${routerObj.name} (${routerObj.nas_ip})`);
                                }
                            }

                            logger.info(`[IMPORT] Calling addPPPoEUser with: username=${pppoe_username}, profile=${pppoe_profile}, customer.id=${customer.id}`);
                            const addRes = await addPPPoEUser({ 
                                username: pppoe_username, 
                                password: pppoe_password, 
                                profile: pppoe_profile, 
                                customer: { id: customer.id },
                                routerObj: routerObj
                            });

                            if (addRes && addRes.success) {
                                logger.info(`✅ [IMPORT] PPPoE user ${pppoe_username} created/updated successfully in ${authMode} mode`);
                            } else {
                                const errorMsg = addRes?.message || addRes?.error || 'Unknown error';
                                logger.error(`❌ [IMPORT] Failed to create/update PPPoE user ${pppoe_username}: ${errorMsg}`);
                                logger.error(`[IMPORT] Full response:`, JSON.stringify(addRes));
                            }
                        } else {
                            logger.warn(`[IMPORT] Skipping PPPoE user creation: username or password is empty for phone ${raw.phone}`);
                        }
                    } catch (pppoeError) {
                        logger.error(`[IMPORT] Error creating/updating PPPoE user for ${raw.phone}:`, pppoeError);
                        logger.error(`[IMPORT] Error stack:`, pppoeError.stack);
                        // Don't fail the import if PPPoE creation fails, but log the error
                        errors.push({ row: r, error: `PPPoE creation failed: ${pppoeError.message}` });
                    }
                } else if (!importFastMode) {
                    logger.debug(`[IMPORT] Skipping PPPoE user creation for ${raw.phone}: pppoe_username or pppoe_password not provided`);
                } else {
                    logger.debug(`[IMPORT] Fast mode enabled: skip PPPoE provisioning for ${raw.phone}`);
                }

                // Fast mode: skip sinkron RADIUS per baris (import massal jauh lebih cepat).
                if (importFastMode) {
                    const radiusUsername = (customerData.pppoe_username || (existing && existing.pppoe_username) || '').trim();
                    if (radiusUsername) radiusSync.skipped++;
                }
                processedRows++;
                reportProgress();
            } catch (e) {
                failed++;
                errors.push({ row: r, name: raw && raw.name ? raw.name : '', phone: raw && raw.phone ? raw.phone : '', error: e.message });
                logger.error(`Error processing row ${r}:`, e);
                processedRows++;
                reportProgress();
            }
        }

        const operationId = `import_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        if (useAtomicImport) {
            await dbRun(
                `INSERT INTO import_customer_operations
                (id, source_type, created_count, updated_count, failed_count, created_ids_json, updated_before_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    operationId,
                    'xlsx',
                    created,
                    updated,
                    failed,
                    JSON.stringify(opCreatedIds),
                    JSON.stringify(opUpdatedBefore)
                ]
            );
            await dbRun('COMMIT');
            transactionStarted = false;
        }
        if (importJobId) {
            updateCommitJob(importJobId, {
                progress: {
                    total_rows: totalRowsForProgress,
                    processed_rows: totalRowsForProgress,
                    success_rows: created + updated,
                    failed_rows: failed,
                    percentage: 100
                }
            });
        }

        const responsePayload = {
            success: true,
            operation_id: useAtomicImport ? operationId : null,
            summary: {
                created,
                updated,
                failed,
                total: Math.max(worksheet.rowCount - 1, 0),
                success_count: created + updated,
                bypass_mode: true,
                match_key: 'pppoe_username',
                radius_sync: radiusSync
            },
            errors
        };
        if (importJobId) {
            updateCommitJob(importJobId, {
                status: 'finished',
                result: responsePayload,
                finished_at: new Date().toISOString(),
                progress: {
                    total_rows: totalRowsForProgress,
                    processed_rows: totalRowsForProgress,
                    success_rows: created + updated,
                    failed_rows: failed,
                    percentage: 100
                }
            });
        }
        res.json(responsePayload);
    } catch (error) {
        if (transactionStarted && dbRun) {
            try {
                await dbRun('ROLLBACK');
            } catch (rollbackError) {
                logger.error('Error rolling back XLSX import transaction:', rollbackError);
            }
        }
        const importJobId = String(req.headers['x-import-job-id'] || '').trim();
        if (importJobId) {
            updateCommitJob(importJobId, {
                status: 'failed',
                error: error.message,
                finished_at: new Date().toISOString()
            });
        }
        logger.error('Error importing customers (XLSX):', error);
        res.status(500).json({ success: false, message: 'Error importing customers (XLSX)', error: error.message });
    }
}
router.post('/import/customers/xlsx', upload.single('file'), runCustomerXlsxImport);

// Get latest customer import operation result (for frontend recovery when network drops)
router.get('/import/customers/last-operation', async (req, res) => {
    try {
        const db = require('../config/billing').db;
        const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
        });

        const sourceType = String(req.query.source_type || '').trim().toLowerCase();
        const sinceMsRaw = Number(req.query.since_ms || 0);
        const sinceMs = Number.isFinite(sinceMsRaw) ? sinceMsRaw : 0;
        const maxAgeSecRaw = Number(req.query.max_age_sec || 900);
        const maxAgeSec = Number.isFinite(maxAgeSecRaw) ? Math.min(Math.max(maxAgeSecRaw, 30), 7200) : 900;

        let sql = `
            SELECT id, source_type, created_count, updated_count, failed_count, created_at
            FROM import_customer_operations
        `;
        const params = [];
        if (sourceType === 'xlsx' || sourceType === 'json') {
            sql += ' WHERE source_type = ?';
            params.push(sourceType);
        }
        sql += ' ORDER BY datetime(created_at) DESC LIMIT 1';

        const op = await dbGet(sql, params);
        if (!op) {
            return res.json({ success: true, found: false });
        }

        const createdAtMs = new Date(`${op.created_at}Z`).getTime();
        const nowMs = Date.now();
        const ageMs = Number.isFinite(createdAtMs) ? (nowMs - createdAtMs) : Number.POSITIVE_INFINITY;
        const tooOld = ageMs > (maxAgeSec * 1000);
        const olderThanRequest = sinceMs > 0 && Number.isFinite(createdAtMs) && createdAtMs < (sinceMs - 15000);
        if (tooOld || olderThanRequest) {
            return res.json({ success: true, found: false });
        }

        return res.json({
            success: true,
            found: true,
            operation: {
                id: op.id,
                source_type: op.source_type,
                created_at: op.created_at,
                summary: {
                    created: Number(op.created_count || 0),
                    updated: Number(op.updated_count || 0),
                    failed: Number(op.failed_count || 0),
                    success_count: Number(op.created_count || 0) + Number(op.updated_count || 0),
                    total: Number(op.created_count || 0) + Number(op.updated_count || 0) + Number(op.failed_count || 0)
                }
            }
        });
    } catch (error) {
        logger.error('Error getting latest import operation:', error);
        return res.status(500).json({
            success: false,
            message: 'Gagal mengambil data operasi import terakhir',
            error: error.message
        });
    }
});

// Revert customer import operation (created rows deleted, updated rows restored)
router.post('/import/customers/revert/:operationId', async (req, res) => {
    try {
        const operationId = String(req.params.operationId || '').trim();
        if (!operationId) {
            return res.status(400).json({ success: false, message: 'operation_id wajib diisi' });
        }

        const db = require('../config/billing').db;
        const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
            db.run(sql, params, function (err) {
                if (err) return reject(err);
                resolve(this);
            });
        });
        const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
        });
        const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
        });

        const op = await dbGet(`SELECT * FROM import_customer_operations WHERE id = ?`, [operationId]);
        if (!op) {
            return res.status(404).json({ success: false, message: 'Data operasi import tidak ditemukan' });
        }

        const createdIds = JSON.parse(op.created_ids_json || '[]').filter(Number.isFinite);
        const updatedBefore = JSON.parse(op.updated_before_json || '[]').filter(x => x && Number.isFinite(x.id));

        const customerColumns = (await dbAll(`PRAGMA table_info(customers)`)).map(c => c.name);
        const restorableColumns = customerColumns.filter(c => c !== 'id');

        let revertedCreated = 0;
        let revertedUpdated = 0;

        await dbRun('BEGIN IMMEDIATE');
        try {
            // restore updated rows to "before" snapshot
            for (const prev of updatedBefore) {
                const setCols = restorableColumns.filter(col => Object.prototype.hasOwnProperty.call(prev, col));
                if (!setCols.length) continue;
                const sql = `UPDATE customers SET ${setCols.map(c => `"${c}" = ?`).join(', ')} WHERE id = ?`;
                const params = setCols.map(c => prev[c]);
                params.push(prev.id);
                const r = await dbRun(sql, params);
                revertedUpdated += (r && r.changes) ? r.changes : 0;
            }

            // delete created rows
            const chunkSize = 300;
            for (let i = 0; i < createdIds.length; i += chunkSize) {
                const chunk = createdIds.slice(i, i + chunkSize);
                if (!chunk.length) continue;
                const placeholders = chunk.map(() => '?').join(', ');
                const r = await dbRun(`DELETE FROM customers WHERE id IN (${placeholders})`, chunk);
                revertedCreated += (r && r.changes) ? r.changes : 0;
            }

            await dbRun(`DELETE FROM import_customer_operations WHERE id = ?`, [operationId]);
            await dbRun('COMMIT');
        } catch (e) {
            await dbRun('ROLLBACK');
            throw e;
        }

        return res.json({
            success: true,
            message: 'Perubahan import berhasil di-revert',
            summary: {
                reverted_created: revertedCreated,
                reverted_updated: revertedUpdated
            }
        });
    } catch (error) {
        logger.error('Error reverting customer import:', error);
        return res.status(500).json({
            success: false,
            message: 'Gagal melakukan revert import',
            error: error.message
        });
    }
});

// Export customers to JSON
router.get('/export/customers.json', async (req, res) => {
    try {
        const { customers, joinMonth, joinYear, listFilters } = await loadCustomersForExport(req);
        const enrichedCustomers = await enrichCustomersForExport(customers);

        const monthNames = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
        let filename = 'customers.json';
        if (listFilters && listFilters.month && listFilters.year) {
            filename = `pelanggan-${listFilters.year}-${String(listFilters.month).padStart(2, '0')}.json`;
        } else if (joinMonth && joinYear) {
            filename = `pelanggan-join-${String(joinMonth).padStart(2, '0')}-${joinYear}.json`;
        }

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.json({
            success: true,
            export_period: (listFilters && listFilters.month && listFilters.year)
                ? {
                    month: listFilters.month,
                    year: listFilters.year,
                    label: `${monthNames[listFilters.month] || listFilters.month} ${listFilters.year}`,
                    as_of: 'end_of_month'
                }
                : null,
            customers: enrichedCustomers
        });
    } catch (error) {
        logger.error('Error exporting customers (JSON):', error);
        res.status(500).json({
            success: false,
            message: 'Error exporting customers (JSON)',
            error: error.message
        });
    }
});

// Import customers from JSON file
async function runCustomerJsonImport(req, res) {
    let db = null;
    let dbRun = null;
    let transactionStarted = false;
    try {
        const importFastMode = String(req.headers['x-import-fast-mode'] || '').trim() === '1';
        const bypassRequested = String(req.headers['x-import-bypass-once'] || '').trim() === '1';
        const importBypassMode = bypassRequested ? consumeOneTimeImportBypass() : false;
        const importJobId = String(req.headers['x-import-job-id'] || '').trim();
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'File JSON tidak ditemukan' });
        }

        const content = req.file.buffer.toString('utf8');
        let payload;
        try {
            payload = JSON.parse(content);
        } catch (e) {
            return res.status(400).json({ success: false, message: 'Format JSON tidak valid' });
        }

        const items = Array.isArray(payload) ? payload : (payload.customers || []);
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: 'Tidak ada data pelanggan pada file' });
        }

        db = require('../config/billing').db;
        await ensureCustomersPhoneNonUnique(db);
        dbRun = (sql, params = []) => new Promise((resolve, reject) => {
            db.run(sql, params, function (err) {
                if (err) return reject(err);
                resolve(this);
            });
        });
        const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
        });

        await dbRun(`
            CREATE TABLE IF NOT EXISTS import_customer_operations (
                id TEXT PRIMARY KEY,
                source_type TEXT NOT NULL,
                created_count INTEGER NOT NULL DEFAULT 0,
                updated_count INTEGER NOT NULL DEFAULT 0,
                failed_count INTEGER NOT NULL DEFAULT 0,
                created_ids_json TEXT NOT NULL DEFAULT '[]',
                updated_before_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            )
        `);
        const useAtomicImport = !importFastMode;
        if (useAtomicImport) {
            await dbRun('BEGIN IMMEDIATE');
            transactionStarted = true;
        }

        let created = 0, updated = 0, failed = 0;
        const errors = [];
        const totalRowsForProgress = items.length;
        let processedRows = 0;
        let successRows = 0;
        const reportProgress = (force = false) => {
            if (!importJobId) return;
            if (!force && processedRows % 5 !== 0 && processedRows !== totalRowsForProgress) return;
            const percentage = totalRowsForProgress > 0
                ? Math.min(99, Math.floor((processedRows / totalRowsForProgress) * 100))
                : 99;
            updateCommitJob(importJobId, {
                progress: {
                    total_rows: totalRowsForProgress,
                    processed_rows: processedRows,
                    success_rows: successRows,
                    failed_rows: failed,
                    percentage
                }
            });
        };

        for (const raw of items) {
            try {
                const name = (raw.name || '').toString().trim();
                const phoneRawDigits = String(raw.phone || '').replace(/\D/g, '');
                if (!name || !phoneRawDigits || phoneRawDigits.length < 9) {
                    failed++; errors.push({ name, phone: raw.phone, error: 'Nama/Phone wajib' }); continue;
                }
                const phone = parsePhoneFromSpreadsheetCell(raw.phone);
                if (!phone) {
                    failed++; errors.push({ name, phone: raw.phone, error: 'Nomor telepon tidak valid' }); continue;
                }

                const pppoeUsernameKey = String(raw.pppoe_username || '').trim();
                if (!pppoeUsernameKey) {
                    failed++;
                    errors.push({ name, phone, error: 'PPPoE username wajib diisi' });
                    continue;
                }
                const existing = await dbGet(
                    `SELECT * FROM customers WHERE TRIM(COALESCE(pppoe_username, '')) = ? LIMIT 1`,
                    [pppoeUsernameKey]
                );
                const optNum = (v) => {
                    if (v === undefined || v === null || v === '') return undefined;
                    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
                    return Number.isFinite(n) ? n : undefined;
                };
                const customerData = {
                    name,
                    phone,
                    pppoe_username: raw.pppoe_username || '',
                    pppoe_password: raw.pppoe_password ? String(raw.pppoe_password).trim() : '',
                    email: raw.email || '',
                    address: raw.address || '',
                    package_id: raw.package_id || null,
                    pppoe_profile: raw.pppoe_profile || 'default',
                    status: raw.status || 'active',
                    auto_suspension: raw.auto_suspension !== undefined ? parseInt(raw.auto_suspension, 10) : 1,
                    billing_day: raw.billing_day ? Math.min(Math.max(parseInt(raw.billing_day, 10), 1), 28) : 15
                };
                if (importFastMode) {
                    customerData.__skip_genieacs_sync = true;
                    customerData.__skip_radius_sync = true;
                }
                if (raw.username) customerData.username = String(raw.username).trim();
                if (raw.login_password || raw.password) customerData.password = String(raw.login_password || raw.password).trim();
                const latJ = optNum(raw.latitude);
                const lngJ = optNum(raw.longitude);
                if (latJ !== undefined) customerData.latitude = latJ;
                if (lngJ !== undefined) customerData.longitude = lngJ;
                if (raw.area) customerData.area = String(raw.area).trim();
                const aid = optNum(raw.area_id);
                if (aid !== undefined) customerData.area_id = aid;
                const oid = optNum(raw.odp_id);
                if (oid !== undefined) customerData.odp_id = oid;
                if (raw.renewal_type) customerData.renewal_type = String(raw.renewal_type).trim();
                const fd = optNum(raw.fix_date);
                if (fd !== undefined) customerData.fix_date = fd;
                if (raw.cable_type) customerData.cable_type = String(raw.cable_type).trim();
                const clen = optNum(raw.cable_length);
                if (clen !== undefined) customerData.cable_length = clen;
                const pnum = optNum(raw.port_number);
                if (pnum !== undefined) customerData.port_number = pnum;
                if (raw.cable_status) customerData.cable_status = String(raw.cable_status).trim();
                if (raw.cable_notes) customerData.cable_notes = String(raw.cable_notes).trim();

                const joinParsed = resolveImportJoinDate((row, key) => row[key], raw);

                let result;
                let customerIdForJoin = null;
                if (existing) {
                    result = await billingManager.updateCustomer(existing.phone, customerData);
                    customerIdForJoin = existing.id;
                    updated++;
                    successRows++;
                } else {
                    if (joinParsed) customerData.join_date = joinParsed;
                    result = await billingManager.createCustomer(customerData);
                    customerIdForJoin = result && result.id ? result.id : null;
                    created++;
                    successRows++;
                }
                if (joinParsed && customerIdForJoin) {
                    await applyCustomerJoinAndCreatedDates(db, customerIdForJoin, joinParsed);
                }

                // Handle PPPoE user creation/update if pppoe_username and password provided
                if (!importFastMode && raw.pppoe_username && raw.pppoe_password) {
                    try {
                        const pppoe_username = String(raw.pppoe_username).trim();
                        const pppoe_password = String(raw.pppoe_password).trim();
                        const pppoe_profile = raw.pppoe_profile || 'default';
                        const router_id = raw.router_id || null;

                        if (pppoe_username && pppoe_password) {
                            const { addPPPoEUser, getUserAuthModeAsync } = require('../config/mikrotik');
                            
                            // Helper function untuk get router by ID
                            const getRouterById = async (routerId) => {
                                try {
                                    const db = require('../config/billing').db;
                                    return new Promise((resolve, reject) => {
                                        db.get('SELECT * FROM routers WHERE id = ?', [parseInt(routerId)], (err, row) => {
                                            if (err) reject(err);
                                            else resolve(row || null);
                                        });
                                    });
                                } catch (err) {
                                    logger.warn(`Failed to get router by ID ${routerId}: ${err.message}`);
                                    return null;
                                }
                            };

                            // Get customer data after create/update to ensure we have the ID
                            const customer = await billingManager.getCustomerByPhone(phone);
                            if (!customer || !customer.id) {
                                logger.error(`[IMPORT] Customer not found or missing ID for phone ${phone}`);
                                throw new Error(`Customer not found or missing ID for phone ${phone}`);
                            }

                            const authMode = await getUserAuthModeAsync();
                            logger.info(`[IMPORT] Creating/updating PPPoE user ${pppoe_username} with profile ${pppoe_profile} (Mode: ${authMode}) for customer ${customer.id}`);

                            // Handle router_id: jika "RADIUS", set routerObj ke null
                            let routerObj = null;
                            if (router_id && router_id !== '' && router_id !== 'RADIUS' && router_id !== 'radius') {
                                routerObj = await getRouterById(router_id);
                                if (routerObj) {
                                    logger.info(`[IMPORT] Using router: ${routerObj.name} (${routerObj.nas_ip})`);
                                }
                            }

                            logger.info(`[IMPORT] Calling addPPPoEUser with: username=${pppoe_username}, profile=${pppoe_profile}, customer.id=${customer.id}`);
                            const addRes = await addPPPoEUser({ 
                                username: pppoe_username, 
                                password: pppoe_password, 
                                profile: pppoe_profile, 
                                customer: { id: customer.id },
                                routerObj: routerObj
                            });

                            if (addRes && addRes.success) {
                                logger.info(`✅ [IMPORT] PPPoE user ${pppoe_username} created/updated successfully in ${authMode} mode`);
                            } else {
                                const errorMsg = addRes?.message || addRes?.error || 'Unknown error';
                                logger.error(`❌ [IMPORT] Failed to create/update PPPoE user ${pppoe_username}: ${errorMsg}`);
                                logger.error(`[IMPORT] Full response:`, JSON.stringify(addRes));
                            }
                        } else {
                            logger.warn(`[IMPORT] Skipping PPPoE user creation: username or password is empty for phone ${phone}`);
                        }
                    } catch (pppoeError) {
                        logger.error(`[IMPORT] Error creating/updating PPPoE user for ${phone}:`, pppoeError);
                        logger.error(`[IMPORT] Error stack:`, pppoeError.stack);
                        // Don't fail the import if PPPoE creation fails, but log the error
                        errors.push({ name, phone, error: `PPPoE creation failed: ${pppoeError.message}` });
                    }
                } else if (!importFastMode) {
                    logger.debug(`[IMPORT] Skipping PPPoE user creation for ${phone}: pppoe_username or pppoe_password not provided`);
                } else {
                    logger.debug(`[IMPORT] Fast mode enabled: skip PPPoE provisioning for ${phone}`);
                }

                if (importFastMode) {
                    const radiusUsername = String(customerData.pppoe_username || (existing && existing.pppoe_username) || '').trim();
                    if (!radiusUsername) {
                        radiusSync.skipped++;
                    } else {
                        radiusSync.attempted++;
                        try {
                            const radiusRes = await syncCustomerToRadius(
                                {
                                    ...customerData,
                                    pppoe_username: radiusUsername,
                                    username: customerData.username || (existing && existing.username) || ''
                                },
                                {
                                    ...customerData,
                                    pppoe_password: raw.pppoe_password || '',
                                    pppoe_profile: customerData.pppoe_profile,
                                    status: customerData.status
                                }
                            );
                            if (radiusRes && radiusRes.success) radiusSync.success++;
                            else if (radiusRes && radiusRes.skipped) radiusSync.skipped++;
                            else radiusSync.failed++;
                        } catch (radiusErr) {
                            radiusSync.failed++;
                            logger.warn(`[IMPORT-RADIUS] Sync failed for ${radiusUsername}: ${radiusErr.message}`);
                        }
                    }
                }
                processedRows++;
                reportProgress();
            } catch (e) {
                failed++;
                errors.push({ name: raw && raw.name ? raw.name : '', phone: raw && raw.phone, error: e.message });
                processedRows++;
                reportProgress();
            }
        }

        const operationId = `import_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        if (useAtomicImport) {
            await dbRun(
                `INSERT INTO import_customer_operations
                (id, source_type, created_count, updated_count, failed_count, created_ids_json, updated_before_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    operationId,
                    'json',
                    created,
                    updated,
                    failed,
                    '[]',
                    '[]'
                ]
            );
            await dbRun('COMMIT');
            transactionStarted = false;
        }
        if (importJobId) {
            updateCommitJob(importJobId, {
                progress: {
                    total_rows: totalRowsForProgress,
                    processed_rows: totalRowsForProgress,
                    success_rows: created + updated,
                    failed_rows: failed,
                    percentage: 100
                }
            });
        }

        const responsePayload = {
            success: true,
            operation_id: useAtomicImport ? operationId : null,
            summary: {
                created,
                updated,
                failed,
                total: created + updated + failed,
                success_count: created + updated,
                bypass_mode: true,
                match_key: 'pppoe_username',
                radius_sync: radiusSync
            },
            errors
        };
        if (importJobId) {
            updateCommitJob(importJobId, {
                status: 'finished',
                result: responsePayload,
                finished_at: new Date().toISOString(),
                progress: {
                    total_rows: totalRowsForProgress,
                    processed_rows: totalRowsForProgress,
                    success_rows: created + updated,
                    failed_rows: failed,
                    percentage: 100
                }
            });
        }
        res.json(responsePayload);
    } catch (error) {
        if (transactionStarted && dbRun) {
            try {
                await dbRun('ROLLBACK');
            } catch (rollbackError) {
                logger.error('Error rolling back JSON import transaction:', rollbackError);
            }
        }
        const importJobId = String(req.headers['x-import-job-id'] || '').trim();
        if (importJobId) {
            updateCommitJob(importJobId, {
                status: 'failed',
                error: error.message,
                finished_at: new Date().toISOString()
            });
        }
        logger.error('Error importing customers (JSON):', error);
        res.status(500).json({
            success: false,
            message: 'Error importing customers (JSON)',
            error: error.message
        });
    }
}
router.post('/import/customers/json', upload.single('file'), runCustomerJsonImport);

// Auto Invoice Management
router.get('/auto-invoice', getAppSettings, async (req, res) => {
    try {
        const customers = await billingManager.getCustomers();
        const activeCustomers = customers.filter(c => c.status === 'active' && c.package_id);
        
        const currentDate = new Date();
        const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
        const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
        
        const thisMonthInvoices = await billingManager.getInvoices();
        const thisMonthInvoicesCount = thisMonthInvoices.filter(invoice => {
            const invoiceDate = new Date(invoice.created_at);
            return invoiceDate >= startOfMonth && invoiceDate <= endOfMonth;
        }).length;
        
        // Calculate next run date
        const nextRunDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
        
        res.render('admin/billing/auto-invoice', {
            title: 'Auto Invoice Management',
            activeCustomersCount: activeCustomers.length,
            thisMonthInvoicesCount,
            nextRunDate: nextRunDate.toLocaleDateString('id-ID'),
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error loading auto invoice page:', error);
        res.status(500).render('error', { 
            message: 'Error loading auto invoice page',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

const {
    createInvoiceGenerationJob,
    updateInvoiceGenerationJob,
    getInvoiceGenerationJob,
    cleanupOldInvoiceJobs
} = require('../config/invoiceGenerationJobs');

let invoiceGenRunning = false;

// Generate invoices manually (background — satu klik untuk semua pelanggan)
router.post('/auto-invoice/generate', async (req, res) => {
    try {
        if (invoiceGenRunning) {
            return res.status(409).json({
                success: false,
                message: 'Generate invoice masih berjalan. Tunggu selesai atau cek status job.'
            });
        }

        cleanupOldInvoiceJobs();
        const job = createInvoiceGenerationJob();
        invoiceGenRunning = true;
        updateInvoiceGenerationJob(job.id, { status: 'running', progress: { phase: 'starting', processed: 0, total: 0 } });

        const invoiceScheduler = require('../config/scheduler');

        setImmediate(async () => {
            try {
                const result = await invoiceScheduler.triggerMonthlyInvoices({
                    skipNotifications: true,
                    onProgress: (p) => {
                        updateInvoiceGenerationJob(job.id, {
                            status: 'running',
                            progress: {
                                phase: p.phase || 'customers',
                                processed: p.processed || 0,
                                total: p.total || 0,
                                created: p.created || 0,
                                skipped: p.skipped || 0,
                                failed: p.failed || 0
                            }
                        });
                    }
                });
                const stats = result.stats || {};
                const total = stats.customers_total || 0;
                updateInvoiceGenerationJob(job.id, {
                    status: 'completed',
                    stats,
                    progress: {
                        phase: 'done',
                        processed: total,
                        total,
                        created: stats.created || 0,
                        skipped: stats.skipped || 0,
                        failed: stats.failed || 0
                    }
                });
            } catch (error) {
                logger.error('Background invoice generation failed:', error);
                updateInvoiceGenerationJob(job.id, {
                    status: 'failed',
                    error: error.message || String(error)
                });
            } finally {
                invoiceGenRunning = false;
            }
        });

        res.json({
            success: true,
            message: 'Generate invoice dimulai di background',
            job_id: job.id
        });
    } catch (error) {
        invoiceGenRunning = false;
        logger.error('Error starting invoice generation:', error);
        res.status(500).json({
            success: false,
            message: 'Error generating invoices: ' + error.message
        });
    }
});

router.get('/auto-invoice/generate/status/:jobId', async (req, res) => {
    try {
        const job = getInvoiceGenerationJob(req.params.jobId);
        if (!job) {
            return res.status(404).json({ success: false, message: 'Job tidak ditemukan' });
        }
        res.json({ success: true, job });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Preview invoices that will be generated
router.get('/auto-invoice/preview', async (req, res) => {
    try {
        const customers = await billingManager.getCustomers();
        const activeCustomers = customers.filter(c => c.status === 'active' && c.package_id);
        
        // Get active members
        const members = await billingManager.getAllMembers({ status: 'active' });
        const activeMembers = members.filter(m => m.status === 'active' && m.package_id);
        
        const currentDate = new Date();
        const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
        const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
        
        const customersNeedingInvoices = [];
        const membersNeedingInvoices = [];
        
        // Process customers
        for (const customer of activeCustomers) {
            // Check if invoice already exists for this month
            const existingInvoices = await billingManager.getInvoicesByCustomerAndDateRange(
                customer.username,
                startOfMonth,
                endOfMonth
            );
            
            if (existingInvoices.length === 0) {
                // Get customer's package
                const package = await billingManager.getPackageById(customer.package_id);
                if (package) {
                    // Set due date based on customer's renewal type
                    let dueDate;
                    const renewalType = customer.renewal_type || 'renewal';
                    
                    if (renewalType === 'fix_date') {
                        const fixDate = customer.fix_date || customer.billing_day || 15;
                        const targetDay = Math.min(fixDate, 28);
                        const lastDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
                        const finalDay = Math.min(targetDay, lastDayOfMonth);
                        dueDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), finalDay);
                    } else {
                        const billingDay = (() => {
                            const v = parseInt(customer.billing_day, 10);
                            if (Number.isFinite(v)) return Math.min(Math.max(v, 1), 28);
                            return 15;
                        })();
                        const lastDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
                        const targetDay = Math.min(billingDay, lastDayOfMonth);
                        dueDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), targetDay);
                    }
                    
                    // Calculate price with PPN
                    const basePrice = package.price;
                    const taxRate = (package.tax_rate === 0 || (typeof package.tax_rate === 'number' && package.tax_rate > -1))
                        ? Number(package.tax_rate)
                        : 11.00;
                    const priceWithTax = billingManager.calculatePriceWithTax(basePrice, taxRate);
                    
                    customersNeedingInvoices.push({
                        type: 'customer',
                        username: customer.username,
                        name: customer.name,
                        package_name: package.name,
                        package_price: basePrice,
                        tax_rate: taxRate,
                        price_with_tax: priceWithTax,
                        due_date: dueDate.toISOString().split('T')[0]
                    });
                }
            }
        }
        
        // Process members
        for (const member of activeMembers) {
            const memberUsername = member.hotspot_username || member.username;
            if (!memberUsername) continue;
            
            // Check if invoice already exists for this month
            const existingInvoices = await billingManager.getInvoicesByMemberAndDateRange(
                memberUsername,
                startOfMonth,
                endOfMonth
            );
            
            if (existingInvoices.length === 0) {
                // Get member's package
                const package = await billingManager.getMemberPackageById(member.package_id);
                if (package) {
                    // Set due date based on member's billing_day
                    const billingDay = (() => {
                        const v = parseInt(member.billing_day, 10);
                        if (Number.isFinite(v)) return Math.min(Math.max(v, 1), 28);
                        return 15;
                    })();
                    const lastDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
                    const targetDay = Math.min(billingDay, lastDayOfMonth);
                    const dueDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), targetDay);
                    
                    // Calculate price with PPN
                    const basePrice = package.price;
                    const taxRate = (package.tax_rate === 0 || (typeof package.tax_rate === 'number' && package.tax_rate > -1))
                        ? Number(package.tax_rate)
                        : 11.00;
                    const priceWithTax = billingManager.calculatePriceWithTax(basePrice, taxRate);
                    
                    membersNeedingInvoices.push({
                        type: 'member',
                        username: memberUsername,
                        name: member.name,
                        package_name: package.name,
                        package_price: basePrice,
                        tax_rate: taxRate,
                        price_with_tax: priceWithTax,
                        due_date: dueDate.toISOString().split('T')[0]
                    });
                }
            }
        }
        
        // Combine customers and members
        const allInvoices = [...customersNeedingInvoices, ...membersNeedingInvoices];
        
        res.json({
            success: true,
            customers: allInvoices,
            customer_count: customersNeedingInvoices.length,
            member_count: membersNeedingInvoices.length,
            total_count: allInvoices.length
        });
    } catch (error) {
        logger.error('Error previewing invoices:', error);
        res.status(500).json({
            success: false,
            message: 'Error previewing invoices: ' + error.message
        });
    }
});

// Save auto invoice settings
router.post('/auto-invoice/settings', async (req, res) => {
    try {
        const { due_date_day, auto_invoice_enabled, invoice_notes } = req.body;
        
        // Save settings to database or config file
        // For now, we'll just log the settings
        logger.info('Auto invoice settings updated:', {
            due_date_day,
            auto_invoice_enabled,
            invoice_notes
        });
        
        res.json({
            success: true,
            message: 'Settings saved successfully'
        });
    } catch (error) {
        logger.error('Error saving auto invoice settings:', error);
        res.status(500).json({
            success: false,
            message: 'Error saving settings: ' + error.message
        });
    }
});

// WhatsApp Settings Routes
router.get('/whatsapp-settings', getAppSettings, async (req, res) => {
    try {
        res.render('admin/billing/whatsapp-settings', {
            title: 'WhatsApp Notification Settings',
            page: 'whatsapp-settings',
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error loading WhatsApp settings page:', error);
        res.status(500).render('error', {
            message: 'Error loading WhatsApp settings page',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

router.get('/whatsapp-settings/gateway', async (req, res) => {
    try {
        const { getWhatsAppProviderSettings } = require('../config/whatsapp-provider-settings');
        const providerSettings = getWhatsAppProviderSettings();
        res.json({
            success: true,
            settings: providerSettings,
            providers: providerSettings.providers
        });
    } catch (error) {
        logger.error('Error getting WhatsApp gateway settings:', error);
        res.status(500).json({ success: false, message: 'Error getting WhatsApp gateway settings: ' + error.message });
    }
});

router.post('/whatsapp-settings/gateway', async (req, res) => {
    try {
        const { saveWhatsAppProviderSettings } = require('../config/whatsapp-provider-settings');
        const providerSettings = saveWhatsAppProviderSettings(req.body || {});
        clearSettingsCache();

        try {
            const { getProviderManager } = require('../config/whatsapp-provider-manager');
            const providerManager = getProviderManager();
            if (providerManager.isInitialized()) {
                await providerManager.switchProvider(providerSettings.activeProvider);
            }
        } catch (switchError) {
            logger.warn('WhatsApp provider saved but could not hot-switch provider:', switchError.message);
        }

        res.json({
            success: true,
            message: 'Pengaturan gateway WhatsApp berhasil disimpan',
            settings: providerSettings,
            providers: providerSettings.providers
        });
    } catch (error) {
        logger.error('Error saving WhatsApp gateway settings:', error);
        res.status(500).json({ success: false, message: 'Error saving WhatsApp gateway settings: ' + error.message });
    }
});

// WhatsApp system monitoring (master on/off per automated WA source)
router.get('/whatsapp-monitoring', getAppSettings, async (req, res) => {
    try {
        res.render('admin/billing/whatsapp-monitoring', {
            title: 'Monitoring WhatsApp',
            page: 'whatsapp-monitoring',
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error loading WhatsApp monitoring page:', error);
        res.status(500).render('error', {
            message: 'Error loading WhatsApp monitoring page',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

router.get('/whatsapp-monitoring/switches', getAppSettings, async (req, res) => {
    try {
        const { MONITOR_DEFINITIONS, getMergedMonitors } = require('../config/whatsappMonitoringSettings');
        res.json({
            success: true,
            monitors: MONITOR_DEFINITIONS,
            switches: getMergedMonitors()
        });
    } catch (error) {
        logger.error('Error reading WA monitoring switches:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

const WHATSAPP_MONITOR_SETTING_FIELDS = [
    { key: 'pppoe_monitor_interval_minutes', label: 'Interval monitor PPPoE (menit)', type: 'number', min: 0.17, step: 0.01, defaultValue: '5', group: 'PPPoE & MikroTik' },
    { key: 'pppoe_notifications.includeOfflineList', label: 'Sertakan daftar PPPoE offline di pesan login/logout', type: 'boolean', defaultValue: true, group: 'PPPoE & MikroTik' },
    { key: 'pppoe_notifications.maxOfflineListCount', label: 'Maksimal user offline di pesan PPPoE', type: 'number', min: 0, step: 1, defaultValue: '20', group: 'PPPoE & MikroTik' },
    { key: 'rx_power_warning', label: 'Threshold RX warning (dBm)', type: 'number', step: 0.1, defaultValue: '-35', group: 'GenieACS & RX' },
    { key: 'rx_power_critical', label: 'Threshold RX critical (dBm)', type: 'number', step: 0.1, defaultValue: '-37', group: 'GenieACS & RX' },
    { key: 'rx_power_notification_interval_hours', label: 'Jeda ulang notifikasi RX threshold (jam)', type: 'number', min: 1, step: 1, defaultValue: '1', group: 'GenieACS & RX' },
    { key: 'rxpower_recap_interval_hours', label: 'Interval rekap RX GenieACS (jam)', type: 'number', min: 1, step: 1, defaultValue: '6', group: 'GenieACS & RX' },
    { key: 'offline_notification_interval_hours', label: 'Interval digest perangkat offline (jam)', type: 'number', min: 1, step: 1, defaultValue: '12', group: 'GenieACS & RX' },
    { key: 'offline_device_threshold_hours', label: 'Perangkat dianggap offline setelah (jam)', type: 'number', min: 1, step: 1, defaultValue: '24', group: 'GenieACS & RX' }
];

router.get('/whatsapp-monitoring/settings', getAppSettings, async (req, res) => {
    try {
        const values = {};
        WHATSAPP_MONITOR_SETTING_FIELDS.forEach((field) => {
            values[field.key] = getSetting(field.key, field.defaultValue);
        });

        res.json({ success: true, fields: WHATSAPP_MONITOR_SETTING_FIELDS, values });
    } catch (error) {
        logger.error('Error reading WA monitoring settings:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/whatsapp-monitoring/settings', getAppSettings, async (req, res) => {
    try {
        const incoming = req.body && typeof req.body === 'object' ? req.body : {};
        WHATSAPP_MONITOR_SETTING_FIELDS.forEach((field) => {
            if (!(field.key in incoming)) return;
            const rawValue = incoming[field.key];
            const value = field.type === 'boolean' ? rawValue === true || rawValue === 'true' || rawValue === 'on' : String(rawValue ?? '').trim();
            setSetting(field.key, value);
        });

        const rxWarnHours = parseInt(getSetting('rx_power_notification_interval_hours', '1'), 10);
        const rxRecapHours = parseInt(getSetting('rxpower_recap_interval_hours', '6'), 10);
        const offlineHours = parseInt(getSetting('offline_notification_interval_hours', '12'), 10);
        setSetting('rx_power_warning_interval', String(Math.max(rxWarnHours || 1, 1) * 60 * 60 * 1000));
        setSetting('rxpower_recap_interval', String(Math.max(rxRecapHours || 6, 1) * 60 * 60 * 1000));
        setSetting('offline_notification_interval', String(Math.max(offlineHours || 12, 1) * 60 * 60 * 1000));

        try {
            const intervalManager = require('../config/intervalManager');
            intervalManager.restartAll();
        } catch (e) {
            logger.warn('intervalManager.restartAll after WA monitoring settings:', e.message);
        }
        try {
            const pm = require('../config/pppoe-monitor');
            await pm.restartPPPoEMonitoring();
        } catch (e) {
            logger.warn('restartPPPoEMonitoring after WA monitoring settings:', e.message);
        }

        const values = {};
        WHATSAPP_MONITOR_SETTING_FIELDS.forEach((field) => {
            values[field.key] = getSetting(field.key, field.defaultValue);
        });
        res.json({ success: true, fields: WHATSAPP_MONITOR_SETTING_FIELDS, values });
    } catch (error) {
        logger.error('Error saving WA monitoring settings:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/whatsapp-monitoring/switches', getAppSettings, async (req, res) => {
    try {
        const { setMonitorsPartial, getMergedMonitors } = require('../config/whatsappMonitoringSettings');
        const incoming = (req.body && req.body.switches) ? req.body.switches : req.body;
        if (!incoming || typeof incoming !== 'object') {
            return res.status(400).json({ success: false, message: 'Invalid body' });
        }
        setMonitorsPartial(incoming);
        try {
            const intervalManager = require('../config/intervalManager');
            intervalManager.restartAll();
        } catch (e) {
            logger.warn('intervalManager.restartAll after WA monitors:', e.message);
        }
        try {
            const pm = require('../config/pppoe-monitor');
            await pm.restartPPPoEMonitoring();
        } catch (e) {
            logger.warn('restartPPPoEMonitoring after WA monitors:', e.message);
        }
        res.json({ success: true, switches: getMergedMonitors() });
    } catch (error) {
        logger.error('Error saving WA monitoring switches:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Email Settings Routes (placed right after WhatsApp settings)
router.get('/email-settings', getAppSettings, async (req, res) => {
    try {
        res.render('admin/billing/email-settings', {
            title: 'Email Notification Settings',
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error loading Email settings page:', error);
        res.status(500).render('error', {
            message: 'Error loading Email settings page',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

router.get('/email-settings/smtp', async (req, res) => {
    try {
        res.json({
            success: true,
            settings: {
                smtp_host: getSetting('smtp_host', ''),
                smtp_port: getSetting('smtp_port', '587'),
                smtp_secure: getSetting('smtp_secure', 'false'),
                smtp_user: getSetting('smtp_user', ''),
                smtp_password: getSetting('smtp_password', ''),
                smtp_from_email: getSetting('smtp_from_email', ''),
                smtp_from_name: getSetting('smtp_from_name', ''),
                smtp_reject_unauthorized: getSetting('smtp_reject_unauthorized', true)
            }
        });
    } catch (error) {
        logger.error('Error getting SMTP settings:', error);
        res.status(500).json({ success: false, message: 'Error getting SMTP settings: ' + error.message });
    }
});

router.post('/email-settings/smtp', async (req, res) => {
    try {
        const smtpData = req.body || {};
        setSetting('smtp_host', String(smtpData.smtp_host || '').trim());
        setSetting('smtp_port', String(parseInt(smtpData.smtp_port, 10) || 587));
        setSetting('smtp_secure', smtpData.smtp_secure === true || smtpData.smtp_secure === 'true');
        setSetting('smtp_user', String(smtpData.smtp_user || '').trim());
        setSetting('smtp_password', String(smtpData.smtp_password || ''));
        setSetting('smtp_from_email', String(smtpData.smtp_from_email || '').trim());
        setSetting('smtp_from_name', String(smtpData.smtp_from_name || '').trim());
        setSetting('smtp_reject_unauthorized', smtpData.smtp_reject_unauthorized !== false && smtpData.smtp_reject_unauthorized !== 'false');
        clearSettingsCache();

        try {
            const emailNotifications = require('../config/email-notifications');
            emailNotifications.reloadTransporter();
        } catch (e) {
            logger.warn('Failed to reload email transporter after SMTP save:', e.message);
        }

        res.json({ success: true, message: 'Konfigurasi SMTP berhasil disimpan' });
    } catch (error) {
        logger.error('Error saving SMTP settings:', error);
        res.status(500).json({ success: false, message: 'Error saving SMTP settings: ' + error.message });
    }
});

// Get WhatsApp templates
router.get('/whatsapp-settings/templates', async (req, res) => {
    try {
        const whatsappNotifications = require('../config/whatsapp-notifications');
        const templates = whatsappNotifications.getTemplates();
        
        res.json({
            success: true,
            templates: templates
        });
    } catch (error) {
        logger.error('Error getting WhatsApp templates:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting templates: ' + error.message
        });
    }
});

// Save WhatsApp templates
router.post('/whatsapp-settings/templates', async (req, res) => {
    try {
        const whatsappNotifications = require('../config/whatsapp-notifications');
        const templateData = req.body;
        
        // Update templates (more efficient for multiple updates)
        const updatedCount = whatsappNotifications.updateTemplates(templateData);
        
        res.json({
            success: true,
            message: `${updatedCount} templates saved successfully`
        });
    } catch (error) {
        logger.error('Error saving WhatsApp templates:', error);
        res.status(500).json({
            success: false,
            message: 'Error saving templates: ' + error.message
        });
    }
});

// Jadwal notifikasi WA tagihan (tagihan baru H-X, pengingat H-Y, peringatan hari H)
router.get('/whatsapp-settings/billing-notify-schedule', async (req, res) => {
    try {
        const { getBillingNotifySchedule } = require('../config/billing-wa-schedule');
        res.json({
            success: true,
            settings: getBillingNotifySchedule()
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/whatsapp-settings/billing-notify-schedule', adminAuth, async (req, res) => {
    try {
        const { invoice_notify_days_before, reminder_days_before, send_on_due_day } = req.body || {};

        const invoiceDays = parseInt(invoice_notify_days_before, 10);
        const reminderDays = parseInt(reminder_days_before, 10);

        if (!Number.isFinite(invoiceDays) || invoiceDays < 1 || invoiceDays > 30) {
            return res.status(400).json({
                success: false,
                message: 'Hari kirim tagihan baru harus antara 1–30'
            });
        }
        if (!Number.isFinite(reminderDays) || reminderDays < 1 || reminderDays > 30) {
            return res.status(400).json({
                success: false,
                message: 'Hari kirim pengingat harus antara 1–30'
            });
        }
        if (invoiceDays === reminderDays) {
            return res.status(400).json({
                success: false,
                message: 'Hari tagihan baru dan hari pengingat harus berbeda (mis. 3 dan 1)'
            });
        }

        const ok1 = setSetting('billing_wa_invoice_notify_days_before', String(invoiceDays));
        const ok2 = setSetting('billing_wa_reminder_days_before', String(reminderDays));
        const ok3 = setSetting(
            'billing_wa_send_on_due_day',
            send_on_due_day === false || send_on_due_day === 'false' ? 'false' : 'true'
        );
        if (!ok1 || !ok2 || !ok3) {
            return res.status(500).json({ success: false, message: 'Gagal menyimpan pengaturan' });
        }
        clearSettingsCache();

        const { getBillingNotifySchedule } = require('../config/billing-wa-schedule');
        res.json({
            success: true,
            settings: getBillingNotifySchedule()
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get WhatsApp rate limit settings
router.get('/whatsapp-settings/rate-limit', async (req, res) => {
    try {
        // Prefer nested object if exists, fallback to flattened keys
        const nested = getSetting('whatsapp_rate_limit', null);
        const settings = nested && typeof nested === 'object' ? {
            maxMessagesPerBatch: nested.maxMessagesPerBatch ?? 10,
            delayBetweenBatches: nested.delayBetweenBatches ?? 30,
            delayBetweenMessages: nested.delayBetweenMessages ?? 2,
            maxRetries: nested.maxRetries ?? 2,
            dailyMessageLimit: nested.dailyMessageLimit ?? 0,
            enabled: nested.enabled ?? true
        } : {
            maxMessagesPerBatch: getSetting('whatsapp_rate_limit.maxMessagesPerBatch', 10),
            delayBetweenBatches: getSetting('whatsapp_rate_limit.delayBetweenBatches', 30),
            delayBetweenMessages: getSetting('whatsapp_rate_limit.delayBetweenMessages', 2),
            maxRetries: getSetting('whatsapp_rate_limit.maxRetries', 2),
            dailyMessageLimit: getSetting('whatsapp_rate_limit.dailyMessageLimit', 0),
            enabled: getSetting('whatsapp_rate_limit.enabled', true)
        };
        
        res.json({
            success: true,
            settings: settings
        });
    } catch (error) {
        logger.error('Error getting WhatsApp rate limit settings:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting rate limit settings: ' + error.message
        });
    }
});

// Save WhatsApp rate limit settings
router.post('/whatsapp-settings/rate-limit', async (req, res) => {
    try {
        const { maxMessagesPerBatch, delayBetweenBatches, delayBetweenMessages, maxRetries, dailyMessageLimit, enabled } = req.body;
        
        // Validate input
        if (maxMessagesPerBatch < 1 || maxMessagesPerBatch > 100) {
            return res.status(400).json({
                success: false,
                message: 'Maksimal pesan per batch harus antara 1-100'
            });
        }
        
        if (delayBetweenBatches < 1 || delayBetweenBatches > 300) {
            return res.status(400).json({
                success: false,
                message: 'Jeda antar batch harus antara 1-300 detik'
            });
        }
        
        if (delayBetweenMessages < 0 || delayBetweenMessages > 10) {
            return res.status(400).json({
                success: false,
                message: 'Jeda antar pesan harus antara 0-10 detik'
            });
        }
        
        if (maxRetries < 0 || maxRetries > 5) {
            return res.status(400).json({
                success: false,
                message: 'Maksimal retry harus antara 0-5'
            });
        }
        
        if (dailyMessageLimit < 0 || dailyMessageLimit > 1000) {
            return res.status(400).json({
                success: false,
                message: 'Batas harian harus antara 0-1000'
            });
        }
        
        // Save settings
        const parsed = {
            maxMessagesPerBatch: parseInt(maxMessagesPerBatch),
            delayBetweenBatches: parseInt(delayBetweenBatches),
            delayBetweenMessages: parseInt(delayBetweenMessages),
            maxRetries: parseInt(maxRetries),
            dailyMessageLimit: parseInt(dailyMessageLimit),
            enabled: (enabled === true || enabled === 'true')
        };
        // Save flattened keys for backward compatibility
        setSetting('whatsapp_rate_limit.maxMessagesPerBatch', parsed.maxMessagesPerBatch);
        setSetting('whatsapp_rate_limit.delayBetweenBatches', parsed.delayBetweenBatches);
        setSetting('whatsapp_rate_limit.delayBetweenMessages', parsed.delayBetweenMessages);
        setSetting('whatsapp_rate_limit.maxRetries', parsed.maxRetries);
        setSetting('whatsapp_rate_limit.dailyMessageLimit', parsed.dailyMessageLimit);
        setSetting('whatsapp_rate_limit.enabled', parsed.enabled);
        // Also save as nested object for readability
        setSetting('whatsapp_rate_limit', parsed);
        // Ensure new reads reflect immediately
        clearSettingsCache();
        
        res.json({
            success: true,
            message: 'Pengaturan rate limiting berhasil disimpan'
        });
    } catch (error) {
        logger.error('Error saving WhatsApp rate limit settings:', error);
        res.status(500).json({
            success: false,
            message: 'Error saving rate limit settings: ' + error.message
        });
    }
});

// WhatsApp Groups Settings
router.get('/whatsapp-settings/groups', async (req, res) => {
    try {
        // Prefer nested object if exists
        const nested = getSetting('whatsapp_groups', null);
        const enabled = nested && typeof nested === 'object' ? (nested.enabled !== false) : getSetting('whatsapp_groups.enabled', true);
        // groups can be stored as array or object with numeric keys
        let ids = nested && Array.isArray(nested.ids) ? nested.ids : getSetting('whatsapp_groups.ids', []);
        if (!Array.isArray(ids)) {
            const asObj = getSetting('whatsapp_groups', {});
            ids = [];
            Object.keys(asObj).forEach(k => {
                if (k.match(/^ids\.\d+$/)) {
                    ids.push(asObj[k]);
                }
            });
        }
        res.json({ success: true, groups: { enabled, ids } });
    } catch (error) {
        logger.error('Error getting WhatsApp groups:', error);
        res.status(500).json({ success: false, message: 'Error getting WhatsApp groups: ' + error.message });
    }
});

router.post('/whatsapp-settings/groups', async (req, res) => {
    try {
        const enabled = req.body.enabled === true || req.body.enabled === 'true';
        const ids = Array.isArray(req.body.ids) ? req.body.ids : [];

        // Basic validation for WhatsApp group JIDs
        for (const id of ids) {
            if (typeof id !== 'string' || !id.endsWith('@g.us')) {
                return res.status(400).json({ success: false, message: `Invalid group id: ${id}` });
            }
        }

        // Save flattened keys
        setSetting('whatsapp_groups.enabled', enabled);
        setSetting('whatsapp_groups.ids', ids);
        // Save nested object for readability
        setSetting('whatsapp_groups', { enabled, ids });
        // Also write numeric keys for compatibility
        ids.forEach((val, idx) => setSetting(`whatsapp_groups.ids.${idx}`, val));
        // Ensure cache refresh
        clearSettingsCache();

        res.json({ success: true, message: 'WhatsApp groups updated' });
    } catch (error) {
        logger.error('Error saving WhatsApp groups:', error);
        res.status(500).json({ success: false, message: 'Error saving WhatsApp groups: ' + error.message });
    }
});


router.post('/system/restart', async (req, res) => {
    try {
        const isDev = process.env.NODE_ENV === 'development';

        // Di mode development (nodemon), tidak perlu restart manual via PM2
        // nodemon otomatis mengelola proses — jangan exit atau kill process
        if (isDev) {
            return res.json({
                success: true,
                message: 'Server berjalan dalam mode development (nodemon). Tidak perlu restart manual — simpan file JS/EJS apapun untuk memicu reload otomatis.',
                mode: 'development',
                env: process.env.NODE_ENV
            });
        }

        const repoPath = getSetting('repo_path', process.cwd());
        const targetApp = getSetting('pm2_restart_target', null)
            || getSetting('pm2_app_name', null)
            || process.env.PM2_APP_NAME
            || process.env.name
            || (typeof process.env.pm_id !== 'undefined' ? process.env.pm_id : null)
            || 'billing-kalimasada';
        const opts = { cwd: repoPath, windowsHide: true, shell: process.platform === 'win32' ? undefined : '/bin/bash' };

        const restartCmd = `pm2 restart ${targetApp}`;

        // Kirim respons cepat dulu supaya fetch client tidak gagal saat proses billing dimatikan/restart.
        res.json({
            success: true,
            message: 'Billing restart requested',
            app: targetApp,
            usedFallback: false,
            mode: 'production'
        });

        res.on('finish', () => {
            exec(restartCmd, opts, (restartError, stdout, stderr) => {
                const stderrStr = (stderr || '').toString();
                const startFallback = /process.*not found|unknown process|no process found|not found/i.test(stderrStr);

                if (restartError && startFallback) {
                    const ecoPath = path.join(repoPath, 'ecosystem.config.cjs');
                    const startCmd = `pm2 start "${ecoPath}" --only "billing-kalimasada" --update-env`;
                    exec(startCmd, opts, (startErr, startStdout, startStderr) => {
                        if (startErr) {
                            logger.error('PM2 restart fallback failed:', startErr, startStderr);
                            return;
                        }
                        exec('pm2 save', opts, (saveErr) => {
                            if (saveErr) logger.error('pm2 save failed after fallback:', saveErr);
                        });
                    });
                    return;
                }

                if (restartError) {
                    logger.error('PM2 restart command failed:', restartError, stderrStr);
                }

                exec('pm2 save', opts, (saveErr) => {
                    if (saveErr) logger.error('pm2 save failed after restart:', saveErr);
                });
            });
        });
        return;
    } catch (e) {
        res.status(500).json({ success: false, message: 'Unexpected error', error: e.message });
    }
});

// Alias for backward compatibility
router.get('/api/server-info', async (req, res) => {
    res.redirect('/admin/billing/system/server-info');
});

router.get('/system/server-info', async (req, res) => {
    try {
        const appVersion = getSetting('app_version', '4.1');
        const pm2App = getSetting('pm2_restart_target', null)
            || getSetting('pm2_app_name', null)
            || process.env.PM2_APP_NAME
            || 'billing-kalimasada';
        const now = new Date();

        res.json({
            success: true,
            serverTimeIso: now.toISOString(),
            serverTimeLocale: now.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
            appVersion,
            pm2App: pm2App || null
        });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Failed to load server info', error: e.message });
    }
});

// Get WhatsApp status
router.get('/whatsapp-settings/status', async (req, res) => {
    try {
        const customers = await billingManager.getCustomers();
        const activeCustomers = customers.filter(c => c.status === 'active' && c.phone);
        
        const invoices = await billingManager.getInvoices();
        const pendingInvoices = invoices.filter(i => i.status === 'unpaid');
        
        // Get WhatsApp status - cek dari provider manager dulu, lalu fallback ke global
        let whatsappStatus = { connected: false, status: 'disconnected' };
        
        try {
            // Coba ambil dari provider manager (untuk Wablas/Baileys)
            const { getProviderManager } = require('../config/whatsapp-provider-manager');
            const providerManager = getProviderManager();
            
            if (providerManager && providerManager.isInitialized()) {
                const provider = providerManager.getProvider();
                if (provider) {
                    const providerStatus = provider.getStatus();
                    whatsappStatus = {
                        connected: provider.isConnected() || providerStatus.connected || false,
                        status: providerStatus.status || (provider.isConnected() ? 'connected' : 'disconnected'),
                        provider: providerManager.getProviderType()
                    };
                }
            }
        } catch (providerError) {
            // Fallback ke whatsapp-core jika provider manager tidak tersedia
            try {
                const whatsappCore = require('../config/whatsapp-core');
                const coreStatus = whatsappCore.getWhatsAppStatus();
                if (coreStatus) {
                    whatsappStatus = {
                        connected: coreStatus.connected || false,
                        status: coreStatus.status || 'disconnected'
                    };
                }
            } catch (coreError) {
                // Final fallback ke global
                whatsappStatus = global.whatsappStatus || { connected: false, status: 'disconnected' };
            }
        }
        
        // Jika masih belum dapat status, cek global
        if (!whatsappStatus || (!whatsappStatus.connected && !whatsappStatus.status)) {
            whatsappStatus = global.whatsappStatus || { connected: false, status: 'disconnected' };
        }
        
        const { getBillingNotifySchedule } = require('../config/billing-wa-schedule');
        const sched = getBillingNotifySchedule();

        res.json({
            success: true,
            whatsappStatus: whatsappStatus.connected ? 'Connected' : 'Disconnected',
            whatsappProvider: whatsappStatus.provider || getSetting('whatsapp_active_provider', 'baileys'),
            activeCustomers: activeCustomers.length,
            pendingInvoices: pendingInvoices.length,
            nextReminder: `H-${sched.invoice_notify_days_before} tagihan, H-${sched.reminder_days_before} pengingat, hari H — 09:00`
        });
    } catch (error) {
        logger.error('Error getting WhatsApp status:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting status: ' + error.message
        });
    }
});

// Test WhatsApp notification
router.post('/whatsapp-settings/test', async (req, res) => {
    try {
        const whatsappNotifications = require('../config/whatsapp-notifications');
        const { phoneNumber, templateKey } = req.body;
        
        // Test data for different templates
        const testData = {
            invoice_created: {
                customer_name: 'Test Customer',
                invoice_number: 'INV-2024-001',
                amount: '500,000',
                due_date: '15 Januari 2024',
                package_name: 'Paket Premium',
                package_speed: '50 Mbps',
                notes: 'Tagihan bulanan'
            },
            due_date_reminder: {
                customer_name: 'Test Customer',
                invoice_number: 'INV-2024-001',
                amount: '500,000',
                due_date: '15 Januari 2024',
                days_remaining: '3',
                package_name: 'Paket Premium',
                package_speed: '50 Mbps'
            },
            due_date_reminder_today: {
                customer_name: 'Test Customer',
                invoice_number: 'INV-2024-001',
                amount: '500,000',
                due_date: '15 Januari 2024',
                days_remaining: '0',
                package_name: 'Paket Premium',
                package_speed: '50 Mbps'
            },
            payment_received: {
                customer_name: 'Test Customer',
                invoice_number: 'INV-2024-001',
                amount: '500,000',
                payment_method: 'Transfer Bank',
                payment_date: '10 Januari 2024',
                reference_number: 'TRX123456',
                package_name: 'Paket Premium',
                package_speed: '50 Mbps'
            },
            service_disruption: {
                disruption_type: 'Gangguan Jaringan',
                affected_area: 'Seluruh Area',
                estimated_resolution: '2 jam',
                support_phone: getSetting('contact_whatsapp', '0813-6888-8498')
            },
            service_announcement: {
                announcement_content: 'Pengumuman penting untuk semua pelanggan.'
            },
            service_suspension: {
                customer_name: 'Test Customer',
                reason: 'Tagihan terlambat lebih dari 7 hari'
            },
            service_restoration: {
                customer_name: 'Test Customer',
                package_name: 'Paket Premium',
                package_speed: '50 Mbps'
            },
            welcome_message: {
                customer_name: 'Test Customer',
                package_name: 'Paket Premium',
                package_speed: '50 Mbps',
                wifi_password: 'test123456',
                pppoe_username: 'user@test',
                pppoe_password: 'pass123',
                support_phone: getSetting('contact_whatsapp', '0813-6888-8498')
            },
            installation_job_assigned: {
                technician_name: 'Teknisi Test',
                job_number: 'JOB-001',
                customer_name: 'Pelanggan Test',
                customer_phone: '081234567890',
                customer_address: 'Jl. Contoh No. 1',
                package_name: 'Paket 30 Mbps',
                package_price: '350.000',
                installation_date: '5 Mei 2026',
                installation_time: '09:00',
                notes: 'Catatan job',
                equipment_needed: 'ONT, kabel',
                priority: 'Normal',
                pppoe_username: 'pppoe_test',
                pppoe_password: 'rahasia'
            },
            installation_status_update: {
                technician_name: 'Teknisi Test',
                job_number: 'JOB-001',
                customer_name: 'Pelanggan Test',
                new_status: 'Sedang Berlangsung',
                update_time: '5 Mei 2026 10:00',
                notes: 'Sedang instalasi'
            },
            installation_completed: {
                technician_name: 'Teknisi Test',
                job_number: 'JOB-001',
                customer_name: 'Pelanggan Test',
                completion_time: '5 Mei 2026 11:30',
                completion_notes: 'Instalasi OK'
            },
            sales_order_new_customer: {
                customer_id: '12345',
                customer_name: 'Pelanggan Baru',
                customer_phone: '081298765432',
                customer_email: 'test@mail.com',
                customer_address: 'Alamat contoh',
                package_name: 'Paket 50 Mbps',
                package_speed: '50 Mbps',
                pppoe_username: 'sales_pppoe',
                pppoe_password: 'salespass',
                pppoe_profile: 'default'
            },
            trouble_report_new_technician: {
                company_header: getSetting('company_header', 'ISP Test'),
                report_id: '99',
                customer_name: 'Budi',
                phone: '081211112222',
                location: 'Desa Contoh',
                category: 'Internet putus',
                created_at: '05/05/2026 08:00:00',
                description: 'Kabel putus',
                status: 'OPEN'
            },
            trouble_report_customer_update: {
                company_header: getSetting('company_header', 'ISP Test'),
                report_id: '99',
                updated_at: '05/05/2026 09:00:00',
                status_label: 'Sedang Ditangani',
                technician_note_section: '💬 *Catatan Teknisi*:\nTim menuju lokasi.\n\n',
                status_message: 'Tim teknisi kami sedang menangani laporan Anda.'
            }
        };

        const testPayload = testData[templateKey] || {};
        const result = await whatsappNotifications.testNotification(phoneNumber, templateKey, testPayload);
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Test notification sent successfully'
            });
        } else {
            res.json({
                success: false,
                message: result.error
            });
        }
    } catch (error) {
        logger.error('Error sending test notification:', error);
        res.status(500).json({
            success: false,
            message: 'Error sending test notification: ' + error.message
        });
    }
});

// Send broadcast message
router.post('/whatsapp-settings/broadcast', async (req, res) => {
    try {
        const whatsappNotifications = require('../config/whatsapp-notifications');
        const { type, message, disruptionType, affectedArea, estimatedResolution } = req.body;
        
        let result;
        
        if (type === 'service_disruption') {
            result = await whatsappNotifications.sendServiceDisruptionNotification({
                type: disruptionType || 'Gangguan Jaringan',
                area: affectedArea || 'Seluruh Area',
                estimatedTime: estimatedResolution || 'Sedang dalam penanganan'
            });
        } else if (type === 'service_announcement') {
            result = await whatsappNotifications.sendServiceAnnouncement({
                content: message
            });
        } else {
            return res.status(400).json({
                success: false,
                message: 'Invalid broadcast type'
            });
        }
        
        if (result.success) {
            res.json({
                success: true,
                sent: result.sent,
                failed: result.failed,
                total: result.total,
                customer_sent: result.customer_sent || 0,
                customer_failed: result.customer_failed || 0,
                group_sent: result.group_sent || 0,
                group_failed: result.group_failed || 0,
                message: `Broadcast sent successfully. Customer: ${result.customer_sent || 0} ok / ${result.customer_failed || 0} fail, Group: ${result.group_sent || 0} ok / ${result.group_failed || 0} fail`
            });
        } else {
            res.json({
                success: false,
                message: result.error
            });
        }
    } catch (error) {
        logger.error('Error sending broadcast:', error);
        res.status(500).json({
            success: false,
            message: 'Error sending broadcast: ' + error.message
        });
    }
});

// Get Email templates
router.get('/email-settings/templates', async (req, res) => {
    try {
        const emailNotifications = require('../config/email-notifications');
        const templates = emailNotifications.getTemplates();
        
        res.json({
            success: true,
            templates: templates
        });
    } catch (error) {
        logger.error('Error getting Email templates:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting templates: ' + error.message
        });
    }
});

// Save Email templates
router.post('/email-settings/templates', async (req, res) => {
    try {
        const emailNotifications = require('../config/email-notifications');
        const templateData = req.body;
        
        // Update templates
        const updatedCount = emailNotifications.updateTemplates(templateData);
        
        res.json({
            success: true,
            message: `${updatedCount} templates saved successfully`
        });
    } catch (error) {
        logger.error('Error saving Email templates:', error);
        res.status(500).json({
            success: false,
            message: 'Error saving templates: ' + error.message
        });
    }
});

// Get Email connection status
router.get('/email-settings/status', async (req, res) => {
    try {
        const emailNotifications = require('../config/email-notifications');
        // Reload transporter to get latest SMTP settings
        emailNotifications.reloadTransporter();
        const isConfigured = emailNotifications.isConfigured();
        const connectionTest = await emailNotifications.testConnection();
        
        // Get stats
        const customers = await billingManager.getCustomers();
        const activeCustomers = customers.filter(c => c.status === 'active' && c.email);
        const pendingInvoices = await billingManager.getUnpaidInvoices();
        
        res.json({
            success: true,
            emailConfigured: isConfigured,
            connectionStatus: connectionTest.success ? 'Connected' : 'Not Connected',
            connectionError: connectionTest.error || null,
            activeCustomersWithEmail: activeCustomers.length,
            pendingInvoices: pendingInvoices.length
        });
    } catch (error) {
        logger.error('Error getting Email status:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting status: ' + error.message
        });
    }
});

// Test SMTP Connection (POST endpoint for testing)
router.post('/email-settings/status', async (req, res) => {
    try {
        const emailNotifications = require('../config/email-notifications');
        // Reload transporter to get latest SMTP settings
        emailNotifications.reloadTransporter();
        const isConfigured = emailNotifications.isConfigured();
        const connectionTest = await emailNotifications.testConnection();
        
        // Get stats
        const customers = await billingManager.getCustomers();
        const activeCustomers = customers.filter(c => c.status === 'active' && c.email);
        const pendingInvoices = await billingManager.getUnpaidInvoices();
        
        res.json({
            success: true,
            emailConfigured: isConfigured,
            connectionStatus: connectionTest.success ? 'Connected' : 'Not Connected',
            connectionError: connectionTest.error || null,
            activeCustomersWithEmail: activeCustomers.length,
            pendingInvoices: pendingInvoices.length
        });
    } catch (error) {
        logger.error('Error testing Email connection:', error);
        res.status(500).json({
            success: false,
            message: 'Error testing connection: ' + error.message,
            connectionStatus: 'Error',
            connectionError: error.message
        });
    }
});

// Test Email notification
router.post('/email-settings/test', async (req, res) => {
    try {
        const emailNotifications = require('../config/email-notifications');
        const { emailAddress, templateKey } = req.body;
        
        if (!emailAddress || !emailAddress.includes('@')) {
            return res.status(400).json({
                success: false,
                message: 'Invalid email address'
            });
        }
        
        if (!templateKey) {
            return res.status(400).json({
                success: false,
                message: 'Template key is required'
            });
        }
        
        const result = await emailNotifications.testNotification(emailAddress, templateKey);
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Test email sent successfully'
            });
        } else {
            res.json({
                success: false,
                message: 'Error sending test email: ' + result.error
            });
        }
    } catch (error) {
        logger.error('Error sending test email:', error);
        res.status(500).json({
            success: false,
            message: 'Error sending test email: ' + error.message
        });
    }
});

// Send Email broadcast message
router.post('/email-settings/broadcast', async (req, res) => {
    try {
        const emailNotifications = require('../config/email-notifications');
        const { type, message, disruptionType, affectedArea, estimatedResolution } = req.body;
        
        let result;
        
        if (type === 'service_disruption') {
            result = await emailNotifications.sendServiceDisruptionNotification({
                type: disruptionType || 'Gangguan Jaringan',
                area: affectedArea || 'Seluruh Area',
                estimatedTime: estimatedResolution || 'Sedang dalam penanganan'
            });
        } else if (type === 'service_announcement') {
            result = await emailNotifications.sendServiceAnnouncement({
                content: message
            });
        } else {
            return res.status(400).json({
                success: false,
                message: 'Invalid broadcast type'
            });
        }
        
        if (result.success) {
            res.json({
                success: true,
                sent: result.sent,
                failed: result.failed,
                total: result.total,
                message: `Broadcast sent successfully. ${result.sent} sent / ${result.failed} failed`
            });
        } else {
            res.json({
                success: false,
                message: result.error
            });
        }
    } catch (error) {
        logger.error('Error sending email broadcast:', error);
        res.status(500).json({
            success: false,
            message: 'Error sending broadcast: ' + error.message
        });
    }
});

// API: Get RADIUS groupnames (for dropdown/autocomplete)
router.get('/api/radius/groupnames', async (req, res) => {
    try {
        const { getRadiusConnection } = require('../config/mikrotik');
        const conn = await getRadiusConnection();
        
        // Get unique groupnames from radgroupreply and radusergroup
        const [groupReplyRows] = await conn.execute(`
            SELECT DISTINCT groupname 
            FROM radgroupreply 
            WHERE groupname IS NOT NULL AND groupname != ''
            ORDER BY groupname ASC
        `);
        
        const [userGroupRows] = await conn.execute(`
            SELECT DISTINCT groupname 
            FROM radusergroup 
            WHERE groupname IS NOT NULL AND groupname != ''
            ORDER BY groupname ASC
        `);
        
        await conn.end();
        
        // Combine and deduplicate groupnames
        const groupnamesSet = new Set();
        (groupReplyRows || []).forEach(row => groupnamesSet.add(row.groupname));
        (userGroupRows || []).forEach(row => groupnamesSet.add(row.groupname));
        
        const groupnames = Array.from(groupnamesSet).sort();
        
        res.json({
            success: true,
            groupnames: groupnames
        });
    } catch (error) {
        logger.error('Error getting RADIUS groupnames:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil daftar groupname dari RADIUS',
            error: error.message,
            groupnames: []
        });
    }
});

// Paket Management
router.get('/packages', getAppSettings, async (req, res) => {
    try {
        const packages = await billingManager.getPackages();
        // Fetch routers for NAS selection
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('./data/billing.db');
        const routers = await new Promise((resolve, reject) => {
            db.all('SELECT * FROM routers ORDER BY id', (err, rows) => {
                db.close();
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        
        // Get user auth mode for conditional display
        const { getUserAuthModeAsync } = require('../config/mikrotik');
        const authMode = await getUserAuthModeAsync();
        
        res.render('admin/billing/packages', {
            title: 'Kelola Paket',
            packages,
            routers,
            appSettings: req.appSettings,
            authMode // Pass auth mode ke view
        });
    } catch (error) {
        logger.error('Error loading packages:', error);
        res.status(500).render('error', { 
            message: 'Error loading packages',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

router.post('/packages', imageUpload.single('image'), async (req, res) => {
    try {
        const { 
            name, speed, price, tax_rate, description, pppoe_profile, router_id, nas_ip,
            upload_limit, download_limit, burst_limit_upload, burst_limit_download, 
            burst_threshold, burst_time 
        } = req.body;

        const billingOnly = ['1', 'true', 'on', 'yes'].includes(String(req.body.billing_only || '').toLowerCase());

        const packageData = {
            name: name.trim(),
            speed: speed.trim(),
            price: parseFloat(price),
            tax_rate: parseFloat(tax_rate) >= 0 ? parseFloat(tax_rate) : 0,
            description: description.trim(),
            billing_only: billingOnly,
            pppoe_profile: billingOnly ? null : (pppoe_profile ? pppoe_profile.trim() : 'default'),
            router_id: billingOnly ? null : (router_id ? parseInt(router_id, 10) : null),
            nas_ip: billingOnly ? null : (nas_ip ? nas_ip.trim() : null),
            upload_limit: upload_limit ? upload_limit.trim() : null,
            download_limit: download_limit ? download_limit.trim() : null,
            burst_limit_upload: burst_limit_upload ? burst_limit_upload.trim() : null,
            burst_limit_download: burst_limit_download ? burst_limit_download.trim() : null,
            burst_threshold: burst_threshold ? burst_threshold.trim() : null,
            burst_time: burst_time ? burst_time.trim() : null
        };

        // Add image filename if uploaded
        if (req.file) {
            packageData.image = req.file.filename;
        }

        if (!packageData.name || !packageData.speed || !packageData.price) {
            return res.status(400).json({
                success: false,
                message: 'Nama, kecepatan, dan harga harus diisi'
            });
        }

        const newPackage = await billingManager.createPackage(packageData);
        logger.info(`Package created: ${newPackage.name} with tax_rate: ${newPackage.tax_rate}, router_id: ${newPackage.router_id}`);
        
        // Auto-sync limits berdasarkan mode (RADIUS atau API)
        const { getUserAuthModeAsync, syncPackageLimitsToRadius, syncPackageLimitsToMikrotik, getPPPoEProfiles, addPPPoEProfile, buildMikrotikRateLimit } = require('../config/mikrotik');
        const authMode = await getUserAuthModeAsync();
        
        let syncResult = null;
        if (!billingOnly && authMode === 'radius') {
            // Sync ke RADIUS (radgroupreply)
            try {
                // Convert profile name ke format groupname (lowercase dengan underscore)
                const groupname = newPackage.pppoe_profile.toLowerCase().replace(/\s+/g, '_');
                syncResult = await syncPackageLimitsToRadius({
                    groupname: groupname,
                    upload_limit: newPackage.upload_limit,
                    download_limit: newPackage.download_limit,
                    burst_limit_upload: newPackage.burst_limit_upload,
                    burst_limit_download: newPackage.burst_limit_download,
                    burst_threshold: newPackage.burst_threshold,
                    burst_time: newPackage.burst_time
                });
                if (syncResult && syncResult.success) {
                    logger.info(`✅ Package limits synced to RADIUS for group: ${groupname}`);
                }
            } catch (syncError) {
                logger.warn(`Failed to sync limits to RADIUS: ${syncError.message}`);
            }
        } else if (!billingOnly) {
            // Sync ke Mikrotik (PPPoE profile rate-limit) - hanya jika router_id ada
            if (newPackage.router_id && newPackage.pppoe_profile) {
                try {
                    const sqlite3 = require('sqlite3').verbose();
                    const db = new sqlite3.Database('./data/billing.db');
                    const routerObj = await new Promise((resolve, reject) => {
                        db.get('SELECT * FROM routers WHERE id=?', [newPackage.router_id], (err, row) => {
                            db.close();
                            if (err) reject(err);
                            else resolve(row || null);
                        });
                    });
                    
                    if (routerObj) {
                        // Check if profile exists
                        const profilesResult = await getPPPoEProfiles(routerObj);
                        const profileExists = profilesResult.success && profilesResult.data && 
                            profilesResult.data.some(p => (p.name || p['name']) === newPackage.pppoe_profile);
                        
                        if (profileExists) {
                            // Update existing profile dengan limits
                            syncResult = await syncPackageLimitsToMikrotik({
                                profile_name: newPackage.pppoe_profile,
                                upload_limit: newPackage.upload_limit,
                                download_limit: newPackage.download_limit,
                                burst_limit_upload: newPackage.burst_limit_upload,
                                burst_limit_download: newPackage.burst_limit_download,
                                burst_threshold: newPackage.burst_threshold,
                                burst_time: newPackage.burst_time
                            }, routerObj);
                            if (syncResult && syncResult.success) {
                                logger.info(`✅ Package limits synced to Mikrotik profile: ${newPackage.pppoe_profile}`);
                            }
                        } else {
                            // Create profile baru dengan limits
                            const rateLimit = buildMikrotikRateLimit({
                                upload_limit: newPackage.upload_limit,
                                download_limit: newPackage.download_limit,
                                burst_limit_upload: newPackage.burst_limit_upload,
                                burst_limit_download: newPackage.burst_limit_download,
                                burst_threshold: newPackage.burst_threshold,
                                burst_time: newPackage.burst_time
                            });
                            
                            const profileData = {
                                name: newPackage.pppoe_profile,
                                'remote-address': 'POOL-PPPOE-NEW',
                                'rate-limit': rateLimit || undefined
                            };
                            
                            const createResult = await addPPPoEProfile(profileData, routerObj);
                            if (createResult && createResult.success) {
                                syncResult = { success: true, message: 'Profile created with limits' };
                                logger.info(`✅ PPPoE profile created with limits: ${newPackage.pppoe_profile}`);
                            }
                        }
                    }
                } catch (profileError) {
                    logger.warn(`Failed to sync limits to Mikrotik: ${profileError.message}`);
                }
            }
        }
        
        res.json({
            success: true,
            message: syncResult && syncResult.success 
                ? `Paket berhasil ditambahkan dan limits di-sync ke ${authMode === 'radius' ? 'RADIUS' : 'Mikrotik'}`
                : 'Paket berhasil ditambahkan',
            package: newPackage,
            syncResult
        });
    } catch (error) {
        logger.error('Error creating package:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating package',
            error: error.message
        });
    }
});

router.put('/packages/:id', imageUpload.single('image'), async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            name, speed, price, tax_rate, description, pppoe_profile, router_id, nas_ip,
            upload_limit, download_limit, burst_limit_upload, burst_limit_download, 
            burst_threshold, burst_time 
        } = req.body;

        const billingOnly = ['1', 'true', 'on', 'yes'].includes(String(req.body.billing_only || '').toLowerCase());

        const packageData = {
            name: name.trim(),
            speed: speed.trim(),
            price: parseFloat(price),
            tax_rate: parseFloat(tax_rate) >= 0 ? parseFloat(tax_rate) : 0,
            description: description.trim(),
            billing_only: billingOnly,
            pppoe_profile: billingOnly ? null : (pppoe_profile ? pppoe_profile.trim() : 'default'),
            router_id: billingOnly ? null : (router_id ? parseInt(router_id, 10) : null),
            nas_ip: billingOnly ? null : (nas_ip ? nas_ip.trim() : null),
            upload_limit: upload_limit ? upload_limit.trim() : null,
            download_limit: download_limit ? download_limit.trim() : null,
            burst_limit_upload: burst_limit_upload ? burst_limit_upload.trim() : null,
            burst_limit_download: burst_limit_download ? burst_limit_download.trim() : null,
            burst_threshold: burst_threshold ? burst_threshold.trim() : null,
            burst_time: burst_time ? burst_time.trim() : null
        };

        // Add image filename if uploaded
        if (req.file) {
            packageData.image = req.file.filename;
        }

        if (!packageData.name || !packageData.speed || !packageData.price) {
            return res.status(400).json({
                success: false,
                message: 'Nama, kecepatan, dan harga harus diisi'
            });
        }

        const updatedPackage = await billingManager.updatePackage(id, packageData);
        logger.info(`Package updated: ${updatedPackage.name} with tax_rate: ${updatedPackage.tax_rate}, router_id: ${updatedPackage.router_id}`);
        
        // Auto-sync limits berdasarkan mode (RADIUS atau API)
        const { getUserAuthModeAsync, syncPackageLimitsToRadius, syncPackageLimitsToMikrotik, getPPPoEProfiles, addPPPoEProfile, buildMikrotikRateLimit } = require('../config/mikrotik');
        const authMode = await getUserAuthModeAsync();
        
        let syncResult = null;
        if (!billingOnly && authMode === 'radius') {
            // Sync ke RADIUS (radgroupreply)
            try {
                // Convert profile name ke format groupname (lowercase dengan underscore)
                const groupname = updatedPackage.pppoe_profile.toLowerCase().replace(/\s+/g, '_');
                syncResult = await syncPackageLimitsToRadius({
                    groupname: groupname,
                    upload_limit: updatedPackage.upload_limit,
                    download_limit: updatedPackage.download_limit,
                    burst_limit_upload: updatedPackage.burst_limit_upload,
                    burst_limit_download: updatedPackage.burst_limit_download,
                    burst_threshold: updatedPackage.burst_threshold,
                    burst_time: updatedPackage.burst_time
                });
                if (syncResult && syncResult.success) {
                    logger.info(`✅ Package limits synced to RADIUS for group: ${groupname}`);
                }
            } catch (syncError) {
                logger.warn(`Failed to sync limits to RADIUS: ${syncError.message}`);
            }
        } else if (!billingOnly) {
            // Sync ke Mikrotik (PPPoE profile rate-limit) - hanya jika router_id ada
            if (updatedPackage.router_id && updatedPackage.pppoe_profile) {
                try {
                    const sqlite3 = require('sqlite3').verbose();
                    const db = new sqlite3.Database('./data/billing.db');
                    const routerObj = await new Promise((resolve, reject) => {
                        db.get('SELECT * FROM routers WHERE id=?', [updatedPackage.router_id], (err, row) => {
                            db.close();
                            if (err) reject(err);
                            else resolve(row || null);
                        });
                    });
                    
                    if (routerObj) {
                        // Check if profile exists
                        const profilesResult = await getPPPoEProfiles(routerObj);
                        const profileExists = profilesResult.success && profilesResult.data && 
                            profilesResult.data.some(p => (p.name || p['name']) === updatedPackage.pppoe_profile);
                        
                        if (profileExists) {
                            // Update existing profile dengan limits
                            syncResult = await syncPackageLimitsToMikrotik({
                                profile_name: updatedPackage.pppoe_profile,
                                upload_limit: updatedPackage.upload_limit,
                                download_limit: updatedPackage.download_limit,
                                burst_limit_upload: updatedPackage.burst_limit_upload,
                                burst_limit_download: updatedPackage.burst_limit_download,
                                burst_threshold: updatedPackage.burst_threshold,
                                burst_time: updatedPackage.burst_time
                            }, routerObj);
                            if (syncResult && syncResult.success) {
                                logger.info(`✅ Package limits synced to Mikrotik profile: ${updatedPackage.pppoe_profile}`);
                            }
                        } else {
                            // Create profile baru dengan limits
                            const rateLimit = buildMikrotikRateLimit({
                                upload_limit: updatedPackage.upload_limit,
                                download_limit: updatedPackage.download_limit,
                                burst_limit_upload: updatedPackage.burst_limit_upload,
                                burst_limit_download: updatedPackage.burst_limit_download,
                                burst_threshold: updatedPackage.burst_threshold,
                                burst_time: updatedPackage.burst_time
                            });
                            
                            const profileData = {
                                name: updatedPackage.pppoe_profile,
                                'remote-address': 'POOL-PPPOE-NEW',
                                'rate-limit': rateLimit || undefined
                            };
                            
                            const createResult = await addPPPoEProfile(profileData, routerObj);
                            if (createResult && createResult.success) {
                                syncResult = { success: true, message: 'Profile created with limits' };
                                logger.info(`✅ PPPoE profile created with limits: ${updatedPackage.pppoe_profile}`);
                            }
                        }
                    }
                } catch (profileError) {
                    logger.warn(`Failed to sync limits to Mikrotik: ${profileError.message}`);
                }
            }
        }
        
        res.json({
            success: true,
            message: syncResult && syncResult.success 
                ? `Paket berhasil diupdate dan limits di-sync ke ${authMode === 'radius' ? 'RADIUS' : 'Mikrotik'}`
                : 'Paket berhasil diupdate',
            package: updatedPackage,
            syncResult
        });
    } catch (error) {
        logger.error('Error updating package:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating package',
            error: error.message
        });
    }
});

// Get package detail (HTML view)
router.get('/packages/:id', getAppSettings, async (req, res) => {
    try {
        const { id } = req.params;
        const package = await billingManager.getPackageById(parseInt(id));
        
        if (!package) {
            return res.status(404).render('error', {
                message: 'Paket tidak ditemukan',
                error: 'Package not found',
                appSettings: req.appSettings
            });
        }

        const customers = await billingManager.getCustomersByPackage(parseInt(id));
        
        res.render('admin/billing/package-detail', {
            title: 'Detail Paket',
            package,
            customers,
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error loading package detail:', error);
        res.status(500).render('error', {
            message: 'Error loading package detail',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Get package data for editing (JSON API)
router.get('/api/packages/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const package = await billingManager.getPackageById(parseInt(id));
        
        if (!package) {
            return res.status(404).json({
                success: false,
                message: 'Paket tidak ditemukan'
            });
        }
        
        res.json({
            success: true,
            package: package
        });
    } catch (error) {
        logger.error('Error getting package data:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting package data',
            error: error.message
        });
    }
});

router.delete('/packages/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await billingManager.deletePackage(id);
        logger.info(`Package deleted: ${id}`);
        
        res.json({
            success: true,
            message: 'Paket berhasil dihapus'
        });
    } catch (error) {
        logger.error('Error deleting package:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting package',
            error: error.message
        });
    }
});

// ============================================================
// AREA MANAGEMENT — CRUD Lengkap
// ============================================================

// Helper: Ensure areas table exists + area_id di customers
async function ensureAreasTable(db) {
    await new Promise((resolve) => db.run(`
        CREATE TABLE IF NOT EXISTS areas (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            kode_area   TEXT,
            nama_area   TEXT    NOT NULL,
            deskripsi   TEXT,
            status      TEXT    NOT NULL DEFAULT 'aktif',
            created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
            UNIQUE(nama_area)
        )
    `, () => resolve()));

    // Migration: tambah kode_area jika tabel areas sudah ada tapi kolom belum ada
    await new Promise((resolve) => db.run(
        `ALTER TABLE areas ADD COLUMN kode_area TEXT`,
        () => resolve() // Abaikan error jika kolom sudah ada
    ));

    // Tambahkan kolom area_id ke customers jika belum ada
    await new Promise((resolve) => db.run(
        `ALTER TABLE customers ADD COLUMN area_id INTEGER REFERENCES areas(id)`,
        () => resolve() // Abaikan error jika kolom sudah ada
    ));
}

// GET /admin/billing/areas — Halaman Manajemen Area
router.get('/areas', getAppSettings, async (req, res) => {
    try {
        const db = require('../config/billing').db;
        await ensureAreasTable(db);

        const page     = Math.max(1, parseInt(req.query.page)  || 1);
        const limit    = Math.max(1, parseInt(req.query.limit) || 20);
        const offset   = (page - 1) * limit;
        const search   = req.query.search ? String(req.query.search).trim() : '';
        const filterStatus = req.query.status ? String(req.query.status).trim() : '';

        let whereClauses = [];
        let params = [];
        if (search)       { whereClauses.push(`a.nama_area LIKE ?`); params.push(`%${search}%`); }
        if (filterStatus) { whereClauses.push(`a.status = ?`);        params.push(filterStatus); }
        const where = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';

        const [areas, countRow, stats] = await Promise.all([
            new Promise((resolve) => db.all(`
                SELECT a.*,
                       COUNT(c.id) as total_customers
                FROM areas a
                LEFT JOIN customers c ON c.area_id = a.id
                ${where}
                GROUP BY a.id
                ORDER BY a.nama_area ASC
                LIMIT ? OFFSET ?
            `, [...params, limit, offset], (err, rows) => resolve(rows || []))),

            new Promise((resolve) => db.get(`
                SELECT COUNT(*) as total FROM areas a ${where}
            `, params, (err, row) => resolve(row || { total: 0 }))),

            new Promise((resolve) => db.get(`
                SELECT
                    COUNT(*) as total,
                    SUM(CASE WHEN status='aktif'    THEN 1 ELSE 0 END) as aktif,
                    SUM(CASE WHEN status='nonaktif' THEN 1 ELSE 0 END) as nonaktif
                FROM areas
            `, [], (err, row) => resolve(row || { total: 0, aktif: 0, nonaktif: 0 }))),
        ]);

        const totalCount = countRow.total;
        const totalPages = Math.max(1, Math.ceil(totalCount / limit));

        res.render('admin/billing/areas', {
            title        : 'Manajemen Area',
            areas,
            stats: {
                total   : stats.total    || 0,
                aktif   : stats.aktif    || 0,
                nonaktif: stats.nonaktif || 0,
            },
            pagination: {
                currentPage: page,
                totalPages,
                totalCount,
                limit,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1,
            },
            search,
            filterStatus,
            appSettings: req.appSettings,
            page : 'areas',
        });
    } catch (error) {
        logger.error('Error loading areas:', error);
        res.status(500).render('error', { message: 'Error loading areas', error: error.message, appSettings: req.appSettings });
    }
});

// GET /admin/billing/collector-areas — Mapping Area Kolektor
router.get('/collector-areas', getAppSettings, async (req, res) => {
    try {
        const db = require('../config/billing').db;

        // Ambil semua kolektor beserta area mereka
        const collectorsRows = await new Promise((resolve, reject) => {
            db.all(`
                SELECT c.id, c.name, c.phone, 
                       (SELECT GROUP_CONCAT(area, ',') FROM collector_areas WHERE collector_id = c.id) as assigned_areas
                FROM collectors c
                ORDER BY c.name ASC
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        // Ambil semua area yang tersedia (dari tabel areas)
        const allAreas = await new Promise((resolve, reject) => {
            db.all(`SELECT nama_area FROM areas ORDER BY nama_area ASC`, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        const collectors = collectorsRows.map(c => ({
            id: c.id,
            name: c.name,
            phone: c.phone || '-',
            areas: c.assigned_areas ? c.assigned_areas.split(',') : []
        }));

        const areaAssignmentMap = await billingManager.getCollectorAreaAssignmentMap();

        res.render('admin/billing/collector-areas', {
            page: 'collector-areas',
            appSettings: req.appSettings,
            collectors: collectors,
            areas: allAreas,
            areaAssignmentMap
        });
    } catch (error) {
        console.error('Error loading collector areas:', error);
        res.status(500).render('error', { message: 'Error loading collector areas', error: error.message, appSettings: req.appSettings });
    }
});

// POST /admin/billing/collector-areas/save
router.post('/collector-areas/save', adminAuth, async (req, res) => {
    try {
        const { collector_id, areas } = req.body;
        await billingManager.saveCollectorAreas(collector_id, areas || []);
        res.json({ success: true, message: 'Mapping area berhasil diperbarui' });
    } catch (error) {
        console.error('Error saving collector areas:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET /admin/billing/areas/list — API: daftar area (support filter status=aktif)
router.get('/areas/list', async (req, res) => {
    try {
        const db = require('../config/billing').db;
        await ensureAreasTable(db);
        const { status } = req.query;
        const where  = status ? `WHERE status = ?`  : '';
        const params = status ? [status]             : [];
        const areas  = await new Promise((resolve) =>
            db.all(`SELECT id, kode_area, nama_area, deskripsi, status FROM areas ${where} ORDER BY nama_area ASC`, params,
                   (err, rows) => resolve(rows || []))
        );
        res.json({ success: true, data: areas });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// POST /admin/billing/areas — Tambah area baru
router.post('/areas', adminAuth, async (req, res) => {
    try {
        const { kode_area, nama_area, deskripsi, status } = req.body;
        if (!nama_area || !String(nama_area).trim()) {
            return res.status(400).json({ success: false, message: 'Nama area tidak boleh kosong.' });
        }
        const db = require('../config/billing').db;
        await ensureAreasTable(db);

        const trimmed      = String(nama_area).trim();
        const trimmedKode  = kode_area ? String(kode_area).trim().toUpperCase() : null;

        // Cek duplikat nama
        const existing = await new Promise((resolve) =>
            db.get(`SELECT id FROM areas WHERE nama_area = ? COLLATE NOCASE`, [trimmed], (err, row) => resolve(row))
        );
        if (existing) return res.status(409).json({ success: false, message: `Area "${trimmed}" sudah ada.` });

        // Cek duplikat kode (jika diisi)
        if (trimmedKode) {
            const existingKode = await new Promise((resolve) =>
                db.get(`SELECT id FROM areas WHERE kode_area = ? COLLATE NOCASE`, [trimmedKode], (err, row) => resolve(row))
            );
            if (existingKode) return res.status(409).json({ success: false, message: `Kode area "${trimmedKode}" sudah digunakan.` });
        }

        const id = await new Promise((resolve, reject) =>
            db.run(`INSERT INTO areas (kode_area, nama_area, deskripsi, status) VALUES (?, ?, ?, ?)`,
                   [trimmedKode, trimmed, deskripsi || null, status || 'aktif'],
                   function(err) { err ? reject(err) : resolve(this.lastID); })
        );
        res.json({ success: true, message: 'Area berhasil ditambahkan.', id });
    } catch (error) {
        logger.error('Error creating area:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// PUT /admin/billing/areas/:id — Update area
router.put('/areas/:id', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { kode_area, nama_area, deskripsi, status } = req.body;
        if (!nama_area || !String(nama_area).trim()) {
            return res.status(400).json({ success: false, message: 'Nama area tidak boleh kosong.' });
        }
        const db = require('../config/billing').db;
        const trimmed     = String(nama_area).trim();
        const trimmedKode = kode_area ? String(kode_area).trim().toUpperCase() : null;

        // Cek duplikat nama (kecuali dirinya sendiri)
        const existing = await new Promise((resolve) =>
            db.get(`SELECT id FROM areas WHERE nama_area = ? COLLATE NOCASE AND id != ?`, [trimmed, id], (err, row) => resolve(row))
        );
        if (existing) return res.status(409).json({ success: false, message: `Area "${trimmed}" sudah ada.` });

        // Cek duplikat kode (kecuali dirinya sendiri, jika diisi)
        if (trimmedKode) {
            const existingKode = await new Promise((resolve) =>
                db.get(`SELECT id FROM areas WHERE kode_area = ? COLLATE NOCASE AND id != ?`, [trimmedKode, id], (err, row) => resolve(row))
            );
            if (existingKode) return res.status(409).json({ success: false, message: `Kode area "${trimmedKode}" sudah digunakan.` });
        }

        await new Promise((resolve, reject) =>
            db.run(`UPDATE areas SET kode_area=?, nama_area=?, deskripsi=?, status=?, updated_at=datetime('now','localtime') WHERE id=?`,
                   [trimmedKode, trimmed, deskripsi || null, status || 'aktif', id],
                   (err) => err ? reject(err) : resolve())
        );
        res.json({ success: true, message: 'Area berhasil diperbarui.' });
    } catch (error) {
        logger.error('Error updating area:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// PATCH /admin/billing/areas/:id/toggle-status — Toggle aktif/nonaktif
router.patch('/areas/:id/toggle-status', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        if (!['aktif', 'nonaktif'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Status tidak valid.' });
        }
        const db = require('../config/billing').db;
        await new Promise((resolve, reject) =>
            db.run(`UPDATE areas SET status=?, updated_at=datetime('now','localtime') WHERE id=?`,
                   [status, id], (err) => err ? reject(err) : resolve())
        );
        res.json({ success: true, message: `Area berhasil di${status === 'aktif' ? 'aktifkan' : 'nonaktifkan'}.` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// DELETE /admin/billing/areas/:id — Hapus area (cek pemakaian oleh pelanggan)
router.delete('/areas/:id', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const db = require('../config/billing').db;

        // Cek apakah area dipakai pelanggan
        const usageRow = await new Promise((resolve) =>
            db.get(`SELECT COUNT(*) as cnt FROM customers WHERE area_id = ?`, [id], (err, row) => resolve(row || { cnt: 0 }))
        );
        if (usageRow.cnt > 0) {
            return res.status(409).json({
                success: false,
                message: `Area tidak dapat dihapus karena masih digunakan oleh ${usageRow.cnt} pelanggan.`
            });
        }

        await new Promise((resolve, reject) =>
            db.run(`DELETE FROM areas WHERE id = ?`, [id], (err) => err ? reject(err) : resolve())
        );
        res.json({ success: true, message: 'Area berhasil dihapus.' });
    } catch (error) {
        logger.error('Error deleting area:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Customer Management
router.get('/customers', getAppSettings, async (req, res) => {
    try {
        const packages = await billingManager.getPackages();
        // Ensure routers table exists and load routers for dropdown & filter
        const db = require('../config/billing').db;
        await new Promise((resolve) => db.run(`CREATE TABLE IF NOT EXISTS routers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, nas_ip TEXT NOT NULL, nas_identifier TEXT, secret TEXT, location TEXT, pop TEXT, UNIQUE(nas_ip))`, () => resolve()));
        
        // Get auth mode untuk auto-select NAS
        const { getUserAuthModeAsync } = require('../config/mikrotik');
        const authMode = await getUserAuthModeAsync();
        
        // Load routers dari database
        const routers = await new Promise((resolve) => db.all(`SELECT id, name, nas_ip FROM routers ORDER BY id`, (err, rows) => resolve(rows || [])));
        
        // Jika mode RADIUS, cek apakah ada router "RADIUS" atau buat virtual entry
        let radiusRouterId = null;
        if (authMode === 'radius') {
            // Cek apakah sudah ada router dengan nama "RADIUS"
            const radiusRouter = await new Promise((resolve) => db.get(`SELECT id FROM routers WHERE name = 'RADIUS' OR nas_ip = 'RADIUS' LIMIT 1`, (err, row) => resolve(row || null)));
            if (radiusRouter) {
                radiusRouterId = radiusRouter.id;
            } else {
                // Buat virtual router RADIUS untuk display (tidak disimpan ke DB)
                routers.unshift({ id: 'RADIUS', name: 'RADIUS', nas_ip: 'RADIUS Server' });
            }
        }
        
        // OPTIMASI: Gunakan pagination untuk menghindari load semua customer sekaligus
        // Default: 50 customers per page (bisa diubah via query parameter)
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;
        const search = req.query.search ? String(req.query.search).trim() : '';
        const statusFilter = req.query.status ? String(req.query.status).trim() : '';
        
        const routerFilter = req.query.router ? parseInt(req.query.router) : null;
        
        const filters = {};
        if (routerFilter) filters.router_id = routerFilter;
        if (search) filters.search = search;
        if (statusFilter) filters.status = statusFilter;
        
        // Month and Year defaults to current if not provided
        const now = new Date();
        const month = req.query.month ? parseInt(req.query.month) : (now.getMonth() + 1);
        const year = req.query.year ? parseInt(req.query.year) : now.getFullYear();
        filters.month = month;
        filters.year = year;
        

        // Add new filters
        if (req.query.package_id) filters.package_id = req.query.package_id;
        if (req.query.area) filters.area = req.query.area;
        if (req.query.collector_id) filters.collector_id = req.query.collector_id;
        if (req.query.payment_status) filters.payment_status = req.query.payment_status;
        if (req.query.customer_type) filters.customer_type = req.query.customer_type;
        
        // Gunakan satu query builder agar semua filter (termasuk NAS/router) konsisten.
        const customersResult = await billingManager.getCustomersPaginated(limit, offset, filters);
        
        const customers = customersResult.customers;
        
        // Get ODPs for dropdown selection (termasuk sub ODP)
        const odps = await new Promise((resolve, reject) => {
            const db = require('../config/billing').db;
            db.all(`
                SELECT o.id, o.name, o.code, o.capacity, o.used_ports, o.status, o.parent_odp_id,
                       p.name as parent_name, p.code as parent_code
                FROM odps o
                LEFT JOIN odps p ON o.parent_odp_id = p.id
                WHERE o.status = 'active' 
                ORDER BY p.name, o.name
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        
        // Get Collectors for dropdown selection
        const collectors = await new Promise((resolve) => {
            const db = require('../config/billing').db;
            db.all('SELECT id, name, phone FROM collectors WHERE status = "active" ORDER BY name', (err, rows) => {
                resolve(rows || []);
            });
        });

        // Get areas from areas table (status aktif for dropdown, all for filter)
        await ensureAreasTable(db);
        const areasForDropdown = await new Promise((resolve) => {
            db.all('SELECT id, nama_area FROM areas WHERE status = "aktif" ORDER BY nama_area', (err, rows) => {
                resolve(rows || []);
            });
        });

        const uniqueAreas = await new Promise((resolve) => {
            db.all('SELECT DISTINCT area FROM customers WHERE area IS NOT NULL AND area != "" ORDER BY area', (err, rows) => {
                resolve(rows ? rows.map(r => r.area) : []);
            });
        });

        const customerStats = await billingManager.getCustomerStatsByMonth(month, year, filters);
        
        res.render('admin/billing/customers', {
            title: 'Kelola Pelanggan',
            customers,
            customerStats,
            selectedMonth: month,
            selectedYear: year,
            packages,
            odps,
            routers,
            collectors,
            uniqueAreas,
            areasForDropdown,   // tabel areas aktif untuk dropdown form
            routerFilter,
            authMode, // Pass auth mode ke view
            radiusRouterId, // Pass radius router ID jika ada
            pagination: {
                currentPage: customersResult.page,
                totalPages: customersResult.totalPages,
                totalCount: customersResult.totalCount,
                limit: customersResult.limit,
                hasNextPage: customersResult.page < customersResult.totalPages,
                hasPrevPage: customersResult.page > 1
            },
            search: search,
            statusFilter: statusFilter,
            appSettings: req.appSettings,
            filters,
            page: 'customers'
        });
    } catch (error) {
        logger.error('Error loading customers:', error);
        res.status(500).render('error', { 
            message: 'Error loading customers',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

router.post('/customers', customerPhotoUpload.fields([
    { name: 'ktp_photo', maxCount: 1 },
    { name: 'house_photo', maxCount: 1 }
]), async (req, res) => {
    try {
        const { name, username, password, phone, pppoe_username, email, address, area, area_id, package_id, odp_id, pppoe_profile, status: bodyStatus, auto_suspension, billing_day, renewal_type, fix_date, create_pppoe_user, pppoe_password, static_ip, assigned_ip, mac_address, latitude, longitude, cable_type, cable_length, port_number, cable_status, cable_notes, router_id, save_mode } = req.body;
        
        const phoneStored = parsePhoneFromSpreadsheetCell(phone);

        // Validate required fields
        if (!name || !username || !phoneStored || !package_id) {
            return res.status(400).json({
                success: false,
                message: 'Nama, username, telepon, dan paket harus diisi'
            });
        }
        
        // Validate username format
        if (!/^[a-z0-9_]+$/.test(username)) {
            return res.status(400).json({
                success: false,
                message: 'Username hanya boleh berisi huruf kecil, angka, dan underscore'
            });
        }

        const packageData = await billingManager.getPackageById(package_id);
        const profileToUse = resolveCustomerPppoeProfile(pppoe_profile, packageData, null);

        // Password portal: default 123456 jika kosong (sesuai kebijakan form tambah pelanggan)
        const bcrypt = require('bcrypt');
        const pwdPlain = (password && String(password).trim()) || '123456';
        if (pwdPlain.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password portal harus minimal 6 karakter'
            });
        }
        const hashedPassword = await bcrypt.hash(pwdPlain, 10);

        const allowedNewStatus = ['active', 'inactive', 'suspended'];
        const statusFromForm = (bodyStatus && String(bodyStatus).trim()) || '';
        const initialStatus = allowedNewStatus.includes(statusFromForm) ? statusFromForm : 'active';

        const customerData = {
            name,
            username,
            password: hashedPassword,
            phone: phoneStored,
            pppoe_username,
            email,
            address,
            area,
            area_id: area_id ? parseInt(area_id) : null,
            package_id,
            odp_id: odp_id || null,
            pppoe_profile: profileToUse ?? null,
            status: initialStatus,
            auto_suspension: auto_suspension !== undefined ? parseInt(auto_suspension) : 1,
            billing_day: (() => {
                const v = parseInt(billing_day, 10);
                if (Number.isFinite(v)) return Math.min(Math.max(v, 1), 28);
                return 15;
            })(),
            renewal_type: renewal_type || 'renewal',
            fix_date: renewal_type === 'fix_date' ? (() => {
                const v = parseInt(fix_date, 10);
                if (Number.isFinite(v)) return Math.min(Math.max(v, 1), 28);
                return 15;
            })() : null,
            static_ip: static_ip || null,
            assigned_ip: assigned_ip || null,
            mac_address: mac_address || null,
            latitude: latitude !== undefined && latitude !== '' ? parseFloat(latitude) : undefined,
            longitude: longitude !== undefined && longitude !== '' ? parseFloat(longitude) : undefined,
            // Cable connection data
            cable_type: cable_type || null,
            cable_length: cable_length ? parseInt(cable_length) : null,
            port_number: port_number ? parseInt(port_number) : null,
            cable_status: cable_status || 'connected',
            cable_notes: cable_notes || null
        };

        if (!packageUsesPPPoEProfile(packageData)) {
            customerData.__billing_only_package = true;
        }
        
        // Handle photo uploads
        if (req.files) {
            if (req.files.ktp_photo && req.files.ktp_photo[0]) {
                // Get filename from multer
                const filename = req.files.ktp_photo[0].filename;
                // Ensure path starts with /img/
                const ktpPhotoPath = '/img/' + filename;
                customerData.ktp_photo_path = ktpPhotoPath;
                logger.info('Uploaded KTP photo for new customer:', ktpPhotoPath, 'Full path:', req.files.ktp_photo[0].path);
            }
            if (req.files.house_photo && req.files.house_photo[0]) {
                // Get filename from multer
                const filename = req.files.house_photo[0].filename;
                // Ensure path starts with /img/
                const housePhotoPath = '/img/' + filename;
                customerData.house_photo_path = housePhotoPath;
                logger.info('Uploaded house photo for new customer:', housePhotoPath, 'Full path:', req.files.house_photo[0].path);
            }
        }

        const result = await billingManager.createCustomer(customerData);
        // Map customer ke router jika dipilih
        // Handle khusus untuk mode RADIUS: router_id bisa berupa "RADIUS" (string)
        let mappedRouterId = null;
        try {
            if (router_id && router_id !== '' && router_id !== 'RADIUS') {
                // Mode API: router_id adalah integer ID router
                const db = require('../config/billing').db;
                mappedRouterId = parseInt(router_id);
                if (!isNaN(mappedRouterId)) {
                    await new Promise((resolve, reject) => {
                        db.run(`INSERT OR REPLACE INTO customer_router_map (customer_id, router_id) VALUES (?, ?)`, [result.id, mappedRouterId], (err) => err ? reject(err) : resolve());
                    });
                }
            } else if (router_id === 'RADIUS') {
                // Mode RADIUS: tidak perlu mapping ke router spesifik, semua menggunakan RADIUS database
                logger.info(`Customer ${result.id} menggunakan mode RADIUS - tidak perlu router mapping`);
            }
        } catch (e) {
            logger.warn('Gagal menyimpan mapping customer_router_map: ' + e.message);
        }

        // Optional: create PPPoE user (support both API and RADIUS mode)
        // Auto-create jika checkbox dicentang atau jika pppoe_username diisi
        let pppoeCreate = { attempted: false, created: false, message: '' };
        try {
            const shouldCreate = create_pppoe_user === 1 || create_pppoe_user === '1' || create_pppoe_user === true || create_pppoe_user === 'true';
            const pkgUsesPppoe = packageUsesPPPoEProfile(packageData);
            // Paket non-PPPoE: jangan buat user RADIUS/Mikrotik walau checkbox/username terisi
            if (pkgUsesPppoe && (shouldCreate || pppoe_username) && pppoe_username) {
                pppoeCreate.attempted = true;
                
                // Generate password jika tidak diberikan
                const passwordToUse = (pppoe_password && String(pppoe_password).trim())
                    ? String(pppoe_password).trim()
                    : 'skynet1010';

                const { addPPPoEUser, getUserAuthModeAsync } = require('../config/mikrotik');
                
                // Helper function untuk get router by ID
                const getRouterById = async (routerId) => {
                    try {
                        const db = require('../config/billing').db;
                        return new Promise((resolve, reject) => {
                            db.get('SELECT * FROM routers WHERE id = ?', [parseInt(routerId)], (err, row) => {
                                if (err) reject(err);
                                else resolve(row || null);
                            });
                        });
                    } catch (err) {
                        logger.warn(`Failed to get router by ID ${routerId}: ${err.message}`);
                        return null;
                    }
                };
                
                // Cek mode autentikasi untuk logging
                const authMode = await getUserAuthModeAsync();
                logger.info(`Creating PPPoE user ${pppoe_username} with profile ${profileToUse || '(none)'} (Mode: ${authMode})`);
                
                // Pass customer object dengan id untuk per-router connection di mode API
                // Di mode RADIUS, routerObj tidak diperlukan karena semua router pakai database yang sama
                // Handle router_id: jika "RADIUS", set routerObj ke null
                let routerObj = null;
                if (router_id && router_id !== '' && router_id !== 'RADIUS') {
                    routerObj = await getRouterById(router_id);
                }
                const addRes = await addPPPoEUser({ 
                    username: pppoe_username, 
                    password: passwordToUse, 
                    profile: profileToUse, 
                    customer: { id: result.id },
                    routerObj: routerObj
                });
                
                if (addRes && addRes.success) {
                    pppoeCreate.created = true;
                    pppoeCreate.message = `User PPPoE berhasil dibuat di ${authMode === 'radius' ? 'RADIUS' : 'Mikrotik'}`;
                    pppoeCreate.password = passwordToUse; // Return password untuk ditampilkan ke user
                    logger.info(`✅ PPPoE user ${pppoe_username} created successfully in ${authMode} mode`);
                } else {
                    pppoeCreate.created = false;
                    pppoeCreate.message = (addRes && addRes.message) ? addRes.message : 'Gagal membuat user PPPoE';
                    logger.error(`❌ Failed to create PPPoE user ${pppoe_username}: ${addRes?.message || 'Unknown error'}`);
                }
            }
        } catch (e) {
            logger.error('Gagal membuat user PPPoE (opsional): ' + e.message);
            pppoeCreate.created = false;
            pppoeCreate.message = e.message;
        }

        if (save_mode === 'save_and_create_task') {
            const prefillInstallationCustomer = {
                customer_id: result.id,
                customer_name: result.name || name,
                customer_phone: result.phone || phone,
                customer_address: (result.address != null && result.address !== '') ? result.address : (address || ''),
                package_id: package_id ? parseInt(package_id, 10) : null,
                pppoe_username: pppoe_username || '',
                pppoe_password: (pppoeCreate && pppoeCreate.password) ? pppoeCreate.password : (pppoe_password || '')
            };
            req.session.prefillInstallationCustomer = prefillInstallationCustomer;
            req.session.save((err) => {
                if (err) {
                    logger.error('Error saving session for prefill:', err);
                }
                res.json({
                    success: true,
                    message: 'Pelanggan berhasil ditambahkan',
                    customer: result,
                    pppoeCreate,
                    prefill_installation: prefillInstallationCustomer,
                    redirect_to_task: '/admin/installations/create?prefill_customer=1'
                });
            });
        } else {
            res.json({
                success: true,
                message: 'Pelanggan berhasil ditambahkan',
                customer: result,
                pppoeCreate,
                redirect_to_task: null
            });
        }
    } catch (error) {
        logger.error('Error creating customer:', error);
        
        // Handle specific error messages dengan penjelasan yang jelas
        let errorMessage = 'Gagal menambahkan pelanggan';
        let statusCode = 500;
        let errorDetails = '';
        
        if (error.message.includes('UNIQUE constraint failed')) {
            if (error.message.includes('customers.phone')) {
                errorMessage = 'Nomor telepon sudah terdaftar';
                errorDetails = 'Nomor telepon yang Anda masukkan sudah digunakan oleh pelanggan lain. Silakan gunakan nomor telepon yang berbeda atau cek data pelanggan yang sudah ada.';
            } else if (error.message.includes('customers.username')) {
                errorMessage = 'Username login sudah digunakan';
                errorDetails =
                    'Kolom Username (login portal / billing) bentrok dengan pelanggan lain — ini bukan username PPPoE. ' +
                    'Ubah kolom Username di form, atau kosongkan lalu simpan lagi. Username PPPoE (mis. rumah-ato) terpisah dan boleh unik sendiri.';
            } else if (error.message.includes('customers.customer_id')) {
                errorMessage = 'ID Pelanggan duplikat';
                errorDetails = 'Terjadi konflik ID Pelanggan. Silakan coba lagi atau hubungi administrator.';
            } else {
                errorMessage = 'Data duplikat terdeteksi';
                errorDetails = 'Data yang Anda masukkan sudah ada dalam sistem. Silakan cek kembali nomor telepon, username, atau data lainnya.';
            }
            statusCode = 400;
        } else if (error.message.includes('FOREIGN KEY constraint failed')) {
            if (error.message.includes('package_id')) {
                errorMessage = 'Paket tidak valid';
                errorDetails = 'Paket yang dipilih tidak ditemukan atau tidak aktif. Silakan pilih paket yang tersedia dari daftar paket.';
            } else if (error.message.includes('odp_id')) {
                errorMessage = 'ODP tidak valid';
                errorDetails = 'ODP (Optical Distribution Point) yang dipilih tidak ditemukan. Silakan pilih ODP yang tersedia atau kosongkan field ini.';
            } else {
                errorMessage = 'Data referensi tidak valid';
                errorDetails = 'Salah satu data referensi (paket, ODP, dll) tidak valid. Silakan cek kembali pilihan Anda.';
            }
            statusCode = 400;
        } else if (error.message.includes('NOT NULL constraint failed')) {
            if (error.message.includes('name')) {
                errorMessage = 'Nama pelanggan wajib diisi';
                errorDetails = 'Field nama pelanggan tidak boleh kosong. Silakan isi nama pelanggan.';
            } else if (error.message.includes('phone')) {
                errorMessage = 'Nomor telepon wajib diisi';
                errorDetails = 'Field nomor telepon tidak boleh kosong. Silakan isi nomor telepon pelanggan.';
            } else if (error.message.includes('username')) {
                errorMessage = 'Username wajib diisi';
                errorDetails = 'Field username tidak boleh kosong. Username akan otomatis terisi dari nama jika dikosongkan.';
            } else if (error.message.includes('package_id')) {
                errorMessage = 'Paket wajib dipilih';
                errorDetails = 'Anda harus memilih paket untuk pelanggan. Silakan pilih paket dari dropdown.';
            } else {
                errorMessage = 'Data wajib tidak lengkap';
                errorDetails = 'Beberapa field wajib tidak diisi. Silakan lengkapi semua field yang bertanda (*).';
            }
            statusCode = 400;
        } else if (error.message.includes('Failed to generate customer ID')) {
            errorMessage = 'Gagal membuat ID Pelanggan';
            errorDetails = 'Sistem tidak dapat membuat ID Pelanggan unik. Silakan coba lagi atau hubungi administrator.';
            statusCode = 500;
        } else if (error.message.includes('Database not initialized')) {
            errorMessage = 'Database tidak siap';
            errorDetails = 'Database belum siap digunakan. Silakan tunggu beberapa saat dan coba lagi, atau hubungi administrator.';
            statusCode = 500;
        } else {
            // Error umum - tampilkan pesan asli untuk debugging
            errorMessage = 'Terjadi kesalahan saat menambahkan pelanggan';
            errorDetails = error.message || 'Silakan cek kembali data yang Anda masukkan atau hubungi administrator jika masalah berlanjut.';
        }
        
        res.status(statusCode).json({
            success: false,
            message: errorMessage,
            details: errorDetails,
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Get customer detail
router.get('/customers/:phone', getAppSettings, async (req, res) => {
    try {
        const { phone } = req.params;
        logger.info(`Loading customer detail for phone: ${phone}`);
        
        const customer = await billingManager.getCustomerByPhone(phone);
        logger.info(`Customer found:`, customer);
        
        if (!customer) {
            logger.warn(`Customer not found for phone: ${phone}`);
            return res.status(404).render('error', {
                message: 'Pelanggan tidak ditemukan',
                error: 'Customer not found',
                appSettings: req.appSettings
            });
        }

        // Get PPPoE password (from RADIUS or Mikrotik API)
        let pppoePassword = null;
        let authMode = null;
        try {
            const { getUserAuthModeAsync, getRadiusConnection, getMikrotikConnection } = require('../config/mikrotik');
            authMode = await getUserAuthModeAsync();
            const pppoeUsername = customer.pppoe_username || customer.username;
            
            if (pppoeUsername) {
                if (authMode === 'radius') {
                    // Get password from RADIUS database
                    const conn = await getRadiusConnection();
                    try {
                        const [rows] = await conn.execute(`
                            SELECT value as password 
                            FROM radcheck 
                            WHERE username = ? AND attribute = 'Cleartext-Password'
                            LIMIT 1
                        `, [pppoeUsername]);
                        await conn.end();
                        if (rows && rows.length > 0) {
                            pppoePassword = rows[0].password;
                        }
                    } catch (radiusError) {
                        logger.warn(`Failed to get password from RADIUS for ${pppoeUsername}: ${radiusError.message}`);
                        await conn.end();
                    }
                } else {
                    // Get password from Mikrotik API
                    try {
                        const conn = await getMikrotikConnection();
                        if (conn) {
                            const secrets = await conn.write('/ppp/secret/print', ['?name=' + pppoeUsername]);
                            if (secrets && secrets.length > 0) {
                                pppoePassword = secrets[0].password || null;
                            }
                        }
                    } catch (mikrotikError) {
                        logger.warn(`Failed to get password from Mikrotik for ${pppoeUsername}: ${mikrotikError.message}`);
                    }
                }
            }
        } catch (passwordError) {
            logger.warn(`Error getting PPPoE password: ${passwordError.message}`);
        }

        const invoices = await billingManager.getInvoicesByCustomer(customer.id);
        const packages = await billingManager.getPackages();
        // Load trouble report history for this customer (by phone)
        let troubleReports = [];
        try {
            const { getTroubleReportsByPhone } = require('../config/troubleReport');
            troubleReports = getTroubleReportsByPhone(customer.phone || phone) || [];
        } catch (e) {
            logger.warn('Unable to load trouble reports for customer:', e.message);
        }
        
        let assignedCollectorId = null;
        let activeCollectors = [];
        try {
            const dbPath = path.join(__dirname, '../data/billing.db');
            const dblcl = new sqlite3.Database(dbPath);
            const mappingRow = await new Promise((resolve) => dblcl.get(`SELECT collector_id FROM collector_assignments WHERE customer_id = ?`, [customer.id], (err, row) => resolve(row)));
            if (mappingRow) assignedCollectorId = mappingRow.collector_id;
            
            activeCollectors = await new Promise((resolve) => dblcl.all(`SELECT id, name FROM collectors WHERE status = 'active'`, (err, rows) => resolve(rows || [])));
            dblcl.close();
        } catch (e) {
            logger.warn('Failed to load collector assigning options:', e.message);
        }
        
        logger.info(`Rendering customer detail page for: ${phone}`);
        
        // Try to render with minimal data first
        try {
            res.render('admin/billing/customer-detail', {
                title: 'Detail Pelanggan',
                customer,
                pppoePassword, // Pass password to view
                authMode, // Pass auth mode to view
                invoices: invoices || [],
                packages: packages || [],
                troubleReports,
                activeCollectors,
                assignedCollectorId,
                appSettings: req.appSettings
            });
        } catch (renderError) {
            logger.error('Error rendering customer detail page:', renderError);
            res.status(500).render('error', {
                message: 'Error rendering customer detail page',
                error: renderError.message,
                appSettings: req.appSettings
            });
        }
    } catch (error) {
        logger.error('Error loading customer detail:', error);
        res.status(500).render('error', {
            message: 'Error loading customer detail',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// API route for getting customer data (for editing)
router.get('/api/customers/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        logger.info(`API: Loading customer data for editing phone: ${phone}`);
        
        const customer = await billingManager.getCustomerByPhone(phone);
        // Ambil router mapping
        let routerMapping = null;
        try {
            const db = require('../config/billing').db;
            routerMapping = await new Promise((resolve) => db.get(`SELECT router_id FROM customer_router_map WHERE customer_id = ?`, [customer?.id || -1], (err, row) => resolve(row || null)));
        } catch (_) {}
        
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Customer not found'
            });
        }

        return res.json({
            success: true,
            customer: Object.assign({}, customer || {}, { router_id: routerMapping ? routerMapping.router_id : null }),
            message: 'Customer data loaded successfully'
        });
    } catch (error) {
        logger.error('API: Error loading customer data:', error);
        return res.status(500).json({
            success: false,
            message: 'Error loading customer data',
            error: error.message
        });
    }
});

// Debug route for customer detail
router.get('/customers/:username/debug', getAppSettings, async (req, res) => {
    try {
        const { username } = req.params;
        logger.info(`Debug: Loading customer detail for username: ${username}`);
        
        const customer = await billingManager.getCustomerByUsername(username);
        logger.info(`Debug: Customer found:`, customer);
        
        if (!customer) {
            return res.json({
                success: false,
                message: 'Customer not found',
                username: username
            });
        }

        const invoices = await billingManager.getInvoicesByCustomer(customer.id);
        const packages = await billingManager.getPackages();
        
        return res.json({
            success: true,
            customer: customer,
            invoices: invoices,
            packages: packages,
            message: 'Debug data loaded successfully'
        });
    } catch (error) {
        logger.error('Debug: Error loading customer detail:', error);
        return res.json({
            success: false,
            message: 'Error loading customer detail',
            error: error.message
        });
    }
});

// Test route with simple template (no auth for debugging)
router.get('/customers/:username/test', async (req, res) => {
    try {
        const { username } = req.params;
        logger.info(`Test: Loading customer detail for username: ${username}`);
        
        const customer = await billingManager.getCustomerByUsername(username);
        logger.info(`Test: Customer found:`, customer);
        
        if (!customer) {
            return res.status(404).render('error', {
                message: 'Pelanggan tidak ditemukan',
                error: 'Customer not found',
                appSettings: {}
            });
        }

        const invoices = await billingManager.getInvoicesByCustomer(customer.id);
        const packages = await billingManager.getPackages();
        
        logger.info(`Test: Rendering simple template for: ${username}`);
        res.render('admin/billing/customer-detail-test', {
            title: 'Detail Pelanggan - Test',
            customer,
            invoices: invoices || [],
            packages: packages || [],
            appSettings: {}
        });
    } catch (error) {
        logger.error('Test: Error loading customer detail:', error);
        res.status(500).render('error', {
            message: 'Error loading customer detail',
            error: error.message,
            appSettings: {}
        });
    }
});

router.put('/customers/:phone', customerPhotoUpload.fields([
    { name: 'ktp_photo', maxCount: 1 },
    { name: 'house_photo', maxCount: 1 }
]), async (req, res) => {
    try {
        const { phone } = req.params;
        
        // Debug: Log request body to see what we're receiving
        logger.debug('PUT /customers/:phone - Request body:', JSON.stringify(req.body));
        logger.debug('PUT /customers/:phone - Request files:', req.files ? Object.keys(req.files) : 'No files');
        
        // Extract form data from req.body (multer puts form fields here)
        const name = req.body.name;
        const username = req.body.username;
        const package_id = req.body.package_id;
        const pppoe_username = req.body.pppoe_username;
        const email = req.body.email;
        const address = req.body.address;
        const area = req.body.area;
        const odp_id = req.body.odp_id;
        const pppoe_profile = req.body.pppoe_profile;
        const status = req.body.status;
        const auto_suspension = req.body.auto_suspension;
        const billing_day = req.body.billing_day;
        const renewal_type = req.body.renewal_type;
        const fix_date = req.body.fix_date;
        const latitude = req.body.latitude;
        const longitude = req.body.longitude;
        const static_ip = req.body.static_ip;
        const assigned_ip = req.body.assigned_ip;
        const mac_address = req.body.mac_address;
        const cable_type = req.body.cable_type;
        const cable_length = req.body.cable_length;
        const port_number = req.body.port_number;
        const cable_status = req.body.cable_status;
        const cable_notes = req.body.cable_notes;
        const router_id = req.body.router_id;
        
        // Validate required fields - check for empty strings too
        if (!name || name.trim() === '' || !username || username.trim() === '' || !package_id || package_id.toString().trim() === '') {
            logger.warn('PUT /customers/:phone - Validation failed:', { 
                name: name || 'MISSING', 
                username: username || 'MISSING', 
                package_id: package_id || 'MISSING',
                bodyKeys: Object.keys(req.body),
                bodyValues: {
                    name: req.body.name,
                    username: req.body.username,
                    package_id: req.body.package_id
                }
            });
            return res.status(400).json({
                success: false,
                message: 'Nama, username, dan paket harus diisi'
            });
        }
        
        // Validate username format
        if (!/^[a-z0-9_]+$/.test(username)) {
            return res.status(400).json({
                success: false,
                message: 'Username hanya boleh berisi huruf kecil, angka, dan underscore'
            });
        }
        
        // Get current customer data
        const currentCustomer = await billingManager.getCustomerByPhone(phone);
        if (!currentCustomer) {
            return res.status(404).json({
                success: false,
                message: 'Pelanggan tidak ditemukan'
            });
        }

        const packageRowForProfile = package_id ? await billingManager.getPackageById(package_id) : null;
        const profileToUse = resolveCustomerPppoeProfile(pppoe_profile, packageRowForProfile, currentCustomer.pppoe_profile);

        // Extract new phone from request body, fallback to current if not provided
        const newPhone = req.body.phone
            ? parsePhoneFromSpreadsheetCell(req.body.phone)
            : currentCustomer.phone;
        const password = req.body.password;
        
        let hashedPassword = undefined;
        if (password && password.trim().length >= 6) {
            const bcrypt = require('bcrypt');
            hashedPassword = await bcrypt.hash(password.trim(), 10);
        } else if (password) {
            return res.status(400).json({
                success: false,
                message: 'Password portal harus minimal 6 karakter'
            });
        }
        
        const customerData = {
            name: name,
            username: username,
            password: hashedPassword,
            phone: newPhone,
            pppoe_username: pppoe_username || currentCustomer.pppoe_username,
            email: email || currentCustomer.email,
            address: address || currentCustomer.address,
            area: area !== undefined ? area : currentCustomer.area,
            package_id: package_id,
            odp_id: odp_id !== undefined ? odp_id : currentCustomer.odp_id,
            pppoe_profile: profileToUse ?? null,
            status: status || currentCustomer.status,
            auto_suspension: auto_suspension !== undefined ? parseInt(auto_suspension) : currentCustomer.auto_suspension,
            billing_day: (function(){
                const v = parseInt(billing_day, 10);
                if (Number.isFinite(v)) return Math.min(Math.max(v, 1), 28);
                return currentCustomer.billing_day ?? 1;
            })(),
            renewal_type: renewal_type !== undefined ? renewal_type : (currentCustomer.renewal_type || 'renewal'),
            fix_date: renewal_type === 'fix_date' ? (function(){
                const v = parseInt(fix_date, 10);
                if (Number.isFinite(v)) return Math.min(Math.max(v, 1), 28);
                return currentCustomer.fix_date ?? 15;
            })() : (renewal_type === undefined && currentCustomer.renewal_type === 'fix_date' ? currentCustomer.fix_date : null),
            latitude: latitude !== undefined ? parseFloat(latitude) : currentCustomer.latitude,
            longitude: longitude !== undefined ? parseFloat(longitude) : currentCustomer.longitude,
            static_ip: static_ip !== undefined ? static_ip : currentCustomer.static_ip,
            assigned_ip: assigned_ip !== undefined ? assigned_ip : currentCustomer.assigned_ip,
            mac_address: mac_address !== undefined ? mac_address : currentCustomer.mac_address,
            // Cable connection data
            cable_type: cable_type !== undefined ? cable_type : currentCustomer.cable_type,
            cable_length: cable_length !== undefined ? parseInt(cable_length) : currentCustomer.cable_length,
            port_number: port_number !== undefined ? parseInt(port_number) : currentCustomer.port_number,
            cable_status: cable_status !== undefined ? cable_status : currentCustomer.cable_status,
            cable_notes: cable_notes !== undefined ? cable_notes : currentCustomer.cable_notes
        };
        
        // Handle photo uploads - only update if new files are uploaded
        if (req.files) {
            if (req.files.ktp_photo && req.files.ktp_photo[0]) {
                // Delete old photo if exists
                if (currentCustomer.ktp_photo_path) {
                    try {
                        const oldPhotoPath = path.join(__dirname, '../public', currentCustomer.ktp_photo_path);
                        if (fs.existsSync(oldPhotoPath)) {
                            fs.unlinkSync(oldPhotoPath);
                            logger.info('Deleted old KTP photo:', oldPhotoPath);
                        }
                    } catch (e) {
                        logger.warn('Failed to delete old KTP photo: ' + e.message);
                    }
                }
                // Get filename from multer
                const filename = req.files.ktp_photo[0].filename;
                // Ensure path starts with /img/
                const ktpPhotoPath = '/img/' + filename;
                customerData.ktp_photo_path = ktpPhotoPath;
                logger.info('Uploaded new KTP photo:', ktpPhotoPath, 'Full path:', req.files.ktp_photo[0].path);
            }
            if (req.files.house_photo && req.files.house_photo[0]) {
                // Delete old photo if exists
                if (currentCustomer.house_photo_path) {
                    try {
                        const oldPhotoPath = path.join(__dirname, '../public', currentCustomer.house_photo_path);
                        if (fs.existsSync(oldPhotoPath)) {
                            fs.unlinkSync(oldPhotoPath);
                            logger.info('Deleted old house photo:', oldPhotoPath);
                        }
                    } catch (e) {
                        logger.warn('Failed to delete old house photo: ' + e.message);
                    }
                }
                // Get filename from multer
                const filename = req.files.house_photo[0].filename;
                // Ensure path starts with /img/
                const housePhotoPath = '/img/' + filename;
                customerData.house_photo_path = housePhotoPath;
                logger.info('Uploaded new house photo:', housePhotoPath, 'Full path:', req.files.house_photo[0].path);
            }
        }
        
        // PENTING: Cek perubahan status sebelum update
        const oldStatus = currentCustomer.status;
        const newStatus = status || currentCustomer.status;
        const statusChanged = newStatus !== oldStatus;
        if (statusChanged && (newStatus === 'suspended' || newStatus === 'active')) {
            customerData.__skip_radius_sync = true;
        }
        
        // Use current phone for lookup, allow phone to be updated in customerData
        const result = await billingManager.updateCustomerByPhone(phone, customerData);

        // PENTING: Jika status berubah, sync ke RADIUS/Mikrotik
        if (statusChanged && customerData.pppoe_username) {
            try {
                const serviceSuspension = require('../config/serviceSuspension');
                const updatedCustomer = await billingManager.getCustomerByPhone(customerData.phone || phone);
                
                if (newStatus === 'suspended' && oldStatus !== 'suspended') {
                    // Status berubah ke suspended -> isolir
                    logger.info(`[BILLING] Status changed to suspended for ${updatedCustomer.username}, calling suspendCustomerService...`);
                    await serviceSuspension.suspendCustomerService(updatedCustomer, 'Status changed to suspended via admin panel');
                    logger.info(`[BILLING] Successfully suspended customer ${updatedCustomer.username}`);
                } else if (newStatus === 'active' && oldStatus === 'suspended') {
                    // Status berubah dari suspended ke active -> restore
                    logger.info(`[BILLING] Status changed from suspended to active for ${updatedCustomer.username}, calling restoreCustomerService...`);
                    await serviceSuspension.restoreCustomerService(updatedCustomer, 'Status changed to active via admin panel');
                    logger.info(`[BILLING] Successfully restored customer ${updatedCustomer.username}`);
                }
            } catch (statusSyncError) {
                logger.error(`[BILLING] Failed to sync status change for ${customerData.username}:`, statusSyncError.message);
                // Jangan gagalkan update customer jika error sync status
            }
        }

        // Update NAS mapping jika router_id diberikan
        try {
            if (router_id) {
                const db = require('../config/billing').db;
                const customerAfter = await billingManager.getCustomerByPhone(customerData.phone);
                if (customerAfter && customerAfter.id) {
                    await new Promise((resolve, reject) => {
                        db.run(`INSERT OR REPLACE INTO customer_router_map (customer_id, router_id) VALUES (?, ?)`, [customerAfter.id, parseInt(router_id)], (err) => err ? reject(err) : resolve());
                    });
                }
            }
        } catch (e) {
            logger.warn('Gagal update mapping customer_router_map: ' + e.message);
        }

        // Optional: create or update PPPoE user (support both API and RADIUS mode)
        // Auto-create jika checkbox dicentang atau jika pppoe_username baru/diubah
        let pppoeCreate = { attempted: false, created: false, updated: false, message: '' };
        try {
            const shouldCreate = req.body.create_pppoe_user === 1 || req.body.create_pppoe_user === '1' || req.body.create_pppoe_user === true || req.body.create_pppoe_user === 'true';
            const newPPPoEUsername = pppoe_username || currentCustomer.pppoe_username;
            const pppoePassword = req.body.pppoe_password || null;
            const hasExplicitPppoePassword = !!(pppoePassword && String(pppoePassword).trim());
            const isUsernameChanged = !!(newPPPoEUsername && newPPPoEUsername !== currentCustomer.pppoe_username);
            
            // Helper function untuk get router by ID
            const getRouterById = async (routerId) => {
                try {
                    const db = require('../config/billing').db;
                    return new Promise((resolve, reject) => {
                        db.get('SELECT * FROM routers WHERE id = ?', [parseInt(routerId)], (err, row) => {
                            if (err) reject(err);
                            else resolve(row || null);
                        });
                    });
                } catch (err) {
                    logger.warn(`Failed to get router by ID ${routerId}: ${err.message}`);
                    return null;
                }
            };
            
            // SAFETY:
            // - Pilih PPPoE existing tanpa isi password JANGAN ubah password di RADIUS/Mikrotik.
            // - Proses create/update PPPoE hanya jika:
            //   1) user memang centang create_pppoe_user, ATAU
            //   2) user mengisi password PPPoE baru secara eksplisit.
            // Dengan ini, perubahan mapping/link username saja tidak akan me-reset password acak.
            const shouldProcessPppoeProvisioning = !!(newPPPoEUsername && (shouldCreate || hasExplicitPppoePassword));
            if (isUsernameChanged && !shouldProcessPppoeProvisioning) {
                logger.info(`[BILLING] PPPoE username changed to existing/link-only (${newPPPoEUsername}) without password; skipping PPPoE credential update`);
            }

            if (shouldProcessPppoeProvisioning) {
                pppoeCreate.attempted = true;
                
                // Generate password hanya saat provisioning eksplisit tanpa password.
                // Untuk alur link existing tanpa provisioning, blok ini tidak akan dijalankan.
                const passwordToUse = hasExplicitPppoePassword
                    ? String(pppoePassword).trim()
                    : (Math.random().toString(36).slice(-8) + Math.floor(Math.random()*10));

                const { addPPPoEUser, editPPPoEUser, getUserAuthModeAsync, getPPPoEUsers } = require('../config/mikrotik');
                
                // Cek mode autentikasi untuk logging
                const authMode = await getUserAuthModeAsync();
                logger.info(`Creating/updating PPPoE user ${newPPPoEUsername} with profile ${profileToUse} (Mode: ${authMode})`);
                
                // Cek apakah user sudah ada di RADIUS atau Mikrotik
                const existingUsers = await getPPPoEUsers();
                const userExists = existingUsers.some(u => u.name === newPPPoEUsername || u.username === newPPPoEUsername);
                
                let addRes;
                const updatedCustomer = await billingManager.getCustomerByPhone(customerData.phone || phone);
                const customerId = updatedCustomer ? updatedCustomer.id : result.id;
                
                if (userExists && currentCustomer.pppoe_username === newPPPoEUsername) {
                    // Update existing user (password atau profile)
                    if (authMode === 'radius') {
                        const { editPPPoEUserRadius } = require('../config/mikrotik');
                        addRes = await editPPPoEUserRadius({ 
                            username: newPPPoEUsername, 
                            password: passwordToUse, 
                            profile: profileToUse 
                        });
                    } else {
                        // Mode Mikrotik: cari ID user dulu
                        const existingUser = existingUsers.find(u => (u.name === newPPPoEUsername || u.username === newPPPoEUsername));
                        if (existingUser && existingUser.id) {
                            addRes = await editPPPoEUser({ 
                                id: existingUser.id, 
                                username: newPPPoEUsername, 
                                password: passwordToUse, 
                                profile: profileToUse 
                            });
                        } else {
                            // Fallback: create new jika tidak ketemu ID
                            // Handle router_id: jika "RADIUS", set routerObj ke null
                            let routerObj = null;
                            if (router_id && router_id !== '' && router_id !== 'RADIUS') {
                                routerObj = await getRouterById(router_id);
                            }
                            addRes = await addPPPoEUser({ 
                                username: newPPPoEUsername, 
                                password: passwordToUse, 
                                profile: profileToUse, 
                                customer: { id: customerId },
                                routerObj: routerObj
                            });
                        }
                    }
                    pppoeCreate.updated = true;
                } else {
                    // Create new user
                    // Handle router_id: jika "RADIUS", set routerObj ke null
                    let routerObj = null;
                    if (router_id && router_id !== '' && router_id !== 'RADIUS') {
                        routerObj = await getRouterById(router_id);
                    }
                    addRes = await addPPPoEUser({ 
                        username: newPPPoEUsername, 
                        password: passwordToUse, 
                        profile: profileToUse, 
                        customer: { id: customerId },
                        routerObj: routerObj
                    });
                }
                
                if (addRes && addRes.success) {
                    pppoeCreate.created = true;
                    pppoeCreate.message = `User PPPoE berhasil ${pppoeCreate.updated ? 'diupdate' : 'dibuat'} di ${authMode === 'radius' ? 'RADIUS' : 'Mikrotik'}`;
                    pppoeCreate.password = passwordToUse; // Return password untuk ditampilkan ke user
                    logger.info(`✅ PPPoE user ${newPPPoEUsername} ${pppoeCreate.updated ? 'updated' : 'created'} successfully in ${authMode} mode`);
                } else {
                    pppoeCreate.created = false;
                    pppoeCreate.message = (addRes && addRes.message) ? addRes.message : 'Gagal membuat/update user PPPoE';
                    logger.error(`❌ Failed to create/update PPPoE user ${newPPPoEUsername}: ${addRes?.message || 'Unknown error'}`);
                }
            }
        } catch (e) {
            logger.error('Gagal membuat/update user PPPoE (opsional): ' + e.message);
            pppoeCreate.created = false;
            pppoeCreate.message = e.message;
        }
        
        // Jika update berhasil dan customer memiliki PPPoE, update profil di Mikrotik (untuk perubahan package)
        if (result && customerData.pppoe_username) {
            try {
                const updatedCustomer = await billingManager.getCustomerByPhone(customerData.phone || phone);
                const packageChanged =
                    updatedCustomer &&
                    updatedCustomer.package_id !== currentCustomer.package_id;
                const profileChanged =
                    updatedCustomer &&
                    (updatedCustomer.pppoe_profile || null) !== (currentCustomer.pppoe_profile || null);
                if (updatedCustomer && (packageChanged || profileChanged)) {
                    const { isSuspendedStatus } = require('../utils/customerSuspendReason');
                    if (isSuspendedStatus(updatedCustomer.status)) {
                        logger.info(
                            `[BILLING] Package/profile changed for suspended ${updatedCustomer.username} — update PREVGROUP only`
                        );
                        await serviceSuspension.updatePackageForSuspendedCustomer(
                            updatedCustomer,
                            'Package changed while suspended'
                        );
                    } else {
                        logger.info(`[BILLING] Package changed for ${updatedCustomer.username}, updating PPPoE profile...`);
                        await serviceSuspension.restoreCustomerService(updatedCustomer, 'Package changed');
                        logger.info(`[BILLING] PPPoE profile updated successfully for ${updatedCustomer.username}`);
                    }
                }
            } catch (mikrotikError) {
                logger.error(`[BILLING] Failed to update PPPoE profile for ${customerData.username}:`, mikrotikError.message);
            }
        }

        res.json({
            success: true,
            message: 'Pelanggan berhasil diupdate',
            customer: result,
            pppoeCreate
        });
    } catch (error) {
        logger.error('Error updating customer:', error);
        
        // Handle specific error messages
        let errorMessage = 'Gagal mengupdate pelanggan';
        let statusCode = 500;
        
        if (error.message.includes('Pelanggan tidak ditemukan')) {
            errorMessage = 'Pelanggan tidak ditemukan';
            statusCode = 404;
        } else if (error.message.includes('UNIQUE constraint failed')) {
            if (error.message.includes('phone')) {
                errorMessage = 'Nomor telepon sudah terdaftar. Silakan gunakan nomor telepon yang berbeda.';
            } else if (error.message.includes('username')) {
                errorMessage = 'Username sudah digunakan. Silakan coba lagi.';
            } else {
                errorMessage = 'Data sudah ada dalam sistem. Silakan cek kembali.';
            }
            statusCode = 400;
        } else if (error.message.includes('FOREIGN KEY constraint failed')) {
            errorMessage = 'Paket yang dipilih tidak valid. Silakan pilih paket yang tersedia.';
            statusCode = 400;
        } else if (error.message.includes('not null constraint')) {
            errorMessage = 'Data wajib tidak boleh kosong. Silakan lengkapi semua field yang diperlukan.';
            statusCode = 400;
        }
        
        res.status(statusCode).json({
            success: false,
            message: errorMessage,
            error: error.message
        });
    }
});

// Accept customer (generate PPPoE and send notifications)
router.post('/customers/:phone/accept', async (req, res) => {
    try {
        const { phone } = req.params;
        
        // Get customer
        const customer = await billingManager.getCustomerByPhone(phone);
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Pelanggan tidak ditemukan'
            });
        }
        
        // Check if customer status is 'register'
        if (customer.status !== 'register') {
            return res.status(400).json({
                success: false,
                message: `Pelanggan ini sudah di-accept sebelumnya. Status saat ini: ${customer.status}`
            });
        }
        
        // Get package info
        const packageData = await billingManager.getPackageById(customer.package_id);
        if (!packageData) {
            return res.status(400).json({
                success: false,
                message: 'Paket pelanggan tidak ditemukan'
            });
        }
        
        // Generate PPPoE username if not exists
        let pppoeUsername = customer.pppoe_username;
        if (!pppoeUsername || pppoeUsername.trim() === '') {
            pppoeUsername = billingManager.generatePPPoEUsername(customer.phone);
        }
        
        // Generate PPPoE password
        const pppoePassword = Math.random().toString(36).slice(-8) + Math.floor(Math.random() * 10);
        
        // Get profile from package or use default
        const pppoeProfile = customer.pppoe_profile || packageData.pppoe_profile || 'default';
        
        // Create PPPoE user
        const { addPPPoEUser, getUserAuthModeAsync } = require('../config/mikrotik');
        const authMode = await getUserAuthModeAsync();
        logger.info(`Accepting customer ${customer.name} - Creating PPPoE user ${pppoeUsername} (Mode: ${authMode})`);
        
        let pppoeCreated = false;
        try {
            // Get router if customer has router mapping
            let routerObj = null;
            try {
                const { getRouterForCustomer } = require('../config/mikrotik');
                routerObj = await getRouterForCustomer(customer);
            } catch (routerError) {
                logger.warn(`Customer ${customer.name} tidak punya router mapping, akan menggunakan router default`);
            }
            
            const pppoeResult = await addPPPoEUser({
                username: pppoeUsername,
                password: pppoePassword,
                profile: pppoeProfile,
                customer: customer,
                routerObj: routerObj
            });
            
            if (pppoeResult && pppoeResult.success) {
                pppoeCreated = true;
                logger.info(`PPPoE user ${pppoeUsername} created successfully`);
            } else {
                logger.warn(`Failed to create PPPoE user: ${pppoeResult?.message || 'Unknown error'}`);
            }
        } catch (pppoeError) {
            logger.error(`Error creating PPPoE user: ${pppoeError.message}`);
            // Continue even if PPPoE creation fails
        }
        
        // Update customer: set status to 'active' and save PPPoE username
        // Note: pppoe_password tidak disimpan di database, hanya di RADIUS/Mikrotik
        const updateData = {
            status: 'active',
            pppoe_username: pppoeUsername
        };
        
        await billingManager.updateCustomerByPhone(phone, updateData);
        
        // Get updated customer with package info
        const updatedCustomer = await billingManager.getCustomerByPhone(phone);
        updatedCustomer.package_name = packageData.name;
        updatedCustomer.package_speed = packageData.speed || 'N/A';
        updatedCustomer.pppoe_password = pppoePassword; // Include password for notifications
        
        // Send Welcome Message via WhatsApp
        let waSent = false;
        try {
            const whatsappNotifications = require('../config/whatsapp-notifications');
            const waResult = await whatsappNotifications.sendWelcomeMessage(updatedCustomer);
            if (waResult && waResult.success) {
                waSent = true;
                logger.info(`Welcome message sent via WhatsApp to ${updatedCustomer.name}`);
            }
        } catch (waError) {
            logger.error('Error sending WhatsApp welcome message:', waError);
        }
        
        // Send Welcome Message via Email
        let emailSent = false;
        try {
            const emailNotifications = require('../config/email-notifications');
            const emailResult = await emailNotifications.sendWelcomeMessage(updatedCustomer);
            if (emailResult && emailResult.success) {
                emailSent = true;
                logger.info(`Welcome message sent via Email to ${updatedCustomer.name}`);
            }
        } catch (emailError) {
            logger.error('Error sending Email welcome message:', emailError);
        }
        
        // Send notification to technicians (Sales Order)
        let techNotifSent = false;
        try {
            const whatsappNotifications = require('../config/whatsapp-notifications');
            const techResult = await whatsappNotifications.sendSalesOrderNotification(updatedCustomer);
            if (techResult && techResult.success) {
                techNotifSent = true;
                logger.info(`Sales Order notification sent to technicians for ${updatedCustomer.name}`);
            }
        } catch (techError) {
            logger.error('Error sending Sales Order notification to technicians:', techError);
        }
        
        // Build success message
        let message = 'Pelanggan berhasil di-accept!';
        const details = [];
        if (pppoeCreated) {
            details.push(`PPPoE User: ${pppoeUsername}`);
        }
        if (waSent) {
            details.push('Welcome Message (WA) terkirim');
        }
        if (emailSent) {
            details.push('Welcome Message (Email) terkirim');
        }
        if (techNotifSent) {
            details.push('Notifikasi ke teknisi terkirim');
        }
        
        if (details.length > 0) {
            message += '\n\n' + details.join('\n');
        }
        
        res.json({
            success: true,
            message: message,
            customer: {
                id: updatedCustomer.id,
                name: updatedCustomer.name,
                phone: updatedCustomer.phone,
                pppoe_username: pppoeUsername,
                status: 'active'
            },
            notifications: {
                whatsapp: waSent,
                email: emailSent,
                technician: techNotifSent
            }
        });
    } catch (error) {
        logger.error('Error accepting customer:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal accept pelanggan: ' + error.message
        });
    }
});

// Delete customer by phone (backward compatibility)
router.delete('/customers/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        
        const deletedCustomer = await billingManager.deleteCustomer(phone);
        logger.info(`Customer deleted: ${phone}`);
        
        res.json({
            success: true,
            message: 'Pelanggan berhasil dihapus',
            customer: deletedCustomer
        });
    } catch (error) {
        logger.error('Error deleting customer:', error);
        
        // Handle specific error messages
        let errorMessage = 'Gagal menghapus pelanggan';
        let statusCode = 500;
        
        if (error.message.includes('Customer not found') || error.message.includes('Pelanggan tidak ditemukan')) {
            errorMessage = 'Pelanggan tidak ditemukan';
            statusCode = 404;
        } else if (error.message.includes('invoice(s) still exist')) {
            errorMessage = 'Tidak dapat menghapus pelanggan karena masih memiliki tagihan. Silakan hapus semua tagihan terlebih dahulu.';
            statusCode = 400;
        } else if (error.message.includes('foreign key constraint')) {
            errorMessage = 'Tidak dapat menghapus pelanggan karena masih memiliki data terkait. Silakan hapus data terkait terlebih dahulu.';
            statusCode = 400;
        }
        
        res.status(statusCode).json({
            success: false,
            message: errorMessage,
            error: error.message
        });
    }
});

// Delete customer by ID
router.delete('/customers/id/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const deletedCustomer = await billingManager.deleteCustomerById(id);
        logger.info(`Customer deleted by ID: ${id}`);
        
        res.json({
            success: true,
            message: 'Pelanggan berhasil dihapus',
            customer: deletedCustomer
        });
    } catch (error) {
        logger.error('Error deleting customer by ID:', error);
        
        // Handle specific error messages
        let errorMessage = 'Gagal menghapus pelanggan';
        let statusCode = 500;
        
        if (error.message.includes('Customer not found') || error.message.includes('Pelanggan tidak ditemukan')) {
            errorMessage = 'Pelanggan tidak ditemukan';
            statusCode = 404;
        } else if (error.message.includes('invoice(s) still exist')) {
            errorMessage = 'Tidak dapat menghapus pelanggan karena masih memiliki tagihan. Silakan hapus semua tagihan terlebih dahulu.';
            statusCode = 400;
        } else if (error.message.includes('foreign key constraint')) {
            errorMessage = 'Tidak dapat menghapus pelanggan karena masih memiliki data terkait. Silakan hapus data terkait terlebih dahulu.';
            statusCode = 400;
        }
        
        res.status(statusCode).json({
            success: false,
            message: errorMessage,
            error: error.message
        });
    }
});

// Invoice Management
router.get('/invoices', getAppSettings, async (req, res) => {
    try {
        const invoices = await billingManager.getInvoices();
        const customers = await billingManager.getCustomers();
        const packages = await billingManager.getPackages();
        
        // Get members if table exists
        let members = [];
        let memberPackages = [];
        try {
            members = await billingManager.getAllMembers({ status: 'active' });
            // Get active member packages
            memberPackages = await billingManager.getAllMemberPackages(true);
        } catch (err) {
            // Members table might not exist, ignore error
            logger.debug('Members table not available:', err.message);
        }
        
        const { getVersionInfo } = require('../config/version-utils');
        const settings = getSettingsWithCache();
        
        res.render('admin/billing/invoices', {
            title: 'Kelola Tagihan',
            invoices,
            customers,
            members,
            packages,
            memberPackages,
            appSettings: req.appSettings,
            settings: settings,
            versionInfo: getVersionInfo()
        });
    } catch (error) {
        logger.error('Error loading invoices:', error);
        res.status(500).render('error', { 
            message: 'Error loading invoices',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

router.post('/invoices', async (req, res) => {
    try {
        const { customer_id, member_id, package_id, amount, due_date, notes, base_amount, tax_rate, invoice_type_select } = req.body;
        const safeNotes = (notes || '').toString().trim();
        
        // Determine if this is a member invoice
        const isMemberInvoice = invoice_type_select === 'member' && member_id;
        
        const invoiceData = {
            customer_id: customer_id ? parseInt(customer_id) : null,
            member_id: member_id ? parseInt(member_id) : null,
            package_id: parseInt(package_id),
            amount: parseFloat(amount),
            due_date: due_date,
            notes: safeNotes,
            invoice_type: isMemberInvoice ? 'member' : 'monthly'
        };
        
        // Add PPN data if available
        if (base_amount !== undefined && tax_rate !== undefined) {
            invoiceData.base_amount = parseFloat(base_amount);
            invoiceData.tax_rate = parseFloat(tax_rate);
        }

        if ((!invoiceData.customer_id && !invoiceData.member_id) || !invoiceData.package_id || !invoiceData.amount || !invoiceData.due_date) {
            return res.status(400).json({
                success: false,
                message: 'Semua field harus diisi'
            });
        }

        const newInvoice = await billingManager.createInvoice(invoiceData);
        logger.info(`Invoice created: ${newInvoice.invoice_number} for ${isMemberInvoice ? 'member' : 'customer'}`);

        res.json({
            success: true,
            message: 'Tagihan berhasil dibuat',
            invoice: newInvoice
        });

        // WA / email di background — jangan blokir respons (invoice sudah commit).
        setImmediate(() => {
            (async () => {
                // WA tagihan baru mengikuti jadwal harian (lihat billing-wa-schedule), bukan saat invoice dibuat
                try {
                    const emailNotifications = require('../config/email-notifications');
                    if (isMemberInvoice && invoiceData.member_id) {
                        await emailNotifications.sendInvoiceCreatedNotification(
                            invoiceData.member_id,
                            newInvoice.id
                        );
                    } else if (invoiceData.customer_id) {
                        await emailNotifications.sendInvoiceCreatedNotification(
                            invoiceData.customer_id,
                            newInvoice.id
                        );
                    }
                } catch (notificationError) {
                    logger.error('Error sending invoice email (background):', notificationError);
                }
            })();
        });
    } catch (error) {
        logger.error('Error creating invoice:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating invoice',
            error: error.message
        });
    }
});

router.put('/invoices/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, payment_method } = req.body;

        const updatedInvoice = await billingManager.updateInvoiceStatus(id, status, payment_method);
        logger.info(`Invoice status updated: ${id} to ${status}`);
        
        res.json({
            success: true,
            message: 'Status tagihan berhasil diupdate',
            invoice: updatedInvoice
        });
    } catch (error) {
        logger.error('Error updating invoice status:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating invoice status',
            error: error.message
        });
    }
});

// View individual invoice
router.get('/invoices/:id', getAppSettings, async (req, res) => {
    try {
        const { id } = req.params;
        const invoice = await billingManager.getInvoiceById(id);
        
        if (!invoice) {
            return res.status(404).render('error', {
                message: 'Invoice tidak ditemukan',
                error: 'Invoice with ID ' + id + ' not found',
                appSettings: req.appSettings
            });
        }
        
        res.render('admin/billing/invoice-detail', {
            title: 'Detail Invoice',
            invoice,
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error loading invoice detail:', error);
        res.status(500).render('error', {
            message: 'Error loading invoice detail',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Print invoice
router.get('/invoices/:id/print', getAppSettings, async (req, res) => {
    try {
        const { id } = req.params;
        const invoice = await billingManager.getInvoiceById(id);
        
        if (!invoice) {
            return res.status(404).render('error', {
                message: 'Invoice tidak ditemukan',
                error: 'Invoice with ID ' + id + ' not found',
                appSettings: req.appSettings
            });
        }
        
        res.render('admin/billing/invoice-print', {
            title: 'Cetak Invoice',
            invoice,
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error loading invoice print:', error);
        res.status(500).render('error', {
            message: 'Error loading invoice print',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Edit invoice
router.get('/invoices/:id/edit', getAppSettings, async (req, res) => {
    try {
        const { id } = req.params;
        const invoice = await billingManager.getInvoiceById(id);
        const customers = await billingManager.getCustomers();
        const packages = await billingManager.getPackages();
        
        if (!invoice) {
            return res.status(404).render('error', {
                message: 'Invoice tidak ditemukan',
                error: 'Invoice with ID ' + id + ' not found',
                appSettings: req.appSettings
            });
        }
        
        res.render('admin/billing/invoice-edit', {
            title: 'Edit Invoice',
            invoice,
            customers,
            packages,
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error loading invoice edit:', error);
        res.status(500).render('error', {
            message: 'Error loading invoice edit',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Update invoice
router.put('/invoices/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { customer_id, package_id, amount, due_date, notes } = req.body;
        
        const updateData = {
            customer_id: parseInt(customer_id),
            package_id: parseInt(package_id),
            amount: parseFloat(amount),
            due_date: due_date,
            notes: notes ? notes.trim() : ''
        };

        if (!updateData.customer_id || !updateData.package_id || !updateData.amount || !updateData.due_date) {
            return res.status(400).json({
                success: false,
                message: 'Semua field harus diisi'
            });
        }

        const updatedInvoice = await billingManager.updateInvoice(id, updateData);
        logger.info(`Invoice updated: ${updatedInvoice.invoice_number}`);
        
        res.json({
            success: true,
            message: 'Invoice berhasil diperbarui',
            invoice: updatedInvoice
        });
    } catch (error) {
        logger.error('Error updating invoice:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating invoice',
            error: error.message
        });
    }
});

// API untuk cleanup orphan voucher invoices
router.post('/api/cleanup-orphan-voucher-invoices', adminAuth, async (req, res) => {
    try {
        const { getVoucherInvoices, checkVoucherExists, deleteInvoice } = require('../scripts/cleanup_orphan_voucher_invoices');
        
        const invoices = await getVoucherInvoices();
        const orphanInvoices = [];
        
        for (const invoice of invoices) {
            const match = invoice.notes.match(/Voucher Hotspot\s+(\S+)/i);
            if (!match || !match[1]) {
                orphanInvoices.push({ invoice, reason: 'Invalid notes format' });
                continue;
            }
            
            const username = match[1];
            const exists = await checkVoucherExists(username);
            
            if (!exists) {
                orphanInvoices.push({ invoice, username, reason: 'Voucher not found in RADIUS' });
            }
        }
        
        if (orphanInvoices.length === 0) {
            return res.json({
                success: true,
                message: 'Tidak ada invoice yang perlu dihapus',
                deleted: 0
            });
        }
        
        let successCount = 0;
        let errorCount = 0;
        const errors = [];
        
        for (const { invoice, username } of orphanInvoices) {
            try {
                await deleteInvoice(invoice.id);
                successCount++;
            } catch (error) {
                errorCount++;
                errors.push({ invoice_number: invoice.invoice_number, error: error.message });
            }
        }
        
        return res.json({
            success: true,
            message: `Berhasil menghapus ${successCount} invoice`,
            deleted: successCount,
            failed: errorCount,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        logger.error('Error cleaning up orphan voucher invoices:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal membersihkan invoice voucher',
            error: error.message
        });
    }
});

// Delete invoice
router.delete('/invoices/:id', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        
        const deletedInvoice = await billingManager.deleteInvoice(id);
        logger.info(`Invoice deleted: ${deletedInvoice.invoice_number}`);
        
        res.json({
            success: true,
            message: 'Invoice berhasil dihapus',
            invoice: deletedInvoice
        });
    } catch (error) {
        logger.error('Error deleting invoice:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting invoice',
            error: error.message
        });
    }
});

// Bulk delete invoices
router.post('/invoices/bulk-delete', adminAuth, async (req, res) => {
    try {
        const { ids } = req.body || {};
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, message: 'Daftar ID tagihan kosong atau tidak valid' });
        }

        const results = [];
        let success = 0;
        let failed = 0;

        for (const rawId of ids) {
            try {
                const id = parseInt(rawId, 10);
                if (!Number.isFinite(id)) throw new Error('ID tidak valid');
                const deletedInvoice = await billingManager.deleteInvoice(id);
                results.push({ id, success: true, invoice_number: deletedInvoice?.invoice_number });
                success++;
            } catch (e) {
                results.push({ id: rawId, success: false, message: e.message });
                failed++;
            }
        }

        return res.json({ success: true, summary: { success, failed, total: ids.length }, results });
    } catch (error) {
        logger.error('Error bulk deleting invoices:', error);
        return res.status(500).json({ success: false, message: 'Gagal melakukan hapus massal tagihan', error: error.message });
    }
});

// Payment Management - Collector Transactions Only
router.get('/payments', getAppSettings, async (req, res) => {
    try {
        const period = resolveMonthYearRange(req.query);
        // Get filter parameters
        const filters = {
            month: String(period.month),
            year: String(period.year),
            from: req.query.from || period.startDate,
            to: req.query.to || period.endDate,
            collector_id: req.query.collector_id || '',
            status: req.query.status || '',
            q: req.query.q || ''
        };
        
        // Get payments with filters
        const payments = await billingManager.getCollectorPaymentsWithFilters(filters);
        
        // Get collectors list for dropdown
        const collectors = await billingManager.getAllCollectors();
        
        const settings = getSettingsWithCache();
        res.render('admin/billing/payments', {
            title: 'Transaksi Kolektor',
            payments,
            collectors,
            filters,
            appSettings: req.appSettings,
            settings: settings,
            page: 'payments'
        });
    } catch (error) {
        logger.error('Error loading payments:', error);
        res.status(500).render('error', { 
            message: 'Error loading payments',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// All Payments - Admin and Collector
router.get('/all-payments', getAppSettings, async (req, res) => {
    try {
        const period = resolveMonthYearRange(req.query);
        const filters = {
            month: String(period.month),
            year: String(period.year),
            from: req.query.from || period.startDate,
            to: req.query.to || period.endDate,
            collector_id: req.query.collector_id || '',
            q: req.query.q || ''
        };

        const [payments, collectors, summary] = await Promise.all([
            billingManager.getAllPaymentsHistory(filters),
            billingManager.getAllCollectors(),
            billingManager.getAllPaymentsHistorySummary(filters)
        ]);

        const settings = getSettingsWithCache();
        res.render('admin/billing/payments', {
            title: 'Riwayat Pembayaran',
            payments,
            collectors,
            filters,
            summary,
            appSettings: req.appSettings,
            settings: settings,
            page: 'all-payments'
        });
    } catch (error) {
        logger.error('Error loading all payments:', error);
        res.status(500).render('error', { 
            message: 'Error loading all payments',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

/** Batalkan satu pembayaran (riwayat all-payments): hapus baris payment & kembalikan invoice ke unpaid bila perlu */
router.post('/api/payments/:id/cancel', async (req, res) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ success: false, message: 'ID pembayaran tidak valid' });
        }
        const rawBody = req.body && typeof req.body === 'object' ? req.body : {};
        const confirmPassword =
            rawBody.confirm_password != null
                ? String(rawBody.confirm_password)
                : rawBody.super_admin_password != null
                  ? String(rawBody.super_admin_password)
                  : '';
        if (!verifySuperAdminPassword(confirmPassword)) {
            return res.status(403).json({
                success: false,
                message: 'Password super admin salah atau kosong.'
            });
        }
        const result = await billingManager.cancelPaymentById(id);
        let message = result.invoice_reverted_unpaid
            ? 'Pembayaran dibatalkan. Tagihan kembali belum lunas.'
            : 'Pembayaran dibatalkan.';
        if ((result.remittance_receipts_removed || 0) > 0) {
            message += ' Riwayat setoran transfer kantor ikut dihapus.';
        }
        return res.json({
            success: true,
            message,
            ...result
        });
    } catch (error) {
        logger.error('Cancel payment failed:', error);
        return res.status(400).json({
            success: false,
            message: error.message || 'Gagal membatalkan pembayaran'
        });
    }
});

router.post('/payments', async (req, res) => {
    try {
        const { invoice_id, amount, payment_method, reference_number, notes, payment_date, discount_amount } = req.body;
        
        // Validate required fields first
        if (!invoice_id || !amount || !payment_method) {
            return res.status(400).json({
                success: false,
                message: 'Invoice ID, jumlah, dan metode pembayaran harus diisi'
            });
        }
        
        const normalizedPaymentMethod = payment_method.trim();
        const normalizedNotes = (notes ? notes.trim() : '') ||
            (normalizedPaymentMethod === 'manual_admin' ? 'Pelunasan oleh Admin Kantor' : '');

        const discNum = Math.max(0, parseFloat(discount_amount) || 0);
        const paymentData = {
            invoice_id: parseInt(invoice_id),
            amount: parseFloat(amount),
            payment_method: normalizedPaymentMethod,
            reference_number: reference_number ? reference_number.trim() : '',
            notes: normalizedNotes,
            payment_date: payment_date ? String(payment_date).trim() : '',
            discount_amount: discNum
        };

        const newPayment = await billingManager.recordPayment(paymentData);
        
        // Update invoice status to paid
        await billingManager.updateInvoiceStatus(paymentData.invoice_id, 'paid', paymentData.payment_method);
        
        logger.info(`Payment recorded: ${newPayment.id}`);
        
        // Send WhatsApp notification
        try {
            const whatsappNotifications = require('../config/whatsapp-notifications');
            await whatsappNotifications.sendPaymentReceivedNotification(newPayment.id);
        } catch (notificationError) {
            logger.error('Error sending payment notification:', notificationError);
            // Don't fail the payment recording if notification fails
        }
        
        // Send Email notification
        try {
            const emailNotifications = require('../config/email-notifications');
            await emailNotifications.sendPaymentReceivedNotification(newPayment.id);
        } catch (notificationError) {
            logger.error('Error sending email payment notification:', notificationError);
            // Don't fail the payment recording if notification fails
        }
        
        // Attempt immediate restore if eligible
        try {
            const paidInvoice = await billingManager.getInvoiceById(paymentData.invoice_id);
            if (paidInvoice && paidInvoice.customer_id) {
                const customer = await billingManager.getCustomerById(paidInvoice.customer_id);
                const { shouldAutoRestoreCustomer } = require('../utils/customerSuspendReason');
                if (shouldAutoRestoreCustomer(customer)) {
                    const invoices = await billingManager.getInvoicesByCustomer(customer.id);
                    const unpaid = invoices.filter(i => i.status === 'unpaid');
                    if (unpaid.length === 0) {
                        await serviceSuspension.restoreCustomerService(customer);
                    }
                }
            }
        } catch (restoreErr) {
            logger.error('Immediate restore check failed:', restoreErr);
        }
        
        res.json({
            success: true,
            message: 'Pembayaran berhasil dicatat',
            payment: newPayment
        });
    } catch (error) {
        logger.error('Error recording payment:', error);
        res.status(500).json({
            success: false,
            message: 'Error recording payment',
            error: error.message
        });
    }
});

// Export customers to CSV
router.get('/export/customers', getAppSettings, async (req, res) => {
    try {
        const customers = await billingManager.getCustomers();
        
        // Create CSV content
        let csvContent = 'ID,Username,Nama,Phone,Email,Address,Package,Status,Payment Status,Created At\n';
        
        customers.forEach(customer => {
            const row = [
                customer.id,
                customer.username,
                customer.name,
                customer.phone,
                customer.email || '',
                customer.address || '',
                customer.package_name || '',
                customer.status,
                customer.payment_status,
                new Date(customer.created_at).toLocaleDateString('id-ID')
            ].map(field => `"${field}"`).join(',');
            
            csvContent += row + '\n';
        });
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=customers.csv');
        res.send(csvContent);
        
    } catch (error) {
        logger.error('Error exporting customers:', error);
        res.status(500).json({
            success: false,
            message: 'Error exporting customers',
            error: error.message
        });
    }
});

// Export invoices to CSV
router.get('/export/invoices', getAppSettings, async (req, res) => {
    try {
        const invoices = await billingManager.getInvoices();
        
        // Create CSV content
        let csvContent = 'ID,Invoice Number,Customer,Amount,Status,Due Date,Created At\n';
        
        invoices.forEach(invoice => {
            const row = [
                invoice.id,
                invoice.invoice_number,
                invoice.customer_name,
                invoice.amount,
                invoice.status,
                new Date(invoice.due_date).toLocaleDateString('id-ID'),
                new Date(invoice.created_at).toLocaleDateString('id-ID')
            ].map(field => `"${field}"`).join(',');
            
            csvContent += row + '\n';
        });
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=invoices.csv');
        res.send(csvContent);
        
    } catch (error) {
        logger.error('Error exporting invoices:', error);
        res.status(500).json({
            success: false,
            message: 'Error exporting invoices',
            error: error.message
        });
    }
});

// Export payments to CSV
router.get('/export/payments', getAppSettings, async (req, res) => {
    try {
        const payments = await billingManager.getPayments();
        
        // Create CSV content
        let csvContent = 'ID,Invoice Number,Customer,Amount,Payment Method,Payment Date,Reference,Notes\n';
        
        payments.forEach(payment => {
            const row = [
                payment.id,
                payment.invoice_number,
                payment.customer_name,
                payment.amount,
                payment.payment_method,
                new Date(payment.payment_date).toLocaleDateString('id-ID'),
                payment.reference_number || '',
                payment.notes || ''
            ].map(field => `"${field}"`).join(',');
            
            csvContent += row + '\n';
        });
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=payments.csv');
        res.send(csvContent);
        
    } catch (error) {
        logger.error('Error exporting payments:', error);
        res.status(500).json({
            success: false,
            message: 'Error exporting payments',
            error: error.message
        });
    }
});

// API Routes untuk AJAX
// Get package profiles for customer form
router.get('/api/packages', async (req, res) => {
    try {
        const packages = await billingManager.getPackages();
        res.json({
            success: true,
            packages: packages
        });
    } catch (error) {
        logger.error('Error getting packages API:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});



// API endpoint untuk ODPs
router.get('/api/odps', adminAuth, async (req, res) => {
    try {
        const db = require('../config/billing').db;
        const odps = await new Promise((resolve, reject) => {
            db.all(`
                SELECT o.id, o.name, o.code, o.capacity, o.used_ports, o.status, o.parent_odp_id,
                       o.latitude, o.longitude, o.address, o.notes,
                       p.name as parent_name
                FROM odps o
                LEFT JOIN odps p ON o.parent_odp_id = p.id
                ORDER BY o.name
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
        
        res.json({
            success: true,
            odps: odps
        });
    } catch (error) {
        logger.error('Error getting ODPs for mobile mapping:', error);
        res.status(500).json({
            success: false,
            message: 'Error loading ODPs data'
        });
    }
});

// Helper function untuk mendapatkan parameter value dari device
function getParameterValue(device, parameterName) {
    if (!device || !parameterName) return null;
    
    // Coba akses langsung
    if (device[parameterName] !== undefined) {
        return device[parameterName];
    }
    
    // Coba dengan path array
    const pathParts = parameterName.split('.');
    let current = device;
    
    for (const part of pathParts) {
        if (current && typeof current === 'object' && current[part] !== undefined) {
            current = current[part];
        } else {
            return null;
        }
    }
    
    // Jika current adalah object dengan _value property, return _value
    if (current && typeof current === 'object' && current._value !== undefined) {
        return current._value;
    }
    
    // Jika current adalah string/number, return langsung
    if (typeof current === 'string' || typeof current === 'number') {
        return current;
    }
    
    return current;
}

// API endpoint untuk mendapatkan PPPoE users (dari RADIUS jika mode RADIUS, atau dari Mikrotik jika mode API)
router.get('/api/pppoe-users', async (req, res) => {
    try {
        const { getPPPoEUsers, getUserAuthModeAsync } = require('../config/mikrotik');
        const authMode = await getUserAuthModeAsync();
        
        logger.info(`[API] Fetching PPPoE users in ${authMode} mode`);
        
        // getPPPoEUsers() sudah otomatis memilih antara RADIUS atau Mikrotik berdasarkan mode
        // dan sudah mengembalikan status aktif untuk masing-masing mode
        const raw = await getPPPoEUsers();
        const pppoeUsers = Array.isArray(raw) ? raw : [];

        res.json({
            success: true,
            data: pppoeUsers.map(user => ({
                username: user.name,
                profile: user.profile || 'default',
                active: user.active || false
            }))
        });

        logger.info(`[API] Returned ${pppoeUsers.length} PPPoE users from ${authMode === 'radius' ? 'RADIUS Server' : 'Mikrotik'} (${pppoeUsers.filter(u => u.active).length} active)`);
    } catch (error) {
        logger.error('Error fetching PPPoE users:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data PPPoE users',
            error: error.message
        });
    }
});

// API endpoint untuk devices
router.get('/api/devices', async (req, res) => {
    try {
        console.log('🔍 Loading devices from GenieACS...');
        const { getDevicesCached } = require('../config/genieacs');
        let devices = [];
        
        try {
            devices = await getDevicesCached();
            console.log(`📊 Found ${devices.length} devices from GenieACS`);
        } catch (genieacsError) {
            console.warn('⚠️ GenieACS tidak tersedia:', genieacsError.message);
            // Jangan buat perangkat simulasi (fallback_*, Simulated ONU) — bukan data DB dan membingungkan.
            devices = [];
        }
        
        // Process devices with customer information
        const processedDevices = [];
        
        for (const device of devices) {
            // Debug: log first device structure
            if (processedDevices.length === 0) {
                console.log('🔍 Sample device structure:', Object.keys(device));
                console.log('🔍 Sample device data:', JSON.stringify(device, null, 2).substring(0, 500) + '...');
                
                // Test parameter extraction
                console.log('🧪 Testing parameter extraction:');
                console.log('- Serial from ID:', device._id);
                console.log('- VirtualParameters.getSerialNumber:', getParameterValue(device, 'VirtualParameters.getSerialNumber'));
                console.log('- DeviceID.SerialNumber:', getParameterValue(device, 'DeviceID.SerialNumber'));
                console.log('- DeviceID.ProductClass:', getParameterValue(device, 'DeviceID.ProductClass'));
                console.log('- DeviceID.Manufacturer:', getParameterValue(device, 'DeviceID.Manufacturer'));
                console.log('- VirtualParameters.getdeviceuptime:', getParameterValue(device, 'VirtualParameters.getdeviceuptime'));
                console.log('- Device.DeviceInfo.VirtualParameters.getdeviceuptime:', getParameterValue(device, 'Device.DeviceInfo.VirtualParameters.getdeviceuptime'));
                console.log('- InternetGatewayDevice.DeviceInfo.UpTime:', getParameterValue(device, 'InternetGatewayDevice.DeviceInfo.UpTime'));
                console.log('- Last Inform:', device._lastInform);
                console.log('- SSID:', getParameterValue(device, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID'));
                console.log('- PPPoE Username:', getParameterValue(device, 'VirtualParameters.pppoeUsername'));
                
                // Test status detection
                const uptime1 = getParameterValue(device, 'VirtualParameters.getdeviceuptime');
                const uptime2 = getParameterValue(device, 'Device.DeviceInfo.VirtualParameters.getdeviceuptime');
                const uptime3 = getParameterValue(device, 'InternetGatewayDevice.DeviceInfo.UpTime');
                const lastInform = device._lastInform;
                const hasUptime = (uptime1 && uptime1 > 0) || (uptime2 && uptime2 > 0) || (uptime3 && uptime3 > 0);
                const isRecentInform = lastInform && (Date.now() - new Date(lastInform).getTime()) < 5 * 60 * 1000;
                console.log('- Status Detection - Uptime1:', uptime1, 'Uptime2:', uptime2, 'Uptime3:', uptime3);
                console.log('- Status Detection - HasUptime:', hasUptime, 'IsRecentInform:', isRecentInform);
                console.log('- Status Detection - Final Status:', hasUptime || isRecentInform ? 'Online' : 'Offline');
                
                // Test model extraction
                const deviceId = device._id || '';
                const modelMatch = deviceId.match(/-([A-Z0-9]+)-/);
                console.log('- Model from ID regex:', modelMatch ? modelMatch[1] : 'No match');
            }
            
            // Extract serial number - try multiple sources
            const deviceId = device._id || '';
            const virtualSerial = getParameterValue(device, 'VirtualParameters.getSerialNumber');
            const deviceIdSerial = getParameterValue(device, 'DeviceID.SerialNumber');
            const extractedSerial = deviceId.replace(/%2D/g, '-').replace(/-XPON-.*/, '');
            
            const serialNumber = virtualSerial || deviceIdSerial || extractedSerial || 'N/A';
            
            const processedDevice = {
                id: device._id,
                serialNumber: serialNumber,
                model: (() => {
                    // Try DeviceID.ProductClass first, then extract from device ID
                    const productClass = getParameterValue(device, 'DeviceID.ProductClass');
                    
                    if (productClass && typeof productClass === 'string') {
                        return productClass;
                    }
                    
                    // Extract model from device ID (e.g., "F663NV3A" from "44FB5A-F663NV3A-ZTEGCB7552E1")
                    const modelMatch = deviceId.match(/-([A-Z0-9]+)-/);
                    return modelMatch ? modelMatch[1] : 'Unknown';
                })(),
                status: (() => {
                    // Try multiple uptime parameters for different device types
                    const uptime1 = getParameterValue(device, 'VirtualParameters.getdeviceuptime');
                    const uptime2 = getParameterValue(device, 'Device.DeviceInfo.VirtualParameters.getdeviceuptime');
                    const uptime3 = getParameterValue(device, 'InternetGatewayDevice.DeviceInfo.UpTime');
                    const lastInform = device._lastInform;
                    
                    // Check if device has uptime > 0
                    const hasUptime = (uptime1 && uptime1 > 0) || (uptime2 && uptime2 > 0) || (uptime3 && uptime3 > 0);
                    
                    // Check if device has recent inform (within last 5 minutes)
                    const isRecentInform = lastInform && (Date.now() - new Date(lastInform).getTime()) < 5 * 60 * 1000;
                    
                    // Device is online if it has uptime OR recent inform
                    return hasUptime || isRecentInform ? 'Online' : 'Offline';
                })(),
                ssid: getParameterValue(device, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID') || 'N/A',
                lastInform: device._lastInform || new Date().toISOString(),
                latitude: null,
                longitude: null,
                customerName: null,
                customerPhone: null
            };
            
            // Try to find customer by PPPoE username - try multiple sources
            const pppoeUsername = getParameterValue(device, 'VirtualParameters.pppoeUsername') || 
                                 getParameterValue(device, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username');
            if (pppoeUsername && pppoeUsername !== '-') {
                try {
                    const db = require('../config/billing').db;
                    const customer = await new Promise((resolve, reject) => {
                        db.get(`
                            SELECT id, name, phone, latitude, longitude 
                            FROM customers 
                            WHERE pppoe_username = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
                        `, [pppoeUsername], (err, row) => {
                            if (err) reject(err);
                            else resolve(row);
                        });
                    });
                    
                    if (customer) {
                        processedDevice.latitude = customer.latitude;
                        processedDevice.longitude = customer.longitude;
                        processedDevice.customerName = customer.name;
                        processedDevice.customerPhone = customer.phone;
                    }
                } catch (customerError) {
                    console.log(`⚠️ Error finding customer for device ${processedDevice.serialNumber}:`, customerError.message);
                }
            }
            
            processedDevices.push(processedDevice);
        }
        
        console.log(`✅ Processed ${processedDevices.length} devices`);
        
        res.json({
            success: true,
            devices: processedDevices
        });
    } catch (error) {
        console.error('❌ Error getting devices:', error);
        res.status(500).json({
            success: false,
            message: 'Error loading devices data: ' + error.message
        });
    }
});

// API endpoint untuk cables
router.get('/api/cables', adminAuth, async (req, res) => {
    try {
        const db = require('../config/billing').db;
        const cables = await new Promise((resolve, reject) => {
            db.all(`
                SELECT c.id, c.name, c.from_odp_id, c.to_odp_id, c.cable_type, c.length,
                       c.status, c.notes,
                       o1.name as from_odp_name, o1.latitude as from_lat, o1.longitude as from_lng,
                       o2.name as to_odp_name, o2.latitude as to_lat, o2.longitude as to_lng
                FROM cable_routes c
                LEFT JOIN odps o1 ON c.from_odp_id = o1.id
                LEFT JOIN odps o2 ON c.to_odp_id = o2.id
                WHERE o1.latitude IS NOT NULL AND o1.longitude IS NOT NULL
                  AND o2.latitude IS NOT NULL AND o2.longitude IS NOT NULL
                ORDER BY c.name
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
        
        // Format cables for map
        const formattedCables = cables.map(cable => ({
            id: cable.id,
            name: cable.name,
            from: [cable.from_lat, cable.from_lng],
            to: [cable.to_lat, cable.to_lng],
            type: cable.cable_type,
            length: cable.length,
            status: cable.status
        }));
        
        res.json({
            success: true,
            cables: formattedCables
        });
    } catch (error) {
        logger.error('Error getting cables for mobile mapping:', error);
        res.status(500).json({
            success: false,
            message: 'Error loading cables data'
        });
    }
});

// Mapping & Coordinates Management
// API untuk analisis coverage area
router.get('/api/mapping/coverage', async (req, res) => {
    try {
        const MappingUtils = require('../utils/mappingUtils');
        
        // Ambil data customers
        const customers = await billingManager.getAllCustomers();
        const customersWithCoords = customers.filter(c => c.latitude && c.longitude);
        
        if (customersWithCoords.length < 3) {
            return res.json({
                success: false,
                message: 'Minimal 3 koordinat diperlukan untuk analisis coverage'
            });
        }
        
        // Hitung bounding box
        const coordinates = customersWithCoords.map(c => ({ 
            latitude: c.latitude, 
            longitude: c.longitude 
        }));
        
        const boundingBox = MappingUtils.getBoundingBox(coordinates);
        const center = MappingUtils.getCenterCoordinate(coordinates);
        const coverageArea = MappingUtils.calculateCoverageArea(coordinates);
        
        // Analisis density per area
        const clusters = MappingUtils.createClusters(coordinates, 1000); // 1km radius
        const highDensityAreas = clusters.filter(c => c.count >= 5);
        const mediumDensityAreas = clusters.filter(c => c.count >= 3 && c.count < 5);
        const lowDensityAreas = clusters.filter(c => c.count < 3);
        
        res.json({
            success: true,
            data: {
                coverageArea: parseFloat(coverageArea),
                boundingBox,
                center,
                densityAnalysis: {
                    highDensity: highDensityAreas.length,
                    mediumDensity: mediumDensityAreas.length,
                    lowDensity: lowDensityAreas.length,
                    totalClusters: clusters.length
                },
                clusters: {
                    high: highDensityAreas,
                    medium: mediumDensityAreas,
                    low: lowDensityAreas
                }
            }
        });
    } catch (error) {
        logger.error('Error analyzing coverage:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Gagal menganalisis coverage area' 
        });
    }
});

// API untuk update koordinat customer
router.put('/api/mapping/customers/:id/coordinates', async (req, res) => {
    try {
        const { id } = req.params;
        const { latitude, longitude } = req.body;
        
        if (!latitude || !longitude) {
            return res.status(400).json({
                success: false,
                message: 'Latitude dan longitude wajib diisi'
            });
        }
        
        const MappingUtils = require('../utils/mappingUtils');
        
        // Validasi koordinat
        if (!MappingUtils.isValidCoordinate(latitude, longitude)) {
            return res.status(400).json({
                success: false,
                message: 'Koordinat tidak valid'
            });
        }
        
        // Update koordinat customer
        const result = await billingManager.updateCustomerCoordinates(parseInt(id), {
            latitude: parseFloat(latitude),
            longitude: parseFloat(longitude)
        });
        
        if (result) {
            res.json({
                success: true,
                message: 'Koordinat customer berhasil diperbarui',
                data: {
                    id: parseInt(id),
                    latitude: parseFloat(latitude),
                    longitude: parseFloat(longitude),
                    formattedCoordinates: MappingUtils.formatCoordinates(latitude, longitude)
                }
            });
        } else {
            res.status(404).json({
                success: false,
                message: 'Customer tidak ditemukan'
            });
        }
    } catch (error) {
        logger.error('Error updating customer coordinates:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal memperbarui koordinat customer'
        });
    }
});

// API untuk bulk update koordinat
router.post('/api/mapping/customers/bulk-coordinates', async (req, res) => {
    try {
        const { coordinates } = req.body;
        
        if (!coordinates || !Array.isArray(coordinates)) {
            return res.status(400).json({
                success: false,
                message: 'Data koordinat harus berupa array'
            });
        }
        
        const MappingUtils = require('../utils/mappingUtils');
        const results = [];
        let successCount = 0;
        let errorCount = 0;
        
        for (const coord of coordinates) {
            try {
                const { customer_id, latitude, longitude } = coord;
                
                if (!customer_id || !latitude || !longitude) {
                    results.push({
                        customer_id,
                        success: false,
                        message: 'Data tidak lengkap'
                    });
                    errorCount++;
                    continue;
                }
                
                // Validasi koordinat
                if (!MappingUtils.isValidCoordinate(latitude, longitude)) {
                    results.push({
                        customer_id,
                        success: false,
                        message: 'Koordinat tidak valid'
                    });
                    errorCount++;
                    continue;
                }
                
                // Update koordinat
                const result = await billingManager.updateCustomerCoordinates(parseInt(customer_id), {
                    latitude: parseFloat(latitude),
                    longitude: parseFloat(longitude)
                });
                
                if (result) {
                    results.push({
                        customer_id,
                        success: true,
                        message: 'Koordinat berhasil diperbarui',
                        data: {
                            latitude: parseFloat(latitude),
                            longitude: parseFloat(longitude),
                            formattedCoordinates: MappingUtils.formatCoordinates(latitude, longitude)
                        }
                    });
                    successCount++;
                } else {
                    results.push({
                        customer_id,
                        success: false,
                        message: 'Customer tidak ditemukan'
                    });
                    errorCount++;
                }
            } catch (error) {
                results.push({
                    customer_id: coord.customer_id,
                    success: false,
                    message: error.message
                });
                errorCount++;
            }
        }
        
        res.json({
            success: true,
            message: `Bulk update selesai. ${successCount} berhasil, ${errorCount} gagal`,
            data: {
                total: coordinates.length,
                success: successCount,
                error: errorCount,
                results
            }
        });
    } catch (error) {
        logger.error('Error bulk updating coordinates:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal melakukan bulk update koordinat'
        });
    }
});

// API untuk export mapping data
router.get('/api/mapping/export', async (req, res) => {
    try {
        const { format = 'json' } = req.query;
        
        // Ambil data mapping
        const customers = await billingManager.getAllCustomers();
        const customersWithCoords = customers.filter(c => c.latitude && c.longitude);
        
        if (format === 'csv') {
            // Export sebagai CSV
            const csvData = customersWithCoords.map(c => ({
                id: c.id,
                name: c.name,
                phone: c.phone,
                username: c.username,
                latitude: c.latitude,
                longitude: c.longitude,
                package_name: c.package_name || 'N/A',
                status: c.status,
                address: c.address || 'N/A'
            }));
            
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="mapping_data.csv"');
            
            // CSV header
            const headers = Object.keys(csvData[0]).join(',');
            const rows = csvData.map(row => Object.values(row).map(val => `"${val}"`).join(','));
            
            res.send([headers, ...rows].join('\n'));
        } else {
            // Export sebagai JSON
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename="mapping_data.json"');
            
            res.json({
                exportDate: new Date().toISOString(),
                totalCustomers: customersWithCoords.length,
                data: customersWithCoords
            });
        }
    } catch (error) {
        logger.error('Error exporting mapping data:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal export data mapping'
        });
    }
});

router.get('/api/customers', adminAuth, async (req, res) => {
    try {
        const customers = await billingManager.getCustomers();
        res.json({
            success: true,
            customers: customers
        });
    } catch (error) {
        logger.error('Error getting customers API:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Bulk Operations for Customer Data
// Get current customer data for preview
router.post('/customers/current-data', async (req, res) => {
    try {
        const { customers } = req.body;
        
        if (!customers || !Array.isArray(customers)) {
            return res.status(400).json({
                success: false,
                message: 'Data customers harus berupa array'
            });
        }
        
        const result = [];
        
        for (const customer of customers) {
            if (customer.phone && customer.username) {
                try {
                    const currentCustomer = await billingManager.getCustomerByPhone(customer.phone);
                    
                    // Get current package info
                    let currentPackageName = null;
                    if (currentCustomer && currentCustomer.package_id) {
                        const currentPackage = await billingManager.getPackageById(currentCustomer.package_id);
                        currentPackageName = currentPackage ? currentPackage.name : null;
                    }
                    
                    result.push({
                        phone: customer.phone,
                        name: customer.name,
                        current_username: currentCustomer ? currentCustomer.username : null,
                        new_username: customer.username,
                        current_package_id: currentCustomer ? currentCustomer.package_id : null,
                        current_package_name: currentPackageName,
                        new_package_id: customer.package_id || null,
                        new_package_name: customer.package_name || null,
                        found: !!currentCustomer
                    });
                } catch (error) {
                    logger.error(`Error getting customer by phone ${customer.phone}:`, error);
                    result.push({
                        phone: customer.phone,
                        name: customer.name,
                        current_username: null,
                        new_username: customer.username,
                        current_package_id: null,
                        current_package_name: null,
                        new_package_id: customer.package_id || null,
                        new_package_name: customer.package_name || null,
                        found: false,
                        error: error.message
                    });
                }
            }
        }
        
        res.json({
            success: true,
            data: result
        });
        
    } catch (error) {
        logger.error('Error getting current customer data:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting current customer data: ' + error.message
        });
    }
});

// Bulk update customer data
router.post('/customers/update-customer-data', async (req, res) => {
    try {
        const { customers } = req.body;
        
        if (!customers || !Array.isArray(customers)) {
            return res.status(400).json({
                success: false,
                message: 'Data customers harus berupa array'
            });
        }
        
        let updated = 0;
        let total = 0;
        const errors = [];
        
        for (const customer of customers) {
            if (customer.phone && customer.username) {
                total++;
                
                try {
                    // Validate username format
                    if (!/^[a-z0-9_]+$/.test(customer.username)) {
                        errors.push({
                            phone: customer.phone,
                            name: customer.name,
                            error: 'Username hanya boleh berisi huruf kecil, angka, dan underscore'
                        });
                        continue;
                    }
                    
                    // Get current customer
                    const currentCustomer = await billingManager.getCustomerByPhone(customer.phone);
                    
                    if (!currentCustomer) {
                        errors.push({
                            phone: customer.phone,
                            name: customer.name,
                            error: 'Pelanggan tidak ditemukan'
                        });
                        continue;
                    }
                    
                    // Check if package exists (if package_id or package_name is provided)
                    let packageId = currentCustomer.package_id;
                    
                    // If package_id is provided and different, use it
                    if (customer.package_id && customer.package_id !== currentCustomer.package_id) {
                        const packageExists = await billingManager.getPackageById(customer.package_id);
                        if (!packageExists) {
                            errors.push({
                                phone: customer.phone,
                                name: customer.name,
                                error: `Paket dengan ID ${customer.package_id} tidak ditemukan`
                            });
                            continue;
                        }
                        packageId = customer.package_id;
                    }
                    // If package_name is provided, try to find matching package
                    else if (customer.package_name && !customer.package_id) {
                        const packages = await billingManager.getPackages();
                        const matchingPackage = packages.find(pkg => 
                            pkg.name.toLowerCase() === customer.package_name.toLowerCase() && pkg.is_active === 1
                        );
                        
                        if (matchingPackage) {
                            packageId = matchingPackage.id;
                            logger.info(`Found matching package for ${customer.phone}: ${customer.package_name} -> ID ${matchingPackage.id}`);
                        } else {
                            errors.push({
                                phone: customer.phone,
                                name: customer.name,
                                error: `Paket dengan nama "${customer.package_name}" tidak ditemukan atau tidak aktif`
                            });
                            continue;
                        }
                    }
                    
                    // Check if there are any changes
                    const usernameChanged = currentCustomer.username !== customer.username;
                    const packageChanged = packageId !== currentCustomer.package_id;
                    
                    if (!usernameChanged && !packageChanged) {
                        continue; // Skip if no changes
                    }
                    
                    // Update customer data
                    const updateData = {
                        name: currentCustomer.name,
                        username: customer.username,
                        phone: currentCustomer.phone,
                        pppoe_username: currentCustomer.pppoe_username,
                        email: currentCustomer.email,
                        address: currentCustomer.address,
                        package_id: packageId,
                        pppoe_profile: currentCustomer.pppoe_profile,
                        status: currentCustomer.status,
                        auto_suspension: currentCustomer.auto_suspension,
                        billing_day: currentCustomer.billing_day
                    };
                    
                    // Debug logging
                    logger.info(`Updating customer ${customer.phone} with data:`, {
                        old_package_id: currentCustomer.package_id,
                        new_package_id: packageId,
                        username_changed: usernameChanged,
                        package_changed: packageChanged,
                        update_data: updateData
                    });
                    
                    await billingManager.updateCustomerByPhone(customer.phone, updateData);
                    updated++;
                    
                    let logMessage = `Customer data updated for ${customer.phone}:`;
                    if (usernameChanged) {
                        logMessage += ` username: ${currentCustomer.username} -> ${customer.username}`;
                    }
                    if (packageChanged) {
                        logMessage += ` package: ${currentCustomer.package_id} -> ${packageId}`;
                    }
                    
                    logger.info(logMessage);
                    
                } catch (error) {
                    logger.error(`Error updating customer data for ${customer.phone}:`, error);
                    errors.push({
                        phone: customer.phone,
                        name: customer.name,
                        error: error.message
                    });
                }
            }
        }
        
        res.json({
            success: true,
            message: `Berhasil mengupdate ${updated} dari ${total} pelanggan`,
            updated: updated,
            total: total,
            errors: errors
        });
        
    } catch (error) {
        logger.error('Error bulk updating customer data:', error);
        res.status(500).json({
            success: false,
            message: 'Error bulk updating customer data: ' + error.message
        });
    }
});

router.get('/api/invoices', async (req, res) => {
    try {
        const { customer_username } = req.query;
        const invoices = await billingManager.getInvoices(customer_username);
        res.json(invoices);
    } catch (error) {
        logger.error('Error getting invoices API:', error);
        res.status(500).json({ error: error.message });
    }
});

// WhatsApp Notifications
// Send WhatsApp Notification for Invoice
router.post('/invoices/send-whatsapp', async (req, res) => {
    try {
        const { invoiceId } = req.body;
        
        if (!invoiceId) {
            return res.status(400).json({
                success: false,
                message: 'Invoice ID harus diisi'
            });
        }
        
        // Get invoice data from database
        const invoice = await billingManager.getInvoiceById(invoiceId);
        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: 'Invoice tidak ditemukan'
            });
        }
        
        // Check if this is a member invoice
        const isMemberInvoice = invoice.member_id !== null && invoice.member_id !== undefined;
        
        let customer, packageData, phone, customerName;
        
        if (isMemberInvoice) {
            // Get member data
            const member = await billingManager.getMemberById(invoice.member_id);
            if (!member) {
                return res.status(404).json({
                    success: false,
                    message: 'Member tidak ditemukan'
                });
            }
            
            // Get member package
            packageData = await billingManager.getMemberPackageById(invoice.package_id);
            phone = member.phone;
            customerName = member.name;
        } else {
            // Get customer data
            customer = await billingManager.getCustomerById(invoice.customer_id);
            if (!customer) {
                return res.status(404).json({
                    success: false,
                    message: 'Customer tidak ditemukan'
                });
            }
            
            // Get customer package
            packageData = await billingManager.getPackageById(invoice.package_id);
            phone = customer.phone;
            customerName = customer.name;
        }
        
        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Nomor telepon tidak ditemukan'
            });
        }
        
        // Use WhatsApp notification manager with template support
        const whatsappNotifications = require('../config/whatsapp-notifications');
        
        // Determine which notification to send based on invoice status
        if (invoice.status === 'paid') {
            // Send payment received notification
            const payments = await billingManager.getPayments();
            const payment = payments.find(p => p.invoice_id === invoice.id);
            
            const data = {
                customer_name: customerName,
                invoice_number: invoice.invoice_number,
                amount: whatsappNotifications.formatCurrency(invoice.amount),
                payment_method: payment?.payment_method || 'Manual Admin',
                payment_date: payment?.payment_date ? whatsappNotifications.formatDate(payment.payment_date) : whatsappNotifications.formatDate(new Date()),
                reference_number: payment?.reference_number || '-',
                package_name: packageData?.name || '-',
                package_speed: packageData?.speed || '-',
                invoice_id: invoice.id
            };
            
            const result = await whatsappNotifications.sendPaymentReceivedNotification(phone, data);
            
            if (result.success) {
                res.json({
                    success: true,
                    message: 'Notifikasi WhatsApp berhasil dikirim'
                });
            } else {
                res.json({
                    success: false,
                    message: 'Gagal mengirim notifikasi WhatsApp: ' + (result.error || 'Unknown error')
                });
            }
        } else {
            // Send invoice created or due date reminder notification
            if (isMemberInvoice) {
                const result = await whatsappNotifications.sendMemberInvoiceCreatedNotification(invoice.member_id, invoice.id);
                
                if (result.success) {
                    res.json({
                        success: true,
                        message: 'Notifikasi WhatsApp berhasil dikirim'
                    });
                } else {
                    res.json({
                        success: false,
                        message: 'Gagal mengirim notifikasi WhatsApp: ' + (result.error || 'Unknown error')
                    });
                }
            } else {
                const result = await whatsappNotifications.sendInvoiceCreatedNotification(invoice.customer_id, invoice.id);
                
                if (result.success) {
                    res.json({
                        success: true,
                        message: 'Notifikasi WhatsApp berhasil dikirim'
                    });
                } else {
                    res.json({
                        success: false,
                        message: 'Gagal mengirim notifikasi WhatsApp: ' + (result.error || 'Unknown error')
                    });
                }
            }
        }
        
    } catch (error) {
        logger.error('Error sending WhatsApp notification:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengirim notifikasi: ' + error.message
        });
    }
});

// Payment Gateway Integration
// Payment Settings Routes
router.get('/payment-settings', getAppSettings, async (req, res) => {
    try {
        const paymentConfig = await getPaymentGatewayConfig();
        const settings = getSettingsWithCache();
        settings.payment_gateway = paymentConfig;
        res.render('admin/billing/payment-settings', {
            title: 'Payment Gateway Settings',
            settings: settings,
            appSettings: req.appSettings,
            pg: paymentConfig,
            mid: paymentConfig.midtrans,
            xe: paymentConfig.xendit,
            tp: paymentConfig.tripay,
            dk: paymentConfig.duitku,
            gatewayStatus: await billingManager.getGatewayStatus(),
            saved: req.query.saved === '1'
        });
    } catch (error) {
        logger.error('Error loading payment settings:', error);
        res.status(500).render('error', { 
            message: 'Error loading payment settings',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Update active gateway
router.post('/payment-settings/active-gateway', async (req, res) => {
    try {
        const { activeGateway } = req.body;
        const updatedConfig = await setActivePaymentGateway(activeGateway);
        const reloadInfo = await billingManager.reloadPaymentGateway();

        res.json({
            success: true,
            message: 'Active gateway updated successfully',
            config: updatedConfig,
            reload: reloadInfo
        });
    } catch (error) {
        logger.error('Error updating active gateway:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating active gateway',
            error: error.message
        });
    }
});

// Update gateway configuration
router.post('/payment-settings/:gateway', async (req, res) => {
    try {
        const { gateway } = req.params;
        const config = req.body || {};

        const updatedGateway = await updatePaymentGatewayConfigStore(gateway, config);
        const reloadInfo = await billingManager.reloadPaymentGateway();

        res.json({
            success: true,
            message: `${gateway} configuration updated successfully`,
            gateway: updatedGateway,
            reload: reloadInfo
        });
    } catch (error) {
        logger.error(`Error updating ${req.params.gateway} configuration:`, error);
        res.status(500).json({
            success: false,
            message: `Error updating ${req.params.gateway} configuration`,
            error: error.message
        });
    }
});

// Test gateway connection
router.post('/payment-settings/test/:gateway', async (req, res) => {
    try {
        const { gateway } = req.params;
        const PaymentGatewayManager = require('../config/paymentGateway');
        const paymentManager = new PaymentGatewayManager();
        
        // Test the gateway by trying to create a test payment
        const testInvoice = {
            invoice_number: 'TEST-001',
            amount: 10000,
            package_name: 'Test Package',
            customer_name: 'Test Customer',
            customer_phone: '08123456789',
            customer_email: 'test@example.com'
        };
        
        // Guard: Tripay minimum amount validation to avoid gateway rejection
        if (gateway === 'tripay' && Number(testInvoice.amount) < 10000) {
            return res.status(400).json({
                success: false,
                message: 'Minimal nominal Tripay adalah Rp 10.000'
            });
        }
        
        const result = await paymentManager.createPayment(testInvoice, gateway);
        
        res.json({
            success: true,
            message: `${gateway} connection test successful`,
            data: result
        });
    } catch (error) {
        logger.error(`Error testing ${req.params.gateway} connection:`, error);
        res.status(500).json({
            success: false,
            message: `${req.params.gateway} connection test failed: ${error.message}`
        });
    }
});

router.get('/api/invoices/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const invoice = await billingManager.getInvoiceById(id);
        
        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: 'Invoice tidak ditemukan'
            });
        }
        
        res.json({
            success: true,
            invoice: invoice
        });
    } catch (error) {
        logger.error('Error getting invoice by ID API:', error);
        res.status(500).json({ 
            success: false,
            error: error.message 
        });
    }
});

// Route /api/stats sudah ada di atas dengan adminAuth middleware

router.get('/api/overdue', async (req, res) => {
    try {
        const overdueInvoices = await billingManager.getOverdueInvoices();
        res.json(overdueInvoices);
    } catch (error) {
        logger.error('Error getting overdue invoices API:', error);
        res.status(500).json({ error: error.message });
    }
});

// Manual test auto suspension
router.post('/test-auto-suspension', adminAuth, async (req, res) => {
    try {
        logger.info('Manual test auto suspension triggered by admin');
        
        const serviceSuspension = require('../config/serviceSuspension');
        const result = await serviceSuspension.checkAndSuspendOverdueCustomers({ force: true });
        
        res.json({
            success: true,
            message: 'Test auto suspension completed',
            result: result
        });
        
    } catch (error) {
        logger.error('Error in manual test auto suspension:', error);
        res.status(500).json({
            success: false,
            message: 'Error testing auto suspension: ' + error.message
        });
    }
});

// Service Suspension Management Routes
router.post('/service-suspension/suspend/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const { reason } = req.body;
        
        // Validasi input
        if (!username || username.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Username tidak boleh kosong'
            });
        }

        const customer = await billingManager.getCustomerByUsername(username.trim());
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Customer tidak ditemukan'
            });
        }

        // Cek apakah customer sudah suspended
        if (customer.status === 'suspended') {
            return res.status(400).json({
                success: false,
                message: 'Customer sudah dalam status suspended'
            });
        }

        const serviceSuspension = require('../config/serviceSuspension');
        const result = await serviceSuspension.suspendCustomerService(customer, reason || 'Manual suspension');
        
        res.json({
            success: result.success,
            message: result.success ? 'Service suspended successfully' : 'Failed to suspend service',
            results: result.results,
            customer: result.customer,
            reason: result.reason || (reason || 'Manual suspension')
        });
    } catch (error) {
        logger.error('Error suspending service:', error);
        res.status(500).json({
            success: false,
            message: 'Error suspending service: ' + error.message
        });
    }
});

router.post('/service-suspension/restore/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const { reason } = req.body || {};
        
        // Validasi input
        if (!username || username.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Username tidak boleh kosong'
            });
        }

        const customer = await billingManager.getCustomerByUsername(username.trim());
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Customer tidak ditemukan'
            });
        }

        // Cek apakah customer sudah active
        if (customer.status === 'active') {
            return res.status(400).json({
                success: false,
                message: 'Customer sudah dalam status active'
            });
        }

        const serviceSuspension = require('../config/serviceSuspension');
        const result = await serviceSuspension.restoreCustomerService(customer, reason || 'Manual restore');
        
        res.json({
            success: result.success,
            message: result.success ? 'Service restored successfully' : 'Failed to restore service',
            results: result.results,
            customer: result.customer,
            reason: result.reason || (reason || 'Manual restore')
        });
    } catch (error) {
        logger.error('Error restoring service:', error);
        res.status(500).json({
            success: false,
            message: 'Error restoring service: ' + error.message
        });
    }
});

router.post('/service-suspension/check-overdue', async (req, res) => {
    try {
        const serviceSuspension = require('../config/serviceSuspension');
        const result = await serviceSuspension.checkAndSuspendOverdueCustomers({ force: true });
        const memberResult = await serviceSuspension.checkAndSuspendOverdueMembers({ force: true });
        
        res.json({
            success: true,
            message: 'Overdue customers check completed',
            ...result,
            members: memberResult
        });
    } catch (error) {
        logger.error('Error checking overdue customers:', error);
        res.status(500).json({
            success: false,
            message: 'Error checking overdue customers: ' + error.message
        });
    }
});

router.post('/service-suspension/check-paid', async (req, res) => {
    try {
        const serviceSuspension = require('../config/serviceSuspension');
        const result = await serviceSuspension.checkAndRestorePaidCustomers();
        
        res.json({
            success: true,
            message: 'Paid customers check completed',
            ...result
        });
    } catch (error) {
        logger.error('Error checking paid customers:', error);
        res.status(500).json({
            success: false,
            message: 'Error checking paid customers: ' + error.message
        });
    }
});

// Service Suspension Settings Page
router.get('/service-suspension', getAppSettings, async (req, res) => {
    try {
        // Get authentication mode
        const { getUserAuthModeAsync } = require('../config/mikrotik');
        const authMode = await getUserAuthModeAsync();
        
        res.render('admin/billing/service-suspension', {
            title: 'Service Suspension',
            appSettings: req.appSettings,
            authMode: authMode || 'mikrotik'
        });
    } catch (error) {
        logger.error('Error loading service suspension page:', error);
        res.status(500).render('error', { 
            message: 'Error loading service suspension page',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Service Suspension: Grace Period Setting API
router.get('/service-suspension/grace-period', adminAuth, async (req, res) => {
    try {
        const value = getSetting('suspension_grace_period_days', '3');
        res.json({ success: true, grace_period_days: value });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/service-suspension/grace-period', adminAuth, async (req, res) => {
    try {
        const { grace_period_days } = req.body || {};
        if (!grace_period_days || typeof grace_period_days !== 'string') {
            return res.status(400).json({ success: false, message: 'grace_period_days tidak valid' });
        }

        const days = parseInt(grace_period_days.trim(), 10);
        if (isNaN(days) || days < 1 || days > 30) {
            return res.status(400).json({ success: false, message: 'Grace period harus antara 1-30 hari' });
        }

        const ok = setSetting('suspension_grace_period_days', days.toString());
        if (!ok) {
            return res.status(500).json({ success: false, message: 'Gagal menyimpan ke settings.json' });
        }

        // Clear cache agar pengaturan baru langsung berlaku
        clearSettingsCache();

        res.json({ success: true, grace_period_days: days.toString() });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/service-suspension/auto-suspension-day', adminAuth, async (req, res) => {
    try {
        const serviceSuspension = require('../config/serviceSuspension');
        const value = serviceSuspension.getAutoSuspensionDay();
        res.json({ success: true, auto_suspension_day: String(value) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/service-suspension/auto-suspension-day', adminAuth, async (req, res) => {
    try {
        const { auto_suspension_day } = req.body || {};
        if (auto_suspension_day === undefined || auto_suspension_day === null || String(auto_suspension_day).trim() === '') {
            return res.status(400).json({ success: false, message: 'auto_suspension_day tidak valid' });
        }

        const day = parseInt(String(auto_suspension_day).trim(), 10);
        if (isNaN(day) || day < 1 || day > 28) {
            return res.status(400).json({ success: false, message: 'Tanggal isolir harus antara 1-28' });
        }

        const ok = setSetting('auto_suspension_day', day.toString());
        if (!ok) {
            return res.status(500).json({ success: false, message: 'Gagal menyimpan ke settings.json' });
        }

        clearSettingsCache();

        res.json({ success: true, auto_suspension_day: day.toString() });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Service Suspension: Isolir Profile Setting API
router.get('/service-suspension/isolir-profile', adminAuth, async (req, res) => {
    try {
        const value = getSetting('isolir_profile', 'isolir');
        res.json({ success: true, isolir_profile: value });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/service-suspension/isolir-profile', adminAuth, async (req, res) => {
    try {
        const { isolir_profile } = req.body || {};
        if (!isolir_profile || typeof isolir_profile !== 'string') {
            return res.status(400).json({ success: false, message: 'isolir_profile tidak valid' });
        }

        const profile = isolir_profile.trim();
        if (!profile) {
            return res.status(400).json({ success: false, message: 'Profile tidak boleh kosong' });
        }

        const ok = setSetting('isolir_profile', profile);
        if (!ok) {
            return res.status(500).json({ success: false, message: 'Gagal menyimpan ke settings.json' });
        }

        // Clear cache agar pengaturan baru langsung berlaku
        clearSettingsCache();

        res.json({ success: true, isolir_profile: profile });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Toggle auto suspension feature
router.post('/service-suspension/toggle-feature', adminAuth, async (req, res) => {
    try {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean' && enabled !== 'true' && enabled !== 'false') {
            return res.status(400).json({ success: false, message: 'Status tidak valid' });
        }

        const isEnabled = enabled === true || enabled === 'true';
        const ok = setSetting('auto_suspension_enabled', isEnabled);
        
        if (!ok) {
            return res.status(500).json({ success: false, message: 'Gagal menyimpan ke settings.json' });
        }

        clearSettingsCache();
        res.json({ success: true, enabled: isEnabled });
    } catch (error) {
        logger.error('Toggle auto suspension feature error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Bulk update jatuh tempo per wilayah
router.post('/service-suspension/bulk-update-due-date-by-areas', adminAuth, async (req, res) => {
    try {
        const { area_ids, due_day } = req.body || {};

        const day = parseInt(due_day, 10);
        if (isNaN(day) || day < 1 || day > 28) {
            return res.status(400).json({
                success: false,
                message: 'Tanggal jatuh tempo harus antara 1-28',
                total: 0,
                updated: 0,
                failed: 0,
                invoices_updated: 0
            });
        }

        const result = await billingManager.bulkUpdateDueDateByAreas({ area_ids, due_day: day });
        const { total, updated, failed, invoices_updated, need_retry } = result;

        let message = `Jatuh tempo diupdate: ${updated} dari ${total} pelanggan di wilayah terpilih.`;
        if (failed > 0) message += ` Gagal: ${failed}.`;
        message += ` Tagihan unpaid disesuaikan: ${invoices_updated}.`;

        logger.info(`[BILLING] Bulk update due date by areas: ${message}`);

        res.json({
            success: failed === 0 || updated > 0,
            message,
            total,
            updated,
            failed,
            invoices_updated: invoices_updated || 0,
            need_retry: Boolean(need_retry),
            due_day: result.due_day,
            area_ids: result.area_ids
        });
    } catch (error) {
        logger.error('Bulk update due date by areas error:', error);
        res.status(500).json({
            success: false,
            message: error.message,
            total: 0,
            updated: 0,
            failed: 0,
            invoices_updated: 0
        });
    }
});

// Ringkasan tanggal auto isolir per pelanggan / wilayah
router.get('/service-suspension/isolir-day-summary', adminAuth, async (req, res) => {
    try {
        const { getSetting } = require('../config/settingsManager');
        const globalDefault = parseInt(getSetting('auto_suspension_day', '25'), 10) || 25;

        let area_ids = req.query.area_ids;
        if (typeof area_ids === 'string' && area_ids.trim()) {
            area_ids = area_ids.split(',').map((s) => s.trim()).filter(Boolean);
        } else if (!Array.isArray(area_ids)) {
            area_ids = [];
        }

        const summary = await billingManager.getAutoIsolirScheduleSummary(area_ids);

        const by_day = (summary.by_day || []).map((row) => {
            const dayNum = row.day_value != null && row.day_value !== '' ? parseInt(row.day_value, 10) : null;
            return {
                day_value: dayNum,
                label: dayNum != null && dayNum >= 1 && dayNum <= 28
                    ? `Tanggal ${dayNum}`
                    : `Global (tgl ${globalDefault})`,
                count: row.count
            };
        });

        const customers = (summary.customers || []).map((c) => {
            const dayNum = c.auto_suspension_day != null && c.auto_suspension_day !== ''
                ? parseInt(c.auto_suspension_day, 10)
                : null;
            return {
                ...c,
                isolir_day: dayNum != null && dayNum >= 1 && dayNum <= 28 ? dayNum : globalDefault,
                isolir_label: dayNum != null && dayNum >= 1 && dayNum <= 28
                    ? `Tgl ${dayNum}`
                    : `Global (tgl ${globalDefault})`
            };
        });

        res.json({
            success: true,
            global_default_day: globalDefault,
            total: summary.total,
            area_ids: summary.area_ids,
            by_day,
            by_area: (summary.by_area || []).map((row) => {
                const dayNum = row.day_value != null && row.day_value !== '' ? parseInt(row.day_value, 10) : null;
                return {
                    area_name: row.area_name,
                    day_value: dayNum,
                    label: dayNum != null && dayNum >= 1 && dayNum <= 28
                        ? `Tgl ${dayNum}`
                        : `Global (tgl ${globalDefault})`,
                    count: row.count
                };
            }),
            customers
        });
    } catch (error) {
        logger.error('Isolir day summary error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Bulk update tanggal auto isolir per wilayah
router.post('/service-suspension/bulk-update-auto-isolir-by-areas', adminAuth, async (req, res) => {
    try {
        const { area_ids, auto_suspension_day } = req.body || {};

        const day = parseInt(auto_suspension_day, 10);
        if (isNaN(day) || day < 1 || day > 28) {
            return res.status(400).json({
                success: false,
                message: 'Tanggal auto isolir harus antara 1-28',
                total: 0,
                updated: 0,
                failed: 0
            });
        }

        const result = await billingManager.bulkUpdateAutoIsolirDayByAreas({ area_ids, auto_suspension_day: day });
        const { total, updated, failed, need_retry } = result;

        let message = `Tanggal auto isolir diupdate: ${updated} dari ${total} pelanggan di wilayah terpilih.`;
        if (failed > 0) message += ` Gagal: ${failed}.`;

        logger.info(`[BILLING] Bulk update auto isolir by areas: ${message}`);

        res.json({
            success: failed === 0 || updated > 0,
            message,
            total,
            updated,
            failed,
            need_retry: Boolean(need_retry),
            auto_suspension_day: result.auto_suspension_day,
            area_ids: result.area_ids
        });
    } catch (error) {
        logger.error('Bulk update auto isolir by areas error:', error);
        res.status(500).json({
            success: false,
            message: error.message,
            total: 0,
            updated: 0,
            failed: 0
        });
    }
});

// Bulk update isolir date
router.post('/service-suspension/bulk-update-isolir-date', adminAuth, async (req, res) => {
    try {
        const { renewal_type, billing_day, fix_date } = req.body;

        if (renewal_type === 'fix_date') {
            const fDate = parseInt(fix_date, 10);
            if (isNaN(fDate) || fDate < 1 || fDate > 28) {
                return res.status(400).json({
                    success: false,
                    message: 'Tanggal fix date harus antara 1-28',
                    total: 0,
                    updated: 0,
                    failed: 0,
                    need_retry: false
                });
            }
        } else {
            const bDay = parseInt(billing_day, 10);
            if (isNaN(bDay) || bDay < 1 || bDay > 365) {
                return res.status(400).json({
                    success: false,
                    message: 'Billing day (siklus) tidak valid (1-365)',
                    total: 0,
                    updated: 0,
                    failed: 0,
                    need_retry: false
                });
            }
        }

        const result = await billingManager.bulkUpdateCustomerBillingCycle({
            renewal_type,
            billing_day,
            fix_date
        });

        const { total, updated, failed, invoices_updated, need_retry } = result;
        let message = `Pelanggan berhasil diupdate: ${updated} dari ${total}.`;
        if (failed > 0) {
            message += ` Gagal: ${failed}.`;
        }
        if (renewal_type === 'fix_date') {
            message += ` Tagihan belum lunas dengan jatuh tempo disesuaikan: ${invoices_updated}.`;
        }
        if (need_retry) {
            message += ' Disarankan ulangi operasi.';
        } else {
            message += ' Tidak perlu diulang.';
        }

        logger.info(`[BILLING] Bulk update billing cycle: ${message}`);

        res.json({
            success: failed === 0 || updated > 0,
            message,
            total,
            updated,
            failed,
            invoices_updated: invoices_updated || 0,
            need_retry: Boolean(need_retry),
            renewal_type: result.renewal_type,
            fix_date: result.fix_date,
            billing_day: result.billing_day
        });
    } catch (error) {
        logger.error('Bulk update isolir date unhandled error:', error);
        res.status(500).json({
            success: false,
            message: error.message,
            total: 0,
            updated: 0,
            failed: 0,
            need_retry: true
        });
    }
});

// Payment Monitor
router.get('/payment-monitor', getAppSettings, async (req, res) => {
    try {
        res.render('admin/billing/payment-monitor', {
            title: 'Payment Monitor',
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error loading payment monitor:', error);
        res.status(500).render('error', { 
            message: 'Error loading payment monitor',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Manual Isolir by Invoice ID
router.post('/invoices/:id/isolir', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const reason = (req.body && req.body.reason) || 'Isolir manual dari Admin';

        const invoice = await billingManager.getInvoiceById(id);
        if (!invoice) return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan' });

        const customer = await billingManager.getCustomerById(invoice.customer_id);
        if (!customer) return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });

        const result = await serviceSuspension.suspendCustomerService(customer, reason);
        return res.json({ success: !!result?.success, data: result, message: result?.success ? 'Isolir berhasil' : (result?.error || 'Gagal isolir') });
    } catch (error) {
        logger.error('Error manual isolir:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Manual Restore by Invoice ID
router.post('/invoices/:id/restore', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const reason = (req.body && req.body.reason) || 'Restore manual dari Admin';

        const invoice = await billingManager.getInvoiceById(id);
        if (!invoice) return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan' });

        const customer = await billingManager.getCustomerById(invoice.customer_id);
        if (!customer) return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });

        const result = await serviceSuspension.restoreCustomerService(customer, reason);
        return res.json({ success: !!result?.success, data: result, message: result?.success ? 'Restore berhasil' : (result?.error || 'Gagal restore') });
    } catch (error) {
        logger.error('Error manual restore:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// API untuk Kelola Kategori Keuangan
router.get('/api/finance-categories', async (req, res) => {
    try {
        const { type } = req.query;
        let query = 'SELECT * FROM finance_categories';
        const params = [];
        if (type) {
            query += ' WHERE type = ?';
            params.push(type);
        }
        query += ' ORDER BY name ASC';
        
        const db = new sqlite3.Database(path.join(__dirname, '../data/billing.db'));
        db.all(query, params, (err, rows) => {
            db.close();
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true, data: rows });
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/finance-categories', async (req, res) => {
    try {
        const { type, name, subcategories } = req.body;
        if (!type || !name) return res.status(400).json({ success: false, message: 'Type dan Name wajib diisi' });

        const trimmedName = String(name).trim();
        if (!trimmedName) return res.status(400).json({ success: false, message: 'Nama kategori tidak boleh kosong' });
        
        const subCatStr = subcategories ? JSON.stringify(subcategories) : null;
        const db = new sqlite3.Database(path.join(__dirname, '../data/billing.db'));
        db.get(
            'SELECT id FROM finance_categories WHERE type = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1',
            [type, trimmedName],
            (dupErr, dupRow) => {
                if (dupErr) {
                    db.close();
                    return res.status(500).json({ success: false, message: dupErr.message });
                }
                if (dupRow) {
                    db.close();
                    return res.status(400).json({ success: false, message: 'Kategori dengan nama serupa sudah ada' });
                }
                db.run(
                    'INSERT INTO finance_categories (type, name, subcategories) VALUES (?, ?, ?)',
                    [type, trimmedName, subCatStr],
                    function(err) {
                        db.close();
                        if (err) return res.status(500).json({ success: false, message: err.message });
                        res.json({ success: true, data: { id: this.lastID, type, name: trimmedName, subcategories } });
                    }
                );
            }
        );
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.put('/api/finance-categories/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, subcategories } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'Name wajib diisi' });
        
        const subCatStr = subcategories ? JSON.stringify(subcategories) : null;
        const db = new sqlite3.Database(path.join(__dirname, '../data/billing.db'));
        db.run("UPDATE finance_categories SET name = ?, subcategories = ?, updated_at = datetime('now','localtime') WHERE id = ?", [name, subCatStr, id], function(err) {
            db.close();
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true, message: 'Kategori berhasil diupdate' });
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.delete('/api/finance-categories/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const db = new sqlite3.Database(path.join(__dirname, '../data/billing.db'));
        db.run('DELETE FROM finance_categories WHERE id = ?', [id], function(err) {
            db.close();
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true, message: 'Kategori berhasil dihapus' });
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// UI untuk Kelola Kategori Keuangan
router.get('/finance-categories', getAppSettings, async (req, res) => {
    res.render('admin/billing/finance-categories', {
        title: 'Kelola Kategori Keuangan',
        appSettings: req.appSettings,
        page: 'finance-categories'
    });
});

// Route untuk mengelola expenses
router.get('/expenses', getAppSettings, async (req, res) => {
    try {
        const { start_date, end_date } = req.query;
        const period = resolveMonthYearRange(req.query);
        const startDate = start_date || period.startDate;
        const endDate = end_date || period.endDate;
        const expenses = await billingManager.getExpenses(startDate, endDate);
        const categorySummary = await billingManager.getFinanceCategorySummary('expense', startDate, endDate);
        
        res.render('admin/billing/expenses', {
            title: 'Manajemen Pengeluaran',
            expenses,
            categorySummary,
            startDate,
            endDate,
            month: period.month,
            year: period.year,
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error loading expenses:', error);
        res.status(500).render('error', { 
            message: 'Gagal memuat data pengeluaran',
            error: error.message 
        });
    }
});

// API untuk menambah expense
router.post('/api/expenses', async (req, res) => {
    try {
        const { amount, category, account_expenses, expense_date, payment_method, notes } = req.body;
        
        if (!amount || !category || !expense_date) {
            return res.status(400).json({ 
                success: false, 
                message: 'Semua field wajib diisi' 
            });
        }
        
        const expense = await billingManager.addExpense({
            amount: parseFloat(amount),
            category,
            account_expenses: account_expenses || null,
            expense_date,
            payment_method: payment_method || '',
            notes: notes || ''
        });
        
        res.json({ success: true, data: expense, message: 'Pengeluaran berhasil ditambahkan' });
    } catch (error) {
        logger.error('Error adding expense:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// API untuk get expense by id
router.get('/api/expenses/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const expenses = await billingManager.getExpenses();
        const expense = expenses.find(exp => exp.id === parseInt(id));
        
        if (!expense) {
            return res.status(404).json({ 
                success: false, 
                message: 'Pengeluaran tidak ditemukan' 
            });
        }
        
        res.json({ success: true, data: expense });
    } catch (error) {
        logger.error('Error getting expense:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// API untuk update expense
router.put('/api/expenses/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, category, account_expenses, expense_date, payment_method, notes } = req.body;
        
        if (!amount || !category || !expense_date) {
            return res.status(400).json({ 
                success: false, 
                message: 'Semua field wajib diisi' 
            });
        }
        
        const expense = await billingManager.updateExpense(parseInt(id), {
            amount: parseFloat(amount),
            category,
            account_expenses: account_expenses || null,
            expense_date,
            payment_method: payment_method || '',
            notes: notes || ''
        });
        
        res.json({ success: true, data: expense, message: 'Pengeluaran berhasil diperbarui' });
    } catch (error) {
        logger.error('Error updating expense:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// API untuk delete expense
router.delete('/api/expenses/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await billingManager.deleteExpense(parseInt(id));
        
        res.json({ success: true, data: result, message: 'Pengeluaran berhasil dihapus' });
    } catch (error) {
        logger.error('Error deleting expense:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// API untuk statistik komisi kolektor
router.get('/api/commission-stats', async (req, res) => {
    try {
        const { start_date, end_date } = req.query;
        const period = resolveMonthYearRange(req.query);
        const startDate = start_date || period.startDate;
        const endDate = end_date || period.endDate;
        const stats = await billingManager.getCommissionStats(startDate, endDate);
        
        res.json({ success: true, data: stats });
    } catch (error) {
        logger.error('Error getting commission stats:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Route untuk mengelola income (pemasukan)
router.get('/income', getAppSettings, async (req, res) => {
    try {
        const { start_date, end_date } = req.query;
        const period = resolveMonthYearRange(req.query);
        const startDate = start_date || period.startDate;
        const endDate = end_date || period.endDate;
        const incomes = await billingManager.getIncomes(startDate, endDate);
        const categorySummary = await billingManager.getFinanceCategorySummary('income', startDate, endDate);
        
        res.render('admin/billing/income', {
            title: 'Manajemen Pemasukan',
            incomes,
            categorySummary,
            startDate,
            endDate,
            month: period.month,
            year: period.year,
            page: 'income',
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error loading income:', error);
        res.status(500).render('error', { 
            message: 'Gagal memuat data pemasukan',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// API untuk menambah income
router.post('/api/income', async (req, res) => {
    try {
        const { description, amount, category, income_date, payment_method, notes } = req.body;
        
        if (!description || !amount || !category || !income_date) {
            return res.status(400).json({ 
                success: false, 
                message: 'Semua field wajib diisi' 
            });
        }
        
        const income = await billingManager.addIncome({
            description,
            amount: parseFloat(amount),
            category,
            income_date,
            payment_method: payment_method || '',
            notes: notes || ''
        });
        
        res.json({ success: true, data: income, message: 'Pemasukan berhasil ditambahkan' });
    } catch (error) {
        logger.error('Error adding income:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// API untuk update income
router.put('/api/income/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { description, amount, category, income_date, payment_method, notes } = req.body;
        
        if (!description || !amount || !category || !income_date) {
            return res.status(400).json({ 
                success: false, 
                message: 'Semua field wajib diisi' 
            });
        }
        
        const income = await billingManager.updateIncome(parseInt(id), {
            description,
            amount: parseFloat(amount),
            category,
            income_date,
            payment_method: payment_method || '',
            notes: notes || ''
        });
        
        res.json({ success: true, data: income, message: 'Pemasukan berhasil diperbarui' });
    } catch (error) {
        logger.error('Error updating income:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// API untuk delete income
router.delete('/api/income/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await billingManager.deleteIncome(parseInt(id));
        
        res.json({ success: true, data: result, message: 'Pemasukan berhasil dihapus' });
    } catch (error) {
        logger.error('Error deleting income:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Export Laporan Laba Rugi to Excel
router.get('/export/profit-loss.xlsx', async (req, res) => {
    try {
        const { start_date, end_date } = req.query;
        
        // Default date range: current month
        const now = new Date();
        const startDate = start_date || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const endDate = end_date || new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
        
        const financialData = await billingManager.getFinancialReport(startDate, endDate, 'all');
        
        if (!financialData || !financialData.profitLossData) {
            return res.status(404).json({ success: false, message: 'Data laba rugi tidak ditemukan' });
        }
        
        const profitLossData = financialData.profitLossData;
        
        // Create workbook
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Laporan Laba Rugi');
        
        // Set column widths
        worksheet.columns = [
            { header: 'Keterangan', key: 'keterangan', width: 60 },
            { header: 'Jumlah (Rp)', key: 'jumlah', width: 25 }
        ];
        
        // Style header
        worksheet.getRow(1).font = { bold: true, size: 12 };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4472C4' }
        };
        worksheet.getRow(1).font = { ...worksheet.getRow(1).font, color: { argb: 'FFFFFFFF' } };
        worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
        
        // Add title
        worksheet.insertRow(1, ['LAPORAN LABA RUGI', '']);
        worksheet.mergeCells('A1:B1');
        worksheet.getRow(1).font = { bold: true, size: 14 };
        worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
        worksheet.getRow(1).height = 25;
        
        // Add period
        worksheet.insertRow(2, [`Periode: ${startDate} s/d ${endDate}`, '']);
        worksheet.mergeCells('A2:B2');
        worksheet.getRow(2).alignment = { vertical: 'middle', horizontal: 'center' };
        worksheet.getRow(2).height = 20;
        
        // Add empty row
        worksheet.insertRow(3, ['', '']);
        
        // Add header row
        worksheet.insertRow(4, ['Keterangan', 'Jumlah (Rp)']);
        worksheet.getRow(4).font = { bold: true };
        worksheet.getRow(4).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE7E6E6' }
        };
        worksheet.getRow(4).alignment = { vertical: 'middle', horizontal: 'center' };
        
        let currentRow = 5;
        
        // PENDAPATAN USAHA
        worksheet.insertRow(currentRow, ['PENDAPATAN USAHA', '']);
        worksheet.getRow(currentRow).font = { bold: true };
        worksheet.getRow(currentRow).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFD4EDDA' }
        };
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Pendapatan PPPoE', profitLossData.revenue.pppoePayment || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Pendapatan Member', profitLossData.revenue.memberPayment || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Pendapatan Voucher', profitLossData.revenue.voucher]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Pendapatan lain-lain dari Manajemen Pendapatan', profitLossData.revenue.otherIncome]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Total Pendapatan Usaha', profitLossData.revenue.total]);
        worksheet.getRow(currentRow).font = { bold: true };
        worksheet.getRow(currentRow).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFC3E6CB' }
        };
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        // Empty row
        worksheet.insertRow(currentRow, ['', '']);
        currentRow++;
        
        // PENGELUARAN
        worksheet.insertRow(currentRow, ['PENGELUARAN', '']);
        worksheet.getRow(currentRow).font = { bold: true };
        worksheet.getRow(currentRow).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF8D7DA' }
        };
        currentRow++;
        
        // Add expenses by category
        const expensesByCategory = profitLossData.expenses.byCategory;
        const categoryOrder = ['Harga Pokok Penjualan (HPP)', 'Beban Operasional (OPEX)', 'Beban Lainnya'];
        
        categoryOrder.forEach(category => {
            if (expensesByCategory[category]) {
                const categoryTotal = profitLossData.expenses.totalByCategory[category] || 0;
                worksheet.insertRow(currentRow, [category, categoryTotal]);
                worksheet.getRow(currentRow).font = { bold: true };
                worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
                currentRow++;
                
                Object.keys(expensesByCategory[category]).forEach(account => {
                    const accountAmount = expensesByCategory[category][account];
                    worksheet.insertRow(currentRow, [`  ${account}`, accountAmount]);
                    worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
                    currentRow++;
                });
            }
        });
        
        // Handle other categories
        Object.keys(expensesByCategory).forEach(category => {
            if (!categoryOrder.includes(category)) {
                const categoryTotal = profitLossData.expenses.totalByCategory[category] || 0;
                worksheet.insertRow(currentRow, [category, categoryTotal]);
                worksheet.getRow(currentRow).font = { bold: true };
                worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
                currentRow++;
                
                Object.keys(expensesByCategory[category]).forEach(account => {
                    const accountAmount = expensesByCategory[category][account];
                    worksheet.insertRow(currentRow, [`  ${account}`, accountAmount]);
                    worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
                    currentRow++;
                });
            }
        });
        
        worksheet.insertRow(currentRow, ['Total Pengeluaran', profitLossData.expenses.total]);
        worksheet.getRow(currentRow).font = { bold: true };
        worksheet.getRow(currentRow).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE5C3C6' }
        };
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        // Empty row
        worksheet.insertRow(currentRow, ['', '']);
        currentRow++;
        
        // LABA BERSIH
        const isProfit = profitLossData.netProfit >= 0;
        worksheet.insertRow(currentRow, ['LABA BERSIH', profitLossData.netProfit]);
        worksheet.getRow(currentRow).font = { bold: true, size: 12 };
        worksheet.getRow(currentRow).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: isProfit ? 'FFD4EDDA' : 'FFF8D7DA' }
        };
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        
        // Set alignment for all rows
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber > 4) {
                row.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
                row.getCell(2).alignment = { vertical: 'middle', horizontal: 'right' };
            }
        });
        
        // Set response headers
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=laporan-laba-rugi-${startDate}-${endDate}.xlsx`);
        
        // Write to response
        await workbook.xlsx.write(res);
        res.end();
        
    } catch (error) {
        logger.error('Error exporting profit loss to Excel:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Root billing page - redirect to dashboard
router.get('/', getAppSettings, async (req, res) => {
    res.redirect('/admin/billing/dashboard');
});

// Devices page
router.get('/devices', getAppSettings, async (req, res) => {
    try {
        res.render('admin/billing/devices', {
            title: 'Network Devices',
            user: req.user,
            settings: req.appSettings
        });
    } catch (error) {
        console.error('Error rendering devices page:', error);
        res.status(500).render('error', { 
            message: 'Error loading devices page',
            error: error 
        });
    }
});

// New Mapping page
router.get('/mapping-new', getAppSettings, async (req, res) => {
    try {
        const { ensureMapCenterFromCompanyAddress } = require('../config/mapDefaultCenter');
        const mapCenter = await ensureMapCenterFromCompanyAddress();
        res.render('admin/billing/mapping-new', {
            title: 'Network Mapping - New',
            user: req.user,
            settings: req.appSettings,
            defaultMapLat: mapCenter.lat,
            defaultMapLng: mapCenter.lng,
            defaultMapZoom: mapCenter.zoom
        });
    } catch (error) {
        console.error('Error rendering new mapping page:', error);
        res.status(500).render('error', { 
            message: 'Error loading mapping page',
            error: error 
        });
    }
});

// Mapping page - Redirect to new mapping page
router.get('/mapping', getAppSettings, async (req, res) => {
    try {
        // Redirect to new mapping page
        return res.redirect('/admin/billing/mapping-new');
    } catch (error) {
        logger.error('Error redirecting to mapping page:', error);
        res.status(500).render('error', {
            message: 'Error redirecting to mapping page',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Mobile Mapping page
router.get('/mobile/mapping', getAppSettings, async (req, res) => {
    try {
        // Get mapping data for mobile
        const customers = await billingManager.getCustomers();
        const customersWithCoords = customers.filter(c => c.latitude && c.longitude);
        
        // Calculate stats
        const totalCustomers = customersWithCoords.length;
        const activeCustomers = customersWithCoords.filter(c => c.status === 'active').length;
        const suspendedCustomers = customersWithCoords.filter(c => c.status === 'suspended').length;
        
        // Use responsive mapping-new.ejs instead of separate mobile version
        res.redirect('/admin/billing/mapping');
    } catch (error) {
        logger.error('Error loading mobile mapping page:', error);
        res.status(500).render('error', {
            message: 'Error loading mobile mapping page',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// API untuk mapping data
router.get('/api/mapping/data', async (req, res) => {
    try {
        const MappingUtils = require('../utils/mappingUtils');
        
        // Ambil data customers dengan koordinat
        const customers = await billingManager.getCustomers();
        const customersWithCoords = customers.filter(c => c.latitude && c.longitude);
        
        // Validasi koordinat customer
        const validatedCustomers = customersWithCoords.map(customer => 
            MappingUtils.validateCustomerCoordinates(customer)
        );
        
        // Hitung statistik mapping
        const totalCustomers = validatedCustomers.length;
        const validCoordinates = validatedCustomers.filter(c => c.coordinateStatus === 'valid').length;
        const defaultCoordinates = validatedCustomers.filter(c => c.coordinateStatus === 'default').length;
        const invalidCoordinates = validatedCustomers.filter(c => c.coordinateStatus === 'invalid').length;
        
        // Hitung area coverage jika ada minimal 3 koordinat
        let coverageArea = 0;
        if (validCoordinates >= 3) {
            const validCoords = validatedCustomers
                .filter(c => c.coordinateStatus === 'valid')
                .map(c => ({ latitude: c.latitude, longitude: c.longitude }));
            coverageArea = MappingUtils.calculateCoverageArea(validCoords);
        }
        
        // Buat clusters untuk customer
        const customerClusters = MappingUtils.createClusters(
            validatedCustomers.map(c => ({ latitude: c.latitude, longitude: c.longitude })),
            2000 // 2km cluster radius
        );
        
        res.json({
            success: true,
            data: {
                customers: validatedCustomers,
                clusters: customerClusters,
                statistics: {
                    totalCustomers,
                    validCoordinates,
                    defaultCoordinates,
                    invalidCoordinates,
                    coverageArea: parseFloat(coverageArea)
                }
            }
        });
    } catch (error) {
        logger.error('Error getting mapping data:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Gagal mengambil data mapping' 
        });
    }
});

// API untuk analisis coverage area
router.get('/api/mapping/coverage', async (req, res) => {
    try {
        const MappingUtils = require('../utils/mappingUtils');
        
        // Ambil data customers
        const customers = await billingManager.getCustomers();
        const customersWithCoords = customers.filter(c => c.latitude && c.longitude);
        
        if (customersWithCoords.length < 3) {
            return res.json({
                success: false,
                message: 'Minimal 3 koordinat diperlukan untuk analisis coverage'
            });
        }
        
        // Hitung bounding box
        const coordinates = customersWithCoords.map(c => ({ 
            latitude: c.latitude, 
            longitude: c.longitude 
        }));
        
        const boundingBox = MappingUtils.getBoundingBox(coordinates);
        const center = MappingUtils.getCenterCoordinate(coordinates);
        const coverageArea = MappingUtils.calculateCoverageArea(coordinates);
        
        // Analisis density per area
        const clusters = MappingUtils.createClusters(coordinates, 1000); // 1km radius
        const highDensityAreas = clusters.filter(c => c.count >= 5);
        const mediumDensityAreas = clusters.filter(c => c.count >= 3 && c.count < 5);
        const lowDensityAreas = clusters.filter(c => c.count < 3);
        
        res.json({
            success: true,
            data: {
                coverageArea: parseFloat(coverageArea),
                boundingBox,
                center,
                densityAnalysis: {
                    highDensity: highDensityAreas.length,
                    mediumDensity: mediumDensityAreas.length,
                    lowDensity: lowDensityAreas.length,
                    totalClusters: clusters.length
                },
                clusters: {
                    high: highDensityAreas,
                    medium: mediumDensityAreas,
                    low: lowDensityAreas
                }
            }
        });
    } catch (error) {
        logger.error('Error analyzing coverage:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Gagal menganalisis coverage area' 
        });
    }
});

// API untuk update koordinat customer
router.put('/api/mapping/customers/:id/coordinates', async (req, res) => {
    try {
        const { id } = req.params;
        const { latitude, longitude } = req.body;
        
        if (!latitude || !longitude) {
            return res.status(400).json({
                success: false,
                message: 'Latitude dan longitude wajib diisi'
            });
        }
        
        const MappingUtils = require('../utils/mappingUtils');
        
        // Validasi koordinat
        if (!MappingUtils.isValidCoordinate(latitude, longitude)) {
            return res.status(400).json({
                success: false,
                message: 'Koordinat tidak valid'
            });
        }
        
        // Update koordinat customer
        const result = await billingManager.updateCustomerCoordinates(parseInt(id), {
            latitude: parseFloat(latitude),
            longitude: parseFloat(longitude)
        });
        
        if (result) {
            res.json({
                success: true,
                message: 'Koordinat customer berhasil diperbarui',
                data: {
                    id: parseInt(id),
                    latitude: parseFloat(latitude),
                    longitude: parseFloat(longitude),
                    formattedCoordinates: MappingUtils.formatCoordinates(latitude, longitude)
                }
            });
        } else {
            res.status(404).json({
                success: false,
                message: 'Customer tidak ditemukan'
            });
        }
    } catch (error) {
        logger.error('Error updating customer coordinates:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal memperbarui koordinat customer'
        });
    }
});

// API untuk bulk update koordinat
router.post('/api/mapping/customers/bulk-coordinates', async (req, res) => {
    try {
        const { coordinates } = req.body;
        
        if (!coordinates || !Array.isArray(coordinates)) {
            return res.status(400).json({
                success: false,
                message: 'Data koordinat harus berupa array'
            });
        }
        
        const MappingUtils = require('../utils/mappingUtils');
        const results = [];
        let successCount = 0;
        let errorCount = 0;
        
        for (const coord of coordinates) {
            try {
                const { customer_id, latitude, longitude } = coord;
                
                if (!customer_id || !latitude || !longitude) {
                    results.push({
                        customer_id,
                        success: false,
                        message: 'Data tidak lengkap'
                    });
                    errorCount++;
                    continue;
                }
                
                // Validasi koordinat
                if (!MappingUtils.isValidCoordinate(latitude, longitude)) {
                    results.push({
                        customer_id,
                        success: false,
                        message: 'Koordinat tidak valid'
                    });
                    errorCount++;
                    continue;
                }
                
                // Update koordinat
                const result = await billingManager.updateCustomerCoordinates(parseInt(customer_id), {
                    latitude: parseFloat(latitude),
                    longitude: parseFloat(longitude)
                });
                
                if (result) {
                    results.push({
                        customer_id,
                        success: true,
                        message: 'Koordinat berhasil diperbarui',
                        data: {
                            latitude: parseFloat(latitude),
                            longitude: parseFloat(longitude),
                            formattedCoordinates: MappingUtils.formatCoordinates(latitude, longitude)
                        }
                    });
                    successCount++;
                } else {
                    results.push({
                        customer_id,
                        success: false,
                        message: 'Customer tidak ditemukan'
                    });
                    errorCount++;
                }
            } catch (error) {
                results.push({
                    customer_id: coord.customer_id,
                    success: false,
                    message: error.message
                });
                errorCount++;
            }
        }
        
        res.json({
            success: true,
            message: `Bulk update selesai. ${successCount} berhasil, ${errorCount} gagal`,
            data: {
                total: coordinates.length,
                success: successCount,
                error: errorCount,
                results
            }
        });
    } catch (error) {
        logger.error('Error bulk updating coordinates:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal melakukan bulk update koordinat'
        });
    }
});

// API untuk export mapping data
router.get('/api/mapping/export', async (req, res) => {
    try {
        const { format = 'json' } = req.query;
        
        // Ambil data mapping
        const customers = await billingManager.getCustomers();
        const customersWithCoords = customers.filter(c => c.latitude && c.longitude);
        
        if (format === 'csv') {
            // Export sebagai CSV
            const csvData = customersWithCoords.map(c => ({
                id: c.id,
                name: c.name,
                phone: c.phone,
                username: c.username,
                latitude: c.latitude,
                longitude: c.longitude,
                package_name: c.package_name || 'N/A',
                status: c.status,
                address: c.address || 'N/A'
            }));
            
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="mapping_data.csv"');
            
            // CSV header
            const headers = Object.keys(csvData[0]).join(',');
            const rows = csvData.map(row => Object.values(row).map(val => `"${val}"`).join(','));
            
            res.send([headers, ...rows].join('\n'));
        } else {
            // Export sebagai JSON
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename="mapping_data.json"');
            
            res.json({
                exportDate: new Date().toISOString(),
                totalCustomers: customersWithCoords.length,
                data: customersWithCoords
            });
        }
    } catch (error) {
        logger.error('Error exporting mapping data:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal export data mapping'
        });
    }
});

// Calculate price with tax for package
router.get('/api/packages/:id/price-with-tax', async (req, res) => {
    try {
        const { id } = req.params;
        const package = await billingManager.getPackageById(parseInt(id));
        
        if (!package) {
            return res.status(404).json({
                success: false,
                message: 'Package not found'
            });
        }
        
        const basePrice = package.price;
        const taxRate = (package.tax_rate === 0 || (typeof package.tax_rate === 'number' && package.tax_rate > -1))
            ? Number(package.tax_rate)
            : 11.00;
        const priceWithTax = billingManager.calculatePriceWithTax(basePrice, taxRate);
        
        res.json({
            success: true,
            package: {
                id: package.id,
                name: package.name,
                base_price: basePrice,
                tax_rate: taxRate,
                price_with_tax: priceWithTax
            }
        });
    } catch (error) {
        logger.error('Error calculating price with tax:', error);
        res.status(500).json({
            success: false,
            message: 'Error calculating price with tax',
            error: error.message
        });
    }
});

// GET: View individual payment
router.get('/payments/:id', getAppSettings, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Get payment data (placeholder - implement getPayment method if needed)
        const payment = {
            id: id,
            customer_name: 'John Doe',
            amount: 150000,
            method: 'Transfer Bank',
            status: 'Pending',
            date: new Date().toISOString(),
            reference: 'PAY' + id.toString().padStart(6, '0'),
            description: 'Pembayaran tagihan bulanan'
        };
        
        res.render('admin/billing/mobile-payment-detail', {
            title: 'Detail Pembayaran - Mobile',
            appSettings: req.appSettings,
            payment: payment
        });
    } catch (error) {
        logger.error('Error loading payment detail:', error);
        res.status(500).render('error', { 
            message: 'Error loading payment detail',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// GET: Billing Settings
router.get('/settings', getAppSettings, async (req, res) => {
    try {
        const settings = getSettingsWithCache();
        
        res.render('admin/billing/settings', {
            title: 'Pengaturan Billing - Mobile',
            appSettings: req.appSettings,
            settings: settings
        });
    } catch (error) {
        logger.error('Error loading billing settings:', error);
        res.status(500).render('error', { 
            message: 'Error loading billing settings',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// API: Get list of unpaid invoices (tagihan)
router.get('/api/list-tagihan', adminAuth, async (req, res) => {
    try {
        const unpaidInvoices = await billingManager.getUnpaidInvoices();

        // Group by customer for better display
        const customerGroups = {};
        unpaidInvoices.forEach(invoice => {
            if (!customerGroups[invoice.customer_id]) {
                customerGroups[invoice.customer_id] = {
                    customer_name: invoice.customer_name,
                    customer_phone: invoice.customer_phone,
                    total_amount: 0,
                    invoices: []
                };
            }
            customerGroups[invoice.customer_id].total_amount += parseFloat(invoice.amount);
            customerGroups[invoice.customer_id].invoices.push(invoice);
        });

        res.json({
            success: true,
            data: {
                total_customers: Object.keys(customerGroups).length,
                total_invoices: unpaidInvoices.length,
                customers: customerGroups
            }
        });

    } catch (error) {
        console.error('Error getting unpaid invoices:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting unpaid invoices: ' + error.message
        });
    }
});

// API: Get list of paid invoices (bayar)
router.get('/api/list-bayar', adminAuth, async (req, res) => {
    try {
        const paidInvoices = await billingManager.getPaidInvoices();

        // Group by customer for better display
        const customerGroups = {};
        paidInvoices.forEach(invoice => {
            if (!customerGroups[invoice.customer_id]) {
                customerGroups[invoice.customer_id] = {
                    customer_name: invoice.customer_name,
                    customer_phone: invoice.customer_phone,
                    total_amount: 0,
                    invoices: []
                };
            }
            customerGroups[invoice.customer_id].total_amount += parseFloat(invoice.amount);
            customerGroups[invoice.customer_id].invoices.push(invoice);
        });

        res.json({
            success: true,
            data: {
                total_customers: Object.keys(customerGroups).length,
                total_invoices: paidInvoices.length,
                customers: customerGroups
            }
        });

    } catch (error) {
        console.error('Error getting paid invoices:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting paid invoices: ' + error.message
        });
    }
});

// GET: Billing Reports
router.get('/reports', getAppSettings, async (req, res) => {
    try {
        const settings = getSettingsWithCache();
        
        // Get basic stats for reports
        let totalCustomers = 0;
        let totalInvoices = 0;
        let totalRevenue = 0;
        let pendingPayments = 0;
        let detailedStats = {};
        
        try {
            totalCustomers = await billingManager.getTotalCustomers();
            totalInvoices = await billingManager.getTotalInvoices();
            totalRevenue = await billingManager.getTotalRevenue();
            pendingPayments = await billingManager.getPendingPayments();
        } catch (err) {
            logger.error('Error loading basic stats:', err);
        }
        
        // Get detailed stats (with error handling)
        try {
            detailedStats = await billingManager.getReportsStats();
        } catch (err) {
            logger.error('Error loading detailed stats:', err);
            // Set default values if getReportsStats fails
            detailedStats = {
                activeCustomers: 0,
                inactiveCustomers: 0,
                newCustomersThisMonth: 0,
                invoicesThisMonth: 0,
                paidInvoices: 0,
                unpaidInvoices: 0,
                successfulPayments: 0,
                failedPayments: 0,
                retentionRate: 0,
                paymentRate: 0
            };
        }
        
        res.render('admin/billing/reports', {
            title: 'Laporan Billing - Mobile',
            appSettings: req.appSettings,
            stats: {
                totalCustomers,
                totalInvoices,
                totalRevenue,
                pendingPayments,
                ...detailedStats
            }
        });
    } catch (error) {
        logger.error('Error loading billing reports:', error);
        res.status(500).render('error', { 
            message: 'Error loading billing reports',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Terjadi kesalahan saat memuat laporan. Silakan coba lagi.'
        });
    }
});

// API: Get detailed reports statistics
router.get('/api/reports/stats', adminAuth, async (req, res) => {
    try {
        const stats = await billingManager.getReportsStats();
        res.json({ success: true, data: stats });
    } catch (error) {
        logger.error('Error getting reports stats:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// API: Get revenue data for chart (last 30 days)
router.get('/api/reports/revenue-chart', adminAuth, async (req, res) => {
    try {
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Get last 30 days revenue data
        const revenueData = [];
        const today = new Date();
        
        for (let i = 29; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            
            const revenue = await new Promise((resolve, reject) => {
                db.get(`
                    SELECT COALESCE(SUM(amount), 0) AS total
                    FROM payments
                    WHERE date(payment_date) = date(?)
                `, [dateStr], (err, row) => {
                    if (err) reject(err);
                    else resolve(row?.total || 0);
                });
            });
            
            revenueData.push({
                date: dateStr,
                dateLabel: date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }),
                revenue: revenue
            });
        }
        
        db.close();
        
        res.json({ 
            success: true, 
            data: revenueData 
        });
    } catch (error) {
        logger.error('Error getting revenue chart data:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// POST: Export Reports to Excel
router.post('/api/reports/export', adminAuth, async (req, res) => {
    try {
        const { reportType } = req.body;
        
        // Get stats
        const stats = await billingManager.getReportsStats();
        
        // Get revenue summary directly from database
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        function getDateStr(d) { return new Date(d).toISOString().split('T')[0]; }
        const todayStr = getDateStr(new Date());
        const weekAgoStr = getDateStr(new Date(Date.now() - 6 * 24 * 3600 * 1000));
        
        const [todayRevenue, weekRevenue, monthRevenue] = await Promise.all([
            new Promise((resolve, reject) => {
                db.get(`
                    SELECT COALESCE(SUM(amount),0) AS total
                    FROM payments
                    WHERE date(payment_date) = date(?)
                `, [todayStr], (err, row) => err ? reject(err) : resolve(row?.total || 0));
            }),
            new Promise((resolve, reject) => {
                db.get(`
                    SELECT COALESCE(SUM(amount),0) AS total
                    FROM payments
                    WHERE date(payment_date) BETWEEN date(?) AND date(?)
                `, [weekAgoStr, todayStr], (err, row) => err ? reject(err) : resolve(row?.total || 0));
            }),
            new Promise((resolve, reject) => {
                db.get(`
                    SELECT COALESCE(SUM(amount),0) AS total
                    FROM payments
                    WHERE strftime('%Y-%m', payment_date) = strftime('%Y-%m', 'now', 'localtime')
                `, [], (err, row) => err ? reject(err) : resolve(row?.total || 0));
            }),
        ]);
        
        db.close();
        
        const revenueSummary = {
            todayRevenue,
            weekRevenue,
            monthRevenue
        };
        
        // Merge stats with basic stats
        const totalCustomers = await billingManager.getTotalCustomers();
        const totalInvoices = await billingManager.getTotalInvoices();
        const totalRevenue = await billingManager.getTotalRevenue();
        const pendingPayments = await billingManager.getPendingPayments();
        
        const allStats = {
            ...stats,
            totalCustomers,
            totalInvoices,
            totalRevenue,
            pendingPayments
        };
        
        // Create workbook
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Laporan Billing');
        
        // Set column widths
        worksheet.columns = [
            { header: 'Keterangan', key: 'keterangan', width: 50 },
            { header: 'Nilai', key: 'nilai', width: 25 }
        ];
        
        // Add title
        worksheet.insertRow(1, ['LAPORAN BILLING', '']);
        worksheet.mergeCells('A1:B1');
        worksheet.getRow(1).font = { bold: true, size: 16 };
        worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
        worksheet.getRow(1).height = 30;
        
        // Add date
        const now = new Date();
        worksheet.insertRow(2, [`Tanggal: ${now.toLocaleDateString('id-ID')}`, '']);
        worksheet.mergeCells('A2:B2');
        worksheet.getRow(2).alignment = { vertical: 'middle', horizontal: 'center' };
        worksheet.getRow(2).height = 20;
        
        // Add empty row
        worksheet.insertRow(3, ['', '']);
        
        let currentRow = 4;
        
        // STATISTIK UMUM
        worksheet.insertRow(currentRow, ['STATISTIK UMUM', '']);
        worksheet.getRow(currentRow).font = { bold: true, size: 12 };
        worksheet.getRow(currentRow).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4472C4' }
        };
        worksheet.getRow(currentRow).font = { ...worksheet.getRow(currentRow).font, color: { argb: 'FFFFFFFF' } };
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Total Pelanggan', allStats.totalCustomers || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Total Tagihan', allStats.totalInvoices || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Total Pendapatan', allStats.totalRevenue || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Pembayaran Pending', allStats.pendingPayments || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        // Empty row
        worksheet.insertRow(currentRow, ['', '']);
        currentRow++;
        
        // LAPORAN PENDAPATAN
        worksheet.insertRow(currentRow, ['LAPORAN PENDAPATAN', '']);
        worksheet.getRow(currentRow).font = { bold: true, size: 12 };
        worksheet.getRow(currentRow).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFD4EDDA' }
        };
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Pendapatan Hari Ini', revenueSummary.todayRevenue || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Pendapatan Minggu Ini', revenueSummary.weekRevenue || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Pendapatan Bulan Ini', revenueSummary.monthRevenue || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        // Empty row
        worksheet.insertRow(currentRow, ['', '']);
        currentRow++;
        
        // LAPORAN PELANGGAN
        worksheet.insertRow(currentRow, ['LAPORAN PELANGGAN', '']);
        worksheet.getRow(currentRow).font = { bold: true, size: 12 };
        worksheet.getRow(currentRow).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFC3E6CB' }
        };
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Pelanggan Aktif', allStats.activeCustomers || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Pelanggan Baru (Bulan Ini)', allStats.newCustomersThisMonth || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Pelanggan Non-Aktif', allStats.inactiveCustomers || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Tingkat Retensi', `${allStats.retentionRate || 0}%`]);
        currentRow++;
        
        // Empty row
        worksheet.insertRow(currentRow, ['', '']);
        currentRow++;
        
        // LAPORAN TAGIHAN
        worksheet.insertRow(currentRow, ['LAPORAN TAGIHAN', '']);
        worksheet.getRow(currentRow).font = { bold: true, size: 12 };
        worksheet.getRow(currentRow).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFE5B4' }
        };
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Tagihan Dibuat (Bulan Ini)', allStats.invoicesThisMonth || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Tagihan Lunas', allStats.paidInvoices || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Tagihan Belum Lunas', allStats.unpaidInvoices || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Tingkat Pembayaran', `${allStats.paymentRate || 0}%`]);
        currentRow++;
        
        // Empty row
        worksheet.insertRow(currentRow, ['', '']);
        currentRow++;
        
        // LAPORAN PEMBAYARAN
        worksheet.insertRow(currentRow, ['LAPORAN PEMBAYARAN', '']);
        worksheet.getRow(currentRow).font = { bold: true, size: 12 };
        worksheet.getRow(currentRow).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE5C3C6' }
        };
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Pembayaran Berhasil', allStats.successfulPayments || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Pembayaran Pending', allStats.pendingPayments || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        worksheet.insertRow(currentRow, ['Pembayaran Gagal', allStats.failedPayments || 0]);
        worksheet.getRow(currentRow).getCell(2).numFmt = '#,##0';
        currentRow++;
        
        // Set alignment for all rows
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber > 3) {
                row.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
                row.getCell(2).alignment = { vertical: 'middle', horizontal: 'right' };
            }
        });
        
        // Set response headers
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=laporan-billing-${now.toISOString().split('T')[0]}.xlsx`);
        
        // Write to response
        await workbook.xlsx.write(res);
        res.end();
        
    } catch (error) {
        logger.error('Error exporting reports to Excel:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Calculate price with tax for package
router.get('/api/packages/:id/price-with-tax', async (req, res) => {
    try {
        const { id } = req.params;
        const package = await billingManager.getPackageById(parseInt(id));
        
        if (!package) {
            return res.status(404).json({
                success: false,
                message: 'Package not found'
            });
        }
        
        const basePrice = package.price;
        const taxRate = (package.tax_rate === 0 || (typeof package.tax_rate === 'number' && package.tax_rate > -1))
            ? Number(package.tax_rate)
            : 11.00;
        const priceWithTax = billingManager.calculatePriceWithTax(basePrice, taxRate);
        
        res.json({
            success: true,
            package: {
                id: package.id,
                name: package.name,
                base_price: basePrice,
                tax_rate: taxRate,
                price_with_tax: priceWithTax
            }
        });
    } catch (error) {
        logger.error('Error calculating price with tax:', error);
        res.status(500).json({
            success: false,
            message: 'Error calculating price with tax',
            error: error.message
        });
    }
});

// ==========================================
// Customer/Member Password Management
// ==========================================

// API: Set customer password (admin only)
router.post('/api/customers/:id/set-password', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;
        
        if (!password || password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password harus minimal 6 karakter'
            });
        }
        
        const bcrypt = require('bcrypt');
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Check if customer exists
        const customer = await new Promise((resolve) => {
            db.get('SELECT id, name, username FROM customers WHERE id = ?', [id], (err, row) => resolve(row));
        });
        
        if (!customer) {
            db.close();
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }
        
        // Update password
        await new Promise((resolve, reject) => {
            db.run('UPDATE customers SET password = ? WHERE id = ?', [hashedPassword, id], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        db.close();
        
        logger.info(`[AUTH] Password set for customer: ${customer.username} (ID: ${id})`);
        
        res.json({
            success: true,
            message: `Password berhasil diatur untuk pelanggan ${customer.name}`
        });
        
    } catch (error) {
        logger.error('Error setting customer password:', error);
        res.status(500).json({ success: false, message: 'Gagal mengatur password: ' + error.message });
    }
});

// API: Set member password (admin only)
router.post('/api/members/:id/set-password', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;
        
        if (!password || password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password harus minimal 6 karakter'
            });
        }
        
        const bcrypt = require('bcrypt');
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Check if member exists
        const member = await new Promise((resolve) => {
            db.get('SELECT id, name, username FROM members WHERE id = ?', [id], (err, row) => resolve(row));
        });
        
        if (!member) {
            db.close();
            return res.status(404).json({ success: false, message: 'Member tidak ditemukan' });
        }
        
        // Update password
        await new Promise((resolve, reject) => {
            db.run('UPDATE members SET password = ? WHERE id = ?', [hashedPassword, id], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        db.close();
        
        logger.info(`[AUTH] Password set for member: ${member.username} (ID: ${id})`);
        
        res.json({
            success: true,
            message: `Password berhasil diatur untuk member ${member.name}`
        });
        
    } catch (error) {
        logger.error('Error setting member password:', error);
        res.status(500).json({ success: false, message: 'Gagal mengatur password: ' + error.message });
    }
});

// API: Assign collector to customer
router.post('/api/customers/:id/assign-collector', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { collector_id } = req.body;
        
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        await new Promise((resolve, reject) => {
            // Delete existing assignment first
            db.run('DELETE FROM collector_assignments WHERE customer_id = ?', [id], (err) => {
                if (err) return reject(err);
                
                // If collector_id is provided, insert new assignment
                if (collector_id) {
                    db.run('INSERT INTO collector_assignments (collector_id, customer_id) VALUES (?, ?)', [collector_id, id], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                } else {
                    resolve();
                }
            });
        });
        
        db.close();
        logger.info(`[MAPPING] Collector updated for customer ID: ${id}`);
        res.json({ success: true, message: 'Mapping kolektor berhasil diperbarui' });
        
    } catch (error) {
        logger.error('Error assigning collector:', error);
        res.status(500).json({ success: false, message: 'Gagal memperbarui mapping kolektor: ' + error.message });
    }
});

// API: Reset customer password (admin only)
router.delete('/api/customers/:id/password', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        await new Promise((resolve, reject) => {
            db.run('UPDATE customers SET password = NULL WHERE id = ?', [id], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        db.close();
        
        logger.info(`[AUTH] Password reset for customer ID: ${id}`);
        
        res.json({ success: true, message: 'Password pelanggan berhasil direset' });
        
    } catch (error) {
        logger.error('Error resetting customer password:', error);
        res.status(500).json({ success: false, message: 'Gagal mereset password' });
    }
});

module.exports = router;