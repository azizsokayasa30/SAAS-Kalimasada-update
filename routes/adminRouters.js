const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const billingManager = require('../config/billing');
const { getTenantId, hasTenantContext } = require('../config/platform/tenantContext');

function tAnd(alias = '') {
  const t = billingManager._tenantWhere(alias);
  if (!t.sql) return '';
  const col = alias ? `${alias}.tenant_id` : 'tenant_id';
  return ` AND ${col} = ${parseInt(t.params[0], 10)}`;
}
function tWhere(alias = '') {
  const t = billingManager._tenantWhere(alias);
  if (!t.sql) return '';
  const col = alias ? `${alias}.tenant_id` : 'tenant_id';
  return ` WHERE ${col} = ${parseInt(t.params[0], 10)}`;
}

// List routers page
router.get('/routers', adminAuth, async (req, res) => {
  try {
    const db = billingManager.db;
    await new Promise((resolve) => db.run(`CREATE TABLE IF NOT EXISTS routers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, nas_ip TEXT NOT NULL, nas_identifier TEXT, secret TEXT, location TEXT, pop TEXT, port INTEGER, user TEXT, password TEXT, genieacs_server_id INTEGER, UNIQUE(nas_ip))`, () => resolve()));
    // Best-effort schema extension for existing installs
    db.run(`ALTER TABLE routers ADD COLUMN location TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN pop TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN port INTEGER DEFAULT 8728`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN user TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN password TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN genieacs_server_id INTEGER`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`, () => {});
    // Create genieacs_servers table
    await new Promise((resolve) => db.run(`CREATE TABLE IF NOT EXISTS genieacs_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      UNIQUE(url)
    )`, () => resolve()));
    // Get GenieACS servers for dropdown
    const genieacsServers = await new Promise((resolve) => {
      db.all(`SELECT id, name, url FROM genieacs_servers ORDER BY name`, (err, rows) => {
        resolve(rows || []);
      });
    });
    
    db.all(`SELECT r.*, g.name as genieacs_server_name, g.url as genieacs_server_url 
            FROM routers r 
            LEFT JOIN genieacs_servers g ON r.genieacs_server_id = g.id 
            ${tWhere('r')}
            ORDER BY r.id`, (err, rows) => {
      const routers = rows || [];
      res.render('admin/routers', { title: 'NAS (RADIUS)', routers, genieacsServers, page: 'routers' });
    });
  } catch (e) {
    res.status(500).render('error', { message: 'Gagal memuat NAS', error: e.message });
  }
});

