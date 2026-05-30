/**
 * FIXED VERSION v2 - adminMappingNew.js
 * Perbaikan untuk masalah:
 * 1. Error SQL: no such column: c.serial_number
 * 2. Error JS: pppoeUsername.includes is not a function
 * 3. Error JS: Cannot access 'customers' before initialization
 * 4. Error Logic: Device ID undefined
 */

const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { adminAuth } = require('./adminAuth');
const cacheManager = require('../config/cacheManager');
const {
    CACHE_KEYS,
    CACHE_TTL,
    invalidateMappingCache,
    openBillingDb,
    loadMappingDbData,
    buildCorePayload,
    buildLivePayload,
    buildMappingStatistics,
    enrichCustomersWithPppoe,
    getPppoeBatchCached
} = require('../utils/mappingNewData');

// Helper function untuk mendapatkan nilai parameter dari device
function getParameterValue(device, parameterPath) {
    if (!device || !parameterPath) return null;
    
    const pathParts = parameterPath.split('.');
    let current = device;
    
    for (const part of pathParts) {
        if (current && typeof current === 'object' && current.hasOwnProperty(part)) {
            current = current[part];
        } else {
            return null;
        }
    }
    
    // Pastikan return value adalah string atau null
    if (current === null || current === undefined) {
        return null;
    }
    
    // Konversi object ke string jika diperlukan
    if (typeof current === 'object') {
        return JSON.stringify(current);
    }
    
    return String(current);
}

// Helper function untuk mendapatkan status device
function getDeviceStatus(lastInform) {
    if (!lastInform) return 'Offline';
    
    const now = new Date();
    const lastInformTime = new Date(lastInform);
    const diffMinutes = (now - lastInformTime) / (1000 * 60);
    
    return diffMinutes < 15 ? 'Online' : 'Offline';
}

// Helper function untuk memvalidasi dan membersihkan PPPoE username
function sanitizePPPoEUsername(username) {
    if (!username) return null;
    
    // Jika berupa object, konversi ke string
    if (typeof username === 'object') {
        username = JSON.stringify(username);
    }
    
    // Pastikan berupa string
    if (typeof username !== 'string') {
        return null;
    }
    
    // Bersihkan dari karakter yang tidak valid
    username = username.trim();
    
    // Skip jika berupa placeholder atau kosong
    if (username === '-' || username === '' || username === 'null' || username === 'undefined') {
        return null;
    }
    
    return username;
}

