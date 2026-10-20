const express = require('express');
const router = express.Router();
const billingManager = require('../config/billing');
const { attachTenantAppSettings } = require('../config/platform/tenantAppSettings');
const { adminAuth } = require('./adminAuth');
const { 
  getTroubleReportById, 
  updateTroubleReportStatus,
  updateTroubleReportAssignment,
  createTroubleReport,
  deleteTroubleReport,
  extractTechnicianCompletion,
  getMonthlyTroubleDashboard,
  countUnreadTroubleProgress,
  markTroubleProgressSeen
} = require('../config/troubleReport');

function tAnd(alias = '') {
  const t = billingManager._tenantWhere(alias);
  if (!t.sql) return '';
  const col = alias ? `${alias}.tenant_id` : 'tenant_id';
  return ` AND ${col} = ${parseInt(t.params[0], 10)}`;
}

router.use(adminAuth);
router.use(attachTenantAppSettings);

// GET: Dashboard bulanan laporan gangguan
router.get('/', async (req, res) => {
  try {
    const dash = await getMonthlyTroubleDashboard(req.query.month, req.query.year);

    // Manager Area: filter laporan ke pelanggan di wilayah yang ditugaskan
    if (req.isAreaManager || (req.session && req.session.isAreaManager)) {
      const areaIds = req.areaManagerAreaIds || [];
      const phoneOk = new Set();
      if (areaIds.length) {
        const match = billingManager._sqlCustomerInAreaIds('c', areaIds);
        const rows = await new Promise((resolve) => {
          billingManager.db.all(
            `SELECT phone FROM customers c WHERE ${match.clause}`,
            match.params,
            (err, r) => resolve(err ? [] : r || [])
          );
        });
        rows.forEach((r) => {
          if (r.phone) phoneOk.add(String(r.phone).trim());
        });
      }
      const inScope = (r) => phoneOk.has(String(r.phone || '').trim());
      dash.reports = (dash.reports || []).filter(inScope);
      dash.carryOver = (dash.carryOver || []).filter(inScope);
      dash.recentProgress = (dash.recentProgress || []).filter(inScope);
      const doneCount = dash.reports.filter((r) =>
        ['resolved', 'closed'].includes(String(r.status || '').toLowerCase())
      ).length;
      dash.stats = {
        ...dash.stats,
        total: dash.reports.length,
        open: dash.reports.filter((r) => String(r.status || '').toLowerCase() === 'open').length,
        inProgress: dash.reports.filter((r) => String(r.status || '').toLowerCase() === 'in_progress').length,
        resolved: dash.reports.filter((r) => String(r.status || '').toLowerCase() === 'resolved').length,
        closed: dash.reports.filter((r) => String(r.status || '').toLowerCase() === 'closed').length,
        carryOver: dash.carryOver.length,
        doneCount,
        resolutionRate: dash.reports.length ? Math.round((doneCount / dash.reports.length) * 100) : 0
      };
    }

    const unreadBefore = dash.stats.unreadProgress || 0;
    if (typeof req.query.keepUnread === 'undefined') {
      await markTroubleProgressSeen(null);
      dash.stats.unreadProgress = 0;
    }

    const monthNames = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
    const monthLabel = `${monthNames[dash.period.month - 1]} ${dash.period.year}`;

    res.render('admin/trouble-reports', {
      reports: dash.reports,
      carryOver: dash.carryOver,
      recentProgress: dash.recentProgress,
      dailyCreated: dash.dailyCreated,
      dailyResolved: dash.dailyResolved,
      daysInMonth: dash.daysInMonth,
      stats: dash.stats,
      selectedMonth: dash.period.month,
      selectedYear: dash.period.year,
      currentMonth: dash.period.currentMonth,
      currentYear: dash.period.currentYear,
      monthLabel,
      unreadBefore,
      title: 'Dashboard Gangguan Bulanan'
    });
  } catch (error) {
    console.error('Error loading trouble reports:', error);
    res.status(500).send('Internal Server Error: ' + error.message);
  }
});

router.get('/api/progress-badge', async (req, res) => {
  try {
    const count = await countUnreadTroubleProgress();
    res.json({ success: true, count });
  } catch (error) {
    res.status(500).json({ success: false, count: 0, message: error.message });
  }
});

