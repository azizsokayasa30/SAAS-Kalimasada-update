/**
 * Manajemen gudang: barang masuk/keluar, master nama barang, laporan, QR per unit.
 * Setiap unit fisik punya public_code unik di QR; keluar wajib scan kode tersebut.
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const ExcelJS = require('exceljs');
const { getSetting, getSettingsWithCache, getLocalTimestamp } = require('../config/settingsManager');
const { getVersionInfo } = require('../config/version-utils');
const logger = require('../config/logger');

const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

const dbPath = path.join(__dirname, '../data/billing.db');

function openDb() {
    return new sqlite3.Database(dbPath);
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function genPublicCode() {
    return `WH${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

const getAppSettings = (req, res, next) => {
    req.appSettings = {
        companyHeader: getSetting('company_header', 'ISP Monitor'),
        footerInfo: getSetting('footer_info', ''),
        logoFilename: getSetting('logo_filename', 'logo.png')
    };
    next();
};

function renderLocals(req, page, title) {
    const settings = getSettingsWithCache();
    return {
        title,
        page,
        appSettings: req.appSettings,
        settings,
        versionInfo: getVersionInfo()
    };
}

function normalizeScanCode(raw) {
    return String(raw ?? '')
        .trim()
        .replace(/^\uFEFF/, '');
}

function parseEmployeeScanForWarehouse(raw) {
    const trimmed = normalizeScanCode(raw);
    if (!trimmed) return null;
    const upper = trimmed.toUpperCase();
    if (upper.startsWith('EMP')) {
        return { kind: 'code', value: upper };
    }
    try {
        const j = JSON.parse(trimmed);
        if (j && j.type === 'employee') {
            if (j.id != null) return { kind: 'id', value: parseInt(j.id, 10) };
            if (j.public_code) return { kind: 'code', value: String(j.public_code).trim().toUpperCase() };
        }
    } catch (_) {
        /* bukan JSON */
    }
    return null;
}

async function resolveEmployeeForOutbound(db, reqBody) {
    const employeeIdRaw = reqBody.employee_id ?? reqBody.employeeId;
    if (employeeIdRaw != null && String(employeeIdRaw).trim() !== '') {
        const employeeId = parseInt(employeeIdRaw, 10);
        if (!Number.isInteger(employeeId)) {
            return { error: { status: 400, message: 'ID karyawan tidak valid.' } };
        }
        const row = await dbGet(
            db,
            `SELECT id, nama_lengkap, nik, jabatan, public_code, status FROM employees WHERE id = ?`,
            [employeeId]
        );
        if (!row) return { error: { status: 404, message: 'Karyawan tidak ditemukan.' } };
        if (row.status !== 'aktif') return { error: { status: 400, message: 'Karyawan tidak aktif.' } };
        return { employee: row };
    }

    const parsed = parseEmployeeScanForWarehouse(
        reqBody.employee_code ?? reqBody.employee_qr ?? reqBody.employeeQr ?? ''
    );
    if (!parsed) return { employee: null };

    if (parsed.kind === 'id') {
        const row = await dbGet(
            db,
            `SELECT id, nama_lengkap, nik, jabatan, public_code, status FROM employees WHERE id = ?`,
            [parsed.value]
        );
        if (!row) return { error: { status: 404, message: 'Karyawan tidak ditemukan.' } };
        if (row.status !== 'aktif') return { error: { status: 400, message: 'Karyawan tidak aktif.' } };
        return { employee: row };
    }

    const row = await dbGet(
        db,
        `SELECT id, nama_lengkap, nik, jabatan, public_code, status FROM employees WHERE UPPER(TRIM(public_code)) = ?`,
        [parsed.value]
    );
    if (!row) return { error: { status: 404, message: 'Kode karyawan tidak dikenali.' } };
    if (row.status !== 'aktif') return { error: { status: 400, message: 'Karyawan tidak aktif.' } };
    return { employee: row };
}

// ---------- Halaman UI ----------
router.get('/nama-barang', getAppSettings, async (req, res) => {
    try {
        res.render('admin/warehouse/nama-barang', {
            ...renderLocals(req, 'warehouse-items', 'Nama Barang — Gudang')
        });
    } catch (e) {
        logger.error('warehouse nama-barang', e);
        res.status(500).render('error', { message: 'Gagal memuat halaman', error: e.message });
    }
});

