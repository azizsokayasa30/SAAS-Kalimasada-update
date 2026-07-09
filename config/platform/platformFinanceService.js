'use strict';

const fs = require('fs');
const path = require('path');
const tenantStore = require('./tenantStore');

const FINANCE_SETTINGS_KEY = 'finance_settings';

const DEFAULT_FINANCE_SETTINGS = {
    bhp_uso_rate: 1.25,
    management_fee_type: 'percent',
    management_fee_value: 5,
    default_tax_rate: 11,
};

let schemaReady = false;

async function ensureFinanceSchema() {
    if (schemaReady) return;
    try {
        const { ensurePlatformSettingsSchema } = require('./platformSettingsService');
        await ensurePlatformSettingsSchema();
    } catch (_) { /* ignore */ }
    const migrationPath = path.join(__dirname, '../../migrations/add_platform_finance.sql');
    if (fs.existsSync(migrationPath)) {
        const sql = fs.readFileSync(migrationPath, 'utf8');
        const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
        for (const stmt of statements) {
            try {
                await tenantStore.dbRun(stmt);
            } catch (err) {
                const msg = String(err.message || '').toLowerCase();
                if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
                    console.warn('[platformFinance] migration warn:', err.message);
                }
            }
        }
    }
    schemaReady = true;
}

