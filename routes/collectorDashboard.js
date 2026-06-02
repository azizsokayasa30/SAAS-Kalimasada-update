/**
 * Collector Dashboard Routes
 * Routes untuk dashboard dan pembayaran tukang tagih
 */

const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const { getSetting } = require('../config/settingsManager');
const { collectorAuth } = require('./collectorAuth');
const billingManager = require('../config/billing');
const { submitCollectorPayment, collectorPaymentMulter } = require('../utils/collectorPaymentSubmit');

function collectorCustomerIsIsolir(c) {
    return String(c.status || '')
        .toLowerCase()
        .trim() === 'suspended';
}

function matchesAdminBelumLunasFromPaymentStatus(c) {
    const ps = c.payment_status || '';
    return ps === 'unpaid' || ps === 'overdue' || ps === 'no_invoice';
}

function matchesAdminLunasFromPaymentStatus(c) {
    return (c.payment_status || '') === 'paid';
}

function joinDateThisCalendarMonth(c) {
    if (!c.join_date) return false;
    const jd = String(c.join_date).slice(0, 10);
    const now = new Date();
    const y = now.getFullYear();
    const mo = now.getMonth();
    const pad = (n) => String(n).padStart(2, '0');
    const startStr = `${y}-${pad(mo + 1)}-01`;
    const lastD = new Date(y, mo + 1, 0).getDate();
    const endStr = `${y}-${pad(mo + 1)}-${pad(lastD)}`;
    return jd >= startStr && jd <= endStr;
}

