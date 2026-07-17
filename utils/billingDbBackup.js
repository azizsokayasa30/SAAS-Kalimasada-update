const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');

const DEFAULT_KEEP_COUNT = 3;

/**
 * Path gambar yang sengaja TIDAK ikut backup database.
 * Data referensi (path string di kolom DB) tetap ikut; file binary-nya tidak.
 */
const EXCLUDED_IMAGE_PATHS = [
    'public/img/field-completion/', // foto instalasi job + tiket/penyelesaian lapangan
    'public/uploads/payments/', // bukti transfer / bukti bayar kolektor
    'public/img/customer-', // KTP / foto rumah pelanggan
    'public/uploads/customers/'
];

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

function getAppSettings(db, tenantId = null) {
    return new Promise((resolve) => {
        let sql = 'SELECT key, value FROM app_settings';
        const params = [];
        if (tenantId != null) {
            sql += ' WHERE tenant_id = ?';
            params.push(tenantId);
        }
        db.all(sql, params, (err, rows) => {
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

function resolveLiveDb(options = {}) {
    if (options.db && typeof options.db.backup === 'function') {
        return { db: options.db, owned: false };
    }
    try {
        const billing = require('../config/billing');
        if (billing && billing.db && typeof billing.db.backup === 'function') {
            return { db: billing.db, owned: false };
        }
    } catch (_) {
        /* app belum load / script standalone */
    }
    return { db: null, owned: false };
}

function walCheckpoint(db) {
    return new Promise((resolve) => {
        db.run('PRAGMA wal_checkpoint(TRUNCATE)', () => resolve());
    });
}

function onlineBackupToFile(db, destPath) {
    return new Promise((resolve, reject) => {
        let backup;
        try {
            // filenameIsDest=true → destPath adalah file tujuan
            backup = db.backup(destPath, 'main', 'main', true);
        } catch (err) {
            return reject(err);
        }

        const stepAll = () => {
            try {
                backup.step(-1);
            } catch (err) {
                try {
                    backup.finish(() => {});
                } catch (_) {
                    /* ignore */
                }
                return reject(err);
            }
            if (backup.completed) {
                return backup.finish((err) => (err ? reject(err) : resolve()));
            }
            if (backup.failed) {
                return backup.finish(() =>
                    reject(new Error('Online backup gagal (database sedang sibuk)'))
                );
            }
            setImmediate(stepAll);
        };
        stepAll();
    });
}

function openStandaloneDb(sourceDbPath) {
    const sqlite3 = require('sqlite3').verbose();
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(sourceDbPath, (err) => {
            if (err) reject(err);
            else resolve(db);
        });
    });
}

function closeDb(db) {
    return new Promise((resolve) => {
        try {
            db.close(() => resolve());
        } catch (_) {
            resolve();
        }
    });
}

/**
 * Buat backup lengkap billing.db (semua tabel: billing, absensi, gudang, dll).
 * Menggunakan SQLite Online Backup API + WAL checkpoint agar data di WAL ikut.
 * File gambar di disk tidak ikut (lihat EXCLUDED_IMAGE_PATHS).
 *
 * @returns {Promise<{ backupFile: string, filename: string, cleanup: object, method: string }>}
 */
async function createBillingDbBackup(
    sourceDbPath = path.join(process.cwd(), 'data', 'billing.db'),
    options = {}
) {
    const keepCount = options.keepCount ?? DEFAULT_KEEP_COUNT;
    const backupDir = options.backupDir ?? getBackupDir();
    const prefix = options.prefix || 'billing_backup';

    if (!fs.existsSync(sourceDbPath)) {
        throw new Error(`Database tidak ditemukan: ${sourceDbPath}`);
    }

    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(backupDir, `${prefix}_${timestamp}.db`);

    let method = 'copy';
    let ownedDb = null;

    try {
        let { db } = resolveLiveDb(options);
        if (!db) {
            ownedDb = await openStandaloneDb(sourceDbPath);
            db = ownedDb;
        }

        await walCheckpoint(db);
        await onlineBackupToFile(db, backupFile);
        method = 'online';
        logger.info(`[billing-backup] Online backup OK: ${path.basename(backupFile)}`);
    } catch (err) {
        logger.warn(`[billing-backup] Online backup gagal (${err.message}), fallback copyFileSync`);
        try {
            if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
        } catch (_) {
            /* ignore */
        }
        // Checkpoint via koneksi singkat lalu salin file utama
        try {
            const tempDb = await openStandaloneDb(sourceDbPath);
            await walCheckpoint(tempDb);
            await closeDb(tempDb);
        } catch (checkpointErr) {
            logger.warn(`[billing-backup] Checkpoint sebelum copy gagal: ${checkpointErr.message}`);
        }
        fs.copyFileSync(sourceDbPath, backupFile);
        method = 'copy';
    } finally {
        if (ownedDb) {
            await closeDb(ownedDb);
        }
    }

    if (!fs.existsSync(backupFile) || !isValidSqliteHeader(backupFile)) {
        throw new Error('Backup gagal: file hasil tidak valid');
    }

    const cleanup = cleanupOldBillingBackups(keepCount, backupDir);

    return {
        backupFile,
        filename: path.basename(backupFile),
        cleanup,
        method
    };
}

function isValidSqliteHeader(filePath) {
    let fd = null;
    try {
        fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(16);
        const bytes = fs.readSync(fd, buf, 0, 16, 0);
        if (bytes < 16) return false;
        return buf.toString('utf8', 0, 15) === 'SQLite format 3';
    } catch (_) {
        return false;
    } finally {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch (_) {
                /* ignore */
            }
        }
    }
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

    const result = await createBillingDbBackup(sourceDbPath, {
        ...(options.backupOptions || {}),
        db
    });
    return {
        ran: true,
        interval,
        ...result
    };
}

module.exports = {
    DEFAULT_KEEP_COUNT,
    EXCLUDED_IMAGE_PATHS,
    getBackupDir,
    listBackupDbFiles,
    getLatestRegularBackup,
    shouldRunAutoBackup,
    getAppSettings,
    runBillingAutoBackupIfEnabled,
    cleanupOldBillingBackups,
    createBillingDbBackup
};
