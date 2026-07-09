'use strict';

const fs = require('fs');
const path = require('path');
const platformFinanceService = require('./platformFinanceService');
const tenantStore = require('./tenantStore');

const BACKUP_SCHEMA = 'platform_finance_backup';
const BACKUP_VERSION = 1;
const BACKUP_DIR = path.join(__dirname, '../../data/backup/platform-finance');
const DEFAULT_KEEP_COUNT = 15;
const FINANCE_SETTINGS_KEY = 'finance_settings';

function ensureBackupDir() {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function buildTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeBackupFilename(name) {
    const base = path.basename(String(name || ''));
    if (!/^platform_finance_backup_[\w.-]+\.json$/i.test(base)) {
        throw new Error('Nama file backup tidak valid');
    }
    return base;
}

function cleanupOldBackups(keepCount = DEFAULT_KEEP_COUNT) {
    ensureBackupDir();
    const files = fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.endsWith('.json') && f.startsWith('platform_finance_backup_'))
        .map((f) => {
            const full = path.join(BACKUP_DIR, f);
            const stat = fs.statSync(full);
            return { name: f, full, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

    const deleted = [];
    for (const file of files.slice(keepCount)) {
        fs.unlinkSync(file.full);
        deleted.push(file.name);
    }
    return { deletedCount: deleted.length, deleted };
}

async function collectBackupPayload() {
    await platformFinanceService.ensureFinanceSchema();

    const [
        tenantInvoices,
        invoiceItems,
        incomes,
        expenses,
        categories,
        financeSettings,
    ] = await Promise.all([
        tenantStore.dbAll('SELECT * FROM platform_tenant_invoices ORDER BY id ASC'),
        tenantStore.dbAll('SELECT * FROM platform_tenant_invoice_items ORDER BY id ASC'),
        tenantStore.dbAll('SELECT * FROM platform_finance_income ORDER BY id ASC'),
        tenantStore.dbAll('SELECT * FROM platform_finance_expenses ORDER BY id ASC'),
        tenantStore.dbAll('SELECT * FROM platform_finance_categories ORDER BY id ASC'),
        platformFinanceService.getFinanceSettings(),
    ]);

    return {
        schema: BACKUP_SCHEMA,
        version: BACKUP_VERSION,
        exported_at: new Date().toISOString(),
        tenant_invoice_count: tenantInvoices.length,
        invoice_item_count: invoiceItems.length,
        income_count: incomes.length,
        expense_count: expenses.length,
        category_count: categories.length,
        finance_settings: financeSettings,
        tenant_invoices: tenantInvoices,
        invoice_items: invoiceItems,
        incomes,
        expenses,
        categories,
    };
}

function validateBackupPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('File backup tidak valid');
    }
    if (payload.schema !== BACKUP_SCHEMA) {
        throw new Error('Format backup tidak dikenali (bukan data finance platform)');
    }
    const arrays = ['tenant_invoices', 'invoice_items', 'incomes', 'expenses', 'categories'];
    for (const key of arrays) {
        if (!Array.isArray(payload[key])) {
            throw new Error(`Data ${key} tidak ditemukan dalam backup`);
        }
    }
    return payload;
}

async function exportFinanceBackup({ saveToDisk = true, prefix = 'platform_finance_backup' } = {}) {
    const payload = await collectBackupPayload();
    const filename = `${prefix}_${buildTimestamp()}.json`;
    const json = JSON.stringify(payload, null, 2);

    if (saveToDisk) {
        ensureBackupDir();
        fs.writeFileSync(path.join(BACKUP_DIR, filename), json, 'utf8');
        const cleanup = cleanupOldBackups();
        return { payload, filename, cleanup };
    }

    return { payload, filename, cleanup: { deletedCount: 0, deleted: [] } };
}

function listFinanceBackups() {
    ensureBackupDir();
    return fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
            const full = path.join(BACKUP_DIR, f);
            const stat = fs.statSync(full);
            return {
                filename: f,
                size: stat.size,
                created_at: stat.mtime.toISOString(),
            };
        })
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function getBackupFilePath(filename) {
    const safe = safeBackupFilename(filename);
    const full = path.join(BACKUP_DIR, safe);
    if (!fs.existsSync(full)) throw new Error('File backup tidak ditemukan');
    return full;
}

