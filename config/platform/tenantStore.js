'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const bcrypt = require('bcrypt');

function newUuid() {
    return crypto.randomUUID();
}

const DB_PATH = path.join(__dirname, '../../data/billing.db');

let db = null;

function getDb() {
    if (db) return db;
    db = new sqlite3.Database(DB_PATH);
    db.run('PRAGMA foreign_keys = ON');
    return db;
}

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        getDb().run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        getDb().get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        getDb().all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function parseTenant(row) {
    if (!row) return null;
    let settings = {};
    try {
        settings = row.settings ? JSON.parse(row.settings) : {};
    } catch (_) {
        settings = {};
    }
    return { ...row, settings };
}

const RESERVED_SUBDOMAINS = new Set([
    'manage', 'management', 'api', 'www', 'admin', 'mail', 'ftp', 'cdn', 'static', 'app', 'billing',
    '__master__',
]);

function isReservedSubdomain(subdomain) {
    return RESERVED_SUBDOMAINS.has(String(subdomain || '').toLowerCase());
}

function resolveAdminCredentials(data, existing = null) {
    const username = String(data.admin_username ?? existing?.admin_username ?? 'admin').trim();
    if (!username) {
        throw new Error('Username admin tenant wajib diisi.');
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
        throw new Error('Username admin hanya boleh huruf, angka, titik, strip, dan underscore.');
    }

    const rawPassword = data.admin_password !== undefined ? String(data.admin_password).trim() : '';
    let password;
    if (rawPassword) {
        password = rawPassword;
    } else if (existing?.admin_password) {
        password = existing.admin_password;
    } else {
        password = generatePassword(12);
    }
    if (password.length < 4) {
        throw new Error('Password admin minimal 4 karakter.');
    }

    return { admin_username: username, admin_password: password };
}

function defaultTenantSettings(tenant) {
    const creds = resolveAdminCredentials(
        {
            admin_username: tenant.admin_username ?? tenant.settings?.admin_username,
            admin_password: tenant.admin_password ?? tenant.settings?.admin_password,
        },
        null
    );
    try {
        const { seedSettingsForNewTenant } = require('./tenantSettingsManager');
        const full = seedSettingsForNewTenant({
            ...tenant,
            settings: creds,
        });
        return full;
    } catch (_) {
        return {
            ...creds,
            company_header: tenant.name,
            company_name: tenant.name,
            footer_info: `© ${new Date().getFullYear()} ${tenant.name}`,
            contact_phone: tenant.owner_phone,
            server_port: process.env.PORT || '4555',
            timezone: 'Asia/Jakarta',
        };
    }
}

async function updateTenantSettings(tenantId, settingsObj) {
    await dbRun(
        `UPDATE tenants SET settings = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
        [JSON.stringify(settingsObj), tenantId]
    );
}

async function backfillTenantSettingsFromTemplate() {
    const { getFullSettingsForTenantId, saveFullSettingsForTenantId } = require('./tenantSettingsManager');
    const tenants = await dbAll('SELECT id FROM tenants WHERE deleted_at IS NULL');
    for (const row of tenants) {
        const tenant = await getTenantById(row.id);
        if (!tenant) continue;
        const keys = Object.keys(tenant.settings || {});
        if (keys.length < 15) {
            const full = await getFullSettingsForTenantId(row.id);
            await updateTenantSettings(row.id, full);
            console.log(`[tenantStore] settings backfilled for tenant #${row.id}`);
        }
    }
}

function generatePassword(length = 10) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#';
    let out = '';
    for (let i = 0; i < length; i++) {
        out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
}

async function ensurePlatformSchema() {
    const fs = require('fs');
    const migrationPath = path.join(__dirname, '../../migrations/create_saas_platform_tables.sql');
    if (!fs.existsSync(migrationPath)) return;
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
        try {
            await dbRun(stmt);
        } catch (err) {
            const msg = String(err.message || '').toLowerCase();
            if (!msg.includes('already exists') && !msg.includes('duplicate')) {
                console.warn('[tenantStore] migration warn:', err.message);
            }
        }
    }
}

