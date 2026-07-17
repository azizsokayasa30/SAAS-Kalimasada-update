const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const billingManager = require('../config/billing');
const { tenantIdForInsert, tenantSqlFromRequest } = require('../config/platform/tenantSqlHelpers');
const { attachTenantAppSettings } = require('../config/platform/tenantAppSettings');
const { getSettingsWithCache } = require('../config/settingsManager');
const { notifyLeaveDecision } = require('../config/technicianFieldNotifications');
const logger = require('../config/logger');

let _activeTenantSql = null;

function tAnd(alias = '') {
    if (_activeTenantSql) return _activeTenantSql.and(alias);
    const t = billingManager._tenantWhere(alias);
    if (!t.sql) return '';
    const col = alias ? `${alias}.tenant_id` : 'tenant_id';
    return ` AND ${col} = ${parseInt(t.params[0], 10)}`;
}
function tWhere(alias = '') {
    if (_activeTenantSql) return _activeTenantSql.where(alias);
    const t = billingManager._tenantWhere(alias);
    if (!t.sql) return '';
    const col = alias ? `${alias}.tenant_id` : 'tenant_id';
    return ` WHERE ${col} = ${parseInt(t.params[0], 10)}`;
}

router.use(attachTenantAppSettings);
router.use((req, res, next) => {
    _activeTenantSql = tenantSqlFromRequest(req);
    next();
});

const db = new sqlite3.Database('./data/billing.db');

function normalizePhoneEmployee(raw) {
    if (!raw) return '';
    let p = String(raw).trim().replace(/\D/g, '');
    if (p.startsWith('0')) p = '62' + p.slice(1);
    if (!p.startsWith('62')) p = '62' + p;
    return p;
}

function employeeConstraintError(err) {
    const msg = String((err && err.message) || '');
    if (!msg.includes('UNIQUE')) return null;
    const lower = msg.toLowerCase();
    if (lower.includes('employees.nik') || lower.includes('(nik)') || /\bnik\b/.test(lower)) {
        return 'NIK sudah terdaftar. Gunakan NIK lain atau edit data karyawan yang sudah ada.';
    }
    if (lower.includes('public_code')) {
        return 'Kode publik karyawan bentrok. Silakan coba simpan lagi.';
    }
    return 'Data bentrok dengan karyawan lain (nilai unik sudah dipakai).';
}

