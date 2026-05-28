// ==========================================
// CRITICAL: Set TZ sebelum SEMUA require() lain
// Node.js membaca TZ SEKALI saat V8 engine start.
// Jika di-set terlambat, semua new Date() akan pakai UTC.
// Harus berada di baris PERTAMA untuk efek penuh.
// ==========================================
process.env.TZ = 'Asia/Jakarta';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// ==========================================
// GLOBAL CRASH GUARD — harus dipasang sedini mungkin
// Mencegah crash dari error non-fatal di module eksternal
// (WhatsApp, Mikrotik, DB connection, dll)
// ==========================================
process.on('uncaughtException', (err, origin) => {
    // Daftar error yang BOLEH diabaikan (non-fatal)
    const ignorable = [
        'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
        'ERR_STREAM_DESTROYED', 'ERR_SOCKET_CLOSED',
        'Connection closing', 'Connection already closing',
        'RosException', 'SocketTimeout',
    ];
    const isIgnorable = ignorable.some(k =>
        err.message?.includes(k) || err.code === k || err.name?.includes(k)
    );

    if (isIgnorable) {
        console.warn(`[CRASH-GUARD] Non-fatal uncaughtException (diabaikan): ${err.message}`);
    } else {
        console.error(`[CRASH-GUARD] ❌ uncaughtException dari ${origin}:`, err.stack || err);
        // Hanya exit untuk SyntaxError (program tidak bisa jalan)
        // Semua error lain: LOG saja, jangan exit — server tetap berjalan
        if (err.name === 'SyntaxError') {
            process.exit(1);
        }
    }
});

process.on('unhandledRejection', (reason, promise) => {
    const msg = reason?.message || String(reason);
    const ignorable = [
        'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
        'Connection closing', 'Connection already closing',
        'RosException', 'SocketTimeout', 'read ECONNRESET',
        'write EPIPE', 'socket hang up',
    ];
    const isIgnorable = ignorable.some(k => msg.includes(k));

    if (isIgnorable) {
        console.warn(`[CRASH-GUARD] Non-fatal unhandledRejection (diabaikan): ${msg}`);
    } else {
        console.error(`[CRASH-GUARD] ⚠️  unhandledRejection:`, reason);
        // TIDAK memanggil process.exit() — server tetap berjalan
    }
});

// ==========================================
// PROCESS OWNERSHIP GUARD
// Cegah proses campuran root/non-root untuk app yang sama.
// ==========================================
(() => {
    try {
        // Hanya Linux: `ps` tidak ada di Windows; guard ini untuk konflik owner proses.
        if (process.platform !== 'linux') {
            return;
        }
        const { execSync } = require('child_process');
        const os = require('os');
        const appPath = require('path').resolve(__filename);
        const currentPid = process.pid;
        const currentUser = os.userInfo().username;

        const output = execSync('ps -eo pid,user,args', { encoding: 'utf8' });
        const lines = output.split('\n').slice(1).filter(Boolean);

        const conflicts = [];
        for (const line of lines) {
            const trimmed = line.trim();
            const match = trimmed.match(/^(\d+)\s+(\S+)\s+(.*)$/);
            if (!match) continue;
            const pid = Number(match[1]);
            const user = match[2];
            const args = match[3] || '';
            if (!pid || pid === currentPid) continue;

            // Deteksi proses node app.js yang sama, bukan node -e.
            const isNode = /\bnode\b/.test(args) || /\bnodemon\b/.test(args);
            if (!isNode) continue;
            if (!args.includes(appPath)) continue;
            if (/\s-e\s/.test(args)) continue;

            if (user !== currentUser) {
                conflicts.push({ pid, user, args });
            }
        }

        if (conflicts.length > 0) {
            console.error('\n[OWNERSHIP-GUARD] ❌ Ditemukan proses app dengan owner berbeda.');
            console.error(`[OWNERSHIP-GUARD] Current user: ${currentUser}`);
            conflicts.forEach((c) => {
                console.error(`[OWNERSHIP-GUARD] Conflict PID=${c.pid} user=${c.user}`);
            });
            console.error('[OWNERSHIP-GUARD] Jalankan aplikasi hanya dari satu jalur owner (root semua ATAU non-root semua).');
            process.exit(1);
        }
    } catch (e) {
        console.warn('[OWNERSHIP-GUARD] Skip check:', e.message);
    }
})();

