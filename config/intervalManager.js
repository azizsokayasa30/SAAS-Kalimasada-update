/**
 * Interval Manager
 * Mengelola interval monitoring sistem dengan kemampuan restart real-time
 */

const { getSetting } = require('./settingsManager');
const logger = require('./logger');
const MIN_MONITORING_INTERVAL_MS = 10 * 1000;

function getSafeIntervalMs(settingKey, defaultMs) {
    const parsed = parseInt(getSetting(settingKey, defaultMs), 10);
    const intervalMs = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
    return Math.max(intervalMs, MIN_MONITORING_INTERVAL_MS);
}

const TENANT_POLL_MS = 60 * 1000;

class IntervalManager {
    constructor() {
        this.intervals = {
            rxPowerWarning: null,
            rxPowerRecap: null,
            offlineNotification: null
        };
        
        this.timeouts = {
            rxPowerWarning: null,
            rxPowerRecap: null,
            offlineNotification: null
        };
        
        this.isInitialized = false;
    }

    /**
     * Inisialisasi semua interval monitoring
     */
    initialize() {
        if (this.isInitialized) {
            logger.warn('IntervalManager already initialized, restarting...');
            this.stopAll();
        }

        this.startRXPowerWarning();
        this.startRXPowerRecap();
        this.startOfflineNotification();
        
        this.isInitialized = true;
        logger.info('IntervalManager initialized successfully');
    }

    /**
     * Restart semua interval dengan pengaturan terbaru
     */
    restartAll() {
        logger.info('Restarting all intervals with latest settings...');
        this.stopAll();
        this.initialize();
    }

    /**
     * Stop semua interval dan timeout
     */
    stopAll() {
        Object.keys(this.intervals).forEach(key => {
            if (this.intervals[key]) {
                clearInterval(this.intervals[key]);
                this.intervals[key] = null;
            }
        });

        Object.keys(this.timeouts).forEach(key => {
            if (this.timeouts[key]) {
                clearTimeout(this.timeouts[key]);
                this.timeouts[key] = null;
            }
        });

        this.isInitialized = false;
        logger.info('All intervals stopped');
    }

    /**
     * Start RX Power Warning monitoring
     */
    startRXPowerWarning() {
        try {
            logger.info('Starting RX Power Warning monitoring (per-tenant toggle, poll 60s)');

            const { checkRXPowerAndNotify } = require('./rxPowerMonitor');
            
            this.timeouts.rxPowerWarning = setTimeout(() => {
                checkRXPowerAndNotify().catch(err => {
                    logger.error('Error in initial RX Power check:', err.message);
                });
            }, 10000);

            this.intervals.rxPowerWarning = setInterval(() => {
                checkRXPowerAndNotify().catch(err => {
                    logger.error('Error in periodic RX Power check:', err.message);
                });
            }, TENANT_POLL_MS);

        } catch (error) {
            logger.error('Error starting RX Power Warning monitoring:', error.message);
        }
    }

    /**
     * Start RX Power Recap monitoring
     */
    startRXPowerRecap() {
        try {
            logger.info('Starting RX Power Recap monitoring (per-tenant toggle, poll 60s)');

            const { monitorRXPower } = require('./genieacs');
            
            this.timeouts.rxPowerRecap = setTimeout(() => {
                monitorRXPower().catch(err => {
                    logger.error('Error in initial RX Power Recap check:', err.message);
                });
            }, 5 * 60 * 1000);

            this.intervals.rxPowerRecap = setInterval(() => {
                monitorRXPower().catch(err => {
                    logger.error('Error in periodic RX Power Recap check:', err.message);
                });
            }, TENANT_POLL_MS);

        } catch (error) {
            logger.error('Error starting RX Power Recap monitoring:', error.message);
        }
    }

    /**
     * Start Offline Notification monitoring
     */
    startOfflineNotification() {
        try {
            logger.info('Starting Offline Notification monitoring (per-tenant toggle, poll 60s)');

            const { monitorOfflineDevices } = require('./genieacs');
            
            this.timeouts.offlineNotification = setTimeout(() => {
                monitorOfflineDevices().catch(err => {
                    logger.error('Error in initial Offline Notification check:', err.message);
                });
            }, 5 * 60 * 1000);

            this.intervals.offlineNotification = setInterval(() => {
                monitorOfflineDevices().catch(err => {
                    logger.error('Error in periodic Offline Notification check:', err.message);
                });
            }, TENANT_POLL_MS);

        } catch (error) {
            logger.error('Error starting Offline Notification monitoring:', error.message);
        }
    }

    /**
     * Restart interval tertentu
     */
    restartInterval(intervalType) {
        switch (intervalType) {
            case 'rxPowerWarning':
                if (this.intervals.rxPowerWarning) {
                    clearInterval(this.intervals.rxPowerWarning);
                    this.intervals.rxPowerWarning = null;
                }
                if (this.timeouts.rxPowerWarning) {
                    clearTimeout(this.timeouts.rxPowerWarning);
                    this.timeouts.rxPowerWarning = null;
                }
                this.startRXPowerWarning();
                break;

            case 'rxPowerRecap':
                if (this.intervals.rxPowerRecap) {
                    clearInterval(this.intervals.rxPowerRecap);
                    this.intervals.rxPowerRecap = null;
                }
                if (this.timeouts.rxPowerRecap) {
                    clearTimeout(this.timeouts.rxPowerRecap);
                    this.timeouts.rxPowerRecap = null;
                }
                this.startRXPowerRecap();
                break;

            case 'offlineNotification':
                if (this.intervals.offlineNotification) {
                    clearInterval(this.intervals.offlineNotification);
                    this.intervals.offlineNotification = null;
                }
                if (this.timeouts.offlineNotification) {
                    clearTimeout(this.timeouts.offlineNotification);
                    this.timeouts.offlineNotification = null;
                }
                this.startOfflineNotification();
                break;

            default:
                logger.warn(`Unknown interval type: ${intervalType}`);
        }
    }

    /**
     * Get status semua interval
     */
    getStatus() {
        return {
            isInitialized: this.isInitialized,
            intervals: {
                rxPowerWarning: !!this.intervals.rxPowerWarning,
                rxPowerRecap: !!this.intervals.rxPowerRecap,
                offlineNotification: !!this.intervals.offlineNotification
            },
            timeouts: {
                rxPowerWarning: !!this.timeouts.rxPowerWarning,
                rxPowerRecap: !!this.timeouts.rxPowerRecap,
                offlineNotification: !!this.timeouts.offlineNotification
            }
        };
    }

    /**
     * Get current interval settings
     */
    getCurrentSettings() {
        return {
            rxPowerWarning: {
                enabled: getSetting('rx_power_notification_enable', true),
                intervalMs: getSafeIntervalMs('rx_power_warning_interval', 36000000),
                intervalHours: Math.round(getSafeIntervalMs('rx_power_warning_interval', 36000000) / (1000 * 60 * 60))
            },
            rxPowerRecap: {
                enabled: getSetting('rxpower_recap_enable', true),
                intervalMs: getSafeIntervalMs('rxpower_recap_interval', 21600000),
                intervalHours: Math.round(getSafeIntervalMs('rxpower_recap_interval', 21600000) / (1000 * 60 * 60))
            },
            offlineNotification: {
                enabled: getSetting('offline_notification_enable', true),
                intervalMs: getSafeIntervalMs('offline_notification_interval', 43200000),
                intervalHours: Math.round(getSafeIntervalMs('offline_notification_interval', 43200000) / (1000 * 60 * 60))
            }
        };
    }
}

// Singleton instance
const intervalManager = new IntervalManager();

module.exports = intervalManager;
