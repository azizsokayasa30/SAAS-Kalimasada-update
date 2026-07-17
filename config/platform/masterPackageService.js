'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const tenantStore = require('./tenantStore');

const DB_PATH = path.join(__dirname, '../../data/billing.db');

let db = null;

function getDb() {
    if (db) return db;
    db = new sqlite3.Database(DB_PATH);
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

async function ensurePackagesLimitColumns() {
    const columns = [
        'router_id INTEGER',
        'nas_ip TEXT',
        'upload_limit TEXT',
        'download_limit TEXT',
        'burst_limit_upload TEXT',
        'burst_limit_download TEXT',
        'burst_threshold TEXT',
        'burst_time TEXT',
    ];
    for (const col of columns) {
        try {
            await dbRun(`ALTER TABLE packages ADD COLUMN ${col}`);
        } catch (err) {
            const msg = String(err.message || '').toLowerCase();
            if (!msg.includes('duplicate')) throw err;
        }
    }
}

async function ensureMasterPackageSchema() {
    const fs = require('fs');
    const migrationPath = path.join(__dirname, '../../migrations/add_master_packages.sql');
    if (!fs.existsSync(migrationPath)) return;
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
        try {
            await dbRun(stmt);
        } catch (err) {
            const msg = String(err.message || '').toLowerCase();
            if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
                console.warn('[masterPackage] migration warn:', err.message);
            }
        }
    }
    await ensurePackagesLimitColumns();
}

function normalizeMasterInput(data) {
    const billingOnly = ['1', 'true', 'on', 'yes'].includes(String(data.billing_only || '').toLowerCase());
    const ppnEnabled = ['1', 'true', 'on', 'yes'].includes(String(data.ppn_enabled || '').toLowerCase());
    const parsedRate = parseFloat(data.tax_rate);
    const tax_rate = ppnEnabled
        ? (Number.isFinite(parsedRate) && parsedRate >= 0 ? parsedRate : 11)
        : 0;
    return {
        name: String(data.name || '').trim(),
        speed: String(data.speed || '').trim(),
        price: parseFloat(data.price),
        tax_rate,
        description: String(data.description || '').trim(),
        billing_only: billingOnly ? 1 : 0,
        pppoe_profile: billingOnly ? null : (String(data.pppoe_profile || 'default').trim() || 'default'),
        upload_limit: data.upload_limit ? String(data.upload_limit).trim() : null,
        download_limit: data.download_limit ? String(data.download_limit).trim() : null,
        burst_limit_upload: data.burst_limit_upload ? String(data.burst_limit_upload).trim() : null,
        burst_limit_download: data.burst_limit_download ? String(data.burst_limit_download).trim() : null,
        burst_threshold: data.burst_threshold ? String(data.burst_threshold).trim() : null,
        burst_time: data.burst_time ? String(data.burst_time).trim() : null,
        image: data.image || null,
        is_active: data.is_active === 0 || data.is_active === '0' ? 0 : 1,
    };
}

async function listMasterPackages({ includeInactive = false } = {}) {
    const where = includeInactive ? '' : 'WHERE is_active = 1';
    return dbAll(`SELECT * FROM master_packages ${where} ORDER BY price ASC, name ASC`);
}

async function getMasterPackageById(id) {
    return dbGet('SELECT * FROM master_packages WHERE id = ?', [id]);
}

