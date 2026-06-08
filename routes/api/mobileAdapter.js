/**
 * Mobile app (Flutter) — adapter API untuk teknisi/kolektor.
 * Auth: JWT sama seperti /api/auth/login (Bearer).
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { verifyToken, normalizePhone } = require('./auth');
const logger = require('../../config/logger');
const { getSetting, getLocalTimestamp } = require('../../config/settingsManager');
require('../../config/technicianFieldNotifications');
require('../../config/collectorFieldNotifications');

const dbPath = path.join(__dirname, '../../data/billing.db');
const db = new sqlite3.Database(dbPath);

/** Tabel tugas teknisi (PSB + gangguan) — DB fresh sering belum punya karena hanya ada di script terpisah. */
function ensureFieldOpsTables() {
    const tableDdl = [
        `CREATE TABLE IF NOT EXISTS installation_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_number VARCHAR(50) UNIQUE,
            customer_name VARCHAR(255) NOT NULL,
            customer_phone VARCHAR(20),
            customer_address TEXT,
            customer_id INTEGER,
            package_id INTEGER,
            installation_date DATE,
            installation_time VARCHAR(20),
            assigned_technician_id INTEGER,
            status VARCHAR(50) DEFAULT 'scheduled',
            priority VARCHAR(20) DEFAULT 'normal',
            notes TEXT,
            equipment_needed TEXT,
            estimated_duration INTEGER DEFAULT 120,
            created_by_admin_id INTEGER,
            completed_at DATETIME,
            completion_notes TEXT,
            customer_latitude DECIMAL(10, 8),
            customer_longitude DECIMAL(11, 8),
            assigned_at DATETIME,
            work_started_at DATETIME,
            work_duration_seconds INTEGER,
            tech_completion_latitude REAL,
            tech_completion_longitude REAL,
            install_cable_length_m REAL,
            install_ont_sticker_photo_path TEXT,
            created_at DATETIME DEFAULT (datetime('now','localtime')),
            updated_at DATETIME DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (package_id) REFERENCES packages(id),
            FOREIGN KEY (assigned_technician_id) REFERENCES technicians(id)
        )`,
        `CREATE TABLE IF NOT EXISTS installation_job_status_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL,
            old_status VARCHAR(50),
            new_status VARCHAR(50) NOT NULL,
            changed_by_type VARCHAR(20) NOT NULL,
            changed_by_id INTEGER NOT NULL,
            notes TEXT,
            created_at DATETIME DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (job_id) REFERENCES installation_jobs(id)
        )`,
        `CREATE TABLE IF NOT EXISTS trouble_reports (
            id TEXT PRIMARY KEY,
            status TEXT DEFAULT 'open',
            created_at DATETIME DEFAULT (datetime('now','localtime')),
            updated_at DATETIME DEFAULT (datetime('now','localtime')),
            name TEXT,
            phone TEXT,
            location TEXT,
            category TEXT,
            description TEXT,
            assigned_technician_id INTEGER,
            priority TEXT DEFAULT 'Normal',
            notes TEXT,
            customer_id INTEGER,
            work_started_at DATETIME,
            work_duration_seconds INTEGER
        )`
    ];
    const indexDdl = [
        'CREATE INDEX IF NOT EXISTS idx_installation_jobs_status ON installation_jobs(status)',
        'CREATE INDEX IF NOT EXISTS idx_installation_jobs_technician ON installation_jobs(assigned_technician_id)',
        'CREATE INDEX IF NOT EXISTS idx_trouble_reports_technician ON trouble_reports(assigned_technician_id)',
        'CREATE INDEX IF NOT EXISTS idx_trouble_reports_status ON trouble_reports(status)'
    ];
    db.serialize(() => {
        for (const sql of tableDdl) {
            db.run(sql, (err) => {
                if (err) logger.warn('[mobile-adapter] ensureFieldOpsTables table:', err.message);
            });
        }
        for (const sql of indexDdl) {
            db.run(sql, (err) => {
                if (err) logger.warn('[mobile-adapter] ensureFieldOpsTables index:', err.message);
            });
        }
    });
}
ensureFieldOpsTables();

const MIKROTIK_NETWORK_MAP_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
        })
    ]);
}

const CableNetworkUtils = require('../../utils/cableNetworkUtils');
const billingManager = require('../../config/billing');
const { getTenantId, hasTenantContext } = require('../../config/platform/tenantContext');
const { submitCollectorPayment, collectorPaymentMulter } = require('../../utils/collectorPaymentSubmit');

db.run('ALTER TABLE customers ADD COLUMN customer_id TEXT', (err) => {
    if (err && !/duplicate column/i.test(String(err.message))) {
        logger.warn('[mobile-adapter] customers.customer_id:', err.message);
    }
});
db.run(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_customer_id ON customers(customer_id)',
    (err) => {
        if (err) logger.warn('[mobile-adapter] idx_customers_customer_id:', err.message);
    }
);

function requireCollector(req, res, next) {
    if (!req.user || String(req.user.role) !== 'collector') {
        return res.status(403).json({ success: false, message: 'Hanya kolektor' });
    }
    next();
}

function parseCollectorId(req) {
    const u = req.user || {};
    const raw =
        u.id != null && u.id !== ''
            ? u.id
            : u.sub != null && u.sub !== ''
                ? u.sub
                : u.user_id != null && u.user_id !== ''
                    ? u.user_id
                    : u.userId;
    const id = parseInt(String(raw), 10);
    return Number.isFinite(id) && id > 0 ? id : null;
}

/** ID numerik teknisi dari JWT (id / sub / user_id) — hindari NaN bila token pakai string non-angka. */
function parseTechnicianId(req) {
    return parseCollectorId(req);
}

/** SQLite3 kadang mengembalikan BIGINT; JSON.stringify gagal → klien Flutter error. */
function sqliteJsonSafeRow(row) {
    if (!row || typeof row !== 'object') return row;
    const out = {};
    for (const [k, v] of Object.entries(row)) {
        out[k] = typeof v === 'bigint' ? Number(v) : v;
    }
    return out;
}

function resolveCustomerAreaLabel(c) {
    if (!c) return '';
    const direct = c.area != null ? String(c.area).trim() : '';
    if (direct) return direct;
    const joined = c.nama_area != null ? String(c.nama_area).trim() : '';
    if (joined) return joined;
    return '';
}

/** Baris pelanggan untuk pencarian tag lokasi (teknisi / field ops). */
function mapTagSearchCustomerRow(r) {
    const safe = sqliteJsonSafeRow(r || {});
    return {
        id: safe.id,
        customer_id:
            safe.customer_id != null && String(safe.customer_id).trim() !== ''
                ? String(safe.customer_id)
                : null,
        name: safe.name || '',
        phone: safe.phone || '',
        email: safe.email || '',
        status: safe.status,
        address: safe.address || '',
        area: resolveCustomerAreaLabel(safe),
        area_id:
            safe.area_id != null && safe.area_id !== '' && !Number.isNaN(Number(safe.area_id))
                ? Number(safe.area_id)
                : null
    };
}

/** Isi nama area dari tabel master `areas` bila kolom teks pelanggan kosong. */
function attachAreaNamesFromMaster(customers, cb) {
    const list = Array.isArray(customers) ? customers.map((c) => ({ ...c })) : [];
    const ids = [
        ...new Set(
            list
                .map((c) => {
                    if (resolveCustomerAreaLabel(c)) return null;
                    const aid = c.area_id != null ? Number(c.area_id) : NaN;
                    return Number.isFinite(aid) && aid > 0 ? aid : null;
                })
                .filter(Boolean)
        )
    ];
    if (!ids.length) {
        return cb(null, list);
    }
    const placeholders = ids.map(() => '?').join(',');
    db.all(
        `SELECT id, nama_area FROM areas WHERE id IN (${placeholders})`,
        ids,
        (err, rows) => {
            if (err) return cb(err);
            const byId = new Map(
                (rows || []).map((r) => [Number(r.id), String(r.nama_area || '').trim()])
            );
            for (const c of list) {
                const existing = resolveCustomerAreaLabel(c);
                if (existing) {
                    c.area = existing;
                    continue;
                }
                const aid = c.area_id != null ? Number(c.area_id) : NaN;
                c.area = Number.isFinite(aid) ? byId.get(aid) || '' : '';
            }
            cb(null, list);
        }
    );
}

function collectorCustomerIsIsolir(c) {
    return String(c.status || '')
        .toLowerCase()
        .trim() === 'suspended';
}

/**
 * Sama dengan filter "Belum Lunas" di admin getCustomersPaginated (mode default, tanpa filter bulan):
 * ada invoice unpaid ATAU belum pernah ada invoice paid.
 */
function matchesAdminBelumLunasFromPaymentStatus(c) {
    const ps = c.payment_status || '';
    return ps === 'unpaid' || ps === 'overdue' || ps === 'no_invoice';
}

/** Sama dengan filter "Lunas" di admin: tidak ada unpaid & pernah paid (direfleksikan di CASE SQL sebagai 'paid'). */
function matchesAdminLunasFromPaymentStatus(c) {
    return (c.payment_status || '') === 'paid';
}

/** Join date jatuh di bulan kalender berjalan (sesuai filter "baru" admin / pelanggan baru bulan ini). */
function joinDateThisCalendarMonth(c) {
    if (!c.join_date) return false;
    const jd = String(c.join_date).slice(0, 10);
    const now = new Date();
    const y = now.getFullYear();
    const mo = now.getMonth();
    const pad = (n) => String(n).padStart(2, '0');
    const startStr = `${y}-${pad(mo + 1)}-01`;
    const lastD = new Date(y, mo + 1, 0).getDate();
    const endStr = `${y}-${pad(mo + 1)}-${pad(lastD)}`;
    return jd >= startStr && jd <= endStr;
}

/**
 * Filter daftar kolektor: pool = area + assignment kolektor (getCollectorCustomers).
 * Semua = seluruh pelanggan di pool (seperti admin /customers, dibatasi area tim).
 * unpaid = Belum Lunas admin; paid = Lunas admin; baru = belum punya invoice (no_invoice).
 */
function filterCollectorCustomersForMobile(allMappedCustomers, statusFilter, q, areaFilter) {
    const validFilters = new Set(['paid', 'unpaid', 'overdue', 'no_invoice', 'isolir', 'baru']);
    const sf = (statusFilter || '').toString().toLowerCase();
    const qLower = (q || '').toString().trim().toLowerCase();
    const areaLow = (areaFilter || '').toString().trim().toLowerCase();
    let customers = allMappedCustomers || [];

    if (sf === 'isolir') {
        customers = customers.filter((c) => collectorCustomerIsIsolir(c));
    } else if (sf === 'baru') {
        customers = customers.filter((c) => (c.payment_status || '') === 'no_invoice');
    } else if (sf === 'unpaid') {
        customers = customers.filter((c) => matchesAdminBelumLunasFromPaymentStatus(c));
    } else if (sf === 'paid') {
        customers = customers.filter((c) => matchesAdminLunasFromPaymentStatus(c));
    } else if (validFilters.has(sf) && sf !== '') {
        customers = customers.filter((c) => (c.payment_status || '') === sf);
    }
    // sf === '' (Semua): tidak filter status / pembayaran

    if (qLower) {
        customers = customers.filter((c) => {
            const name = (c.name || '').toLowerCase();
            const idStr = String(c.id || '');
            const phone = (c.phone || '').toLowerCase();
            const ppp = (c.pppoe_username || '').toString().toLowerCase();
            const user = (c.username || '').toString().toLowerCase();
            return (
                name.includes(qLower) ||
                idStr.includes(qLower) ||
                phone.includes(qLower) ||
                ppp.includes(qLower) ||
                user.includes(qLower)
            );
        });
    }

    if (areaLow) {
        customers = customers.filter((c) => {
            const t = (c.area || '').toString().trim().toLowerCase();
            if (t && t === areaLow) return true;
            const aid = c.area_id != null ? Number(c.area_id) : NaN;
            const wantId = Number(areaFilter);
            if (Number.isFinite(wantId) && Number.isFinite(aid) && aid === wantId) return true;
            return false;
        });
    }
    return customers;
}

/** Angka aman untuk JSON (hindari BigInt / nilai aneh dari SQLite). */
function toFiniteNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/** Statistik dashboard kolektor — hanya angka, aman untuk res.json. */
function sanitizeCollectorDashboardStats(stats) {
    if (!stats || typeof stats !== 'object') {
        return {
            tagihan: { count: 0, total: 0 },
            tagihanLunas: { count: 0, total: 0 },
            lunas: { count: 0, total: 0 },
            belumLunas: { count: 0, total: 0 },
            hariIni: { count: 0, total: 0 },
            setoran: { sudah_setor: 0, belum_setor: 0 }
        };
    }
    const pair = (k) => ({
        count: toFiniteNumber(stats[k] && stats[k].count),
        total: toFiniteNumber(stats[k] && stats[k].total)
    });
    return {
        tagihan: pair('tagihan'),
        tagihanLunas: pair('tagihanLunas'),
        lunas: pair('lunas'),
        belumLunas: pair('belumLunas'),
        hariIni: pair('hariIni'),
        setoran: {
            sudah_setor: toFiniteNumber(stats.setoran && stats.setoran.sudah_setor),
            belum_setor: toFiniteNumber(stats.setoran && stats.setoran.belum_setor)
        }
    };
}

/** Baris kolektor untuk API publik (tanpa password). */
function sanitizeCollectorRow(row) {
    if (!row || typeof row !== 'object') return null;
    const out = { ...row };
    if (out.password !== undefined) delete out.password;
    if (out.password_hash !== undefined) delete out.password_hash;
    return out;
}

/** Satu baris pembayaran kolektor — BigInt → number. */
function sanitizeCollectorPaymentRow(p) {
    if (!p || typeof p !== 'object') return p;
    const out = {};
    for (const k of Object.keys(p)) {
        let v = p[k];
        if (typeof v === 'bigint') v = Number(v);
        out[k] = v;
    }
    return out;
}

// Kolom untuk timer tugas perbaikan (idempotent)
db.run(
    'ALTER TABLE trouble_reports ADD COLUMN work_started_at DATETIME',
    (err) => {
        if (err && !/duplicate column/i.test(String(err.message))) {
            logger.warn('[mobile-adapter] trouble_reports.work_started_at:', err.message);
        }
    }
);
db.run(
    'ALTER TABLE trouble_reports ADD COLUMN work_duration_seconds INTEGER',
    (err) => {
        if (err && !/duplicate column/i.test(String(err.message))) {
            logger.warn('[mobile-adapter] trouble_reports.work_duration_seconds:', err.message);
        }
    }
);
db.run('ALTER TABLE trouble_reports ADD COLUMN customer_id INTEGER', (err) => {
    if (err && !/duplicate column/i.test(String(err.message))) {
        logger.warn('[mobile-adapter] trouble_reports.customer_id:', err.message);
    }
    if (!err || /duplicate column/i.test(String(err.message))) {
        // Tiket lama: isi customer_id dari nama pelanggan yang sama (bantu app Gangguan / dashboard).
        db.run(
            `UPDATE trouble_reports SET customer_id = (
                SELECT c.id FROM customers c
                WHERE LOWER(TRIM(c.name)) = LOWER(TRIM(trouble_reports.name))
                  AND LENGTH(TRIM(trouble_reports.name)) >= 3
                ORDER BY c.id DESC LIMIT 1
            )
            WHERE (customer_id IS NULL OR customer_id = 0)
              AND name IS NOT NULL AND TRIM(name) != ''`,
            (e2) => {
                if (e2 && !/no such column/i.test(String(e2.message))) {
                    logger.warn('[mobile-adapter] trouble_reports customer_id backfill (name):', e2.message);
                }
            }
        );
    }
});

const installJobAlterSql = [
    'ALTER TABLE installation_jobs ADD COLUMN work_started_at DATETIME',
    'ALTER TABLE installation_jobs ADD COLUMN work_duration_seconds INTEGER',
    'ALTER TABLE installation_jobs ADD COLUMN tech_completion_latitude REAL',
    'ALTER TABLE installation_jobs ADD COLUMN tech_completion_longitude REAL',
    'ALTER TABLE installation_jobs ADD COLUMN install_cable_length_m REAL',
    'ALTER TABLE installation_jobs ADD COLUMN install_ont_sticker_photo_path TEXT'
];
for (const sql of installJobAlterSql) {
    db.run(sql, (err) => {
        if (err && !/duplicate column/i.test(String(err.message))) {
            logger.warn('[mobile-adapter] installation_jobs schema:', err.message);
        }
    });
}

/** Durasi dari app mobile (detik), dibatasi agar masuk akal */
function clampWorkDurationSeconds(raw) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return null;
    const maxSec = 168 * 3600; // 7 hari
    return Math.min(n, maxSec);
}

function parseCompletionLatLng(body) {
    if (!body || typeof body !== 'object') return { lat: null, lng: null };
    const lat = parseFloat(
        body.completion_latitude ?? body.latitude ?? body.tag_latitude ?? body.tag_lat
    );
    const lng = parseFloat(
        body.completion_longitude ?? body.longitude ?? body.tag_longitude ?? body.tag_lng
    );
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { lat: null, lng: null };
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return { lat: null, lng: null };
    return { lat, lng };
}

/**
 * Job instalasi yang boleh dilihat/diubah teknisi: ditugaskan kepadanya atau belum ada teknisi (pool umum).
 * Param query: [techId, String(techId)] — sama pola dengan tiket gangguan tanpa penugasan.
 */
function sqlInstallationJobAccessibleByTech(alias = 'ij') {
    const a = alias;
    return `(
        ${a}.assigned_technician_id = ?
        OR CAST(${a}.assigned_technician_id AS TEXT) = ?
        OR IFNULL(TRIM(CAST(${a}.assigned_technician_id AS TEXT)), '') IN ('', '0')
    )`;
}

/** Samakan normalisasi nomor dengan query daftar tugas INSTALL */
function resolveCustomerIdFromInstallationJob(jobRow) {
    return new Promise((resolve) => {
        if (!jobRow) {
            resolve(null);
            return;
        }
        const fromCol = jobRow.customer_id != null ? parseInt(jobRow.customer_id, 10) : NaN;
        if (Number.isFinite(fromCol) && fromCol > 0) {
            resolve(fromCol);
            return;
        }
        const rawPhone = (jobRow.customer_phone || '').trim();
        if (!rawPhone) {
            resolve(null);
            return;
        }
        db.get(
            `SELECT id FROM customers
             WHERE REPLACE(REPLACE(REPLACE(LOWER(TRIM(phone)), ' ', ''), '-', ''), '+', '') =
                   REPLACE(REPLACE(REPLACE(LOWER(TRIM(?)), ' ', ''), '-', ''), '+', '')
             ORDER BY id DESC LIMIT 1`,
            [rawPhone],
            (err, row) => {
                if (err) {
                    logger.warn('[mobile-adapter] resolve customer_id job PSB:', err.message);
                    resolve(null);
                    return;
                }
                resolve(row && row.id != null ? parseInt(row.id, 10) : null);
            }
        );
    });
}

function updateCustomerTagLocation(customerId, lat, lng) {
    return new Promise((resolve) => {
        if (!customerId || !Number.isFinite(lat) || !Number.isFinite(lng)) {
            resolve();
            return;
        }
        db.run(
            'UPDATE customers SET latitude = ?, longitude = ? WHERE id = ?',
            [lat, lng, customerId],
            (ce) => {
                if (ce) {
                    logger.warn('[mobile-adapter] update pelanggan tag lokasi:', ce.message);
                }
                resolve();
            }
        );
    });
}

function backfillInstallationJobCustomerId(jobId, customerId) {
    return new Promise((resolve) => {
        if (!jobId || !customerId) {
            resolve();
            return;
        }
        db.run(
            `UPDATE installation_jobs SET customer_id = ?
             WHERE id = ? AND (customer_id IS NULL OR customer_id = 0)`,
            [customerId, jobId],
            () => resolve()
        );
    });
}

const { resolveEmployeePhotoPath, buildPhotoUrl } = require('../../utils/technicianEmployeePhoto');

/** Tanpa auth — untuk cek deploy / reverse proxy (GET …/health) */
router.get('/health', (req, res) => {
    res.json({ success: true, service: 'mobile-adapter', time: new Date().toISOString() });
});

/**
 * Pembaruan aplikasi Flutter (tanpa JWT): manifest dari file atau settings.json.
 * File: public/mobile-app/manifest.json (lihat manifest.example.json).
 * Settings (opsional): mobile_app_version, mobile_app_build, mobile_app_apk_url, mobile_app_release_notes
 */
