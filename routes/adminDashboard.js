const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const { getAllDevicesFromAllServers } = require('../config/genieacs');
const { getMikrotikConnectionForRouter, getRadiusStatistics, getUserAuthModeAsync } = require('../config/mikrotik');
const { getSettingsWithCache } = require('../config/settingsManager');
const { getVersionInfo, getVersionBadge } = require('../config/version-utils');
const { getRadiusConfigValue } = require('../config/radiusConfig');
const { checkLicenseStatus } = require('../config/licenseManager');
const billingManager = require('../config/billing');
const sqlite3 = require('sqlite3').verbose();

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

// GET: Dashboard admin
router.get('/dashboard', adminAuth, async (req, res) => {
  let genieacsTotal = 0, genieacsOnline = 0, genieacsOffline = 0;
  let mikrotikTotal = 0, mikrotikAktif = 0, mikrotikOffline = 0;
  let settings = {};
  
  try {
    // Baca settings.json
    settings = getSettingsWithCache();
    
    // GenieACS dengan timeout dan fallback - aggregate dari semua server
    try {
      const devices = await Promise.race([
        getAllDevicesFromAllServers(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('GenieACS timeout')), 10000) // Increased timeout untuk multiple servers
        )
      ]);
      genieacsTotal = devices.length;
      // Anggap device online jika ada _lastInform dalam 1 jam terakhir
      const now = Date.now();
      genieacsOnline = devices.filter(dev => dev._lastInform && (now - new Date(dev._lastInform).getTime()) < 3600*1000).length;
      genieacsOffline = genieacsTotal - genieacsOnline;
      console.log(`✅ [DASHBOARD] GenieACS data loaded successfully: ${genieacsTotal} devices from all servers`);
    } catch (genieacsError) {
      console.warn('⚠️ [DASHBOARD] GenieACS tidak dapat diakses - menggunakan data default:', genieacsError.message);
      // Set default values jika GenieACS tidak bisa diakses
      genieacsTotal = 0;
      genieacsOnline = 0;
      genieacsOffline = 0;
      // Dashboard tetap bisa dimuat meskipun GenieACS bermasalah
    }
    
    // Check auth mode - RADIUS atau Mikrotik API
    let authMode = 'mikrotik';
    try {
      authMode = await getUserAuthModeAsync();
    } catch (e) {
      console.warn('⚠️ [DASHBOARD] Could not determine auth mode, defaulting to mikrotik');
    }
    
    // Mikrotik agregasi seluruh NAS (jika mode Mikrotik API)
    if (authMode === 'mikrotik') {
      try {
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database(path.join(process.cwd(), 'data/billing.db'));
        const routers = await new Promise((resolve) => {
          db.all('SELECT * FROM routers ORDER BY id', (err, rows) => resolve(rows || []));
        });
        db.close();

        let totalSecrets = 0, totalActive = 0;
        await Promise.all((routers || []).map(async (r) => {
          try {
            const conn = await Promise.race([
              getMikrotikConnectionForRouter(r),
              new Promise((_, reject) => setTimeout(() => reject(new Error('connect timeout')), 5000))
            ]);
            const [active, secrets] = await Promise.all([
              conn.write('/ppp/active/print'),
              conn.write('/ppp/secret/print')
            ]);
            totalActive += Array.isArray(active) ? active.length : 0;
            totalSecrets += Array.isArray(secrets) ? secrets.length : 0;
          } catch (e) {
            console.warn('⚠️ [DASHBOARD] Skip router', r && r.nas_ip, e.message);
          }
        }));

        mikrotikAktif = totalActive;
        mikrotikTotal = totalSecrets;
        mikrotikOffline = Math.max(totalSecrets - totalActive, 0);
        console.log('✅ [DASHBOARD] Mikrotik aggregated across NAS');
      } catch (mikrotikError) {
        console.warn('⚠️ [DASHBOARD] Mikrotik tidak dapat diakses - menggunakan data default:', mikrotikError.message);
        // Set default values jika Mikrotik tidak bisa diakses
        mikrotikTotal = 0;
        mikrotikAktif = 0;
        mikrotikOffline = 0;
        // Dashboard tetap bisa dimuat meskipun Mikrotik bermasalah
      }
    } else {
      // Mode RADIUS - ambil dari database RADIUS
      try {
        const stats = await getRadiusStatistics();
        mikrotikTotal = stats.total;
        mikrotikAktif = stats.active;
        mikrotikOffline = stats.offline;
        console.log('✅ [DASHBOARD] RADIUS statistics loaded:', stats);
      } catch (radiusError) {
        console.warn('⚠️ [DASHBOARD] RADIUS tidak dapat diakses - menggunakan data default:', radiusError.message);
        mikrotikTotal = 0;
        mikrotikAktif = 0;
        mikrotikOffline = 0;
      }
    }
  } catch (e) {
    console.error('❌ [DASHBOARD] Error in dashboard route:', e);
    // Jika error, biarkan value default 0
  }
  
  // Check license status untuk ditampilkan di dashboard
  let licenseStatus = null;
  try {
    licenseStatus = await checkLicenseStatus();
  } catch (error) {
    console.error('⚠️ [DASHBOARD] Error checking license status:', error);
  }

  // ─── Billing Stats ────────────────────────────────────────────────────────
  let billingStats = null;
  let overdueInvoices = [];
  let recentInvoices = [];
  const withBillingTimeout = (promise, ms = 10000) =>
    Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('billing timeout')), ms))]);

  try {
    [billingStats, overdueInvoices, recentInvoices] = await Promise.all([
      withBillingTimeout(billingManager.getBillingStats(), 15000),
      withBillingTimeout(billingManager.getOverdueInvoices(10), 10000),
      withBillingTimeout(billingManager.getInvoices(null, 10, 0), 10000)
    ]);
    console.log('✅ [DASHBOARD] Billing stats loaded');
  } catch (billingError) {
    console.warn('⚠️ [DASHBOARD] Billing stats tidak dapat dimuat:', billingError.message);
    billingStats = { total_customers: 0, active_customers: 0, total_invoices: 0, paid_invoices: 0, unpaid_invoices: 0, total_revenue: 0, total_unpaid: 0, monthly_revenue: 0, voucher_revenue: 0, monthly_invoices: 0, paid_monthly_invoices: 0, unpaid_monthly_invoices: 0, monthly_unpaid: 0, monthly_total_tagihan: 0, monthly_belum_lunas_canonical: 0, monthly_lunas_canonical: 0, outstanding_unpaid_total: 0, outstanding_unpaid_count: 0, voucher_invoices: 0, paid_voucher_invoices: 0, unpaid_voucher_invoices: 0, voucher_unpaid: 0 };
  }

  let portalPackageRequests = [];
  try {
    await billingManager.reconcilePortalPackageRequestsFulfilled();
  } catch (e) {
    console.warn('⚠️ [DASHBOARD] reconcile portal package requests:', e.message);
  }
  try {
    portalPackageRequests = await billingManager.listPortalPackageRequestsPending(20);
  } catch (e) {
    console.warn('⚠️ [DASHBOARD] portal package requests:', e.message);
    portalPackageRequests = [];
  }

  let adminNotifBadgeTotal = 0;
  try {
    adminNotifBadgeTotal = await billingManager.getAdminNotificationBadgeCount();
  } catch (e) {
    console.warn('⚠️ [DASHBOARD] admin notification badge:', e.message);
    adminNotifBadgeTotal = 0;
  }

  // ─── Recent Data Queries ──────────────────────────────────────────────────
  let recentCustomers = [];
  let recentPaidInvoices = [];
  let recentTickets = [];
  let newCustomersThisMonth = 0;
  let operationalStats = {
    pendingInstallations: 0,
    pendingTroubleTickets: 0,
    employeesAttendedToday: 0
  };

  try {
    const dbPath = resolveBestBillingDbPath();
    const db = new sqlite3.Database(dbPath);
    const now = new Date();
    const monthStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

    await Promise.all([
      // 5 pelanggan terbaru
      new Promise((resolve) => {
        db.all(`SELECT id, name, phone, area, status, join_date
                FROM customers
                ORDER BY datetime(COALESCE(join_date, '1970-01-01 00:00:00')) DESC, id DESC
                LIMIT 5`, [], (err, rows) => {
          if (err) {
            console.warn('⚠️ [DASHBOARD] recentCustomers query failed, trying fallback:', err.message);
            return db.all(`SELECT id, name, phone, area, status, join_date FROM customers ORDER BY id DESC LIMIT 5`, [], (err2, rows2) => {
              if (err2) {
                console.warn('⚠️ [DASHBOARD] recentCustomers fallback failed:', err2.message);
                recentCustomers = [];
              } else {
                recentCustomers = rows2 || [];
              }
              resolve();
            });
          }
          recentCustomers = rows || [];
          resolve();
        });
      }),
      // 5 tagihan lunas terbaru
      new Promise((resolve) => {
        db.all(`SELECT i.id, i.invoice_number, i.amount, i.payment_date, i.created_at,
                  COALESCE(c.name, 'Pelanggan') as customer_name
                FROM invoices i
                LEFT JOIN customers c ON i.customer_id = c.id
                WHERE i.status = 'paid'
                ORDER BY datetime(COALESCE(i.payment_date, i.created_at, '1970-01-01 00:00:00')) DESC, i.id DESC
                LIMIT 5`, [], (err, rows) => {
          if (err) {
            console.warn('⚠️ [DASHBOARD] recentPaidInvoices query failed, trying fallback:', err.message);
            return db.all(`SELECT i.id, i.invoice_number, i.amount, i.payment_date, i.created_at,
                              COALESCE(c.name, 'Pelanggan') as customer_name
                            FROM invoices i
                            LEFT JOIN customers c ON i.customer_id = c.id
                            WHERE i.status = 'paid'
                            ORDER BY i.id DESC LIMIT 5`, [], (err2, rows2) => {
              if (err2) {
                console.warn('⚠️ [DASHBOARD] recentPaidInvoices fallback failed:', err2.message);
                recentPaidInvoices = [];
              } else {
                recentPaidInvoices = rows2 || [];
              }
              resolve();
            });
          }
          recentPaidInvoices = rows || [];
          resolve();
        });
      }),
      // Pelanggan baru bulan ini
      new Promise((resolve) => {
        db.get(`SELECT COUNT(*) as cnt FROM customers WHERE strftime('%Y-%m', COALESCE(join_date, created_at, datetime('now','localtime'))) = ? AND date(COALESCE(join_date, created_at)) <= date('now','localtime')`, [monthStr], (err, row) => {
          if (err) {
            console.warn('⚠️ [DASHBOARD] newCustomersThisMonth query failed:', err.message);
            newCustomersThisMonth = 0;
            return resolve();
          }
          newCustomersThisMonth = (row && row.cnt) || 0;
          resolve();
        });
      }),
      // Pending job instalasi (belum selesai / belum dibatalkan)
      new Promise((resolve) => {
        db.get(
          `SELECT COUNT(*) AS cnt
           FROM installation_jobs
           WHERE LOWER(COALESCE(status, '')) IN ('scheduled', 'assigned', 'in_progress')`,
          [],
          (err, row) => {
            if (err) {
              console.warn('⚠️ [DASHBOARD] pendingInstallations query failed:', err.message);
              operationalStats.pendingInstallations = 0;
            } else {
              operationalStats.pendingInstallations = (row && row.cnt) || 0;
            }
            resolve();
          }
        );
      }),
      // Karyawan yang sudah absen hari ini (unik per employee_id)
      new Promise((resolve) => {
        db.get(
          `SELECT COUNT(DISTINCT employee_id) AS cnt
           FROM employee_attendance
           WHERE date = date('now', 'localtime')
             AND TRIM(COALESCE(status, '')) != ''`,
          [],
          (err, row) => {
            if (err) {
              console.warn('⚠️ [DASHBOARD] employeesAttendedToday query failed:', err.message);
              operationalStats.employeesAttendedToday = 0;
            } else {
              operationalStats.employeesAttendedToday = (row && row.cnt) || 0;
            }
            resolve();
          }
        );
      }),
    ]);
    db.close();

    // Tiket gangguan terbaru (5) dari config troubleReport
    try {
      const { getAllTroubleReports } = require('../config/troubleReport');
      const allTickets = await getAllTroubleReports();
      const pendingStatuses = new Set(['open', 'pending', 'in_progress', 'baru']);
      operationalStats.pendingTroubleTickets = (allTickets || []).filter((t) => {
        const st = String(t && t.status ? t.status : '').toLowerCase().trim();
        return pendingStatuses.has(st);
      }).length;
      recentTickets = (allTickets || [])
        .sort((a, b) => {
          const ad = new Date(a.createdAt || a.created_at || 0).getTime();
          const bd = new Date(b.createdAt || b.created_at || 0).getTime();
          return bd - ad;
        })
        .slice(0, 5);
    } catch(e) {
      operationalStats.pendingTroubleTickets = 0;
      recentTickets = [];
    }
  } catch(dbErr) {
    console.warn('⚠️ [DASHBOARD] Recent data queries failed:', dbErr.message);
  }

  res.render('adminDashboard', {
    title: 'Dashboard Admin',
    page: 'dashboard',
    genieacsTotal,
    genieacsOnline,
    genieacsOffline,
    mikrotikTotal,
    mikrotikAktif,
    mikrotikOffline,
    settings,
    versionInfo: getVersionInfo(),
    versionBadge: getVersionBadge(),
    licenseStatus: licenseStatus,
    // Billing data
    billingStats: billingStats || {},
    overdueInvoices: overdueInvoices || [],
    recentInvoices: recentInvoices || [],
    // Recent data
    recentCustomers,
    recentPaidInvoices,
    recentTickets,
    newCustomersThisMonth,
    operationalStats,
    portalPackageRequests: portalPackageRequests || [],
    adminNotifBadgeTotal: adminNotifBadgeTotal || 0,
    dashboardGreetingUser: resolveDashboardUserName(req, settings),
    dashboardGreetingDate: formatDashboardGreetingDate()
  });
});

// Halaman penuh pusat notifikasi admin
router.get('/dashboard/notifications', adminAuth, async (req, res) => {
  try {
    const settings = getSettingsWithCache();
    try {
      await billingManager.reconcilePortalPackageRequestsFulfilled();
    } catch (e) {
      console.warn('⚠️ [NOTIF PAGE] reconcile portal package requests:', e.message);
    }
    const lim = 200;
    const [feed, badge, portalPending] = await Promise.all([
      billingManager.getAdminUnifiedNotificationFeed(lim),
      billingManager.getAdminNotificationBadgeCount(),
      billingManager.countPortalPackageRequestsPending().catch(() => 0),
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
    try {
      await billingManager.reconcilePortalPackageRequestsFulfilled();
    } catch (e) {
      console.warn('⚠️ [DASHBOARD API] reconcile portal package requests:', e.message);
    }
    const lim = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 50));
    const [feed, badge, portalPending] = await Promise.all([
      billingManager.getAdminUnifiedNotificationFeed(lim),
      billingManager.getAdminNotificationBadgeCount(),
      billingManager.countPortalPackageRequestsPending().catch(() => 0),
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