function roundMoney(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

function defaultDateRange(filters = {}) {
    const now = new Date();
    const year = filters.year ? Number(filters.year) : now.getFullYear();
    const month = filters.month ? Number(filters.month) : now.getMonth() + 1;
    const start = filters.startDate || `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const end = filters.endDate || `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { startDate: start, endDate: end, year, month };
}

function voucherExclusionClause(alias = 'i') {
    return `(${alias}.invoice_type IS NULL OR ${alias}.invoice_type != 'voucher')`;
}

function onlinePaymentWhere(aliasP = 'p') {
    return `(${aliasP}.payment_method = 'online' OR ${aliasP}.payment_type = 'online')`;
}

async function readFinanceSetting() {
    const row = await tenantStore.dbGet('SELECT value FROM platform_settings WHERE key = ?', [FINANCE_SETTINGS_KEY]);
    if (!row?.value) return null;
    try {
        return JSON.parse(row.value);
    } catch (_) {
        return null;
    }
}

async function writeFinanceSetting(value) {
    await tenantStore.dbRun(
        `INSERT INTO platform_settings (key, value, updated_at)
         VALUES (?, ?, datetime('now','localtime'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [FINANCE_SETTINGS_KEY, JSON.stringify(value)]
    );
}

async function getFinanceSettings() {
    await ensureFinanceSchema();
    const stored = await readFinanceSetting();
    return { ...DEFAULT_FINANCE_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
}

async function saveFinanceSettings(data) {
    await ensureFinanceSchema();
    const next = {
        bhp_uso_rate: roundMoney(data.bhp_uso_rate ?? DEFAULT_FINANCE_SETTINGS.bhp_uso_rate),
        management_fee_type: ['percent', 'fixed'].includes(data.management_fee_type)
            ? data.management_fee_type
            : DEFAULT_FINANCE_SETTINGS.management_fee_type,
        management_fee_value: roundMoney(data.management_fee_value ?? DEFAULT_FINANCE_SETTINGS.management_fee_value),
        default_tax_rate: roundMoney(data.default_tax_rate ?? DEFAULT_FINANCE_SETTINGS.default_tax_rate),
    };
    await writeFinanceSetting(next);
    return next;
}

function calculateFeeBreakdown(totals, settings) {
    const gross = roundMoney(totals.gross || 0);
    const tax = roundMoney(totals.tax || 0);
    const bhpUso = roundMoney(gross * (Number(settings.bhp_uso_rate) || 0) / 100);
    let managementFee = 0;
    if (settings.management_fee_type === 'fixed') {
        managementFee = roundMoney(settings.management_fee_value);
    } else {
        managementFee = roundMoney(gross * (Number(settings.management_fee_value) || 0) / 100);
    }
    const net = roundMoney(gross - tax - bhpUso - managementFee);
    return { gross, tax, bhp_uso: bhpUso, management_fee: managementFee, net };
}

async function getGatewayPayments(filters = {}) {
    await ensureFinanceSchema();
    const { startDate, endDate } = defaultDateRange(filters);
    const params = [startDate, endDate];
    let extra = '';

    if (filters.tenantId) {
        extra += ' AND p.tenant_id = ?';
        params.push(Number(filters.tenantId));
    }
    if (filters.gateway) {
        extra += ' AND LOWER(COALESCE(pgt.gateway, "")) = LOWER(?)';
        params.push(String(filters.gateway));
    }
    if (filters.status) {
        extra += ' AND LOWER(COALESCE(pgt.status, "settlement")) = LOWER(?)';
        params.push(String(filters.status));
    }

    const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
    const offset = Math.max(Number(filters.offset) || 0, 0);

    const countRow = await tenantStore.dbGet(
        `SELECT COUNT(*) AS total
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         JOIN tenants t ON t.id = p.tenant_id
         LEFT JOIN payment_gateway_transactions pgt ON pgt.invoice_id = i.id
         WHERE ${onlinePaymentWhere('p')}
           AND t.deleted_at IS NULL
           AND ${voucherExclusionClause('i')}
           AND DATE(p.payment_date) BETWEEN ? AND ?${extra}`,
        params
    );

    const rows = await tenantStore.dbAll(
        `SELECT
            p.id, p.amount, p.payment_date, p.reference_number, p.payment_method, p.payment_type,
            i.invoice_number, i.base_amount, i.tax_rate, i.amount AS invoice_amount,
            t.id AS tenant_id, t.name AS tenant_name, t.subdomain, t.owner_name,
            COALESCE(c.name, m.name, '-') AS customer_name,
            COALESCE(pgt.gateway, '') AS gateway,
            COALESCE(pgt.order_id, p.reference_number, '') AS order_id,
            COALESCE(pgt.status, 'settlement') AS gateway_status
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         JOIN tenants t ON t.id = p.tenant_id
         LEFT JOIN customers c ON c.id = i.customer_id
         LEFT JOIN members m ON m.id = i.member_id
         LEFT JOIN payment_gateway_transactions pgt ON pgt.invoice_id = i.id
         WHERE ${onlinePaymentWhere('p')}
           AND t.deleted_at IS NULL
           AND ${voucherExclusionClause('i')}
           AND DATE(p.payment_date) BETWEEN ? AND ?${extra}
         ORDER BY p.payment_date DESC, p.id DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );

    return {
        rows,
        total: countRow?.total || 0,
        startDate,
        endDate,
        limit,
        offset,
    };
}

async function getTenantFinancialSummary(filters = {}) {
    await ensureFinanceSchema();
    const settings = await getFinanceSettings();
    const { startDate, endDate } = defaultDateRange(filters);

    const rows = await tenantStore.dbAll(
        `SELECT
            t.id AS tenant_id,
            t.name AS tenant_name,
            t.subdomain,
            t.owner_name,
            t.owner_email,
            COUNT(p.id) AS transaction_count,
            COALESCE(SUM(p.amount), 0) AS gross_amount,
            COALESCE(SUM(
                CASE
                    WHEN i.base_amount IS NOT NULL AND i.base_amount > 0 AND i.tax_rate IS NOT NULL
                    THEN i.base_amount * i.tax_rate / 100
                    ELSE p.amount * ? / (100 + ?)
                END
            ), 0) AS tax_amount
         FROM tenants t
         INNER JOIN payments p ON p.tenant_id = t.id
            AND ${onlinePaymentWhere('p')}
            AND DATE(p.payment_date) BETWEEN ? AND ?
         INNER JOIN invoices i ON i.id = p.invoice_id
            AND ${voucherExclusionClause('i')}
         WHERE t.deleted_at IS NULL
         GROUP BY t.id
         ORDER BY gross_amount DESC, t.name ASC`,
        [
            settings.default_tax_rate,
            settings.default_tax_rate,
            startDate,
            endDate,
        ]
    );

    return rows.map((row) => {
        const breakdown = calculateFeeBreakdown(
            { gross: row.gross_amount, tax: row.tax_amount },
            settings
        );
        return {
            ...row,
            gross_amount: breakdown.gross,
            tax_amount: breakdown.tax,
            bhp_uso_amount: breakdown.bhp_uso,
            management_fee_amount: breakdown.management_fee,
            net_amount: breakdown.net,
        };
    });
}

async function getTaxFeeBreakdownByMonth(filters = {}) {
    await ensureFinanceSchema();
    const settings = await getFinanceSettings();
    const year = filters.year ? Number(filters.year) : new Date().getFullYear();

    const rows = await tenantStore.dbAll(
        `SELECT
            t.id AS tenant_id,
            t.name AS tenant_name,
            strftime('%Y-%m', p.payment_date) AS period_month,
            COUNT(p.id) AS transaction_count,
            COALESCE(SUM(p.amount), 0) AS gross_amount,
            COALESCE(SUM(
                CASE
                    WHEN i.base_amount IS NOT NULL AND i.base_amount > 0 AND i.tax_rate IS NOT NULL
                    THEN i.base_amount * i.tax_rate / 100
                    ELSE p.amount * ? / (100 + ?)
                END
            ), 0) AS tax_amount
         FROM tenants t
         JOIN payments p ON p.tenant_id = t.id
         JOIN invoices i ON i.id = p.invoice_id
         WHERE t.deleted_at IS NULL
           AND ${onlinePaymentWhere('p')}
           AND ${voucherExclusionClause('i')}
           AND strftime('%Y', p.payment_date) = ?
         GROUP BY t.id, period_month
         ORDER BY period_month DESC, t.name ASC`,
        [settings.default_tax_rate, settings.default_tax_rate, String(year)]
    );

    return rows.map((row) => {
        const breakdown = calculateFeeBreakdown(
            { gross: row.gross_amount, tax: row.tax_amount },
            settings
        );
        return { ...row, ...breakdown, bhp_uso_amount: breakdown.bhp_uso, management_fee_amount: breakdown.management_fee };
    });
}

async function generateInvoiceNumber() {
    const prefix = `PF-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const row = await tenantStore.dbGet(
        `SELECT invoice_number FROM platform_tenant_invoices
         WHERE invoice_number LIKE ?
         ORDER BY id DESC LIMIT 1`,
        [`${prefix}%`]
    );
    let seq = 1;
    if (row?.invoice_number) {
        const tail = parseInt(String(row.invoice_number).slice(-4), 10);
        if (!Number.isNaN(tail)) seq = tail + 1;
    }
    return `${prefix}-${String(seq).padStart(4, '0')}`;
}

async function generateTenantInvoice(tenantId, periodStart, periodEnd, createdBy = null) {
    await ensureFinanceSchema();
    const tenant = await tenantStore.getTenantById(tenantId);
    if (!tenant) throw new Error('Tenant tidak ditemukan.');

    const payments = await getGatewayPayments({
        tenantId,
        startDate: periodStart,
        endDate: periodEnd,
        limit: 10000,
        offset: 0,
    });
    if (!payments.rows.length) {
        throw new Error('Tidak ada pembayaran gateway pada periode ini.');
    }

    const settings = await getFinanceSettings();
    let gross = 0;
    let tax = 0;
    const gatewayMap = new Map();

    for (const row of payments.rows) {
        gross += Number(row.amount) || 0;
        if (row.base_amount != null && row.tax_rate != null) {
            tax += (Number(row.base_amount) * Number(row.tax_rate)) / 100;
        } else {
            tax += (Number(row.amount) * settings.default_tax_rate) / (100 + settings.default_tax_rate);
        }
        const gw = row.gateway || 'online';
        gatewayMap.set(gw, (gatewayMap.get(gw) || 0) + (Number(row.amount) || 0));
    }

    const breakdown = calculateFeeBreakdown({ gross, tax }, settings);
    const invoiceNumber = await generateInvoiceNumber();
    const ownerSnapshot = JSON.stringify({
        owner_name: tenant.owner_name,
        owner_email: tenant.owner_email,
        owner_phone: tenant.owner_phone,
        tenant_name: tenant.name,
    });

    const insert = await tenantStore.dbRun(
        `INSERT INTO platform_tenant_invoices (
            invoice_number, tenant_id, period_start, period_end,
            gross_amount, tax_amount, bhp_uso_amount, management_fee_amount, net_amount,
            status, owner_snapshot, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        [
            invoiceNumber,
            tenantId,
            periodStart,
            periodEnd,
            breakdown.gross,
            breakdown.tax,
            breakdown.bhp_uso,
            breakdown.management_fee,
            breakdown.net,
            ownerSnapshot,
            createdBy,
        ]
    );

    const invoiceId = insert.id;
    for (const [gateway, amount] of gatewayMap.entries()) {
        await tenantStore.dbRun(
            `INSERT INTO platform_tenant_invoice_items (invoice_id, description, amount, item_type)
             VALUES (?, ?, ?, 'gateway_collection')`,
            [invoiceId, `Koleksi via ${gateway}`, roundMoney(amount)]
        );
    }
    if (breakdown.tax > 0) {
        await tenantStore.dbRun(
            `INSERT INTO platform_tenant_invoice_items (invoice_id, description, amount, item_type)
             VALUES (?, ?, ?, 'tax')`,
            [invoiceId, 'PPN', breakdown.tax]
        );
    }
    if (breakdown.bhp_uso > 0) {
        await tenantStore.dbRun(
            `INSERT INTO platform_tenant_invoice_items (invoice_id, description, amount, item_type)
             VALUES (?, ?, ?, 'bhp_uso')`,
            [invoiceId, `BHP USO (${settings.bhp_uso_rate}%)`, breakdown.bhp_uso]
        );
    }
    if (breakdown.management_fee > 0) {
        const feeLabel = settings.management_fee_type === 'fixed'
            ? `Management Fee (Rp ${settings.management_fee_value})`
            : `Management Fee (${settings.management_fee_value}%)`;
        await tenantStore.dbRun(
            `INSERT INTO platform_tenant_invoice_items (invoice_id, description, amount, item_type)
             VALUES (?, ?, ?, 'management_fee')`,
            [invoiceId, feeLabel, breakdown.management_fee]
        );
    }

    return getTenantInvoice(invoiceId);
}

async function listTenantInvoices(filters = {}) {
    await ensureFinanceSchema();
    const params = [];
    let extra = '';
    if (filters.tenantId) {
        extra += ' AND pti.tenant_id = ?';
        params.push(Number(filters.tenantId));
    }
    if (filters.status) {
        extra += ' AND pti.status = ?';
        params.push(String(filters.status));
    }
    return tenantStore.dbAll(
        `SELECT pti.*, t.name AS tenant_name, t.subdomain
         FROM platform_tenant_invoices pti
         JOIN tenants t ON t.id = pti.tenant_id
         WHERE 1=1${extra}
         ORDER BY pti.created_at DESC`,
        params
    );
}

async function getTenantInvoice(id) {
    await ensureFinanceSchema();
    const invoice = await tenantStore.dbGet(
        `SELECT pti.*, t.name AS tenant_name, t.subdomain, t.owner_name, t.owner_email, t.owner_phone
         FROM platform_tenant_invoices pti
         JOIN tenants t ON t.id = pti.tenant_id
         WHERE pti.id = ?`,
        [id]
    );
    if (!invoice) return null;
    const items = await tenantStore.dbAll(
        'SELECT * FROM platform_tenant_invoice_items WHERE invoice_id = ? ORDER BY id',
        [id]
    );
    let ownerSnapshot = {};
    try {
        ownerSnapshot = invoice.owner_snapshot ? JSON.parse(invoice.owner_snapshot) : {};
    } catch (_) {
        ownerSnapshot = {};
    }
    return { ...invoice, items, ownerSnapshot };
}

async function updateTenantInvoiceStatus(id, status) {
    await ensureFinanceSchema();
    const allowed = ['draft', 'sent', 'paid'];
    if (!allowed.includes(status)) throw new Error('Status tidak valid.');
    await tenantStore.dbRun(
        `UPDATE platform_tenant_invoices SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
        [status, id]
    );
    return getTenantInvoice(id);
}

async function deleteTenantInvoice(id) {
    await ensureFinanceSchema();
    const inv = await getTenantInvoice(id);
    if (!inv) throw new Error('Invoice tidak ditemukan.');
    if (inv.status !== 'draft') throw new Error('Hanya invoice draft yang bisa dihapus.');
    await tenantStore.dbRun('DELETE FROM platform_tenant_invoices WHERE id = ?', [id]);
    return { success: true };
}

async function listIncome(filters = {}) {
    await ensureFinanceSchema();
    const { startDate, endDate } = defaultDateRange(filters);
    return tenantStore.dbAll(
        `SELECT * FROM platform_finance_income
         WHERE DATE(transaction_date) BETWEEN ? AND ?
         ORDER BY transaction_date DESC, id DESC`,
        [startDate, endDate]
    );
}

async function createIncome(data) {
    await ensureFinanceSchema();
    const result = await tenantStore.dbRun(
        `INSERT INTO platform_finance_income (description, amount, category, transaction_date, payment_method, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            String(data.description || '').trim(),
            roundMoney(data.amount),
            String(data.category || 'Lainnya').trim(),
            data.transaction_date,
            data.payment_method || null,
            data.notes || null,
        ]
    );
    return tenantStore.dbGet('SELECT * FROM platform_finance_income WHERE id = ?', [result.id]);
}

async function updateIncome(id, data) {
    await ensureFinanceSchema();
    await tenantStore.dbRun(
        `UPDATE platform_finance_income SET
            description = ?, amount = ?, category = ?, transaction_date = ?,
            payment_method = ?, notes = ?, updated_at = datetime('now','localtime')
         WHERE id = ?`,
        [
            String(data.description || '').trim(),
            roundMoney(data.amount),
            String(data.category || 'Lainnya').trim(),
            data.transaction_date,
            data.payment_method || null,
            data.notes || null,
            id,
        ]
    );
    return tenantStore.dbGet('SELECT * FROM platform_finance_income WHERE id = ?', [id]);
}

async function deleteIncome(id) {
    await ensureFinanceSchema();
    await tenantStore.dbRun('DELETE FROM platform_finance_income WHERE id = ?', [id]);
    return { success: true };
}

async function listExpenses(filters = {}) {
    await ensureFinanceSchema();
    const { startDate, endDate } = defaultDateRange(filters);
    return tenantStore.dbAll(
        `SELECT * FROM platform_finance_expenses
         WHERE DATE(transaction_date) BETWEEN ? AND ?
         ORDER BY transaction_date DESC, id DESC`,
        [startDate, endDate]
    );
}

async function createExpense(data) {
    await ensureFinanceSchema();
    const result = await tenantStore.dbRun(
        `INSERT INTO platform_finance_expenses (description, amount, category, transaction_date, payment_method, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            String(data.description || '').trim(),
            roundMoney(data.amount),
            String(data.category || 'Lainnya').trim(),
            data.transaction_date,
            data.payment_method || null,
            data.notes || null,
        ]
    );
    return tenantStore.dbGet('SELECT * FROM platform_finance_expenses WHERE id = ?', [result.id]);
}

async function updateExpense(id, data) {
    await ensureFinanceSchema();
    await tenantStore.dbRun(
        `UPDATE platform_finance_expenses SET
            description = ?, amount = ?, category = ?, transaction_date = ?,
            payment_method = ?, notes = ?, updated_at = datetime('now','localtime')
         WHERE id = ?`,
        [
            String(data.description || '').trim(),
            roundMoney(data.amount),
            String(data.category || 'Lainnya').trim(),
            data.transaction_date,
            data.payment_method || null,
            data.notes || null,
            id,
        ]
    );
    return tenantStore.dbGet('SELECT * FROM platform_finance_expenses WHERE id = ?', [id]);
}

async function deleteExpense(id) {
    await ensureFinanceSchema();
    await tenantStore.dbRun('DELETE FROM platform_finance_expenses WHERE id = ?', [id]);
    return { success: true };
}

async function listCategories(type = null) {
    await ensureFinanceSchema();
    if (type) {
        return tenantStore.dbAll(
            'SELECT * FROM platform_finance_categories WHERE is_active = 1 AND type = ? ORDER BY name',
            [type]
        );
    }
    return tenantStore.dbAll(
        'SELECT * FROM platform_finance_categories WHERE is_active = 1 ORDER BY type, name'
    );
}

async function getPlatformFinancialReport(filters = {}) {
    await ensureFinanceSchema();
    const settings = await getFinanceSettings();
    const { startDate, endDate } = defaultDateRange(filters);

    const tenantSummary = await getTenantFinancialSummary({ startDate, endDate });
    const totalGross = tenantSummary.reduce((s, r) => s + (Number(r.gross_amount) || 0), 0);
    const totalTax = tenantSummary.reduce((s, r) => s + (Number(r.tax_amount) || 0), 0);
    const totalBhpUso = tenantSummary.reduce((s, r) => s + (Number(r.bhp_uso_amount) || 0), 0);
    const totalMgmtFee = tenantSummary.reduce((s, r) => s + (Number(r.management_fee_amount) || 0), 0);

    const incomes = await listIncome({ startDate, endDate });
    const expenses = await listExpenses({ startDate, endDate });
    const totalIncomeManual = incomes.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const totalExpense = expenses.reduce((s, r) => s + (Number(r.amount) || 0), 0);

    const platformRevenue = totalBhpUso + totalMgmtFee + totalIncomeManual;
    const netProfit = roundMoney(platformRevenue - totalExpense);

    const payments = await getGatewayPayments({ startDate, endDate, limit: 500, offset: 0 });

    return {
        startDate,
        endDate,
        settings,
        summary: {
            totalGross,
            totalTax,
            totalBhpUso,
            totalManagementFee: totalMgmtFee,
            totalIncomeManual,
            totalExpense,
            platformRevenue,
            netProfit,
            transactionCount: payments.total,
        },
        tenantSummary,
        incomes,
        expenses,
        gatewayPayments: payments.rows,
    };
}

module.exports = {
    ensureFinanceSchema,
    getFinanceSettings,
    saveFinanceSettings,
    calculateFeeBreakdown,
    defaultDateRange,
    getGatewayPayments,
    getTenantFinancialSummary,
    getTaxFeeBreakdownByMonth,
    generateTenantInvoice,
    listTenantInvoices,
    getTenantInvoice,
    updateTenantInvoiceStatus,
    deleteTenantInvoice,
    listIncome,
    createIncome,
    updateIncome,
    deleteIncome,
    listExpenses,
    createExpense,
    updateExpense,
    deleteExpense,
    listCategories,
    getPlatformFinancialReport,
};