const express = require('express');
const compression = require('compression');
const path = require('path');
const axios = require('axios');
const logger = require('./config/logger');
console.log('🚀 [BOOTSTRAP] CVLMEDIA Application is starting...');
console.log(`🚀 [BOOTSTRAP] Current working directory: ${process.cwd()}`);
console.log(`🚀 [BOOTSTRAP] NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`🚀 [BOOTSTRAP] PORT from ENV: ${process.env.PORT}`);
console.log(`⏰ [BOOTSTRAP] Timezone locked to: ${process.env.TZ} (WIB UTC+7)`);
const whatsapp = (() => {
  try {
    return require('./config/whatsapp');
  } catch (err) {
    console.error('[WHATSAPP] Disabled at startup:', err.message);
    return {
      connectToWhatsApp: async () => null,
      setSock: () => {}
    };
  }
})();
const { monitorPPPoEConnections } = require('./config/mikrotik');
const fs = require('fs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const { getSetting } = require('./config/settingsManager');

// Konfirmasi timezone telah tersetel dengan benar
const { getServerTimezone } = require('./config/settingsManager');
logger.info(`⏰ Application timezone confirmed: ${process.env.TZ} (WIB - Waktu Indonesia Barat)`);

// Import invoice scheduler
const invoiceScheduler = require('./config/scheduler');

// Import auto GenieACS setup untuk development (DISABLED - menggunakan web interface)
// const { autoGenieACSSetup } = require('./config/autoGenieACSSetup');

// Import technician sync service for hot-reload
const technicianSync = {
    start() {
        const fs = require('fs');
        const sqlite3 = require('sqlite3').verbose();
        const { getSettingsWithCache } = require('./config/settingsManager');
        
        const db = new sqlite3.Database('./data/billing.db');
        
        const sync = () => {
            const sql = `CREATE TABLE IF NOT EXISTS technicians (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT UNIQUE NOT NULL,
                role TEXT NOT NULL DEFAULT 'technician',
                email TEXT,
                notes TEXT,
                is_active INTEGER DEFAULT 1 CHECK (is_active IN (0, 1)),
                area_coverage TEXT,
                whatsapp_group TEXT,
                created_at DATETIME DEFAULT (datetime('now','localtime')),
                updated_at DATETIME DEFAULT (datetime('now','localtime')),
                last_login DATETIME
            )`;
            db.run(sql, (createErr) => {
                if (createErr) {
                    console.error('Failed to ensure technicians table:', createErr.message);
                    return;
                }
                // Migrate missing columns for older databases
                const migrations = [
                    'ALTER TABLE technicians ADD COLUMN join_date DATETIME',
                    'ALTER TABLE technicians ADD COLUMN whatsapp_group_id TEXT',
                    'ALTER TABLE technicians ADD COLUMN password TEXT'
                ];
                migrations.forEach(m => {
                    db.run(m, (err) => {
                        if (err && !err.message.includes('duplicate column')) {
                            // Column already exists, ignore
                        }
                    });
                });
                // Legacy settings.json technician sync removed
            });
        };
        
        fs.watchFile('settings.json', { interval: 1000 }, sync);
        sync(); // Initial sync
        console.log('🔄 Technician auto-sync enabled - settings.json changes will auto-update technicians');
    }
};

// Start technician sync service
technicianSync.start();

// Import collector sync service
const collectorSync = {
    start() {
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('./data/billing.db');
        
        const sync = () => {
            const tables = [
                // Table: collectors
                `CREATE TABLE IF NOT EXISTS collectors (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    phone TEXT UNIQUE NOT NULL,
                    email TEXT,
                    address TEXT,
                    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'suspended')),
                    commission_rate DECIMAL(5,2) DEFAULT 5.00,
                    password TEXT,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime'))
                )`,
                // Table: collector_payments
                `CREATE TABLE IF NOT EXISTS collector_payments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    collector_id INTEGER NOT NULL,
                    customer_id INTEGER NOT NULL,
                    invoice_id INTEGER NOT NULL,
                    payment_amount DECIMAL(15,2) NOT NULL,
                    commission_amount DECIMAL(15,2) NOT NULL,
                    payment_method TEXT DEFAULT 'cash' CHECK(payment_method IN ('cash', 'transfer', 'other')),
                    payment_date DATETIME DEFAULT (datetime('now','localtime')),
                    notes TEXT,
                    status TEXT DEFAULT 'completed' CHECK(status IN ('completed', 'pending', 'cancelled')),
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (collector_id) REFERENCES collectors(id),
                    FOREIGN KEY (customer_id) REFERENCES customers(id),
                    FOREIGN KEY (invoice_id) REFERENCES invoices(id)
                )`,
                // Table: collector_assignments
                `CREATE TABLE IF NOT EXISTS collector_assignments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    collector_id INTEGER NOT NULL,
                    customer_id INTEGER NOT NULL,
                    assigned_date DATETIME DEFAULT (datetime('now','localtime')),
                    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'cancelled')),
                    notes TEXT,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (collector_id) REFERENCES collectors(id),
                    FOREIGN KEY (customer_id) REFERENCES customers(id),
                    UNIQUE(collector_id, customer_id)
                )`,
                // Table: collector_areas
                `CREATE TABLE IF NOT EXISTS collector_areas (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    collector_id INTEGER NOT NULL,
                    area TEXT NOT NULL,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    UNIQUE(collector_id, area),
                    FOREIGN KEY (collector_id) REFERENCES collectors(id) ON DELETE CASCADE
                )`
            ];

            tables.forEach(sql => {
                db.run(sql, (err) => {
                    if (err) console.error('Failed to ensure collector table:', err.message);
                });
            });

            // Ensure password column exists if table was already created without it
            db.run('ALTER TABLE collectors ADD COLUMN password TEXT', (err) => {
                if (err && !err.message.includes('duplicate column')) {
                    // Ignore other errors
                }
            });

            // Migrate missing columns for collector_payments
            const paymentMigrations = [
                'ALTER TABLE collector_payments ADD COLUMN collected_at DATETIME',
                'ALTER TABLE collector_payments ADD COLUMN amount DECIMAL(15,2)'
            ];
            paymentMigrations.forEach(m => {
                db.run(m, (err) => {
                    if (err && !err.message.includes('duplicate column')) {
                        // Column already exists, ignore
                    }
                });
            });
        };
        
        sync();
        console.log('🔄 Collector system sync enabled');
    }
};

// Start collector sync service
collectorSync.start();

// Import voucher sync service
const voucherSync = {
    start() {
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('./data/billing.db');
        
        const sync = () => {
            const sql = `CREATE TABLE IF NOT EXISTS voucher_revenue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                price DECIMAL(10,2) NOT NULL DEFAULT 0,
                profile TEXT,
                status TEXT DEFAULT 'unpaid' CHECK(status IN ('unpaid', 'paid')),
                created_at DATETIME DEFAULT (datetime('now','localtime')),
                used_at DATETIME,
                usage_count INTEGER DEFAULT 0,
                notes TEXT
            )`;
            db.run(sql, (err) => {
                if (err) console.error('Failed to ensure voucher_revenue table:', err.message);
                else {
                    // Create indexes for better performance
                    const indexes = [
                        'CREATE INDEX IF NOT EXISTS idx_voucher_revenue_username ON voucher_revenue(username)',
                        'CREATE INDEX IF NOT EXISTS idx_voucher_revenue_status ON voucher_revenue(status)',
                        'CREATE INDEX IF NOT EXISTS idx_voucher_revenue_created_at ON voucher_revenue(created_at)'
                    ];
                    indexes.forEach(idx => {
                        db.run(idx, (idxErr) => {
                            if (idxErr) console.error('Failed to create voucher index:', idxErr.message);
                        });
                    });
                }
            });
        };
        
        sync();
        console.log('🔄 Voucher system sync enabled');
    }
};

// Start voucher sync service
voucherSync.start();

// Import employee sync service
const employeeSync = {
    start() {
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('./data/billing.db');
        
        const sync = () => {
            const tables = [
                `CREATE TABLE IF NOT EXISTS employees (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    nama_lengkap TEXT NOT NULL,
                    nik TEXT UNIQUE NOT NULL,
                    alamat TEXT,
                    no_hp TEXT,
                    email TEXT,
                    jabatan TEXT,
                    area_id INTEGER,
                    shift_id INTEGER,
                    tanggal_masuk DATE,
                    status TEXT DEFAULT 'aktif' CHECK(status IN ('aktif', 'nonaktif')),
                    gaji_pokok DECIMAL(15,2) DEFAULT 0,
                    foto_path TEXT,
                    public_code TEXT,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (area_id) REFERENCES areas(id),
                    FOREIGN KEY (shift_id) REFERENCES attendance_shifts(id)
                )`,
                `CREATE TABLE IF NOT EXISTS employee_attendance (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id INTEGER NOT NULL,
                    date DATE NOT NULL,
                    check_in DATETIME,
                    check_out DATETIME,
                    status TEXT CHECK(status IN ('hadir', 'izin', 'sakit', 'alpha')),
                    notes TEXT,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime')),
                    UNIQUE(employee_id, date),
                    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
                )`,
                `CREATE TABLE IF NOT EXISTS employee_payroll (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id INTEGER NOT NULL,
                    period_month INTEGER NOT NULL,
                    period_year INTEGER NOT NULL,
                    gaji_pokok DECIMAL(15,2) DEFAULT 0,
                    tunjangan DECIMAL(15,2) DEFAULT 0,
                    bonus DECIMAL(15,2) DEFAULT 0,
                    potongan DECIMAL(15,2) DEFAULT 0,
                    total_gaji DECIMAL(15,2) DEFAULT 0,
                    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'paid')),
                    payment_date DATETIME,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime')),
                    UNIQUE(employee_id, period_month, period_year),
                    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
                )`,
                `CREATE TABLE IF NOT EXISTS employee_leave_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id INTEGER NOT NULL,
                    request_type TEXT NOT NULL CHECK(request_type IN ('izin', 'cuti')),
                    start_date DATE NOT NULL,
                    end_date DATE NOT NULL,
                    reason TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
                    requested_by TEXT,
                    approved_by TEXT,
                    approved_at DATETIME,
                    approval_notes TEXT,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
                )`,
                `CREATE TABLE IF NOT EXISTS attendance_branches (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    branch_name TEXT NOT NULL,
                    address TEXT,
                    latitude REAL NOT NULL,
                    longitude REAL NOT NULL,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime'))
                )`,
                `CREATE TABLE IF NOT EXISTS attendance_settings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    lock_gps_enabled INTEGER DEFAULT 0,
                    lock_gps_radius_meters INTEGER DEFAULT 100,
                    method_selfie INTEGER DEFAULT 0,
                    method_qrcode INTEGER DEFAULT 0,
                    method_gps_tag INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime'))
                )`,
                `CREATE TABLE IF NOT EXISTS attendance_shifts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    shift_name TEXT NOT NULL,
                    check_in_time TEXT NOT NULL,
                    check_out_time TEXT NOT NULL,
                    is_active INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime'))
                )`
            ];

            tables.forEach(sql => {
                db.run(sql, (err) => {
                    if (err) console.error('Failed to ensure employee table:', err.message);
                });
            });

            // Migrate older databases that do not have employee shift assignment yet
            db.run('ALTER TABLE employees ADD COLUMN shift_id INTEGER', (err) => {
                if (err && !err.message.includes('duplicate column')) {
                    console.error('Failed to add shift_id to employees:', err.message);
                }
            });
            db.run('ALTER TABLE employees ADD COLUMN public_code TEXT', (err) => {
                if (err && !String(err.message).includes('duplicate column')) {
                    console.error('Failed to add public_code to employees:', err.message);
                }
            });
            db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_public_code ON employees(public_code) WHERE public_code IS NOT NULL', (err) => {
                if (err) console.error('Failed employees public_code index:', err.message);
            });
        };
        
        sync();
        console.log('🔄 Employee system sync enabled');
    }
};

// Start employee sync service
employeeSync.start();

// Warehouse (manajemen gudang) — tabel di billing.db
const warehouseSync = {
    start() {
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('./data/billing.db');
        const sync = () => {
            const tables = [
                `CREATE TABLE IF NOT EXISTS warehouse_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    unit TEXT DEFAULT '',
                    low_stock_threshold INTEGER NOT NULL DEFAULT 5,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime'))
                )`,
                `CREATE TABLE IF NOT EXISTS warehouse_inbound_batches (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    item_id INTEGER NOT NULL,
                    quantity INTEGER NOT NULL,
                    reference TEXT,
                    notes TEXT,
                    created_at DATETIME DEFAULT (datetime('now','localtime'))
                )`,
                `CREATE TABLE IF NOT EXISTS warehouse_units (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    item_id INTEGER NOT NULL,
                    inbound_batch_id INTEGER NOT NULL,
                    public_code TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL DEFAULT 'in_stock' CHECK(status IN ('in_stock','out')),
                    outbound_at DATETIME,
                    outbound_recipient TEXT,
                    outbound_notes TEXT,
                    outbound_employee_id INTEGER,
                    created_at DATETIME DEFAULT (datetime('now','localtime'))
                )`
            ];
            tables.forEach((sql) => {
                db.run(sql, (err) => {
                    if (err) console.error('Failed to ensure warehouse table:', err.message);
                });
            });
            db.run('ALTER TABLE warehouse_units ADD COLUMN outbound_recipient TEXT', (err) => {
                if (err && !String(err.message).includes('duplicate column')) {
                    console.error('Warehouse migrate outbound_recipient:', err.message);
                }
            });
            db.run('ALTER TABLE warehouse_units ADD COLUMN outbound_employee_id INTEGER', (err) => {
                if (err && !String(err.message).includes('duplicate column')) {
                    console.error('Warehouse migrate outbound_employee_id:', err.message);
                }
            });
            const indexes = [
                'CREATE INDEX IF NOT EXISTS idx_wh_units_code ON warehouse_units(public_code)',
                'CREATE INDEX IF NOT EXISTS idx_wh_units_item_status ON warehouse_units(item_id, status)',
                'CREATE INDEX IF NOT EXISTS idx_wh_units_batch ON warehouse_units(inbound_batch_id)',
                'CREATE INDEX IF NOT EXISTS idx_wh_batches_item ON warehouse_inbound_batches(item_id)',
                'CREATE INDEX IF NOT EXISTS idx_wh_batches_created ON warehouse_inbound_batches(created_at)'
            ];
            indexes.forEach((sql) => {
                db.run(sql, (err) => {
                    if (err) console.error('Failed to ensure warehouse index:', err.message);
                });
            });
        };
        sync();
        console.log('📦 Warehouse module sync enabled');
    }
};
warehouseSync.start();

// Inisialisasi aplikasi Express
const app = express();

// Import route adminAuth
const { router: adminAuthRouter, adminAuth } = require('./routes/adminAuth');
const cors = require('cors');

// Import license route
const licenseRouter = require('./routes/license');
const { router: apiAuthRouter } = require('./routes/api/auth');
const mobileAdapterRouter = require('./routes/api/mobileAdapter');
const apiCustomersRouter = require('./routes/api/customers');
const apiRoutersRouter = require('./routes/api/routers');
const apiPackagesRouter = require('./routes/api/packages');
const apiTroubleRouter = require('./routes/api/trouble-reports');
const apiAgentsRouter = require('./routes/api/agents');
const apiInstallationsRouter = require('./routes/api/installations');
const apiTechniciansRouter = require('./routes/api/technicians');
const apiVouchersRouter = require('./routes/api/vouchers');
const apiSettingsRouter = require('./routes/api/settings');
const apiCollectorsRouter = require('./routes/api/collectors');
const apiSystemRouter = require('./routes/api/system');
const apiPublicEndpointRouter = require('./routes/api/public-endpoint');
const customerPortalV1Router = require('./routes/api/customerPortalV1');
const unifiedAuthRouter = require('./routes/unifiedAuth');

// Import middleware untuk access control (harus diimport sebelum digunakan)
const { blockTechnicianAccess } = require('./middleware/technicianAccessControl');

// Middleware dasar - Optimized
app.use(compression()); // Tambahkan kompresi gzip/brotli untuk mempercepat loading di web & mobile
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Enable CORS for mobile app access - Enhanced for Web Development
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Static files dengan cache
app.use('/public', express.static(path.join(__dirname, 'public'), {
  maxAge: '7d', // Cache static files untuk 7 hari
  etag: true
}));
const sessionDataDir = path.join(__dirname, 'data');
if (!fs.existsSync(sessionDataDir)) {
  fs.mkdirSync(sessionDataDir, { recursive: true });
}

const DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES = 60;
function getAdminSessionTimeoutMinutes() {
  const raw =
    process.env.ADMIN_SESSION_TIMEOUT_MINUTES ||
    getSetting('admin_session_timeout_minutes', DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES);
  const minutes = Number(raw);
  if (!Number.isFinite(minutes)) return DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES;
  return Math.min(Math.max(Math.round(minutes), 5), 24 * 60);
}

function getAdminSessionTimeoutMs() {
  return getAdminSessionTimeoutMinutes() * 60 * 1000;
}

app.use(session({
  secret: process.env.SESSION_SECRET || getSetting('session_secret', 'kalimasada-billing-secret-key-ganti-ini'),
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: sessionDataDir,
    concurrentDb: true
  }),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: false,
    maxAge: getAdminSessionTimeoutMs(),
    httpOnly: true,
    sameSite: 'lax'
  },
  name: 'admin_session'
}));

app.use((req, res, next) => {
  if (!req.session?.isAdmin) {
    return next();
  }

  const now = Date.now();
  const timeoutMs = getAdminSessionTimeoutMs();
  const lastActivityAt = Number(req.session.lastActivityAt || now);
  const isExpired = now - lastActivityAt > timeoutMs;

  if (isExpired) {
    return req.session.destroy(() => {
      res.clearCookie('admin_session');
      const wantsJson = req.xhr || req.path.startsWith('/api/') || req.get('accept')?.includes('application/json');
      if (wantsJson) {
        return res.status(401).json({
          success: false,
          message: 'Sesi login berakhir karena tidak ada aktivitas. Silakan login kembali.'
        });
      }
      return res.redirect('/login?timeout=1');
    });
  }

  req.session.lastActivityAt = now;
  req.session.cookie.maxAge = timeoutMs;
  return next();
});

// Route khusus untuk login mobile (harus sebelum semua route admin)
app.get('/admin/login/mobile', (req, res) => {
    try {
        const { getSettingsWithCache } = require('./config/settingsManager');
        const appSettings = getSettingsWithCache();
        
        console.log('🔍 Rendering mobile login page...');
        res.render('admin/mobile-login', { 
            error: null,
            success: null,
            appSettings: appSettings
        });
    } catch (error) {
        console.error('❌ Error rendering mobile login:', error);
        res.status(500).send('Error loading mobile login page');
    }
});

// Test route untuk debugging
app.get('/admin/test', (req, res) => {
    res.json({ message: 'Admin routes working!', timestamp: new Date().toISOString() });
});

// POST untuk login mobile
app.post('/admin/login/mobile', async (req, res) => {
    try {
        // Check license status sebelum proses login
        const { isLicenseValid, isTrialExpired } = require('./config/licenseManager');
        const licenseValid = await isLicenseValid();
        
        if (!licenseValid) {
            const trialExpired = await isTrialExpired();
            
            if (trialExpired) {
                return res.render('admin/mobile-login', { 
                    error: 'Trial period telah berakhir. Silakan aktivasi license key terlebih dahulu.',
                    success: null,
                    appSettings: { companyHeader: 'ISP Monitor' },
                    licenseExpired: true
                });
            }
        }
        
        const { username, password, remember } = req.body;
        const { getSetting } = require('./config/settingsManager');
        
        const credentials = {
            username: getSetting('admin_username', 'admin'),
            password: getSetting('admin_password', 'admin')
        };

        if (!username || !password) {
            return res.render('admin/mobile-login', { 
                error: 'Username dan password harus diisi!',
                success: null,
                appSettings: { companyHeader: 'ISP Monitor' }
            });
        }

        if (username === credentials.username && password === credentials.password) {
            req.session.isAdmin = true;
            req.session.adminUsername = username;
            req.session.lastActivityAt = Date.now();

            if (remember) {
                req.session.cookie.maxAge = getAdminSessionTimeoutMs();
            }

            return req.session.save((saveErr) => {
                if (saveErr) {
                    console.error('Mobile login session save failed:', saveErr);
                    return res.render('admin/mobile-login', {
                        error: 'Gagal menyimpan sesi. Silakan coba lagi.',
                        success: null,
                        appSettings: { companyHeader: 'ISP Monitor' }
                    });
                }
                res.redirect('/admin/billing/mobile');
            });
        } else {
            res.render('admin/mobile-login', { 
                error: 'Username atau password salah!',
                success: null,
                appSettings: { companyHeader: 'ISP Monitor' }
            });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.render('admin/mobile-login', { 
            error: 'Terjadi kesalahan saat login!',
            success: null,
            appSettings: { companyHeader: 'ISP Monitor' }
        });
    }
});

// Redirect untuk mobile login
app.get('/admin/mobile', (req, res) => {
    res.redirect('/admin/login/mobile');
});

// Gunakan route adminAuth untuk /admin
app.use('/admin', adminAuthRouter);

// Gunakan route license (harus setelah adminAuth tapi sebelum routes yang memerlukan auth)
app.use('/admin', licenseRouter);

// Import dan gunakan route adminDashboard
const adminDashboardRouter = require('./routes/adminDashboard');
app.use('/admin', blockTechnicianAccess, adminDashboardRouter);

// Import dan gunakan route adminGenieacs
const adminGenieacsRouter = require('./routes/adminGenieacs');
app.use('/admin', blockTechnicianAccess, adminGenieacsRouter);

// Import dan gunakan route adminMappingNew
const adminMappingNewRouter = require('./routes/adminMappingNew');
app.use('/admin', blockTechnicianAccess, adminMappingNewRouter);

// Import dan gunakan route adminMikrotik
const adminMikrotikRouter = require('./routes/adminMikrotik');
app.use('/admin', blockTechnicianAccess, adminMikrotikRouter);

// Import dan gunakan route adminRadius (Setting RADIUS)
const adminRadiusRouter = require('./routes/adminRadius');
app.use('/admin', blockTechnicianAccess, adminRadiusRouter);

// Import dan gunakan route adminRouters (NAS management)
const adminRoutersRouter = require('./routes/adminRouters');
app.use('/admin', blockTechnicianAccess, adminRoutersRouter);

// Import dan gunakan route adminGenieacsServers
const adminGenieacsServersRouter = require('./routes/adminGenieacsServers');
app.use('/admin', blockTechnicianAccess, adminGenieacsServersRouter);

// Import dan gunakan route adminConnectionSettings (Setting Mikrotik - NAS/Routers only)
const adminConnectionSettingsRouter = require('./routes/adminConnectionSettings');
app.use('/admin', blockTechnicianAccess, adminConnectionSettingsRouter);

// Import dan gunakan route adminGenieacsSetting (GenieACS Setting)
const adminGenieacsSettingRouter = require('./routes/adminGenieacsSetting');
app.use('/admin', blockTechnicianAccess, adminGenieacsSettingRouter);

// Import dan gunakan route adminHotspot
const adminHotspotRouter = require('./routes/adminHotspot');
app.use('/admin/hotspot', blockTechnicianAccess, adminHotspotRouter);

// Import dan gunakan route adminMember
const adminMemberRouter = require('./routes/adminMember');
app.use('/admin/member', blockTechnicianAccess, adminMemberRouter);

// Import dan gunakan route adminSetting
const { router: adminSettingRouter } = require('./routes/adminSetting');
app.use('/admin/settings', blockTechnicianAccess, adminAuth, adminSettingRouter);

// Import dan gunakan route configValidation
const configValidationRouter = require('./routes/configValidation');
app.use('/admin/config', blockTechnicianAccess, configValidationRouter);

// Import dan gunakan route adminTroubleReport
const adminTroubleReportRouter = require('./routes/adminTroubleReport');
app.use('/admin/trouble', blockTechnicianAccess, adminAuth, adminTroubleReportRouter);

// Import dan gunakan route adminBilling (dipindah ke bawah agar tidak mengganggu route login)
const adminBillingRouter = require('./routes/adminBilling');
app.use('/admin/billing', blockTechnicianAccess, adminAuth, adminBillingRouter);

const adminWarehouseRouter = require('./routes/adminWarehouse');
app.use('/admin/warehouse', blockTechnicianAccess, adminAuth, adminWarehouseRouter);

// Import dan gunakan route adminGoodsInvoice
const adminGoodsInvoiceRouter = require('./routes/adminGoodsInvoice');
app.use('/admin/billing/goods-invoices', blockTechnicianAccess, adminAuth, adminGoodsInvoiceRouter);

// Import dan gunakan route adminInstallationJobs
const adminInstallationJobsRouter = require('./routes/adminInstallationJobs');
app.use('/admin/installations', blockTechnicianAccess, adminAuth, adminInstallationJobsRouter);

// Import dan gunakan route adminTechnicians
const adminTechniciansRouter = require('./routes/adminTechnicians');
app.use('/admin/technicians', blockTechnicianAccess, adminAuth, adminTechniciansRouter);

// Import dan gunakan route agentAuth
const { router: agentAuthRouter } = require('./routes/agentAuth');
app.use('/agent', agentAuthRouter);

// Import dan gunakan route agent
const agentRouter = require('./routes/agent');
app.use('/agent', agentRouter);

// Import dan gunakan route adminAgents
const adminAgentsRouter = require('./routes/adminAgents');
app.use('/admin', blockTechnicianAccess, adminAuth, adminAgentsRouter);

// Import dan gunakan route adminEmployees
const adminEmployeesRouter = require('./routes/adminEmployees');
app.use('/admin/employees', blockTechnicianAccess, adminAuth, adminEmployeesRouter);

// Import dan gunakan route adminVoucherPricing
const adminVoucherPricingRouter = require('./routes/adminVoucherPricing');
app.use('/admin/voucher-pricing', blockTechnicianAccess, adminAuth, adminVoucherPricingRouter);

// Import dan gunakan route adminCableNetwork
const adminCableNetworkRouter = require('./routes/adminCableNetwork');
app.use('/admin/cable-network', blockTechnicianAccess, adminAuth, adminCableNetworkRouter);

// Import dan gunakan route adminCollectors
const adminCollectorsRouter = require('./routes/adminCollectors');
app.use('/admin/collectors', blockTechnicianAccess, adminCollectorsRouter);

// Import dan gunakan route cache management
const cacheManagementRouter = require('./routes/cacheManagement');
app.use('/admin/cache', blockTechnicianAccess, cacheManagementRouter);

// Import dan gunakan route payment
const paymentRouter = require('./routes/payment');
app.use('/payment', paymentRouter);

// Import dan gunakan route trouble report untuk pelanggan
const troubleReportRouter = require('./routes/troubleReport');
app.use('/customer/trouble', troubleReportRouter);

// Import dan gunakan route voucher publik
const { router: publicVoucherRouter } = require('./routes/publicVoucher');
app.use('/voucher', publicVoucherRouter);

// Import dan gunakan route public tools
const publicToolsRouter = require('./routes/publicTools');
app.use('/tools', publicToolsRouter);

// Import dan gunakan route hotspot error (untuk menampilkan Reply-Message)
const hotspotErrorRouter = require('./routes/hotspotError');
app.use('/', hotspotErrorRouter);

// Tambahkan webhook endpoint untuk voucher payment
app.use('/webhook/voucher', publicVoucherRouter);

// Konstanta
const VERSION = '1.0.0';

// Variabel global untuk menyimpan status koneksi WhatsApp
// (Tetap, karena status runtime)
global.whatsappStatus = {
    connected: false,
    qrCode: null,
    phoneNumber: null,
    connectedSince: null,
    status: 'disconnected'
};

// HAPUS global.appSettings
// Pastikan direktori sesi WhatsApp ada
const sessionDir = getSetting('whatsapp_session_path', './whatsapp-session');
if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
    logger.info(`Direktori sesi WhatsApp dibuat: ${sessionDir}`);
}

// Route untuk health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        version: VERSION,
        whatsapp: global.whatsappStatus.status
    });
});

// Route untuk mendapatkan status WhatsApp
app.get('/whatsapp/status', (req, res) => {
    res.json({
        status: global.whatsappStatus.status,
        connected: global.whatsappStatus.connected,
        phoneNumber: global.whatsappStatus.phoneNumber,
        connectedSince: global.whatsappStatus.connectedSince
    });
});

// Redirect root ke portal login terpusat
app.get('/', (req, res) => {
  res.redirect('/login');
});

// Route Login Terpusat
app.use('/login', unifiedAuthRouter);

// Import PPPoE monitoring modules
const pppoeMonitor = require('./config/pppoe-monitor');
const pppoeCommands = require('./config/pppoe-commands');

// Import GenieACS commands module
const genieacsCommands = require('./config/genieacs-commands');

// Import MikroTik commands module
const mikrotikCommands = require('./config/mikrotik-commands');

// Import RX Power Monitor module
const rxPowerMonitor = require('./config/rxPowerMonitor');

// Tambahkan view engine dan static
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (process.env.NODE_ENV === 'production') {
  app.set('view cache', true); // Optimasi EJS caching untuk prod
}
const {
  registerFieldCompletionStatic,
  scheduleFieldCompletionCleanup,
  cleanupFieldCompletionImages
} = require('./utils/fieldCompletionStorage');
registerFieldCompletionStatic(app);

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  etag: true,
  setHeaders: (res, filePath) => {
    const normalized = filePath.replace(/\\/g, '/');
    // Portal React: selalu ambil index.html & entry terbaru setelah deploy (hindari UI lama di Chrome mobile)
    if (normalized.includes('/customer-app/index.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// Deep link /customer-app/dashboard — kirim SPA index (setelah static, jika bukan file aset)
const customerPortalIndexFile = path.join(__dirname, 'public', 'customer-app', 'index.html');
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const url = (req.originalUrl || '').split('?')[0];
  if (!url.startsWith('/customer-app')) return next();
  const rel = url.replace(/^\/customer-app\/?/, '');
  if (rel.startsWith('assets/')) return next();
  if (rel && /\.(js|mjs|cjs|css|map|svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|json|webmanifest)$/i.test(rel)) {
    return next();
  }
  const fs = require('fs');
  if (!fs.existsSync(customerPortalIndexFile)) return next();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(customerPortalIndexFile, (err) => (err ? next(err) : undefined));
});

// Import dan gunakan route API dashboard traffic
const apiDashboardRouter = require('./routes/apiDashboard');
// Mobile adapter harus sebelum app.use('/api', …) agar /api/mobile-adapter/* tidak tertelan router /api lain
app.use('/api/mobile-adapter', mobileAdapterRouter);
logger.info('✅ API mobile teknisi: /api/mobile-adapter (cek GET /api/mobile-adapter/health)');
// Customer portal API harus sebelum app.use('/api', …) agar tidak tertelan router /api lain
app.use('/api/customer-portal/v1', customerPortalV1Router);
logger.info('✅ Customer portal API: /api/customer-portal/v1');
app.use('/api', apiDashboardRouter);
app.use('/api/auth', apiAuthRouter);
// NOTE: /login sudah di-mount di baris 555, tidak perlu duplikat di sini
app.use('/api/customers', apiCustomersRouter);
app.use('/api/routers', apiRoutersRouter);
app.use('/api/packages', apiPackagesRouter);
app.use('/api/trouble-reports', apiTroubleRouter);
app.use('/api/agents', apiAgentsRouter);
app.use('/api/installations', apiInstallationsRouter);
app.use('/api/technicians', apiTechniciansRouter);
app.use('/api/vouchers', apiVouchersRouter);
app.use('/api/settings', apiSettingsRouter);
app.use('/api/collectors', apiCollectorsRouter);
app.use('/api/system', apiSystemRouter);
app.use('/api/public', apiPublicEndpointRouter);

// Import dan gunakan route Wablas webhook
try {
  const wablasWebhookRouter = require('./routes/wablas-webhook');
  app.use('/', wablasWebhookRouter);
  logger.info('✅ Wablas webhook route loaded');
} catch (e) {
  logger.warn('Wablas webhook route not loaded:', e.message);
}

// Mount customer portal
const customerPortal = require('./routes/customerPortal');
app.use('/customer', customerPortal);

// Mount customer billing portal
const customerBillingRouter = require('./routes/customerBilling');
app.use('/customer/billing', customerBillingRouter);

// Alias singkat ke SPA portal pelanggan (sama host:port dengan billing)
app.get('/portal-pelanggan', (req, res) => res.redirect(302, '/customer-app/'));
app.get('/portal-pelanggan/', (req, res) => res.redirect(302, '/customer-app/'));

// Import dan gunakan route teknisi portal
const { router: technicianAuthRouter } = require('./routes/technicianAuth');
app.use('/technician', technicianAuthRouter);
// Alias Bahasa Indonesia untuk teknisi
app.use('/teknisi', technicianAuthRouter);

// Import dan gunakan route dashboard teknisi
const technicianDashboardRouter = require('./routes/technicianDashboard');
app.use('/technician', technicianDashboardRouter);
// Alias Bahasa Indonesia untuk dashboard teknisi
app.use('/teknisi', technicianDashboardRouter);

// Import dan gunakan route technician cable network
const technicianCableNetworkRouter = require('./routes/technicianCableNetwork');
app.use('/technician', technicianCableNetworkRouter);
// Alias Bahasa Indonesia untuk technician cable network
app.use('/teknisi', technicianCableNetworkRouter);

function normalizeWaNumber(value) {
    const raw = String(value || '').replace(/\D/g, '');
    if (!raw) return '';
    if (raw.startsWith('62')) return raw;
    if (raw.startsWith('0')) return `62${raw.slice(1)}`;
    return raw;
}

function formatDisplayPhone(value) {
    const raw = String(value || '').replace(/\D/g, '');
    if (!raw) return '-';
    if (raw.startsWith('62')) return `0${raw.slice(2)}`;
    return raw;
}

async function renderIsolirPage(req, res) {
    try {
        const { getSettingsWithCache, getSetting } = require('./config/settingsManager');
        const { getPublicAppBaseUrl } = require('./config/public-endpoint');
        const billingManager = require('./config/billing');

        const settings = getSettingsWithCache();
        const companyHeader = getSetting('company_header', 'GEMBOK');
        const adminWA = normalizeWaNumber(
            getSetting('contact_whatsapp', '') || getSetting('admins.0', '6281234567890')
        );
        const adminDisplay = formatDisplayPhone(adminWA);
        const billingBaseUrl = getPublicAppBaseUrl();

        let customer = null;
        const resolveCustomer = async () => {
            const sessionUsername = req.session && (req.session.customer_username || req.session.username);
            const qUser = (req.query.pppoe || req.query.username || req.query.user || '').toString().trim();
            const qPhone = (req.query.phone || req.query.nohp || '').toString().trim();

            if (sessionUsername) {
                try {
                    const c = await billingManager.getCustomerByUsername(sessionUsername);
                    if (c) return c;
                } catch {}
            }
            if (qUser) {
                try {
                    const c = await billingManager.getCustomerByPPPoE(qUser);
                    if (c) return c;
                } catch {}
                try {
                    const c = await billingManager.getCustomerByUsername(qUser);
                    if (c) return c;
                } catch {}
            }
            if (qPhone) {
                try {
                    const c = await billingManager.getCustomerByPhone(qPhone);
                    if (c) return c;
                } catch {}
            }
            return null;
        };

        customer = await resolveCustomer();

        // Auto-resolve nama pelanggan: query -> data pelanggan -> session -> fallback.
        let customerName = (req.query.nama || req.query.name || '').toString().trim();
        if (!customerName && customer && customer.name) customerName = customer.name;
        if (!customerName) customerName = 'Pelanggan';

        let unpaidInvoices = [];
        if (customer && customer.id) {
            try {
                const invoices = await billingManager.getInvoicesByCustomer(customer.id);
                unpaidInvoices = (invoices || [])
                    .filter((invoice) => String(invoice.status || '').toLowerCase() === 'unpaid')
                    .sort((a, b) => new Date(a.due_date || 0) - new Date(b.due_date || 0));
            } catch (invoiceError) {
                logger.warn(`[ISOLIR] Gagal mengambil invoice customer ${customer.id}: ${invoiceError.message}`);
            }
        }
        const totalUnpaid = unpaidInvoices.reduce((sum, invoice) => sum + (Number(invoice.amount) || 0), 0);

        // Logo path dari settings.json (served via /public or /storage pattern)
        const logoFile = settings.logo_filename || 'logo.png';
        const logoPath = `/img/${logoFile}`;

        // Payment accounts from settings.json (bank transfer & cash)
        const paymentAccounts = settings.payment_accounts || {};
        const qrFile = settings.billing_qr_filename || settings.qr_filename || '';

        res.render('isolir', {
            companyHeader,
            adminWA,
            adminDisplay,
            customerName: customerName.slice(0, 64),
            customer,
            unpaidInvoices,
            totalUnpaid,
            logoPath,
            paymentAccounts,
            qrFile,
            billingBaseUrl,
            billingPortalUrl: `${billingBaseUrl}/customer-app/dashboard`,
            invoiceUrl: `${billingBaseUrl}/customer-app/tagihan`,
            encodeURIComponent
        });
    } catch (error) {
        console.error('Error rendering isolir page:', error);
        res.status(500).send('Gagal memuat halaman isolir');
    }
}

// Halaman Isolir - tersedia di port utama dan port khusus 8899.
app.get(['/isolir', '/isolir/'], renderIsolirPage);

// Import dan gunakan route tukang tagih (collector)
const { router: collectorAuthRouter } = require('./routes/collectorAuth');
app.use('/collector', collectorAuthRouter);

// Import dan gunakan route dashboard tukang tagih
const collectorDashboardRouter = require('./routes/collectorDashboard');
app.use('/collector', collectorDashboardRouter);

// Inisialisasi WhatsApp Provider Manager (Baileys/Wablas/Meta/Qontak)
try {
    const { getProviderManager } = require('./config/whatsapp-provider-manager');
    const { getActiveWhatsAppProvider } = require('./config/whatsapp-provider-settings');
    const providerManager = getProviderManager();
    
    // Initialize provider manager saat startup
    (async () => {
        try {
            const activeProvider = getActiveWhatsAppProvider();
            await providerManager.initialize();
            logger.info(`✅ WhatsApp provider initialized at startup: ${providerManager.getProviderType() || activeProvider}`);
                
            // Setup message listener untuk API provider yang mendukung webhook command bot
            try {
                const WhatsAppCore = require('./config/whatsapp-core');
                const WhatsAppCommands = require('./config/whatsapp-commands');
                const WhatsAppMessageHandlers = require('./config/whatsapp-message-handlers');
                
                const whatsappCore = new WhatsAppCore();
                const whatsappCommands = new WhatsAppCommands(whatsappCore);
                const messageHandlers = new WhatsAppMessageHandlers(whatsappCore, whatsappCommands);
                
                const provider = providerManager.getProvider();
                if (provider) {
                    provider.onMessage(async (message) => {
                        logger.debug('📥 WhatsApp provider message received, routing to handler');
                        await messageHandlers.handleIncomingMessage(provider, message);
                    });
                    logger.info('✅ WhatsApp provider message listener registered for command bot');
                }
            } catch (listenerError) {
                logger.error('❌ Error setting up WhatsApp provider message listener:', listenerError);
            }
        } catch (error) {
            logger.error('❌ Error initializing WhatsApp Provider Manager:', error);
        }
    })();
} catch (error) {
    logger.warn('⚠️ WhatsApp Provider Manager not available:', error.message);
}

// Inisialisasi WhatsApp dan PPPoE monitoring
try {
    // Cek apakah Baileys enabled sebelum connect
    const { isBaileysEnabled } = require('./config/baileys-config');
    const { isWablasEnabled } = require('./config/wablas-config');
    const { getActiveWhatsAppProvider } = require('./config/whatsapp-provider-settings');
    const hasMikrotikSettings = getSetting('mikrotik_host') && getSetting('mikrotik_user') && getSetting('mikrotik_password');
    const activeProvider = getActiveWhatsAppProvider();
    const useEnhancedPppoeMonitor = isBaileysEnabled() || (activeProvider === 'baileys' && !isWablasEnabled());
    
    // Hanya connect jika Baileys enabled atau Wablas tidak enabled
    if (useEnhancedPppoeMonitor) {
        whatsapp.connectToWhatsApp().then(sock => {
        if (sock) {
            // Set sock instance untuk whatsapp
            whatsapp.setSock(sock);
            
            // Make WhatsApp socket globally available
            global.whatsappSocket = sock;
            global.getWhatsAppSocket = () => sock;

            // Set sock instance untuk PPPoE monitoring
            pppoeMonitor.setSock(sock);

            // Initialize Agent WhatsApp Commands
            const AgentWhatsAppIntegration = require('./config/agentWhatsAppIntegration');
            const agentWhatsApp = new AgentWhatsAppIntegration(whatsapp);
            agentWhatsApp.initialize();
            
            console.log('🤖 Agent WhatsApp Commands initialized');
            pppoeCommands.setSock(sock);

            // Set sock instance untuk GenieACS commands
            genieacsCommands.setSock(sock);

            // Set sock instance untuk MikroTik commands
            mikrotikCommands.setSock(sock);

            // Set sock instance untuk RX Power Monitor
            rxPowerMonitor.setSock(sock);
            // Set sock instance untuk trouble report
            const troubleReport = require('./config/troubleReport');
            troubleReport.setSockInstance(sock);

            // Initialize database tables for legacy databases without agent feature
            const initAgentTables = () => {
                return new Promise((resolve, reject) => {
                    try {
                        // AgentManager sudah memiliki createTables() yang otomatis membuat semua tabel agent
                        const AgentManager = require('./config/agentManager');
                        const agentManager = new AgentManager();
                        console.log('✅ Agent tables created/verified by AgentManager');
                        resolve();
                    } catch (error) {
                        console.error('Error initializing agent tables:', error);
                        reject(error);
                    }
                });
            };

            // Call init after database connected
            initAgentTables().then(() => {
                console.log('Database initialization completed successfully');
            }).catch((err) => {
                console.error('Database initialization failed:', err);
            });

            // Initialize PPPoE monitoring jika MikroTik dikonfigurasi
            if (hasMikrotikSettings) {
                pppoeMonitor.initializePPPoEMonitoring().then(() => {
                    logger.info('PPPoE monitoring initialized');
                }).catch((err) => {
                    logger.error('Error initializing PPPoE monitoring:', err);
                });
            }

            // Initialize Interval Manager (replaces individual monitoring systems)
            try {
                const intervalManager = require('./config/intervalManager');
                intervalManager.initialize();
                logger.info('Interval Manager initialized with all monitoring systems');
            } catch (err) {
                logger.error('Error initializing Interval Manager:', err);
            }

            try {
                const { startRadiusMaintenanceSchedule } = require('./config/radiusMaintenance');
                startRadiusMaintenanceSchedule();
            } catch (err) {
                logger.error('Error starting RADIUS maintenance schedule:', err);
            }

            try {
                scheduleFieldCompletionCleanup();
                setImmediate(() => {
                    cleanupFieldCompletionImages({ aggressive: true, syncDb: true })
                        .then((r) => {
                            logger.info(
                                `[field-completion] Startup cleanup: ${r.deleted} file dihapus (~${Math.round((r.freedBytes || 0) / 1024 / 1024)}MB)`
                            );
                        })
                        .catch((e) => {
                            logger.warn('[field-completion] Startup cleanup:', e.message);
                        });
                });
            } catch (err) {
                logger.error('Error starting field-completion cleanup:', err);
            }
            
            // Initialize License System
            try {
                const { initializeLicense } = require('./config/licenseManager');
                initializeLicense().then(() => {
                    logger.info('License system initialized');
                }).catch((err) => {
                    logger.error('Error initializing License system:', err);
                });
            } catch (err) {
                logger.error('Error loading License Manager:', err);
            }
        }
        }).catch(err => {
            logger.error('Error connecting to WhatsApp:', err);
        });
    } else {
        logger.info('🚫 Baileys disabled and Wablas enabled, skipping Baileys WhatsApp connection');
    }

    // Jalankan monitor legacy hanya saat monitor PPPoE baru tidak aktif, agar tidak ada polling MikroTik ganda.
    if (hasMikrotikSettings && !useEnhancedPppoeMonitor) {
        monitorPPPoEConnections().catch(err => {
            logger.error('Error starting legacy PPPoE monitoring:', err);
        });
    }
} catch (error) {
    logger.error('Error initializing services:', error);
}

// Tambahkan delay yang lebih lama untuk reconnect WhatsApp
const RECONNECT_DELAY = 30000; // 30 detik

// Fungsi: kill proses yang memakai port tertentu (Windows & Linux)
function killProcessOnPort(port) {
    return new Promise((resolve) => {
        const { exec } = require('child_process');
        const isWin = process.platform === 'win32';

        if (isWin) {
            // Windows: netstat → ambil PID → taskkill
            exec(`netstat -ano | findstr :${port}`, (err, stdout) => {
                if (err || !stdout) return resolve(false);
                const lines = stdout.trim().split('\n');
                const pids = new Set();
                lines.forEach(line => {
                    // Hanya ambil baris dengan state LISTENING atau tanpa state (kadang berbeda format)
                    const parts = line.trim().split(/\s+/);
                    const pid = parts[parts.length - 1];
                    if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
                });
                if (pids.size === 0) return resolve(false);
                let killed = 0;
                pids.forEach(pid => {
                    // Jangan bunuh diri sendiri
                    if (pid === String(process.pid)) { killed++; if (killed === pids.size) resolve(true); return; }
                    exec(`taskkill /PID ${pid} /F`, () => {
                        killed++;
                        if (killed === pids.size) resolve(true);
                    });
                });
            });
        } else {
            // Linux / macOS: fuser
            exec(`fuser -k ${port}/tcp`, (err) => {
                resolve(!err);
            });
        }
    });
}

// Guard: pastikan startServer hanya dipanggil sekali
let _serverStarted = false;

// Fungsi untuk memulai server — dengan auto-kill & retry saat port bentrok
function startServer(portToUse) {
    // Singleton guard — cegah double start
    if (_serverStarted) {
        logger.warn('[BOOTSTRAP] startServer() dipanggil lebih dari sekali — diabaikan.');
        return;
    }
    _serverStarted = true;

    const port = parseInt(portToUse);
    if (isNaN(port) || port < 1 || port > 65535) {
        logger.error(`Port tidak valid: ${portToUse}`);
        return; // jangan exit — biarkan nodemon restart
    }

    logger.info(`Memulai server pada port yang dikonfigurasi: ${port}`);

    // Coba listen, dengan retry setelah kill proses lama
    function doListen(isRetry) {
        try {
            const server = app.listen(port, '0.0.0.0', () => {
                logger.info(`✅ Server berhasil berjalan pada port ${port}`);
                logger.info(`🌐 Akses lokal: http://localhost:${port}`);
                logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
            }).on('error', async (err) => {
                if (err.code === 'EADDRINUSE') {
                    if (!isRetry) {
                        logger.warn(`⚠️  Port ${port} terpakai — mencoba membersihkan proses lama...`);
                        const killed = await killProcessOnPort(port);
                        if (killed) {
                            logger.info(`🔪 Proses pada port ${port} dihentikan. Mencoba ulang dalam 3 detik...`);
                        } else {
                            logger.warn(`⚠️  Tidak ada proses yang bisa dihentikan. Menunggu 3 detik lalu coba ulang...`);
                        }
                        // Tunggu lebih lama agar TIME_WAIT dari OS clear
                        setTimeout(() => doListen(true), 3000);
                    } else {
                        // Retry kedua juga gagal — LOG saja, jangan exit
                        // nodemon akan restart otomatis saat ada perubahan file
                        logger.error(`❌ Port ${port} masih terpakai setelah 2 percobaan.`);
                        logger.error(`💡 Jalankan di terminal: Stop-Process -Name node -Force`);
                        logger.error(`💡 Lalu simpan semua file untuk trigger nodemon restart.`);
                        // Reset guard agar bisa dicoba lagi jika diperlukan
                        _serverStarted = false;
                    }
                } else {
                    // Error selain EADDRINUSE — log saja
                    logger.error('❌ Error starting server:', err.message);
                    _serverStarted = false;
                }
            });
        } catch (error) {
            logger.error(`❌ Terjadi kesalahan saat memulai server:`, error.message);
            _serverStarted = false;
        }
    }

    doListen(false);
}

