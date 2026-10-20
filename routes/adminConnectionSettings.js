const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const billingManager = require('../config/billing');
const { tenantSqlFromRequest } = require('../config/platform/tenantSqlHelpers');
const { attachTenantAppSettings } = require('../config/platform/tenantAppSettings');
const { getTenantId, hasTenantContext } = require('../config/platform/tenantContext');
const vpnService = require('../config/platform/vpnService');
const {
  getMikrotikConnectionForRouter,
  getCachedFullPppSecrets,
  getCachedPppActivePrint,
  getRadiusConnection,
  addPPPoEUserRadius,
} = require('../config/mikrotik');
const { claimTenantPppoeUsername, releaseTenantPppoeUsername } = require('../utils/tenantPppoeOwnership');

const ROUTER_QUERY_TIMEOUT_MS = 9000;

function withRouterTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout (${ROUTER_QUERY_TIMEOUT_MS}ms)`)), ROUTER_QUERY_TIMEOUT_MS)
    ),
  ]);
}

function loadTenantRouters(t) {
  const db = billingManager.db;
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, name, nas_ip, nas_identifier, location, pop, port, user, password, secret, genieacs_server_id, tenant_id
       FROM routers WHERE 1=1${t.and('')} ORDER BY id`,
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

function loadTenantRouterById(t, id) {
  const db = billingManager.db;
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM routers WHERE id = ?${t.and('')}`,
      [id],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

async function getRadiusPasswordUsernameSet() {
  const conn = await getRadiusConnection();
  const [rows] = await conn.execute(
    `SELECT DISTINCT LOWER(TRIM(username)) AS u FROM radcheck
     WHERE LOWER(TRIM(attribute)) IN (
       'cleartext-password',
       'user-password',
       'crypt-password',
       'md5-password',
       'sha-password',
       'smd5-password',
       'mikrotik-password'
     )`
  );
  const set = new Set();
  for (const row of rows || []) {
    const u = String(row?.u || '').trim().toLowerCase();
    if (u) set.add(u);
  }
  return set;
}

function secretName(sec) {
  return String(sec?.name || '').trim();
}

async function listRouterPppSecrets(router) {
  const conn = await getMikrotikConnectionForRouter(router);
  const secrets = await getCachedFullPppSecrets(conn, `admin_${router.id}`);
  const active = await getCachedPppActivePrint(conn, `admin_${router.id}`);
  return {
    secrets: Array.isArray(secrets) ? secrets : [],
    active: Array.isArray(active) ? active : [],
  };
}

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
        const { isPublicIpv4 } = require('../config/mikrotikApiGuard');
        resolve((rows || []).map((row) => {
          const copy = { ...row };
          copy.has_password = !!(copy.password || copy.secret);
          copy.api_public = isPublicIpv4(copy.nas_ip);
          delete copy.password;
          delete copy.secret;
          return copy;
        }));
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
      tenantPrefix,
      tenantId,
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

router.get('/connection-settings/mikrotik-pppoe-stats', adminAuth, async (req, res) => {
  try {
    const t = tenantSqlFromRequest(req);
    const routers = await loadTenantRouters(t);
    const stats = await Promise.all(
      routers.map((r) =>
        withRouterTimeout(
          (async () => {
            try {
              const { secrets, active } = await listRouterPppSecrets(r);
              return {
                id: r.id,
                name: r.name,
                nas_ip: r.nas_ip,
                secret_count: secrets.length,
                active_count: active.length,
                ok: true,
                error: null,
              };
            } catch (err) {
              return {
                id: r.id,
                name: r.name,
                nas_ip: r.nas_ip,
                secret_count: null,
                active_count: null,
                ok: false,
                error: err.message || 'Gagal query MikroTik',
              };
            }
          })(),
          r.name || r.nas_ip || `router-${r.id}`
        ).catch((err) => ({
          id: r.id,
          name: r.name,
          nas_ip: r.nas_ip,
          secret_count: null,
          active_count: null,
          ok: false,
          error: err.message || 'Timeout query MikroTik',
        }))
      )
    );
    res.json({ success: true, routers: stats });
  } catch (err) {
    console.error('[connection-settings] pppoe stats:', err);
    res.status(500).json({ success: false, message: err.message || 'Gagal memuat status PPPoE' });
  }
});

router.get('/connection-settings/routers/:id/pppoe-not-in-radius', adminAuth, async (req, res) => {
  try {
    const t = tenantSqlFromRequest(req);
    const routerRow = await loadTenantRouterById(t, req.params.id);
    if (!routerRow) return res.status(404).json({ success: false, message: 'Router tidak ditemukan.' });

    const [{ secrets }, radiusSet] = await Promise.all([
      withRouterTimeout(listRouterPppSecrets(routerRow), routerRow.name || routerRow.nas_ip),
      getRadiusPasswordUsernameSet(),
    ]);

    const missing = [];
    const seen = new Set();
    for (const sec of secrets) {
      const name = secretName(sec);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (radiusSet.has(key)) continue;
      const password = sec.password != null ? String(sec.password) : '';
      missing.push({
        name,
        profile: sec.profile != null ? String(sec.profile) : '',
        has_password: !!password.trim(),
        password,
      });
    }

    res.json({
      success: true,
      router: { id: routerRow.id, name: routerRow.name, nas_ip: routerRow.nas_ip },
      total_secrets: secrets.length,
      missing_count: missing.length,
      missing,
    });
  } catch (err) {
    console.error('[connection-settings] pppoe-not-in-radius:', err);
    res.status(500).json({ success: false, message: err.message || 'Gagal cek PPPoE vs RADIUS' });
  }
});

router.post('/connection-settings/routers/:id/pppoe-sync-to-radius', adminAuth, async (req, res) => {
  try {
    const t = tenantSqlFromRequest(req);
    const routerRow = await loadTenantRouterById(t, req.params.id);
    if (!routerRow) return res.status(404).json({ success: false, message: 'Router tidak ditemukan.' });

    const requested = Array.isArray(req.body?.usernames) ? req.body.usernames : [];
    const want = new Set(
      requested.map((u) => String(u || '').trim().toLowerCase()).filter(Boolean)
    );
    if (!want.size) {
      return res.status(400).json({ success: false, message: 'Pilih minimal satu username.' });
    }

    const [{ secrets }, radiusSet] = await Promise.all([
      withRouterTimeout(listRouterPppSecrets(routerRow), routerRow.name || routerRow.nas_ip),
      getRadiusPasswordUsernameSet(),
    ]);

    const byName = new Map();
    for (const sec of secrets) {
      const name = secretName(sec);
      if (!name) continue;
      const key = name.toLowerCase();
      if (!byName.has(key)) byName.set(key, sec);
    }

    const results = [];
    for (const key of want) {
      const sec = byName.get(key);
      if (!sec) {
        results.push({ username: key, success: false, message: 'Secret tidak ada di MikroTik ini' });
        continue;
      }
      const username = secretName(sec);
      if (radiusSet.has(key)) {
        results.push({ username, success: true, skipped: true, message: 'Sudah ada di RADIUS' });
        continue;
      }
      const password = sec.password != null ? String(sec.password) : '';
      if (!password.trim()) {
        results.push({ username, success: false, message: 'Password secret kosong, dilewati' });
        continue;
      }
      const profile = sec.profile != null ? String(sec.profile).trim() : '';
      try {
        await claimTenantPppoeUsername(username);
      } catch (claimErr) {
        results.push({ username, success: false, message: claimErr.message || 'Gagal klaim username' });
        continue;
      }
      let added = await addPPPoEUserRadius({
        username,
        password,
        profile: profile || null,
      });
      let profileWarning = null;
      if (!added.success && added.error === 'unknown_profile') {
        profileWarning = added.message;
        added = await addPPPoEUserRadius({ username, password, profile: null });
      }
      if (!added.success) {
        await releaseTenantPppoeUsername(username).catch(() => {});
        results.push({ username, success: false, message: added.message || 'Gagal tambah ke RADIUS' });
        continue;
      }
      radiusSet.add(key);
      results.push({
        username,
        success: true,
        message: profileWarning
          ? `Ditambahkan ke RADIUS tanpa profil (${profileWarning})`
          : added.message || 'Ditambahkan ke RADIUS',
        profile_warning: profileWarning || undefined,
      });
    }

    const synced = results.filter((r) => r.success && !r.skipped).length;
    const failed = results.filter((r) => !r.success).length;
    res.json({
      success: failed === 0,
      message: `Sync selesai: ${synced} ditambahkan, ${failed} gagal.`,
      synced,
      failed,
      results,
    });
  } catch (err) {
    console.error('[connection-settings] pppoe-sync-to-radius:', err);
    res.status(500).json({ success: false, message: err.message || 'Gagal sync PPPoE ke RADIUS' });
  }
});

module.exports = router;
