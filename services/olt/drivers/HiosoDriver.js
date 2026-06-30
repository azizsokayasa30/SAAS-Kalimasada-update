const snmp = require('net-snmp');
const OltDriverInterface = require('./OltDriverInterface');
const GenericHttpApiDriver = require('./GenericHttpApiDriver');
const { parseNumber, getSignalQuality } = require('../statusNormalizer');

const STANDARD_OIDS = {
    sysDescr: '1.3.6.1.2.1.1.1.0',
    sysUpTime: '1.3.6.1.2.1.1.3.0',
    sysName: '1.3.6.1.2.1.1.5.0'
};

const HIOSO_EPON_OIDS = {
    onuSerial: '1.3.6.1.4.1.25355.3.2.6.3.2.1.11',
    onuDistance: '1.3.6.1.4.1.25355.3.2.6.3.2.1.25',
    onuName: '1.3.6.1.4.1.25355.3.2.6.3.2.1.37',
    onuStatus: '1.3.6.1.4.1.25355.3.2.6.3.2.1.39',
    onuTxPower: '1.3.6.1.4.1.25355.3.2.6.14.2.1.4',
    onuTemperature: '1.3.6.1.4.1.25355.3.2.6.14.2.1.7',
    onuRxPower: '1.3.6.1.4.1.25355.3.2.6.14.2.1.8'
};
const HIOSO_MAX_PON = 8;
const HIOSO_MAX_ONU_PER_PON = 128;
const HIOSO_MIN_STATUS_SCAN_RESULTS = 20;
const HIOSO_STATUS_SCAN_ATTEMPTS = 3;

function valueToString(value) {
    if (Buffer.isBuffer(value)) {
        const ascii = value.toString('utf8').replace(/[\x00-\x1F\x7F]/g, '').trim();
        return ascii || (value.toString('hex').match(/.{1,2}/g) || []).join(':');
    }
    if (value === undefined || value === null) return '';
    return String(value).replace(/^"|"$/g, '').trim();
}

