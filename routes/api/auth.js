const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { getSetting } = require('../../config/settingsManager');
const { getTenantSetting } = require('../../config/platform/tenantSettings');
const { getTenant, hasTenantContext } = require('../../config/platform/tenantContext');
const logger = require('../../config/logger');
const billingManager = require('../../config/billing');
const AgentManager = require('../../config/agentManager');
const { sendMessage } = require('../../config/sendMessage');
const { resolveEmployeePhotoPath, buildPhotoUrl } = require('../../utils/technicianEmployeePhoto');

const agentManager = new AgentManager();
const dbPath = path.join(__dirname, '../../data/billing.db');
const db = new sqlite3.Database(dbPath);

const JWT_SECRET = getSetting('jwt_secret', 'alijaya-billing-secret-2025');

// OTP Store for mobile API
const otpStore = {};

// WhatsApp integration for OTP is handled by the import at line 11

/**
 * Normalisasi nomor telepon ke format Indonesia: 62XXXXXXXXXXX (tanpa +)
 */
function normalizePhone(phone) {
    if (!phone) return '';
    let p = String(phone).trim();
    p = p.replace(/\D/g, '');
    if (p.startsWith('0')) p = '62' + p.slice(1);
    if (!p.startsWith('62')) p = '62' + p;
    return p;
}

/**
 * Generate dan simpan OTP
 */
function generateOTP(phone) {
    const length = parseInt(getSetting('otp_length', '6'));
    const expiryMin = parseInt(getSetting('otp_expiry_minutes', '5'));
    
    const min = Math.pow(10, length - 1);
    const max = Math.pow(10, length) - 1;
    const otp = Math.floor(min + Math.random() * (max - min)).toString();
    
    otpStore[phone] = { 
        otp, 
        expires: Date.now() + expiryMin * 60 * 1000 
    };
    
    return otp;
}

/**
 * Tenant aktif saat login/API (dari resolveTenant → ALS / req.tenant).
 */
function resolveLoginTenant(req) {
    if (hasTenantContext()) return getTenant();
    return req.tenant || null;
}

function tenantClaims(tenant) {
    if (!tenant?.id) return {};
    return {
        tenantId: tenant.id,
        tenant: tenant.subdomain || null,
    };
}

function userMatchesTenant(row, tenant) {
    if (!tenant?.id || !row) return false;
    if (row.tenant_id == null || row.tenant_id === '') return false;
    return Number(row.tenant_id) === Number(tenant.id);
}

// Middleware to verify JWT Token
const verifyToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'No token provided' });
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Failed to authenticate token' });
        }
        req.user = decoded;

        // Isolasi multi-tenant: JWT tidak boleh dipakai lintas tenant (X-Tenant / host).
        const jwtTenantId = decoded?.tenantId;
        const reqTenantId = req.tenantId ?? (hasTenantContext() ? getTenant()?.id : null);
        if (jwtTenantId != null && reqTenantId != null
            && Number(jwtTenantId) !== Number(reqTenantId)) {
            return res.status(403).json({
                success: false,
                message: 'Sesi tidak berlaku untuk tenant ini. Silakan login ulang.',
                code: 'TENANT_MISMATCH',
            });
        }
        next();
    });
};