// Dashboard
router.get('/dashboard', collectorAuth, async (req, res) => {
    try {
        const collectorId = req.collector.id;
        
        // Get collector info menggunakan BillingManager
        const collector = await billingManager.getCollectorById(collectorId);
        
        if (!collector) {
            return res.status(404).render('error', { 
                message: 'Collector not found',
                error: {}
            });
        }
        
        // Validasi dan format data collector
        const validCollector = {
            ...collector,
            commission_rate: Math.max(0, Math.min(100, parseFloat(collector.commission_rate !== null && collector.commission_rate !== undefined ? collector.commission_rate : 5))), // Pastikan 0-100%
            name: collector.name || 'Unknown Collector',
            phone: collector.phone || '',
            status: collector.status || 'active'
        };
        // Tangkap filter bulan dan tahun dari query
        const month = req.query.month || '';
        const year = req.query.year || '';

        // Dapatkan semua 6 statistik dalam satu langkah (sudah mendukung filter waktu)
        const dashboardStats = await billingManager.getCollectorDashboardStats(collectorId, month, year);
        
        // Panggil payment terbaru
        const recentPayments = await billingManager.getCollectorRecentPayments(collectorId, 5);
        
        const appSettings = await getAppSettings();

        const allMappedCustomers = await billingManager.getCollectorCustomers(collectorId);
        const list = allMappedCustomers || [];
        const totalPelangganAktif = list.length;
        const belumBayarCount = list.filter(c => matchesAdminBelumLunasFromPaymentStatus(c)).length;
        const lunasCount = list.filter(c => matchesAdminLunasFromPaymentStatus(c)).length;
        const isolirCount = list.filter(c => collectorCustomerIsIsolir(c)).length;
        const priorityCustomers = list
            .filter(c => matchesAdminBelumLunasFromPaymentStatus(c) && !collectorCustomerIsIsolir(c))
            .slice(0, 5)
            .map(c => ({
                id: c.id,
                name: c.name,
                address: c.address || '-',
                amount: Math.round(parseFloat(c.package_price || 0)),
                payment_status: c.payment_status
            }));

        const targetMonth = Math.round(parseFloat(dashboardStats.tagihan?.total || 0));
        // Terkumpul = nilai invoice cohort bulan yang sudah paid (bukan hanya pembayaran lewat akun kolektor).
        const terkumpul = Math.round(
            parseFloat((dashboardStats.tagihanLunas?.total ?? dashboardStats.lunas?.total) || 0)
        );
        const progressPct = targetMonth > 0 ? Math.min(100, Math.round((terkumpul / targetMonth) * 100)) : 0;
        const sisaTarget = Math.max(0, targetMonth - terkumpul);

        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        const areaRows = await new Promise((resolve, reject) => {
            db.all('SELECT DISTINCT area FROM collector_areas WHERE collector_id = ? AND area IS NOT NULL AND area != "" LIMIT 8', [collectorId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        db.close();
        const areaLabel = areaRows.map(r => r.area).join(', ') || (collector.address || 'Wilayah penugasan');

        const now = new Date();
        const displayDate = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        
        res.render('collector/dashboard', {
            title: 'Dashboard Tukang Tagih',
            appSettings: appSettings,
            collector: collector,
            statistics: dashboardStats,
            recentPayments: recentPayments,
            filters: { month, year },
            fieldUi: {
                totalPelangganAktif,
                belumBayarCount,
                lunasCount,
                isolirCount,
                priorityCustomers,
                targetMonth,
                terkumpul,
                progressPct,
                sisaTarget,
                areaLabel,
                displayDate
            }
        });
        
    } catch (error) {
        console.error('❌ Error loading collector dashboard:', error);
        
        // Detailed error for server logs
        if (error.stack) console.error(error.stack);

        res.status(500).render('error', { 
            message: 'Terjadi kesalahan saat memuat dashboard. Silakan coba lagi nanti.',
            error: process.env.NODE_ENV === 'development' ? error : { 
                status: 500, 
                stack: 'Internal Server Error (Detail logged to server console)' 
            }
        });
    }
});

// Payment form
router.get('/payment', collectorAuth, async (req, res) => {
    try {
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        const appSettings = await getAppSettings();
        const collector = req.collector;
        
        // Get active assigned customers using collector_areas
        const customers = await new Promise((resolve, reject) => {
            const sql = `
                SELECT c.* 
                FROM customers c 
                INNER JOIN collector_areas ca ON TRIM(IFNULL(c.area, '')) != '' AND TRIM(c.area) = TRIM(ca.area)
                WHERE ca.collector_id = ? AND LOWER(TRIM(c.status)) IN ('active', 'register')
                ORDER BY c.name
            `;
            db.all(sql, [collector.id], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        
        db.close();
        
        res.render('collector/payment', {
            title: 'Input Pembayaran',
            appSettings: appSettings,
            collector: collector,
            customers: customers
        });
        
    } catch (error) {
        console.error('Error loading payment form:', error);
        res.status(500).render('error', { 
            message: 'Error loading payment form',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// Get customer invoices
router.get('/api/customer-invoices/:customerId', collectorAuth, async (req, res) => {
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

// Payments list
router.get('/payments', collectorAuth, async (req, res) => {
    try {
        const collectorId = req.collector.id;
        
        // Get collector info menggunakan BillingManager
        const collector = await billingManager.getCollectorById(collectorId);
        
        if (!collector) {
            return res.status(404).render('error', { 
                message: 'Collector not found',
                error: {}
            });
        }
        
        // Get all payments menggunakan BillingManager
        const payments = await billingManager.getCollectorAllPayments(collectorId);
        const dashboardStats = await billingManager.getCollectorDashboardStats(collectorId);
        const s = dashboardStats.setoran || {};
        const sudahSetor = Math.round(parseFloat(s.sudah_setor || 0));
        const belumSetor = Math.round(parseFloat(s.belum_setor || 0));
        const totalHarusSetor = sudahSetor + belumSetor;
        const setoranProgressPct = totalHarusSetor > 0 ? Math.min(100, Math.round((sudahSetor / totalHarusSetor) * 100)) : 0;
        
        const appSettings = await getAppSettings();
        
        res.render('collector/payments', {
            title: 'Riwayat Pembayaran',
            appSettings: appSettings,
            collector: collector,
            payments: payments,
            setoranUi: { sudahSetor, belumSetor, totalHarusSetor, setoranProgressPct }
        });
        
    } catch (error) {
        console.error('Error loading payments:', error);
        res.status(500).render('error', { 
            message: 'Error loading payments',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// Customers list
router.get('/customers', collectorAuth, async (req, res) => {
    try {
        // Gunakan getCollectorCustomers agar hanya menampilkan customer yang di-mapping
        const collector = req.collector;
        const allMappedCustomers = await billingManager.getCollectorCustomers(collector.id);
        const statusFilter = (req.query.status || '').toString().toLowerCase();
        const validFilters = new Set(['paid', 'unpaid', 'overdue', 'no_invoice', 'isolir', 'baru']);
        const q = (req.query.q || '').toString().trim().toLowerCase();

        let customers = allMappedCustomers || [];
        if (statusFilter === 'isolir') {
            customers = customers.filter(c => collectorCustomerIsIsolir(c));
        } else if (statusFilter === 'baru') {
            customers = customers.filter(c => (c.payment_status || '') === 'no_invoice');
        } else if (statusFilter === 'unpaid') {
            customers = customers.filter(c => matchesAdminBelumLunasFromPaymentStatus(c));
        } else if (statusFilter === 'paid') {
            customers = customers.filter(c => matchesAdminLunasFromPaymentStatus(c));
        } else if (validFilters.has(statusFilter) && statusFilter !== '') {
            customers = customers.filter(c => (c.payment_status || '') === statusFilter);
        }

        if (q) {
            customers = customers.filter(c => {
                const name = (c.name || '').toLowerCase();
                const idStr = String(c.id || '');
                const phone = (c.phone || '').toLowerCase();
                const ppp = (c.pppoe_username || '').toString().toLowerCase();
                const user = (c.username || '').toString().toLowerCase();
                return name.includes(q) || idStr.includes(q) || phone.includes(q) || ppp.includes(q) || user.includes(q);
            });
        }

        const appSettings = await getAppSettings();
        
        res.render('collector/customers', {
            title: 'Daftar Pelanggan',
            appSettings: appSettings,
            collector: collector,
            customers: customers,
            currentStatusFilter: validFilters.has(statusFilter) ? statusFilter : '',
            searchQuery: q
        });
        
    } catch (error) {
        console.error('Error loading customers:', error);
        res.status(500).render('error', { 
            message: 'Error loading customers',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// Profile page
router.get('/profile', collectorAuth, async (req, res) => {
    try {
        const collectorId = req.collector.id;
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Get collector info
        const collector = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM collectors WHERE id = ?', [collectorId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        const appSettings = await getAppSettings();
        
        db.close();

        const dashboardStats = await billingManager.getCollectorDashboardStats(collectorId);
        const tagCount = parseInt(dashboardStats.tagihan?.count || 0, 10) || 0;
        const paidDistinct = parseInt(dashboardStats.lunas?.count || 0, 10) || 0;
        const successRate = tagCount > 0 ? Math.min(100, Math.round((paidDistinct / tagCount) * 100)) : 0;
        const allPayments = await billingManager.getCollectorAllPayments(collectorId);
        const totalCollections = (allPayments || []).filter(p => p.status === 'completed').length;
        const now = new Date();
        const monthlyCommission = await billingManager.getCollectorMonthlyCommission(collectorId, now.getFullYear(), now.getMonth() + 1);
        
        res.render('collector/profile', {
            title: 'Profil Saya',
            appSettings: appSettings,
            collector: collector,
            profileStats: {
                successRate,
                totalCollections,
                monthlyCommission: Math.round(parseFloat(monthlyCommission || 0))
            }
        });
        
    } catch (error) {
        console.error('Error loading profile:', error);
        res.status(500).render('error', { 
            message: 'Error loading profile',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// Edit profile page
router.get('/profile/edit', collectorAuth, async (req, res) => {
    try {
        const collectorId = req.collector.id;
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Get collector info
        const collector = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM collectors WHERE id = ?', [collectorId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        const appSettings = await getAppSettings();
        
        db.close();
        
        res.render('collector/profile-edit', {
            title: 'Edit Profil',
            appSettings: appSettings,
            collector: collector
        });
        
    } catch (error) {
        console.error('Error loading edit profile:', error);
        res.status(500).render('error', { 
            message: 'Error loading edit profile',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// Update profile
router.post('/api/profile/update', collectorAuth, async (req, res) => {
    try {
        const collectorId = req.collector.id;
        const { name, phone, email } = req.body;
        
        if (!name || name.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Nama tidak boleh kosong'
            });
        }
        
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Update collector info
        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE collectors 
                SET name = ?, phone = ?, email = ?, updated_at = datetime('now','localtime')
                WHERE id = ?
            `, [name.trim(), phone?.trim() || null, email?.trim() || null, collectorId], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        db.close();
        
        res.json({
            success: true,
            message: 'Profil berhasil diperbarui'
        });
        
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating profile: ' + error.message
        });
    }
});

// Update password
router.post('/api/profile/update-password', collectorAuth, async (req, res) => {
    try {
        const collectorId = req.collector.id;
        const { currentPassword, newPassword } = req.body;
        
        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Password lama dan password baru harus diisi'
            });
        }
        
        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password baru minimal 6 karakter'
            });
        }
        
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Get current collector data
        const collector = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM collectors WHERE id = ?', [collectorId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        if (!collector) {
            db.close();
            return res.status(404).json({
                success: false,
                message: 'Tukang tagih tidak ditemukan'
            });
        }
        
        // Verify current password using bcrypt
        const validPassword = collector.password ? bcrypt.compareSync(currentPassword, collector.password) : false;
        
        if (!validPassword) {
            db.close();
            return res.status(400).json({
                success: false,
                message: 'Password lama tidak benar'
            });
        }
        
        // Hash new password
        const hashedNewPassword = bcrypt.hashSync(newPassword, 10);
        
        // Update password
        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE collectors 
                SET password = ?, updated_at = datetime('now','localtime')
                WHERE id = ?
            `, [hashedNewPassword, collectorId], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        db.close();
        
        res.json({
            success: true,
            message: 'Password berhasil diperbarui'
        });
        
    } catch (error) {
        console.error('Error updating password:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating password: ' + error.message
        });
    }
});

// Submit payment
router.post('/api/payment', collectorAuth, collectorPaymentMulter.single('payment_proof'), async (req, res) => {
    try {
        const collectorId = req.collector.id;
        const { customer_id, payment_amount, payment_method, notes, invoice_ids, discount_amount } = req.body;
        const paymentProof = req.file ? '/uploads/payments/' + req.file.filename : null;

        const result = await submitCollectorPayment({
            collectorId,
            customer_id,
            payment_amount,
            payment_method,
            notes,
            invoice_ids,
            discount_amount,
            paymentProofRelativePath: paymentProof
        });

        if (!result.ok) {
            return res.status(result.status || 400).json({
                success: false,
                message: result.message
            });
        }

        res.json({
            success: true,
            message: 'Payment recorded successfully',
            payment_id: result.payment_id,
            commission_amount: result.commission_amount
        });
    } catch (error) {
        console.error('Error recording payment:', error);
        res.status(500).json({
            success: false,
            message: 'Error recording payment: ' + error.message
        });
    }
});

// Helper function to get app settings
async function getAppSettings() {
    try {
        return {
            companyHeader: getSetting('company_header', 'Sistem Billing'),
            companyName: getSetting('company_name', 'Sistem Billing'),
            footerInfo: getSetting('footer_info', ''),
            logoFilename: getSetting('logo_filename', 'logo.png'),
            company_slogan: getSetting('company_slogan', ''),
            company_website: getSetting('company_website', ''),
            invoice_notes: getSetting('invoice_notes', ''),
            contact_phone: getSetting('contact_phone', ''),
            contact_email: getSetting('contact_email', ''),
            contact_address: getSetting('contact_address', ''),
            contact_whatsapp: getSetting('contact_whatsapp', '')
        };
    } catch (error) {
        console.error('Error getting app settings:', error);
        return {
            companyHeader: 'Sistem Billing',
            companyName: 'Sistem Billing'
        };
    }
}

module.exports = router;
