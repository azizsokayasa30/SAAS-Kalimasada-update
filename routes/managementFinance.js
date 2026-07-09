'use strict';

const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const tenantStore = require('../config/platform/tenantStore');
const platformFinanceService = require('../config/platform/platformFinanceService');
const platformFinanceBackup = require('../config/platform/platformFinanceBackup');
const { platformAuth } = require('../middleware/platformAuth');
const { formatRupiah } = require('../config/platform/formatRupiah');

const router = express.Router();

const restoreUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter(req, file, cb) {
        const name = String(file.originalname || '').toLowerCase();
        if (name.endsWith('.json')) cb(null, true);
        else cb(new Error('Hanya file JSON backup yang diizinkan'));
    },
});

router.use(platformAuth);

router.use((req, res, next) => {
    res.locals.formatRupiah = formatRupiah;
    next();
});

router.get('/', (req, res) => res.redirect('/management/finance/payments'));

function parsePagination(query) {
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = 50;
    return { page, limit, offset: (page - 1) * limit };
}

function flashFromQuery(query) {
    return {
        success: query.success || null,
        error: query.error ? decodeURIComponent(query.error) : null,
        count: query.count || null,
    };
}

function safeReturnTo(path) {
    const p = String(path || '/management/finance/payments');
    if (p.startsWith('/management/finance')) return p;
    return '/management/finance/payments';
}

function financeLocals(req, extra = {}) {
    const returnPath = `${req.baseUrl || '/management/finance'}${req.path || ''}`.split('?')[0];
    return {
        backups: platformFinanceBackup.listFinanceBackups(),
        financeReturnTo: returnPath,
        adminName: req.session.platformAdminName,
        ...extra,
    };
}

// ── Backup & Restore ──
router.get('/backup/download', async (req, res) => {
    try {
        const { payload, filename } = await platformFinanceBackup.exportFinanceBackup();
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'platform_finance_backup',
            details: {
                filename,
                tenant_invoice_count: payload.tenant_invoice_count,
                income_count: payload.income_count,
                expense_count: payload.expense_count,
            },
            ip: req.ip,
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(JSON.stringify(payload, null, 2));
    } catch (err) {
        console.error('[finance] backup:', err);
        const back = safeReturnTo(req.query.return_to);
        res.redirect(`${back}?error=${encodeURIComponent(err.message)}`);
    }
});

router.get('/backup/file/:filename', async (req, res) => {
    try {
        const full = platformFinanceBackup.getBackupFilePath(req.params.filename);
        res.download(full);
    } catch (err) {
        res.status(404).send(err.message);
    }
});

router.post('/backup/restore', (req, res) => {
    restoreUpload.single('backup_file')(req, res, async (uploadErr) => {
        const back = safeReturnTo(req.body.return_to);
        try {
            if (uploadErr) {
                return res.redirect(`${back}?error=${encodeURIComponent(uploadErr.message)}`);
            }
            if (!req.file) {
                return res.redirect(`${back}?error=${encodeURIComponent('Pilih file backup JSON terlebih dahulu')}`);
            }

            let payload;
            try {
                payload = platformFinanceBackup.validateBackupPayload(JSON.parse(req.file.buffer.toString('utf8')));
            } catch (parseErr) {
                return res.redirect(`${back}?error=${encodeURIComponent(parseErr.message)}`);
            }

            const mode = req.body.mode === 'merge' ? 'merge' : 'replace';
            const result = await platformFinanceBackup.restoreFinanceBackup(payload, { mode });

            await tenantStore.auditLog({
                actorType: 'SuperAdmin',
                actorId: req.session.platformAdminId,
                action: 'platform_finance_restore',
                details: { mode, ...result },
                ip: req.ip,
            });

            res.redirect(`${back}?success=restored&count=${result.restored_invoices}`);
        } catch (err) {
            console.error('[finance] restore upload:', err);
            res.redirect(`${back}?error=${encodeURIComponent(err.message)}`);
        }
    });
});

