'use strict';

const assert = require('assert');
const {
    parseInvoiceIdList,
    computeAdminPayAmounts,
    isInvoicePayable,
    buildAdminPayNotes,
    wantsJsonResponse,
    MAX_BULK_INVOICE_IDS
} = require('../utils/adminInvoicePay');

function testParseInvoiceIdList() {
    assert.deepStrictEqual(parseInvoiceIdList(null), []);
    assert.deepStrictEqual(parseInvoiceIdList(''), []);
    assert.deepStrictEqual(parseInvoiceIdList('12'), [12]);
    assert.deepStrictEqual(parseInvoiceIdList(['3', '3', '4', 'x', 0, -1, 4]), [3, 4]);
    assert.deepStrictEqual(parseInvoiceIdList('1, 2, 2, 3'), [1, 2, 3]);
    const many = Array.from({ length: 150 }, (_, i) => i + 1);
    assert.strictEqual(parseInvoiceIdList(many).length, MAX_BULK_INVOICE_IDS);
    assert.strictEqual(parseInvoiceIdList(many, 5).length, 5);
}

function testComputeAdminPayAmounts() {
    assert.deepStrictEqual(computeAdminPayAmounts(10000, 0), {
        invoiceAmount: 10000,
        discount: 0,
        finalAmount: 10000
    });
    assert.deepStrictEqual(computeAdminPayAmounts('1500', '500'), {
        invoiceAmount: 1500,
        discount: 500,
        finalAmount: 1000
    });
    assert.throws(() => computeAdminPayAmounts(100, 150), /Diskon tidak boleh melebihi/);
}

function testIsInvoicePayable() {
    assert.strictEqual(isInvoicePayable(null).ok, false);
    assert.strictEqual(isInvoicePayable({ status: 'paid' }).code, 'ALREADY_PAID');
    assert.strictEqual(isInvoicePayable({ status: 'cancelled' }).code, 'CANCELLED');
    assert.strictEqual(isInvoicePayable({ status: 'unpaid' }).ok, true);
}

function testBuildNotesAndJson() {
    const notes = buildAdminPayNotes(1000, '2026-08-31');
    assert.ok(notes.includes('1.000'));
    assert.ok(notes.includes('2026-08-31'));
    assert.strictEqual(wantsJsonResponse({ headers: { accept: 'application/json' } }), true);
    assert.strictEqual(wantsJsonResponse({ headers: { accept: 'text/html' }, query: {} }), false);
    assert.strictEqual(wantsJsonResponse({ headers: {}, query: { format: 'json' } }), true);
}

testParseInvoiceIdList();
testComputeAdminPayAmounts();
testIsInvoicePayable();
testBuildNotesAndJson();
console.log('adminInvoicePay tests passed');
