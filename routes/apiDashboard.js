const express = require('express');
const router = express.Router();
const { getInterfaceTraffic, getInterfaces, getResourceInfoForRouter } = require('../config/mikrotik');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { tenantSqlFromRequest } = require('../config/platform/tenantSqlHelpers');
const { getSetting } = require('../config/settingsManager');

function openBillingDb() {
  return new sqlite3.Database(path.join(process.cwd(), 'data/billing.db'));
}

/** Ambil router milik tenant saat ini saja (anti IDOR lintas tenant). */
function getTenantRouterById(db, routerId, req) {
  const t = tenantSqlFromRequest(req);
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM routers WHERE id = ?${t.and()}`, [routerId], (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

// API: GET /api/dashboard/traffic?interface=ether1
router.get('/dashboard/traffic', async (req, res) => {
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

    const db = openBillingDb();
    const routerRow = await getTenantRouterById(db, routerId, req);
    db.close();

    if (!routerRow) {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }

    const result = await getResourceInfoForRouter(routerRow);
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

    const db = openBillingDb();
    const routers = await Promise.all(routerIds.map((routerId) => getTenantRouterById(db, routerId, req)));
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
    for (const routerRow of routers) {
      if (routerRow) {
        try {
          const result = await withRouterTimeout(getResourceInfoForRouter(routerRow));
          if (!result.routerId && routerRow.id) {
            result.routerId = routerRow.id;
          }
          if (!result.routerName && routerRow.name) {
            result.routerName = routerRow.name;
          }
          results.push(result);
        } catch (e) {
          results.push({
            success: false,
            message: `Error untuk router ${routerRow.name}: ${e.message}`,
            routerId: routerRow.id,
            routerName: routerRow.name
          });
        }
      }
    }

    res.json({ success: true, data: results });
  } catch (e) {
    res.json({ success: false, message: e.message, data: [] });
  }
});

// API: GET /api/dashboard/routers - Get list of routers milik tenant
router.get('/dashboard/routers', async (req, res) => {
  try {
    const t = tenantSqlFromRequest(req);
    const db = openBillingDb();
    const routers = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, name, nas_ip, location, pop FROM routers${t.where()} ORDER BY name`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
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

// API: GET /api/dashboard/interface-traffic?router_id=1&interface=ether1
router.get('/dashboard/interface-traffic', async (req, res) => {
  try {
    const routerId = parseInt(req.query.router_id);
    let interfaceName = String(req.query.interface || '').trim();

    if (!routerId || !interfaceName) {
      return res.json({ success: false, message: 'router_id dan interface diperlukan' });
    }

    const db = openBillingDb();
    const routerRow = await getTenantRouterById(db, routerId, req);
    db.close();

    if (!routerRow) {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }

    const { getMikrotikConnectionForRouter } = require('../config/mikrotik');

    try {
      const conn = await getMikrotikConnectionForRouter(routerRow);
      if (!conn) {
        return res.json({ success: false, message: 'Gagal koneksi ke router', data: null });
      }

      const normalizeIfaceKey = (name) =>
        String(name || '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '')
          .replace(/sfp-sfpplus/g, 'sfp+')
          .replace(/sfpplus/g, 'sfp+');

      try {
        const ifaces = await conn.write('/interface/print');
        const names = (Array.isArray(ifaces) ? ifaces : [])
          .map((i) => (i && i.name != null ? String(i.name).trim() : ''))
          .filter((n) => n && !n.startsWith('<'));
        const byKey = new Map(names.map((n) => [normalizeIfaceKey(n), n]));
        const candidates = [interfaceName];
        const key = normalizeIfaceKey(interfaceName);
        if (key.includes('ether1') || key === 'ether1-isp') {
          candidates.push('SFP+1', 'sfp-sfpplus1', 'ether1');
        }
        if (key === 'sfp-sfpplus1' || key === 'sfp+1') {
          candidates.push('SFP+1', 'sfp-sfpplus1');
        }
        for (const cand of candidates) {
          const hit = byKey.get(normalizeIfaceKey(cand));
          if (hit) {
            interfaceName = hit;
            break;
          }
        }
        if (!byKey.has(normalizeIfaceKey(interfaceName))) {
          const sfp = names.find((n) => /^sfp\+/i.test(n));
          if (sfp) interfaceName = sfp;
        }
      } catch (_) {
        // lanjut coba nama asli
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
