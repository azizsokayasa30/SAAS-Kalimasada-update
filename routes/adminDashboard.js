const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const { getSettingsWithCache } = require('../config/settingsManager');
const { getVersionInfo, getVersionBadge } = require('../config/version-utils');
const { getRadiusConfigValue } = require('../config/radiusConfig');
const billingManager = require('../config/billing');
const cacheManager = require('../config/cacheManager');
const { resolveRequestTenantId } = require('../config/platform/tenantCache');
const { attachTenantAppSettings } = require('../config/platform/tenantAppSettings');
const sqlite3 = require('sqlite3').verbose();

router.use(attachTenantAppSettings);

const DASHBOARD_CACHE_TTL_MS = 45 * 1000;
const EMPTY_BILLING_STATS = {
  total_customers: 0, active_customers: 0, total_invoices: 0, paid_invoices: 0, unpaid_invoices: 0,
  total_revenue: 0, total_unpaid: 0, monthly_revenue: 0, voucher_revenue: 0, monthly_invoices: 0,
  paid_monthly_invoices: 0, unpaid_monthly_invoices: 0, monthly_unpaid: 0, monthly_total_tagihan: 0,
  monthly_belum_lunas_canonical: 0, monthly_lunas_canonical: 0, outstanding_unpaid_total: 0,
  outstanding_unpaid_count: 0, voucher_invoices: 0, paid_voucher_invoices: 0, unpaid_voucher_invoices: 0,
  voucher_unpaid: 0,
};

function resolveBestBillingDbPath() {
  const candidates = [
    path.join(process.cwd(), 'data', 'billing.db'),
    path.join(__dirname, '../data', 'billing.db'),
    path.join(__dirname, '../../data', 'billing.db')
  ];

  const existing = Array.from(new Set(candidates)).filter((p) => fs.existsSync(p));
  if (existing.length === 0) {
    return path.join(process.cwd(), 'data', 'billing.db');
  }

  // Prefer the largest DB file to avoid accidentally reading empty nested runtime DB.
  let best = existing[0];
  let bestSize = 0;
  for (const p of existing) {
    try {
      const sz = fs.statSync(p).size || 0;
      if (sz > bestSize) {
        best = p;
        bestSize = sz;
      }
    } catch (_) {}
  }
  return best;
}

function getJakartaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta',
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(date);
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dayIndex: weekdayMap[map.weekday] ?? new Date(date).getDay(),
    day: parseInt(map.day, 10),
    month: parseInt(map.month, 10) - 1,
    year: parseInt(map.year, 10)
  };
}

function formatDashboardGreetingDate(date = new Date()) {
  const days = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu'];
  const months = ['januari', 'februari', 'maret', 'april', 'mei', 'juni', 'juli', 'agustus', 'september', 'oktober', 'november', 'desember'];
  const { dayIndex, day, month, year } = getJakartaDateParts(date);
  return `hari ini ${days[dayIndex]}, ${day} ${months[month]} ${year}`;
}

function resolveDashboardUserName(req, settings = {}) {
  const sessionName = req.session.adminUsername || req.session.adminUser;
  if (sessionName && String(sessionName).trim()) {
    return String(sessionName).trim();
  }
  const fallback = settings.admin_display_name || settings.company_owner || settings.company_name;
  return (fallback && String(fallback).trim()) ? String(fallback).trim() : 'Admin';
}

function dashboardCacheKey(req, suffix) {
  const tenantId = resolveRequestTenantId(req) ?? 'global';
  return `dash:${tenantId}:${suffix}`;
}

