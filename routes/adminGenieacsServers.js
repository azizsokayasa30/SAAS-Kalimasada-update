const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const axios = require('axios');

// List GenieACS servers page
router.get('/genieacs-servers', adminAuth, async (req, res) => {
  try {
    const db = require('../config/billing').db;
    // Ensure table exists
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
    
    db.all(`SELECT *, 
            (SELECT COUNT(*) FROM routers WHERE genieacs_server_id = genieacs_servers.id) as router_count
            FROM genieacs_servers ORDER BY id`, (err, rows) => {
      const servers = rows || [];
      res.render('admin/genieacs-servers', { title: 'GenieACS Servers', servers, page: 'genieacs-servers' });
    });
  } catch (e) {
    res.status(500).render('error', { message: 'Gagal memuat GenieACS Servers', error: e.message });
  }
});

// Add GenieACS server
router.post('/genieacs-servers', adminAuth, async (req, res) => {
  try {
    const { name, url, username, password, description } = req.body;
    if (!name || !url || !username || !password) {
      return res.json({ success: false, message: 'Nama, URL, Username, dan Password wajib diisi' });
    }
    
    // Validate URL format
    try {
      new URL(url);
    } catch (e) {
      return res.json({ success: false, message: 'Format URL tidak valid' });
    }
    
    const db = require('../config/billing').db;
    db.run(`INSERT INTO genieacs_servers (name, url, username, password, description) VALUES (?, ?, ?, ?, ?)`, 
      [name.trim(), url.trim(), username.trim(), password.trim(), (description||'').trim()], 
      function(err) {
        if (err) return res.json({ success: false, message: err.message });
        res.json({ success: true, id: this.lastID });
      });
  } catch (e) { 
    res.json({ success: false, message: e.message }); 
  }
});

// Edit GenieACS server
router.post('/genieacs-servers/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, url, username, password, description } = req.body;
    if (!name || !url || !username) {
      return res.json({ success: false, message: 'Nama, URL, dan Username wajib diisi' });
    }
    
    // Validate URL format
    try {
      new URL(url);
    } catch (e) {
      return res.json({ success: false, message: 'Format URL tidak valid' });
    }
    
    const db = require('../config/billing').db;
    
    // Jika password kosong/undefined, tidak update password
    if (password && password.trim() !== '') {
      db.run(`UPDATE genieacs_servers SET name=?, url=?, username=?, password=?, description=? WHERE id=?`, 
        [name.trim(), url.trim(), username.trim(), password.trim(), (description||'').trim(), id], 
        function(err) {
          if (err) return res.json({ success: false, message: err.message });
          res.json({ success: true });
        });
    } else {
      // Update tanpa password
      db.run(`UPDATE genieacs_servers SET name=?, url=?, username=?, description=? WHERE id=?`, 
        [name.trim(), url.trim(), username.trim(), (description||'').trim(), id], 
        function(err) {
          if (err) return res.json({ success: false, message: err.message });
          res.json({ success: true });
        });
    }
  } catch (e) { 
    res.json({ success: false, message: e.message }); 
  }
});

// Delete GenieACS server
router.post('/genieacs-servers/:id/delete', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const db = require('../config/billing').db;
    
    // Check if any routers are using this server
    db.get(`SELECT COUNT(*) as count FROM routers WHERE genieacs_server_id = ?`, [id], (err, row) => {
      if (err) return res.json({ success: false, message: err.message });
      if (row && row.count > 0) {
        return res.json({ success: false, message: `Tidak bisa menghapus server karena masih digunakan oleh ${row.count} router(s)` });
      }
      
      db.run(`DELETE FROM genieacs_servers WHERE id=?`, [id], function(err) {
        if (err) return res.json({ success: false, message: err.message });
        res.json({ success: true });
      });
    });
  } catch (e) { 
    res.json({ success: false, message: e.message }); 
  }
});

// Test GenieACS server connection
router.post('/genieacs-servers/:id/test', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const db = require('../config/billing').db;
    db.get(`SELECT * FROM genieacs_servers WHERE id=?`, [id], async (err, row) => {
      if (err) return res.json({ success: false, message: err.message });
      if (!row) return res.json({ success: false, message: 'GenieACS server tidak ditemukan' });
      
      try {
        const response = await axios.get(`${row.url}/devices`, {
          auth: {
            username: row.username,
            password: row.password
          },
          timeout: 5000,
          headers: {
            'Accept': 'application/json'
          }
        });
        
        res.json({ 
          success: true, 
          message: 'Koneksi berhasil',
          details: `Status: ${response.status}, Devices: ${response.data ? response.data.length || 0 : 0}`
        });
      } catch (e) {
        res.json({ 
          success: false, 
          message: 'Gagal koneksi ke GenieACS server',
          details: e.response ? `${e.response.status}: ${e.response.statusText}` : e.message
        });
      }
    });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

module.exports = router;

