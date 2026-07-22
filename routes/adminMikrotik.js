const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const logger = require('../config/logger'); // Add logger
const { 
    addPPPoEUser, 
    editPPPoEUser, 
    deletePPPoEUser, 
    getPPPoEProfiles, 
    addPPPoEProfile, 
    editPPPoEProfile, 
    deletePPPoEProfile, 
    getPPPoEProfileDetail,
    getHotspotProfiles,
    addHotspotProfile,
    editHotspotProfile,
    deleteHotspotProfile,
    getHotspotProfileDetail,
    saveHotspotProfileMetadata,
    deleteHotspotProfileMetadata,
    getHotspotServerProfiles,
    addHotspotServerProfileMikrotik,
    editHotspotServerProfileMikrotik,
    deleteHotspotServerProfileMikrotik,
    getHotspotServers,
    addHotspotServer,
    editHotspotServer,
    deleteHotspotServer,
    getHotspotServerDetail,
    getMikrotikConnectionForRouter,
    getCachedFullPppSecrets,
    getCachedPppActivePrint,
    clearPppPrintCachesForRouter
} = require('../config/mikrotik');
const fs = require('fs');
const path = require('path');
const { getSettingsWithCache } = require('../config/settingsManager');
const { getVersionInfo, getVersionBadge } = require('../config/version-utils');
const sqlite3 = require('sqlite3').verbose();
const billingManager = require('../config/billing');
const { getTenantId, hasTenantContext } = require('../config/platform/tenantContext');
const { attachTenantAppSettings } = require('../config/platform/tenantAppSettings');
const { tenantSqlFromRequest } = require('../config/platform/tenantSqlHelpers');

router.use(attachTenantAppSettings);

// Centralized database path
const DB_PATH = path.join(__dirname, '../data/billing.db');

/**
 * Isolasi tenant untuk tabel routers. Mengembalikan potongan SQL dengan
 * tenant_id sebagai literal integer (aman, tervalidasi) sehingga bisa disisipkan
 * ke berbagai bentuk query tanpa harus mengubah parameter binding.
 * WAJIB dipanggil SINKRON di dalam handler (konteks AsyncLocalStorage masih ada).
 */
function _routerTenantAnd() {
  const t = billingManager._tenantWhere('');
  if (!t.sql) return '';
  return ` AND tenant_id = ${parseInt(t.params[0], 10)}`;
}
function _routerTenantWhere() {
  const t = billingManager._tenantWhere('');
  if (!t.sql) return '';
  return ` WHERE tenant_id = ${parseInt(t.params[0], 10)}`;
}

/** Ambil filter tenant dari req (aman setelah await — tidak pakai AsyncLocalStorage). */
function captureRouterTenantWhere(req) {
  return tenantSqlFromRequest(req).where();
}
function captureRouterTenantAnd(req) {
  return tenantSqlFromRequest(req).and('');
}

async function getAllRoutersForRequest(req) {
  const whereSql = captureRouterTenantWhere(req);
  return new Promise((resolve) => {
    billingManager.db.all(`SELECT * FROM routers${whereSql} ORDER BY id`, [], (err, rows) => {
      if (err) {
        logger.error('[DB HELPER] Error fetching routers for tenant:', err.message);
        resolve([]);
      } else {
        resolve(rows || []);
      }
    });
  });
}

/**
 * Helper to get a router by ID using the centralized billingManager
 */
async function findRouterHelper(router_id) {
  return new Promise((resolve) => {
    billingManager.db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => {
      if (err) {
        logger.error(`[DB HELPER] Error fetching router ${router_id}:`, err.message);
        resolve(null);
      } else {
        resolve(row || null);
      }
    });
  });
}

/**
 * Helper to get all routers using the centralized billingManager
 */
async function getAllRoutersHelper() {
  return new Promise((resolve) => {
    billingManager.db.all(('SELECT * FROM routers' + _routerTenantWhere() + ' ORDER BY id'), [], (err, rows) => {
      if (err) {
        logger.error('[DB HELPER] Error fetching all routers:', err.message);
        resolve([]);
      } else {
        resolve(rows || []);
      }
    });
  });
}

// Helper function untuk konversi timeout ke detik (untuk RADIUS)
function convertToSeconds(value, unit) {
  const numValue = parseInt(value);
  if (isNaN(numValue) || numValue <= 0) return 0;
  
  const unitLower = String(unit).toLowerCase();
  const unitMap = {
    's': 1,           // detik (standar Mikrotik)
    'detik': 1,       // kompatibilitas backward
    'm': 60,          // menit (standar Mikrotik) - lowercase untuk waktu
    'menit': 60,      // kompatibilitas backward
    'men': 60,        // kompatibilitas backward
    'h': 3600,        // jam (standar Mikrotik)
    'jam': 3600,      // kompatibilitas backward
    'd': 86400,       // hari (standar Mikrotik)
    'hari': 86400     // kompatibilitas backward
  };
  
  const multiplier = unitMap[unitLower] || 1;
  return numValue * multiplier;
}

const PPPOE_PAGE_CACHE_MS = 45000;
const ROUTER_QUERY_TIMEOUT_MS = 9000;
/** Cache per tenant key — hindari race overwrite antar tenant. */
const _pppoeAdminPageCacheByKey = new Map();
/** Cache API profiles per tenant — jangan share antar tenant. */
const _pppoeProfilesApiCacheByKey = new Map();
const PPPOE_PROFILES_CACHE_MS = 60000;

const {
  getTenantAllowedPppoeUsernames,
  getTenantAllowedPppoeUsernameSet,
  claimTenantPppoeUsername,
  releaseTenantPppoeUsername,
  renameTenantPppoeUsername,
  assertTenantOwnsPppoeUsername,
  ensureTenantPppoeUsersTable
} = require('../utils/tenantPppoeOwnership');

const {
  claimTenantPppoeProfile
} = require('../utils/tenantPppoeProfileOwnership');

function clearPppoeAdminPageCache() {
  _pppoeAdminPageCacheByKey.clear();
  _pppoeProfilesApiCacheByKey.clear();
}

function getPppoeCacheKey(authMode) {
  const tid = hasTenantContext() ? String(getTenantId()) : 'central';
  return `${authMode}:${tid}`;
}

function getPppoeAdminPageCache(authMode) {
  const key = getPppoeCacheKey(authMode);
  const cached = _pppoeAdminPageCacheByKey.get(key);
  if (!cached) return null;
  if (Date.now() - cached.ts > PPPOE_PAGE_CACHE_MS) {
    _pppoeAdminPageCacheByKey.delete(key);
    return null;
  }
  return cached;
}

/** @deprecated use getTenantAllowedPppoeUsernames — retained name for local call sites */
async function getTenantPppoeUsernames() {
  return getTenantAllowedPppoeUsernames();
}

async function getTenantPppoeUsernameSet() {
  return getTenantAllowedPppoeUsernameSet();
}

function filterUsersForTenant(users, tenantSet) {
  if (!tenantSet) return users;
  return (users || []).filter((u) => {
    const name = String(u?.name || u?.username || '').toLowerCase().trim();
    return name && tenantSet.has(name);
  });
}

/**
 * Mode RADIUS: ALLOWLIST saja — hanya user milik tenant (pelanggan + owned manual).
 * Jangan pernah load seluruh radcheck lalu denylist tenant lain (itu sumber kebocoran).
 */
