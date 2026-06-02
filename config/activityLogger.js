const billing = require('./billing');
const logger = require('./logger');

const db = billing.db;
let tableReady = false;

function ensureTable() {
    if (tableReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
        db.run(
            `CREATE TABLE IF NOT EXISTS activity_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_type TEXT NOT NULL DEFAULT 'admin',
                user_id TEXT,
                action TEXT NOT NULL,
                description TEXT NOT NULL,
                ip_address TEXT,
                metadata TEXT,
                created_at DATETIME DEFAULT (datetime('now','localtime'))
            )`,
            (err) => {
                if (err) return reject(err);
                db.run(`ALTER TABLE activity_logs ADD COLUMN metadata TEXT`, () => {
                    db.run(
                        `CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC)`,
                        () => {
                            tableReady = true;
                            resolve();
                        }
                    );
                });
            }
        );
    });
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return String(forwarded).split(',')[0].trim();
    }
    return req.ip || req.connection?.remoteAddress || '';
}

function getAdminUser(req) {
    return req.session?.adminUser || req.session?.adminUsername || 'admin';
}

async function logActivity({ userType = 'admin', userId, action, description, ipAddress, metadata = null }) {
    if (!action || !description) return null;
    await ensureTable();
    const metadataStr = metadata && typeof metadata === 'object' ? JSON.stringify(metadata) : metadata;
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO activity_logs (user_type, user_id, action, description, ip_address, metadata)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userType, userId || null, action, description, ipAddress || null, metadataStr],
            function onInsert(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

async function logAdminActivity(req, action, description, metadata = null) {
    try {
        return await logActivity({
            userType: 'admin',
            userId: getAdminUser(req),
            action,
            description,
            ipAddress: getClientIp(req),
            metadata
        });
    } catch (err) {
        logger.warn(`[activityLogger] Gagal mencatat log: ${err.message}`);
        return null;
    }
}

async function getActivityLogs({ page = 1, limit = 50, userType = null } = {}) {
    await ensureTable();
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (safePage - 1) * safeLimit;

    const where = userType ? 'WHERE user_type = ?' : '';
    const params = userType ? [userType] : [];

    const logs = await new Promise((resolve, reject) => {
        db.all(
            `SELECT id, user_type, user_id, action, description, ip_address, metadata, created_at
             FROM activity_logs
             ${where}
             ORDER BY datetime(created_at) DESC, id DESC
             LIMIT ? OFFSET ?`,
            [...params, safeLimit, offset],
            (err, rows) => (err ? reject(err) : resolve(rows || []))
        );
    });

    const totalRow = await new Promise((resolve, reject) => {
        db.get(
            `SELECT COUNT(*) AS total FROM activity_logs ${where}`,
            params,
            (err, row) => (err ? reject(err) : resolve(row))
        );
    });

    return {
        logs,
        page: safePage,
        limit: safeLimit,
        total: totalRow?.total || 0,
        hasMore: offset + logs.length < (totalRow?.total || 0)
    };
}

async function clearOldActivityLogs(days = 30) {
    await ensureTable();
    const safeDays = Math.max(parseInt(days, 10) || 30, 1);
    return new Promise((resolve, reject) => {
        db.run(
            `DELETE FROM activity_logs
             WHERE datetime(created_at) < datetime('now', 'localtime', ?)`,
            [`-${safeDays} days`],
            function onDelete(err) {
                if (err) reject(err);
                else resolve(this.changes || 0);
            }
        );
    });
}

/** Aturan pencatatan otomatis untuk route admin billing (POST/PUT/DELETE sukses). */
const BILLING_ACTIVITY_RULES = [
    { methods: ['POST'], pattern: /^\/customers$/, action: 'customer_create', describe: (req, body) => `Menambah pelanggan ${body.customer?.name || req.body?.name || ''}`.trim() },
    { methods: ['PUT'], pattern: /^\/customers\//, action: 'customer_update', describe: (req, body) => `Mengedit pelanggan ${body.customer?.name || req.body?.name || req.params?.phone || ''}`.trim() },
    { methods: ['DELETE'], pattern: /^\/customers\//, action: 'customer_delete', describe: (req, body) => `Menghapus pelanggan ${body.customer?.name || body.customer?.phone || req.params?.phone || req.params?.id || ''}`.trim() },
    { methods: ['POST'], pattern: /^\/customers\/bulk-delete$/, action: 'customer_bulk_delete', describe: (req, body) => `Hapus massal pelanggan (${body.summary?.success ?? body.deletedCount ?? '?'})` },
    { methods: ['POST'], pattern: /^\/customers\/[^/]+\/accept$/, action: 'customer_accept', describe: (req, body) => `Accept pelanggan ${body.customer?.name || req.params?.phone || ''}`.trim() },
    { methods: ['POST'], pattern: /^\/import\/customers\/commit\//, action: 'customer_import', describe: (req, body) => `Import pelanggan (${body.imported ?? body.created ?? body.count ?? 'batch'})` },
    { methods: ['POST'], pattern: /^\/packages$/, action: 'package_create', describe: (req, body) => `Menambah paket ${body.package?.name || req.body?.name || ''}`.trim() },
    { methods: ['PUT'], pattern: /^\/packages\//, action: 'package_update', describe: (req, body) => `Mengedit paket ${body.package?.name || req.body?.name || req.params?.id || ''}`.trim() },
    { methods: ['DELETE'], pattern: /^\/packages\//, action: 'package_delete', describe: (req, body) => `Menghapus paket ID ${req.params?.id || body.package?.id || ''}`.trim() },
    { methods: ['POST'], pattern: /^\/invoices$/, action: 'invoice_create', describe: (req, body) => `Membuat invoice ${body.invoice?.invoice_number || body.invoice_number || ''}`.trim() },
    { methods: ['PUT'], pattern: /^\/invoices\/[^/]+\/status$/, action: 'invoice_status', describe: (req, body) => `Ubah status invoice #${req.params?.id || ''} → ${body.status || req.body?.status || ''}`.trim() },
    { methods: ['PUT'], pattern: /^\/invoices\//, action: 'invoice_update', describe: (req, body) => `Mengedit invoice #${req.params?.id || body.invoice?.id || ''}`.trim() },
    { methods: ['DELETE'], pattern: /^\/invoices\//, action: 'invoice_delete', describe: (req, body) => `Menghapus invoice #${req.params?.id || ''}`.trim() },
    { methods: ['POST'], pattern: /^\/invoices\/bulk-delete$/, action: 'invoice_bulk_delete', describe: (req, body) => `Hapus massal invoice (${body.deletedCount ?? body.deleted ?? '?'})` },
    { methods: ['POST'], pattern: /^\/payments$/, action: 'payment_create', describe: (req, body) => `Catat pembayaran ${body.payment?.amount ?? req.body?.amount ?? ''}`.trim() },
    { methods: ['POST'], pattern: /^\/api\/payments\/[^/]+\/cancel$/, action: 'payment_cancel', describe: (req, body) => `Batalkan pembayaran #${req.params?.id || ''}`.trim() },
    { methods: ['POST'], pattern: /^\/service-suspension\/suspend\//, action: 'customer_suspend', describe: (req) => `Isolir pelanggan ${req.params?.username || ''}`.trim() },
    { methods: ['POST'], pattern: /^\/service-suspension\/restore\//, action: 'customer_restore', describe: (req) => `Restore pelanggan ${req.params?.username || ''}`.trim() },
    { methods: ['POST'], pattern: /^\/service-suspension\/bulk-update-due-date-by-areas$/, action: 'billing_bulk_due_date', describe: (req, body) => `Update jatuh tempo per wilayah (tgl ${body.due_day ?? '?'})`.trim() },
    { methods: ['POST'], pattern: /^\/service-suspension\/bulk-update-auto-isolir-by-areas$/, action: 'billing_bulk_isolir_day', describe: (req, body) => `Update auto isolir per wilayah (tgl ${body.auto_suspension_day ?? '?'})`.trim() },
    { methods: ['POST'], pattern: /^\/invoices\/[^/]+\/isolir$/, action: 'customer_isolir', describe: (req) => `Isolir via invoice #${req.params?.id || ''}`.trim() },
    { methods: ['POST'], pattern: /^\/invoices\/[^/]+\/restore$/, action: 'customer_restore', describe: (req) => `Restore via invoice #${req.params?.id || ''}`.trim() },
    { methods: ['POST'], pattern: /^\/areas$/, action: 'area_create', describe: (req, body) => `Menambah area ${body.area?.name || req.body?.name || ''}`.trim() },
    { methods: ['PUT'], pattern: /^\/areas\//, action: 'area_update', describe: (req, body) => `Mengedit area ${body.area?.name || req.body?.name || req.params?.id || ''}`.trim() },
    { methods: ['DELETE'], pattern: /^\/areas\//, action: 'area_delete', describe: (req) => `Menghapus area #${req.params?.id || ''}`.trim() },
    { methods: ['POST'], pattern: /^\/auto-invoice\/generate$/, action: 'invoice_generate', describe: () => 'Generate tagihan otomatis (manual trigger)' },
    { methods: ['POST'], pattern: /^\/api\/collector-payment$/, action: 'payment_collector', describe: (req, body) => `Pembayaran kolektor ${body.customer_name || body.customerName || ''}`.trim() },
    { methods: ['POST'], pattern: /^\/api\/finance-categories$/, action: 'finance_category_create', describe: (req, body) => `Tambah kategori keuangan ${body.name || req.body?.name || ''}`.trim() },
    { methods: ['PUT'], pattern: /^\/api\/finance-categories\//, action: 'finance_category_update', describe: (req) => `Edit kategori keuangan #${req.params?.id || ''}`.trim() },
    { methods: ['DELETE'], pattern: /^\/api\/finance-categories\//, action: 'finance_category_delete', describe: (req) => `Hapus kategori keuangan #${req.params?.id || ''}`.trim() },
    { methods: ['POST'], pattern: /^\/api\/expenses$/, action: 'expense_create', describe: (req, body) => `Tambah pengeluaran ${body.description || req.body?.description || ''}`.trim() },
    { methods: ['PUT'], pattern: /^\/api\/expenses\//, action: 'expense_update', describe: (req) => `Edit pengeluaran #${req.params?.id || ''}`.trim() },
    { methods: ['DELETE'], pattern: /^\/api\/expenses\//, action: 'expense_delete', describe: (req) => `Hapus pengeluaran #${req.params?.id || ''}`.trim() },
    { methods: ['POST'], pattern: /^\/api\/income$/, action: 'income_create', describe: (req, body) => `Tambah pemasukan ${body.description || req.body?.description || ''}`.trim() },
    { methods: ['PUT'], pattern: /^\/api\/income\//, action: 'income_update', describe: (req) => `Edit pemasukan #${req.params?.id || ''}`.trim() },
    { methods: ['DELETE'], pattern: /^\/api\/income\//, action: 'income_delete', describe: (req) => `Hapus pemasukan #${req.params?.id || ''}`.trim() }
];

function matchBillingActivityRule(req) {
    const path = req.path || '';
    return BILLING_ACTIVITY_RULES.find((rule) => rule.methods.includes(req.method) && rule.pattern.test(path)) || null;
}

function adminBillingActivityMiddleware(req, res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        return next();
    }
    if (!req.session?.isAdmin) {
        return next();
    }

    const originalJson = res.json.bind(res);
    res.json = function patchedJson(body) {
        if (body && body.success !== false && body.success !== 0) {
            const rule = matchBillingActivityRule(req);
            if (rule) {
                const description = rule.describe(req, body) || rule.action;
                logAdminActivity(req, rule.action, description, {
                    method: req.method,
                    path: req.path,
                    params: req.params
                }).catch(() => {});
            }
        }
        return originalJson(body);
    };

    next();
}

module.exports = {
    ensureTable,
    logActivity,
    logAdminActivity,
    getActivityLogs,
    clearOldActivityLogs,
    adminBillingActivityMiddleware,
    getAdminUser,
    getClientIp
};
