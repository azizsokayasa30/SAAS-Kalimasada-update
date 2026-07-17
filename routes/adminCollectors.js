/**
 * Admin Collectors Management Routes
 * Routes untuk admin mengelola tukang tagih
 */

const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const billingManager = require('../config/billing');
const { tenantSqlFromRequest, tenantIdForInsert } = require('../config/platform/tenantSqlHelpers');
const { attachTenantAppSettings } = require('../config/platform/tenantAppSettings');
const { adminAuth } = require('./adminAuth');

router.use(attachTenantAppSettings);

function tFrom(req) {
    return tenantSqlFromRequest(req);
}

// List collectors
router.get('/', adminAuth, async (req, res) => {
    try {
        await billingManager._ensureCollectorAreasAreaColumn();
        const t = tFrom(req);
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        const collectors = await new Promise((resolve, reject) => {
            db.all(`
                SELECT c.*, 
                       COUNT(cp.id) as total_payments,
                       COALESCE(SUM(cp.commission_amount), 0) as total_commission,
                       (SELECT GROUP_CONCAT(COALESCE(area, area_name), ', ') FROM collector_areas ca WHERE collector_id = c.id${t.and('ca')}) as assigned_areas
                FROM collectors c
                LEFT JOIN collector_payments cp ON c.id = cp.collector_id 
                    AND cp.status = 'completed'
                WHERE 1=1${t.and('c')}
                GROUP BY c.id
                ORDER BY c.name
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        
        const appSettings = req.tenantSettings || {};
        
        db.close();
        
        res.render('admin/collectors', {
            title: 'Kelola Tukang Tagih',
            appSettings: appSettings,
            collectors: collectors
        });
        
    } catch (error) {
        console.error('Error loading collectors:', error);
        res.status(500).render('error', { 
            message: 'Error loading collectors',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// Add collector form
router.get('/add', adminAuth, async (req, res) => {
    try {
        const appSettings = req.tenantSettings || {};
        
        res.render('admin/collector-form', {
            title: 'Tambah Tukang Tagih',
            appSettings: appSettings,
            collector: null,
            action: 'add'
        });
        
    } catch (error) {
        console.error('Error loading add collector form:', error);
        res.status(500).render('error', { 
            message: 'Error loading form',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// Edit collector form
router.get('/:id/edit', adminAuth, async (req, res) => {
    try {
        const t = tFrom(req);
        const { id } = req.params;

        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        const collector = await new Promise((resolve, reject) => {
            db.get(`SELECT * FROM collectors WHERE id = ?${t.and('')}`, [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        if (!collector) {
            db.close();
            return res.status(404).render('error', { 
                message: 'Tukang tagih tidak ditemukan'
            });
        }
        
        const appSettings = req.tenantSettings || {};
        
        db.close();
        
        res.render('admin/collector-form', {
            title: 'Edit Tukang Tagih',
            appSettings: appSettings,
            collector: collector,
            action: 'edit'
        });
        
    } catch (error) {
        console.error('Error loading edit collector form:', error);
        res.status(500).render('error', { 
            message: 'Error loading form',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

// Create collector
router.post('/', adminAuth, async (req, res) => {
    try {
        const { name, phone, email, address, commission_rate, status, password } = req.body;
        
        if (!name || !phone) {
            return res.status(400).json({
                success: false,
                message: 'Nama dan nomor telepon harus diisi'
            });
        }
        
        if (!password || password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password minimal 6 karakter'
            });
        }
        
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Check if phone already exists
        const existingCollector = await new Promise((resolve, reject) => {
            db.get('SELECT id FROM collectors WHERE phone = ?', [phone], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        if (existingCollector) {
            db.close();
            return res.status(400).json({
                success: false,
                message: 'Nomor telepon sudah digunakan'
            });
        }
        
        // Hash password
        const hashedPassword = bcrypt.hashSync(password, 10);
        const tenantId = tenantIdForInsert();
        
        // Insert new collector
        const collectorId = await new Promise((resolve, reject) => {
            db.run(`
                INSERT INTO collectors (name, phone, email, address, commission_rate, status, password, tenant_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [name, phone, email, address, commission_rate !== undefined && commission_rate !== null && commission_rate !== '' ? commission_rate : 5, status || 'active', hashedPassword, tenantId], function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            });
        });
        
        db.close();
        
        res.json({
            success: true,
            message: 'Tukang tagih berhasil ditambahkan',
            collector_id: collectorId
        });
        
    } catch (error) {
        console.error('Error creating collector:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating collector: ' + error.message
        });
    }
});