async function ensureMasterTenantSchema() {
    const fs = require('fs');
    const migrationPath = path.join(__dirname, '../../migrations/add_master_tenant.sql');
    if (!fs.existsSync(migrationPath)) return;
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
        try {
            await dbRun(stmt);
        } catch (err) {
            const msg = String(err.message || '').toLowerCase();
            if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
                console.warn('[tenantStore] master tenant migration warn:', err.message);
            }
        }
    }
}

const TENANT_SCOPED_TABLES = [
    'customers', 'packages', 'invoices', 'payments', 'routers',
    'technicians', 'collectors', 'areas', 'app_settings', 'agents',
    'members', 'member_packages', 'expenses', 'income', 'odps',
    // Operasional & HR
    'installation_jobs', 'installation_job_status_history', 'trouble_reports',
    'employees', 'employee_attendance', 'employee_payroll', 'employee_leave_requests',
    'attendance_branches', 'attendance_settings', 'attendance_shifts',
    // Gudang
    'warehouse_items', 'warehouse_inbound_batches', 'warehouse_units',
    // Keuangan tambahan
    'finance_categories', 'goods_invoices', 'goods_invoice_items',
    'collector_areas', 'collector_assignments', 'collector_payments',
    'collector_remittance_receipts',
    'voucher_revenue',
    'activity_logs',
];

async function tableExists(tableName) {
    const row = await dbGet(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [tableName]
    );
    return !!row;
}

async function tableHasColumn(tableName, columnName) {
    const cols = await dbAll(`PRAGMA table_info(${tableName})`);
    return cols.some((c) => c.name === columnName);
}

async function ensureTenantIdColumns() {
    for (const table of TENANT_SCOPED_TABLES) {
        try {
            if (!(await tableExists(table))) continue;
            if (await tableHasColumn(table, 'tenant_id')) continue;
            await dbRun(`ALTER TABLE ${table} ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_${table}_tenant_id ON ${table}(tenant_id)`);
            console.log(`[tenantStore] tenant_id added → ${table}`);
        } catch (err) {
            const msg = String(err.message || '').toLowerCase();
            if (msg.includes('duplicate column')) continue;
            console.warn(`[tenantStore] tenant_id migration warn (${table}):`, err.message);
        }
    }
}

async function ensureSuperAdmin(email, password, name = 'Kalimasada Management') {
    const hash = await bcrypt.hash(password, 10);
    const existing = await dbGet('SELECT id FROM super_admins WHERE email = ?', [email]);
    if (existing) {
        await dbRun(
            `UPDATE super_admins SET password_hash = ?, name = ?, is_active = 1, updated_at = datetime('now','localtime') WHERE email = ?`,
            [hash, name, email]
        );
        return existing.id;
    }
    const result = await dbRun(
        `INSERT INTO super_admins (name, email, password_hash) VALUES (?, ?, ?)`,
        [name, email, hash]
    );
    return result.id;
}

async function verifySuperAdmin(email, password) {
    const row = await dbGet('SELECT * FROM super_admins WHERE email = ? AND is_active = 1', [email]);
    if (!row) return null;
    const ok = await bcrypt.compare(password, row.password_hash);
    return ok ? row : null;
}

async function listSubscriptionPlans() {
    return dbAll('SELECT * FROM subscription_plans WHERE is_active = 1 ORDER BY id');
}

async function listTenants({ includeDeleted = false, operationalOnly = false } = {}) {
    const clauses = [];
    if (!includeDeleted) clauses.push('t.deleted_at IS NULL');
    if (operationalOnly) clauses.push('COALESCE(t.is_master, 0) = 0');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await dbAll(
        `SELECT t.*, sp.name as plan_name, sp.code as plan_code,
                sp.max_customers, sp.max_routers, sp.max_admins
         FROM tenants t
         LEFT JOIN subscription_plans sp ON sp.id = t.subscription_plan_id
         ${where}
         ORDER BY t.id DESC`
    );
    return rows.map(parseTenant);
}

async function listOperationalTenants() {
    return listTenants({ operationalOnly: true });
}

async function getMasterTenant() {
    const row = await dbGet(
        `SELECT t.*, sp.name as plan_name, sp.code as plan_code,
                sp.max_customers, sp.max_routers, sp.max_admins
         FROM tenants t
         LEFT JOIN subscription_plans sp ON sp.id = t.subscription_plan_id
         WHERE COALESCE(t.is_master, 0) = 1 AND t.deleted_at IS NULL`
    );
    return parseTenant(row);
}