// Mulai server dengan prioritas: Environment Variable > settings.json > Default 4555
const port = process.env.PORT || getSetting('server_port', 4555);
logger.info(`Attempting to start server on port: ${port} (Source: ${process.env.PORT ? 'Environment' : 'Settings'})`);
// API_URL di .env (untuk mobile) TIDAK mengikat port Node — hindari salah buka di browser
if (!process.env.PORT && process.env.API_URL) {
    try {
        const raw = String(process.env.API_URL).trim().replace(/\/+$/, '');
        const u = new URL(raw.startsWith('http') ? raw : `http://${raw}`);
        const apiPort = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
        const listen = parseInt(port, 10);
        if (apiPort && !Number.isNaN(listen) && apiPort !== listen) {
            logger.warn(
                `[WEB] API_URL memakai port ${apiPort}, tetapi server listen di ${listen}. ` +
                `Tambahkan PORT=${apiPort} di .env (atau buka http://<host>:${listen}) agar web bisa diakses.`
            );
        }
    } catch (_) { /* abaikan URL rusak */ }
}
try {
  const { getPublicAppBaseUrl } = require('./config/public-endpoint');
  logger.info(`Public base URL (Android / link): ${getPublicAppBaseUrl()} — atur di .env (lihat .env.example)`);
} catch (e) {
  logger.warn('Public endpoint config log skipped:', e.message);
}