function mergeRadiusAndBillingUsers(radiusUsers, tenantUsernames, tenantBillingSet) {
  const map = new Map();

  for (const user of radiusUsers || []) {
    const name = String(user?.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const isBilling = tenantBillingSet ? tenantBillingSet.has(key) : false;
    map.set(key, {
      id: name,
      name,
      password: user.password || '',
      profile: user.profile || 'default',
      profile_display: user.profile_display || user.profile || 'default',
      active: !!user.active,
      nas_name: 'RADIUS',
      nas_ip: 'RADIUS Server',
      account_kind: isBilling ? 'pelanggan' : 'gratis',
    });
  }

  // Username milik tenant yang belum ada di RADIUS — tetap tampil
  for (const raw of tenantUsernames || []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (map.has(key)) continue;
    const isBilling = tenantBillingSet ? tenantBillingSet.has(key) : true;
    map.set(key, {
      id: name,
      name,
      password: '',
      profile: 'default',
      active: false,
      nas_name: 'RADIUS',
      nas_ip: 'Belum di RADIUS',
      account_kind: isBilling ? 'pelanggan' : 'gratis',
      missing_radius: true,
    });
  }

  return Array.from(map.values()).sort((a, b) =>
    String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' })
  );
}

async function getTenantBillingPppoeUsernameSet() {
  if (!hasTenantContext()) return null;
  const _t = billingManager._tenantWhere();
  return new Promise((resolve) => {
    billingManager.db.all(
      `SELECT DISTINCT LOWER(TRIM(pppoe_username)) AS u FROM customers
       WHERE pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''${_t.sql}`,
      [..._t.params],
      (err, rows) => {
        if (err) return resolve(new Set());
        resolve(new Set((rows || []).map((r) => r.u).filter(Boolean)));
      }
    );
  });
}

function withRouterTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout (${ROUTER_QUERY_TIMEOUT_MS}ms)`)), ROUTER_QUERY_TIMEOUT_MS)
    )
  ]);
}

function computeUserStats(users) {
  const list = Array.isArray(users) ? users : [];
  const activeUsers = list.filter((u) => u && u.active).length;
  return {
    totalUsers: list.length,
    activeUsers,
    offlineUsers: Math.max(list.length - activeUsers, 0),
    profileCount: new Set(list.map((u) => (u && u.profile) || '').filter(Boolean)).size
  };
}

// GET: List User PPPoE
router.get('/mikrotik', adminAuth, async (req, res) => {
  try {
    // Check auth mode
    const { getUserAuthModeAsync, getPPPoEUsersRadius } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    const forceRefresh = String(req.query.refresh || '') === '1';

    const cached = !forceRefresh ? getPppoeAdminPageCache(authMode) : null;
    if (cached) {
      const settings = req.tenantSettings || getSettingsWithCache();
      return res.render('adminMikrotik', {
        users: cached.combined,
        routers: cached.routers,
        authMode,
        userStats: cached.userStats,
        settings,
        versionInfo: getVersionInfo(),
        versionBadge: getVersionBadge()
      });
    }

    logger.info(`Loading PPPoE users in ${authMode} mode${forceRefresh ? ' (refresh)' : ''}`);

    await ensureTenantPppoeUsersTable();
    const tenantPppoeUsers = await getTenantPppoeUsernames();
    const tenantUserSet =
      tenantPppoeUsers === null
        ? null
        : new Set(tenantPppoeUsers.map((u) => String(u).toLowerCase().trim()).filter(Boolean));
    const tenantBillingSet = await getTenantBillingPppoeUsernameSet();
    let combined = [];
    let routers = [];

    if (authMode === 'radius') {
      // RADIUS mode: ALLOWLIST username milik tenant saja (pelanggan + manual owned).
      // Status online/offline: cek PPP active di Mikrotik milik tenant.
      logger.info(
        `RADIUS mode: Loading tenant-scoped PPPoE users ` +
        `(${tenantPppoeUsers === null ? 'no-tenant-filter' : (tenantPppoeUsers.length + ' allowed')})`
      );
      try {
        // Konteks tenant aktif + allowlist kosong → 0 user (jangan load seluruh radcheck).
        if (tenantPppoeUsers !== null && tenantPppoeUsers.length === 0) {
          combined = [];
          logger.info('RADIUS mode: tenant has no PPPoE usernames — returning empty list');
        } else {
          const tenantRouters = await getAllRoutersHelper();
          const usersRaw = await getPPPoEUsersRadius({
            allowedUsernames: tenantPppoeUsers === null ? null : tenantPppoeUsers,
            skipMikrotikActive: false,
            activeRouters: tenantRouters,
            mikrotikTimeoutMs: ROUTER_QUERY_TIMEOUT_MS,
            forceRefreshActive: forceRefresh
          });
          const users = Array.isArray(usersRaw) ? usersRaw : [];
          // Defense-in-depth: filter lagi di app layer
          const scopedUsers = filterUsersForTenant(users, tenantUserSet);
          logger.info(
            `Found ${users.length} RADIUS users for allowlist` +
            (tenantUserSet ? ` (${scopedUsers.length} after tenant filter)` : '')
          );

          combined = mergeRadiusAndBillingUsers(
            scopedUsers,
            tenantPppoeUsers || [],
            tenantBillingSet
          );
        }

        logger.info(
          `Mapped ${combined.length} users for display ` +
          `(${combined.filter((u) => u.active).length} online, ` +
          `${combined.filter((u) => u.account_kind === 'gratis').length} gratis/manual, ` +
          `${combined.filter((u) => u.missing_radius).length} billing belum di RADIUS)`
        );
      } catch (radiusError) {
        logger.error(`Error loading users from RADIUS: ${radiusError.message}`, radiusError);
        combined = [];
      }
      // No routers needed for RADIUS mode display columns
    } else {
      routers = await getAllRoutersHelper();

      logger.info(`Found ${routers.length} routers configured`);

      // OPTIMASI: Query semua router secara parallel (bukan sequential)
      // Sebelum: 5 router × 2 detik = 10 detik
      // Sesudah: Max(2 detik) = 2 detik (5x lebih cepat)
      const routerQueries = routers.map((r) => withRouterTimeout((async () => {
        try {
          const conn = await getMikrotikConnectionForRouter(r);
          const cacheKey = `admin_${r.id}`;
          const [secrets, active] = await Promise.all([
            getCachedFullPppSecrets(conn, cacheKey),
            getCachedPppActivePrint(conn, cacheKey)
          ]);
          const activeNames = new Set((active || []).map((a) => a.name));
          const routerUsers = (secrets || []).map((sec) => ({
            id: sec['.id'],
            name: sec.name,
            password: sec.password,
            profile: sec.profile,
            active: activeNames.has(sec.name),
            nas_name: r.name,
            nas_ip: r.nas_ip
          }));
          logger.info(`Loaded ${routerUsers.length} users from router ${r.name}`);
          return routerUsers;
        } catch (e) {
          logger.error(`Error getting users from router ${r.name}:`, e.message);
          return [];
        }
      })(), r.name));

      // Tunggu semua query selesai secara parallel
      const allRouterResults = await Promise.all(routerQueries);
      
      // Flatten hasil dari semua router
      combined = allRouterResults.flat();
      combined = filterUsersForTenant(combined, tenantUserSet);
    }
    
    const userStats = computeUserStats(combined);
    logger.info(`Total users to display: ${combined.length}`);

    _pppoeAdminPageCacheByKey.set(getPppoeCacheKey(authMode), {
      ts: Date.now(),
      authMode,
      combined,
      routers,
      userStats
    });

    const settings = req.tenantSettings || getSettingsWithCache();
    res.render('adminMikrotik', {
      users: combined,
      routers: routers,
      authMode: authMode,
      userStats,
      settings,
      versionInfo: getVersionInfo(),
      versionBadge: getVersionBadge()
    });
  } catch (err) {
    logger.error('Error loading PPPoE users:', err);
    logger.error('Error stack:', err.stack);
    const settings = getSettingsWithCache();
    res.render('adminMikrotik', {
      users: [],
      routers: [],
      authMode: 'mikrotik',
      userStats: { totalUsers: 0, activeUsers: 0, offlineUsers: 0, profileCount: 0 },
      error: `Gagal mengambil data user PPPoE: ${err.message}`,
      settings,
      versionInfo: getVersionInfo(),
      versionBadge: getVersionBadge()
    });
  }
});

// POST: Tambah User PPPoE
router.post('/mikrotik/add-user', adminAuth, async (req, res) => {
  try {
    const { username, password, profile, router_id } = req.body;
    
    // Check auth mode
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    if (authMode === 'radius') {
      // RADIUS mode: klaim kepemilikan tenant sebelum tulis ke radcheck bersama
      logger.info('RADIUS mode: Adding user to RADIUS database');
      try {
        await claimTenantPppoeUsername(username);
      } catch (claimErr) {
        return res.json({ success: false, message: claimErr.message });
      }
      const result = await addPPPoEUser({ username, password, profile });
      if (result.success) {
        clearPppoeAdminPageCache();
        return res.json({ success: true, message: result.message });
      } else {
        await releaseTenantPppoeUsername(username).catch(() => {});
        return res.json({ success: false, message: result.message });
      }
    }
    
    // Mikrotik API mode: Need router_id
    if (!router_id) {
      return res.json({ success: false, message: 'Pilih NAS (router) terlebih dahulu' });
    }
    
    const sqlite3 = require('sqlite3').verbose();
    const router = await new Promise((resolve) => billingManager.db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => resolve(row || null)));
    if (!router) {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }
    
    await addPPPoEUser({ username, password, profile, routerObj: router });
    clearPppoeAdminPageCache();
    clearPppPrintCachesForRouter(router.id);
    res.json({ success: true });
  } catch (err) {
    logger.error('Error adding PPPoE user:', err);
    res.json({ success: false, message: err.message });
  }
});

// POST: Edit User PPPoE
router.post('/mikrotik/edit-user', adminAuth, async (req, res) => {
  try {
    const { id, username, password, profile } = req.body;
    
    // Validasi: id harus ada untuk edit
    if (!id) {
      return res.json({ success: false, message: 'ID user tidak ditemukan. Pastikan Anda mengedit user yang sudah ada.' });
    }
    
    // Check auth mode
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    if (authMode === 'radius') {
      // RADIUS mode: id = username lama — wajib milik tenant ini
      try {
        await assertTenantOwnsPppoeUsername(id);
        if (username && String(username).trim() &&
            String(username).trim().toLowerCase() !== String(id).trim().toLowerCase()) {
          await renameTenantPppoeUsername(id, username);
        }
      } catch (ownErr) {
        return res.json({ success: false, message: ownErr.message });
      }
      const result = await editPPPoEUser({ id, username, password, profile });
      if (result.success) {
        clearPppoeAdminPageCache();
        return res.json({ success: true, message: result.message });
      } else {
        return res.json({ success: false, message: result.message });
      }
    }
    
    // Mikrotik API mode: id adalah Mikrotik ID
    logger.info(`Mikrotik API mode: Updating user. ID: ${id}, Username: ${username}`);
    const result = await editPPPoEUser({ id, username, password, profile });
    if (result.success) {
      clearPppoeAdminPageCache();
      return res.json({ success: true, message: result.message || 'User berhasil di-update' });
    } else {
      return res.json({ success: false, message: result.message || 'Gagal mengupdate user' });
    }
  } catch (err) {
    logger.error('Error editing PPPoE user:', err);
    logger.error('Error stack:', err.stack);
    res.json({ success: false, message: err.message || 'Terjadi kesalahan saat mengupdate user' });
  }
});

// POST: Hapus User PPPoE
router.post('/mikrotik/delete-user', adminAuth, async (req, res) => {
  try {
    const { id } = req.body;
    
    // Check auth mode
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    if (authMode === 'radius') {
      try {
        await assertTenantOwnsPppoeUsername(id);
      } catch (ownErr) {
        return res.json({ success: false, message: ownErr.message });
      }
      logger.info('RADIUS mode: Deleting user from RADIUS database');
      const result = await deletePPPoEUser(id); // In RADIUS mode, id is username
      if (result.success) {
        await releaseTenantPppoeUsername(id).catch(() => {});
        clearPppoeAdminPageCache();
        return res.json({ success: true, message: result.message });
      } else {
        return res.json({ success: false, message: result.message });
      }
    }
    
    // Mikrotik API mode
    await deletePPPoEUser(id);
    clearPppoeAdminPageCache();
    res.json({ success: true });
  } catch (err) {
    logger.error('Error deleting PPPoE user:', err);
    res.json({ success: false, message: err.message });
  }
});

const multer = require('multer');
const pppoeImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    const ok =
      name.endsWith('.xlsx') ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/octet-stream';
    cb(ok ? null : new Error('Hanya file Excel .xlsx yang diizinkan'), ok);
  }
});

function unwrapExcelCellValue(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (value.text != null) return String(value.text).trim();
    if (value.result != null) return String(value.result).trim();
    if (Array.isArray(value.richText)) {
      return value.richText.map((t) => t.text || '').join('').trim();
    }
    if (value.hyperlink != null && value.text != null) return String(value.text).trim();
  }
  return String(value).trim();
}

function buildPppoeImportHeaderMap(headerRow) {
  const map = {};
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const raw = unwrapExcelCellValue(cell.value).toLowerCase().replace(/[\s_-]+/g, '');
    if (!raw) return;
    if (['username', 'user', 'pppoeusername', 'login'].includes(raw)) map.username = colNumber;
    else if (['password', 'pass', 'passwd', 'sandi'].includes(raw)) map.password = colNumber;
    else if (['profile', 'groupname', 'profil', 'pppoeprofile'].includes(raw)) map.profile = colNumber;
  });
  return map;
}

function exportFilename(kind) {
  const tid = hasTenantContext() ? `t${getTenantId()}` : 'platform';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `pppoe-${kind}-${tid}-${stamp}.xlsx`;
}

async function writePppoeExcel(res, sheetName, columns, rows, filename) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet(sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }]
  });
  worksheet.columns = columns;
  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true };
  for (const row of rows) {
    worksheet.addRow(row);
  }
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

// GET: Export user PPPoE milik tenant (Excel) — aman multi-tenant, bukan dump RADIUS penuh
router.get('/mikrotik/export-pppoe-users', adminAuth, async (req, res) => {
  try {
    const { getUserAuthModeAsync, getPPPoEUsers } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();

    await ensureTenantPppoeUsersTable();
    const tenantPppoeUsers = await getTenantPppoeUsernames();
    const tenantBillingSet = await getTenantBillingPppoeUsernameSet();

    let users = [];
    if (authMode === 'radius') {
      const { getPPPoEUsersRadius } = require('../config/mikrotik');
      const radiusUsers = await getPPPoEUsersRadius({
        allowedUsernames: tenantPppoeUsers === null ? null : tenantPppoeUsers,
        skipMikrotikActive: true
      });
      users = await mergeRadiusAndBillingUsers(radiusUsers || [], tenantPppoeUsers, tenantBillingSet);
    } else {
      const result = await getPPPoEUsers();
      users = Array.isArray(result) ? result : result?.data || [];
      if (tenantPppoeUsers !== null) {
        const allow = new Set(tenantPppoeUsers.map((u) => String(u).toLowerCase().trim()));
        users = users.filter((u) => allow.has(String(u.name || u.username || '').toLowerCase().trim()));
      }
    }

    const rows = (users || []).map((u) => {
      const username = u.name || u.username || '';
      return {
        username,
        password: u.password || '',
        profile: u.profile || '',
        in_radius: u.missing_radius ? 'no' : 'yes'
      };
    });

    const filename = exportFilename('users');
    logger.info(`[PPPoE-EXPORT] users xlsx rows=${rows.length} file=${filename}`);
    await writePppoeExcel(
      res,
      'User PPPoE',
      [
        { header: 'Username', key: 'username', width: 28 },
        { header: 'Password', key: 'password', width: 20 },
        { header: 'Profile', key: 'profile', width: 24 },
        { header: 'Di RADIUS', key: 'in_radius', width: 12 }
      ],
      rows,
      filename
    );
  } catch (err) {
    logger.error('Error exporting PPPoE users:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: err.message || 'Gagal export user PPPoE' });
    }
  }
});

// GET: Export profile PPPoE milik tenant (Excel)
router.get('/mikrotik/export-pppoe-profiles', adminAuth, async (req, res) => {
  try {
    const result = await getPPPoEProfiles();
    const profiles = result?.success ? result.data || [] : Array.isArray(result) ? result : [];

    const rows = (profiles || []).map((p) => ({
      profile_name: p.name || p.groupname || '',
      groupname: p.groupname || p['.id'] || p.name || '',
      rate_limit: p['rate-limit'] || p.rate_limit || '',
      local_address: p.localAddress || p['local-address'] || '',
      remote_address: p.remoteAddress || p['remote-address'] || '',
      dns_server: p.dnsServer || p['dns-server'] || '',
      address_list: p.addressList || p['address-list'] || '',
      comment: p.comment || '',
      is_system: p.is_system_profile || p.is_isolir ? 'yes' : 'no'
    }));

    const filename = exportFilename('profiles');
    logger.info(`[PPPoE-EXPORT] profiles xlsx rows=${rows.length} file=${filename}`);
    await writePppoeExcel(
      res,
      'Profile PPPoE',
      [
        { header: 'Nama Profile', key: 'profile_name', width: 28 },
        { header: 'Groupname', key: 'groupname', width: 28 },
        { header: 'Rate Limit', key: 'rate_limit', width: 22 },
        { header: 'Local Address', key: 'local_address', width: 16 },
        { header: 'Remote Address', key: 'remote_address', width: 18 },
        { header: 'DNS Server', key: 'dns_server', width: 20 },
        { header: 'Address List', key: 'address_list', width: 18 },
        { header: 'Comment', key: 'comment', width: 30 },
        { header: 'Sistem', key: 'is_system', width: 10 }
      ],
      rows,
      filename
    );
  } catch (err) {
    logger.error('Error exporting PPPoE profiles:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: err.message || 'Gagal export profile PPPoE' });
    }
  }
});

// GET: Template Excel import user PPPoE
router.get('/mikrotik/import-pppoe-users/template', adminAuth, async (req, res) => {
  try {
    await writePppoeExcel(
      res,
      'User PPPoE',
      [
        { header: 'Username', key: 'username', width: 28 },
        { header: 'Password', key: 'password', width: 20 },
        { header: 'Profile', key: 'profile', width: 24 }
      ],
      [
        { username: 'contoh-user', password: 'rahasia123', profile: 'nama_profile' }
      ],
      'template-import-pppoe-users.xlsx'
    );
  } catch (err) {
    logger.error('Error creating PPPoE import template:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: err.message || 'Gagal buat template' });
    }
  }
});

// POST: Import user PPPoE dari Excel (.xlsx)
router.post(
  '/mikrotik/import-pppoe-users',
  adminAuth,
  (req, res, next) => {
    pppoeImportUpload.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, message: err.message || 'Upload gagal' });
      }
      return next();
    });
  },
  async (req, res) => {
    try {
      if (!hasTenantContext()) {
        return res.status(400).json({
          success: false,
          message: 'Import PPPoE hanya dari panel tenant yang aktif (bukan platform tanpa tenant).'
        });
      }
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ success: false, message: 'File Excel (.xlsx) wajib diunggah' });
      }

      const { getUserAuthModeAsync } = require('../config/mikrotik');
      const authMode = await getUserAuthModeAsync();
      let routerObj = null;

      if (authMode !== 'radius') {
        const routerId = parseInt(String(req.body.router_id || '').trim(), 10);
        if (!routerId) {
          return res.status(400).json({
            success: false,
            message: 'Mode Mikrotik: pilih NAS (router_id) untuk import.'
          });
        }
        routerObj = await new Promise((resolve) => {
          billingManager.db.get(
            'SELECT * FROM routers WHERE id=?' + _routerTenantAnd(),
            [routerId],
            (err, row) => resolve(row || null)
          );
        });
        if (!routerObj) {
          return res.status(400).json({ success: false, message: 'Router tidak ditemukan' });
        }
      }

      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const worksheet =
        workbook.getWorksheet('User PPPoE') ||
        workbook.worksheets.find((ws) => ws && ws.rowCount > 0) ||
        workbook.worksheets[0];
      if (!worksheet) {
        return res.status(400).json({ success: false, message: 'Worksheet tidak ditemukan dalam file' });
      }

      const headerMap = buildPppoeImportHeaderMap(worksheet.getRow(1));
      if (!headerMap.username || !headerMap.password) {
        return res.status(400).json({
          success: false,
          message: 'Header wajib: Username dan Password (opsional: Profile). Sesuaikan dengan template/export.'
        });
      }

      const MAX_ROWS = 3000;
      const MAX_ERROR_SAMPLES = 40;
      let created = 0;
      let updated = 0;
      let skipped = 0;
      let failed = 0;
      const errors = [];
      const seenInFile = new Set();

      await ensureTenantPppoeUsersTable();
      const tenantOwnedSet = await getTenantAllowedPppoeUsernameSet();

      for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
        if (created + updated + failed + skipped >= MAX_ROWS) {
          errors.push(`Dihentikan: maksimal ${MAX_ROWS} baris data per import`);
          break;
        }

        const row = worksheet.getRow(rowNumber);
        const username = unwrapExcelCellValue(row.getCell(headerMap.username).value);
        const password = unwrapExcelCellValue(row.getCell(headerMap.password).value);
        const profile = headerMap.profile
          ? unwrapExcelCellValue(row.getCell(headerMap.profile).value)
          : '';

        if (!username && !password && !profile) {
          skipped += 1;
          continue;
        }
        if (!username) {
          failed += 1;
          if (errors.length < MAX_ERROR_SAMPLES) {
            errors.push(`Baris ${rowNumber}: username kosong`);
          }
          continue;
        }
        if (!password) {
          failed += 1;
          if (errors.length < MAX_ERROR_SAMPLES) {
            errors.push(`Baris ${rowNumber} (${username}): password kosong`);
          }
          continue;
        }

        const key = username.toLowerCase();
        if (seenInFile.has(key)) {
          skipped += 1;
          if (errors.length < MAX_ERROR_SAMPLES) {
            errors.push(`Baris ${rowNumber} (${username}): duplikat dalam file, dilewati`);
          }
          continue;
        }
        seenInFile.add(key);

        const existedBefore = !!(tenantOwnedSet && tenantOwnedSet.has(key));

        try {
          try {
            await claimTenantPppoeUsername(username);
          } catch (claimErr) {
            if (!existedBefore) throw claimErr;
          }

          const result = await addPPPoEUser({
            username,
            password,
            profile: profile || null,
            routerObj: routerObj || null
          });

          if (!result || result.success === false) {
            if (!existedBefore) {
              await releaseTenantPppoeUsername(username).catch(() => {});
            }
            failed += 1;
            if (errors.length < MAX_ERROR_SAMPLES) {
              errors.push(
                `Baris ${rowNumber} (${username}): ${(result && result.message) || 'gagal simpan'}`
              );
            }
            continue;
          }

          if (existedBefore) updated += 1;
          else {
            created += 1;
            if (tenantOwnedSet) tenantOwnedSet.add(key);
          }
        } catch (rowErr) {
          failed += 1;
          if (errors.length < MAX_ERROR_SAMPLES) {
            errors.push(`Baris ${rowNumber} (${username}): ${rowErr.message || rowErr}`);
          }
        }
      }

      clearPppoeAdminPageCache();
      if (routerObj && routerObj.id) {
        clearPppPrintCachesForRouter(routerObj.id);
      }

      logger.info(
        `[PPPoE-IMPORT] tenant=${getTenantId()} created=${created} updated=${updated} failed=${failed} skipped=${skipped}`
      );

      return res.json({
        success: failed === 0,
        message:
          failed === 0
            ? `Import selesai: ${created} baru, ${updated} diperbarui`
            : `Import selesai dengan error: ${created} baru, ${updated} diperbarui, ${failed} gagal`,
        created,
        updated,
        failed,
        skipped,
        errors
      });
    } catch (err) {
      logger.error('Error importing PPPoE users:', err);
      return res.status(500).json({
        success: false,
        message: err.message || 'Gagal import user PPPoE'
      });
    }
  }
);

// GET: List Profile PPPoE
router.get('/mikrotik/profiles', adminAuth, async (req, res) => {
  let profiles = [];
  let routers = [];
  let authMode = 'mikrotik';
  let settings = getSettingsWithCache();

  try {
    // Check auth mode
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    authMode = await getUserAuthModeAsync();
    
    // Always fetch routers regardless of authMode to ensure dropdown is populated
    logger.info(`[DIAGNOSTIC] Fetching routers via billingManager (authMode: ${authMode})`);
    routers = await new Promise((resolve) => {
      billingManager.db.all(('SELECT * FROM routers' + _routerTenantWhere() + ' ORDER BY id'), [], (err, rows) => {
        if (err) {
          logger.error('[DIAGNOSTIC] Database error fetching routers:', err.message);
          resolve([]);
        } else {
          logger.info(`[DIAGNOSTIC] Found ${rows ? rows.length : 0} routers in billingManager.db`);
          resolve(rows || []);
        }
      });
    });

    if (authMode === 'radius') {
      // RADIUS mode: Get profiles from RADIUS database
      logger.info('[DIAGNOSTIC] authMode is radius, getting profiles from RADIUS db');
      const result = await getPPPoEProfiles();
      if (result.success) {
        profiles = result.data || [];
      }
    } else {
      // Mikrotik API mode: Profiles are aggregated from all routers (already fetched above)

      // Aggregate profiles from all NAS
      for (const router of routers) {
        try {
          const result = await getPPPoEProfiles(router);
          if (result.success && Array.isArray(result.data)) {
            result.data.forEach(prof => {
              profiles.push({
                ...prof,
                nas_id: router.id,
                nas_name: router.name,
                nas_ip: router.nas_ip
              });
            });
          }
        } catch (e) {
          logger.error(`Error getting profiles from ${router.name}:`, e.message);
        }
      }
    }

    res.render('adminMikrotikProfiles', { 
      profiles: profiles, 
      routers: routers,
      authMode: authMode, // Pass auth mode to view
      page: 'mikrotik-profiles', // Current page for sidebar
      settings,
      versionInfo: getVersionInfo(),
      versionBadge: getVersionBadge()
    });
  } catch (err) {
    logger.error('Error loading PPPoE profiles:', err);
    
    // Ensure routers is defined for the error block render
    if (!routers || routers.length === 0) {
      try {
        routers = await getAllRoutersHelper();
      } catch (dbErr) {
        routers = [];
      }
    }

    res.render('adminMikrotikProfiles', { 
      profiles: [], 
      routers: routers, // Use preserved or refetched routers
      authMode: authMode || 'mikrotik',
      error: 'Gagal mengambil data profile PPPoE: ' + err.message, 
      settings,
      versionInfo: getVersionInfo(),
      versionBadge: getVersionBadge()
    });
  }
});

// GET: API Daftar Profile PPPoE (untuk dropdown)
router.get('/mikrotik/profiles/api', adminAuth, async (req, res) => {
  try {
    const { router_id } = req.query;
    const forceRefresh = String(req.query.refresh || '') === '1';

    // Check if system is in RADIUS mode
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    if (authMode === 'radius') {
      // include_assigned=1: grup di radusergroup yang belum di radgroupreply (hanya untuk dropdown user PPPoE), bukan halaman daftar profil
      const includeAssigned = String(req.query.include_assigned || '').trim() === '1';
      logger.info(
        `RADIUS mode: profiles API (include_assigned=${includeAssigned ? '1' : '0'})`
      );
      const result = await getPPPoEProfiles(null, {
        mergeAssignedGroups: includeAssigned
      });
      if (result.success) {
        return res.json({ 
          success: true, 
          profiles: result.data || [],
          message: `Ditemukan ${result.data?.length || 0} profile dari RADIUS`
        });
      } else {
        return res.json({ 
          success: true, 
          profiles: [], 
          message: result.message || 'Tidak ada profile ditemukan di RADIUS'
        });
      }
    }

    if (!router_id && !forceRefresh) {
      const cacheKey = getPppoeCacheKey(authMode);
      const cached = _pppoeProfilesApiCacheByKey.get(cacheKey);
      if (cached && Date.now() - cached.ts < PPPOE_PROFILES_CACHE_MS) {
        return res.json(cached.payload);
      }
    }

    // If router_id is provided, only fetch from that router
    if (router_id) {
      const routerObj = await new Promise((resolve) => billingManager.db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => {
        resolve(row || null);
      }));
      
      if (!routerObj) {
        return res.json({ success: false, profiles: [], message: 'Router tidak ditemukan' });
      }
      
      try {
        const result = await getPPPoEProfiles(routerObj);
        if (result.success) {
          return res.json({ success: true, profiles: result.data || [] });
        } else {
          // Return empty array instead of error to prevent UI blocking
          logger.warn(`Failed to get profiles from router ${routerObj.name}: ${result.message}`);
          return res.json({ success: true, profiles: [], message: `Tidak dapat mengambil profile dari ${routerObj.name}. Pastikan router dapat diakses.` });
        }
      } catch (profileError) {
        logger.error(`Error getting profiles from router ${routerObj.name}:`, profileError.message);
        return res.json({ success: true, profiles: [], message: `Error: ${profileError.message}` });
      }
    } else {
      const routers = await getAllRoutersHelper();
      
      if (!routers || routers.length === 0) {
        return res.json({ 
          success: true, 
          profiles: [], 
          message: 'Tidak ada router yang dikonfigurasi. Silakan tambahkan router terlebih dahulu.' 
        });
      }
      
      const profileResults = await Promise.all(
        routers.map((router) =>
          withRouterTimeout(
            getPPPoEProfiles(router).then((result) => ({ router, result })),
            router.name
          ).catch((routerError) => ({
            router,
            error: routerError.message
          }))
        )
      );

      let allProfiles = [];
      const errors = [];

      profileResults.forEach((entry) => {
        if (entry.error) {
          errors.push(`${entry.router.name}: ${entry.error}`);
          return;
        }
        const { router, result } = entry;
        if (result.success && Array.isArray(result.data)) {
          allProfiles = allProfiles.concat(
            result.data.map((prof) => ({
              ...prof,
              nas_id: router.id,
              nas_name: router.name,
              nas_ip: router.nas_ip
            }))
          );
        } else {
          errors.push(`${router.name}: ${result.message || 'Unknown error'}`);
        }
      });

      const payload = allProfiles.length > 0 || errors.length === 0
        ? {
            success: true,
            profiles: allProfiles,
            message: errors.length > 0 ? `Beberapa router tidak dapat diakses: ${errors.join(', ')}` : undefined
          }
        : {
            success: true,
            profiles: [],
            message: `Tidak dapat mengambil profile dari router: ${errors.join(', ')}. Pastikan router dapat diakses dan kredensial benar.`
          };

      _pppoeProfilesApiCacheByKey.set(getPppoeCacheKey(authMode), {
        ts: Date.now(),
        payload
      });
      return res.json(payload);
    }
  } catch (err) {
    logger.error('Error in /mikrotik/profiles/api:', err);
    // Return empty array instead of error to prevent UI blocking
    res.json({ 
      success: true, 
      profiles: [], 
      message: `Error: ${err.message || 'Gagal mengambil daftar profile PPPOE'}` 
    });
  }
});

// GET: API Detail Profile PPPoE
router.get('/mikrotik/profile/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await getPPPoEProfileDetail(id);
    if (result.success) {
      res.json({ success: true, profile: result.data });
    } else {
      res.json({ success: false, profile: null, message: result.message });
    }
  } catch (err) {
    res.json({ success: false, profile: null, message: err.message });
  }
});

// POST: Tambah Profile PPPoE
router.post('/mikrotik/add-profile', adminAuth, async (req, res) => {
  let routerObj = null;
  let profileData = {};
  let authMode = 'mikrotik';

  try {
    const { router_id, ...data } = req.body;
    profileData = data;
    
    // Check auth mode
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    authMode = await getUserAuthModeAsync();

    if (router_id) {
      routerObj = await findRouterHelper(router_id);
    }
    
    if (!routerObj && authMode !== 'radius') {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }
    
    const result = await addPPPoEProfile(profileData, routerObj);
    if (result.success) {
      try {
        const name = result.groupname || (profileData.name || '').toLowerCase().replace(/\s+/g, '_');
        if (name) await claimTenantPppoeProfile(name);
      } catch (claimErr) {
        logger.warn(`[add-profile] claim after create: ${claimErr.message}`);
      }
      clearPppoeAdminPageCache();
      res.json({ success: true });
    } else {
      res.json({ success: false, message: result.message || 'Gagal menyimpan profile' });
    }
  } catch (err) {
    logger.error('Error adding PPPoE profile:', err);
    res.json({ success: false, message: err.message || 'Terjadi kesalahan sistem saat menyimpan profile' });
  }
});

// POST: Edit Profile PPPoE
router.post('/mikrotik/edit-profile', adminAuth, async (req, res) => {
  let routerObj = null;
  let profileData = {};

  try {
    const { router_id, ...data } = req.body;
    profileData = data;
    
    // Check auth mode
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    if (authMode === 'radius') {
      // RADIUS mode: Update in radgroupreply
      logger.info('RADIUS mode: Updating profile in RADIUS database');
      const result = await editPPPoEProfile(profileData);
      if (result.success) {
        clearPppoeAdminPageCache();
        return res.json({ success: true, message: result.message });
      } else {
        return res.json({ success: false, message: result.message || 'Gagal mengubah profile' });
      }
    }
    
    // Mikrotik API mode
    if (router_id) {
      routerObj = await findRouterHelper(router_id);
    }
    
    if (!routerObj) {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }
    
    const result = await editPPPoEProfile(profileData, routerObj);
    if (result.success) {
      clearPppoeAdminPageCache();
      res.json({ success: true });
    } else {
      res.json({ success: false, message: result.message || 'Gagal mengubah profile' });
    }
  } catch (err) {
    logger.error('Error editing PPPoE profile:', err);
    res.json({ success: false, message: err.message || 'Terjadi kesalahan sistem saat mengubah profile' });
  }
});

// POST: Hapus Profile PPPoE
router.post('/mikrotik/delete-profile', adminAuth, async (req, res) => {
  try {
    const { id, router_id } = req.body;
    
    // Check auth mode
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    if (authMode === 'radius') {
      // RADIUS mode: Delete from radgroupreply
      logger.info('RADIUS mode: Deleting profile from RADIUS database');
      const result = await deletePPPoEProfile(id);
      if (result.success) {
        clearPppoeAdminPageCache();
        return res.json({ success: true, message: result.message });
      } else {
        return res.json({ success: false, message: result.message });
      }
    }
    
    // Mikrotik API mode
    let routerObj = null;
    if (router_id) {
      routerObj = await findRouterHelper(router_id);
    }
    const result = await deletePPPoEProfile(id, routerObj);
    if (result.success) {
      clearPppoeAdminPageCache();
      res.json({ success: true });
    } else {
      res.json({ success: false, message: result.message });
    }
  } catch (err) {
    logger.error('Error deleting PPPoE profile:', err);
    res.json({ success: false, message: err.message });
  }
});

// GET: List Profile Hotspot — render cepat; data dimuat via API (AJAX)
router.get('/mikrotik/hotspot-profiles', adminAuth, async (req, res) => {
  const routerWhereSql = captureRouterTenantWhere(req);
  try {
    let userAuthMode = 'mikrotik';
    try {
      const { getRadiusConfigValue } = require('../config/radiusConfig');
      const mode = await getRadiusConfigValue('user_auth_mode', null);
      if (mode) userAuthMode = mode;
    } catch (_) { /* ignore */ }

    const { pickSidebarSettings } = require('../config/platform/tenantAppSettings');
    const settings = pickSidebarSettings(req.tenantSettings || {}, req.tenant);

    const routers = await new Promise((resolve) => {
      billingManager.db.all(
        `SELECT id, name, nas_ip, port FROM routers${routerWhereSql} ORDER BY id`,
        [],
        (err, rows) => {
          if (err) {
            logger.error('[hotspot-profiles] routers:', err.message);
            resolve([]);
          } else {
            resolve(rows || []);
          }
        }
      );
    });

    const routerWarning = (!routers || routers.length === 0)
      ? 'Tidak ada router/NAS yang dikonfigurasi. Silakan tambahkan router terlebih dahulu di menu NAS (RADIUS).'
      : null;

    res.render('adminMikrotikHotspotProfiles', {
      profiles: [],
      routers,
      settings,
      error: routerWarning,
      versionInfo: getVersionInfo(),
      versionBadge: getVersionBadge(),
      userAuthMode,
      page: 'hotspot-profiles',
      tenantSubdomain: req.tenant?.subdomain || req.tenant?.slug || ''
    });
  } catch (err) {
    console.error('Error in hotspot profiles GET route:', err);
    const { pickSidebarSettings } = require('../config/platform/tenantAppSettings');
    res.render('adminMikrotikHotspotProfiles', {
      profiles: [],
      routers: [],
      settings: pickSidebarSettings(req.tenantSettings || {}, req.tenant),
      error: `Terjadi kesalahan: ${err.message}`,
      versionInfo: getVersionInfo(),
      versionBadge: getVersionBadge(),
      userAuthMode: 'mikrotik',
      page: 'hotspot-profiles'
    });
  }
});

// GET: API Daftar Profile Hotspot
router.get('/mikrotik/hotspot-profiles/api', adminAuth, async (req, res) => {
  const routerAndSql = captureRouterTenantAnd(req);
  try {
    const { router_id } = req.query;
    
    // If router_id is provided, only fetch from that router
    if (router_id) {
      const routerObj = await new Promise((resolve) => {
        billingManager.db.get(
          `SELECT * FROM routers WHERE id=?${routerAndSql}`,
          [parseInt(router_id, 10)],
          (err, row) => resolve(err ? null : (row || null))
        );
      });
      if (!routerObj) {
        return res.json({ success: false, profiles: [], message: 'Router tidak ditemukan' });
      }
      const result = await getHotspotProfiles(routerObj);
      if (result.success) {
        // Ensure router info is attached
        const profilesWithRouter = result.data.map(prof => ({
          ...prof,
          nas_id: routerObj.id,
          nas_name: routerObj.name,
          nas_ip: routerObj.nas_ip
        }));
        return res.json({ success: true, profiles: profilesWithRouter });
      } else {
        return res.json({ success: false, profiles: [], message: result.message });
      }
    }
    
    const routers = await getAllRoutersForRequest(req);
    
    if (!routers || routers.length === 0) {
      return res.json({
        success: true,
        profiles: [],
        no_routers: true,
        message: 'Tidak ada router/NAS untuk tenant ini. Tambahkan di menu RADIUS → NAS.'
      });
    }
    
    let combined = [];
    let errorMessages = [];
    for (const r of routers) {
      try {
        console.log(`=== API: Attempting to get hotspot profiles from router: ${r.name} (${r.nas_ip}:${r.port || 8728}) ===`);
        const result = await getHotspotProfiles(r);
        console.log(`=== API: Result from ${r.name}:`, {
          success: result.success,
          message: result.message,
          dataCount: result.data ? result.data.length : 0
        });
        
        if (result.success && Array.isArray(result.data)) {
          console.log(`✓ API: Successfully retrieved ${result.data.length} profiles from ${r.name}`);
          result.data.forEach(prof => {
            const profileObj = {
              ...prof,
              nas_id: r.id,
              nas_name: r.name,
              nas_ip: r.nas_ip
            };
            combined.push(profileObj);
            console.log(`  - API: Added profile: ${prof.name || prof['name'] || 'unnamed'} from ${r.name} (nas_id: ${r.id}, nas_name: ${r.name}, nas_ip: ${r.nas_ip})`);
          });
        } else {
          console.warn(`✗ API: Failed to get profiles from ${r.name}:`, result.message);
          errorMessages.push(`${r.name}: ${result.message}`);
        }
      } catch (e) {
        console.error(`✗ API: Error getting hotspot profiles from ${r.name} (${r.nas_ip}:${r.port || 8728}):`, e.message);
        errorMessages.push(`${r.name}: ${e.message}`);
      }
    }
    
    console.log(`=== API: Total profiles collected: ${combined.length} ===`);
    
    res.json({ 
      success: true, 
      profiles: combined,
      error: errorMessages.length > 0 ? `Beberapa router gagal: ${errorMessages.join('; ')}` : null
    });
  } catch (err) {
    console.error('Error in hotspot profiles API route:', err);
    res.json({ success: false, profiles: [], message: err.message });
  }
});

// GET: API Detail Profile Hotspot
router.get('/mikrotik/hotspot-profiles/detail/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { router_id } = req.query;
    let routerObj = null;
    if (router_id) {
      routerObj = await findRouterHelper(router_id);
    }
    const result = await getHotspotProfileDetail(id, routerObj);
    if (result.success) {
      res.json({ success: true, profile: result.data });
    } else {
      res.json({ success: false, profile: null, message: result.message });
    }
  } catch (err) {
    res.json({ success: false, profile: null, message: err.message });
  }
});

// POST: Tambah Profile Hotspot
router.post('/mikrotik/hotspot-profiles/add', adminAuth, async (req, res) => {
  try {
    const { router_id } = req.body;
    // Untuk mode Mikrotik API, perlu router
    if (!router_id) {
      return res.json({ success: false, message: 'Pilih NAS (router) terlebih dahulu' });
    }
    const routerObj = await new Promise((resolve) => billingManager.db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => {
      resolve(row || null);
    }));
    if (!routerObj) {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }
    // Clean profileData: remove undefined, null, empty strings, and unsupported parameters
    // Note: local-address, remote-address, dns-server, parent-queue, address-list
    // are NOT supported for hotspot user profile in Mikrotik
    const cleanProfileData = {};
    const unsupportedParams = ['local-address', 'remote-address', 'dns-server', 'parent-queue', 'address-list', 'limitUptime', 'limitUptimeUnit', 'validity', 'validityUnit'];
    Object.keys(req.body).forEach(key => {
      if (key === 'router_id' || key === 'id') return;
      const value = req.body[key];
      // Skip unsupported parameters and null/undefined values
      // Empty strings are OK for optional fields, they will be filtered in addHotspotProfile
      if (value !== undefined && value !== null && !unsupportedParams.includes(key)) {
        cleanProfileData[key] = value;
      }
    });
    console.log('Cleaned profileData for add:', cleanProfileData);
    const result = await addHotspotProfile(cleanProfileData, routerObj);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: result.message });
    }
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// POST: Edit Profile Hotspot
router.post('/mikrotik/hotspot-profiles/edit', adminAuth, async (req, res) => {
  try {
    const { id, router_id } = req.body;

    // Untuk halaman Mikrotik, semua operasi edit dilakukan langsung ke router (RouterOS),
    // tidak lagi ke database RADIUS.
    if (!router_id) {
      return res.json({ success: false, message: 'Pilih NAS (router) terlebih dahulu' });
    }
    if (!id) {
      return res.json({ success: false, message: 'ID profile tidak ditemukan' });
    }
    const routerObj = await new Promise((resolve) => billingManager.db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => {
      resolve(row || null);
    }));
    if (!routerObj) {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }
    // Clean profileData: remove undefined, null values, and unsupported parameters
    // Note: local-address, remote-address, dns-server, parent-queue, address-list
    // are NOT supported for hotspot user profile in Mikrotik
    const cleanProfileData = {};
    const unsupportedParams = ['local-address', 'remote-address', 'dns-server', 'parent-queue', 'address-list', 'limitUptime', 'limitUptimeUnit', 'validity', 'validityUnit'];
    Object.keys(req.body).forEach(key => {
      if (key === 'router_id') return; // router_id tidak dikirim ke Mikrotik
      const value = req.body[key];
      // Skip unsupported parameters and null/undefined values
      if (value !== undefined && value !== null && !unsupportedParams.includes(key)) {
        cleanProfileData[key] = value;
      }
    });
    console.log('Cleaned profileData for edit:', cleanProfileData);
    const result = await editHotspotProfile(cleanProfileData, routerObj);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: result.message });
    }
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// POST: Hapus Profile Hotspot
router.post('/mikrotik/hotspot-profiles/delete', adminAuth, async (req, res) => {
  try {
    const { id, router_id, name } = req.body;

    // Untuk mode Mikrotik API, perlu router
    if (!router_id) {
      return res.json({ success: false, message: 'Pilih NAS (router) terlebih dahulu' });
    }
    if (!id) {
      return res.json({ success: false, message: 'ID profile tidak ditemukan' });
    }
    const routerObj = await new Promise((resolve) => billingManager.db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => {
      resolve(row || null);
    }));
    if (!routerObj) {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }
    const result = await deleteHotspotProfile(id, routerObj);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: result.message });
    }
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// POST: Putuskan sesi PPPoE user
router.post('/mikrotik/disconnect-session', adminAuth, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.json({ success: false, message: 'Username tidak boleh kosong' });
    
    // Check auth mode
    const { getUserAuthModeAsync, disconnectPPPoEUser, getMikrotikConnectionForRouter } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    logger.info(`${authMode} mode: Disconnecting session for user ${username}`);
    
    // Ambil daftar router
    const routers = await new Promise((resolve) => billingManager.db.all(('SELECT * FROM routers' + _routerTenantWhere() + ' ORDER BY id'), (err, rows) => resolve(rows || [])));
    
    if (!routers || routers.length === 0) {
      return res.json({ success: false, message: 'Tidak ada router yang dikonfigurasi' });
    }
    
    // Cari router yang memiliki user aktif
    let foundRouter = null;
    let foundActiveSession = false;
    
    for (const router of routers) {
      try {
        const conn = await getMikrotikConnectionForRouter(router);
        const activeSessions = await conn.write('/ppp/active/print', [`?name=${username}`]);
        
        if (activeSessions && activeSessions.length > 0) {
          foundRouter = router;
          foundActiveSession = true;
          logger.info(`Found active session for ${username} on router ${router.name}`);
          break;
        }
      } catch (routerError) {
        logger.warn(`Error checking router ${router.name}: ${routerError.message}`);
        // Continue to next router
      }
    }
    
    // Jika tidak ditemukan user aktif di router manapun, return success dengan message
    if (!foundActiveSession) {
      logger.info(`No active session found for ${username} on any router`);
      return res.json({ 
        success: true, 
        message: `User ${username} tidak sedang online`, 
        disconnected: 0 
      });
    }
    
    // Disconnect menggunakan router yang ditemukan (hanya jika ada session aktif)
    const result = await disconnectPPPoEUser(username, foundRouter);
    return res.json(result);
  } catch (err) {
    logger.error(`Error disconnecting session for ${req.body.username}:`, err);
    res.json({ success: false, message: err.message || 'Gagal memutuskan sesi' });
  }
});

// GET: Get PPPoE user statistics
router.get('/mikrotik/user-stats', adminAuth, async (req, res) => {
  try {
    // Check auth mode
    const { getUserAuthModeAsync, getRadiusStatistics } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    const forceRefresh = String(req.query.refresh || '') === '1';

    const pageCached = !forceRefresh ? getPppoeAdminPageCache(authMode) : null;
    if (pageCached && pageCached.userStats) {
      return res.json({
        success: true,
        totalUsers: pageCached.userStats.totalUsers,
        activeUsers: pageCached.userStats.activeUsers,
        offlineUsers: pageCached.userStats.offlineUsers,
        profileCount: pageCached.userStats.profileCount
      });
    }

    if (authMode === 'radius') {
      // RADIUS mode: Get statistics from RADIUS database
      logger.info('RADIUS mode: Getting user statistics from RADIUS database');
      try {
        const stats = await getRadiusStatistics();
        return res.json({ 
          success: true, 
          totalUsers: stats.total || 0, 
          activeUsers: stats.active || 0, 
          offlineUsers: stats.offline || 0
        });
      } catch (radiusError) {
        logger.error(`Error getting RADIUS statistics: ${radiusError.message}`);
        return res.json({ 
          success: true, 
          totalUsers: 0, 
          activeUsers: 0, 
          offlineUsers: 0 
        });
      }
    }
    
    logger.info('Mikrotik API mode: Getting user statistics from routers');
    const routers = await getAllRoutersHelper();
    const routerStats = await Promise.all(
      routers.map((r) =>
        withRouterTimeout(
          (async () => {
            const conn = await getMikrotikConnectionForRouter(r);
            const cacheKey = `admin_${r.id}`;
            const [secrets, active] = await Promise.all([
              getCachedFullPppSecrets(conn, cacheKey),
              getCachedPppActivePrint(conn, cacheKey)
            ]);
            return {
              total: Array.isArray(secrets) ? secrets.length : 0,
              active: Array.isArray(active) ? active.length : 0
            };
          })(),
          r.name
        ).catch(() => ({ total: 0, active: 0 }))
      )
    );
    let totalUsers = 0;
    let activeUsers = 0;
    routerStats.forEach((s) => {
      totalUsers += s.total;
      activeUsers += s.active;
    });
    const offlineUsers = Math.max(totalUsers - activeUsers, 0);
    const profilesCache = _pppoeProfilesApiCacheByKey.get(getPppoeCacheKey(authMode || 'mikrotik'));
    const profileCount = profilesCache && profilesCache.payload && Array.isArray(profilesCache.payload.profiles)
      ? profilesCache.payload.profiles.length
      : 0;

    res.json({
      success: true,
      totalUsers,
      activeUsers,
      offlineUsers,
      profileCount
    });
  } catch (err) {
    logger.error('Error getting PPPoE user stats:', err);
    res.status(500).json({ 
      success: false, 
      message: err.message,
      totalUsers: 0,
      activeUsers: 0,
      offlineUsers: 0
    });
  }
});

// POST: Restart Mikrotik
router.post('/mikrotik/restart', adminAuth, async (req, res) => {
  try {
    const { restartRouter } = require('../config/mikrotik');
    const result = await restartRouter();
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.json({ success: false, message: result.message });
    }
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ============================================
// HOTSPOT SERVER PROFILES ROUTES
// ============================================

// GET: List Server Hotspot dan Server Profile Hotspot (Mikrotik API Only)
// Helper function untuk membuat table hotspot_servers jika belum ada
function ensureHotspotServersTable(db) {
  return new Promise((resolve, reject) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS hotspot_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        updated_at DATETIME DEFAULT (datetime('now','localtime'))
      )
    `, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Helper function untuk mendapatkan semua server hotspot dari database
function getHotspotServersFromDB(db) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM hotspot_servers ORDER BY name', [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

router.get('/mikrotik/hotspot-server-profiles', adminAuth, async (req, res) => {
  try {
    // Check auth mode
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    // Pastikan table hotspot_servers ada
    await ensureHotspotServersTable(billingManager.db);
    
    // Ambil daftar server hotspot dari database
    let hotspotServersDB = [];
    try {
      hotspotServersDB = await getHotspotServersFromDB(billingManager.db);
    } catch (dbErr) {
      console.error('Error fetching hotspot servers from DB:', dbErr);
      hotspotServersDB = [];
    }
    
    if (authMode === 'radius') {
      // Mode RADIUS: Hanya tampilkan daftar server hotspot dari database (tidak perlu API)
      const settings = getSettingsWithCache();
      return res.render('admin/mikrotik/hotspot-server-profiles', {
        servers: [],
        profiles: [],
        routers: [],
        hotspotServersDB: hotspotServersDB || [], // Server hotspot dari database
        error: null,
        settings: settings || getSettingsWithCache(),
        versionInfo: getVersionInfo(),
        versionBadge: getVersionBadge(),
        userAuthMode: 'radius',
        radiusMode: true // Flag untuk view
      });
    }
    
    // Mode Mikrotik API: Ambil routers
    const routers = await new Promise((resolve) => {
      billingManager.db.all(('SELECT * FROM routers' + _routerTenantWhere() + ' ORDER BY id'), (err, rows) => {
        if (err) {
          console.error('Error fetching routers:', err);
          resolve([]);
        } else {
          resolve(rows || []);
        }
      });
    });

    // Untuk mode Mikrotik API, perlu router
    if (!routers || routers.length === 0) {
      console.warn('No routers found in database');
      const settings = getSettingsWithCache();
      // Ambil server hotspot dari database
      let hotspotServersDBFinal = [];
      try {
        hotspotServersDBFinal = await getHotspotServersFromDB(billingManager.db);
      } catch (dbErr) {
        console.error('Error fetching hotspot servers from DB:', dbErr);
        hotspotServersDBFinal = [];
      }
      return res.render('admin/mikrotik/hotspot-server-profiles', {
        servers: [],
        profiles: [], 
        routers: [],
        hotspotServersDB: hotspotServersDBFinal || [], // Server hotspot dari database
        error: 'Tidak ada router/NAS yang dikonfigurasi. Silakan tambahkan router terlebih dahulu di menu NAS (RADIUS).', 
        settings: settings || getSettingsWithCache(),
        versionInfo: getVersionInfo(),
        versionBadge: getVersionBadge(),
        userAuthMode: 'mikrotik',
        radiusMode: false
      });
    }

    // Ambil Server Hotspot dan Server Profile Hotspot dari semua router secara paralel
    const fetchPromises = routers.map(async (r) => {
      const result = {
        nas_id: r.id,
        nas_name: r.name,
        nas_ip: r.nas_ip,
        servers: [],
        profiles: [],
        errors: []
      };

      try {
        // Ambil Server Hotspot
        const serverResult = await getHotspotServers(r);
        if (serverResult.success && Array.isArray(serverResult.data)) {
          result.servers = serverResult.data.map(server => ({
            ...server,
            nas_id: r.id,
            nas_name: r.name,
            nas_ip: r.nas_ip
          }));
        } else {
          result.errors.push(`Servers (${r.name}): ${serverResult.message}`);
        }

        // Ambil Server Profiles
        const profileResult = await getHotspotServerProfiles(r);
        if (profileResult.success && Array.isArray(profileResult.data)) {
          result.profiles = profileResult.data.map(prof => ({
            ...prof,
            nas_id: r.id,
            nas_name: r.name,
            nas_ip: r.nas_ip
          }));
        } else {
          const errorMsg = profileResult.message || 'Unknown error';
          if (!errorMsg.includes('tidak mendukung') && !errorMsg.includes('tidak kompatibel')) {
            result.errors.push(`Profiles (${r.name}): ${errorMsg}`);
          }
        }
      } catch (e) {
        console.error(`Error fetching hotspot data from ${r.name}:`, e.message);
        result.errors.push(`${r.name}: ${e.message}`);
      }
      return result;
    });

    const results = await Promise.all(fetchPromises);
    
    let servers = [];
    let profiles = [];
    let allErrors = [];

    results.forEach(res => {
      servers = servers.concat(res.servers);
      profiles = profiles.concat(res.profiles);
      allErrors = allErrors.concat(res.errors);
    });
    const settings = getSettingsWithCache();
    
    // Ambil daftar server hotspot dari database untuk mode Mikrotik API juga
    let hotspotServersDBFinal = [];
    try {
      hotspotServersDBFinal = await getHotspotServersFromDB(billingManager.db);
    } catch (dbErr) {
      console.error('Error fetching hotspot servers from DB (Mikrotik API mode):', dbErr);
      hotspotServersDBFinal = [];
    }
    
    // Sanitize data untuk memastikan JSON valid (menghilangkan undefined, null, circular references)
    const sanitizedServers = servers.map(server => ({
      id: server.id || server['.id'] || '',
      name: server.name || '',
      interface: server.interface || '',
      profile: server.profile || '',
      addressPool: server.addressPool || server.address || '',
      disabled: server.disabled === true || server.disabled === 'true',
      nas_id: server.nas_id || null,
      nas_name: server.nas_name || '',
      nas_ip: server.nas_ip || ''
    }));
    
    const sanitizedProfiles = profiles.map(prof => ({
      id: prof.id || prof['.id'] || '',
      name: prof.name || '',
      'rate-limit': prof['rate-limit'] || '',
      'session-timeout': prof['session-timeout'] || '',
      'idle-timeout': prof['idle-timeout'] || '',
      'shared-users': prof['shared-users'] || '1',
      'open-status-page': prof['open-status-page'] || 'http-login',
      comment: prof.comment || '',
      nas_id: prof.nas_id || null,
      nas_name: prof.nas_name || '',
      nas_ip: prof.nas_ip || ''
    }));
    
    return res.render('admin/mikrotik/hotspot-server-profiles', {
      servers: sanitizedServers,
      profiles: sanitizedProfiles, 
      routers: routers || [],
      hotspotServersDB: hotspotServersDBFinal || [], // Server hotspot dari database
      settings: settings || getSettingsWithCache(),
      error: allErrors.length > 0 ? `Beberapa router gagal: ${allErrors.join('; ')}` : null,
      versionInfo: getVersionInfo(),
      versionBadge: getVersionBadge(),
      userAuthMode: 'mikrotik',
      radiusMode: false
    });
  } catch (err) {
    console.error('Error in hotspot server/profiles GET route:', err);
    console.error('Error stack:', err.stack);
    
    const settings = getSettingsWithCache();
    // Check auth mode untuk error handler juga
    let userAuthMode = 'mikrotik';
    let hotspotServersDB = [];
    try {
      const { getUserAuthModeAsync } = require('../config/mikrotik');
      userAuthMode = await getUserAuthModeAsync();
      
      // Coba ambil server hotspot dari database jika memungkinkan
      try {
        await ensureHotspotServersTable(billingManager.db);
        hotspotServersDB = await getHotspotServersFromDB(billingManager.db);
      } catch (dbErr) {
        console.error('Error fetching hotspot servers from DB in error handler:', dbErr);
      }
    } catch (e) {
      console.error('Error in error handler:', e);
    }
    
    try {
      return res.render('admin/mikrotik/hotspot-server-profiles', {
        servers: [],
        profiles: [], 
        routers: [],
        hotspotServersDB: hotspotServersDB || [], // Server hotspot dari database
        error: `Gagal mengambil data: ${err.message}`, 
        settings: settings || getSettingsWithCache(),
        versionInfo: getVersionInfo(),
        versionBadge: getVersionBadge(),
        userAuthMode: userAuthMode,
        radiusMode: userAuthMode === 'radius'
      });
    } catch (renderErr) {
      console.error('Error rendering error page:', renderErr);
      return res.status(500).send(`Error: ${err.message}<br><pre>${err.stack}</pre>`);
    }
  }
});

// GET: API Daftar Server Profile Hotspot (Mikrotik API Only)
router.get('/mikrotik/hotspot-server-profiles/api', adminAuth, async (req, res) => {
  try {
    // Check auth mode - fitur ini hanya untuk mode Mikrotik API
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    if (authMode === 'radius') {
      return res.json({ 
        success: false, 
        profiles: [], 
        message: 'Fitur ini tidak tersedia di mode RADIUS. Server Profile Hotspot harus dikonfigurasi langsung di Mikrotik router.' 
      });
    }
    
    const { router_id } = req.query;

    // Untuk mode Mikrotik API, ambil dari Mikrotik router
    if (router_id) {
      const sqlite3 = require('sqlite3').verbose();
      const db = new sqlite3.Database(DB_PATH);
      const routerObj = await new Promise((resolve) => db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => {
        db.close();
        resolve(row || null);
      }));
      if (!routerObj) {
        return res.json({ success: false, profiles: [], message: 'Router tidak ditemukan' });
      }

      const result = await getHotspotServerProfiles(routerObj);
      if (result.success) {
        const profilesWithRouter = result.data.map(prof => ({
          ...prof,
          nas_id: routerObj.id,
          nas_name: routerObj.name,
          nas_ip: routerObj.nas_ip
        }));
        return res.json({ success: true, profiles: profilesWithRouter });
      } else {
        return res.json({ success: false, profiles: [], message: result.message });
      }
    }

    // Fetch from all routers
    const routers = await new Promise((resolve) => billingManager.db.all(('SELECT * FROM routers' + _routerTenantWhere() + ' ORDER BY id'), (err, rows) => {
      if (err) {
        console.error('Error fetching routers:', err);
        resolve([]);
      } else {
        resolve(rows || []);
      }
    }));

    if (!routers || routers.length === 0) {
      return res.json({ success: false, profiles: [], message: 'Tidak ada router/NAS yang dikonfigurasi' });
    }
    
    let combined = [];
    let errorMessages = [];
    for (const r of routers) {
      try {
        const result = await getHotspotServerProfiles(r);
        if (result.success && Array.isArray(result.data)) {
          result.data.forEach(prof => {
            const profileObj = {
              ...prof,
              nas_id: r.id,
              nas_name: r.name,
              nas_ip: r.nas_ip
            };
            combined.push(profileObj);
          });
        } else {
          // Skip error jika router tidak mendukung fitur ini (bukan error kritis)
          const errorMsg = result.message || 'Unknown error';
          if (errorMsg.includes('tidak mendukung') || errorMsg.includes('tidak kompatibel')) {
            logger.warn(`${r.name}: ${errorMsg} - Fitur Server Profile Hotspot tidak tersedia`);
            // Tidak menambahkan ke errorMessages karena ini bukan error kritis
          } else {
            errorMessages.push(`${r.name}: ${errorMsg}`);
          }
        }
      } catch (e) {
        console.error(`Error getting server profiles from ${r.name}:`, e.message);
        errorMessages.push(`${r.name}: ${e.message}`);
      }
    }

    return res.json({ 
      success: true, 
      profiles: combined,
      error: errorMessages.length > 0 ? `Beberapa router gagal: ${errorMessages.join('; ')}` : null
    });
  } catch (err) {
    console.error('Error in server profiles API route:', err);
    res.json({ success: false, profiles: [], message: err.message });
  }
});