function withTimeout(promise, ms, label = 'timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

async function getCachedDashboardData(req, key, fetcher, ttl = DASHBOARD_CACHE_TTL_MS) {
  const cacheKey = dashboardCacheKey(req, key);
  const cached = cacheManager.get(cacheKey);
  if (cached != null) return cached;
  const value = await fetcher();
  cacheManager.set(cacheKey, value, ttl);
  return value;
}

function scheduleReconcilePortalPackageRequests(tenantId = null) {
  setImmediate(() => {
    billingManager.reconcilePortalPackageRequestsFulfilled(tenantId).catch((e) => {
      console.warn('[DASHBOARD] background reconcile:', e.message);
    });
  });
}

function loadDashboardRecentData(tenantId = null) {
  return new Promise((resolve) => {
    const dbPath = resolveBestBillingDbPath();
    const db = new sqlite3.Database(dbPath);
    const now = new Date();
    const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    // Isolasi multi-tenant untuk data pelanggan/invoice (kolom tenant_id).
    const tScope = tenantId != null;
    const custTenantAnd = tScope ? ' AND c.tenant_id = ?' : '';
    const custTenantWhere = tScope ? ' WHERE tenant_id = ?' : '';
    const invTenantAnd = tScope ? ' AND i.tenant_id = ?' : '';
    const result = {
      recentCustomers: [],
      recentPaidInvoices: [],
      newCustomersThisMonth: 0,
      operationalStats: {
        pendingInstallations: 0,
        pendingTroubleTickets: 0,
        employeesAttendedToday: 0,
      },
    };

    const finish = () => {
      db.close();
      resolve(result);
    };

    let pending = 5;
    const done = () => {
      pending -= 1;
      if (pending <= 0) finish();
    };

    db.all(
      `SELECT id, name, phone, area, status, join_date FROM customers${custTenantWhere}
       ORDER BY datetime(COALESCE(join_date, '1970-01-01 00:00:00')) DESC, id DESC LIMIT 5`,
      tScope ? [tenantId] : [],
      (err, rows) => {
        result.recentCustomers = err ? [] : (rows || []);
        done();
      }
    );

    db.all(
      `SELECT i.id, i.invoice_number, i.amount, i.payment_date, i.created_at,
              COALESCE(c.name, 'Pelanggan') as customer_name
       FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id
       WHERE i.status = 'paid'${invTenantAnd}
       ORDER BY datetime(COALESCE(i.payment_date, i.created_at, '1970-01-01 00:00:00')) DESC, i.id DESC
       LIMIT 5`,
      tScope ? [tenantId] : [],
      (err, rows) => {
        result.recentPaidInvoices = err ? [] : (rows || []);
        done();
      }
    );

    db.get(
      `SELECT COUNT(*) as cnt FROM customers c
       WHERE strftime('%Y-%m', COALESCE(join_date, created_at, datetime('now','localtime'))) = ?
         AND date(COALESCE(join_date, created_at)) <= date('now','localtime')${custTenantAnd}`,
      tScope ? [monthStr, tenantId] : [monthStr],
      (err, row) => {
        result.newCustomersThisMonth = (!err && row) ? (row.cnt || 0) : 0;
        done();
      }
    );

    const jobsTenantAnd = tScope ? ' AND tenant_id = ?' : '';
    const attTenantAnd = tScope ? ' AND tenant_id = ?' : '';

    db.get(
      `SELECT COUNT(*) AS cnt FROM installation_jobs
       WHERE LOWER(COALESCE(status, '')) IN ('scheduled', 'assigned', 'in_progress')${jobsTenantAnd}`,
      tScope ? [tenantId] : [],
      (err, row) => {
        result.operationalStats.pendingInstallations = (!err && row) ? (row.cnt || 0) : 0;
        done();
      }
    );

    db.get(
      `SELECT COUNT(DISTINCT employee_id) AS cnt FROM employee_attendance
       WHERE date = date('now', 'localtime') AND TRIM(COALESCE(status, '')) != ''${attTenantAnd}`,
      tScope ? [tenantId] : [],
      (err, row) => {
        result.operationalStats.employeesAttendedToday = (!err && row) ? (row.cnt || 0) : 0;
        done();
      }
    );
  });
}

function loadDashboardTroubleSummary() {
  const _t = billingManager._tenantWhere();
  return new Promise((resolve) => {
    const dbPath = resolveBestBillingDbPath();
    const db = new sqlite3.Database(dbPath);
    db.get(
      `SELECT COUNT(*) AS cnt FROM trouble_reports
       WHERE LOWER(COALESCE(status, '')) IN ('open', 'pending', 'in_progress', 'baru')${_t.sql}`,
      [..._t.params],
      (err, countRow) => {
        const pending = (!err && countRow) ? (countRow.cnt || 0) : 0;
        db.all(
          `SELECT id, name, customer_name, status, created_at FROM trouble_reports
           WHERE 1=1${_t.sql}
           ORDER BY datetime(COALESCE(created_at, '1970-01-01 00:00:00')) DESC LIMIT 5`,
          [..._t.params],
          (err2, rows) => {
            db.close();
            resolve({
              pendingTroubleTickets: pending,
              recentTickets: err2 ? [] : (rows || []),
            });
          }
        );
      }
    );
  });
}

function pickSidebarSettings(full = {}) {
  return {
    logo_filename: full.logo_filename || 'logo.png',
    company_header: full.company_header || full.company_name || 'Kalimasada Billing',
    company_name: full.company_name || full.company_header || 'Kalimasada Billing',
  };
}

function getLightSettingsForDashboard(req) {
  if (req.tenantSettings) {
    return pickSidebarSettings(req.tenantSettings);
  }
  if (req.tenant?.settings) {
    return pickSidebarSettings(req.tenant.settings);
  }
  return pickSidebarSettings(getSettingsWithCache());
}

async function loadDashboardOverviewData(req) {
  const tenantId = resolveRequestTenantId(req);
  const [
    billingResult,
    portalReqResult,
    recentDataResult,
    troubleResult,
  ] = await Promise.allSettled([
    getCachedDashboardData(req, 'billing-stats', () => withTimeout(billingManager.getBillingStats({ tenantId }), 12000, 'billing stats timeout')),
    withTimeout(billingManager.listPortalPackageRequestsPending(20, tenantId), 5000, 'portal requests timeout'),
    getCachedDashboardData(req, 'recent-data', () => loadDashboardRecentData(tenantId), 30 * 1000),
    loadDashboardTroubleSummary(),
  ]);

  const billingStats = billingResult.status === 'fulfilled' ? billingResult.value : EMPTY_BILLING_STATS;
  const portalPackageRequests = portalReqResult.status === 'fulfilled' ? portalReqResult.value : [];
  const recentData = recentDataResult.status === 'fulfilled' ? recentDataResult.value : {};
  const troubleData = troubleResult.status === 'fulfilled' ? troubleResult.value : {};

  if (billingResult.status === 'rejected') {
    console.warn('⚠️ [DASHBOARD] Billing stats:', billingResult.reason?.message || billingResult.reason);
  }

  return {
    billingStats: billingStats || EMPTY_BILLING_STATS,
    portalPackageRequests: portalPackageRequests || [],
    recentCustomers: recentData.recentCustomers || [],
    recentPaidInvoices: recentData.recentPaidInvoices || [],
    recentTickets: troubleData.recentTickets || [],
    newCustomersThisMonth: recentData.newCustomersThisMonth || 0,
    operationalStats: {
      pendingInstallations: recentData.operationalStats?.pendingInstallations || 0,
      pendingTroubleTickets: troubleData.pendingTroubleTickets || 0,
      employeesAttendedToday: recentData.operationalStats?.employeesAttendedToday || 0,
    },
  };
}

// GET: Dashboard admin — shell cepat; data statistik via /dashboard/api/overview (AJAX).
router.get('/dashboard', adminAuth, (req, res) => {
  const settings = getLightSettingsForDashboard(req);
  scheduleReconcilePortalPackageRequests(resolveRequestTenantId(req));

  res.render('adminDashboard', {
    title: 'Dashboard Admin',
    page: 'dashboard',
    deferStatsLoad: true,
    settings,
    versionInfo: getVersionInfo(),
    versionBadge: getVersionBadge(),
    billingStats: EMPTY_BILLING_STATS,
    recentCustomers: [],
    recentPaidInvoices: [],
    recentTickets: [],
    newCustomersThisMonth: 0,
    operationalStats: { pendingInstallations: 0, pendingTroubleTickets: 0, employeesAttendedToday: 0 },
    portalPackageRequests: [],
    adminNotifBadgeTotal: 0,
    dashboardGreetingUser: resolveDashboardUserName(req, settings),
    dashboardGreetingDate: formatDashboardGreetingDate(),
  });
});

router.get('/dashboard/api/overview', adminAuth, async (req, res) => {
  try {
    const cacheKey = dashboardCacheKey(req, 'overview-json');
    const cached = cacheManager.get(cacheKey);
    if (cached) {
      return res.json({ success: true, cached: true, ...cached });
    }
    const data = await loadDashboardOverviewData(req);
    cacheManager.set(cacheKey, data, 30 * 1000);
    return res.json({ success: true, cached: false, ...data });
  } catch (err) {
    console.error('[DASHBOARD] overview API:', err);
    return res.status(500).json({ success: false, message: err.message || 'Gagal memuat data dashboard' });
  }
});

/** Status Baileys per-tenant untuk banner dashboard (tidak di-cache lama). */
router.get('/dashboard/api/baileys-status', adminAuth, async (req, res) => {
  try {
    const tenantId = resolveRequestTenantId(req);
    if (!tenantId) {
      return res.json({ success: true, applicable: false, alert: null });
    }
    const registry = require('../config/baileys-session-registry');
    const alert = await registry.getDashboardAlertForTenant(tenantId);
    if (alert && !alert.connected && alert.hasCreds) {
      // Dorong reconnect otomatis saat admin membuka dashboard
      registry.connect(tenantId).catch(() => {});
    }
    return res.json({
      success: true,
      applicable: !!alert,
      alert: alert && !alert.connected ? alert : (alert && alert.connected ? { ...alert, message: null } : null)
    });
  } catch (err) {
    console.error('[DASHBOARD] baileys-status:', err);
    return res.status(500).json({ success: false, message: err.message || 'Gagal cek status Baileys' });
  }
});

// Halaman penuh pusat notifikasi admin
router.get('/dashboard/notifications', adminAuth, async (req, res) => {
  try {
    const tenantId = resolveRequestTenantId(req);
    const settings = req.tenantSettings || getLightSettingsForDashboard(req);
    try {
      await billingManager.reconcilePortalPackageRequestsFulfilled(tenantId);
    } catch (e) {
      console.warn('⚠️ [NOTIF PAGE] reconcile portal package requests:', e.message);
    }
    const lim = 200;
    const [feed, badge, portalPending] = await Promise.all([
      billingManager.getAdminUnifiedNotificationFeed(lim, tenantId),
      billingManager.getAdminNotificationBadgeCount(tenantId),
      billingManager.countPortalPackageRequestsPending(tenantId).catch(() => 0),
    ]);
    return res.render('admin/notifications-center', {
      title: 'Pusat notifikasi',
      page: 'dashboard',
      settings: settings || {},
      notifItems: feed.items || [],
      adminNotifBadgeTotal: badge || 0,
      portalPending: portalPending || 0,
    });
  } catch (err) {
    console.error('[NOTIF PAGE]', err);
    return res.status(500).send('Gagal memuat pusat notifikasi');
  }
});

router.get('/dashboard/api/notifications', adminAuth, async (req, res) => {
  try {
    const tenantId = resolveRequestTenantId(req);
    try {
      await billingManager.reconcilePortalPackageRequestsFulfilled(tenantId);
    } catch (e) {
      console.warn('⚠️ [DASHBOARD API] reconcile portal package requests:', e.message);
    }
    const lim = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 50));
    const [feed, badge, portalPending] = await Promise.all([
      billingManager.getAdminUnifiedNotificationFeed(lim, tenantId),
      billingManager.getAdminNotificationBadgeCount(tenantId),
      billingManager.countPortalPackageRequestsPending(tenantId).catch(() => 0),
    ]);
    return res.json({
      success: true,
      items: feed.items || [],
      badge: badge || 0,
      portalPending: portalPending || 0,
    });
  } catch (err) {
    console.error('[DASHBOARD API] notifications', err);
    return res.status(500).json({ success: false, message: 'Gagal memuat notifikasi' });
  }
});