router.get('/app-update/manifest', (req, res) => {
    const empty = () =>
        res.json({
            success: true,
            source: 'none',
            data: {
                configured: false,
                version: null,
                build_number: null,
                apk_url: null,
                release_notes: null
            }
        });

    function normalizeManifest(parsed) {
        if (!parsed || typeof parsed !== 'object') return null;
        const version = parsed.version != null ? String(parsed.version).trim() : '';
        const bnRaw = parsed.build_number != null ? parseInt(String(parsed.build_number), 10) : NaN;
        const build_number = Number.isFinite(bnRaw) && bnRaw >= 0 ? bnRaw : null;
        const apk_url = parsed.apk_url != null ? String(parsed.apk_url).trim() : '';
        const release_notes = parsed.release_notes != null ? String(parsed.release_notes).trim() : '';
        const forceRaw = parsed.force_update;
        const force_update =
            forceRaw === true ||
            forceRaw === 1 ||
            forceRaw === '1' ||
            String(forceRaw).toLowerCase() === 'true';
        if (!version || !apk_url) return null;
        return {
            configured: true,
            version,
            build_number,
            apk_url,
            release_notes: release_notes || 'Pembaruan aplikasi mobile.',
            force_update
        };
    }

    let parsed = null;
    const manifestPath = path.join(__dirname, '../../public/mobile-app/manifest.json');
    try {
        if (fs.existsSync(manifestPath)) {
            parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        }
    } catch (e) {
        logger.warn('[mobile-adapter] app-update manifest.json:', e.message);
    }

    let data = normalizeManifest(parsed);
    if (!data) {
        const fromSettings = {
            version: String(getSetting('mobile_app_version', '') || '').trim(),
            build_number: getSetting('mobile_app_build', ''),
            apk_url: String(getSetting('mobile_app_apk_url', '') || '').trim(),
            release_notes: String(getSetting('mobile_app_release_notes', '') || '').trim()
        };
        data = normalizeManifest(fromSettings);
    }

    if (!data) {
        return empty();
    }

    res.json({ success: true, source: 'server', data });
});

function allowFieldOps(req, res, next) {
    const role = req.user && req.user.role;
    if (!['technician', 'collector', 'admin'].includes(role)) {
        return res.status(403).json({ success: false, message: 'Akses ditolak' });
    }
    next();
}

function requireTechnician(req, res, next) {
    const role = req.user && req.user.role;
    if (role !== 'technician' && role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Hanya teknisi' });
    }
    next();
}

function phoneVariantsForEmployeeLookup(rawPhone) {
    const norm = normalizePhone(rawPhone || '');
    const v = new Set();
    const raw = rawPhone != null ? String(rawPhone).trim() : '';
    if (raw) v.add(raw);
    if (norm) {
        v.add(norm);
        v.add(`+${norm}`);
        if (norm.startsWith('62') && norm.length > 2) {
            v.add(`0${norm.slice(2)}`);
        }
    }
    return [...v].filter(Boolean);
}

function jakartaAttendanceTodayYmd() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

function extractTimePart(value) {
    if (value == null) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const m = raw.match(/(\d{2}):(\d{2})(?::\d{2})?$/);
    if (!m) return null;
    return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

function calculateLateMinutes(actualTs, shiftCheckInTime) {
    const actual = extractTimePart(actualTs);
    const shift = extractTimePart(shiftCheckInTime);
    if (!actual || !shift) return 0;
    const actualMinutes = (actual.hour * 60) + actual.minute;
    const shiftMinutes = (shift.hour * 60) + shift.minute;
    return Math.max(0, actualMinutes - shiftMinutes);
}

/** Grace setelah jam pulang shift sebelum absen pulang otomatis. */
const AUTO_CHECKOUT_GRACE_MINUTES = 10;

function shiftEndEpochMsForAutoCheckout(attendanceDateYmd, shiftCheckOutTime, checkInTs) {
    const out = extractTimePart(shiftCheckOutTime);
    if (!out) return NaN;
    const ymd = attendanceDateYmd || jakartaAttendanceTodayYmd();
    const iso = `${ymd}T${String(out.hour).padStart(2, '0')}:${String(out.minute).padStart(2, '0')}:00+07:00`;
    let endMs = Date.parse(iso);
    if (!Number.isFinite(endMs)) return NaN;
    const inPart = extractTimePart(checkInTs);
    const outMin = out.hour * 60 + out.minute;
    if (inPart) {
        const inMin = inPart.hour * 60 + inPart.minute;
        if (outMin <= inMin) {
            endMs += 24 * 60 * 60 * 1000;
        }
    }
    return endMs;
}

function shouldAutoCheckOutNow(row, shiftCheckOutTime, graceMinutes = AUTO_CHECKOUT_GRACE_MINUTES) {
    if (!row || !row.check_in || row.check_out) return false;
    const endMs = shiftEndEpochMsForAutoCheckout(row.date, shiftCheckOutTime, row.check_in);
    if (!Number.isFinite(endMs)) return false;
    return Date.now() >= endMs + graceMinutes * 60 * 1000;
}

function performAutoCheckOut(attendanceId, existingNotes, cb) {
    const ts = getLocalTimestamp();
    const tag = '[AUTO_CHECKOUT] Pulang otomatis (lewat jam shift +10 menit)';
    const notes = existingNotes ? `${String(existingNotes)} | ${tag}` : tag;
    db.run(
        `UPDATE employee_attendance SET check_out = ?, notes = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
        [ts, notes, attendanceId],
        (err) => cb(err, ts)
    );
}

function formatShiftTimeLabel(timeValue) {
    const t = extractTimePart(timeValue);
    if (!t) return '';
    return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function parseAttendanceBranchQrPayload(rawQr) {
    if (!rawQr) return null;
    try {
        const parsed = JSON.parse(String(rawQr));
        if (!parsed || parsed.type !== 'attendance_branch') return null;
        const out = {};
        if (parsed.id != null) {
            const id = parseInt(parsed.id, 10);
            if (Number.isFinite(id) && id > 0) out.id = id;
        }
        if (parsed.latitude != null) {
            const latitude = Number(parsed.latitude);
            if (Number.isFinite(latitude)) out.latitude = latitude;
        }
        if (parsed.longitude != null) {
            const longitude = Number(parsed.longitude);
            if (Number.isFinite(longitude)) out.longitude = longitude;
        }
        if (parsed.branch_name != null) out.branch_name = String(parsed.branch_name);
        return Object.keys(out).length ? out : null;
    } catch (_) {
        return null;
    }
}

function toDhmsFromSeconds(rawSeconds) {
    const secs = Number(rawSeconds);
    if (!Number.isFinite(secs) || secs < 0) return null;
    const total = Math.floor(secs);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function mapInstallPriority(p) {
    const u = String(p || 'normal').toLowerCase();
    if (u === 'urgent' || u === 'high') return 'HIGH';
    if (u === 'normal') return 'NORMAL';
    return 'MEDIUM';
}

function mapDisplayStatusInstall(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'completed' || s === 'cancelled') return 'closed';
    return s || 'scheduled';
}

function mapDisplayStatusTrouble(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'resolved' || s === 'closed') return 'closed';
    if (s === 'in_progress') return 'in_progress';
    return s || 'open';
}

/** Kondisi SQL: baris customers (alias cu) ↔ trouble_reports (alias tr) adalah pelanggan yang sama. */
function sqlTroubleTicketCustomerMatch(cu, tr) {
    const digits = (expr) =>
        `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(${expr}, ''), ' ', ''), '-', ''), '+', ''), '(', ''), ')', '')`;
    return `(
        (NULLIF(${tr}.customer_id, 0) IS NOT NULL AND CAST(${cu}.id AS INTEGER) = CAST(${tr}.customer_id AS INTEGER))
        OR (
            NULLIF(TRIM(IFNULL(${cu}.phone, '')), '') IS NOT NULL
            AND NULLIF(TRIM(IFNULL(${tr}.phone, '')), '') IS NOT NULL
            AND LOWER(TRIM(IFNULL(${cu}.phone, ''))) = LOWER(TRIM(IFNULL(${tr}.phone, '')))
        )
        OR (
            NULLIF(TRIM(IFNULL(${cu}.phone, '')), '') IS NOT NULL
            AND NULLIF(TRIM(IFNULL(${tr}.phone, '')), '') IS NOT NULL
            AND REPLACE(REPLACE(REPLACE(LOWER(TRIM(IFNULL(${cu}.phone, ''))), ' ', ''), '-', ''), '+', '') =
                REPLACE(REPLACE(REPLACE(LOWER(TRIM(IFNULL(${tr}.phone, ''))), ' ', ''), '-', ''), '+', '')
        )
        OR (
            LENGTH(${digits(`${cu}.phone`)}) >= 10
            AND LENGTH(${digits(`${tr}.phone`)}) >= 10
            AND SUBSTR(${digits(`${cu}.phone`)}, -10) = SUBSTR(${digits(`${tr}.phone`)}, -10)
        )
        OR (
            LENGTH(TRIM(IFNULL(${tr}.name, ''))) >= 3
            AND LENGTH(TRIM(IFNULL(${cu}.name, ''))) >= 3
            AND LOWER(TRIM(IFNULL(${cu}.name, ''))) = LOWER(TRIM(IFNULL(${tr}.name, '')))
        )
    )`;
}

const {
    saveCompletionPhotoFromBase64: decodeAndSaveCompletionPhoto,
    saveStickerPhotoFromBase64: decodeAndSaveStickerPhoto
} = require('../../utils/fieldCompletionStorage');

// --- Customers (pagination) ---
router.get('/customers', verifyToken, allowFieldOps, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const search = (req.query.search && String(req.query.search).trim()) || '';
    const status = (req.query.status && String(req.query.status).trim()) || '';

    const params = [];
    let where = '1=1';
    if (hasTenantContext()) {
        where += ' AND c.tenant_id = ?';
        params.push(getTenantId());
    }
    if (status) {
        const role = req.user && req.user.role;
        const techId = role === 'technician' ? parseTechnicianId(req) : null;
        const isGangguanFilter = status.toLowerCase() === 'isolated';
        if (isGangguanFilter && role === 'technician' && techId) {
            // App "Gangguan" = status isolated + pelanggan yang punya tiket gangguan aktif ditugaskan ke teknisi ini
            const trMatch = sqlTroubleTicketCustomerMatch('cu', 'tr');
            where += ` AND (
                LOWER(c.status) = LOWER(?)
                OR c.id IN (
                    SELECT cu.id FROM customers cu
                    INNER JOIN trouble_reports tr ON ${trMatch}
                    WHERE (tr.assigned_technician_id = ? OR CAST(tr.assigned_technician_id AS TEXT) = ?)
                      AND LOWER(IFNULL(tr.status, '')) NOT IN ('closed', 'resolved')
                )
            )`;
            params.push(status, techId, String(techId));
        } else {
            where += ' AND LOWER(c.status) = LOWER(?)';
            params.push(status);
        }
    }
    if (search) {
        where +=
            ' AND (c.name LIKE ? OR c.phone LIKE ? OR CAST(c.customer_id AS TEXT) LIKE ? OR c.username LIKE ? OR IFNULL(c.email, \'\') LIKE ?)';
        const like = `%${search.replace(/%/g, '')}%`;
        params.push(like, like, like, like, like);
    }

    const sql = `
        SELECT c.id, c.customer_id, c.name, c.phone, c.email, c.status, c.address,
               c.area_id, c.latitude, c.longitude, c.pppoe_username,
               COALESCE(NULLIF(TRIM(c.area), ''), ar.nama_area, '') AS area,
               ar.nama_area AS nama_area,
               p.name AS profile
        FROM customers c
        LEFT JOIN packages p ON c.package_id = p.id
        LEFT JOIN areas ar ON c.area_id = ar.id
        WHERE ${where}
        ORDER BY c.id DESC
        LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    db.all(sql, params, (err, rows) => {
        if (err) {
            logger.error('[mobile-adapter] customers:', err);
            return res.status(500).json({ success: false, message: 'Gagal memuat pelanggan' });
        }
        attachAreaNamesFromMaster(rows || [], (areaErr, enriched) => {
            if (areaErr) {
                logger.error('[mobile-adapter] customers area:', areaErr);
                return res.status(500).json({ success: false, message: areaErr.message });
            }
            const list = (enriched || []).map((r) => {
                const safe = sqliteJsonSafeRow(r);
                return {
                    ...safe,
                    area: resolveCustomerAreaLabel(safe),
                    ip_address: safe.pppoe_username ? 'PPPoE' : 'DHCP/Dynamic'
                };
            });
            res.json({ success: true, data: list });
        });
    });
});

router.get('/customers/:customerId/ppp-session', verifyToken, requireTechnician, async (req, res) => {
    const customerId = parseInt(String(req.params.customerId), 10);
    if (!Number.isFinite(customerId) || customerId <= 0) {
        return res.status(400).json({ success: false, message: 'ID pelanggan tidak valid' });
    }
    try {
        const customer = await new Promise((resolve, reject) => {
            db.get(
                'SELECT id, pppoe_username, username FROM customers WHERE id = ?',
                [customerId],
                (err, row) => (err ? reject(err) : resolve(row || null))
            );
        });
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }
        const login =
            (customer.pppoe_username && String(customer.pppoe_username).trim()) ||
            (customer.username && String(customer.username).trim()) ||
            '';
        if (!login) {
            return res.json({
                success: true,
                data: {
                    online: false,
                    login_checked: '',
                    mac_address: null,
                    ip_address: null,
                    uptime: null
                }
            });
        }

        const {
            getUserAuthModeAsync,
            getActivePPPoEConnectionsRadius,
            collectMikrotikPppActiveSessionsByLoginMap,
            getMikrotikConnectionForRouter,
            getMikrotikConnection
        } = require('../../config/mikrotik');
        const authMode = await getUserAuthModeAsync();

        let session = null;
        let mikrotikSession = null;
        const findMikrotikSessionByLogin = async (pppoeLogin) => {
            const routers = await new Promise((resolve, reject) => {
                db.all('SELECT * FROM routers ORDER BY id ASC', [], (err, rows) =>
                    err ? reject(err) : resolve(rows || [])
                );
            });
            for (const r of (Array.isArray(routers) ? routers : [])) {
                try {
                    const conn = await getMikrotikConnectionForRouter(r);
                    const rows = await conn.write('/ppp/active/print', [`?name=${pppoeLogin}`]);
                    if (Array.isArray(rows) && rows.length > 0) {
                        return rows[0];
                    }
                } catch (_) {}
            }
            try {
                const conn = await getMikrotikConnection();
                if (!conn) return null;
                const rows = await conn.write('/ppp/active/print', [`?name=${pppoeLogin}`]);
                if (Array.isArray(rows) && rows.length > 0) {
                    return rows[0];
                }
            } catch (_) {}
            return null;
        };

        if (authMode === 'radius') {
            const mikrotikByLogin = await collectMikrotikPppActiveSessionsByLoginMap();
            mikrotikSession = mikrotikByLogin.get(login) || null;
            session = mikrotikSession;
            if (!session) {
                const active = await getActivePPPoEConnectionsRadius();
                if (Array.isArray(active)) {
                    session = active.find((a) => String(a.name || '').trim() === login) || null;
                }
            }
        } else {
            session = await findMikrotikSessionByLogin(login);
            mikrotikSession = session;
        }

        const source = mikrotikSession || session;
        const macAddress = source
            ? (
                source['caller-id'] ||
                source.caller_id ||
                source.callerid ||
                source['mac-address'] ||
                source.mac_address ||
                source.mac ||
                null
            )
            : null;
        const ipAddress = source
            ? (
                source.address ||
                source.ip ||
                source.framedipaddress ||
                null
            )
            : null;
        const rawUptime = source
            ? (
                source.uptime ||
                source.session_time ||
                null
            )
            : null;
        const uptime =
            typeof rawUptime === 'number' || /^\d+$/.test(String(rawUptime || ''))
                ? (toDhmsFromSeconds(rawUptime) || String(rawUptime))
                : (rawUptime || null);

        return res.json({
            success: true,
            data: {
                online: Boolean(session || mikrotikSession),
                auth_mode: authMode || 'unknown',
                login_checked: login,
                mac_address: macAddress,
                ip_address: ipAddress,
                uptime: uptime
            }
        });
    } catch (error) {
        logger.error('[mobile-adapter] customers/:id/ppp-session', error);
        return res.status(500).json({ success: false, message: error.message || 'Gagal memuat sesi PPPoE' });
    }
});

router.get('/customers/search', verifyToken, allowFieldOps, (req, res) => {
    const q = (req.query.q && String(req.query.q).trim()) || '';
    if (q.length < 1) {
        return res.json({ success: true, data: [] });
    }
    const like = `%${q.replace(/%/g, '')}%`;
    const searchParams = [like, like, like, like, like, like, like];
    let searchWhere = `c.name LIKE ? OR c.phone LIKE ? OR CAST(c.customer_id AS TEXT) LIKE ? OR IFNULL(c.email, '') LIKE ?
            OR IFNULL(c.area, '') LIKE ? OR IFNULL(ar.nama_area, '') LIKE ? OR IFNULL(ar.kode_area, '') LIKE ?`;
    if (hasTenantContext()) {
        searchWhere = `c.tenant_id = ? AND (${searchWhere})`;
        searchParams.unshift(getTenantId());
    }
    db.all(
        `SELECT c.id, c.customer_id, c.name, c.phone, c.email, c.status, c.address, c.area_id,
                COALESCE(NULLIF(TRIM(c.area), ''), ar.nama_area, ar.kode_area, '') AS area,
                ar.nama_area AS nama_area
         FROM customers c
         LEFT JOIN areas ar ON c.area_id = ar.id
         WHERE ${searchWhere}
         ORDER BY c.name
         LIMIT 30`,
        searchParams,
        (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, message: err.message });
            }
            attachAreaNamesFromMaster(rows || [], (areaErr, enriched) => {
                if (areaErr) {
                    return res.status(500).json({ success: false, message: areaErr.message });
                }
                const data = (enriched || []).map(mapTagSearchCustomerRow);
                res.json({ success: true, data });
            });
        }
    );
});

/** Batch resolve nama area pelanggan (fallback tag pelanggan teknisi). */
router.post('/customers/resolve-areas', verifyToken, allowFieldOps, (req, res) => {
    const rawIds = req.body && req.body.ids;
    const ids = (Array.isArray(rawIds) ? rawIds : [])
        .map((v) => parseInt(String(v), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(0, 50);
    if (!ids.length) {
        return res.json({ success: true, data: {} });
    }
    const placeholders = ids.map(() => '?').join(',');
    db.all(
        `SELECT c.id, c.area_id,
                COALESCE(NULLIF(TRIM(c.area), ''), ar.nama_area, '') AS area
         FROM customers c
         LEFT JOIN areas ar ON c.area_id = ar.id
         WHERE c.id IN (${placeholders})`,
        ids,
        (err, rows) => {
            if (err) {
                logger.error('[mobile-adapter] customers/resolve-areas', err);
                return res.status(500).json({ success: false, message: err.message });
            }
            attachAreaNamesFromMaster(rows || [], (areaErr, enriched) => {
                if (areaErr) {
                    return res.status(500).json({ success: false, message: areaErr.message });
                }
                const data = {};
                for (const row of enriched || []) {
                    const id = row.id != null ? Number(row.id) : NaN;
                    if (!Number.isFinite(id)) continue;
                    data[String(id)] = resolveCustomerAreaLabel(row);
                }
                res.json({ success: true, data });
            });
        }
    );
});

/** Daftar nama area (teknisi / field ops) — untuk label pencarian tag pelanggan. */
router.get('/areas/names', verifyToken, allowFieldOps, (req, res) => {
    db.all(
        `SELECT id, nama_area FROM areas
         WHERE nama_area IS NOT NULL AND TRIM(nama_area) != ''
         ORDER BY nama_area ASC`,
        [],
        (err, rows) => {
            if (err) {
                logger.error('[mobile-adapter] areas/names', err);
                return res.status(500).json({ success: false, message: err.message });
            }
            const data = (rows || []).map((r) => ({
                id: Number(r.id),
                nama_area: String(r.nama_area || '').trim(),
            }));
            res.json({ success: true, data });
        }
    );
});

router.put('/customers/:customerId/location', verifyToken, allowFieldOps, (req, res) => {
    const id = parseInt(req.params.customerId, 10);
    const body = req.body || {};
    const { latitude, longitude } = body;
    const odpRaw = body.odp_id != null ? body.odp_id : body.odpId;
    if (!Number.isFinite(id) || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ success: false, message: 'Data tidak valid' });
    }
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ success: false, message: 'Koordinat tidak valid' });
    }

    const runLocationUpdate = (odpIntId) => {
        if (odpIntId != null && Number.isFinite(odpIntId) && odpIntId > 0) {
            db.run(
                'UPDATE customers SET latitude = ?, longitude = ?, odp_id = ? WHERE id = ?',
                [lat, lng, odpIntId, id],
                function (err) {
                    if (err) {
                        return res.status(500).json({ success: false, message: err.message });
                    }
                    if (this.changes === 0) {
                        return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
                    }
                    return res.json({ success: true, message: 'Lokasi dan ODP pelanggan diperbarui' });
                }
            );
            return;
        }
        db.run(
            'UPDATE customers SET latitude = ?, longitude = ? WHERE id = ?',
            [lat, lng, id],
            function (err) {
                if (err) {
                    return res.status(500).json({ success: false, message: err.message });
                }
                if (this.changes === 0) {
                    return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
                }
                res.json({ success: true, message: 'Lokasi diperbarui' });
            }
        );
    };

    if (odpRaw === undefined || odpRaw === null || String(odpRaw).trim() === '') {
        return runLocationUpdate(null);
    }

    const odpKey = String(odpRaw).trim();
    db.get(
        'SELECT id FROM odps WHERE id = ? OR code = ? OR name = ? LIMIT 1',
        [odpKey, odpKey, odpKey],
        (eOdp, odpRow) => {
            if (eOdp) {
                return res.status(500).json({ success: false, message: eOdp.message });
            }
            if (!odpRow) {
                return res.status(400).json({ success: false, message: 'ODP tidak ditemukan' });
            }
            runLocationUpdate(odpRow.id);
        }
    );
});

