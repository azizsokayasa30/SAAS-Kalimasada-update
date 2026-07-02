const snmp = require('net-snmp');
const net = require('net');
const { Client } = require('ssh2');
const OltDriverInterface = require('./OltDriverInterface');
const GenericHttpApiDriver = require('./GenericHttpApiDriver');
const { getSignalQuality } = require('../statusNormalizer');

const STANDARD_OIDS = {
    sysDescr: '1.3.6.1.2.1.1.1.0',
    sysUpTime: '1.3.6.1.2.1.1.3.0',
    sysName: '1.3.6.1.2.1.1.5.0'
};

const HUAWEI_GPON_OIDS = {
    ontSerial: '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.3',
    ontModel: '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.8',
    ontName: '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.9',
    ontRunModel: '1.3.6.1.4.1.2011.6.128.1.1.2.45.1.4',
    ontSoftwareVersion: '1.3.6.1.4.1.2011.6.128.1.1.2.45.1.1',
    ontRxPower: '1.3.6.1.4.1.2011.6.128.1.1.2.51.1.4',
    ontTxPower: '1.3.6.1.4.1.2011.6.128.1.1.2.51.1.5',
    ontDistance: '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.20'
};

const HUAWEI_BASE_IFINDEX = 4194312192;
const HUAWEI_IFINDEX_STEP = 256;

function valueToString(value) {
    if (Buffer.isBuffer(value)) {
        const ascii = value.toString('utf8').replace(/[\x00-\x1F\x7F]/g, '').trim();
        return ascii || value.toString('hex').toUpperCase();
    }
    if (value === undefined || value === null) return '';
    return String(value).replace(/^"|"$/g, '').trim();
}

function serialToString(value) {
    if (!Buffer.isBuffer(value)) return valueToString(value);
    if (value.length >= 8) {
        const vendor = value.subarray(0, 4).toString('ascii').replace(/[^\x20-\x7E]/g, '').trim();
        const suffix = value.subarray(4).toString('hex').toUpperCase();
        if (vendor && suffix) return `${vendor}${suffix}`;
    }
    return value.toString('hex').toUpperCase();
}

function indexFromOid(root, oid) {
    return String(oid).slice(root.length + 1);
}

function parseHuaweiIndex(index) {
    const [ifIndexRaw, ontIdRaw] = String(index || '').split('.');
    const ifIndex = Number(ifIndexRaw);
    const ontId = Number(ontIdRaw);
    const offset = Number.isFinite(ifIndex) ? Math.round((ifIndex - HUAWEI_BASE_IFINDEX) / HUAWEI_IFINDEX_STEP) : 0;
    const slot = Math.floor(Math.max(0, offset) / 16) + 1;
    const gponPort = Math.max(0, offset) % 16;
    return {
        ifIndex,
        ontId: Number.isFinite(ontId) ? ontId : null,
        slot: String(slot),
        pon: String(gponPort + 1),
        gponPort: String(gponPort)
    };
}

function validHuaweiMetric(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    if (number === -1 || number === 2147483647) return null;
    return number;
}

function parseHuaweiRxPower(value) {
    const number = validHuaweiMetric(value);
    return number === null ? null : Number((number / 100).toFixed(2));
}

function parseHuaweiTxPower(value) {
    const number = validHuaweiMetric(value);
    return number === null ? null : Number((number / 1000).toFixed(2));
}

function parseHuaweiDistance(value) {
    const number = validHuaweiMetric(value);
    return number === null ? null : number;
}

