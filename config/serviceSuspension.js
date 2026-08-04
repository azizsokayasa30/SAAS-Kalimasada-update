const logger = require('./logger');
const billingManager = require('./billing');
const {
    getMikrotikConnectionForCustomer,
    suspendUserRadius,
    unsuspendUserRadius,
    updateIsolirPreviousGroupRadius,
    disablePppoeUserRadius,
    enablePppoeUserRadius,
    disconnectPPPoEUser
} = require('./mikrotik');
const { classifySuspendReason, isSuspendedStatus, shouldAutoRestoreCustomer } = require('../utils/customerSuspendReason');
const { findDeviceByPhoneNumber, findDeviceByPPPoE, setParameterValues } = require('./genieacs');
const { getSetting } = require('./settingsManager');
const { getTenantSetting } = require('./platform/tenantSettings');
const staticIPSuspension = require('./staticIPSuspension');
const { getRadiusConfigValue } = require('./radiusConfig');

// Helper untuk get user_auth_mode (prioritaskan database)
async function getUserAuthMode() {
    try {
        const mode = await getRadiusConfigValue('user_auth_mode', null);
        if (mode !== null) return mode;
    } catch (e) {
        // Fallback ke settings.json
    }
    return getTenantSetting('user_auth_mode', getSetting('user_auth_mode', 'radius'));
}

/** Jeda singkat setelah disconnect agar NAS sempat membersihkan sesi (dulu 1s — terlalu memperlambat admin). */
const POST_DISCONNECT_SETTLE_MS = 400;
const GENIEACS_WAN_MS = 5000;