// API: POST /api/auth/request-otp
router.post('/request-otp', async (req, res) => {
    const { phone } = req.body;
    
    if (!phone) {
        return res.status(400).json({ success: false, message: 'Nomor telepon harus diisi' });
    }

    const tenant = resolveLoginTenant(req);
    if (!tenant?.id) {
        return res.status(400).json({
            success: false,
            message: 'Kode tenant wajib (header X-Tenant / body.tenant).',
        });
    }
    
    const normPhone = normalizePhone(phone);
    const variants = [normPhone, '+' + normPhone, '0' + normPhone.slice(2)];
    const placeholders = variants.map(() => '?').join(',');

    try {
        // Check if phone exists as Customer or Member (Technicians use password only now)
        const user = await new Promise((resolve, reject) => {
            const sql = `
                SELECT 'customer' as type FROM customers
                 WHERE phone IN (${placeholders}) AND status = 'active' AND tenant_id = ?
                UNION
                SELECT 'member' as type FROM members
                 WHERE phone IN (${placeholders}) AND status = 'active' AND tenant_id = ?
                LIMIT 1
            `;
            db.get(sql, [...variants, tenant.id, ...variants, tenant.id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!user) {
            return res.status(404).json({ success: false, message: 'Nomor telepon tidak terdaftar atau tidak aktif' });
        }

        const otp = generateOTP(normPhone);
        
        // Always log OTP in development/testing for visibility
        logger.info(`[LOGIN-OTP] Generated OTP for ${normPhone}: ${otp}`);

        if (sendMessage) {
            const message = `*KODE OTP LOGIN*\n\nKode OTP Anda adalah: *${otp}*\nJangan berikan kode ini kepada siapapun.\n\nBerlaku selama 5 menit.`;
            await sendMessage(normPhone, message);
            return res.json({ success: true, message: 'OTP telah dikirim ke WhatsApp Anda' });
        } else {
            return res.json({ 
                success: true, 
                message: 'OTP generated (Dev mode)', 
                otp: process.env.NODE_ENV === 'development' ? otp : undefined 
            });
        }
    } catch (error) {
        console.error('Error requesting OTP:', error);
        res.status(500).json({ success: false, message: 'Gagal mengirim OTP' });
    }
});

// API: POST /api/auth/login
router.post('/login', async (req, res) => {
    const { username, password, otp, phone, role } = req.body;
    const tenant = resolveLoginTenant(req);

    // Field/mobile login wajib terikat tenant (cegah kebocoran lintas tenant).
    if (!tenant?.id) {
        return res.status(400).json({
            success: false,
            message: 'Kode tenant wajib (header X-Tenant / body.tenant).',
        });
    }
    
    // 1. Check Admin — gunakan settings tenant (sama seperti /login web),
    // bukan settings.json global, supaya password per-tenant (mis. tenant1) valid.
    if (!role || role === 'admin') {
        const adminUsername = String(getTenantSetting('admin_username', 'admin') || 'admin').trim();
        const adminPassword = String(getTenantSetting('admin_password', 'admin') || 'admin').trim();
        const inputUser = String(username || '').trim();
        const inputPass = String(password || '').trim();

        if (inputUser === adminUsername && inputPass === adminPassword) {
            const claims = tenantClaims(tenant);
            const tokenPayload = {
                id: 'admin',
                username: adminUsername,
                role: 'admin',
                ...claims,
            };
            const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '24h' });
            return res.json({
                success: true,
                token,
                user: {
                    id: 'admin',
                    username: adminUsername,
                    role: 'admin',
                    tenant: tenant.subdomain || null,
                    tenantId: tenant.id,
                },
            });
        }
    }

    // 2. Check Password-based roles (Collector, Agent)
    if (!otp) {
        // Try Collector — harus milik tenant yang dipilih
        if (!role || role === 'collector') {
            const collector = await new Promise((resolve) => {
                db.get(
                    'SELECT * FROM collectors WHERE (phone = ? OR email = ?) AND status = "active" AND tenant_id = ?',
                    [username || phone, username || phone, tenant.id],
                    (err, row) => resolve(row)
                );
            });

            if (collector && userMatchesTenant(collector, tenant)
                && collector.password && bcrypt.compareSync(password, collector.password)) {
                const claims = tenantClaims(tenant);
                const token = jwt.sign(
                    {
                        id: collector.id,
                        username: collector.phone,
                        phone: collector.phone,
                        name: collector.name,
                        role: 'collector',
                        ...claims,
                    },
                    JWT_SECRET,
                    { expiresIn: '24h' }
                );
                const userPayload = {
                    id: collector.id,
                    name: collector.name,
                    role: 'collector',
                    phone: collector.phone,
                    email: collector.email || null,
                    tenant: tenant.subdomain || null,
                    tenantId: tenant.id,
                };
                const photoRel = collector.photo_path || collector.foto_path || null;
                if (photoRel) {
                    userPayload.photo_url = buildPhotoUrl(String(photoRel));
                }
                return res.json({ success: true, token, user: userPayload });
            }
        }

        // Try Agent
        if (!role || role === 'agent') {
            try {
                const result = await agentManager.authenticateAgent(username || phone, password);
                if (result.success) {
                    const agent = result.agent;
                    if (agent.tenant_id != null && Number(agent.tenant_id) !== Number(tenant.id)) {
                        // Agent milik tenant lain — jangan izinkan
                    } else {
                        const claims = tenantClaims(tenant);
                        const token = jwt.sign(
                            {
                                id: agent.id,
                                username: agent.username,
                                phone: agent.phone || agent.username,
                                name: agent.name,
                                role: 'agent',
                                ...claims,
                            },
                            JWT_SECRET,
                            { expiresIn: '24h' }
                        );
                        return res.json({
                            success: true,
                            token,
                            user: {
                                id: agent.id,
                                name: agent.name,
                                role: 'agent',
                                tenant: tenant.subdomain || null,
                                tenantId: tenant.id,
                            },
                        });
                    }
                }
            } catch (e) {}
        }

        // Try Technician (nomor: terima format 08… / 62… / +62…)
        if (!role || role === 'technician') {
            const rawTechPhone = username || phone;
            const normTechPhone = normalizePhone(rawTechPhone);
            const techVariants = [rawTechPhone, normTechPhone, '+' + normTechPhone, '0' + normTechPhone.slice(2)].filter(
                (v, i, a) => v && a.indexOf(v) === i
            );
            const techPh = techVariants.map(() => '?').join(',');
            const technician = await new Promise((resolve) => {
                db.get(
                    `SELECT * FROM technicians WHERE phone IN (${techPh}) AND is_active = 1 AND tenant_id = ?`,
                    [...techVariants, tenant.id],
                    (err, row) => resolve(row)
                );
            });

            if (technician && userMatchesTenant(technician, tenant)
                && technician.password && bcrypt.compareSync(password, technician.password)) {
                const claims = tenantClaims(tenant);
                const token = jwt.sign(
                    {
                        id: technician.id,
                        username: technician.phone,
                        phone: technician.phone,
                        name: technician.name,
                        role: 'technician',
                        ...claims,
                    },
                    JWT_SECRET,
                    { expiresIn: '24h' }
                );
                const userPayload = {
                    id: technician.id,
                    name: technician.name,
                    role: 'technician',
                    position: technician.role || 'technician',
                    phone: technician.phone,
                    email: technician.email || null,
                    area_coverage: technician.area_coverage || '',
                    notes: technician.notes || '',
                    whatsapp_group_id: technician.whatsapp_group_id || null,
                    join_date: technician.join_date || null,
                    last_login: technician.last_login || null,
                    tenant: tenant.subdomain || null,
                    tenantId: tenant.id,
                };
                let photoRel = null;
                try {
                    photoRel = await new Promise((resolve, reject) => {
                        resolveEmployeePhotoPath(db, technician, (err, p) => (err ? reject(err) : resolve(p)));
                    });
                } catch (e) {
                    logger.warn('[auth] resolveEmployeePhotoPath:', e.message);
                }
                if (photoRel) {
                    userPayload.photo_url = buildPhotoUrl(photoRel);
                }
                return res.json({ success: true, token, user: userPayload });
            }
        }

        // Try Customer (password login)
        if (!role || role === 'customer') {
            const normPhone = normalizePhone(username || phone);
            const variants = [normPhone, '+' + normPhone, '0' + normPhone.slice(2)];
            const placeholders = variants.map(() => '?').join(',');

            const customer = await new Promise((resolve) => {
                db.get(
                    `SELECT * FROM customers WHERE (username = ? OR phone IN (${placeholders}) OR customer_id = ?) AND status = 'active' AND tenant_id = ?`,
                    [username || phone, ...variants, username || phone, tenant.id],
                    (err, row) => resolve(row)
                );
            });

            if (customer && userMatchesTenant(customer, tenant)
                && customer.password && bcrypt.compareSync(password, customer.password)) {
                const claims = tenantClaims(tenant);
                const token = jwt.sign(
                    {
                        id: customer.id,
                        username: customer.username,
                        phone: customer.phone,
                        name: customer.name,
                        role: 'customer',
                        ...claims,
                    },
                    JWT_SECRET,
                    { expiresIn: '24h' }
                );
                return res.json({
                    success: true,
                    token,
                    user: {
                        id: customer.id,
                        name: customer.name,
                        role: 'customer',
                        tenant: tenant.subdomain || null,
                        tenantId: tenant.id,
                    },
                });
            }

            // Try Member (password login)
            const member = await new Promise((resolve) => {
                db.get(
                    `SELECT * FROM members WHERE (username = ? OR phone IN (${placeholders}) OR hotspot_username = ?) AND status = 'active' AND tenant_id = ?`,
                    [username || phone, ...variants, username || phone, tenant.id],
                    (err, row) => resolve(row)
                );
            });

            if (member && userMatchesTenant(member, tenant)
                && member.password && bcrypt.compareSync(password, member.password)) {
                const claims = tenantClaims(tenant);
                const token = jwt.sign(
                    {
                        id: member.id,
                        username: member.username,
                        phone: member.phone,
                        name: member.name,
                        role: 'member',
                        ...claims,
                    },
                    JWT_SECRET,
                    { expiresIn: '24h' }
                );
                return res.json({
                    success: true,
                    token,
                    user: {
                        id: member.id,
                        name: member.name,
                        role: 'member',
                        tenant: tenant.subdomain || null,
                        tenantId: tenant.id,
                    },
                });
            }
        }
    }

    // 3. Check OTP-based roles (Customer, Member)
    if (otp && (phone || username)) {
        const targetPhone = normalizePhone(phone || username);
        const stored = otpStore[targetPhone];
        
        if (!stored || stored.otp !== otp || Date.now() > stored.expires) {
            return res.status(401).json({ success: false, message: 'OTP tidak valid atau sudah kadaluarsa' });
        }
        
        // Clear OTP after use
        delete otpStore[targetPhone];

        const variants = [targetPhone, '+' + targetPhone, '0' + targetPhone.slice(2)];
        const placeholders = variants.map(() => '?').join(',');

        // Find which role this phone belongs to (scoped ke tenant)
        const user = await new Promise((resolve) => {
            const sql = `
                SELECT id, name, phone, 'customer' as role, tenant_id FROM customers
                 WHERE phone IN (${placeholders}) AND status = 'active' AND tenant_id = ?
                UNION
                SELECT id, name, phone, 'member' as role, tenant_id FROM members
                 WHERE phone IN (${placeholders}) AND status = 'active' AND tenant_id = ?
                LIMIT 1
            `;
            db.get(sql, [...variants, tenant.id, ...variants, tenant.id], (err, row) => resolve(row));
        });

        if (user && userMatchesTenant(user, tenant)) {
            const claims = tenantClaims(tenant);
            const token = jwt.sign(
                {
                    id: user.id,
                    username: user.phone,
                    phone: user.phone,
                    name: user.name,
                    role: user.role,
                    ...claims,
                },
                JWT_SECRET,
                { expiresIn: '24h' }
            );
            return res.json({
                success: true,
                token,
                user: {
                    id: user.id,
                    name: user.name,
                    role: user.role,
                    tenant: tenant.subdomain || null,
                    tenantId: tenant.id,
                },
            });
        }
    }

    return res.status(401).json({ success: false, message: 'Kredensial tidak valid' });
});

// API: GET /api/auth/status
router.get('/status', verifyToken, (req, res) => {
    res.json({ success: true, user: req.user });
});

// API: GET /api/auth/roles
router.get('/roles', (req, res) => {
    const roles = [
        { id: 'collector', name: 'Collector' },
        { id: 'technician', name: 'Technician' }
    ];
    res.json({ success: true, data: roles });
});

/**
 * Verify OTP from store
 */
function verifyOTP(phone, otp) {
    const normPhone = normalizePhone(phone);
    const stored = otpStore[normPhone];
    
    if (!stored || stored.otp !== otp || Date.now() > stored.expires) {
        return false;
    }
    
    // Clear OTP after use
    delete otpStore[normPhone];
    return true;
}

/**
 * Find user by phone in multiple tables
 */
async function findUserByPhone(phone) {
    const normPhone = normalizePhone(phone);
    const variants = [normPhone, '+' + normPhone, '0' + normPhone.slice(2)];
    const placeholders = variants.map(() => '?').join(',');

    return new Promise((resolve) => {
        const sql = `
            SELECT id, name, phone, 'technician' as role FROM technicians WHERE phone IN (${placeholders}) AND is_active = 1
            UNION
            SELECT id, name, phone, 'customer' as role FROM customers WHERE phone IN (${placeholders}) AND status = 'active'
            UNION
            SELECT id, name, phone, 'member' as role FROM members WHERE phone IN (${placeholders}) AND status = 'active'
            LIMIT 1
        `;
        db.get(sql, [...variants, ...variants, ...variants], (err, row) => resolve(row));
    });
}

module.exports = {
    router,
    verifyToken,
    normalizePhone,
    verifyOTP,
    findUserByPhone
};