// --- Profil teknisi (sinkron dengan data web / tabel technicians) ---
router.get('/me', verifyToken, requireTechnician, (req, res) => {
    const techId = parseTechnicianId(req);
    if (!techId) {
        return res.status(400).json({ success: false, message: 'ID teknisi tidak valid' });
    }
    db.get('SELECT * FROM technicians WHERE id = ? AND is_active = 1', [techId], (err, row) => {
        if (err) {
            logger.error('[mobile-adapter] /me', err);
            return res.status(500).json({ success: false, message: err.message });
        }
        if (!row) {
            return res.status(404).json({ success: false, message: 'Profil teknisi tidak ditemukan' });
        }
        if (row.password) delete row.password;
        const variants = phoneVariantsForEmployeeLookup(req.user.phone || req.user.username || row.phone || '');
        const ph = variants.map(() => '?').join(',');
        const employeeQuery = variants.length
            ? `SELECT * FROM employees WHERE (status IS NULL OR LOWER(TRIM(status)) = 'aktif') AND TRIM(no_hp) IN (${ph}) LIMIT 1`
            : null;

        const finalize = (employeeRow) => {
            resolveEmployeePhotoPath(db, row, (ePh, relPath) => {
                if (ePh) {
                    logger.warn('[mobile-adapter] /me foto karyawan:', ePh.message);
                }
                const employeeEmail = employeeRow
                    ? (employeeRow.email || employeeRow.email_karyawan || employeeRow.mail || null)
                    : null;
                const employeeAddress = employeeRow
                    ? (employeeRow.address || employeeRow.alamat || employeeRow.address_detail || '')
                    : '';
                const data = {
                    id: row.id,
                    name: row.name,
                    role: 'technician',
                    position: row.role || 'technician',
                    phone: row.phone,
                    email: employeeEmail || row.email || null,
                    address: employeeAddress || row.notes || '',
                    area_coverage: row.area_coverage || '',
                    notes: row.notes || '',
                    whatsapp_group_id: row.whatsapp_group_id || null,
                    join_date: row.join_date || null,
                    last_login: row.last_login || null,
                    created_at: row.created_at || null,
                    support_whatsapp: getSetting('contact_whatsapp', '') || ''
                };
                if (relPath) {
                    data.photo_url = buildPhotoUrl(relPath);
                }
                res.json({ success: true, data });
            });
        };

        if (!employeeQuery) {
            return finalize(null);
        }
        db.get(employeeQuery, variants, (empErr, empRow) => {
            if (empErr) {
                logger.warn('[mobile-adapter] /me employee fallback failed:', empErr.message);
                return finalize(null);
            }
            return finalize(empRow || null);
        });
    });
});

router.put('/me', verifyToken, requireTechnician, (req, res) => {
    const techId = parseTechnicianId(req);
    if (!techId) {
        return res.status(400).json({ success: false, message: 'ID teknisi tidak valid' });
    }
    const body = req.body || {};
    const name = body.name != null ? String(body.name).trim() : '';
    const phone = body.phone != null ? String(body.phone).trim() : '';
    const email = body.email != null ? String(body.email).trim() : '';
    const address = body.address != null ? String(body.address).trim() : '';

    if (!name) {
        return res.status(400).json({ success: false, message: 'Nama wajib diisi' });
    }
    if (!phone) {
        return res.status(400).json({ success: false, message: 'Nomor HP wajib diisi' });
    }

    db.all('PRAGMA table_info(technicians)', [], (techColsErr, techColsRows) => {
        if (techColsErr || !Array.isArray(techColsRows)) {
            logger.error('[mobile-adapter] /me PUT technician schema failed', techColsErr);
            return res.status(500).json({ success: false, message: 'Gagal membaca schema teknisi' });
        }
        const techCols = new Set(techColsRows.map((c) => String(c.name || '').toLowerCase()));
        const techSets = [];
        const techVals = [];
        if (techCols.has('name')) {
            techSets.push('name = ?');
            techVals.push(name);
        }
        if (techCols.has('phone')) {
            techSets.push('phone = ?');
            techVals.push(phone);
        }
        if (techCols.has('email')) {
            techSets.push('email = ?');
            techVals.push(email || null);
        }
        if (techCols.has('notes')) {
            techSets.push('notes = ?');
            techVals.push(address || null);
        }
        if (!techSets.length) {
            return res.status(500).json({ success: false, message: 'Kolom profil teknisi tidak ditemukan' });
        }

        const techUpdateSql = `UPDATE technicians SET ${techSets.join(', ')} WHERE id = ?`;
        techVals.push(techId);
        db.run(techUpdateSql, techVals, function (err) {
            if (err) {
                const msg = err && err.message ? String(err.message) : '';
                if (msg.includes('UNIQUE') && msg.toLowerCase().includes('phone')) {
                    return res.status(400).json({ success: false, message: 'Nomor HP sudah dipakai teknisi lain' });
                }
                logger.error('[mobile-adapter] /me PUT', err);
                return res.status(500).json({ success: false, message: err.message || 'Gagal menyimpan profil' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ success: false, message: 'Profil teknisi tidak ditemukan' });
            }
            // Sinkronkan juga data karyawan (employees) agar form teknisi konsisten
            // dengan sumber data karyawan yang dipakai sistem absensi.
            const variants = phoneVariantsForEmployeeLookup(req.user.phone || req.user.username || '');
            if (!variants.length) {
                return res.json({ success: true, message: 'Profil berhasil diperbarui' });
            }
            const ph = variants.map(() => '?').join(',');
            const selectSql =
                `SELECT id FROM employees WHERE (status IS NULL OR LOWER(TRIM(status)) = 'aktif') AND TRIM(no_hp) IN (${ph}) LIMIT 1`;
            db.get(selectSql, variants, (empErr, empRow) => {
                if (empErr || !empRow || !empRow.id) {
                    if (empErr) {
                        logger.warn('[mobile-adapter] /me PUT employee lookup failed:', empErr.message);
                    }
                    return res.json({ success: true, message: 'Profil berhasil diperbarui' });
                }
                db.all('PRAGMA table_info(employees)', [], (colErr, colRows) => {
                    if (colErr || !Array.isArray(colRows)) {
                        if (colErr) {
                            logger.warn('[mobile-adapter] /me PUT employee schema failed:', colErr.message);
                        }
                        return res.json({ success: true, message: 'Profil berhasil diperbarui' });
                    }
                    const cols = new Set(colRows.map((c) => String(c.name || '').toLowerCase()));
                    const sets = [];
                    const vals = [];
                    if (cols.has('name')) {
                        sets.push('name = ?');
                        vals.push(name);
                    }
                    if (cols.has('no_hp')) {
                        sets.push('no_hp = ?');
                        vals.push(phone);
                    }
                    if (cols.has('email')) {
                        sets.push('email = ?');
                        vals.push(email || null);
                    }
                    if (cols.has('address')) {
                        sets.push('address = ?');
                        vals.push(address || null);
                    } else if (cols.has('alamat')) {
                        sets.push('alamat = ?');
                        vals.push(address || null);
                    }
                    if (!sets.length) {
                        return res.json({ success: true, message: 'Profil berhasil diperbarui' });
                    }
                    const updateSql = `UPDATE employees SET ${sets.join(', ')} WHERE id = ?`;
                    vals.push(empRow.id);
                    db.run(updateSql, vals, (upErr) => {
                        if (upErr) {
                            logger.warn('[mobile-adapter] /me PUT employee update failed:', upErr.message);
                        }
                        return res.json({ success: true, message: 'Profil berhasil diperbarui' });
                    });
                });
            });
        });
    });
});

// --- Absensi teknisi (employees.no_hp = nomor login JWT) ---
function sendAttendanceStatusPayload(res, empRow, row, today) {
    const shiftOutTime = empRow && empRow.check_out_time;
    const shiftPayload = empRow
        ? {
              shift_name: empRow.shift_name || null,
              check_in_time: empRow.check_in_time || null,
              check_out_time: shiftOutTime || null,
              check_out_time_label: formatShiftTimeLabel(shiftOutTime)
          }
        : null;

    if (!row) {
        return res.json({
            success: true,
            data: null,
            employee_matched: true,
            date: today,
            shift: shiftPayload
        });
    }

    const lateFromMarker = (() => {
        const m = String(row.notes || '').match(/\[LATE_MINUTES:(\d+)\]/);
        return m ? parseInt(m[1], 10) : 0;
    })();
    const lateFromShift = calculateLateMinutes(row.check_in, empRow && empRow.check_in_time);
    const lateMinutes = lateFromMarker > 0 ? lateFromMarker : lateFromShift;
    const lateNotice = lateMinutes > 0 ? `Anda terlambat ${lateMinutes} menit` : null;
    const autoApplied = /\[AUTO_CHECKOUT\]/i.test(String(row.notes || ''));
    const autoNotice = autoApplied
        ? `Pulang otomatis dicatat (lewat jam shift +${AUTO_CHECKOUT_GRACE_MINUTES} menit).`
        : null;
    const attendanceNotice = autoNotice || lateNotice;

    return res.json({
        success: true,
        employee_matched: true,
        date: row.date,
        attendance_notice: attendanceNotice,
        shift: shiftPayload,
        auto_check_out_applied: autoApplied,
        data: {
            check_in: row.check_in,
            check_out: row.check_out,
            status: row.status,
            notes: row.notes,
            late_minutes: lateMinutes,
            late_notice: lateNotice,
            auto_check_out: autoApplied
        }
    });
}

router.get('/attendance/status', verifyToken, requireTechnician, (req, res) => {
    const variants = phoneVariantsForEmployeeLookup(req.user.phone || req.user.username || '');
    if (!variants.length) {
        return res.json({ success: true, data: null, employee_matched: false });
    }
    const ph = variants.map(() => '?').join(',');
    db.get(
        `SELECT e.id, e.shift_id, s.shift_name, s.check_in_time, s.check_out_time
         FROM employees e
         LEFT JOIN attendance_shifts s ON e.shift_id = s.id
         WHERE (e.status IS NULL OR LOWER(TRIM(e.status)) = 'aktif') AND TRIM(e.no_hp) IN (${ph})
         LIMIT 1`,
        variants,
        (empErr, empRow) => {
            if (empErr) {
                logger.error('[mobile-adapter] attendance/status employee', empErr);
                return res.status(500).json({ success: false, message: empErr.message });
            }
            const eid = empRow && empRow.id != null ? parseInt(empRow.id, 10) : NaN;
            if (!Number.isFinite(eid) || eid <= 0) {
                return res.json({ success: true, data: null, employee_matched: false });
            }
            const today = jakartaAttendanceTodayYmd();
            db.get(
                'SELECT id, date, check_in, check_out, status, notes FROM employee_attendance WHERE employee_id = ? AND date = ?',
                [eid, today],
                (aErr, row) => {
                    if (aErr) {
                        logger.error('[mobile-adapter] attendance/status', aErr);
                        return res.status(500).json({ success: false, message: aErr.message });
                    }
                    if (!row) {
                        return sendAttendanceStatusPayload(res, empRow, null, today);
                    }
                    const shiftOut = empRow && empRow.check_out_time;
                    if (!shouldAutoCheckOutNow(row, shiftOut)) {
                        return sendAttendanceStatusPayload(res, empRow, row, today);
                    }
                    performAutoCheckOut(row.id, row.notes, (coErr, ts) => {
                        if (coErr) {
                            logger.error('[mobile-adapter] attendance auto check_out', coErr);
                            return sendAttendanceStatusPayload(res, empRow, row, today);
                        }
                        logger.info('[mobile-adapter] attendance auto check_out ok', {
                            attendance_id: row.id,
                            check_out: ts
                        });
                        const updated = {
                            ...row,
                            check_out: ts,
                            notes: row.notes
                                ? `${row.notes} | [AUTO_CHECKOUT] Pulang otomatis (lewat jam shift +10 menit)`
                                : '[AUTO_CHECKOUT] Pulang otomatis (lewat jam shift +10 menit)'
                        };
                        return sendAttendanceStatusPayload(res, empRow, updated, today);
                    });
                }
            );
        }
    );
});

router.post('/attendance', verifyToken, requireTechnician, (req, res) => {
    const body = req.body || {};
    const type = String(body.type || '').toLowerCase();
    if (!['check_in', 'check_out'].includes(type)) {
        return res.status(400).json({ success: false, message: 'Tipe tidak valid' });
    }
    const lat = body.location && body.location.latitude != null ? Number(body.location.latitude) : NaN;
    const lng = body.location && body.location.longitude != null ? Number(body.location.longitude) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ success: false, message: 'Koordinat lokasi wajib' });
    }
    const mode = String(body.check_in_mode || '').toLowerCase();
    const qrValue = body.qr_value != null ? String(body.qr_value).trim() : '';
    const photoB64 = body.photo_base64 != null ? String(body.photo_base64).trim() : '';

    if (type === 'check_in') {
        if (mode !== 'selfie' && mode !== 'qr') {
            return res.status(400).json({ success: false, message: 'Mode absensi wajib: selfie atau qr' });
        }
        if (mode === 'selfie' && !photoB64) {
            return res.status(400).json({ success: false, message: 'Foto selfie wajib' });
        }
        if (mode === 'qr' && !qrValue) {
            return res.status(400).json({ success: false, message: 'Data QR wajib' });
        }
    }

    const variants = phoneVariantsForEmployeeLookup(req.user.phone || req.user.username || '');
    if (!variants.length) {
        return res.status(400).json({
            success: false,
            message: 'Nomor HP teknisi tidak cocok dengan data karyawan (employees.no_hp). Hubungi admin.'
        });
    }
    const ph = variants.map(() => '?').join(',');
    db.get(
        `SELECT e.id, e.shift_id, s.shift_name, s.check_in_time, s.check_out_time
         FROM employees e
         LEFT JOIN attendance_shifts s ON e.shift_id = s.id
         WHERE (e.status IS NULL OR LOWER(TRIM(e.status)) = 'aktif') AND TRIM(e.no_hp) IN (${ph})
         LIMIT 1`,
        variants,
        (empErr, empRow) => {
            if (empErr) {
                logger.error('[mobile-adapter] attendance employee', empErr);
                return res.status(500).json({ success: false, message: empErr.message });
            }
            const eid = empRow && empRow.id != null ? parseInt(empRow.id, 10) : NaN;
            if (!Number.isFinite(eid) || eid <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Karyawan tidak ditemukan. Pastikan no_hp di data karyawan sama dengan nomor login teknisi.'
                });
            }
            const today = jakartaAttendanceTodayYmd();
            const ts = getLocalTimestamp();
            const noteBase = `[MOBILE] ${type} lat:${lat.toFixed(5)} lng:${lng.toFixed(5)}`;
            logger.info('[mobile-adapter] attendance request', {
                type,
                employee_id: eid,
                date: today,
                mode: type === 'check_in' ? mode : null,
                photo_len: photoB64.length,
                qr_len: qrValue.length
            });

            db.get(
                'SELECT id, check_in, check_out, notes FROM employee_attendance WHERE employee_id = ? AND date = ?',
                [eid, today],
                (rowErr, row) => {
                    if (rowErr) {
                        logger.error('[mobile-adapter] attendance row', rowErr);
                        return res.status(500).json({ success: false, message: rowErr.message });
                    }

                    if (type === 'check_in') {
                        if (row && row.check_in) {
                            return res.status(400).json({ success: false, message: 'Sudah masuk hari ini' });
                        }
                        return db.get(
                            'SELECT * FROM attendance_settings ORDER BY id DESC LIMIT 1',
                            [],
                            (cfgErr, cfg) => {
                                if (cfgErr) {
                                    logger.error('[mobile-adapter] attendance gps-config', cfgErr);
                                    return res.status(500).json({ success: false, message: cfgErr.message });
                                }

                                const lockGpsEnabled = Number(cfg && cfg.lock_gps_enabled) === 1;
                                const radiusMeters = Math.max(1, parseInt(cfg && cfg.lock_gps_radius_meters, 10) || 100);

                                const continueCheckIn = (gpsMeta) => {
                                    const lateMinutes = calculateLateMinutes(ts, empRow && empRow.check_in_time);
                                    const lateNotice = lateMinutes > 0
                                        ? `Anda terlambat ${lateMinutes} menit`
                                        : '';
                                    const extra =
                                        mode === 'qr'
                                            ? ` | qr:${qrValue.slice(0, 240)}`
                                            : ` | selfie_bytes:${photoB64 ? photoB64.length : 0}`;
                                    const lateMeta = lateMinutes > 0 ? ` | [LATE_MINUTES:${lateMinutes}] ${lateNotice}` : '';
                                    const gpsInfo = gpsMeta
                                        ? ` | [GPS_LOCK] branch:${gpsMeta.branch_name} distance:${Math.round(gpsMeta.distance_m)}m radius:${gpsMeta.radius_m}m`
                                        : '';
                                    const notes = `${noteBase}${extra}${lateMeta}${gpsInfo}`;
                                    if (row && row.id) {
                                        return db.run(
                                            `UPDATE employee_attendance SET status = 'hadir', check_in = ?, check_out = NULL, notes = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
                                            [ts, notes, row.id],
                                            function (upErr) {
                                                if (upErr) {
                                                    logger.error('[mobile-adapter] attendance check_in update', upErr);
                                                    return res.status(500).json({ success: false, message: upErr.message });
                                                }
                                                logger.info('[mobile-adapter] attendance check_in ok', { attendance_id: row.id });
                                                const checkInMessage = lateMinutes > 0 ? `Masuk berhasil. ${lateNotice}` : 'Masuk berhasil';
                                                return res.json({
                                                    success: true,
                                                    message: checkInMessage,
                                                    check_in: ts,
                                                    late_minutes: lateMinutes,
                                                    late_notice: lateNotice || null
                                                });
                                            }
                                        );
                                    }
                                    return db.run(
                                        `INSERT INTO employee_attendance (employee_id, date, status, check_in, check_out, notes) VALUES (?, ?, 'hadir', ?, NULL, ?)`,
                                        [eid, today, ts, notes],
                                        function (insErr) {
                                            if (insErr) {
                                                logger.error('[mobile-adapter] attendance check_in insert', insErr);
                                                return res.status(500).json({ success: false, message: insErr.message });
                                            }
                                            logger.info('[mobile-adapter] attendance check_in ok', { attendance_id: this.lastID });
                                            const checkInMessage = lateMinutes > 0 ? `Masuk berhasil. ${lateNotice}` : 'Masuk berhasil';
                                            return res.json({
                                                success: true,
                                                message: checkInMessage,
                                                check_in: ts,
                                                late_minutes: lateMinutes,
                                                late_notice: lateNotice || null
                                            });
                                        }
                                    );
                                };

                                if (!lockGpsEnabled) {
                                    return continueCheckIn(null);
                                }

                                db.all(
                                    'SELECT id, branch_name, latitude, longitude FROM attendance_branches ORDER BY id ASC',
                                    [],
                                    (brErr, branches) => {
                                        if (brErr) {
                                            logger.error('[mobile-adapter] attendance branches', brErr);
                                            return res.status(500).json({ success: false, message: brErr.message });
                                        }
                                        const rows = Array.isArray(branches) ? branches : [];
                                        if (!rows.length) {
                                            return res.status(400).json({
                                                success: false,
                                                message: 'Lock GPS aktif, tetapi data branch absensi belum ada. Hubungi admin.'
                                            });
                                        }

                                        let targetBranch = null;
                                        if (mode === 'qr') {
                                            const qrPayload = parseAttendanceBranchQrPayload(qrValue);
                                            if (!qrPayload) {
                                                return res.status(400).json({
                                                    success: false,
                                                    message: 'QR absensi tidak valid untuk branch.'
                                                });
                                            }
                                            if (qrPayload.id) {
                                                targetBranch = rows.find((b) => Number(b.id) === Number(qrPayload.id)) || null;
                                            }
                                            if (!targetBranch && Number.isFinite(qrPayload.latitude) && Number.isFinite(qrPayload.longitude)) {
                                                targetBranch = {
                                                    id: qrPayload.id || null,
                                                    branch_name: qrPayload.branch_name || 'Branch QR',
                                                    latitude: qrPayload.latitude,
                                                    longitude: qrPayload.longitude
                                                };
                                            }
                                            if (!targetBranch) {
                                                return res.status(400).json({
                                                    success: false,
                                                    message: 'QR branch tidak dikenali di data branch absensi.'
                                                });
                                            }
                                        } else {
                                            let nearest = null;
                                            rows.forEach((b) => {
                                                const bLat = Number(b.latitude);
                                                const bLng = Number(b.longitude);
                                                if (!Number.isFinite(bLat) || !Number.isFinite(bLng)) return;
                                                const d = haversineMeters(lat, lng, bLat, bLng);
                                                if (!nearest || d < nearest.distance_m) {
                                                    nearest = { branch: b, distance_m: d };
                                                }
                                            });
                                            if (!nearest) {
                                                return res.status(400).json({
                                                    success: false,
                                                    message: 'Koordinat branch absensi tidak valid. Hubungi admin.'
                                                });
                                            }
                                            targetBranch = nearest.branch;
                                        }

                                        const targetLat = Number(targetBranch.latitude);
                                        const targetLng = Number(targetBranch.longitude);
                                        const distanceM = haversineMeters(lat, lng, targetLat, targetLng);
                                        if (distanceM > radiusMeters) {
                                            const roundedDistance = Math.round(distanceM);
                                            const needCloserMeters = Math.max(0, roundedDistance - radiusMeters);
                                            return res.status(400).json({
                                                success: false,
                                                code: 'ATTENDANCE_OUT_OF_RADIUS',
                                                message: `Anda berada di luar radius absensi branch ${targetBranch.branch_name} (jarak ${roundedDistance}m, batas ${radiusMeters}m).`,
                                                details: {
                                                    branch_id: targetBranch.id || null,
                                                    branch_name: targetBranch.branch_name || 'Branch',
                                                    distance_m: roundedDistance,
                                                    radius_m: radiusMeters,
                                                    need_closer_m: needCloserMeters
                                                }
                                            });
                                        }

                                        return continueCheckIn({
                                            branch_id: targetBranch.id || null,
                                            branch_name: targetBranch.branch_name || 'Branch',
                                            distance_m: distanceM,
                                            radius_m: radiusMeters
                                        });
                                    }
                                );
                            }
                        );
                    }

                    if (!row || !row.check_in) {
                        return res.status(400).json({ success: false, message: 'Belum masuk hari ini' });
                    }
                    if (row.check_out) {
                        return res.status(400).json({ success: false, message: 'Sudah pulang hari ini' });
                    }
                    const outNotes = row.notes ? `${row.notes} | ${noteBase}` : noteBase;
                    return db.run(
                        `UPDATE employee_attendance SET check_out = ?, notes = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
                        [ts, outNotes, row.id],
                        function (coErr) {
                            if (coErr) {
                                logger.error('[mobile-adapter] attendance check_out', coErr);
                                return res.status(500).json({ success: false, message: coErr.message });
                            }
                            logger.info('[mobile-adapter] attendance check_out ok', { attendance_id: row.id });
                            return res.json({ success: true, message: 'Pulang berhasil', check_out: ts });
                        }
                    );
                }
            );
        }
    );
});

/** Izin/cuti dari app teknisi → `employee_leave_requests` (pending), tampil di admin /employees/leave-requests */
router.post('/leave-request', verifyToken, requireTechnician, (req, res) => {
    const body = req.body || {};
    const requestType = String(body.request_type || '').toLowerCase() === 'cuti' ? 'cuti' : 'izin';
    const startDate = body.start_date != null ? String(body.start_date).trim().slice(0, 10) : '';
    const endDate = body.end_date != null ? String(body.end_date).trim().slice(0, 10) : '';
    const reason = body.reason != null ? String(body.reason).trim() : '';

    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    if (!ymd.test(startDate) || !ymd.test(endDate)) {
        return res.status(400).json({ success: false, message: 'Format tanggal wajib YYYY-MM-DD' });
    }
    if (!reason) {
        return res.status(400).json({ success: false, message: 'Alasan wajib diisi' });
    }
    const t0 = new Date(`${startDate}T00:00:00`);
    const t1 = new Date(`${endDate}T00:00:00`);
    if (Number.isNaN(t0.getTime()) || Number.isNaN(t1.getTime()) || t1 < t0) {
        return res.status(400).json({ success: false, message: 'Rentang tanggal tidak valid' });
    }

    const variants = phoneVariantsForEmployeeLookup(req.user.phone || req.user.username || '');
    if (!variants.length) {
        return res.status(400).json({
            success: false,
            message: 'Nomor HP login tidak cocok dengan data karyawan (employees.no_hp). Hubungi admin.'
        });
    }
    const requestedBy = [req.user.phone, req.user.username].filter(Boolean).join(' / ') || 'mobile';
    const ph = variants.map(() => '?').join(',');
    db.get(
        `SELECT id FROM employees WHERE (status IS NULL OR LOWER(TRIM(status)) = 'aktif') AND TRIM(no_hp) IN (${ph}) LIMIT 1`,
        variants,
        (empErr, empRow) => {
            if (empErr) {
                logger.error('[mobile-adapter] leave-request employee', empErr);
                return res.status(500).json({ success: false, message: empErr.message });
            }
            const eid = empRow && empRow.id != null ? parseInt(empRow.id, 10) : NaN;
            if (!Number.isFinite(eid) || eid <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Karyawan tidak ditemukan. Pastikan no_hp di data karyawan sama dengan nomor login teknisi.'
                });
            }
            const query = `
                INSERT INTO employee_leave_requests (employee_id, request_type, start_date, end_date, reason, requested_by, status)
                VALUES (?, ?, ?, ?, ?, ?, 'pending')
            `;
            db.run(
                query,
                [eid, requestType, startDate, endDate, reason, requestedBy],
                function (insErr) {
                    if (insErr) {
                        logger.error('[mobile-adapter] leave-request insert', insErr);
                        return res.status(500).json({ success: false, message: insErr.message });
                    }
                    logger.info('[mobile-adapter] leave-request ok', {
                        id: this.lastID,
                        employee_id: eid,
                        request_type: requestType,
                        start_date: startDate,
                        end_date: endDate
                    });
                    return res.json({
                        success: true,
                        id: this.lastID,
                        message: 'Permintaan izin/cuti dikirim. Menunggu persetujuan admin.'
                    });
                }
            );
        }
    );
});