function parseServicePortIds(output) {
    const ids = new Set();
    for (const line of String(output || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        const indexMatch = trimmed.match(/^(\d+)\s+\d+\s+/);
        if (indexMatch) ids.add(indexMatch[1]);
        const explicitMatch = trimmed.match(/\bservice-?port(?:\s+index)?\s*[:=]?\s*(\d+)\b/i);
        if (explicitMatch) ids.add(explicitMatch[1]);
    }
    return [...ids];
}

class HuaweiDriver extends OltDriverInterface {
    constructor(context) {
        super(context);
        this.context = context;
        this.olt = context.olt;
        this.password = context.password;
        this.enablePassword = context.enablePassword;
        if (this.olt.connection_method === 'http_api' || this.olt.connection_method === 'https_api') {
            this.httpDriver = new GenericHttpApiDriver(context);
        }
    }

    isSnmp() {
        return this.olt.connection_method === 'snmp_v2' || this.olt.connection_method === 'snmp_v3';
    }

    createSnmpSession() {
        if (this.olt.connection_method === 'snmp_v3') {
            const error = new Error('Huawei SNMP v3 requires username/auth/privacy settings; current OLT form only supports SNMP v2 community.');
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
                    result[varbind.oid] = snmp.isVarbindError(varbind) ? null : valueToString(varbind.value);
                }
                resolve(result);
            });
        });
    }

    snmpWalk(rootOid, limit = 3000, formatter = valueToString) {
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
                        values.set(indexFromOid(rootOid, varbind.oid), formatter(varbind.value));
                    }
                    count++;
                    currentOid = varbind.oid;
                    next();
                });
            };
            next();
        });
    }

    async connect() {
        if (this.httpDriver) return this.httpDriver.connect();
        if (!this.isSnmp()) return this.unsupported('connect');
        const values = await this.snmpGet(Object.values(STANDARD_OIDS));
        return {
            connected: true,
            systemInfo: {
                hostname: values[STANDARD_OIDS.sysName] || this.olt.name,
                vendor: 'Huawei',
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

    async getOnuList() {
        if (this.httpDriver) return this.httpDriver.getOnuList();
        const [serials, names, models, runtimeModels, softwareVersions, rxPowers, txPowers, distances] = await Promise.all([
            this.snmpWalk(HUAWEI_GPON_OIDS.ontSerial, 3000, serialToString),
            this.snmpWalk(HUAWEI_GPON_OIDS.ontName),
            this.snmpWalk(HUAWEI_GPON_OIDS.ontModel),
            this.snmpWalk(HUAWEI_GPON_OIDS.ontRunModel),
            this.snmpWalk(HUAWEI_GPON_OIDS.ontSoftwareVersion),
            this.snmpWalk(HUAWEI_GPON_OIDS.ontRxPower),
            this.snmpWalk(HUAWEI_GPON_OIDS.ontTxPower),
            this.snmpWalk(HUAWEI_GPON_OIDS.ontDistance)
        ]);

        return [...serials.keys()].map((index) => {
            const parsed = parseHuaweiIndex(index);
            const runtimeModel = runtimeModels.get(index);
            const status = runtimeModel && String(runtimeModel).trim() ? 'ONLINE' : 'OFFLINE';
            const name = names.get(index) || `ONT ${parsed.pon}/${parsed.ontId}`;
            const model = runtimeModel || models.get(index) || null;
            const serial = serials.get(index) || null;
            const rx = parseHuaweiRxPower(rxPowers.get(index));
            const tx = parseHuaweiTxPower(txPowers.get(index));
            const distance = parseHuaweiDistance(distances.get(index));
            return {
                onu_index: index,
                onu_id: parsed.ontId != null ? String(parsed.ontId) : index,
                onu_sn: serial,
                onu_name: name,
                vendor: 'Huawei',
                model,
                status,
                rx_power: rx,
                tx_power: tx,
                signal_quality: getSignalQuality(rx),
                distance,
                mac_address: null,
                ip_address: null,
                slot: parsed.slot,
                pon: parsed.pon,
                raw: {
                    index,
                    ifIndex: parsed.ifIndex,
                    ont_id: parsed.ontId,
                    name,
                    model,
                    runtime_model: runtimeModel || null,
                    software_version: softwareVersions.get(index) || null,
                    rx_power_raw: rxPowers.get(index) || null,
                    tx_power_raw: txPowers.get(index) || null,
                    distance_raw: distances.get(index) || null,
                    serial
                }
            };
        }).filter((onu) => onu.onu_sn || onu.onu_name);
    }

    async getPonPorts() {
        if (this.httpDriver) return this.httpDriver.getPonPorts();
        const onus = await this.getOnuList();
        const ponIds = [...new Set(onus.map((onu) => onu.pon).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
        return ponIds.map((pon) => ({
            slot: '0',
            pon: String(pon),
            name: `PON ${pon}`,
            onu_count: onus.filter((onu) => String(onu.pon) === String(pon)).length
        }));
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

    buildUnregisterCommands(onu) {
        const parsed = parseHuaweiIndex(onu.onu_index);
        const values = {
            frame: '0',
            slot: parsed.slot || '0',
            pon: parsed.gponPort || String(Math.max(0, Number(parsed.pon || 1) - 1)),
            port: parsed.gponPort || String(Math.max(0, Number(parsed.pon || 1) - 1)),
            ontId: parsed.ontId != null ? String(parsed.ontId) : String(onu.onu_id || ''),
            onuId: String(onu.onu_id || ''),
            onuIndex: String(onu.onu_index || '')
        };
        const template = process.env.OLT_HUAWEI_UNREGISTER_TEMPLATE || [
            'enable',
            'config',
            'interface gpon {frame}/{slot}',
            'ont delete {port} {ontId}',
            'quit',
            'quit'
        ].join('\n');

        return template
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => line.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? ''));
    }

    runSshCommands(commands) {
        if (!this.olt.username || !this.password) {
            const error = new Error('Huawei unregister requires OLT CLI username and password in OLT settings.');
            error.code = 'missing_olt_cli_credentials';
            throw error;
        }

        const conn = new Client();
        const output = [];
        const port = Number(process.env.OLT_HUAWEI_SSH_PORT || this.olt.ssh_port || 22);
        const timeoutMs = Number(process.env.OLT_CLI_TIMEOUT_MS || 30000);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                conn.end();
                reject(new Error('Huawei unregister SSH command timed out'));
            }, timeoutMs);

            conn.on('ready', () => {
                conn.shell((error, stream) => {
                    if (error) {
                        clearTimeout(timer);
                        conn.end();
                        return reject(error);
                    }

                    stream.on('data', (data) => {
                        const text = data.toString();
                        output.push(text);
                        if (/are you sure|confirm|continue|y\/n|\[n\]/i.test(text)) {
                            stream.write('y\n');
                        }
                        if (/password:/i.test(text) && this.enablePassword) {
                            stream.write(`${this.enablePassword}\n`);
                        }
                    });
                    stream.stderr.on('data', (data) => output.push(data.toString()));
                    stream.on('close', () => {
                        clearTimeout(timer);
                        conn.end();
                        resolve({ output: output.join('').slice(-4000) });
                    });

                    let delay = 500;
                    for (const command of commands) {
                        setTimeout(() => stream.write(`${command}\n`), delay);
                        delay += 700;
                    }
                    setTimeout(() => stream.end('quit\n'), delay + 500);
                });
            }).on('error', (error) => {
                clearTimeout(timer);
                reject(error);
            }).connect({
                host: this.olt.ip_address,
                port,
                username: this.olt.username,
                password: this.password,
                readyTimeout: 10000,
                algorithms: {
                    kex: [
                        'diffie-hellman-group14-sha1',
                        'diffie-hellman-group1-sha1',
                        'diffie-hellman-group-exchange-sha1',
                        'diffie-hellman-group-exchange-sha256',
                        'diffie-hellman-group14-sha256'
                    ],
                    serverHostKey: ['ssh-rsa', 'ssh-dss', 'rsa-sha2-256', 'rsa-sha2-512'],
                    cipher: [
                        'aes128-cbc',
                        '3des-cbc',
                        'aes192-cbc',
                        'aes256-cbc',
                        'aes128-ctr',
                        'aes192-ctr',
                        'aes256-ctr'
                    ],
                    hmac: ['hmac-sha1', 'hmac-md5', 'hmac-sha2-256', 'hmac-sha2-512']
                }
            });
        });
    }

    async runTelnetCommand(socket, command, waitMs = 1000) {
        socket.write(`${command}\n`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return this.consumeTelnetOutput();
    }

    consumeTelnetOutput() {
        const output = this.telnetOutput.join('');
        this.telnetOutput = [];
        return output;
    }

    runTelnetUnregister(onu) {
        if (!this.olt.username || !this.password) {
            const error = new Error('Huawei unregister requires OLT CLI username and password in OLT settings.');
            error.code = 'missing_olt_cli_credentials';
            throw error;
        }

        const parsed = parseHuaweiIndex(onu.onu_index);
        const slot = parsed.slot;
        const port = parsed.gponPort || String(Math.max(0, Number(parsed.pon || 1) - 1));
        const ontId = parsed.ontId != null ? String(parsed.ontId) : String(onu.onu_id || '');
        const telnetPort = Number(process.env.OLT_HUAWEI_TELNET_PORT || 23);
        const timeoutMs = Number(process.env.OLT_CLI_TIMEOUT_MS || 45000);
        const commands = [];

        this.telnetOutput = [];
        const socket = new net.Socket();
        socket.setEncoding('ascii');

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error('Huawei unregister Telnet command timed out'));
            }, timeoutMs);

            socket.on('data', (data) => {
                this.telnetOutput.push(String(data || ''));
                if (/are you sure|confirm|continue|y\/n|\[n\]|\(y\/n\)/i.test(String(data))) {
                    socket.write('y\n');
                }
                if (/password:/i.test(String(data)) && this.enablePassword) {
                    socket.write(`${this.enablePassword}\n`);
                }
            });
            socket.on('error', (error) => {
                clearTimeout(timer);
                reject(error);
            });
            socket.on('connect', async () => {
                try {
                    await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));
                    socket.write(`${this.olt.username}\n`);
                    await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));
                    socket.write(`${this.password}\n`);
                    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
                    this.consumeTelnetOutput();

                    for (const command of ['enable', 'config']) {
                        commands.push(command);
                        await this.runTelnetCommand(socket, command, 1000);
                    }

                    const displayServicePort = `display service-port port 0/${slot}/${port} ont ${ontId}`;
                    commands.push(displayServicePort);
                    const servicePortOutput = await this.runTelnetCommand(socket, displayServicePort, 2500);
                    const servicePortIds = parseServicePortIds(servicePortOutput);

                    for (const servicePortId of servicePortIds) {
                        const undoCommand = `undo service-port ${servicePortId}`;
                        commands.push(undoCommand);
                        await this.runTelnetCommand(socket, undoCommand, 900);
                        socket.write('\n');
                        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
                    }

                    const interfaceCommand = `interface gpon 0/${slot}`;
                    const deleteCommand = `ont delete ${port} ${ontId}`;
                    for (const command of [interfaceCommand, deleteCommand, 'quit', 'save']) {
                        commands.push(command);
                        await this.runTelnetCommand(socket, command, command === 'save' ? 1500 : 1000);
                        if (command === 'save') {
                            socket.write('\n');
                            await new Promise((resolveDelay) => setTimeout(resolveDelay, 2500));
                        }
                    }

                    const output = this.consumeTelnetOutput();
                    clearTimeout(timer);
                    socket.end();
                    resolve({
                        commands,
                        servicePortIds,
                        output: output.slice(-4000)
                    });
                } catch (error) {
                    clearTimeout(timer);
                    socket.destroy();
                    reject(error);
                }
            });
            socket.connect(telnetPort, this.olt.ip_address);
        });
    }

    async unregisterOnu(onu) {
        if (this.httpDriver) return this.httpDriver.callEndpoint('unregisterOnu', {
            onuId: onu.onu_id || onu.id,
            onuIndex: onu.onu_index || onu.id
        }, { onu });

        const protocol = String(process.env.OLT_HUAWEI_CLI_PROTOCOL || 'telnet').toLowerCase();
        const commands = this.buildUnregisterCommands(onu);
        const result = protocol === 'ssh'
            ? await this.runSshCommands(commands)
            : await this.runTelnetUnregister(onu);
        return {
            success: true,
            commands: result.commands || commands,
            service_port_ids: result.servicePortIds || [],
            message: 'Huawei ONU unregister command sent. Sync has been queued to verify removal.',
            output: result.output
        };
    }

    async syncData() {
        if (this.httpDriver) return this.httpDriver.syncData();
        const systemInfo = await this.getSystemInfo();
        const onuList = await this.getOnuList();
        const ponIds = [...new Set(onuList.map((onu) => onu.pon).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
        const ponPorts = ponIds.map((pon) => ({
            slot: '0',
            pon: String(pon),
            name: `PON ${pon}`,
            onu_count: onuList.filter((onu) => String(onu.pon) === String(pon)).length
        }));
        return { systemInfo, ponPorts, onuList, skipMarkMissing: true, pruneMissing: true };
    }
}

module.exports = HuaweiDriver;