router.post('/api/mark-seen', async (req, res) => {
  try {
    const reportId = (req.body && req.body.reportId) || req.query.reportId || null;
    const changed = await markTroubleProgressSeen(reportId);
    const count = await countUnreadTroubleProgress();
    res.json({ success: true, changed, count });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET: Halaman detail laporan gangguan
router.get('/detail/:id', async (req, res) => {
  try {
    const reportId = req.params.id;
    
    // Dapatkan detail laporan
    const report = await getTroubleReportById(reportId);
    
    // Validasi laporan ditemukan
    if (!report) {
      req.flash('error', 'Laporan gangguan tidak ditemukan');
      return res.redirect('/admin/trouble');
    }

    markTroubleProgressSeen(reportId).catch(() => {});
    
    const appPublicBase = (process.env.PUBLIC_APP_BASE_URL || '').replace(/\/$/, '');
    // Render halaman detail laporan
    res.render('admin/trouble-report-detail', {
      report,
      title: `Detail Laporan #${reportId}`,
      technicianCompletion: extractTechnicianCompletion(report),
      appPublicBase
    });
  } catch (error) {
    console.error('Error loading trouble report detail:', error);
    res.status(500).send('Internal Server Error: ' + error.message);
  }
});

// POST: Update status laporan gangguan
router.post('/update-status/:id', async (req, res) => {
  const reportId = req.params.id;
  const { status, notes, sendNotification } = req.body;
  
  // Validasi status
  const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      message: 'Status tidak valid'
    });
  }
  
  const notify =
    sendNotification === false ||
    sendNotification === 'false' ||
    sendNotification === 0
      ? false
      : true;
  
  const updatedReport = await updateTroubleReportStatus(reportId, status, notes, {}, notify);
  
  if (!updatedReport) {
    return res.status(500).json({
      success: false,
      message: 'Gagal mengupdate status laporan'
    });
  }

  markTroubleProgressSeen(reportId).catch(() => {});
  
  res.json({
    success: true,
    message: 'Catatan berhasil disimpan' + (notify ? ' dan notifikasi dikirim ke pelanggan.' : '.'),
    report: updatedReport
  });
});

// POST: Tambah catatan pada laporan tanpa mengubah status
router.post('/add-note/:id', async (req, res) => {
  const reportId = req.params.id;
  const { notes } = req.body;
  
  // Dapatkan detail laporan untuk mendapatkan status saat ini
  const report = await getTroubleReportById(reportId);
  
  if (!report) {
    return res.status(404).json({
      success: false,
      message: 'Laporan tidak ditemukan'
    });
  }
  
  // Update laporan dengan catatan baru tanpa mengubah status
  const updatedReport = await updateTroubleReportStatus(reportId, report.status, notes);
  
  if (!updatedReport) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menambahkan catatan'
    });
  }

  markTroubleProgressSeen(reportId).catch(() => {});
  
  res.json({
    success: true,
    message: 'Catatan berhasil ditambahkan',
    report: updatedReport
  });
});

// POST: Hapus laporan gangguan
router.delete('/delete/:id', async (req, res) => {
  try {
    const reportId = req.params.id;
    const deleted = await deleteTroubleReport(reportId);
    
    if (deleted) {
      res.json({ success: true, message: 'Laporan berhasil dihapus' });
    } else {
      res.status(404).json({ success: false, message: 'Laporan tidak ditemukan' });
    }
  } catch (error) {
    console.error('Error delete trouble report:', error);
    res.status(500).json({ success: false, message: 'Gagal menghapus laporan' });
  }
});

