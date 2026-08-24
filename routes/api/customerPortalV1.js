/**
 * REST API v1 untuk Customer Portal (React SPA).
 * Autentikasi: JWT. Data pelanggan & tagihan dari billingManager (SQLite billing existing).
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const axios = require('axios');
const { getSetting } = require('../../config/settingsManager');
const billingManager = require('../../config/billing');
const logger = require('../../config/logger');
const { createTroubleReport } = require('../../config/troubleReport');

const router = express.Router();
const JWT_SECRET = getSetting('jwt_secret', 'alijaya-billing-secret-2025');
const DEFAULT_SPEEDTEST_SERVER_URL = 'http://192.168.166.192:9090';

/** Body biner untuk ukur kecepatan upload (speedtest portal). */
const speedtestUploadRaw = express.raw({
    limit: '35mb',
    type: (req) => {
        const ct = String(req.headers['content-type'] || '').toLowerCase();
        return ct.includes('octet-stream') || ct === '' || ct === 'application/binary';
    },
});

function resolveSpeedtestServerURL() {
    const configured =
        process.env.CUSTOMER_PORTAL_SPEEDTEST_SERVER_URL ||
        getSetting('customer_portal_speedtest_server_url', '') ||
        DEFAULT_SPEEDTEST_SERVER_URL;
    return String(configured).trim().replace(/\/+$/, '');
}

function makeLibreSpeedURL(path, params = {}) {
    const url = new URL(`${resolveSpeedtestServerURL()}/${path.replace(/^\/+/, '')}`);
    Object.entries({ cors: 'true', ...params }).forEach(([key, value]) => {
        url.searchParams.set(key, String(value));
    });
    return url.toString();
}

/** Tanpa auth — untuk cek koneksi browser / reverse proxy */
router.get('/health', (req, res) => {
    res.json({ ok: true, service: 'customer-portal-v1', time: new Date().toISOString() });
});

/** Login: max N attempts per IP per menit (ringan, in-memory). */
const loginBuckets = new Map();
function rateLimitLogin(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const windowMs = 60_000;
    const max = 30;
    let b = loginBuckets.get(ip);
    if (!b || now - b.start > windowMs) {
        b = { start: now, count: 0 };
        loginBuckets.set(ip, b);
    }
    b.count += 1;
    if (b.count > max) {
        return res.status(429).json({ success: false, message: 'Terlalu banyak percobaan login. Coba lagi nanti.' });
    }
    next();
}

function sanitizeCustomer(row) {
    if (!row) return null;
    const { password: _pw, ...rest } = row;
    return rest;
}

async function findCustomerByIdentifier(identifier) {
    const raw = String(identifier || '').trim();
    if (!raw) return null;

    let row = await billingManager.getCustomerByUsername(raw);
    if (row) return row;

    row = await billingManager.getCustomerByPPPoE(raw);
    if (row) return row;

    row = await billingManager.getCustomerByPhone(raw);
    if (row) return row;

    if (/^\d+$/.test(raw)) {
        row = await billingManager.getCustomerByCustomerId(raw);
        if (row) return row;
        row = await billingManager.getCustomerById(parseInt(raw, 10));
        if (row) return row;
    }

    return new Promise((resolve, reject) => {
        billingManager.db.get(
            `SELECT c.*, p.name as package_name, p.price as package_price, p.speed as package_speed,
                    p.image as package_image, p.tax_rate, p.pppoe_profile as package_pppoe_profile
             FROM customers c
             LEFT JOIN packages p ON c.package_id = p.id
             WHERE LOWER(TRIM(COALESCE(c.email, ''))) = LOWER(?)`,
            [raw],
            (err, r) => {
                if (err) reject(err);
                else {
                    if (r && r.package_price && r.tax_rate != null) {
                        r.package_price = billingManager.calculatePriceWithTax(r.package_price, r.tax_rate);
                    }
                    resolve(r || null);
                }
            }
        );
    });
}

function invoiceDisplayStatus(inv) {
    const s = String(inv.status || '').toLowerCase().trim();
    if (s === 'paid' || s === 'lunas') return 'lunas';
    const unpaidLike = s === 'unpaid' || s === 'partial' || s === 'belum_bayar' || s === 'pending';
    if (unpaidLike && inv.due_date) {
        const due = new Date(inv.due_date);
        const todayStart = new Date(new Date().toDateString());
        if (!Number.isNaN(due.getTime()) && due < todayStart) return 'overdue';
    }
    if (unpaidLike) return 'belum_bayar';
    return s || 'unknown';
}

/** Untuk filter & badge: lunas jika status resmi paid / lunas (selaras tampilan). */
function portalInvoiceIsPaidForFilter(inv) {
    return invoiceDisplayStatus(inv) === 'lunas';
}

async function loadCustomerInvoicesForPortal(customer) {
    const limRows = 500;
    let list = await billingManager.getInvoicesByCustomerId(customer.id, limRows);
    if ((!list || list.length === 0) && customer.username) {
        try {
            list = await billingManager.getInvoices(customer.username);
        } catch (_) {
            list = [];
        }
    }
    return Array.isArray(list) ? list : [];
}

const PORTAL_GATEWAY_LABELS = {
    midtrans: 'Kartu & dompet digital (Midtrans)',
    duitku: 'Virtual Account & e-wallet (Duitku)',
    tripay: 'Channel pembayaran (Tripay)',
    xendit: 'Xendit',
};

