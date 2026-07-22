const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const logger = require('../config/logger');
const { getRadiusConfig } = require('../config/radiusConfig');
const { resolveRadiusSqliteDbPath } = require('../config/radiusSQLite');

const execAsync = promisify(exec);

/**
 * Backup RADIUS Database dan Konfigurasi
 * @returns {Promise<{success: boolean, filePath: string, message: string}>}
 */
async function backupRadius() {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupDir = path.join(__dirname, '../backups/radius');
        const backupFileName = `radius-backup-${timestamp}.tar.gz`;
        const backupFilePath = path.join(backupDir, backupFileName);
        
        // Create backup directory if not exists
        await fs.mkdir(backupDir, { recursive: true });
        
        // Create temporary directory for backup files
        const tempDir = path.join(backupDir, `temp-${timestamp}`);
        await fs.mkdir(tempDir, { recursive: true });
        
        logger.info(`Starting RADIUS backup to ${backupFilePath}`);
        
        // Get RADIUS config
        const config = await getRadiusConfig();
        const dbHost = config.radius_host || 'localhost';
        const dbUser = config.radius_user || 'radius';
        const dbPassword = config.radius_password || '';
        const dbName = config.radius_database || 'radius';
        // 1. Backup Database (SQLite) — path sama logika getRadiusConnection
        logger.info('Backing up RADIUS database (SQLite)...');
        const { dbPath: sourceDbPath } = await resolveRadiusSqliteDbPath();
        const targetDbPath = path.join(tempDir, 'radius-database.db');
        
        try {
            await fs.access(sourceDbPath);
            const { backupRadiusDatabaseToPath } = require('../config/radiusSQLite');
            await backupRadiusDatabaseToPath(targetDbPath);
            const dbStat = await fs.stat(targetDbPath);
            if (!dbStat.size || dbStat.size < 1024) {
                throw new Error(`RADIUS DB backup kosong/terlalu kecil (${dbStat.size} bytes)`);
            }
            logger.info(`Database backup completed (SQLite online backup, ${dbStat.size} bytes)`);
        } catch (error) {
            logger.error(`Database backup failed at ${sourceDbPath}: ${error.message}`);
            // Jangan buat arsip "sukses" tanpa DB — itu yang sempat menyebabkan restore kosong
            try {
                await execAsync(`rm -rf ${tempDir}`);
            } catch (_) {}
            return {
                success: false,
                filePath: null,
                message: `Gagal backup database RADIUS: ${error.message}`
            };
        }
        
        // 2. Backup FreeRADIUS Configuration
        logger.info('Backing up FreeRADIUS configuration...');
        const freeradiusConfigDir = '/etc/freeradius/3.0';
        const configBackupDir = path.join(tempDir, 'freeradius-config');
        
        try {
            // Check if directory exists
            await fs.access(freeradiusConfigDir);
            
            // Copy entire config directory
            await execAsync(`cp -r ${freeradiusConfigDir} ${configBackupDir}`);
            logger.info('FreeRADIUS configuration backup completed');
        } catch (error) {
            logger.warn(`FreeRADIUS config directory not found or not accessible: ${error.message}`);
        }
        
        // 3. Backup MariaDB/MySQL credentials (if exists)
        logger.info('Backing up database credentials...');
        const credentialsFile = '/root/.freeradius_credentials';
        const credentialsBackupFile = path.join(tempDir, 'freeradius-credentials');
        
        try {
            await fs.access(credentialsFile);
            await fs.copyFile(credentialsFile, credentialsBackupFile);
            logger.info('Database credentials backup completed');
        } catch (error) {
            logger.warn(`Credentials file not found: ${error.message}`);
        }
        
        // 4. Create backup info file
        const backupInfo = {
            timestamp: new Date().toISOString(),
            database: {
                host: dbHost,
                name: dbName,
                user: dbUser
            },
            version: '1.0',
            description: 'RADIUS Server Backup - Database and Configuration'
        };
        
        await fs.writeFile(
            path.join(tempDir, 'backup-info.json'),
            JSON.stringify(backupInfo, null, 2),
            'utf8'
        );
        
        // 5. Create tar.gz archive
        logger.info('Creating backup archive...');
        await execAsync(`cd ${tempDir} && tar -czf ${backupFilePath} *`);
        
        // 6. Cleanup temp directory
        await execAsync(`rm -rf ${tempDir}`);
        
        // 7. Cleanup old backups (keep only 3 most recent)
        try {
            const files = await fs.readdir(backupDir);
            const backupFiles = [];
            for (const file of files) {
                if (file.endsWith('.tar.gz') && !file.startsWith('temp-')) {
                    const stats = await fs.stat(path.join(backupDir, file));
                    backupFiles.push({ file, created: stats.birthtime });
                }
            }
            backupFiles.sort((a, b) => b.created - a.created);
            
            // Simpan lebih banyak cadangan — batas 3 terlalu agresif setelah insiden wipe
            if (backupFiles.length > 14) {
                logger.info(`Ditemukan ${backupFiles.length} file backup. Menghapus backup lama (batas maksimal 14)...`);
                const filesToDelete = backupFiles.slice(14);
                for (const backup of filesToDelete) {
                    await fs.unlink(path.join(backupDir, backup.file));
                    logger.info(`Berhasil menghapus backup lama: ${backup.file}`);
                }
            }
        } catch (cleanupError) {
            logger.warn(`Gagal menghapus file backup lama: ${cleanupError.message}`);
        }
        
        logger.info(`RADIUS backup completed: ${backupFilePath}`);
        
        return {
            success: true,
            filePath: backupFilePath,
            fileName: backupFileName,
            message: 'Backup berhasil dibuat',
            size: (await fs.stat(backupFilePath)).size
        };
        
    } catch (error) {
        logger.error('Error creating RADIUS backup:', error);
        return {
            success: false,
            filePath: null,
            message: `Gagal membuat backup: ${error.message}`
        };
    }
}

