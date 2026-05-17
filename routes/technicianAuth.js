const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const { getSetting } = require('../config/settingsManager');
const logger = require('../config/logger');

// Database connection
const dbPath = path.join(__dirname, '../data/billing.db');
const db = new sqlite3.Database(dbPath);

// Simple OTP store (following customer portal pattern)
const otpStore = {};

// WhatsApp integration untuk kirim OTP (following customer portal pattern)
let sendMessage;
try {
    const sendMessageModule = require('../config/sendMessage');
    sendMessage = sendMessageModule.sendMessage;
} catch (error) {
    console.log('WhatsApp not available for OTP sending');
    sendMessage = null;
}

/**
 * Technician Authentication Manager (following customer portal pattern)
 */
class TechnicianAuthManager {
    constructor() {
        this.otpLength = parseInt(getSetting('otp_length', '6'));
        this.otpExpiryMinutes = parseInt(getSetting('otp_expiry_minutes', '5'));
    }

    // Normalisasi nomor telepon ke format Indonesia: 62XXXXXXXXXXX (tanpa +)
    normalizePhone(phone) {
        if (!phone) return '';
        let p = String(phone).trim();
        // Hapus non-digit
        p = p.replace(/\D/g, '');
        // Jika diawali 0 -> ganti 62
        if (p.startsWith('0')) {
            p = '62' + p.slice(1);
        }
        // Jika tidak diawali 62, paksa 62 prefix
        if (!p.startsWith('62')) {
            p = '62' + p;
        }
        return p;
    }

    // Buat beberapa varian umum untuk kecocokan database
    generatePhoneVariants(phone) {
        const normalized = this.normalizePhone(phone);
        const plus62 = '+' + normalized; // +62XXXXXXXXXXX
        const local0 = normalized.replace(/^62/, '0'); // 08XXXXXXXXX
        return Array.from(new Set([normalized, plus62, local0]));
    }

    // Generate OTP code (same as customer portal)
    generateOTP() {
        const min = Math.pow(10, this.otpLength - 1);
        const max = Math.pow(10, this.otpLength) - 1;
        return Math.floor(min + Math.random() * (max - min)).toString();
    }