function toIsoDate(d) {
    if (!d) return new Date().toISOString();
    const t = new Date(d);
    return Number.isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString();
}

function troubleStatusLabel(s) {
    const x = (s || '').toLowerCase();
    if (x === 'open') return 'Menunggu penanganan';
    if (x === 'in_progress') return 'Sedang ditangani';
    if (x === 'resolved' || x === 'closed') return 'Selesai';
    return 'Diperbarui';
}

/** Paket rekomendasi (upgrade/downgrade) — portal & API GET /package */
const PORTAL_PACKAGE_RECOMMENDATIONS = [
    { id: 'rec_10', name: 'PAKET 10MBPS', speed: '10 MBPS', price_label: 'Rp 100.000', price_rupiah: 100000 },
    { id: 'rec_20', name: 'PAKET 20MBPS', speed: '20 MBPS', price_label: 'Rp 150.000', price_rupiah: 150000 },
    { id: 'rec_30', name: 'PAKET 30MBPS', speed: '30 MBPS', price_label: 'Rp 200.000', price_rupiah: 200000 },
    { id: 'rec_40', name: 'PAKET 40MBPS', speed: '40 MBPS', price_label: 'Rp 300.000', price_rupiah: 300000 },
    { id: 'rec_50', name: 'PAKET 50MBPS', speed: '50 MBPS', price_label: 'Rp 350.000', price_rupiah: 350000 },
];

/** Urutan tampilan: tagihan & pembayaran di atas pengumuman admin. */
function notificationFeedTypeRank(it) {
    if (it.type === 'billing') return 0;
    if (it.type === 'payment') return 1;
    if (it.type === 'outage' || it.type === 'handling' || it.type === 'resolved') return 2;
    if (it.type === 'announcement') return 3;
    return 4;
}

/** Gabung: broadcast admin, tagihan, pembayaran, laporan gangguan (trouble_reports). */
async function buildCustomerNotificationFeed(customer) {
    const items = [];

    let broadcasts = [];
    try {
        broadcasts = await billingManager.getPortalBroadcasts(30);
    } catch (e) {
        logger.warn('[customer-portal-v1] getPortalBroadcasts', e.message);
    }
    for (const b of broadcasts) {
        items.push({
            id: `bc_${b.id}`,
            type: 'announcement',
            category: 'informasi',
            title: b.title,
            body: b.body,
            created_at: toIsoDate(b.created_at),
        });
    }

    let invoiceRows = [];
    try {
        invoiceRows = await billingManager.getPortalFeedInvoices(customer.id, customer.username, 160);
    } catch (e) {
        logger.error('[customer-portal-v1] notifications invoices (portal feed)', e);
    }
    const invoices = [...invoiceRows].sort(
        (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)
    );

    const normStatus = (s) => String(s || '').toLowerCase().trim();
    const isPaid = (inv) => {
        const s = normStatus(inv.status);
        return s === 'paid' || s === 'lunas';
    };
    const isUnpaid = (inv) => {
        if (isPaid(inv)) return false;
        const s = normStatus(inv.status);
        if (s === 'cancelled' || s === 'void' || s === 'batal') return false;
        return true;
    };

    const paid = invoices.filter((i) => isPaid(i) && i.payment_date).slice(0, 16);
    for (const inv of paid) {
        items.push({
            id: `pay_${inv.id}`,
            type: 'payment',
            category: 'pembayaran',
            title: 'Pembayaran berhasil',
            body: `Tagihan ${inv.invoice_number} sudah lunas. Terima kasih.`,
            created_at: toIsoDate(inv.payment_date),
        });
    }

    const unpaid = invoices.filter((i) => isUnpaid(i)).slice(0, 48);
    for (const inv of unpaid) {
        const ds = invoiceDisplayStatus(inv);
        const amt = Number(inv.amount || 0).toLocaleString('id-ID');
        const createdMs = inv.created_at ? new Date(inv.created_at).getTime() : 0;
        const ageOk = !Number.isNaN(createdMs) && createdMs > 0 && (Date.now() - createdMs) < 60 * 24 * 60 * 60 * 1000;

        /** Selalu pakai waktu pembuatan tagihan agar urutan + badge unread selaras (bukan tanggal jatuh tempo lama). */
        const notifCreatedAt = toIsoDate(inv.created_at || inv.due_date);
        const bodyBase = `${inv.invoice_number} · Rp ${amt}${inv.due_date ? ` · jatuh tempo ${inv.due_date}` : ''}`;

        if (ds === 'overdue') {
            items.push({
                id: `inv_od_${inv.id}`,
                type: 'billing',
                category: 'tagihan',
                title: ageOk ? 'Tagihan baru' : 'Tagihan lewat jatuh tempo',
                body: `${bodyBase}\nPerlu segera dibayar.`,
                created_at: notifCreatedAt,
            });
        } else {
            items.push({
                id: `inv_un_${inv.id}`,
                type: 'billing',
                category: 'tagihan',
                title: ageOk ? 'Tagihan baru' : 'Tagihan menunggu pembayaran',
                body: bodyBase,
                created_at: notifCreatedAt,
            });
        }
    }

    const phone = (customer.phone || '').trim();
    if (phone) {
        await new Promise((resolve) => {
            billingManager.db.all(
                `SELECT id, status, category, description, created_at, updated_at
                 FROM trouble_reports
                 WHERE TRIM(COALESCE(phone,'')) = TRIM(?)
                 ORDER BY datetime(COALESCE(updated_at, created_at)) DESC
                 LIMIT 15`,
                [phone],
                (err, rows) => {
                    if (err || !rows) {
                        if (err && !String(err.message || '').includes('no such table')) {
                            logger.warn('[customer-portal-v1] trouble_reports', err.message);
                        }
                        return resolve();
                    }
                    for (const tr of rows) {
                        const when = tr.updated_at || tr.created_at;
                        const st = (tr.status || '').toLowerCase();
                        let type = 'handling';
                        if (st === 'open') type = 'outage';
                        else if (st === 'resolved' || st === 'closed') type = 'resolved';
                        const cat = st === 'resolved' || st === 'closed' ? 'gangguan' : 'penanganan';
                        const desc = (tr.description || '').trim();
                        const short = desc.length > 160 ? `${desc.slice(0, 160)}…` : desc;
                        items.push({
                            id: `tr_${tr.id}_${st}`,
                            type,
                            category: cat,
                            title: `Laporan gangguan · ${troubleStatusLabel(tr.status)}`,
                            body: `${tr.category || 'Gangguan'}: ${short || '(tanpa keterangan)'}`,
                            created_at: toIsoDate(when),
                        });
                    }
                    resolve();
                }
            );
        });
    }

    items.sort((a, b) => {
        const ra = notificationFeedTypeRank(a);
        const rb = notificationFeedTypeRank(b);
        if (ra !== rb) return ra - rb;
        return new Date(b.created_at) - new Date(a.created_at);
    });
    const max = 120;
    if (items.length <= max) return items;
    const isMoney = (it) => it.type === 'billing' || it.type === 'payment';
    const out = [...items];
    while (out.length > max) {
        let dropIdx = -1;
        for (let i = out.length - 1; i >= 0; i -= 1) {
            if (!isMoney(out[i])) {
                dropIdx = i;
                break;
            }
        }
        if (dropIdx === -1) dropIdx = out.length - 1;
        out.splice(dropIdx, 1);
    }
    return out;
}

