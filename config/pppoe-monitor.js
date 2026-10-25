// pppoe-monitor.js - Enhanced PPPoE monitoring with notification control
const logger = require('./logger');
const pppoeNotifications = require('./pppoe-notifications');

let monitorInterval = null;
const lastActiveByTenant = new Map();
let isMonitoring = false;
const MIN_POLLING_INTERVAL_MS = 10 * 1000;

function normalizePollingIntervalMs(value, fallbackMs = 300000) {
    const parsed = Number(value);
    const interval = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
    return Math.max(interval, MIN_POLLING_INTERVAL_MS);
}

async function isPppoeWaMonitorEnabled(tenantId = null) {
    try {
        const { isWaSystemMonitorEnabled } = require('./whatsappMonitoringSettings');
        return await isWaSystemMonitorEnabled('pppoe_login_logout_wa', tenantId);
    } catch (_) {
        return true;
    }
}

// Start PPPoE monitoring. Interval pendek; tiap tenant memakai jeda miliknya sendiri.
async function startPPPoEMonitoring() {
    try {
        if (isMonitoring && monitorInterval) {
            logger.info('PPPoE monitoring is already running');
            return { success: true, message: 'Monitoring sudah berjalan' };
        }

        const interval = 30 * 1000;

        if (monitorInterval) {
            clearInterval(monitorInterval);
        }

        monitorInterval = setInterval(async () => {
            await checkPPPoEChanges();
        }, interval);

        isMonitoring = true;
        logger.info(`PPPoE monitoring started with interval ${interval}ms (per-tenant toggle)`);
        
        return { 
            success: true, 
            message: `PPPoE monitoring dimulai dengan interval ${interval/1000} detik` 
        };
    } catch (error) {
        logger.error(`Error starting PPPoE monitoring: ${error.message}`);
        return { 
            success: false, 
            message: `Gagal memulai monitoring: ${error.message}` 
        };
    }
}

// Stop PPPoE monitoring
function stopPPPoEMonitoring() {
    try {
        if (monitorInterval) {
            clearInterval(monitorInterval);
            monitorInterval = null;
        }
        
        isMonitoring = false;
        logger.info('PPPoE monitoring stopped');
        
        return { 
            success: true, 
            message: 'PPPoE monitoring dihentikan' 
        };
    } catch (error) {
        logger.error(`Error stopping PPPoE monitoring: ${error.message}`);
        return { 
            success: false, 
            message: `Gagal menghentikan monitoring: ${error.message}` 
        };
    }
}

// Restart PPPoE monitoring
async function restartPPPoEMonitoring() {
    try {
        stopPPPoEMonitoring();
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        return await startPPPoEMonitoring();
    } catch (error) {
        logger.error(`Error restarting PPPoE monitoring: ${error.message}`);
        return { 
            success: false, 
            message: `Gagal restart monitoring: ${error.message}` 
        };
    }
}

