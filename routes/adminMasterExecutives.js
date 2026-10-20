/**
 * Jabatan pimpinan master tenant: Komisaris, Direktur, Wakil Direktur.
 * Akses login sama dengan admin utama. Halaman ini hanya ada di master tenant.
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const billingManager = require('../config/billing');
const { tenantSqlFromRequest, tenantIdForInsert } = require('../config/platform/tenantSqlHelpers');
const { attachTenantAppSettings } = require('../config/platform/tenantAppSettings');
const { requireFullAdmin } = require('./adminAuth');

const JABATAN = ['Komisaris', 'Direktur', 'Wakil Direktur'];

router.use(attachTenantAppSettings);
router.use(requireFullAdmin);
router.use(requireMasterTenant);

function requireMasterTenant(req, res, next) {
    const master = req.tenant && (req.tenant.is_master === 1 || req.tenant.is_master === true);
    if (master) return next();
    const wantsJson =
        req.path.startsWith('/api/') ||
        req.headers.accept?.includes('application/json') ||
        String(req.headers['content-type'] || '').includes('application/json') ||
        ['DELETE', 'PUT', 'PATCH'].includes(req.method);
    if (wantsJson) {
        return res.status(404).json({
            success: false,
            message: 'Jabatan pimpinan hanya tersedia di master tenant.',
        });
    }
    return res.status(404).render('error', {
        message: 'Jabatan pimpinan hanya tersedia di master tenant.',
        error: {},
    });
}

function tFrom(req) {
    return tenantSqlFromRequest(req);
}

function runDb(sql, params = []) {
    return new Promise((resolve, reject) => {
        billingManager.db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function getDb(sql, params = []) {
    return new Promise((resolve, reject) => {
        billingManager.db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row || null);
        });
    });
}

function allDb(sql, params = []) {
    return new Promise((resolve, reject) => {
        billingManager.db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function normalizeJabatan(value) {
    const raw = String(value || '').trim();
    return JABATAN.find((j) => j.toLowerCase() === raw.toLowerCase()) || null;
}

async function usernameTaken(username, tenantClause, excludeId = null) {
    const params = [username];
    let exclude = '';
    if (excludeId != null) {
        exclude = ' AND id != ?';
        params.push(excludeId);
    }
    const executive = await getDb(
        `SELECT id FROM master_executives WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))${exclude}${tenantClause}`,
        params
    );
    if (executive) return 'Username sudah digunakan jabatan pimpinan lain.';

    await billingManager.ensureAreaManagersTables();
    const manager = await getDb(
        `SELECT id FROM area_managers WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))${tenantClause}`,
        [username]
    );
    if (manager) return 'Username sudah digunakan Manager Area.';
    return null;
}

function conflictsAdminUsername(req, username) {
    const adminUser = String(req.tenant?.settings?.admin_username || '').trim();
    if (!adminUser) return false;
    return adminUser.toLowerCase() === String(username || '').trim().toLowerCase();
}

router.get('/', async (req, res) => {
    try {
        await billingManager.ensureMasterExecutivesTable();
        const t = tFrom(req);
        const executives = await allDb(
            `SELECT id, name, username, phone, email, jabatan, status, created_at
             FROM master_executives
             WHERE 1=1${t.and('')}
             ORDER BY
               CASE jabatan
                 WHEN 'Komisaris' THEN 1
                 WHEN 'Direktur' THEN 2
                 WHEN 'Wakil Direktur' THEN 3
                 ELSE 4
               END,
               name ASC`
        );
        res.render('admin/master-executives', {
            title: 'Jabatan Pimpinan',
            page: 'master-executives',
            appSettings: req.tenantSettings || {},
            executives,
            jabatanOptions: JABATAN,
        });
    } catch (error) {
        console.error('Error loading master executives:', error);
        res.status(500).render('error', {
            message: 'Gagal memuat jabatan pimpinan',
            error: process.env.NODE_ENV === 'development' ? error : {},
        });
    }
});

router.post('/', async (req, res) => {
    try {
        await billingManager.ensureMasterExecutivesTable();
        const t = tFrom(req);
        const name = String(req.body.name || '').trim();
        const username = String(req.body.username || '').trim();
        const phone = String(req.body.phone || '').trim() || null;
        const email = String(req.body.email || '').trim() || null;
        const jabatan = normalizeJabatan(req.body.jabatan);
        const status = ['active', 'inactive', 'suspended'].includes(req.body.status)
            ? req.body.status
            : 'active';
        const password = String(req.body.password || '');

        if (!name || !username) {
            return res.status(400).json({ success: false, message: 'Nama dan username wajib diisi' });
        }
        if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
            return res.status(400).json({
                success: false,
                message: 'Username hanya boleh huruf, angka, titik, strip, dan underscore.',
            });
        }
        if (!jabatan) {
            return res.status(400).json({
                success: false,
                message: 'Jabatan harus Komisaris, Direktur, atau Wakil Direktur.',
            });
        }
        if (!password || password.length < 6) {
            return res.status(400).json({ success: false, message: 'Password minimal 6 karakter' });
        }
        if (conflictsAdminUsername(req, username)) {
            return res.status(400).json({
                success: false,
                message: 'Username tidak boleh sama dengan admin utama.',
            });
        }

        const taken = await usernameTaken(username, t.and(''));
        if (taken) return res.status(400).json({ success: false, message: taken });

        const tenantId = tenantIdForInsert(t.tid);
        const hashed = bcrypt.hashSync(password, 10);
        const result = await runDb(
            `INSERT INTO master_executives
                (name, username, phone, email, password, jabatan, status, tenant_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, username, phone, email, hashed, jabatan, status, tenantId]
        );
        res.json({
            success: true,
            message: `${jabatan} berhasil ditambahkan`,
            id: result.lastID,
        });
    } catch (error) {
        console.error('Error creating master executive:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.put('/:id', async (req, res) => {
    try {
        await billingManager.ensureMasterExecutivesTable();
        const t = tFrom(req);
        const id = parseInt(req.params.id, 10);
        const name = String(req.body.name || '').trim();
        const username = String(req.body.username || '').trim();
        const phone = String(req.body.phone || '').trim() || null;
        const email = String(req.body.email || '').trim() || null;
        const jabatan = normalizeJabatan(req.body.jabatan);
        const status = ['active', 'inactive', 'suspended'].includes(req.body.status)
            ? req.body.status
            : 'active';
        const password = String(req.body.password || '');

        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ success: false, message: 'ID tidak valid' });
        }
        if (!name || !username) {
            return res.status(400).json({ success: false, message: 'Nama dan username wajib diisi' });
        }
        if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
            return res.status(400).json({
                success: false,
                message: 'Username hanya boleh huruf, angka, titik, strip, dan underscore.',
            });
        }
        if (!jabatan) {
            return res.status(400).json({
                success: false,
                message: 'Jabatan harus Komisaris, Direktur, atau Wakil Direktur.',
            });
        }
        if (password && password.length < 6) {
            return res.status(400).json({ success: false, message: 'Password minimal 6 karakter' });
        }
        if (conflictsAdminUsername(req, username)) {
            return res.status(400).json({
                success: false,
                message: 'Username tidak boleh sama dengan admin utama.',
            });
        }

        const row = await getDb(`SELECT id FROM master_executives WHERE id = ?${t.and('')}`, [id]);
        if (!row) {
            return res.status(404).json({ success: false, message: 'Akun jabatan tidak ditemukan' });
        }

        const taken = await usernameTaken(username, t.and(''), id);
        if (taken) return res.status(400).json({ success: false, message: taken });

        if (password) {
            const hashed = bcrypt.hashSync(password, 10);
            await runDb(
                `UPDATE master_executives
                 SET name = ?, username = ?, phone = ?, email = ?, jabatan = ?, status = ?,
                     password = ?, updated_at = datetime('now','localtime')
                 WHERE id = ?${t.and('')}`,
                [name, username, phone, email, jabatan, status, hashed, id]
            );
        } else {
            await runDb(
                `UPDATE master_executives
                 SET name = ?, username = ?, phone = ?, email = ?, jabatan = ?, status = ?,
                     updated_at = datetime('now','localtime')
                 WHERE id = ?${t.and('')}`,
                [name, username, phone, email, jabatan, status, id]
            );
        }

        if (req.session && Number(req.session.executiveId) === id) {
            req.session.executiveName = name;
            req.session.executiveJabatan = jabatan;
            req.session.adminUser = username;
        }

        res.json({ success: true, message: `${jabatan} berhasil diperbarui` });
    } catch (error) {
        console.error('Error updating master executive:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await billingManager.ensureMasterExecutivesTable();
        const t = tFrom(req);
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ success: false, message: 'ID tidak valid' });
        }
        const result = await runDb(`DELETE FROM master_executives WHERE id = ?${t.and('')}`, [id]);
        if (!result.changes) {
            return res.status(404).json({ success: false, message: 'Akun jabatan tidak ditemukan' });
        }
        res.json({ success: true, message: 'Akun jabatan berhasil dihapus' });
    } catch (error) {
        console.error('Error deleting master executive:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