function signToken(customer, rememberMe) {
    const payload = {
        typ: 'customer_portal',
        sub: customer.id,
        u: customer.username,
    };
    const expiresIn = rememberMe ? '30d' : '8h';
    return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function verifyCustomerToken(req, res, next) {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) {
        return res.status(401).json({ success: false, message: 'Token tidak ada' });
    }
    try {
        const decoded = jwt.verify(m[1], JWT_SECRET);
        if (decoded.typ !== 'customer_portal' || !decoded.sub) {
            return res.status(401).json({ success: false, message: 'Token tidak valid' });
        }
        req.portal = { customerId: decoded.sub, username: decoded.u };
        next();
    } catch (e) {
        return res.status(401).json({ success: false, message: 'Token kedaluwarsa atau tidak valid' });
    }
}

async function loadCustomerForRequest(req) {
    const id = req.portal.customerId;
    const row = await billingManager.getCustomerById(id);
    return row;
}

// --- Auth ---

router.post('/auth/login', rateLimitLogin, async (req, res) => {
    try {
        const { identifier, password, rememberMe } = req.body || {};
        if (!identifier || !password) {
            return res.status(400).json({ success: false, message: 'Username / nomor layanan / email dan password wajib diisi.' });
        }

        const customer = await findCustomerByIdentifier(identifier);
        if (!customer || !customer.password) {
            return res.status(401).json({ success: false, message: 'Kredensial tidak valid.' });
        }

        // Suspended / isolated may still log in to view bills & pay; only inactive is blocked.
        const status = String(customer.status || '').toLowerCase().trim();
        const portalBlockedStatuses = new Set(['inactive', 'disabled', 'terminated', 'deleted']);
        if (status && portalBlockedStatuses.has(status)) {
            return res.status(403).json({
                success: false,
                message: 'Akun layanan tidak aktif. Hubungi admin.',
                status: customer.status,
            });
        }

        const ok = bcrypt.compareSync(password, customer.password);
        if (!ok) {
            return res.status(401).json({ success: false, message: 'Kredensial tidak valid.' });
        }

        const token = signToken(customer, !!rememberMe);
        return res.json({
            success: true,
            token,
            expiresIn: rememberMe ? '30d' : '8h',
            customer: sanitizeCustomer(customer),
        });
    } catch (err) {
        logger.error('[customer-portal-v1] login', err);
        return res.status(500).json({ success: false, message: 'Kesalahan server' });
    }
});

router.get('/auth/me', verifyCustomerToken, async (req, res) => {
    try {
        const customer = await loadCustomerForRequest(req);
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }
        return res.json({ success: true, customer: sanitizeCustomer(customer) });
    } catch (err) {
        logger.error('[customer-portal-v1] me', err);
        return res.status(500).json({ success: false, message: 'Kesalahan server' });
    }
});

