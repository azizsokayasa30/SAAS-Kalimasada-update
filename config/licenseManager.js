const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const dbPath = path.join(__dirname, '../data/billing.db');

// Initialize license table
function initializeLicenseTable() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        db.run(`
            CREATE TABLE IF NOT EXISTS license (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                license_key TEXT UNIQUE,
                status TEXT NOT NULL DEFAULT 'trial',
                trial_start_date DATETIME,
                trial_end_date DATETIME,
                activated_at DATETIME,
                created_at DATETIME DEFAULT (datetime('now','localtime')),
                updated_at DATETIME DEFAULT (datetime('now','localtime'))
            )
        `, (err) => {
            if (err) {
                logger.error(`Error creating license table: ${err.message}`);
                db.close();
                reject(err);
            } else {
                db.close();
                logger.info('License table initialized');
                resolve();
            }
        });
    });
}

// Initialize license (trial) jika belum ada
async function initializeLicense() {
    try {
        await initializeLicenseTable();
        
        const db = new sqlite3.Database(dbPath);
        
        // Cek apakah sudah ada record license
        const existing = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM license ORDER BY id DESC LIMIT 1', [], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        if (!existing) {
            // Buat trial license baru
            const trialStartDate = new Date().toISOString();
            const trialEndDate = new Date();
            trialEndDate.setDate(trialEndDate.getDate() + 10); // 10 hari dari sekarang
            
            await new Promise((resolve, reject) => {
                db.run(`
                    INSERT INTO license (status, trial_start_date, trial_end_date, license_key)
                    VALUES (?, ?, ?, NULL)
                `, ['trial', trialStartDate, trialEndDate.toISOString()], function(err) {
                    if (err) reject(err);
                    else {
                        logger.info(`Trial license initialized. Trial ends: ${trialEndDate.toISOString()}`);
                        resolve();
                    }
                });
            });
        }
        
        db.close();
    } catch (error) {
        logger.error(`Error initializing license: ${error.message}`);
        throw error;
    }
}

// Check license status
async function checkLicenseStatus() {
    return {
        status: 'active',
        license_key: 'CVLM-BYPASS-BYPASS-BYPASS',
        activated_at: new Date().toISOString(),
        message: 'License aktif (Bypassed)'
    };
}

// Update license status
async function updateLicenseStatus(status) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        db.run(`
            UPDATE license 
            SET status = ?, updated_at = datetime('now','localtime')
            WHERE id = (SELECT id FROM license ORDER BY id DESC LIMIT 1)
        `, [status], function(err) {
            db.close();
            if (err) reject(err);
            else resolve();
        });
    });
}

// Validate license key format
function validateLicenseKeyFormat(key) {
    // Format: CVLM-XXXX-XXXX-XXXX-XXXX (20 karakter total, 4 groups)
    const pattern = /^CVLM-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
    return pattern.test(key);
}

// Generate license key
function generateLicenseKey() {
    // Generate random 4 groups of 4 characters each
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'; // Exclude I, O untuk avoid confusion
    let key = 'CVLM-';
    
    for (let i = 0; i < 3; i++) {
        let group = '';
        for (let j = 0; j < 4; j++) {
            group += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        key += group + '-';
    }
    
    // Last group
    let lastGroup = '';
    for (let j = 0; j < 4; j++) {
        lastGroup += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    key += lastGroup;
    
    return key;
}

// Validate license key (with checksum)
function validateLicenseKey(key) {
    if (!validateLicenseKeyFormat(key)) {
        return { valid: false, message: 'Format license key tidak valid' };
    }
    
    // TODO: Implement checksum validation jika diperlukan
    // Untuk sekarang, hanya validasi format
    // Di production, bisa tambahkan checksum atau validasi terhadap database license yang valid
    
    return { valid: true, message: 'License key valid' };
}

// Activate license
async function activateLicense(key) {
    try {
        // Validate format
        const validation = validateLicenseKey(key);
        if (!validation.valid) {
            return { success: false, message: validation.message };
        }
        
        const db = new sqlite3.Database(dbPath);
        
        // Check if license key already exists
        const existing = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM license WHERE license_key = ?', [key], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        if (existing && existing.id !== (await getCurrentLicenseId())) {
            db.close();
            return { success: false, message: 'License key sudah digunakan oleh instalasi lain' };
        }
        
        // Activate license
        const activatedAt = new Date().toISOString();
        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE license 
                SET license_key = ?, 
                    status = 'active', 
                    activated_at = ?,
                    updated_at = datetime('now','localtime')
                WHERE id = (SELECT id FROM license ORDER BY id DESC LIMIT 1)
            `, [key, activatedAt], function(err) {
                if (err) reject(err);
                else resolve();
            });
        });
        
        db.close();
        logger.info(`License activated: ${key}`);
        
        return { success: true, message: 'License berhasil diaktivasi' };
    } catch (error) {
        logger.error(`Error activating license: ${error.message}`);
        return { success: false, message: `Gagal mengaktivasi license: ${error.message}` };
    }
}

// Get current license ID
async function getCurrentLicenseId() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        db.get('SELECT id FROM license ORDER BY id DESC LIMIT 1', [], (err, row) => {
            db.close();
            if (err) reject(err);
            else resolve(row ? row.id : null);
        });
    });
}

// Check if license is valid (for middleware)
async function isLicenseValid() {
    return true;
}

// Check if trial is expired
async function isTrialExpired() {
    return false;
}

// Initialize on module load
initializeLicenseTable().catch(err => {
    logger.error(`Failed to initialize license table: ${err.message}`);
});

module.exports = {
    initializeLicense,
    checkLicenseStatus,
    validateLicenseKey,
    activateLicense,
    generateLicenseKey,
    isLicenseValid,
    isTrialExpired,
    updateLicenseStatus
};