// Mulai server dengan port dari konfigurasi
console.log(`🚀 [BOOTSTRAP] Final port selected: ${port}`);
startServer(port);

// Portal isolir khusus untuk walled garden Mikrotik.
// Jalur ini hanya menyajikan halaman isolir dan aset publik agar bisa dibuka di port 8899.
function startIsolirPortal(portToUse) {
    const isolirPort = parseInt(portToUse, 10);
    const mainPort = parseInt(port, 10);
    if (!isolirPort || Number.isNaN(isolirPort) || isolirPort < 1 || isolirPort > 65535) {
        logger.warn(`[ISOLIR] Port isolir tidak valid: ${portToUse}`);
        return;
    }
    if (isolirPort === mainPort) {
        logger.info(`[ISOLIR] Port isolir sama dengan port utama (${isolirPort}), memakai route /isolir di app utama.`);
        return;
    }

    const isolirApp = express();
    isolirApp.set('view engine', 'ejs');
    isolirApp.set('views', path.join(__dirname, 'views'));
    isolirApp.use(express.urlencoded({ extended: true, limit: '1mb' }));
    isolirApp.use(express.json({ limit: '1mb' }));
    isolirApp.use(express.static(path.join(__dirname, 'public'), {
        maxAge: '7d',
        etag: true
    }));
    isolirApp.get(['/', '/isolir', '/isolir/'], renderIsolirPage);
    isolirApp.get('*', renderIsolirPage);

    isolirApp.listen(isolirPort, '0.0.0.0', () => {
        logger.info(`✅ Portal isolir aktif di http://0.0.0.0:${isolirPort}/isolir`);
    }).on('error', (err) => {
        logger.warn(`[ISOLIR] Gagal membuka port ${isolirPort}: ${err.message}`);
    });
}

