/**
 * DEV ONLY — sample ODP/cable (Jakarta demo). Jangan dijadwalkan di production:
 * data yang sudah dihapus bisa terlihat "kembali" jika skrip ini dijalankan ulang.
 * Migrasi schema: node scripts/setup-mapping-database.js (tanpa --seed)
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

console.log('🔧 Adding sample ODP and Cable data...\n');

// Path ke database
const dbPath = path.join(__dirname, '../data/billing.db');

// Pastikan database ada
if (!fs.existsSync(dbPath)) {
    console.error('❌ Database not found at:', dbPath);
    process.exit(1);
}

// Koneksi ke database
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Error connecting to database:', err);
        process.exit(1);
    } else {
        console.log('✅ Connected to billing database');
    }
});

// Sample data ODP
const sampleODPs = [
    {
        name: 'ODP-Central-01',
        code: 'ODP-C01',
        latitude: -6.2088,
        longitude: 106.8456,
        address: 'Jl. Sudirman No. 1, Jakarta Pusat',
        capacity: 64,
        used_ports: 0,
        status: 'active'
    },
    {
        name: 'ODP-Branch-01',
        code: 'ODP-B01',
        latitude: -6.2200,
        longitude: 106.8500,
        address: 'Jl. Thamrin No. 10, Jakarta Pusat',
        capacity: 32,
        used_ports: 0,
        status: 'active'
    },
    {
        name: 'ODP-Residential-01',
        code: 'ODP-R01',
        latitude: -6.2000,
        longitude: 106.8400,
        address: 'Jl. Kebon Jeruk No. 5, Jakarta Barat',
        capacity: 16,
        used_ports: 0,
        status: 'active'
    },
    {
        name: 'ODP-Industrial-01',
        code: 'ODP-I01',
        latitude: -6.1900,
        longitude: 106.8300,
        address: 'Jl. Gatot Subroto No. 15, Jakarta Selatan',
        capacity: 48,
        used_ports: 0,
        status: 'active'
    },
    {
        name: 'ODP-Commercial-01',
        code: 'ODP-COM01',
        latitude: -6.1800,
        longitude: 106.8200,
        address: 'Jl. HR Rasuna Said No. 20, Jakarta Selatan',
        capacity: 32,
        used_ports: 0,
        status: 'active'
    }
];

// Sample data Cable Routes (akan ditambahkan setelah ODP dan customers tersedia)
const sampleCableRoutes = [
    {
        customer_id: 1, // Akan di-set berdasarkan customer yang ada
        odp_id: 1, // Akan di-set berdasarkan ODP yang dibuat
        cable_length: 150.5,
        cable_type: 'Fiber Optic',
        status: 'connected',
        port_number: 1
    },
    {
        customer_id: 2,
        odp_id: 2,
        cable_length: 200.0,
        cable_type: 'Fiber Optic',
        status: 'connected',
        port_number: 2
    },
    {
        customer_id: 3,
        odp_id: 3,
        cable_length: 300.0,
        cable_type: 'Fiber Optic',
        status: 'connected',
        port_number: 1
    }
];

// Sample data Backbone Cables (antar ODP)
const sampleBackboneCables = [
    {
        name: 'Backbone-Central-Branch',
        start_odp_id: 1, // ODP-Central-01
        end_odp_id: 2,   // ODP-Branch-01
        cable_length: 500.0,
        cable_type: 'Fiber Optic',
        status: 'connected'
    },
    {
        name: 'Backbone-Branch-Residential',
        start_odp_id: 2, // ODP-Branch-01
        end_odp_id: 3,   // ODP-Residential-01
        cable_length: 300.0,
        cable_type: 'Fiber Optic',
        status: 'connected'
    },
    {
        name: 'Backbone-Central-Industrial',
        start_odp_id: 1, // ODP-Central-01
        end_odp_id: 4,   // ODP-Industrial-01
        cable_length: 800.0,
        cable_type: 'Fiber Optic',
        status: 'connected'
    },
    {
        name: 'Backbone-Industrial-Commercial',
        start_odp_id: 4, // ODP-Industrial-01
        end_odp_id: 5,   // ODP-Commercial-01
        cable_length: 400.0,
        cable_type: 'Fiber Optic',
        status: 'connected'
    }
];

async function checkAndAddSampleData() {
    try {
        // Cek apakah tabel odps sudah ada
        const odpsExist = await new Promise((resolve) => {
            db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='odps'", (err, row) => {
                resolve(!!row);
            });
        });

        if (!odpsExist) {
            console.log('❌ Table odps does not exist. Please run the migration first.');
            return;
        }

        // Cek apakah ada ODP data
        const existingODPs = await new Promise((resolve) => {
            db.all("SELECT COUNT(*) as count FROM odps", (err, rows) => {
                if (err) {
                    console.error('❌ Error checking ODPs:', err);
                    resolve(0);
                } else {
                    resolve(rows[0].count);
                }
            });
        });

        console.log(`📊 Found ${existingODPs} existing ODPs`);

        if (existingODPs === 0) {
            console.log('📝 Adding sample ODP data...');
            
            for (const odp of sampleODPs) {
                await new Promise((resolve, reject) => {
                    db.run(`
                        INSERT INTO odps (name, code, latitude, longitude, address, capacity, used_ports, status, installation_date)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, date('now'))
                    `, [odp.name, odp.code, odp.latitude, odp.longitude, odp.address, odp.capacity, odp.used_ports, odp.status], function(err) {
                        if (err) {
                            console.error(`❌ Error adding ODP ${odp.name}:`, err);
                            reject(err);
                        } else {
                            console.log(`✅ Added ODP: ${odp.name} (ID: ${this.lastID})`);
                            resolve();
                        }
                    });
                });
            }
        } else {
            console.log('✅ ODPs already exist, skipping...');
        }

        // Cek apakah tabel cable_routes sudah ada
        const cablesExist = await new Promise((resolve) => {
            db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='cable_routes'", (err, row) => {
                resolve(!!row);
            });
        });

        if (!cablesExist) {
            console.log('❌ Table cable_routes does not exist. Please run the migration first.');
            return;
        }

        // Cek apakah ada cable routes data
        const existingCables = await new Promise((resolve) => {
            db.all("SELECT COUNT(*) as count FROM cable_routes", (err, rows) => {
                if (err) {
                    console.error('❌ Error checking cables:', err);
                    resolve(0);
                } else {
                    resolve(rows[0].count);
                }
            });
        });

        console.log(`📊 Found ${existingCables} existing cable routes`);

        if (existingCables === 0) {
            // Cek apakah ada customers dengan koordinat
            const customersWithCoords = await new Promise((resolve) => {
                db.all("SELECT id, name FROM customers WHERE latitude IS NOT NULL AND longitude IS NOT NULL LIMIT 5", (err, rows) => {
                    if (err) {
                        console.error('❌ Error checking customers:', err);
                        resolve([]);
                    } else {
                        resolve(rows || []);
                    }
                });
            });

            console.log(`📊 Found ${customersWithCoords.length} customers with coordinates`);

            if (customersWithCoords.length > 0) {
                console.log('📝 Adding sample cable route data...');
                
                for (let i = 0; i < Math.min(sampleCableRoutes.length, customersWithCoords.length); i++) {
                    const cable = sampleCableRoutes[i];
                    const customer = customersWithCoords[i];
                    const odpId = i + 1; // ODP ID dimulai dari 1

                    await new Promise((resolve, reject) => {
                        db.run(`
                            INSERT INTO cable_routes (customer_id, odp_id, cable_length, cable_type, status, port_number, installation_date)
                            VALUES (?, ?, ?, ?, ?, ?, date('now'))
                        `, [customer.id, odpId, cable.cable_length, cable.cable_type, cable.status, cable.port_number], function(err) {
                            if (err) {
                                console.error(`❌ Error adding cable route for customer ${customer.name}:`, err);
                                reject(err);
                            } else {
                                console.log(`✅ Added cable route: Customer ${customer.name} -> ODP ${odpId} (ID: ${this.lastID})`);
                                resolve();
                            }
                        });
                    });
                }
            } else {
                console.log('⚠️ No customers with coordinates found. Cable routes need customers with latitude/longitude.');
            }
        } else {
            console.log('✅ Cable routes already exist, skipping...');
        }

        // Cek apakah tabel network_segments sudah ada
        const networkSegmentsExist = await new Promise((resolve) => {
            db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='network_segments'", (err, row) => {
                resolve(!!row);
            });
        });

        if (!networkSegmentsExist) {
            console.log('❌ Table network_segments does not exist. Please run the migration first.');
            return;
        }

        // Cek apakah ada network segments data
        const existingNetworkSegments = await new Promise((resolve) => {
            db.all("SELECT COUNT(*) as count FROM network_segments", (err, rows) => {
                if (err) {
                    console.error('❌ Error checking network segments:', err);
                    resolve(0);
                } else {
                    resolve(rows[0].count);
                }
            });
        });

        console.log(`📊 Found ${existingNetworkSegments} existing network segments`);

        if (existingNetworkSegments === 0) {
            console.log('📝 Adding sample network segment data...');
            
            for (const backboneCable of sampleBackboneCables) {
                await new Promise((resolve, reject) => {
                    db.run(`
                        INSERT INTO network_segments (name, start_odp_id, end_odp_id, cable_length, segment_type, status, installation_date)
                        VALUES (?, ?, ?, ?, ?, ?, date('now'))
                    `, [backboneCable.name, backboneCable.start_odp_id, backboneCable.end_odp_id, 
                         backboneCable.cable_length, 'Backbone', backboneCable.status], function(err) {
                        if (err) {
                            console.error(`❌ Error adding network segment ${backboneCable.name}:`, err);
                            reject(err);
                        } else {
                            console.log(`✅ Added network segment: ${backboneCable.name} (ID: ${this.lastID})`);
                            resolve();
                        }
                    });
                });
            }
        } else {
            console.log('✅ Network segments already exist, skipping...');
        }

        console.log('\n🎉 Sample data addition completed!');
        
        // Show summary
        const finalODPs = await new Promise((resolve) => {
            db.all("SELECT COUNT(*) as count FROM odps", (err, rows) => {
                resolve(rows[0].count);
            });
        });

        const finalCables = await new Promise((resolve) => {
            db.all("SELECT COUNT(*) as count FROM cable_routes", (err, rows) => {
                resolve(rows[0].count);
            });
        });

        const finalNetworkSegments = await new Promise((resolve) => {
            db.all("SELECT COUNT(*) as count FROM network_segments", (err, rows) => {
                resolve(rows[0].count);
            });
        });

        console.log(`📊 Final summary:`);
        console.log(`   - ODPs: ${finalODPs}`);
        console.log(`   - Cable Routes: ${finalCables}`);
        console.log(`   - Network Segments: ${finalNetworkSegments}`);

    } catch (error) {
        console.error('❌ Error in checkAndAddSampleData:', error);
    } finally {
        db.close();
    }
}

// Jalankan script
checkAndAddSampleData();