/** Riwayat izin/cuti yang sudah diproses admin (30 hari) — tampil di halaman absensi mobile */
router.get('/leave-requests/recent', verifyToken, requireTechnician, (req, res) => {
    const variants = phoneVariantsForEmployeeLookup(req.user.phone || req.user.username || '');
    if (!variants.length) {
        return res.json({ success: true, data: [], employee_matched: false });
    }
    const ph = variants.map(() => '?').join(',');
    db.get(
        `SELECT id FROM employees WHERE (status IS NULL OR LOWER(TRIM(status)) = 'aktif') AND TRIM(no_hp) IN (${ph}) LIMIT 1`,
        variants,
        (empErr, empRow) => {
            if (empErr) {
                logger.error('[mobile-adapter] leave-requests/recent employee', empErr);
                return res.status(500).json({ success: false, message: empErr.message });
            }
            const eid = empRow && empRow.id != null ? parseInt(empRow.id, 10) : NaN;
            if (!Number.isFinite(eid) || eid <= 0) {
                return res.json({ success: true, data: [], employee_matched: false });
            }
            db.all(
                `SELECT id, request_type, start_date, end_date, reason, status, approved_at, approval_notes, created_at
                 FROM employee_leave_requests
                 WHERE employee_id = ?
                   AND status IN ('approved', 'rejected')
                   AND datetime(COALESCE(approved_at, updated_at, created_at)) >= datetime('now','localtime', '-30 days')
                 ORDER BY datetime(COALESCE(approved_at, updated_at)) DESC
                 LIMIT 50`,
                [eid],
                (qErr, rows) => {
                    if (qErr) {
                        logger.error('[mobile-adapter] leave-requests/recent', qErr);
                        return res.status(500).json({ success: false, message: qErr.message });
                    }
                    res.json({ success: true, employee_matched: true, data: rows || [] });
                }
            );
        }
    );
});

// --- Dashboard stats ---
router.get('/dashboard', verifyToken, allowFieldOps, (req, res) => {
    const baseSql = `SELECT
            COUNT(*) AS total_customers,
            SUM(CASE WHEN LOWER(status) = 'active' THEN 1 ELSE 0 END) AS active_customers,
            SUM(CASE WHEN LOWER(status) = 'suspended' THEN 1 ELSE 0 END) AS suspended_customers,
            SUM(CASE WHEN LOWER(status) IN ('inactive','register') THEN 1 ELSE 0 END) AS isolated_customers
         FROM customers`;

    const sendStats = (row, isolatedOverride) => {
        res.json({
            success: true,
            data: {
                stats: {
                    total_customers: row.total_customers || 0,
                    active_customers: row.active_customers || 0,
                    suspended_customers: row.suspended_customers || 0,
                    isolated_customers:
                        isolatedOverride != null ? isolatedOverride : row.isolated_customers || 0
                }
            }
        });
    };

    db.get(baseSql, [], (err, row) => {
        if (err) {
            logger.error('[mobile-adapter] dashboard:', err);
            return res.status(500).json({ success: false, message: err.message });
        }
        const role = req.user && req.user.role;
        const techId = role === 'technician' ? parseTechnicianId(req) : null;
        if (role === 'technician' && techId) {
            const trMatch = sqlTroubleTicketCustomerMatch('cu', 'tr');
            const gangSql = `SELECT COUNT(DISTINCT id) AS n FROM (
                SELECT c.id FROM customers c WHERE LOWER(c.status) = 'isolated'
                UNION
                SELECT cu.id FROM customers cu
                INNER JOIN trouble_reports tr ON ${trMatch}
                WHERE (
                        tr.assigned_technician_id = ?
                        OR CAST(tr.assigned_technician_id AS TEXT) = ?
                        OR IFNULL(TRIM(CAST(tr.assigned_technician_id AS TEXT)), '') IN ('', '0')
                      )
                  AND LOWER(IFNULL(tr.status, '')) NOT IN ('closed', 'resolved')
            )`;
            db.get(gangSql, [techId, String(techId)], (err2, gRow) => {
                if (err2) {
                    logger.error('[mobile-adapter] dashboard gangguan:', err2);
                    return sendStats(row, null);
                }
                sendStats(row, gRow && gRow.n != null ? gRow.n : 0);
            });
            return;
        }
        sendStats(row, null);
    });
});

// --- Tasks: instalasi + tiket gangguan untuk teknisi login ---
// ?history=1 → hanya tugas selesai (untuk riwayat profil). Tanpa param → hanya tugas aktif.
router.get('/tasks', verifyToken, requireTechnician, (req, res) => {
    const role = req.user && req.user.role;
    const isAdmin = role === 'admin';
    const techId = parseTechnicianId(req);
    if (!isAdmin && !techId) {
        return res.status(400).json({ success: false, message: 'ID teknisi tidak valid' });
    }

    const history = String(req.query.history || '') === '1';

    const installWhere = isAdmin
        ? history
            ? `LOWER(ij.status) IN ('completed','cancelled')`
            : `LOWER(ij.status) NOT IN ('completed','cancelled')`
        : history
            ? `(ij.assigned_technician_id = ? OR CAST(ij.assigned_technician_id AS TEXT) = ?) AND LOWER(ij.status) IN ('completed','cancelled')`
            : `${sqlInstallationJobAccessibleByTech('ij')} AND LOWER(ij.status) NOT IN ('completed','cancelled')`;
    const installParams = isAdmin ? [] : [techId, String(techId)];

    const installSql = `
        SELECT ij.*, p.name AS package_name,
            COALESCE(
                (SELECT COALESCE(NULLIF(TRIM(pppoe_username), ''), NULLIF(TRIM(username), ''))
                 FROM customers WHERE id = ij.customer_id AND NULLIF(ij.customer_id, 0) IS NOT NULL),
                (SELECT COALESCE(NULLIF(TRIM(pppoe_username), ''), NULLIF(TRIM(username), ''))
                 FROM customers cu
                 WHERE (ij.customer_id IS NULL OR ij.customer_id = 0)
                   AND NULLIF(TRIM(IFNULL(ij.customer_phone, '')), '') IS NOT NULL
                   AND REPLACE(REPLACE(REPLACE(LOWER(TRIM(cu.phone)), ' ', ''), '-', ''), '+', '') =
                       REPLACE(REPLACE(REPLACE(LOWER(TRIM(ij.customer_phone)), ' ', ''), '-', ''), '+', '')
                 ORDER BY cu.id DESC LIMIT 1)
            ) AS cust_pppoe_username,
            NULL AS cust_pppoe_password
        FROM installation_jobs ij
        LEFT JOIN packages p ON ij.package_id = p.id
        WHERE ${installWhere}
        ORDER BY ij.updated_at DESC, ij.created_at DESC
        LIMIT 200
    `;

    const troubleWhere = isAdmin
        ? history
            ? `LOWER(status) IN ('closed','resolved')`
            : `LOWER(status) NOT IN ('closed','resolved')`
        : history
            ? `(assigned_technician_id = ? OR CAST(assigned_technician_id AS TEXT) = ?)
            AND LOWER(status) IN ('closed','resolved')`
            : `(
                assigned_technician_id = ?
                OR CAST(assigned_technician_id AS TEXT) = ?
                OR IFNULL(TRIM(CAST(assigned_technician_id AS TEXT)), '') IN ('', '0')
            )
            AND LOWER(status) NOT IN ('closed','resolved')`;
    const troubleParams = isAdmin ? [] : [techId, String(techId)];

    db.all(installSql, installParams, (err1, installRows) => {
        if (err1) {
            logger.error('[mobile-adapter] tasks install:', err1);
            return res.status(500).json({ success: false, message: 'Gagal memuat tugas instalasi' });
        }
        db.all(
            `SELECT * FROM trouble_reports
             WHERE ${troubleWhere}
             ORDER BY updated_at DESC, created_at DESC
             LIMIT 200`,
            troubleParams,
            async (err2, troubleRows) => {
                if (err2) {
                    logger.error('[mobile-adapter] tasks trouble:', err2);
                    return res.status(500).json({ success: false, message: 'Gagal memuat tiket' });
                }

                const { resolvePppoeCleartextFromRadiusOnly } = require('../../utils/pppoePasswordPolicy');

                const tasks = [];
                for (const row of installRows || []) {
                    const activityAt = row.updated_at || row.created_at || '';
                    const stLow = String(row.status || '').toLowerCase();
                    const ws =
                        row.work_started_at ||
                        (stLow === 'in_progress' ? row.updated_at || null : null);
                    const pppUser =
                        (row.cust_pppoe_username && String(row.cust_pppoe_username).trim()) || '';
                    let pppPass = null;
                    if (pppUser) {
                        try {
                            pppPass = await resolvePppoeCleartextFromRadiusOnly(pppUser);
                        } catch (radErr) {
                            logger.warn('[mobile-adapter] tasks install RADIUS password:', radErr.message || radErr);
                        }
                    }
                    tasks.push({
                        id: row.id,
                        type: 'INSTALL',
                        job_number: row.job_number || null,
                        title: `PSB · ${row.job_number || ''}`,
                        customer: row.customer_name,
                        address: row.customer_address,
                        phone: row.customer_phone,
                        customer_id: (() => {
                            const c = row.customer_id != null ? parseInt(row.customer_id, 10) : NaN;
                            return Number.isFinite(c) && c > 0 ? c : null;
                        })(),
                        status: mapDisplayStatusInstall(row.status),
                        priority: mapInstallPriority(row.priority),
                        description: row.notes || row.package_name || '',
                        sector: 'PSB',
                        activity_at: activityAt,
                        work_started_at: ws,
                        pppoe_username: pppUser || null,
                        pppoe_password: pppPass
                    });
                }
                for (const row of troubleRows || []) {
                    const activityAt = row.updated_at || row.created_at || '';
                    const stLow = String(row.status || '').toLowerCase();
                    const ws =
                        row.work_started_at ||
                        (stLow === 'in_progress' ? row.updated_at || null : null);
                    tasks.push({
                        id: row.id,
                        type: 'TR',
                        title: row.category || 'Tiket gangguan',
                        customer: row.name,
                        address: row.location || '',
                        phone: row.phone,
                        customer_id: (() => {
                            const c = row.customer_id != null ? parseInt(row.customer_id, 10) : NaN;
                            return Number.isFinite(c) && c > 0 ? c : null;
                        })(),
                        status: mapDisplayStatusTrouble(row.status),
                        priority: mapInstallPriority(row.priority),
                        description: row.description || '',
                        sector: 'TIKET',
                        activity_at: activityAt,
                        work_started_at: ws
                    });
                }
                tasks.sort((a, b) => String(b.activity_at || '').localeCompare(String(a.activity_at || '')));
                res.json({ success: true, data: tasks });
            }
        );
    });
});

/** Zona waktu untuk rentang "minggu ini" (Sen–Min) di kartu performa teknisi. */
const PERF_WEEK_TZ = 'Asia/Jakarta';
const PERF_WEEKDAY_ID = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

function jakartaYmdFromInstant(inst) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: PERF_WEEK_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(inst);
}

function jakartaWeekdayMon0(inst) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: PERF_WEEK_TZ, weekday: 'short' }).format(inst);
    const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
    return map[wd] ?? 0;
}

function jakartaAddDaysFromInstant(inst, deltaDays) {
    return new Date(inst.getTime() + deltaDays * 86400000);
}

function attendanceDayScore(row) {
    if (!row) return 0;
    const st = String(row.status || '')
        .toLowerCase()
        .trim();
    if (st === 'izin' || st === 'sakit') return 100;
    if (st === 'alpha') return 0;
    const hasIn = row.check_in != null && String(row.check_in).trim() !== '';
    const hasOut = row.check_out != null && String(row.check_out).trim() !== '';
    if (hasOut) return 100;
    if (hasIn) return 70;
    return 0;
}

