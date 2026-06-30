const axios = require('axios');
const https = require('https');
const OltDriverInterface = require('./OltDriverInterface');
const { normalizeStatus, parseNumber, getSignalQuality } = require('../statusNormalizer');

function getPathValue(source, path, fallback = undefined) {
    if (!path) return fallback;
    const parts = String(path).split('.');
    let value = source;
    for (const part of parts) {
        if (value === undefined || value === null) return fallback;
        if (Array.isArray(value) && /^\d+$/.test(part)) {
            value = value[Number(part)];
        } else {
            value = value[part];
        }
    }
    return value === undefined ? fallback : value;
}

function ensureArray(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null) return [];
    return [value];
}

class GenericHttpApiDriver extends OltDriverInterface {
    constructor(context) {
        super(context);
        this.olt = context.olt;
        this.profile = context.olt.profile || {};
        this.password = context.password;
        this.enablePassword = context.enablePassword;
        this.endpoints = this.profile.endpoints || {};
        this.parser = this.profile.parser || {};
        this.capabilities = this.profile.capabilities || {};
        const protocol = this.olt.connection_method === 'http_api' ? 'http' : 'https';
        const basePath = this.profile.base_path || '';
        this.baseURL = `${protocol}://${this.olt.ip_address}:${this.olt.port}${basePath}`;
        this.client = axios.create({
            baseURL: this.baseURL,
            timeout: Number(this.profile.timeout_ms) || 10000,
            httpsAgent: new https.Agent({ rejectUnauthorized: this.profile.verify_tls !== 0 })
        });
    }

    requestConfig(endpoint = {}) {
        const headers = {};
        const authType = this.profile.auth_type || 'basic';
        if (authType === 'bearer' && this.password) {
            headers.Authorization = `Bearer ${this.password}`;
        }
        if (authType === 'header' && this.profile.auth_header && this.password) {
            headers[this.profile.auth_header] = this.password;
        }
        const config = { headers };
        if (authType === 'basic' && this.olt.username) {
            config.auth = {
                username: this.olt.username,
                password: this.password || ''
            };
        }
        if (endpoint.headers && typeof endpoint.headers === 'object') {
            Object.assign(headers, endpoint.headers);
        }
        return config;
    }

    async callEndpoint(name, replacements = {}, body = undefined) {
        const endpoint = this.endpoints[name];
        if (!endpoint || !endpoint.path) {
            return this.unsupported(name);
        }
        const method = String(endpoint.method || 'GET').toUpperCase();
        const path = Object.entries(replacements).reduce(
            (acc, [key, value]) => acc.replace(new RegExp(`:${key}\\b`, 'g'), encodeURIComponent(value ?? '')),
            endpoint.path
        );
        const config = this.requestConfig(endpoint);
        const response = await this.client.request({
            method,
            url: path,
            data: body || endpoint.body,
            ...config
        });
        return response.data;
    }

    parseSystemInfo(data) {
        const map = this.parser.systemInfo || {};
        const info = {
            hostname: getPathValue(data, map.hostname, data.hostname || data.name || null),
            vendor: getPathValue(data, map.vendor, data.vendor || this.olt.vendor),
            model: getPathValue(data, map.model, data.model || this.olt.model),
            serial_number: getPathValue(data, map.serial_number, data.serial_number || data.serialNumber || null),
            firmware: getPathValue(data, map.firmware, data.firmware || data.version || null),
            uptime: getPathValue(data, map.uptime, data.uptime || null),
            cpu_usage: parseNumber(getPathValue(data, map.cpu_usage, data.cpu_usage || data.cpu)),
            memory_usage: parseNumber(getPathValue(data, map.memory_usage, data.memory_usage || data.memory)),
            temperature: parseNumber(getPathValue(data, map.temperature, data.temperature))
        };
        return info;
    }

    parsePonPorts(data) {
        const map = this.parser.ponPorts || {};
        const rows = ensureArray(getPathValue(data, map.listPath, data.pon_ports || data.ports || data));
        return rows.map((row) => ({
            slot: getPathValue(row, map.slot, row.slot || row.board || ''),
            pon: getPathValue(row, map.pon, row.pon || row.port || row.name),
            name: getPathValue(row, map.name, row.name || row.description || null),
            onu_count: parseNumber(getPathValue(row, map.onu_count, row.onu_count || row.onuCount || 0)) || 0,
            raw: row
        })).filter((port) => port.pon !== undefined && port.pon !== null);
    }