    // Cek apakah nomor adalah teknisi yang valid
    async isValidTechnician(phone) {
        const variants = this.generatePhoneVariants(phone);
        return new Promise((resolve, reject) => {
            const placeholders = variants.map(() => '?').join(',');
            const sql = `SELECT * FROM technicians WHERE is_active = 1 AND phone IN (${placeholders}) LIMIT 1`;
            db.get(sql, variants, (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    // Generate dan simpan OTP (following customer portal pattern)
    async generateAndSaveOTP(phone) {
        const otp = this.generateOTP();
        const expiryMin = this.otpExpiryMinutes;
        
        // Store OTP in memory (same as customer portal)
        otpStore[phone] = { 
            otp, 
            expires: Date.now() + expiryMin * 60 * 1000 
        };
        
        return { otpCode: otp };
    }

    // Kirim OTP via WhatsApp (following customer portal pattern)
    async sendOTPViaWhatsApp(phone, otpCode) {
        if (!sendMessage) {
            throw new Error('WhatsApp service not available');
        }

        const message = `🔐 *KODE OTP PORTAL TEKNISI*\n\nKode OTP Anda: *${otpCode}*\n\n⏰ Berlaku selama ${this.otpExpiryMinutes} menit\n🔒 Jangan bagikan kode ini kepada siapa pun\n\n*${getSetting('company_header', 'GEMBOK TEKNISI PORTAL')}*`;

        try {
            const jid = `${phone}@s.whatsapp.net`;
            await sendMessage(jid, message);
            logger.info(`OTP sent to technician: ${phone}`);
            return true;
        } catch (error) {
            logger.error('Failed to send OTP via WhatsApp:', error);
            throw error;
        }
    }

    // Verifikasi OTP (following customer portal pattern)
    async verifyOTP(phone, otpCode) {
        const data = otpStore[phone];
        
        if (!data || data.otp !== otpCode || Date.now() > data.expires) {
            return { valid: false, reason: 'invalid_or_expired' };
        }
        
        // Remove OTP after successful verification
        delete otpStore[phone];
        return { valid: true };
    }

    // Create session untuk teknisi
    async createTechnicianSession(technician, req) {
        const sessionId = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 jam

        return new Promise((resolve, reject) => {
            const sql = `INSERT INTO technician_sessions (session_id, technician_id, expires_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)`;
            const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
            const userAgent = req.get('User-Agent') || 'unknown';

            db.run(sql, [sessionId, technician.id, expiresAt.toISOString(), ipAddress, userAgent], function(err) {
                if (err) {
                    reject(err);
                } else {
                    // Update last login teknisi
                    const updateSql = `UPDATE technicians SET last_login = datetime('now','localtime') WHERE id = ?`;
                    db.run(updateSql, [technician.id]);

                    resolve({ sessionId, expiresAt, sessionDbId: this.lastID });
                }
            });
        });
    }

    // Validate session
    async validateSession(sessionId) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT ts.*, t.* 
                FROM technician_sessions ts 
                JOIN technicians t ON ts.technician_id = t.id 
                WHERE ts.session_id = ? AND ts.expires_at > datetime('now','localtime') AND ts.is_active = 1 AND t.is_active = 1
            `;
            
            db.get(sql, [sessionId], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    if (row) {
                        // Update last activity
                        const updateSql = `UPDATE technician_sessions SET last_activity = datetime('now','localtime') WHERE session_id = ?`;
                        db.run(updateSql, [sessionId]);
                    }
                    resolve(row || null);
                }
            });
        });
    }

    // Log aktivitas teknisi
    async logActivity(technicianId, activityType, description, metadata = null) {
        return new Promise((resolve, reject) => {
            const sql = `INSERT INTO technician_activities (technician_id, activity_type, description, metadata) VALUES (?, ?, ?, ?)`;
            const metadataStr = metadata ? JSON.stringify(metadata) : null;

            db.run(sql, [technicianId, activityType, description, metadataStr], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
        });
    }
}

// Instance manager
const authManager = new TechnicianAuthManager();

/**
 * Middleware untuk cek autentikasi teknisi
 */
function technicianAuth(req, res, next) {
    const sessionId = req.session?.technicianSessionId;
    
    if (!sessionId) {
        const acceptsJson = req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1) || req.headers['content-type'] === 'application/json';
        if (acceptsJson) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }
        return res.redirect('/login');
    }

    authManager.validateSession(sessionId)
        .then(session => {
            if (!session) {
                req.session.technicianSessionId = null;
                const acceptsJson = req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1) || req.headers['content-type'] === 'application/json';
                if (acceptsJson) {
                    return res.status(401).json({ success: false, message: 'Unauthorized' });
                }
                return res.redirect('/login');
            }

            // Tambahkan info teknisi ke request
            req.technician = {
                id: session.technician_id,
                name: session.name,
                phone: session.phone,
                role: session.role,
                area_coverage: session.area_coverage
            };

            next();
        })
        .catch(error => {
            logger.error('Error validating technician session:', error);
            res.status(500).send('Internal Server Error');
        });
}

/**
 * ROUTES
 */

// GET: Halaman login teknisi
router.get('/login', (req, res) => {
    res.redirect('/login');
});

// POST: Request OTP - Redirected
router.post('/request-otp', async (req, res) => {
    res.redirect('/login');
});

// POST: Verify OTP dan login - Redirected
router.post('/verify-otp', async (req, res) => {
    res.redirect('/login');
});

// GET: Logout
router.get('/logout', technicianAuth, async (req, res) => {
    try {
        const sessionId = req.session.technicianSessionId;
        
        if (sessionId) {
            // Deactivate session
            const sql = `UPDATE technician_sessions SET is_active = 0 WHERE session_id = ?`;
            db.run(sql, [sessionId]);

            // Log aktivitas logout
            await authManager.logActivity(req.technician.id, 'logout', 'Logout dari portal teknisi');
        }

        req.session.technicianSessionId = null;
        res.redirect('/login');
        
    } catch (error) {
        logger.error('Error during logout:', error);
        req.session.technicianSessionId = null;
        res.redirect('/login');
    }
});

// GET: Redirect root to dashboard
router.get('/', (req, res) => {
    const sessionId = req.session?.technicianSessionId;
    if (sessionId) {
        res.redirect('/technician/dashboard');
    } else {
        res.redirect('/login');
    }
});

module.exports = { router, technicianAuth, authManager };