// POST: Tambah Server Profile Hotspot (Mikrotik API Only)
router.post('/mikrotik/hotspot-server-profiles/add', adminAuth, async (req, res) => {
  try {
    // Check auth mode - fitur ini hanya untuk mode Mikrotik API
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    if (authMode === 'radius') {
      return res.json({ 
        success: false, 
        message: 'Fitur ini tidak tersedia di mode RADIUS. Server Profile Hotspot harus dikonfigurasi langsung di Mikrotik router.' 
      });
    }
    
    const profileData = req.body;
    const { router_id } = req.body;
    
    if (!router_id) {
      return res.json({ success: false, message: 'Router ID harus diisi' });
    }

    const routerObj = await new Promise((resolve) => billingManager.db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => {
      resolve(row || null);
    }));

    if (!routerObj) {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }

    const result = await addHotspotServerProfileMikrotik(profileData, routerObj);
    return res.json(result);
  } catch (err) {
    console.error('Error adding server profile:', err);
    res.json({ success: false, message: err.message });
  }
});

// POST: Edit Server Profile Hotspot (Mikrotik API Only)
router.post('/mikrotik/hotspot-server-profiles/edit', adminAuth, async (req, res) => {
  try {
    // Check auth mode - fitur ini hanya untuk mode Mikrotik API
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    if (authMode === 'radius') {
      return res.json({ 
        success: false, 
        message: 'Fitur ini tidak tersedia di mode RADIUS. Server Profile Hotspot harus dikonfigurasi langsung di Mikrotik router.' 
      });
    }
    
    const { id } = req.body;
    const profileData = req.body;
    const { router_id } = req.body;
    
    if (!id) {
      return res.json({ success: false, message: 'ID server profile harus diisi' });
    }
    
    if (!router_id) {
      return res.json({ success: false, message: 'Router ID harus diisi' });
    }

    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(DB_PATH);
    const routerObj = await new Promise((resolve) => db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => {
      db.close();
      resolve(row || null);
    }));

    if (!routerObj) {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }

    const result = await editHotspotServerProfileMikrotik(id, profileData, routerObj);
    return res.json(result);
  } catch (err) {
    console.error('Error editing server profile:', err);
    res.json({ success: false, message: err.message });
  }
});