/** Sen–Min kalender minggu berjalan (Asia/Jakarta), + agregat tugas selesai & skor absensi per hari. */
router.get('/performance/week', verifyToken, requireTechnician, (req, res) => {
    const role = req.user && req.user.role;
    const techId = parseTechnicianId(req);
    const isAdmin = role === 'admin';

    const now = new Date();
    let anchor = now;
    for (let i = 0; i < jakartaWeekdayMon0(now); i++) {
        anchor = jakartaAddDaysFromInstant(anchor, -1);
    }
    const weekStartYmd = jakartaYmdFromInstant(anchor);
    const weekEndYmd = jakartaYmdFromInstant(jakartaAddDaysFromInstant(anchor, 6));
    const todayYmd = jakartaYmdFromInstant(now);

    const replyPerfEmptyZeros = () => {
        const daysEmpty = [];
        let cur = anchor;
        for (let i = 0; i < 7; i++) {
            const ymd = jakartaYmdFromInstant(cur);
            daysEmpty.push({
                date: ymd,
                weekday: PERF_WEEKDAY_ID[i],
                is_today: ymd === todayYmd,
                tasks_completed: 0,
                attendance_score: 0
            });
            cur = jakartaAddDaysFromInstant(cur, 1);
        }
        return res.json({
            success: true,
            data: {
                days: daysEmpty,
                tasks_week_total: 0,
                attendance_week_avg: 0,
                employee_matched: false,
                tasks_week_max_per_day: 0
            }
        });
    };

    if (!isAdmin && !techId) {
        return replyPerfEmptyZeros();
    }

    if (isAdmin) {
        const installSqlAdmin = `
        SELECT substr(COALESCE(updated_at, created_at), 1, 10) AS d, COUNT(*) AS c
        FROM installation_jobs
        WHERE LOWER(status) IN ('completed','cancelled')
          AND substr(COALESCE(updated_at, created_at), 1, 10) >= ?
          AND substr(COALESCE(updated_at, created_at), 1, 10) <= ?
        GROUP BY substr(COALESCE(updated_at, created_at), 1, 10)
    `;
        const troubleSqlAdmin = `
        SELECT substr(COALESCE(updated_at, created_at), 1, 10) AS d, COUNT(*) AS c
        FROM trouble_reports
        WHERE LOWER(status) IN ('closed','resolved')
          AND substr(COALESCE(updated_at, created_at), 1, 10) >= ?
          AND substr(COALESCE(updated_at, created_at), 1, 10) <= ?
        GROUP BY substr(COALESCE(updated_at, created_at), 1, 10)
    `;
        db.all(installSqlAdmin, [weekStartYmd, weekEndYmd], (aErr1, installAgg) => {
            if (aErr1) {
                logger.error('[mobile-adapter] performance/week admin install:', aErr1);
                return res.status(500).json({ success: false, message: 'Gagal memuat performa tugas' });
            }
            db.all(troubleSqlAdmin, [weekStartYmd, weekEndYmd], (aErr2, troubleAgg) => {
                if (aErr2) {
                    logger.error('[mobile-adapter] performance/week admin trouble:', aErr2);
                    return res.status(500).json({ success: false, message: 'Gagal memuat performa tiket' });
                }
                const taskByDay = {};
                for (const row of installAgg || []) {
                    if (row && row.d) taskByDay[row.d] = (taskByDay[row.d] || 0) + toFiniteNumber(row.c);
                }
                for (const row of troubleAgg || []) {
                    if (row && row.d) taskByDay[row.d] = (taskByDay[row.d] || 0) + toFiniteNumber(row.c);
                }
                const days = [];
                let cur = anchor;
                let tasksWeekTotal = 0;
                let maxTasks = 0;
                for (let i = 0; i < 7; i++) {
                    const ymd = jakartaYmdFromInstant(cur);
                    const tc = toFiniteNumber(taskByDay[ymd]);
                    if (tc > maxTasks) maxTasks = tc;
                    tasksWeekTotal += tc;
                    days.push({
                        date: ymd,
                        weekday: PERF_WEEKDAY_ID[i],
                        is_today: ymd === todayYmd,
                        tasks_completed: tc,
                        attendance_score: 0
                    });
                    cur = jakartaAddDaysFromInstant(cur, 1);
                }
                res.json({
                    success: true,
                    data: {
                        days,
                        tasks_week_total: tasksWeekTotal,
                        attendance_week_avg: 0,
                        employee_matched: false,
                        tasks_week_max_per_day: maxTasks
                    }
                });
            });
        });
        return;
    }

    const installSql = `
        SELECT substr(COALESCE(updated_at, created_at), 1, 10) AS d, COUNT(*) AS c
        FROM installation_jobs
        WHERE assigned_technician_id = ?
          AND LOWER(status) IN ('completed','cancelled')
          AND substr(COALESCE(updated_at, created_at), 1, 10) >= ?
          AND substr(COALESCE(updated_at, created_at), 1, 10) <= ?
        GROUP BY substr(COALESCE(updated_at, created_at), 1, 10)
    `;
    const troubleSql = `
        SELECT substr(COALESCE(updated_at, created_at), 1, 10) AS d, COUNT(*) AS c
        FROM trouble_reports
        WHERE (assigned_technician_id = ? OR CAST(assigned_technician_id AS TEXT) = ?)
          AND LOWER(status) IN ('closed','resolved')
          AND substr(COALESCE(updated_at, created_at), 1, 10) >= ?
          AND substr(COALESCE(updated_at, created_at), 1, 10) <= ?
        GROUP BY substr(COALESCE(updated_at, created_at), 1, 10)
    `;

    db.all(installSql, [techId, weekStartYmd, weekEndYmd], (err1, installAgg) => {
        if (err1) {
            logger.error('[mobile-adapter] performance/week install:', err1);
            return res.status(500).json({ success: false, message: 'Gagal memuat performa tugas' });
        }
        db.all(troubleSql, [techId, String(techId), weekStartYmd, weekEndYmd], (err2, troubleAgg) => {
            if (err2) {
                logger.error('[mobile-adapter] performance/week trouble:', err2);
                return res.status(500).json({ success: false, message: 'Gagal memuat performa tiket' });
            }
            const taskByDay = {};
            for (const row of installAgg || []) {
                if (row && row.d) taskByDay[row.d] = (taskByDay[row.d] || 0) + toFiniteNumber(row.c);
            }
            for (const row of troubleAgg || []) {
                if (row && row.d) taskByDay[row.d] = (taskByDay[row.d] || 0) + toFiniteNumber(row.c);
            }

            const variants = phoneVariantsForEmployeeLookup(req.user.phone || req.user.username || '');
            const findEmp = (cb) => {
                if (!variants.length) return cb(null, null);
                const ph = variants.map(() => '?').join(',');
                db.get(
                    `SELECT id FROM employees
                     WHERE (status IS NULL OR LOWER(TRIM(status)) = 'aktif')
                       AND TRIM(no_hp) IN (${ph})
                     LIMIT 1`,
                    variants,
                    (e, empRow) => cb(e, empRow)
                );
            };

            findEmp((empErr, empRow) => {
                if (empErr) {
                    logger.error('[mobile-adapter] performance/week employee:', empErr);
                }
                const employeeId = empRow && empRow.id != null ? parseInt(empRow.id, 10) : null;
                const employeeMatched = Number.isFinite(employeeId) && employeeId > 0;

                const finish = (attRows) => {
                    const attByDate = {};
                    for (const r of attRows || []) {
                        if (r && r.date) attByDate[String(r.date).slice(0, 10)] = r;
                    }

                    const days = [];
                    let cur = anchor;
                    let tasksWeekTotal = 0;
                    let attSum = 0;
                    let attCount = 0;
                    let maxTasks = 0;
                    for (let i = 0; i < 7; i++) {
                        const ymd = jakartaYmdFromInstant(cur);
                        const tc = toFiniteNumber(taskByDay[ymd]);
                        if (tc > maxTasks) maxTasks = tc;
                        tasksWeekTotal += tc;
                        const attSc = employeeMatched ? attendanceDayScore(attByDate[ymd]) : 0;
                        if (employeeMatched) {
                            attSum += attSc;
                            attCount += 1;
                        }
                        days.push({
                            date: ymd,
                            weekday: PERF_WEEKDAY_ID[i],
                            is_today: ymd === todayYmd,
                            tasks_completed: tc,
                            attendance_score: attSc
                        });
                        cur = jakartaAddDaysFromInstant(cur, 1);
                    }
                    const attendanceWeekAvg = attCount > 0 ? Math.round((attSum / attCount) * 10) / 10 : 0;
                    res.json({
                        success: true,
                        data: {
                            days,
                            tasks_week_total: tasksWeekTotal,
                            attendance_week_avg: attendanceWeekAvg,
                            employee_matched: employeeMatched,
                            tasks_week_max_per_day: maxTasks
                        }
                    });
                };

                if (!employeeMatched) {
                    return finish([]);
                }
                db.all(
                    `SELECT date, check_in, check_out, status FROM employee_attendance
                     WHERE employee_id = ? AND date >= ? AND date <= ?`,
                    [employeeId, weekStartYmd, weekEndYmd],
                    (aErr, rows) => {
                        if (aErr) {
                            logger.error('[mobile-adapter] performance/week attendance:', aErr);
                            return finish([]);
                        }
                        finish(rows);
                    }
                );
            });
        });
    });
});

router.post('/tasks/:type/:id/status', verifyToken, requireTechnician, (req, res) => {
    const { type, id } = req.params;
    const body = req.body || {};
    const { status } = body;
    if (!status) {
        return res.status(400).json({ success: false, message: 'Status wajib diisi' });
    }
    const roleUser = req.user && req.user.role;
    const isAdminTask = roleUser === 'admin';
    const techId = parseTechnicianId(req);
    if (!isAdminTask && !techId) {
        return res.status(400).json({ success: false, message: 'ID teknisi tidak valid' });
    }
    const actorHistoryId = isAdminTask ? 0 : techId;
    const rawStatus = String(status).toLowerCase();

    if (type === 'INSTALL') {
        const jobId = parseInt(id, 10);
        if (!Number.isFinite(jobId)) {
            return res.status(400).json({ success: false, message: 'ID tugas tidak valid' });
        }

        /** Pending dari app teknisi: simpan alasan di notes, kembalikan status ke assigned agar admin melihat di web. */
        if (rawStatus === 'pending' || rawStatus === 'ditunda') {
            const pendingReason = String(body.pending_reason || body.reason || '').trim();
            if (pendingReason.length < 8) {
                return res.status(400).json({
                    success: false,
                    message: 'Alasan pending wajib diisi (minimal 8 karakter)'
                });
            }
            const pickSql = isAdminTask
                ? `SELECT * FROM installation_jobs WHERE id = ?`
                : `SELECT * FROM installation_jobs WHERE id = ? AND ${sqlInstallationJobAccessibleByTech('installation_jobs')}`;
            const pickParams = isAdminTask ? [jobId] : [jobId, techId, String(techId)];
            db.get(pickSql, pickParams, (pErr, job) => {
                if (pErr) {
                    logger.error('[mobile-adapter] install pending get:', pErr);
                    return res.status(500).json({ success: false, message: pErr.message });
                }
                if (!job) {
                    return res.status(404).json({ success: false, message: 'Tugas tidak ditemukan atau bukan milik Anda' });
                }
                const noteBlock = `[Pending — app teknisi]\n${pendingReason}`;
                const newNotes = job.notes ? `${job.notes}\n\n${noteBlock}` : noteBlock;
                const wallNow = getLocalTimestamp();
                const updSql = isAdminTask
                    ? `UPDATE installation_jobs SET status = 'assigned', notes = ?, work_started_at = NULL, updated_at = ? WHERE id = ?`
                    : `UPDATE installation_jobs SET status = 'assigned', notes = ?, work_started_at = NULL, updated_at = ?,
                         assigned_technician_id = CASE
                            WHEN IFNULL(TRIM(CAST(assigned_technician_id AS TEXT)), '') IN ('', '0') THEN ?
                            ELSE assigned_technician_id
                         END
                         WHERE id = ? AND ${sqlInstallationJobAccessibleByTech('installation_jobs')}`;
                const updParams = isAdminTask
                    ? [newNotes, wallNow, jobId]
                    : [newNotes, wallNow, techId, jobId, techId, String(techId)];
                db.run(updSql, updParams, function (uErr) {
                    if (uErr) {
                        return res.status(500).json({ success: false, message: uErr.message });
                    }
                    if (this.changes === 0) {
                        return res.status(404).json({ success: false, message: 'Tugas tidak ditemukan atau bukan milik Anda' });
                    }
                    db.run(
                        `INSERT INTO installation_job_status_history (
                            job_id, old_status, new_status, changed_by_type, changed_by_id, notes
                        ) VALUES (?, ?, 'assigned', 'technician', ?, ?)`,
                        [jobId, job.status, actorHistoryId, pendingReason.slice(0, 500)],
                        (hErr) => {
                            if (hErr) {
                                logger.warn('[mobile-adapter] install pending history:', hErr.message);
                            }
                        }
                    );
                    return res.json({ success: true, message: 'Pending tersimpan; admin dapat melihat alasan di catatan job.' });
                });
            });
            return;
        }

        const rawNorm = String(status || '')
            .toLowerCase()
            .trim()
            .replace(/\s+/g, '_');
        let dbStatus = rawNorm;
        if (rawNorm === 'closed' || rawNorm === 'selesai') dbStatus = 'completed';
        else if (rawNorm === 'mulai' || rawNorm === 'in_progress' || rawNorm === 'start') dbStatus = 'in_progress';

        if (dbStatus === 'completed') {
            const completion_description = String(body.completion_description || '').trim();
            if (!completion_description) {
                return res.status(400).json({
                    success: false,
                    message: 'Deskripsi penyelesaian wajib diisi'
                });
            }
            const { lat: compLat, lng: compLng } = parseCompletionLatLng(body);
            const cableRaw = body.cable_length_m ?? body.install_cable_length_m;
            const cableM = parseFloat(cableRaw);
            let stickerPath = null;
            try {
                if (body.sticker_photo_base64 != null && String(body.sticker_photo_base64).trim() !== '') {
                    stickerPath = decodeAndSaveStickerPhoto(body.sticker_photo_base64);
                }
            } catch (se) {
                return res.status(400).json({ success: false, message: se.message || 'Foto stiker tidak valid' });
            }
            if (!Number.isFinite(cableM) || cableM < 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Panjang kabel (meter) wajib diisi dengan angka valid'
                });
            }
            if (!stickerPath) {
                return res.status(400).json({
                    success: false,
                    message: 'Foto stiker belakang ONT wajib (kamera)'
                });
            }
            if (compLat == null || compLng == null) {
                return res.status(400).json({
                    success: false,
                    message: 'Tag lokasi wajib — ambil koordinat GPS sebelum selesai'
                });
            }

            let photoPath = null;
            if (body.completion_photo_base64 != null && String(body.completion_photo_base64).trim() !== '') {
                try {
                    photoPath = decodeAndSaveCompletionPhoto(body.completion_photo_base64);
                } catch (pe) {
                    return res.status(400).json({ success: false, message: pe.message || 'Foto tidak valid' });
                }
            }

            const installPickSql = isAdminTask
                ? `SELECT * FROM installation_jobs WHERE id = ?`
                : `SELECT * FROM installation_jobs WHERE id = ? AND ${sqlInstallationJobAccessibleByTech('installation_jobs')}`;
            const installPickParams = isAdminTask ? [jobId] : [jobId, techId, String(techId)];

            db.get(
                installPickSql,
                installPickParams,
                (gErr, job) => {
                    if (gErr) {
                        logger.error('[mobile-adapter] install complete get:', gErr);
                        return res.status(500).json({ success: false, message: gErr.message });
                    }
                    if (!job) {
                        return res.status(404).json({ success: false, message: 'Tugas tidak ditemukan atau bukan milik Anda' });
                    }
                    const noteBlock =
                        `[Selesai — app teknisi]\n${completion_description}` +
                        `\n📏 Kabel: ${cableM} m` +
                        (photoPath ? `\n📷 ${photoPath}` : '') +
                        `\n📷 Stiker ONT: ${stickerPath}`;
                    const newNotes = job.notes ? `${job.notes}\n\n${noteBlock}` : noteBlock;
                    const wd = clampWorkDurationSeconds(body.work_duration_seconds);

                    const setCols = [`status = 'completed'`];
                    const uParams = [];
                    if (!isAdminTask) {
                        setCols.push(
                            `assigned_technician_id = CASE WHEN IFNULL(TRIM(CAST(assigned_technician_id AS TEXT)), '') IN ('', '0') THEN ? ELSE assigned_technician_id END`
                        );
                        uParams.push(techId);
                    }
                    setCols.push(
                        `notes = ?`,
                        `updated_at = datetime('now','localtime')`,
                        `install_cable_length_m = ?`,
                        `install_ont_sticker_photo_path = ?`
                    );
                    uParams.push(newNotes, cableM, stickerPath);
                    if (wd != null) {
                        setCols.push('work_duration_seconds = ?');
                        uParams.push(wd);
                    }
                    if (compLat != null && compLng != null) {
                        setCols.push('tech_completion_latitude = ?', 'tech_completion_longitude = ?');
                        uParams.push(compLat, compLng);
                        setCols.push('customer_latitude = ?', 'customer_longitude = ?');
                        uParams.push(compLat, compLng);
                    }
                    let updInstallSql = `UPDATE installation_jobs SET ${setCols.join(', ')} WHERE id = ? AND ${sqlInstallationJobAccessibleByTech('installation_jobs')}`;
                    if (isAdminTask) {
                        uParams.push(jobId);
                        updInstallSql = `UPDATE installation_jobs SET ${setCols.join(', ')} WHERE id = ?`;
                    } else {
                        uParams.push(jobId, techId, String(techId));
                    }

                    db.run(updInstallSql, uParams, async function (uErr) {
                            if (uErr) {
                                return res.status(500).json({ success: false, message: uErr.message });
                            }
                            if (this.changes === 0) {
                                return res.status(404).json({ success: false, message: 'Tugas tidak ditemukan atau bukan milik Anda' });
                            }
                            // Tag lokasi penyelesaian → latitude/longitude pelanggan (resolusi id dari customer_id atau nomor HP job)
                            if (compLat != null && compLng != null) {
                                const custDbId = await resolveCustomerIdFromInstallationJob(job);
                                if (custDbId) {
                                    await updateCustomerTagLocation(custDbId, compLat, compLng);
                                    await backfillInstallationJobCustomerId(jobId, custDbId);
                                } else {
                                    logger.warn(
                                        '[mobile-adapter] PSB selesai: tidak bisa memetakan pelanggan untuk update lokasi (customer_id & phone kosong/tidak cocok)'
                                    );
                                }
                            }
                            db.run(
                                `INSERT INTO installation_job_status_history (
                                    job_id, old_status, new_status, changed_by_type, changed_by_id, notes
                                ) VALUES (?, ?, 'completed', 'technician', ?, ?)`,
                                [jobId, job.status, actorHistoryId, completion_description.slice(0, 500)],
                                (histErr) => {
                                    if (histErr) {
                                        logger.warn('[mobile-adapter] install history:', histErr.message);
                                    }
                                }
                            );
                            const phone = (job.customer_phone || '').replace(/\D/g, '');
                            res.json({ success: true, message: 'Instalasi diselesaikan' });

                            setImmediate(() => {
                                const { cleanupFieldCompletionImages } = require('../../utils/fieldCompletionStorage');
                                cleanupFieldCompletionImages({ aggressive: false, syncDb: true }).catch(() => {});
                            });

                            // WhatsApp jangan menahan respons API (koneksi WA bisa lama / timeout).
                            if (phone) {
                                const jobForWa = { ...job, customer_id: job.customer_id };
                                setImmediate(() => {
                                    (async () => {
                                        try {
                                            const whatsappNotifications = require('../../config/whatsapp-notifications');
                                            const waResult = await whatsappNotifications.sendWelcomeMessageOnInstallComplete(jobForWa);
                                            if (waResult && waResult.success && !waResult.skipped) {
                                                logger.info('[mobile-adapter] Welcome message terkirim setelah PSB selesai');
                                            } else if (waResult && waResult.skipped) {
                                                logger.info('[mobile-adapter] Welcome message dilewati:', waResult.reason);
                                            } else {
                                                logger.warn('[mobile-adapter] Welcome message gagal:', waResult?.error);
                                            }
                                        } catch (waErr) {
                                            logger.warn('[mobile-adapter] WA welcome pelanggan PSB (bg):', waErr.message || waErr);
                                        }
                                    })();
                                });
                            }
                            return;
                    });
                }
            );
            return;
        }

        if (dbStatus === 'in_progress') {
            // Pakai jam zona aplikasi (bukan SQLite datetime('now','localtime') = UTC) agar durasi di app mobile sinkron.
            const wallNow = getLocalTimestamp();
            const pickInProgSql = isAdminTask
                ? `SELECT id, status FROM installation_jobs WHERE id = ?`
                : `SELECT id, status FROM installation_jobs WHERE id = ? AND ${sqlInstallationJobAccessibleByTech('installation_jobs')}`;
            const pickInProgParams = isAdminTask ? [jobId] : [jobId, techId, String(techId)];
            db.get(pickInProgSql, pickInProgParams, (gErr, jobRow) => {
                if (gErr) {
                    logger.error('[mobile-adapter] install in_progress pick:', gErr);
                    return res.status(500).json({ success: false, message: gErr.message });
                }
                if (!jobRow) {
                    return res.status(404).json({
                        success: false,
                        message: 'Tugas tidak ditemukan atau bukan milik Anda'
                    });
                }
                const oldSt = jobRow.status;
                const oldLower = String(oldSt || '').toLowerCase().trim();
                if (oldLower === 'in_progress') {
                    return res.json({ success: true, message: 'Status sudah sedang dikerjakan' });
                }
                const updInProgSql = isAdminTask
                    ? `UPDATE installation_jobs SET status = ?, updated_at = ?,
                     work_started_at = COALESCE(work_started_at, ?)
                     WHERE id = ?`
                    : `UPDATE installation_jobs SET status = ?, updated_at = ?,
                 work_started_at = COALESCE(work_started_at, ?),
                 assigned_technician_id = CASE
                    WHEN IFNULL(TRIM(CAST(assigned_technician_id AS TEXT)), '') IN ('', '0') THEN ?
                    ELSE assigned_technician_id
                 END
                 WHERE id = ? AND ${sqlInstallationJobAccessibleByTech('installation_jobs')}`;
                const updInProgParams = isAdminTask
                    ? [dbStatus, wallNow, wallNow, jobId]
                    : [dbStatus, wallNow, wallNow, techId, jobId, techId, String(techId)];
                db.run(updInProgSql, updInProgParams, function (uErr) {
                    if (uErr) {
                        return res.status(500).json({ success: false, message: uErr.message });
                    }
                    if (this.changes === 0) {
                        return res.status(404).json({
                            success: false,
                            message: 'Tugas tidak ditemukan atau bukan milik Anda'
                        });
                    }
                    const histType = isAdminTask ? 'admin' : 'technician';
                    const histId = isAdminTask ? 0 : actorHistoryId;
                    let histNotes = 'Pengerjaan di lapangan dimulai (admin).';
                    if (!isAdminTask) {
                        if (oldLower === 'assigned') {
                            histNotes =
                                'Tugas dijalankan kembali di lapangan (app teknisi) — dilanjutkan setelah pending / jeda.';
                        } else if (oldLower === 'scheduled') {
                            histNotes = 'Tugas mulai dikerjakan di lapangan (app teknisi).';
                        } else {
                            histNotes = `Pengerjaan dilanjutkan ke sedang dikerjakan (app teknisi). Status sebelumnya: ${oldSt || '-'}.`;
                        }
                    }
                    db.run(
                        `INSERT INTO installation_job_status_history (
                            job_id, old_status, new_status, changed_by_type, changed_by_id, notes
                        ) VALUES (?, ?, ?, ?, ?, ?)`,
                        [jobId, oldSt, dbStatus, histType, histId, histNotes],
                        (hErr) => {
                            if (hErr) {
                                logger.warn('[mobile-adapter] install in_progress history:', hErr.message);
                            }
                            res.json({ success: true, message: 'Status diperbarui' });
                        }
                    );
                });
            });
            return;
        }

        if (isAdminTask) {
            const wallNow = getLocalTimestamp();
            db.run(
                `UPDATE installation_jobs SET status = ?, updated_at = ?
             WHERE id = ?`,
                [dbStatus, wallNow, jobId],
                function (err) {
                    if (err) {
                        return res.status(500).json({ success: false, message: err.message });
                    }
                    if (this.changes === 0) {
                        return res.status(404).json({
                            success: false,
                            message: 'Tugas tidak ditemukan atau bukan milik Anda'
                        });
                    }
                    res.json({ success: true, message: 'Status diperbarui' });
                }
            );
            return;
        }

        const wallNowOther = getLocalTimestamp();
        db.run(
            `UPDATE installation_jobs SET status = ?, updated_at = ?,
             assigned_technician_id = CASE
                WHEN IFNULL(TRIM(CAST(assigned_technician_id AS TEXT)), '') IN ('', '0') THEN ?
                ELSE assigned_technician_id
             END,
             work_started_at = CASE
                WHEN ? = 'in_progress' THEN COALESCE(work_started_at, ?)
                ELSE work_started_at
             END
             WHERE id = ? AND ${sqlInstallationJobAccessibleByTech('installation_jobs')}`,
            [dbStatus, wallNowOther, techId, dbStatus, wallNowOther, jobId, techId, String(techId)],
            function (err) {
                if (err) {
                    return res.status(500).json({ success: false, message: err.message });
                }
                if (this.changes === 0) {
                    return res.status(404).json({
                        success: false,
                        message: 'Tugas tidak ditemukan atau bukan milik Anda'
                    });
                }
                res.json({ success: true, message: 'Status diperbarui' });
            }
        );
        return;
    }

    if (type === 'TR') {
        if (rawStatus === 'pending' || rawStatus === 'ditunda') {
            const pendingReason = String(body.pending_reason || body.reason || '').trim();
            if (pendingReason.length < 8) {
                return res.status(400).json({
                    success: false,
                    message: 'Alasan pending wajib diisi (minimal 8 karakter)'
                });
            }
            const trAccessSql = isAdminTask
                ? `SELECT id FROM trouble_reports WHERE id = ?`
                : `SELECT id FROM trouble_reports
                 WHERE id = ?
                   AND (
                        assigned_technician_id = ?
                        OR CAST(assigned_technician_id AS TEXT) = ?
                        OR IFNULL(TRIM(CAST(assigned_technician_id AS TEXT)), '') IN ('', '0')
                   )`;
            const trAccessParams = isAdminTask ? [id] : [id, techId, String(techId)];
            db.get(trAccessSql, trAccessParams, async (aErr, row) => {
                if (aErr) {
                    logger.error('[mobile-adapter] TR pending access:', aErr);
                    return res.status(500).json({ success: false, message: aErr.message });
                }
                if (!row) {
                    return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan atau bukan milik Anda' });
                }
                try {
                    const { updateTroubleReportStatus } = require('../../config/troubleReport');
                    await updateTroubleReportStatus(
                        id,
                        'open',
                        `[Pending — app teknisi]\n${pendingReason}`,
                        {},
                        false
                    );
                    await new Promise((resolve, reject) => {
                        const wallNow = getLocalTimestamp();
                        db.run(
                            'UPDATE trouble_reports SET work_started_at = NULL, updated_at = ? WHERE id = ?',
                            [wallNow, id],
                            (e2) => (e2 ? reject(e2) : resolve())
                        );
                    });
                    return res.json({ success: true, message: 'Pending tersimpan; admin melihat alasan di riwayat tiket.' });
                } catch (e) {
                    logger.error('[mobile-adapter] TR pending:', e);
                    return res.status(500).json({
                        success: false,
                        message: e.message || 'Gagal menyimpan pending'
                    });
                }
            });
            return;
        }

        let dbStatus = rawStatus;
        if (rawStatus === 'selesai' || rawStatus === 'closed' || rawStatus === 'completed') {
            dbStatus = 'resolved';
        } else if (rawStatus === 'mulai' || rawStatus === 'in_progress' || rawStatus === 'start') {
            dbStatus = 'in_progress';
        }

        function done(err) {
            if (err) {
                return res.status(500).json({ success: false, message: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan atau bukan milik Anda' });
            }
            res.json({ success: true, message: 'Status diperbarui' });
        }

        if (dbStatus === 'in_progress') {
            const wallNow = getLocalTimestamp();
            if (isAdminTask) {
                db.run(
                    `UPDATE trouble_reports SET status = ?, updated_at = ?,
                     work_started_at = COALESCE(work_started_at, ?)
                     WHERE id = ?`,
                    [dbStatus, wallNow, wallNow, id],
                    done
                );
                return;
            }
            db.run(
                `UPDATE trouble_reports SET status = ?, updated_at = ?,
                 work_started_at = COALESCE(work_started_at, ?),
                 assigned_technician_id = CASE
                    WHEN IFNULL(TRIM(CAST(assigned_technician_id AS TEXT)), '') IN ('', '0') THEN ?
                    ELSE assigned_technician_id
                 END
                 WHERE id = ?
                   AND (
                        assigned_technician_id = ?
                        OR CAST(assigned_technician_id AS TEXT) = ?
                        OR IFNULL(TRIM(CAST(assigned_technician_id AS TEXT)), '') IN ('', '0')
                   )`,
                [dbStatus, wallNow, wallNow, techId, id, techId, String(techId)],
                done
            );
            return;
        }

        if (dbStatus === 'resolved' || dbStatus === 'closed') {
            const completion_description = String(body.completion_description || '').trim();
            if (!completion_description) {
                return res.status(400).json({
                    success: false,
                    message: 'Deskripsi penyelesaian wajib diisi'
                });
            }
            let photoPath = null;
            try {
                photoPath = decodeAndSaveCompletionPhoto(body.completion_photo_base64);
            } catch (pe) {
                return res.status(400).json({ success: false, message: pe.message || 'Foto tidak valid' });
            }

            const trPickSql = isAdminTask
                ? `SELECT id FROM trouble_reports WHERE id = ?`
                : `SELECT id FROM trouble_reports
                 WHERE id = ?
                   AND (
                        assigned_technician_id = ?
                        OR CAST(assigned_technician_id AS TEXT) = ?
                        OR IFNULL(TRIM(CAST(assigned_technician_id AS TEXT)), '') IN ('', '0')
                   )`;
            const trPickParams = isAdminTask ? [id] : [id, techId, String(techId)];

            db.get(trPickSql, trPickParams, (qErr, row) => {
                    if (qErr) {
                        return res.status(500).json({ success: false, message: qErr.message });
                    }
                    if (!row) {
                        return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan atau bukan milik Anda' });
                    }
                    (async () => {
                        try {
                            const { updateTroubleReportStatus } = require('../../config/troubleReport');
                            let noteText = `[Penyelesaian teknisi]\n${completion_description}`;
                            if (photoPath) noteText += `\n📷 ${photoPath}`;
                            await updateTroubleReportStatus(id, 'resolved', noteText, {}, true);
                            const wd = clampWorkDurationSeconds(body.work_duration_seconds);
                            if (wd != null) {
                                await new Promise((resolve, reject) => {
                                    db.run(
                                        'UPDATE trouble_reports SET work_duration_seconds = ? WHERE id = ?',
                                        [wd, id],
                                        (e2) => (e2 ? reject(e2) : resolve())
                                    );
                                });
                            }
                            res.json({ success: true, message: 'Tiket diselesaikan' });
                        } catch (e) {
                            logger.error('[mobile-adapter] TR resolve:', e);
                            res.status(500).json({
                                success: false,
                                message: e.message || 'Gagal menyelesaikan tiket'
                            });
                        }
                    })();
                }
            );
            return;
        }

        if (isAdminTask) {
            const wallNow = getLocalTimestamp();
            db.run(
                `UPDATE trouble_reports
             SET status = ?, updated_at = ?
             WHERE id = ?`,
                [dbStatus, wallNow, id],
                done
            );
            return;
        }

        const wallNow = getLocalTimestamp();
        db.run(
            `UPDATE trouble_reports
             SET status = ?, updated_at = ?,
                 assigned_technician_id = CASE
                    WHEN IFNULL(TRIM(CAST(assigned_technician_id AS TEXT)), '') IN ('', '0') THEN ?
                    ELSE assigned_technician_id
                 END
             WHERE id = ?
               AND (
                    assigned_technician_id = ?
                    OR CAST(assigned_technician_id AS TEXT) = ?
                    OR IFNULL(TRIM(CAST(assigned_technician_id AS TEXT)), '') IN ('', '0')
               )`,
            [dbStatus, wallNow, techId, id, techId, String(techId)],
            done
        );
        return;
    }

    res.status(400).json({ success: false, message: 'Tipe tugas tidak dikenal' });
});