/** Update terbatas: telepon, email, alamat (portal). */
router.patch('/profile', verifyCustomerToken, async (req, res) => {
    try {
        const customer = await loadCustomerForRequest(req);
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }
        const body = req.body || {};
        const phone = body.phone !== undefined ? String(body.phone).trim() : undefined;
        const email = body.email !== undefined ? String(body.email).trim() : undefined;
        const address = body.address !== undefined ? String(body.address).trim() : undefined;
        if (phone !== undefined && phone.length === 0) {
            return res.status(400).json({ success: false, message: 'Nomor telepon tidak boleh kosong.' });
        }
        if (phone !== undefined && phone.length > 48) {
            return res.status(400).json({ success: false, message: 'Nomor telepon terlalu panjang.' });
        }
        if (email !== undefined && email.length > 160) {
            return res.status(400).json({ success: false, message: 'Email terlalu panjang.' });
        }
        if (address !== undefined && address.length > 600) {
            return res.status(400).json({ success: false, message: 'Alamat terlalu panjang.' });
        }
        await billingManager.updateCustomerById(customer.id, {
            phone: phone !== undefined ? phone : customer.phone,
            email: email !== undefined ? email : customer.email,
            address: address !== undefined ? address : customer.address,
        });
        const fresh = await billingManager.getCustomerById(customer.id);
        return res.json({ success: true, customer: sanitizeCustomer(fresh) });
    } catch (err) {
        logger.error('[customer-portal-v1] profile patch', err);
        return res.status(500).json({ success: false, message: err.message || 'Gagal menyimpan profil' });
    }
});

/** Ping kecil ke server LibreSpeed lewat backend agar browser tidak kena mixed-content/CORS. */
router.get('/speedtest/ping', verifyCustomerToken, async (req, res) => {
    try {
        await axios.get(makeLibreSpeedURL('backend/empty.php', { r: Date.now() }), {
            responseType: 'arraybuffer',
            timeout: 12_000,
            headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        });
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        return res.status(204).end();
    } catch (err) {
        logger.error('[customer-portal-v1] speedtest ping', err);
        return res.status(502).json({ success: false, message: 'Server LibreSpeed tidak dapat dijangkau' });
    }
});

/** Unduh blob dari server LibreSpeed lewat backend portal. */
router.get('/speedtest/download', verifyCustomerToken, async (req, res) => {
    try {
        const maxBytes = 25 * 1024 * 1024;
        const defBytes = 5 * 1024 * 1024;
        const n = Math.min(maxBytes, Math.max(2048, parseInt(req.query.bytes, 10) || defBytes));
        const chunkSizeMb = Math.max(1, Math.ceil(n / (1024 * 1024)));
        const upstream = await axios.get(makeLibreSpeedURL('backend/garbage.php', {
            ckSize: chunkSizeMb,
            r: Date.now(),
        }), {
            responseType: 'stream',
            timeout: 120_000,
        });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        upstream.data.on('error', (streamErr) => {
            logger.error('[customer-portal-v1] speedtest download stream', streamErr);
            if (!res.headersSent) {
                res.status(502).end();
            } else {
                res.destroy(streamErr);
            }
        });
        return upstream.data.pipe(res);
    } catch (err) {
        logger.error('[customer-portal-v1] speedtest download', err);
        if (!res.headersSent) {
            return res.status(502).json({ success: false, message: 'Gagal mengambil data uji dari server LibreSpeed' });
        }
    }
});

router.post('/speedtest/upload', verifyCustomerToken, speedtestUploadRaw, async (req, res) => {
    try {
        const len = Buffer.isBuffer(req.body) ? req.body.length : 0;
        await axios.post(makeLibreSpeedURL('backend/empty.php', { r: Date.now() }), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), {
            headers: { 'Content-Type': 'application/octet-stream' },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            responseType: 'arraybuffer',
            timeout: 120_000,
        });
        return res.json({ success: true, bytes_received: len });
    } catch (err) {
        logger.error('[customer-portal-v1] speedtest upload', err);
        return res.status(502).json({ success: false, message: 'Gagal mengirim data uji ke server LibreSpeed' });
    }
});

// --- Dashboard ---