function phoneVariantsEmployeeNoHp(rawPhone) {
    const norm = normalizePhoneEmployee(rawPhone || '');
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

function findTechnicianIdForEmployee(employeeId, cb) {
    db.get(`SELECT no_hp FROM employees WHERE id = ?${tAnd('')}`, [employeeId], (err, emp) => {
        if (err) return cb(err, null);
        if (!emp || !emp.no_hp) return cb(null, null);
        const variants = phoneVariantsEmployeeNoHp(emp.no_hp);
        if (!variants.length) return cb(null, null);
        const ph = variants.map(() => '?').join(',');
        db.get(
            `SELECT id FROM technicians WHERE is_active = 1 AND TRIM(phone) IN (${ph})${tAnd('')} LIMIT 1`,
            variants,
            (e2, row) => {
                if (e2) return cb(e2, null);
                const tid = row && row.id != null ? parseInt(row.id, 10) : NaN;
                cb(null, Number.isFinite(tid) && tid > 0 ? tid : null);
            }
        );
    });
}

function pushLeaveDecisionToTechnician(leaveRow, leaveDbId, approved) {
    if (!leaveRow || !leaveDbId) return;
    const detail = `${String(leaveRow.request_type || '').toUpperCase()} ${leaveRow.start_date} – ${leaveRow.end_date}. ${leaveRow.reason || ''}`.trim();
    findTechnicianIdForEmployee(leaveRow.employee_id, (err, techId) => {
        if (err) {
            logger.error('[admin-employees] leave notify lookup technician:', err);
            return;
        }
        if (!techId) {
            logger.warn('[admin-employees] leave notify: no technician match for employee_id', leaveRow.employee_id);
            return;
        }
        notifyLeaveDecision(techId, leaveDbId, approved, detail).catch((e) => {
            logger.error('[admin-employees] leave notify:', e && e.message);
        });
    });
}

// Multer setup for employee photos
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = './public/uploads/employees';
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'emp-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

function genEmployeePublicCode() {
    return `EMP${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

function normalizeEmployeeScan(raw) {
    return String(raw ?? '')
        .trim()
        .replace(/^\uFEFF/, '');
}

function parseEmployeeScan(raw) {
    const trimmed = normalizeEmployeeScan(raw);
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

function ensureEmployeePublicCodes(cb) {
    db.all(`SELECT id FROM employees WHERE public_code IS NULL OR TRIM(public_code) = ""${tAnd('')}`, [], (err, rows) => {
        if (err) return cb(err);
        if (!rows || !rows.length) return cb(null);
        const assignNext = (idx) => {
            if (idx >= rows.length) return cb(null);
            const code = genEmployeePublicCode();
            db.run(
                'UPDATE employees SET public_code = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?' + tAnd(''),
                [code, rows[idx].id],
                (e2) => {
                    if (e2 && String(e2.message).includes('UNIQUE')) {
                        return assignNext(idx);
                    }
                    if (e2) return cb(e2);
                    assignNext(idx + 1);
                }
            );
        };
        assignNext(0);
    });
}

// ==========================================
// VIEWS ROUTES
// ==========================================

router.get('/', (req, res) => {
    res.render('admin/employees/index', { 
        page: 'employees',
        settings: req.tenantSettings || getSettingsWithCache()
    });
});

router.get('/attendance', (req, res) => {
    res.render('admin/employees/attendance', { 
        page: 'employee-attendance',
        settings: req.tenantSettings || getSettingsWithCache()
    });
});

router.get('/payroll', (req, res) => {
    res.render('admin/employees/payroll', { 
        page: 'employee-payroll',
        settings: req.tenantSettings || getSettingsWithCache()
    });
});

router.get('/reports', (req, res) => {
    res.render('admin/employees/reports', { 
        page: 'employee-reports',
        settings: req.tenantSettings || getSettingsWithCache()
    });
});

router.get('/leave-requests', (req, res) => {
    res.render('admin/employees/leave-requests', {
        page: 'employee-leave-requests',
        settings: req.tenantSettings || getSettingsWithCache()
    });
});

router.get('/attendance-settings', (req, res) => {
    res.render('admin/employees/attendance-settings', {
        page: 'employee-attendance-settings',
        settings: req.tenantSettings || getSettingsWithCache()
    });
});

router.get('/cetak-qr', (req, res) => {
    const sql = `
        SELECT id, nama_lengkap, nik, jabatan, public_code, status
        FROM employees
        WHERE status = 'aktif' AND public_code IS NOT NULL AND TRIM(public_code) != ''${tAnd('')}
        ORDER BY nama_lengkap COLLATE NOCASE
    `;
    db.all(sql, [], (err, rows) => {
        if (err) {
            return res.status(500).send('Gagal memuat data karyawan');
        }
        res.render('admin/employees/cetak-qr-karyawan', {
            page: 'employees',
            settings: req.tenantSettings || getSettingsWithCache(),
            employees: rows || [],
            single: null,
            qrBaseUrl: `${req.protocol}://${req.get('host')}/admin/warehouse/api/qr.png?code=`
        });
    });
});