// --- Notifikasi tugas (admin → teknisi, in-app + badge di mobile) ---
router.get('/notifications', verifyToken, requireTechnician, (req, res) => {
    const roleNt = req.user && req.user.role;
    if (roleNt === 'admin') {
        return res.json({ success: true, data: { items: [], unread_count: 0 } });
    }
    const techId = parseTechnicianId(req);
    if (!techId) {
        return res.status(400).json({ success: false, message: 'ID teknisi tidak valid' });
    }
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    db.get(
        `SELECT COUNT(*) AS c FROM technician_field_notifications
         WHERE technician_id = ? AND read_at IS NULL`,
        [techId],
        (e1, countRow) => {
            if (e1) {
                logger.error('[mobile-adapter] notifications count:', e1);
                return res.status(500).json({ success: false, message: e1.message });
            }
            const unread_count = countRow ? countRow.c : 0;
            db.all(
                `SELECT id, technician_id, kind, ref_id, title, body, read_at, created_at
                 FROM technician_field_notifications
                 WHERE technician_id = ?
                 ORDER BY datetime(created_at) DESC
                 LIMIT ?`,
                [techId, limit],
                (e2, rows) => {
                    if (e2) {
                        logger.error('[mobile-adapter] notifications list:', e2);
                        return res.status(500).json({ success: false, message: e2.message });
                    }
                    const items = (rows || []).map((r) => ({
                        id: r.id,
                        kind: r.kind,
                        ref_id: r.ref_id,
                        title: r.title,
                        body: r.body,
                        read_at: r.read_at,
                        created_at: r.created_at,
                        unread: !r.read_at
                    }));
                    res.json({ success: true, data: { items, unread_count } });
                }
            );
        }
    );
});

router.post('/notifications/:notifId/read', verifyToken, requireTechnician, (req, res) => {
    const roleNt = req.user && req.user.role;
    if (roleNt === 'admin') {
        return res.json({ success: true, message: 'Ditandai dibaca' });
    }
    const techId = parseTechnicianId(req);
    const nid = parseInt(req.params.notifId, 10);
    if (!techId || !Number.isFinite(nid)) {
        return res.status(400).json({ success: false, message: 'Data tidak valid' });
    }
    db.run(
        `UPDATE technician_field_notifications SET read_at = datetime('now','localtime')
         WHERE id = ? AND technician_id = ?`,
        [nid, techId],
        function (err) {
            if (err) {
                return res.status(500).json({ success: false, message: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ success: false, message: 'Notifikasi tidak ditemukan' });
            }
            res.json({ success: true, message: 'Ditandai dibaca' });
        }
    );
});

router.post('/notifications/read-all', verifyToken, requireTechnician, (req, res) => {
    const roleNt = req.user && req.user.role;
    if (roleNt === 'admin') {
        return res.json({ success: true, message: 'Semua ditandai dibaca', updated: 0 });
    }
    const techId = parseTechnicianId(req);
    if (!techId) {
        return res.status(400).json({ success: false, message: 'ID teknisi tidak valid' });
    }
    db.run(
        `UPDATE technician_field_notifications SET read_at = datetime('now','localtime')
         WHERE technician_id = ? AND read_at IS NULL`,
        [techId],
        function (err) {
            if (err) {
                return res.status(500).json({ success: false, message: err.message });
            }
            res.json({ success: true, message: 'Semua ditandai dibaca', updated: this.changes });
        }
    );
});

// --- ODP / jaringan ---
router.get('/odps', verifyToken, allowFieldOps, (req, res) => {
    const includeAll = String(req.query.all || '').trim() === '1';
    const sql = includeAll
        ? `SELECT id, name, code, latitude, longitude, status, capacity, used_ports, address, parent_odp_id
           FROM odps
           ORDER BY name`
        : `SELECT id, name, code, latitude, longitude, status, capacity, used_ports, address, parent_odp_id
           FROM odps
           WHERE latitude IS NOT NULL AND longitude IS NOT NULL
           ORDER BY name`;
    db.all(
        sql,
        [],
        (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, message: err.message });
            }
            const data = (rows || []).map((r) => ({
                ...r,
                latitude: r.latitude != null && r.latitude !== '' ? parseFloat(r.latitude) : null,
                longitude: r.longitude != null && r.longitude !== '' ? parseFloat(r.longitude) : null
            }));
            res.json({ success: true, data });
        }
    );
});

// Network map payload for mobile (customers + ODP + cable routes + backbone)
router.get('/network-map', verifyToken, requireTechnician, async (req, res) => {
    try {
        const odps = await new Promise((resolve, reject) => {
            db.all(
                `SELECT id, name, code, latitude, longitude, status, capacity, used_ports, address, parent_odp_id
                 FROM odps
                 WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
                [],
                (err, rows) => (err ? reject(err) : resolve(rows || []))
            );
        });

        const customers = await new Promise((resolve, reject) => {
            db.all(
                `SELECT id, name, phone, status, latitude, longitude, odp_id, pppoe_username, username
                 FROM customers
                 WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
                [],
                (err, rows) => (err ? reject(err) : resolve(rows || []))
            );
        });

        const cableRoutes = await new Promise((resolve, reject) => {
            db.all(
                `SELECT cr.id, cr.customer_id, cr.odp_id, cr.status, cr.cable_type, cr.cable_length,
                        c.name AS customer_name, c.latitude AS customer_lat, c.longitude AS customer_lng,
                        o.name AS odp_name, o.latitude AS odp_lat, o.longitude AS odp_lng
                 FROM cable_routes cr
                 JOIN customers c ON c.id = cr.customer_id
                 JOIN odps o ON o.id = cr.odp_id
                 WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL
                   AND o.latitude IS NOT NULL AND o.longitude IS NOT NULL`,
                [],
                (err, rows) => (err ? reject(err) : resolve(rows || []))
            );
        });

        const backbone = await new Promise((resolve, reject) => {
            db.all(
                `SELECT oc.id, oc.from_odp_id, oc.to_odp_id, oc.connection_type, oc.status, oc.cable_length,
                        fo.name AS from_name, fo.latitude AS from_lat, fo.longitude AS from_lng,
                        to2.name AS to_name, to2.latitude AS to_lat, to2.longitude AS to_lng
                 FROM odp_connections oc
                 JOIN odps fo ON fo.id = oc.from_odp_id
                 JOIN odps to2 ON to2.id = oc.to_odp_id
                 WHERE fo.latitude IS NOT NULL AND fo.longitude IS NOT NULL
                   AND to2.latitude IS NOT NULL AND to2.longitude IS NOT NULL`,
                [],
                (err, rows) => (err ? reject(err) : resolve(rows || []))
            );
        });

        // Garis backbone kuning di app teknisi: dari odp_connections di atas.
        // Parent ODP di admin hanya mengisi odps.parent_odp_id — tanpa baris odp_connections garis tidak muncul.
        // Tambahkan segmen parent→child bila belum ada koneksi eksplisit antara pasangan tersebut (dua arah).
        const backboneFromParent = await new Promise((resolve, reject) => {
            db.all(
                `SELECT
                    ('hier:' || child.id) AS id,
                    child.parent_odp_id AS from_odp_id,
                    child.id AS to_odp_id,
                    'hierarchy' AS connection_type,
                    'active' AS status,
                    NULL AS cable_length,
                    p.name AS from_name,
                    p.latitude AS from_lat,
                    p.longitude AS from_lng,
                    child.name AS to_name,
                    child.latitude AS to_lat,
                    child.longitude AS to_lng
                 FROM odps child
                 INNER JOIN odps p ON p.id = child.parent_odp_id
                 WHERE child.parent_odp_id IS NOT NULL
                   AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL
                   AND child.latitude IS NOT NULL AND child.longitude IS NOT NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM odp_connections oc2
                       WHERE (oc2.from_odp_id = child.parent_odp_id AND oc2.to_odp_id = child.id)
                          OR (oc2.from_odp_id = child.id AND oc2.to_odp_id = child.parent_odp_id)
                   )`,
                [],
                (err, rows) => (err ? reject(err) : resolve(rows || []))
            );
        });

        const backboneMerged = backbone.concat(backboneFromParent);

        let onlineLoginSet = new Set();
        let pppoeUptimeByLogin = Object.create(null);
        try {
            const { getActivePppoeLoginNamesSetWithUptimeMap } = require('../../config/mikrotik');
            const batch = await withTimeout(
                getActivePppoeLoginNamesSetWithUptimeMap(),
                MIKROTIK_NETWORK_MAP_TIMEOUT_MS,
                'MikroTik PPPoE'
            );
            onlineLoginSet = batch.names || new Set();
            pppoeUptimeByLogin = batch.uptimeByLogin || Object.create(null);
        } catch (e) {
            logger.warn('[mobile-adapter] network-map PPPoE batch:', e.message || e);
        }
        const enrichedCustomers = (customers || []).map((r) => {
            const login =
                (r.pppoe_username && String(r.pppoe_username).trim()) ||
                (r.username && String(r.username).trim()) ||
                '';
            let pppoeActive = null;
            if (login) {
                pppoeActive = onlineLoginSet.has(login);
            }
            const networkDown = pppoeActive === false;
            const uptimeDisplay =
                login && pppoeActive === true
                    ? pppoeUptimeByLogin[String(login).toLowerCase()] || null
                    : null;
            return {
                ...sqliteJsonSafeRow(r),
                pppoe_active: pppoeActive,
                network_down: networkDown,
                down_reason: networkDown ? 'PPPoE inactive' : null,
                pppoe_uptime_display: uptimeDisplay
            };
        });

        const downCustomerIdSet = new Set(
            enrichedCustomers.filter((c) => c.network_down === true).map((c) => Number(c.id))
        );

        res.json({
            success: true,
            data: {
                odps: odps.map((r) => ({
                    ...r,
                    latitude: parseFloat(r.latitude),
                    longitude: parseFloat(r.longitude)
                })),
                customers: enrichedCustomers.map((r) => ({
                    ...r,
                    latitude: parseFloat(r.latitude),
                    longitude: parseFloat(r.longitude)
                })),
                cableRoutes: cableRoutes.map((r) => ({
                    ...r,
                    status:
                        r.status === 'connected' && downCustomerIdSet.has(Number(r.customer_id))
                            ? 'disconnected'
                            : r.status,
                    network_down: downCustomerIdSet.has(Number(r.customer_id)),
                    customer_lat: parseFloat(r.customer_lat),
                    customer_lng: parseFloat(r.customer_lng),
                    odp_lat: parseFloat(r.odp_lat),
                    odp_lng: parseFloat(r.odp_lng)
                })),
                backbone: backboneMerged.map((r) => ({
                    ...r,
                    from_lat: parseFloat(r.from_lat),
                    from_lng: parseFloat(r.from_lng),
                    to_lat: parseFloat(r.to_lat),
                    to_lng: parseFloat(r.to_lng)
                }))
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Gagal memuat data network map'
        });
    }
});

router.get('/network-status', verifyToken, requireTechnician, async (req, res) => {
    try {
        const {
            getUserAuthModeAsync,
            getMikrotikConnectionForRouter,
            getResourceInfoForRouter
        } = require('../../config/mikrotik');
        const authMode = await getUserAuthModeAsync();

        const routers = await new Promise((resolve, reject) => {
            db.all(
                `SELECT *
                 FROM routers
                 ORDER BY id ASC`,
                [],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(Array.isArray(rows) ? rows : []);
                }
            );
        });

        const routerRows = routers.length
            ? routers
            : [{ id: 'default', name: 'Mikrotik Default', nas_ip: null, nas_identifier: null }];

        const routerStats = await Promise.all(
            routerRows.map(async (r) => {
                const name = r.name || r.nas_identifier || r.nas_ip || `Router ${r.id}`;
                try {
                    const conn = await getMikrotikConnectionForRouter(r);
                    if (!conn) {
                        return {
                            id: r.id,
                            name,
                            active: 0,
                            offline: 0,
                            total: 0,
                            status: 'offline',
                            error: 'Koneksi router gagal'
                        };
                    }
                    const [actives, secrets, resourceInfo] = await Promise.all([
                        conn.write('/ppp/active/print'),
                        conn.write('/ppp/secret/print'),
                        getResourceInfoForRouter(r)
                    ]);
                    const activeCount = Array.isArray(actives) ? actives.length : 0;
                    const totalSecrets = Array.isArray(secrets) ? secrets.length : 0;
                    const traffic = resourceInfo && resourceInfo.success && resourceInfo.data
                        ? resourceInfo.data
                        : null;
                    return {
                        id: r.id,
                        name,
                        active: activeCount,
                        offline: Math.max(totalSecrets - activeCount, 0),
                        total: totalSecrets,
                        rx_mbps: Number(traffic && traffic.totalNetworkInMbps) || 0,
                        tx_mbps: Number(traffic && traffic.totalNetworkOutMbps) || 0,
                        status: 'online'
                    };
                } catch (e) {
                    logger.warn('[mobile-adapter] network-status router failed:', e.message || e);
                    return {
                        id: r.id,
                        name,
                        active: 0,
                        offline: 0,
                        total: 0,
                        status: 'offline',
                        error: (e && e.message) ? e.message : 'Router tidak merespons'
                    };
                }
            })
        );

        const summary = routerStats.reduce(
            (acc, item) => {
                acc.active += Number(item.active) || 0;
                acc.offline += Number(item.offline) || 0;
                acc.total += Number(item.total) || 0;
                return acc;
            },
            { active: 0, offline: 0, total: 0 }
        );

        return res.json({
            success: true,
            mode: 'mikrotik',
            auth_mode: authMode,
            summary,
            routers: routerStats
        });
    } catch (e) {
        logger.error('[mobile-adapter] network-status:', e);
        return res.status(500).json({
            success: false,
            message: e.message || 'Gagal memuat status jaringan'
        });
    }
});

