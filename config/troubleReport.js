const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('./logger');
const billingManager = require('./billing');
const { getTenantId, hasTenantContext } = require('./platform/tenantContext');
const { getSetting, getLocalTimestamp } = require('./settingsManager');
const { sendMessage, setSock } = require('./sendMessage');

function _tWhere(alias = '') {
    const t = billingManager._tenantWhere(alias);
    if (!t.sql) return { sql: '', params: [] };
    const col = alias ? `${alias}.tenant_id` : 'tenant_id';
    return { sql: ` AND ${col} = ?`, params: [...t.params] };
}

function _parseNotes(raw) {
    try {
        return JSON.parse(raw || '[]');
    } catch (_) {
        return [];
    }
}

function pingTroubleProgress() {
    try {
        require('./adminNotificationBus').pingAdminNotifications('TROUBLE_PROGRESS');
    } catch (_) { /* ignore */ }
}

function jakartaYearMonth() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit'
    }).formatToParts(new Date());
    const pick = (type) => {
        const p = parts.find((x) => x.type === type);
        return p ? p.value : '';
    };
    return {
        year: parseInt(pick('year'), 10) || new Date().getFullYear(),
        month: parseInt(pick('month'), 10) || (new Date().getMonth() + 1)
    };
}

function normalizeMonthYear(month, year) {
    const cur = jakartaYearMonth();
    let y = parseInt(year, 10);
    let m = parseInt(month, 10);
    if (!Number.isFinite(y) || y < 2020 || y > cur.year + 2) y = cur.year;
    if (!Number.isFinite(m) || m < 1 || m > 12) m = cur.month;
    return {
        month: m,
        year: y,
        mm: String(m).padStart(2, '0'),
        yyyy: String(y),
        currentMonth: cur.month,
        currentYear: cur.year
    };
}

function dateInPeriod(raw, yyyy, mm) {
    if (!raw) return false;
    const s = String(raw).replace('T', ' ');
    return s.startsWith(`${yyyy}-${mm}`);
}

function dayOfTimestamp(raw) {
    const s = String(raw || '').replace('T', ' ');
    const day = parseInt(s.slice(8, 10), 10);
    return Number.isFinite(day) ? day : 0;
}

function isActiveTroubleStatus(status) {
    const s = String(status || '').toLowerCase().trim();
    return s === 'open' || s === 'in_progress' || s === 'pending' || s === 'baru';
}

function isResolvedTroubleStatus(status) {
    const s = String(status || '').toLowerCase().trim();
    return s === 'resolved' || s === 'closed';
}

function isUnreadProgressRow(row) {
    const progressAt = row && (row.progress_updated_at || row.progressUpdatedAt);
    if (!progressAt) return false;
    const seenAt = row && (row.admin_seen_at || row.adminSeenAt);
    if (!seenAt) return true;
    return new Date(seenAt).getTime() < new Date(progressAt).getTime();
}

let _progressColumnsEnsured = false;
let _troubleReportColumnsCache = null;

/** Tunggu writer lain (invoice, notifikasi, scheduler) alih-alih gagal instan. */
const BUSY_TIMEOUT_MS = 8000;
const BUSY_MAX_ATTEMPTS = 3;

function isSqliteBusyError(err) {
    if (!err) return false;
    const msg = String(err.message || err);
    return err.code === 'SQLITE_BUSY' || /SQLITE_BUSY|database is locked/i.test(msg);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
            else resolve(this);
        });
    });
}