router.get('/cetak-qr/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).send('ID karyawan tidak valid');
    }
    db.get(
        'SELECT id, nama_lengkap, nik, jabatan, public_code, status FROM employees WHERE id = ?' + tAnd(''),
        [id],
        (err, row) => {
            if (err) return res.status(500).send('Gagal memuat data');
            if (!row) return res.status(404).send('Karyawan tidak ditemukan');
            if (!row.public_code) {
                const code = genEmployeePublicCode();
                db.run(
                    'UPDATE employees SET public_code = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?' + tAnd(''),
                    [code, id],
                    (e2) => {
                        if (e2) return res.status(500).send('Gagal membuat kode QR');
                        row.public_code = code;
                        res.render('admin/employees/cetak-qr-karyawan', {
                            page: 'employees',
                            settings: req.tenantSettings || getSettingsWithCache(),
                            employees: [row],
                            single: row,
                            qrBaseUrl: `${req.protocol}://${req.get('host')}/admin/warehouse/api/qr.png?code=`
                        });
                    }
                );
                return;
            }
            res.render('admin/employees/cetak-qr-karyawan', {
                page: 'employees',
                settings: req.tenantSettings || getSettingsWithCache(),
                employees: [row],
                single: row,
                qrBaseUrl: `${req.protocol}://${req.get('host')}/admin/warehouse/api/qr.png?code=`
            });
        }
    );
});

// ==========================================
// API ROUTES - MASTER DATA
// ==========================================

router.get('/api/areas', (req, res) => {
    db.all("SELECT id, nama_area FROM areas" + tWhere('') + " ORDER BY nama_area ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, data: rows });
    });
});

router.get('/api/data', (req, res) => {
    ensureEmployeePublicCodes((ensureErr) => {
        if (ensureErr) {
            return res.status(500).json({ success: false, error: ensureErr.message });
        }
        const query = `
        SELECT e.*, s.shift_name, s.check_in_time, s.check_out_time
        FROM employees e
        LEFT JOIN attendance_shifts s ON e.shift_id = s.id AND s.tenant_id = e.tenant_id
        WHERE 1=1${tAnd('e')}
        ORDER BY e.created_at DESC
    `;
        db.all(query, [], (err, rows) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, data: rows });
        });
    });
});

router.get('/api/lookup-qr', (req, res) => {
    const parsed = parseEmployeeScan(req.query.code ?? req.query.qr ?? '');
    if (!parsed) {
        return res.status(400).json({ success: false, message: 'Kode QR karyawan tidak valid.' });
    }
    const finish = (err, row) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!row) {
            return res.status(404).json({ success: false, message: 'Karyawan tidak ditemukan.' });
        }
        if (row.status !== 'aktif') {
            return res.status(400).json({ success: false, message: 'Karyawan tidak aktif.' });
        }
        res.json({
            success: true,
            employee: {
                id: row.id,
                nama_lengkap: row.nama_lengkap,
                nik: row.nik,
                jabatan: row.jabatan,
                public_code: row.public_code
            }
        });
    };
    if (parsed.kind === 'id') {
        db.get(
            'SELECT id, nama_lengkap, nik, jabatan, public_code, status FROM employees WHERE id = ?' + tAnd(''),
            [parsed.value],
            finish
        );
        return;
    }
    db.get(
        'SELECT id, nama_lengkap, nik, jabatan, public_code, status FROM employees WHERE UPPER(TRIM(public_code)) = ?' + tAnd(''),
        [parsed.value],
        finish
    );
});

