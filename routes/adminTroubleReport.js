const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const { 
  getAllTroubleReports, 
  getTroubleReportById, 
  updateTroubleReportStatus,
  updateTroubleReportAssignment,
  createTroubleReport,
  deleteTroubleReport,
  extractTechnicianCompletion
} = require('../config/troubleReport');

// Middleware admin auth untuk semua route
router.use(adminAuth);

// GET: Halaman daftar semua laporan gangguan
router.get('/', async (req, res) => {
  try {
    // Dapatkan semua laporan gangguan
    const reports = await getAllTroubleReports();
    
    // Hitung jumlah laporan berdasarkan status
    const stats = {
      total: reports.length,
      open: reports.filter(r => r.status === 'open').length,
      inProgress: reports.filter(r => r.status === 'in_progress').length,
      resolved: reports.filter(r => r.status === 'resolved').length,
      closed: reports.filter(r => r.status === 'closed').length
    };
    
    // Render halaman admin laporan gangguan
    res.render('admin/trouble-reports', {
      reports,
      stats,
      title: 'Manajemen Laporan Gangguan'
    });
  } catch (error) {
    console.error('Error loading trouble reports:', error);
    res.status(500).send('Internal Server Error: ' + error.message);
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

// GET: Cari pelanggan (untuk auto fill di form buat tiket)
router.get('/customers/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || q.length < 3) return res.json({ success: true, data: [] });
    
    const dbPath = require('path').join(__dirname, '../data/billing.db');
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(dbPath);
    
    db.all("SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? LIMIT 10", ['%'+q+'%', '%'+q+'%'], (err, rows) => {
      db.close();
      if (err) return res.status(500).json({ success: false, message: 'Database error' });
      res.json({ success: true, data: rows });
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET: Ambil daftar teknisi
router.get('/technicians/list', async (req, res) => {
  try {
    const dbPath = require('path').join(__dirname, '../data/billing.db');
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(dbPath);
    
    db.all("SELECT id, name, role FROM technicians WHERE is_active = 1", [], (err, rows) => {
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