router.get('/barang-masuk', getAppSettings, async (req, res) => {
    try {
        res.render('admin/warehouse/barang-masuk', {
            ...renderLocals(req, 'warehouse-inbound', 'Barang Masuk — Gudang')
        });
    } catch (e) {
        logger.error('warehouse barang-masuk', e);
        res.status(500).render('error', { message: 'Gagal memuat halaman', error: e.message });
    }
});

router.get('/barang-keluar', getAppSettings, async (req, res) => {
    try {
        res.render('admin/warehouse/barang-keluar', {
            ...renderLocals(req, 'warehouse-outbound', 'Barang Keluar — Gudang')
        });
    } catch (e) {
        logger.error('warehouse barang-keluar', e);
        res.status(500).render('error', { message: 'Gagal memuat halaman', error: e.message });
    }
});

router.get('/laporan', getAppSettings, async (req, res) => {
    try {
        res.render('admin/warehouse/laporan', {
            ...renderLocals(req, 'warehouse-report', 'Laporan Gudang')
        });
    } catch (e) {
        logger.error('warehouse laporan', e);
        res.status(500).render('error', { message: 'Gagal memuat halaman', error: e.message });
    }
});

// Cetak lembar QR untuk satu batch masuk
router.get('/cetak-qr/:batchId', getAppSettings, async (req, res) => {
    const batchId = parseInt(req.params.batchId, 10);
    if (!Number.isInteger(batchId)) {
        return res.status(400).send('ID batch tidak valid');
    }
    const db = openDb();
    try {
        const batch = await dbGet(
            db,
            `SELECT b.*, i.name AS item_name FROM warehouse_inbound_batches b
             JOIN warehouse_items i ON i.id = b.item_id WHERE b.id = ?`,
            [batchId]
        );
        if (!batch) {
            return res.status(404).send('Batch tidak ditemukan');
        }
        const units = await dbAll(
            db,
            `SELECT id, public_code FROM warehouse_units WHERE inbound_batch_id = ? ORDER BY id`,
            [batchId]
        );
        res.render('admin/warehouse/cetak-qr-batch', {
            ...renderLocals(req, 'warehouse-inbound', 'Cetak QR — Gudang'),
            batch,
            units,
            qrBaseUrl: `${req.protocol}://${req.get('host')}/admin/warehouse/api/qr.png?code=`
        });
    } catch (e) {
        logger.error('cetak-qr', e);
        res.status(500).send('Gagal memuat data');
    } finally {
        db.close();
    }
});

// Gambar QR (PNG) untuk satu kode — dipakai cetak & preview
router.get('/api/qr.png', async (req, res) => {
    const code = normalizeScanCode(req.query.code);
    if (!code || code.length > 80) {
        return res.status(400).send('Parameter code tidak valid');
    }
    try {
        const QRCode = require('qrcode');
        const buf = await QRCode.toBuffer(code, {
            type: 'png',
            width: 256,
            margin: 1,
            errorCorrectionLevel: 'M'
        });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.send(buf);
    } catch (e) {
        logger.error('qr.png', e);
        return res.status(500).send('Gagal membuat QR');
    }
});

