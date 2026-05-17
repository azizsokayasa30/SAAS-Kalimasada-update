const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Path ke database billing
const dbPath = path.join(__dirname, '../data/billing.db');

console.log('🔧 Setting up mapping database...');

async function setupMappingDatabase() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('❌ Error opening database:', err);
                reject(err);
                return;
            }
            console.log('✅ Connected to database');
        });

        // Read migration file
        const migrationPath = path.join(__dirname, '../migrations/create_odp_cable_network.sql');
        
        if (!fs.existsSync(migrationPath)) {
            console.error('❌ Migration file not found:', migrationPath);
            reject(new Error('Migration file not found'));
            return;
        }

        const migrationSQL = fs.readFileSync(migrationPath, 'utf-8');
        
        // Execute migration
        db.exec(migrationSQL, (err) => {
            if (err) {
                console.error('❌ Error executing migration:', err);
                reject(err);
                return;
            }
            
            console.log('✅ Migration executed successfully');
            
            // Check if tables exist
            db.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('odps', 'cable_routes', 'network_segments', 'odp_connections')", (err, rows) => {
                if (err) {
                    console.error('❌ Error checking tables:', err);
                    reject(err);
                    return;
                }
                
                console.log('📊 Created tables:', rows.map(r => r.name).join(', '));

                const seedDemo = process.argv.includes('--seed');
                const afterSetup = () => {
                    db.close((err) => {
                        if (err) {
                            console.error('❌ Error closing database:', err);
                            reject(err);
                        } else {
                            console.log('✅ Database setup completed successfully');
                            if (!seedDemo) {
                                console.log('ℹ️  Tanpa data demo. Untuk sample ODP: node scripts/setup-mapping-database.js --seed');
                            }
                            resolve();
                        }
                    });
                };

                if (seedDemo) {
                    insertSampleData(db).then(afterSetup).catch(reject);
                } else {
                    afterSetup();
                }
            });
        });
    });
}

async function insertSampleData(db) {
    return new Promise((resolve, reject) => {
        console.log('📝 Inserting sample data...');
        
        // Check if ODPs table has data
        db.get("SELECT COUNT(*) as count FROM odps", (err, row) => {
            if (err) {
                console.error('❌ Error checking ODPs:', err);
                reject(err);
                return;
            }
            
            if (row.count === 0) {
                console.log('📊 No ODPs found, inserting sample data...');
                
                // Insert sample ODPs
                const sampleODPs = [
                    {
                        name: 'ODP-Central-01',
                        code: 'ODP-C01',
                        latitude: -6.2088,
                        longitude: 106.8456,
                        address: 'Jl. Sudirman No. 1, Jakarta Pusat',
                        capacity: 64,
                        status: 'active'
                    },
                    {
                        name: 'ODP-Branch-01',
                        code: 'ODP-B01',
                        latitude: -6.2200,
                        longitude: 106.8500,
                        address: 'Jl. Thamrin No. 10, Jakarta Pusat',
                        capacity: 32,
                        status: 'active'
                    },
                    {
                        name: 'ODP-Residential-01',
                        code: 'ODP-R01',
                        latitude: -6.2000,
                        longitude: 106.8400,
                        address: 'Jl. Kebon Jeruk No. 5, Jakarta Barat',
                        capacity: 16,
                        status: 'active'
                    }
                ];
                
                let inserted = 0;
                sampleODPs.forEach((odp, index) => {
                    db.run(
                        `INSERT INTO odps (name, code, latitude, longitude, address, capacity, status, installation_date) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [odp.name, odp.code, odp.latitude, odp.longitude, odp.address, odp.capacity, odp.status, new Date().toISOString().split('T')[0]],
                        function(err) {
                            if (err) {
                                console.error(`❌ Error inserting ODP ${odp.name}:`, err);
                            } else {
                                console.log(`✅ Inserted ODP: ${odp.name}`);
                                inserted++;
                                
                                if (inserted === sampleODPs.length) {
                                    // Insert sample network segments
                                    insertSampleNetworkSegments(db).then(resolve).catch(reject);
                                }
                            }
                        }
                    );
                });
            } else {
                console.log(`✅ Found ${row.count} existing ODPs`);
                resolve();
            }
        });
    });
}

async function insertSampleNetworkSegments(db) {
    return new Promise((resolve, reject) => {
        console.log('📊 Inserting sample network segments...');
        
        // Get ODP IDs for connections
        db.all("SELECT id, name FROM odps ORDER BY name", (err, odps) => {
            if (err) {
                console.error('❌ Error getting ODPs:', err);
                reject(err);
                return;
            }
            
            if (odps.length >= 2) {
                // Create connections between ODPs
                const connections = [
                    {
                        name: 'Backbone-Central-Branch',
                        start_odp_id: odps[0].id,
                        end_odp_id: odps[1].id,
                        segment_type: 'Backbone',
                        cable_length: 500.00,
                        status: 'active'
                    },
                    {
                        name: 'Distribution-Branch-Residential',
                        start_odp_id: odps[1].id,
                        end_odp_id: odps[2] ? odps[2].id : null,
                        segment_type: 'Distribution',
                        cable_length: 300.00,
                        status: 'active'
                    }
                ];
                
                let inserted = 0;
                connections.forEach((segment, index) => {
                    if (segment.end_odp_id) {
                        db.run(
                            `INSERT INTO network_segments (name, start_odp_id, end_odp_id, segment_type, cable_length, status, installation_date) 
                             VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            [segment.name, segment.start_odp_id, segment.end_odp_id, segment.segment_type, segment.cable_length, segment.status, new Date().toISOString().split('T')[0]],
                            function(err) {
                                if (err) {
                                    console.error(`❌ Error inserting network segment ${segment.name}:`, err);
                                } else {
                                    console.log(`✅ Inserted network segment: ${segment.name}`);
                                }
                                inserted++;
                                
                                if (inserted === connections.filter(c => c.end_odp_id).length) {
                                    resolve();
                                }
                            }
                        );
                    } else {
                        inserted++;
                        if (inserted === connections.filter(c => c.end_odp_id).length) {
                            resolve();
                        }
                    }
                });
            } else {
                console.log('⚠️ Not enough ODPs to create network segments');
                resolve();
            }
        });
    });
}

// Run setup
if (require.main === module) {
    setupMappingDatabase()
        .then(() => {
            console.log('🎉 Mapping database setup completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Setup failed:', error);
            process.exit(1);
        });
}

module.exports = { setupMappingDatabase };
