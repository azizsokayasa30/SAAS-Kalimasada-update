const OltRepository = require('./repositories/OltRepository');
const DriverRegistry = require('./drivers/DriverRegistry');
const cacheManager = require('../../config/cacheManager');
const logger = require('../../config/logger');
const { encryptCredential, decryptCredential } = require('../../utils/credentialCrypto');

class OltService {
    constructor(repository = new OltRepository()) {
        this.repository = repository;
    }

    sanitizeOlt(olt) {
        if (!olt) return null;
        const { password_encrypted, enable_password, ...safe } = olt;
        return {
            ...safe,
            has_password: !!password_encrypted,
            has_enable_password: !!enable_password
        };
    }

    async listOlts(filters) {
        const olts = await this.repository.listOlts(filters);
        return olts.map((olt) => this.sanitizeOlt(olt));
    }

    async getOlt(id, includeSecret = false) {
        const olt = await this.repository.getOltById(id);
        if (!olt) return null;
        return includeSecret ? olt : this.sanitizeOlt(olt);
    }

    async createOlt(data) {
        const payload = { ...data };
        await this.attachInlineApiProfile(payload);
        if (payload.password) {
            payload.password_encrypted = encryptCredential(payload.password);
            delete payload.password;
        }
        if (payload.enable_password) {
            payload.enable_password = encryptCredential(payload.enable_password);
        }
        const olt = await this.repository.createOlt(payload);
        this.invalidateCache();
        return this.sanitizeOlt(olt);
    }

    async updateOlt(id, data) {
        const payload = { ...data };
        await this.attachInlineApiProfile(payload, id);
        if (payload.password) {
            payload.password_encrypted = encryptCredential(payload.password);
            delete payload.password;
        }
        if (payload.enable_password) {
            payload.enable_password = encryptCredential(payload.enable_password);
        } else {
            delete payload.enable_password;
        }
        const olt = await this.repository.updateOlt(id, payload);
        this.invalidateCache();
        return this.sanitizeOlt(olt);
    }

    async deleteOlt(id) {
        const result = await this.repository.deleteOlt(id);
        this.invalidateCache();
        return result;
    }

    async createDriver(oltId) {
        const olt = await this.repository.getOltById(oltId);
        if (!olt) throw new Error('OLT not found');
        const password = olt.password_encrypted ? decryptCredential(olt.password_encrypted) : null;
        const enablePassword = olt.enable_password ? decryptCredential(olt.enable_password) : null;
        return DriverRegistry.createDriver({ olt, password, enablePassword });
    }

    async testConnection(oltId) {
        try {
            const driver = await this.createDriver(oltId);
            const result = await driver.connect();
            await this.repository.updateOltConnection(oltId, 'connected', null, result.systemInfo || null);
            this.invalidateCache();
            return { success: true, data: result };
        } catch (error) {
            await this.repository.updateOltConnection(oltId, 'error', error.message);
            return { success: false, error: error.message, code: error.code };
        }
    }

    async disconnect(oltId) {
        const driver = await this.createDriver(oltId);
        const result = await driver.disconnect();
        await this.repository.updateOltConnection(oltId, 'disconnected');
        this.invalidateCache();
        return result;
    }

    async enqueueSync(oltId, manual = true) {
        const jobId = await this.repository.enqueueSyncJob(oltId, manual ? 'manual_sync' : 'sync', manual ? 1 : 5);
        return { job_id: jobId };
    }

