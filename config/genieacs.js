const axios = require('axios');
const { sendTechnicianMessage } = require('./sendMessage');
const mikrotik = require('./mikrotik');
const { getMikrotikConnection } = require('./mikrotik');
const { getSetting } = require('./settingsManager');
const cacheManager = require('./cacheManager');
const { tenantCacheKey } = require('./platform/tenantCache');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

function getConfiguredGenieacsUrlFromSettings() {
    try {
        const { hasTenantContext } = require('./platform/tenantContext');
        const { getTenantSetting } = require('./platform/tenantSettings');
        if (hasTenantContext()) {
            return String(getTenantSetting('genieacs_url', '') || '').trim();
        }
    } catch (_) {
        // single-tenant / non-platform mode
    }
    return String(getSetting('genieacs_url', '') || '').trim();
}

async function isGenieacsConfigured() {
    const servers = await getAllGenieacsServers();
    if (servers.some((s) => s && String(s.url || '').trim())) {
        return true;
    }
    return !!getConfiguredGenieacsUrlFromSettings();
}

// Helper untuk mendapatkan GenieACS server berdasarkan customer router
async function getGenieacsServerForCustomer(customer) {
    return new Promise((resolve, reject) => {
        try {
            const dbPath = path.join(__dirname, '../data/billing.db');
            const db = new sqlite3.Database(dbPath);

            // Customer harus punya id untuk lookup mapping
            if (!customer || !customer.id) {
                db.close();
                console.log('⚠️ Customer tidak punya id untuk lookup router mapping');
                resolve(null);
                return;
            }

            // Cek router_id langsung di customer (jika ada) atau dari customer_router_map
            let routerId = customer.router_id;

            // Jika tidak ada router_id langsung, ambil dari customer_router_map
            if (!routerId) {
                db.get(`SELECT router_id FROM customer_router_map WHERE customer_id = ?`, [customer.id], (err, mapRow) => {
                    if (err) {
                        console.error('Error getting router mapping for customer:', err);
                        db.close();
                        resolve(null);
                        return;
                    }

                    routerId = mapRow ? mapRow.router_id : null;

                    if (!routerId) {
                        db.close();
                        console.log(`⚠️ Customer ${customer.id} tidak memiliki router mapping`);
                        resolve(null);
                        return;
                    }

                    // Ambil GenieACS server dari router
                    db.get(`
                        SELECT g.* FROM genieacs_servers g
                        INNER JOIN routers r ON r.genieacs_server_id = g.id
                        WHERE r.id = ?
                    `, [routerId], (err2, row) => {
                        db.close();
                        if (err2) {
                            console.error('Error getting GenieACS server for router:', err2);
                            resolve(null);
                        } else {
                            if (row) {
                                console.log(`✅ GenieACS server found for customer ${customer.id}: ${row.name} (${row.url})`);
                            }
                            resolve(row || null);
                        }
                    });
                });
            } else {
                // Jika router_id sudah ada di customer object, langsung query
                db.get(`
                    SELECT g.* FROM genieacs_servers g
                    INNER JOIN routers r ON r.genieacs_server_id = g.id
                    WHERE r.id = ?
                `, [routerId], (err, row) => {
                    db.close();
                    if (err) {
                        console.error('Error getting GenieACS server for router:', err);
                        resolve(null);
                    } else {
                        if (row) {
                            console.log(`✅ GenieACS server found for customer ${customer.id}: ${row.name} (${row.url})`);
                        }
                        resolve(row || null);
                    }
                });
            }
        } catch (error) {
            console.error('Error in getGenieacsServerForCustomer:', error);
            resolve(null);
        }
    });
}

// Helper untuk membuat axios instance dinamis dengan server tertentu
function getAxiosInstance(genieacsServer = null) {
    let GENIEACS_URL, GENIEACS_USERNAME, GENIEACS_PASSWORD;

    if (genieacsServer) {
        // Gunakan server yang spesifik
        GENIEACS_URL = genieacsServer.url;
        GENIEACS_USERNAME = genieacsServer.username;
        GENIEACS_PASSWORD = genieacsServer.password;
    } else {
        GENIEACS_URL = getConfiguredGenieacsUrlFromSettings();
        GENIEACS_USERNAME = getSetting('genieacs_username', 'acs');
        GENIEACS_PASSWORD = getSetting('genieacs_password', '');
    }

    // Validasi URL
    if (!GENIEACS_URL || typeof GENIEACS_URL !== 'string' || GENIEACS_URL.trim() === '') {
        throw new Error('GenieACS URL tidak dikonfigurasi atau tidak valid. Silakan konfigurasi GenieACS URL di Settings atau tambahkan GenieACS Server di /admin/genieacs-setting');
    }

    // Validasi format URL
    try {
        new URL(GENIEACS_URL);
    } catch (e) {
        throw new Error(`Format GenieACS URL tidak valid: ${GENIEACS_URL}. URL harus lengkap dengan protocol (http:// atau https://)`);
    }

    return axios.create({
        baseURL: GENIEACS_URL,
        auth: {
            username: GENIEACS_USERNAME,
            password: GENIEACS_PASSWORD
        },
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 second timeout (diperpanjang untuk query yang kompleks)
    });
}