// Add router
router.post('/routers', adminAuth, async (req, res) => {
  try {
    const { name, nas_ip, nas_identifier, location, pop, port, user, password, genieacs_server_id } = req.body;
    if (!name || !nas_ip || !user || !password) return res.json({ success: false, message: 'Nama, NAS IP, user, dan password wajib diisi' });
    const { isValidClientName, isValidClientIp, sanitizeClientName } = require('../config/radiusClients');
    const safeName = String(name).trim();
    const safeIp = String(nas_ip).trim();
    if (!isValidClientName(safeName)) {
      const suggested = sanitizeClientName(safeName);
      return res.json({
        success: false,
        message: suggested
          ? `Nama NAS tidak valid untuk RADIUS (tanpa spasi/karakter aneh). Contoh: ${suggested}`
          : 'Nama NAS tidak valid. Gunakan hanya huruf, angka, titik, strip, underscore (tanpa spasi).'
      });
    }
    if (!isValidClientIp(safeIp)) {
      return res.json({
        success: false,
        message: 'NAS IP tidak valid (IPv4 tanpa port, contoh: 10.10.0.5)'
      });
    }
    const portToUse = parseInt(port || 8728);
    const genieacsServerId = genieacs_server_id ? parseInt(genieacs_server_id) : null;
    const tenantId = hasTenantContext() ? getTenantId() : 1;
    const db = billingManager.db;
    db.run(
      `INSERT INTO routers (name, nas_ip, nas_identifier, location, pop, port, user, password, genieacs_server_id, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [safeName, safeIp, (nas_identifier||'').trim(), (location||'').trim(), (pop||'').trim(), portToUse, user, password, genieacsServerId, tenantId],
      function(err) {
        if (err) return res.json({ success: false, message: err.message });
        const newId = this.lastID;
        // Sinkron NAS ke tabel RADIUS (terisolasi per tenant)
        setImmediate(async () => {
          try {
            const { upsertRadiusNasFromRouter } = require('../config/radiusClients');
            await upsertRadiusNasFromRouter({
              id: newId,
              name: safeName,
              nas_ip: safeIp,
              nas_identifier: (nas_identifier || '').trim(),
              location: (location || '').trim(),
              password,
              tenant_id: tenantId
            }, tenantId);
          } catch (e) {
            console.warn('[adminRouters] sync RADIUS nas gagal:', e.message);
          }
        });
        res.json({ success: true, id: newId });
      }
    );
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// Edit router
router.post('/routers/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, nas_ip, nas_identifier, location, pop, port, user, password, genieacs_server_id } = req.body;
    const { isValidClientName, isValidClientIp, sanitizeClientName } = require('../config/radiusClients');
    const safeName = String(name || '').trim();
    const safeIp = String(nas_ip || '').trim();
    if (!safeName || !safeIp || !user || !password) {
      return res.json({ success: false, message: 'Nama, NAS IP, user, dan password wajib diisi' });
    }
    if (!isValidClientName(safeName)) {
      const suggested = sanitizeClientName(safeName);
      return res.json({
        success: false,
        message: suggested
          ? `Nama NAS tidak valid untuk RADIUS (tanpa spasi/karakter aneh). Contoh: ${suggested}`
          : 'Nama NAS tidak valid. Gunakan hanya huruf, angka, titik, strip, underscore (tanpa spasi).'
      });
    }
    if (!isValidClientIp(safeIp)) {
      return res.json({
        success: false,
        message: 'NAS IP tidak valid (IPv4 tanpa port, contoh: 10.10.0.5)'
      });
    }
    const portToUse2 = parseInt(port || 8728);
    const genieacsServerId = genieacs_server_id ? parseInt(genieacs_server_id) : null;
    const db = billingManager.db;
    db.run(
      `UPDATE routers SET name=?, nas_ip=?, nas_identifier=?, location=?, pop=?, port=?, user=?, password=?, genieacs_server_id=?
       WHERE id=?${tAnd()}`,
      [safeName, safeIp, nas_identifier, location, pop, portToUse2, user, password, genieacsServerId, id],
      function(err) {
        if (err) return res.json({ success: false, message: err.message });
        if (this.changes === 0) return res.json({ success: false, message: 'Router tidak ditemukan atau bukan milik tenant ini.' });
        const tenantId = hasTenantContext() ? getTenantId() : null;
        setImmediate(async () => {
          try {
            const { upsertRadiusNasFromRouter } = require('../config/radiusClients');
            await upsertRadiusNasFromRouter({
              id: parseInt(id, 10),
              name: safeName,
              nas_ip: safeIp,
              nas_identifier,
              location,
              password,
              tenant_id: tenantId
            }, tenantId);
          } catch (e) {
            console.warn('[adminRouters] sync RADIUS nas (edit) gagal:', e.message);
          }
        });
        res.json({ success: true });
      }
    );
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// Delete router
router.post('/routers/:id/delete', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const db = billingManager.db;
    db.get(`SELECT nas_ip FROM routers WHERE id=?${tAnd()}`, [id], (selErr, row) => {
      if (selErr) return res.json({ success: false, message: selErr.message });
      if (!row) return res.json({ success: false, message: 'Router tidak ditemukan atau bukan milik tenant ini.' });
      const nasIp = row.nas_ip;
      const tenantId = hasTenantContext() ? getTenantId() : null;
      db.run(`DELETE FROM routers WHERE id=?${tAnd()}`, [id], function(err) {
        if (err) return res.json({ success: false, message: err.message });
        if (this.changes === 0) return res.json({ success: false, message: 'Router tidak ditemukan atau bukan milik tenant ini.' });
        setImmediate(async () => {
          try {
            const { removeRadiusNasByIp } = require('../config/radiusClients');
            await removeRadiusNasByIp(nasIp, tenantId);
          } catch (e) {
            console.warn('[adminRouters] hapus RADIUS nas gagal:', e.message);
          }
        });
        res.json({ success: true });
      });
    });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// Test koneksi Mikrotik per NAS (ephemeral TCP API — bukan ping ICMP)
router.post('/routers/:id/test', adminAuth, async (req, res) => {
  try {
    const db = billingManager.db;
    db.get(`SELECT * FROM routers WHERE id=?${tAnd()}`, [req.params.id], async (err, row) => {
      if (err) return res.json({ success: false, message: err.message });
      if (!row) return res.json({ success: false, message: 'Router tidak ditemukan' });
      try {
        const { testMikrotikConnectionForRouter } = require('../config/mikrotik');
        const result = await testMikrotikConnectionForRouter(row);
        res.json(result);
      } catch (e) {
        res.json({
          success: false,
          message: e.message,
          host: row.nas_ip,
          port: row.port || 8728
        });
      }
    });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

module.exports = router;
