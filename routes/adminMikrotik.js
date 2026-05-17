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

// Centralized database path
const DB_PATH = path.join(__dirname, '../data/billing.db');

/**
 * Helper to get a router by ID using the centralized billingManager
 */
async function findRouterHelper(router_id) {
  return new Promise((resolve) => {
    billingManager.db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
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
    billingManager.db.all('SELECT * FROM routers ORDER BY id', [], (err, rows) => {
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
let _pppoeAdminPageCache = null;
let _pppoeProfilesApiCache = null;
const PPPOE_PROFILES_CACHE_MS = 60000;

function clearPppoeAdminPageCache() {
  _pppoeAdminPageCache = null;
  _pppoeProfilesApiCache = null;
}

function getPppoeAdminPageCache(authMode) {
  if (!_pppoeAdminPageCache) return null;
  if (_pppoeAdminPageCache.authMode !== authMode) return null;
  if (Date.now() - _pppoeAdminPageCache.ts > PPPOE_PAGE_CACHE_MS) return null;
  return _pppoeAdminPageCache;
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
    const { getUserAuthModeAsync, getPPPoEUsersRadius, getActivePPPoEConnectionsRadius } = require('../config/mikrotik');
    const authMode = await getUserAuthModeAsync();
    const forceRefresh = String(req.query.refresh || '') === '1';

    const cached = !forceRefresh ? getPppoeAdminPageCache(authMode) : null;
    if (cached) {
      const settings = getSettingsWithCache();
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

    let combined = [];
    let routers = [];

    if (authMode === 'radius') {
      // RADIUS mode: Get users from RADIUS database
      logger.info('RADIUS mode: Loading users from RADIUS database');
      try {
        const usersRaw = await getPPPoEUsersRadius();
        const users = Array.isArray(usersRaw) ? usersRaw : [];
        logger.info(`Found ${users.length} users in RADIUS database`);

        const activeRaw = await getActivePPPoEConnectionsRadius();
        const activeConnections = Array.isArray(activeRaw) ? activeRaw : [];
        logger.info(`Found ${activeConnections.length} active connections in RADIUS`);
        
        const activeNames = new Set(activeConnections.map(a => a.name));
        
        // PENTING: Gunakan Map untuk menghindari duplikasi berdasarkan username
        // Jika ada duplikasi dari query, hanya ambil yang pertama
        const userMap = new Map();
        users.forEach(user => {
          if (!userMap.has(user.name)) {
            userMap.set(user.name, {
              id: user.name, // Use username as ID for RADIUS
              name: user.name,
              password: user.password,
              profile: user.profile || 'default',
              active: activeNames.has(user.name),
              nas_name: 'RADIUS',
              nas_ip: 'RADIUS Server'
            });
          }
        });
        
        combined = Array.from(userMap.values());
        
        logger.info(`Mapped ${combined.length} unique users for display (from ${users.length} total users)`);
      } catch (radiusError) {
        logger.error(`Error loading users from RADIUS: ${radiusError.message}`, radiusError);
        // Return empty array but log the error
        combined = [];
      }
      // No routers needed for RADIUS mode
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
    }
    
    const userStats = computeUserStats(combined);
    logger.info(`Total users to display: ${combined.length}`);

    _pppoeAdminPageCache = {
      ts: Date.now(),
      authMode,
      combined,
      routers,
      userStats
    };

    const settings = getSettingsWithCache();
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
      // RADIUS mode: Save to radcheck and radusergroup
      logger.info('RADIUS mode: Adding user to RADIUS database');
      const result = await addPPPoEUser({ username, password, profile });
      if (result.success) {
        clearPppoeAdminPageCache();
        return res.json({ success: true, message: result.message });
      } else {
        return res.json({ success: false, message: result.message });
      }
    }
    
    // Mikrotik API mode: Need router_id
    if (!router_id) {
      return res.json({ success: false, message: 'Pilih NAS (router) terlebih dahulu' });
    }
    
    const sqlite3 = require('sqlite3').verbose();
    const router = await new Promise((resolve) => billingManager.db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => resolve(row || null)));
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
      // RADIUS mode: Update in radcheck and radusergroup
      // id adalah username lama di mode RADIUS
      logger.info(`RADIUS mode: Updating user in RADIUS database. Old username: ${id}, New username: ${username}`);
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
      // RADIUS mode: Delete from radcheck and radusergroup
      logger.info('RADIUS mode: Deleting user from RADIUS database');
      const result = await deletePPPoEUser(id); // In RADIUS mode, id is username
      if (result.success) {
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
      billingManager.db.all('SELECT * FROM routers ORDER BY id', [], (err, rows) => {
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

    if (!router_id && !forceRefresh && _pppoeProfilesApiCache
        && _pppoeProfilesApiCache.authMode === authMode
        && Date.now() - _pppoeProfilesApiCache.ts < PPPOE_PROFILES_CACHE_MS) {
      return res.json(_pppoeProfilesApiCache.payload);
    }

    // If router_id is provided, only fetch from that router
    if (router_id) {
      const routerObj = await new Promise((resolve) => billingManager.db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
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

      _pppoeProfilesApiCache = { ts: Date.now(), authMode, payload };
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
      res.json({ success: true });
    } else {
      res.json({ success: false, message: result.message });
    }
  } catch (err) {
    logger.error('Error deleting PPPoE profile:', err);
    res.json({ success: false, message: err.message });
  }
});

// GET: List Profile Hotspot
// Catatan: Selalu ambil langsung dari Mikrotik (RouterOS),
// tidak lagi menggunakan profile dari RADIUS.
router.get('/mikrotik/hotspot-profiles', adminAuth, async (req, res) => {
  let combined = [];
  let errorMessages = [];
  let routers = [];
  let settings = getSettingsWithCache();
  let userAuthMode = 'mikrotik';

  try {
    // Try to get userAuthMode
    try {
      const { getRadiusConfigValue } = require('../config/radiusConfig');
      const mode = await getRadiusConfigValue('user_auth_mode', null);
      if (mode) userAuthMode = mode;
    } catch (e) {}

    routers = await new Promise((resolve) => {
      billingManager.db.all('SELECT * FROM routers ORDER BY id', [], (err, rows) => {
        if (err) {
          logger.error('[DIAGNOSTIC] Hotspot Profiles: error fetching routers:', err.message);
          resolve([]);
        } else {
          logger.info(`[DIAGNOSTIC] Hotspot Profiles: found ${rows ? rows.length : 0} routers`);
          resolve(rows || []);
        }
      });
    });


    // Untuk halaman Mikrotik API, router wajib ada
    if (!routers || routers.length === 0) {
      console.warn('No routers found in database');
      const settings = getSettingsWithCache();
      return res.render('adminMikrotikHotspotProfiles', { 
        profiles: [], 
        routers: [],
        error: 'Tidak ada router/NAS yang dikonfigurasi. Silakan tambahkan router terlebih dahulu di menu NAS (RADIUS).', 
        settings,
        versionInfo: getVersionInfo(),
        versionBadge: getVersionBadge(),
        userAuthMode: 'mikrotik'
      });
    }

    let combined = [];
    let errorMessages = [];
    for (const r of routers) {
      try {
        console.log(`=== Attempting to get hotspot profiles from router: ${r.name} (${r.nas_ip}:${r.port || 8728}) ===`);
        console.log(`Router data:`, JSON.stringify({
          id: r.id,
          name: r.name,
          nas_ip: r.nas_ip,
          port: r.port,
          user: r.user ? '***' : 'missing',
          password: r.password ? '***' : 'missing'
        }));
        
        const result = await getHotspotProfiles(r);
        console.log(`Result from ${r.name}:`, {
          success: result.success,
          message: result.message,
          dataCount: result.data ? result.data.length : 0
        });
        
        if (result.success && Array.isArray(result.data)) {
          console.log(`✓ Successfully retrieved ${result.data.length} profiles from ${r.name}`);
          if (result.data.length > 0) {
            console.log(`Profile names:`, result.data.map(p => p.name || p['name'] || 'unnamed').join(', '));
          }
          result.data.forEach(prof => {
            const profileObj = {
              ...prof,
              nas_id: r.id,
              nas_name: r.name,
              nas_ip: r.nas_ip
            };
            combined.push(profileObj);
            console.log(`  - Added profile: ${prof.name || prof['name'] || 'unnamed'} from ${r.name}`);
          });
        } else {
          console.warn(`✗ Failed to get profiles from ${r.name}:`, result.message);
          errorMessages.push(`${r.name}: ${result.message}`);
        }
      } catch (e) {
        console.error(`✗ Error getting hotspot profiles from ${r.name} (${r.nas_ip}:${r.port || 8728}):`, e.message);
        console.error('Full error:', e);
        errorMessages.push(`${r.name}: ${e.message}`);
      }
    }
    
    console.log(`=== Total profiles collected: ${combined.length} ===`);
    
    res.render('adminMikrotikHotspotProfiles', { 
      profiles: combined, 
      routers,
      settings,
      error: errorMessages.length > 0 ? `Beberapa router gagal: ${errorMessages.join('; ')}` : null,
      versionInfo: getVersionInfo(),
      versionBadge: getVersionBadge(),
      userAuthMode: userAuthMode,
      page: 'hotspot-profiles'
    });
  } catch (err) {
    console.error('Error in hotspot profiles GET route:', err);
    
    // Robust Error Fallback: Refetch routers if they aren't populated yet
    if (!routers || routers.length === 0) {
      try {
        routers = await getAllRoutersHelper();
      } catch (_) {}
    }

    res.render('adminMikrotikHotspotProfiles', { 
      profiles: [], 
      routers: routers, // Preserve NAS list even on error
      error: `Terjadi kesalahan: ${err.message}`, 
      settings,
      versionInfo: getVersionInfo(),
      versionBadge: getVersionBadge(),
      userAuthMode: userAuthMode
    });
  }
});

// GET: API Daftar Profile Hotspot
router.get('/mikrotik/hotspot-profiles/api', adminAuth, async (req, res) => {
  try {
    const { router_id } = req.query;
    
    // If router_id is provided, only fetch from that router
    if (router_id) {
      const routerObj = await new Promise((resolve) => billingManager.db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
        resolve(row || null);
      }));
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
    
    const routers = await getAllRoutersHelper();
    
    // Untuk endpoint API ini, selalu ambil profile langsung dari Mikrotik (RouterOS),
    // tidak lagi menggunakan profile dari RADIUS.
    // Router wajib ada.
    if (!routers || routers.length === 0) {
      return res.json({ success: false, profiles: [], message: 'Tidak ada router/NAS yang dikonfigurasi' });
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
    const routerObj = await new Promise((resolve) => billingManager.db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
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
    const routerObj = await new Promise((resolve) => billingManager.db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
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
    const routerObj = await new Promise((resolve) => billingManager.db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
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
    const routers = await new Promise((resolve) => billingManager.db.all('SELECT * FROM routers ORDER BY id', (err, rows) => resolve(rows || [])));
    
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
    const profileCount = _pppoeProfilesApiCache && _pppoeProfilesApiCache.payload && Array.isArray(_pppoeProfilesApiCache.payload.profiles)
      ? _pppoeProfilesApiCache.payload.profiles.length
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
      billingManager.db.all('SELECT * FROM routers ORDER BY id', (err, rows) => {
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
      const routerObj = await new Promise((resolve) => db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
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
    const routers = await new Promise((resolve) => billingManager.db.all('SELECT * FROM routers ORDER BY id', (err, rows) => {
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

    const routerObj = await new Promise((resolve) => billingManager.db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
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
    const routerObj = await new Promise((resolve) => db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
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
    const routerObj = await new Promise((resolve) => db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
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
      billingManager.db.all('SELECT * FROM routers ORDER BY name', (err, rows) => {
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

    const routerObj = await new Promise((resolve) => billingManager.db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
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

    const routerObj = await new Promise((resolve) => billingManager.db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
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
      billingManager.db.all('SELECT * FROM routers ORDER BY name', (err, rows) => {
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
            // Deduplikasi: jika pool dengan nama yang sama sudah ada, gabungkan info router
            if (poolMap.has(pool.name)) {
              const existing = poolMap.get(pool.name);
              if (!existing.routers) {
                existing.routers = [existing.router];
              }
              if (!existing.routers.some(r => r.id === router.id)) {
                existing.routers.push({
                  id: router.id,
                  name: router.name,
                  nas_ip: router.nas_ip
                });
              }
            } else {
              poolMap.set(pool.name, {
                name: pool.name,
                ranges: pool.ranges || '',
                comment: pool.comment || '',
                router: {
                  id: router.id,
                  name: router.name,
                  nas_ip: router.nas_ip
                },
                routers: [{
                  id: router.id,
                  name: router.name,
                  nas_ip: router.nas_ip
                }]
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
      const routerObj = await new Promise((resolve) => billingManager.db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
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
    const routers = await new Promise((resolve) => billingManager.db.all('SELECT * FROM routers ORDER BY id', (err, rows) => {
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

    const routerObj = await new Promise((resolve) => billingManager.db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
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

    const routerObj = await new Promise((resolve) => billingManager.db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
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
    const routerObj = await new Promise((resolve) => db.get('SELECT * FROM routers WHERE id=?', [parseInt(router_id)], (err, row) => {
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