const MASTER_TENANT_SUBDOMAIN = '__master__';

async function ensureMasterTenant(data) {
    const existing = await getMasterTenant();
    if (existing) {
        throw new Error('Master tenant sudah ada.');
    }

    const settings = {
        company_header: data.name,
        company_name: data.name,
        is_master_parent: true,
    };

    const insert = await dbRun(
        `INSERT INTO tenants (
            uuid, name, subdomain, slug, owner_name, owner_email, owner_phone,
            subscription_plan_id, subscription_starts_at, subscription_ends_at,
            status, settings, is_master, provisioned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now','localtime'), datetime('now','+10 years','localtime'), 'active', ?, 1, datetime('now','localtime'))`,
        [
            newUuid(),
            data.name,
            MASTER_TENANT_SUBDOMAIN,
            MASTER_TENANT_SUBDOMAIN,
            data.owner_name,
            data.owner_email,
            data.owner_phone,
            JSON.stringify(settings),
        ]
    );

    return getTenantById(insert.id);
}

async function getTenantById(id) {
    const row = await dbGet(
        `SELECT t.*, sp.name as plan_name, sp.code as plan_code,
                sp.max_customers, sp.max_routers, sp.max_admins
         FROM tenants t
         LEFT JOIN subscription_plans sp ON sp.id = t.subscription_plan_id
         WHERE t.id = ? AND t.deleted_at IS NULL`,
        [id]
    );
    return parseTenant(row);
}

async function getTenantBySubdomain(subdomain) {
    const row = await dbGet(
        `SELECT t.*, sp.name as plan_name, sp.code as plan_code,
                sp.max_customers, sp.max_routers, sp.max_admins
         FROM tenants t
         LEFT JOIN subscription_plans sp ON sp.id = t.subscription_plan_id
         WHERE t.subdomain = ? AND t.deleted_at IS NULL`,
        [String(subdomain).toLowerCase()]
    );
    return parseTenant(row);
}

async function getTenantStats(tenantId) {
    const safeCount = async (table) => {
        if (!(await tableExists(table))) return 0;
        if (!(await tableHasColumn(table, 'tenant_id'))) return 0;
        const row = await dbGet(`SELECT COUNT(*) as c FROM ${table} WHERE tenant_id = ?`, [tenantId]);
        return row?.c || 0;
    };

    const customers = { total: 0, active: 0, inactive: 0, new: 0 };
    const invoices = { total: 0, paid: 0, unpaid: 0, isolir: 0 };

    if (await tableExists('customers') && (await tableHasColumn('customers', 'tenant_id'))) {
        const hasJoinDate = await tableHasColumn('customers', 'join_date');
        const hasCreatedAt = await tableHasColumn('customers', 'created_at');
        const joinExpr = hasJoinDate && hasCreatedAt
            ? 'COALESCE(join_date, created_at)'
            : hasJoinDate
                ? 'join_date'
                : hasCreatedAt
                    ? 'created_at'
                    : null;

        const newExpr = joinExpr
            ? `SUM(CASE WHEN strftime('%Y-%m', date(${joinExpr})) = strftime('%Y-%m', 'now') THEN 1 ELSE 0 END)`
            : '0';

        const row = await dbGet(
            `SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status IN ('active', 'suspended', 'isolir') THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END) AS inactive,
                ${newExpr} AS new_count
             FROM customers
             WHERE tenant_id = ?`,
            [tenantId]
        );

        customers.total = row?.total || 0;
        customers.active = row?.active || 0;
        customers.inactive = row?.inactive || 0;
        customers.new = row?.new_count || 0;
    }

    if (await tableExists('invoices') && (await tableHasColumn('invoices', 'tenant_id'))) {
        const hasInvoiceType = await tableHasColumn('invoices', 'invoice_type');
        const voucherExcl = hasInvoiceType
            ? "(i.invoice_type != 'voucher' OR i.invoice_type IS NULL)"
            : '1=1';
        const hasCustomerId = await tableHasColumn('invoices', 'customer_id');
        const joinCustomers = hasCustomerId ? 'LEFT JOIN customers c ON c.id = i.customer_id' : '';
        const isolirExpr = hasCustomerId
            ? "SUM(CASE WHEN i.status = 'unpaid' AND c.status IN ('suspended', 'isolir') THEN i.amount ELSE 0 END)"
            : '0';

        const row = await dbGet(
            `SELECT
                COALESCE(SUM(i.amount), 0) AS total,
                COALESCE(SUM(CASE WHEN i.status = 'paid' THEN i.amount ELSE 0 END), 0) AS paid,
                COALESCE(SUM(CASE WHEN i.status = 'unpaid' THEN i.amount ELSE 0 END), 0) AS unpaid,
                COALESCE(${isolirExpr}, 0) AS isolir
             FROM invoices i
             ${joinCustomers}
             WHERE i.tenant_id = ? AND ${voucherExcl}`,
            [tenantId]
        );

        invoices.total = row?.total || 0;
        invoices.paid = row?.paid || 0;
        invoices.unpaid = row?.unpaid || 0;
        invoices.isolir = row?.isolir || 0;
    }

    return {
        customers,
        invoices,
        routers: await safeCount('routers'),
    };
}