function withTimeout(promise, ms, label = 'operation') {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} (${ms}ms)`)), ms);
    });
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        timeoutPromise
    ]);
}

function isAutoSuspensionEnabledFlag() {
    const raw = getTenantSetting('auto_suspension_enabled', getSetting('auto_suspension_enabled', true));
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

/** Tanggal isolir otomatis global setiap bulan (1–28), default 25. */
function getAutoSuspensionDay() {
    const raw = parseInt(
        getTenantSetting('auto_suspension_day', getSetting('auto_suspension_day', '25')),
        10
    );
    if (!Number.isFinite(raw)) return 25;
    return Math.min(Math.max(raw, 1), 28);
}

function isAutoSuspensionDay(date = new Date()) {
    return date.getDate() === getAutoSuspensionDay();
}

/** Tanggal isolir pelanggan: kolom auto_suspension_day atau fallback global. */
function getCustomerAutoSuspensionDay(customer) {
    if (customer && customer.auto_suspension_day != null && customer.auto_suspension_day !== '') {
        const per = parseInt(customer.auto_suspension_day, 10);
        if (Number.isFinite(per) && per >= 1 && per <= 28) return per;
    }
    return getAutoSuspensionDay();
}

function isCustomerAutoSuspensionDay(customer, date = new Date()) {
    return date.getDate() === getCustomerAutoSuspensionDay(customer);
}

/** Scheduler: admin manual pakai force; otomatis dicek per pelanggan di loop. */
function shouldRunAutoSuspension(options = {}) {
    if (options && options.force) return true;
    return true;
}

/**
 * Router untuk disconnect PPPoE. Tanpa mapping: pindai router dengan timeout per-router + budget total
 * agal request admin tidak hang menunggu NAS yang tidak merespons.
 */
async function findRouterForPppDisconnect(customer, pppUser) {
    const { getRouterForCustomer, getMikrotikConnectionForRouter } = require('./mikrotik');
    const PER_ROUTER_MS = 2800;
    const GET_ROUTER_MS = 4000;
    const SCAN_BUDGET_MS = 12000;
    const scanStart = Date.now();

    try {
        return await withTimeout(
            getRouterForCustomer(customer),
            GET_ROUTER_MS,
            'getRouterForCustomer'
        );
    } catch (e) {
        logger.warn(`RADIUS: getRouterForCustomer gagal untuk ${pppUser}: ${e.message} — pindai router (waktu terbatas)`);
    }

    const sqlite3 = require('sqlite3').verbose();
    const dbPath = require('path').join(__dirname, '../data/billing.db');
    const db = new sqlite3.Database(dbPath);
    let tenantFilterSql = '';
    const tenantParams = [];
    try {
        const { hasTenantContext, getTenantId } = require('./platform/tenantContext');
        if (hasTenantContext()) {
            tenantFilterSql = ' WHERE tenant_id = ?';
            tenantParams.push(getTenantId());
        }
    } catch (_) {}
    const routers = await new Promise((resolve) =>
        db.all(`SELECT * FROM routers${tenantFilterSql} ORDER BY id`, tenantParams, (err, rows) => {
            db.close();
            resolve(rows || []);
        })
    );

    for (const router of routers) {
        if (Date.now() - scanStart > SCAN_BUDGET_MS) {
            logger.warn(`RADIUS: Batas pindaian router ${SCAN_BUDGET_MS}ms untuk ${pppUser}`);
            break;
        }
        try {
            const conn = await withTimeout(
                getMikrotikConnectionForRouter(router),
                PER_ROUTER_MS,
                `mikrotik connect ${router.name}`
            );
            const activeSessions = await withTimeout(
                conn.write('/ppp/active/print', [`?name=${pppUser}`]),
                PER_ROUTER_MS,
                `ppp active ${router.name}`
            );
            if (activeSessions && activeSessions.length > 0) {
                logger.info(`RADIUS: Found active session for ${pppUser} on router ${router.name}`);
                return router;
            }
        } catch (_) {
            // router berikutnya
        }
    }

    if (routers.length > 0) {
        logger.warn(`RADIUS: Tidak ada sesi aktif terdeteksi dalam batas waktu, fallback router pertama: ${routers[0].name}`);
        return routers[0];
    }
    return null;
}

class ServiceSuspensionManager {
    constructor() {
        /** @type {Set<string>} lock per tenant agar job tenant A tidak skip job tenant B */
        this.runningKeys = new Set();
        /** @type {Set<string>} lock khusus Sync Isolir (terpisah agar tidak mengganggu job overdue/restore) */
        this.isolirSyncKeys = new Set();
    }

    _runKey() {
        try {
            const { hasTenantContext, getTenantId } = require('./platform/tenantContext');
            if (hasTenantContext()) return `t:${getTenantId()}`;
        } catch (_) {}
        return 'global';
    }

    _tryAcquireRun() {
        const key = this._runKey();
        if (this.runningKeys.has(key)) return null;
        this.runningKeys.add(key);
        return key;
    }

    _releaseRun(key) {
        if (key) this.runningKeys.delete(key);
    }

    _tryAcquireIsolirSync() {
        const key = this._runKey();
        if (this.isolirSyncKeys.has(key)) return null;
        this.isolirSyncKeys.add(key);
        return key;
    }

    _releaseIsolirSync(key) {
        if (key) this.isolirSyncKeys.delete(key);
    }

    /**
     * Pastikan profile isolir (berdasarkan setting) tersedia di Mikrotik jika perlu
     * Hanya auto-create bila nama profil = 'isolir'
     */
    async ensureIsolirProfile(customer) {
        try {
            const mikrotik = await getMikrotikConnectionForCustomer(customer);
            
            const selectedProfile = getTenantSetting('isolir_profile', getSetting('isolir_profile', 'isolir'));
            // Cek apakah profile isolir sudah ada
            const profiles = await mikrotik.write('/ppp/profile/print', [
                `?name=${selectedProfile}`
            ]);
            
            if (profiles && profiles.length > 0) {
                logger.info(`Isolir profile '${selectedProfile}' already exists in Mikrotik`);
                return profiles[0]['.id'];
            }
            
            // Buat profile jika belum ada, menggunakan nama sesuai setting
            const newProfile = await mikrotik.write('/ppp/profile/add', [
                `=name=${selectedProfile}`,
                '=local-address=0.0.0.0',
                '=remote-address=0.0.0.0',
                '=rate-limit=0/0',
                '=comment=SUSPENDED_PROFILE',
                '=shared-users=1'
            ]);
            
            const profileId = newProfile[0]['ret'];
            logger.info('Created isolir profile in Mikrotik with ID:', profileId);
            return profileId;
            
        } catch (error) {
            logger.error('Error ensuring isolir profile:', error);
            throw error;
        }
    }

    /**
     * Suspend layanan pelanggan (blokir internet)
     * Mendukung PPPoE dan IP statik
     * @param {object} [options]
     * @param {boolean} [options.skipBillingStatus] — jangan update status di DB (untuk WA dulu di luar)
     * @param {boolean} [options.awaitWhatsApp] — tunggu kirim WA sebelum return (dipakai dengan skipBillingStatus)
     */
    async suspendCustomerService(customer, reason = 'Telat bayar', options = {}) {
        try {
            const { skipBillingStatus = false, awaitWhatsApp = false } = options || {};
            logger.info(`Suspending service for customer: ${customer.username} (${reason})`);

            const results = {
                mikrotik: false,
                genieacs: false,
                olt: false,
                billing: false,
                suspension_type: null
            };

            // Tentukan tipe koneksi pelanggan
            // Prefer jalur static jika ada IP/MAC dan tidak ada pppoe_username eksplisit
            // (jangan fallback ke username portal — itu login billing, bukan secret PPPoE)
            const explicitPppoe = customer.pppoe_username && String(customer.pppoe_username).trim();
            const hasStaticIP = !!(customer.static_ip || customer.ip_address || customer.assigned_ip);
            const hasMacAddress = !!customer.mac_address;
            const pppUser = explicitPppoe
                || (!hasStaticIP && !hasMacAddress && customer.username ? String(customer.username).trim() : '');
            const hasPPPoE = !!pppUser;

            // 1. Prioritas suspend PPPoE jika tersedia
            if (hasPPPoE) {
                results.suspension_type = 'pppoe';
                const authMode = await getUserAuthMode();
                
                // Check jika menggunakan RADIUS mode
                if (authMode === 'radius') {
                    try {
                        // 1) Pindah ke group isolir dulu, 2) putus sesi aktif agar reconnect pakai atribut isolir
                        const suspendResult = await suspendUserRadius(pppUser);
                        if (suspendResult && suspendResult.success) {
                            results.mikrotik = true;
                            results.radius = true;
                            logger.info(
                                `RADIUS: User ${pppUser} dipindah ke group isolir (kicked ${suspendResult.disconnected || 0} sesi)`
                            );
                            if ((suspendResult.disconnected || 0) > 0) {
                                await new Promise((resolve) => setTimeout(resolve, POST_DISCONNECT_SETTLE_MS));
                            }
                        } else {
                            logger.error(`RADIUS: Suspension failed for ${pppUser}`);
                        }
                    } catch (radiusError) {
                        logger.error(`RADIUS suspension failed for ${customer.username}:`, radiusError.message);
                    }
                } else {
                    // Mode Mikrotik API (original code)
                    try {
                        const mikrotik = await getMikrotikConnectionForCustomer(customer);
                        
                        // Tentukan profile isolir dari setting
                        const selectedProfile = getTenantSetting('isolir_profile', getSetting('isolir_profile', 'isolir'));
                        // Pastikan profile isolir ada pada NAS milik customer
                        await this.ensureIsolirProfile(customer);

                        // 1) Ubah secret ke profile isolir, 2) putus sesi aktif agar reconnect pakai isolir
                        let secretId = null;
                        try {
                            const secrets = await mikrotik.write('/ppp/secret/print', [
                                `?name=${pppUser}`
                            ]);
                            if (secrets && secrets.length > 0) {
                                secretId = secrets[0]['.id'];
                            }
                        } catch (lookupErr) {
                            logger.warn(`Mikrotik: failed to lookup secret id for ${customer.pppoe_username}: ${lookupErr.message}`);
                        }

                        const setParams = secretId
                            ? [`=.id=${secretId}`, `=profile=${selectedProfile}`, `=comment=SUSPENDED - ${reason}`]
                            : [`=name=${pppUser}`, `=profile=${selectedProfile}`, `=comment=SUSPENDED - ${reason}`];

                        await mikrotik.write('/ppp/secret/set', setParams);
                        logger.info(`Mikrotik: Set profile to '${selectedProfile}' for ${customer.pppoe_username} (${secretId ? 'by .id' : 'by name'})`);

                        const { disconnectPPPoEUser } = require('./mikrotik');
                        let disconnectResult;
                        try {
                            disconnectResult = await withTimeout(
                                disconnectPPPoEUser(pppUser, mikrotik),
                                8000,
                                `disconnect PPPoE API ${pppUser}`
                            );
                        } catch (e) {
                            disconnectResult = { success: false, disconnected: 0, message: e.message };
                            logger.warn(`Mikrotik: disconnect timeout/error untuk ${pppUser}: ${e.message}`);
                        }

                        if (disconnectResult.success && disconnectResult.disconnected > 0) {
                            logger.info(`Mikrotik: Disconnected ${disconnectResult.disconnected} active PPPoE session(s) for ${customer.pppoe_username} after isolir profile`);
                            await new Promise((resolve) => setTimeout(resolve, POST_DISCONNECT_SETTLE_MS));
                        } else if (disconnectResult.disconnected === 0) {
                            logger.info(`Mikrotik: User ${customer.pppoe_username} tidak sedang online setelah ubah profile isolir`);
                        } else {
                            logger.warn(`Mikrotik: Disconnect result: ${disconnectResult.message}`);
                        }

                        results.mikrotik = true;
                        logger.info(`Mikrotik: Successfully suspended PPPoE user ${customer.pppoe_username} with isolir profile`);
                    } catch (mikrotikError) {
                        logger.error(`Mikrotik PPPoE suspension failed for ${customer.username}:`, mikrotikError.message);
                    }
                }
            }
            // 2. Jika tidak ada PPPoE, coba suspend IP statik
            else if (hasStaticIP || hasMacAddress) {
                results.suspension_type = 'static_ip';
                try {
                    // Tentukan metode suspend dari setting (default: address_list)
                    const suspensionMethod = getSetting('static_ip_suspension_method', 'address_list');
                    
                    const staticResult = await staticIPSuspension.suspendStaticIPCustomer(
                        customer, 
                        reason, 
                        suspensionMethod
                    );
                    
                    if (staticResult.success) {
                        results.mikrotik = true;
                        results.static_ip_method = staticResult.results?.method_used;
                        logger.info(`Static IP suspension successful for ${customer.username} using ${staticResult.results?.method_used}`);
                        try {
                            const { syncPoolAfterCustomerChange } = require('./staticIpPoolSync');
                            await syncPoolAfterCustomerChange({ ...customer, status: 'suspended' });
                            results.pool_sync = true;
                        } catch (poolErr) {
                            logger.warn(`Static IP pool sync after suspend: ${poolErr.message}`);
                        }
                    } else {
                        logger.error(`Static IP suspension failed for ${customer.username}: ${staticResult.error}`);
                    }
                } catch (staticIPError) {
                    logger.error(`Static IP suspension failed for ${customer.username}:`, staticIPError.message);
                }
            }
            // 3. Jika tidak ada PPPoE atau IP statik, coba cari device untuk suspend WAN
            else {
                results.suspension_type = 'wan_disable';
                logger.warn(`Customer ${customer.username} has no PPPoE username or static IP, trying WAN disable method`);
            }

            // GenieACS hanya untuk pelanggan tanpa PPPoE/static (WAN disable). Isolir PPPoE cukup RADIUS/Mikrotik — hindari timeout pencarian device.
            if (results.suspension_type === 'wan_disable' && (customer.phone || customer.pppoe_username)) {
                try {
                    await Promise.race([
                        (async () => {
                            let device = null;
                            if (customer.phone) {
                                try {
                                    device = await findDeviceByPhoneNumber(customer.phone);
                                } catch (phoneError) {
                                    logger.warn(`Device not found by phone ${customer.phone}, trying PPPoE...`);
                                }
                            }
                            if (!device && customer.pppoe_username) {
                                try {
                                    device = await findDeviceByPPPoE(customer.pppoe_username);
                                } catch (pppoeError) {
                                    logger.warn(`Device not found by PPPoE ${customer.pppoe_username}`);
                                }
                            }
                            if (device) {
                                const parameters = [
                                    ["InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Enable", false, "xsd:boolean"],
                                    ["InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Enable", false, "xsd:boolean"]
                                ];
                                await setParameterValues(device._id, parameters);
                                results.genieacs = true;
                                logger.info(`GenieACS: Successfully suspended device ${device._id} for customer ${customer.username}`);
                            } else {
                                logger.warn(`GenieACS: No device found for customer ${customer.username}`);
                            }
                        })(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('GenieACS suspend timeout')), GENIEACS_WAN_MS))
                    ]);
                } catch (genieacsError) {
                    logger.error(`GenieACS suspension failed for ${customer.username}:`, genieacsError.message);
                }
            }

            if (customer.onu_id) {
                try {
                    const oltService = require('../services/olt/OltService');
                    await oltService.disableOnu(customer.onu_id);
                    results.olt = true;
                    logger.info(`OLT: Disabled ONU ${customer.onu_id} for suspended customer ${customer.username}`);
                } catch (oltError) {
                    logger.error(`OLT auto isolation failed for ${customer.username}:`, oltError.message);
                }
            }

            // Update status di billing database
            const alreadySuspended = isSuspendedStatus(customer?.status);
            const suspendReasonClass = classifySuspendReason(reason);
            const persistSuspendReason = async (customerId) => {
                if (!customerId) return;
                try {
                    await billingManager.setSuspendReasonById(customerId, suspendReasonClass);
                } catch (e) {
                    logger.warn(`[SUSPEND] Gagal menyimpan suspend_reason untuk id=${customerId}: ${e.message}`);
                }
            };
            if (!skipBillingStatus) {
                try {
                    if (!alreadySuspended && customer.id) {
                        logger.info(`[SUSPEND] Updating billing status by id=${customer.id} to 'suspended' (username=${customer.username||customer.pppoe_username||'-'})`);
                        await billingManager.setCustomerStatusById(customer.id, 'suspended', { skipRadiusSync: true });
                        await persistSuspendReason(customer.id);
                        results.billing = true;
                    } else if (!alreadySuspended) {
                        let resolved = null;
                        if (customer.pppoe_username) {
                            try { resolved = await billingManager.getCustomerByUsername(customer.pppoe_username); } catch (_) {}
                        }
                        if (!resolved && customer.username) {
                            try { resolved = await billingManager.getCustomerByUsername(customer.username); } catch (_) {}
                        }
                        if (!resolved && customer.phone) {
                            try { resolved = await billingManager.getCustomerByPhone(customer.phone); } catch (_) {}
                        }
                        if (resolved && resolved.id) {
                            logger.info(`[SUSPEND] Resolved customer id=${resolved.id} (username=${resolved.pppoe_username||resolved.username||'-'}) → set 'suspended'`);
                            await billingManager.setCustomerStatusById(resolved.id, 'suspended', { skipRadiusSync: true });
                            await persistSuspendReason(resolved.id);
                            results.billing = true;
                        } else if (customer.phone) {
                            logger.warn(`[SUSPEND] Falling back to update by phone=${customer.phone} (no id resolved)`);
                            await billingManager.updateCustomer(customer.phone, { ...customer, status: 'suspended' });
                            results.billing = true;
                        } else {
                            logger.error(`[SUSPEND] Unable to resolve customer identifier for status update`);
                        }
                    } else if (alreadySuspended && customer.id) {
                        await persistSuspendReason(customer.id);
                        results.billing = true;
                    }
                } catch (billingError) {
                    logger.error(`Billing update failed for ${customer.username}:`, billingError.message);
                }
            }

            const sendSuspensionWa = async () => {
                const { isWaSystemMonitorEnabled } = require('./whatsappMonitoringSettings');
                if (!isWaSystemMonitorEnabled('isolir_suspension_wa')) {
                    logger.info('isolir_suspension_wa off — skip WA suspensi');
                    return;
                }
                const whatsappNotifications = require('./whatsapp-notifications');
                await whatsappNotifications.sendServiceSuspensionNotification(customer, reason);
            };

            if (awaitWhatsApp) {
                try {
                    await sendSuspensionWa();
                } catch (notificationError) {
                    logger.error(`WhatsApp notification failed for ${customer.username}:`, notificationError.message);
                }
            } else {
                void (async () => {
                    try {
                        await sendSuspensionWa();
                    } catch (notificationError) {
                        logger.error(`WhatsApp notification failed for ${customer.username}:`, notificationError.message);
                    }
                })();
            }

            return {
                success: results.mikrotik || results.genieacs || results.olt || results.billing || results.radius,
                results,
                customer: customer.username,
                reason
            };

        } catch (error) {
            logger.error(`Error suspending service for ${customer.username}:`, error);
            throw error;
        }
    }

    /**
     * Restore layanan pelanggan (aktifkan kembali internet)
     * Mendukung PPPoE dan IP statik
     */
    async restoreCustomerService(customer, reason = 'Manual restore') {
        try {
            logger.info(`Restoring service for customer: ${customer.username} (${reason})`);

            const results = {
                mikrotik: false,
                genieacs: false,
                olt: false,
                billing: false,
                restoration_type: null
            };

            // Tentukan tipe koneksi pelanggan
            // Prefer jalur static jika ada IP/MAC dan tidak ada pppoe_username eksplisit
            // (jangan fallback ke username portal — itu login billing, bukan secret PPPoE)
            const explicitPppoe = customer.pppoe_username && String(customer.pppoe_username).trim();
            const hasStaticIP = !!(customer.static_ip || customer.ip_address || customer.assigned_ip);
            const hasMacAddress = !!customer.mac_address;
            const pppUser = explicitPppoe
                || (!hasStaticIP && !hasMacAddress && customer.username ? String(customer.username).trim() : '');
            const hasPPPoE = !!pppUser;

            // 1. Prioritas restore PPPoE jika tersedia
            if (hasPPPoE) {
                results.restoration_type = 'pppoe';
                const authMode = await getUserAuthMode();
                
                // Check jika menggunakan RADIUS mode
                if (authMode === 'radius') {
                    try {
                        // PENTING: Ubah group ke paket aktif DULU, baru putus sesi PPPoE (sama seperti alur isolir).
                        // Jika disconnect dulu saat masih group isolir, CPE bisa reconnect dan tetap dapat IP isolir.
                        const unsuspendResult = await unsuspendUserRadius(pppUser, customer);
                        if (unsuspendResult && unsuspendResult.success) {
                            results.mikrotik = true;
                            results.radius = true;
                            logger.info(
                                `RADIUS: Restored ${pppUser} to ${unsuspendResult.previousGroup || 'package'} (kicked ${unsuspendResult.disconnected || 0} sesi, MySQL synced)`
                            );
                            if ((unsuspendResult.disconnected || 0) > 0) {
                                await new Promise((resolve) => setTimeout(resolve, POST_DISCONNECT_SETTLE_MS));
                            }
                        } else {
                            logger.error(`RADIUS: Unsuspend failed for ${pppUser}`);
                        }
                    } catch (radiusError) {
                        logger.error(`RADIUS unsuspend failed for ${customer.username}:`, radiusError.message);
                    }
                } else {
                    // Mode Mikrotik API (original code)
                    try {
                        const mikrotik = await getMikrotikConnectionForCustomer(customer);
                        
                        // Ambil profile dari customer atau package, fallback ke default
                        let profileToUse = customer.pppoe_profile;
                        if (!profileToUse) {
                            // Coba ambil dari package
                            const packageData = await billingManager.getPackageById(customer.package_id);
                            profileToUse = packageData?.pppoe_profile || getSetting('default_pppoe_profile', 'default');
                        }
                        
                        // PENTING: Ubah profile secret DULU, baru putus sesi aktif (sama seperti alur isolir).
                        // Jika disconnect dulu saat secret masih profil isolir, CPE reconnect dan tetap dapat IP isolir.
                        let secretId = null;
                        try {
                            const secrets = await mikrotik.write('/ppp/secret/print', [
                                `?name=${pppUser}`
                            ]);
                            if (secrets && secrets.length > 0) {
                                secretId = secrets[0]['.id'];
                            }
                        } catch (lookupErr) {
                            logger.warn(`Mikrotik: failed to lookup secret id for ${customer.pppoe_username}: ${lookupErr.message}`);
                        }

                        const setParams = secretId
                            ? [`=.id=${secretId}`, `=profile=${profileToUse}`, `=comment=ACTIVE - ${reason}`]
                            : [`=name=${pppUser}`, `=profile=${profileToUse}`, `=comment=ACTIVE - ${reason}`];

                        await mikrotik.write('/ppp/secret/set', setParams);
                        logger.info(`Mikrotik: Restored profile to '${profileToUse}' for ${customer.pppoe_username} (${secretId ? 'by .id' : 'by name'})`);

                        const { disconnectPPPoEUserAllRouters } = require('./mikrotik');
                        let disconnectResult;
                        try {
                            disconnectResult = await withTimeout(
                                disconnectPPPoEUserAllRouters(pppUser),
                                15000,
                                `disconnect PPPoE all routers ${pppUser}`
                            );
                        } catch (e) {
                            disconnectResult = { success: false, disconnected: 0, message: e.message };
                            logger.warn(`Mikrotik: disconnect timeout/error untuk ${pppUser}: ${e.message}`);
                        }

                        if (disconnectResult.disconnected > 0) {
                            logger.info(
                                `Mikrotik: Disconnected ${disconnectResult.disconnected} session(s) for ${customer.pppoe_username} after restore to ${profileToUse} (routers: ${(disconnectResult.routers || []).join(', ')})`
                            );
                            await new Promise((resolve) => setTimeout(resolve, POST_DISCONNECT_SETTLE_MS));
                        } else {
                            logger.info(`Mikrotik: User ${customer.pppoe_username} tidak sedang online setelah ubah profile ke ${profileToUse}`);
                        }

                        results.mikrotik = true;
                        logger.info(`Mikrotik: Successfully restored PPPoE user ${customer.pppoe_username} with ${profileToUse} profile`);
                    } catch (mikrotikError) {
                        logger.error(`Mikrotik PPPoE restoration failed for ${customer.username}:`, mikrotikError.message);
                    }
                }
            }
            // 2. Jika tidak ada PPPoE, coba restore IP statik
            else if (hasStaticIP || hasMacAddress) {
                results.restoration_type = 'static_ip';
                try {
                    const staticResult = await staticIPSuspension.restoreStaticIPCustomer(customer, reason);
                    
                    if (staticResult.success) {
                        results.mikrotik = true;
                        results.static_ip_methods = staticResult.results?.methods_tried;
                        logger.info(`Static IP restoration successful for ${customer.username}. Methods: ${staticResult.results?.methods_tried?.join(', ')}`);
                        try {
                            const { syncPoolAfterCustomerChange } = require('./staticIpPoolSync');
                            await syncPoolAfterCustomerChange({ ...customer, status: 'active' });
                            results.pool_sync = true;
                        } catch (poolErr) {
                            logger.warn(`Static IP pool sync after restore: ${poolErr.message}`);
                        }
                    } else {
                        logger.error(`Static IP restoration failed for ${customer.username}: ${staticResult.error}`);
                    }
                } catch (staticIPError) {
                    logger.error(`Static IP restoration failed for ${customer.username}:`, staticIPError.message);
                }

                // Re-apply package speed queue after lifting suspension
                try {
                    const { provisionStaticIPQueue, getCustomerStaticIp } = require('./staticIPProvisioning');
                    if (getCustomerStaticIp(customer) && customer.package_id) {
                        const pkg = await billingManager.getPackageById(customer.package_id);
                        const prov = await provisionStaticIPQueue(customer, pkg);
                        if (prov && prov.success) {
                            results.mikrotik = true;
                            results.static_ip_queue = prov.queue;
                            results.static_ip_rate = prov.maxLimit;
                            logger.info(`Static IP package queue restored for ${customer.username}: ${prov.queue} (${prov.maxLimit})`);
                        } else if (prov && !prov.skipped) {
                            logger.warn(`Static IP package queue re-provision failed for ${customer.username}: ${prov.message}`);
                        }
                    }
                } catch (provErr) {
                    logger.warn(`Static IP package queue re-provision error for ${customer.username}: ${provErr.message}`);
                }
            }
            // 3. Jika tidak ada PPPoE atau IP statik, coba enable WAN
            else {
                results.restoration_type = 'wan_enable';
                logger.warn(`Customer ${customer.username} has no PPPoE username or static IP, trying WAN enable method`);
            }

            // GenieACS hanya untuk wan_enable (tanpa PPPoE/static). Restore PPPoE cukup RADIUS/Mikrotik — hindari timeout pencarian device.
            if (results.restoration_type === 'wan_enable' && (customer.phone || customer.pppoe_username)) {
                try {
                    await Promise.race([
                        (async () => {
                            let device = null;
                            if (customer.phone) {
                                try {
                                    device = await findDeviceByPhoneNumber(customer.phone);
                                } catch (phoneError) {
                                    logger.warn(`Device not found by phone ${customer.phone}, trying PPPoE...`);
                                }
                            }
                            if (!device && customer.pppoe_username) {
                                try {
                                    device = await findDeviceByPPPoE(customer.pppoe_username);
                                } catch (pppoeError) {
                                    logger.warn(`Device not found by PPPoE ${customer.pppoe_username}`);
                                }
                            }
                            if (device) {
                                const parameters = [
                                    ["InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Enable", true, "xsd:boolean"],
                                    ["InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Enable", true, "xsd:boolean"]
                                ];
                                await setParameterValues(device._id, parameters);
                                results.genieacs = true;
                                logger.info(`GenieACS: Successfully restored device ${device._id} for customer ${customer.username}`);
                            } else {
                                logger.warn(`GenieACS: No device found for customer ${customer.username}`);
                            }
                        })(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('GenieACS restore timeout')), GENIEACS_WAN_MS))
                    ]);
                } catch (genieacsError) {
                    logger.error(`GenieACS restoration failed for ${customer.username}:`, genieacsError.message);
                }
            }

            if (customer.onu_id) {
                try {
                    const oltService = require('../services/olt/OltService');
                    await oltService.enableOnu(customer.onu_id);
                    results.olt = true;
                    logger.info(`OLT: Enabled ONU ${customer.onu_id} for restored customer ${customer.username}`);
                } catch (oltError) {
                    logger.error(`OLT auto restore failed for ${customer.username}:`, oltError.message);
                }
            }

            // 3. Update status di billing database (skip jika billing sudah active — mis. setelah updateCustomerByPhone)
            const alreadyActive = String(customer?.status || '').toLowerCase() === 'active';
            try {
                if (!alreadyActive && customer.id) {
                    logger.info(`[RESTORE] Updating billing status by id=${customer.id} to 'active' (username=${customer.username||customer.pppoe_username||'-'})`);
                    await billingManager.setCustomerStatusById(customer.id, 'active', { skipRadiusSync: true });
                    results.billing = true;
                } else if (!alreadyActive) {
                    // Resolve by username first, then phone
                    let resolved = null;
                    if (customer.pppoe_username) {
                        try { resolved = await billingManager.getCustomerByUsername(customer.pppoe_username); } catch (_) {}
                    }
                    if (!resolved && customer.username) {
                        try { resolved = await billingManager.getCustomerByUsername(customer.username); } catch (_) {}
                    }
                    if (!resolved && customer.phone) {
                        try { resolved = await billingManager.getCustomerByPhone(customer.phone); } catch (_) {}
                    }
                    if (resolved && resolved.id) {
                        logger.info(`[RESTORE] Resolved customer id=${resolved.id} (username=${resolved.pppoe_username||resolved.username||'-'}) → set 'active'`);
                        await billingManager.setCustomerStatusById(resolved.id, 'active', { skipRadiusSync: true });
                        results.billing = true;
                    } else if (customer.phone) {
                        logger.warn(`[RESTORE] Falling back to update by phone=${customer.phone} (no id resolved)`);
                        await billingManager.updateCustomer(customer.phone, { ...customer, status: 'active' });
                        results.billing = true;
                    } else {
                        logger.error(`[RESTORE] Unable to resolve customer identifier for status update`);
                    }
                } else if (alreadyActive && customer.id) {
                    results.billing = true;
                }
            } catch (billingError) {
                logger.error(`Billing restore update failed for ${customer.username}:`, billingError.message);
            }

            // 4–5. Notifikasi di background
            void (async () => {
                try {
                    const { isWaSystemMonitorEnabled } = require('./whatsappMonitoringSettings');
                    if (!isWaSystemMonitorEnabled('isolir_restore_wa')) {
                        logger.info('isolir_restore_wa off — skip WA restore');
                        return;
                    }
                    const whatsappNotifications = require('./whatsapp-notifications');
                    await whatsappNotifications.sendServiceRestorationNotification(customer, reason);
                } catch (notificationError) {
                    logger.error(`WhatsApp notification failed for ${customer.username}:`, notificationError.message);
                }
            })();
            void (async () => {
                try {
                    const emailNotifications = require('./email-notifications');
                    await emailNotifications.sendServiceRestorationNotification(customer, reason);
                } catch (notificationError) {
                    logger.error(`Email notification failed for ${customer.username}:`, notificationError.message);
                }
            })();

            return {
                success: results.mikrotik || results.genieacs || results.olt || results.billing,
                results,
                customer: customer.username,
                reason
            };

        } catch (error) {
            logger.error(`Error restoring service for ${customer.username}:`, error);
            throw error;
        }
    }

    /**
     * Check dan suspend pelanggan yang telat bayar otomatis
     */
    async checkAndSuspendOverdueCustomers(options = {}) {
        const runKey = this._tryAcquireRun();
        if (!runKey) {
            logger.info('Service suspension check already running for this tenant, skipping...');
            return;
        }

        try {
            logger.info(`Starting automatic service suspension check (${runKey})...`);

            const autoSuspensionEnabled = isAutoSuspensionEnabledFlag();
            const defaultSuspensionDay = getAutoSuspensionDay();
            const todayDay = new Date().getDate();
            const forceRun = Boolean(options && options.force);

            if (!autoSuspensionEnabled) {
                logger.info('Auto suspension is disabled in settings');
                return;
            }

            logger.info(
                forceRun
                    ? 'Running manual (force) auto suspension — semua pelanggan unpaid'
                    : `Running auto suspension (hari ini: ${todayDay}, default global: tgl ${defaultSuspensionDay}) — per pelanggan sesuai auto_suspension_day`
            );

            // Tanggal isolir tetap: semua tagihan unpaid (bukan hanya overdue + grace period)
            const unpaidInvoices = await billingManager.getUnpaidInvoicesForAutoSuspension();
            logger.info(`Found ${unpaidInvoices.length} unpaid invoices to check`);
            
            if (unpaidInvoices.length === 0) {
                logger.info('No unpaid invoices found, skipping suspension check');
                return { checked: 0, suspended: 0, errors: 0, details: [] };
            }
            
            const results = {
                checked: 0,
                suspended: 0,
                skipped_wrong_day: 0,
                errors: 0,
                suspension_day: defaultSuspensionDay,
                details: []
            };

            for (const invoice of unpaidInvoices) {
                if (!invoice.customer_id) continue;

                try {
                    const customer = await billingManager.getCustomerById(invoice.customer_id);
                    if (!customer) {
                        logger.warn(`Customer not found for invoice ${invoice.invoice_number}`);
                        continue;
                    }

                    if (!forceRun && !isCustomerAutoSuspensionDay(customer)) {
                        results.skipped_wrong_day++;
                        continue;
                    }

                    results.checked++;

                    // Skip jika sudah suspended/isolir
                    if (isSuspendedStatus(customer.status)) {
                        logger.info(`Customer ${customer.username} already suspended - skipping`);
                        continue;
                    }

                    // Skip jika auto_suspension = 0 (tidak diisolir otomatis)
                    if (customer.auto_suspension === 0) {
                        logger.info(`Customer ${customer.username} has auto_suspension disabled - skipping`);
                        continue;
                    }

                    const customerSuspensionDay = getCustomerAutoSuspensionDay(customer);
                    logger.info(`Customer ${invoice.customer_name}: unpaid invoice ${invoice.invoice_number}, due ${invoice.due_date}`);

                    // Suspend layanan
                    const suspensionResult = await this.suspendCustomerService(customer, `Isolir otomatis tanggal ${customerSuspensionDay}`);
                    
                    if (suspensionResult.success) {
                        results.suspended++;
                        results.details.push({
                            customer: customer.username,
                            invoice: invoice.invoice_number,
                            status: 'suspended'
                        });
                        logger.info(`Successfully suspended service for ${customer.username} (auto suspension day ${customerSuspensionDay})`);
                    } else {
                        results.errors++;
                        results.details.push({
                            customer: customer.username,
                            invoice: invoice.invoice_number,
                            status: 'failed'
                        });
                        logger.error(`Failed to suspend service for ${customer.username}`);
                    }

                } catch (customerError) {
                    results.errors++;
                    logger.error(`Error processing customer for invoice ${invoice.invoice_number}:`, customerError);
                }
            }

            logger.info(`Service suspension check completed. Checked: ${results.checked}, Suspended: ${results.suspended}, Errors: ${results.errors}`);
            return results;

        } catch (error) {
            logger.error('Error in automatic service suspension check:', error);
            throw error;
        } finally {
            this._releaseRun(runKey);
        }
    }

    async checkAndSuspendOverdueMembers(options = {}) {
        const runKey = this._tryAcquireRun();
        if (!runKey) {
            logger.info('Member service suspension check already running for this tenant, skipping...');
            return;
        }

        try {
            logger.info(`Starting automatic member service suspension check (${runKey})...`);

            const autoSuspensionEnabled = isAutoSuspensionEnabledFlag();
            const suspensionDay = getAutoSuspensionDay();
            const todayDay = new Date().getDate();

            if (!autoSuspensionEnabled) {
                logger.info('Auto suspension is disabled in settings');
                return;
            }

            if (!shouldRunAutoSuspension(options)) {
                logger.info(`Member auto suspension hanya dijalankan tanggal ${suspensionDay} setiap bulan (hari ini: ${todayDay}), skipping...`);
                return { checked: 0, suspended: 0, errors: 0, skipped: true, suspension_day: suspensionDay, details: [] };
            }

            const unpaidInvoices = await billingManager.getUnpaidInvoicesForAutoSuspension();
            const memberInvoices = unpaidInvoices.filter(inv => inv.member_id && inv.invoice_type_entity === 'member');
            logger.info(`Found ${memberInvoices.length} unpaid member invoices to check`);
            
            if (memberInvoices.length === 0) {
                logger.info('No unpaid member invoices found, skipping suspension check');
                return { checked: 0, suspended: 0, errors: 0, details: [] };
            }
            
            const results = {
                checked: 0,
                suspended: 0,
                errors: 0,
                suspension_day: suspensionDay,
                details: []
            };

            for (const invoice of memberInvoices) {
                results.checked++;

                try {
                    const member = await billingManager.getMemberById(invoice.member_id);
                    if (!member) {
                        logger.warn(`Member not found for invoice ${invoice.invoice_number}`);
                        continue;
                    }

                    // Skip jika sudah isolir
                    if (member.status === 'isolir') {
                        logger.info(`Member ${member.hotspot_username || member.name} already isolir - skipping`);
                        continue;
                    }

                    // Skip jika auto_suspension = 0
                    if (member.auto_suspension === 0) {
                        logger.info(`Member ${member.hotspot_username || member.name} has auto_suspension disabled - skipping`);
                        continue;
                    }

                    logger.info(`Member ${invoice.member_name}: unpaid invoice ${invoice.invoice_number}, due ${invoice.due_date}`);

                    // Suspend layanan member
                    const suspensionResult = await this.suspendMemberService(member, `Isolir otomatis tanggal ${suspensionDay}`);
                    
                    if (suspensionResult.success) {
                        results.suspended++;
                        results.details.push({
                            member: member.hotspot_username || member.name,
                            invoice: invoice.invoice_number,
                            status: 'suspended'
                        });
                        logger.info(`Successfully suspended service for member ${member.hotspot_username || member.name} (auto suspension day ${suspensionDay})`);
                    } else {
                        results.errors++;
                        results.details.push({
                            member: member.hotspot_username || member.name,
                            invoice: invoice.invoice_number,
                            status: 'failed'
                        });
                        logger.error(`Failed to suspend service for member ${member.hotspot_username || member.name}`);
                    }

                } catch (memberError) {
                    results.errors++;
                    logger.error(`Error processing member for invoice ${invoice.invoice_number}:`, memberError);
                }
            }

            logger.info(`Member service suspension check completed. Checked: ${results.checked}, Suspended: ${results.suspended}, Errors: ${results.errors}`);
            return results;

        } catch (error) {
            logger.error('Error in automatic member service suspension check:', error);
            throw error;
        } finally {
            this._releaseRun(runKey);
        }
    }

    async suspendMemberService(member, reason = 'Telat bayar') {
        try {
            const { disconnectHotspotUser, disableHotspotUserRadius } = require('./mikrotik');
            const authMode = await getUserAuthMode();
            
            if (authMode !== 'radius') {
                logger.warn('Member suspension only supports RADIUS mode');
                return { success: false, message: 'Only RADIUS mode supported' };
            }

            const hotspotUsername = member.hotspot_username;
            if (!hotspotUsername) {
                logger.warn(`Member ${member.name} has no hotspot_username`);
                return { success: false, message: 'No hotspot username' };
            }

            // Disconnect active hotspot session first
            try {
                const disconnectResult = await disconnectHotspotUser(hotspotUsername);
                if (disconnectResult.success) {
                    logger.info(`Disconnected hotspot session for ${hotspotUsername}`);
                    // Wait a bit to ensure disconnect completes
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else if (disconnectResult.message && disconnectResult.message.includes('tidak ditemukan')) {
                    logger.info(`Hotspot user ${hotspotUsername} tidak sedang online`);
                }
            } catch (disconnectError) {
                logger.warn(`Failed to disconnect hotspot session for ${hotspotUsername}: ${disconnectError.message}`);
                // Continue dengan suspend meskipun disconnect gagal
            }

            // Disable hotspot user di RADIUS (tambahkan Auth-Type := Reject)
            // Karena hotspot tidak mempunyai profile isolir, kita disable username langsung
            try {
                const disableResult = await disableHotspotUserRadius(hotspotUsername);
                if (!disableResult || !disableResult.success) {
                    logger.error(`Failed to disable hotspot user ${hotspotUsername} in RADIUS`);
                    return { success: false, message: disableResult?.message || 'RADIUS disable failed' };
                }
                logger.info(`Hotspot user ${hotspotUsername} disabled in RADIUS (Auth-Type := Reject)`);
            } catch (disableError) {
                logger.error(`Error disabling hotspot user ${hotspotUsername}: ${disableError.message}`);
                return { success: false, message: `Failed to disable user: ${disableError.message}` };
            }

            // Update member status to isolir (include all required fields)
            await billingManager.updateMember(member.id, {
                name: member.name,
                username: member.username || member.hotspot_username || '',
                phone: member.phone,
                hotspot_username: member.hotspot_username,
                email: member.email,
                address: member.address,
                package_id: member.package_id,
                hotspot_profile: member.hotspot_profile,
                status: 'isolir',
                server_hotspot: member.server_hotspot,
                auto_suspension: member.auto_suspension !== undefined ? member.auto_suspension : 1,
                billing_day: member.billing_day || 15,
                latitude: member.latitude,
                longitude: member.longitude,
                ktp_photo_path: member.ktp_photo_path,
                house_photo_path: member.house_photo_path
            });
            logger.info(`Member ${hotspotUsername} status updated to isolir`);

            // Send notification
            try {
                const { isWaSystemMonitorEnabled } = require('./whatsappMonitoringSettings');
                if (!isWaSystemMonitorEnabled('member_isolir_wa')) {
                    logger.info('member_isolir_wa off — skip WA isolir member');
                } else {
                    const whatsappNotifications = require('./whatsapp-notifications');
                    await whatsappNotifications.sendMemberIsolirNotification(member.id, reason);
                }
            } catch (notifError) {
                logger.error(`Failed to send isolir notification: ${notifError.message}`);
            }

            return { success: true, message: 'Member service suspended successfully' };

        } catch (error) {
            logger.error(`Error suspending member service: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    async restoreMemberService(member, reason = 'Manual restore') {
        try {
            const { enableHotspotUserRadius } = require('./mikrotik');
            const authMode = await getUserAuthMode();
            
            if (authMode !== 'radius') {
                logger.warn('Member restoration only supports RADIUS mode');
                return { success: false, message: 'Only RADIUS mode supported' };
            }

            const hotspotUsername = member.hotspot_username;
            if (!hotspotUsername) {
                logger.warn(`Member ${member.name} has no hotspot_username`);
                return { success: false, message: 'No hotspot username' };
            }

            // Enable hotspot user di RADIUS (hapus Auth-Type := Reject)
            try {
                const enableResult = await enableHotspotUserRadius(hotspotUsername);
                if (!enableResult || !enableResult.success) {
                    logger.error(`Failed to enable hotspot user ${hotspotUsername} in RADIUS`);
                    return { success: false, message: enableResult?.message || 'RADIUS enable failed' };
                }
                logger.info(`Hotspot user ${hotspotUsername} enabled in RADIUS (Auth-Type Reject removed)`);
            } catch (enableError) {
                logger.error(`Error enabling hotspot user ${hotspotUsername}: ${enableError.message}`);
                return { success: false, message: `Failed to enable user: ${enableError.message}` };
            }

            // Update member status to active (preserve all existing fields)
            const updateData = { 
                name: member.name,
                username: member.username || member.hotspot_username || '',
                phone: member.phone,
                hotspot_username: member.hotspot_username || member.username || '',
                email: member.email || '',
                address: member.address || '',
                package_id: member.package_id,
                hotspot_profile: member.hotspot_profile || '',
                status: 'active',
                server_hotspot: member.server_hotspot || '',
                auto_suspension: member.auto_suspension || 0,
                billing_day: member.billing_day || null,
                latitude: member.latitude || null,
                longitude: member.longitude || null,
                ktp_photo_path: member.ktp_photo_path || null,
                house_photo_path: member.house_photo_path || null
            };
            await billingManager.updateMember(member.id, updateData);
            logger.info(`Member ${hotspotUsername} status updated to active`);

            return { success: true, message: 'Member service restored successfully' };

        } catch (error) {
            logger.error(`Error restoring member service: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * Sync status suspended customers dari billing ke RADIUS
     * Memastikan customer yang statusnya 'suspended' di billing juga di group 'isolir' di RADIUS
     */
    async syncSuspendedStatusToRadius() {
        try {
            logger.info('Starting sync suspended status to RADIUS...');
            
            const { getUserAuthModeAsync } = require('./mikrotik');
            const authMode = await getUserAuthModeAsync();
            
            if (authMode !== 'radius') {
                logger.info('Auth mode bukan RADIUS, skip sync');
                return { synced: 0, alreadyIsolir: 0, errors: 0 };
            }
            
            // Ambil semua customer yang statusnya suspended
            const customers = await billingManager.getCustomers();
            const suspendedCustomers = customers.filter(c => c.status === 'suspended');
            
            logger.info(`Found ${suspendedCustomers.length} customers with status 'suspended'`);
            
            if (suspendedCustomers.length === 0) {
                return { synced: 0, alreadyIsolir: 0, errors: 0 };
            }
            
            const { getRadiusConnection, suspendUserRadius, ensureIsolirProfileRadius } = require('./mikrotik');
            await ensureIsolirProfileRadius();
            const conn = await getRadiusConnection();
            let synced = 0;
            let alreadyIsolir = 0;
            let errors = 0;
            
            for (const customer of suspendedCustomers) {
                const pppUser = (customer.pppoe_username && String(customer.pppoe_username).trim()) || 
                               (customer.username && String(customer.username).trim());
                
                if (!pppUser) {
                    continue;
                }
                
                try {
                    const [currentGroup] = await conn.execute(
                        "SELECT groupname FROM radusergroup WHERE username = ? LIMIT 1",
                        [pppUser]
                    );
                    
                    if (currentGroup && currentGroup.length > 0 && currentGroup[0].groupname === 'isolir') {
                        alreadyIsolir++;
                    } else {
                        // Cron sync: hanya update RADIUS, tanpa disconnect Mikrotik (hindari beban saat mass reconnect)
                        const result = await suspendUserRadius(pppUser, { skipEnsureIsolir: true });
                        if (result && result.success) {
                            synced++;
                            logger.info(`Synced ${pppUser} to isolir group`);
                        } else {
                            errors++;
                            logger.error(`Failed to sync ${pppUser} to isolir: ${result?.message || 'Unknown error'}`);
                        }
                        // Jeda singkat antar write agar tidak bentrok dengan auth FreeRADIUS
                        await new Promise((r) => setTimeout(r, 30));
                    }
                } catch (error) {
                    errors++;
                    logger.error(`Error syncing ${pppUser}: ${error.message}`);
                }
            }
            
            await conn.end();
            
            logger.info(`Sync suspended status completed: synced=${synced}, alreadyIsolir=${alreadyIsolir}, errors=${errors}`);
            return { synced, alreadyIsolir, errors };
            
        } catch (error) {
            logger.error(`Error in syncSuspendedStatusToRadius: ${error.message}`);
            return { synced: 0, alreadyIsolir: 0, errors: 1 };
        }
    }

    /**
     * Perbarui paket/profil PPPoE untuk pelanggan yang masih isolir tanpa mengubah status billing.
     */
    async updatePackageForSuspendedCustomer(customer, reason = 'Package changed while suspended') {
        try {
            const pppUser =
                (customer.pppoe_username && String(customer.pppoe_username).trim()) ||
                (customer.username && String(customer.username).trim());
            if (!pppUser) {
                return { success: true, skipped: true, message: 'No PPPoE username' };
            }
            const authMode = await getUserAuthMode();
            if (authMode === 'radius') {
                const pkgRow = customer.package_id
                    ? await billingManager.getPackageById(customer.package_id)
                    : null;
                const enriched = {
                    ...customer,
                    package_pppoe_profile: pkgRow?.pppoe_profile || customer.package_pppoe_profile
                };
                const result = await updateIsolirPreviousGroupRadius(pppUser, enriched);
                logger.info(
                    `[SUSPEND] Package/profile updated for suspended ${pppUser} (${reason}): ${result.message || 'ok'}`
                );
                return result;
            }
            logger.info(`[SUSPEND] Package changed for suspended ${pppUser} (Mikrotik mode) — akan dipakai saat restore`);
            return { success: true };
        } catch (error) {
            logger.error(`updatePackageForSuspendedCustomer failed: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * Check dan restore pelanggan yang sudah bayar
     */
    async checkAndRestorePaidCustomers() {
        try {
            logger.info('Starting automatic service restoration check...');

            // Ambil semua customer yang suspended
            const customers = await billingManager.getCustomers();
            const suspendedCustomers = customers.filter((c) => isSuspendedStatus(c.status));

            const results = {
                checked: suspendedCustomers.length,
                restored: 0,
                skipped_manual: 0,
                errors: 0,
                details: []
            };

            for (const customer of suspendedCustomers) {
                try {
                    if (!shouldAutoRestoreCustomer(customer)) {
                        results.skipped_manual++;
                        logger.info(
                            `Customer ${customer.username} isolir manual (suspend_reason=${customer.suspend_reason || 'legacy'}) — skip auto-restore`
                        );
                        continue;
                    }

                    // Cek apakah customer punya tagihan yang belum dibayar
                    const invoices = await billingManager.getInvoicesByCustomer(customer.id);
                    const unpaidInvoices = invoices.filter(i => i.status === 'unpaid');

                    // Jika tidak ada tagihan yang belum dibayar, restore layanan
                    if (unpaidInvoices.length === 0) {
                        const restorationResult = await this.restoreCustomerService(customer);
                        
                        if (restorationResult.success) {
                            results.restored++;
                            results.details.push({
                                customer: customer.username,
                                status: 'restored'
                            });
                            logger.info(`Successfully restored service for ${customer.username}`);
                        } else {
                            results.errors++;
                            results.details.push({
                                customer: customer.username,
                                status: 'failed'
                            });
                            logger.error(`Failed to restore service for ${customer.username}`);
                        }
                    } else {
                        logger.info(`Customer ${customer.username} still has ${unpaidInvoices.length} unpaid invoices - keeping suspended`);
                    }

                } catch (customerError) {
                    results.errors++;
                    logger.error(`Error processing suspended customer ${customer.username}:`, customerError);
                }
            }

            logger.info(`Service restoration check completed. Checked: ${results.checked}, Restored: ${results.restored}, Errors: ${results.errors}`);
            return results;

        } catch (error) {
            logger.error('Error in automatic service restoration check:', error);
            throw error;
        }
    }

    /**
     * Nonaktif (berhenti langganan): tolak auth PPPoE / disable secret — tidak bisa internet sama sekali.
     * Beda dari isolir (masih bisa login ke captive portal).
     */
    async deactivateCustomerNetwork(customer, reason = 'Status Nonaktif') {
        try {
            logger.info(`Deactivating network for customer: ${customer.username} (${reason})`);
            const results = { mikrotik: false, radius: false, static_ip: false };

            const explicitPppoe = customer.pppoe_username && String(customer.pppoe_username).trim();
            const hasStaticIP = !!(customer.static_ip || customer.ip_address || customer.assigned_ip);
            const hasMacAddress = !!customer.mac_address;
            const pppUser = explicitPppoe
                || (!hasStaticIP && !hasMacAddress && customer.username ? String(customer.username).trim() : '');

            if (pppUser) {
                const authMode = await getUserAuthMode();
                if (authMode === 'radius') {
                    const disableResult = await disablePppoeUserRadius(pppUser);
                    if (disableResult && disableResult.success) {
                        results.radius = true;
                        results.mikrotik = true;
                        logger.info(
                            `RADIUS: ${pppUser} nonaktif (Reject), kicked ${disableResult.disconnected || 0} sesi`
                        );
                    }
                } else {
                    try {
                        const mikrotik = await getMikrotikConnectionForCustomer(customer);
                        let secretId = null;
                        const secrets = await mikrotik.write('/ppp/secret/print', [`?name=${pppUser}`]);
                        if (secrets && secrets.length > 0) secretId = secrets[0]['.id'];
                        const setParams = secretId
                            ? [`=.id=${secretId}`, '=disabled=yes', `=comment=INACTIVE - ${reason}`]
                            : [`=name=${pppUser}`, '=disabled=yes', `=comment=INACTIVE - ${reason}`];
                        await mikrotik.write('/ppp/secret/set', setParams);
                        try {
                            await withTimeout(disconnectPPPoEUser(pppUser, mikrotik), 8000, `disconnect ${pppUser}`);
                        } catch (e) {
                            logger.warn(`Mikrotik disconnect after inactive: ${e.message}`);
                        }
                        results.mikrotik = true;
                        logger.info(`Mikrotik: PPPoE secret ${pppUser} disabled=yes (nonaktif)`);
                    } catch (mikrotikError) {
                        logger.error(`Mikrotik deactivate failed for ${customer.username}:`, mikrotikError.message);
                    }
                }
            } else if (hasStaticIP || hasMacAddress) {
                try {
                    const { syncPoolAfterCustomerChange } = require('./staticIpPoolSync');
                    await syncPoolAfterCustomerChange({ ...customer, status: 'inactive' });
                    results.static_ip = true;
                } catch (e) {
                    logger.warn(`Static IP deactivate sync: ${e.message}`);
                }
            }

            return { success: results.mikrotik || results.radius || results.static_ip, results };
        } catch (error) {
            logger.error(`Error deactivating network for ${customer.username}:`, error.message);
            return { success: false, message: error.message };
        }
    }

    /**
     * Kembalikan akses jaringan saat status Nonaktif → Aktif.
     */
    async reactivateCustomerNetwork(customer, reason = 'Status Aktif') {
        try {
            logger.info(`Reactivating network for customer: ${customer.username} (${reason})`);
            const results = { mikrotik: false, radius: false, static_ip: false };

            const explicitPppoe = customer.pppoe_username && String(customer.pppoe_username).trim();
            const hasStaticIP = !!(customer.static_ip || customer.ip_address || customer.assigned_ip);
            const hasMacAddress = !!customer.mac_address;
            const pppUser = explicitPppoe
                || (!hasStaticIP && !hasMacAddress && customer.username ? String(customer.username).trim() : '');

            if (pppUser) {
                const authMode = await getUserAuthMode();
                if (authMode === 'radius') {
                    const enableResult = await enablePppoeUserRadius(pppUser, customer);
                    if (enableResult && enableResult.success) {
                        results.radius = true;
                        results.mikrotik = true;
                        logger.info(`RADIUS: ${pppUser} diaktifkan kembali dari nonaktif`);
                    }
                } else {
                    try {
                        const mikrotik = await getMikrotikConnectionForCustomer(customer);
                        const profile =
                            customer.pppoe_profile ||
                            customer.package_pppoe_profile ||
                            getTenantSetting('default_pppoe_profile', getSetting('default_pppoe_profile', 'default'));
                        let secretId = null;
                        const secrets = await mikrotik.write('/ppp/secret/print', [`?name=${pppUser}`]);
                        if (secrets && secrets.length > 0) secretId = secrets[0]['.id'];
                        const setParams = secretId
                            ? [`=.id=${secretId}`, '=disabled=no', `=profile=${profile}`, `=comment=ACTIVE`]
                            : [`=name=${pppUser}`, '=disabled=no', `=profile=${profile}`, `=comment=ACTIVE`];
                        await mikrotik.write('/ppp/secret/set', setParams);
                        try {
                            await withTimeout(disconnectPPPoEUser(pppUser, mikrotik), 8000, `disconnect ${pppUser}`);
                        } catch (_) {}
                        results.mikrotik = true;
                        logger.info(`Mikrotik: PPPoE secret ${pppUser} enabled (profile=${profile})`);
                    } catch (mikrotikError) {
                        logger.error(`Mikrotik reactivate failed for ${customer.username}:`, mikrotikError.message);
                    }
                }
            } else if (hasStaticIP || hasMacAddress) {
                try {
                    const { syncPoolAfterCustomerChange } = require('./staticIpPoolSync');
                    await syncPoolAfterCustomerChange({ ...customer, status: 'active' });
                    results.static_ip = true;
                } catch (e) {
                    logger.warn(`Static IP reactivate sync: ${e.message}`);
                }
            }

            return { success: results.mikrotik || results.radius || results.static_ip, results };
        } catch (error) {
            logger.error(`Error reactivating network for ${customer.username}:`, error.message);
            return { success: false, message: error.message };
        }
    }

    /**
     * Sync ulang pelanggan isolir ke MikroTik/RADIUS.
     * Hanya menyentuh jaringan — tidak ubah status billing, suspend_reason, GenieACS/OLT, atau WA.
     * @param {object} [options]
     * @param {boolean} [options.kickSessions=true] — putus sesi PPPoE agar reconnect ke profil/pool isolir
     */
    async syncIsolirCustomersToMikrotik(options = {}) {
        const syncKey = this._tryAcquireIsolirSync();
        if (!syncKey) {
            return {
                success: false,
                busy: true,
                message: 'Sync Isolir sedang berjalan. Tunggu hingga selesai.',
                total: 0,
                synced: 0,
                alreadyOk: 0,
                kicked: 0,
                skipped: 0,
                errors: 0
            };
        }

        const kickSessions = options.kickSessions !== false;
        const summary = {
            success: true,
            total: 0,
            synced: 0,
            alreadyOk: 0,
            kicked: 0,
            skipped: 0,
            errors: 0,
            pppoe: 0,
            static_ip: 0
        };

        try {
            logger.info(`[SYNC-ISOLIR] Mulai sync pelanggan isolir ke MikroTik (kickSessions=${kickSessions})...`);

            const customers = await billingManager.getCustomers();
            const suspendedCustomers = (customers || []).filter((c) => isSuspendedStatus(c.status));
            summary.total = suspendedCustomers.length;

            if (suspendedCustomers.length === 0) {
                summary.message = 'Tidak ada pelanggan isolir yang perlu disinkronkan';
                return summary;
            }

            const authMode = await getUserAuthMode();
            let radiusConn = null;
            if (authMode === 'radius') {
                const { getRadiusConnection, ensureIsolirProfileRadius } = require('./mikrotik');
                await ensureIsolirProfileRadius();
                radiusConn = await getRadiusConnection();
            }

            const isolirProfile = getTenantSetting('isolir_profile', getSetting('isolir_profile', 'isolir'));
            const staticMethod = getSetting('static_ip_suspension_method', 'address_list');

            for (const customer of suspendedCustomers) {
                try {
                    const result = await this._syncOneIsolirCustomer(customer, {
                        authMode,
                        kickSessions,
                        radiusConn,
                        isolirProfile,
                        staticMethod
                    });

                    if (result.skipped) {
                        summary.skipped++;
                    } else if (result.error) {
                        summary.errors++;
                    } else if (result.synced) {
                        summary.synced++;
                        if (result.type === 'pppoe') summary.pppoe++;
                        if (result.type === 'static_ip') summary.static_ip++;
                    } else {
                        summary.alreadyOk++;
                        if (result.type === 'pppoe') summary.pppoe++;
                        if (result.type === 'static_ip') summary.static_ip++;
                    }
                    if (result.kicked > 0) summary.kicked += result.kicked;

                    await new Promise((r) => setTimeout(r, 40));
                } catch (err) {
                    summary.errors++;
                    logger.error(
                        `[SYNC-ISOLIR] Error ${customer.username || customer.pppoe_username || customer.id}: ${err.message}`
                    );
                }
            }

            if (radiusConn) {
                try {
                    await radiusConn.end();
                } catch (_) {}
            }

            summary.message =
                `Sync Isolir selesai: ${summary.synced} disinkron, ${summary.alreadyOk} sudah OK` +
                (kickSessions && summary.kicked ? `, ${summary.kicked} sesi diputus` : '') +
                (summary.skipped ? `, ${summary.skipped} dilewati` : '') +
                (summary.errors ? `, ${summary.errors} gagal` : '') +
                ` (total ${summary.total})`;

            logger.info(`[SYNC-ISOLIR] ${summary.message}`);
            return summary;
        } catch (error) {
            logger.error(`[SYNC-ISOLIR] Fatal: ${error.message}`);
            summary.success = false;
            summary.errors = Math.max(summary.errors, 1);
            summary.message = error.message;
            return summary;
        } finally {
            this._releaseIsolirSync(syncKey);
        }
    }

    /**
     * Sync satu pelanggan isolir ke jaringan (tanpa ubah billing / WA).
     * @private
     */
    async _syncOneIsolirCustomer(customer, ctx = {}) {
        const {
            authMode,
            kickSessions = true,
            radiusConn = null,
            isolirProfile = 'isolir',
            staticMethod = 'address_list'
        } = ctx;

        const explicitPppoe = customer.pppoe_username && String(customer.pppoe_username).trim();
        const hasStaticIP = !!(customer.static_ip || customer.ip_address || customer.assigned_ip);
        const hasMacAddress = !!customer.mac_address;
        const pppUser = explicitPppoe
            || (!hasStaticIP && !hasMacAddress && customer.username ? String(customer.username).trim() : '');

        // PPPoE path
        if (pppUser) {
            if (authMode === 'radius') {
                let alreadyIsolir = false;
                try {
                    if (radiusConn) {
                        const [currentGroup] = await radiusConn.execute(
                            'SELECT groupname FROM radusergroup WHERE username = ? LIMIT 1',
                            [pppUser]
                        );
                        alreadyIsolir =
                            !!(currentGroup && currentGroup.length > 0 && currentGroup[0].groupname === 'isolir');
                    }
                } catch (e) {
                    logger.warn(`[SYNC-ISOLIR] Cek group RADIUS gagal untuk ${pppUser}: ${e.message}`);
                }

                let kicked = 0;
                if (!alreadyIsolir) {
                    const result = await suspendUserRadius(pppUser, { skipEnsureIsolir: true });
                    kicked = (result && result.disconnected) || 0;
                    if (result && result.success) {
                        logger.info(`[SYNC-ISOLIR] ${pppUser} → group isolir (kicked ${kicked})`);
                        return { type: 'pppoe', synced: true, kicked };
                    }
                    return { type: 'pppoe', error: true, message: result?.message || 'RADIUS suspend gagal' };
                }

                // Sudah di group isolir: pastikan sesi aktif reconnect ke pool isolir
                if (kickSessions) {
                    try {
                        const { disconnectPPPoEUserAllRouters } = require('./mikrotik');
                        const kick = await withTimeout(
                            disconnectPPPoEUserAllRouters(pppUser),
                            10000,
                            `kick isolir ${pppUser}`
                        );
                        kicked = (kick && kick.disconnected) || 0;
                    } catch (e) {
                        logger.warn(`[SYNC-ISOLIR] Kick ${pppUser}: ${e.message}`);
                    }
                }
                return { type: 'pppoe', synced: false, alreadyOk: true, kicked };
            }

            // Mode Mikrotik API
            try {
                const mikrotik = await getMikrotikConnectionForCustomer(customer);
                await this.ensureIsolirProfile(customer);

                let secretId = null;
                let currentProfile = null;
                try {
                    const secrets = await mikrotik.write('/ppp/secret/print', [`?name=${pppUser}`]);
                    if (secrets && secrets.length > 0) {
                        secretId = secrets[0]['.id'];
                        currentProfile = secrets[0].profile || null;
                    }
                } catch (lookupErr) {
                    logger.warn(`[SYNC-ISOLIR] Lookup secret ${pppUser}: ${lookupErr.message}`);
                }

                const needsProfile = !currentProfile || String(currentProfile) !== String(isolirProfile);
                if (needsProfile) {
                    const setParams = secretId
                        ? [`=.id=${secretId}`, `=profile=${isolirProfile}`, '=comment=SUSPENDED - Sync Isolir']
                        : [`=name=${pppUser}`, `=profile=${isolirProfile}`, '=comment=SUSPENDED - Sync Isolir'];
                    await mikrotik.write('/ppp/secret/set', setParams);
                }

                let kicked = 0;
                if (kickSessions || needsProfile) {
                    try {
                        const disconnectResult = await withTimeout(
                            disconnectPPPoEUser(pppUser, mikrotik),
                            8000,
                            `disconnect sync ${pppUser}`
                        );
                        kicked = (disconnectResult && disconnectResult.disconnected) || 0;
                    } catch (e) {
                        logger.warn(`[SYNC-ISOLIR] Disconnect ${pppUser}: ${e.message}`);
                    }
                }

                if (needsProfile) {
                    logger.info(`[SYNC-ISOLIR] ${pppUser} profile → ${isolirProfile} (kicked ${kicked})`);
                    return { type: 'pppoe', synced: true, kicked };
                }
                return { type: 'pppoe', synced: false, alreadyOk: true, kicked };
            } catch (e) {
                return { type: 'pppoe', error: true, message: e.message };
            }
        }

        // Static IP — hanya address-list (tanpa update billing / WA)
        if (hasStaticIP || hasMacAddress) {
            try {
                if (staticMethod && staticMethod !== 'address_list') {
                    logger.warn(
                        `[SYNC-ISOLIR] Metode static "${staticMethod}" tidak didukung sync aman — pakai address_list untuk ${customer.username}`
                    );
                }
                const result = await staticIPSuspension.suspendByAddressList(customer, 'Sync Isolir');
                if (result && result.success) {
                    const wasAlready = String(result.message || '').toLowerCase().includes('already');
                    return {
                        type: 'static_ip',
                        synced: !wasAlready,
                        alreadyOk: wasAlready
                    };
                }
                return { type: 'static_ip', error: true, message: result?.error || 'Static isolir gagal' };
            } catch (e) {
                return { type: 'static_ip', error: true, message: e.message };
            }
        }

        return { skipped: true, message: 'Tidak ada PPPoE / static IP' };
    }

    /** Pastikan semua pelanggan status inactive tertolak di RADIUS / secret disabled. */
    async syncInactiveStatusToNetwork() {
        try {
            logger.info('Starting sync inactive (nonaktif) customers to network disable...');
            const customers = await billingManager.getCustomers();
            const inactiveCustomers = customers.filter(
                (c) => String(c.status || '').toLowerCase() === 'inactive'
            );
            logger.info(`Found ${inactiveCustomers.length} inactive customers`);

            let synced = 0;
            let errors = 0;
            for (const customer of inactiveCustomers) {
                try {
                    const r = await this.deactivateCustomerNetwork(customer, 'Sync nonaktif');
                    if (r && r.success) synced++;
                    else errors++;
                    await new Promise((res) => setTimeout(res, 30));
                } catch (e) {
                    errors++;
                    logger.error(`Sync inactive ${customer.username}: ${e.message}`);
                }
            }
            logger.info(`Sync inactive completed: synced=${synced}, errors=${errors}`);
            return { synced, errors, total: inactiveCustomers.length };
        } catch (error) {
            logger.error(`Error in syncInactiveStatusToNetwork: ${error.message}`);
            return { synced: 0, errors: 1, total: 0 };
        }
    }
}

// Create singleton instance
const serviceSuspensionManager = new ServiceSuspensionManager();

module.exports = serviceSuspensionManager;
module.exports.getAutoSuspensionDay = getAutoSuspensionDay;
module.exports.isAutoSuspensionDay = isAutoSuspensionDay;
module.exports.getCustomerAutoSuspensionDay = getCustomerAutoSuspensionDay;
module.exports.isCustomerAutoSuspensionDay = isCustomerAutoSuspensionDay;
module.exports.shouldRunAutoSuspension = shouldRunAutoSuspension;
