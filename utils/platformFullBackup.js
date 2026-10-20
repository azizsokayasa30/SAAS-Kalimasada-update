'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const logger = require('../config/logger');
const platformSettingsService = require('../config/platform/platformSettingsService');
const {
    createBillingDbBackup,
    restoreBillingDbFromFile,
    isValidSqliteHeader,
} = require('./billingDbBackup');

const execFileAsync = promisify(execFile);

const SCHEMA = 'platform_full_backup';
const SCHEMA_VERSION = 1;
const SETTINGS_KEY = 'platform_full_backup';
const DEFAULT_INTERVAL_DAYS = 7;
const DEFAULT_KEEP_COUNT = 5;
const MAX_INTERVAL_DAYS = 365;
const MAX_KEEP_COUNT = 30;

const IMAGE_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.heic', '.avif',
]);

const EXCLUDED_NOTES = [
    'File gambar di disk (foto instalasi, bukti bayar, KTP/foto rumah, gambar paket)',
    'Sesi WhatsApp (whatsapp-session/)',
];

function getFullBackupDir() {
    return path.join(process.cwd(), 'data', 'backup', 'full');
}

function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function buildTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function isImageFile(name) {
    return IMAGE_EXT.has(path.extname(String(name || '')).toLowerCase());
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function rmDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
        /* ignore */
    }
}

async function getAutoBackupSettings() {
    await platformSettingsService.ensurePlatformSettingsSchema();
    const stored = await platformSettingsService.getSetting(SETTINGS_KEY);
    const src = stored && typeof stored === 'object' ? stored : {};
    return {
        enabled: src.enabled === true || src.enabled === 'true',
        interval_days: clampInt(src.interval_days, 1, MAX_INTERVAL_DAYS, DEFAULT_INTERVAL_DAYS),
        keep_count: clampInt(src.keep_count, 1, MAX_KEEP_COUNT, DEFAULT_KEEP_COUNT),
        last_run_at: src.last_run_at || null,
        last_filename: src.last_filename || null,
        last_error: src.last_error || null,
        last_trigger: src.last_trigger || null,
    };
}

async function saveAutoBackupSettings(input = {}) {
    const current = await getAutoBackupSettings();
    const next = {
        ...current,
        enabled: input.enabled === true || input.enabled === 'true' || input.enabled === 'on',
        interval_days: clampInt(input.interval_days, 1, MAX_INTERVAL_DAYS, current.interval_days),
        keep_count: clampInt(input.keep_count, 1, MAX_KEEP_COUNT, current.keep_count),
        last_error: null,
    };
    await platformSettingsService.setSetting(SETTINGS_KEY, next);
    return next;
}

async function touchLastRun(patch) {
    const current = await getAutoBackupSettings();
    const next = { ...current, ...patch };
    await platformSettingsService.setSetting(SETTINGS_KEY, next);
    return next;
}

function isFullArchiveName(filename) {
    return /^(platform_full|pre_restore_platform|uploaded)_[\w.-]+\.tar\.gz$/i.test(String(filename || ''));
}

function listFullBackups(backupDir = getFullBackupDir()) {
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir)
        .filter((file) => file.endsWith('.tar.gz') && isFullArchiveName(file))
        .map((file) => {
            const filePath = path.join(backupDir, file);
            const stats = fs.statSync(filePath);
            return {
                filename: file,
                path: filePath,
                size: stats.size,
                created: stats.birthtime,
                modified: stats.mtime,
                kind: 'full',
            };
        })
        .sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