async function createMasterPackage(data) {
    const p = normalizeMasterInput(data);
    if (!p.name || !p.speed || !Number.isFinite(p.price)) {
        throw new Error('Nama, kecepatan, dan harga wajib diisi.');
    }
    const result = await dbRun(
        `INSERT INTO master_packages (
            name, speed, price, tax_rate, description, pppoe_profile,
            upload_limit, download_limit, burst_limit_upload, burst_limit_download,
            burst_threshold, burst_time, billing_only, image, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            p.name, p.speed, p.price, p.tax_rate, p.description, p.pppoe_profile,
            p.upload_limit, p.download_limit, p.burst_limit_upload, p.burst_limit_download,
            p.burst_threshold, p.burst_time, p.billing_only, p.image, p.is_active,
        ]
    );
    return getMasterPackageById(result.id);
}

async function updateMasterPackage(id, data) {
    const existing = await getMasterPackageById(id);
    if (!existing) throw new Error('Master paket tidak ditemukan.');
    const p = normalizeMasterInput({ ...existing, ...data, billing_only: data.billing_only ?? existing.billing_only });
    if (!p.name || !p.speed || !Number.isFinite(p.price)) {
        throw new Error('Nama, kecepatan, dan harga wajib diisi.');
    }
    await dbRun(
        `UPDATE master_packages SET
            name = ?, speed = ?, price = ?, tax_rate = ?, description = ?, pppoe_profile = ?,
            upload_limit = ?, download_limit = ?, burst_limit_upload = ?, burst_limit_download = ?,
            burst_threshold = ?, burst_time = ?, billing_only = ?, image = COALESCE(?, image),
            is_active = ?, updated_at = datetime('now','localtime')
         WHERE id = ?`,
        [
            p.name, p.speed, p.price, p.tax_rate, p.description, p.pppoe_profile,
            p.upload_limit, p.download_limit, p.burst_limit_upload, p.burst_limit_download,
            p.burst_threshold, p.burst_time, p.billing_only, p.image,
            p.is_active, id,
        ]
    );
    await syncMasterPackageToAllSelectedTenants(id);
    return getMasterPackageById(id);
}

async function deleteMasterPackage(id) {
    const existing = await getMasterPackageById(id);
    if (!existing) throw new Error('Master paket tidak ditemukan.');
    await dbRun(
        `UPDATE master_packages SET is_active = 0, updated_at = datetime('now','localtime') WHERE id = ?`,
        [id]
    );
    await dbRun(
        `UPDATE packages SET is_active = 0 WHERE master_package_id = ?`,
        [id]
    );
    return { id, deleted: true };
}

async function syncMasterPackageToTenant(masterPackageId, tenantId) {
    await ensurePackagesLimitColumns();
    const master = await getMasterPackageById(masterPackageId);
    if (!master) throw new Error('Master paket tidak ditemukan.');

    const existing = await dbGet(
        'SELECT id FROM packages WHERE tenant_id = ? AND master_package_id = ?',
        [tenantId, masterPackageId]
    );

    const isActive = master.is_active ? 1 : 0;
    const params = [
        master.name,
        master.speed,
        master.price,
        master.tax_rate,
        master.description,
        master.pppoe_profile,
        master.image,
        master.upload_limit,
        master.download_limit,
        master.burst_limit_upload,
        master.burst_limit_download,
        master.burst_threshold,
        master.burst_time,
        isActive,
    ];

    if (existing) {
        await dbRun(
            `UPDATE packages SET
                name = ?, speed = ?, price = ?, tax_rate = ?, description = ?, pppoe_profile = ?,
                image = ?, upload_limit = ?, download_limit = ?,
                burst_limit_upload = ?, burst_limit_download = ?, burst_threshold = ?, burst_time = ?,
                is_active = ?
             WHERE id = ?`,
            [...params, existing.id]
        );
        return existing.id;
    }

    const result = await dbRun(
        `INSERT INTO packages (
            name, speed, price, tax_rate, description, pppoe_profile, image,
            upload_limit, download_limit, burst_limit_upload, burst_limit_download,
            burst_threshold, burst_time, is_active, tenant_id, master_package_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...params, tenantId, masterPackageId]
    );
    return result.id;
}

async function syncMasterPackageToAllSelectedTenants(masterPackageId) {
    const rows = await dbAll(
        'SELECT tenant_id FROM tenant_package_selections WHERE master_package_id = ? AND is_enabled = 1',
        [masterPackageId]
    );
    for (const row of rows) {
        await syncMasterPackageToTenant(masterPackageId, row.tenant_id);
    }
}