router.post('/backup/restore/:filename', async (req, res) => {
    const back = safeReturnTo(req.body.return_to);
    try {
        const payload = platformFinanceBackup.readBackupFile(req.params.filename);
        const mode = req.body.mode === 'merge' ? 'merge' : 'replace';
        const result = await platformFinanceBackup.restoreFinanceBackup(payload, { mode });

        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'platform_finance_restore',
            details: { source: req.params.filename, mode, ...result },
            ip: req.ip,
        });

        res.redirect(`${back}?success=restored&count=${result.restored_invoices}`);
    } catch (err) {
        console.error('[finance] restore file:', err);
        res.redirect(`${back}?error=${encodeURIComponent(err.message)}`);
    }
});

// ── Riwayat Pembayaran ──
router.get('/payments', async (req, res) => {
    try {
        const { page, limit, offset } = parsePagination(req.query);
        const range = platformFinanceService.defaultDateRange(req.query);
        const result = await platformFinanceService.getGatewayPayments({
            ...req.query,
            ...range,
            limit,
            offset,
        });
        const tenants = await tenantStore.listOperationalTenants();
        const totalPages = Math.max(Math.ceil(result.total / limit), 1);

        res.render('platform/finance/payments', financeLocals(req, {
            title: 'Riwayat Pembayaran Gateway',
            active: 'finance-payments',
            financeSection: 'payments',
            payments: result.rows,
            tenants,
            filters: { ...range, tenantId: req.query.tenant_id || '', gateway: req.query.gateway || '', status: req.query.status || '' },
            pagination: { page, totalPages, total: result.total, limit },
            flash: flashFromQuery(req.query),
        }));
    } catch (err) {
        console.error('[finance] payments:', err);
        res.status(500).send('Error loading payments');
    }
});

// ── Rekap Per Tenant ──
router.get('/tenant-summary', async (req, res) => {
    try {
        const range = platformFinanceService.defaultDateRange(req.query);
        const summary = await platformFinanceService.getTenantFinancialSummary(range);
        const totals = summary.reduce(
            (acc, row) => {
                acc.gross += Number(row.gross_amount) || 0;
                acc.tax += Number(row.tax_amount) || 0;
                acc.bhp_uso += Number(row.bhp_uso_amount) || 0;
                acc.management_fee += Number(row.management_fee_amount) || 0;
                acc.net += Number(row.net_amount) || 0;
                acc.transactions += Number(row.transaction_count) || 0;
                return acc;
            },
            { gross: 0, tax: 0, bhp_uso: 0, management_fee: 0, net: 0, transactions: 0 }
        );

        res.render('platform/finance/tenant-summary', financeLocals(req, {
            title: 'Rekap Keuangan Per Tenant',
            active: 'finance-tenant-summary',
            financeSection: 'tenant-summary',
            summary,
            totals,
            filters: range,
            flash: flashFromQuery(req.query),
        }));
    } catch (err) {
        console.error('[finance] tenant-summary:', err);
        res.status(500).send('Error loading tenant summary');
    }
});

// ── Invoice Tenant ──
router.get('/invoices', async (req, res) => {
    try {
        const invoices = await platformFinanceService.listTenantInvoices({
            tenantId: req.query.tenant_id || null,
            status: req.query.status || null,
        });
        const tenants = await tenantStore.listOperationalTenants();
        const range = platformFinanceService.defaultDateRange(req.query);

        res.render('platform/finance/invoices', financeLocals(req, {
            title: 'Invoice Rekap Tenant',
            active: 'finance-invoices',
            financeSection: 'invoices',
            invoices,
            tenants,
            filters: range,
            flash: flashFromQuery(req.query),
        }));
    } catch (err) {
        console.error('[finance] invoices:', err);
        res.status(500).send('Error loading invoices');
    }
});

router.post('/invoices/generate', async (req, res) => {
    try {
        const { tenant_id, period_start, period_end } = req.body;
        if (!tenant_id || !period_start || !period_end) {
            throw new Error('Tenant dan periode wajib diisi.');
        }
        const invoice = await platformFinanceService.generateTenantInvoice(
            Number(tenant_id),
            period_start,
            period_end,
            req.session.platformAdminId
        );
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'platform_finance_invoice_created',
            tenantId: Number(tenant_id),
            details: { invoice_id: invoice.id, invoice_number: invoice.invoice_number },
            ip: req.ip,
        });
        res.redirect(`/management/finance/invoices/${invoice.id}?success=created`);
    } catch (err) {
        res.redirect(`/management/finance/invoices?error=${encodeURIComponent(err.message)}`);
    }
});

