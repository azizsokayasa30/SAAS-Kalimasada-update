const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { adminAuth } = require('./adminAuth');
const { getRadiusConfig, saveRadiusConfig } = require('../config/radiusConfig');
const logger = require('../config/logger');
const { getRadiusConnection } = require('../config/mikrotik');
const { getRadiusSqliteFileDiagnostics } = require('../config/radiusSQLite');
const { getRadiusConsistencyReport } = require('../config/radiusConsistency');
const {
  parseClientsConf,
  parseClientsConfFromDB,
  writeClientsConf,
  writeClientsConfToDB,
  restartFreeRADIUS,
  validateClient,
  getRadiusClientsConfReadDiagnostics
} = require('../config/radiusClients');
const { backupRadius, restoreRadius, listBackups } = require('../utils/radiusBackup');

// Configure multer for file upload
const upload = multer({
    dest: path.join(__dirname, '../temp/uploads'),
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB max
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/gzip' || 
            file.mimetype === 'application/x-gzip' ||
            file.originalname.endsWith('.tar.gz') ||
            file.originalname.endsWith('.gz')) {
            cb(null, true);
        } else {
            cb(new Error('Hanya file backup (.tar.gz) yang diizinkan'));
        }
    }
});

// GET: Halaman Setting RADIUS
router.get('/radius', adminAuth, async (req, res) => {
  try {
    // Ambil dari database, bukan settings.json
    const settings = await getRadiusConfig();
    // Force mode RADIUS (100% RADIUS mode)
    settings.user_auth_mode = 'radius';
    
    // Get list of backups
    let backups = [];
    try {
      backups = await listBackups();
    } catch (backupError) {
      logger.warn('Error loading backups list:', backupError);
      backups = [];
    }
    
    res.render('adminRadius', {
      settings,
      backups: backups || [],
      page: 'setting-radius',
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (e) {
    logger.error('Error loading radius config:', e);
    
    // Get list of backups even on error
    let backups = [];
    try {
      backups = await listBackups();
    } catch (backupError) {
      logger.warn('Error loading backups list:', backupError);
      backups = [];
    }
    
    res.render('adminRadius', {
      settings: {
        user_auth_mode: 'radius', // Always RADIUS mode
        radius_host: 'localhost',
        radius_user: 'billing',
        radius_password: '',
        radius_database: 'radius'
      },
      backups: backups || [],
      page: 'setting-radius',
      error: 'Gagal memuat pengaturan RADIUS',
      success: null
    });
  }
});

// POST: Simpan Setting RADIUS
router.post('/radius', adminAuth, async (req, res) => {
  try {
    const { radius_host, radius_user, radius_password, radius_database } = req.body;

    // Force mode RADIUS (100% RADIUS mode - tidak ada opsi Mikrotik API)
    const user_auth_mode = 'radius';

    // Simpan ke database (app_settings table)
    await saveRadiusConfig({
      user_auth_mode: user_auth_mode, // Always 'radius'
      radius_host: radius_host ? radius_host.trim() : 'localhost',
      radius_user: radius_user ? radius_user.trim() : 'billing',
      radius_password: radius_password || '',
      radius_database: radius_database ? radius_database.trim() : 'radius'
    });

    // Reload untuk ditampilkan
    const settings = await getRadiusConfig();
    // Force mode RADIUS (100% RADIUS mode)
    settings.user_auth_mode = 'radius';
    
    // Get list of backups
    let backups = [];
    try {
      backups = await listBackups();
    } catch (backupError) {
      logger.warn('Error loading backups list:', backupError);
      backups = [];
    }
    
    res.render('adminRadius', {
      settings,
      backups: backups || [],
      page: 'setting-radius',
      error: null,
      success: 'Pengaturan RADIUS berhasil disimpan ke database'
    });
  } catch (e) {
    logger.error('Error saving radius config:', e);
    const settings = await getRadiusConfig().catch(() => ({
      user_auth_mode: 'radius', // Always RADIUS mode
      radius_host: 'localhost',
      radius_user: 'radius',
      radius_password: '',
      radius_database: 'radius'
    }));
    
    // Force mode RADIUS
    settings.user_auth_mode = 'radius';
    
    // Get list of backups
    let backups = [];
    try {
      backups = await listBackups();
    } catch (backupError) {
      logger.warn('Error loading backups list:', backupError);
      backups = [];
    }
    
    res.render('adminRadius', {
      settings,
      backups: backups || [],
      page: 'setting-radius',
      error: 'Gagal menyimpan pengaturan RADIUS: ' + e.message,
      success: null
    });
  }
});

// POST: Sync password FreeRADIUS dengan password database billing
router.post('/radius/sync-password', adminAuth, async (req, res) => {
  try {
    const { syncRadiusPassword } = require('../utils/syncRadiusPassword');
    const result = await syncRadiusPassword();
    
    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        oldPassword: result.oldPassword ? '***' : null,
        newPassword: '***'
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.message
      });
    }
  } catch (error) {
    logger.error('Error syncing RADIUS password:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal sync password: ' + error.message
    });
  }
});

