/**
 * Penyimpanan foto penyelesaian tugas lapangan (instalasi / gangguan).
 * - Direktori bisa dipindah ke disk lain: FIELD_COMPLETION_UPLOAD_DIR
 * - Pembersihan otomatis foto job selesai & file yatim
 * - Saat disk penuh (ENOSPC): cleanup darurat lalu coba simpan lagi
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const logger = require('../config/logger');

const PUBLIC_PREFIX = '/img/field-completion';
const IMG_PATH_RE = /\/img\/field-completion\/([^\s?#'"]+\.(?:jpe?g|png|webp))/gi;

function getUploadDir() {
    const env = process.env.FIELD_COMPLETION_UPLOAD_DIR;
    if (env && String(env).trim()) {
        return path.resolve(String(env).trim());
    }
    return path.join(__dirname, '../public/img/field-completion');
}

function getDefaultPublicDir() {
    return path.join(__dirname, '../public/img/field-completion');
}

function usesCustomUploadDir() {
    return path.resolve(getUploadDir()) !== path.resolve(getDefaultPublicDir());
}

function ensureUploadDir() {
    const dir = getUploadDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function extractPathsFromText(text) {
    const out = new Set();
    if (!text || typeof text !== 'string') return out;
    let m;
    const re = new RegExp(IMG_PATH_RE.source, 'gi');
    while ((m = re.exec(text)) !== null) {
        out.add(`${PUBLIC_PREFIX}/${m[1]}`);
    }
    return out;
}

function publicUrlToAbsFile(publicPath) {
    if (!publicPath) return null;
    const s = String(publicPath).trim();
    const m = s.match(/\/img\/field-completion\/([^/?#]+)$/i);
    if (!m) return null;
    return path.join(getUploadDir(), m[1]);
}

function decodeBase64Image(base64Input) {
    if (base64Input == null || base64Input === '') return null;
    let raw = String(base64Input).trim();
    if (!raw) return null;
    if (raw.includes(',')) raw = raw.split(',').pop();
    let buf;
    try {
        buf = Buffer.from(raw, 'base64');
    } catch (e) {
        throw new Error('Format foto tidak valid');
    }
    if (!buf || buf.length < 24) throw new Error('Foto tidak valid');
    const maxMb = parseInt(process.env.FIELD_COMPLETION_MAX_MB || '3', 10);
    const maxBytes = Math.max(512 * 1024, maxMb * 1024 * 1024);
    if (buf.length > maxBytes) {
        throw new Error(`Foto terlalu besar (maks ${maxMb}MB)`);
    }
    return buf;
}

function getFreeDiskMb(dir) {
    try {
        if (typeof fs.statfsSync === 'function') {
            const st = fs.statfsSync(dir);
            return (st.bfree * st.bsize) / (1024 * 1024);
        }
    } catch (_) {}
    return null;
}

function writeFileWithRetry(filePath, buf) {
    const tryWrite = () => fs.writeFileSync(filePath, buf);
    try {
        tryWrite();
    } catch (e) {
        if (e.code !== 'ENOSPC') throw e;
        logger.warn('[field-completion] Disk penuh — cleanup darurat sebelum simpan foto');
        cleanupFieldCompletionImages({ aggressive: true, syncDb: true });
        tryWrite();
    }
}

function saveBuffer(buf, namePrefix) {
    if (!buf || buf.length < 24) throw new Error('Foto tidak valid');
    const minFree = parseInt(process.env.FIELD_COMPLETION_MIN_FREE_MB || '80', 10);
    const freeMb = getFreeDiskMb(getUploadDir());
    if (freeMb != null && freeMb < minFree) {
        logger.warn(`[field-completion] Ruang disk rendah (${Math.round(freeMb)}MB) — cleanup`);
        cleanupFieldCompletionImages({ aggressive: true, syncDb: true });
    }
    const dir = ensureUploadDir();
    const name = `${namePrefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.jpg`;
    const abs = path.join(dir, name);
    writeFileWithRetry(abs, buf);
    return `${PUBLIC_PREFIX}/${name}`;
}

function saveCompletionPhotoFromBase64(base64Input) {
    const buf = decodeBase64Image(base64Input);
    if (!buf) return null;
    return saveBuffer(buf, 'fc');
}

function saveStickerPhotoFromBase64(base64Input) {
    const buf = decodeBase64Image(base64Input);
    if (!buf) return null;
    return saveBuffer(buf, 'ont-sticker');
}

function openBillingDb() {
    const dbPath = path.join(__dirname, '../data/billing.db');
    return new sqlite3.Database(dbPath);
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this.changes);
        });
    });
}

function stripPhotoLinesFromNotes(notes) {
    if (!notes || typeof notes !== 'string') return notes;
    const lines = notes.split(/\r?\n/);
    const kept = lines.filter((line) => {
        const t = line.trim();
        if (/\/img\/field-completion\//i.test(t) && (t.startsWith('📷') || t.includes('field-completion'))) {
            return false;
        }
        return true;
    });
    return kept.join('\n').trim();
}

/**
 * Kumpulkan path publik yang masih dilindungi (job aktif / tiket aktif / retention belum lewat).
 */
