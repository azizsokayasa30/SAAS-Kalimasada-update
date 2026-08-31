'use strict';

const assert = require('assert');
const { parseInvoiceListPeriod, invoiceListQueryString } = require('../utils/invoiceListPeriod');

const now = new Date(2026, 7, 31); // 31 Aug 2026 local

{
    const r = parseInvoiceListPeriod({}, now);
    assert.strictEqual(r.selectedMonth, 8);
    assert.strictEqual(r.selectedYear, 2026);
    assert.strictEqual(r.filters.month, '2026-08');
    assert.strictEqual(r.filters.year, undefined);
}

{
    const r = parseInvoiceListPeriod({ status: 'unpaid' }, now);
    assert.strictEqual(r.filters.month, '2026-08');
}

{
    const r = parseInvoiceListPeriod({ month: 'all', year: 'all', status: 'unpaid' }, now);
    assert.strictEqual(r.selectedMonth, 'all');
    assert.strictEqual(r.selectedYear, 'all');
    assert.deepStrictEqual(r.filters, {});
}

{
    const r = parseInvoiceListPeriod({ month: '3', year: 'all' }, now);
    assert.strictEqual(r.selectedMonth, 'all');
    assert.strictEqual(r.selectedYear, 'all');
    assert.deepStrictEqual(r.filters, {});
}

{
    const r = parseInvoiceListPeriod({ month: 'all', year: '2025' }, now);
    assert.strictEqual(r.selectedMonth, 'all');
    assert.strictEqual(r.selectedYear, 2025);
    assert.strictEqual(r.filters.year, 2025);
    assert.strictEqual(r.filters.month, undefined);
}

{
    const r = parseInvoiceListPeriod({ month: '3', year: '2024' }, now);
    assert.strictEqual(r.selectedMonth, 3);
    assert.strictEqual(r.selectedYear, 2024);
    assert.strictEqual(r.filters.month, '2024-03');
}

{
    const r = parseInvoiceListPeriod({ month: 'all', year: 'all' }, now);
    const qs = invoiceListQueryString({
        month: r.selectedMonth,
        year: r.selectedYear,
        status: 'unpaid'
    });
    assert.ok(qs.includes('month=all'));
    assert.ok(qs.includes('year=all'));
    assert.ok(qs.includes('status=unpaid'));
}

console.log('invoiceListPeriod tests passed');