// Helper function untuk memvalidasi device ID
function getValidDeviceId(device) {
    if (!device) return null;
    
    // Coba berbagai kemungkinan ID
    const possibleIds = [
        device._id,
        device.id,
        device.DeviceID,
        device._deviceId
    ];
    
    for (const id of possibleIds) {
        if (id && typeof id === 'string' && id.trim() !== '') {
            return id.trim();
        }
    }
    
    // Generate fallback ID jika tidak ada yang valid
    return `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Helper function untuk mendapatkan parameter value dari device GenieACS
function getParameterValue(device, parameterPath) {
    try {
        const parts = parameterPath.split('.');
        let current = device;
        
        for (const part of parts) {
            if (!current) return null;
            current = current[part];
        }
        
        // Check if it's a GenieACS parameter object
        if (current && current._value !== undefined) {
        return current._value;
    }
    
        return current || null;
    } catch (error) {
        console.error(`Error getting parameter ${parameterPath}:`, error);
        return null;
    }
}

// Helper function untuk mendapatkan device status
function getDeviceStatus(lastInform) {
    if (!lastInform) return 'Offline';
    
    const now = new Date();
    const lastInformTime = new Date(lastInform);
    const diffMinutes = (now - lastInformTime) / (1000 * 60);
    
    if (diffMinutes <= 60) return 'Online';
    if (diffMinutes <= 1440) return 'Warning'; // 24 hours
    return 'Offline';
}

// Helper function untuk mendapatkan nilai RXPower dengan multiple paths
function getRXPowerValue(device) {
    try {
        // Paths yang mungkin berisi nilai RXPower
        const rxPowerPaths = [
            'VirtualParameters.RXPower',
            'VirtualParameters.redaman',
            'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
            'Device.XPON.Interface.1.Stats.RXPower',
            'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower._value',
            'VirtualParameters.RXPower._value',
            'Device.XPON.Interface.1.Stats.RXPower._value'
        ];
        
        let rxPower = null;
        
        // Periksa setiap jalur yang mungkin berisi nilai RXPower
        for (const path of rxPowerPaths) {
            const value = getParameterValue(device, path);
            if (value !== null && value !== undefined && value !== '') {
                // Validasi apakah nilai berupa angka
                const numValue = parseFloat(value);
                if (!isNaN(numValue)) {
                    rxPower = value;
                    break;
                }
            }
        }
        
        return rxPower;
    } catch (error) {
        console.error('Error getting RXPower:', error);
        return null;
    }
}

// Helper function untuk mendapatkan nilai TXPower dengan multiple paths
function getTXPowerValue(device) {
    try {
        // Paths yang mungkin berisi nilai TXPower
        const txPowerPaths = [
            'VirtualParameters.TXPower',
            'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.TXPower',
            'Device.XPON.Interface.1.Stats.TXPower',
            'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.TXPower._value',
            'VirtualParameters.TXPower._value',
            'Device.XPON.Interface.1.Stats.TXPower._value'
        ];
        
        let txPower = null;
        
        // Periksa setiap jalur yang mungkin berisi nilai TXPower
        for (const path of txPowerPaths) {
            const value = getParameterValue(device, path);
            if (value !== null && value !== undefined && value !== '') {
                // Validasi apakah nilai berupa angka
                const numValue = parseFloat(value);
                if (!isNaN(numValue)) {
                    txPower = value;
                    break;
                }
            }
        }
        
        return txPower;
    } catch (error) {
        console.error('Error getting TXPower:', error);
        return null;
    }
}

// API endpoint untuk mapping data baru
router.get('/api/mapping/new', adminAuth, async (req, res) => {
    const started = Date.now();
    const phase = String(req.query.phase || 'full').toLowerCase();

    try {
        if (phase === 'core') {
            const cached = cacheManager.get(CACHE_KEYS.core);
            if (cached) {
                return res.json({ success: true, data: cached, phase: 'core', cached: true, ms: Date.now() - started });
            }

            const db = openBillingDb();
            const dbData = await loadMappingDbData(db);
            db.close();

            const data = buildCorePayload(dbData);
            cacheManager.set(CACHE_KEYS.core, data, CACHE_TTL.core);
            console.log(`✅ Mapping core loaded in ${Date.now() - started}ms`);
            return res.json({ success: true, data, phase: 'core', cached: false, ms: Date.now() - started });
        }

        if (phase === 'live') {
            const cached = cacheManager.get(CACHE_KEYS.live);
            if (cached) {
                return res.json({ success: true, data: cached, phase: 'live', cached: true, ms: Date.now() - started });
            }

            let customers = cacheManager.get(CACHE_KEYS.core)?.customers;
            if (!customers?.length) {
                const db = openBillingDb();
                const dbData = await loadMappingDbData(db);
                db.close();
                customers = dbData.customers;
            } else {
                customers = customers.map((c) => ({
                    id: c.id,
                    name: c.name,
                    phone: c.phone,
                    pppoe_username: c.pppoe_username,
                    latitude: c.latitude,
                    longitude: c.longitude,
                    address: c.address,
                    package_id: c.package_id,
                    status: c.status,
                    join_date: c.join_date,
                    odp_id: c.odp_id,
                    package_name: c.package_name,
                    odp_name: c.odp_name
                }));
            }

            const live = await buildLivePayload(customers);
            const data = {
                customers: live.enrichedCustomers,
                statistics: {
                    downCustomers: live.enrichedCustomers.filter((c) => c.network_down === true).length
                }
            };
            cacheManager.set(CACHE_KEYS.live, data, CACHE_TTL.live);
            console.log(`✅ Mapping live (PPPoE) loaded in ${Date.now() - started}ms`);
            return res.json({ success: true, data, phase: 'live', cached: false, ms: Date.now() - started });
        }

        console.log('🚀 New Mapping API - Loading full network data...');
        const db = openBillingDb();
        const dbData = await loadMappingDbData(db);
        db.close();

        const pppoeBatch = await getPppoeBatchCached();
        const enrichedCustomers = enrichCustomersWithPppoe(dbData.customers, pppoeBatch);

        const data = buildCorePayload(dbData);
        data.customers = enrichedCustomers;
        data.onuDevices = [];
        data.statistics = buildMappingStatistics(
            enrichedCustomers,
            dbData.odps,
            dbData.cables,
            dbData.backboneCables,
            []
        );

        console.log(`✅ Mapping full loaded in ${Date.now() - started}ms`);
        return res.json({ success: true, data, phase: 'full', ms: Date.now() - started });
    } catch (error) {
        console.error('❌ Error in new mapping API:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// API endpoint untuk update ONU device
router.post('/update-onu', adminAuth, async (req, res) => {
    try {
        console.log('🔄 Update ONU API - Processing request...');
        console.log('📋 Request data:', req.body);
        
        const { id, name, serial_number, mac_address, ip_address, status, latitude, longitude, customer_id, odp_id } = req.body;
        
        // Validate required fields
        if (!id || !name || !serial_number || !mac_address) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: id, name, serial_number, mac_address'
            });
        }
        
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Check if ONU device exists in database
        const existingDevice = await new Promise((resolve, reject) => {
            db.get(`
                SELECT id FROM onu_devices WHERE id = ?
            `, [id], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
        
        if (existingDevice) {
            // Update existing ONU device
            await new Promise((resolve, reject) => {
                db.run(`
                    UPDATE onu_devices SET 
                        name = ?, 
                        serial_number = ?, 
                        mac_address = ?, 
                        ip_address = ?, 
                        status = ?, 
                        latitude = ?, 
                        longitude = ?, 
                        customer_id = ?, 
                        odp_id = ?,
                        updated_at = datetime('now','localtime')
                    WHERE id = ?
                `, [name, serial_number, mac_address, ip_address, status, latitude, longitude, customer_id, odp_id, id], function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        console.log(`✅ Updated ONU device: ${id}`);
                        resolve();
                    }
                });
            });
        } else {
            // Insert new ONU device
            await new Promise((resolve, reject) => {
                db.run(`
                    INSERT INTO onu_devices (
                        id, name, serial_number, mac_address, ip_address, status, 
                        latitude, longitude, customer_id, odp_id, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
                `, [id, name, serial_number, mac_address, ip_address, status, latitude, longitude, customer_id, odp_id], function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        console.log(`✅ Created new ONU device: ${id}`);
                        resolve();
                    }
                });
            });
        }
        
        db.close();
        
        console.log('✅ ONU device updated successfully in database');
        
        // Invalidate GenieACS cache after successful update
        try {
            const cacheManager = require('../config/cacheManager');
            cacheManager.invalidatePattern('genieacs:*');
            invalidateMappingCache();
            console.log('🔄 GenieACS cache invalidated after ONU update');
        } catch (cacheError) {
            console.warn('⚠️ Failed to invalidate cache:', cacheError.message);
        }
        
        res.json({
            success: true,
            message: 'ONU device updated successfully',
            data: {
                id: id,
                name: name,
                serial_number: serial_number,
                mac_address: mac_address,
                ip_address: ip_address,
                status: status,
                latitude: latitude,
                longitude: longitude,
                customer_id: customer_id,
                odp_id: odp_id
            }
        });
        
    } catch (error) {
        console.error('❌ Error updating ONU device:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating ONU device: ' + error.message
        });
    }
});

// API endpoint untuk mendapatkan detail ODP
router.get('/odp/:id', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'ODP ID is required'
            });
        }
        
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Get ODP details
        const odp = await new Promise((resolve, reject) => {
            db.get(`
                SELECT id, name, code, capacity, used_ports, status, 
                       address, latitude, longitude, installation_date,
                       created_at, updated_at
                FROM odps 
                WHERE id = ?
            `, [id], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
        
        db.close();
        
        if (!odp) {
            return res.status(404).json({
                success: false,
                message: 'ODP not found'
            });
        }
        
        res.json({
            success: true,
            data: odp
        });
        
    } catch (error) {
        console.error('❌ Error getting ODP details:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting ODP details: ' + error.message
        });
    }
});

// API endpoint untuk update ODP
router.post('/update-odp', adminAuth, async (req, res) => {
    try {
        console.log('🔄 Update ODP API - Processing request...');
        console.log('📋 Request data:', req.body);
        
        const { id, name, code, capacity, used_ports, status, address, latitude, longitude, installation_date, parent_odp_id } = req.body;
        const isNewOdp = !id || id === 'new' || id === '0';
        
        if (!isNewOdp && !id) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: id'
            });
        }
        
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        let existingODP = null;
        if (!isNewOdp) {
            existingODP = await new Promise((resolve, reject) => {
                db.get(`SELECT id FROM odps WHERE id = ?`, [id], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });
        }
        
        let savedOdpId = isNewOdp ? null : parseInt(id, 10);
        let savedCode = code;
        
        if (existingODP) {
            // Bangun query dinamis berdasarkan field yang ada
            const fields = [];
            const values = [];
            
            if (name !== undefined) {
                fields.push('name = ?');
                values.push(name);
            }
            if (code !== undefined) {
                fields.push('code = ?');
                values.push(code);
            }
            if (capacity !== undefined) {
                fields.push('capacity = ?');
                values.push(capacity);
            }
            if (used_ports !== undefined) {
                fields.push('used_ports = ?');
                values.push(used_ports);
            }
            if (status !== undefined) {
                fields.push('status = ?');
                values.push(status);
            }
            if (address !== undefined) {
                fields.push('address = ?');
                values.push(address);
            }
            if (latitude !== undefined) {
                fields.push('latitude = ?');
                values.push(latitude);
            }
            if (longitude !== undefined) {
                fields.push('longitude = ?');
                values.push(longitude);
            }
            if (installation_date !== undefined) {
                fields.push('installation_date = ?');
                values.push(installation_date);
            }
            if (parent_odp_id !== undefined) {
                fields.push('parent_odp_id = ?');
                const parsedParent = (parent_odp_id === '' || parent_odp_id === null) ? null : parseInt(parent_odp_id, 10);
                values.push(Number.isInteger(parsedParent) ? parsedParent : null);
            }
            
            // Tambahkan updated_at
            fields.push("updated_at = datetime('now','localtime')");
            
            if (fields.length > 1) { // Lebih dari 1 karena sudah ada updated_at
                // Update existing ODP
                await new Promise((resolve, reject) => {
                    const query = `UPDATE odps SET ${fields.join(', ')} WHERE id = ?`;
                    values.push(id);
                    
                    db.run(query, values, function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            console.log(`✅ Updated ODP: ${id}`);
                            resolve();
                        }
                    });
                });
            }

            // Sinkronkan koneksi antar ODP untuk visual backbone di mapping view.
            if (parent_odp_id !== undefined) {
                const childOdpId = parseInt(id, 10);
                const parsedParent = (parent_odp_id === '' || parent_odp_id === null) ? null : parseInt(parent_odp_id, 10);
                const validParentId = Number.isInteger(parsedParent) && parsedParent > 0 && parsedParent !== childOdpId
                    ? parsedParent
                    : null;

                if (validParentId) {
                    const existingBackbone = await new Promise((resolve, reject) => {
                        db.get(
                            'SELECT id FROM odp_connections WHERE to_odp_id = ? ORDER BY id ASC LIMIT 1',
                            [childOdpId],
                            (err, row) => (err ? reject(err) : resolve(row || null))
                        );
                    });

                    if (existingBackbone) {
                        await new Promise((resolve, reject) => {
                            db.run(
                                `UPDATE odp_connections
                                 SET from_odp_id = ?, to_odp_id = ?, status = COALESCE(status, 'active'),
                                     connection_type = COALESCE(connection_type, 'fiber'),
                                     updated_at = datetime('now','localtime')
                                 WHERE id = ?`,
                                [validParentId, childOdpId, existingBackbone.id],
                                (err) => (err ? reject(err) : resolve())
                            );
                        });
                    } else {
                        await new Promise((resolve, reject) => {
                            db.run(
                                `INSERT INTO odp_connections (from_odp_id, to_odp_id, connection_type, status, notes)
                                 VALUES (?, ?, ?, ?, ?)`,
                                [validParentId, childOdpId, 'fiber', 'active', 'Auto-created from mapping ODP parent'],
                                (err) => (err ? reject(err) : resolve())
                            );
                        });
                    }
                }
            }
        } else {
            if (!name || capacity === undefined || capacity === null || capacity === '') {
                db.close();
                return res.status(400).json({
                    success: false,
                    message: 'Field wajib untuk ODP baru: name, capacity'
                });
            }

            const finalCode = (code && String(code).trim())
                || String(name).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
                || `ODP-${Date.now()}`;

            savedCode = finalCode;

            savedOdpId = await new Promise((resolve, reject) => {
                db.run(`
                    INSERT INTO odps (
                        name, code, capacity, used_ports, status,
                        address, latitude, longitude, installation_date,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
                `, [
                    name,
                    finalCode,
                    parseInt(capacity, 10) || 8,
                    parseInt(used_ports, 10) || 0,
                    status || 'active',
                    address || '',
                    latitude != null ? parseFloat(latitude) : 0,
                    longitude != null ? parseFloat(longitude) : 0,
                    installation_date || new Date().toISOString().split('T')[0]
                ], function onInsert(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                });
            });

            console.log(`✅ Created new ODP: ${savedOdpId}`);
        }
        
        db.close();
        
        console.log('✅ ODP saved successfully in database');
        
        // Invalidate cache after successful save
        try {
            const cacheManager = require('../config/cacheManager');
            cacheManager.invalidatePattern('genieacs:*');
            invalidateMappingCache();
        } catch (cacheError) {
            console.warn('⚠️ Failed to invalidate cache:', cacheError.message);
        }
        
        res.json({
            success: true,
            message: isNewOdp ? 'ODP berhasil ditambahkan' : 'ODP updated successfully',
            data: {
                id: savedOdpId,
                name: name,
                code: savedCode,
                capacity: capacity,
                used_ports: used_ports,
                status: status || 'active',
                address: address,
                latitude: latitude,
                longitude: longitude,
                installation_date: installation_date,
                parent_odp_id: parent_odp_id ?? null
            }
        });
        
    } catch (error) {
        console.error('❌ Error updating ODP:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating ODP: ' + error.message
        });
    }
});

// API endpoint untuk update Customer
router.post('/update-customer', adminAuth, async (req, res) => {
    try {
        console.log('🔄 Update Customer API - Processing request...');
        console.log('📋 Request data:', req.body);
        
        // Endpoint ini KHUSUS untuk halaman mapping:
        // hanya boleh mengubah data lokasi + mapping ODP.
        const { id, address, latitude, longitude, odp_id } = req.body;
        
        // Validate required fields
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: id'
            });
        }
        
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        // Check if Customer exists in database
        const existingCustomer = await new Promise((resolve, reject) => {
            db.get(`
                SELECT id FROM customers WHERE id = ?
            `, [id], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
        
        if (existingCustomer) {
            // Update existing Customer
            await new Promise((resolve, reject) => {
                db.run(`
                    UPDATE customers SET 
                        address = ?, 
                        latitude = ?, 
                        longitude = ?, 
                        odp_id = ?
                    WHERE id = ?
                `, [address ?? null, latitude ?? null, longitude ?? null, odp_id ?? null, id], function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        console.log(`✅ Updated Customer: ${id}`);
                        resolve();
                    }
                });
            });

            // Sinkronisasi cable route agar konsisten dengan menu Cable Route:
            // jika ODP dipilih/diganti dari mapping view, route pelanggan harus ikut terbuat/terupdate.
            const normalizedOdpId = (odp_id === '' || odp_id === null || odp_id === undefined)
                ? null
                : parseInt(odp_id, 10);

            if (Number.isInteger(normalizedOdpId) && normalizedOdpId > 0) {
                const existingRoute = await new Promise((resolve, reject) => {
                    db.get(
                        'SELECT * FROM cable_routes WHERE customer_id = ? LIMIT 1',
                        [id],
                        (err, row) => (err ? reject(err) : resolve(row || null))
                    );
                });

                if (existingRoute) {
                    await new Promise((resolve, reject) => {
                        db.run(
                            `UPDATE cable_routes
                             SET odp_id = ?, updated_at = datetime('now','localtime')
                             WHERE customer_id = ?`,
                            [normalizedOdpId, id],
                            (err) => (err ? reject(err) : resolve())
                        );
                    });
                    console.log(`✅ Cable route updated for customer ${id} -> ODP ${normalizedOdpId}`);
                } else {
                    await new Promise((resolve, reject) => {
                        db.run(
                            `INSERT INTO cable_routes (customer_id, odp_id, cable_type, cable_length, port_number, status, notes)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            [
                                id,
                                normalizedOdpId,
                                'Fiber Optic',
                                0,
                                1,
                                'connected',
                                'Auto-created from mapping view'
                            ],
                            (err) => (err ? reject(err) : resolve())
                        );
                    });
                    console.log(`✅ Cable route created for customer ${id} -> ODP ${normalizedOdpId}`);
                }
            }
        } else {
            // Dari mapping page TIDAK BOLEH membuat customer baru.
            db.close();
            return res.status(404).json({
                success: false,
                message: `Customer with id ${id} not found`
            });
        }
        
        db.close();
        
        console.log('✅ Customer updated successfully in database');
        
        // Invalidate GenieACS cache after successful update
        try {
            const cacheManager = require('../config/cacheManager');
            cacheManager.invalidatePattern('genieacs:*');
            invalidateMappingCache();
            console.log('🔄 GenieACS cache invalidated after Customer update');
        } catch (cacheError) {
            console.warn('⚠️ Failed to invalidate cache:', cacheError.message);
        }
        
        res.json({
            success: true,
            message: 'Customer mapping updated successfully',
            data: {
                id: id,
                address: address ?? null,
                latitude: latitude ?? null,
                longitude: longitude ?? null,
                odp_id: odp_id ?? null
            }
        });
        
    } catch (error) {
        console.error('❌ Error updating Customer:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating Customer: ' + error.message
        });
    }
});