function formatMacAddress(value) {
    const hex = String(value || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
    if (hex.length !== 12 || /^0+$/.test(hex)) return null;
    return hex.match(/.{1,2}/g).join(':');
}

function statusFromHioso(value) {
    const code = Number(value);
    if (code === 1) return 'ONLINE';
    if (code === 2) return 'OFFLINE';
    return 'UNKNOWN';
}

function indexFromOid(root, oid) {
    return String(oid).slice(root.length + 1);
}

function parseIndex(index) {
    const parts = String(index || '').split('.').map((part) => Number(part));
    return {
        board: parts[0] || 1,
        pon: parts[1] || 1,
        onuId: parts[2] || parts[parts.length - 1] || null
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class HiosoDriver extends OltDriverInterface {
    constructor(context) {
        super(context);
        this.context = context;
        this.olt = context.olt;
        if (this.olt.connection_method === 'http_api' || this.olt.connection_method === 'https_api') {
            this.httpDriver = new GenericHttpApiDriver(context);
        }
    }

    isSnmp() {
        return this.olt.connection_method === 'snmp_v2' || this.olt.connection_method === 'snmp_v3';
    }

    createSnmpSession() {
        if (this.olt.connection_method === 'snmp_v3') {
            const error = new Error('Hioso SNMP v3 requires username/auth/privacy settings; current OLT form only supports SNMP v2 community.');
            error.code = 'unsupported_driver_operation';
            throw error;
        }
        return snmp.createSession(this.olt.ip_address, this.olt.snmp_community || 'public', {
            port: Number(this.olt.port) || 161,
            version: snmp.Version2c,
            timeout: 5000,
            retries: 1
        });
    }

    snmpGet(oids) {
        const session = this.createSnmpSession();
        return new Promise((resolve, reject) => {
            session.get(oids, (error, varbinds) => {
                session.close();
                if (error) return reject(error);
                const result = {};
                for (const varbind of varbinds || []) {
                    if (snmp.isVarbindError(varbind)) {
                        result[varbind.oid] = null;
                    } else {
                        result[varbind.oid] = varbind.value != null ? String(varbind.value) : null;
                    }
                }
                resolve(result);
            });
        });
    }

    snmpWalk(rootOid, limit = 1024) {
        const session = this.createSnmpSession();
        const values = new Map();
        let currentOid = rootOid;
        let count = 0;
        return new Promise((resolve) => {
            const next = () => {
                if (count >= limit) {
                    session.close();
                    return resolve(values);
                }
                session.getNext([currentOid], (error, varbinds) => {
                    if (error) {
                        session.close();
                        return resolve(values);
                    }
                    const varbind = varbinds && varbinds[0];
                    if (!varbind || !String(varbind.oid).startsWith(`${rootOid}.`)) {
                        session.close();
                        return resolve(values);
                    }
                    if (!snmp.isVarbindError(varbind)) {
                        values.set(indexFromOid(rootOid, varbind.oid), valueToString(varbind.value));
                    }
                    count++;
                    currentOid = varbind.oid;
                    next();
                });
            };
            next();
        });
    }

    async snmpGetMany(oids, chunkSize = 20, options = {}) {
        const fallbackToSingle = options.fallbackToSingle !== false;
        const result = new Map();
        const chunks = [];
        for (let i = 0; i < oids.length; i += chunkSize) {
            chunks.push(oids.slice(i, i + chunkSize));
        }

        for (const chunk of chunks) {
            let chunkValues = null;
            const attempts = fallbackToSingle ? 1 : 3;
            for (let attempt = 1; attempt <= attempts; attempt++) {
                const session = this.createSnmpSession();
                chunkValues = await new Promise((resolve) => {
                    session.get(chunk, (error, varbinds) => {
                        session.close();
                        if (error) return resolve(null);
                        const values = new Map();
                        for (const varbind of varbinds || []) {
                            if (!snmp.isVarbindError(varbind)) {
                                values.set(varbind.oid, valueToString(varbind.value));
                            }
                        }
                        resolve(values);
                    });
                });
                if (chunkValues) break;
                if (attempt < attempts) await sleep(150);
            }

            if (chunkValues) {
                for (const [oid, value] of chunkValues.entries()) result.set(oid, value);
                continue;
            }

            if (!fallbackToSingle) continue;
            for (const oid of chunk) {
                const single = await this.snmpGetSingle(oid);
                if (single !== null) result.set(oid, single);
            }
        }
        return result;
    }

    snmpGetSingle(oid) {
        const session = this.createSnmpSession();
        return new Promise((resolve) => {
            session.get([oid], (error, varbinds) => {
                session.close();
                if (error) return resolve(null);
                const varbind = varbinds && varbinds[0];
                if (!varbind || snmp.isVarbindError(varbind)) return resolve(null);
                resolve(valueToString(varbind.value));
            });
        });
    }

    async scanStatusByIndex() {
        const oids = [];
        for (let pon = 1; pon <= HIOSO_MAX_PON; pon++) {
            for (let onu = 1; onu <= HIOSO_MAX_ONU_PER_PON; onu++) {
                oids.push(`${HIOSO_EPON_OIDS.onuStatus}.1.${pon}.${onu}`);
            }
        }
        const byIndex = new Map();

        // Hioso SNMP can occasionally drop chunks. Merge several GET/GETNEXT rounds
        // so one partial response does not under-count offline ONUs.
        for (let attempt = 1; attempt <= HIOSO_STATUS_SCAN_ATTEMPTS; attempt++) {
            const [exactValues, walkedValues] = await Promise.all([
                this.snmpGetMany(oids, 20, { fallbackToSingle: false }),
                this.snmpWalk(HIOSO_EPON_OIDS.onuStatus, HIOSO_MAX_PON * HIOSO_MAX_ONU_PER_PON)
            ]);
            for (const [index, value] of walkedValues.entries()) {
                byIndex.set(index, value);
            }
            for (const [oid, value] of exactValues.entries()) {
                byIndex.set(indexFromOid(HIOSO_EPON_OIDS.onuStatus, oid), value);
            }
            if (attempt < HIOSO_STATUS_SCAN_ATTEMPTS) await sleep(250);
        }

        if (byIndex.size < HIOSO_MIN_STATUS_SCAN_RESULTS) {
            throw new Error(`Hioso status scan incomplete: only ${byIndex.size} ONU status values returned`);
        }
        return byIndex;
    }

    async getValuesByIndex(rootOid, indexes) {
        const oids = indexes.map((index) => `${rootOid}.${index}`);
        const values = await this.snmpGetMany(oids);
        const byIndex = new Map();
        for (const [oid, value] of values.entries()) {
            byIndex.set(indexFromOid(rootOid, oid), value);
        }
        return byIndex;
    }

    async connect() {
        if (this.httpDriver) return this.httpDriver.connect();
        if (!this.isSnmp()) return this.unsupported('connect');
        const values = await this.snmpGet(Object.values(STANDARD_OIDS));
        return {
            connected: true,
            systemInfo: {
                hostname: values[STANDARD_OIDS.sysName] || this.olt.name,
                vendor: 'Hioso',
                model: this.olt.model || null,
                firmware: values[STANDARD_OIDS.sysDescr] || null,
                uptime: values[STANDARD_OIDS.sysUpTime] || null
            }
        };
    }

    async disconnect() {
        if (this.httpDriver) return this.httpDriver.disconnect();
        return { disconnected: true };
    }

    async getSystemInfo() {
        const result = await this.connect();
        return result.systemInfo;
    }

    async getPonPorts() {
        if (this.httpDriver) return this.httpDriver.getPonPorts();
        const onus = await this.getOnuList();
        const ponIds = [...new Set(onus.map((onu) => onu.pon).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
        return ponIds.map((pon) => ({
            slot: '1',
            pon: String(pon),
            name: `PON ${pon}`,
            onu_count: onus.filter((onu) => String(onu.pon) === String(pon)).length
        }));
    }

    async getOnuList() {
        if (this.httpDriver) return this.httpDriver.getOnuList();
        const statusValues = await this.scanStatusByIndex();
        const indexes = [...statusValues.keys()];
        const [serials, distances, names, txPowers, rxPowers] = await Promise.all([
            this.snmpWalk(HIOSO_EPON_OIDS.onuSerial),
            this.snmpWalk(HIOSO_EPON_OIDS.onuDistance),
            this.snmpWalk(HIOSO_EPON_OIDS.onuName),
            this.snmpWalk(HIOSO_EPON_OIDS.onuTxPower),
            this.snmpWalk(HIOSO_EPON_OIDS.onuRxPower)
        ]);

        return indexes.map((index) => {
            const parsed = parseIndex(index);
            const rx = parseNumber(rxPowers.get(index));
            const tx = parseNumber(txPowers.get(index));
            const distance = parseNumber(distances.get(index));
            const status = statusFromHioso(statusValues.get(index));
            const name = names.get(index) || `ONU ${parsed.pon}/${parsed.onuId}`;
            const serial = serials.get(index) || null;
            const macAddress = formatMacAddress(serial);
            return {
                onu_index: index,
                onu_id: parsed.onuId ? String(parsed.onuId) : index,
                onu_sn: serial,
                onu_name: name,
                vendor: 'Hioso',
                model: null,
                status,
                rx_power: rx,
                tx_power: tx,
                signal_quality: getSignalQuality(rx),
                distance,
                mac_address: macAddress,
                ip_address: null,
                slot: String(parsed.board),
                pon: String(parsed.pon),
                raw: {
                    index,
                    name,
                    status_code: statusValues.get(index),
                    serial,
                    distance,
                    rx_power: rxPowers.get(index),
                    tx_power: txPowers.get(index)
                }
            };
        }).filter((onu) => onu.onu_id);
    }

    async enableOnu(onu) {
        if (this.httpDriver) return this.httpDriver.enableOnu(onu);
        return this.unsupported('enableOnu');
    }

    async disableOnu(onu) {
        if (this.httpDriver) return this.httpDriver.disableOnu(onu);
        return this.unsupported('disableOnu');
    }

    async rebootOnu(onu) {
        if (this.httpDriver) return this.httpDriver.rebootOnu(onu);
        return this.unsupported('rebootOnu');
    }

    async syncData() {
        if (this.httpDriver) return this.httpDriver.syncData();
        const systemInfo = await this.getSystemInfo();
        const onuList = await this.getOnuList();
        const ponIds = [...new Set(onuList.map((onu) => onu.pon).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
        const ponPorts = ponIds.map((pon) => ({
            slot: '1',
            pon: String(pon),
            name: `PON ${pon}`,
            onu_count: onuList.filter((onu) => String(onu.pon) === String(pon)).length
        }));
        return { systemInfo, ponPorts, onuList, skipMarkMissing: true, pruneMissing: true };
    }
}

module.exports = HiosoDriver;