const isolirPort = process.env.ISOLIR_PORT || getSetting('isolir_page_port', 8899);
startIsolirPortal(isolirPort);

// Auto setup GenieACS DNS untuk development (DISABLED - menggunakan web interface)
// setTimeout(async () => {
//     try {
//         logger.info('🚀 Memulai auto setup GenieACS DNS untuk development...');
//         const result = await autoGenieACSSetup.runAutoSetup();
//         
//         if (result.success) {
//             logger.info('✅ Auto GenieACS DNS setup berhasil');
//             if (result.data) {
//                 logger.info(`📋 IP Server: ${result.data.serverIP}`);
//                 logger.info(`📋 GenieACS URL: ${result.data.genieacsUrl}`);
//                 logger.info(`📋 Script Mikrotik: ${result.data.mikrotikScript}`);
//             }
//         } else {
//             logger.warn(`⚠️  Auto GenieACS DNS setup: ${result.message}`);
//         }
//     } catch (error) {
//         logger.error('❌ Error dalam auto GenieACS DNS setup:', error);
//     }
// }, 15000); // Delay 15 detik setelah server start

// Tambahkan perintah untuk menambahkan nomor pelanggan ke tag GenieACS
const { addCustomerTag } = require('./config/customerTag');

// Export app untuk testing
module.exports = app;

