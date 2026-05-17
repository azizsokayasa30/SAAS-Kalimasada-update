const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');

// List routers page
router.get('/routers', adminAuth, async (req, res) => {
  try {
    const db = require('../config/billing').db;
    await new Promise((resolve) => db.run(`CREATE TABLE IF NOT EXISTS routers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, nas_ip TEXT NOT NULL, nas_identifier TEXT, secret TEXT, location TEXT, pop TEXT, port INTEGER, user TEXT, password TEXT, genieacs_server_id INTEGER, UNIQUE(nas_ip))`, () => resolve()));
    // Best-effort schema extension for existing installs
    db.run(`ALTER TABLE routers ADD COLUMN location TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN pop TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN port INTEGER DEFAULT 8728`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN user TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN password TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN genieacs_server_id INTEGER`, () => {});
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
    const portToUse = parseInt(port || 8728);
    const genieacsServerId = genieacs_server_id ? parseInt(genieacs_server_id) : null;
    const db = require('../config/billing').db;
    db.run(`INSERT INTO routers (name, nas_ip, nas_identifier, location, pop, port, user, password, genieacs_server_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [name.trim(), nas_ip.trim(), (nas_identifier||'').trim(), (location||'').trim(), (pop||'').trim(), portToUse, user, password, genieacsServerId], function(err){
      if (err) return res.json({ success: false, message: err.message });
      res.json({ success: true, id: this.lastID });
    });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// Edit router
router.post('/routers/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, nas_ip, nas_identifier, location, pop, port, user, password, genieacs_server_id } = req.body;
    const portToUse2 = parseInt(port || 8728);
    const genieacsServerId = genieacs_server_id ? parseInt(genieacs_server_id) : null;
    const db = require('../config/billing').db;
    db.run(`UPDATE routers SET name=?, nas_ip=?, nas_identifier=?, location=?, pop=?, port=?, user=?, password=?, genieacs_server_id=? WHERE id=?`, [name, nas_ip, nas_identifier, location, pop, portToUse2, user, password, genieacsServerId, id], function(err){
      if (err) return res.json({ success: false, message: err.message });
      res.json({ success: true });
    });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// Delete router
router.post('/routers/:id/delete', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const db = require('../config/billing').db;
    db.run(`DELETE FROM routers WHERE id=?`, [id], function(err){
      if (err) return res.json({ success: false, message: err.message });
      res.json({ success: true });
    });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

module.exports = router;


// Tambah endpoint test koneksi Mikrotik per NAS
router.post('/routers/:id/test', adminAuth, async (req, res) => {
  try {
    const db = require('../config/billing').db;
    db.get(`SELECT * FROM routers WHERE id=?`, [req.params.id], async (err, row) => {
      if (err) return res.json({ success: false, message: err.message });
      if (!row) return res.json({ success: false, message: 'Router tidak ditemukan' });
      try {
        const { getMikrotikConnectionForRouter, getRouterIdentity } = require('../config/mikrotik');
        const conn = await getMikrotikConnectionForRouter(row);
        const identity = await conn.write('/system/identity/print');
        res.json({ success: true, identity: identity && identity[0] ? identity[0].name || identity[0]['name'] : 'connected', host: row.nas_ip, port: row.port || 8728 });
      } catch (e) {
        res.json({ success: false, message: e.message });
      }
    });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});


