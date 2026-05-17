const express = require('express');
const router = express.Router();
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { adminAuth } = require('./adminAuth');
const logger = require('../config/logger');
const { getSettingsWithCache } = require('../config/settingsManager');

const dbPath = path.join(__dirname, '../data/billing.db');

// Middleware to get app settings for templates
const getAppSettings = (req, res, next) => {
    res.locals.appSettings = getSettingsWithCache();
    next();
};

function getDb() {
    return new sqlite3.Database(dbPath);
}

// Generate auto invoice number (e.g. INV-SL-2026-0001)
const generateInvoiceNumber = () => {
    return new Promise((resolve, reject) => {
        const db = getDb();
        const year = new Date().getFullYear();
        const prefix = `INV-SL-${year}-`;
        
        db.get(`SELECT invoice_number FROM goods_invoices WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1`, [`${prefix}%`], (err, row) => {
            db.close();
            if (err) return reject(err);
            
            let seq = 1;
            if (row && row.invoice_number) {
                const parts = row.invoice_number.split('-');
                if (parts.length > 0) {
                    const lastSeq = parseInt(parts[parts.length - 1], 10);
                    if (!isNaN(lastSeq)) seq = lastSeq + 1;
                }
            }
            resolve(`${prefix}${String(seq).padStart(4, '0')}`);
        });
    });
};

// --- Page Routes ---

// List Goods Invoices
router.get('/', adminAuth, getAppSettings, (req, res) => {
    const db = getDb();
    db.all(`SELECT * FROM goods_invoices ORDER BY id DESC`, [], (err, invoices) => {
        db.close();
        if (err) {
            logger.error('Error loading goods invoices:', err);
            return res.status(500).send('Database Error');
        }
        
        res.render('admin/billing/goods-invoices', {
            title: 'Invoice Penjualan',
            page: 'goods_invoices',
            path: '/admin/billing/goods-invoices',
            invoices: invoices
        });
    });
});

// Detail Goods Invoice
router.get('/:id/detail', adminAuth, getAppSettings, (req, res) => {
    const db = getDb();
    db.get(`SELECT * FROM goods_invoices WHERE id = ?`, [req.params.id], (err, invoice) => {
        if (err || !invoice) {
            db.close();
            return res.status(404).send('Invoice not found');
        }
        
        db.all(`SELECT * FROM goods_invoice_items WHERE invoice_id = ?`, [invoice.id], (err, items) => {
            db.close();
            if (err) {
                logger.error('Error loading goods invoice items:', err);
                return res.status(500).send('Database Error');
            }
            res.render('admin/billing/goods-invoice-detail', {
                title: 'Detail Invoice Penjualan',
                page: 'goods_invoices',
                path: '/admin/billing/goods-invoices',
                invoice: invoice,
                items: items
            });
        });
    });
});

// Print Goods Invoice
router.get('/:id/print', adminAuth, getAppSettings, (req, res) => {
    const db = getDb();
    db.get(`SELECT * FROM goods_invoices WHERE id = ?`, [req.params.id], (err, invoice) => {
        if (err || !invoice) {
            db.close();
            return res.status(404).send('Invoice not found');
        }
        
        db.all(`SELECT * FROM goods_invoice_items WHERE invoice_id = ?`, [invoice.id], (err, items) => {
            db.close();
            if (err) {
                logger.error('Error loading goods invoice items:', err);
                return res.status(500).send('Database Error');
            }
            res.render('admin/billing/goods-invoice-print', {
                title: 'Print Invoice Penjualan',
                invoice: invoice,
                items: items
            });
        });
    });
});

// --- API Routes ---

// Get Auto Invoice Number
router.get('/api/generate-number', adminAuth, async (req, res) => {
    try {
        const invoice_number = await generateInvoiceNumber();
        res.json({ invoice_number });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create Goods Invoice
router.post('/api/create', adminAuth, async (req, res) => {
    const { customer_name, customer_phone, customer_address, invoice_number, items, notes } = req.body;
    
    if (!customer_name || !items || !items.length) {
        return res.status(400).json({ error: 'Customer name and items are required' });
    }

    const db = getDb();
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        let subtotal = 0;
        const processedItems = items.map(item => {
            const qty = parseInt(item.qty, 10) || 1;
            const price = parseFloat(item.unit_price) || 0;
            const total = qty * price;
            subtotal += total;
            return { name: item.name, qty, price, total };
        });

        const stmt = db.prepare(`
            INSERT INTO goods_invoices (invoice_number, customer_name, customer_phone, customer_address, subtotal, tax_amount, total_amount, notes, status)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'unpaid')
        `);
        
        const invNum = invoice_number || `INV-SL-${Date.now()}`;
        
        stmt.run([invNum, customer_name, customer_phone, customer_address, subtotal, subtotal, notes], function(err) {
            if (err) {
                db.run('ROLLBACK');
                db.close();
                return res.status(500).json({ error: 'Error creating invoice: ' + err.message });
            }
            
            const invoiceId = this.lastID;
            const itemStmt = db.prepare(`
                INSERT INTO goods_invoice_items (invoice_id, item_name, quantity, unit_price, total_price)
                VALUES (?, ?, ?, ?, ?)
            `);
            
            let itemsProcessed = 0;
            let itemError = null;
            
            for (const item of processedItems) {
                itemStmt.run([invoiceId, item.name, item.qty, item.price, item.total], (err) => {
                    if (err) itemError = err;
                    itemsProcessed++;
                    
                    if (itemsProcessed === processedItems.length) {
                        itemStmt.finalize();
                        if (itemError) {
                            db.run('ROLLBACK');
                            db.close();
                            return res.status(500).json({ error: 'Error adding items: ' + itemError.message });
                        }
                        
                        db.run('COMMIT', (err) => {
                            db.close();
                            if (err) return res.status(500).json({ error: 'Transaction commit failed' });
                            res.json({ success: true, invoice_id: invoiceId });
                        });
                    }
                });
            }
        });
    });
});

// Delete Goods Invoice
router.delete('/api/:id', adminAuth, (req, res) => {
    const db = getDb();
    db.run(`DELETE FROM goods_invoices WHERE id = ?`, [req.params.id], function(err) {
        db.close();
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Update Status Payment
router.put('/api/:id/status', adminAuth, (req, res) => {
    const { status, payment_method } = req.body;
    const db = getDb();
    const isPaid = status === 'paid';
    const paymentDate = isPaid ? new Date().toISOString() : null;

    db.run(`UPDATE goods_invoices SET status = ?, payment_method = ?, payment_date = ?, updated_at = datetime('now','localtime') WHERE id = ?`, 
        [status, payment_method || null, paymentDate, req.params.id], function(err) {
        db.close();
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

module.exports = router;