async function getGlobalStats() {
    const tenants = await dbGet(`SELECT COUNT(*) as total FROM tenants WHERE deleted_at IS NULL`);
    const customers = await dbGet('SELECT COUNT(*) as total FROM customers');
    return {
        totalTenants: tenants?.total || 0,
        totalCustomers: customers?.total || 0,
    };
}

async function getExtendedGlobalStats() {
    const base = await getGlobalStats();
    let totalRouters = 0;
    if (await tableExists('routers')) {
        const row = await dbGet('SELECT COUNT(*) as total FROM routers');
        totalRouters = row?.total || 0;
    }
    return {
        ...base,
        totalRouters,
    };
}

async function logProvisionStep(tenantId, step, status, errorMessage = null) {
    await dbRun(
        `INSERT INTO tenant_provisioning_logs (tenant_id, step, status, error_message, started_at, completed_at)
         VALUES (?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`,
        [tenantId, step, status, errorMessage]
    );
}

async function seedDefaultPackages(tenantId) {
    if (!(await tableHasColumn('packages', 'tenant_id'))) {
        await ensureTenantIdColumns();
    }
    const packages = [
        { name: 'Paket 10 Mbps', price: 150000, speed: '10M/10M' },
        { name: 'Paket 20 Mbps', price: 200000, speed: '20M/20M' },
        { name: 'Paket 50 Mbps', price: 350000, speed: '50M/50M' },
    ];
    for (const pkg of packages) {
        await dbRun(
            `INSERT INTO packages (name, speed, price, description, tenant_id, is_active)
             SELECT ?, ?, ?, ?, ?, 1
             WHERE NOT EXISTS (SELECT 1 FROM packages WHERE tenant_id = ? AND name = ?)`,
            [pkg.name, pkg.speed, pkg.price, `Kecepatan ${pkg.speed}`, tenantId, tenantId, pkg.name]
        );
    }
}

function releasedIdentifier(base, id) {
    const suffix = `__del_${id}`;
    const maxBase = 63 - suffix.length;
    return `${String(base).slice(0, maxBase)}${suffix}`;
}