    parseOnuList(data) {
        const map = this.parser.onuList || {};
        const rows = ensureArray(getPathValue(data, map.listPath, data.onus || data.onu_list || data.devices || data));
        return rows.map((row) => {
            const rx = parseNumber(getPathValue(row, map.rx_power, row.rx_power || row.rx || row.rxPower));
            return {
                onu_index: String(getPathValue(row, map.onu_index, row.onu_index || row.index || row.id || '') || ''),
                onu_id: getPathValue(row, map.onu_id, row.onu_id || row.id || null),
                onu_sn: getPathValue(row, map.onu_sn, row.onu_sn || row.sn || row.serial || row.serial_number || null),
                onu_name: getPathValue(row, map.onu_name, row.onu_name || row.name || row.description || null),
                vendor: getPathValue(row, map.vendor, row.vendor || null),
                model: getPathValue(row, map.model, row.model || null),
                status: normalizeStatus(getPathValue(row, map.status, row.status || row.state)),
                rx_power: rx,
                tx_power: parseNumber(getPathValue(row, map.tx_power, row.tx_power || row.tx || row.txPower)),
                signal_quality: getSignalQuality(rx),
                distance: parseNumber(getPathValue(row, map.distance, row.distance || row.range)),
                mac_address: getPathValue(row, map.mac_address, row.mac_address || row.mac || null),
                ip_address: getPathValue(row, map.ip_address, row.ip_address || row.ip || null),
                slot: getPathValue(row, map.slot, row.slot || ''),
                pon: getPathValue(row, map.pon, row.pon || row.port || row.pon_port || null),
                raw: row
            };
        }).filter((onu) => onu.onu_index || onu.onu_sn || onu.onu_id);
    }

    async connect() {
        if (!this.endpoints.systemInfo || !this.endpoints.systemInfo.path) {
            const response = await this.client.request({
                method: 'GET',
                url: '/',
                validateStatus: (status) => status >= 200 && status < 500,
                ...this.requestConfig({})
            });
            return {
                connected: true,
                connectionOnly: true,
                httpStatus: response.status,
                systemInfo: {
                    hostname: this.olt.name,
                    vendor: this.olt.vendor,
                    model: this.olt.model,
                    note: 'HTTP connection test only. Configure systemInfo, ponPorts, and onuList endpoints for full monitoring.'
                }
            };
        }
        const data = await this.callEndpoint('systemInfo');
        return { connected: true, systemInfo: this.parseSystemInfo(data) };
    }

    async disconnect() {
        if (!this.endpoints.disconnect) return { disconnected: true };
        await this.callEndpoint('disconnect');
        return { disconnected: true };
    }

    async getSystemInfo() {
        return this.parseSystemInfo(await this.callEndpoint('systemInfo'));
    }

    async getPonPorts() {
        return this.parsePonPorts(await this.callEndpoint('ponPorts'));
    }

    async getOnuList() {
        return this.parseOnuList(await this.callEndpoint('onuList'));
    }

    async getOnuDetail(onu) {
        return this.callEndpoint('onuDetail', { onuId: onu.onu_id || onu.id, onuIndex: onu.onu_index || onu.id });
    }

    async enableOnu(onu) {
        return this.callEndpoint('enableOnu', { onuId: onu.onu_id || onu.id, onuIndex: onu.onu_index || onu.id }, { onu });
    }

    async disableOnu(onu) {
        return this.callEndpoint('disableOnu', { onuId: onu.onu_id || onu.id, onuIndex: onu.onu_index || onu.id }, { onu });
    }

    async rebootOnu(onu) {
        return this.callEndpoint('rebootOnu', { onuId: onu.onu_id || onu.id, onuIndex: onu.onu_index || onu.id }, { onu });
    }

    async syncData() {
        const [systemInfo, ponPorts, onuList] = await Promise.all([
            this.getSystemInfo(),
            this.getPonPorts(),
            this.getOnuList()
        ]);
        return { systemInfo, ponPorts, onuList };
    }
}

module.exports = GenericHttpApiDriver;