// GenieACS API wrapper
const genieacsApi = {
    async getDevices() {
        try {
            if (!(await isGenieacsConfigured())) {
                return [];
            }

            // Check cache first
            const cacheKey = tenantCacheKey('genieacs:devices');
            const cachedData = cacheManager.get(cacheKey);

            if (cachedData) {
                console.log(`✅ Using cached devices data (${cachedData.length} devices)`);
                return cachedData;
            }

            console.log('🔍 Fetching devices from GenieACS API...');

            try {
                const axiosInstance = getAxiosInstance();
                const response = await axiosInstance.get('/devices');
                const devices = response.data || [];

                console.log(`✅ Found ${devices.length} devices from API`);

                // Cache the response for 2 minutes
                cacheManager.set(cacheKey, devices, 2 * 60 * 1000);

                return devices;
            } catch (urlError) {
                // Jika error karena URL tidak valid atau tidak dikonfigurasi
                if (urlError.message && (urlError.message.includes('tidak dikonfigurasi') || urlError.message.includes('tidak valid'))) {
                    console.error('❌ Error getting devices:', urlError.message);
                    console.warn('⚠️ GenieACS tidak dikonfigurasi. Silakan konfigurasi di /admin/genieacs-setting atau Settings');
                    return []; // Return empty array instead of throwing
                }
                throw urlError;
            }
        } catch (error) {
            console.error('❌ Error getting devices:', error.response?.data || error.message);
            // Return empty array instead of throwing to prevent app crash
            return [];
        }
    },

    async findDeviceByPhoneNumber(phoneNumber) {
        try {
            console.log(`🔍 [FIND_DEVICE] Searching for device with phone number: ${phoneNumber}`);

            // Cari customer untuk mendapatkan GenieACS server yang tepat
            let genieacsServer = null;
            let customer = null;
            try {
                const billingManager = require('./billing');
                customer = await billingManager.getCustomerByPhone(phoneNumber);
                if (customer) {
                    console.log(`✅ Customer found: ${customer.name} (ID: ${customer.id})`);
                    genieacsServer = await getGenieacsServerForCustomer(customer);
                }
            } catch (billingError) {
                console.error(`Error finding customer for phone ${phoneNumber}:`, billingError.message);
            }

            const axiosInstance = getAxiosInstance(genieacsServer);

            // Bersihkan nomor dari karakter non-digit
            let cleanNumber = phoneNumber.replace(/\D/g, '');

            // Format nomor dalam beberapa variasi yang mungkin digunakan sebagai tag
            const possibleFormats = [];

            // Format 1: Nomor asli yang dibersihkan
            possibleFormats.push(cleanNumber);

            // Format 2: Jika diawali 0, coba versi dengan 62 di depan (ganti 0 dengan 62)
            if (cleanNumber.startsWith('0')) {
                possibleFormats.push('62' + cleanNumber.substring(1));
            }

            // Format 3: Jika diawali 62, coba versi dengan 0 di depan (ganti 62 dengan 0)
            if (cleanNumber.startsWith('62')) {
                possibleFormats.push('0' + cleanNumber.substring(2));
            }

            // Format 4: Tanpa awalan, jika ada awalan
            if (cleanNumber.startsWith('0') || cleanNumber.startsWith('62')) {
                if (cleanNumber.startsWith('0')) {
                    possibleFormats.push(cleanNumber.substring(1));
                } else if (cleanNumber.startsWith('62')) {
                    possibleFormats.push(cleanNumber.substring(2));
                }
            }

            // Format 5: Dengan prefix +62
            if (!cleanNumber.startsWith('62') && !cleanNumber.startsWith('0')) {
                possibleFormats.push('62' + cleanNumber);
                possibleFormats.push('0' + cleanNumber);
            }

            console.log(`📋 [FIND_DEVICE] Trying formats: ${possibleFormats.join(', ')}`);

            // Coba cari dengan semua format yang mungkin
            for (const format of possibleFormats) {
                try {
                    // Coba dengan query exact match
                    const response = await axiosInstance.get('/devices', {
                        params: {
                            'query': JSON.stringify({
                                '_tags': format
                            })
                        },
                        timeout: 10000
                    });

                    if (response.data && response.data.length > 0) {
                        console.log(`✅ Device found with exact tag match: ${format}`);
                        return response.data[0]; // Mengembalikan device pertama yang ditemukan
                    }
                } catch (queryError) {
                    console.log(`⚠️ Query failed for format ${format}: ${queryError.message}`);
                }
            }

            // Jika tidak ditemukan dengan exact match, coba cari semua device dan cek tags secara manual
            console.log(`🔍 [FIND_DEVICE] Exact match failed, trying partial match...`);
            try {
                const allDevicesResponse = await axiosInstance.get('/devices', { timeout: 10000 });

                if (allDevicesResponse.data && allDevicesResponse.data.length > 0) {
                    for (const device of allDevicesResponse.data) {
                        if (device._tags && Array.isArray(device._tags)) {
                            for (const tag of device._tags) {
                                for (const format of possibleFormats) {
                                    // Exact match
                                    if (tag === format) {
                                        console.log(`✅ Device found with exact tag match: ${format} (device: ${device._id})`);
                                        return device;
                                    }
                                    // Partial match
                                    if (tag.includes(format) || format.includes(tag)) {
                                        console.log(`✅ Device found with partial tag match: ${tag} contains ${format} (device: ${device._id})`);
                                        return device;
                                    }
                                    // Cleaned match (remove prefixes)
                                    const cleanTag = String(tag).replace(/^\+62|^62|^0/, '');
                                    const cleanFormat = format.replace(/^\+62|^62|^0/, '');
                                    if (cleanTag === cleanFormat || cleanTag.includes(cleanFormat) || cleanFormat.includes(cleanTag)) {
                                        console.log(`✅ Device found with cleaned tag match: ${tag} -> ${cleanTag} matches ${format} -> ${cleanFormat} (device: ${device._id})`);
                                        return device;
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (allDevicesError) {
                console.error(`Error fetching all devices: ${allDevicesError.message}`);
            }

            // Jika tidak ditemukan dengan tag, coba cari dengan PPPoE username dari billing
            if (customer && customer.pppoe_username) {
                console.log(`🔍 [FIND_DEVICE] Device not found by phone tag, trying PPPoE username: ${customer.pppoe_username}`);
                try {
                    return await this.findDeviceByPPPoE(customer.pppoe_username, customer);
                } catch (pppoeError) {
                    console.error(`Error finding device by PPPoE: ${pppoeError.message}`);
                }
            }

            console.log(`❌ [FIND_DEVICE] No device found with phone number: ${phoneNumber} (tried formats: ${possibleFormats.join(', ')})`);
            throw new Error(`No device found with phone number: ${phoneNumber}`);
        } catch (error) {
            console.error(`Error finding device with phone number ${phoneNumber}:`, error.response?.data || error.message);
            throw error;
        }
    },

    async findDeviceByPPPoE(pppoeUsername, customer = null) {
        try {
            console.log(`🔍 [FIND_PPPOE] Searching for device with PPPoE Username: ${pppoeUsername}`);

            // Jika customer tidak diberikan, cari dari billing
            if (!customer) {
                try {
                    const billingManager = require('./billing');
                    customer = await billingManager.getCustomerByPPPoE(pppoeUsername);
                    if (customer) {
                        console.log(`✅ Customer found: ${customer.name} (ID: ${customer.id})`);
                    }
                } catch (e) {
                    console.log(`⚠️ Customer not found for PPPoE ${pppoeUsername}, will search all servers`);
                }
            }

            // Dapatkan GenieACS server dari customer router
            let genieacsServer = null;
            if (customer) {
                genieacsServer = await getGenieacsServerForCustomer(customer);
            }

            // Jika tidak ada router mapping, coba semua servers atau default
            if (!genieacsServer) {
                console.log(`⚠️ No router mapping for customer, trying all GenieACS servers...`);
                try {
                    // Coba ambil semua devices dari semua servers dan filter berdasarkan PPPoE
                    const allDevices = await getAllDevicesFromAllServers();

                    // Filter device berdasarkan PPPoE username
                    for (const device of allDevices) {
                        // Cek berbagai path untuk PPPoE Username
                        const devicePPPoE = device?.VirtualParameters?.pppoeUsername?._value ||
                            device?.VirtualParameters?.pppoeUsername ||
                            device?.VirtualParameters?.pppUsername?._value ||
                            device?.VirtualParameters?.pppUsername ||
                            device?.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.Username?._value ||
                            device?.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.Username;

                        if (devicePPPoE && devicePPPoE === pppoeUsername) {
                            console.log(`✅ Device found with PPPoE Username: ${pppoeUsername} (Device ID: ${device._id}) from server: ${device._genieacs_server_name || 'Default'}`);
                            return device;
                        }
                    }

                    console.log(`⚠️ No device found with PPPoE Username: ${pppoeUsername} in all servers`);
                } catch (allServersError) {
                    console.log(`⚠️ Error searching all servers, falling back to default server:`, allServersError.message);
                    // Fallback ke default server dari settings.json
                }
            }

            // Gunakan server spesifik atau default
            const axiosInstance = getAxiosInstance(genieacsServer);

            // Method 1: Coba dengan query langsung (jika GenieACS support)
            try {
                const queryObj = {
                    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username': pppoeUsername
                };
                const queryJson = JSON.stringify(queryObj);
                const encodedQuery = encodeURIComponent(queryJson);

                const response = await axiosInstance.get(`/devices/?query=${encodedQuery}`, {
                    timeout: 10000
                });

                if (response.data && response.data.length > 0) {
                    console.log(`✅ Device found with PPPoE Username query: ${pppoeUsername} (Device ID: ${response.data[0]._id})`);
                    return response.data[0];
                }
            } catch (queryError) {
                console.log(`⚠️ Query method failed, trying manual search: ${queryError.message}`);
            }

            // Method 2: Ambil semua device dan filter secara manual
            try {
                const allDevicesResponse = await axiosInstance.get('/devices', { timeout: 10000 });

                if (allDevicesResponse.data && allDevicesResponse.data.length > 0) {
                    for (const device of allDevicesResponse.data) {
                        // Cek berbagai path untuk PPPoE Username
                        const devicePPPoE = device?.VirtualParameters?.pppoeUsername?._value ||
                            device?.VirtualParameters?.pppoeUsername ||
                            device?.VirtualParameters?.pppUsername?._value ||
                            device?.VirtualParameters?.pppUsername ||
                            device?.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.Username?._value ||
                            device?.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.Username;

                        if (devicePPPoE && devicePPPoE === pppoeUsername) {
                            console.log(`✅ Device found with PPPoE Username (manual search): ${pppoeUsername} (Device ID: ${device._id})`);
                            return device;
                        }
                    }
                }
            } catch (manualError) {
                console.error(`❌ Error in manual search: ${manualError.message}`);
            }

            console.log(`❌ No device found with PPPoE Username: ${pppoeUsername}`);
            return null; // Return null instead of throwing untuk error handling yang lebih baik
        } catch (error) {
            if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                console.error(`⏱️ Timeout finding device with PPPoE Username ${pppoeUsername}: GenieACS server tidak merespons dalam 30 detik`);
            } else {
                console.error(`❌ Error finding device with PPPoE Username ${pppoeUsername}:`, error.response?.data || error.message);
            }
            return null; // Return null instead of throwing untuk error handling yang lebih baik
        }
    },

    async getDeviceByPhoneNumber(phoneNumber) {
        try {
            const device = await this.findDeviceByPhoneNumber(phoneNumber);
            if (!device) {
                throw new Error(`No device found with phone number: ${phoneNumber}`);
            }
            return await this.getDevice(device._id);
        } catch (error) {
            console.error(`Error getting device by phone number ${phoneNumber}:`, error.message);
            throw error;
        }
    },

    async getDevice(deviceId) {
        try {
            const axiosInstance = getAxiosInstance();
            const response = await axiosInstance.get(`/devices/${encodeURIComponent(deviceId)}`);
            return response.data;
        } catch (error) {
            console.error(`Error getting device ${deviceId}:`, error.response?.data || error.message);
            throw error;
        }
    },

    async setParameterValues(deviceId, parameters) {
        try {
            console.log('Setting parameters for device:', deviceId, parameters);
            const axiosInstance = getAxiosInstance();
            // Format parameter values untuk GenieACS
            const parameterValues = [];
            for (const [path, value] of Object.entries(parameters)) {
                // Handle SSID update
                if (path.includes('SSID')) {
                    parameterValues.push(
                        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", value],
                        ["Device.WiFi.SSID.1.SSID", value]
                    );
                }
                // Handle WiFi password update
                else if (path.includes('Password') || path.includes('KeyPassphrase')) {
                    parameterValues.push(
                        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase", value],
                        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", value],
                        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey", value]
                    );
                }
                // Handle other parameters
                else {
                    parameterValues.push([path, value]);
                }
            }

            console.log('Formatted parameter values:', parameterValues);

            // Kirim task ke GenieACS
            const task = {
                name: "setParameterValues",
                parameterValues: parameterValues
            };

            const response = await axiosInstance.post(
                `/devices/${encodeURIComponent(deviceId)}/tasks?connection_request`,
                task
            );

            console.log('Parameter update response:', response.data);

            // Kirim refresh task
            const refreshTask = {
                name: "refreshObject",
                objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1"
            };

            const refreshResponse = await axiosInstance.post(
                `/devices/${encodeURIComponent(deviceId)}/tasks?connection_request`,
                refreshTask
            );

            console.log('Refresh task response:', refreshResponse.data);

            return response.data;
        } catch (error) {
            console.error(`Error setting parameters for device ${deviceId}:`, error.response?.data || error.message);
            throw error;
        }
    },

    async reboot(deviceId) {
        try {
            const axiosInstance = getAxiosInstance();
            const task = {
                name: "reboot",
                timestamp: new Date().toISOString()
            };
            const response = await axiosInstance.post(
                `/devices/${encodeURIComponent(deviceId)}/tasks`,
                task
            );
            return response.data;
        } catch (error) {
            console.error(`Error rebooting device ${deviceId}:`, error.response?.data || error.message);
            throw error;
        }
    },

    async factoryReset(deviceId) {
        try {
            const axiosInstance = getAxiosInstance();
            const task = {
                name: "factoryReset",
                timestamp: new Date().toISOString()
            };
            const response = await axiosInstance.post(
                `/devices/${encodeURIComponent(deviceId)}/tasks`,
                task
            );
            return response.data;
        } catch (error) {
            console.error(`Error factory resetting device ${deviceId}:`, error.response?.data || error.message);
            throw error;
        }
    },

    async addTagToDevice(deviceId, tag) {
        try {
            console.log(`Adding tag "${tag}" to device: ${deviceId}`);
            const axiosInstance = getAxiosInstance();

            // Dapatkan device terlebih dahulu untuk melihat tag yang sudah ada
            const device = await this.getDevice(deviceId);
            const existingTags = device._tags || [];

            // Cek apakah tag sudah ada
            if (existingTags.includes(tag)) {
                console.log(`Tag "${tag}" already exists on device ${deviceId}`);
                return { success: true, message: 'Tag already exists' };
            }

            // Tambahkan tag baru
            const newTags = [...existingTags, tag];

            // Update device dengan tag baru
            const response = await axiosInstance.put(
                `/devices/${encodeURIComponent(deviceId)}`,
                {
                    _tags: newTags
                }
            );

            console.log(`Successfully added tag "${tag}" to device ${deviceId}`);
            return { success: true, message: 'Tag added successfully' };
        } catch (error) {
            console.error(`Error adding tag "${tag}" to device ${deviceId}:`, error.response?.data || error.message);
            throw error;
        }
    },

    async removeTagFromDevice(deviceId, tag) {
        try {
            console.log(`Removing tag "${tag}" from device: ${deviceId}`);
            const axiosInstance = getAxiosInstance();

            // Dapatkan device terlebih dahulu untuk melihat tag yang sudah ada
            const device = await this.getDevice(deviceId);
            const existingTags = device._tags || [];

            // Cek apakah tag ada
            if (!existingTags.includes(tag)) {
                console.log(`Tag "${tag}" does not exist on device ${deviceId}`);
                return { success: true, message: 'Tag does not exist' };
            }

            // Hapus tag
            const newTags = existingTags.filter(t => t !== tag);

            // Update device dengan tag yang sudah difilter
            const response = await axiosInstance.put(
                `/devices/${encodeURIComponent(deviceId)}`,
                {
                    _tags: newTags
                }
            );

            console.log(`Successfully removed tag "${tag}" from device ${deviceId}`);
            return { success: true, message: 'Tag removed successfully' };
        } catch (error) {
            console.error(`Error removing tag "${tag}" from device ${deviceId}:`, error.response?.data || error.message);
            throw error;
        }
    },

    async getDeviceParameters(deviceId, parameterNames) {
        try {
            const axiosInstance = getAxiosInstance();
            const queryString = parameterNames.map(name => `query=${encodeURIComponent(name)}`).join('&');
            const response = await axiosInstance.get(`/devices/${encodeURIComponent(deviceId)}?${queryString}`);
            return response.data;
        } catch (error) {
            console.error(`Error getting parameters for device ${deviceId}:`, error.response?.data || error.message);
            throw error;
        }
    },

    async getDeviceInfo(deviceId) {
        try {
            console.log(`Getting device info for device ID: ${deviceId}`);
            const GENIEACS_URL = getSetting('genieacs_url', 'http://localhost:7557');
            const GENIEACS_USERNAME = getSetting('genieacs_username', 'acs');
            const GENIEACS_PASSWORD = getSetting('genieacs_password', '');
            // Mendapatkan device detail
            const deviceResponse = await axios.get(`${GENIEACS_URL}/devices/${encodeURIComponent(deviceId)}`, {
                auth: {
                    username: GENIEACS_USERNAME,
                    password: GENIEACS_PASSWORD
                }
            });
            return deviceResponse.data;
        } catch (error) {
            console.error(`Error getting device info for ${deviceId}:`, error.response?.data || error.message);
            throw error;
        }
    },

    async getVirtualParameters(deviceId) {
        try {
            const axiosInstance = getAxiosInstance();
            const response = await axiosInstance.get(`/devices/${encodeURIComponent(deviceId)}`);
            return response.data.VirtualParameters || {};
        } catch (error) {
            console.error(`Error getting virtual parameters for device ${deviceId}:`, error.response?.data || error.message);
            throw error;
        }
    },
};

// Fungsi untuk memeriksa nilai RXPower dari semua perangkat
async function monitorRXPower(threshold = -27) {
    try {
        console.log(`Memulai pemantauan RXPower dengan threshold ${threshold} dBm`);

        // Ambil semua perangkat
        const devices = await genieacsApi.getDevices();

        if (!devices || devices.length === 0) {
            console.warn('⚠️ Tidak ada perangkat ditemukan atau GenieACS tidak dikonfigurasi. Monitoring RXPower dilewati.');
            console.warn('⚠️ Silakan konfigurasi GenieACS di /admin/genieacs-setting atau Settings');
            return;
        }

        console.log(`Memeriksa RXPower untuk ${devices.length} perangkat...`);

        // Ambil data PPPoE dari Mikrotik
        console.log('Mengambil data PPPoE dari Mikrotik...');
        const conn = await getMikrotikConnection();
        let pppoeSecrets = [];

        if (conn) {
            try {
                // Dapatkan semua PPPoE secret dari Mikrotik
                pppoeSecrets = await conn.write('/ppp/secret/print');
                console.log(`Ditemukan ${pppoeSecrets.length} PPPoE secret`);
            } catch (error) {
                console.error('Error mendapatkan PPPoE secret:', error.message);
            }
        }

        const criticalDevices = [];

        // Periksa setiap perangkat
        for (const device of devices) {
            try {
                // Dapatkan nilai RXPower
                const rxPowerPaths = [
                    'VirtualParameters.RXPower',
                    'VirtualParameters.redaman',
                    'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
                    'Device.XPON.Interface.1.Stats.RXPower'
                ];

                let rxPower = null;

                // Periksa setiap jalur yang mungkin berisi nilai RXPower
                for (const path of rxPowerPaths) {
                    // Ekstrak nilai menggunakan path yang ada di device
                    if (getRXPowerValue(device, path)) {
                        rxPower = getRXPowerValue(device, path);
                        break;
                    }
                }

                // Jika rxPower ditemukan dan di bawah threshold
                if (rxPower !== null && parseFloat(rxPower) < threshold) {
                    // Cari PPPoE username dari parameter perangkat (seperti di handleAdminCheckONU)
                    let pppoeUsername = "Unknown";
                    const serialNumber = getDeviceSerialNumber(device);
                    const deviceId = device._id;
                    const shortDeviceId = deviceId.split('-')[2] || deviceId;

                    // Ambil PPPoE username dari parameter perangkat
                    pppoeUsername =
                        device.InternetGatewayDevice?.WANDevice?.[1]?.WANConnectionDevice?.[1]?.WANPPPConnection?.[1]?.Username?._value ||
                        device.InternetGatewayDevice?.WANDevice?.[0]?.WANConnectionDevice?.[0]?.WANPPPConnection?.[0]?.Username?._value ||
                        device.VirtualParameters?.pppoeUsername?._value ||
                        "Unknown";

                    // Jika tidak ditemukan dari parameter perangkat, coba cari dari PPPoE secret di Mikrotik
                    if (pppoeUsername === "Unknown") {
                        // Coba cari PPPoE secret yang terkait dengan perangkat ini berdasarkan comment
                        const matchingSecret = pppoeSecrets.find(secret => {
                            if (!secret.comment) return false;

                            // Cek apakah serial number atau device ID ada di kolom comment
                            return (
                                secret.comment.includes(serialNumber) ||
                                secret.comment.includes(shortDeviceId)
                            );
                        });

                        if (matchingSecret) {
                            // Jika ditemukan secret yang cocok, gunakan nama secret sebagai username
                            pppoeUsername = matchingSecret.name;
                            console.log(`Menemukan PPPoE username ${pppoeUsername} untuk perangkat ${shortDeviceId} dari PPPoE secret`);
                        }
                    } else {
                        console.log(`Menemukan PPPoE username ${pppoeUsername} untuk perangkat ${shortDeviceId} dari parameter perangkat`);
                    }

                    // Jika masih tidak ditemukan, coba cari dari tag perangkat
                    if (pppoeUsername === "Unknown" && device._tags && Array.isArray(device._tags)) {
                        // Cek apakah ada tag yang dimulai dengan "pppoe:" yang berisi username
                        const pppoeTag = device._tags.find(tag => tag.startsWith('pppoe:'));
                        if (pppoeTag) {
                            pppoeUsername = pppoeTag.replace('pppoe:', '');
                            console.log(`Menemukan PPPoE username ${pppoeUsername} untuk perangkat ${shortDeviceId} dari tag`);
                        } else {
                            console.log(`Tidak menemukan PPPoE username untuk perangkat ${shortDeviceId}, tags: ${JSON.stringify(device._tags)}`);
                        }
                    }

                    const deviceInfo = {
                        id: device._id,
                        rxPower,
                        serialNumber: getDeviceSerialNumber(device),
                        lastInform: device._lastInform,
                        pppoeUsername: pppoeUsername
                    };

                    criticalDevices.push(deviceInfo);
                    console.log(`Perangkat dengan RXPower rendah: ${deviceInfo.id}, RXPower: ${rxPower} dBm, PPPoE: ${pppoeUsername}`);
                }
            } catch (deviceError) {
                console.error(`Error memeriksa RXPower untuk perangkat ${device._id}:`, deviceError);
            }
        }

        // Jika ada perangkat dengan RXPower di bawah threshold
        if (criticalDevices.length > 0) {
            // Buat pesan peringatan
            let message = `⚠️ *PERINGATAN: REDAMAN TINGGI* ⚠️\n\n`;
            message += `${criticalDevices.length} perangkat memiliki nilai RXPower di atas ${threshold} dBm:\n\n`;

            criticalDevices.forEach((device, index) => {
                message += `${index + 1}. ID: ${device.id.split('-')[2] || device.id}\n`;
                message += `   S/N: ${device.serialNumber}\n`;
                message += `   PPPoE: ${device.pppoeUsername}\n`;
                message += `   RXPower: ${device.rxPower} dBm\n`;
                message += `   Last Inform: ${new Date(device.lastInform).toLocaleString()}\n\n`;
            });

            message += `Mohon segera dicek untuk menghindari koneksi terputus.`;

            const { isWaSystemMonitorEnabled } = require('./whatsappMonitoringSettings');
            if (!isWaSystemMonitorEnabled('genieacs_rx_recap_wa')) {
                console.log('Master switch genieacs_rx_recap_wa off — skip WA rekap RX GenieACS');
            } else {
                await sendTechnicianMessage(message, 'high');
                console.log(`Pesan peringatan RXPower terkirim untuk ${criticalDevices.length} perangkat`);
            }
        } else {
            console.log('Tidak ada perangkat dengan nilai RXPower di bawah threshold');
        }

        return {
            success: true,
            criticalDevices,
            message: `${criticalDevices.length} perangkat memiliki RXPower di atas threshold`
        };
    } catch (error) {
        console.error('Error memantau RXPower:', error);
        return {
            success: false,
            message: `Error memantau RXPower: ${error.message}`,
            error
        };
    }
}

// Helper function untuk mendapatkan nilai RXPower
function getRXPowerValue(device, path) {
    try {
        // Split path menjadi parts
        const parts = path.split('.');
        let current = device;

        // Navigate through nested properties
        for (const part of parts) {
            if (!current) return null;
            current = current[part];
        }

        // Check if it's a GenieACS parameter object
        if (current && current._value !== undefined) {
            return current._value;
        }

        return null;
    } catch (error) {
        console.error(`Error getting RXPower from path ${path}:`, error);
        return null;
    }
}

// Helper function untuk mendapatkan serial number
function getDeviceSerialNumber(device) {
    try {
        const serialPaths = [
            'DeviceID.SerialNumber',
            'InternetGatewayDevice.DeviceInfo.SerialNumber',
            'Device.DeviceInfo.SerialNumber'
        ];

        for (const path of serialPaths) {
            const parts = path.split('.');
            let current = device;

            for (const part of parts) {
                if (!current) break;
                current = current[part];
            }

            if (current && current._value !== undefined) {
                return current._value;
            }
        }

        // Fallback ke ID perangkat jika serial number tidak ditemukan
        if (device._id) {
            const parts = device._id.split('-');
            if (parts.length >= 3) {
                return parts[2];
            }
            return device._id;
        }

        return 'Unknown';
    } catch (error) {
        console.error('Error getting device serial number:', error);
        return 'Unknown';
    }
}

// Fungsi untuk memantau perangkat yang tidak aktif (offline)
async function monitorOfflineDevices(thresholdHours = null) {
    try {
        const offlineNotifEnabled = getSetting('offline_notification_enable', true) !== false;
        if (!offlineNotifEnabled) {
            console.log('Offline notification monitoring disabled (offline_notification_enable=false) — skip monitorOfflineDevices');
            return {
                success: true,
                offlineDevices: [],
                message: 'Offline notification monitoring disabled'
            };
        }

        const { isWaSystemMonitorEnabled: waMonOff } = require('./whatsappMonitoringSettings');
        if (!waMonOff('genieacs_offline_digest_wa')) {
            console.log('Master switch genieacs_offline_digest_wa off — skip monitorOfflineDevices');
            return {
                success: true,
                offlineDevices: [],
                message: 'GenieACS offline WA digest disabled'
            };
        }

        // Jika thresholdHours tidak diberikan, ambil dari settings
        if (thresholdHours === null) {
            thresholdHours = parseInt(getSetting('offline_device_threshold_hours', '24'));
        }
        console.log(`Memulai pemantauan perangkat offline dengan threshold ${thresholdHours} jam`);

        // Ambil semua perangkat
        const devices = await genieacsApi.getDevices();
        console.log(`Memeriksa status untuk ${devices.length} perangkat...`);

        const offlineDevices = [];
        const now = new Date();
        const thresholdMs = thresholdHours * 60 * 60 * 1000; // Convert jam ke ms

        // Periksa setiap perangkat
        for (const device of devices) {
            try {
                if (!device._lastInform) {
                    console.log(`Perangkat ${device._id} tidak memiliki lastInform`);
                    continue;
                }

                const lastInformTime = new Date(device._lastInform).getTime();
                const timeDiff = now.getTime() - lastInformTime;

                // Jika perangkat belum melakukan inform dalam waktu yang melebihi threshold
                if (timeDiff > thresholdMs) {
                    const pppoeUsername = device?.VirtualParameters?.pppoeUsername?._value ||
                        device?.InternetGatewayDevice?.WANDevice?.[1]?.WANConnectionDevice?.[1]?.WANPPPConnection?.[1]?.Username?._value ||
                        device?.InternetGatewayDevice?.WANDevice?.[0]?.WANConnectionDevice?.[0]?.WANPPPConnection?.[0]?.Username?._value ||
                        (Array.isArray(device?._tags) ? (device._tags.find(tag => tag.startsWith('pppoe:'))?.replace('pppoe:', '')) : undefined) ||
                        '-';
                    const deviceInfo = {
                        id: device._id,
                        serialNumber: getDeviceSerialNumber(device),
                        pppoeUsername,
                        lastInform: device._lastInform,
                        offlineHours: Math.round(timeDiff / (60 * 60 * 1000) * 10) / 10 // Jam dengan 1 desimal
                    };

                    offlineDevices.push(deviceInfo);
                    console.log(`Perangkat offline: ${deviceInfo.id}, Offline selama: ${deviceInfo.offlineHours} jam`);
                }
            } catch (deviceError) {
                console.error(`Error memeriksa status untuk perangkat ${device._id}:`, deviceError);
            }
        }

        // Jika ada perangkat yang offline
        if (offlineDevices.length > 0) {
            // Buat pesan peringatan
            let message = `⚠️ *PERINGATAN: PERANGKAT OFFLINE* ⚠️\n\n`;
            message += `${offlineDevices.length} perangkat offline lebih dari ${thresholdHours} jam:\n\n`;

            offlineDevices.forEach((device, index) => {
                message += `${index + 1}. ID: ${device.id.split('-')[2] || device.id}\n`;
                message += `   S/N: ${device.serialNumber}\n`;
                message += `   PPPoE: ${device.pppoeUsername || '-'}\n`;
                message += `   Offline selama: ${device.offlineHours} jam\n`;
                message += `   Last Inform: ${new Date(device.lastInform).toLocaleString()}\n\n`;
            });

            message += `Mohon segera ditindaklanjuti.`;

            await sendTechnicianMessage(message, 'medium');
            console.log(`Pesan peringatan perangkat offline terkirim untuk ${offlineDevices.length} perangkat`);
        } else {
            console.log('Tidak ada perangkat yang offline lebih dari threshold');
        }

        return {
            success: true,
            offlineDevices,
            message: `${offlineDevices.length} perangkat offline lebih dari ${thresholdHours} jam`
        };
    } catch (error) {
        console.error('Error memantau perangkat offline:', error);
        return {
            success: false,
            message: `Error memantau perangkat offline: ${error.message}`,
            error
        };
    }
}

// Jadwalkan monitoring setiap 6 jam
function scheduleMonitoring() {
    const minPollingIntervalMs = 10 * 1000;
    const normalizeInterval = (value, fallbackMs) => {
        const parsed = Number(value);
        const interval = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
        return Math.max(interval, minPollingIntervalMs);
    };

    // Ambil pengaturan dari settings.json
    const rxPowerRecapEnabled = getSetting('rxpower_recap_enable', true) !== false;
    const rxPowerRecapInterval = normalizeInterval(getSetting('rxpower_recap_interval', 6 * 60 * 60 * 1000), 6 * 60 * 60 * 1000);
    const offlineNotifEnabled = getSetting('offline_notification_enable', true) !== false;
    const offlineNotifInterval = normalizeInterval(getSetting('offline_notification_interval', 12 * 60 * 60 * 1000), 12 * 60 * 60 * 1000);

    setTimeout(async () => {
        if (rxPowerRecapEnabled) {
            console.log('Menjalankan pemantauan RXPower awal...');
            await monitorRXPower();
        }
        if (offlineNotifEnabled) {
            console.log('Menjalankan pemantauan perangkat offline awal...');
            await monitorOfflineDevices();
        }
        // Jadwalkan secara berkala
        if (rxPowerRecapEnabled) {
            setInterval(async () => {
                console.log('Menjalankan pemantauan RXPower terjadwal...');
                await monitorRXPower();
            }, rxPowerRecapInterval);
        }
        if (offlineNotifEnabled) {
            setInterval(async () => {
                console.log('Menjalankan pemantauan perangkat offline terjadwal...');
                await monitorOfflineDevices();
            }, offlineNotifInterval);
        }
    }, 5 * 60 * 1000); // Mulai 5 menit setelah server berjalan
}

// Jalankan penjadwalan monitoring - DISABLED (using IntervalManager instead)
// scheduleMonitoring();

// ===== ENHANCEMENT: CACHED VERSIONS (Tidak mengubah fungsi existing) =====

/**
 * Enhanced getDevices dengan caching
 * Fallback ke fungsi original jika cache miss
 */
async function getDevicesCached() {
    if (!(await isGenieacsConfigured())) {
        return [];
    }

    // Use the same cache key as getDevices method
    const cacheKey = tenantCacheKey('genieacs:devices');
    const cached = cacheManager.get(cacheKey);

    if (cached) {
        console.log(`📦 Using cached devices data (${cached.length} devices)`);
        return cached;
    }

    console.log('🔄 Fetching fresh devices data from GenieACS');
    const devices = await genieacsApi.getDevices();

    return devices; // getDevices already handles caching
}

/**
 * Enhanced getDeviceInfo dengan caching
 * Fallback ke fungsi original jika cache miss
 */
async function getDeviceInfoCached(deviceId) {
    const cacheKey = `genieacs_device_${deviceId}`;
    const cached = cacheManager.get(cacheKey);

    if (cached) {
        console.log(`📦 Using cached device info for ${deviceId}`);
        return cached;
    }

    console.log(`🔄 Fetching fresh device info for ${deviceId}`);
    const deviceInfo = await genieacsApi.getDeviceInfo(deviceId);

    // Cache untuk 2 menit
    cacheManager.set(cacheKey, deviceInfo, 2 * 60 * 1000);

    return deviceInfo;
}

/**
 * Clear cache untuk device tertentu
 * Berguna saat ada update device
 */
function clearDeviceCache(deviceId = null) {
    try {
        if (deviceId) {
            cacheManager.clear(`genieacs_device_${deviceId}`);
            console.log(`🗑️ Cleared cache for device ${deviceId}`);
        } else {
            // Clear all GenieACS related cache
            cacheManager.clear('genieacs_devices');
            console.log('🗑️ Cleared all GenieACS devices cache');
        }
    } catch (error) {
        console.error('Error clearing device cache:', error);
        throw error;
    }
}

/**
 * Clear all cache (untuk maintenance)
 */
function clearAllCache() {
    try {
        cacheManager.clearAll();
        console.log('🗑️ Cleared all cache');
    } catch (error) {
        console.error('Error clearing all cache:', error);
        throw error;
    }
}

/**
 * Get cache statistics untuk monitoring
 */
function getCacheStats() {
    return cacheManager.getStats();
}

// Get all GenieACS servers from database
async function getAllGenieacsServers() {
    return new Promise((resolve, reject) => {
        try {
            const dbPath = path.join(__dirname, '../data/billing.db');
            const db = new sqlite3.Database(dbPath);
            db.all(`SELECT id, name, url, username, password FROM genieacs_servers ORDER BY name`, (err, rows) => {
                db.close();
                if (err) {
                    console.error('Error getting GenieACS servers:', err);
                    resolve([]);
                } else {
                    resolve(rows || []);
                }
            });
        } catch (error) {
            console.error('Error in getAllGenieacsServers:', error);
            resolve([]);
        }
    });
}

// Get devices from all GenieACS servers
async function getAllDevicesFromAllServers() {
    if (!(await isGenieacsConfigured())) {
        return [];
    }

    try {
        const servers = await getAllGenieacsServers();
        if (servers.length === 0) {
            const defaultDevices = await genieacsApi.getDevices();
            return (defaultDevices || []).map((device) => ({
                ...device,
                _genieacs_server_id: null,
                _genieacs_server_name: 'Default',
            }));
        }

        const allDevices = [];
        for (const server of servers) {
            try {
                const axiosInstance = getAxiosInstance(server);
                const response = await axiosInstance.get('/devices', { timeout: 30000 });
                const devices = (response.data || []).map((device) => ({
                    ...device,
                    _genieacs_server_id: server.id,
                    _genieacs_server_name: server.name,
                    _genieacs_server_url: server.url,
                }));
                allDevices.push(...devices);
                console.log(`✅ Found ${devices.length} devices from server: ${server.name}`);
            } catch (error) {
                console.error(`❌ Error fetching devices from server ${server.name}:`, error.message);
            }
        }

        console.log(`✅ Total devices from all servers: ${allDevices.length}`);
        return allDevices;
    } catch (error) {
        console.error('Error in getAllDevicesFromAllServers:', error);
        return [];
    }
}

module.exports = {
    // Original functions
    getDevices: genieacsApi.getDevices,
    getDeviceInfo: genieacsApi.getDeviceInfo,
    findDeviceByPhoneNumber: genieacsApi.findDeviceByPhoneNumber,
    findDeviceByPPPoE: genieacsApi.findDeviceByPPPoE,
    // Helper functions for multi-server support
    getGenieacsServerForCustomer,
    getAxiosInstance,
    getAllGenieacsServers,
    getAllDevicesFromAllServers,
    isGenieacsConfigured,
    getConfiguredGenieacsUrlFromSettings,
    getDeviceByPhoneNumber: genieacsApi.getDeviceByPhoneNumber,
    setParameterValues: genieacsApi.setParameterValues,
    reboot: genieacsApi.reboot,
    factoryReset: genieacsApi.factoryReset,
    addTagToDevice: genieacsApi.addTagToDevice,
    removeTagFromDevice: genieacsApi.removeTagFromDevice,
    getVirtualParameters: genieacsApi.getVirtualParameters,
    monitorRXPower,
    monitorOfflineDevices,

    // Enhanced functions dengan caching
    getDevicesCached,
    getDeviceInfoCached,
    clearDeviceCache,
    clearAllCache,
    getCacheStats
};