// GET: Check password sync status
router.get('/radius/check-password-sync', adminAuth, async (req, res) => {
  try {
    const { checkPasswordSync } = require('../utils/syncRadiusPassword');
    const status = await checkPasswordSync();
    
    res.json({
      success: true,
      synced: status.synced,
      needsSync: !status.synced,
      billingPassword: status.billingPassword ? '***' : null,
      freeradiusPassword: status.freeradiusPassword ? '***' : null,
      error: status.error
    });
  } catch (error) {
    logger.error('Error checking password sync:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal cek status sync: ' + error.message
    });
  }
});

// GET: Check RADIUS service status
router.get('/radius/status', adminAuth, async (req, res) => {
  try {
    let serviceStatus = 'unknown';
    let serviceError = null;
    let dbStatus = 'unknown';
    let dbError = null;
    let overallStatus = 'unknown'; // 'running', 'error', 'not_running'
    let statusMessage = '';

    // Check FreeRADIUS service status
    try {
      const { stdout, stderr } = await execAsync('systemctl is-active freeradius', { timeout: 5000 });
      serviceStatus = stdout.trim();
      
      // Check if service is active
      if (serviceStatus === 'active') {
        serviceStatus = 'running';
      } else if (serviceStatus === 'inactive' || serviceStatus === 'failed') {
        serviceStatus = 'not_running';
      } else {
        serviceStatus = 'unknown';
      }
    } catch (error) {
      serviceError = error.message;
      // Try alternative check
      try {
        const { stdout } = await execAsync('pgrep -x freeradius || echo "not_running"', { timeout: 3000 });
        if (stdout.trim() === 'not_running') {
          serviceStatus = 'not_running';
        } else {
          serviceStatus = 'running';
        }
      } catch (altError) {
        serviceStatus = 'not_running';
        serviceError = error.message;
      }
    }

    // Check database connection
    try {
      const settings = await getRadiusConfig();
      const conn = await getRadiusConnection();
      const [testRows] = await conn.execute('SELECT 1 as test');
      await conn.end();
      
      if (testRows && testRows[0] && testRows[0].test === 1) {
        dbStatus = 'connected';
      } else {
        dbStatus = 'error';
        dbError = 'Database test query failed';
      }
    } catch (error) {
      dbStatus = 'error';
      dbError = error.message;
    }

    // Determine overall status
    if (serviceStatus === 'running' && dbStatus === 'connected') {
      overallStatus = 'running';
      statusMessage = 'RADIUS berjalan normal';
    } else if (serviceStatus === 'not_running') {
      overallStatus = 'not_running';
      statusMessage = 'RADIUS service tidak berjalan';
    } else if (serviceStatus === 'running' && dbStatus === 'error') {
      overallStatus = 'error';
      statusMessage = 'RADIUS service berjalan tapi ada masalah koneksi database';
    } else if (serviceStatus === 'unknown' || dbStatus === 'error') {
      overallStatus = 'error';
      statusMessage = 'Ada masalah pada RADIUS: ' + (serviceError || dbError || 'Unknown error');
    } else {
      overallStatus = 'error';
      statusMessage = 'Status tidak dapat ditentukan';
    }

    res.json({
      success: true,
      status: overallStatus,
      message: statusMessage,
      details: {
        service: {
          status: serviceStatus,
          error: serviceError
        },
        database: {
          status: dbStatus,
          error: dbError
        }
      }
    });
  } catch (error) {
    logger.error('Error checking RADIUS status:', error);
    res.json({
      success: false,
      status: 'error',
      message: 'Gagal memeriksa status RADIUS: ' + error.message,
      error: error.message
    });
  }
});