router.post('/api/data', upload.single('foto'), (req, res) => {
    const { nama_lengkap, nik, alamat, no_hp, email, jabatan, tanggal_masuk, status, gaji_pokok, shift_id } = req.body;
    const foto_path = req.file ? `/public/uploads/employees/${req.file.filename}` : null;
    
    const public_code = genEmployeePublicCode();
    const query = `
        INSERT INTO employees (nama_lengkap, nik, alamat, no_hp, email, jabatan, tanggal_masuk, status, gaji_pokok, shift_id, foto_path, public_code, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const normalizedShiftId = shift_id ? parseInt(shift_id, 10) : null;
    const values = [nama_lengkap, nik, alamat, no_hp, email, jabatan, tanggal_masuk, status || 'aktif', gaji_pokok || 0, Number.isNaN(normalizedShiftId) ? null : normalizedShiftId, foto_path, public_code, tenantIdForInsert()];
    
    db.run(query, values, function(err) {
        if (err) {
            // Hapus file yang sudah diupload jika db insert gagal
            if (req.file) {
                try { fs.unlinkSync(req.file.path); } catch (_) { /* ignore */ }
            }
            const friendly = employeeConstraintError(err);
            if (friendly) {
                return res.status(400).json({ success: false, error: friendly });
            }
            logger.error('[admin-employees] insert employee:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, id: this.lastID, message: 'Karyawan berhasil ditambahkan' });
    });
});

router.put('/api/data/:id', upload.single('foto'), (req, res) => {
    const { id } = req.params;
    const { nama_lengkap, nik, alamat, no_hp, email, jabatan, tanggal_masuk, status, gaji_pokok, shift_id } = req.body;
    
    db.get("SELECT foto_path FROM employees WHERE id = ?" + tAnd(''), [id], (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        
        let foto_path = row ? row.foto_path : null;
        if (req.file) {
            foto_path = `/public/uploads/employees/${req.file.filename}`;
            // Hapus foto lama
            if (row && row.foto_path) {
                const oldPath = path.join(__dirname, '..', row.foto_path);
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            }
        }

        const query = `
            UPDATE employees 
            SET nama_lengkap = ?, nik = ?, alamat = ?, no_hp = ?, email = ?, jabatan = ?, tanggal_masuk = ?, status = ?, gaji_pokok = ?, shift_id = ?, foto_path = ?, updated_at = datetime('now','localtime')
            WHERE id = ?${tAnd('')}
        `;
        const normalizedShiftId = shift_id ? parseInt(shift_id, 10) : null;
        const values = [nama_lengkap, nik, alamat, no_hp, email, jabatan, tanggal_masuk, status, gaji_pokok || 0, Number.isNaN(normalizedShiftId) ? null : normalizedShiftId, foto_path, id];
        
        db.run(query, values, function(err) {
            if (err) {
                const friendly = employeeConstraintError(err);
                if (friendly) {
                    return res.status(400).json({ success: false, error: friendly });
                }
                logger.error('[admin-employees] update employee:', err);
                return res.status(500).json({ success: false, error: err.message });
            }
            res.json({ success: true, message: 'Data karyawan berhasil diupdate' });
        });
    });
});

router.delete('/api/data/:id', (req, res) => {
    const { id } = req.params;
    db.get("SELECT foto_path FROM employees WHERE id = ?" + tAnd(''), [id], (err, row) => {
        if (!err && row && row.foto_path) {
            const oldPath = path.join(__dirname, '..', row.foto_path);
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        db.run("DELETE FROM employees WHERE id = ?" + tAnd(''), [id], function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, message: 'Karyawan berhasil dihapus' });
        });
    });
});

// ==========================================
// API ROUTES - ATTENDANCE
// ==========================================

router.get('/api/attendance', (req, res) => {
    const { month, year } = req.query;
    
    let query = `
        SELECT a.*, e.nama_lengkap, e.nik, e.shift_id, s.check_in_time AS shift_check_in_time, s.shift_name
        FROM employee_attendance a
        JOIN employees e ON a.employee_id = e.id
        LEFT JOIN attendance_shifts s ON e.shift_id = s.id AND s.tenant_id = e.tenant_id
        WHERE 1=1${tAnd('e')}
    `;
    
    let values = [];
    if (month && year) {
        query += ` AND strftime('%Y-%m', a.date) = ? `;
        const monthStr = month.padStart(2, '0');
        values.push(`${year}-${monthStr}`);
    }
    query += ` ORDER BY a.date DESC, e.nama_lengkap ASC`;
    
    db.all(query, values, (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, data: rows });
    });
});

router.post('/api/attendance', (req, res) => {
    const { employee_id, date, status, check_in, check_out, notes } = req.body;
    
    db.get("SELECT id FROM employee_attendance WHERE employee_id = ? AND date = ?" + tAnd(''), [employee_id, date], (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        
        if (row) {
            // Update
            const query = `
                UPDATE employee_attendance 
                SET status = ?, check_in = ?, check_out = ?, notes = ?, updated_at = datetime('now','localtime')
                WHERE id = ?${tAnd('')}
            `;
            db.run(query, [status, check_in || null, check_out || null, notes, row.id], function(err) {
                if (err) return res.status(500).json({ success: false, error: err.message });
                res.json({ success: true, message: 'Absensi berhasil diupdate' });
            });
        } else {
            // Insert
            const query = `
                INSERT INTO employee_attendance (employee_id, date, status, check_in, check_out, notes, tenant_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `;
            db.run(query, [employee_id, date, status, check_in || null, check_out || null, notes, tenantIdForInsert()], function(err) {
                if (err) return res.status(500).json({ success: false, error: err.message });
                res.json({ success: true, message: 'Absensi berhasil dicatat' });
            });
        }
    });
});

// ==========================================
// API ROUTES - LEAVE REQUESTS
// ==========================================

router.get('/api/leave-requests', (req, res) => {
    const { status } = req.query;
    let query = `
        SELECT lr.*, e.nama_lengkap, e.nik
        FROM employee_leave_requests lr
        JOIN employees e ON lr.employee_id = e.id
        WHERE 1=1${tAnd('e')}
    `;
    const values = [];

    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
        query += ' AND lr.status = ?';
        values.push(status);
    }

    query += ' ORDER BY CASE lr.status WHEN "pending" THEN 0 ELSE 1 END, lr.created_at DESC';

    db.all(query, values, (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, data: rows || [] });
    });
});

router.post('/api/leave-requests', (req, res) => {
    const { employee_id, request_type, start_date, end_date, reason, requested_by } = req.body;
    const normalizedType = request_type === 'cuti' ? 'cuti' : 'izin';

    if (!employee_id || !start_date || !end_date || !reason) {
        return res.status(400).json({ success: false, error: 'Data tidak lengkap' });
    }

    const query = `
        INSERT INTO employee_leave_requests (employee_id, request_type, start_date, end_date, reason, requested_by, status, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `;
    db.run(query, [employee_id, normalizedType, start_date, end_date, reason, requested_by || null, tenantIdForInsert()], function (err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, id: this.lastID, message: 'Permintaan izin/cuti berhasil dibuat' });
    });
});

router.put('/api/leave-requests/:id/approve', (req, res) => {
    const { id } = req.params;
    const { approval_notes, approved_by } = req.body || {};

    db.get('SELECT * FROM employee_leave_requests WHERE id = ?' + tAnd(''), [id], (err, leaveReq) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!leaveReq) return res.status(404).json({ success: false, error: 'Permintaan tidak ditemukan' });
        if (leaveReq.status !== 'pending') {
            return res.status(400).json({ success: false, error: 'Permintaan sudah diproses sebelumnya' });
        }

        const attendanceStatus = 'izin';
        const notesSuffix = approval_notes ? ` (${approval_notes})` : '';
        const attendanceNote = `[${leaveReq.request_type.toUpperCase()}] ${leaveReq.reason || '-'}${notesSuffix}`;

        const dates = [];
        const start = new Date(`${leaveReq.start_date}T00:00:00`);
        const end = new Date(`${leaveReq.end_date}T00:00:00`);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
            return res.status(400).json({ success: false, error: 'Rentang tanggal permintaan tidak valid' });
        }

        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            dates.push(d.toISOString().slice(0, 10));
        }

        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            db.run(
                `UPDATE employee_leave_requests
                 SET status = 'approved', approved_by = ?, approved_at = datetime('now','localtime'), approval_notes = ?, updated_at = datetime('now','localtime')
                 WHERE id = ?${tAnd('')}`,
                [approved_by || null, approval_notes || null, id],
                function (updateErr) {
                    if (updateErr) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ success: false, error: updateErr.message });
                    }

                    let index = 0;
                    const upsertNext = () => {
                        if (index >= dates.length) {
                            return db.run('COMMIT', (commitErr) => {
                                if (commitErr) return res.status(500).json({ success: false, error: commitErr.message });
                                res.json({ success: true, message: 'Permintaan disetujui dan tersimpan di absensi' });
                                pushLeaveDecisionToTechnician(leaveReq, parseInt(id, 10), true);
                            });
                        }

                        const date = dates[index++];
                        const attendanceTenantId = leaveReq.tenant_id != null
                            ? Number(leaveReq.tenant_id)
                            : tenantIdForInsert();
                        db.run(
                            `INSERT INTO employee_attendance (employee_id, date, status, check_in, check_out, notes, tenant_id)
                             VALUES (?, ?, ?, NULL, NULL, ?, ?)
                             ON CONFLICT(employee_id, date) DO UPDATE SET
                               status = excluded.status,
                               notes = excluded.notes,
                               check_in = NULL,
                               check_out = NULL,
                               tenant_id = excluded.tenant_id,
                               updated_at = datetime('now','localtime')`,
                            [leaveReq.employee_id, date, attendanceStatus, attendanceNote, attendanceTenantId],
                            (attendanceErr) => {
                                if (attendanceErr) {
                                    db.run('ROLLBACK');
                                    return res.status(500).json({ success: false, error: attendanceErr.message });
                                }
                                upsertNext();
                            }
                        );
                    };

                    upsertNext();
                }
            );
        });
    });
});

router.put('/api/leave-requests/:id/reject', (req, res) => {
    const { id } = req.params;
    const { approval_notes, approved_by } = req.body || {};

    db.get('SELECT * FROM employee_leave_requests WHERE id = ?' + tAnd(''), [id], (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!row) return res.status(404).json({ success: false, error: 'Permintaan tidak ditemukan' });
        if (row.status !== 'pending') {
            return res.status(400).json({ success: false, error: 'Permintaan sudah diproses sebelumnya' });
        }

        db.run(
            `UPDATE employee_leave_requests
             SET status = 'rejected', approved_by = ?, approved_at = datetime('now','localtime'), approval_notes = ?, updated_at = datetime('now','localtime')
             WHERE id = ?${tAnd('')}`,
            [approved_by || null, approval_notes || null, id],
            function (updateErr) {
                if (updateErr) return res.status(500).json({ success: false, error: updateErr.message });
                res.json({ success: true, message: 'Permintaan ditolak' });
                pushLeaveDecisionToTechnician(row, parseInt(id, 10), false);
            }
        );
    });
});

// ==========================================
// API ROUTES - ATTENDANCE SETTINGS
// ==========================================

router.get('/api/attendance-settings/branches', (req, res) => {
    const query = 'SELECT * FROM attendance_branches' + tWhere('') + ' ORDER BY created_at DESC';
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, data: rows || [] });
    });
});

router.post('/api/attendance-settings/branches', (req, res) => {
    const { branch_name, address, latitude, longitude } = req.body || {};
    if (!branch_name || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ success: false, error: 'Nama branch, latitude, dan longitude wajib diisi' });
    }
    const query = `
        INSERT INTO attendance_branches (branch_name, address, latitude, longitude, tenant_id)
        VALUES (?, ?, ?, ?, ?)
    `;
    db.run(query, [branch_name, address || null, parseFloat(latitude), parseFloat(longitude), tenantIdForInsert()], function (err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, id: this.lastID, message: 'Branch berhasil ditambahkan' });
    });
});

router.put('/api/attendance-settings/branches/:id', (req, res) => {
    const { id } = req.params;
    const { branch_name, address, latitude, longitude } = req.body || {};
    if (!branch_name || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ success: false, error: 'Nama branch, latitude, dan longitude wajib diisi' });
    }
    const query = `
        UPDATE attendance_branches
        SET branch_name = ?, address = ?, latitude = ?, longitude = ?, updated_at = datetime('now','localtime')
        WHERE id = ?${tAnd('')}
    `;
    db.run(query, [branch_name, address || null, parseFloat(latitude), parseFloat(longitude), id], function (err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Branch berhasil diupdate' });
    });
});

router.delete('/api/attendance-settings/branches/:id', (req, res) => {
    const { id } = req.params;
    db.run('DELETE FROM attendance_branches WHERE id = ?' + tAnd(''), [id], function (err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Branch berhasil dihapus' });
    });
});

router.get('/api/attendance-settings/config', (req, res) => {
    db.get('SELECT * FROM attendance_settings' + tWhere('') + ' ORDER BY id DESC LIMIT 1', [], (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        const fallback = {
            lock_gps_enabled: 0,
            lock_gps_radius_meters: 100,
            method_selfie: 0,
            method_qrcode: 0,
            method_gps_tag: 1
        };
        res.json({ success: true, data: row || fallback });
    });
});

router.put('/api/attendance-settings/config', (req, res) => {
    const {
        lock_gps_enabled,
        lock_gps_radius_meters,
        method_selfie,
        method_qrcode,
        method_gps_tag
    } = req.body || {};

    db.get('SELECT id FROM attendance_settings' + tWhere('') + ' ORDER BY id DESC LIMIT 1', [], (checkErr, row) => {
        if (checkErr) return res.status(500).json({ success: false, error: checkErr.message });

        const values = [
            lock_gps_enabled ? 1 : 0,
            parseInt(lock_gps_radius_meters, 10) || 100,
            method_selfie ? 1 : 0,
            method_qrcode ? 1 : 0,
            method_gps_tag ? 1 : 0
        ];

        if (row) {
            const query = `
                UPDATE attendance_settings
                SET lock_gps_enabled = ?, lock_gps_radius_meters = ?, method_selfie = ?, method_qrcode = ?, method_gps_tag = ?, updated_at = datetime('now','localtime')
                WHERE id = ?${tAnd('')}
            `;
            db.run(query, [...values, row.id], function (updateErr) {
                if (updateErr) return res.status(500).json({ success: false, error: updateErr.message });
                res.json({ success: true, message: 'Setelan absensi berhasil disimpan' });
            });
        } else {
            const query = `
                INSERT INTO attendance_settings (lock_gps_enabled, lock_gps_radius_meters, method_selfie, method_qrcode, method_gps_tag, tenant_id)
                VALUES (?, ?, ?, ?, ?, ?)
            `;
            db.run(query, [...values, tenantIdForInsert()], function (insertErr) {
                if (insertErr) return res.status(500).json({ success: false, error: insertErr.message });
                res.json({ success: true, message: 'Setelan absensi berhasil disimpan' });
            });
        }
    });
});

router.get('/api/attendance-settings/shifts', (req, res) => {
    db.all('SELECT * FROM attendance_shifts' + tWhere('') + ' ORDER BY check_in_time ASC', [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, data: rows || [] });
    });
});

router.post('/api/attendance-settings/shifts', (req, res) => {
    const { shift_name, check_in_time, check_out_time, is_active } = req.body || {};
    if (!shift_name || !check_in_time || !check_out_time) {
        return res.status(400).json({ success: false, error: 'Nama shift, jam check-in, dan jam check-out wajib diisi' });
    }
    const query = `
        INSERT INTO attendance_shifts (shift_name, check_in_time, check_out_time, is_active, tenant_id)
        VALUES (?, ?, ?, ?, ?)
    `;
    db.run(query, [shift_name, check_in_time, check_out_time, is_active ? 1 : 0, tenantIdForInsert()], function (err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, id: this.lastID, message: 'Shift berhasil ditambahkan' });
    });
});

router.put('/api/attendance-settings/shifts/:id', (req, res) => {
    const { id } = req.params;
    const { shift_name, check_in_time, check_out_time, is_active } = req.body || {};
    if (!shift_name || !check_in_time || !check_out_time) {
        return res.status(400).json({ success: false, error: 'Nama shift, jam check-in, dan jam check-out wajib diisi' });
    }
    const query = `
        UPDATE attendance_shifts
        SET shift_name = ?, check_in_time = ?, check_out_time = ?, is_active = ?, updated_at = datetime('now','localtime')
        WHERE id = ?${tAnd('')}
    `;
    db.run(query, [shift_name, check_in_time, check_out_time, is_active ? 1 : 0, id], function (err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Shift berhasil diupdate' });
    });
});

router.delete('/api/attendance-settings/shifts/:id', (req, res) => {
    const { id } = req.params;
    db.run('DELETE FROM attendance_shifts WHERE id = ?' + tAnd(''), [id], function (err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Shift berhasil dihapus' });
    });
});

// ==========================================
// API ROUTES - PAYROLL
// ==========================================

router.get('/api/payroll', (req, res) => {
    const { month, year } = req.query;
    
    let query = `
        SELECT p.*, e.nama_lengkap, e.nik, e.jabatan 
        FROM employee_payroll p
        JOIN employees e ON p.employee_id = e.id
        WHERE 1=1${tAnd('e')}
    `;
    let values = [];
    if (month && year) {
        query += ` AND p.period_month = ? AND p.period_year = ? `;
        values.push(parseInt(month), parseInt(year));
    }
    query += ` ORDER BY e.nama_lengkap ASC`;
    
    db.all(query, values, (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, data: rows });
    });
});

router.post('/api/payroll/generate', (req, res) => {
    const { month, year } = req.body;
    
    // Ambil semua karyawan aktif
    db.all("SELECT id, gaji_pokok FROM employees WHERE status = 'aktif'" + tAnd(''), [], (err, employees) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (employees.length === 0) return res.json({ success: true, message: 'Tidak ada karyawan aktif untuk digenerate' });
        
        let completed = 0;
        let errors = [];
        
        employees.forEach(emp => {
            // Cek apakah gaji sudah ada di periode tsb
            db.get("SELECT id FROM employee_payroll WHERE employee_id = ? AND period_month = ? AND period_year = ?" + tAnd(''), 
                [emp.id, month, year], (err, row) => {
                if (!row) {
                    // Generate jika belum ada
                    const query = `
                        INSERT INTO employee_payroll (employee_id, period_month, period_year, gaji_pokok, total_gaji, tenant_id)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `;
                    db.run(query, [emp.id, month, year, emp.gaji_pokok, emp.gaji_pokok, tenantIdForInsert()], (err) => {
                        if (err) errors.push(err.message);
                        checkDone();
                    });
                } else {
                    checkDone();
                }
            });
        });
        
        function checkDone() {
            completed++;
            if (completed === employees.length) {
                if (errors.length > 0) {
                    res.status(500).json({ success: false, error: 'Beberapa error terjadi: ' + errors.join(', ') });
                } else {
                    res.json({ success: true, message: 'Gaji berhasil di-generate untuk bulan ini' });
                }
            }
        }
    });
});

router.put('/api/payroll/:id', (req, res) => {
    const { id } = req.params;
    const { tunjangan, bonus, potongan, status, payment_date } = req.body;
    
    db.get("SELECT gaji_pokok FROM employee_payroll WHERE id = ?" + tAnd(''), [id], (err, row) => {
        if (err || !row) return res.status(500).json({ success: false, error: err ? err.message : 'Data tidak ditemukan' });
        
        const gaji_pokok = row.gaji_pokok || 0;
        const total_gaji = parseFloat(gaji_pokok) + parseFloat(tunjangan || 0) + parseFloat(bonus || 0) - parseFloat(potongan || 0);
        
        const query = `
            UPDATE employee_payroll 
            SET tunjangan = ?, bonus = ?, potongan = ?, total_gaji = ?, status = ?, payment_date = ?, updated_at = datetime('now','localtime')
            WHERE id = ?${tAnd('')}
        `;
        db.run(query, [tunjangan || 0, bonus || 0, potongan || 0, total_gaji, status, payment_date || null, id], function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, message: 'Data penggajian berhasil diupdate', total_gaji });
        });
    });
});

router.delete('/api/payroll/:id', (req, res) => {
    const { id } = req.params;

    db.get('SELECT id, status FROM employee_payroll WHERE id = ?' + tAnd(''), [id], (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!row) return res.status(404).json({ success: false, error: 'Data payroll tidak ditemukan' });
        if (row.status === 'paid') {
            return res.status(400).json({ success: false, error: 'Payroll dengan status paid tidak bisa dihapus' });
        }

        db.run('DELETE FROM employee_payroll WHERE id = ?' + tAnd(''), [id], function(deleteErr) {
            if (deleteErr) return res.status(500).json({ success: false, error: deleteErr.message });
            res.json({ success: true, message: 'Data payroll berhasil dihapus' });
        });
    });
});

module.exports = router;
