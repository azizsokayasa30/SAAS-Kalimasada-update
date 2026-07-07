/**
 * Normalisasi laporan keuangan halaman /admin/billing/financial-report.
 * Pendapatan PPPoE (pembayaran tagihan pelanggan di tabel payments) tidak ditampilkan;
 * pendapatan Kolektor/Kantor dari Manajemen Pendapatan (income) tetap dipakai.
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

function openBillingDb() {
    const dbPath = path.join(__dirname, '../data/billing.db');
    return new sqlite3.Database(dbPath);
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

/** Nomor invoice tagihan bulanan pelanggan PPPoE yang dibayar di periode (sumber payments). */
async function loadPppoeInvoiceNumbers(db, startDate, endDate, tenantId = null) {
    const tPay = tenantId != null ? ` AND p.tenant_id = ${Number(tenantId)}` : '';
    const tInv = tenantId != null ? ` AND i.tenant_id = ${Number(tenantId)}` : '';
    const rows = await dbAll(
        db,
        `
        SELECT DISTINCT i.invoice_number AS invoice_number
        FROM payments p
        INNER JOIN invoices i ON p.invoice_id = i.id
        WHERE DATE(p.payment_date) BETWEEN DATE(?) AND DATE(?)
          AND p.payment_type IN ('direct', 'collector', 'online', 'manual')
          AND i.customer_id IS NOT NULL
          AND (i.member_id IS NULL OR i.member_id = '')
          AND (i.invoice_type = 'monthly' OR (
                (i.invoice_type IS NULL OR i.invoice_type = '')
                AND i.invoice_number NOT LIKE 'VCHR-%'
          ))
          AND (i.invoice_type IS NULL OR i.invoice_type != 'voucher')
          AND i.invoice_number IS NOT NULL
          AND TRIM(i.invoice_number) != ''
          ${tPay}${tInv}
        `,
        [startDate, endDate]
    );
    return new Set(rows.map((r) => String(r.invoice_number).trim()).filter(Boolean));
}

function isPppoePaymentTransaction(tx, pppoeInvoiceNumbers) {
    if (tx.type !== 'income') return false;
    const inv = String(tx.invoice_number || '').trim();
    if (!inv || inv === '-') return false;
    return pppoeInvoiceNumbers.has(inv);
}

function adjustProfitLoss(profitLossData) {
    if (!profitLossData || !profitLossData.revenue) {
        return profitLossData;
    }

    const memberPayment = Number(profitLossData.revenue.memberPayment) || 0;
    const voucher = Number(profitLossData.revenue.voucher) || 0;
    const goodsInvoice = Number(profitLossData.revenue.goodsInvoice) || 0;
    const byCategory = { ...(profitLossData.revenue.byCategory || {}) };
    const otherIncome = Object.values(byCategory).reduce((sum, val) => sum + (Number(val) || 0), 0);
    const totalRevenue = memberPayment + voucher + goodsInvoice + otherIncome;
    const totalExpenses = Number(profitLossData.expenses?.total) || 0;

    return {
        ...profitLossData,
        revenue: {
            ...profitLossData.revenue,
            pppoePayment: 0,
            monthlyPayment: memberPayment,
            otherIncome,
            byCategory,
            total: totalRevenue,
            _adjusted: true,
            _pppoeExcluded: true
        },
        netProfit: totalRevenue - totalExpenses
    };
}

function recalculateSummary(transactions, profitLossData) {
    const incomeRows = transactions.filter((tx) => tx.type === 'income');
    const expenseRows = transactions.filter((tx) => tx.type === 'expense');
    const totalIncome = incomeRows.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
    const totalExpense = expenseRows.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
    const totalCommission = incomeRows.reduce((sum, tx) => sum + (Number(tx.commission_amount) || 0), 0);

    const incomeByType = incomeRows.reduce((acc, tx) => {
        const gateway = tx.gateway_name || 'Unknown';
        if (!acc[gateway]) {
            acc[gateway] = { count: 0, amount: 0, commission: 0 };
        }
        acc[gateway].count += 1;
        acc[gateway].amount += Number(tx.amount) || 0;
        acc[gateway].commission += Number(tx.commission_amount) || 0;
        return acc;
    }, {});

    return {
        totalIncome,
        totalExpense,
        totalCommission,
        netProfit: profitLossData?.netProfit ?? totalIncome - totalExpense,
        transactionCount: transactions.length,
        incomeCount: incomeRows.length,
        expenseCount: expenseRows.length,
        incomeByType
    };
}

/**
 * @param {object} financialData - hasil billingManager.getFinancialReport
 * @param {string} startDate
 * @param {string} endDate
 */
async function normalizeFinancialReportForView(financialData, startDate, endDate, tenantId = null) {
    if (!financialData) return financialData;

    const db = openBillingDb();
    try {
        const pppoeInvoiceNumbers = await loadPppoeInvoiceNumbers(db, startDate, endDate, tenantId);
        const transactions = (financialData.transactions || []).filter(
            (tx) => !isPppoePaymentTransaction(tx, pppoeInvoiceNumbers)
        );

        const profitLossData = adjustProfitLoss(financialData.profitLossData);
        const summary = recalculateSummary(transactions, profitLossData);

        return {
            ...financialData,
            transactions,
            summary,
            profitLossData,
            reportAdjustments: {
                pppoeExcluded: true,
                excludedPppoePaymentCount: (financialData.transactions || []).length - transactions.length
            }
        };
    } finally {
        db.close();
    }
}

module.exports = {
    normalizeFinancialReportForView,
    loadPppoeInvoiceNumbers
};