function cleanupOldArchives(keepCount = DEFAULT_KEEP_COUNT, backupDir = getFullBackupDir(), protect = []) {
    const keep = clampInt(keepCount, 1, MAX_KEEP_COUNT, DEFAULT_KEEP_COUNT);
    const protectSet = new Set((protect || []).map((p) => path.resolve(p)));
    const files = listFullBackups(backupDir);
    const kept = [];
    const deleted = [];
    let slots = keep;

    for (const item of files) {
        const resolved = path.resolve(item.path);
        if (protectSet.has(resolved) || slots > 0) {
            kept.push(item.filename);
            if (!protectSet.has(resolved)) slots -= 1;
            continue;
        }
        try {
            fs.unlinkSync(item.path);
            deleted.push(item.filename);
            logger.info(`[platform-full-backup] Hapus arsip lama: ${item.filename}`);
        } catch (err) {
            logger.warn(`[platform-full-backup] Gagal hapus ${item.filename}: ${err.message}`);
            kept.push(item.filename);
        }
    }

    return { kept, deleted, deletedCount: deleted.length };
}

function getLatestRegularFullBackup(backupDir = getFullBackupDir()) {
    return listFullBackups(backupDir).find((f) => f.filename.startsWith('platform_full_')) || null;
}

function daysSince(date) {
    return Math.floor(Math.abs(Date.now() - new Date(date)) / (1000 * 60 * 60 * 24));
}

function writeJson(filePath, data) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function removeImageFiles(dir) {
    if (!dir || !fs.existsSync(dir)) return 0;
    let removed = 0;
    const walk = (current) => {
        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (_) {
            return;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (entry.isFile() && isImageFile(entry.name)) {
                try {
                    fs.unlinkSync(full);
                    removed += 1;
                } catch (_) {
                    /* ignore */
                }
            }
        }
    };
    walk(dir);
    return removed;
}

function copyRegularFiles(srcDir, destDir) {
    const copied = [];
    if (!fs.existsSync(srcDir)) return copied;
    ensureDir(destDir);
    for (const name of fs.readdirSync(srcDir)) {
        const from = path.join(srcDir, name);
        let st;
        try {
            st = fs.lstatSync(from);
        } catch (_) {
            continue;
        }
        if (!st.isFile() || isImageFile(name)) continue;
        const to = path.join(destDir, name);
        fs.copyFileSync(from, to);
        copied.push(name);
    }
    return copied;
}