// POST: Hapus Server Profile Hotspot (Mikrotik API Only)
router.post('/mikrotik/hotspot-server-profiles/delete', adminAuth, async (req, res) => {
  try {
    // Check auth mode - fitur ini hanya untuk mode Mikrotik API
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    if (authMode === 'radius') {
      return res.json({ 
        success: false, 
        message: 'Fitur ini tidak tersedia di mode RADIUS. Server Profile Hotspot harus dikonfigurasi langsung di Mikrotik router.' 
      });
    }
    
    const { id } = req.body;
    const { router_id } = req.body;
    
    if (!id) {
      return res.json({ success: false, message: 'ID server profile harus diisi' });
    }
    
    if (!router_id) {
      return res.json({ success: false, message: 'Router ID harus diisi' });
    }

    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(DB_PATH);
    const routerObj = await new Promise((resolve) => db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => {
      db.close();
      resolve(row || null);
    }));

    if (!routerObj) {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }

    const result = await deleteHotspotServerProfileMikrotik(id, routerObj);
    return res.json(result);
  } catch (err) {
    console.error('Error deleting server profile:', err);
    res.json({ success: false, message: err.message });
  }
});

// ============================================
// HOTSPOT SERVER DATABASE ROUTES (Untuk semua mode)
// ============================================

