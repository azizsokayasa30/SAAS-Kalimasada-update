const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');

const DEFAULT_KEEP_COUNT = 3;

function getBackupDir() {
    return path.join(process.cwd(), 'data', 'backup');
}

function listBackupDbFiles(backupDir = getBackupDir()) {
    if (!fs.existsSync(backupDir)) {
        return [];
    }
    return fs.readdirSync(backupDir)
        .filter((file) => file.endsWith('.db'))
        .map((file) => {
            const filePath = path.join(backupDir, file);
            const stats = fs.statSync(filePath);
            return {
                filename: file,
                path: filePath,
                size: stats.size,
                created: stats.birthtime,
                modified: stats.mtime
            };
        })
        .sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

/**
 * Hapus backup .db lama, sisakan N file terbaru (default 3).
 * @returns {{ kept: string[], deleted: string[], deletedCount: number }}
 */
function cleanupOldBillingBackups(keepCount = DEFAULT_KEEP_COUNT, backupDir = getBackupDir()) {
    const keep = Math.max(parseInt(keepCount, 10) || DEFAULT_KEEP_COUNT, 1);
    const files = listBackupDbFiles(backupDir);
    const kept = files.slice(0, keep);
    const toDelete = files.slice(keep);
    const deleted = [];

    for (const item of toDelete) {
        try {
            fs.unlinkSync(item.path);
            deleted.push(item.filename);
            logger.info(`[billing-backup] Hapus backup lama: ${item.filename}`);
        } catch (err) {
            logger.warn(`[billing-backup] Gagal hapus ${item.filename}: ${err.message}`);
        }
    }

    if (deleted.length > 0) {
        logger.info(`[billing-backup] Cleanup selesai — dipertahankan ${kept.length}, dihapus ${deleted.length}`);
    }

    return {
        kept: kept.map((f) => f.filename),
        deleted,
        deletedCount: deleted.length
    };
}

function getLatestRegularBackup(backupDir = getBackupDir()) {
    return listBackupDbFiles(backupDir).find((f) => f.filename.startsWith('billing_backup_')) || null;
}

function daysSince(date) {
    return Math.floor(Math.abs(Date.now() - new Date(date)) / (1000 * 60 * 60 * 24));
}

function shouldRunAutoBackup(intervalDays, backupDir = getBackupDir()) {
    const interval = Math.max(parseInt(intervalDays, 10) || 7, 1);
    const latest = getLatestRegularBackup(backupDir);
    if (!latest) {
        return true;
    }
    return daysSince(latest.modified) >= interval;
}

function getAppSettings(db) {
    return new Promise((resolve) => {
        db.all('SELECT key, value FROM app_settings', (err, rows) => {
            const settingsObj = {};
            if (!err && rows) {
                rows.forEach((row) => {
                    settingsObj[row.key] = row.value;
                });
            }
            resolve(settingsObj);
        });
    });
}

async function runBillingAutoBackupIfEnabled(options = {}) {
    const db = options.db || require('../config/billing').db;
    const sourceDbPath = options.sourceDbPath || path.join(process.cwd(), 'data', 'billing.db');
    const appSettings = await getAppSettings(db);

    if (appSettings.billing_autobackup_enabled !== 'true') {
        return { ran: false, reason: 'disabled' };
    }

    const interval = parseInt(appSettings.billing_autobackup_interval, 10) || 7;
    if (!shouldRunAutoBackup(interval)) {
        const latest = getLatestRegularBackup();
        return {
            ran: false,
            reason: 'interval',
            interval,
            lastBackup: latest ? latest.filename : null,
            daysSinceLast: latest ? daysSince(latest.modified) : null
        };
    }

    const result = createBillingDbBackup(sourceDbPath, options.backupOptions || {});
    return {
        ran: true,
        interval,
        ...result
    };
}

function createBillingDbBackup(sourceDbPath = path.join(process.cwd(), 'data', 'billing.db'), options = {}) {
    const keepCount = options.keepCount ?? DEFAULT_KEEP_COUNT;
    const backupDir = options.backupDir ?? getBackupDir();
    const prefix = options.prefix || 'billing_backup';

    if (!fs.existsSync(sourceDbPath)) {
        throw new Error(`Database tidak ditemukan: ${sourceDbPath}`);
    }

    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(backupDir, `${prefix}_${timestamp}.db`);
    fs.copyFileSync(sourceDbPath, backupFile);

    const cleanup = cleanupOldBillingBackups(keepCount, backupDir);

    return {
        backupFile,
        filename: path.basename(backupFile),
        cleanup
    };
}

module.exports = {
    DEFAULT_KEEP_COUNT,
    getBackupDir,
    listBackupDbFiles,
    getLatestRegularBackup,
    shouldRunAutoBackup,
    getAppSettings,
    runBillingAutoBackupIfEnabled,
    cleanupOldBillingBackups,
    createBillingDbBackup
};
