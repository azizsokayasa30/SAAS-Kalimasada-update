/**
 * Notifikasi in-app untuk kolektor (mobile): tagihan baru, isolir, pembatalan pembayaran, setoran dicatat admin.
 * SQLite `collector_field_notifications` — polling GET /api/mobile-adapter/collector/notifications
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('./logger');

const dbPath = path.join(__dirname, '../data/billing.db');
const db = new sqlite3.Database(dbPath);

db.run(
    `CREATE TABLE IF NOT EXISTS collector_field_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collector_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        read_at TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(collector_id, kind, ref_id)
    )`,
    (err) => {
        if (err) {
            logger.error('[collector-field-notifications] create table:', err.message);
        }
    }
);

function upsertCollectorNotification(collectorId, kind, refId, title, body) {
    const cid = parseInt(collectorId, 10);
    if (!Number.isFinite(cid) || cid <= 0 || !kind || refId == null || refId === '') {
        return Promise.resolve();
    }
    const rid = String(refId);
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO collector_field_notifications (collector_id, kind, ref_id, title, body, read_at, created_at)
             VALUES (?, ?, ?, ?, ?, NULL, datetime('now','localtime'))
             ON CONFLICT(collector_id, kind, ref_id) DO UPDATE SET
               title = excluded.title,
               body = excluded.body,
               read_at = NULL,
               created_at = datetime('now','localtime')`,
            [cid, String(kind).toUpperCase(), rid, String(title || 'Notifikasi'), body != null ? String(body) : null],
            function (e) {
                if (e) {
                    logger.error('[collector-field-notifications] upsert:', e.message);
                    return reject(e);
                }
                resolve(this);
            }
        );
    });
}

async function getBillingManager() {
    return require('./billing');
}

async function notifyCollectorsForCustomerIds(customerId, kind, refId, title, body) {
    try {
        const bm = await getBillingManager();
        const ids = await bm.getCollectorIdsForCustomer(customerId);
        await Promise.all((ids || []).map((colId) => upsertCollectorNotification(colId, kind, refId, title, body)));
    } catch (e) {
        try {
            logger.warn('[collector-field-notifications] notifyCollectorsForCustomerIds:', e.message);
        } catch (_) {}
    }
}

function notifyCollector(collectorId, kind, refId, title, body) {
    return upsertCollectorNotification(collectorId, kind, refId, title, body);
}

function notifyNewInvoice(customerId, invoiceId, invoiceNumber, amountLabel) {
    const ref = `INV-${invoiceId}`;
    const title = 'Tagihan baru';
    const body = `${invoiceNumber || 'Invoice'}${amountLabel ? ` · ${amountLabel}` : ''}`.trim();
    return notifyCollectorsForCustomerIds(Number(customerId), 'NEW_INVOICE', ref, title, body);
}

/** Notifikasi pelunasan (untuk pusat notifikasi admin — bukan tagihan baru). */
function notifyInvoicePaid(customerId, invoiceId, invoiceNumber, amountRp) {
    const ref = `PAID-${invoiceId}`;
    const title = 'Tagihan lunas';
    const body = `${invoiceNumber || 'Invoice'} · Rp ${Number(amountRp || 0).toLocaleString('id-ID')}`;
    return notifyCollectorsForCustomerIds(Number(customerId), 'INVOICE_PAID', ref, title, body);
}

function notifyCustomerIsolir(customerId, customerName) {
    const ref = `ISOLIR-${customerId}`;
    const title = 'Isolir / suspended';
    const body = (customerName && String(customerName).trim()) || `Pelanggan ID ${customerId}`;
    return notifyCollectorsForCustomerIds(Number(customerId), 'ISOLIR', ref, title, body);
}

function notifyPaymentCancelled(collectorId, paymentId, detailLine) {
    if (!collectorId) return Promise.resolve();
    const ref = `PAYCANCEL-${paymentId}`;
    const title = 'Pembayaran dibatalkan';
    const body = detailLine || `ID pembayaran ${paymentId}`;
    return notifyCollector(Number(collectorId), 'PAYMENT_CANCELLED', ref, title, body);
}

function notifyAdminRemittanceRecorded(collectorId, receiptId, amountRp) {
    const ref = `REMIT-${receiptId}`;
    const title = 'Setoran dicatat di kantor';
    const body = `Admin menerima setoran Rp ${Number(amountRp || 0).toLocaleString('id-ID')}`;
    return notifyCollector(Number(collectorId), 'ADMIN_REMITTANCE', ref, title, body);
}

function notifyAdminRecordedCollectorPayment(collectorId, adminPaymentRowId, customerName, amountRp) {
    const ref = `ADMPAY-${adminPaymentRowId}`;
    const title = 'Pembayaran dicatat admin';
    const body = `${customerName || 'Pelanggan'} · Rp ${Number(amountRp || 0).toLocaleString('id-ID')}`;
    return notifyCollector(Number(collectorId), 'ADMIN_COLLECTOR_PAYMENT', ref, title, body);
}

module.exports = {
    upsertCollectorNotification,
    notifyNewInvoice,
    notifyInvoicePaid,
    notifyCustomerIsolir,
    notifyPaymentCancelled,
    notifyAdminRemittanceRecorded,
    notifyAdminRecordedCollectorPayment
};
