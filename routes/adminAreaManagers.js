/**
 * Admin Area Managers — kelola jabatan Manager Area (multi-wilayah)
 * Hanya Admin utama (requireFullAdmin).
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const billingManager = require('../config/billing');
const { tenantSqlFromRequest, tenantIdForInsert } = require('../config/platform/tenantSqlHelpers');
const { attachTenantAppSettings } = require('../config/platform/tenantAppSettings');
const { requireFullAdmin } = require('./adminAuth');

router.use(attachTenantAppSettings);
router.use(requireFullAdmin);

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

function parseAreaIds(body) {
    let raw = body.area_ids ?? body.areaIds ?? [];
    if (typeof raw === 'string') {
        try {
            raw = JSON.parse(raw);
        } catch (_) {
            raw = raw.split(',').map((s) => s.trim()).filter(Boolean);
        }
    }
    if (!Array.isArray(raw)) raw = [raw];
    return [...new Set(raw.map((id) => parseInt(id, 10)).filter((id) => Number.isFinite(id) && id > 0))];
}

async function replaceManagerAreas(managerId, areaIds, tenantId) {
    await runDb('DELETE FROM area_manager_areas WHERE area_manager_id = ? AND tenant_id = ?', [
        managerId,
        tenantId,
    ]);
    for (const areaId of areaIds) {
        const area = await getDb(
            'SELECT id FROM areas WHERE id = ? AND tenant_id = ?',
            [areaId, tenantId]
        );
        if (!area) continue;
        await runDb(
            `INSERT OR IGNORE INTO area_manager_areas (area_manager_id, area_id, tenant_id)
             VALUES (?, ?, ?)`,
            [managerId, areaId, tenantId]
        );
    }
}

// List page
router.get('/', async (req, res) => {
    try {
        await billingManager.ensureAreaManagersTables();
        const t = tFrom(req);
        const managers = await allDb(
            `
            SELECT am.*,
                   (SELECT GROUP_CONCAT(ar.nama_area, ', ')
                    FROM area_manager_areas ama
                    INNER JOIN areas ar ON ar.id = ama.area_id
                    WHERE ama.area_manager_id = am.id${t.and('ama')}
                   ) AS assigned_areas,
                   (SELECT COUNT(*) FROM area_manager_areas ama2
                    WHERE ama2.area_manager_id = am.id${t.and('ama2')}
                   ) AS area_count
            FROM area_managers am
            WHERE 1=1${t.and('am')}
            ORDER BY am.name ASC
            `
        );
        const areas = await allDb(
            `SELECT id, kode_area, nama_area, status FROM areas WHERE 1=1${t.and('')} AND status = 'aktif' ORDER BY nama_area ASC`
        );

        res.render('admin/area-managers', {
            title: 'Manager Area',
            page: 'area-managers',
            appSettings: req.tenantSettings || {},
            managers,
            areas,
        });
    } catch (error) {
        console.error('Error loading area managers:', error);
        res.status(500).render('error', {
            message: 'Gagal memuat Manager Area',
            error: process.env.NODE_ENV === 'development' ? error : {},
        });
    }
});

// API list
router.get('/api/list', async (req, res) => {
    try {
        await billingManager.ensureAreaManagersTables();
        const t = tFrom(req);
        const managers = await allDb(
            `
            SELECT am.id, am.name, am.username, am.phone, am.email, am.status, am.created_at,
                   (SELECT GROUP_CONCAT(ama.area_id)
                    FROM area_manager_areas ama WHERE ama.area_manager_id = am.id${t.and('ama')}
                   ) AS area_ids_csv,
                   (SELECT GROUP_CONCAT(ar.nama_area, ', ')
                    FROM area_manager_areas ama
                    INNER JOIN areas ar ON ar.id = ama.area_id
                    WHERE ama.area_manager_id = am.id${t.and('ama')}
                   ) AS assigned_areas
            FROM area_managers am
            WHERE 1=1${t.and('am')}
            ORDER BY am.name ASC
            `
        );
        const data = managers.map((m) => ({
            ...m,
            area_ids: m.area_ids_csv
                ? String(m.area_ids_csv).split(',').map((x) => parseInt(x, 10)).filter(Boolean)
                : [],
        }));
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Create
router.post('/', async (req, res) => {
    try {
        await billingManager.ensureAreaManagersTables();
        const t = tFrom(req);
        const name = String(req.body.name || '').trim();
        const username = String(req.body.username || '').trim();
        const phone = String(req.body.phone || '').trim() || null;
        const email = String(req.body.email || '').trim() || null;
        const status = ['active', 'inactive', 'suspended'].includes(req.body.status)
            ? req.body.status
            : 'active';
        const password = String(req.body.password || '');
        const areaIds = parseAreaIds(req.body);

        if (!name || !username) {
            return res.status(400).json({ success: false, message: 'Nama dan username wajib diisi' });
        }
        if (!password || password.length < 6) {
            return res.status(400).json({ success: false, message: 'Password minimal 6 karakter' });
        }
        if (!areaIds.length) {
            return res.status(400).json({ success: false, message: 'Pilih minimal satu area' });
        }

        const existing = await getDb(
            `SELECT id FROM area_managers WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))${t.and('')}`,
            [username]
        );
        if (existing) {
            return res.status(400).json({ success: false, message: 'Username sudah digunakan' });
        }
        await billingManager.ensureMasterExecutivesTable();
        const executiveUser = await getDb(
            `SELECT id FROM master_executives WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))${t.and('')}`,
            [username]
        );
        if (executiveUser) {
            return res.status(400).json({ success: false, message: 'Username sudah digunakan jabatan pimpinan' });
        }

        const tenantId = tenantIdForInsert(t.tid);
        const hashed = bcrypt.hashSync(password, 10);
        const result = await runDb(
            `INSERT INTO area_managers (name, username, phone, email, password, status, tenant_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [name, username, phone, email, hashed, status, tenantId]
        );
        await replaceManagerAreas(result.lastID, areaIds, tenantId);

        res.json({
            success: true,
            message: 'Manager Area berhasil ditambahkan',
            id: result.lastID,
        });
    } catch (error) {
        console.error('Error creating area manager:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update
router.put('/:id', async (req, res) => {
    try {
        await billingManager.ensureAreaManagersTables();
        const t = tFrom(req);
        const id = parseInt(req.params.id, 10);
        const name = String(req.body.name || '').trim();
        const username = String(req.body.username || '').trim();
        const phone = String(req.body.phone || '').trim() || null;
        const email = String(req.body.email || '').trim() || null;
        const status = ['active', 'inactive', 'suspended'].includes(req.body.status)
            ? req.body.status
            : 'active';
        const password = String(req.body.password || '');
        const areaIds = parseAreaIds(req.body);

        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ success: false, message: 'ID tidak valid' });
        }
        if (!name || !username) {
            return res.status(400).json({ success: false, message: 'Nama dan username wajib diisi' });
        }
        if (password && password.length < 6) {
            return res.status(400).json({ success: false, message: 'Password minimal 6 karakter' });
        }
        if (!areaIds.length) {
            return res.status(400).json({ success: false, message: 'Pilih minimal satu area' });
        }

        const row = await getDb(`SELECT id FROM area_managers WHERE id = ?${t.and('')}`, [id]);
        if (!row) {
            return res.status(404).json({ success: false, message: 'Manager Area tidak ditemukan' });
        }

        const duplicate = await getDb(
            `SELECT id FROM area_managers WHERE LOWER(TRIM(username)) = LOWER(TRIM(?)) AND id != ?${t.and('')}`,
            [username, id]
        );
        if (duplicate) {
            return res.status(400).json({ success: false, message: 'Username sudah digunakan' });
        }
        await billingManager.ensureMasterExecutivesTable();
        const executiveUser = await getDb(
            `SELECT id FROM master_executives WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))${t.and('')}`,
            [username]
        );
        if (executiveUser) {
            return res.status(400).json({ success: false, message: 'Username sudah digunakan jabatan pimpinan' });
        }

        const tenantId = t.tid != null ? Number(t.tid) : tenantIdForInsert();
        if (password) {
            const hashed = bcrypt.hashSync(password, 10);
            await runDb(
                `UPDATE area_managers
                 SET name = ?, username = ?, phone = ?, email = ?, status = ?, password = ?,
                     updated_at = datetime('now','localtime')
                 WHERE id = ?${t.and('')}`,
                [name, username, phone, email, status, hashed, id]
            );
        } else {
            await runDb(
                `UPDATE area_managers
                 SET name = ?, username = ?, phone = ?, email = ?, status = ?,
                     updated_at = datetime('now','localtime')
                 WHERE id = ?${t.and('')}`,
                [name, username, phone, email, status, id]
            );
        }
        await replaceManagerAreas(id, areaIds, tenantId);

        res.json({ success: true, message: 'Manager Area berhasil diperbarui' });
    } catch (error) {
        console.error('Error updating area manager:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Delete
router.delete('/:id', async (req, res) => {
    try {
        await billingManager.ensureAreaManagersTables();
        const t = tFrom(req);
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ success: false, message: 'ID tidak valid' });
        }
        await runDb('DELETE FROM area_manager_areas WHERE area_manager_id = ?' + t.and(''), [id]);
        const result = await runDb('DELETE FROM area_managers WHERE id = ?' + t.and(''), [id]);
        if (!result.changes) {
            return res.status(404).json({ success: false, message: 'Manager Area tidak ditemukan' });
        }
        res.json({ success: true, message: 'Manager Area berhasil dihapus' });
    } catch (error) {
        console.error('Error deleting area manager:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