function ensureProgressColumns(db) {
    if (_progressColumnsEnsured) return Promise.resolve();
    return (async () => {
        let rows;
        try {
            rows = await dbAll(db, 'PRAGMA table_info(trouble_reports)');
        } catch (err) {
            logger.warn(`ensureProgressColumns pragma: ${err.message}`);
            return;
        }
        const names = new Set((rows || []).map((r) => r.name));
        const missing = ['progress_updated_at', 'admin_seen_at'].filter((col) => !names.has(col));
        if (!missing.length) {
            _progressColumnsEnsured = true;
            return;
        }
        for (const col of missing) {
            try {
                await dbRun(db, `ALTER TABLE trouble_reports ADD COLUMN ${col} TEXT`);
            } catch (alterErr) {
                const msg = String(alterErr.message || '');
                if (!/duplicate column/i.test(msg)) {
                    logger.warn(`ensureProgressColumns alter ${col}: ${msg}`);
                }
            }
        }
        if (missing.includes('progress_updated_at')) {
            try {
                await dbRun(
                    db,
                    `UPDATE trouble_reports
                     SET progress_updated_at = COALESCE(progress_updated_at, updated_at, created_at)
                     WHERE progress_updated_at IS NULL
                       AND LOWER(TRIM(COALESCE(status,''))) IN ('open','in_progress','pending','baru')`
                );
            } catch (updErr) {
                logger.warn(`ensureProgressColumns backfill: ${updErr.message}`);
            }
            _troubleReportColumnsCache = null;
        }
        try {
            const after = await dbAll(db, 'PRAGMA table_info(trouble_reports)');
            const have = new Set((after || []).map((r) => r.name));
            _progressColumnsEnsured = ['progress_updated_at', 'admin_seen_at'].every((col) => have.has(col));
        } catch (_) {
            _progressColumnsEnsured = false;
        }
    })();
}

// Database helper
const dbPath = path.join(__dirname, '../data/billing.db');
function getDB() {
    const db = new sqlite3.Database(dbPath);
    // Diantrekan lebih dulu supaya statement berikutnya di koneksi ini menunggu kunci.
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return db;
}

// Helper function untuk format tanggal Indonesia yang benar
function formatIndonesianDateTime(date = new Date()) {
  try {
    const targetDate = new Date(date);
    
    const options = {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: '2-digit', 
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    };
    
    const formatter = new Intl.DateTimeFormat('id-ID', options);
    const parts = formatter.formatToParts(targetDate);
    
    const day = parts.find(part => part.type === 'day').value;
    const month = parts.find(part => part.type === 'month').value;
    const year = parts.find(part => part.type === 'year').value;
    const hour = parts.find(part => part.type === 'hour').value;
    const minute = parts.find(part => part.type === 'minute').value;
    const second = parts.find(part => part.type === 'second').value;
    
    return `${day}/${month}/${year} ${hour}:${minute}:${second}`;
  } catch (error) {
    // Fallback manual dengan offset WIB +7
    const d = new Date(date);
    const wibDate = new Date(d.getTime() + 7 * 60 * 60 * 1000);
    const day = wibDate.getUTCDate().toString().padStart(2, '0');
    const month = (wibDate.getUTCMonth() + 1).toString().padStart(2, '0');
    const year = wibDate.getUTCFullYear();
    const hour = wibDate.getUTCHours().toString().padStart(2, '0');
    const minute = wibDate.getUTCMinutes().toString().padStart(2, '0');
    const second = wibDate.getUTCSeconds().toString().padStart(2, '0');
    
    return `${day}/${month}/${year} ${hour}:${minute}:${second}`;
  }
}

// Mendapatkan semua laporan gangguan
async function getAllTroubleReports() {
  const _t = _tWhere('tr');
  return new Promise((resolve, reject) => {
    const db = getDB();
    db.all(`
      SELECT tr.*, t.name AS technician_name, t.phone AS technician_phone
      FROM trouble_reports tr
      LEFT JOIN technicians t
        ON CAST(tr.assigned_technician_id AS TEXT) = CAST(t.id AS TEXT)
      WHERE 1=1${_t.sql}
      ORDER BY tr.created_at DESC
    `, [..._t.params], (err, rows) => {
      db.close();
      if (err) {
        logger.error(`Gagal membaca laporan gangguan: ${err.message}`);
        return reject(err);
      }
      resolve(rows.map(r => ({...r, notes: _parseNotes(r.notes)})));
    });
  });
}

async function countUnreadTroubleProgress() {
  const _t = _tWhere();
  return new Promise((resolve) => {
    const db = getDB();
    ensureProgressColumns(db).then(() => {
      db.get(
        `SELECT COUNT(*) AS n FROM trouble_reports
         WHERE progress_updated_at IS NOT NULL
           AND TRIM(progress_updated_at) != ''
           AND (
             admin_seen_at IS NULL
             OR TRIM(admin_seen_at) = ''
             OR datetime(admin_seen_at) < datetime(progress_updated_at)
           )${_t.sql}`,
        [..._t.params],
        (err, row) => {
          db.close();
          if (err) {
            logger.warn(`countUnreadTroubleProgress: ${err.message}`);
            return resolve(0);
          }
          resolve(Number(row && row.n) || 0);
        }
      );
    });
  });
}