    async syncOlt(oltId, jobId = null) {
        const runId = await this.repository.startSyncRun(oltId, jobId);
        try {
            const driver = await this.createDriver(oltId);
            const data = await driver.syncData();
            await this.validateSyncData(await this.repository.getOltById(oltId), data);
            const ponMap = new Map();
            for (const port of data.ponPorts || []) {
                const saved = await this.repository.upsertPonPort(oltId, port);
                ponMap.set(`${saved.slot || ''}/${saved.pon}`, saved.id);
                ponMap.set(String(saved.pon), saved.id);
            }

            const seenIds = [];
            let onlineCount = 0;
            for (const onu of data.onuList || []) {
                const ponKey = `${onu.slot || ''}/${onu.pon || ''}`;
                const ponPortId = ponMap.get(ponKey) || ponMap.get(String(onu.pon || '')) || null;
                const result = await this.repository.upsertOnu(oltId, ponPortId, onu);
                seenIds.push(result.current.id);
                await this.repository.addOnuHistory(result.current);
                if (result.current.status === 'ONLINE') onlineCount++;
                await this.generateAlerts(oltId, result.previous, result.current);
            }

            if (data.pruneMissing) {
                await this.repository.deleteOnusNotSeen(oltId, seenIds);
            } else if (!data.skipMarkMissing) {
                await this.repository.markMissingOnus(oltId, seenIds);
            } else {
                await this.repository.clearMissingFlags(oltId);
            }
            await this.repository.markOltSynced(oltId, data.systemInfo || null);
            const stats = {
                pon_count: (data.ponPorts || []).length,
                onu_count: (data.onuList || []).length,
                online_count: onlineCount,
                offline_count: (data.onuList || []).filter((onu) =>
                    ['OFFLINE', 'LOS', 'POWER_OFF', 'DYING_GASP', 'DISABLED', 'AUTH_FAILED'].includes(onu.status)
                ).length
            };
            await this.repository.finishSyncRun(runId, 'completed', stats);
            this.invalidateCache();
            return { success: true, ...stats };
        } catch (error) {
            logger.error('[olt-sync] failed:', error);
            await this.repository.finishSyncRun(runId, 'failed', {}, error.message);
            await this.repository.updateOltConnection(oltId, 'error', error.message);
            this.invalidateCache();
            throw error;
        }
    }

    async validateSyncData(olt, data) {
        const onuList = data.onuList || [];
        if (!olt || String(olt.vendor || '').toLowerCase() !== 'hioso' || onuList.length < 100) return;

        const onlineCount = onuList.filter((onu) => onu.status === 'ONLINE').length;
        const onlineRatio = onlineCount / onuList.length;
        if (onlineRatio < 0.1) {
            throw new Error(
                `Hioso sync rejected: implausible status scan (${onlineCount}/${onuList.length} online). SNMP status data may be stale or incomplete.`
            );
        }

        const existingCounts = await this.repository.getOnuStatusCounts(olt.id);
        const existingTotal = Number(existingCounts?.total || 0);
        if (existingTotal >= 100 && onuList.length < existingTotal * 0.95) {
            throw new Error(
                `Hioso sync rejected: partial status scan (${onuList.length}/${existingTotal} ONU). Retrying later will preserve existing data.`
            );
        }
    }

    async generateAlerts(oltId, previous, current) {
        if (!current) return;
        if (previous && previous.status !== current.status) {
            await this.repository.createAlert({
                olt_id: oltId,
                onu_id: current.id,
                level: current.status === 'ONLINE' ? 'info' : 'warning',
                title: `ONU ${previous.status} -> ${current.status}`,
                message: `${current.onu_name || current.onu_sn || current.onu_index || current.id} changed status`
            });
        }
        const rx = Number(current.rx_power);
        if (Number.isFinite(rx) && rx < -30) {
            await this.repository.createAlert({
                olt_id: oltId,
                onu_id: current.id,
                level: 'critical',
                title: 'RX Power Critical',
                message: `RX power ${rx} dBm is below -30 dBm`
            });
        } else if (Number.isFinite(rx) && rx < -27) {
            await this.repository.createAlert({
                olt_id: oltId,
                onu_id: current.id,
                level: 'warning',
                title: 'RX Power Warning',
                message: `RX power ${rx} dBm is below -27 dBm`
            });
        }
        if (['LOS', 'DYING_GASP', 'AUTH_FAILED'].includes(current.status)) {
            await this.repository.createAlert({
                olt_id: oltId,
                onu_id: current.id,
                level: current.status === 'AUTH_FAILED' ? 'warning' : 'critical',
                title: current.status.replace(/_/g, ' '),
                message: `OLT reported ${current.status} for ONU ${current.onu_sn || current.onu_index || current.id}`
            });
        }
    }

    async getDashboard() {
        const cached = cacheManager.get('olt:dashboard');
        if (cached) return cached;
        const [stats, charts] = await Promise.all([
            this.repository.getDashboardStats(),
            this.repository.getChartData()
        ]);
        const dashboard = { stats, charts };
        cacheManager.set('olt:dashboard', dashboard, 60 * 1000);
        return dashboard;
    }

