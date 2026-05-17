/**
 * Notifikasi in-app untuk teknisi (mobile): tugas PSB / tiket gangguan dari admin.
 * Disimpan di SQLite; aplikasi polling GET /api/mobile-adapter/notifications.
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('./logger');

const dbPath = path.join(__dirname, '../data/billing.db');
const db = new sqlite3.Database(dbPath);

db.run(
    `CREATE TABLE IF NOT EXISTS technician_field_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        technician_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        read_at TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(technician_id, kind, ref_id)
    )`,
    (err) => {
        if (err) {
            logger.error('[technician-field-notifications] create table:', err.message);
        }
    }
);

function upsertTaskNotification(technicianId, kind, refId, title, body) {
    const tid = parseInt(technicianId, 10);
    if (!Number.isFinite(tid) || !kind || refId == null || refId === '') {
        return Promise.resolve();
    }
    const rid = String(refId);
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO technician_field_notifications (technician_id, kind, ref_id, title, body, read_at, created_at)
             VALUES (?, ?, ?, ?, ?, NULL, datetime('now','localtime'))
             ON CONFLICT(technician_id, kind, ref_id) DO UPDATE SET
               title = excluded.title,
               body = excluded.body,
               read_at = NULL,
               created_at = datetime('now','localtime')`,
            [tid, String(kind).toUpperCase(), rid, String(title || 'Tugas baru'), body || null],
            function (e) {
                if (e) {
                    logger.error('[technician-field-notifications] upsert:', e.message);
                    return reject(e);
                }
                resolve(this);
            }
        );
    });
}

function notifyInstallationJob(technicianId, job) {
    if (!job || !job.id) return Promise.resolve();
    const title = 'Tugas PSB baru';
    const body = `${job.job_number || job.id} — ${job.customer_name || ''}`.trim();
    return upsertTaskNotification(technicianId, 'INSTALL', String(job.id), title, body);
}

function notifyTroubleTicket(technicianId, report) {
    if (!report || !report.id) return Promise.resolve();
    const title = 'Tiket gangguan baru';
    const body = `${report.id} — ${report.name || ''} · ${report.category || ''}`.trim();
    return upsertTaskNotification(technicianId, 'TR', String(report.id), title, body);
}

/** Hapus notifikasi jenis LEAVE yang lebih tua dari 30 hari. */
function pruneLeaveNotificationsOlderThanDays(days) {
    const d = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.min(365, Math.floor(Number(days))) : 30;
    const mod = `-${d} days`;
    return new Promise((resolve, reject) => {
        db.run(
            `DELETE FROM technician_field_notifications
             WHERE UPPER(TRIM(kind)) = 'LEAVE'
               AND datetime(created_at) < datetime('now', ?)`,
            [mod],
            function (e) {
                if (e) {
                    logger.error('[technician-field-notifications] prune LEAVE:', e.message);
                    return reject(e);
                }
                resolve(this.changes);
            }
        );
    });
}

/**
 * Admin menyetujui / menolak izin-cuti — teknisi lihat di polling notifikasi mobile.
 * ref_id = id baris employee_leave_requests (unik per teknisi + kind + ref_id).
 */
function notifyLeaveDecision(technicianId, leaveRequestId, approved, bodyText) {
    const tid = parseInt(technicianId, 10);
    if (!Number.isFinite(tid) || tid <= 0 || leaveRequestId == null || leaveRequestId === '') {
        return Promise.resolve();
    }
    const title = approved ? 'Izin/cuti disetujui' : 'Izin/cuti ditolak';
    const body = bodyText != null ? String(bodyText).trim().slice(0, 500) : null;
    return pruneLeaveNotificationsOlderThanDays(30).then(() =>
        upsertTaskNotification(tid, 'LEAVE', String(leaveRequestId), title, body)
    );
}

module.exports = {
    upsertTaskNotification,
    notifyInstallationJob,
    notifyTroubleTicket,
    pruneLeaveNotificationsOlderThanDays,
    notifyLeaveDecision
};
