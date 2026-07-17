#!/usr/bin/env node

/**
 * Script untuk initialize database setelah clone dari GitHub
 * 1. Membuat tabel dasar melalui BillingManager.createTables()
 * 2. Menjalankan semua migration SQL files untuk update schema
 */

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../data/billing.db');
const migrationsPath = path.join(__dirname, '../migrations');

// Ensure data directory exists
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

console.log('📦 Initializing CVLMEDIA database...');
console.log(`Database path: ${dbPath}`);

// Open database
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Error opening database:', err);
        process.exit(1);
    }
    console.log('✅ Database connected');
});

// Enable foreign keys
db.run('PRAGMA foreign_keys = ON', (err) => {
    if (err) {
        console.error('⚠️  Warning: Could not enable foreign keys:', err);
    }
});

// Import BillingManager untuk create tabel dasar
// Note: billing.js exports instance, not class, so we'll create tables directly via SQL

// Run SQL file (ignore "no such table" errors for ALTER/CREATE INDEX - normal for migrations)
function runSQLFile(filePath) {
    return new Promise((resolve, reject) => {
        console.log(`  📄 Running: ${path.basename(filePath)}`);
        
        const sql = fs.readFileSync(filePath, 'utf-8');
        
        // Robust SQL splitting: handles semicolons inside single quotes and handles triggers
        const statements = [];
        let currentStatement = '';
        let inQuotes = false;
        let inTrigger = false;
        
        for (let i = 0; i < sql.length; i++) {
            const char = sql[i];
            const nextChar = sql[i + 1];
            
            // Handle single quotes (sql escape '' handled by skipping next quote)
            if (char === "'" && (i === 0 || sql[i - 1] !== "\\")) {
                if (nextChar === "'") {
                    currentStatement += "''";
                    i++; 
                    continue;
                }
                inQuotes = !inQuotes;
            }
            
            currentStatement += char;
            
            if (!inQuotes) {
                const upperSoFar = currentStatement.toUpperCase();
                if (upperSoFar.includes('CREATE TRIGGER') && !inTrigger) {
                    inTrigger = true;
                }
                
                if (inTrigger && upperSoFar.endsWith('END;')) {
                    inTrigger = false;
                    statements.push(currentStatement.trim());
                    currentStatement = '';
                    continue;
                }
                
                if (!inTrigger && char === ';') {
                    statements.push(currentStatement.trim());
                    currentStatement = '';
                }
            }
        }
        if (currentStatement.trim()) statements.push(currentStatement.trim());

        // Execute statements one by one for better control and error reporting
        const executeNext = async (index) => {
            if (index >= statements.length) {
                resolve();
                return;
            }

            const statement = statements[index];
            if (!statement) {
                executeNext(index + 1);
                return;
            }

            db.run(statement, (err) => {
                if (err) {
                    const ignorableErrors = [
                        'already exists',
                        'duplicate column',
                        'no such table',
                        'cannot commit - no transaction is active'
                    ];
                    
                    const isIgnorable = ignorableErrors.some(msg => err.message.includes(msg));
                    
                    if (isIgnorable) {
                        executeNext(index + 1);
                    } else {
                        console.error(`    ❌ Error in ${path.basename(filePath)} (Statement ${index + 1}): ${err.message}`);
                        // Log a snippet of the problematic statement for debugging
                        console.error(`    Statement: ${statement.substring(0, 50)}...`);
                        reject(err);
                    }
                } else {
                    executeNext(index + 1);
                }
            });
        };

        executeNext(0);
    });
}

// Get all migration files
function getMigrationFiles() {
    if (!fs.existsSync(migrationsPath)) {
        console.warn('⚠️  Migrations directory not found:', migrationsPath);
        return [];
    }
    
    const files = fs.readdirSync(migrationsPath)
        .filter(file => file.endsWith('.sql'))
        .map(file => path.join(migrationsPath, file))
        .sort(); // Run in alphabetical order
    
    return files;
}

