'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const tenantStore = require('./tenantStore');

const BACKUP_SCHEMA = 'tenant_registry_backup';
const BACKUP_VERSION = 1;
const BACKUP_DIR = path.join(__dirname, '../../data/backup/tenants');
const DEFAULT_KEEP_COUNT = 15;

const EXCEL_COLUMNS = [
    { key: 'name', header: 'Nama Tenant', width: 28 },
    { key: 'subdomain', header: 'Subdomain', width: 18 },
    { key: 'owner_name', header: 'Nama Owner', width: 22 },
    { key: 'owner_email', header: 'Email Owner', width: 28 },
    { key: 'owner_phone', header: 'WhatsApp Owner', width: 18 },
    { key: 'admin_username', header: 'Username Admin', width: 16 },
    { key: 'admin_password', header: 'Password Admin', width: 18 },
    { key: 'subscription_plan_id', header: 'Plan ID', width: 10 },
];

const HEADER_ALIASES = {
    name: ['nama tenant', 'name', 'tenant', 'nama'],
    subdomain: ['subdomain', 'slug', 'domain'],
    owner_name: ['nama owner', 'owner name', 'owner_name', 'pemilik'],
    owner_email: ['email owner', 'owner email', 'owner_email', 'email'],
    owner_phone: ['whatsapp owner', 'owner phone', 'owner_phone', 'whatsapp', 'telepon', 'hp'],
    admin_username: ['username admin', 'admin username', 'admin_username', 'username'],
    admin_password: ['password admin', 'admin password', 'admin_password', 'password'],
    subscription_plan_id: ['plan id', 'subscription_plan_id', 'plan_id', 'paket id'],
};

function ensureBackupDir() {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function buildTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeBackupFilename(name) {
    const base = path.basename(String(name || ''));
    if (!/^tenants_backup_[\w.-]+\.json$/i.test(base)) {
        throw new Error('Nama file backup tidak valid');
    }
    return base;
}

function cleanupOldBackups(keepCount = DEFAULT_KEEP_COUNT) {
    ensureBackupDir();
    const files = fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.endsWith('.json') && f.startsWith('tenants_backup_'))
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

function tenantToExportRecord(tenant) {
    const settings = tenant.settings || {};
    return {
        name: tenant.name,
        subdomain: tenant.subdomain,
        owner_name: tenant.owner_name,
        owner_email: tenant.owner_email,
        owner_phone: tenant.owner_phone,
        admin_username: settings.admin_username || 'admin',
        admin_password: settings.admin_password || '',
        subscription_plan_id: tenant.subscription_plan_id || 1,
        status: tenant.status,
        uuid: tenant.uuid,
        plan_code: tenant.plan_code || null,
    };
}

function normalizeImportRow(raw) {
    const row = raw || {};
    const name = String(row.name ?? '').trim();
    const subdomain = String(row.subdomain ?? '').trim().toLowerCase();
    const owner_name = String(row.owner_name ?? '').trim();
    const owner_email = String(row.owner_email ?? '').trim();
    const owner_phone = String(row.owner_phone ?? '').trim();
    const admin_username = String(row.admin_username ?? 'admin').trim() || 'admin';
    const admin_password = row.admin_password !== undefined ? String(row.admin_password).trim() : '';
    const planRaw = row.subscription_plan_id;
    const subscription_plan_id = planRaw !== undefined && planRaw !== '' && planRaw !== null
        ? Number(planRaw)
        : 1;

    if (!name) throw new Error('Nama tenant wajib diisi');
    if (!subdomain) throw new Error('Subdomain wajib diisi');
    if (!owner_name) throw new Error('Nama owner wajib diisi');
    if (!owner_email) throw new Error('Email owner wajib diisi');
    if (!owner_phone) throw new Error('WhatsApp owner wajib diisi');
    if (!Number.isFinite(subscription_plan_id) || subscription_plan_id < 1) {
        throw new Error('Plan ID tidak valid');
    }

    return {
        name,
        subdomain,
        owner_name,
        owner_email,
        owner_phone,
        admin_username,
        admin_password,
        subscription_plan_id,
    };
}

async function collectBackupPayload() {
    const tenants = await tenantStore.listOperationalTenants();
    const records = tenants.map(tenantToExportRecord);
    return {
        schema: BACKUP_SCHEMA,
        version: BACKUP_VERSION,
        exported_at: new Date().toISOString(),
        tenant_count: records.length,
        tenants: records,
    };
}

function validateBackupPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('File backup tidak valid');
    }
    if (payload.schema !== BACKUP_SCHEMA) {
        throw new Error('Format backup tidak dikenali (bukan registry tenant)');
    }
    if (!Array.isArray(payload.tenants)) {
        throw new Error('Data tenant tidak ditemukan dalam backup');
    }
    return payload;
}