// GET: API untuk mengambil daftar server hotspot dari semua Mikrotik
router.get('/mikrotik/hotspot-server-profiles/api-servers-from-mikrotik', adminAuth, async (req, res) => {
  try {
    // Ambil semua router yang terdaftar
    const routers = await new Promise((resolve) => {
      billingManager.db.all(('SELECT * FROM routers' + _routerTenantWhere() + ' ORDER BY name'), (err, rows) => {
        if (err) {
          console.error('Error fetching routers:', err);
          resolve([]);
        } else {
          resolve(rows || []);
        }
      });
    });
    
    if (routers.length === 0) {
      return res.json({ 
        success: true, 
        servers: [], 
        message: 'Tidak ada router/NAS yang terdaftar. Silakan tambahkan router terlebih dahulu di menu NAS (RADIUS).' 
      });
    }
    
    // Ambil server hotspot dari semua router
    let allServers = [];
    let errors = [];
    
    for (const router of routers) {
      try {
        const result = await getHotspotServers(router);
        if (result.success && Array.isArray(result.data)) {
          result.data.forEach(server => {
            // Hanya ambil nama server (unique)
            if (server.name && !allServers.find(s => s.name === server.name)) {
              allServers.push({
                name: server.name,
                router_name: router.name,
                router_ip: router.nas_ip,
                router_id: router.id
              });
            }
          });
        } else {
          errors.push(`${router.name}: ${result.message || 'Gagal mengambil server'}`);
        }
      } catch (e) {
        console.error(`Error getting servers from ${router.name}:`, e.message);
        errors.push(`${router.name}: ${e.message}`);
      }
    }
    
    // Sort by name
    allServers.sort((a, b) => a.name.localeCompare(b.name));
    
    res.json({ 
      success: true, 
      servers: allServers,
      total_routers: routers.length,
      errors: errors.length > 0 ? errors : null
    });
  } catch (err) {
    console.error('Error in hotspot servers from Mikrotik API:', err);
    res.json({ success: false, servers: [], message: err.message });
  }
});

