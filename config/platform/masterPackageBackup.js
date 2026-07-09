'use strict';

const fs = require('fs');
const path = require('path');
const masterPackageService = require('./masterPackageService');

const BACKUP_SCHEMA = 'master_packages_backup';
const BACKUP_VERSION = 1;
const BACKUP_DIR = path.join(__dirname, '../../data/backup/master-packages');
const DEFAULT_KEEP_COUNT = 10;

const PACKAGE_COLUMNS = [
    'id', 'name', 'speed', 'price', 'tax_rate', 'description', 'pppoe_profile',
    'upload_limit', 'download_limit', 'burst_limit_upload', 'burst_limit_download',
    'burst_threshold', 'burst_time', 'billing_only', 'image', 'is_active',
    'created_at', 'updated_at',
];

function ensureBackupDir() {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function buildTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeBackupFilename(name) {
    const base = path.basename(String(name || ''));
    if (!/^master_packages_backup_[\w.-]+\.json$/i.test(base)) {
        throw new Error('Nama file backup tidak valid');
    }
    return base;
}

function cleanupOldBackups(keepCount = DEFAULT_KEEP_COUNT) {
    ensureBackupDir();
    const files = fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.endsWith('.json') && f.startsWith('master_packages_backup_'))
        .map((f) => {
            const full = path.join(BACKUP_DIR, f);
            const stat = fs.statSync(full);
            return { name: f, full, mtime: stat.mtimeMs, size: stat.size };
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
    await masterPackageService.ensureMasterPackageSchema();
    const db = masterPackageService.getDb();

    const packages = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM master_packages ORDER BY id ASC', [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });

    const selections = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM tenant_package_selections ORDER BY id ASC', [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });

    return {
        schema: BACKUP_SCHEMA,
        version: BACKUP_VERSION,
        exported_at: new Date().toISOString(),
        package_count: packages.length,
        selection_count: selections.length,
        packages,
        selections,
    };
}

function validateBackupPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('File backup tidak valid');
    }
    if (payload.schema !== BACKUP_SCHEMA) {
        throw new Error('Format backup tidak dikenali (bukan master paket)');
    }
    if (!Array.isArray(payload.packages)) {
        throw new Error('Data paket tidak ditemukan dalam backup');
    }
    if (payload.selections != null && !Array.isArray(payload.selections)) {
        throw new Error('Data pemilihan tenant tidak valid');
    }
    return payload;
}

async function exportMasterPackagesBackup({ saveToDisk = true, prefix = 'master_packages_backup' } = {}) {
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

function listMasterPackageBackups() {
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

async function upsertPackageFromBackup(row) {
    const db = masterPackageService.getDb();
    const existing = await new Promise((resolve, reject) => {
        db.get('SELECT id FROM master_packages WHERE id = ?', [row.id], (err, r) => {
            if (err) reject(err);
            else resolve(r || null);
        });
    });

    const values = PACKAGE_COLUMNS.filter((c) => c !== 'id').map((c) => row[c] ?? null);

    if (existing) {
        await masterPackageService.dbRun(
            `UPDATE master_packages SET
                name = ?, speed = ?, price = ?, tax_rate = ?, description = ?, pppoe_profile = ?,
                upload_limit = ?, download_limit = ?, burst_limit_upload = ?, burst_limit_download = ?,
                burst_threshold = ?, burst_time = ?, billing_only = ?, image = ?, is_active = ?,
                created_at = COALESCE(?, created_at), updated_at = COALESCE(?, updated_at)
             WHERE id = ?`,
            [...values, row.id]
        );
        return row.id;
    }

    await masterPackageService.dbRun(
        `INSERT INTO master_packages (
            id, name, speed, price, tax_rate, description, pppoe_profile,
            upload_limit, download_limit, burst_limit_upload, burst_limit_download,
            burst_threshold, burst_time, billing_only, image, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        PACKAGE_COLUMNS.map((c) => row[c] ?? null)
    );
    return row.id;
}

async function upsertSelectionFromBackup(row) {
    await masterPackageService.dbRun(
        `INSERT INTO tenant_package_selections (tenant_id, master_package_id, is_enabled, created_at)
         VALUES (?, ?, ?, COALESCE(?, datetime('now','localtime')))
         ON CONFLICT(tenant_id, master_package_id) DO UPDATE SET
            is_enabled = excluded.is_enabled`,
        [row.tenant_id, row.master_package_id, row.is_enabled ? 1 : 0, row.created_at || null]
    );
}

async function restoreMasterPackagesBackup(payload, { mode = 'replace' } = {}) {
    const data = validateBackupPayload(payload);
    await masterPackageService.ensureMasterPackageSchema();

    const pre = await exportMasterPackagesBackup({ saveToDisk: true, prefix: 'pre_restore_master_packages' });

    const backupIds = new Set(data.packages.map((p) => Number(p.id)).filter(Boolean));

    if (mode === 'replace') {
        const all = await masterPackageService.listMasterPackages({ includeInactive: true });
        for (const pkg of all) {
            if (!backupIds.has(Number(pkg.id))) {
                await masterPackageService.deleteMasterPackage(pkg.id);
            }
        }
        await masterPackageService.dbRun('DELETE FROM tenant_package_selections');
    }

    for (const pkg of data.packages) {
        if (!pkg.name || !pkg.speed) continue;
        await upsertPackageFromBackup(pkg);
    }

    const selections = data.selections || [];
    for (const sel of selections) {
        if (!sel.tenant_id || !sel.master_package_id) continue;
        await upsertSelectionFromBackup(sel);
    }

    const syncIds = mode === 'replace'
        ? [...backupIds]
        : [...new Set(data.packages.map((p) => Number(p.id)).filter(Boolean))];

    for (const id of syncIds) {
        try {
            await masterPackageService.syncMasterPackageToAllSelectedTenants(id);
        } catch (err) {
            console.warn(`[masterPackageBackup] sync warn id=${id}:`, err.message);
        }
    }

    return {
        restored_packages: data.packages.length,
        restored_selections: selections.length,
        pre_restore_file: pre.filename,
        mode,
    };
}

module.exports = {
    BACKUP_DIR,
    exportMasterPackagesBackup,
    listMasterPackageBackups,
    getBackupFilePath,
    readBackupFile,
    restoreMasterPackagesBackup,
    validateBackupPayload,
};