/** Hapus/bersihkan notifikasi admin (baca + permintaan paket pending → dismissed). */
router.post('/dashboard/api/notifications/clear', adminAuth, async (req, res) => {
  try {
    const dismissPortal = req.body && req.body.dismissPortal === false ? false : true;
    const summary = await billingManager.clearAdminUiNotifications({ dismissPortalRequests: dismissPortal });
    return res.json({ success: true, summary });
  } catch (err) {
    console.error('[DASHBOARD API] notifications/clear', err);
    return res.status(500).json({ success: false, message: 'Gagal membersihkan notifikasi' });
  }
});

// GET: System Information API
router.get('/dashboard/api/system-info', adminAuth, async (req, res) => {
  try {
    const hostname = os.hostname();
    const platform = os.platform();
    const arch = os.arch();
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const uptime = os.uptime();
    
    // Get CPU load averages (Linux only)
    let loadAvg = [0, 0, 0];
    try {
      if (platform === 'linux') {
        const { stdout } = await execAsync('cat /proc/loadavg');
        const parts = stdout.trim().split(' ');
        loadAvg = [parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2])];
      }
    } catch (e) {
      console.warn('Could not get load average:', e.message);
    }
    
    // Get running processes count
    let processCount = 0;
    try {
      if (platform === 'linux') {
        const { stdout } = await execAsync('ps aux | wc -l');
        processCount = parseInt(stdout.trim()) - 1; // Subtract header line
      }
    } catch (e) {
      console.warn('Could not get process count:', e.message);
    }
    
    // Get CPU usage percentage - using /proc/stat method (more accurate)
    let cpuUsage = 0;
    try {
      // Read /proc/stat twice with small delay to calculate actual CPU usage
      const { stdout: stat1 } = await execAsync("cat /proc/stat | head -1");
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
      const { stdout: stat2 } = await execAsync("cat /proc/stat | head -1");
      
      const parseStat = (line) => {
        const parts = line.trim().split(/\s+/);
        return {
          user: parseInt(parts[1]) || 0,
          nice: parseInt(parts[2]) || 0,
          system: parseInt(parts[3]) || 0,
          idle: parseInt(parts[4]) || 0,
          iowait: parseInt(parts[5]) || 0,
          irq: parseInt(parts[6]) || 0,
          softirq: parseInt(parts[7]) || 0
        };
      };
      
      const cpu1 = parseStat(stat1);
      const cpu2 = parseStat(stat2);
      
      const total1 = cpu1.user + cpu1.nice + cpu1.system + cpu1.idle + cpu1.iowait + cpu1.irq + cpu1.softirq;
      const total2 = cpu2.user + cpu2.nice + cpu2.system + cpu2.idle + cpu2.iowait + cpu2.irq + cpu2.softirq;
      
      const idle1 = cpu1.idle;
      const idle2 = cpu2.idle;
      
      const totalIdle = idle2 - idle1;
      const total = total2 - total1;
      
      if (total > 0) {
        cpuUsage = Math.round(((total - totalIdle) / total) * 100);
        cpuUsage = Math.max(0, Math.min(100, cpuUsage)); // Clamp between 0-100
      }
    } catch (e) {
      // Fallback: use load average as percentage of CPU cores
      // Load average of 1.0 on 4 cores = 25% usage
      const cpuCount = cpus.length;
      if (cpuCount > 0 && loadAvg[0] > 0) {
        cpuUsage = Math.min(Math.round((loadAvg[0] / cpuCount) * 100), 100);
      }
      console.warn('Using load average for CPU usage:', cpuUsage + '%');
    }
    
    // Get disk usage
    const diskUsage = [];
    try {
      if (platform === 'linux') {
        const { stdout } = await execAsync("df -h | grep -E '^/dev/' | awk '{print $2,$3,$4,$5,$6}'");
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5) {
            const total = parseSize(parts[0]);
            const used = parseSize(parts[1]);
            const available = parseSize(parts[2]);
            const percent = parseInt(parts[3].replace('%', ''));
            const mount = parts.slice(4).join(' '); // Handle mount paths with spaces
            
            // Get filesystem type
            let fsType = 'ext4';
            try {
              const { stdout: fsTypeOut } = await execAsync(`df -T "${mount}" 2>/dev/null | tail -1 | awk '{print $2}'`);
              fsType = fsTypeOut.trim() || 'ext4';
            } catch (e) {
              // Use default
            }
            
            diskUsage.push({
              mounted: mount,
              total: total,
              used: used,
              free: available,
              percent: percent,
              type: fsType
            });
          }
        }
      }
    } catch (e) {
      console.warn('Could not get disk usage:', e.message);
    }
    
    // Get network interfaces
    const networkInterfaces = [];
    try {
      const interfaces = os.networkInterfaces();
      for (const [name, addrs] of Object.entries(interfaces)) {
        if (!addrs) continue;
        // Skip loopback interface
        if (name === 'lo') continue;
        
        const ipv4 = addrs.find(addr => addr.family === 'IPv4');
        const ipv6 = addrs.filter(addr => addr.family === 'IPv6');
        
        if (ipv4) {
          // Try to get interface speed (Linux only)
          let interfaceSpeed = 'N/A';
          try {
            if (platform === 'linux') {
              const { stdout: speedOut } = await execAsync(`cat /sys/class/net/${name}/speed 2>/dev/null || echo "N/A"`);
              const speed = speedOut.trim();
              if (speed && speed !== 'N/A' && !isNaN(speed)) {
                interfaceSpeed = speed + 'Mb/s';
              }
            }
          } catch (e) {
            // Use default
          }
          
          networkInterfaces.push({
            name: name,
            type: 'Ethernet',
            interfaceSpeed: interfaceSpeed,
            ipv4: ipv4.address,
            ipv6: ipv6.map(addr => addr.address),
            netmask: ipv4.netmask,
            broadcast: calculateBroadcast(ipv4.address, ipv4.netmask),
            active: true
          });
        }
      }
    } catch (e) {
      console.warn('Could not get network interfaces:', e.message);
    }
    
    // Get kernel version
    let kernel = 'N/A';
    try {
      if (platform === 'linux') {
        const { stdout } = await execAsync('uname -r');
        kernel = stdout.trim();
      }
    } catch (e) {
      console.warn('Could not get kernel version:', e.message);
    }
    
    // Get OS version
    let osVersion = 'N/A';
    try {
      if (platform === 'linux') {
        const { stdout } = await execAsync('lsb_release -d 2>/dev/null | cut -f2 || cat /etc/os-release | grep PRETTY_NAME | cut -d "=" -f2 | tr -d \'"\'');
        osVersion = stdout.trim() || 'Linux';
      }
    } catch (e) {
      osVersion = platform;
    }
    
    // Format uptime
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const uptimeFormatted = `${days}d ${hours}h ${minutes}m`;
    
    // Get version info
    const versionInfo = getVersionInfo();
    
    const systemInfo = {
      hostname: hostname,
      os: osVersion,
      kernel: kernel,
      platform: platform,
      arch: arch,
      cpu: {
        model: cpus[0]?.model || 'Unknown',
        cores: cpus.length,
        usage: Math.round(cpuUsage),
        loadAvg: {
          '1min': loadAvg[0].toFixed(2),
          '5min': loadAvg[1].toFixed(2),
          '15min': loadAvg[2].toFixed(2)
        }
      },
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        cached: 0, // Would need more complex parsing
        percent: Math.round((usedMem / totalMem) * 100)
      },
      virtualMemory: {
        total: totalMem, // Simplified
        used: 0,
        percent: 0
      },
      disk: diskUsage,
      network: networkInterfaces,
      processes: processCount,
      uptime: uptime,
      uptimeFormatted: uptimeFormatted,
      time: new Date().toLocaleString('id-ID', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit' 
      }),
      version: versionInfo.version || 'N/A',
      // Disk I/O - get from /proc/diskstats
      diskIO: await getDiskIO(),
      // Network I/O - get from /proc/net/dev
      networkIO: await getNetworkIO()
    };
    
    res.json({ success: true, data: systemInfo });
  } catch (error) {
    console.error('Error getting system info:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      message: error.message,
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Helper function to parse size strings like "20G", "500M"
function parseSize(sizeStr) {
  const units = { 'K': 1024, 'M': 1024*1024, 'G': 1024*1024*1024, 'T': 1024*1024*1024*1024 };
  const match = sizeStr.match(/^([\d.]+)([KMGT])?/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = (match[2] || '').toUpperCase();
  return Math.round(value * (units[unit] || 1));
}

// Helper function to calculate broadcast address
function calculateBroadcast(ip, netmask) {
  const ipParts = ip.split('.').map(Number);
  const maskParts = netmask.split('.').map(Number);
  const broadcast = ipParts.map((part, i) => part | (~maskParts[i] & 255));
  return broadcast.join('.');
}

// Get Disk I/O statistics
async function getDiskIO() {
  try {
    if (os.platform() === 'linux') {
      // Read /proc/diskstats - format: major minor name reads reads_merged reads_sectors reads_ms writes writes_merged writes_sectors writes_ms
      const { stdout } = await execAsync("cat /proc/diskstats | grep -E 'sd[a-z] |nvme|vd[a-z] ' | head -1");
      const parts = stdout.trim().split(/\s+/);
      if (parts.length >= 14) {
        // sectors_read = parts[5], sectors_written = parts[9]
        // Each sector is typically 512 bytes
        const sectorsRead = parseInt(parts[5]) || 0;
        const sectorsWritten = parseInt(parts[9]) || 0;
        const bytesRead = sectorsRead * 512;
        const bytesWritten = sectorsWritten * 512;
        // Convert to MiB
        return {
          read: Math.round(bytesRead / 1024 / 1024),
          write: Math.round(bytesWritten / 1024 / 1024)
        };
      }
    }
  } catch (e) {
    console.warn('Could not get disk I/O:', e.message);
  }
  return { read: 0, write: 0 };
}

// Get Network I/O statistics
async function getNetworkIO() {
  try {
    if (os.platform() === 'linux') {
      // Read /proc/net/dev - get total RX and TX bytes
      const { stdout } = await execAsync("cat /proc/net/dev | grep -E 'eth|ens|enp|wlan' | awk '{rx+=$2; tx+=$10} END {print rx, tx}'");
      const parts = stdout.trim().split(/\s+/);
      if (parts.length >= 2) {
        const bytesRx = parseInt(parts[0]) || 0;
        const bytesTx = parseInt(parts[1]) || 0;
        // Convert to Mbps (assuming this is total since boot, we'd need delta for real-time)
        // For now, return as is - client will calculate delta
        return {
          rx: Math.round((bytesRx / 1024 / 1024) * 8), // Convert to Mbps
          tx: Math.round((bytesTx / 1024 / 1024) * 8)
        };
      }
    }
  } catch (e) {
    console.warn('Could not get network I/O:', e.message);
  }
  return { rx: 0, tx: 0 };
}

module.exports = router;