// API endpoint untuk restart ONU device via GenieACS
router.post('/restart-onu', adminAuth, async (req, res) => {
    try {
        console.log('🔄 Restart ONU API - Processing request...');
        console.log('📋 Request data:', req.body);
        
        const { deviceId, deviceName, serialNumber, customerName } = req.body;
        
        // Validate required fields
        if (!deviceId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: deviceId'
            });
        }
        
        // Import GenieACS configuration
        const { getGenieACSConfig } = require('../config/genieacs');
        const genieacsConfig = getGenieACSConfig();
        
        if (!genieacsConfig || !genieacsConfig.url || !genieacsConfig.username || !genieacsConfig.password) {
            return res.status(500).json({
                success: false,
                message: 'GenieACS configuration not found or incomplete'
            });
        }
        
        console.log(`🔄 Restarting ONU device: ${deviceId} (${deviceName})`);
        console.log(`👤 Customer: ${customerName}`);
        console.log(`📱 Serial: ${serialNumber}`);
        
        // Call GenieACS API to restart device
        const genieacsUrl = `${genieacsConfig.url}/devices/${encodeURIComponent(deviceId)}/tasks`;
        const auth = Buffer.from(`${genieacsConfig.username}:${genieacsConfig.password}`).toString('base64');
        
        const restartTask = {
            name: 'reboot',
            objectName: 'Device.Reboot',
            object: 'Device.Reboot',
            parameters: {
                'CommandKey': 'Reboot'
            }
        };
        
        console.log(`🌐 Calling GenieACS API: ${genieacsUrl}`);
        console.log(`📋 Restart task:`, restartTask);
        
        const response = await fetch(genieacsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${auth}`
            },
            body: JSON.stringify(restartTask)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ GenieACS API error:', response.status, errorText);
            return res.status(500).json({
                success: false,
                message: `GenieACS API error: ${response.status} - ${errorText}`
            });
        }
        
        const result = await response.json();
        console.log('✅ GenieACS restart task created:', result);
        
        // Log the restart action to database (optional)
        try {
            const dbPath = path.join(__dirname, '../data/billing.db');
            const db = new sqlite3.Database(dbPath);
            
            await new Promise((resolve, reject) => {
                db.run(`
                    INSERT INTO device_actions (
                        device_id, device_name, serial_number, customer_name, 
                        action_type, action_status, action_details, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
                `, [
                    deviceId, 
                    deviceName || 'Unknown', 
                    serialNumber || 'Unknown', 
                    customerName || 'Unknown',
                    'restart',
                    'initiated',
                    JSON.stringify({
                        genieacs_task_id: result._id,
                        restart_time: new Date().toISOString(),
                        api_response: result
                    })
                ], function(err) {
                    if (err) {
                        console.error('❌ Error logging restart action:', err);
                        // Don't fail the request if logging fails
                    } else {
                        console.log(`✅ Logged restart action for device: ${deviceId}`);
                    }
                    resolve();
                });
            });
            
            db.close();
        } catch (logError) {
            console.error('❌ Error logging restart action to database:', logError);
            // Don't fail the request if logging fails
        }
        
        console.log('✅ ONU restart initiated successfully');
        
        // Invalidate GenieACS cache after successful restart
        try {
            const cacheManager = require('../config/cacheManager');
            cacheManager.invalidatePattern('genieacs:*');
            invalidateMappingCache();
            console.log('🔄 GenieACS cache invalidated after ONU restart');
        } catch (cacheError) {
            console.warn('⚠️ Failed to invalidate cache:', cacheError.message);
        }
        
        res.json({
            success: true,
            message: 'ONU restart initiated successfully',
            data: {
                deviceId: deviceId,
                deviceName: deviceName,
                serialNumber: serialNumber,
                customerName: customerName,
                genieacsTaskId: result._id,
                restartTime: new Date().toISOString(),
                status: 'initiated'
            }
        });
        
    } catch (error) {
        console.error('❌ Error restarting ONU device:', error);
        res.status(500).json({
            success: false,
            message: 'Error restarting ONU device: ' + error.message
        });
    }
});

module.exports = router;
