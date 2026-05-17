const express = require('express');
const router = express.Router();
const { verifyToken } = require('./auth');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const billingManager = require('../../config/billing');
const serviceSuspension = require('../../config/serviceSuspension');
const whatsappNotifications = require('../../config/whatsapp-notifications');

// Database helper
const getDB = () => new sqlite3.Database(path.join(process.cwd(), 'data/billing.db'));

// API: GET /api/collectors/stats
// Returns statistics for the authenticated collector
router.get('/stats', verifyToken, async (req, res) => {
    try {
        const collectorId = req.user.id; // From JWT
        if (req.user.role !== 'collector' && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const today = new Date();
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

        const [todayPayments, totalCommission, totalPayments, unpaidInvoicesCount] = await Promise.all([
            billingManager.getCollectorTodayPayments(collectorId, startOfDay, endOfDay),
            billingManager.getCollectorTotalCommission(collectorId),
            billingManager.getCollectorTotalPayments(collectorId),
            billingManager.getUnpaidInvoicesCount()
        ]);

        res.json({
            success: true,
            data: {
                todayPayments,
                totalCommission,
                totalPayments,
                unpaidInvoicesCount
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// API: GET /api/collectors/customers
// List of all active customers with their payment status
router.get('/customers', verifyToken, async (req, res) => {
    try {
        const allCustomers = await billingManager.getCustomers();
        const statusFilter = req.query.status; // Optional: paid, unpaid, overdue
        
        if (req.user.role !== 'collector' && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }
        
        let customers = (allCustomers || []).filter(c => c.status === 'active');
        
        if (statusFilter) {
            customers = customers.filter(c => c.payment_status === statusFilter);
        }

        res.json({ success: true, data: customers });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// API: GET /api/collectors/customer-invoices/:customerId
// List unpaid invoices for a specific customer
router.get('/customer-invoices/:customerId', verifyToken, async (req, res) => {
    try {
        const { customerId } = req.params;
        const db = getDB();
        
        const invoices = await new Promise((resolve, reject) => {
            db.all(`
                SELECT i.*, p.name as package_name
                FROM invoices i
                LEFT JOIN packages p ON i.package_id = p.id
                WHERE i.customer_id = ? AND i.status = 'unpaid'
                ORDER BY i.created_at DESC
            `, [customerId], (err, rows) => {
                db.close();
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        res.json({ success: true, data: invoices });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// API: POST /api/collectors/payment
// Submit a new payment from collector
router.post('/payment', verifyToken, async (req, res) => {
    try {
        const collectorId = req.user.id;
        if (req.user.role !== 'collector' && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const { customer_id, payment_amount, payment_method, notes, invoice_ids } = req.body;

        if (!customer_id || !payment_amount) {
            return res.status(400).json({ success: false, message: 'Customer ID and Payment Amount are required' });
        }

        const collector = await billingManager.getCollectorById(collectorId);
        if (!collector) return res.status(404).json({ success: false, message: 'Collector not found' });

        const commissionRate = collector.commission_rate !== null && collector.commission_rate !== undefined ? collector.commission_rate : 5;
        const commissionAmount = Math.round((payment_amount * commissionRate) / 100);

        // Record the payment entry
        const paymentId = await billingManager.recordCollectorPaymentRecord({
            collector_id: collectorId,
            customer_id: customer_id,
            amount: payment_amount,
            payment_amount: payment_amount,
            commission_amount: commissionAmount,
            payment_method: payment_method || 'cash',
            notes: notes,
            status: 'completed'
        });

        let lastPaymentId = null;
        // Allocate to specific invoices or auto-allocate
        if (Array.isArray(invoice_ids) && invoice_ids.length > 0) {
            for (const invId of invoice_ids) {
                await billingManager.updateInvoiceStatus(invId, 'paid', payment_method || 'cash');
                const inv = await billingManager.getInvoiceById(invId);
                const invAmount = parseFloat(inv?.amount || 0);
                const newPayment = await billingManager.recordCollectorPayment({
                    invoice_id: invId,
                    amount: invAmount,
                    payment_method: payment_method || 'cash',
                    reference_number: `COL-${paymentId}`,
                    notes: notes || `Collector Payment`,
                    collector_id: collectorId,
                    commission_amount: Math.round((invAmount * commissionRate) / 100)
                });
                lastPaymentId = newPayment?.id || lastPaymentId;
            }
        } else {
            // Auto allocate logic (same as collectorDashboard.js)
            const invoicesByCustomer = await billingManager.getInvoicesByCustomer(Number(customer_id));
            const unpaidInvoices = (invoicesByCustomer || [])
                .filter(i => i.status === 'unpaid')
                .sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
            
            let remaining = payment_amount;
            for (const inv of unpaidInvoices) {
                const invAmount = parseFloat(inv.amount || 0);
                if (remaining >= invAmount && invAmount > 0) {
                    await billingManager.updateInvoiceStatus(inv.id, 'paid', payment_method || 'cash');
                    const newPayment = await billingManager.recordCollectorPayment({
                        invoice_id: inv.id,
                        amount: invAmount,
                        payment_method: payment_method || 'cash',
                        reference_number: `COL-${paymentId}`,
                        notes: notes || `Collector Auto-Allocation`,
                        collector_id: collectorId,
                        commission_amount: Math.round((invAmount * commissionRate) / 100)
                    });
                    lastPaymentId = newPayment?.id || lastPaymentId;
                    remaining -= invAmount;
                } else break;
            }
        }

        // Notifications & Restoration check
        if (lastPaymentId) {
            try { await whatsappNotifications.sendPaymentReceivedNotification(lastPaymentId); } catch (e) {}
            // restore check
            setTimeout(async () => {
                const unpaid = (await billingManager.getInvoicesByCustomer(Number(customer_id))).filter(i => i.status === 'unpaid');
                if (unpaid.length === 0) {
                    const cust = await billingManager.getCustomerById(Number(customer_id));
                    const { shouldAutoRestoreCustomer } = require('../../utils/customerSuspendReason');
                    if (shouldAutoRestoreCustomer(cust)) {
                        await serviceSuspension.restoreCustomerService(cust);
                    }
                }
            }, 1000);
        }

        res.json({ success: true, payment_id: paymentId, commission_amount: commissionAmount });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// API: GET /api/collectors/payments
// Returns history of payments recorded by the collector
router.get('/payments', verifyToken, async (req, res) => {
    try {
        const collectorId = req.user.id;
        const payments = await billingManager.getCollectorAllPayments(collectorId);
        res.json({ success: true, data: payments });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// API: GET /api/collectors/all-invoices
// Returns all unpaid invoices across all customers
router.get('/all-invoices', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'collector' && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }
        
        // Fetch all unpaid invoices
        const invoices = await billingManager.getInvoicesWithFilters({ status: 'unpaid' });
        res.json({ success: true, data: invoices });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin endpoints (re-include original ones or keep them)
router.get('/', verifyToken, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only' });
    const db = getDB();
    db.all('SELECT * FROM collectors ORDER BY name', [], (err, rows) => {
        db.close();
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, data: rows });
    });
});

module.exports = router;