// GET: Cari pelanggan (untuk auto fill di form buat tiket) — sama dengan Kelola Pelanggan
function resolveTroubleTenantId(req) {
  const raw = req?.tenantId ?? req?.tenant?.id ?? req?.session?.tenantId ?? null;
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

router.get('/customers/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ success: true, data: [] });

    const tenantId = resolveTroubleTenantId(req);
    const searchOpts = {
      tenantId: tenantId || undefined,
      limit: 100
    };
    let rows = await billingManager.searchCustomers(q, searchOpts);
    if (req.isAreaManager || (req.session && req.session.isAreaManager)) {
      const areaIds = req.areaManagerAreaIds || [];
      const allowed = new Set(areaIds.map(Number));
      rows = (rows || []).filter((c) => c.area_id != null && allowed.has(Number(c.area_id)));
    }
    const data = (rows || []).map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      address: c.address || '',
      username: c.username || c.pppoe_username || '',
      pppoe_username: c.pppoe_username || '',
      customer_id: c.customer_id || '',
      status: c.status || ''
    }));
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error search customers for trouble ticket:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET: Ambil daftar teknisi
router.get('/technicians/list', async (req, res) => {
  try {
    const dbPath = require('path').join(__dirname, '../data/billing.db');
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(dbPath);
    db.run('PRAGMA busy_timeout = 8000');
    
    db.all(`SELECT id, name, role FROM technicians WHERE is_active = 1${tAnd('')}`, [], (err, rows) => {
      db.close();
      if (err) return res.status(500).json({ success: false, message: 'Database error' });
      res.json({ success: true, technicians: rows });
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT: Ubah penugasan teknisi pada tiket gangguan
router.put('/assign/:id', async (req, res) => {
  try {
    const reportId = req.params.id;
    const { assignedTechnicianId, notes } = req.body || {};

    const updatedReport = await updateTroubleReportAssignment(
      reportId,
      assignedTechnicianId,
      notes
    );

    if (!updatedReport) {
      return res.status(404).json({
        success: false,
        message: 'Laporan gangguan tidak ditemukan'
      });
    }

    const assignNum = parseInt(
      updatedReport.assigned_technician_id ?? updatedReport.assignedTechnicianId,
      10
    );
    if (Number.isFinite(assignNum) && assignNum > 0) {
      try {
        const fieldNotif = require('../config/technicianFieldNotifications');
        await fieldNotif.notifyTroubleTicket(assignNum, updatedReport);
      } catch (nfErr) {
        console.error('Field notification trouble assign:', nfErr.message || nfErr);
      }
    }

    res.json({
      success: true,
      message: assignNum > 0 ? 'Penugasan teknisi berhasil diperbarui' : 'Penugasan teknisi dicabut',
      report: updatedReport
    });
  } catch (error) {
    console.error('Error updating trouble assignment:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal memperbarui penugasan: ' + error.message
    });
  }
});

// POST: Buat tiket laporan gangguan baru dari admin
router.post('/create', async (req, res) => {
  try {
    const { name, phone, location, category, description, assignedTechnicianId, priority, customerId } = req.body;
    
    // Note: createTroubleReport will automatically send notification when auto_ticket setting is true
    const newReport = await createTroubleReport({
      name,
      phone,
      location,
      category,
      description,
      assignedTechnicianId,
      priority,
      customerId
    });

    if (newReport && newReport.id) {
      markTroubleProgressSeen(newReport.id).catch(() => {});
    }

    const assignTid = newReport.assigned_technician_id || newReport.assignedTechnicianId;
    try {
      const fieldNotif = require('../config/technicianFieldNotifications');
      const assignNum = parseInt(assignTid, 10);
      if (Number.isFinite(assignNum) && assignNum > 0) {
        await fieldNotif.notifyTroubleTicket(assignNum, newReport);
      } else {
        // Jika tidak di-assign, broadcast ke semua teknisi aktif agar tiket tampil sebagai notifikasi baru.
        const dbPath = require('path').join(__dirname, '../data/billing.db');
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database(dbPath);
        db.run('PRAGMA busy_timeout = 8000');
        const techRows = await new Promise((resolve, reject) => {
          db.all(
            `SELECT id FROM technicians
             WHERE is_active = 1
               AND LOWER(IFNULL(role, 'technician')) = 'technician'`,
            [],
            (err, rows) => {
              db.close();
              if (err) return reject(err);
              resolve(rows || []);
            }
          );
        });
        for (const tr of techRows) {
          const tid = parseInt(tr.id, 10);
          if (Number.isFinite(tid) && tid > 0) {
            await fieldNotif.notifyTroubleTicket(tid, newReport);
          }
        }
      }
    } catch (nfErr) {
      console.error('Field notification trouble create:', nfErr.message || nfErr);
    }
    
    res.json({ success: true, message: 'Tiket berhasil dibuat', report: newReport });
  } catch (error) {
    console.error('Error creating ticket:', error);
    res.status(500).json({ success: false, message: 'Gagal membuat tiket: ' + error.message });
  }
});

module.exports = router;