// Check for PPPoE login/logout changes
async function checkPPPoEChanges() {
    try {
        const { hasTenantContext } = require('./platform/tenantContext');
        if (!hasTenantContext()) {
            const { runForEnabledTenants, claimTenantMonitorRun, readScopedSetting } = require('./whatsappMonitoringSettings');
            const { resetMikrotikConnectionCache } = require('./mikrotik');
            await runForEnabledTenants('pppoe_login_logout_wa', async (tenant) => {
                const tid = tenant && tenant.id;
                const minutes = parseFloat(readScopedSetting('pppoe_monitor_interval_minutes', '5'));
                const gap = normalizePollingIntervalMs((Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * 60 * 1000);
                if (!claimTenantMonitorRun(tid, 'pppoe_login_logout_wa', gap)) return;
                resetMikrotikConnectionCache();
                await checkPPPoEChangesForCurrentTenant(tid);
            });
            return;
        }
        await checkPPPoEChangesForCurrentTenant();
    } catch (error) {
        logger.error(`❌ Error in PPPoE monitoring check: ${error.message}`);
        logger.error(`Error stack: ${error.stack}`);
    }
}

async function checkPPPoEChangesForCurrentTenant(explicitTenantId = null) {
    try {
        if (!(await isPppoeWaMonitorEnabled(explicitTenantId))) {
            logger.debug('PPPoE WA monitoring master switch is off, skipping check');
            return;
        }

        const settings = pppoeNotifications.getSettings();
        
        // Skip if notifications are disabled
        if (!settings.enabled) {
            logger.debug('PPPoE notifications are disabled, skipping check');
            return;
        }

        // Get current active connections
        const connectionsResult = await pppoeNotifications.getActivePPPoEConnections();
        if (!connectionsResult.success) {
            logger.warn(`Failed to get PPPoE connections: ${connectionsResult.message || 'Unknown error'}`);
            // Jangan return, biarkan monitoring tetap berjalan meskipun ada error
            // Hanya log warning dan skip notifikasi untuk kali ini
            return;
        }

        const connections = connectionsResult.data || [];
        const activeNow = connections.map(conn => conn.name).filter(Boolean); // Filter null/undefined
        const stateKey = explicitTenantId ? String(explicitTenantId) : 'current';
        const lastActivePPPoE = lastActiveByTenant.get(stateKey) || [];

        // Detect login/logout events
        const loginUsers = activeNow.filter(user => !lastActivePPPoE.includes(user));
        const logoutUsers = lastActivePPPoE.filter(user => !activeNow.includes(user));

        // Handle login notifications
        if (loginUsers.length > 0 && settings.loginNotifications) {
            logger.info(`🔔 PPPoE LOGIN detected: ${loginUsers.join(', ')}`);
            
            try {
                // Get offline users for the notification
                const offlineUsers = await pppoeNotifications.getOfflinePPPoEUsers(activeNow);
                
                // Format and send login notification
                const message = pppoeNotifications.formatLoginMessage(loginUsers, connections, offlineUsers);
                const sent = await pppoeNotifications.sendNotification(message);
                
                if (sent) {
                    logger.info(`✅ Login notification sent successfully for: ${loginUsers.join(', ')}`);
                } else {
                    logger.warn(`⚠️ Failed to send login notification for: ${loginUsers.join(', ')}`);
                }
            } catch (notifError) {
                logger.error(`❌ Error sending login notification: ${notifError.message}`);
            }
        }

        // Handle logout notifications
        if (logoutUsers.length > 0 && settings.logoutNotifications) {
            logger.info(`🚪 PPPoE LOGOUT detected: ${logoutUsers.join(', ')}`);
            
            try {
                // Get offline users for the notification
                const offlineUsers = await pppoeNotifications.getOfflinePPPoEUsers(activeNow);
                
                // Format and send logout notification
                const message = pppoeNotifications.formatLogoutMessage(logoutUsers, offlineUsers);
                const sent = await pppoeNotifications.sendNotification(message);
                
                if (sent) {
                    logger.info(`✅ Logout notification sent successfully for: ${logoutUsers.join(', ')}`);
                } else {
                    logger.warn(`⚠️ Failed to send logout notification for: ${logoutUsers.join(', ')}`);
                }
            } catch (notifError) {
                logger.error(`❌ Error sending logout notification: ${notifError.message}`);
            }
        }

        // Update last active users for this tenant only
        lastActiveByTenant.set(stateKey, activeNow);

        // Log monitoring status
        if (loginUsers.length > 0 || logoutUsers.length > 0) {
            logger.info(`📊 PPPoE monitoring: ${connections.length} active connections, ${loginUsers.length} login, ${logoutUsers.length} logout`);
        } else {
            // Log periodic status (setiap 10 kali check untuk mengurangi spam log)
            if (Math.random() < 0.1) { // 10% chance untuk log
                logger.debug(`📊 PPPoE monitoring: ${connections.length} active connections, no changes`);
            }
        }

    } catch (error) {
        logger.error(`❌ Error in PPPoE monitoring check: ${error.message}`);
        logger.error(`Error stack: ${error.stack}`);
    }
}

// Get monitoring status
function getMonitoringStatus() {
    const settings = pppoeNotifications.getSettings();
    const adminNumbers = pppoeNotifications.getAdminNumbers();
    const technicianNumbers = pppoeNotifications.getTechnicianNumbers();
    
    return {
        isRunning: isMonitoring,
        notificationsEnabled: settings.enabled,
        loginNotifications: settings.loginNotifications,
        logoutNotifications: settings.logoutNotifications,
        interval: settings.monitorInterval,
        adminNumbers: adminNumbers,
        technicianNumbers: technicianNumbers,
        activeConnections: Array.from(lastActiveByTenant.values()).reduce((sum, list) => sum + (list ? list.length : 0), 0)
    };
}

// Set monitoring interval
async function setMonitoringInterval(intervalMs) {
    try {
        const settings = pppoeNotifications.getSettings();
        const safeIntervalMs = normalizePollingIntervalMs(intervalMs);
        settings.monitorInterval = safeIntervalMs;
        
        if (pppoeNotifications.saveSettings(settings)) {
            // Restart monitoring with new interval if it's running
            if (isMonitoring) {
                await restartPPPoEMonitoring();
            }
            
            logger.info(`PPPoE monitoring interval updated to ${safeIntervalMs}ms`);
            return { 
                success: true, 
                message: `Interval monitoring diubah menjadi ${safeIntervalMs/1000} detik` 
            };
        } else {
            return { 
                success: false, 
                message: 'Gagal menyimpan pengaturan interval' 
            };
        }
    } catch (error) {
        logger.error(`Error setting monitoring interval: ${error.message}`);
        return { 
            success: false, 
            message: `Gagal mengubah interval: ${error.message}` 
        };
    }
}

// Initialize monitoring on startup
async function initializePPPoEMonitoring() {
    try {
        // Cek apakah Mikrotik sudah dikonfigurasi dari database (routers table)
        // Prioritas: database routers table, fallback ke settings.json
        let hasMikrotikConfig = false;
        let configSource = '';
        
        try {
            // Cek dari database routers table (prioritas utama)
            const sqlite3 = require('sqlite3').verbose();
            const path = require('path');
            const dbPath = path.join(__dirname, '../data/billing.db');
            const db = new sqlite3.Database(dbPath);
            
            const router = await new Promise((resolve, reject) => {
                db.get('SELECT * FROM routers ORDER BY id LIMIT 1', [], (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                });
            });
            db.close();
            
            if (router && router.nas_ip && router.user && (router.password || router.secret)) {
                hasMikrotikConfig = true;
                configSource = `database (router: ${router.name || router.nas_ip})`;
                logger.info(`✅ Mikrotik config found in ${configSource}`);
            }
        } catch (dbError) {
            logger.warn(`Database check failed: ${dbError.message}, trying settings.json fallback`);
        }
        
        // Fallback: cek dari settings.json (untuk kompatibilitas)
        if (!hasMikrotikConfig) {
            try {
                const { getSetting } = require('./settingsManager');
                const mikrotikHost = getSetting('mikrotik_host', '');
                const mikrotikUser = getSetting('mikrotik_user', '');
                const mikrotikPassword = getSetting('mikrotik_password', '');
                
                if (mikrotikHost && mikrotikUser && mikrotikPassword) {
                    hasMikrotikConfig = true;
                    configSource = 'settings.json';
                    logger.info(`✅ Mikrotik config found in ${configSource}`);
                }
            } catch (settingsError) {
                logger.warn(`Settings.json check failed: ${settingsError.message}`);
            }
        }
        
        if (!hasMikrotikConfig) {
            logger.warn('⚠️ PPPoE monitoring tidak dapat dimulai: Mikrotik belum dikonfigurasi');
            logger.warn('⚠️ Silakan konfigurasi Mikrotik di Admin → Connection Settings');
            return { success: false, message: 'Mikrotik belum dikonfigurasi' };
        }
        
        const result = await startPPPoEMonitoring();
        if (result.success) {
            logger.info(`✅ PPPoE monitoring auto-started on initialization (using ${configSource})`);
        } else {
            logger.error(`❌ Failed to start PPPoE monitoring: ${result.message}`);
        }
        return result;
    } catch (error) {
        logger.error(`❌ Error initializing PPPoE monitoring: ${error.message}`);
        logger.error(`Error stack: ${error.stack}`);
        return { success: false, message: error.message };
    }
}

// Set WhatsApp socket
function setSock(sockInstance) {
    pppoeNotifications.setSock(sockInstance);
}

module.exports = {
    setSock,
    startPPPoEMonitoring,
    stopPPPoEMonitoring,
    restartPPPoEMonitoring,
    getMonitoringStatus,
    setMonitoringInterval,
    initializePPPoEMonitoring,
    checkPPPoEChanges
};