router.get('/dashboard/summary', verifyCustomerToken, async (req, res) => {
    try {
        const customer = await loadCustomerForRequest(req);
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }

        const invoices = await billingManager.getInvoices(customer.username);
        const paid = invoices.filter((i) => i.status === 'paid').length;
        const unpaid = invoices.filter((i) => i.status === 'unpaid');
        const overdue = unpaid.filter((i) => i.due_date && new Date(i.due_date) < new Date(new Date().toDateString())).length;
        const unpaid_amount_total = unpaid.reduce((sum, i) => sum + (Number(i.amount) || 0), 0);

        const latestUnpaid = unpaid
            .filter((i) => i.due_date)
            .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))[0];

        const recent = invoices.slice(0, 8).map((i) => ({
            id: i.id,
            invoice_number: i.invoice_number,
            amount: i.amount,
            status: i.status,
            display_status: invoiceDisplayStatus(i),
            due_date: i.due_date,
            created_at: i.created_at,
        }));

        const serviceStatus = customer.status === 'active' ? 'Aktif'
            : customer.status === 'suspended' ? 'Suspend'
                : (customer.status === 'isolir' || customer.status === 'isolated') ? 'Isolir'
                    : customer.status || '-';

        /** Sumber sama dengan admin /admin/billing/packages: SELECT * FROM packages + aturan PPN di packages.ejs */
        let pkg = null;
        if (customer.package_id) {
            try {
                pkg = await billingManager.getPackageById(customer.package_id);
            } catch (_) {
                pkg = null;
            }
        }

        const speedRaw = (pkg && pkg.speed != null && String(pkg.speed).trim() !== '')
            ? pkg.speed
            : (customer.package_speed || customer.speed);
        const package_speed_label = speedRaw != null && String(speedRaw).trim() !== '' ? String(speedRaw).trim() : '-';

        let package_name_display = customer.package_name || '-';
        if (pkg && pkg.name) package_name_display = pkg.name;

        let package_price_total = null;
        const baseRaw = (pkg && (pkg.price != null && pkg.price !== ''))
            ? pkg.price
            : (customer.package_price ?? customer.price);
        if (baseRaw != null && baseRaw !== '') {
            const baseNum = Number(baseRaw);
            if (!Number.isNaN(baseNum)) {
                let taxRate;
                if (pkg) {
                    if (pkg.tax_rate === 0 || pkg.tax_rate === '0') taxRate = 0;
                    else if (pkg.tax_rate != null && pkg.tax_rate !== '') taxRate = Number(pkg.tax_rate);
                    else taxRate = 11;
                } else if (customer.tax_rate === 0 || customer.tax_rate === '0') {
                    taxRate = 0;
                } else if (customer.tax_rate != null && customer.tax_rate !== '') {
                    taxRate = Number(customer.tax_rate);
                } else {
                    taxRate = 11;
                }
                package_price_total = billingManager.calculatePriceWithTax(baseNum, taxRate);
            }
        }

        const usageSeries = buildMockUsageSeries(customer.id);

        return res.json({
            success: true,
            summary: {
                customer: sanitizeCustomer(customer),
                service_status_label: serviceStatus,
                package_name: package_name_display,
                package_speed: package_speed_label,
                package_price: package_price_total,
                stats: {
                    total_invoices: invoices.length,
                    paid,
                    unpaid: unpaid.length,
                    overdue,
                    unpaid_amount_total,
                },
                next_due: latestUnpaid
                    ? { invoice_number: latestUnpaid.invoice_number, due_date: latestUnpaid.due_date, amount: latestUnpaid.amount }
                    : null,
                recent_invoices: recent,
                bandwidth_usage_sample: usageSeries,
            },
        });
    } catch (err) {
        logger.error('[customer-portal-v1] dashboard', err);
        return res.status(500).json({ success: false, message: 'Kesalahan server' });
    }
});

function buildMockUsageSeries(seedId) {
    const days = 7;
    const labels = [];
    const down = [];
    const up = [];
    const base = (Number(seedId) || 1) % 40;
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        labels.push(d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric' }));
        down.push(Math.round(20 + base + (i * 3) % 15 + Math.sin(i) * 8));
        up.push(Math.round(5 + (base / 4) + (i * 2) % 6));
    }
    return {
        note: 'Contoh visualisasi — sambungkan ke monitoring/traffic nyata untuk data aktual.',
        labels,
        download_mbps: down,
        upload_mbps: up,
    };
}

// --- Paket ---

router.get('/package', verifyCustomerToken, async (req, res) => {
    try {
        const customer = await loadCustomerForRequest(req);
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }
        let pkg = null;
        if (customer.package_id) {
            pkg = await billingManager.getPackageById(customer.package_id);
        }
        return res.json({
            success: true,
            package: pkg
                ? {
                    id: pkg.id,
                    name: pkg.name,
                    speed: pkg.speed,
                    price: pkg.price,
                    description: pkg.description || null,
                }
                : null,
            customer_snapshot: {
                package_name: customer.package_name,
                package_speed: customer.package_speed,
                package_price: customer.package_price,
                status: customer.status,
                join_date: customer.join_date,
            },
            history: [],
            recommendations: PORTAL_PACKAGE_RECOMMENDATIONS,
        });
    } catch (err) {
        logger.error('[customer-portal-v1] package', err);
        return res.status(500).json({ success: false, message: 'Kesalahan server' });
    }
});

router.post('/package-change-request', verifyCustomerToken, async (req, res) => {
    try {
        const customer = await loadCustomerForRequest(req);
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }
        const body = req.body || {};
        let target_package_name = String(body.target_package_name || '').trim();
        let target_speed = String(body.target_speed || '').trim();
        let target_price_rupiah =
            body.target_price_rupiah != null && body.target_price_rupiah !== ''
                ? parseInt(body.target_price_rupiah, 10)
                : null;
        const note = String(body.note || '').trim().slice(0, 500);

        const recId = String(body.recommendation_id || '').trim();
        if (recId) {
            const rec = PORTAL_PACKAGE_RECOMMENDATIONS.find((r) => r.id === recId);
            if (rec) {
                target_package_name = rec.name;
                target_speed = rec.speed;
                target_price_rupiah = rec.price_rupiah;
            }
        }
        if (!target_package_name) {
            return res.status(400).json({ success: false, message: 'Paket tujuan wajib dipilih atau diisi.' });
        }
        if (target_price_rupiah != null && Number.isNaN(target_price_rupiah)) {
            target_price_rupiah = null;
        }

        await billingManager.insertPortalPackageRequest({
            customer_id: customer.id,
            customer_username: customer.username,
            customer_name: customer.name,
            customer_phone: customer.phone,
            current_package_name: customer.package_name || '',
            current_speed: customer.package_speed || '',
            target_package_name,
            target_speed,
            target_price_rupiah,
            note,
        });
        logger.info(
            `[customer-portal-v1] package-change-request customer_id=${customer.id} → ${target_package_name}`
        );
        return res.json({
            success: true,
            message: 'Permintaan ubah paket telah dikirim. Admin akan meninjaunya dari dashboard.',
        });
    } catch (err) {
        logger.error('[customer-portal-v1] package-change-request', err);
        return res.status(500).json({ success: false, message: 'Gagal mengirim permintaan. Coba lagi.' });
    }
});

