/**
 * Fungsi lapangan Manager Area di aplikasi mobile:
 * - Tagih pelanggan di wilayahnya (pembayaran langsung tanpa komisi, ditandai payments.area_manager_id).
 * - Notifikasi tugas PSB / gangguan baru di wilayahnya.
 * Dipasang oleh mobileAdapter di /api/mobile-adapter/area-manager.
 */
const express = require('express');
const billingManager = require('../../config/billing');
const serviceSuspension = require('../../config/serviceSuspension');
const logger = require('../../config/logger');
const { getLocalTimestamp } = require('../../config/settingsManager');
const { verifyToken } = require('./auth');
const { collectorPaymentMulterSingle } = require('../../utils/collectorPaymentSubmit');

const NOTIFICATION_LOOKBACK_DAYS = 7;

function createAreaManagerFieldRouter({
    db,
    getAreaIds,
    sqlCustomerScope,
    sqlTroubleTicketCustomerMatch,
    resolveReqTenantId
}) {
    const router = express.Router();

    const dbAll = (sql, params = []) =>
        new Promise((resolve, reject) => db.all(sql, params, (e, rows) => (e ? reject(e) : resolve(rows || []))));
    const dbGet = (sql, params = []) =>
        new Promise((resolve, reject) => db.get(sql, params, (e, row) => (e ? reject(e) : resolve(row))));
    const dbRun = (sql, params = []) =>
        new Promise((resolve, reject) =>
            db.run(sql, params, function onRun(e) {
                if (e) reject(e);
                else resolve({ lastID: this.lastID, changes: this.changes });
            })
        );

    let schemaReady = null;
    function ensureSchema() {
        if (!schemaReady) {
            schemaReady = (async () => {
                try {
                    await dbRun('ALTER TABLE payments ADD COLUMN area_manager_id INTEGER');
                } catch (e) {
                    if (!/duplicate column/i.test(String(e.message))) throw e;
                }
                await dbRun(
                    'CREATE INDEX IF NOT EXISTS idx_payments_area_manager_id ON payments(area_manager_id)'
                );
                await dbRun(`CREATE TABLE IF NOT EXISTS area_manager_field_notifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    area_manager_id INTEGER NOT NULL,
                    tenant_id INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    ref_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    body TEXT,
                    read_at TEXT,
                    created_at TEXT DEFAULT (datetime('now','localtime')),
                    UNIQUE(area_manager_id, kind, ref_id)
                )`);
            })().catch((e) => {
                schemaReady = null;
                throw e;
            });
        }
        return schemaReady;
    }

    /** Konteks Manager Area: { amId, tenantId, areaIds, name } atau null bila bukan Manager Area. */
    function amContext(req) {
        const areaIds = getAreaIds(req);
        if (areaIds === null) return null;
        const amId = parseInt(String(req.user.id), 10);
        return {
            amId: Number.isFinite(amId) && amId > 0 ? amId : null,
            tenantId: resolveReqTenantId(req),
            areaIds,
            name: String(req.user.name || req.user.username || 'Manager Area').trim()
        };
    }

    function requireAreaManager(req, res, next) {
        const ctx = amContext(req);
        if (!ctx || !ctx.amId) {
            return res.status(403).json({ success: false, message: 'Hanya Manager Area' });
        }
        if (ctx.tenantId == null) {
            return res.status(400).json({ success: false, message: 'Konteks tenant wajib' });
        }
        if (!ctx.areaIds.length) {
            return res.status(403).json({ success: false, message: 'Akun Manager Area belum memiliki wilayah' });
        }
        req.am = ctx;
        next();
    }

    async function findCustomerInScope(am, customerId) {
        const id = parseInt(String(customerId), 10);
        if (!Number.isFinite(id) || id <= 0) return null;
        return dbGet(
            `SELECT c.id, c.customer_id, c.name, c.phone, c.address, c.status,
                    COALESCE(NULLIF(TRIM(c.area), ''), ar.nama_area, '') AS area,
                    p.name AS package_name
             FROM customers c
             LEFT JOIN areas ar ON ar.id = c.area_id
             LEFT JOIN packages p ON p.id = c.package_id
             WHERE c.id = ? AND c.tenant_id = ? AND ${sqlCustomerScope('c', am.areaIds)}`,
            [id, am.tenantId]
        );
    }

    /**
     * Periode tagihan dari query ?month=1-12&year=YYYY (berdasarkan tanggal terbit invoice,
     * sama seperti filter "Belum bayar" admin). null = semua periode.
     */
    function invoicePeriodFilter(query, alias) {
        const month = parseInt(query.month, 10);
        const year = parseInt(query.year, 10) || new Date().getFullYear();
        if (!Number.isFinite(month) || month < 1 || month > 12 || year < 2000 || year > 2100) return null;
        const start = `${year}-${String(month).padStart(2, '0')}-01`;
        const endDate = new Date(year, month, 1);
        const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-01`;
        const dateExpr = `date(COALESCE(${alias}.created_at, ${alias}.due_date, '1970-01-01'))`;
        return {
            sql: ` AND ${dateExpr} >= date(?) AND ${dateExpr} < date(?)`,
            params: [start, end],
            month,
            year
        };
    }

    /** payment_date tersimpan UTC (CURRENT_TIMESTAMP); tampilkan dalam jam aplikasi. */
    function localPaymentTime(raw) {
        const s = String(raw || '').trim();
        if (!s) return '';
        const d = new Date(`${s.replace(' ', 'T')}Z`);
        return Number.isNaN(d.getTime()) ? s : getLocalTimestamp(d);
    }

    // --- Tagih pelanggan ---

    router.get('/collect/customers', verifyToken, requireAreaManager, async (req, res) => {
        const am = req.am;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
        const search = String(req.query.search || '').trim().replace(/%/g, '');
        const unpaidOnly = String(req.query.filter || 'unpaid').toLowerCase() !== 'all';
        const period = invoicePeriodFilter(req.query, 'i');

        const params = [...(period ? period.params : []), am.tenantId];
        let where = `c.tenant_id = ? AND ${sqlCustomerScope('c', am.areaIds)}`;
        if (search) {
            const like = `%${search}%`;
            where += ` AND (c.name LIKE ? OR c.phone LIKE ? OR CAST(c.customer_id AS TEXT) LIKE ?
                OR c.pppoe_username LIKE ? OR c.address LIKE ?)`;
            params.push(like, like, like, like, like);
        }
        const baseSql = `
            SELECT c.id, c.customer_id, c.name, c.phone, c.address, c.status, c.pppoe_username,
                   COALESCE(NULLIF(TRIM(c.area), ''), ar.nama_area, '') AS area,
                   p.name AS package_name,
                   COUNT(i.id) AS unpaid_count,
                   COALESCE(SUM(CAST(i.amount AS REAL)), 0) AS unpaid_total,
                   MIN(i.due_date) AS oldest_due_date
            FROM customers c
            LEFT JOIN areas ar ON ar.id = c.area_id
            LEFT JOIN packages p ON p.id = c.package_id
            LEFT JOIN invoices i ON i.customer_id = c.id
                AND i.status = 'unpaid'
                AND CAST(i.amount AS REAL) > 0
                AND (i.invoice_type != 'voucher' OR i.invoice_type IS NULL)${period ? period.sql : ''}
            WHERE ${where}
            GROUP BY c.id
            ${unpaidOnly ? 'HAVING COUNT(i.id) > 0' : ''}`;
        try {
            const summary = await dbGet(
                `SELECT COUNT(*) AS total_customers,
                        COALESCE(SUM(unpaid_count), 0) AS total_invoices,
                        COALESCE(SUM(unpaid_total), 0) AS total_amount
                 FROM (${baseSql})`,
                params
            );
            const rows = await dbAll(
                `${baseSql}
                 ORDER BY (COUNT(i.id) > 0) DESC, MIN(i.due_date) IS NULL, MIN(i.due_date) ASC, c.name COLLATE NOCASE
                 LIMIT ? OFFSET ?`,
                [...params, limit, (page - 1) * limit]
            );
            const total = Number(summary?.total_customers) || 0;
            res.json({
                success: true,
                data: rows,
                summary: {
                    total_customers: total,
                    total_invoices: Number(summary?.total_invoices) || 0,
                    total_amount: Math.round(Number(summary?.total_amount) || 0)
                },
                period: period ? { month: period.month, year: period.year } : null,
                pagination: { page, limit, total, has_more: page * limit < total }
            });
        } catch (error) {
            logger.error('[mobile-area-manager] collect/customers', error);
            res.status(500).json({ success: false, message: error.message || 'Gagal memuat pelanggan' });
        }
    });

    router.get('/collect/customers/:customerId/invoices', verifyToken, requireAreaManager, async (req, res) => {
        try {
            const customer = await findCustomerInScope(req.am, req.params.customerId);
            if (!customer) {
                return res.status(403).json({ success: false, message: 'Pelanggan di luar wilayah Anda' });
            }
            const period = invoicePeriodFilter(req.query, 'i');
            const invoices = await dbAll(
                `SELECT i.id, i.invoice_number, i.amount, i.due_date, i.status, i.created_at,
                        COALESCE(p.name, i.package_name) AS package_name
                 FROM invoices i
                 LEFT JOIN packages p ON i.package_id = p.id
                 WHERE i.customer_id = ? AND i.status = 'unpaid' AND CAST(i.amount AS REAL) > 0
                   AND (i.invoice_type != 'voucher' OR i.invoice_type IS NULL)${period ? period.sql : ''}
                 ORDER BY i.due_date ASC, i.created_at ASC`,
                [customer.id, ...(period ? period.params : [])]
            );
            res.json({ success: true, data: { customer, invoices } });
        } catch (error) {
            logger.error('[mobile-area-manager] collect/invoices', error);
            res.status(500).json({ success: false, message: error.message || 'Gagal memuat tagihan' });
        }
    });

    function parseInvoiceIds(raw) {
        let list = raw;
        if (typeof raw === 'string') {
            const t = raw.trim();
            try {
                list = t.startsWith('[') ? JSON.parse(t) : t.split(',');
            } catch (_) {
                list = t.split(',');
            }
        }
        if (!Array.isArray(list)) return [];
        return [...new Set(list.map((v) => parseInt(String(v).trim(), 10)).filter((v) => Number.isFinite(v) && v > 0))];
    }

    function restoreServiceIfSettled(customerId) {
        (async () => {
            const invoices = await billingManager.getInvoicesByCustomer(customerId);
            if ((invoices || []).some((i) => i.status === 'unpaid')) return;
            const customer = await billingManager.getCustomerById(customerId);
            const { shouldAutoRestoreCustomer } = require('../../utils/customerSuspendReason');
            if (!shouldAutoRestoreCustomer(customer)) return;
            await billingManager.setCustomerStatusById(customerId, 'active', { skipRadiusSync: true });
            const fresh = await billingManager.getCustomerById(customerId);
            if (fresh) {
                await serviceSuspension.restoreCustomerService(
                    fresh,
                    'Pembayaran via Manager Area — tagihan lunas, layanan dipulihkan'
                );
            }
        })().catch((e) => logger.error('[mobile-area-manager] restore after payment', e));
    }

    function notifyPaymentReceived(paymentIds) {
        setImmediate(() => {
            (async () => {
                try {
                    const wa = require('../../config/whatsapp-notifications');
                    if (paymentIds.length > 1) await wa.sendCollectorBatchPaymentReceivedNotification(paymentIds);
                    else await wa.sendPaymentReceivedNotification(paymentIds[0]);
                } catch (e) {
                    logger.warn('[mobile-area-manager] payment WhatsApp', e.message || e);
                }
            })();
        });
    }

    router.post(
        '/collect/payment',
        verifyToken,
        requireAreaManager,
        collectorPaymentMulterSingle('payment_proof'),
        async (req, res) => {
            const am = req.am;
            const body = req.body || {};
            const method = String(body.payment_method || 'cash').trim().toLowerCase() || 'cash';
            const invoiceIds = parseInvoiceIds(body.invoice_ids);
            const discountTotal = Math.max(0, Math.round(Number(body.discount_amount) || 0));
            const userNotes = String(body.notes || '').trim().slice(0, 500);
            const proofPath = req.file ? `/uploads/payments/${req.file.filename}` : null;

            if (!invoiceIds.length) {
                return res.status(400).json({ success: false, message: 'Pilih minimal satu tagihan' });
            }
            if (method.includes('transfer') && !proofPath) {
                return res.status(400).json({ success: false, message: 'Foto bukti transfer wajib diunggah' });
            }
            try {
                await ensureSchema();
                const customer = await findCustomerInScope(am, body.customer_id);
                if (!customer) {
                    return res.status(403).json({ success: false, message: 'Pelanggan di luar wilayah Anda' });
                }
                const invoices = [];
                for (const id of invoiceIds) {
                    const inv = await billingManager.getInvoiceById(id);
                    if (!inv || Number(inv.customer_id) !== Number(customer.id)) {
                        return res.status(400).json({ success: false, message: `Tagihan #${id} bukan milik pelanggan ini` });
                    }
                    if (String(inv.status || '').toLowerCase() !== 'unpaid') {
                        return res.status(409).json({
                            success: false,
                            message: `Tagihan ${inv.invoice_number || `#${id}`} sudah lunas. Refresh daftar tagihan.`
                        });
                    }
                    invoices.push(inv);
                }
                const gross = Math.round(invoices.reduce((s, inv) => s + (parseFloat(inv.amount) || 0), 0));
                if (discountTotal > gross) {
                    return res.status(400).json({ success: false, message: 'Diskon tidak boleh melebihi total tagihan' });
                }

                const noteParts = [`Diterima oleh Manager Area ${am.name}`];
                if (userNotes) noteParts.push(userNotes);
                const paymentIds = [];
                let remainingDiscount = discountTotal;
                for (const inv of invoices) {
                    const invAmount = Math.round(parseFloat(inv.amount) || 0);
                    const disc = Math.min(remainingDiscount, invAmount);
                    remainingDiscount -= disc;
                    const notes = disc > 0
                        ? [...noteParts, `Diskon: Rp ${disc.toLocaleString('id-ID')}`].join(' | ')
                        : noteParts.join(' | ');
                    const payment = await billingManager.recordPayment({
                        invoice_id: inv.id,
                        amount: invAmount - disc,
                        payment_method: method,
                        reference_number: '',
                        notes,
                        discount_amount: disc
                    });
                    await dbRun('UPDATE payments SET area_manager_id = ?, payment_proof = COALESCE(?, payment_proof) WHERE id = ?', [
                        am.amId,
                        paymentIds.length === 0 ? proofPath : null,
                        payment.id
                    ]);
                    await billingManager.updateInvoiceStatus(inv.id, 'paid', method);
                    paymentIds.push(payment.id);
                }

                notifyPaymentReceived(paymentIds);
                restoreServiceIfSettled(customer.id);

                res.json({
                    success: true,
                    message: 'Pembayaran tersimpan atas nama Manager Area',
                    payment_ids: paymentIds,
                    paid_invoice_ids: invoices.map((inv) => inv.id),
                    total_paid: gross - discountTotal
                });
            } catch (error) {
                logger.error('[mobile-area-manager] collect/payment', error);
                res.status(500).json({ success: false, message: error.message || 'Gagal menyimpan pembayaran' });
            }
        }
    );

    router.get('/collect/history', verifyToken, requireAreaManager, async (req, res) => {
        const am = req.am;
        const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 31));
        try {
            await ensureSchema();
            const rows = await dbAll(
                `SELECT p.id, p.invoice_id, p.amount, p.discount_amount, p.payment_method, p.payment_date, p.notes,
                        i.invoice_number, c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone
                 FROM payments p
                 JOIN invoices i ON i.id = p.invoice_id
                 LEFT JOIN customers c ON c.id = i.customer_id
                 WHERE p.area_manager_id = ? AND p.tenant_id = ?
                   AND datetime(p.payment_date) >= datetime('now', ?)
                 ORDER BY datetime(p.payment_date) DESC, p.id DESC
                 LIMIT 300`,
                [am.amId, am.tenantId, `-${days} days`]
            );
            const today = getLocalTimestamp().slice(0, 10);
            const totals = { count: 0, amount: 0, today_count: 0, today_amount: 0, cash_amount: 0, transfer_amount: 0 };
            const items = rows.map((r) => {
                const local = localPaymentTime(r.payment_date);
                const amount = Math.round(Number(r.amount) || 0);
                totals.count += 1;
                totals.amount += amount;
                if (local.slice(0, 10) === today) {
                    totals.today_count += 1;
                    totals.today_amount += amount;
                }
                if (String(r.payment_method || '').toLowerCase().includes('transfer')) totals.transfer_amount += amount;
                else totals.cash_amount += amount;
                return { ...r, amount, payment_date_local: local };
            });
            res.json({ success: true, data: { items, totals, days } });
        } catch (error) {
            logger.error('[mobile-area-manager] collect/history', error);
            res.status(500).json({ success: false, message: error.message || 'Gagal memuat riwayat' });
        }
    });

    // --- Notifikasi tugas baru di wilayah ---

    async function syncNotifications(am) {
        await ensureSchema();
        const scope = sqlCustomerScope('amc', am.areaIds);
        const since = `-${NOTIFICATION_LOOKBACK_DAYS} days`;
        await dbRun(
            `INSERT OR IGNORE INTO area_manager_field_notifications
                (area_manager_id, tenant_id, kind, ref_id, title, body, created_at)
             SELECT ?, ij.tenant_id, 'INSTALL', CAST(ij.id AS TEXT),
                    'PSB baru: ' || COALESCE(NULLIF(TRIM(ij.customer_name), ''), 'Pelanggan'),
                    TRIM(COALESCE(ij.job_number, '') || ' · ' || COALESCE(ij.customer_address, '')),
                    COALESCE(ij.created_at, datetime('now','localtime'))
             FROM installation_jobs ij
             WHERE ij.tenant_id = ?
               AND LOWER(COALESCE(ij.status, '')) NOT IN ('completed', 'cancelled')
               AND datetime(ij.created_at) >= datetime('now', 'localtime', ?)
               AND EXISTS (SELECT 1 FROM customers amc
                           WHERE amc.id = ij.customer_id AND amc.tenant_id = ij.tenant_id AND ${scope})`,
            [am.amId, am.tenantId, since]
        );
        await dbRun(
            `INSERT OR IGNORE INTO area_manager_field_notifications
                (area_manager_id, tenant_id, kind, ref_id, title, body, created_at)
             SELECT ?, tr.tenant_id, 'TR', CAST(tr.id AS TEXT),
                    'Gangguan: ' || COALESCE(NULLIF(TRIM(tr.name), ''), 'Pelanggan'),
                    TRIM(COALESCE(tr.category, '') || ' · ' || COALESCE(tr.description, '')),
                    COALESCE(tr.created_at, datetime('now','localtime'))
             FROM trouble_reports tr
             WHERE tr.tenant_id = ?
               AND LOWER(COALESCE(tr.status, '')) NOT IN ('resolved', 'closed')
               AND datetime(tr.created_at) >= datetime('now', 'localtime', ?)
               AND EXISTS (SELECT 1 FROM customers amc
                           WHERE amc.tenant_id = tr.tenant_id
                             AND ${sqlTroubleTicketCustomerMatch('amc', 'tr')}
                             AND ${scope})`,
            [am.amId, am.tenantId, since]
        );
    }

    async function listNotifications(req, res) {
        const am = amContext(req);
        if (!am || !am.amId || am.tenantId == null) {
            return res.status(400).json({ success: false, message: 'Konteks Manager Area tidak valid' });
        }
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
        try {
            if (am.areaIds.length) await syncNotifications(am);
            else await ensureSchema();
            const countRow = await dbGet(
                `SELECT COUNT(*) AS c FROM area_manager_field_notifications
                 WHERE area_manager_id = ? AND tenant_id = ? AND read_at IS NULL`,
                [am.amId, am.tenantId]
            );
            const rows = await dbAll(
                `SELECT id, kind, ref_id, title, body, read_at, created_at
                 FROM area_manager_field_notifications
                 WHERE area_manager_id = ? AND tenant_id = ?
                 ORDER BY datetime(created_at) DESC, id DESC
                 LIMIT ?`,
                [am.amId, am.tenantId, limit]
            );
            res.json({
                success: true,
                data: {
                    items: rows.map((r) => ({ ...r, unread: !r.read_at })),
                    unread_count: countRow ? countRow.c : 0
                }
            });
        } catch (error) {
            logger.error('[mobile-area-manager] notifications', error);
            res.status(500).json({ success: false, message: error.message || 'Gagal memuat notifikasi' });
        }
    }

    async function markNotificationRead(req, res) {
        const am = amContext(req);
        const nid = parseInt(req.params.notifId, 10);
        if (!am || !am.amId || !Number.isFinite(nid)) {
            return res.status(400).json({ success: false, message: 'Data tidak valid' });
        }
        try {
            await ensureSchema();
            const r = await dbRun(
                `UPDATE area_manager_field_notifications SET read_at = datetime('now','localtime')
                 WHERE id = ? AND area_manager_id = ? AND tenant_id = ?`,
                [nid, am.amId, am.tenantId]
            );
            if (!r.changes) return res.status(404).json({ success: false, message: 'Notifikasi tidak ditemukan' });
            res.json({ success: true, message: 'Ditandai dibaca' });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    async function markAllNotificationsRead(req, res) {
        const am = amContext(req);
        if (!am || !am.amId) {
            return res.status(400).json({ success: false, message: 'Konteks Manager Area tidak valid' });
        }
        try {
            await ensureSchema();
            const r = await dbRun(
                `UPDATE area_manager_field_notifications SET read_at = datetime('now','localtime')
                 WHERE area_manager_id = ? AND tenant_id = ? AND read_at IS NULL`,
                [am.amId, am.tenantId]
            );
            res.json({ success: true, message: 'Semua ditandai dibaca', updated: r.changes });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    return {
        router,
        notifications: {
            list: listNotifications,
            markRead: markNotificationRead,
            markAllRead: markAllNotificationsRead
        }
    };
}

module.exports = { createAreaManagerFieldRouter };
