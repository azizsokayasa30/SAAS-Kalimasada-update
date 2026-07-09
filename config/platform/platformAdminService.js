'use strict';

const bcrypt = require('bcrypt');
const tenantStore = require('./tenantStore');

async function listSuperAdmins() {
    return tenantStore.dbAll(
        'SELECT id, name, email, is_active, created_at, updated_at FROM super_admins ORDER BY id ASC'
    );
}

async function getSuperAdminById(id) {
    return tenantStore.dbGet(
        'SELECT id, name, email, is_active, created_at, updated_at FROM super_admins WHERE id = ?',
        [id]
    );
}

async function createSuperAdmin({ name, email, password }) {
    const n = String(name || '').trim();
    const e = String(email || '').trim().toLowerCase();
    const p = String(password || '');
    if (!n || !e || !p) throw new Error('Nama, email, dan password wajib diisi.');
    if (p.length < 6) throw new Error('Password minimal 6 karakter.');
    const dup = await tenantStore.dbGet('SELECT id FROM super_admins WHERE email = ?', [e]);
    if (dup) throw new Error('Email sudah terdaftar.');
    const hash = await bcrypt.hash(p, 10);
    const result = await tenantStore.dbRun(
        'INSERT INTO super_admins (name, email, password_hash, is_active) VALUES (?, ?, ?, 1)',
        [n, e, hash]
    );
    return getSuperAdminById(result.id);
}

async function updateSuperAdmin(id, { name, email, password, is_active }) {
    const existing = await getSuperAdminById(id);
    if (!existing) throw new Error('User tidak ditemukan.');
    const n = String(name || existing.name).trim();
    const e = String(email || existing.email).trim().toLowerCase();
    if (!n || !e) throw new Error('Nama dan email wajib diisi.');
    const dup = await tenantStore.dbGet('SELECT id FROM super_admins WHERE email = ? AND id != ?', [e, id]);
    if (dup) throw new Error('Email sudah digunakan user lain.');

    const active = is_active === 0 || is_active === '0' ? 0 : 1;
    if (active === 0) {
        const activeCount = await tenantStore.dbGet(
            'SELECT COUNT(*) as c FROM super_admins WHERE is_active = 1 AND id != ?',
            [id]
        );
        if ((activeCount?.c || 0) < 1) throw new Error('Minimal harus ada satu user aktif.');
    }

    let sql = `UPDATE super_admins SET name = ?, email = ?, is_active = ?, updated_at = datetime('now','localtime')`;
    const params = [n, e, active];

    if (password && String(password).trim()) {
        if (String(password).length < 6) throw new Error('Password minimal 6 karakter.');
        const hash = await bcrypt.hash(String(password).trim(), 10);
        sql += ', password_hash = ?';
        params.push(hash);
    }
    sql += ' WHERE id = ?';
    params.push(id);

    await tenantStore.dbRun(sql, params);
    return getSuperAdminById(id);
}

async function deactivateSuperAdmin(id, currentAdminId) {
    if (Number(id) === Number(currentAdminId)) {
        throw new Error('Tidak bisa menonaktifkan akun yang sedang login.');
    }
    return updateSuperAdmin(id, { is_active: 0, name: undefined, email: undefined });
}

function parseDetails(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch (_) {
        return { raw };
    }
}

async function listAuditLogs({
    limit = 50,
    offset = 0,
    action = '',
    actorId = null,
    tenantId = null,
    from = '',
    to = '',
} = {}) {
    const clauses = [];
    const params = [];

    if (action) {
        clauses.push('l.action LIKE ?');
        params.push(`%${action}%`);
    }
    if (actorId) {
        clauses.push('l.actor_id = ?');
        params.push(actorId);
    }
    if (tenantId) {
        clauses.push('l.tenant_id = ?');
        params.push(tenantId);
    }
    if (from) {
        clauses.push('l.created_at >= ?');
        params.push(from);
    }
    if (to) {
        clauses.push('l.created_at <= ?');
        params.push(to);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = await tenantStore.dbAll(
        `SELECT l.*, sa.name AS actor_name, sa.email AS actor_email, t.name AS tenant_name
         FROM platform_audit_logs l
         LEFT JOIN super_admins sa ON l.actor_type = 'SuperAdmin' AND sa.id = l.actor_id
         LEFT JOIN tenants t ON t.id = l.tenant_id
         ${where}
         ORDER BY l.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );

    const countRow = await tenantStore.dbGet(
        `SELECT COUNT(*) as total FROM platform_audit_logs l ${where}`,
        params
    );

    return {
        rows: rows.map((r) => ({ ...r, details_parsed: parseDetails(r.details) })),
        total: countRow?.total || 0,
    };
}

async function getAuditLogById(id) {
    const row = await tenantStore.dbGet(
        `SELECT l.*, sa.name AS actor_name, sa.email AS actor_email, t.name AS tenant_name
         FROM platform_audit_logs l
         LEFT JOIN super_admins sa ON l.actor_type = 'SuperAdmin' AND sa.id = l.actor_id
         LEFT JOIN tenants t ON t.id = l.tenant_id
         WHERE l.id = ?`,
        [id]
    );
    if (!row) return null;
    return { ...row, details_parsed: parseDetails(row.details) };
}

const ACTION_LABELS = {
    platform_login: 'Login portal',
    master_package_created: 'Buat master paket',
    master_package_updated: 'Update master paket',
    master_package_deleted: 'Nonaktifkan master paket',
    master_package_backup: 'Backup master paket',
    master_package_restore: 'Restore master paket',
    platform_user_created: 'Buat user management',
    platform_user_updated: 'Update user management',
    platform_user_deactivated: 'Nonaktifkan user management',
    platform_company_updated: 'Update profil perusahaan',
    platform_payment_updated: 'Update payment gateway',
    platform_finance_invoice_created: 'Buat invoice rekap tenant',
    platform_finance_settings_updated: 'Update pengaturan finance',
    platform_finance_backup: 'Backup data finance platform',
    platform_finance_restore: 'Restore data finance platform',
};

function formatActionLabel(action) {
    return ACTION_LABELS[action] || action;
}

module.exports = {
    listSuperAdmins,
    getSuperAdminById,
    createSuperAdmin,
    updateSuperAdmin,
    deactivateSuperAdmin,
    listAuditLogs,
    getAuditLogById,
    formatActionLabel,
};