// GET: Test koneksi RADIUS
router.get('/radius/test', adminAuth, async (req, res) => {
  try {
    const settings = await getRadiusConfig();
    
    if (settings.user_auth_mode !== 'radius') {
      return res.json({
        success: false,
        message: 'Mode bukan RADIUS. Test hanya untuk mode RADIUS.',
        mode: settings.user_auth_mode
      });
    }
    
    const sqliteDiag = await getRadiusSqliteFileDiagnostics();
    let consistency = null;
    try {
      consistency = await getRadiusConsistencyReport();
    } catch (ce) {
      logger.warn('[RADIUS] consistency check failed:', ce.message);
      consistency = { ok: false, warnings: [`Gagal memuat laporan konsistensi: ${ce.message}`], notes: [] };
    }

    const conn = await getRadiusConnection();

    const [testRows] = await conn.execute('SELECT 1 as test');
    const testList = Array.isArray(testRows) ? testRows : [];
    const testResult = testList[0]?.test;

    const [userCount] = await conn.execute(`
      SELECT COUNT(DISTINCT username) as total
      FROM radcheck
      WHERE LOWER(TRIM(attribute)) IN (
        'cleartext-password','user-password','crypt-password','md5-password',
        'sha-password','smd5-password','mikrotik-password'
      )
    `);
    const ucList = Array.isArray(userCount) ? userCount : [];
    const totalUsers = ucList[0]?.total || 0;

    let activeConnections = 0;
    try {
      const [activeCount] = await conn.execute(`
      SELECT COUNT(DISTINCT ra.username) as active
      FROM radacct ra
      JOIN radcheck rc
        ON rc.username = ra.username
       AND LOWER(TRIM(rc.attribute)) IN (
         'cleartext-password','user-password','crypt-password','md5-password',
         'sha-password','smd5-password','mikrotik-password'
       )
      WHERE (ra.acctstoptime IS NULL OR ra.acctstoptime = '' OR ra.acctstoptime = '0' OR ra.acctstoptime = '0000-00-00 00:00:00')
    `);
      const acList = Array.isArray(activeCount) ? activeCount : [];
      activeConnections = acList[0]?.active || 0;
    } catch (_) {
      activeConnections = 0;
    }

    await conn.end();

    res.json({
      success: true,
      message: 'Koneksi ke RADIUS database berhasil!',
      sqlite: sqliteDiag,
      consistency,
      connection: {
        host: settings.radius_host || 'localhost',
        database: settings.radius_database || 'radius',
        user: settings.radius_user || 'radius',
        status: 'connected',
        resolvedSqlitePath: sqliteDiag.dbPath,
        pathSource: sqliteDiag.source
      },
      statistics: {
        totalUsers: totalUsers,
        activeConnections: activeConnections,
        offlineUsers: Math.max(totalUsers - activeConnections, 0)
      },
      testQuery: testResult === 1 ? 'OK' : 'FAILED'
    });
  } catch (error) {
    logger.error('Error testing RADIUS connection:', error);
    res.json({
      success: false,
      message: 'Gagal koneksi ke RADIUS database: ' + error.message,
      error: error.message,
      connection: {
        status: 'failed'
      }
    });
  }
});

