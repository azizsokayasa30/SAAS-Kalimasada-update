'use strict';

const COPIED_READONLY_MESSAGE =
    'Data salinan tenant bersifat view-only. Perubahan hanya boleh dilakukan di tenant sumber.';

function copiedWriteError(message = COPIED_READONLY_MESSAGE) {
    const err = new Error(message);
    err.code = 'MASTER_COPIED_READONLY';
    return err;
}

function isCopiedOrigin(row) {
    return String(row?.master_origin || '').toLowerCase() === 'copied';
}

function isDummyOrigin(row) {
    return String(row?.master_origin || '').toLowerCase() === 'dummy';
}

function isCurrentTenantMaster() {
    try {
        const { getTenant } = require('./tenantContext');
        return Boolean(getTenant()?.is_master);
    } catch (_) {
        return false;
    }
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
    });
}

async function getCustomerMirrorRow(db, customerId) {
    if (!db || customerId == null) return null;
    return dbGet(
        db,
        `SELECT id, tenant_id, master_origin, source_tenant_id, source_customer_id
         FROM customers WHERE id = ?`,
        [customerId]
    );
}

async function getInvoiceMirrorRow(db, invoiceId) {
    if (!db || invoiceId == null) return null;
    return dbGet(
        db,
        `SELECT i.id, i.tenant_id, i.source_invoice_id, i.customer_id,
                c.master_origin, c.source_tenant_id, c.source_customer_id
         FROM invoices i
         LEFT JOIN customers c ON c.id = i.customer_id
         WHERE i.id = ?`,
        [invoiceId]
    );
}

function isCopiedCustomerRow(row) {
    if (!row) return false;
    if (isCopiedOrigin(row)) return true;
    if (row.source_tenant_id != null && row.source_customer_id != null && !isDummyOrigin(row)) {
        return true;
    }
    return false;
}

function isCopiedInvoiceRow(row) {
    if (!row) return false;
    if (row.source_invoice_id != null) return true;
    return isCopiedCustomerRow(row);
}

async function assertCustomerWritable(db, customerId, options = {}) {
    if (options.allowMasterSync) return;
    const row = await getCustomerMirrorRow(db, customerId);
    if (isCopiedCustomerRow(row)) {
        throw copiedWriteError();
    }
}

async function assertInvoiceWritable(db, invoiceId, options = {}) {
    if (options.allowMasterSync) return;
    const row = await getInvoiceMirrorRow(db, invoiceId);
    if (isCopiedInvoiceRow(row)) {
        throw copiedWriteError();
    }
}

module.exports = {
    COPIED_READONLY_MESSAGE,
    copiedWriteError,
    isCopiedOrigin,
    isDummyOrigin,
    isCurrentTenantMaster,
    isCopiedCustomerRow,
    isCopiedInvoiceRow,
    getCustomerMirrorRow,
    getInvoiceMirrorRow,
    assertCustomerWritable,
    assertInvoiceWritable,
};