async function collectProtectedPublicPaths(db, options = {}) {
    const aggressive = options.aggressive === true;
    const completedDays = aggressive
        ? parseInt(process.env.FIELD_COMPLETION_COMPLETED_RETENTION_DAYS_AGGRESSIVE || '1', 10)
        : parseInt(process.env.FIELD_COMPLETION_COMPLETED_RETENTION_DAYS || '5', 10);
    const orphanHours = aggressive
        ? 6
        : parseInt(process.env.FIELD_COMPLETION_ORPHAN_HOURS || '48', 10);

    const protectedPaths = new Set();
    const pathsToDeleteFromDb = [];

    const jobs = await dbAll(
        db,
        `SELECT id, status, notes, install_ont_sticker_photo_path, updated_at
         FROM installation_jobs`
    );

    const cutoffCompleted = new Date(Date.now() - completedDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');

    for (const job of jobs) {
        const st = String(job.status || '').toLowerCase();
        const isDone = st === 'completed' || st === 'cancelled';
        const paths = new Set();
        if (job.install_ont_sticker_photo_path) paths.add(String(job.install_ont_sticker_photo_path).trim());
        for (const p of extractPathsFromText(job.notes)) paths.add(p);

        if (!isDone) {
            paths.forEach((p) => protectedPaths.add(p));
            continue;
        }

        const updated = job.updated_at || '';
        if (updated && updated >= cutoffCompleted) {
            paths.forEach((p) => protectedPaths.add(p));
        } else {
            for (const p of paths) {
                if (p) pathsToDeleteFromDb.push({ type: 'install', id: job.id, publicPath: p, notes: job.notes });
            }
        }
    }

    const tickets = await dbAll(db, `SELECT id, status, notes, updated_at FROM trouble_reports`);
    const cutoffTicket = new Date(Date.now() - completedDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');

    for (const tr of tickets) {
        const st = String(tr.status || '').toLowerCase();
        const isClosed = st === 'resolved' || st === 'closed';
        const paths = extractPathsFromText(tr.notes);
        if (!isClosed) {
            paths.forEach((p) => protectedPaths.add(p));
            continue;
        }
        const updated = tr.updated_at || '';
        if (updated && updated >= cutoffTicket) {
            paths.forEach((p) => protectedPaths.add(p));
        } else {
            for (const p of paths) {
                pathsToDeleteFromDb.push({ type: 'trouble', id: tr.id, publicPath: p, notes: tr.notes });
            }
        }
    }

    return { protectedPaths, pathsToDeleteFromDb, orphanHours };
}

function safeUnlink(absPath) {
    if (!absPath || !fs.existsSync(absPath)) return false;
    try {
        fs.unlinkSync(absPath);
        return true;
    } catch (e) {
        logger.warn(`[field-completion] Gagal hapus ${absPath}: ${e.message}`);
        return false;
    }
}

/**
 * Hapus foto job selesai yang sudah lewat retention, file yatim, dan opsional bersihkan referensi DB.
 */
function cleanupFieldCompletionImages(options = {}) {
    const syncDb = options.syncDb !== false;
    const dir = getUploadDir();
    if (!fs.existsSync(dir)) {
        return Promise.resolve({ deleted: 0, freedBytes: 0, dbCleared: 0 });
    }

    const db = openBillingDb();
    return collectProtectedPublicPaths(db, options)
        .then(async ({ protectedPaths, pathsToDeleteFromDb, orphanHours }) => {
            let deleted = 0;
            let freedBytes = 0;

            for (const item of pathsToDeleteFromDb) {
                const abs = publicUrlToAbsFile(item.publicPath);
                let size = 0;
                if (abs && fs.existsSync(abs)) {
                    try {
                        size = fs.statSync(abs).size;
                    } catch (_) {}
                }
                if (abs && safeUnlink(abs)) {
                    deleted++;
                    freedBytes += size;
                }
                if (syncDb) {
                    if (item.type === 'install') {
                        const newNotes = stripPhotoLinesFromNotes(item.notes);
                        await dbRun(
                            db,
                            `UPDATE installation_jobs SET install_ont_sticker_photo_path = NULL, notes = ? WHERE id = ?`,
                            [newNotes || null, item.id]
                        );
                    } else if (item.type === 'trouble') {
                        const newNotes = stripPhotoLinesFromNotes(item.notes);
                        await dbRun(db, `UPDATE trouble_reports SET notes = ? WHERE id = ?`, [newNotes || null, item.id]);
                    }
                }
            }

            const orphanCutoff = Date.now() - orphanHours * 60 * 60 * 1000;
            const files = fs.readdirSync(dir);
            for (const fname of files) {
                if (!/\.(jpe?g|png|webp)$/i.test(fname)) continue;
                const abs = path.join(dir, fname);
                const pub = `${PUBLIC_PREFIX}/${fname}`;
                if (protectedPaths.has(pub)) continue;
                let st;
                try {
                    st = fs.statSync(abs);
                } catch (_) {
                    continue;
                }
                if (st.mtimeMs > orphanCutoff && !options.aggressive) continue;
                const size = st.size;
                if (safeUnlink(abs)) {
                    deleted++;
                    freedBytes += size;
                }
            }

            return { deleted, freedBytes: freedBytes, dbCleared: pathsToDeleteFromDb.length };
        })
        .finally(() => {
            db.close();
        });
}

function registerFieldCompletionStatic(app) {
    if (!usesCustomUploadDir()) return;
    const express = require('express');
    const dir = ensureUploadDir();
    app.use(PUBLIC_PREFIX, express.static(dir, { maxAge: '7d' }));
    logger.info(`[field-completion] Static files dari ${dir}`);
}

function scheduleFieldCompletionCleanup() {
    const cron = require('node-cron');
    const { getServerTimezone } = require('../config/settingsManager');
    cron.schedule(
        '15 */4 * * *',
        async () => {
            try {
                const r = await cleanupFieldCompletionImages({ aggressive: false, syncDb: true });
                logger.info(
                    `[field-completion] Scheduled cleanup: ${r.deleted} file, ~${Math.round((r.freedBytes || 0) / 1024)}KB`
                );
            } catch (e) {
                logger.error('[field-completion] Scheduled cleanup failed:', e.message);
            }
        },
        { scheduled: true, timezone: getServerTimezone() }
    );
    logger.info('[field-completion] Cleanup scheduler: setiap 4 jam');
}

module.exports = {
    PUBLIC_PREFIX,
    getUploadDir,
    usesCustomUploadDir,
    ensureUploadDir,
    saveCompletionPhotoFromBase64,
    saveStickerPhotoFromBase64,
    publicUrlToAbsFile,
    cleanupFieldCompletionImages,
    registerFieldCompletionStatic,
    scheduleFieldCompletionCleanup
};