router.get('/invoices/:id', async (req, res) => {
    try {
        const invoice = await platformFinanceService.getTenantInvoice(req.params.id);
        if (!invoice) return res.status(404).send('Invoice tidak ditemukan.');
        res.render('platform/finance/invoice-detail', financeLocals(req, {
            title: `Invoice ${invoice.invoice_number}`,
            active: 'finance-invoices',
            financeSection: 'invoices',
            invoice,
            flash: flashFromQuery(req.query),
        }));
    } catch (err) {
        console.error('[finance] invoice detail:', err);
        res.status(500).send('Error loading invoice');
    }
});

router.get('/invoices/:id/print', async (req, res) => {
    try {
        const invoice = await platformFinanceService.getTenantInvoice(req.params.id);
        if (!invoice) return res.status(404).send('Invoice tidak ditemukan.');
        const company = res.locals.platformCompany || {};
        res.render('platform/finance/invoice-print', {
            layout: false,
            title: `Invoice ${invoice.invoice_number}`,
            invoice,
            company,
            formatRupiah,
        });
    } catch (err) {
        console.error('[finance] invoice print:', err);
        res.status(500).send('Error loading invoice print');
    }
});

router.post('/invoices/:id/status', async (req, res) => {
    try {
        await platformFinanceService.updateTenantInvoiceStatus(req.params.id, req.body.status);
        res.redirect(`/management/finance/invoices/${req.params.id}?success=updated`);
    } catch (err) {
        res.redirect(`/management/finance/invoices/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/invoices/:id/delete', async (req, res) => {
    try {
        await platformFinanceService.deleteTenantInvoice(req.params.id);
        res.redirect('/management/finance/invoices?success=deleted');
    } catch (err) {
        res.redirect(`/management/finance/invoices/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    }
});

// ── Pajak & Fee ──
router.get('/tax-fees', async (req, res) => {
    try {
        const settings = await platformFinanceService.getFinanceSettings();
        const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
        const breakdown = await platformFinanceService.getTaxFeeBreakdownByMonth({ year });

        res.render('platform/finance/tax-fees', financeLocals(req, {
            title: 'Pajak & Fee Management',
            active: 'finance-tax-fees',
            financeSection: 'tax-fees',
            settings,
            breakdown,
            year,
            flash: flashFromQuery(req.query),
        }));
    } catch (err) {
        console.error('[finance] tax-fees:', err);
        res.status(500).send('Error loading tax fees');
    }
});

router.post('/tax-fees', async (req, res) => {
    try {
        await platformFinanceService.saveFinanceSettings(req.body);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'platform_finance_settings_updated',
            details: req.body,
            ip: req.ip,
        });
        res.redirect('/management/finance/tax-fees?success=saved');
    } catch (err) {
        res.redirect(`/management/finance/tax-fees?error=${encodeURIComponent(err.message)}`);
    }
});

// ── Catatan Pemasukan ──
router.get('/income', async (req, res) => {
    try {
        const range = platformFinanceService.defaultDateRange(req.query);
        const incomes = await platformFinanceService.listIncome(range);
        const categories = await platformFinanceService.listCategories('income');

        res.render('platform/finance/income', financeLocals(req, {
            title: 'Catatan Pemasukan',
            active: 'finance-income',
            financeSection: 'income',
            incomes,
            categories,
            filters: range,
            flash: flashFromQuery(req.query),
        }));
    } catch (err) {
        console.error('[finance] income:', err);
        res.status(500).send('Error loading income');
    }
});

