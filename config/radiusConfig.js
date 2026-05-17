const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const dbPath = path.join(__dirname, '../data/billing.db');

// Ensure app_settings table exists
function ensureAppSettingsTable() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        db.run(`
            CREATE TABLE IF NOT EXISTS app_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT UNIQUE NOT NULL,
                value TEXT,
                created_at DATETIME DEFAULT (datetime('now','localtime')),
                updated_at DATETIME DEFAULT (datetime('now','localtime'))
            )
        `, (err) => {
            db.close();
            if (err) reject(err);
            else resolve();
        });
    });
}

// Get radius configuration from database
async function getRadiusConfig() {
    await ensureAppSettingsTable();
    
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        
        const keys = ['user_auth_mode', 'radius_host', 'radius_user', 'radius_password', 'radius_database'];
        const config = {};
        
        // Get all radius config keys
        db.all(
            `SELECT key, value FROM app_settings WHERE key IN (?, ?, ?, ?, ?)`,
            keys,
            (err, rows) => {
                db.close();
                
                if (err) {
                    logger.error(`Error getting radius config from database: ${err.message}`);
                    // Return defaults if error
                    resolve({
                        user_auth_mode: 'mikrotik',
                        radius_host: 'localhost',
                        radius_user: 'radius',
                        radius_password: 'radius',
                        radius_database: 'radius'
                    });
                    return;
                }
                
                // Map results to config object
                rows.forEach(row => {
                    config[row.key] = row.value;
                });
                
                // Set defaults for missing keys
                resolve({
                    user_auth_mode: config.user_auth_mode || 'mikrotik',
                    radius_host: config.radius_host || 'localhost',
                    radius_user: config.radius_user || 'radius',
                    radius_password: config.radius_password || 'radius',
                    radius_database: config.radius_database || 'radius'
                });
            }
        );
    });
}

// Save radius configuration to database
async function saveRadiusConfig(config) {
    await ensureAppSettingsTable();
    
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        
        const entries = [
            ['user_auth_mode', config.user_auth_mode || 'radius'],
            ['radius_host', config.radius_host || 'localhost'],
            ['radius_user', config.radius_user || 'radius'],
            ['radius_password', config.radius_password || 'radius'],
            ['radius_database', config.radius_database || 'radius']
        ];
        
        // Use transaction for atomicity
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            
            entries.forEach(([key, value]) => {
                db.run(
                    `INSERT OR REPLACE INTO app_settings (key, value, updated_at) 
                     VALUES (?, ?, datetime('now','localtime'))`,
                    [key, value],
                    (err) => {
                        if (err) {
                            logger.error(`Error saving ${key} to database: ${err.message}`);
                        }
                    }
                );
            });
            
            db.run('COMMIT', (err) => {
                db.close();
                if (err) {
                    logger.error(`Error committing radius config: ${err.message}`);
                    reject(err);
                } else {
                    logger.info('Radius configuration saved to database successfully');
                    resolve(true);
                }
            });
        });
    });
}

// Get single radius config value
async function getRadiusConfigValue(key, defaultValue = null) {
    await ensureAppSettingsTable();
    
    return new Promise((resolve) => {
        const db = new sqlite3.Database(dbPath);
        
        db.get(
            'SELECT value FROM app_settings WHERE key = ?',
            [key],
            (err, row) => {
                db.close();
                
                if (err || !row) {
                    resolve(defaultValue);
                } else {
                    resolve(row.value || defaultValue);
                }
            }
        );
    });
}

module.exports = {
    getRadiusConfig,
    saveRadiusConfig,
    getRadiusConfigValue,
    ensureAppSettingsTable
};

