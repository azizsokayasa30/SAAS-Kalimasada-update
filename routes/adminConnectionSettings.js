const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const axios = require('axios');

// Setting Mikrotik page (NAS/Routers only)
router.get('/connection-settings', adminAuth, async (req, res) => {
  try {
    const db = require('../config/billing').db;
    
    // Ensure routers table exists
    await new Promise((resolve) => db.run(`CREATE TABLE IF NOT EXISTS routers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, nas_ip TEXT NOT NULL, nas_identifier TEXT, secret TEXT, location TEXT, pop TEXT, port INTEGER, user TEXT, password TEXT, genieacs_server_id INTEGER, UNIQUE(nas_ip))`, () => resolve()));
    
    // Best-effort schema extension for existing installs
    db.run(`ALTER TABLE routers ADD COLUMN location TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN pop TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN port INTEGER DEFAULT 8728`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN user TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN password TEXT`, () => {});
    db.run(`ALTER TABLE routers ADD COLUMN genieacs_server_id INTEGER`, () => {});
    
    // Ensure genieacs_servers table exists (for dropdown)
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
    
    // Get routers with GenieACS server info
    const routers = await new Promise((resolve) => {
      db.all(`SELECT r.*, g.name as genieacs_server_name, g.url as genieacs_server_url 
              FROM routers r 
              LEFT JOIN genieacs_servers g ON r.genieacs_server_id = g.id 
              ORDER BY r.id`, (err, rows) => {
        resolve(rows || []);
      });
    });
    
    res.render('admin/connection-settings', { 
      title: 'Setting Mikrotik', 
      routers, 
      genieacsServers, 
      page: 'connection-settings' 
    });
  } catch (e) {
    res.status(500).render('error', { message: 'Gagal memuat Setting Mikrotik', error: e.message });
  }
});

module.exports = router;