async function markTroubleProgressSeen(reportId = null) {
  const _t = _tWhere();
  const now = getLocalTimestamp();
  return new Promise((resolve) => {
    const db = getDB();
    ensureProgressColumns(db).then(() => {
      const hasId = reportId != null && String(reportId).trim() !== '';
      const sql = hasId
        ? `UPDATE trouble_reports SET admin_seen_at = ?
           WHERE id = ?
             AND progress_updated_at IS NOT NULL${_t.sql}`
        : `UPDATE trouble_reports SET admin_seen_at = ?
           WHERE progress_updated_at IS NOT NULL
             AND (
               admin_seen_at IS NULL
               OR TRIM(admin_seen_at) = ''
               OR datetime(admin_seen_at) < datetime(progress_updated_at)
             )${_t.sql}`;
      const params = hasId
        ? [now, String(reportId).trim(), ..._t.params]
        : [now, ..._t.params];
      db.run(sql, params, function (err) {
        db.close();
        if (err) {
          logger.warn(`markTroubleProgressSeen: ${err.message}`);
          return resolve(0);
        }
        resolve(Number(this.changes) || 0);
      });
    });
  });
}

async function flagTroubleProgressUpdated(reportId) {
  if (reportId == null || String(reportId).trim() === '') return false;
  const _t = _tWhere();
  const now = getLocalTimestamp();
  return new Promise((resolve) => {
    const db = getDB();
    ensureProgressColumns(db).then(() => {
      db.run(
        `UPDATE trouble_reports
         SET progress_updated_at = ?, updated_at = COALESCE(updated_at, ?)
         WHERE id = ?${_t.sql}`,
        [now, now, String(reportId).trim(), ..._t.params],
        function (err) {
          db.close();
          if (err) {
            logger.warn(`flagTroubleProgressUpdated: ${err.message}`);
            return resolve(false);
          }
          if (this.changes > 0) pingTroubleProgress();
          resolve(this.changes > 0);
        }
      );
    });
  });
}

async function getMonthlyTroubleDashboard(month, year) {
  const period = normalizeMonthYear(month, year);
  const all = await getAllTroubleReports();
  const monthReports = all.filter((r) => dateInPeriod(r.created_at || r.createdAt, period.yyyy, period.mm));
  const carryOver = all.filter((r) => {
    return isActiveTroubleStatus(r.status) && !dateInPeriod(r.created_at || r.createdAt, period.yyyy, period.mm);
  });
  const resolvedThisMonth = all.filter((r) => {
    return isResolvedTroubleStatus(r.status) && dateInPeriod(r.updated_at || r.updatedAt, period.yyyy, period.mm);
  });

  const daysInMonth = new Date(period.year, period.month, 0).getDate();
  const dailyCreated = Array(daysInMonth).fill(0);
  const dailyResolved = Array(daysInMonth).fill(0);
  monthReports.forEach((r) => {
    const day = dayOfTimestamp(r.created_at || r.createdAt);
    if (day >= 1 && day <= daysInMonth) dailyCreated[day - 1] += 1;
  });
  all.forEach((r) => {
    if (!isResolvedTroubleStatus(r.status)) return;
    const raw = r.updated_at || r.updatedAt;
    if (!dateInPeriod(raw, period.yyyy, period.mm)) return;
    const day = dayOfTimestamp(raw);
    if (day >= 1 && day <= daysInMonth) dailyResolved[day - 1] += 1;
  });

  const recentProgress = [];
  all.forEach((r) => {
    const notes = Array.isArray(r.notes) ? r.notes : [];
    notes.forEach((n) => {
      if (!n || n.type === 'assignment_change') return;
      if (!dateInPeriod(n.timestamp, period.yyyy, period.mm)) return;
      const content = String(n.content || '').trim();
      if (!content) return;
      recentProgress.push({
        reportId: r.id,
        name: r.name || '',
        phone: r.phone || '',
        status: n.status || r.status,
        content: content.slice(0, 280),
        timestamp: n.timestamp,
        unread: isUnreadProgressRow(r)
      });
    });
  });
  recentProgress.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

  const doneCount = monthReports.filter((r) => isResolvedTroubleStatus(r.status)).length;
  const unreadProgress = all.filter(isUnreadProgressRow).length;

  return {
    period,
    reports: monthReports,
    carryOver,
    recentProgress: recentProgress.slice(0, 12),
    dailyCreated,
    dailyResolved,
    daysInMonth,
    stats: {
      total: monthReports.length,
      open: monthReports.filter((r) => String(r.status || '').toLowerCase() === 'open').length,
      inProgress: monthReports.filter((r) => String(r.status || '').toLowerCase() === 'in_progress').length,
      resolved: monthReports.filter((r) => String(r.status || '').toLowerCase() === 'resolved').length,
      closed: monthReports.filter((r) => String(r.status || '').toLowerCase() === 'closed').length,
      resolvedThisMonth: resolvedThisMonth.length,
      carryOver: carryOver.length,
      doneCount,
      unreadProgress,
      resolutionRate: monthReports.length ? Math.round((doneCount / monthReports.length) * 100) : 0
    }
  };
}