/**
 * Restore RADIUS Database dan Konfigurasi
 * @param {string} backupFilePath - Path to backup file
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function restoreRadius(backupFilePath) {
    try {
        if (!await fs.access(backupFilePath).then(() => true).catch(() => false)) {
            throw new Error('Backup file tidak ditemukan');
        }
        
        logger.info(`Starting RADIUS restore from ${backupFilePath}`);
        
        // Get RADIUS config
        const config = await getRadiusConfig();
        const dbHost = config.radius_host || 'localhost';
        const dbUser = config.radius_user || 'radius';
        const dbPassword = config.radius_password || '';
        // Create temporary directory for extraction
        const tempDir = path.join(__dirname, '../backups/radius', `restore-temp-${Date.now()}`);
        await fs.mkdir(tempDir, { recursive: true });
        
        try {
            // 1. Extract backup file
            logger.info('Extracting backup file...');
            await execAsync(`tar -xzf ${backupFilePath} -C ${tempDir}`);
            
            // 2. Read backup info
            const backupInfoFile = path.join(tempDir, 'backup-info.json');
            let backupInfo = null;
            try {
                const infoContent = await fs.readFile(backupInfoFile, 'utf8');
                backupInfo = JSON.parse(infoContent);
                logger.info(`Restoring backup from: ${backupInfo.timestamp}`);
            } catch (error) {
                logger.warn('Backup info file not found, continuing...');
            }
            
            // 3. Restore Database (SQLite)
            logger.info('Restoring RADIUS database (SQLite)...');
            const dbBackupFile = path.join(tempDir, 'radius-database.db');
            
            if (await fs.access(dbBackupFile).then(() => true).catch(() => false)) {
                const dbStat = await fs.stat(dbBackupFile);
                if (!dbStat.size || dbStat.size < 1024) {
                    throw new Error(
                        `File radius-database.db di arsip kosong/rusak (${dbStat.size} bytes). Restore dibatalkan.`
                    );
                }

                // Validasi isi sebelum menimpa DB live (cegah wipe ulang)
                const sqlite3 = require('sqlite3').verbose();
                const passwordUsers = await new Promise((resolve, reject) => {
                    const db = new sqlite3.Database(dbBackupFile, sqlite3.OPEN_READONLY, (err) => {
                        if (err) return reject(new Error(`Backup DB tidak bisa dibuka: ${err.message}`));
                    });
                    db.get(
                        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='radcheck'`,
                        (tErr, tRow) => {
                            if (tErr || !tRow || !tRow.n) {
                                db.close(() => {});
                                return reject(new Error('Backup tidak punya tabel radcheck — restore dibatalkan'));
                            }
                            db.get(
                                `SELECT COUNT(*) AS n FROM radcheck
                                 WHERE LOWER(TRIM(attribute)) IN (
                                   'cleartext-password','user-password','crypt-password',
                                   'md5-password','sha-password','smd5-password','mikrotik-password'
                                 )`,
                                (qErr, row) => {
                                    db.close(() => {
                                        if (qErr) return reject(new Error(`Gagal validasi radcheck: ${qErr.message}`));
                                        resolve(row && row.n != null ? Number(row.n) : 0);
                                    });
                                }
                            );
                        }
                    );
                });

                if (passwordUsers < 1) {
                    throw new Error(
                        'Backup berisi 0 user password di radcheck — restore dibatalkan (mencegah wipe RADIUS).'
                    );
                }
                logger.info(`Backup RADIUS valid: ${passwordUsers} password users, ${dbStat.size} bytes`);

                const { dbPath: targetDbPath } = await resolveRadiusSqliteDbPath();
                await fs.mkdir(path.dirname(targetDbPath), { recursive: true });

                // Backup existing database first
                if (await fs.access(targetDbPath).then(() => true).catch(() => false)) {
                    await fs.copyFile(targetDbPath, `${targetDbPath}.bak-${Date.now()}`);
                }

                // Replace with backup file
                await fs.copyFile(dbBackupFile, targetDbPath);
                logger.info('Database restore (SQLite) completed');
            } else {
                // Check if it's an old .sql backup
                const sqlBackupFile = path.join(tempDir, 'radius-database.sql');
                if (await fs.access(sqlBackupFile).then(() => true).catch(() => false)) {
                    logger.warn('Found legacy .sql backup, but system is now using SQLite. SQL restore skipped.');
                    // In a future version, we could implement SQL to SQLite conversion here
                } else {
                    throw new Error('Database backup file tidak ditemukan');
                }
            }
            
            // 4. Restore FreeRADIUS Configuration
            logger.info('Restoring FreeRADIUS configuration...');
            const configBackupDir = path.join(tempDir, 'freeradius-config');
            const freeradiusConfigDir = '/etc/freeradius/3.0';
            
            if (await fs.access(configBackupDir).then(() => true).catch(() => false)) {
                // Backup existing config first
                const existingBackup = `${freeradiusConfigDir}.backup-${Date.now()}`;
                try {
                    await execAsync(`cp -r ${freeradiusConfigDir} ${existingBackup}`);
                    logger.info(`Existing config backed up to: ${existingBackup}`);
                } catch (error) {
                    logger.warn(`Could not backup existing config: ${error.message}`);
                }
                
                // Restore config
                await execAsync(`cp -r ${configBackupDir}/* ${freeradiusConfigDir}/`);
                
                // Fix permissions
                await execAsync(`chown -R freerad:freerad ${freeradiusConfigDir}`);
                await execAsync(`find ${freeradiusConfigDir} -type f -exec chmod 640 {} \\;`);
                await execAsync(`find ${freeradiusConfigDir} -type d -exec chmod 750 {} \\;`);
                
                logger.info('FreeRADIUS configuration restore completed');
            } else {
                logger.warn('FreeRADIUS config backup not found, skipping...');
            }
            
            // 5. Restore credentials (if exists)
            const credentialsBackupFile = path.join(tempDir, 'freeradius-credentials');
            const credentialsFile = '/root/.freeradius_credentials';
            
            if (await fs.access(credentialsBackupFile).then(() => true).catch(() => false)) {
                await fs.copyFile(credentialsBackupFile, credentialsFile);
                await execAsync(`chmod 600 ${credentialsFile}`);
                logger.info('Database credentials restore completed');
            }
            
            // 6. Sync password FreeRADIUS dengan password dari database billing
            // Ini penting karena setelah restore, password MySQL mungkin berbeda
            logger.info('Syncing FreeRADIUS password dengan password database billing...');
            try {
                const { syncRadiusPassword } = require('./syncRadiusPassword');
                const syncResult = await syncRadiusPassword();
                if (syncResult.success) {
                    logger.info('Password FreeRADIUS berhasil disinkronkan');
                } else {
                    logger.warn(`Gagal sync password: ${syncResult.message}`);
                }
            } catch (error) {
                logger.warn(`Error syncing password: ${error.message}`);
                // Continue even if sync fails
            }
            
            // 7. Restart FreeRADIUS
            logger.info('Restarting FreeRADIUS...');
            try {
                await execAsync('systemctl restart freeradius');
                logger.info('FreeRADIUS restarted successfully');
            } catch (error) {
                logger.warn(`Failed to restart FreeRADIUS: ${error.message}`);
            }
            
            // 8. Cleanup
            await execAsync(`rm -rf ${tempDir}`);
            
            logger.info('RADIUS restore completed successfully');
            
            return {
                success: true,
                message: 'Restore berhasil. Database dan konfigurasi telah dipulihkan. Password FreeRADIUS telah disinkronkan dengan password database billing.'
            };
            
        } catch (error) {
            // Cleanup on error
            try {
                await execAsync(`rm -rf ${tempDir}`);
            } catch (cleanupError) {
                logger.error('Cleanup error:', cleanupError);
            }
            throw error;
        }
        
    } catch (error) {
        logger.error('Error restoring RADIUS backup:', error);
        return {
            success: false,
            message: `Gagal restore backup: ${error.message}`
        };
    }
}

/**
 * List all backup files
 * @returns {Promise<Array>}
 */
async function listBackups() {
    try {
        const backupDir = path.join(__dirname, '../backups/radius');
        await fs.mkdir(backupDir, { recursive: true });
        
        const files = await fs.readdir(backupDir);
        const backups = [];
        
        for (const file of files) {
            if (file.endsWith('.tar.gz') && !file.startsWith('temp-')) {
                const filePath = path.join(backupDir, file);
                const stats = await fs.stat(filePath);
                backups.push({
                    fileName: file,
                    filePath: filePath,
                    size: stats.size,
                    created: stats.birthtime,
                    modified: stats.mtime
                });
            }
        }
        
        // Sort by created date (newest first)
        backups.sort((a, b) => b.created - a.created);
        
        return backups;
    } catch (error) {
        logger.error('Error listing backups:', error);
        return [];
    }
}

module.exports = {
    backupRadius,
    restoreRadius,
    listBackups
};