// POST: Sinkronisasi & hapus user yatim (orphan users) di RADIUS (root version)
router.post('/radius/sync-orphan-users', adminAuth, async (req, res) => {
  let conn = null;
  try {
    const settings = await getRadiusConfig();
    if (settings.user_auth_mode !== 'radius') {
      return res.json({
        success: false,
        message: 'Mode bukan RADIUS. Sync/hapus orphan hanya untuk mode RADIUS.',
        mode: settings.user_auth_mode
      });
    }

    conn = await getRadiusConnection();

    const sqlite3 = require('sqlite3').verbose();
    const billingDbPath = path.join(__dirname, '../data/billing.db');

    // Ambil daftar username yang "ada di aplikasi"
    const allowedUsernames = new Set();
    const billingDb = new sqlite3.Database(billingDbPath);

    const customersPromise = new Promise((resolve) => {
      billingDb.all(`
        SELECT DISTINCT pppoe_username
        FROM customers
        WHERE pppoe_username IS NOT NULL
          AND pppoe_username != ''
      `, [], (err, rows) => {
        if (!err && Array.isArray(rows)) {
          rows.forEach(r => { if (r.pppoe_username) allowedUsernames.add(String(r.pppoe_username).trim()); });
        }
        resolve();
      });
    });

    const membersPromise = new Promise((resolve) => {
      billingDb.all(`
        SELECT DISTINCT hotspot_username
        FROM members
        WHERE hotspot_username IS NOT NULL
          AND hotspot_username != ''
      `, [], (err, rows) => {
        if (!err && Array.isArray(rows)) {
          rows.forEach(r => { if (r.hotspot_username) allowedUsernames.add(String(r.hotspot_username).trim()); });
        }
        resolve();
      });
    });

    const memberNormalPromise = new Promise((resolve) => {
      billingDb.all(`
        SELECT DISTINCT username
        FROM members
        WHERE (hotspot_username IS NULL OR hotspot_username = '')
          AND username IS NOT NULL
          AND username != ''
      `, [], (err, rows) => {
        if (!err && Array.isArray(rows)) {
          rows.forEach(r => { if (r.username) allowedUsernames.add(String(r.username).trim()); });
        }
        resolve();
      });
    });

    const vouchersPromise = new Promise((resolve) => {
      billingDb.all(`
        SELECT DISTINCT username
        FROM voucher_revenue
        WHERE username IS NOT NULL
          AND username != ''
      `, [], (err, rows) => {
        if (!err && Array.isArray(rows)) {
          rows.forEach(r => { if (r.username) allowedUsernames.add(String(r.username).trim()); });
        }
        resolve();
      });
    });

    await Promise.all([customersPromise, membersPromise, memberNormalPromise, vouchersPromise]);
    billingDb.close();

    // Ambil orphan dari radcheck
    const [radcheckRows] = await conn.execute(`
      SELECT DISTINCT username
      FROM radcheck
      WHERE attribute = 'Cleartext-Password'
    `);

    const orphanUsers = (radcheckRows || []).map(r => String(r.username).trim())
      .filter(u => u && !allowedUsernames.has(u));

    let orphanUsersFound = orphanUsers.length;
    let orphanUsersDeleted = 0;
    let endedRadacctActive = 0;
    let pppoeDisconnectAttempts = 0;

    await conn.execute('BEGIN');
    try {
      for (const u of orphanUsers) {
        const [updateRow] = await conn.execute(
          "UPDATE radacct SET acctstoptime = datetime('now','localtime') WHERE username = ? AND (acctstoptime IS NULL OR acctstoptime = '' OR acctstoptime = '0' OR acctstoptime = '0000-00-00 00:00:00')",
          [u]
        );
        endedRadacctActive += updateRow?.affectedRows || 0;

        await conn.execute("DELETE FROM radusergroup WHERE username = ?", [u]);
        await conn.execute("DELETE FROM radreply WHERE username = ?", [u]);
        await conn.execute("DELETE FROM radcheck WHERE username = ?", [u]);

        orphanUsersDeleted += 1;
      }
      await conn.execute('COMMIT');
    } catch (txErr) {
      await conn.execute('ROLLBACK');
      throw txErr;
    }

    // Best-effort disconnect PPPoE on Mikrotik
    try {
      const routersDb = new sqlite3.Database(billingDbPath);
      const routers = await new Promise((resolve) => {
        routersDb.all('SELECT * FROM routers ORDER BY id', [], (err, rows) => resolve(rows || []));
      });
      routersDb.close();

      const listToDisconnect = orphanUsers.slice(0, 30);
      for (const u of listToDisconnect) {
        pppoeDisconnectAttempts += 1;
        for (const r of routers) {
          try {
            const { disconnectPPPoEUser } = require('../config/mikrotik');
            await disconnectPPPoEUser(u, r);
          } catch (_) {}
        }
      }
    } catch (_) {}

    await conn.end();

    return res.json({
      success: true,
      message: 'Orphan users sync/cleanup berhasil',
      details: {
        orphanUsersFound,
        orphanUsersDeleted,
        endedRadacctActive,
        pppoeDisconnectAttempts
      }
    });
  } catch (error) {
    logger.error('Error sync-orphan-users:', error);
    try { if (conn) await conn.end(); } catch (_) {}
    return res.status(500).json({
      success: false,
      message: 'Gagal sync/hapus orphan users: ' + error.message,
      error: error.message
    });
  }
});