router.post('/income', async (req, res) => {
    try {
        await platformFinanceService.createIncome(req.body);
        res.redirect('/management/finance/income?success=created');
    } catch (err) {
        res.redirect(`/management/finance/income?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/income/:id', async (req, res) => {
    try {
        await platformFinanceService.updateIncome(req.params.id, req.body);
        res.redirect('/management/finance/income?success=updated');
    } catch (err) {
        res.redirect(`/management/finance/income?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/income/:id/delete', async (req, res) => {
    try {
        await platformFinanceService.deleteIncome(req.params.id);
        res.redirect('/management/finance/income?success=deleted');
    } catch (err) {
        res.redirect(`/management/finance/income?error=${encodeURIComponent(err.message)}`);
    }
});

// ── Catatan Pengeluaran ──
router.get('/expenses', async (req, res) => {
    try {
        const range = platformFinanceService.defaultDateRange(req.query);
        const expenses = await platformFinanceService.listExpenses(range);
        const categories = await platformFinanceService.listCategories('expense');

        res.render('platform/finance/expenses', financeLocals(req, {
            title: 'Catatan Pengeluaran',
            active: 'finance-expenses',
            financeSection: 'expenses',
            expenses,
            categories,
            filters: range,
            flash: flashFromQuery(req.query),
        }));
    } catch (err) {
        console.error('[finance] expenses:', err);
        res.status(500).send('Error loading expenses');
    }
});

router.post('/expenses', async (req, res) => {
    try {
        await platformFinanceService.createExpense(req.body);
        res.redirect('/management/finance/expenses?success=created');
    } catch (err) {
        res.redirect(`/management/finance/expenses?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/expenses/:id', async (req, res) => {
    try {
        await platformFinanceService.updateExpense(req.params.id, req.body);
        res.redirect('/management/finance/expenses?success=updated');
    } catch (err) {
        res.redirect(`/management/finance/expenses?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/expenses/:id/delete', async (req, res) => {
    try {
        await platformFinanceService.deleteExpense(req.params.id);
        res.redirect('/management/finance/expenses?success=deleted');
    } catch (err) {
        res.redirect(`/management/finance/expenses?error=${encodeURIComponent(err.message)}`);
    }
});

// ── Laporan Keuangan ──
router.get('/reports', async (req, res) => {
    try {
        const range = platformFinanceService.defaultDateRange(req.query);
        const report = await platformFinanceService.getPlatformFinancialReport(range);

        res.render('platform/finance/reports', financeLocals(req, {
            title: 'Laporan Keuangan Platform',
            active: 'finance-reports',
            financeSection: 'reports',
            report,
            filters: range,
            flash: flashFromQuery(req.query),
        }));
    } catch (err) {
        console.error('[finance] reports:', err);
        res.status(500).send('Error loading reports');
    }
});

router.get('/reports/export.xlsx', async (req, res) => {
    try {
        const range = platformFinanceService.defaultDateRange(req.query);
        const report = await platformFinanceService.getPlatformFinancialReport(range);

        const workbook = new ExcelJS.Workbook();
        const summarySheet = workbook.addWorksheet('Ringkasan');
        summarySheet.columns = [
            { header: 'Item', key: 'item', width: 30 },
            { header: 'Nilai', key: 'value', width: 20 },
        ];
        summarySheet.addRow({ item: 'Total Koleksi Gateway', value: report.summary.totalGross });
        summarySheet.addRow({ item: 'Total PPN', value: report.summary.totalTax });
        summarySheet.addRow({ item: 'Total BHP USO', value: report.summary.totalBhpUso });
        summarySheet.addRow({ item: 'Total Management Fee', value: report.summary.totalManagementFee });
        summarySheet.addRow({ item: 'Pemasukan Manual', value: report.summary.totalIncomeManual });
        summarySheet.addRow({ item: 'Total Pengeluaran', value: report.summary.totalExpense });
        summarySheet.addRow({ item: 'Laba Bersih Platform', value: report.summary.netProfit });
        summarySheet.addRow({ item: 'Periode', value: `${range.startDate} - ${range.endDate}` });

        const tenantSheet = workbook.addWorksheet('Per Tenant');
        tenantSheet.columns = [
            { header: 'Tenant', key: 'tenant', width: 25 },
            { header: 'Owner', key: 'owner', width: 20 },
            { header: 'Transaksi', key: 'tx', width: 12 },
            { header: 'Gross', key: 'gross', width: 15 },
            { header: 'PPN', key: 'tax', width: 15 },
            { header: 'BHP USO', key: 'bhp', width: 15 },
            { header: 'Mgmt Fee', key: 'fee', width: 15 },
            { header: 'Net', key: 'net', width: 15 },
        ];
        for (const row of report.tenantSummary) {
            tenantSheet.addRow({
                tenant: row.tenant_name,
                owner: row.owner_name,
                tx: row.transaction_count,
                gross: row.gross_amount,
                tax: row.tax_amount,
                bhp: row.bhp_uso_amount,
                fee: row.management_fee_amount,
                net: row.net_amount,
            });
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=laporan-finance-platform-${range.startDate}-${range.endDate}.xlsx`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('[finance] export:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
