/**
 * Notifikasi in-app untuk teknisi (mobile): tugas PSB / tiket gangguan dari admin.
 * Disimpan di SQLite; aplikasi polling GET /api/mobile-adapter/notifications.
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('./logger');
const { pingAdminNotifications } = require('./adminNotificationBus');

const dbPath = path.join(__dirname, '../data/billing.db');
const db = new sqlite3.Database(dbPath);
db.run('PRAGMA busy_timeout = 8000');

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
                pingAdminNotifications(String(kind || 'TECH').toUpperCase());
                resolve(this);
            }
        );
    });
}

/** Teknisi hanya boleh menerima notifikasi tugas dari tenant yang sama dengan tugasnya. */
function technicianSharesTenantWith(technicianId, table, refId) {
    const tid = parseInt(technicianId, 10);
    if (!Number.isFinite(tid) || refId == null || refId === '') return Promise.resolve(false);
    return new Promise((resolve) => {
        db.get(
            `SELECT 1 AS ok FROM technicians t
             INNER JOIN ${table} x ON CAST(x.id AS TEXT) = ?
             WHERE t.id = ? AND t.tenant_id IS NOT NULL AND t.tenant_id = x.tenant_id`,
            [String(refId), tid],
            (e, row) => {
                if (e) {
                    logger.error('[technician-field-notifications] tenant check:', e.message);
                    return resolve(false);
                }
                resolve(!!row);
            }
        );
    });
}

async function notifyInstallationJob(technicianId, job) {
    if (!job || !job.id) return;
    if (!(await technicianSharesTenantWith(technicianId, 'installation_jobs', job.id))) {
        logger.warn(`[technician-field-notifications] skip INSTALL ${job.id}: teknisi ${technicianId} beda tenant`);
        return;
    }
    const title = 'Tugas PSB baru';
    const body = `${job.job_number || job.id} — ${job.customer_name || ''}`.trim();
    return upsertTaskNotification(technicianId, 'INSTALL', String(job.id), title, body);
}

async function notifyTroubleTicket(technicianId, report) {
    if (!report || !report.id) return;
    if (!(await technicianSharesTenantWith(technicianId, 'trouble_reports', report.id))) {
        logger.warn(`[technician-field-notifications] skip TR ${report.id}: teknisi ${technicianId} beda tenant`);
        return;
    }
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