// Update collector
router.put('/:id', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const { name, phone, email, address, commission_rate, status, password } = req.body;
        
        if (!name || !phone) {
            return res.status(400).json({
                success: false,
                message: 'Nama dan nomor telepon harus diisi'
            });
        }
        
        if (password && password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password minimal 6 karakter'
            });
        }
        
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Check if phone already exists (excluding current collector)
        const existingCollector = await new Promise((resolve, reject) => {
            db.get('SELECT id FROM collectors WHERE phone = ? AND id != ?', [phone, id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        if (existingCollector) {
            db.close();
            return res.status(400).json({
                success: false,
                message: 'Nomor telepon sudah digunakan'
            });
        }
        
        // Prepare update data
        let updateQuery, updateParams;
        
        if (password) {
            // Update with password
            const hashedPassword = bcrypt.hashSync(password, 10);
            updateQuery = `
                UPDATE collectors 
                SET name = ?, phone = ?, email = ?, address = ?, commission_rate = ?, status = ?, password = ?, updated_at = datetime('now','localtime')
                WHERE id = ?
            `;
            updateParams = [name, phone, email, address, commission_rate, status, hashedPassword, id];
        } else {
            // Update without password
            updateQuery = `
                UPDATE collectors 
                SET name = ?, phone = ?, email = ?, address = ?, commission_rate = ?, status = ?, updated_at = datetime('now','localtime')
                WHERE id = ?
            `;
            updateParams = [name, phone, email, address, commission_rate, status, id];
        }
        
        // Update collector
        await new Promise((resolve, reject) => {
            db.run(updateQuery, updateParams, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        db.close();
        
        res.json({
            success: true,
            message: 'Tukang tagih berhasil diperbarui'
        });
        
    } catch (error) {
        console.error('Error updating collector:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating collector: ' + error.message
        });
    }
});

// Delete collector
router.delete('/:id', adminAuth, async (req, res) => {
    let db;
    try {
        const { id } = req.params;
        const dbPath = path.join(__dirname, '../data/billing.db');
        db = new sqlite3.Database(dbPath);

        const runGet = (sql, params = []) => new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || {})));
        });
        const runExec = (sql, params = []) => new Promise((resolve, reject) => {
            db.run(sql, params, function(err) { (err ? reject(err) : resolve(this.changes || 0)); });
        });

        const removedPayments = await runExec('DELETE FROM collector_payments WHERE collector_id = ?', [id]);
        let removedAssignments = 0;
        try {
            removedAssignments = await runExec('DELETE FROM collector_assignments WHERE collector_id = ?', [id]);
        } catch (e) {
            if (!String(e.message || '').includes('no such table')) throw e;
        }
        const removedAreas = await runExec('DELETE FROM collector_areas WHERE collector_id = ?', [id]);
        const removedCollector = await runExec('DELETE FROM collectors WHERE id = ?', [id]);

        db.close();
        db = null;

        if (removedCollector === 0) {
            return res.status(404).json({ success: false, message: 'Tukang tagih tidak ditemukan' });
        }

        return res.json({
            success: true,
            message: 'Tukang tagih berhasil dihapus'
        });
    } catch (error) {
        if (db) {
            try { db.close(); } catch (_) {}
        }
        return res.status(500).json({ success: false, message: 'Error deleting collector: ' + error.message });
    }
});

// Update collector areas mapping
router.post('/:id/areas', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const { areas } = req.body; // Array of area names
        const billingManager = require('../config/billing');
        
        await billingManager.saveCollectorAreas(id, areas);
        
        res.json({
            success: true,
            message: 'Mapping area berhasil diperbarui'
        });
    } catch (error) {
        console.error('Error updating collector areas:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating mapping area: ' + error.message
        });
    }
});

// Get unique areas from customers and members
router.get('/unique-areas', adminAuth, async (req, res) => {
    try {
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        const areas = await new Promise((resolve, reject) => {
            db.all(`
               SELECT DISTINCT area FROM (
                   SELECT area FROM customers WHERE area IS NOT NULL AND area != ""
                   UNION
                   SELECT area FROM members WHERE area IS NOT NULL AND area != ""
               ) ORDER BY area
            `, (err, rows) => {
                if (err) reject(err);
                else resolve((rows || []).map(r => r.area));
            });
        });
        
        db.close();
        res.json({ success: true, areas });
    } catch (error) {
        console.error('Error getting unique areas:', error);
        res.status(500).json({ success: false, message: error.message });
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