async function purgeTenantBillingData(tenantId) {
    const tid = Number(tenantId);
    if (!Number.isFinite(tid) || tid <= 0) return;

    // Tabel junction tanpa tenant_id — hapus lewat relasi pelanggan/kolektor tenant.
    const junctionDeletes = [
        `DELETE FROM customer_router_map WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)`,
        `DELETE FROM collector_assignments WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)`,
        `DELETE FROM collector_assignments WHERE collector_id IN (SELECT id FROM collectors WHERE tenant_id = ?)`,
        `DELETE FROM collector_areas WHERE collector_id IN (SELECT id FROM collectors WHERE tenant_id = ?)`,
        `DELETE FROM collector_payments WHERE collector_id IN (SELECT id FROM collectors WHERE tenant_id = ?)`,
        `DELETE FROM collector_payments WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = ?)`,
    ];
    for (const sql of junctionDeletes) {
        if (await tableExists(sql.match(/FROM (\w+)/)?.[1] || '')) {
            try { await dbRun(sql, [tid]); } catch (_) { /* tabel opsional */ }
        }
    }

    // Urutan: child dulu (payments/invoices), lalu parent.
    const ordered = [
        'payments', 'invoices', 'customers', 'collectors', 'packages', 'routers',
        'areas', 'odps', 'expenses', 'income', 'members', 'member_packages',
        'agents', 'technicians', 'app_settings',
    ];
    for (const table of ordered) {
        if (!(await tableExists(table))) continue;
        if (!(await tableHasColumn(table, 'tenant_id'))) continue;
        await dbRun(`DELETE FROM ${table} WHERE tenant_id = ?`, [tid]);
    }

    if (await tableExists('tenant_provisioning_logs')) {
        await dbRun('DELETE FROM tenant_provisioning_logs WHERE tenant_id = ?', [tid]);
    }
}

