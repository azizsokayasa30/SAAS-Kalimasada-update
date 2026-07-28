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
        // key di app_settings UNIQUE global — filter ketat tenant_id membuat
        // setting (mis. billing_autobackup_*) "hilang" untuk tenant selain default.
        db.all('SELECT key, value, tenant_id FROM app_settings', [], (err, rows) => {
            const settingsObj = {};
            if (!err && rows) {
                if (tenantId == null) {
                    rows.forEach((row) => {
                        settingsObj[row.key] = row.value;
                    });
                } else {
                    const tid = Number(tenantId);
                    const byKey = new Map();
                    rows.forEach((row) => {
                        const existing = byKey.get(row.key);
                        const isMatch = Number(row.tenant_id) === tid;
                        if (!existing || isMatch) {
                            byKey.set(row.key, row);
                        }
                    });
                    byKey.forEach((row, key) => {
                        settingsObj[key] = row.value;
                    });
                }
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

function onlineBackupToFile(db, destPath, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
        let backup;
        let settled = false;
        const done = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) reject(err);
            else resolve();
        };
        const timer = setTimeout(() => {
            try {
                backup && backup.finish(() => {});
            } catch (_) {
                /* ignore */
            }
            done(new Error('Online backup timeout'));
        }, timeoutMs);

        try {
            // filenameIsDest=true → destPath adalah file tujuan
            backup = db.backup(destPath, 'main', 'main', true);
        } catch (err) {
            return done(err);
        }

        const stepAll = () => {
            if (settled) return;
            try {
                backup.step(-1);
            } catch (err) {
                try {
                    backup.finish(() => {});
                } catch (_) {
                    /* ignore */
                }
                return done(err);
            }
            if (backup.completed) {
                return backup.finish((err) => done(err || null));
            }
            if (backup.failed) {
                return backup.finish(() =>
                    done(new Error('Online backup gagal (database sedang sibuk)'))
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

/**
 * Restore billing.db dari file sumber ke koneksi live via SQLite Online Backup API.
 * Jangan copy-overwrite file .db saat koneksi WAL masih terbuka.
 */
async function restoreBillingDbFromFile(sourceAbsPath, options = {}) {
    const dbPath = options.dbPath || path.join(process.cwd(), 'data', 'billing.db');
    if (!isValidSqliteHeader(sourceAbsPath)) {
        throw new Error('File bukan database SQLite yang valid');
    }

    const { db: liveDb } = resolveLiveDb(options);
    if (!liveDb) {
        throw new Error('Koneksi database aktif tidak tersedia untuk restore');
    }

    await walCheckpoint(liveDb);
    try {
        await createBillingDbBackup(dbPath, { prefix: 'pre_restore', db: liveDb });
    } catch (e) {
        logger.warn('[restore] Gagal membuat cadangan pra-restore: ' + e.message);
    }

    await new Promise((resolve, reject) => {
        let backup;
        try {
            backup = liveDb.backup(sourceAbsPath, 'main', 'main', false, (err) => {
                if (err) reject(err);
            });
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
                    reject(new Error('Restore gagal saat menyalin data database (database sedang sibuk)'))
                );
            }
            setImmediate(stepAll);
        };
        stepAll();
    });

    await walCheckpoint(liveDb);

    try {
        const tenantStore = require('../config/platform/tenantStore');
        await tenantStore.initPlatform();
        logger.info('[restore] Skema platform SaaS dipastikan ulang (initPlatform)');
    } catch (e) {
        logger.error('[restore] Gagal menjalankan initPlatform setelah restore: ' + e.message);
    }

    try {
        const { purgeDemoSeedData } = require('./demoSeedData');
        const purged = await purgeDemoSeedData(liveDb);
        if ((purged.collectorsRemoved || 0) + (purged.odpsRemoved || 0) > 0) {
            logger.info(
                `[restore] Demo seed guard: hapus ${purged.collectorsRemoved || 0} kolektor, ${purged.odpsRemoved || 0} ODP demo`
            );
        }
    } catch (e) {
        logger.warn('[restore] Demo seed guard dilewati: ' + e.message);
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
    createBillingDbBackup,
    restoreBillingDbFromFile,
    isValidSqliteHeader
};