async function listTarEntries(archivePath) {
    const { stdout } = await execFileAsync('tar', ['-tzf', archivePath], { maxBuffer: 32 * 1024 * 1024 });
    return String(stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

function assertSafeTarEntries(entries) {
    for (const raw of entries) {
        const entry = raw.replace(/^\.\//, '');
        if (!entry || entry === '.') continue;
        if (entry.startsWith('/') || entry.split('/').includes('..')) {
            throw new Error('Arsip backup berisi path yang tidak aman');
        }
    }
}

function hasEntry(entries, rel) {
    const want = rel.replace(/^\.\//, '');
    return entries.some((raw) => raw.replace(/^\.\//, '').replace(/\/$/, '') === want);
}

async function collectSnapshots(stagingDir, warnings) {
    const snapDir = path.join(stagingDir, 'snapshots');
    ensureDir(snapDir);
    const included = [];

    try {
        const financeBackup = require('../config/platform/platformFinanceBackup');
        const { payload } = await financeBackup.exportFinanceBackup({ saveToDisk: false });
        writeJson(path.join(snapDir, 'platform-finance.json'), payload);
        included.push('snapshots/platform-finance.json');
    } catch (err) {
        warnings.push(`Snapshot keuangan platform gagal: ${err.message}`);
    }

    try {
        const tenantBackup = require('../config/platform/tenantBackup');
        const { payload } = await tenantBackup.exportTenantBackup({ saveToDisk: false });
        writeJson(path.join(snapDir, 'tenants.json'), payload);
        included.push('snapshots/tenants.json');
    } catch (err) {
        warnings.push(`Snapshot registry tenant gagal: ${err.message}`);
    }

    try {
        const masterPackageBackup = require('../config/platform/masterPackageBackup');
        const { payload } = await masterPackageBackup.exportMasterPackagesBackup({ saveToDisk: false });
        writeJson(path.join(snapDir, 'master-packages.json'), payload);
        included.push('snapshots/master-packages.json');
    } catch (err) {
        warnings.push(`Snapshot master paket gagal: ${err.message}`);
    }

    return included;
}

async function stageRadius(stagingDir, warnings) {
    const radiusDir = path.join(stagingDir, 'radius');
    ensureDir(radiusDir);
    const included = [];

    const { resolveRadiusSqliteDbPath, backupRadiusDatabaseToPath } = require('../config/radiusSQLite');
    const { dbPath } = await resolveRadiusSqliteDbPath();
    if (!dbPath || !fs.existsSync(dbPath)) {
        warnings.push('Database RADIUS tidak ditemukan, bagian radius.db dilewati');
    } else {
        const target = path.join(radiusDir, 'radius-database.db');
        await backupRadiusDatabaseToPath(target);
        for (const extra of [`${target}-wal`, `${target}-shm`]) {
            try {
                if (fs.existsSync(extra)) fs.unlinkSync(extra);
            } catch (_) {
                /* ignore */
            }
        }
        included.push('radius/radius-database.db');
    }

    const freeradiusConfigDir = '/etc/freeradius/3.0';
    if (fs.existsSync(freeradiusConfigDir)) {
        const dest = path.join(radiusDir, 'freeradius-config');
        await execFileAsync('cp', ['-a', freeradiusConfigDir, dest]);
        const removed = removeImageFiles(dest);
        if (removed > 0) {
            warnings.push(`${removed} file gambar di konfigurasi FreeRADIUS tidak ikut arsip`);
        }
        included.push('radius/freeradius-config');
    } else {
        warnings.push('Direktori /etc/freeradius/3.0 tidak ditemukan, konfigurasi FreeRADIUS dilewati');
    }

    const credentialsFile = '/root/.freeradius_credentials';
    if (fs.existsSync(credentialsFile)) {
        fs.copyFileSync(credentialsFile, path.join(radiusDir, 'freeradius-credentials'));
        included.push('radius/freeradius-credentials');
    }

    writeJson(path.join(radiusDir, 'backup-info.json'), {
        timestamp: new Date().toISOString(),
        source_db: dbPath || null,
        description: 'RADIUS database and FreeRADIUS configuration',
    });
    included.push('radius/backup-info.json');
    return included;
}

function stageNginx(stagingDir, warnings) {
    const nginxDir = path.join(stagingDir, 'nginx');
    ensureDir(nginxDir);
    const included = [];
    const { CONFIG_JSON, GENERATED_CONF } = require('../config/platform/nginxManager');
    const copies = [
        [CONFIG_JSON, 'proxy-config.json'],
        [GENERATED_CONF, 'kalimasada-app.conf'],
        ['/etc/nginx/sites-enabled/kalimasada-app.conf', 'sites-enabled-kalimasada-app.conf'],
    ];
    for (const [src, name] of copies) {
        if (!src || !fs.existsSync(src)) continue;
        if (isImageFile(name)) continue;
        try {
            fs.copyFileSync(src, path.join(nginxDir, name));
            included.push(`nginx/${name}`);
        } catch (err) {
            warnings.push(`Gagal menyalin nginx ${name}: ${err.message}`);
        }
    }
    if (!included.length) {
        warnings.push('Konfigurasi nginx tidak ditemukan');
    }
    return included;
}

function stageWireguard(stagingDir, warnings) {
    const src = '/etc/wireguard';
    if (!fs.existsSync(src)) {
        warnings.push('Direktori /etc/wireguard tidak ditemukan');
        return [];
    }
    try {
        const names = copyRegularFiles(src, path.join(stagingDir, 'wireguard'));
        if (!names.length) {
            warnings.push('Tidak ada file kunci/konfigurasi di /etc/wireguard');
            return [];
        }
        return names.map((name) => `wireguard/${name}`);
    } catch (err) {
        warnings.push(`Gagal menyalin /etc/wireguard: ${err.message}`);
        return [];
    }
}

function stageMobileRegistry(stagingDir, warnings) {
    const src = path.join(process.cwd(), 'data', 'mobile-apps', 'registry.json');
    if (!fs.existsSync(src)) {
        warnings.push('Registry mobile app tidak ditemukan');
        return [];
    }
    try {
        const destDir = path.join(stagingDir, 'mobile');
        ensureDir(destDir);
        fs.copyFileSync(src, path.join(destDir, 'registry.json'));
        return ['mobile/registry.json'];
    } catch (err) {
        warnings.push(`Gagal menyalin registry mobile app: ${err.message}`);
        return [];
    }
}

/**
 * Arsip penuh: billing.db, RADIUS + FreeRADIUS, nginx, WireGuard, registry mobile,
 * serta snapshot JSON keuangan platform, registry tenant, dan master paket.
 * File gambar di disk tidak ikut.
 */
async function createPlatformFullBackup(options = {}) {
    const settings = await getAutoBackupSettings();
    const keepCount = options.keepCount ?? settings.keep_count;
    const prefix = options.prefix || 'platform_full';
    const backupDir = options.backupDir || getFullBackupDir();
    const sourceDbPath = options.sourceDbPath || path.join(process.cwd(), 'data', 'billing.db');
    const db = options.db || require('../config/billing').db;
    const protect = options.protect || [];

    ensureDir(backupDir);
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-full-'));
    const filename = `${prefix}_${buildTimestamp()}.tar.gz`;
    const archivePath = path.join(backupDir, filename);
    const warnings = [];

    try {
        const billingOut = path.join(stagingDir, '_billing');
        const billingResult = await createBillingDbBackup(sourceDbPath, {
            db,
            prefix: 'billing',
            backupDir: billingOut,
            keepCount: 2,
        });
        fs.renameSync(billingResult.backupFile, path.join(stagingDir, 'billing.db'));
        rmDir(billingOut);
        if (!isValidSqliteHeader(path.join(stagingDir, 'billing.db'))) {
            throw new Error('Backup billing.db tidak valid');
        }

        const included = ['billing.db'];
        included.push(...await stageRadius(stagingDir, warnings));
        included.push(...stageNginx(stagingDir, warnings));
        included.push(...stageWireguard(stagingDir, warnings));
        included.push(...stageMobileRegistry(stagingDir, warnings));
        included.push(...await collectSnapshots(stagingDir, warnings));

        writeJson(path.join(stagingDir, 'manifest.json'), {
            schema: SCHEMA,
            version: SCHEMA_VERSION,
            created_at: new Date().toISOString(),
            billing_method: billingResult.method,
            included,
            excluded: EXCLUDED_NOTES,
            warnings,
            note: 'Keuangan platform, registry tenant, dan master paket ada di billing.db dan diulang sebagai snapshot JSON.',
        });

        await execFileAsync('tar', ['-czf', archivePath, '-C', stagingDir, '.']);
        try {
            fs.chmodSync(archivePath, 0o600);
        } catch (_) {
            /* ignore */
        }
        const stat = fs.statSync(archivePath);
        if (!stat.size || stat.size < 1024) {
            throw new Error('Arsip backup kosong atau terlalu kecil');
        }

        const cleanup = cleanupOldArchives(keepCount, backupDir, protect);
        logger.info(`[platform-full-backup] Arsip OK: ${filename} (${stat.size} bytes)`);

        if (prefix === 'platform_full') {
            try {
                await touchLastRun({
                    last_run_at: new Date().toISOString(),
                    last_filename: filename,
                    last_error: warnings.length ? warnings.join(' | ') : null,
                    last_trigger: options.trigger || 'manual',
                });
            } catch (err) {
                logger.warn(`[platform-full-backup] Gagal mencatat jadwal backup: ${err.message}`);
            }
        }

        return {
            backupFile: archivePath,
            filename,
            size: stat.size,
            warnings,
            cleanup,
            method: billingResult.method,
        };
    } catch (err) {
        try {
            if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
        } catch (_) {
            /* ignore */
        }
        throw err;
    } finally {
        rmDir(stagingDir);
    }
}

async function restoreNginxFromStaging(stagingDir, warnings) {
    const nginxDir = path.join(stagingDir, 'nginx');
    if (!fs.existsSync(nginxDir)) {
        warnings.push('Arsip tidak berisi konfigurasi nginx');
        return;
    }
    const { CONFIG_JSON, GENERATED_CONF } = require('../config/platform/nginxManager');
    const pairs = [
        ['proxy-config.json', CONFIG_JSON],
        ['kalimasada-app.conf', GENERATED_CONF],
    ];
    for (const [name, dest] of pairs) {
        const src = path.join(nginxDir, name);
        if (!fs.existsSync(src) || !dest) continue;
        ensureDir(path.dirname(dest));
        fs.copyFileSync(src, dest);
    }

    const liveSrc = path.join(nginxDir, 'sites-enabled-kalimasada-app.conf');
    const liveDest = '/etc/nginx/sites-enabled/kalimasada-app.conf';
    if (!fs.existsSync(liveSrc)) {
        warnings.push('File nginx live tidak ada di arsip. Konfigurasi data/nginx sudah dikembalikan; terapkan ulang dari menu Reverse Proxy jika perlu.');
        return;
    }
    try {
        ensureDir(path.dirname(liveDest));
        fs.copyFileSync(liveSrc, liveDest);
        await execFileAsync('nginx', ['-t']);
        await execFileAsync('systemctl', ['reload', 'nginx']);
    } catch (err) {
        warnings.push(`Konfigurasi nginx dikembalikan, tetapi reload gagal: ${err.stderr || err.message}`);
    }
}

function restoreWireguardFromStaging(stagingDir, warnings) {
    const srcDir = path.join(stagingDir, 'wireguard');
    if (!fs.existsSync(srcDir)) {
        warnings.push('Arsip tidak berisi kunci WireGuard');
        return;
    }
    const dest = '/etc/wireguard';
    try {
        ensureDir(dest);
        const names = fs.readdirSync(srcDir).filter((name) => {
            const full = path.join(srcDir, name);
            return fs.statSync(full).isFile() && !isImageFile(name);
        });
        for (const name of names) {
            const to = path.join(dest, name);
            fs.copyFileSync(path.join(srcDir, name), to);
            try {
                fs.chmodSync(to, 0o600);
            } catch (_) {
                /* ignore */
            }
        }
        if (names.length) {
            warnings.push('File WireGuard dikembalikan. Restart layanan WireGuard manual jika tunnel harus memakai kunci baru.');
        }
    } catch (err) {
        warnings.push(`Gagal mengembalikan /etc/wireguard: ${err.message}`);
    }
}

function restoreMobileRegistry(stagingDir, warnings) {
    const src = path.join(stagingDir, 'mobile', 'registry.json');
    if (!fs.existsSync(src)) {
        warnings.push('Arsip tidak berisi registry mobile app');
        return;
    }
    const dest = path.join(process.cwd(), 'data', 'mobile-apps', 'registry.json');
    try {
        ensureDir(path.dirname(dest));
        fs.copyFileSync(src, dest);
    } catch (err) {
        warnings.push(`Gagal mengembalikan registry mobile app: ${err.message}`);
    }
}

async function restoreRadiusFromStaging(stagingDir, warnings) {
    const radiusDir = path.join(stagingDir, 'radius');
    const dbFile = path.join(radiusDir, 'radius-database.db');
    if (!fs.existsSync(dbFile)) {
        warnings.push('Arsip tidak berisi database RADIUS');
        return;
    }
    const radiusTar = path.join(os.tmpdir(), `radius-from-full-${Date.now()}.tar.gz`);
    try {
        await execFileAsync('tar', ['-czf', radiusTar, '-C', radiusDir, '.']);
        const { restoreRadius } = require('./radiusBackup');
        const result = await restoreRadius(radiusTar);
        if (!result.success) {
            warnings.push(result.message || 'Restore RADIUS gagal');
        }
    } catch (err) {
        warnings.push(`Restore RADIUS gagal: ${err.message}`);
    } finally {
        try {
            if (fs.existsSync(radiusTar)) fs.unlinkSync(radiusTar);
        } catch (_) {
            /* ignore */
        }
    }
}

async function restorePlatformFullBackup(archivePath, options = {}) {
    if (!fs.existsSync(archivePath)) {
        throw new Error('File backup tidak ditemukan');
    }
    const entries = await listTarEntries(archivePath);
    assertSafeTarEntries(entries);
    if (!hasEntry(entries, 'billing.db') || !hasEntry(entries, 'manifest.json')) {
        throw new Error('Arsip bukan backup penuh platform (billing.db atau manifest tidak ada)');
    }

    const db = options.db || require('../config/billing').db;
    const dbPath = options.dbPath || path.join(process.cwd(), 'data', 'billing.db');
    const settings = await getAutoBackupSettings();

    try {
        await createPlatformFullBackup({
            prefix: 'pre_restore_platform',
            db,
            sourceDbPath: dbPath,
            keepCount: options.keepCount ?? settings.keep_count,
            protect: [archivePath],
        });
    } catch (err) {
        logger.warn(`[platform-full-backup] Gagal membuat cadangan pra-restore: ${err.message}`);
    }

    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-full-restore-'));
    const warnings = [];
    try {
        await execFileAsync('tar', ['-xzf', archivePath, '-C', stagingDir]);
        const manifestPath = path.join(stagingDir, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!manifest || manifest.schema !== SCHEMA) {
            throw new Error('Format backup tidak dikenali');
        }
        const billingFile = path.join(stagingDir, 'billing.db');
        if (!isValidSqliteHeader(billingFile)) {
            throw new Error('billing.db di dalam arsip tidak valid');
        }

        await restoreBillingDbFromFile(billingFile, { db, dbPath });
        await restoreRadiusFromStaging(stagingDir, warnings);
        await restoreNginxFromStaging(stagingDir, warnings);
        restoreWireguardFromStaging(stagingDir, warnings);
        restoreMobileRegistry(stagingDir, warnings);

        logger.info(`[platform-full-backup] Restore selesai dari ${path.basename(archivePath)}`);
        return { warnings };
    } finally {
        rmDir(stagingDir);
    }
}

async function runPlatformFullAutoBackupIfEnabled(options = {}) {
    const settings = await getAutoBackupSettings();
    if (!settings.enabled) {
        return { ran: false, reason: 'disabled', settings };
    }

    const latest = getLatestRegularFullBackup();
    if (latest && daysSince(latest.modified) < settings.interval_days) {
        return {
            ran: false,
            reason: 'interval',
            settings,
            interval: settings.interval_days,
            lastBackup: latest.filename,
            daysSinceLast: daysSince(latest.modified),
        };
    }

    try {
        const result = await createPlatformFullBackup({
            ...options,
            prefix: 'platform_full',
            keepCount: settings.keep_count,
            trigger: 'auto',
        });
        return { ran: true, settings, interval: settings.interval_days, ...result };
    } catch (err) {
        await touchLastRun({
            last_run_at: new Date().toISOString(),
            last_error: err.message,
            last_trigger: 'auto',
        });
        throw err;
    }
}

module.exports = {
    SCHEMA,
    SETTINGS_KEY,
    DEFAULT_INTERVAL_DAYS,
    DEFAULT_KEEP_COUNT,
    EXCLUDED_NOTES,
    getFullBackupDir,
    getAutoBackupSettings,
    saveAutoBackupSettings,
    listFullBackups,
    isFullArchiveName,
    createPlatformFullBackup,
    restorePlatformFullBackup,
    runPlatformFullAutoBackupIfEnabled,
};