async function releaseTenantIdentifiers(id) {
    const row = await dbGet('SELECT subdomain, slug FROM tenants WHERE id = ?', [id]);
    if (!row) return;
    const subdomain = releasedIdentifier(row.subdomain.replace(/__del_\d+$/, ''), id);
    const slug = releasedIdentifier(row.slug.replace(/__del_\d+$/, ''), id);
    await dbRun(
        `UPDATE tenants SET subdomain = ?, slug = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
        [subdomain, slug, id]
    );
}

/** Bebaskan subdomain/slug dari tenant deleted/failed agar bisa dipakai lagi. */
async function reclaimSubdomainIfStale(subdomain) {
    const stale = await dbAll(
        `SELECT id FROM tenants
         WHERE (subdomain = ? OR slug = ? OR subdomain LIKE ? OR slug LIKE ?)
           AND (deleted_at IS NOT NULL OR status IN ('failed', 'deleted'))`,
        [subdomain, subdomain, `${subdomain}__del_%`, `${subdomain}__del_%`]
    );
    for (const row of stale) {
        await releaseTenantIdentifiers(row.id);
    }
}

async function releaseDeletedTenantSlugs() {
    const rows = await dbAll(
        `SELECT id, subdomain, slug FROM tenants
         WHERE deleted_at IS NOT NULL AND subdomain NOT LIKE '%__del_%'`
    );
    for (const row of rows) {
        await releaseTenantIdentifiers(row.id);
    }
}

async function createTenant(data) {
    const subdomain = String(data.subdomain).toLowerCase().trim();
    if (isReservedSubdomain(subdomain)) {
        throw new Error(`Subdomain "${subdomain}" tidak boleh digunakan.`);
    }
    await reclaimSubdomainIfStale(subdomain);
    const dup = await dbGet(
        `SELECT id FROM tenants WHERE (subdomain = ? OR slug = ?) AND deleted_at IS NULL AND status NOT IN ('failed', 'deleted')`,
        [subdomain, subdomain]
    );
    if (dup) throw new Error('Subdomain sudah digunakan.');

    // Paket & durasi tidak diisi dari form — default Starter, tanpa batas akhir.
    const planId = data.subscription_plan_id ? Number(data.subscription_plan_id) : 1;
    const plan = await dbGet('SELECT * FROM subscription_plans WHERE id = ?', [planId]);
    if (!plan) throw new Error('Paket subscription default tidak ditemukan.');

    const endsAtSql = data.subscription_months
        ? (() => {
            const endsAt = new Date();
            endsAt.setMonth(endsAt.getMonth() + Number(data.subscription_months));
            return endsAt.toISOString().slice(0, 19).replace('T', ' ');
        })()
        : null;
    const settings = defaultTenantSettings({
        name: data.name,
        owner_email: data.owner_email,
        owner_phone: data.owner_phone,
        admin_username: data.admin_username,
        admin_password: data.admin_password,
    });

    const insert = await dbRun(
        `INSERT INTO tenants (
            uuid, name, subdomain, slug, owner_name, owner_email, owner_phone,
            subscription_plan_id, subscription_starts_at, subscription_ends_at,
            status, settings
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), ?, 'provisioning', ?)`,
        [
            newUuid(),
            data.name,
            subdomain,
            subdomain,
            data.owner_name,
            data.owner_email,
            data.owner_phone,
            planId,
            endsAtSql,
            JSON.stringify(settings),
        ]
    );

    const tenantId = insert.id;

    try {
        await logProvisionStep(tenantId, 'create_record', 'completed');
        await logProvisionStep(tenantId, 'default_packages', 'skipped');
        await logProvisionStep(tenantId, 'default_settings', 'completed');

        await dbRun(
            `UPDATE tenants SET status = 'active', provisioned_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?`,
            [tenantId]
        );
        await logProvisionStep(tenantId, 'activate', 'completed');
    } catch (err) {
        await logProvisionStep(tenantId, 'provision_failed', 'failed', err.message);
        await dbRun(`UPDATE tenants SET status = 'failed', updated_at = datetime('now','localtime') WHERE id = ?`, [tenantId]);
        throw err;
    }

    return getTenantById(tenantId);
}

async function updateTenant(id, data) {
    const tenant = await getTenantById(id);
    if (!tenant) throw new Error('Tenant tidak ditemukan.');
    if (tenant.is_master) throw new Error('Master tenant tidak bisa diedit dari halaman tenant operasional.');

    let subdomain = data.subdomain ? String(data.subdomain).toLowerCase().trim() : tenant.subdomain;
    if (isReservedSubdomain(subdomain)) {
        throw new Error(`Subdomain "${subdomain}" tidak boleh digunakan.`);
    }
    if (subdomain !== tenant.subdomain) {
        const dup = await dbGet('SELECT id FROM tenants WHERE subdomain = ? AND id != ? AND deleted_at IS NULL', [subdomain, id]);
        if (dup) throw new Error('Subdomain sudah digunakan.');
    }

    const months = data.subscription_months ? Number(data.subscription_months) : null;
    let endsAtSql = null;
    if (months) {
        const endsAt = new Date();
        endsAt.setMonth(endsAt.getMonth() + months);
        endsAtSql = endsAt.toISOString().slice(0, 19).replace('T', ' ');
    }

    const newName = data.name ?? tenant.name;
    await dbRun(
        `UPDATE tenants SET
            name = ?, subdomain = ?, slug = ?, owner_name = ?, owner_email = ?, owner_phone = ?,
            subscription_plan_id = ?,
            subscription_ends_at = COALESCE(?, subscription_ends_at),
            updated_at = datetime('now','localtime')
         WHERE id = ?`,
        [
            newName,
            subdomain,
            subdomain,
            data.owner_name ?? tenant.owner_name,
            data.owner_email ?? tenant.owner_email,
            data.owner_phone ?? tenant.owner_phone,
            data.subscription_plan_id ?? tenant.subscription_plan_id,
            endsAtSql,
            id,
        ]
    );

    const settings = { ...(tenant.settings || {}) };
    let settingsChanged = false;

    if (newName !== tenant.name || subdomain !== tenant.subdomain) {
        settings.company_header = newName;
        settings.company_name = newName;
        settings.app_name = newName;
        settingsChanged = true;
    }
    if (data.owner_phone) {
        settings.contact_phone = data.owner_phone;
        settings.contact_whatsapp = data.owner_phone;
        settingsChanged = true;
    }

    if (data.admin_username !== undefined || (data.admin_password !== undefined && String(data.admin_password).trim())) {
        const creds = resolveAdminCredentials(data, {
            admin_username: settings.admin_username,
            admin_password: settings.admin_password,
        });
        settings.admin_username = creds.admin_username;
        settings.admin_password = creds.admin_password;
        settingsChanged = true;
    }

    if (settingsChanged) {
        await updateTenantSettings(id, settings);
    }

    return getTenantById(id);
}

/**
 * Ubah HANYA username & password admin tenant (dipakai tombol edit cepat di
 * halaman detail tenant management). Login admin tenant membaca langsung dari
 * tenant.settings.admin_username / admin_password (lihat resolveLoginCredentials),
 * jadi perubahan ini langsung berlaku untuk login.
 * Jika admin_password dikosongkan, password lama dipertahankan.
 */
async function updateTenantAdminCredentials(id, { admin_username, admin_password } = {}) {
    const tenant = await getTenantById(id);
    if (!tenant) throw new Error('Tenant tidak ditemukan.');

    const creds = resolveAdminCredentials(
        { admin_username, admin_password },
        {
            admin_username: tenant.settings?.admin_username,
            admin_password: tenant.settings?.admin_password,
        }
    );

    const settings = {
        ...(tenant.settings || {}),
        admin_username: creds.admin_username,
        admin_password: creds.admin_password,
    };
    await updateTenantSettings(id, settings);
    return creds;
}

async function suspendTenant(id, reason = 'Suspended by Super Admin') {
    await dbRun(
        `UPDATE tenants SET status = 'suspended', suspended_at = datetime('now','localtime'),
         suspension_reason = ?, updated_at = datetime('now','localtime') WHERE id = ? AND deleted_at IS NULL`,
        [reason, id]
    );
    return getTenantById(id);
}

async function activateTenant(id) {
    await dbRun(
        `UPDATE tenants SET status = 'active', suspended_at = NULL, suspension_reason = NULL,
         updated_at = datetime('now','localtime') WHERE id = ? AND deleted_at IS NULL`,
        [id]
    );
    return getTenantById(id);
}

async function deleteTenant(id) {
    const row = await dbGet('SELECT is_master FROM tenants WHERE id = ? AND deleted_at IS NULL', [id]);
    if (row?.is_master) {
        throw new Error('Master tenant tidak bisa dihapus dari halaman tenant operasional.');
    }
    await purgeTenantBillingData(id);
    await releaseTenantIdentifiers(id);
    await dbRun(
        `UPDATE tenants SET status = 'deleted', deleted_at = datetime('now','localtime'),
         updated_at = datetime('now','localtime') WHERE id = ?`,
        [id]
    );
}

async function auditLog({ tenantId, actorType, actorId, action, details, ip }) {
    await dbRun(
        `INSERT INTO platform_audit_logs (tenant_id, actor_type, actor_id, action, details, ip_address)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tenantId || null, actorType, actorId || null, action, details ? JSON.stringify(details) : null, ip || null]
    );
}