function readBackupFile(filename) {
    const full = getBackupFilePath(filename);
    const raw = fs.readFileSync(full, 'utf8');
    return validateBackupPayload(JSON.parse(raw));
}

async function clearFinanceData() {
    await tenantStore.dbRun('DELETE FROM platform_tenant_invoice_items');
    await tenantStore.dbRun('DELETE FROM platform_tenant_invoices');
    await tenantStore.dbRun('DELETE FROM platform_finance_income');
    await tenantStore.dbRun('DELETE FROM platform_finance_expenses');
    await tenantStore.dbRun('DELETE FROM platform_finance_categories');
}

async function upsertCategory(row) {
    const existing = await tenantStore.dbGet('SELECT id FROM platform_finance_categories WHERE id = ?', [row.id]);
    if (existing) {
        await tenantStore.dbRun(
            `UPDATE platform_finance_categories SET name = ?, type = ?, is_active = ?, created_at = COALESCE(?, created_at), updated_at = COALESCE(?, updated_at) WHERE id = ?`,
            [row.name, row.type, row.is_active ? 1 : 0, row.created_at, row.updated_at, row.id]
        );
        return;
    }
    await tenantStore.dbRun(
        `INSERT INTO platform_finance_categories (id, name, type, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, COALESCE(?, datetime('now','localtime')), COALESCE(?, datetime('now','localtime')))`,
        [row.id, row.name, row.type, row.is_active ? 1 : 0, row.created_at, row.updated_at]
    );
}

async function upsertTenantInvoice(row) {
    const existing = await tenantStore.dbGet('SELECT id FROM platform_tenant_invoices WHERE id = ?', [row.id]);
    const cols = [
        'invoice_number', 'tenant_id', 'period_start', 'period_end',
        'gross_amount', 'tax_amount', 'bhp_uso_amount', 'management_fee_amount', 'net_amount',
        'status', 'notes', 'owner_snapshot', 'created_by', 'created_at', 'updated_at',
    ];
    const vals = cols.map((c) => row[c] ?? null);

    if (existing) {
        await tenantStore.dbRun(
            `UPDATE platform_tenant_invoices SET
                invoice_number = ?, tenant_id = ?, period_start = ?, period_end = ?,
                gross_amount = ?, tax_amount = ?, bhp_uso_amount = ?, management_fee_amount = ?, net_amount = ?,
                status = ?, notes = ?, owner_snapshot = ?, created_by = ?,
                created_at = COALESCE(?, created_at), updated_at = COALESCE(?, updated_at)
             WHERE id = ?`,
            [...vals, row.id]
        );
        return row.id;
    }

    await tenantStore.dbRun(
        `INSERT INTO platform_tenant_invoices (
            id, invoice_number, tenant_id, period_start, period_end,
            gross_amount, tax_amount, bhp_uso_amount, management_fee_amount, net_amount,
            status, notes, owner_snapshot, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now','localtime')), COALESCE(?, datetime('now','localtime')))`,
        [row.id, ...vals]
    );
    return row.id;
}

async function upsertInvoiceItem(row) {
    const existing = await tenantStore.dbGet('SELECT id FROM platform_tenant_invoice_items WHERE id = ?', [row.id]);
    if (existing) {
        await tenantStore.dbRun(
            `UPDATE platform_tenant_invoice_items SET invoice_id = ?, description = ?, amount = ?, item_type = ?, created_at = COALESCE(?, created_at) WHERE id = ?`,
            [row.invoice_id, row.description, row.amount, row.item_type, row.created_at, row.id]
        );
        return;
    }
    await tenantStore.dbRun(
        `INSERT INTO platform_tenant_invoice_items (id, invoice_id, description, amount, item_type, created_at) VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now','localtime')))`,
        [row.id, row.invoice_id, row.description, row.amount, row.item_type, row.created_at]
    );
}