// ---------- API: master barang ----------
router.get('/api/items', async (req, res) => {
    const db = openDb();
    try {
        const activeOnly = req.query.all !== '1';
        const sql = activeOnly
            ? `SELECT * FROM warehouse_items WHERE is_active = 1 ORDER BY name COLLATE NOCASE`
            : `SELECT * FROM warehouse_items ORDER BY is_active DESC, name COLLATE NOCASE`;
        const rows = await dbAll(db, sql);
        res.json({ success: true, items: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    } finally {
        db.close();
    }
});

router.post('/api/items', async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    if (!name) {
        return res.status(400).json({ success: false, message: 'Nama barang wajib diisi' });
    }
    const unit = String(req.body.unit ?? '').trim();
    const low = Math.max(0, parseInt(req.body.low_stock_threshold, 10) || 5);
    const db = openDb();
    try {
        const r = await dbRun(
            db,
            `INSERT INTO warehouse_items (name, unit, low_stock_threshold, is_active) VALUES (?,?,?,1)`,
            [name, unit, low]
        );
        res.json({ success: true, id: r.lastID });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    } finally {
        db.close();
    }
});

router.put('/api/items/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, message: 'ID tidak valid' });
    }
    const name = String(req.body.name ?? '').trim();
    if (!name) {
        return res.status(400).json({ success: false, message: 'Nama barang wajib diisi' });
    }
    const unit = String(req.body.unit ?? '').trim();
    const low = Math.max(0, parseInt(req.body.low_stock_threshold, 10) || 0);
    const is_active = req.body.is_active === false || req.body.is_active === 0 ? 0 : 1;
    const db = openDb();
    try {
        await dbRun(
            db,
            `UPDATE warehouse_items SET name = ?, unit = ?, low_stock_threshold = ?, is_active = ?, updated_at = ? WHERE id = ?`,
            [name, unit, low, is_active, getLocalTimestamp(), id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    } finally {
        db.close();
    }
});

router.delete('/api/items/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, message: 'ID tidak valid' });
    }
    const db = openDb();
    try {
        const u = await dbGet(db, `SELECT COUNT(*) AS c FROM warehouse_units WHERE item_id = ?`, [id]);
        if (u && u.c > 0) {
            return res.status(400).json({
                success: false,
                message: 'Barang sudah punya riwayat unit/stok. Nonaktifkan saja, jangan hapus.'
            });
        }
        await dbRun(db, `DELETE FROM warehouse_items WHERE id = ?`, [id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    } finally {
        db.close();
    }
});

// ---------- API: barang masuk ----------
router.post('/api/inbound', async (req, res) => {
    const item_id = parseInt(req.body.item_id, 10);
    const quantity = parseInt(req.body.quantity, 10);
    if (!Number.isInteger(item_id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 5000) {
        return res.status(400).json({ success: false, message: 'item_id dan quantity (1–5000) wajib valid' });
    }
    const reference = String(req.body.reference ?? '').trim().slice(0, 200);
    const notes = String(req.body.notes ?? '').trim().slice(0, 500);

    const db = openDb();
    try {
        const now = getLocalTimestamp();
        const item = await dbGet(db, `SELECT id FROM warehouse_items WHERE id = ? AND is_active = 1`, [item_id]);
        if (!item) {
            return res.status(400).json({ success: false, message: 'Master barang tidak ditemukan atau nonaktif' });
        }

        const { lastID: batchId } = await dbRun(
            db,
            `INSERT INTO warehouse_inbound_batches (item_id, quantity, reference, notes, created_at) VALUES (?,?,?,?,?)`,
            [item_id, quantity, reference, notes, now]
        );

        const units = [];
        for (let i = 0; i < quantity; i++) {
            let inserted = false;
            for (let attempt = 0; attempt < 8 && !inserted; attempt++) {
                const code = genPublicCode();
                try {
                    const r = await dbRun(
                        db,
                        `INSERT INTO warehouse_units (item_id, inbound_batch_id, public_code, status, created_at) VALUES (?,?,?, 'in_stock', ?)`,
                        [item_id, batchId, code, now]
                    );
                    units.push({ id: r.lastID, public_code: code });
                    inserted = true;
                } catch (err) {
                    if (!String(err.message).includes('UNIQUE')) throw err;
                }
            }
            if (!inserted) {
                throw new Error('Gagal menghasilkan kode unik');
            }
        }

        res.json({
            success: true,
            batch_id: batchId,
            units,
            print_url: `/admin/warehouse/cetak-qr/${batchId}`
        });
    } catch (e) {
        logger.error('inbound', e);
        res.status(500).json({ success: false, message: e.message });
    } finally {
        db.close();
    }
});

router.get('/api/inbound-history', async (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const db = openDb();
    try {
        const rows = await dbAll(
            db,
            `SELECT b.id, b.item_id, b.quantity, b.reference, b.notes, b.created_at,
                    i.name AS item_name, i.unit,
                    (SELECT COUNT(*) FROM warehouse_units u WHERE u.inbound_batch_id = b.id AND u.status = 'out') AS units_out,
                    (SELECT COUNT(*) FROM warehouse_units u WHERE u.inbound_batch_id = b.id AND u.status = 'in_stock') AS units_in_stock
             FROM warehouse_inbound_batches b
             JOIN warehouse_items i ON i.id = b.item_id
             ORDER BY b.created_at DESC, b.id DESC
             LIMIT ?`,
            [limit]
        );
        res.json({ success: true, rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    } finally {
        db.close();
    }
});

/**
 * Edit batch masuk. Jika sudah ada unit keluar: hanya referensi & catatan yang boleh diubah.
 * Jika semua unit masih di gudang: boleh ubah barang, qty, referensi, catatan (qty menambah/mengurangi unit & QR).
 */
router.put('/api/inbound-batches/:id', async (req, res) => {
    const batchId = parseInt(req.params.id, 10);
    if (!Number.isInteger(batchId)) {
        return res.status(400).json({ success: false, message: 'ID batch tidak valid' });
    }
    const reference = String(req.body.reference ?? '').trim().slice(0, 200);
    const notes = String(req.body.notes ?? '').trim().slice(0, 500);

    const db = openDb();
    try {
        const batch = await dbGet(db, `SELECT * FROM warehouse_inbound_batches WHERE id = ?`, [batchId]);
        if (!batch) {
            return res.status(404).json({ success: false, message: 'Batch tidak ditemukan' });
        }

        const outRow = await dbGet(
            db,
            `SELECT COUNT(*) AS c FROM warehouse_units WHERE inbound_batch_id = ? AND status = 'out'`,
            [batchId]
        );
        const unitsOut = Number(outRow?.c) || 0;

        if (unitsOut > 0) {
            await dbRun(db, `UPDATE warehouse_inbound_batches SET reference = ?, notes = ? WHERE id = ?`, [
                reference,
                notes,
                batchId
            ]);
            return res.json({
                success: true,
                partial: true,
                message: 'Hanya referensi & catatan yang diubah (batch sudah ada unit yang keluar).'
            });
        }

        const item_id =
            req.body.item_id !== undefined && req.body.item_id !== null && req.body.item_id !== ''
                ? parseInt(req.body.item_id, 10)
                : batch.item_id;
        const quantity =
            req.body.quantity !== undefined && req.body.quantity !== null && req.body.quantity !== ''
                ? parseInt(req.body.quantity, 10)
                : batch.quantity;

        if (!Number.isInteger(item_id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 5000) {
            return res.status(400).json({ success: false, message: 'Barang dan jumlah (1–5000) harus valid' });
        }

        const itemOk = await dbGet(db, `SELECT id FROM warehouse_items WHERE id = ? AND is_active = 1`, [item_id]);
        if (!itemOk) {
            return res.status(400).json({ success: false, message: 'Master barang tidak ditemukan atau nonaktif' });
        }

        const oldQ = Number(batch.quantity) || 0;

        if (quantity < oldQ) {
            const toRemove = oldQ - quantity;
            const victims = await dbAll(
                db,
                `SELECT id FROM warehouse_units WHERE inbound_batch_id = ? AND status = 'in_stock' ORDER BY id DESC LIMIT ?`,
                [batchId, toRemove]
            );
            if (victims.length < toRemove) {
                return res.status(400).json({
                    success: false,
                    message: 'Tidak bisa mengurangi qty melebihi unit yang masih di gudang.'
                });
            }
            for (const v of victims) {
                await dbRun(db, `DELETE FROM warehouse_units WHERE id = ?`, [v.id]);
            }
        } else if (quantity > oldQ) {
            const add = quantity - oldQ;
            const now = getLocalTimestamp();
            for (let i = 0; i < add; i++) {
                let inserted = false;
                for (let attempt = 0; attempt < 8 && !inserted; attempt++) {
                    const code = genPublicCode();
                    try {
                        await dbRun(
                            db,
                            `INSERT INTO warehouse_units (item_id, inbound_batch_id, public_code, status, created_at) VALUES (?,?,?, 'in_stock', ?)`,
                            [item_id, batchId, code, now]
                        );
                        inserted = true;
                    } catch (err) {
                        if (!String(err.message).includes('UNIQUE')) throw err;
                    }
                }
                if (!inserted) throw new Error('Gagal menghasilkan kode unik');
            }
        }

        await dbRun(
            db,
            `UPDATE warehouse_inbound_batches SET item_id = ?, quantity = ?, reference = ?, notes = ? WHERE id = ?`,
            [item_id, quantity, reference, notes, batchId]
        );
        await dbRun(db, `UPDATE warehouse_units SET item_id = ? WHERE inbound_batch_id = ?`, [item_id, batchId]);

        res.json({ success: true });
    } catch (e) {
        logger.error('inbound-batch put', e);
        res.status(500).json({ success: false, message: e.message });
    } finally {
        db.close();
    }
});

router.delete('/api/inbound-batches/:id', async (req, res) => {
    const batchId = parseInt(req.params.id, 10);
    if (!Number.isInteger(batchId)) {
        return res.status(400).json({ success: false, message: 'ID batch tidak valid' });
    }
    const db = openDb();
    try {
        const batch = await dbGet(db, `SELECT id FROM warehouse_inbound_batches WHERE id = ?`, [batchId]);
        if (!batch) {
            return res.status(404).json({ success: false, message: 'Batch tidak ditemukan' });
        }
        const outRow = await dbGet(
            db,
            `SELECT COUNT(*) AS c FROM warehouse_units WHERE inbound_batch_id = ? AND status = 'out'`,
            [batchId]
        );
        if (Number(outRow?.c) > 0) {
            return res.status(400).json({
                success: false,
                message: 'Tidak bisa menghapus: sudah ada unit dari batch ini yang keluar (sudah di-scan keluar).'
            });
        }
        await dbRun(db, `DELETE FROM warehouse_units WHERE inbound_batch_id = ?`, [batchId]);
        await dbRun(db, `DELETE FROM warehouse_inbound_batches WHERE id = ?`, [batchId]);
        res.json({ success: true });
    } catch (e) {
        logger.error('inbound-batch delete', e);
        res.status(500).json({ success: false, message: e.message });
    } finally {
        db.close();
    }
});

// ---------- API: barang keluar (wajib scan kode unit) ----------
router.post('/api/outbound-scan', async (req, res) => {
    const code = normalizeScanCode(req.body.code ?? req.body.qr ?? '').toUpperCase();
    if (!code) {
        return res.status(400).json({ success: false, message: 'Kode QR / barcode kosong' });
    }
    if (code.startsWith('EMP')) {
        return res.status(400).json({
            success: false,
            message: 'Ini kode karyawan. Scan di kolom karyawan terlebih dahulu.'
        });
    }
    const outbound_notes = String(req.body.notes ?? '').trim().slice(0, 500);
    const db = openDb();
    try {
        const empResult = await resolveEmployeeForOutbound(db, req.body);
        if (empResult.error) {
            return res.status(empResult.error.status).json({
                success: false,
                message: empResult.error.message
            });
        }

        let recipient = String(req.body.recipient ?? req.body.penerima ?? '').trim().slice(0, 200);
        let outboundEmployeeId = null;
        if (empResult.employee) {
            outboundEmployeeId = empResult.employee.id;
            recipient = empResult.employee.nama_lengkap;
        }
        if (!recipient) {
            return res.status(400).json({
                success: false,
                message: 'Scan QR karyawan atau isi nama penerima terlebih dahulu.'
            });
        }

        const row = await dbGet(
            db,
            `SELECT u.id, u.public_code, u.status, u.item_id, i.name AS item_name
             FROM warehouse_units u
             JOIN warehouse_items i ON i.id = u.item_id
             WHERE UPPER(TRIM(u.public_code)) = ?`,
            [code]
        );
        if (!row) {
            return res.status(404).json({ success: false, message: 'Kode tidak dikenali. Pastikan QR unit benar.' });
        }
        if (row.status !== 'in_stock') {
            return res.status(400).json({
                success: false,
                message: `Unit sudah pernah keluar (${row.public_code}).`
            });
        }
        await dbRun(
            db,
            `UPDATE warehouse_units SET status = 'out', outbound_at = ?, outbound_recipient = ?, outbound_notes = ?, outbound_employee_id = ? WHERE id = ?`,
            [getLocalTimestamp(), recipient, outbound_notes, outboundEmployeeId, row.id]
        );
        res.json({
            success: true,
            unit: {
                public_code: row.public_code,
                item_name: row.item_name,
                recipient,
                employee_id: outboundEmployeeId
            }
        });
    } catch (e) {
        logger.error('outbound-scan', e);
        res.status(500).json({ success: false, message: e.message });
    } finally {
        db.close();
    }
});

router.get('/api/outbound-history', async (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const db = openDb();
    try {
        const rows = await dbAll(
            db,
            `SELECT u.id, u.public_code, u.outbound_at, u.outbound_recipient, u.outbound_notes,
                    u.outbound_employee_id, i.name AS item_name,
                    e.nama_lengkap AS employee_name, e.nik AS employee_nik, e.jabatan AS employee_jabatan
             FROM warehouse_units u
             JOIN warehouse_items i ON i.id = u.item_id
             LEFT JOIN employees e ON e.id = u.outbound_employee_id
             WHERE u.status = 'out' AND u.outbound_at IS NOT NULL
             ORDER BY u.outbound_at DESC, u.id DESC
             LIMIT ?`,
            [limit]
        );
        res.json({ success: true, rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    } finally {
        db.close();
    }
});

// ---------- API & export: laporan ----------
router.get('/api/report-summary', async (req, res) => {
    const db = openDb();
    try {
        const items = await dbAll(
            db,
            `SELECT i.id, i.name, i.unit, i.low_stock_threshold,
                    (SELECT COUNT(*) FROM warehouse_units u WHERE u.item_id = i.id AND u.status = 'in_stock') AS stock_in,
                    (SELECT COUNT(*) FROM warehouse_units u WHERE u.item_id = i.id AND u.status = 'out') AS stock_out
             FROM warehouse_items i
             WHERE i.is_active = 1
             ORDER BY i.name COLLATE NOCASE`
        );

        const lowStock = items.filter((r) => Number(r.stock_in) <= Number(r.low_stock_threshold));

        const inboundTotal = await dbGet(db, `SELECT COUNT(*) AS c FROM warehouse_inbound_batches`, []);
        const unitsTotal = await dbGet(db, `SELECT COUNT(*) AS c FROM warehouse_units`, []);

        res.json({
            success: true,
            items,
            lowStock,
            totals: {
                inbound_batches: inboundTotal?.c || 0,
                units: unitsTotal?.c || 0
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    } finally {
        db.close();
    }
});

router.get('/export/laporan.xlsx', getAppSettings, async (req, res) => {
    const db = openDb();
    try {
        const items = await dbAll(
            db,
            `SELECT i.id, i.name, i.unit, i.low_stock_threshold,
                    (SELECT COUNT(*) FROM warehouse_units u WHERE u.item_id = i.id AND u.status = 'in_stock') AS stock_in,
                    (SELECT COUNT(*) FROM warehouse_units u WHERE u.item_id = i.id AND u.status = 'out') AS stock_out
             FROM warehouse_items i
             WHERE i.is_active = 1
             ORDER BY i.name COLLATE NOCASE`
        );

        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Stok');
        ws.columns = [
            { header: 'Nama Barang', key: 'name', width: 36 },
            { header: 'Satuan', key: 'unit', width: 12 },
            { header: 'Stok (unit masuk)', key: 'in', width: 18 },
            { header: 'Sudah keluar', key: 'out', width: 14 },
            { header: 'Batas stok tipis', key: 'low', width: 18 },
            { header: 'Status', key: 'st', width: 16 }
        ];
        ws.getRow(1).font = { bold: true };

        for (const r of items) {
            const ins = Number(r.stock_in) || 0;
            const low = Number(r.low_stock_threshold) || 0;
            const st = ins <= low ? 'STOK TIPIS' : 'OK';
            ws.addRow({
                name: r.name,
                unit: r.unit || '-',
                in: ins,
                out: Number(r.stock_out) || 0,
                low,
                st
            });
        }

        const fname = `laporan-gudang-${new Date().toISOString().split('T')[0]}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (e) {
        logger.error('export laporan gudang', e);
        res.status(500).send('Export gagal');
    } finally {
        db.close();
    }
});

router.get('/', getAppSettings, (req, res) => {
    res.redirect('/admin/warehouse/barang-masuk');
});

module.exports = router;