// POST: Tambah Server Hotspot ke Database
router.post('/mikrotik/hotspot-server-profiles/add-server', adminAuth, async (req, res) => {
  try {
    const { name, description } = req.body;
    
    if (!name || !name.trim()) {
      return res.json({ success: false, message: 'Nama server hotspot harus diisi' });
    }
    
    // Pastikan table ada
    await ensureHotspotServersTable(billingManager.db);
    
    // Cek apakah nama sudah ada
    const existing = await new Promise((resolve, reject) => {
      billingManager.db.get('SELECT id FROM hotspot_servers WHERE name = ?', [name.trim()], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (existing) {
      return res.json({ success: false, message: 'Nama server hotspot sudah ada' });
    }
    
    // Insert server hotspot baru
    await new Promise((resolve, reject) => {
      billingManager.db.run(
        'INSERT INTO hotspot_servers (name, description) VALUES (?, ?)',
        [name.trim(), description ? description.trim() : null],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
    
    return res.json({ success: true, message: 'Server hotspot berhasil ditambahkan' });
  } catch (err) {
    console.error('Error adding hotspot server:', err);
    res.json({ success: false, message: err.message });
  }
});

// POST: Edit Server Hotspot di Database
router.post('/mikrotik/hotspot-server-profiles/edit-server', adminAuth, async (req, res) => {
  try {
    const { id, name, description } = req.body;
    
    if (!id) {
      return res.json({ success: false, message: 'ID server hotspot harus diisi' });
    }
    
    if (!name || !name.trim()) {
      return res.json({ success: false, message: 'Nama server hotspot harus diisi' });
    }
    
    // Pastikan table ada
    await ensureHotspotServersTable(billingManager.db);
    
    // Cek apakah server dengan ID ini ada
    const existing = await new Promise((resolve, reject) => {
      billingManager.db.get('SELECT id FROM hotspot_servers WHERE id = ?', [parseInt(id)], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (!existing) {
      return res.json({ success: false, message: 'Server hotspot tidak ditemukan' });
    }
    
    // Cek apakah nama sudah digunakan oleh server lain
    const nameExists = await new Promise((resolve, reject) => {
      billingManager.db.get('SELECT id FROM hotspot_servers WHERE name = ? AND id != ?', [name.trim(), parseInt(id)], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (nameExists) {
      return res.json({ success: false, message: 'Nama server hotspot sudah digunakan oleh server lain' });
    }
    
    // Update server hotspot
    await new Promise((resolve, reject) => {
      billingManager.db.run(
        "UPDATE hotspot_servers SET name = ?, description = ?, updated_at = datetime('now','localtime') WHERE id = ?",
        [name.trim(), description ? description.trim() : null, parseInt(id)],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
    
    return res.json({ success: true, message: 'Server hotspot berhasil diupdate' });
  } catch (err) {
    console.error('Error editing hotspot server:', err);
    res.json({ success: false, message: err.message });
  }
});

// POST: Hapus Server Hotspot dari Database
router.post('/mikrotik/hotspot-server-profiles/delete-server', adminAuth, async (req, res) => {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.json({ success: false, message: 'ID server hotspot harus diisi' });
    }
    
    // Pastikan table ada
    await ensureHotspotServersTable(billingManager.db);
    
    // Cek apakah server dengan ID ini ada
    const existing = await new Promise((resolve, reject) => {
      billingManager.db.get('SELECT id FROM hotspot_servers WHERE id = ?', [parseInt(id)], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (!existing) {
      return res.json({ success: false, message: 'Server hotspot tidak ditemukan' });
    }
    
    // Hapus server hotspot
    await new Promise((resolve, reject) => {
      billingManager.db.run('DELETE FROM hotspot_servers WHERE id = ?', [parseInt(id)], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    return res.json({ success: true, message: 'Server hotspot berhasil dihapus' });
  } catch (err) {
    console.error('Error deleting hotspot server:', err);
    res.json({ success: false, message: err.message });
  }
});

// ============================================
// HOTSPOT SERVER ROUTES (Mikrotik API Only)
// ============================================

// GET: API Daftar Interfaces untuk Router
router.get('/mikrotik/interfaces/api', adminAuth, async (req, res) => {
  try {
    const { router_id } = req.query;
    
    if (!router_id) {
      return res.json({ success: false, interfaces: [], message: 'Router ID harus diisi' });
    }

    const routerObj = await new Promise((resolve) => billingManager.db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => {
      resolve(row || null);
    }));

    if (!routerObj) {
      return res.json({ success: false, interfaces: [], message: 'Router tidak ditemukan' });
    }

    const { getInterfacesForRouter } = require('../config/mikrotik');
    const result = await getInterfacesForRouter(routerObj);
    
    if (result.success) {
      return res.json({ success: true, interfaces: result.data || [] });
    } else {
      return res.json({ success: false, interfaces: [], message: result.message });
    }
  } catch (err) {
    console.error('Error in interfaces API:', err);
    res.json({ success: false, interfaces: [], message: err.message });
  }
});

// GET: API Daftar Address Pools untuk Router
router.get('/mikrotik/address-pools/api', adminAuth, async (req, res) => {
  try {
    const { router_id } = req.query;
    
    if (!router_id) {
      return res.json({ success: false, pools: [], message: 'Router ID harus diisi' });
    }

    const routerObj = await new Promise((resolve) => billingManager.db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => {
      resolve(row || null);
    }));

    if (!routerObj) {
      return res.json({ success: false, pools: [], message: 'Router tidak ditemukan' });
    }

    const { getAddressPoolsForRouter } = require('../config/mikrotik');
    const result = await getAddressPoolsForRouter(routerObj);
    
    if (result.success) {
      return res.json({ success: true, pools: result.data || [] });
    } else {
      return res.json({ success: false, pools: [], message: result.message });
    }
  } catch (err) {
    console.error('Error in address pools API:', err);
    res.json({ success: false, pools: [], message: err.message });
  }
});

// GET: API Address Pools dari semua router yang terdaftar
router.get('/mikrotik/address-pools/api/all', adminAuth, async (req, res) => {
  try {
    // Get all routers
    const routers = await new Promise((resolve) => {
      billingManager.db.all(('SELECT * FROM routers' + _routerTenantWhere() + ' ORDER BY name'), (err, rows) => {
        resolve(rows || []);
      });
    });

    if (!routers || routers.length === 0) {
      return res.json({ success: true, pools: [], message: 'Tidak ada router yang terdaftar' });
    }

    const { getAddressPoolsForRouter } = require('../config/mikrotik');
    const poolMap = new Map(); // Untuk deduplikasi berdasarkan nama pool

    // Get pools from all routers in parallel
    const poolPromises = routers.map(async (router) => {
      try {
        const result = await getAddressPoolsForRouter(router);
        if (result.success && Array.isArray(result.data)) {
          result.data.forEach(pool => {
            const routerEntry = {
              id: router.id,
              name: router.name,
              nas_ip: router.nas_ip,
              ranges: pool.ranges || ''
            };
            // Deduplikasi by nama: range boleh beda per router (multi-NAS Framed-Pool)
            if (poolMap.has(pool.name)) {
              const existing = poolMap.get(pool.name);
              if (!existing.routers) {
                existing.routers = [{
                  ...(existing.router || {}),
                  ranges: existing.ranges || ''
                }];
              }
              if (!existing.routers.some(r => r.id === router.id)) {
                existing.routers.push(routerEntry);
              }
              const uniqueRanges = [...new Set(
                existing.routers.map(r => r.ranges).filter(Boolean)
              )];
              existing.ranges = uniqueRanges.length <= 1
                ? (uniqueRanges[0] || existing.ranges || '')
                : uniqueRanges.join(' | ');
              existing.multiRange = uniqueRanges.length > 1;
            } else {
              poolMap.set(pool.name, {
                name: pool.name,
                ranges: pool.ranges || '',
                multiRange: false,
                comment: pool.comment || '',
                router: {
                  id: router.id,
                  name: router.name,
                  nas_ip: router.nas_ip
                },
                routers: [routerEntry]
              });
            }
          });
        }
      } catch (err) {
        logger.warn(`Error getting pools from router ${router.name}: ${err.message}`);
        // Continue dengan router lain
      }
    });

    await Promise.all(poolPromises);

    // Convert map to array
    const uniquePools = Array.from(poolMap.values());

    return res.json({ 
      success: true, 
      pools: uniquePools.sort((a, b) => a.name.localeCompare(b.name)),
      message: `Ditemukan ${uniquePools.length} pool dari ${routers.length} router` 
    });
  } catch (err) {
    logger.error('Error in all address pools API:', err);
    res.json({ success: false, pools: [], message: err.message });
  }
});

// GET: API Daftar Server Hotspot
router.get('/mikrotik/hotspot-servers/api', adminAuth, async (req, res) => {
  try {
    // Check auth mode - fitur ini hanya untuk mode Mikrotik API
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    if (authMode === 'radius') {
      return res.json({ 
        success: false, 
        servers: [], 
        message: 'Fitur ini tidak tersedia di mode RADIUS. Server Hotspot harus dikonfigurasi langsung di Mikrotik router.' 
      });
    }
    
    const { router_id } = req.query;
    
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(DB_PATH);
    
    if (router_id) {
      const routerObj = await new Promise((resolve) => billingManager.db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => {
        resolve(row || null);
      }));
      if (!routerObj) {
        return res.json({ success: false, servers: [], message: 'Router tidak ditemukan' });
      }

      const result = await getHotspotServers(routerObj);
      if (result.success) {
        const serversWithRouter = result.data.map(server => ({
          ...server,
          nas_id: routerObj.id,
          nas_name: routerObj.name,
          nas_ip: routerObj.nas_ip
        }));
        return res.json({ success: true, servers: serversWithRouter });
      } else {
        return res.json({ success: false, servers: [], message: result.message });
      }
    }

    // Ambil dari semua router
    const routers = await new Promise((resolve) => billingManager.db.all(('SELECT * FROM routers' + _routerTenantWhere() + ' ORDER BY id'), (err, rows) => {
      if (err) {
        console.error('Error fetching routers:', err);
        resolve([]);
      } else {
        resolve(rows || []);
      }
    }));
    
    let combined = [];
    let errorMessages = [];
    for (const r of routers) {
      try {
        const result = await getHotspotServers(r);
        if (result.success && Array.isArray(result.data)) {
          result.data.forEach(server => {
            const serverObj = {
              ...server,
              nas_id: r.id,
              nas_name: r.name,
              nas_ip: r.nas_ip
            };
            combined.push(serverObj);
          });
        } else {
          errorMessages.push(`${r.name}: ${result.message}`);
        }
      } catch (e) {
        console.error(`Error getting servers from ${r.name}:`, e.message);
        errorMessages.push(`${r.name}: ${e.message}`);
      }
    }
    
    res.json({ 
      success: true, 
      servers: combined,
      error: errorMessages.length > 0 ? `Beberapa router gagal: ${errorMessages.join('; ')}` : null
    });
  } catch (err) {
    console.error('Error in hotspot servers API:', err);
    res.json({ success: false, servers: [], message: err.message });
  }
});

// POST: Tambah Server Hotspot
router.post('/mikrotik/hotspot-servers/add', adminAuth, async (req, res) => {
  try {
    // Check auth mode - fitur ini hanya untuk mode Mikrotik API
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    if (authMode === 'radius') {
      return res.json({ 
        success: false, 
        message: 'Fitur ini tidak tersedia di mode RADIUS. Server Hotspot harus dikonfigurasi langsung di Mikrotik router.' 
      });
    }
    
    const serverData = req.body;
    const { router_id } = req.body;
    
    if (!router_id) {
      return res.json({ success: false, message: 'Router ID harus diisi' });
    }

    const routerObj = await new Promise((resolve) => billingManager.db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => {
      resolve(row || null);
    }));

    if (!routerObj) {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }

    const result = await addHotspotServer(serverData, routerObj);
    return res.json(result);
  } catch (err) {
    console.error('Error adding hotspot server:', err);
    res.json({ success: false, message: err.message });
  }
});

// POST: Edit Server Hotspot
router.post('/mikrotik/hotspot-servers/edit', adminAuth, async (req, res) => {
  try {
    // Check auth mode - fitur ini hanya untuk mode Mikrotik API
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    if (authMode === 'radius') {
      return res.json({ 
        success: false, 
        message: 'Fitur ini tidak tersedia di mode RADIUS. Server Hotspot harus dikonfigurasi langsung di Mikrotik router.' 
      });
    }
    
    const { id } = req.body;
    const serverData = req.body;
    const { router_id } = req.body;
    
    if (!id) {
      return res.json({ success: false, message: 'ID server hotspot harus diisi' });
    }
    
    if (!router_id) {
      return res.json({ success: false, message: 'Router ID harus diisi' });
    }

    const routerObj = await new Promise((resolve) => billingManager.db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => {
      resolve(row || null);
    }));

    if (!routerObj) {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }

    const result = await editHotspotServer(id, serverData, routerObj);
    return res.json(result);
  } catch (err) {
    console.error('Error editing hotspot server:', err);
    res.json({ success: false, message: err.message });
  }
});

// POST: Hapus Server Hotspot
router.post('/mikrotik/hotspot-servers/delete', adminAuth, async (req, res) => {
  try {
    // Check auth mode - fitur ini hanya untuk mode Mikrotik API
    const { getUserAuthModeAsync } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    
    if (authMode === 'radius') {
      return res.json({ 
        success: false, 
        message: 'Fitur ini tidak tersedia di mode RADIUS. Server Hotspot harus dikonfigurasi langsung di Mikrotik router.' 
      });
    }
    
    const { id } = req.body;
    const { router_id } = req.body;
    
    if (!id) {
      return res.json({ success: false, message: 'ID server hotspot harus diisi' });
    }
    
    if (!router_id) {
      return res.json({ success: false, message: 'Router ID harus diisi' });
    }

    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(DB_PATH);
    const routerObj = await new Promise((resolve) => db.get(('SELECT * FROM routers WHERE id=?' + _routerTenantAnd()), [parseInt(router_id)], (err, row) => {
      db.close();
      resolve(row || null);
    }));

    if (!routerObj) {
      return res.json({ success: false, message: 'Router tidak ditemukan' });
    }

    const result = await deleteHotspotServer(id, routerObj);
    return res.json(result);
  } catch (err) {
    console.error('Error deleting hotspot server:', err);
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