async function upsertIncome(row) {
    const existing = await tenantStore.dbGet('SELECT id FROM platform_finance_income WHERE id = ?', [row.id]);
    const fields = ['description', 'amount', 'category', 'transaction_date', 'payment_method', 'notes', 'reference_type', 'reference_id', 'created_at', 'updated_at'];
    const vals = fields.map((f) => row[f] ?? null);

    if (existing) {
        await tenantStore.dbRun(
            `UPDATE platform_finance_income SET description = ?, amount = ?, category = ?, transaction_date = ?, payment_method = ?, notes = ?, reference_type = ?, reference_id = ?, created_at = COALESCE(?, created_at), updated_at = COALESCE(?, updated_at) WHERE id = ?`,
            [...vals, row.id]
        );
        return;
    }
    await tenantStore.dbRun(
        `INSERT INTO platform_finance_income (id, description, amount, category, transaction_date, payment_method, notes, reference_type, reference_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now','localtime')), COALESCE(?, datetime('now','localtime')))`,
        [row.id, ...vals]
    );
}

async function upsertExpense(row) {
    const existing = await tenantStore.dbGet('SELECT id FROM platform_finance_expenses WHERE id = ?', [row.id]);
    const fields = ['description', 'amount', 'category', 'transaction_date', 'payment_method', 'notes', 'reference_type', 'reference_id', 'created_at', 'updated_at'];
    const vals = fields.map((f) => row[f] ?? null);

    if (existing) {
        await tenantStore.dbRun(
            `UPDATE platform_finance_expenses SET description = ?, amount = ?, category = ?, transaction_date = ?, payment_method = ?, notes = ?, reference_type = ?, reference_id = ?, created_at = COALESCE(?, created_at), updated_at = COALESCE(?, updated_at) WHERE id = ?`,
            [...vals, row.id]
        );
        return;
    }
    await tenantStore.dbRun(
        `INSERT INTO platform_finance_expenses (id, description, amount, category, transaction_date, payment_method, notes, reference_type, reference_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now','localtime')), COALESCE(?, datetime('now','localtime')))`,
        [row.id, ...vals]
    );
}

async function restoreFinanceBackup(payload, { mode = 'replace' } = {}) {
    const data = validateBackupPayload(payload);
    await platformFinanceService.ensureFinanceSchema();

    const pre = await exportFinanceBackup({ saveToDisk: true, prefix: 'pre_restore_platform_finance' });

    if (mode === 'replace') {
        await clearFinanceData();
    }

    for (const row of data.categories) {
        if (!row.name || !row.type) continue;
        await upsertCategory(row);
    }

    for (const row of data.tenant_invoices) {
        if (!row.invoice_number || !row.tenant_id) continue;
        await upsertTenantInvoice(row);
    }

    for (const row of data.invoice_items) {
        if (!row.invoice_id || !row.description) continue;
        await upsertInvoiceItem(row);
    }

    for (const row of data.incomes) {
        if (!row.description || row.amount == null) continue;
        await upsertIncome(row);
    }

    for (const row of data.expenses) {
        if (!row.description || row.amount == null) continue;
        await upsertExpense(row);
    }

    if (data.finance_settings && typeof data.finance_settings === 'object') {
        await platformFinanceService.saveFinanceSettings(data.finance_settings);
    }

    return {
        restored_invoices: data.tenant_invoices.length,
        restored_income: data.incomes.length,
        restored_expenses: data.expenses.length,
        restored_categories: data.categories.length,
        pre_restore_file: pre.filename,
        mode,
    };
}

module.exports = {
    BACKUP_DIR,
    exportFinanceBackup,
    listFinanceBackups,
    getBackupFilePath,
    readBackupFile,
    restoreFinanceBackup,
    validateBackupPayload,
};