async function selectPackageForTenant(tenantId, masterPackageId) {
    await ensurePackagesLimitColumns();
    const master = await getMasterPackageById(masterPackageId);
    if (!master || !master.is_active) {
        throw new Error('Paket tidak tersedia.');
    }
    const tenant = await tenantStore.getTenantById(tenantId);
    if (!tenant || tenant.is_master) {
        throw new Error('Tenant tidak valid.');
    }
    await dbRun(
        `INSERT INTO tenant_package_selections (tenant_id, master_package_id, is_enabled)
         VALUES (?, ?, 1)
         ON CONFLICT(tenant_id, master_package_id) DO UPDATE SET is_enabled = 1`,
        [tenantId, masterPackageId]
    );
    const packageId = await syncMasterPackageToTenant(masterPackageId, tenantId);

    let syncResult = null;
    try {
        const pkg = await dbGet('SELECT * FROM packages WHERE id = ?', [packageId]);
        if (pkg && pkg.pppoe_profile != null && String(pkg.pppoe_profile).trim() !== '') {
            const { ensurePppoeProfileForPackage } = require('../mikrotik');
            syncResult = await ensurePppoeProfileForPackage(pkg);
            if (syncResult && syncResult.profileName &&
                String(syncResult.profileName).trim() !== String(pkg.pppoe_profile).trim()) {
                await dbRun(
                    'UPDATE packages SET pppoe_profile = ? WHERE id = ?',
                    [syncResult.profileName, packageId]
                );
            }
        }
    } catch (syncErr) {
        console.warn('[masterPackage] ensure PPPoE profile:', syncErr.message);
    }

    const catalog = await getTenantPackageCatalog(tenantId);
    return { catalog, syncResult };
}

async function unselectPackageForTenant(tenantId, masterPackageId) {
    await dbRun(
        `UPDATE tenant_package_selections SET is_enabled = 0
         WHERE tenant_id = ? AND master_package_id = ?`,
        [tenantId, masterPackageId]
    );
    await dbRun(
        `UPDATE packages SET is_active = 0 WHERE tenant_id = ? AND master_package_id = ?`,
        [tenantId, masterPackageId]
    );
}

async function getTenantPackageCatalog(tenantId) {
    const masters = await listMasterPackages();
    const selections = await dbAll(
        'SELECT master_package_id, is_enabled FROM tenant_package_selections WHERE tenant_id = ?',
        [tenantId]
    );
    const selMap = new Map(selections.map((s) => [s.master_package_id, s.is_enabled]));
    const tenantPackages = await dbAll(
        'SELECT * FROM packages WHERE tenant_id = ? AND master_package_id IS NOT NULL',
        [tenantId]
    );
    const pkgMap = new Map(tenantPackages.map((p) => [p.master_package_id, p]));

    return masters.map((m) => ({
        master: m,
        selected: selMap.get(m.id) === 1,
        tenantPackage: pkgMap.get(m.id) || null,
    }));
}

async function getTenantActivePackages(tenantId) {
    return dbAll(
        `SELECT p.*, mp.id AS master_id
         FROM packages p
         INNER JOIN tenant_package_selections tps
            ON tps.tenant_id = p.tenant_id AND tps.master_package_id = p.master_package_id AND tps.is_enabled = 1
         INNER JOIN master_packages mp ON mp.id = p.master_package_id AND mp.is_active = 1
         WHERE p.tenant_id = ? AND p.is_active = 1
         ORDER BY p.price ASC`,
        [tenantId]
    );
}

async function updateTenantPackageRouter(tenantId, packageId, { router_id, nas_ip, pppoe_profile }) {
    const pkg = await dbGet(
        'SELECT * FROM packages WHERE id = ? AND tenant_id = ? AND master_package_id IS NOT NULL',
        [packageId, tenantId]
    );
    if (!pkg) throw new Error('Paket tidak ditemukan atau bukan paket master.');

    await dbRun(
        `UPDATE packages SET router_id = ?, nas_ip = ?, pppoe_profile = COALESCE(?, pppoe_profile)
         WHERE id = ? AND tenant_id = ?`,
        [
            router_id ? parseInt(router_id, 10) : null,
            nas_ip ? String(nas_ip).trim() : null,
            pppoe_profile ? String(pppoe_profile).trim() : null,
            packageId,
            tenantId,
        ]
    );
    return dbGet('SELECT * FROM packages WHERE id = ?', [packageId]);
}

module.exports = {
    ensureMasterPackageSchema,
    listMasterPackages,
    getMasterPackageById,
    createMasterPackage,
    updateMasterPackage,
    deleteMasterPackage,
    selectPackageForTenant,
    unselectPackageForTenant,
    getTenantPackageCatalog,
    getTenantActivePackages,
    syncMasterPackageToTenant,
    syncMasterPackageToAllSelectedTenants,
    updateTenantPackageRouter,
    getDb,
    dbRun,
};
