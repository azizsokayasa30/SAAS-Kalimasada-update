'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const { verifyAdminPassword } = require('../utils/adminPassword');

const router = express.Router();
const dbPath = path.join(__dirname, '../data/billing.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
const APK_PATH = path.join(__dirname, '../public/mobile-app/kalimasada-mobile-latest.apk');
const APK_NAME = 'kalimasada-mobile-6.2.0.apk';
const DUMMY_HASH = bcrypt.hashSync('company-site-timing-pad', 8);
const MAX_COMPARES = 12;
const attempts = new Map();

const ROLE_LABELS = {
    technician: 'Teknisi',
    collector: 'Kolektor',
    agent: 'Agen',
    area_manager: 'Manager area',
    executive: 'Pimpinan',
    customer: 'Pelanggan',
    member: 'Member',
    tenant_admin: 'Admin tenant',
    management: 'Management',
};

function dbAll(sql, params) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function phoneLookupKeys(input) {
    const raw = String(input || '').trim();
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 9) return [];
    let intl = digits;
    if (intl.startsWith('0')) intl = '62' + intl.slice(1);
    else if (!intl.startsWith('62')) intl = '62' + intl;
    const local = intl.startsWith('62') ? '0' + intl.slice(2) : intl;
    return [...new Set([raw, digits, intl, local, `+${intl}`])].filter(Boolean);
}

function identityMatches(stored, keys) {
    const value = String(stored || '').trim().toLowerCase();
    if (!value) return false;
    const folded = new Set(keys.map((key) => String(key).toLowerCase()));
    if (folded.has(value)) return true;
    const digits = value.replace(/\D/g, '');
    if (!digits) return false;
    return keys.some((key) => String(key).replace(/\D/g, '') === digits);
}

function phoneClause(column, keys) {
    const cleaned = `REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(${column}, ''), ' ', ''), '-', ''), '+', ''), '.', '')`;
    const marks = keys.map(() => '?').join(', ');
    const digits = [...new Set(keys.map((key) => String(key).replace(/\D/g, '')).filter(Boolean))];
    const digitMarks = digits.map(() => '?').join(', ');
    return {
        sql: `(TRIM(IFNULL(${column}, '')) IN (${marks}) OR ${cleaned} IN (${digitMarks}))`,
        params: [...keys, ...digits],
    };
}

function tooManyAttempts(ip) {
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const current = attempts.get(ip);
    if (!current || now - current.start > windowMs) return false;
    return current.n >= 8;
}

function recordFailure(ip) {
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const current = attempts.get(ip);
    if (!current || now - current.start > windowMs) {
        attempts.set(ip, { n: 1, start: now });
        return;
    }
    current.n += 1;
}

function clearFailures(ip) {
    attempts.delete(ip);
}

async function firstPasswordMatch(rows, password) {
    const limited = rows.slice(0, MAX_COMPARES);
    for (const row of limited) {
        if (!row || !row.password) continue;
        let ok = false;
        try {
            ok = await verifyAdminPassword(password, row.password);
        } catch (_) {
            ok = false;
        }
        if (ok) return row;
    }
    return null;
}

async function findTenantUser(keys, password) {
    const phone = phoneClause('u.phone', keys);
    const userOrPhone = phoneClause('u.username', keys);
    const queries = [
        {
            role: 'technician',
            sql: `SELECT u.id, u.name, u.phone, u.password, t.name AS tenant_name
                  FROM technicians u
                  INNER JOIN tenants t ON t.id = u.tenant_id AND t.status = 'active' AND t.deleted_at IS NULL
                  WHERE u.is_active = 1 AND TRIM(IFNULL(u.password, '')) != '' AND ${phone.sql}`,
            params: phone.params,
        },
        {
            role: 'collector',
            sql: `SELECT u.id, u.name, u.phone, u.password, t.name AS tenant_name
                  FROM collectors u
                  INNER JOIN tenants t ON t.id = u.tenant_id AND t.status = 'active' AND t.deleted_at IS NULL
                  WHERE u.status = 'active' AND TRIM(IFNULL(u.password, '')) != '' AND ${phone.sql}`,
            params: phone.params,
        },
        {
            role: 'agent',
            sql: `SELECT u.id, u.name, u.phone, u.password, t.name AS tenant_name
                  FROM agents u
                  INNER JOIN tenants t ON t.id = u.tenant_id AND t.status = 'active' AND t.deleted_at IS NULL
                  WHERE u.status = 'active' AND TRIM(IFNULL(u.password, '')) != '' AND ${phone.sql}`,
            params: phone.params,
        },
        {
            role: 'area_manager',
            sql: `SELECT u.id, u.name, u.phone, u.password, t.name AS tenant_name
                  FROM area_managers u
                  INNER JOIN tenants t ON t.id = u.tenant_id AND t.status = 'active' AND t.deleted_at IS NULL
                  WHERE u.status = 'active' AND TRIM(IFNULL(u.password, '')) != ''
                    AND (${phone.sql} OR ${userOrPhone.sql})`,
            params: [...phone.params, ...userOrPhone.params],
        },
        {
            role: 'executive',
            sql: `SELECT u.id, u.name, u.phone, u.password, t.name AS tenant_name
                  FROM master_executives u
                  INNER JOIN tenants t ON t.id = u.tenant_id AND t.status = 'active' AND t.deleted_at IS NULL
                  WHERE u.status = 'active' AND TRIM(IFNULL(u.password, '')) != ''
                    AND (${phone.sql} OR ${userOrPhone.sql})`,
            params: [...phone.params, ...userOrPhone.params],
        },
        {
            role: 'customer',
            sql: `SELECT u.id, u.name, u.phone, u.password, t.name AS tenant_name
                  FROM customers u
                  INNER JOIN tenants t ON t.id = u.tenant_id AND t.status = 'active' AND t.deleted_at IS NULL
                  WHERE u.status = 'active' AND TRIM(IFNULL(u.password, '')) != '' AND ${phone.sql}
                  LIMIT 12`,
            params: phone.params,
        },
        {
            role: 'member',
            sql: `SELECT u.id, u.name, u.phone, u.password, t.name AS tenant_name
                  FROM members u
                  INNER JOIN tenants t ON t.id = u.tenant_id AND t.status = 'active' AND t.deleted_at IS NULL
                  WHERE u.status = 'active' AND TRIM(IFNULL(u.password, '')) != '' AND ${phone.sql}
                  LIMIT 12`,
            params: phone.params,
        },
    ];

    for (const query of queries) {
        const rows = await dbAll(query.sql, query.params);
        const match = await firstPasswordMatch(rows, password);
        if (match) {
            return {
                id: match.id,
                name: match.name,
                role: query.role,
                roleLabel: ROLE_LABELS[query.role],
                tenantName: match.tenant_name || null,
            };
        }
    }
    return null;
}