router.get('/odps/:odpId', verifyToken, requireTechnician, (req, res) => {
    const odpId = req.params.odpId;
    db.get(
        `SELECT o.*,
                COUNT(CASE WHEN cr.customer_id IS NOT NULL THEN cr.id END) AS connected_customers
         FROM odps o
         LEFT JOIN cable_routes cr ON o.id = cr.odp_id
         WHERE o.id = ? OR o.code = ?
         GROUP BY o.id`,
        [odpId, odpId],
        (err, odp) => {
            if (err || !odp) {
                return res.status(err ? 500 : 404).json({
                    success: false,
                    message: err ? err.message : 'ODP tidak ditemukan'
                });
            }
            db.all(
                `SELECT cr.*, c.name AS customer_name, c.phone AS customer_phone, c.id AS customer_id
                 FROM cable_routes cr
                 JOIN customers c ON cr.customer_id = c.id
                 WHERE cr.odp_id = ?
                 ORDER BY cr.port_number, c.name`,
                [odp.id],
                (e2, routes) => {
                    if (e2) {
                        return res.status(500).json({ success: false, message: e2.message });
                    }
                    const customers = (routes || []).map((cr) => ({
                        id: cr.customer_id,
                        name: cr.customer_name,
                        phone: cr.customer_phone,
                        port_number: cr.port_number,
                        status: cr.status
                    }));
                    res.json({
                        success: true,
                        data: {
                            odp,
                            customers
                        }
                    });
                }
            );
        }
    );
});

router.put('/odps/:odpId/capacity', verifyToken, requireTechnician, (req, res) => {
    const odpParam = String(req.params.odpId || '').trim();
    const cap = parseInt((req.body || {}).capacity, 10);
    if (!Number.isFinite(cap) || cap < 1) {
        return res.status(400).json({ success: false, message: 'Kapasitas tidak valid' });
    }
    db.get(
        'SELECT id FROM odps WHERE id = ? OR code = ? OR name = ? LIMIT 1',
        [odpParam, odpParam, odpParam],
        (err, row) => {
            if (err) {
                return res.status(500).json({ success: false, message: err.message });
            }
            if (!row) {
                return res.status(404).json({ success: false, message: 'ODP tidak ditemukan' });
            }
            db.run(
                "UPDATE odps SET capacity = ?, updated_at = datetime('now','localtime') WHERE id = ?",
                [cap, row.id],
                function (e2) {
                    if (e2) {
                        return res.status(500).json({ success: false, message: e2.message });
                    }
                    if (this.changes === 0) {
                        return res.status(404).json({ success: false, message: 'ODP tidak ditemukan' });
                    }
                    res.json({ success: true, message: 'Kapasitas diperbarui' });
                }
            );
        }
    );
});

router.put('/odps/:code/location', verifyToken, requireTechnician, (req, res) => {
    const code = req.params.code;
    const { latitude, longitude, capacity, notes } = req.body || {};
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ success: false, message: 'Koordinat tidak valid' });
    }
    const cap = capacity != null ? parseInt(capacity, 10) : null;

    db.get('SELECT id FROM odps WHERE code = ?', [code], (err, row) => {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        if (row) {
            const sets = ['latitude = ?', 'longitude = ?', "updated_at = datetime('now','localtime')"];
            const vals = [lat, lng];
            if (Number.isFinite(cap) && cap > 0) {
                sets.push('capacity = ?');
                vals.push(cap);
            }
            if (notes != null) {
                sets.push('notes = ?');
                vals.push(String(notes));
            }
            vals.push(row.id);
            db.run(`UPDATE odps SET ${sets.join(', ')} WHERE id = ?`, vals, function (e2) {
                if (e2) {
                    return res.status(500).json({ success: false, message: e2.message });
                }
                return res.json({ success: true, message: 'Lokasi ODP diperbarui' });
            });
            return;
        }
        db.run(
            `INSERT INTO odps (name, code, latitude, longitude, capacity, status, notes)
             VALUES (?, ?, ?, ?, ?, 'active', ?)`,
            [code, code, lat, lng, Number.isFinite(cap) && cap > 0 ? cap : 8, notes != null ? String(notes) : ''],
            function (e3) {
                if (e3) {
                    return res.status(500).json({ success: false, message: e3.message });
                }
                res.json({ success: true, message: 'ODP baru dibuat dengan lokasi' });
            }
        );
    });
});

function pickCustomerLookupRaw(body) {
    const b = body || {};
    const v = b.customer_db_id ?? b.customerDbId ?? b.customer_id ?? b.id;
    if (v === undefined || v === null) return '';
    if (typeof v === 'string' && v.trim() === '') return '';
    return v;
}

router.post('/odps/:odpId/assign', verifyToken, requireTechnician, (req, res) => {
    const odpParam = String(req.params.odpId || '').trim();
    const body = req.body || {};
    const { port_number, cable_length, cable_type, notes } = body;
    const port = parseInt(port_number, 10);
    const rawCustomer = pickCustomerLookupRaw(body);

    if (!odpParam) {
        return res.status(400).json({ success: false, message: 'ODP tidak valid' });
    }
    if (!Number.isFinite(port) || port < 1) {
        return res.status(400).json({ success: false, message: 'Nomor port tidak valid' });
    }
    if (rawCustomer === undefined || rawCustomer === null || String(rawCustomer).trim() === '') {
        return res.status(400).json({ success: false, message: 'Pelanggan wajib dipilih' });
    }

    db.get(
        `SELECT id, latitude, longitude FROM odps WHERE id = ? OR code = ? OR name = ? LIMIT 1`,
        [odpParam, odpParam, odpParam],
        (errOdp, odpRow) => {
            if (errOdp) {
                return res.status(500).json({ success: false, message: errOdp.message });
            }
            if (!odpRow) {
                return res.status(404).json({ success: false, message: 'ODP tidak ditemukan' });
            }
            const odpIntId = odpRow.id;

            const resolveCustomerPk = (cb) => {
                let s = String(rawCustomer).trim();
                const dotZero = /^(-?\d+)\.0+$/.exec(s);
                if (dotZero) s = dotZero[1];

                const tryByPrimaryKey = (cb2) => {
                    let idInt = null;
                    if (typeof rawCustomer === 'number' && Number.isFinite(rawCustomer) && Math.floor(rawCustomer) === rawCustomer) {
                        idInt = Math.floor(rawCustomer);
                    } else if (/^-?\d+$/.test(s)) {
                        idInt = parseInt(s, 10);
                    }
                    if (idInt == null || !Number.isFinite(idInt) || idInt < 1) {
                        return process.nextTick(() => cb2(null, null));
                    }
                    db.get('SELECT id FROM customers WHERE id = ?', [idInt], (e0, rowById) => {
                        if (e0) return cb2(e0);
                        return cb2(null, rowById);
                    });
                };

                tryByPrimaryKey((e0, rowById) => {
                    if (e0) return cb(e0);
                    if (rowById) return cb(null, rowById);
                    db.get(
                        `SELECT id FROM customers
                         WHERE LOWER(TRIM(COALESCE(CAST(customer_id AS TEXT), ''))) = LOWER(TRIM(?))
                            OR CAST(id AS TEXT) = ?
                            OR phone = ?
                            OR REPLACE(REPLACE(phone, ' ', ''), '-', '') = REPLACE(REPLACE(?, ' ', ''), '-', '')
                            OR username = ?
                            OR pppoe_username = ?
                         LIMIT 1`,
                        [s, s, s, s, s, s],
                        cb
                    );
                });
            };

            resolveCustomerPk((errC, custRow) => {
                if (errC) {
                    return res.status(500).json({ success: false, message: errC.message });
                }
                if (!custRow) {
                    return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
                }
                const custIntId = custRow.id;

                db.get('SELECT id FROM cable_routes WHERE customer_id = ?', [custIntId], (err, existing) => {
                    if (err) {
                        return res.status(500).json({ success: false, message: err.message });
                    }
                    if (existing) {
                        return res.status(400).json({ success: false, message: 'Pelanggan sudah punya jalur kabel' });
                    }

                    const notesVal = notes != null ? String(notes) : '';
                    const typeVal = (cable_type && String(cable_type).trim()) || 'Fiber Optic';

                    const runInsert = (lengthMeters) => {
                        db.run(
                            `INSERT INTO cable_routes (customer_id, odp_id, cable_length, cable_type, port_number, status, notes)
                             VALUES (?, ?, ?, ?, ?, 'connected', ?)`,
                            [custIntId, odpIntId, lengthMeters, typeVal, port, notesVal],
                            function (e2) {
                                if (e2) {
                                    return res.status(500).json({ success: false, message: e2.message });
                                }
                                db.run(
                                    "UPDATE odps SET used_ports = (SELECT COUNT(*) FROM cable_routes WHERE odp_id = ? AND status = \"connected\"), updated_at = datetime('now','localtime') WHERE id = ?",
                                    [odpIntId, odpIntId],
                                    () => res.json({ success: true, message: 'Jalur kabel / port berhasil dipasangkan' })
                                );
                            }
                        );
                    };

                    if (cable_length != null && String(cable_length).trim() !== '') {
                        const len = parseFloat(cable_length);
                        return runInsert(Number.isFinite(len) ? len : 0);
                    }

                    db.get(
                        'SELECT latitude, longitude FROM customers WHERE id = ?',
                        [custIntId],
                        (e3, customer) => {
                            if (e3) {
                                return res.status(500).json({ success: false, message: e3.message });
                            }
                            let len = 0;
                            if (
                                customer &&
                                odpRow &&
                                customer.latitude != null &&
                                customer.longitude != null &&
                                odpRow.latitude != null &&
                                odpRow.longitude != null
                            ) {
                                len = CableNetworkUtils.calculateCableDistance(
                                    { latitude: customer.latitude, longitude: customer.longitude },
                                    { latitude: odpRow.latitude, longitude: odpRow.longitude }
                                );
                            }
                            runInsert(len);
                        }
                    );
                });
            });
        }
    );
});

// --- Kolektor (Field Collector app) — notifikasi in-app ---
router.get('/collector/notifications', verifyToken, requireCollector, (req, res) => {
    const collectorId = parseCollectorId(req);
    if (!Number.isFinite(collectorId)) {
        return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
    }
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    db.get(
        `SELECT COUNT(*) AS c FROM collector_field_notifications
         WHERE collector_id = ? AND read_at IS NULL`,
        [collectorId],
        (e1, countRow) => {
            if (e1) {
                logger.error('[mobile-adapter] collector/notifications count:', e1);
                return res.status(500).json({ success: false, message: e1.message });
            }
            const unread_count = countRow ? countRow.c : 0;
            db.all(
                `SELECT id, collector_id, kind, ref_id, title, body, read_at, created_at
                 FROM collector_field_notifications
                 WHERE collector_id = ?
                 ORDER BY datetime(created_at) DESC
                 LIMIT ?`,
                [collectorId, limit],
                (e2, rows) => {
                    if (e2) {
                        logger.error('[mobile-adapter] collector/notifications list:', e2);
                        return res.status(500).json({ success: false, message: e2.message });
                    }
                    const items = (rows || []).map((r) => ({
                        id: r.id,
                        kind: r.kind,
                        ref_id: r.ref_id,
                        title: r.title,
                        body: r.body,
                        read_at: r.read_at,
                        created_at: r.created_at,
                        unread: !r.read_at
                    }));
                    res.json({ success: true, data: { items, unread_count } });
                }
            );
        }
    );
});

router.post('/collector/notifications/:notifId/read', verifyToken, requireCollector, (req, res) => {
    const collectorId = parseCollectorId(req);
    const nid = parseInt(req.params.notifId, 10);
    if (!Number.isFinite(collectorId) || !Number.isFinite(nid)) {
        return res.status(400).json({ success: false, message: 'Data tidak valid' });
    }
    db.run(
        `UPDATE collector_field_notifications SET read_at = datetime('now','localtime')
         WHERE id = ? AND collector_id = ?`,
        [nid, collectorId],
        function (err) {
            if (err) {
                return res.status(500).json({ success: false, message: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ success: false, message: 'Notifikasi tidak ditemukan' });
            }
            res.json({ success: true, message: 'Ditandai dibaca' });
        }
    );
});

router.post('/collector/notifications/read-all', verifyToken, requireCollector, (req, res) => {
    const collectorId = parseCollectorId(req);
    if (!Number.isFinite(collectorId)) {
        return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
    }
    db.run(
        `UPDATE collector_field_notifications SET read_at = datetime('now','localtime')
         WHERE collector_id = ? AND read_at IS NULL`,
        [collectorId],
        function (err) {
            if (err) {
                return res.status(500).json({ success: false, message: err.message });
            }
            res.json({ success: true, message: 'Semua ditandai dibaca', updated: this.changes });
        }
    );
});