// GET: Halaman Manage RADIUS Clients
router.get('/radius/clients', adminAuth, async (req, res) => {
  try {
    const clients = await parseClientsConfFromDB();
    const clientsConfDiag = getRadiusClientsConfReadDiagnostics();
    const settings = await getRadiusConfig();
    
    res.render('adminRadiusClients', {
      clients,
      clientsConfDiag,
      settings,
      page: 'setting-radius-clients',
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (error) {
    logger.error('Error loading RADIUS clients:', error);
    res.render('adminRadiusClients', {
      clients: [],
      clientsConfDiag: getRadiusClientsConfReadDiagnostics(),
      settings: {},
      page: 'setting-radius-clients',
      error: 'Gagal memuat daftar clients: ' + error.message,
      success: null
    });
  }
});

// GET: API - Get all clients
router.get('/radius/clients/api', adminAuth, async (req, res) => {
  try {
    const clients = await parseClientsConfFromDB();
    res.json({ success: true, clients, clientsConfDiag: getRadiusClientsConfReadDiagnostics() });
  } catch (error) {
    logger.error('Error getting clients:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST: Add new client
router.post('/radius/clients/add', adminAuth, async (req, res) => {
  try {
    const { name, ipaddr, secret, nas_type, require_message_authenticator, comment } = req.body;

    // Validate
    const validation = validateClient({ name, ipaddr, secret });
    if (!validation.valid) {
      return res.json({ success: false, message: validation.errors.join(', ') });
    }

    // Get existing clients
    const clients = await parseClientsConfFromDB();

    // Check duplicate name
    if (clients.some(c => c.name === name.trim())) {
      return res.json({ success: false, message: 'Client dengan nama tersebut sudah ada' });
    }

    // Check duplicate IP
    if (clients.some(c => c.ipaddr === ipaddr.trim())) {
      return res.json({ success: false, message: 'Client dengan IP tersebut sudah ada' });
    }

    // Add new client
    clients.push({
      name: name.trim(),
      ipaddr: ipaddr.trim(),
      secret: secret.trim(),
      nas_type: nas_type || 'other',
      require_message_authenticator: require_message_authenticator || 'no',
      comment: comment || null
    });

    const saveResult = await writeClientsConfToDB(clients);
    const restartResult = restartFreeRADIUS();

    let message = 'Client berhasil ditambahkan';
    if (restartResult.success) message += ' dan FreeRADIUS berhasil direstart';
    if (saveResult.warning) message += '. ' + saveResult.warning;

    res.json({
      success: true,
      message,
      client: clients[clients.length - 1],
      restart: restartResult,
      save: saveResult
    });
  } catch (error) {
    logger.error('Error adding client:', error);
    res.status(500).json({ success: false, message: 'Gagal menambah client: ' + error.message });
  }
});

// POST: Update client
router.post('/radius/clients/edit', adminAuth, async (req, res) => {
  try {
    const { oldName, name, ipaddr, secret, nas_type, require_message_authenticator, comment } = req.body;

    // Validate
    const validation = validateClient({ name, ipaddr, secret });
    if (!validation.valid) {
      return res.json({ success: false, message: validation.errors.join(', ') });
    }

    // Get existing clients
    const clients = await parseClientsConfFromDB();

    // Find client index
    const clientIndex = clients.findIndex(c => c.name === oldName);
    if (clientIndex === -1) {
      return res.json({ success: false, message: 'Client tidak ditemukan' });
    }

    // Check duplicate name (if name changed)
    if (name !== oldName && clients.some(c => c.name === name.trim() && c.name !== oldName)) {
      return res.json({ success: false, message: 'Client dengan nama tersebut sudah ada' });
    }

    // Check duplicate IP (if IP changed)
    if (ipaddr !== clients[clientIndex].ipaddr && clients.some(c => c.ipaddr === ipaddr.trim() && c.name !== oldName)) {
      return res.json({ success: false, message: 'Client dengan IP tersebut sudah ada' });
    }

    // Update client
    clients[clientIndex] = {
      name: name.trim(),
      ipaddr: ipaddr.trim(),
      secret: secret.trim(),
      nas_type: nas_type || 'other',
      require_message_authenticator: require_message_authenticator || 'no',
      comment: comment || null
    };

    const saveResult = await writeClientsConfToDB(clients);
    const restartResult = restartFreeRADIUS();

    let message = 'Client berhasil diupdate';
    if (restartResult.success) message += ' dan FreeRADIUS berhasil direstart';
    if (saveResult.warning) message += '. ' + saveResult.warning;

    res.json({
      success: true,
      message,
      client: clients[clientIndex],
      restart: restartResult,
      save: saveResult
    });
  } catch (error) {
    logger.error('Error updating client:', error);
    res.status(500).json({ success: false, message: 'Gagal update client: ' + error.message });
  }
});

// POST: Delete client
router.post('/radius/clients/delete', adminAuth, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.json({ success: false, message: 'Client name diperlukan' });
    }

    // Get existing clients
    const clients = await parseClientsConfFromDB();

    // Filter out the client to delete
    const filteredClients = clients.filter(c => c.name !== name);

    if (filteredClients.length === clients.length) {
      return res.json({ success: false, message: 'Client tidak ditemukan' });
    }

    const saveResult = await writeClientsConfToDB(filteredClients);
    const restartResult = restartFreeRADIUS();

    let message = 'Client berhasil dihapus';
    if (restartResult.success) message += ' dan FreeRADIUS berhasil direstart';
    if (saveResult.warning) message += '. ' + saveResult.warning;

    res.json({
      success: true,
      message,
      restart: restartResult,
      save: saveResult
    });
  } catch (error) {
    logger.error('Error deleting client:', error);
    res.status(500).json({ success: false, message: 'Gagal menghapus client: ' + error.message });
  }
});

// GET: Backup RADIUS
router.get('/radius/backup', adminAuth, async (req, res) => {
  try {
    logger.info('Starting RADIUS backup...');
    const result = await backupRadius();
    
    if (result.success) {
      // Send file for download
      res.download(result.filePath, result.fileName, (err) => {
        if (err) {
          logger.error('Error sending backup file:', err);
          res.status(500).json({ success: false, message: 'Gagal mengirim file backup' });
        }
      });
    } else {
      res.status(500).json({ success: false, message: result.message });
    }
  } catch (error) {
    logger.error('Error creating backup:', error);
    res.status(500).json({ success: false, message: 'Gagal membuat backup: ' + error.message });
  }
});

// POST: Restore RADIUS
router.post('/radius/restore', adminAuth, upload.single('backupFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.redirect('/admin/radius?error=' + encodeURIComponent('File backup tidak ditemukan'));
    }

    logger.info(`Starting RADIUS restore from ${req.file.path}`);
    const result = await restoreRadius(req.file.path);
    
    // Cleanup uploaded file
    try {
      const fs = require('fs').promises;
      await fs.unlink(req.file.path);
    } catch (cleanupError) {
      logger.warn('Error cleaning up uploaded file:', cleanupError);
    }
    
    if (result.success) {
      res.redirect('/admin/radius?success=' + encodeURIComponent(result.message));
    } else {
      res.redirect('/admin/radius?error=' + encodeURIComponent(result.message));
    }
  } catch (error) {
    logger.error('Error restoring backup:', error);
    res.redirect('/admin/radius?error=' + encodeURIComponent('Gagal restore backup: ' + error.message));
  }
});

// GET: List backups
router.get('/radius/backups', adminAuth, async (req, res) => {
  try {
    const backups = await listBackups();
    res.json({ success: true, backups });
  } catch (error) {
    logger.error('Error listing backups:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST: Simpan Pengaturan Auto Backup
router.post('/radius/auto-backup-settings', adminAuth, async (req, res) => {
  try {
    const { enabled, interval } = req.body;
    const db = require('../config/billing').db;
    
    await new Promise((resolve, reject) => {
      db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`, 
              ['radius_autobackup_enabled', enabled], (err) => err ? reject(err) : resolve());
    });
    
    await new Promise((resolve, reject) => {
      db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`, 
              ['radius_autobackup_interval', interval], (err) => err ? reject(err) : resolve());
    });
    
    logger.info(`Auto backup settings updated: enabled=${enabled}, interval=${interval} days`);
    res.json({ success: true, message: 'Pengaturan Auto Backup berhasil disimpan' });
  } catch (error) {
    logger.error('Error saving auto backup settings:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;