    async listOnus(filters) {
        return this.repository.listOnus(filters);
    }

    async getOnu(id) {
        const onu = await this.repository.getOnuById(id);
        if (!onu) return null;
        const history = await this.repository.getOnuHistory(id, 100);
        return { ...onu, history };
    }

    async updateOnu(id, data) {
        const onu = await this.repository.updateOnuLocal(id, data);
        this.invalidateCache();
        return onu;
    }

    async refreshOnu(id) {
        const onu = await this.repository.getOnuById(id);
        if (!onu) throw new Error('ONU not found');
        await this.enqueueSync(onu.olt_id, true);
        return { queued: true };
    }

    async enableOnu(id) {
        const onu = await this.repository.getOnuById(id);
        if (!onu) throw new Error('ONU not found');
        const driver = await this.createDriver(onu.olt_id);
        return driver.enableOnu(onu);
    }

    async disableOnu(id) {
        const onu = await this.repository.getOnuById(id);
        if (!onu) throw new Error('ONU not found');
        const driver = await this.createDriver(onu.olt_id);
        return driver.disableOnu(onu);
    }

    async rebootOnu(id) {
        const onu = await this.repository.getOnuById(id);
        if (!onu) throw new Error('ONU not found');
        const driver = await this.createDriver(onu.olt_id);
        return driver.rebootOnu(onu);
    }

    async unregisterOnu(id, confirmation) {
        const onu = await this.repository.getOnuById(id);
        if (!onu) throw new Error('ONU not found');

        const normalizedConfirmation = String(confirmation || '').trim().toLowerCase();
        const allowedConfirmations = [
            onu.onu_sn,
            onu.mac_address,
            onu.onu_name,
            onu.onu_index
        ].filter(Boolean).map((value) => String(value).trim().toLowerCase());

        if (!normalizedConfirmation || !allowedConfirmations.includes(normalizedConfirmation)) {
            const error = new Error('Konfirmasi unregister tidak cocok. Ketik SN, MAC, Nama, atau ONU Index dengan tepat.');
            error.code = 'invalid_unregister_confirmation';
            throw error;
        }

        const driver = await this.createDriver(onu.olt_id);
        const result = await driver.unregisterOnu(onu);
        await this.enqueueSync(onu.olt_id, true);
        this.invalidateCache();
        return result;
    }

    async listApiProfiles() {
        return this.repository.listApiProfiles();
    }

    async attachInlineApiProfile(payload, oltId = null) {
        if (!payload.api_profile_endpoints_json && !payload.endpoints_json) return;
        const endpointsJson = payload.api_profile_endpoints_json || payload.endpoints_json;
        try {
            JSON.parse(endpointsJson);
            if (payload.api_profile_parser_json) JSON.parse(payload.api_profile_parser_json);
            if (payload.api_profile_capabilities_json) JSON.parse(payload.api_profile_capabilities_json);
        } catch (error) {
            throw new Error(`Invalid API profile JSON: ${error.message}`);
        }
        const name = payload.api_profile_name
            || `${payload.vendor || 'Generic'} ${payload.model || 'OLT'} API${oltId ? ` #${oltId}` : ''}`;
        const profile = await this.repository.createApiProfile({
            name: `${name} ${Date.now()}`,
            vendor: payload.vendor,
            model: payload.model,
            base_path: payload.api_profile_base_path || '',
            auth_type: payload.api_profile_auth_type || 'basic',
            auth_header: payload.api_profile_auth_header || null,
            verify_tls: payload.api_profile_verify_tls === '0' ? 0 : 1,
            timeout_ms: payload.api_profile_timeout_ms || 10000,
            endpoints_json: endpointsJson,
            parser_json: payload.api_profile_parser_json || '{}',
            capabilities_json: payload.api_profile_capabilities_json || '{}'
        });
        payload.api_profile_id = profile.id;
    }

    async mapCustomerToOnu(customerId, onuId) {
        return this.repository.mapCustomerToOnu(customerId, onuId);
    }

    invalidateCache() {
        cacheManager.delete('olt:dashboard');
    }
}

module.exports = new OltService();
module.exports.OltService = OltService;
