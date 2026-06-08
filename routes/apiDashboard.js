const express = require('express');
const router = express.Router();
const { getInterfaceTraffic, getInterfaces, getResourceInfoForRouter } = require('../config/mikrotik');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// API: GET /api/dashboard/traffic?interface=ether1
const { getSetting } = require('../config/settingsManager');
router.get('/dashboard/traffic', async (req, res) => {
  // Ambil interface dari query, jika tidak ada gunakan dari settings.json
  let iface = req.query.interface;
  if (!iface) {
    iface = getSetting('main_interface', 'ether1');
  }
  try {
    const traffic = await getInterfaceTraffic(iface);
    res.json({ success: true, rx: traffic.rx, tx: traffic.tx, interface: iface });
  } catch (e) {
    res.json({ success: false, rx: 0, tx: 0, message: e.message });
  }
});

// API: GET /api/dashboard/resources?router_id=1 - Get resource info for specific router
router.get('/dashboard/resources', async (req, res) => {
  try {
    const routerId = parseInt(req.query.router_id);
    if (!routerId) {
      return res.json({ success: false, message: 'router_id diperlukan' });
    }

    const db = new sqlite3.Database(path.join(process.cwd(), 'data/billing.db'));
    const router = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM routers WHERE id = ?', [routerId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    db.close();

    if (!router) {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }

    const result = await getResourceInfoForRouter(router);
    res.json(result);
  } catch (e) {
    res.json({ success: false, message: e.message, data: null });
  }
});

// API: GET /api/dashboard/resources-multi?router_ids=1,2 - Get resource info for multiple routers
router.get('/dashboard/resources-multi', async (req, res) => {
  try {
    const routerIdsStr = req.query.router_ids;
    if (!routerIdsStr) {
      return res.json({ success: false, message: 'router_ids diperlukan (comma-separated)' });
    }

    const routerIds = routerIdsStr.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    if (routerIds.length === 0 || routerIds.length > 2) {
      return res.json({ success: false, message: 'Harus pilih 1-2 router' });
    }

    const db = new sqlite3.Database(path.join(process.cwd(), 'data/billing.db'));
    const routers = await Promise.all(routerIds.map(routerId => {
      return new Promise((resolve) => {
        db.get('SELECT * FROM routers WHERE id = ?', [routerId], (err, row) => {
          resolve(row || null);
        });
      });
    }));
    db.close();

    const withRouterTimeout = (promise, ms = 4000) => Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve({
        success: false,
        message: 'Timeout koneksi ke router',
        data: null,
      }), ms)),
    ]);

    const results = [];
    for (const router of routers) {
      if (router) {
        try {
          const result = await withRouterTimeout(getResourceInfoForRouter(router));
          if (!result.routerId && router.id) {
            result.routerId = router.id;
          }
          if (!result.routerName && router.name) {
            result.routerName = router.name;
          }
          results.push(result);
        } catch (e) {
          results.push({ success: false, message: `Error untuk router ${router.name}: ${e.message}`, routerId: router.id, routerName: router.name });
        }
      }
    }

    res.json({ success: true, data: results });
  } catch (e) {
    res.json({ success: false, message: e.message, data: [] });
  }
});

// API: GET /api/dashboard/routers - Get list of all routers
router.get('/dashboard/routers', async (req, res) => {
  try {
    const db = new sqlite3.Database(path.join(process.cwd(), 'data/billing.db'));
    const routers = await new Promise((resolve, reject) => {
      db.all('SELECT id, name, nas_ip, location, pop FROM routers ORDER BY name', [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    db.close();

    res.json({ success: true, routers });
  } catch (e) {
    res.json({ success: false, routers: [], message: e.message });
  }
});

// API: GET /api/dashboard/interfaces - Mendapatkan daftar interface yang tersedia
router.get('/dashboard/interfaces', async (req, res) => {
  try {
    const interfaces = await getInterfaces();
    if (interfaces.success) {
      // Filter interface yang umum digunakan untuk monitoring
      const commonInterfaces = interfaces.data.filter(iface => {
        const name = iface.name.toLowerCase();
        return name.startsWith('ether') || 
               name.startsWith('wlan') || 
               name.startsWith('sfp') || 
               name.startsWith('vlan') || 
               name.startsWith('bridge') || 
               name.startsWith('bond') ||
               name.startsWith('pppoe') ||
               name.startsWith('lte');
      });
      
      res.json({ 
        success: true, 
        interfaces: commonInterfaces.map(iface => ({
          name: iface.name,
          type: iface.type,
          disabled: iface.disabled === 'true',
          running: iface.running === 'true'
        }))
      });
    } else {
      res.json({ success: false, interfaces: [], message: interfaces.message });
    }
  } catch (e) {
    res.json({ success: false, interfaces: [], message: e.message });
  }
});

// API: GET /api/dashboard/interface-traffic?router_id=1&interface=ether1 - Get real-time traffic rate for specific interface
router.get('/dashboard/interface-traffic', async (req, res) => {
  try {
    const routerId = parseInt(req.query.router_id);
    const interfaceName = req.query.interface;
    
    if (!routerId || !interfaceName) {
      return res.json({ success: false, message: 'router_id dan interface diperlukan' });
    }

    const db = new sqlite3.Database(path.join(process.cwd(), 'data/billing.db'));
    const router = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM routers WHERE id = ?', [routerId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    db.close();

    if (!router) {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }

    // Get interface traffic rate using getMikrotikConnectionForRouter
    const { getMikrotikConnectionForRouter } = require('../config/mikrotik');
    const { RouterOSAPI } = require('node-routeros');
    
    try {
      const conn = await getMikrotikConnectionForRouter(router);
      if (!conn) {
        return res.json({ success: false, message: 'Gagal koneksi ke router', data: null });
      }

      const monitor = await conn.write('/interface/monitor-traffic', [
        `=interface=${interfaceName}`,
        '=once='
      ]);

      if (!monitor || !monitor[0]) {
        return res.json({ success: false, message: 'Interface tidak ditemukan', data: null });
      }

      const m = monitor[0];
      const rxBitsPerSec = parseInt(m['rx-bits-per-second'] || 0);
      const txBitsPerSec = parseInt(m['tx-bits-per-second'] || 0);
      
      // Convert to Mbps
      const rxMbps = (rxBitsPerSec / 1000000).toFixed(2);
      const txMbps = (txBitsPerSec / 1000000).toFixed(2);

      res.json({
        success: true,
        data: {
          interface: interfaceName,
          rxMbps: parseFloat(rxMbps),
          txMbps: parseFloat(txMbps),
          timestamp: new Date().toISOString()
        }
      });
    } catch (e) {
      res.json({ success: false, message: e.message, data: null });
    }
  } catch (e) {
    res.json({ success: false, message: e.message, data: null });
  }
});

module.exports = router;