// --- Tagihan ---

router.get('/invoices', verifyCustomerToken, async (req, res) => {
    try {
        const customer = await loadCustomerForRequest(req);
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }

        const q = (req.query.q || '').toString().trim().toLowerCase();
        const month = (req.query.month || '').toString().trim();
        const paymentFilter = (req.query.payment || 'all').toString().trim().toLowerCase();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(5, parseInt(req.query.limit, 10) || 10));

        let list = await loadCustomerInvoicesForPortal(customer);
        list = [...list].sort((a, b) => {
            const ta = new Date(a.created_at || 0).getTime();
            const tb = new Date(b.created_at || 0).getTime();
            return tb - ta;
        });
        if (paymentFilter === 'paid' || paymentFilter === 'lunas') {
            list = list.filter((i) => portalInvoiceIsPaidForFilter(i));
        } else if (paymentFilter === 'unpaid' || paymentFilter === 'belum_bayar' || paymentFilter === 'unpaid_only') {
            list = list.filter((i) => !portalInvoiceIsPaidForFilter(i));
        }
        if (month && /^\d{4}-\d{2}$/.test(month)) {
            list = list.filter((i) => {
                if (!i.created_at) return false;
                const m = String(i.created_at).slice(0, 7);
                return m === month;
            });
        }
        if (q) {
            list = list.filter((i) => {
                const num = (i.invoice_number || '').toLowerCase();
                const idStr = String(i.id);
                return num.includes(q) || idStr.includes(q);
            });
        }

        const total = list.length;
        const offset = (page - 1) * limit;
        const slice = list.slice(offset, offset + limit).map((i) => ({
            id: i.id,
            invoice_number: i.invoice_number,
            amount: i.amount,
            status: i.status,
            display_status: invoiceDisplayStatus(i),
            due_date: i.due_date,
            created_at: i.created_at,
            payment_date: i.payment_date,
            package_name: i.package_name,
        }));

        return res.json({
            success: true,
            invoices: slice,
            pagination: { page, limit, total, total_pages: Math.ceil(total / limit) || 1 },
        });
    } catch (err) {
        logger.error('[customer-portal-v1] invoices', err);
        return res.status(500).json({ success: false, message: 'Kesalahan server' });
    }
});

router.get('/invoices/:id/payment-options', verifyCustomerToken, async (req, res) => {
    try {
        const customer = await loadCustomerForRequest(req);
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ success: false, message: 'ID invoice tidak valid' });
        }
        const invoice = await billingManager.getInvoiceById(id);
        if (!invoice || Number(invoice.customer_id) !== Number(customer.id)) {
            return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan' });
        }
        if (portalInvoiceIsPaidForFilter(invoice)) {
            return res.json({
                success: true,
                already_paid: true,
                gateways: [],
                amount: invoice.amount,
                invoice_number: invoice.invoice_number,
            });
        }
        await billingManager.paymentGateway.ensureInitialized();
        const pgm = billingManager.paymentGateway;
        const pg = pgm.settings?.payment_gateway || {};
        const keys = ['midtrans', 'duitku', 'tripay', 'xendit'];
        const gateways = [];
        for (const k of keys) {
            if (pg[k] && pg[k].enabled && pgm.gateways[k]) {
                gateways.push({
                    id: k,
                    name: PORTAL_GATEWAY_LABELS[k] || k,
                    is_default: String(pg.active || '') === k,
                });
            }
        }
        const defGw = pg.active && pgm.gateways[pg.active] ? pg.active : gateways[0]?.id || null;

        let methods = [];
        try {
            methods = await pgm.getAvailablePaymentMethods(invoice.amount);
        } catch (methodErr) {
            logger.warn('[customer-portal-v1] payment methods lookup', methodErr.message);
        }
        const portalMethods = (methods || []).map((m) => ({
            gateway: m.gateway,
            method: m.method,
            name: m.name,
            type: m.type || 'other',
            fee_customer: m.fee_customer || null,
            image_url: m.image_url || null,
        }));
        const methodsByGateway = {};
        portalMethods.forEach((m) => {
            if (!methodsByGateway[m.gateway]) methodsByGateway[m.gateway] = [];
            methodsByGateway[m.gateway].push(m);
        });

        return res.json({
            success: true,
            already_paid: false,
            amount: invoice.amount,
            invoice_number: invoice.invoice_number,
            gateways,
            default_gateway: defGw,
            methods: portalMethods,
            methods_by_gateway: methodsByGateway,
        });
    } catch (err) {
        logger.error('[customer-portal-v1] payment-options', err);
        return res.status(500).json({ success: false, message: err.message || 'Kesalahan server' });
    }
});