async function findTenantAdmin(keys, password) {
    const rows = await dbAll(
        `SELECT id, name, settings FROM tenants WHERE status = 'active' AND deleted_at IS NULL`,
        []
    );
    for (const tenant of rows) {
        let settings = {};
        try {
            settings = JSON.parse(tenant.settings || '{}');
        } catch (_) {
            settings = {};
        }
        const username = String(settings.admin_username || '').trim();
        const stored = String(settings.admin_password || '');
        if (!username || !stored || !identityMatches(username, keys)) continue;
        let ok = false;
        try {
            ok = await verifyAdminPassword(password, stored);
        } catch (_) {
            ok = false;
        }
        if (ok) {
            return {
                id: tenant.id,
                name: tenant.name,
                role: 'tenant_admin',
                roleLabel: ROLE_LABELS.tenant_admin,
                tenantName: tenant.name,
            };
        }
    }
    return null;
}

async function findManagementAdmin(login, password) {
    const email = String(login || '').trim().toLowerCase();
    if (!email.includes('@')) return null;
    const row = await new Promise((resolve, reject) => {
        db.get(
            'SELECT id, name, email, password_hash FROM super_admins WHERE LOWER(email) = ? AND is_active = 1',
            [email],
            (err, found) => (err ? reject(err) : resolve(found || null))
        );
    });
    if (!row || !row.password_hash) return null;
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return null;
    return {
        id: row.id,
        name: row.name,
        role: 'management',
        roleLabel: ROLE_LABELS.management,
        tenantName: null,
    };
}

function publicUser(user) {
    return {
        name: user.name,
        role: user.role,
        roleLabel: user.roleLabel,
        tenantName: user.tenantName,
    };
}

function saveSession(req, res, payload) {
    req.session.save((err) => {
        if (err) {
            console.error('[company-site] session save failed:', err.message);
            return res.status(500).json({ success: false, message: 'Gagal menyimpan sesi. Silakan coba lagi.' });
        }
        return res.json(payload);
    });
}

router.get('/session', (req, res) => {
    const user = req.session?.companySite;
    if (!user) return res.json({ loggedIn: false });
    return res.json({ loggedIn: true, user: publicUser(user) });
});

router.post('/login', async (req, res) => {
    const login = String(req.body?.phone || req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const ip = req.ip || 'unknown';

    if (!login || !password) {
        return res.status(400).json({ success: false, message: 'Nomor HP dan password wajib diisi.' });
    }
    if (tooManyAttempts(ip)) {
        return res.status(429).json({
            success: false,
            message: 'Terlalu banyak percobaan. Coba lagi dalam beberapa menit.',
        });
    }

    try {
        const keys = login.includes('@') ? [] : phoneLookupKeys(login);
        let user = null;
        if (keys.length) user = await findTenantUser(keys, password);
        if (!user && keys.length) user = await findTenantAdmin(keys, password);
        if (!user) user = await findManagementAdmin(login, password);
        if (!user) {
            try {
                await bcrypt.compare(password, DUMMY_HASH);
            } catch (_) {
                /* abaikan */
            }
            recordFailure(ip);
            return res.status(401).json({ success: false, message: 'Nomor atau password tidak sesuai.' });
        }

        clearFailures(ip);
        const sessionUser = publicUser(user);
        return req.session.regenerate((err) => {
            if (err) {
                console.error('[company-site] session regenerate failed:', err.message);
                return res.status(500).json({ success: false, message: 'Gagal menyimpan sesi. Silakan coba lagi.' });
            }
            req.session.companySite = sessionUser;
            return saveSession(req, res, { success: true, user: sessionUser });
        });
    } catch (err) {
        console.error('[company-site] login error:', err.message);
        return res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem.' });
    }
});

router.post('/logout', (req, res) => {
    if (!req.session) return res.json({ success: true });
    return req.session.destroy(() => {
        res.clearCookie('admin_session');
        return res.json({ success: true });
    });
});

router.get('/apk', (req, res) => {
    if (!req.session?.companySite) {
        return res.status(401).json({ success: false, message: 'Masuk terlebih dahulu.' });
    }
    if (!fs.existsSync(APK_PATH)) {
        return res.status(404).json({ success: false, message: 'Berkas aplikasi belum tersedia.' });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    return res.download(APK_PATH, APK_NAME);
});

module.exports = router;
