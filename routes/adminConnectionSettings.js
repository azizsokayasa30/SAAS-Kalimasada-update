const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const billingManager = require('../config/billing');
const { tenantSqlFromRequest } = require('../config/platform/tenantSqlHelpers');
const { attachTenantAppSettings } = require('../config/platform/tenantAppSettings');
const { getTenantId, hasTenantContext } = require('../config/platform/tenantContext');
const vpnService = require('../config/platform/vpnService');

router.use(attachTenantAppSettings);

function resolveTenantId(req) {
  if (req.tenantId) return Number(req.tenantId);
  if (hasTenantContext()) return Number(getTenantId());
  return null;
}

function resolveTenantPrefix(req) {
  const subdomain = String(req.tenant?.subdomain || req.tenant?.slug || '').trim();
  if (subdomain) return subdomain;
  const name = String(req.tenant?.name || '').trim();
  return name || 'tenant';
}

function publicPeer(peer) {
  if (!peer) return null;
  return {
    id: peer.id,
    name: peer.name,
    tunnel_ip: peer.tunnel_ip,
    protocol: peer.protocol || 'wireguard',
    routeros_version: peer.routeros_version || null,
    is_active: peer.is_active,
    notes: peer.notes,
    created_at: peer.created_at,
    connectionStatus: peer.connectionStatus,
    connectionLabel: peer.connectionLabel,
    handshakeAgeLabel: peer.handshakeAgeLabel,
    pingLabel: peer.pingLabel,
    pingMs: peer.pingMs,
  };
}

function mikrotikScriptFilename(peer) {
  const safeName = String(peer.name || 'peer')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'peer';
  const prefix = vpnService.normalizeProtocol(peer.protocol) === 'l2tp' ? 'mikrotik-l2tp' : 'mikrotik-wg';
  return `${prefix}-${safeName}.rsc`;
}

// Setting Mikrotik page (NAS/Routers + VPN request)
router.get('/connection-settings', adminAuth, async (req, res) => {
  try {
    const t = tenantSqlFromRequest(req);
    const db = billingManager.db;
    const tenantId = resolveTenantId(req);
    const tenantPrefix = resolveTenantPrefix(req);

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

    let vpnDevices = [];
    let vpnServerReady = false;
    let wgServerReady = false;
    let l2tpServerReady = false;
    let vpnServer = null;
    try {
      vpnServer = await vpnService.getServer();
      wgServerReady = vpnService.isVpnServerReady(vpnServer);
      l2tpServerReady = vpnService.isL2tpServerReady(vpnServer);
      vpnServerReady = wgServerReady || l2tpServerReady;
      if (tenantId) {
        const status = await vpnService.getDevicesStatus({ tenantId });
        vpnDevices = status.devices || [];
      }
    } catch (vpnErr) {
      console.warn('[connection-settings] vpn load:', vpnErr.message);
    }

    const tenantSettings = req.tenantSettings || {};
    const vpnTunnelIp = String(vpnServer?.tunnel_address || '').trim().split('/')[0] || '10.10.0.1';
    const isolirPagePort = String(
      process.env.ISOLIR_PORT || tenantSettings.isolir_page_port || '8899'
    ).trim() || '8899';

    res.render('admin/connection-settings', {
      title: 'Setting Mikrotik',
      routers,
      genieacsServers,
      settings: tenantSettings,
      page: 'connection-settings',
      vpnDevices,
      vpnServerReady,
      wgServerReady,
      l2tpServerReady,
      vpnTunnelIp,
      isolirPagePort,
      tenantPrefix,
      tenantName: req.tenant?.name || tenantPrefix,
    });
  } catch (e) {
    res.status(500).render('error', { message: 'Gagal memuat Setting Mikrotik', error: e.message });
  }
});

// ── Tenant VPN API ──

router.get('/connection-settings/vpn/devices', adminAuth, async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: 'Tenant tidak dikenali.' });

    const server = await vpnService.getServer();
    const status = await vpnService.getDevicesStatus({ tenantId });
    res.json({
      success: true,
      vpnServerReady: vpnService.isVpnServerReady(server) || vpnService.isL2tpServerReady(server),
      wgServerReady: vpnService.isVpnServerReady(server),
      l2tpServerReady: vpnService.isL2tpServerReady(server),
      devices: (status.devices || []).map(publicPeer),
    });
  } catch (err) {
    console.error('[connection-settings] list vpn:', err);
    res.status(500).json({ success: false, message: err.message || 'Gagal memuat perangkat VPN' });
  }
});

router.post('/connection-settings/vpn/devices', adminAuth, async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: 'Tenant tidak dikenali.' });

    const routerName = String(req.body?.router_name || req.body?.name || '').trim();
    if (!routerName) {
      return res.status(400).json({ success: false, message: 'Nama router wajib diisi.' });
    }

    const routerosVersion = String(req.body?.routeros_version || '').trim();
    if (!vpnService.normalizeRouterOsVersion(routerosVersion)) {
      return res.status(400).json({ success: false, message: 'Versi RouterOS wajib v6 atau v7.' });
    }

    const peer = await vpnService.createPeerForTenant({
      tenantId,
      tenantPrefix: resolveTenantPrefix(req),
      routerName,
      routerosVersion,
    });

    res.json({
      success: true,
      message: 'Perangkat VPN berhasil dibuat.',
      device: publicPeer(peer),
    });
  } catch (err) {
    console.error('[connection-settings] create vpn:', err);
    res.status(400).json({ success: false, message: err.message || 'Gagal membuat perangkat VPN' });
  }
});

router.get('/connection-settings/vpn/devices/:id/mikrotik-script', adminAuth, async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).send('Tenant tidak dikenali.');

    const peer = await vpnService.getPeerByIdForTenant(req.params.id, tenantId);
    if (!peer) return res.status(404).send('Perangkat tidak ditemukan.');

    const { script } = await vpnService.getMikrotikScript(peer.id);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${mikrotikScriptFilename(peer)}"`);
    res.send(script);
  } catch (err) {
    console.error('[connection-settings] mikrotik script:', err);
    res.status(500).send(err.message || 'Gagal generate script MikroTik');
  }
});

router.post('/connection-settings/vpn/devices/:id/delete', adminAuth, async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: 'Tenant tidak dikenali.' });

    const peer = await vpnService.getPeerByIdForTenant(req.params.id, tenantId);
    if (!peer) return res.status(404).json({ success: false, message: 'Perangkat tidak ditemukan.' });

    await vpnService.deletePeer(peer.id);
    res.json({ success: true, message: 'Perangkat VPN dihapus.' });
  } catch (err) {
    console.error('[connection-settings] delete vpn:', err);
    res.status(400).json({ success: false, message: err.message || 'Gagal hapus perangkat VPN' });
  }
});

module.exports = router;