router.post('/invoices/:id/checkout', verifyCustomerToken, async (req, res) => {
    try {
        const customer = await loadCustomerForRequest(req);
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ success: false, message: 'ID invoice tidak valid' });
        }
        const invoice = await billingManager.getInvoiceById(id);
        if (!invoice || Number(invoice.customer_id) !== Number(customer.id)) {
            return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan' });
        }
        if (String(invoice.status || '').toLowerCase().trim() === 'paid' || portalInvoiceIsPaidForFilter(invoice)) {
            return res.status(400).json({ success: false, message: 'Invoice sudah lunas' });
        }
        const bodyGw = req.body && req.body.gateway != null ? String(req.body.gateway).toLowerCase().trim() : '';
        const bodyMethod = req.body && req.body.method != null ? String(req.body.method).trim() : '';
        if ((bodyGw === 'duitku' || bodyGw === 'tripay') && !bodyMethod) {
            return res.status(400).json({ success: false, message: 'Pilih metode pembayaran' });
        }
        const result = bodyMethod
            ? await billingManager.createOnlinePaymentWithMethod(id, bodyGw || null, bodyMethod)
            : await billingManager.createOnlinePayment(id, bodyGw || null);
        const displayMode = result.display_mode || (result.qr_string ? 'qr' : (result.va_number ? 'va' : (result.app_url || result.payment_url ? 'app' : 'redirect')));
        const inline = displayMode === 'qr' || displayMode === 'va' || displayMode === 'app';
        return res.json({
            success: true,
            inline,
            display_mode: displayMode,
            payment_url: result.payment_url,
            app_url: result.app_url || result.payment_url || null,
            qr_string: result.qr_string || null,
            qr_image: result.qr_image || null,
            va_number: result.va_number || null,
            amount: result.amount || invoice.amount,
            expiry_minutes: result.expiry_minutes || 60,
            payment_method: result.payment_method || bodyMethod || null,
            order_id: result.order_id,
            gateway: result.gateway,
            token: result.token,
            sandbox: !!result.sandbox,
        });
    } catch (err) {
        logger.error('[customer-portal-v1] checkout', err);
        return res.status(400).json({
            success: false,
            message: err && err.message ? err.message : 'Gagal membuat pembayaran',
        });
    }
});

router.get('/invoices/:id/payment-status', verifyCustomerToken, async (req, res) => {
    try {
        const customer = await loadCustomerForRequest(req);
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ success: false, message: 'ID invoice tidak valid' });
        }
        const invoice = await billingManager.getInvoiceById(id);
        if (!invoice || Number(invoice.customer_id) !== Number(customer.id)) {
            return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan' });
        }
        if (portalInvoiceIsPaidForFilter(invoice)) {
            return res.json({ success: true, paid: true, status: 'paid' });
        }
        const orderId = req.query.order_id != null ? String(req.query.order_id).trim() : '';
        if (!orderId) {
            return res.json({ success: true, paid: false, status: 'pending' });
        }
        await billingManager.paymentGateway.ensureInitialized();
        const duitku = billingManager.paymentGateway.gateways && billingManager.paymentGateway.gateways.duitku;
        if (!duitku || typeof duitku.checkTransaction !== 'function') {
            return res.json({ success: true, paid: false, status: 'pending' });
        }
        const st = await duitku.checkTransaction(orderId);
        const code = `${st.statusCode || ''}`;
        if (code === '00') {
            const merchantCode = duitku.config.merchant_code;
            const amount = String(parseInt(st.amount || invoice.amount, 10));
            const signature = duitku.hmacSha256(`${merchantCode}${amount}${orderId}`);
            await billingManager.handlePaymentWebhook({
                body: {
                    merchantCode,
                    amount,
                    merchantOrderId: orderId,
                    signature,
                    resultCode: '00',
                    paymentCode: st.paymentMethod || 'duitku',
                    reference: st.reference,
                },
            }, 'duitku');
            return res.json({ success: true, paid: true, status: 'paid' });
        }
        return res.json({
            success: true,
            paid: false,
            status: code === '02' ? 'failed' : 'pending',
            message: st.statusMessage || null,
        });
    } catch (err) {
        logger.warn('[customer-portal-v1] payment-status', err.message);
        return res.json({ success: true, paid: false, status: 'pending' });
    }
});

router.get('/invoices/:id', verifyCustomerToken, async (req, res) => {
    try {
        const customer = await loadCustomerForRequest(req);
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }

        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ success: false, message: 'ID invoice tidak valid' });
        }
        const invoice = await billingManager.getInvoiceById(id);
        if (!invoice || Number(invoice.customer_id) !== Number(customer.id)) {
            return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan' });
        }

        return res.json({
            success: true,
            invoice: {
                ...invoice,
                display_status: invoiceDisplayStatus(invoice),
            },
            pdf_hint: `Gunakan portal billing klasik untuk cetak PDF: /customer/billing/invoice/${id}`,
        });
    } catch (err) {
        logger.error('[customer-portal-v1] invoice detail', err);
        return res.status(500).json({ success: false, message: 'Kesalahan server' });
    }
});

// --- Placeholder fitur lanjutan (tiket, speedtest history, notifikasi) ---

/** Kategori laporan gangguan (sama sumbernya dengan /customer/trouble/report). */
function troubleReportCategoriesList() {
    const categoriesString = getSetting(
        'trouble_report.categories',
        'Internet Lambat,Tidak Bisa Browsing,WiFi Tidak Muncul,Koneksi Putus-Putus,Lainnya'
    );
    return categoriesString.split(',').map((c) => c.trim()).filter(Boolean);
}

router.get('/tickets/form-options', verifyCustomerToken, (req, res) => {
    try {
        return res.json({ success: true, categories: troubleReportCategoriesList() });
    } catch (err) {
        logger.error('[customer-portal-v1] tickets form-options', err);
        return res.status(500).json({ success: false, message: 'Gagal memuat formulir' });
    }
});