// Mendapatkan laporan gangguan berdasarkan ID
async function getTroubleReportById(id) {
  const _t = _tWhere();
  return new Promise((resolve, reject) => {
    const db = getDB();
    db.get(`SELECT * FROM trouble_reports WHERE id = ?${_t.sql}`, [id, ..._t.params], (err, row) => {
      db.close();
      if (err) return reject(err);
      if (row) {
        row.notes = _parseNotes(row.notes);
      }
      resolve(row || null);
    });
  });
}

// Mendapatkan laporan gangguan berdasarkan nomor pelanggan
async function getTroubleReportsByPhone(phone) {
  const _t = _tWhere();
  return new Promise((resolve, reject) => {
    const db = getDB();
    db.all(`SELECT * FROM trouble_reports WHERE phone = ?${_t.sql} ORDER BY created_at DESC`, [phone, ..._t.params], (err, rows) => {
      db.close();
      if (err) return reject(err);
      resolve(rows.map(r => ({...r, notes: _parseNotes(r.notes)})));
    });
  });
}

// Membuat laporan gangguan baru
async function createTroubleReport(reportData) {
  const id = `TR${Date.now().toString().slice(-6)}${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
  const now = getLocalTimestamp();

  const rawCid = reportData.customer_id ?? reportData.customerId;
  const customerId =
      rawCid != null && String(rawCid).trim() !== '' ? parseInt(String(rawCid), 10) : NaN;
  const customerIdSql = Number.isFinite(customerId) && customerId > 0 ? customerId : null;

  const sql = `
    INSERT INTO trouble_reports (
      id, status, created_at, updated_at, name, phone, location, 
      category, description, assigned_technician_id, priority, notes, customer_id, tenant_id,
      progress_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const tenantId = hasTenantContext() ? getTenantId() : 1;
  const params = [
    id,
    'open',
    now,
    now,
    reportData.name,
    reportData.phone,
    reportData.location,
    reportData.category,
    reportData.description,
    reportData.assigned_technician_id || reportData.assignedTechnicianId,
    reportData.priority || 'Normal',
    JSON.stringify([]),
    customerIdSql,
    tenantId,
    now
  ];

  let lastErr;
  for (let attempt = 0; attempt < BUSY_MAX_ATTEMPTS; attempt++) {
    const db = getDB();
    try {
      await ensureProgressColumns(db);
      await dbRun(db, sql, params);
      try { db.close(); } catch (_) { /* ignore */ }

      const newReport = {
        id,
        status: 'open',
        created_at: now,
        updated_at: now,
        ...reportData,
        notes: []
      };

      try {
        if (getSetting('trouble_report.auto_ticket', 'true') === 'true') {
          sendNotificationToTechnicians(newReport);
        }
      } catch (notificationError) {
        logger.warn('Failed to send technician notification:', notificationError.message);
      }

      try {
        require('./adminNotificationBus').pingAdminNotifications('TROUBLE');
      } catch (_) {}
      return newReport;
    } catch (err) {
      try { db.close(); } catch (_) { /* ignore */ }
      lastErr = err;
      if (!isSqliteBusyError(err) || attempt === BUSY_MAX_ATTEMPTS - 1) {
        logger.error(`Gagal membuat laporan gangguan: ${err.message}`);
        throw err;
      }
      logger.warn(`createTroubleReport SQLITE_BUSY, ulang ${attempt + 1}/${BUSY_MAX_ATTEMPTS - 1}`);
      await sleep(200 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** Cache kolom trouble_reports (untuk UPDATE dinamis). */
function getTroubleReportColumns(db) {
  return new Promise((resolve, reject) => {
    if (_troubleReportColumnsCache) return resolve(_troubleReportColumnsCache);
    db.all('PRAGMA table_info(trouble_reports)', (err, rows) => {
      if (err) return reject(err);
      _troubleReportColumnsCache = new Set((rows || []).map((r) => r.name));
      resolve(_troubleReportColumnsCache);
    });
  });
}

// Update status laporan gangguan
async function updateTroubleReportStatus(id, status, notes, technicalData = {}, sendNotification = true) {
  const currentReport = await getTroubleReportById(id);
  if (!currentReport) return null;

  return new Promise((resolve, reject) => {
    const db = getDB();
    const now = getLocalTimestamp();
    let updatedNotes = currentReport.notes || [];
    
    if (notes) {
      const noteEntry = {
        timestamp: now,
        content: notes,
        status,
        notificationSent: sendNotification
      };
      updatedNotes.push(noteEntry);
    }

    const { odp, sn, signal_level } = technicalData || {};
    const _tw = _tWhere();

    (async () => {
      try {
        await ensureProgressColumns(db);
        const cols = await getTroubleReportColumns(db);
        const setParts = ['status = ?', 'notes = ?', 'updated_at = ?'];
        const params = [status, JSON.stringify(updatedNotes), now];
        if (cols.has('progress_updated_at')) {
          setParts.push('progress_updated_at = ?');
          params.push(now);
        }

        // Sertakan kolom teknis hanya jika ada di skema (hindari "no such column")
        if (cols.has('odp')) {
          setParts.push('odp = ?');
          params.push(odp != null ? odp : currentReport.odp ?? null);
        }
        if (cols.has('sn')) {
          setParts.push('sn = ?');
          params.push(sn != null ? sn : currentReport.sn ?? null);
        }
        if (cols.has('signal_level')) {
          setParts.push('signal_level = ?');
          params.push(signal_level != null ? signal_level : currentReport.signal_level ?? null);
        }

        const sql = `
          UPDATE trouble_reports
          SET ${setParts.join(', ')}
          WHERE id = ?${_tw.sql}
        `;
        params.push(id, ..._tw.params);

        db.run(sql, params, function(err) {
          db.close();
          if (err) {
            logger.error(`Gagal mengupdate status laporan gangguan: ${err.message}`);
            return reject(err);
          }

          const updatedReport = {
            ...currentReport,
            status,
            notes: updatedNotes,
            updated_at: now,
          };
          if (cols.has('odp')) updatedReport.odp = odp != null ? odp : currentReport.odp ?? null;
          if (cols.has('sn')) updatedReport.sn = sn != null ? sn : currentReport.sn ?? null;
          if (cols.has('signal_level')) {
            updatedReport.signal_level =
              signal_level != null ? signal_level : currentReport.signal_level ?? null;
          }

          if (sendNotification) {
            sendStatusUpdateToCustomer(updatedReport);
          }

          pingTroubleProgress();
          resolve(updatedReport);
        });
      } catch (e) {
        try { db.close(); } catch (_) { /* ignore */ }
        logger.error(`Gagal mengupdate status laporan gangguan: ${e.message}`);
        reject(e);
      }
    })();
  });
}

// Ubah penugasan teknisi pada laporan gangguan
async function updateTroubleReportAssignment(id, assignedTechnicianId, adminNote = '') {
  const currentReport = await getTroubleReportById(id);
  if (!currentReport) return null;

  const raw = assignedTechnicianId;
  const parsed =
    raw != null && String(raw).trim() !== '' ? parseInt(String(raw), 10) : NaN;
  const newAssignId = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  const oldAssignId =
    currentReport.assigned_technician_id != null &&
    String(currentReport.assigned_technician_id).trim() !== ''
      ? parseInt(String(currentReport.assigned_technician_id), 10)
      : null;

  return new Promise((resolve, reject) => {
    const db = getDB();
    const now = getLocalTimestamp();
    let updatedNotes = currentReport.notes || [];

    const noteText = String(adminNote || '').trim();
    if (noteText || oldAssignId !== newAssignId) {
      const parts = [];
      if (oldAssignId !== newAssignId) {
        parts.push(
          newAssignId
            ? `Penugasan teknisi diubah ke ID ${newAssignId}`
            : 'Penugasan teknisi dicabut'
        );
      }
      if (noteText) parts.push(noteText);
      updatedNotes.push({
        timestamp: now,
        content: parts.join(' — '),
        status: currentReport.status,
        notificationSent: false,
        type: 'assignment_change'
      });
    }

    const _tw = _tWhere();
    const sql = `
      UPDATE trouble_reports
      SET assigned_technician_id = ?, notes = ?, updated_at = ?
      WHERE id = ?${_tw.sql}
    `;

    db.run(sql, [newAssignId, JSON.stringify(updatedNotes), now, id, ..._tw.params], function (err) {
      db.close();
      if (err) {
        logger.error(`Gagal mengubah penugasan teknisi: ${err.message}`);
        return reject(err);
      }

      resolve({
        ...currentReport,
        assigned_technician_id: newAssignId,
        assignedTechnicianId: newAssignId,
        notes: updatedNotes,
        updated_at: now,
        previous_assigned_technician_id: oldAssignId
      });
    });
  });
}

// Menghapus laporan gangguan
async function deleteTroubleReport(id) {
  const _tw = _tWhere();
  return new Promise((resolve, reject) => {
    const db = getDB();
    db.run(`DELETE FROM trouble_reports WHERE id = ?${_tw.sql}`, [id, ..._tw.params], function(err) {
      db.close();
      if (err) {
        logger.error(`Gagal menghapus laporan gangguan: ${err.message}`);
        return reject(err);
      }
      resolve(this.changes > 0);
    });
  });
}

// Kirim notifikasi ke teknisi dan admin
async function sendNotificationToTechnicians(report) {
  try {
    logger.info(`🔔 Mencoba mengirim notifikasi laporan gangguan ${report.id} ke teknisi dan admin`);

    try {
      const { isWaSystemMonitorEnabled } = require('./whatsappMonitoringSettings');
      if (!(await isWaSystemMonitorEnabled('trouble_report_routing_wa', report?.tenant_id))) {
        logger.info('trouble_report_routing_wa off — skip WA laporan gangguan ke teknisi');
        return false;
      }
    } catch (_) { /* ignore */ }

    const whatsappNotifications = require('./whatsapp-notifications');
    const templates = await whatsappNotifications.getResolvedTemplates(
      whatsappNotifications.resolveTenantId(report.tenant_id)
    );
    if (!whatsappNotifications.isTemplateEnabled('trouble_report_new_technician', templates)) {
      logger.info('Template trouble_report_new_technician nonaktif; lewati notifikasi WA ke teknisi.');
      return false;
    }

    const technicianGroupId = getSetting('technician_group_id', '');
    const tenantId = whatsappNotifications.resolveTenantId(report.tenant_id);

    const tpl = templates.trouble_report_new_technician.template;
    const message = await whatsappNotifications.renderTemplate(tpl, {
      report_id: String(report.id),
      customer_name: report.name || 'N/A',
      phone: report.phone || 'N/A',
      location: report.location || 'N/A',
      category: report.category || 'N/A',
      created_at: formatIndonesianDateTime(new Date(report.created_at || report.createdAt)),
      description: report.description || 'Tidak ada deskripsi',
      status: (report.status || '').toString().toUpperCase()
    }, tenantId);

    let sentSuccessfully = false;
    
    if (technicianGroupId) {
      try {
        const result = await sendMessage(technicianGroupId, message);
        if (result) sentSuccessfully = true;
      } catch (error) {
        logger.error(`❌ Error mengirim ke grup teknisi: ${error.message}`);
      }
    }
    
    const { sendTechnicianMessage } = require('./sendMessage');
    try {
      const techResult = await sendTechnicianMessage(message, 'high');
      if (techResult) sentSuccessfully = true;
    } catch (error) {
      logger.error(`❌ Error mengirim ke nomor teknisi: ${error.message}`);
    }
    
    return sentSuccessfully;
  } catch (error) {
    logger.error(`❌ Error mengirim notifikasi ke teknisi: ${error.message}`);
    return false;
  }
}

// Kirim notifikasi update status ke pelanggan
async function sendStatusUpdateToCustomer(report) {
  try {
    if (!report.phone) return false;

    try {
      const { isWaSystemMonitorEnabled } = require('./whatsappMonitoringSettings');
      if (!(await isWaSystemMonitorEnabled('trouble_report_routing_wa', report?.tenant_id))) {
        logger.info('trouble_report_routing_wa off — skip WA update gangguan ke pelanggan');
        return false;
      }
    } catch (_) { /* ignore */ }

    const whatsappNotifications = require('./whatsapp-notifications');
    const templates = await whatsappNotifications.getResolvedTemplates(
      whatsappNotifications.resolveTenantId(report.tenant_id)
    );
    if (!whatsappNotifications.isTemplateEnabled('trouble_report_customer_update', templates)) {
      logger.info('Template trouble_report_customer_update nonaktif; lewati notifikasi WA ke pelanggan.');
      return false;
    }

    const waJid = report.phone.replace(/^0/, '62') + '@s.whatsapp.net';
    const tenantId = whatsappNotifications.resolveTenantId(report.tenant_id);

    const statusMap = {
      'open': 'Dibuka',
      'in_progress': 'Sedang Ditangani',
      'resolved': 'Terselesaikan',
      'closed': 'Ditutup'
    };

    const latestNote = report.notes && report.notes.length > 0
      ? report.notes[report.notes.length - 1].content
      : '';

    let status_message = '';
    if (report.status === 'open') {
      status_message = 'Laporan Anda telah diterima dan akan segera ditindaklanjuti oleh tim teknisi kami.';
    } else if (report.status === 'in_progress') {
      status_message = 'Tim teknisi kami sedang menangani laporan Anda. Mohon kesabarannya.';
    } else if (report.status === 'resolved') {
      status_message = '✅ Laporan Anda telah diselesaikan. Jika masalah sudah benar-benar teratasi, silakan tutup laporan ini melalui portal pelanggan.';
    } else if (report.status === 'closed') {
      status_message = '🙏 Terima kasih telah menggunakan layanan kami. Laporan ini telah ditutup.';
    }

    const technician_note_section = latestNote
      ? `💬 *Catatan Teknisi*:\n${latestNote}\n\n`
      : '';

    const tpl = templates.trouble_report_customer_update.template;
    const message = await whatsappNotifications.renderTemplate(tpl, {
      report_id: String(report.id),
      updated_at: formatIndonesianDateTime(new Date(report.updated_at || report.updatedAt)),
      status_label: statusMap[report.status] || (report.status || '').toString().toUpperCase(),
      technician_note_section,
      status_message
    }, tenantId);

    await sendMessage(waJid, message);
    return true;
  } catch (error) {
    logger.error(`❌ Error mengirim update status ke pelanggan: ${error.message}`);
    return false;
  }
}

// Fungsi untuk set sock instance
function setSockInstance(sockInstance) {
  setSock(sockInstance);
}

/** Isi dari catatan teknisi di app mobile: [Penyelesaian teknisi] + teks + baris foto opsional */
function extractTechnicianCompletion(report) {
  if (!report || !Array.isArray(report.notes)) {
    return { description: null, photoPath: null, completedAt: null };
  }
  const candidates = report.notes.filter(
    (n) => n && typeof n.content === 'string' && n.content.includes('[Penyelesaian teknisi]')
  );
  if (candidates.length === 0) {
    return { description: null, photoPath: null, completedAt: null };
  }
  candidates.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const n = candidates[0];
  const lines = String(n.content)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length);
  let photoPath = null;
  const descParts = [];
  for (const line of lines) {
    if (line.startsWith('[Penyelesaian teknisi]')) continue;
    const imgMatch = line.match(/(\/img\/field-completion\/[^\s]+\.(?:jpg|jpeg|png|webp))/i);
    if (imgMatch) {
      photoPath = imgMatch[1];
      continue;
    }
    if (line.startsWith('📷')) {
      const m2 = line.match(/(\/img\/[^\s]+)/);
      if (m2) photoPath = m2[1];
      continue;
    }
    descParts.push(line);
  }
  return {
    description: descParts.join('\n').trim() || null,
    photoPath,
    completedAt: n.timestamp || null
  };
}

module.exports = {
  getAllTroubleReports,
  getTroubleReportById,
  getTroubleReportsByPhone,
  createTroubleReport,
  deleteTroubleReport,
  updateTroubleReportStatus,
  updateTroubleReportAssignment,
  sendNotificationToTechnicians,
  sendStatusUpdateToCustomer,
  setSockInstance,
  extractTechnicianCompletion,
  countUnreadTroubleProgress,
  markTroubleProgressSeen,
  flagTroubleProgressUpdated,
  getMonthlyTroubleDashboard,
  normalizeMonthYear
};
