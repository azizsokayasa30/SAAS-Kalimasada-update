'use strict';

const MAX_BULK_INVOICE_IDS = 100;

function parseInvoiceIdList(raw, max = MAX_BULK_INVOICE_IDS) {
    const limit = Number.isFinite(max) && max > 0 ? max : MAX_BULK_INVOICE_IDS;
    const list = Array.isArray(raw)
        ? raw
        : (raw == null || raw === '' ? [] : String(raw).split(/[,\s]+/));
    const ids = [];
    const seen = new Set();
    for (const item of list) {
        const id = parseInt(String(item).trim(), 10);
        if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= limit) break;
    }
    return ids;
}

function computeAdminPayAmounts(invoiceAmount, discountAmount) {
    const amount = Math.max(0, Number(invoiceAmount) || 0);
    const discount = Math.max(0, Number(discountAmount) || 0);
    if (discount > amount) {
        const err = new Error('Diskon tidak boleh melebihi jumlah invoice');
        err.code = 'INVALID_DISCOUNT';
        throw err;
    }
    return {
        invoiceAmount: amount,
        discount,
        finalAmount: Math.max(amount - discount, 0)
    };
}

function isInvoicePayable(invoice) {
    if (!invoice) return { ok: false, code: 'NOT_FOUND', message: 'Invoice tidak ditemukan' };
    const status = String(invoice.status || '').toLowerCase();
    if (status === 'paid') return { ok: false, code: 'ALREADY_PAID', message: 'Invoice sudah lunas' };
    if (status === 'cancelled') return { ok: false, code: 'CANCELLED', message: 'Invoice dibatalkan' };
    return { ok: true, code: 'OK', message: '' };
}

function buildAdminPayNotes(discount, paymentDate) {
    return `Pelunasan oleh Admin Kantor | Diskon: Rp ${Math.round(Number(discount) || 0).toLocaleString('id-ID')} | Tanggal Bayar: ${paymentDate}`;
}

function wantsJsonResponse(req) {
    const accept = String((req && req.headers && req.headers.accept) || '');
    const format = String((req && req.query && req.query.format) || '');
    return Boolean(req && (req.xhr || accept.includes('application/json') || format === 'json'));
}

module.exports = {
    MAX_BULK_INVOICE_IDS,
    parseInvoiceIdList,
    computeAdminPayAmounts,
    isInvoicePayable,
    buildAdminPayNotes,
    wantsJsonResponse
};