router.get('/tickets', verifyCustomerToken, async (req, res) => {
    try {
        const customer = await loadCustomerForRequest(req);
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }
        const phone = (customer.phone || '').trim();
        if (!phone) {
            return res.json({
                success: true,
                tickets: [],
                message: 'Lengkapi nomor telepon di profil agar riwayat laporan terhubung ke data gangguan.',
            });
        }
        const rows = await new Promise((resolve, reject) => {
            billingManager.db.all(
                `SELECT id, status, category, description, created_at, updated_at
                 FROM trouble_reports
                 WHERE TRIM(COALESCE(phone,'')) = TRIM(?)
                 ORDER BY datetime(COALESCE(updated_at, created_at)) DESC
                 LIMIT 30`,
                [phone],
                (err, r) => {
                    if (err) {
                        if (String(err.message || '').includes('no such table')) return resolve([]);
                        return reject(err);
                    }
                    resolve(r || []);
                }
            );
        });
        const tickets = rows.map((tr) => ({
            id: tr.id,
            status: tr.status,
            status_label: troubleStatusLabel(tr.status),
            category: (tr.category || '').trim(),
            description: (tr.description || '').trim(),
            created_at: tr.created_at,
            updated_at: tr.updated_at,
        }));
        return res.json({ success: true, tickets });
    } catch (err) {
        logger.error('[customer-portal-v1] tickets list', err);
        return res.status(500).json({ success: false, message: 'Gagal memuat riwayat laporan' });
    }
});

router.post('/tickets', verifyCustomerToken, async (req, res) => {
    try {
        const customer = await loadCustomerForRequest(req);
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }
        const phone = String(customer.phone || '').trim();
        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Lengkapi nomor telepon di halaman Profil sebelum melapor gangguan.',
            });
        }

        const body = req.body || {};
        const category = String(body.category || '').trim();
        const description = String(body.description || '').trim();
        const locationInput = body.location != null ? String(body.location).trim() : '';
        const location = locationInput || String(customer.address || '').trim() || '-';

        if (!category || !description) {
            return res.status(400).json({ success: false, message: 'Kategori dan deskripsi masalah wajib diisi.' });
        }
        if (description.length < 10) {
            return res.status(400).json({ success: false, message: 'Deskripsi minimal 10 karakter agar tim bisa menilai masalah.' });
        }
        if (description.length > 4000) {
            return res.status(400).json({ success: false, message: 'Deskripsi terlalu panjang (maks. 4000 karakter).' });
        }
        if (category.length > 120) {
            return res.status(400).json({ success: false, message: 'Kategori tidak valid.' });
        }

        const allowed = troubleReportCategoriesList();
        if (allowed.length > 0 && !allowed.includes(category)) {
            return res.status(400).json({ success: false, message: 'Kategori tidak valid.' });
        }

        const name = String(customer.name || customer.username || 'Pelanggan').trim() || 'Pelanggan';

        const report = await createTroubleReport({
            name,
            phone,
            location,
            category,
            description,
            customer_id: customer.id,
        });

        return res.status(201).json({
            success: true,
            message: 'Laporan berhasil dikirim ke pusat. Tim teknis dan admin akan menerima notifikasi sesuai pengaturan sistem.',
            ticket: {
                id: report.id,
                status: report.status,
                category: report.category,
                description: report.description,
                created_at: report.created_at,
            },
        });
    } catch (err) {
        logger.error('[customer-portal-v1] tickets POST', err);
        return res.status(500).json({ success: false, message: err.message || 'Gagal mengirim laporan' });
    }
});

router.get('/service-requests', verifyCustomerToken, (req, res) => {
    res.json({ success: true, requests: [] });
});

router.post('/service-requests', verifyCustomerToken, (req, res) => {
    res.status(501).json({ success: false, message: 'Workflow request layanan akan ditambahkan.' });
});

router.get('/broadcasts', verifyCustomerToken, async (req, res) => {
    try {
        const lim = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 8));
        const broadcasts = await billingManager.getPortalBroadcasts(lim);
        return res.json({ success: true, broadcasts });
    } catch (err) {
        logger.error('[customer-portal-v1] broadcasts', err);
        return res.status(500).json({ success: false, message: 'Gagal memuat informasi' });
    }
});

router.get('/notifications', verifyCustomerToken, async (req, res) => {
    try {
        const customer = await loadCustomerForRequest(req);
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }
        const items = await buildCustomerNotificationFeed(customer);
        return res.json({ success: true, items });
    } catch (err) {
        logger.error('[customer-portal-v1] notifications', err);
        return res.status(500).json({ success: false, message: 'Gagal memuat notifikasi' });
    }
});

router.post('/speedtests', verifyCustomerToken, (req, res) => {
    const { ping_ms, download_mbps, upload_mbps } = req.body || {};
    res.json({
        success: true,
        saved: {
            id: Date.now(),
            ping_ms: ping_ms || null,
            download_mbps: download_mbps || null,
            upload_mbps: upload_mbps || null,
            recorded_at: new Date().toISOString(),
        },
        message: 'Disimpan di sesi (persistensi DB dapat ditambahkan).',
    });
});

router.get('/speedtests/history', verifyCustomerToken, (req, res) => {
    res.json({ success: true, history: [] });
});

router.get('/settings/branding', async (req, res) => {
    try {
        res.json({
            success: true,
            company_header: getSetting('company_header', 'ISP'),
            company_name: getSetting('company_name', 'ISP'),
            logo_url: `/public/img/${getSetting('logo_filename', 'logo.png')}`,
        });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

module.exports = router;