async function exportTenantBackup({ saveToDisk = true, prefix = 'tenants_backup' } = {}) {
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

function listTenantBackups() {
    ensureBackupDir();
    return fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.endsWith('.json') && f.startsWith('tenants_backup_'))
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

async function restoreTenantRegistry(rows, { mode = 'merge' } = {}) {
    if (!Array.isArray(rows) || !rows.length) {
        throw new Error('Tidak ada data tenant untuk di-restore');
    }

    const pre = await exportTenantBackup({ saveToDisk: true, prefix: 'pre_restore_tenants' });

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const raw of rows) {
        const label = raw?.subdomain || raw?.name || '?';
        try {
            const data = normalizeImportRow(raw);
            const existing = await tenantStore.getTenantBySubdomain(data.subdomain);

            if (existing) {
                if (mode === 'create_only') {
                    skipped++;
                    continue;
                }
                await tenantStore.updateTenant(existing.id, data);
                updated++;
            } else {
                await tenantStore.createTenant(data);
                created++;
            }
        } catch (err) {
            errors.push({ subdomain: label, error: err.message });
        }
    }

    return {
        created,
        updated,
        skipped,
        errors,
        total: rows.length,
        pre_restore_file: pre.filename,
        mode,
    };
}

async function restoreTenantBackup(payload, options = {}) {
    const data = validateBackupPayload(payload);
    return restoreTenantRegistry(data.tenants, options);
}

function normalizeHeader(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function mapExcelHeaders(headerRow) {
    const mapping = {};
    headerRow.eachCell((cell, colNumber) => {
        const normalized = normalizeHeader(cell.value);
        if (!normalized) return;
        for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
            if (aliases.includes(normalized) || normalized === key) {
                mapping[colNumber] = key;
            }
        }
    });
    return mapping;
}

function cellValue(cell) {
    if (!cell || cell.value == null) return '';
    if (typeof cell.value === 'object' && cell.value.text != null) {
        return String(cell.value.text).trim();
    }
    return String(cell.value).trim();
}

async function parseTenantsFromExcel(buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('File Excel tidak memiliki sheet');

    const headerRow = sheet.getRow(1);
    const mapping = mapExcelHeaders(headerRow);
    const mappedKeys = new Set(Object.values(mapping));
    const required = ['name', 'subdomain', 'owner_name', 'owner_email', 'owner_phone'];
    const missing = required.filter((k) => !mappedKeys.has(k));
    if (missing.length) {
        throw new Error(`Kolom wajib tidak ditemukan di Excel: ${missing.join(', ')}`);
    }

    const rows = [];
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const record = {};
        let hasValue = false;
        for (const [colNumber, key] of Object.entries(mapping)) {
            const val = cellValue(row.getCell(Number(colNumber)));
            if (val !== '') {
                record[key] = val;
                hasValue = true;
            }
        }
        if (hasValue) rows.push(record);
    });

    if (!rows.length) throw new Error('Tidak ada baris data tenant di file Excel');
    return rows;
}

async function buildTenantExcelBuffer({ includeData = true, templateOnly = false } = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Kalimasada Management';
    const sheet = workbook.addWorksheet('Tenants');

    sheet.columns = EXCEL_COLUMNS.map((col) => ({
        header: col.header,
        key: col.key,
        width: col.width,
    }));

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE8F4FC' },
    };

    if (includeData && !templateOnly) {
        const tenants = await tenantStore.listOperationalTenants();
        for (const tenant of tenants) {
            const rec = tenantToExportRecord(tenant);
            sheet.addRow({
                name: rec.name,
                subdomain: rec.subdomain,
                owner_name: rec.owner_name,
                owner_email: rec.owner_email,
                owner_phone: rec.owner_phone,
                admin_username: rec.admin_username,
                admin_password: rec.admin_password,
                subscription_plan_id: rec.subscription_plan_id,
            });
        }
    } else {
        sheet.addRow({
            name: 'Contoh ISP Nusantara',
            subdomain: 'isp-nusantara',
            owner_name: 'Budi Santoso',
            owner_email: 'budi@example.com',
            owner_phone: '6281234567890',
            admin_username: 'admin',
            admin_password: 'ganti-password-ini',
            subscription_plan_id: 1,
        });
    }

    const guide = workbook.addWorksheet('Panduan');
    guide.columns = [{ header: 'Keterangan', key: 'text', width: 80 }];
    guide.addRow({ text: 'Kolom wajib: Nama Tenant, Subdomain, Nama Owner, Email Owner, WhatsApp Owner' });
    guide.addRow({ text: 'Subdomain: huruf kecil, angka, dan strip (contoh: isp-jakarta)' });
    guide.addRow({ text: 'Plan ID: 1=Starter, 2=Professional, 3=Enterprise (default 1 jika kosong)' });
    guide.addRow({ text: 'Password Admin: kosongkan saat import untuk auto-generate' });
    guide.addRow({ text: 'Mode import "Baru saja" = skip tenant yang subdomain-nya sudah ada' });
    guide.addRow({ text: 'Mode import "Gabung" = buat baru + perbarui tenant yang subdomain-nya cocok' });

    return workbook.xlsx.writeBuffer();
}

module.exports = {
    BACKUP_DIR,
    EXCEL_COLUMNS,
    exportTenantBackup,
    listTenantBackups,
    getBackupFilePath,
    readBackupFile,
    restoreTenantBackup,
    restoreTenantRegistry,
    validateBackupPayload,
    parseTenantsFromExcel,
    buildTenantExcelBuffer,
    tenantToExportRecord,
};
