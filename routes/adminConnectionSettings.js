const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const billingManager = require('../config/billing');
const { tenantSqlFromRequest } = require('../config/platform/tenantSqlHelpers');
const { attachTenantAppSettings } = require('../config/platform/tenantAppSettings');

router.use(attachTenantAppSettings);

// Setting Mikrotik page (NAS/Routers only)
router.get('/connection-settings', adminAuth, async (req, res) => {
  try {
    const t = tenantSqlFromRequest(req);
    const db = billingManager.db;
    
    // Ensure routers table exists
    await new Promise((resolve) => db.run(`CREATE TABLE IF NOT EXISTS routers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, nas_ip TEXT NOT NULL, nas_identifier TEXT, secret TEXT, location TEXT, pop TEXT, port INTEGER, user TEXT, password TEXT, genieacs_server_id INTEGER, tenant_id INTEGER NOT NULL DEFAULT 1, UNIQUE(nas_ip))`, () => resolve()));
    
    db.run(`ALTER TABLE routers ADD COLUMN location TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN pop TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN port INTEGER DEFAULT 8728`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN user TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN password TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN genieacs_server_id INTEGER`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`, () => {});
    
    await new Promise((resolve) => db.run(`CREATE TABLE IF NOT EXISTS genieacs_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      description TEXT,
      tenant_id INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      UNIQUE(url)
    )`, () => resolve()));
    db.run(`ALTER TABLE genieacs_servers ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`, () => {});
    
    const genieacsServers = await new Promise((resolve) => {
      db.all(`SELECT id, name, url FROM genieacs_servers WHERE 1=1${t.and('')} ORDER BY name`, (err, rows) => {
        resolve(rows || []);
      });
    });
    
    const routers = await new Promise((resolve) => {
      db.all(`SELECT r.*, g.name as genieacs_server_name, g.url as genieacs_server_url 
              FROM routers r 
              LEFT JOIN genieacs_servers g ON r.genieacs_server_id = g.id AND g.tenant_id = r.tenant_id
              WHERE 1=1${t.and('r')}
              ORDER BY r.id`, (err, rows) => {
        resolve(rows || []);
      });
    });
    
    res.render('admin/connection-settings', { 
      title: 'Setting Mikrotik', 
      routers, 
      genieacsServers,
      settings: req.tenantSettings || {},
      page: 'connection-settings' 
    });
  } catch (e) {
    res.status(500).render('error', { message: 'Gagal memuat Setting Mikrotik', error: e.message });
  }
});

module.exports = router;
