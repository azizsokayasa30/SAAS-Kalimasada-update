'use strict';

/**
 * Parse month/year query for admin invoice-list.
 * - omitted month/year → current calendar month (existing behavior)
 * - month=all + year=YYYY → all months in that year
 * - month=all + year=all → no date filter (semua periode)
 * - year=all → no date filter (month is coerced to all)
 */
function parseInvoiceListPeriod(query = {}, now = new Date()) {
    const monthRaw = String(query.month == null ? '' : query.month).trim().toLowerCase();
    const yearRaw = String(query.year == null ? '' : query.year).trim().toLowerCase();
    const allYears = yearRaw === 'all';
    const allMonths = monthRaw === 'all' || allYears;

    const parsedYear = parseInt(query.year, 10);
    const selectedYear = allYears
        ? 'all'
        : (Number.isFinite(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100
            ? parsedYear
            : now.getFullYear());

    const parsedMonth = parseInt(query.month, 10);
    const selectedMonth = allMonths
        ? 'all'
        : (Number.isFinite(parsedMonth)
            ? Math.min(12, Math.max(1, parsedMonth))
            : (now.getMonth() + 1));

    const filters = {};
    if (selectedYear !== 'all' && selectedMonth !== 'all') {
        filters.month = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
    } else if (selectedYear !== 'all' && selectedMonth === 'all') {
        filters.year = selectedYear;
    }

    return { selectedMonth, selectedYear, filters, allMonths, allYears };
}

function invoiceListQueryString(opts = {}) {
    const params = new URLSearchParams();
    const month = opts.month == null || opts.month === '' ? '' : String(opts.month);
    const year = opts.year == null || opts.year === '' ? '' : String(opts.year);
    if (month) params.set('month', month);
    if (year) params.set('year', year);
    if (opts.status) params.set('status', String(opts.status));
    if (opts.type) params.set('type', String(opts.type));
    if (opts.customer_username) params.set('customer_username', String(opts.customer_username));
    if (opts.page && Number(opts.page) > 1) params.set('page', String(opts.page));
    const qs = params.toString();
    return qs ? `?${qs}` : '';
}

module.exports = {
    parseInvoiceListPeriod,
    invoiceListQueryString
};