router.get('/collector/overview', verifyToken, requireCollector, async (req, res) => {
    const collectorId = parseCollectorId(req);
    if (!collectorId) {
        return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
    }
    const month = req.query.month != null && req.query.month !== '' ? String(req.query.month) : null;
    const year = req.query.year != null && req.query.year !== '' ? String(req.query.year) : null;
    try {
        const [collector, dashboardStats, allMappedCustomers] = await Promise.all([
            billingManager.getCollectorById(collectorId),
            billingManager.getCollectorDashboardStats(collectorId, month, year),
            billingManager.getCollectorCustomers(collectorId)
        ]);
        const list = allMappedCustomers || [];
        const totalPelangganAktif = list.length;
        const belumBayarCount = list.filter((c) => matchesAdminBelumLunasFromPaymentStatus(c)).length;
        const lunasCount = list.filter((c) => matchesAdminLunasFromPaymentStatus(c)).length;
        const isolirCount = list.filter((c) => collectorCustomerIsIsolir(c)).length;
        const priorityCustomers = list
            .filter((c) => matchesAdminBelumLunasFromPaymentStatus(c) && !collectorCustomerIsIsolir(c))
            .slice(0, 5)
            .map((c) => ({
                id: c.id,
                name: c.name,
                address: c.address || '-',
                amount: Math.round(parseFloat(c.package_price || 0)),
                payment_status: c.payment_status
            }));

        const targetMonth = Math.round(parseFloat(dashboardStats.tagihan?.total || 0));
        const terkumpul = Math.round(
            parseFloat((dashboardStats.tagihanLunas?.total ?? dashboardStats.lunas?.total) || 0)
        );
        const progressPct = targetMonth > 0 ? Math.min(100, Math.round((terkumpul / targetMonth) * 100)) : 0;
        const sisaTarget = Math.max(0, targetMonth - terkumpul);

        const areaRows = await new Promise((resolve, reject) => {
            db.all(
                'SELECT DISTINCT area FROM collector_areas WHERE collector_id = ? AND area IS NOT NULL AND area != "" LIMIT 8',
                [collectorId],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
        const areaLabel =
            areaRows.map((r) => r.area).filter(Boolean).join(', ') ||
            collector?.address ||
            'Wilayah penugasan';

        res.json({
            success: true,
            data: {
                collector: sanitizeCollectorRow(collector),
                statistics: sanitizeCollectorDashboardStats(dashboardStats),
                fieldUi: {
                    totalPelangganAktif,
                    belumBayarCount,
                    lunasCount,
                    isolirCount,
                    priorityCustomers,
                    targetMonth,
                    terkumpul,
                    progressPct,
                    sisaTarget,
                    areaLabel,
                    displayDate: new Date().toLocaleDateString('id-ID', {
                        weekday: 'long',
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric'
                    })
                }
            }
        });
    } catch (error) {
        logger.error('[mobile-adapter] collector/overview', error);
        res.status(500).json({ success: false, message: error.message || 'Gagal memuat' });
    }
});

router.get('/collector/areas', verifyToken, requireCollector, (req, res) => {
    const collectorId = parseCollectorId(req);
    if (!collectorId) {
        return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
    }
    db.all(
        `SELECT DISTINCT area FROM collector_areas
         WHERE collector_id = ? AND area IS NOT NULL AND TRIM(area) != ''
         ORDER BY area ASC`,
        [collectorId],
        (err, rows) => {
            if (err) {
                logger.error('[mobile-adapter] collector/areas', err);
                return res.status(500).json({ success: false, message: err.message });
            }
            const data = (rows || []).map((r) => ({ area: String(r.area).trim() }));
            res.json({ success: true, data });
        }
    );
});

router.get('/collector/customers', verifyToken, requireCollector, async (req, res) => {
    const collectorId = parseCollectorId(req);
    if (!collectorId) {
        return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
    }
    const statusFilter = (req.query.status || '').toString().toLowerCase();
    const q = (req.query.q || '').toString();
    const areaFilter = (req.query.area || '').toString();
    try {
        const allMappedCustomers = await billingManager.getCollectorCustomers(collectorId);
        const rows = filterCollectorCustomersForMobile(allMappedCustomers, statusFilter, q, areaFilter);
        const data = rows.map((c) => ({
            id: c.id,
            customer_id: c.customer_id != null && c.customer_id !== '' ? String(c.customer_id) : null,
            username: c.username != null ? String(c.username) : '',
            name: c.name,
            address: c.address || '',
            area: resolveCustomerAreaLabel(c),
            area_id:
                c.area_id != null && c.area_id !== '' && !Number.isNaN(Number(c.area_id))
                    ? Number(c.area_id)
                    : null,
            phone: c.phone || '',
            email: c.email || '',
            status: c.status,
            payment_status: c.payment_status,
            package_price: Math.round(parseFloat(c.package_price || 0)),
            package_name: c.package_name || '',
            latitude:
                c.latitude != null && c.latitude !== '' && !Number.isNaN(parseFloat(c.latitude))
                    ? parseFloat(c.latitude)
                    : null,
            longitude:
                c.longitude != null && c.longitude !== '' && !Number.isNaN(parseFloat(c.longitude))
                    ? parseFloat(c.longitude)
                    : null,
            pppoe_username: c.pppoe_username != null ? String(c.pppoe_username) : '',
            pppoe_profile: c.pppoe_profile != null ? String(c.pppoe_profile) : '',
            router_name: c.router_name != null ? String(c.router_name) : ''
        }));
        attachAreaNamesFromMaster(data, (areaErr, enriched) => {
            if (areaErr) {
                logger.error('[mobile-adapter] collector/customers area', areaErr);
                return res.status(500).json({ success: false, message: areaErr.message || 'Gagal memuat' });
            }
            res.json({ success: true, data: enriched });
        });
    } catch (error) {
        logger.error('[mobile-adapter] collector/customers', error);
        res.status(500).json({ success: false, message: error.message || 'Gagal memuat' });
    }
});

router.get('/collector/settlement', verifyToken, requireCollector, async (req, res) => {
    const collectorId = parseCollectorId(req);
    if (!collectorId) {
        return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
    }
    try {
        const [payments, dashboardStats] = await Promise.all([
            billingManager.getCollectorAllPayments(collectorId),
            billingManager.getCollectorDashboardStats(collectorId)
        ]);
        const s = dashboardStats.setoran || {};
        const sudahSetor = Math.round(parseFloat(s.sudah_setor || 0));
        const belumSetor = Math.round(parseFloat(s.belum_setor || 0));
        const totalHarusSetor = sudahSetor + belumSetor;
        const setoranProgressPct =
            totalHarusSetor > 0 ? Math.min(100, Math.round((sudahSetor / totalHarusSetor) * 100)) : 0;
        const paymentsSafe = (payments || []).slice(0, 100).map((p) => sanitizeCollectorPaymentRow(p));
        res.json({
            success: true,
            data: {
                setoranUi: { sudahSetor, belumSetor, totalHarusSetor, setoranProgressPct },
                payments: paymentsSafe
            }
        });
    } catch (error) {
        logger.error('[mobile-adapter] collector/settlement', error);
        res.status(500).json({ success: false, message: error.message || 'Gagal memuat' });
    }
});

router.get('/collector/me', verifyToken, requireCollector, async (req, res) => {
    const collectorId = parseCollectorId(req);
    if (!collectorId) {
        return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
    }
    try {
        const row = await new Promise((resolve, reject) => {
            db.get(
                'SELECT id, name, phone, email, address, commission_rate, status, created_at FROM collectors WHERE id = ?',
                [collectorId],
                (err, r) => (err ? reject(err) : resolve(r))
            );
        });
        if (!row) {
            return res.status(404).json({ success: false, message: 'Kolektor tidak ditemukan' });
        }
        const [dashboardStats, allPayments, monthlyCommission] = await Promise.all([
            billingManager.getCollectorDashboardStats(collectorId),
            billingManager.getCollectorAllPayments(collectorId),
            (async () => {
                const now = new Date();
                return billingManager.getCollectorMonthlyCommission(
                    collectorId,
                    now.getFullYear(),
                    now.getMonth() + 1
                );
            })()
        ]);
        const statsSafe = sanitizeCollectorDashboardStats(dashboardStats);
        const tagCount = parseInt(statsSafe.tagihan?.count || 0, 10) || 0;
        const paidDistinct = parseInt(statsSafe.lunas?.count || 0, 10) || 0;
        const successRate = tagCount > 0 ? Math.min(100, Math.round((paidDistinct / tagCount) * 100)) : 0;
        const totalCollections = (allPayments || []).filter((p) => p.status === 'completed').length;
        res.json({
            success: true,
            data: {
                ...row,
                profileStats: {
                    successRate,
                    totalCollections,
                    monthlyCommission: Math.round(parseFloat(monthlyCommission || 0))
                }
            }
        });
    } catch (error) {
        logger.error('[mobile-adapter] collector/me', error);
        res.status(500).json({ success: false, message: error.message || 'Gagal memuat' });
    }
});

router.put('/collector/me', verifyToken, requireCollector, async (req, res) => {
    const collectorId = parseCollectorId(req);
    if (!collectorId) {
        return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
    }
    const body = req.body || {};
    const name = body.name != null ? String(body.name).trim() : '';
    const phone = body.phone != null ? String(body.phone).trim() : '';
    const email = body.email != null ? String(body.email).trim() : '';
    const address = body.address != null ? String(body.address).trim() : '';
    if (!name) {
        return res.status(400).json({ success: false, message: 'Nama wajib diisi' });
    }
    if (!phone) {
        return res.status(400).json({ success: false, message: 'Nomor HP wajib diisi' });
    }
    try {
        await new Promise((resolve, reject) => {
            db.run(
                `UPDATE collectors
                 SET name = ?, phone = ?, email = ?, address = ?, updated_at = datetime('now','localtime')
                 WHERE id = ?`,
                [name, phone, email || null, address || null, collectorId],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
        res.json({ success: true, message: 'Profil berhasil diperbarui' });
    } catch (error) {
        const msg = error && error.message ? String(error.message) : '';
        if (msg.includes('UNIQUE') && msg.toLowerCase().includes('phone')) {
            return res.status(400).json({ success: false, message: 'Nomor HP sudah dipakai kolektor lain' });
        }
        logger.error('[mobile-adapter] collector/me PUT', error);
        res.status(500).json({ success: false, message: error.message || 'Gagal menyimpan' });
    }
});

async function collectorMappedCustomerIds(collectorId) {
    const list = await billingManager.getCollectorCustomers(collectorId);
    return new Set((list || []).map((c) => Number(c.id)));
}

router.get('/collector/customer-invoices/:customerId', verifyToken, requireCollector, async (req, res) => {
    const collectorId = parseCollectorId(req);
    if (!collectorId) {
        return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
    }
    const customerId = parseInt(String(req.params.customerId), 10);
    if (!Number.isFinite(customerId) || customerId <= 0) {
        return res.status(400).json({ success: false, message: 'ID pelanggan tidak valid' });
    }
    try {
        const allowed = await collectorMappedCustomerIds(collectorId);
        if (!allowed.has(customerId)) {
            return res.status(403).json({ success: false, message: 'Pelanggan tidak ada di wilayah Anda' });
        }
        const invoices = await new Promise((resolve, reject) => {
            db.all(
                `SELECT i.*, p.name as package_name
                 FROM invoices i
                 LEFT JOIN packages p ON i.package_id = p.id
                 WHERE i.customer_id = ? AND i.status = 'unpaid'
                 ORDER BY i.created_at DESC`,
                [customerId],
                (err, rows) => (err ? reject(err) : resolve(rows || []))
            );
        });
        res.json({ success: true, data: invoices });
    } catch (error) {
        logger.error('[mobile-adapter] collector/customer-invoices', error);
        res.status(500).json({ success: false, message: error.message || 'Gagal memuat' });
    }
});

router.get('/collector/customer-invoice-history/:customerId', verifyToken, requireCollector, async (req, res) => {
    const collectorId = parseCollectorId(req);
    if (!collectorId) {
        return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
    }
    const customerId = parseInt(String(req.params.customerId), 10);
    if (!Number.isFinite(customerId) || customerId <= 0) {
        return res.status(400).json({ success: false, message: 'ID pelanggan tidak valid' });
    }
    try {
        const allowed = await collectorMappedCustomerIds(collectorId);
        if (!allowed.has(customerId)) {
            return res.status(403).json({ success: false, message: 'Pelanggan tidak ada di wilayah Anda' });
        }
        const rows = await new Promise((resolve, reject) => {
            db.all(
                `SELECT i.*, p.name as package_name
                 FROM invoices i
                 LEFT JOIN packages p ON i.package_id = p.id
                 WHERE i.customer_id = ?
                   AND strftime('%Y', i.created_at) = strftime('%Y', 'now', 'localtime')
                 ORDER BY i.created_at DESC
                 LIMIT 240`,
                [customerId],
                (err, r) => (err ? reject(err) : resolve(r || []))
            );
        });
        res.json({ success: true, data: rows });
    } catch (error) {
        logger.error('[mobile-adapter] collector/customer-invoice-history', error);
        res.status(500).json({ success: false, message: error.message || 'Gagal memuat' });
    }
});

router.get('/collector/customer-ppp-session/:customerId', verifyToken, requireCollector, async (req, res) => {
    const collectorId = parseCollectorId(req);
    if (!collectorId) {
        return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
    }
    const customerId = parseInt(String(req.params.customerId), 10);
    if (!Number.isFinite(customerId) || customerId <= 0) {
        return res.status(400).json({ success: false, message: 'ID pelanggan tidak valid' });
    }
    try {
        const allowed = await collectorMappedCustomerIds(collectorId);
        if (!allowed.has(customerId)) {
            return res.status(403).json({ success: false, message: 'Pelanggan tidak ada di wilayah Anda' });
        }
        const row = await new Promise((resolve, reject) => {
            db.get(
                'SELECT pppoe_username, username FROM customers WHERE id = ?',
                [customerId],
                (err, r) => (err ? reject(err) : resolve(r || null))
            );
        });
        if (!row) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }
        const login =
            (row.pppoe_username && String(row.pppoe_username).trim()) ||
            (row.username && String(row.username).trim()) ||
            '';
        const { getPppoeLoginOnlineStatus } = require('../../config/mikrotik');
        const { online, authMode } = await getPppoeLoginOnlineStatus(login);
        res.json({
            success: true,
            data: {
                online: Boolean(online),
                auth_mode: authMode || 'unknown',
                login_checked: login
            }
        });
    } catch (error) {
        logger.error('[mobile-adapter] collector/customer-ppp-session', error);
        res.status(500).json({ success: false, message: error.message || 'Gagal memuat' });
    }
});

router.post('/collector/customer-isolir/:customerId', verifyToken, requireCollector, async (req, res) => {
    const collectorId = parseCollectorId(req);
    if (!collectorId) {
        return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
    }
    const customerId = parseInt(String(req.params.customerId), 10);
    if (!Number.isFinite(customerId) || customerId <= 0) {
        return res.status(400).json({ success: false, message: 'ID pelanggan tidak valid' });
    }
    try {
        const allowed = await collectorMappedCustomerIds(collectorId);
        if (!allowed.has(customerId)) {
            return res.status(403).json({ success: false, message: 'Pelanggan tidak ada di wilayah Anda' });
        }
        const customer = await billingManager.getCustomerById(customerId);
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }
        if (String(customer.status || '')
            .toLowerCase()
            .trim() === 'suspended') {
            return res.status(400).json({ success: false, message: 'Pelanggan sudah dalam status isolir' });
        }
        const rawReason = req.body && req.body.reason != null ? String(req.body.reason).trim() : '';
        const reason =
            rawReason.length > 0
                ? rawReason.slice(0, 400)
                : 'Isolir manual oleh kolektor (peringatan)';
        const serviceSuspension = require('../../config/serviceSuspension');
        // Urutan: RADIUS/Mikrotik (profil isolir + putus sesi) → WA → baru update status DB (tanpa GenieACS/email)
        const result = await serviceSuspension.suspendCustomerService(customer, reason, {
            skipBillingStatus: true,
            awaitWhatsApp: true
        });
        if (!result || !result.success) {
            const det = result && result.results ? JSON.stringify(result.results) : '';
            logger.warn(`[mobile-adapter] isolir: gagal jaringan/WA. ${det}`);
            return res.status(502).json({
                success: false,
                message: 'Gagal menyelesaikan isolir (Mikrotik/RADIUS). Coba lagi atau hubungi admin.',
                data: { customerId, details: result && result.results }
            });
        }
        await billingManager.setCustomerStatusById(customerId, 'suspended', { skipRadiusSync: true });
        return res.json({
            success: true,
            message: 'Pelanggan diisolir; notifikasi WA dikirim bila diaktifkan.',
            data: { customerId }
        });
    } catch (error) {
        logger.error('[mobile-adapter] collector/customer-isolir', error);
        res.status(500).json({ success: false, message: error.message || 'Gagal isolir' });
    }
});

/** Normalisasi nomor HP pelanggan (format lokal 08…). */
function normalizeCustomerPhoneInput(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) return null;
    if (digits.startsWith('0')) return digits;
    if (digits.startsWith('62')) return `0${digits.slice(2)}`;
    return `0${digits}`;
}

router.patch('/collector/customers/:customerId/phone', verifyToken, requireCollector, async (req, res) => {
    const collectorId = parseCollectorId(req);
    if (!collectorId) {
        return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
    }
    const customerId = parseInt(String(req.params.customerId), 10);
    if (!Number.isFinite(customerId) || customerId <= 0) {
        return res.status(400).json({ success: false, message: 'ID pelanggan tidak valid' });
    }
    const phone = normalizeCustomerPhoneInput(req.body && req.body.phone);
    if (!phone) {
        return res.status(400).json({ success: false, message: 'Nomor HP tidak valid (min. 9 digit)' });
    }
    try {
        const allowed = await collectorMappedCustomerIds(collectorId);
        if (!allowed.has(customerId)) {
            return res.status(403).json({ success: false, message: 'Pelanggan tidak ada di wilayah Anda' });
        }
        await new Promise((resolve, reject) => {
            db.run('UPDATE customers SET phone = ? WHERE id = ?', [phone, customerId], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        res.json({ success: true, data: { phone }, message: 'Nomor HP diperbarui' });
    } catch (error) {
        logger.error('[mobile-adapter] collector/customers/phone', error);
        res.status(500).json({ success: false, message: error.message || 'Gagal menyimpan nomor HP' });
    }
});

router.patch(
    '/collector/customers/:customerId/invoices/:invoiceId/due-date',
    verifyToken,
    requireCollector,
    async (req, res) => {
        const collectorId = parseCollectorId(req);
        if (!collectorId) {
            return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
        }
        const customerId = parseInt(String(req.params.customerId), 10);
        const invoiceId = parseInt(String(req.params.invoiceId), 10);
        if (!Number.isFinite(customerId) || customerId <= 0 || !Number.isFinite(invoiceId) || invoiceId <= 0) {
            return res.status(400).json({ success: false, message: 'ID tidak valid' });
        }
        const dueDate = String((req.body && req.body.due_date) || '').trim().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
            return res.status(400).json({ success: false, message: 'Format tanggal harus YYYY-MM-DD' });
        }
        try {
            const allowed = await collectorMappedCustomerIds(collectorId);
            if (!allowed.has(customerId)) {
                return res.status(403).json({ success: false, message: 'Pelanggan tidak ada di wilayah Anda' });
            }
            const inv = await billingManager.getInvoiceById(invoiceId);
            if (!inv || Number(inv.customer_id) !== customerId) {
                return res.status(404).json({ success: false, message: 'Tagihan tidak ditemukan' });
            }
            if (String(inv.status || '').toLowerCase() === 'paid') {
                return res.status(400).json({ success: false, message: 'Tagihan sudah lunas, jatuh tempo tidak dapat diubah' });
            }
            await new Promise((resolve, reject) => {
                db.run(
                    'UPDATE invoices SET due_date = ? WHERE id = ? AND customer_id = ?',
                    [dueDate, invoiceId, customerId],
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });
            const updated = await billingManager.getInvoiceById(invoiceId);
            res.json({
                success: true,
                data: { id: invoiceId, due_date: updated.due_date },
                message: 'Jatuh tempo diperbarui'
            });
        } catch (error) {
            logger.error('[mobile-adapter] collector/customers/.../due-date', error);
            res.status(500).json({ success: false, message: error.message || 'Gagal menyimpan jatuh tempo' });
        }
    }
);

router.post(
    '/collector/payment',
    verifyToken,
    requireCollector,
    collectorPaymentMulter.single('payment_proof'),
    async (req, res) => {
        const collectorId = parseCollectorId(req);
        if (!collectorId) {
            return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
        }
        const { customer_id, payment_amount, payment_method, notes, invoice_ids, discount_amount } =
            req.body || {};
        const customerIdNum = parseInt(String(customer_id), 10);
        if (!Number.isFinite(customerIdNum) || customerIdNum <= 0) {
            return res.status(400).json({ success: false, message: 'ID pelanggan tidak valid' });
        }
        const method = (payment_method || '').toString();
        if (method === 'transfer' && !req.file) {
            return res.status(400).json({ success: false, message: 'Foto bukti transfer wajib diunggah' });
        }
        try {
            const allowed = await collectorMappedCustomerIds(collectorId);
            if (!allowed.has(customerIdNum)) {
                return res.status(403).json({ success: false, message: 'Pelanggan tidak ada di wilayah Anda' });
            }
            const paymentProof = req.file ? `/uploads/payments/${req.file.filename}` : null;
            const result = await submitCollectorPayment({
                collectorId,
                customer_id: customerIdNum,
                payment_amount,
                payment_method: method,
                notes,
                invoice_ids,
                discount_amount,
                paymentProofRelativePath: paymentProof
            });
            if (!result.ok) {
                return res.status(result.status || 400).json({ success: false, message: result.message });
            }
            res.json({
                success: true,
                message: 'Pembayaran berhasil disimpan',
                payment_id: result.payment_id,
                commission_amount: result.commission_amount
            });
        } catch (error) {
            logger.error('[mobile-adapter] collector/payment', error);
            res.status(500).json({ success: false, message: error.message || 'Gagal menyimpan' });
        }
    }
);

function collectorReceiptSettingsForMobile() {
    return {
        companyHeader: getSetting('company_header', 'ISP Monitor'),
        footerInfo: getSetting('footer_info', ''),
        logoFilename: getSetting('logo_filename', 'logo.png'),
        company_slogan: getSetting('company_slogan', ''),
        company_website: getSetting('company_website', ''),
        invoice_notes: getSetting('invoice_notes', ''),
        payment_bank_name: getSetting('payment_bank_name', ''),
        payment_account_number: getSetting('payment_account_number', ''),
        payment_account_holder: getSetting('payment_account_holder', ''),
        payment_cash_address: getSetting('payment_cash_address', ''),
        payment_cash_hours: getSetting('payment_cash_hours', ''),
        contact_phone: getSetting('contact_phone', ''),
        contact_email: getSetting('contact_email', ''),
        contact_address: getSetting('contact_address', ''),
        contact_whatsapp: getSetting('contact_whatsapp', '')
    };
}

function sanitizeInvoiceForCollectorReceipt(inv) {
    if (!inv || typeof inv !== 'object') return null;
    const n = (v) => {
        const x = Number(v);
        return Number.isFinite(x) ? x : 0;
    };
    const s = (v) => (v == null ? '' : String(v));
    return {
        id: n(inv.id),
        invoice_number: s(inv.invoice_number),
        status: s(inv.status),
        amount: n(inv.amount),
        base_amount: inv.base_amount != null && inv.base_amount !== '' ? n(inv.base_amount) : null,
        tax_rate: inv.tax_rate != null && inv.tax_rate !== '' ? n(inv.tax_rate) : null,
        created_at: s(inv.created_at),
        due_date: s(inv.due_date),
        payment_date: inv.payment_date != null ? s(inv.payment_date) : '',
        payment_method: s(inv.payment_method),
        notes: s(inv.notes),
        package_name: s(inv.package_name),
        package_speed: s(inv.package_speed),
        customer_name: s(inv.customer_name),
        customer_username: s(inv.customer_username),
        customer_phone: s(inv.customer_phone),
        customer_address: s(inv.customer_address)
    };
}

/** Resi / cetak invoice (setara /admin/billing/invoices/:id/print) untuk pelanggan di wilayah kolektor. */
async function resolveCollectorPaidReceiptInvoice(customerId, invoiceIdOptional) {
    let full = null;

    if (Number.isFinite(invoiceIdOptional) && invoiceIdOptional > 0) {
        const row = await billingManager.getInvoiceById(invoiceIdOptional);
        if (!row) {
            const err = new Error('Invoice tidak ditemukan');
            err.status = 404;
            throw err;
        }
        if (Number(row.customer_id) !== customerId) {
            const err = new Error('Invoice bukan milik pelanggan ini');
            err.status = 403;
            throw err;
        }
        if (String(row.status || '').toLowerCase() !== 'paid') {
            const err = new Error('Resi hanya untuk tagihan yang sudah lunas');
            err.status = 400;
            throw err;
        }
        full = row;
    } else {
        const list = await billingManager.getInvoicesByCustomer(customerId);
        const paid = (list || [])
            .filter((i) => String(i.status || '').toLowerCase() === 'paid')
            .sort((a, b) => {
                const ta = new Date(a.payment_date || a.updated_at || a.created_at || 0).getTime();
                const tb = new Date(b.payment_date || b.updated_at || b.created_at || 0).getTime();
                return tb - ta;
            });
        const pick = paid[0];
        if (!pick) {
            const err = new Error('Belum ada invoice lunas untuk ditampilkan sebagai resi');
            err.status = 404;
            throw err;
        }
        full = await billingManager.getInvoiceById(pick.id);
    }

    if (!full) {
        const err = new Error('Data invoice tidak tersedia');
        err.status = 404;
        throw err;
    }
    return full;
}

router.get('/collector/customers/:customerId/receipt', verifyToken, requireCollector, async (req, res) => {
    const collectorId = parseCollectorId(req);
    if (!collectorId) {
        return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
    }
    const customerId = parseInt(String(req.params.customerId), 10);
    if (!Number.isFinite(customerId) || customerId <= 0) {
        return res.status(400).json({ success: false, message: 'ID pelanggan tidak valid' });
    }
    const qInv = req.query.invoice_id != null && req.query.invoice_id !== '' ? parseInt(String(req.query.invoice_id), 10) : null;
    try {
        const allowed = await collectorMappedCustomerIds(collectorId);
        if (!allowed.has(customerId)) {
            return res.status(403).json({ success: false, message: 'Pelanggan tidak ada di wilayah Anda' });
        }

        const full = await resolveCollectorPaidReceiptInvoice(customerId, qInv);

        res.json({
            success: true,
            data: {
                invoice: sanitizeInvoiceForCollectorReceipt(full),
                settings: collectorReceiptSettingsForMobile()
            }
        });
    } catch (error) {
        logger.error('[mobile-adapter] collector/customers/.../receipt', error);
        res.status(error.status || 500).json({ success: false, message: error.message || 'Gagal memuat' });
    }
});

/** Unduh PDF invoice lunas — kolektor membagikannya lewat WhatsApp di HP. */
router.get('/collector/customers/:customerId/receipt/pdf', verifyToken, requireCollector, async (req, res) => {
    const collectorId = parseCollectorId(req);
    if (!collectorId) {
        return res.status(400).json({ success: false, message: 'ID kolektor tidak valid' });
    }
    const customerId = parseInt(String(req.params.customerId), 10);
    if (!Number.isFinite(customerId) || customerId <= 0) {
        return res.status(400).json({ success: false, message: 'ID pelanggan tidak valid' });
    }
    const qInv = req.query.invoice_id != null && req.query.invoice_id !== '' ? parseInt(String(req.query.invoice_id), 10) : null;
    try {
        const allowed = await collectorMappedCustomerIds(collectorId);
        if (!allowed.has(customerId)) {
            return res.status(403).json({ success: false, message: 'Pelanggan tidak ada di wilayah Anda' });
        }

        const full = await resolveCollectorPaidReceiptInvoice(customerId, qInv);
        const { generateInvoicePdf } = require('../../config/invoicePdf');
        const pdfResult = await generateInvoicePdf(full.id);
        if (!pdfResult || !pdfResult.buffer) {
            return res.status(500).json({ success: false, message: 'Gagal membuat PDF invoice' });
        }

        const fileName = pdfResult.fileName || `Invoice-${full.invoice_number || full.id}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '')}"`);
        res.send(pdfResult.buffer);
    } catch (error) {
        logger.error('[mobile-adapter] collector/customers/.../receipt/pdf', error);
        res.status(error.status || 500).json({ success: false, message: error.message || 'Gagal membuat PDF' });
    }
});

// --- Tagihan (placeholder aman) ---
router.get('/invoices', verifyToken, allowFieldOps, (req, res) => {
    res.json({ success: true, data: [] });
});

// --- Aksi: restart koneksi (placeholder — bisa dihubungkan ke Mikrotik nanti) ---
router.post('/action/restart', verifyToken, requireTechnician, (req, res) => {
    res.json({ success: true, message: 'Permintaan restart dicatat (otomatisasi server dapat ditambahkan)' });
});

module.exports = router;