// Create base tables directly via SQL (from billing.js createTables)
function createBaseTables() {
    return new Promise((resolve, reject) => {
        console.log('\n📋 Step 1: Creating base tables...');
        
        const baseTables = [
            `CREATE TABLE IF NOT EXISTS packages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                speed TEXT NOT NULL,
                price DECIMAL(10,2) NOT NULL,
                tax_rate DECIMAL(5,2) DEFAULT 11.00,
                description TEXT,
                pppoe_profile TEXT DEFAULT 'default',
                router_id INTEGER,
                is_active BOOLEAN DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                image TEXT,
                FOREIGN KEY (router_id) REFERENCES routers(id)
            )`,
            `CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                phone TEXT UNIQUE NOT NULL,
                pppoe_username TEXT,
                email TEXT,
                address TEXT,
                latitude DECIMAL(10,8),
                longitude DECIMAL(11,8),
                package_id INTEGER,
                pppoe_profile TEXT,
                status TEXT DEFAULT 'active',
                join_date DATETIME DEFAULT CURRENT_TIMESTAMP,
                cable_type TEXT,
                cable_length INTEGER,
                port_number INTEGER,
                cable_status TEXT DEFAULT 'connected',
                cable_notes TEXT,
                odp_id INTEGER,
                auto_suspension BOOLEAN DEFAULT 1,
                billing_day INTEGER DEFAULT 15,
                renewal_type TEXT DEFAULT 'renewal',
                fix_date INTEGER,
                FOREIGN KEY (package_id) REFERENCES packages (id)
            )`,
            `CREATE TABLE IF NOT EXISTS routers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                nas_ip TEXT NOT NULL,
                nas_identifier TEXT,
                secret TEXT,
                UNIQUE(nas_ip)
            )`,
            `CREATE TABLE IF NOT EXISTS customer_router_map (
                customer_id INTEGER NOT NULL,
                router_id INTEGER NOT NULL,
                PRIMARY KEY (customer_id),
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
                FOREIGN KEY (router_id) REFERENCES routers(id) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS invoices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL,
                package_id INTEGER NOT NULL,
                invoice_number TEXT UNIQUE NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                due_date DATE NOT NULL,
                status TEXT DEFAULT 'unpaid',
                payment_date DATETIME,
                payment_method TEXT,
                payment_gateway TEXT,
                payment_token TEXT,
                payment_url TEXT,
                payment_status TEXT DEFAULT 'pending',
                notes TEXT,
                description TEXT,
                invoice_type TEXT DEFAULT 'monthly',
                package_name TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES customers (id),
                FOREIGN KEY (package_id) REFERENCES packages (id)
            )`,
            `CREATE TABLE IF NOT EXISTS payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_id INTEGER NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
                payment_method TEXT NOT NULL,
                reference_number TEXT,
                notes TEXT,
                collector_id INTEGER,
                commission_amount DECIMAL(15,2) DEFAULT 0,
                payment_type TEXT DEFAULT 'direct' CHECK(payment_type IN ('direct', 'collector', 'online', 'manual')),
                remittance_status TEXT CHECK(remittance_status IN ('pending', 'remitted', 'cancelled')),
                remittance_date DATETIME,
                remittance_notes TEXT,
                payment_proof TEXT,
                FOREIGN KEY (invoice_id) REFERENCES invoices (id)
            )`,
            `CREATE TABLE IF NOT EXISTS payment_gateway_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_id INTEGER NOT NULL,
                gateway TEXT NOT NULL,
                order_id TEXT NOT NULL,
                payment_url TEXT,
                token TEXT,
                amount DECIMAL(10,2) NOT NULL,
                status TEXT DEFAULT 'pending',
                payment_type TEXT,
                fraud_status TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (invoice_id) REFERENCES invoices (id)
            )`,
            `CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                description TEXT NOT NULL,
                amount REAL NOT NULL,
                category TEXT NOT NULL,
                expense_date DATE NOT NULL,
                payment_method TEXT,
                notes TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS odps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR(100) NOT NULL UNIQUE,
                code VARCHAR(50) NOT NULL UNIQUE,
                latitude DECIMAL(10,8) NOT NULL,
                longitude DECIMAL(11,8) NOT NULL,
                address TEXT,
                capacity INTEGER DEFAULT 64,
                used_ports INTEGER DEFAULT 0,
                status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'inactive')),
                installation_date DATE,
                notes TEXT,
                parent_odp_id INTEGER,
                is_pole BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS technicians (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT UNIQUE NOT NULL,
                role TEXT NOT NULL DEFAULT 'technician',
                email TEXT,
                notes TEXT,
                password TEXT,
                is_active INTEGER DEFAULT 1 CHECK (is_active IN (0, 1)),
                area_coverage TEXT,
                whatsapp_group TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME
            )`,
            `CREATE TABLE IF NOT EXISTS collector_payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collector_id INTEGER NOT NULL,
                invoice_id INTEGER NOT NULL,
                amount DECIMAL(15,2) NOT NULL,
                payment_amount DECIMAL(15,2) NOT NULL,
                commission_amount DECIMAL(15,2) NOT NULL,
                payment_method TEXT DEFAULT 'cash',
                payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
                collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                notes TEXT,
                status TEXT DEFAULT 'completed',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                paid_at DATETIME,
                FOREIGN KEY (collector_id) REFERENCES collectors(id),
                FOREIGN KEY (invoice_id) REFERENCES invoices(id)
            )`,
            `CREATE TABLE IF NOT EXISTS collector_areas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collector_id INTEGER NOT NULL,
                area TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (collector_id) REFERENCES collectors(id) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS voucher_revenue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                price DECIMAL(10,2) NOT NULL DEFAULT 0,
                profile TEXT,
                status TEXT DEFAULT 'unpaid' CHECK(status IN ('unpaid', 'paid')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                used_at DATETIME,
                usage_count INTEGER DEFAULT 0,
                notes TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS app_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT UNIQUE NOT NULL,
                value TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        ];
        
        let completed = 0;
        let errors = [];
        
        baseTables.forEach((sql) => {
            db.run(sql, (err) => {
                if (err) {
                    // Ignore "already exists" errors
                    if (!err.message.includes('already exists')) {
                        console.warn(`    ⚠️  Warning: ${err.message}`);
                        errors.push(err);
                    }
                }
                completed++;
                if (completed === baseTables.length) {
                    if (errors.length === 0 || errors.every(e => e.message.includes('already exists'))) {
                        console.log('✅ Base tables created');
                        resolve();
                    } else {
                        console.warn(`⚠️  Some warnings occurred, but continuing...`);
                        resolve();
                    }
                }
            });
        });
    });
}

// Main function
async function initDatabase() {
    try {
        // Step 1: Create base tables first
        await createBaseTables();
        
        // Step 1.5: Fix existing payments table columns
        console.log('\n📋 Step 1.5: Patching existing tables...');
        await new Promise((resolve) => {
            const alterQueries = [
                'ALTER TABLE payments ADD COLUMN collector_id INTEGER',
                'ALTER TABLE payments ADD COLUMN commission_amount DECIMAL(15,2) DEFAULT 0',
                "ALTER TABLE payments ADD COLUMN payment_type TEXT DEFAULT 'direct' CHECK(payment_type IN ('direct', 'collector', 'online', 'manual'))",
                "ALTER TABLE payments ADD COLUMN remittance_status TEXT CHECK(remittance_status IN ('pending', 'remitted', 'cancelled'))",
                'ALTER TABLE payments ADD COLUMN remittance_date DATETIME',
                'ALTER TABLE payments ADD COLUMN remittance_notes TEXT',
                'ALTER TABLE payments ADD COLUMN payment_proof TEXT',
                'ALTER TABLE collector_payments ADD COLUMN collected_at DATETIME DEFAULT CURRENT_TIMESTAMP',
                'ALTER TABLE collector_payments ADD COLUMN amount DECIMAL(15,2)'
            ];
            
            let count = 0;
            alterQueries.forEach(q => {
                db.run(q, (err) => {
                    count++;
                    if (count === alterQueries.length) resolve();
                });
            });
        });
        
        // Step 2: Run migrations
        console.log('\n📋 Step 2: Running migrations...');
        
        const migrationFiles = getMigrationFiles();
        
        if (migrationFiles.length === 0) {
            console.warn('⚠️  No migration files found');
        } else {
            console.log(`Found ${migrationFiles.length} migration file(s)`);
            
            let successCount = 0;
            let errorCount = 0;
            
            for (const file of migrationFiles) {
                try {
                    await runSQLFile(file);
                    successCount++;
                } catch (error) {
                    // Check if it's just "no such table" errors (expected)
                    if (error.message.includes('no such table')) {
                        console.log(`    ⚠️  ${path.basename(file)}: Skipped (tables will be created on app start)`);
                        successCount++;
                    } else {
                        console.error(`    ❌ ${path.basename(file)}: ${error.message}`);
                        errorCount++;
                    }
                }
            }
            
            console.log(`\n📊 Migration summary: ${successCount} succeeded, ${errorCount} failed`);
        }
        
        // Verify technicians table exists
        db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='technicians'", (err, row) => {
            if (err) {
                console.warn('⚠️  Could not verify technicians table');
            } else if (!row) {
                console.warn('⚠️  technicians table not found - will be created on app start');
            } else {
                console.log('✅ Verified: technicians table exists');
            }
        });
        
        console.log('\n✅ Database initialization completed!');
        console.log('\n📝 Next steps:');
        console.log('  1. Restart CVLMEDIA: pm2 restart BillCVLmedia');
        console.log('  2. Access web UI and setup RADIUS config via /admin/radius');
        console.log('\n⚠️  Note: Some tables will be created automatically on first app start');
        
        db.close((err) => {
            if (err) {
                console.error('⚠️  Error closing database:', err);
            }
            process.exit(0);
        });
    } catch (error) {
        console.error('❌ Error initializing database:', error);
        db.close();
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    initDatabase();
}

module.exports = { initDatabase };