async function initPlatform() {
    await ensurePlatformSchema();
    await ensureMasterTenantSchema();
    try {
        const { ensureMasterPackageSchema } = require('./masterPackageService');
        await ensureMasterPackageSchema();
    } catch (err) {
        console.warn('[tenantStore] master package schema:', err.message);
    }
    try {
        const { ensureFinanceSchema } = require('./platformFinanceService');
        await ensureFinanceSchema();
    } catch (err) {
        console.warn('[tenantStore] finance schema:', err.message);
    }
    try {
        const { ensurePlatformSettingsSchema } = require('./platformSettingsService');
        await ensurePlatformSettingsSchema();
    } catch (err) {
        console.warn('[tenantStore] platform settings schema:', err.message);
    }
    try {
        const { ensurePopSchema } = require('./popService');
        await ensurePopSchema();
    } catch (err) {
        console.warn('[tenantStore] pop schema:', err.message);
    }
    try {
        const { migrateLegacyPaymentToPlatform } = require('./paymentGatewaySync');
        await migrateLegacyPaymentToPlatform();
    } catch (err) {
        console.warn('[tenantStore] payment gateway migrate:', err.message);
    }
    await ensureTenantIdColumns();
    await releaseDeletedTenantSlugs();
    await backfillTenantSettingsFromTemplate();
    await ensureSuperAdmin('management@kalimasada', 'kalimasada123', 'Kalimasada Management');
    console.log('[platform] SaaS platform initialized');
}

module.exports = {
    initPlatform,
    listSubscriptionPlans,
    listTenants,
    listOperationalTenants,
    getMasterTenant,
    ensureMasterTenant,
    MASTER_TENANT_SUBDOMAIN,
    getTenantById,
    getTenantBySubdomain,
    getTenantStats,
    getGlobalStats,
    getExtendedGlobalStats,
    createTenant,
    updateTenant,
    updateTenantAdminCredentials,
    suspendTenant,
    activateTenant,
    deleteTenant,
    verifySuperAdmin,
    auditLog,
    isReservedSubdomain,
    updateTenantSettings,
    getDb,
    dbRun,
    dbGet,
    dbAll,
};
