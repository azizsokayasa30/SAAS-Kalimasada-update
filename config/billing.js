    const path = require('path');
    const fs = require('fs');
    const sqlite3 = require('sqlite3').verbose();
    const PaymentGatewayManager = require('./paymentGateway');
    const logger = require('./logger'); // Added logger import
    const { syncCustomerToRadius } = require('../utils/radiusCustomerSync');
    const { getCompanyHeader } = require('./message-templates');
    const { getSetting, getLocalTimestamp } = require('./settingsManager');

    /** Diskon dari catatan admin: "… | Diskon: Rp 50.000 | …" (format id-ID) */
    function parseDiscountFromPaymentNotes(notes) {
        if (notes == null || notes === '') return 0;
        const m = String(notes).match(/Diskon:\s*Rp\s*([\d.\s\u00a0]+)/i);
        if (!m) return 0;
        const num = m[1].replace(/\./g, '').replace(/\s/g, '').replace(/,/g, '').trim();
        const n = parseInt(num, 10);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    }

    function effectivePaymentDiscount(row) {
        const col = Number(row.discount_amount);
        if (Number.isFinite(col) && col > 0) return col;
        return parseDiscountFromPaymentNotes(row.notes);
    }

    /** Nilai tagihan dari invoice (bukan bruto kolom payments.amount). */
    function paymentInvoiceTagihan(row) {
        const inv = Number(row.invoice_amount);
        if (Number.isFinite(inv) && inv >= 0) return inv;
        return Number(row.amount) || 0;
    }

    /** Setelah diskon: dasar "Lunas Kolektor" di UI & kartu terima setoran. */
    function paymentJumlahSetelahDiskon(row) {
        const tag = paymentInvoiceTagihan(row);
        const disc = effectivePaymentDiscount(row);
        return Math.max(0, Math.round((tag - disc) * 100) / 100);
    }

    /** Pool setoran ke kasir per baris: jumlah setelah diskon dikurangi komisi kolektor. */
    function paymentRemittancePoolRp(row) {
        const j = paymentJumlahSetelahDiskon(row);
        const c = Number(row.commission_amount) || 0;
        return Math.max(0, Math.round((j - c) * 100) / 100);
    }

    class BillingManager {
        constructor() {
            this.dbPath = path.join(__dirname, '../data/billing.db');
            this.paymentGateway = new PaymentGatewayManager();
            this._paymentsDiscountColumnEnsured = false;
            this._remittanceNetAppliedEnsured = false;
            this._collectorAreaUniqueEnsured = false;
            this.initDatabase();
            
            // Inisialisasi scheduler otomatis hapus foto usang (Umur > 60 Hari)
            this.autoCleanTwoMonthsOldPaymentProofs();
        }

        /** Pastikan kolom payments.discount_amount ada (ALTER bisa race dengan query pertama). */
        async _ensurePaymentsDiscountColumn() {
            if (this._paymentsDiscountColumnEnsured) return;
            await new Promise((resolve) => {
                this.db.run('ALTER TABLE payments ADD COLUMN discount_amount REAL DEFAULT 0', (err) => {
                    if (err && !String(err.message || '').toLowerCase().includes('duplicate')) {
                        try {
                            logger.warn('[billing] payments.discount_amount:', err.message);
                        } catch (_) {}
                    }
                    this._paymentsDiscountColumnEnsured = true;
                    resolve();
                });
            });
        }

        /**
         * Akumulasi net setoran ke kasir per baris payments (tanpa memecah baris untuk setoran parsial).
         * Memperbaiki baris legacy hasil INSERT split "[setoran parsial terima]".
         */
        async _ensureRemittanceNetAppliedColumn() {
            if (this._remittanceNetAppliedEnsured) return;
            await new Promise((resolve) => {
                this.db.run(
                    'ALTER TABLE payments ADD COLUMN remittance_net_applied REAL NOT NULL DEFAULT 0',
                    (err) => {
                        if (err && !String(err.message || '').toLowerCase().includes('duplicate')) {
                            try {
                                logger.warn('[billing] payments.remittance_net_applied:', err.message);
                            } catch (_) {}
                        }
                        resolve();
                    }
                );
            });
            try {
                await this._repairCollectorPartialSplitPaymentRows();
            } catch (e) {
                try {
                    logger.warn('[billing] repair partial split payments:', e.message);
                } catch (_) {}
            }
            await new Promise((resolve) => {
                this.db.run(
                    `UPDATE payments
                     SET remittance_net_applied = ROUND((amount - COALESCE(commission_amount, 0)) * 100) / 100.0
                     WHERE payment_type = 'collector'
                       AND remittance_status = 'remitted'
                       AND ABS(COALESCE(remittance_net_applied, 0)) < 0.00001`,
                    (err) => resolve()
                );
            });
            this._remittanceNetAppliedEnsured = true;
        }

        async _repairCollectorPartialSplitPaymentRows() {
            const dbAll = (sql, params = []) =>
                new Promise((resolve, reject) => {
                    this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
                });
            const dbGet = (sql, params = []) =>
                new Promise((resolve, reject) => {
                    this.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
                });
            const dbRun = (sql, params = []) =>
                new Promise((resolve, reject) => {
                    this.db.run(sql, params, function (err) {
                        if (err) reject(err);
                        else resolve({ changes: this.changes });
                    });
                });
            for (let guard = 0; guard < 200; guard++) {
                const children = await dbAll(
                    `SELECT id, invoice_id, collector_id, amount, commission_amount, notes, remittance_status, remittance_date, remittance_notes
                     FROM payments
                     WHERE payment_type = 'collector'
                       AND COALESCE(notes, '') LIKE '%[setoran parsial terima]%'
                     ORDER BY id ASC
                     LIMIT 80`
                );
                if (!children.length) break;
                for (const ch of children) {
                    const root = await dbGet(
                        `SELECT id, amount, commission_amount, remittance_net_applied, remittance_status, remittance_date, remittance_notes
                         FROM payments
                         WHERE invoice_id = ? AND collector_id = ? AND payment_type = 'collector'
                         ORDER BY id ASC
                         LIMIT 1`,
                        [ch.invoice_id, ch.collector_id]
                    );
                    if (!root || root.id === ch.id) {
                        const cleaned = String(ch.notes || '')
                            .replace(/\[setoran parsial terima\]/gi, '')
                            .replace(/\s*\|\s*/g, ' | ')
                            .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
                            .trim();
                        await dbRun(`UPDATE payments SET notes = ? WHERE id = ?`, [cleaned, ch.id]);
                        continue;
                    }
                    const chNet = (Number(ch.amount) || 0) - (Number(ch.commission_amount) || 0);
                    await dbRun(
                        `UPDATE payments SET
                            amount = amount + ?,
                            commission_amount = commission_amount + ?,
                            remittance_net_applied = COALESCE(remittance_net_applied, 0) + ?
                         WHERE id = ?`,
                        [Number(ch.amount) || 0, Number(ch.commission_amount) || 0, chNet, root.id]
                    );
                    if (ch.remittance_status === 'remitted' && ch.remittance_date) {
                        await dbRun(
                            `UPDATE payments SET remittance_date = COALESCE(remittance_date, ?) WHERE id = ?`,
                            [ch.remittance_date, root.id]
                        );
                        const rn = String(ch.remittance_notes || '').trim();
                        if (rn) {
                            await dbRun(
                                `UPDATE payments SET remittance_notes = CASE
                                    WHEN TRIM(COALESCE(remittance_notes, '')) = '' THEN ?
                                    ELSE TRIM(remittance_notes) || ' | ' || ? END
                                 WHERE id = ?`,
                                [rn, rn, root.id]
                            );
                        }
                    }
                    await dbRun(`DELETE FROM payments WHERE id = ?`, [ch.id]);
                    const r2 = await dbGet(
                        `SELECT amount, commission_amount, remittance_net_applied, remittance_status
                         FROM payments WHERE id = ?`,
                        [root.id]
                    );
                    if (r2) {
                        const net = (Number(r2.amount) || 0) - (Number(r2.commission_amount) || 0);
                        const applied = Number(r2.remittance_net_applied) || 0;
                        const done = net > 0 && applied + 0.01 >= net;
                        await dbRun(
                            `UPDATE payments SET remittance_status = ? WHERE id = ?`,
                            [done ? 'remitted' : 'pending', root.id]
                        );
                    }
                }
            }
        }

        // Hot-reload payment gateway configuration
        // Hot-reload payment gateway configuration
        async reloadPaymentGateway() {
            try {
                const result = await this.paymentGateway.reload();
                return result;
            } catch (e) {
                try { logger.error('[BILLING] Failed to reload payment gateways:', e.message); } catch (_) {}
                return { error: true, message: e.message };
            }
        }

        autoCleanTwoMonthsOldPaymentProofs() {
            // Cek secara sinkron 1 kali di awal, lalu jadwalkan tiap 24 jam
            const cleanUpTask = () => {
                try {
                    const sql = "SELECT id, payment_proof FROM payments WHERE payment_proof IS NOT NULL AND payment_date <= datetime('now','localtime', '-60 days')";
                    
                    this.db.all(sql, [], (err, rows) => {
                        if (err || !rows) return;
                        
                        rows.forEach(row => {
                            const proofPath = row.payment_proof; 
                            const fullPath = path.join(__dirname, '..', 'public', proofPath);
                            
                            if (fs.existsSync(fullPath)) {
                                fs.unlink(fullPath, (error) => {
                                    if (!error) {
                                        this.db.run("UPDATE payments SET payment_proof = NULL WHERE id = ?", [row.id]);
                                    }
                                });
                            } else {
                                this.db.run("UPDATE payments SET payment_proof = NULL WHERE id = ?", [row.id]);
                            }
                        });
                    });
                } catch (e) {
                    console.error("Payment proof cleanup worker err:", e);
                }
            };

            // Jalankan setelah sistem siap, lalu rutinkan tiap 24 Jam
            setTimeout(cleanUpTask, 15000); 
            setInterval(cleanUpTask, 24 * 60 * 60 * 1000); 
        }

        /**
         * Helper function untuk auto-sync status ke RADIUS
         * Dipanggil saat status customer berubah menjadi 'suspended' atau 'active'
         */
        async _autoSyncStatusToRadius(customer, oldStatus, newStatus) {
            try {
                // Hanya sync jika status benar-benar berubah
                if (newStatus === 'suspended' && oldStatus !== 'suspended') {
                    // Status berubah menjadi suspended - langsung sync ke RADIUS
                    const { getUserAuthModeAsync } = require('./mikrotik');
                    const authMode = await getUserAuthModeAsync();
                    
                    if (authMode === 'radius') {
                        const pppUser = (customer.pppoe_username && String(customer.pppoe_username).trim()) || 
                                    (customer.username && String(customer.username).trim());
                        
                        if (pppUser) {
                            logger.info(`[BILLING] Auto-syncing ${pppUser} to isolir group in RADIUS...`);
                            const { suspendUserRadius } = require('./mikrotik');
                            
                            const suspendResult = await suspendUserRadius(pppUser);
                            if (suspendResult && suspendResult.success) {
                                logger.info(
                                    `[BILLING] ✅ ${pppUser} isolir (kicked ${suspendResult.disconnected || 0} sesi)`
                                );
                            } else {
                                logger.error(`[BILLING] ❌ Failed to move ${pppUser} to isolir: ${suspendResult?.message || 'Unknown error'}`);
                            }
                        }
                    }
                } else if (newStatus === 'active' && oldStatus === 'suspended') {
                    // Status berubah dari suspended ke active - restore dari isolir
                    const { getUserAuthModeAsync } = require('./mikrotik');
                    const authMode = await getUserAuthModeAsync();
                    
                    if (authMode === 'radius') {
                        const pppUser = (customer.pppoe_username && String(customer.pppoe_username).trim()) || 
                                    (customer.username && String(customer.username).trim());
                        
                        if (pppUser) {
                            logger.info(`[BILLING] Auto-restoring ${pppUser} from isolir group in RADIUS...`);
                            const { unsuspendUserRadius } = require('./mikrotik');
                            
                            const restoreResult = await unsuspendUserRadius(pppUser, customer);
                            if (restoreResult && restoreResult.success) {
                                logger.info(
                                    `[BILLING] ✅ ${pppUser} restored ke ${restoreResult.previousGroup || 'paket'} (kicked ${restoreResult.disconnected || 0} sesi)`
                                );
                            } else {
                                logger.error(`[BILLING] ❌ Failed to restore ${pppUser} from isolir: ${restoreResult?.message || 'Unknown error'}`);
                            }
                        }
                    }
                }
            } catch (syncError) {
                logger.error(`[BILLING] Error auto-syncing status to RADIUS: ${syncError.message}`);
                // Jangan throw error, karena update status sudah berhasil
            }
        }

        async setSuspendReasonById(id, suspendReason) {
            return new Promise((resolve, reject) => {
                this.db.run(
                    `UPDATE customers SET suspend_reason = ? WHERE id = ?`,
                    [suspendReason || null, id],
                    (err) => (err ? reject(err) : resolve())
                );
            });
        }

        async setCustomerStatusById(id, status, options = {}) {
            return new Promise(async (resolve, reject) => {
                try {
                    const existing = await this.getCustomerById(id);
                    if (!existing) return reject(new Error('Customer not found'));
                    const oldStatus = existing.status;
                    const skipRadiusSync = Boolean(options && (options.skipRadiusSync || options.skipExternalSync));
                    const st = String(status || '').toLowerCase();
                    const clearSuspendReason = st === 'active' || st === 'inactive' || st === 'register';
                    const sql = clearSuspendReason
                        ? `UPDATE customers SET status = ?, suspend_reason = NULL WHERE id = ?`
                        : `UPDATE customers SET status = ? WHERE id = ?`;
                    const params = clearSuspendReason ? [status, id] : [status, id];
                    this.db.run(sql, params, async (err) => {
                        if (err) return reject(err);
                        try {
                            logger.info(`[BILLING] setCustomerStatusById: id=${id}, username=${existing.username}, from=${oldStatus} -> to=${status}`);
                            
                            // Auto-sync hanya untuk perubahan status langsung dari billing.
                            // Orchestrator isolir/restore memakai skipRadiusSync agar aksi jaringan tidak dobel.
                            if (!skipRadiusSync) {
                                await this._autoSyncStatusToRadius(existing, oldStatus, status);
                            }
                        } catch (_) {}
                        const oldSt = String(oldStatus || '').toLowerCase();
                        const nowIsolir = st === 'suspended' || st === 'isolir';
                        const wasIsolir = oldSt === 'suspended' || oldSt === 'isolir';
                        if (nowIsolir && !wasIsolir) {
                            setImmediate(() => {
                                try {
                                    const cfn = require('./collectorFieldNotifications');
                                    cfn.notifyCustomerIsolir(Number(id), existing.name || '');
                                } catch (_) {}
                            });
                        }
                        resolve({ id, status });
                    });
                } catch (e) {
                    reject(e);
                }
            });
        }

        initDatabase() {
            // Pastikan direktori data ada
            const dataDir = path.dirname(this.dbPath);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            // Inisialisasi database secara synchronous
            try {
                this.db = new sqlite3.Database(this.dbPath);
                console.log('Billing database connected');
                
                // Enable foreign key constraints and performance PRAGMAs
                this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -20000; PRAGMA temp_store = MEMORY;", (err) => {
                    if (err) {
                        console.error('Error enabling PRAGMA optimizations:', err);
                    } else {
                        console.log('✅ Database optimizations enabled (WAL, memory temp_store, cache_size)');
                    }
                });
                
                this.createTables();
            } catch (err) {
                console.error('Error opening billing database:', err);
                throw err;
            }
        }

        async updateCustomerById(id, customerData) {
            return new Promise(async (resolve, reject) => {
                const { name, username, pppoe_username, email, address, area, area_id, latitude, longitude, package_id, odp_id, pppoe_profile, status, auto_suspension, billing_day, renewal_type, fix_date, cable_type, cable_length, port_number, cable_status, cable_notes } = customerData;
                try {
                    const oldCustomer = await this.getCustomerById(id);
                    if (!oldCustomer) return reject(new Error('Customer not found'));

                    const normBillingDay = Math.min(Math.max(parseInt(billing_day !== undefined ? billing_day : (oldCustomer?.billing_day ?? 15), 10) || 15, 1), 28);
                    
                    // Normalisasi renewal_type dan fix_date
                    const normRenewalType = renewal_type || oldCustomer.renewal_type || 'renewal';
                    const normFixDate = renewal_type === 'fix_date' ? 
                        (fix_date !== undefined ? Math.min(Math.max(parseInt(fix_date, 10) || 15, 1), 28) : (oldCustomer.fix_date || 15)) : 
                        null;

                    const sql = `UPDATE customers SET name = ?, username = ?, pppoe_username = ?, email = ?, address = ?, area = ?, area_id = ?, latitude = ?, longitude = ?, package_id = ?, odp_id = ?, pppoe_profile = ?, status = ?, auto_suspension = ?, billing_day = ?, renewal_type = ?, fix_date = ?, cable_type = ?, cable_length = ?, port_number = ?, cable_status = ?, cable_notes = ? WHERE id = ?`;
                    this.db.run(sql, [
                        name ?? oldCustomer.name,
                        username ?? oldCustomer.username,
                        pppoe_username ?? oldCustomer.pppoe_username,
                        email ?? oldCustomer.email,
                        address ?? oldCustomer.address,
                        area !== undefined ? area : oldCustomer.area,
                        customerData.area_id !== undefined ? customerData.area_id : oldCustomer.area_id,
                        latitude !== undefined ? parseFloat(latitude) : oldCustomer.latitude,
                        longitude !== undefined ? parseFloat(longitude) : oldCustomer.longitude,
                        package_id ?? oldCustomer.package_id,
                        odp_id !== undefined ? odp_id : oldCustomer.odp_id,
                        pppoe_profile ?? oldCustomer.pppoe_profile,
                        status ?? oldCustomer.status,
                        auto_suspension !== undefined ? auto_suspension : oldCustomer.auto_suspension,
                        normBillingDay,
                        normRenewalType,
                        normFixDate,
                        cable_type !== undefined ? cable_type : oldCustomer.cable_type,
                        cable_length !== undefined ? cable_length : oldCustomer.cable_length,
                        port_number !== undefined ? port_number : oldCustomer.port_number,
                        cable_status !== undefined ? cable_status : oldCustomer.cable_status,
                        cable_notes !== undefined ? cable_notes : oldCustomer.cable_notes,
                        id
                    ], async (err) => {
                        if (err) {
                            reject(err);
                        } else {
                            // PENTING: Auto-sync ke RADIUS jika status berubah menjadi 'suspended' atau 'active'
                            const newStatus = status !== undefined ? status : oldCustomer.status;
                            const oldStatus = oldCustomer.status;
                            if (newStatus !== oldStatus) {
                                // Buat customer object dengan data terbaru untuk sync
                                const updatedCustomer = {
                                    ...oldCustomer,
                                    ...customerData,
                                    id,
                                    status: newStatus
                                };
                                await this._autoSyncStatusToRadius(updatedCustomer, oldStatus, newStatus);
                                const nst = String(newStatus || '').toLowerCase();
                                const ost = String(oldStatus || '').toLowerCase();
                                const nowIsolir = nst === 'suspended' || nst === 'isolir';
                                const wasIsolir = ost === 'suspended' || ost === 'isolir';
                                if (nowIsolir && !wasIsolir) {
                                    setImmediate(() => {
                                        try {
                                            const cfn = require('./collectorFieldNotifications');
                                            const nm =
                                                (name !== undefined ? name : oldCustomer.name) || '';
                                            cfn.notifyCustomerIsolir(Number(id), nm);
                                        } catch (_) {}
                                    });
                                }
                            }
                            
                            // Sinkronisasi cable routes jika ada data ODP atau cable
                            if (odp_id !== undefined || cable_type !== undefined) {
                                console.log(`🔧 Updating cable route for customer ${oldCustomer.username}, odp_id: ${odp_id}, cable_type: ${cable_type}`);
                                try {
                                    const db = this.db;
                                    const customerId = id;
                                    
                                    // Cek apakah sudah ada cable route untuk customer ini
                                    const existingRoute = await new Promise((resolve, reject) => {
                                        db.get('SELECT * FROM cable_routes WHERE customer_id = ?', [customerId], (err, row) => {
                                            if (err) reject(err);
                                            else resolve(row);
                                        });
                                    });
                                    
                                    if (existingRoute) {
                                        // Update cable route yang ada
                                        console.log(`📝 Found existing cable route for customer ${oldCustomer.username}, updating...`);
                                        console.log(`🔧 ODP: ${odp_id !== undefined ? odp_id : existingRoute.odp_id}, Port: ${port_number !== undefined ? port_number : existingRoute.port_number}`);
                                        const updateSql = `
                                            UPDATE cable_routes 
                                            SET odp_id = ?, cable_type = ?, cable_length = ?, port_number = ?, status = ?, notes = ?, updated_at = datetime('now','localtime')
                                            WHERE customer_id = ?
                                        `;
                                        
                                        db.run(updateSql, [
                                            odp_id !== undefined ? odp_id : existingRoute.odp_id,
                                            cable_type !== undefined ? cable_type : existingRoute.cable_type,
                                            cable_length !== undefined ? cable_length : existingRoute.cable_length,
                                            port_number !== undefined ? port_number : existingRoute.port_number,
                                            cable_status !== undefined ? cable_status : existingRoute.status,
                                            cable_notes !== undefined ? cable_notes : existingRoute.notes,
                                            customerId
                                        ], function(err) {
                                            if (err) {
                                                console.error(`❌ Error updating cable route for customer ${oldCustomer.username}:`, err.message);
                                            } else {
                                                console.log(`✅ Successfully updated cable route for customer ${oldCustomer.username}`);
                                            }
                                        });
                                    } else if (odp_id) {
                                        // Buat cable route baru jika belum ada
                                        console.log(`📝 Creating new cable route for customer ${oldCustomer.username}...`);
                                        const cableRouteSql = `
                                            INSERT INTO cable_routes (customer_id, odp_id, cable_type, cable_length, port_number, status, notes)
                                            VALUES (?, ?, ?, ?, ?, ?, ?)
                                        `;
                                        
                                        db.run(cableRouteSql, [
                                            customerId,
                                            odp_id,
                                            cable_type || 'Fiber Optic',
                                            cable_length || 0,
                                            port_number || 1,
                                            cable_status || 'connected',
                                            cable_notes || `Auto-created for customer ${oldCustomer.name}`
                                        ], function(err) {
                                            if (err) {
                                                console.error(`❌ Error creating cable route for customer ${oldCustomer.username}:`, err.message);
                                            } else {
                                                console.log(`✅ Successfully created cable route for customer ${oldCustomer.username}`);
                                            }
                                        });
                                    }
                                } catch (cableError) {
                                    console.error(`❌ Error handling cable route for customer ${oldCustomer.username}:`, cableError.message);
                                    // Jangan reject, karena customer sudah berhasil diupdate di billing
                                }
                            }
                            
                            resolve({ username: oldCustomer.username, id, ...customerData });
                        }
                    });
                } catch (error) {
                    reject(error);
                }
            });
        }

        // Update customer coordinates untuk mapping
        async updateCustomerCoordinates(id, coordinates) {
            return new Promise((resolve, reject) => {
                const { latitude, longitude } = coordinates;
                
                if (latitude === undefined || longitude === undefined) {
                    return reject(new Error('Latitude dan longitude wajib diisi'));
                }

                const sql = `UPDATE customers SET latitude = ?, longitude = ? WHERE id = ?`;
                this.db.run(sql, [latitude, longitude, id], function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ id, latitude, longitude, changes: this.changes });
                    }
                });
            });
        }

        // Get customer by serial number (untuk mapping device)
        async getCustomerBySerialNumber(serialNumber) {
            return new Promise((resolve, reject) => {
                const sql = `SELECT * FROM customers WHERE serial_number = ?`;
                this.db.get(sql, [serialNumber], (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row || null);
                    }
                });
            });
        }

        // Get customer by PPPoE username (untuk mapping device)
        async getCustomerByPPPoE(pppoeUsername) {
            return new Promise((resolve, reject) => {
                const sql = `SELECT * FROM customers WHERE pppoe_username = ?`;
                this.db.get(sql, [pppoeUsername], (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row || null);
                    }
                });
            });
        }

        createTables() {
            const tables = [
                // Tabel paket internet
                `CREATE TABLE IF NOT EXISTS packages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    speed TEXT NOT NULL,
                    price DECIMAL(10,2) NOT NULL,
                    tax_rate DECIMAL(5,2) DEFAULT 11.00,
                    description TEXT,
                    pppoe_profile TEXT DEFAULT 'default',
                    router_id INTEGER,
                    upload_limit TEXT,
                    download_limit TEXT,
                    burst_limit_upload TEXT,
                    burst_limit_download TEXT,
                    burst_threshold TEXT,
                    burst_time TEXT,
                    is_active BOOLEAN DEFAULT 1,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (router_id) REFERENCES routers(id)
                )`,

                // Tabel pelanggan
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
                    join_date DATETIME DEFAULT (datetime('now','localtime')),
                    -- Cable connection fields
                    cable_type TEXT,
                    cable_length INTEGER,
                    port_number INTEGER,
                    cable_status TEXT DEFAULT 'connected',
                    cable_notes TEXT,
                    area TEXT,
                    FOREIGN KEY (package_id) REFERENCES packages (id)
                )`,

                // Tabel routers (NAS) untuk RADIUS mapping
                `CREATE TABLE IF NOT EXISTS routers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    nas_ip TEXT NOT NULL,
                    nas_identifier TEXT,
                    secret TEXT,
                    UNIQUE(nas_ip)
                )`,

                // Tabel Paket Member (mirip dengan packages untuk PPPoE)
                `CREATE TABLE IF NOT EXISTS member_packages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    speed TEXT NOT NULL,
                    price DECIMAL(10,2) NOT NULL,
                    tax_rate DECIMAL(5,2) DEFAULT 11.00,
                    description TEXT,
                    hotspot_profile TEXT DEFAULT 'default',
                    upload_limit TEXT,
                    download_limit TEXT,
                    burst_limit_upload TEXT,
                    burst_limit_download TEXT,
                    burst_threshold TEXT,
                    burst_time TEXT,
                    is_active BOOLEAN DEFAULT 1,
                    created_at DATETIME DEFAULT (datetime('now','localtime'))
                )`,

                // Tabel Members (mirip dengan customers untuk PPPoE, tapi menggunakan Hotspot)
                `CREATE TABLE IF NOT EXISTS members (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    name TEXT NOT NULL,
                    phone TEXT UNIQUE NOT NULL,
                    hotspot_username TEXT,
                    email TEXT,
                    address TEXT,
                    latitude DECIMAL(10,8),
                    longitude DECIMAL(11,8),
                    package_id INTEGER,
                    hotspot_profile TEXT,
                    status TEXT DEFAULT 'active',
                    join_date DATETIME DEFAULT (datetime('now','localtime')),
                    server_hotspot TEXT,
                    auto_suspension BOOLEAN DEFAULT 1,
                    billing_day INTEGER DEFAULT 15,
                    renewal_type TEXT DEFAULT 'renewal',
                    fix_date INTEGER,
                    area TEXT,
                    ktp_photo_path TEXT,
                    house_photo_path TEXT,
                    password TEXT,
                    FOREIGN KEY (package_id) REFERENCES member_packages (id)
                )`,

                // Mapping customer ke router (tanpa ubah skema customers)
                `CREATE TABLE IF NOT EXISTS customer_router_map (
                    customer_id INTEGER NOT NULL,
                    router_id INTEGER NOT NULL,
                    PRIMARY KEY (customer_id),
                    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
                    FOREIGN KEY (router_id) REFERENCES routers(id) ON DELETE CASCADE
                )`,

                // Tabel Assignment Collector (Lama - Masih dipertahankan sebagai fallback/manual)
                `CREATE TABLE IF NOT EXISTS collector_assignments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    collector_id INTEGER NOT NULL,
                    customer_id INTEGER NULL,
                    member_id INTEGER NULL,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    UNIQUE(collector_id, customer_id),
                    UNIQUE(collector_id, member_id),
                    FOREIGN KEY (collector_id) REFERENCES collectors(id) ON DELETE CASCADE,
                    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
                    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
                    CHECK ((customer_id IS NOT NULL) OR (member_id IS NOT NULL))
                )`,

                // Tabel Mapping Area ke Collector (Baru)
                `CREATE TABLE IF NOT EXISTS collector_areas (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    collector_id INTEGER NOT NULL,
                    area TEXT NOT NULL,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    UNIQUE(collector_id, area),
                    FOREIGN KEY (collector_id) REFERENCES collectors(id) ON DELETE CASCADE
                )`,

                // Tabel tagihan
                `CREATE TABLE IF NOT EXISTS invoices (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    customer_id INTEGER NULL,
                    member_id INTEGER NULL,
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
                    base_amount DECIMAL(10,2),
                    tax_rate DECIMAL(5,2),
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (customer_id) REFERENCES customers (id),
                    FOREIGN KEY (member_id) REFERENCES members (id),
                    FOREIGN KEY (package_id) REFERENCES packages (id),
                    CHECK ((customer_id IS NOT NULL) OR (member_id IS NOT NULL))
                )`,

                // Tabel pembayaran
                `CREATE TABLE IF NOT EXISTS payments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    invoice_id INTEGER NOT NULL,
                    amount DECIMAL(10,2) NOT NULL,
                    payment_date DATETIME DEFAULT (datetime('now','localtime')),
                    payment_method TEXT NOT NULL,
                    reference_number TEXT,
                    notes TEXT,
                    FOREIGN KEY (invoice_id) REFERENCES invoices (id)
                )`,

                // Tabel transaksi payment gateway
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
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (invoice_id) REFERENCES invoices (id)
                )`,

                // Tabel expenses untuk pengeluaran
                `CREATE TABLE IF NOT EXISTS expenses (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    description TEXT NOT NULL,
                    amount REAL NOT NULL,
                    category TEXT NOT NULL,
                    account_expenses TEXT,
                    expense_date DATE NOT NULL,
                    payment_method TEXT,
                    notes TEXT,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime'))
                )`,

                // Tabel income (pemasukan)
                `CREATE TABLE IF NOT EXISTS income (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    description TEXT NOT NULL,
                    amount REAL NOT NULL,
                    category TEXT NOT NULL,
                    income_date DATE NOT NULL,
                    payment_method TEXT,
                    notes TEXT,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime'))
                )`,

                // Tabel kategori keuangan (pemasukan dan pengeluaran dinamis)
                `CREATE TABLE IF NOT EXISTS finance_categories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    type TEXT NOT NULL, -- 'income' atau 'expense'
                    name TEXT NOT NULL,
                    subcategories TEXT, -- JSON array of strings for expense account_expenses
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime'))
                )`,

                // Tabel Goods Invoices (Invoice Barang)
                `CREATE TABLE IF NOT EXISTS goods_invoices (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    invoice_number TEXT UNIQUE NOT NULL,
                    customer_name TEXT NOT NULL,
                    customer_phone TEXT,
                    customer_address TEXT,
                    subtotal DECIMAL(15,2) NOT NULL DEFAULT 0,
                    tax_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
                    total_amount DECIMAL(15,2) NOT NULL,
                    status TEXT DEFAULT 'unpaid',
                    payment_method TEXT,
                    payment_date DATETIME,
                    notes TEXT,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime'))
                )`,

                // Tabel Goods Invoice Items (Item Barang)
                `CREATE TABLE IF NOT EXISTS goods_invoice_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    invoice_id INTEGER NOT NULL,
                    item_name TEXT NOT NULL,
                    quantity INTEGER NOT NULL DEFAULT 1,
                    unit_price DECIMAL(15,2) NOT NULL,
                    total_price DECIMAL(15,2) NOT NULL,
                    FOREIGN KEY (invoice_id) REFERENCES goods_invoices(id) ON DELETE CASCADE
                )`,

                // Tabel voucher_revenue
                `CREATE TABLE IF NOT EXISTS voucher_revenue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    price DECIMAL(10,2) NOT NULL DEFAULT 0,
                    profile TEXT,
                    status TEXT DEFAULT 'unpaid' CHECK(status IN ('unpaid', 'paid')),
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    used_at DATETIME,
                    usage_count INTEGER DEFAULT 0,
                    notes TEXT
                )`,

                // Tabel ODP (Optical Distribution Point)
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
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime'))
                )`,

                // Tabel Cable Routes (Jalur Kabel dari ODP ke Pelanggan)
                `CREATE TABLE IF NOT EXISTS cable_routes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    customer_id INTEGER NOT NULL,
                    odp_id INTEGER NOT NULL,
                    cable_length DECIMAL(8,2),
                    cable_type VARCHAR(50) DEFAULT 'Fiber Optic',
                    installation_date DATE,
                    status VARCHAR(20) DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected', 'maintenance', 'damaged')),
                    port_number INTEGER,
                    notes TEXT,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
                    FOREIGN KEY (odp_id) REFERENCES odps(id) ON DELETE CASCADE
                )`,

                // Tabel Network Segments (Segmen Jaringan)
                `CREATE TABLE IF NOT EXISTS network_segments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name VARCHAR(100) NOT NULL,
                    start_odp_id INTEGER NOT NULL,
                    end_odp_id INTEGER,
                    segment_type VARCHAR(50) DEFAULT 'Backbone' CHECK (segment_type IN ('Backbone', 'Distribution', 'Access')),
                    cable_length DECIMAL(10,2),
                    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'damaged', 'inactive')),
                    installation_date DATE,
                    notes TEXT,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (start_odp_id) REFERENCES odps(id) ON DELETE CASCADE,
                    FOREIGN KEY (end_odp_id) REFERENCES odps(id) ON DELETE CASCADE
                )`,
                
                // Tabel ODP Connections (Backbone Network)
                `CREATE TABLE IF NOT EXISTS odp_connections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_odp_id INTEGER NOT NULL,
                    to_odp_id INTEGER NOT NULL,
                    connection_type VARCHAR(50) DEFAULT 'fiber' CHECK (connection_type IN ('fiber', 'copper', 'wireless', 'microwave')),
                    cable_length DECIMAL(8,2),
                    cable_capacity VARCHAR(20) DEFAULT '1G' CHECK (cable_capacity IN ('100M', '1G', '10G', '100G')),
                    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'inactive', 'damaged')),
                    installation_date DATE,
                    notes TEXT,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (from_odp_id) REFERENCES odps(id) ON DELETE CASCADE,
                    FOREIGN KEY (to_odp_id) REFERENCES odps(id) ON DELETE CASCADE,
                    UNIQUE(from_odp_id, to_odp_id)
                )`,

                // Tabel Cable Maintenance Log
                `CREATE TABLE IF NOT EXISTS cable_maintenance_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    cable_route_id INTEGER,
                    network_segment_id INTEGER,
                    maintenance_type VARCHAR(50) NOT NULL CHECK (maintenance_type IN ('repair', 'replacement', 'inspection', 'upgrade')),
                    description TEXT NOT NULL,
                    performed_by INTEGER,
                    maintenance_date DATE NOT NULL,
                    duration_hours DECIMAL(4,2),
                    cost DECIMAL(12,2),
                    notes TEXT,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (cable_route_id) REFERENCES cable_routes(id) ON DELETE CASCADE,
                    FOREIGN KEY (network_segment_id) REFERENCES network_segments(id) ON DELETE CASCADE
                )`,

                // Pesan/broadcast admin → portal pelanggan (daftar di dashboard & gabung notifikasi)
                `CREATE TABLE IF NOT EXISTS customer_portal_broadcasts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    body TEXT NOT NULL,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    is_active INTEGER DEFAULT 1
                )`,

                `CREATE TABLE IF NOT EXISTS customer_portal_package_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    customer_id INTEGER NOT NULL,
                    customer_username TEXT,
                    customer_name TEXT,
                    customer_phone TEXT,
                    current_package_name TEXT,
                    current_speed TEXT,
                    target_package_name TEXT NOT NULL,
                    target_speed TEXT,
                    target_price_rupiah INTEGER,
                    note TEXT,
                    status TEXT DEFAULT 'pending',
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (customer_id) REFERENCES customers(id)
                )`
            ];

            // Create tables sequentially to ensure proper order
            this.createTablesSequentially(tables);

            // Tambahkan kolom payment_status jika belum ada
            this.db.run("ALTER TABLE invoices ADD COLUMN payment_status TEXT DEFAULT 'pending'", (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('Error adding payment_status column:', err);
                }
            });

            // Tambahkan kolom pppoe_profile ke packages jika belum ada
            this.db.run("ALTER TABLE packages ADD COLUMN pppoe_profile TEXT DEFAULT 'default'", (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('Error adding pppoe_profile column to packages:', err);
                } else if (!err) {
                    console.log('Added pppoe_profile column to packages table');
                }
            });

            // Tambahkan kolom pppoe_profile ke customers jika belum ada
            this.db.run("ALTER TABLE customers ADD COLUMN pppoe_profile TEXT", (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('Error adding pppoe_profile column to customers:', err);
                } else if (!err) {
                    console.log('Added pppoe_profile column to customers table');
                }
            });

            // Tambahkan kolom cable connection ke customers jika belum ada
            this.addCableFieldsToCustomers();

            // Tambahkan kolom auto_suspension ke customers jika belum ada
            this.db.run("ALTER TABLE customers ADD COLUMN auto_suspension BOOLEAN DEFAULT 1", (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('Error adding auto_suspension column:', err);
                } else if (!err) {
                    console.log('Added auto_suspension column to customers table');
                }
            });

            // Alasan isolir: overdue (telat bayar) vs manual — mengontrol auto-restore
            this.db.run("ALTER TABLE customers ADD COLUMN suspend_reason TEXT", (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('Error adding suspend_reason column:', err);
                } else if (!err) {
                    console.log('Added suspend_reason column to customers table');
                }
                // Backfill sekali: pelanggan isolir tanpa tagihan overdue → manual
                this.db.run(
                    `UPDATE customers SET suspend_reason = 'manual'
                     WHERE status IN ('suspended', 'isolir')
                     AND (suspend_reason IS NULL OR suspend_reason = '')
                     AND id NOT IN (
                         SELECT customer_id FROM invoices
                         WHERE status = 'unpaid' AND date(due_date) < date('now','localtime')
                     )`,
                    (uErr) => {
                        if (uErr) {
                            console.warn('Backfill suspend_reason (manual) skipped:', uErr.message);
                        }
                        this.db.run(
                            `UPDATE customers SET suspend_reason = 'overdue'
                             WHERE status IN ('suspended', 'isolir')
                             AND (suspend_reason IS NULL OR suspend_reason = '')`,
                            (u2Err) => {
                                if (u2Err) {
                                    console.warn('Backfill suspend_reason (overdue) skipped:', u2Err.message);
                                }
                            }
                        );
                    }
                );
            });

            // Tambahkan kolom billing_day ke customers jika belum ada
            this.db.run("ALTER TABLE customers ADD COLUMN billing_day INTEGER DEFAULT 15", (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('Error adding billing_day column:', err);
                } else if (!err) {
                    console.log('Added billing_day column to customers table');
                }
            });

            // Tanggal auto isolir per pelanggan (null = pakai pengaturan global auto_suspension_day)
            this.db.run("ALTER TABLE customers ADD COLUMN auto_suspension_day INTEGER", (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('Error adding auto_suspension_day column:', err);
                } else if (!err) {
                    console.log('Added auto_suspension_day column to customers table');
                }
            });

        // Tambahkan kolom tax_rate ke packages jika belum ada
        this.db.run("ALTER TABLE packages ADD COLUMN tax_rate DECIMAL(5,2) DEFAULT 11.00", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding tax_rate column to packages:', err);
            } else if (!err) {
                console.log('Added tax_rate column to packages table');
            }
        });

        // Tambahkan kolom latitude dan longitude ke customers jika belum ada
        this.db.run("ALTER TABLE customers ADD COLUMN latitude DECIMAL(10,8)", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding latitude column to customers:', err);
            } else if (!err) {
                console.log('Added latitude column to customers table');
            }
        });
        this.db.run("ALTER TABLE customers ADD COLUMN longitude DECIMAL(11,8)", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding longitude column to customers:', err);
            } else if (!err) {
                console.log('Added longitude column to customers table');
            }
        });

        // Tambahkan kolom odp_id ke customers jika belum ada
        this.db.run("ALTER TABLE customers ADD COLUMN odp_id INTEGER", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding odp_id column to customers:', err);
            } else if (!err) {
                console.log('Added odp_id column to customers table');
            }
        });

        // Tambahkan kolom parent_odp_id ke odps jika belum ada
        this.db.run("ALTER TABLE odps ADD COLUMN parent_odp_id INTEGER", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding parent_odp_id column to odps:', err);
            } else if (!err) {
                console.log('Added parent_odp_id column to odps table');
            }
        });

        // Update existing customers to have username if null (for backward compatibility)
        this.db.run("UPDATE customers SET username = 'cust_' || substr(phone, -4, 4) || '_' || strftime('%s','now') WHERE username IS NULL OR username = ''", (err) => {
            if (err) {
                console.error('Error updating null usernames:', err);
            } else {
                console.log('Updated null usernames for existing customers');
            }
        });
    }

    addCableFieldsToCustomers() {
        // Add cable connection fields to customers table
        const cableFields = [
            { name: 'cable_type', type: 'TEXT' },
            { name: 'cable_length', type: 'INTEGER' },
            { name: 'port_number', type: 'INTEGER' },
            { name: 'cable_status', type: 'TEXT DEFAULT "connected"' },
            { name: 'cable_notes', type: 'TEXT' }
        ];

        cableFields.forEach(field => {
            this.db.run(`ALTER TABLE customers ADD COLUMN ${field.name} ${field.type}`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error(`Error adding ${field.name} column:`, err);
                } else if (!err) {
                    console.log(`Added ${field.name} column to customers table`);
                }
            });
        });
    }

    createTablesSequentially(tables) {
        let currentIndex = 0;
        
        const createNextTable = () => {
            if (currentIndex >= tables.length) {
                // All tables created, now add columns and create indexes/triggers
                this.addColumnsAndCreateIndexes();
                return;
            }
            
            const tableSQL = tables[currentIndex];
            this.db.run(tableSQL, (err) => {
                if (err) {
                    console.error('Error creating table:', err);
                }
                currentIndex++;
                createNextTable();
            });
        };
        
        createNextTable();
    }

    addColumnsAndCreateIndexes() {
        this.db.run(
            `CREATE TABLE IF NOT EXISTS customer_portal_package_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL,
                customer_username TEXT,
                customer_name TEXT,
                customer_phone TEXT,
                current_package_name TEXT,
                current_speed TEXT,
                target_package_name TEXT NOT NULL,
                target_speed TEXT,
                target_price_rupiah INTEGER,
                note TEXT,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (customer_id) REFERENCES customers(id)
            )`,
            (err) => {
                if (err && !String(err.message || '').includes('already exists')) {
                    console.error('Error ensuring customer_portal_package_requests:', err.message);
                }
            }
        );

        // Tambahkan kolom customer_id jika belum ada (ID Pelanggan 6 digit)
        this.db.run("ALTER TABLE customers ADD COLUMN customer_id TEXT UNIQUE", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding customer_id column:', err);
            } else if (!err) {
                console.log('Added customer_id column to customers table');
                // Generate customer_id untuk customer yang sudah ada
                this.generateCustomerIdsForExistingCustomers();
            }
        });
        
        // Buat index untuk customer_id
        this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_customer_id ON customers(customer_id)", (err) => {
            if (err) {
                console.error('Error creating index for customer_id:', err);
            }
        });
        
        // Tambahkan kolom pppoe_username jika belum ada
        this.db.run("ALTER TABLE customers ADD COLUMN pppoe_username TEXT", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding pppoe_username column:', err);
            }
        });

        // Tambahkan kolom member_id ke invoices jika belum ada (untuk support member/hotspot billing)
        this.db.run("ALTER TABLE invoices ADD COLUMN member_id INTEGER REFERENCES members(id)", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding member_id column to invoices:', err);
            } else if (!err) {
                console.log('Added member_id column to invoices table');
            }
        });

        // Tambahkan kolom invoice_type ke invoices jika belum ada
        this.db.run("ALTER TABLE invoices ADD COLUMN invoice_type TEXT DEFAULT 'monthly'", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding invoice_type column to invoices:', err);
            } else if (!err) {
                console.log('Added invoice_type column to invoices table');
            }
        });

        // Tambahkan kolom package_name ke invoices jika belum ada
        this.db.run("ALTER TABLE invoices ADD COLUMN package_name TEXT", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding package_name column to invoices:', err);
            } else if (!err) {
                console.log('Added package_name column to invoices table');
            }
        });

        // Tambahkan kolom base_amount ke invoices jika belum ada
        this.db.run("ALTER TABLE invoices ADD COLUMN base_amount DECIMAL(10,2)", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding base_amount column to invoices:', err);
            } else if (!err) {
                console.log('Added base_amount column to invoices table');
            }
        });

        // Tambahkan kolom tax_rate ke invoices jika belum ada
        this.db.run("ALTER TABLE invoices ADD COLUMN tax_rate DECIMAL(5,2)", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding tax_rate column to invoices:', err);
            } else if (!err) {
                console.log('Added tax_rate column to invoices table');
            }
        });

        // Tambahkan kolom description ke invoices jika belum ada
        this.db.run("ALTER TABLE invoices ADD COLUMN description TEXT", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding description column to invoices:', err);
            } else if (!err) {
                console.log('Added description column to invoices table');
            }
        });

        // Tambahkan kolom payment_gateway jika belum ada
        this.db.run("ALTER TABLE invoices ADD COLUMN payment_gateway TEXT", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding payment_gateway column:', err);
            }
        });

        // Tambahkan kolom payment_token jika belum ada
        this.db.run("ALTER TABLE invoices ADD COLUMN payment_token TEXT", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding payment_token column:', err);
            }
        });

        // Tambahkan kolom payment_url jika belum ada
        this.db.run("ALTER TABLE invoices ADD COLUMN payment_url TEXT", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding payment_url column:', err);
            }
        });

        this.db.run('ALTER TABLE payments ADD COLUMN discount_amount REAL DEFAULT 0', (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding discount_amount to payments:', err);
            } else if (!err) {
                console.log('Added discount_amount column to payments table');
            }
        });

        // Tambahkan kolom password ke customers untuk login via username/password
        this.db.run("ALTER TABLE customers ADD COLUMN password TEXT", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding password column to customers:', err);
            } else if (!err) {
                console.log('Added password column to customers table');
            }
        });

        // Tambahkan kolom area ke customers jika belum ada
        this.db.run("ALTER TABLE customers ADD COLUMN area TEXT", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding area column to customers:', err);
            } else if (!err) {
                console.log('Added area column to customers table');
            }
        });

        // Tambahkan kolom password ke members untuk login via username/password
        this.db.run("ALTER TABLE members ADD COLUMN password TEXT", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding password column to members:', err);
            } else if (!err) {
                console.log('Added password column to members table');
            }
        });

        // Tambahkan kolom area ke members jika belum ada
        this.db.run("ALTER TABLE members ADD COLUMN area TEXT", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding area column to members:', err);
            } else if (!err) {
                console.log('Added area column to members table');
            }
        });

        // Tambahkan kolom ktp_photo_path ke members jika belum ada
        this.db.run("ALTER TABLE members ADD COLUMN ktp_photo_path TEXT", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding ktp_photo_path column to members:', err);
            }
        });

        // Tambahkan kolom house_photo_path ke members jika belum ada
        this.db.run("ALTER TABLE members ADD COLUMN house_photo_path TEXT", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding house_photo_path column to members:', err);
            }
        });

        // Tambahkan kolom image ke packages jika belum ada
        this.db.run("ALTER TABLE packages ADD COLUMN image TEXT", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding image column to packages:', err);
            } else if (!err) {
                console.log('Added image column to packages table');
            }
        });

        // Tambahkan kolom member_id ke collector_assignments jika belum ada
        this.db.run("ALTER TABLE collector_assignments ADD COLUMN member_id INTEGER REFERENCES members(id)", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding member_id column to collector_assignments:', err);
            } else if (!err) {
                console.log('Added member_id column to collector_assignments table');
            }
        });

        // Buat index untuk tabel ODP dan Cable Network
        this.createODPIndexes();
        
        // Buat trigger untuk tabel ODP dan Cable Network
        this.createODPTriggers();
        
        // Buat index untuk performa billing queries
        this.createBillingPerformanceIndexes();
    }
    
    createBillingPerformanceIndexes() {
        const indexes = [
            // Index untuk invoices - sangat penting untuk getBillingStats()
            'CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices(created_at)',
            'CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)',
            'CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices(customer_id)',
            'CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date)',
            'CREATE INDEX IF NOT EXISTS idx_invoices_created_status ON invoices(created_at, status)',
            'CREATE INDEX IF NOT EXISTS idx_invoices_invoice_type ON invoices(invoice_type)',
            'CREATE INDEX IF NOT EXISTS idx_invoices_invoice_type_status ON invoices(invoice_type, status)',
            // Index untuk customers
            'CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)',
            'CREATE INDEX IF NOT EXISTS idx_customers_username ON customers(username)',
            'CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status)'
        ];
        
        indexes.forEach(indexSQL => {
            this.db.run(indexSQL, (err) => {
                if (err) {
                    console.error('Error creating billing performance index:', err);
                } else {
                    console.log('✅ Created billing performance index:', indexSQL);
                }
            });
        });
    }

    createODPIndexes() {
        const indexes = [
            // Indexes untuk performa ODP dan Cable Network
            'CREATE INDEX IF NOT EXISTS idx_odps_location ON odps(latitude, longitude)',
            'CREATE INDEX IF NOT EXISTS idx_odps_status ON odps(status)',
            'CREATE INDEX IF NOT EXISTS idx_cable_routes_customer ON cable_routes(customer_id)',
            'CREATE INDEX IF NOT EXISTS idx_cable_routes_odp ON cable_routes(odp_id)',
            'CREATE INDEX IF NOT EXISTS idx_cable_routes_status ON cable_routes(status)',
            'CREATE INDEX IF NOT EXISTS idx_network_segments_start ON network_segments(start_odp_id)',
            'CREATE INDEX IF NOT EXISTS idx_network_segments_end ON network_segments(end_odp_id)',
            'CREATE INDEX IF NOT EXISTS idx_network_segments_status ON network_segments(status)',
            'CREATE INDEX IF NOT EXISTS idx_maintenance_logs_route ON cable_maintenance_logs(cable_route_id)',
            'CREATE INDEX IF NOT EXISTS idx_maintenance_logs_segment ON cable_maintenance_logs(network_segment_id)',
            'CREATE INDEX IF NOT EXISTS idx_maintenance_logs_date ON cable_maintenance_logs(maintenance_date)'
        ];

        indexes.forEach(indexSQL => {
            this.db.run(indexSQL, (err) => {
                if (err) {
                    console.error('Error creating ODP index:', err);
                }
            });
        });
    }

    createODPTriggers() {
        const triggers = [
            // Triggers untuk update timestamp
            `CREATE TRIGGER IF NOT EXISTS update_odps_updated_at 
                AFTER UPDATE ON odps
                FOR EACH ROW
            BEGIN
                UPDATE odps SET updated_at = datetime('now','localtime') WHERE id = NEW.id;
            END`,
            
            `CREATE TRIGGER IF NOT EXISTS update_cable_routes_updated_at 
                AFTER UPDATE ON cable_routes
                FOR EACH ROW
            BEGIN
                UPDATE cable_routes SET updated_at = datetime('now','localtime') WHERE id = NEW.id;
            END`,
            
            `CREATE TRIGGER IF NOT EXISTS update_network_segments_updated_at 
                AFTER UPDATE ON network_segments
                FOR EACH ROW
            BEGIN
                UPDATE network_segments SET updated_at = datetime('now','localtime') WHERE id = NEW.id;
            END`,
            
            `CREATE TRIGGER IF NOT EXISTS update_odp_connections_updated_at 
                AFTER UPDATE ON odp_connections
                FOR EACH ROW
            BEGIN
                UPDATE odp_connections SET updated_at = datetime('now','localtime') WHERE id = NEW.id;
            END`,
            
            // Triggers untuk update used_ports di ODP
            `CREATE TRIGGER IF NOT EXISTS update_odp_used_ports_insert
                AFTER INSERT ON cable_routes
                FOR EACH ROW
            BEGIN
                UPDATE odps SET used_ports = used_ports + 1 WHERE id = NEW.odp_id;
            END`,
            
            `CREATE TRIGGER IF NOT EXISTS update_odp_used_ports_delete
                AFTER DELETE ON cable_routes
                FOR EACH ROW
            BEGIN
                UPDATE odps SET used_ports = used_ports - 1 WHERE id = OLD.odp_id;
            END`,

            // Trigger untuk memutakhirkan used_ports saat cable_routes berpindah ODP
            `CREATE TRIGGER IF NOT EXISTS update_odp_used_ports_change
                AFTER UPDATE OF odp_id ON cable_routes
                FOR EACH ROW
                WHEN NEW.odp_id IS NOT OLD.odp_id
            BEGIN
                UPDATE odps SET used_ports = used_ports - 1 WHERE id = OLD.odp_id;
                UPDATE odps SET used_ports = used_ports + 1 WHERE id = NEW.odp_id;
            END`
        ];

        triggers.forEach(triggerSQL => {
            this.db.run(triggerSQL, (err) => {
                if (err) {
                    console.error('Error creating ODP trigger:', err);
                }
            });
        });
    }

    // Paket Management
    async createPackage(packageData) {
        return new Promise((resolve, reject) => {
            // Add columns if they don't exist (migration)
            const migrations = [
                'router_id INTEGER',
                'nas_ip TEXT',
                'upload_limit TEXT',
                'download_limit TEXT',
                'burst_limit_upload TEXT',
                'burst_limit_download TEXT',
                'burst_threshold TEXT',
                'burst_time TEXT'
            ];
            
            migrations.forEach(col => {
                this.db.run(`ALTER TABLE packages ADD COLUMN ${col}`, (err) => {
                    // Ignore error if column already exists
                });
            });
            
            const { 
                name, speed, price, tax_rate, description, pppoe_profile, image, router_id, nas_ip,
                upload_limit, download_limit, burst_limit_upload, burst_limit_download, 
                burst_threshold, burst_time 
            } = packageData;

            const billingOnly = Boolean(packageData.billing_only);
            const resolvedPppoeProfile = billingOnly
                ? null
                : (pppoe_profile !== undefined && pppoe_profile !== null && String(pppoe_profile).trim() !== ''
                    ? String(pppoe_profile).trim()
                    : 'default');
            const resolvedRouterId = billingOnly ? null : (router_id !== undefined && router_id !== null && router_id !== '' ? router_id : null);
            const resolvedNasIp = billingOnly ? null : (nas_ip !== undefined && nas_ip !== null && String(nas_ip).trim() !== '' ? String(nas_ip).trim() : null);
            
            const sql = `INSERT INTO packages (
                name, speed, price, tax_rate, description, pppoe_profile, image, router_id, nas_ip,
                upload_limit, download_limit, burst_limit_upload, burst_limit_download, 
                burst_threshold, burst_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            
            this.db.run(sql, [
                name, 
                speed, 
                price, 
                tax_rate !== undefined ? tax_rate : 11.00, 
                description, 
                resolvedPppoeProfile, 
                image || null, 
                resolvedRouterId,
                resolvedNasIp,
                upload_limit || null,
                download_limit || null,
                burst_limit_upload || null,
                burst_limit_download || null,
                burst_threshold || null,
                burst_time || null
            ], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({
                        id: this.lastID,
                        ...packageData,
                        pppoe_profile: resolvedPppoeProfile,
                        router_id: resolvedRouterId,
                        nas_ip: resolvedNasIp
                    });
                }
            });
        });
    }

    async getPackages() {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM packages WHERE is_active = 1 ORDER BY price ASC`;
            
            this.db.all(sql, [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async getPackageById(id) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM packages WHERE id = ?`;
            
            this.db.get(sql, [id], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    async updatePackage(id, packageData) {
        return new Promise((resolve, reject) => {
            // Add columns if they don't exist (migration)
            const migrations = [
                'router_id INTEGER',
                'nas_ip TEXT',
                'upload_limit TEXT',
                'download_limit TEXT',
                'burst_limit_upload TEXT',
                'burst_limit_download TEXT',
                'burst_threshold TEXT',
                'burst_time TEXT'
            ];
            
            migrations.forEach(col => {
                this.db.run(`ALTER TABLE packages ADD COLUMN ${col}`, (err) => {
                    // Ignore error if column already exists
                });
            });
            
            const { 
                name, speed, price, tax_rate, description, pppoe_profile, image, router_id, nas_ip,
                upload_limit, download_limit, burst_limit_upload, burst_limit_download, 
                burst_threshold, burst_time 
            } = packageData;

            const billingOnly = Boolean(packageData.billing_only);
            const resolvedPppoeProfile = billingOnly
                ? null
                : (pppoe_profile !== undefined && pppoe_profile !== null && String(pppoe_profile).trim() !== ''
                    ? String(pppoe_profile).trim()
                    : 'default');
            const resolvedRouterId = billingOnly ? null : (router_id !== undefined && router_id !== null && router_id !== '' ? router_id : null);
            const resolvedNasIp = billingOnly ? null : (nas_ip !== undefined && nas_ip !== null && String(nas_ip).trim() !== '' ? String(nas_ip).trim() : null);
            
            const sql = `UPDATE packages SET 
                name = ?, speed = ?, price = ?, tax_rate = ?, description = ?, pppoe_profile = ?, 
                image = ?, router_id = ?, nas_ip = ?,
                upload_limit = ?, download_limit = ?, burst_limit_upload = ?, burst_limit_download = ?,
                burst_threshold = ?, burst_time = ?
                WHERE id = ?`;
            
            this.db.run(sql, [
                name, 
                speed, 
                price, 
                tax_rate || 0, 
                description, 
                resolvedPppoeProfile, 
                image || null, 
                resolvedRouterId,
                resolvedNasIp,
                upload_limit || null,
                download_limit || null,
                burst_limit_upload || null,
                burst_limit_download || null,
                burst_threshold || null,
                burst_time || null,
                id
            ], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({
                        id,
                        ...packageData,
                        pppoe_profile: resolvedPppoeProfile,
                        router_id: resolvedRouterId,
                        nas_ip: resolvedNasIp
                    });
                }
            });
        });
    }

    async deletePackage(id) {
        return new Promise((resolve, reject) => {
            const sql = `UPDATE packages SET is_active = 0 WHERE id = ?`;
            
            this.db.run(sql, [id], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id, deleted: true });
                }
            });
        });
    }

    // Customer Management
    async createCustomer(customerData) {
        return new Promise(async (resolve, reject) => {
            // Pastikan database sudah siap
            if (!this.db) {
                console.error('❌ Database not initialized');
                return reject(new Error('Database not initialized'));
            }
            
            // Simpan reference database untuk digunakan di callback
            const db = this.db;
            const skipExternalSync = Boolean(customerData && customerData.__skip_external_sync);
            const skipGenieacsSync = skipExternalSync || Boolean(customerData && customerData.__skip_genieacs_sync);
            const skipRadiusSync = skipExternalSync || Boolean(customerData && customerData.__skip_radius_sync);
            
            const { name, username, password, phone, pppoe_username, email, address, area, area_id, package_id, odp_id, pppoe_profile, status, auto_suspension, billing_day, static_ip, assigned_ip, mac_address, latitude, longitude, cable_type, cable_length, port_number, cable_status, cable_notes, ktp_photo_path, house_photo_path } = customerData;
            
            // Username = login portal (UNIQUE). PPPoE = terpisah. Bentrok sering terjadi bila pola nama+tanggal sama.
            let finalUsername = (username && String(username).trim()) || this.generateUsername(phone);
            const autoPPPoEUsername = customerData.__billing_only_package
                ? ((pppoe_username != null && String(pppoe_username).trim()) || '')
                : (pppoe_username || this.generatePPPoEUsername(phone));
            const pppoeUserStored =
                autoPPPoEUsername != null && String(autoPPPoEUsername).trim() !== ''
                    ? String(autoPPPoEUsername).trim()
                    : null;
            
            // Generate customer_id (6 digit numerik)
            let generatedCustomerId;
            try {
                generatedCustomerId = await this.generateCustomerId();
            } catch (genErr) {
                console.error('Error generating customer_id:', genErr);
                return reject(new Error('Failed to generate customer ID'));
            }
            
            // Normalisasi billing_day (1-28)
            const normBillingDay = Math.min(Math.max(parseInt(billing_day ?? 15, 10) || 15, 1), 28);
            
            // Pastikan status 'register' tidak di-override
            // Jika status sudah diset (termasuk 'register'), gunakan itu
            // Jika tidak, default ke 'active'
            const finalStatus = (status !== undefined && status !== null && status !== '') ? status : 'active';

            // join_date eksplisit WIB (offset +07:00) agar tampilan detail selaras dengan waktu bisnis Indonesia,
            // bukan hanya DEFAULT SQLite UTC yang sering membingungkan saat server timezone-nya UTC.
            const joinDateStored = `${getLocalTimestamp().replace(/ /, 'T')}+07:00`;
            
            const sql = `INSERT INTO customers (customer_id, username, password, name, phone, pppoe_username, email, address, area, area_id, package_id, odp_id, pppoe_profile, status, auto_suspension, billing_day, static_ip, assigned_ip, mac_address, latitude, longitude, cable_type, cable_length, port_number, cable_status, cable_notes, ktp_photo_path, house_photo_path, join_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            
            // Default coordinates untuk Jakarta jika tidak ada koordinat
            // Jika tag lokasi tidak diisi, simpan NULL agar teknisi bisa update di lapangan.
            const finalLatitude = latitude !== undefined && latitude !== null && `${latitude}`.trim() !== ''
                ? parseFloat(latitude)
                : null;
            const finalLongitude = longitude !== undefined && longitude !== null && `${longitude}`.trim() !== ''
                ? parseFloat(longitude)
                : null;

            const insertParams = (loginUser) => [
                generatedCustomerId,
                loginUser,
                password || null,
                name,
                phone,
                pppoeUserStored,
                email,
                address,
                area || null,
                area_id ? parseInt(area_id) : null,
                package_id,
                customerData.odp_id || null,
                pppoe_profile,
                finalStatus,
                auto_suspension !== undefined ? auto_suspension : 1,
                normBillingDay,
                static_ip || null,
                assigned_ip || null,
                mac_address || null,
                finalLatitude,
                finalLongitude,
                cable_type || null,
                cable_length || null,
                port_number || null,
                cable_status || 'connected',
                cable_notes || null,
                ktp_photo_path || null,
                house_photo_path || null,
                joinDateStored
            ];

            let lastInsertErr = null;
            let lastID = null;
            for (let attempt = 0; attempt < 10; attempt++) {
                try {
                    lastID = await new Promise((res, rej) => {
                        db.run(sql, insertParams(finalUsername), function (err) {
                            if (err) rej(err);
                            else res(this.lastID);
                        });
                    });
                    lastInsertErr = null;
                    break;
                } catch (err) {
                    lastInsertErr = err;
                    const uqLogin =
                        err.message &&
                        err.message.includes('UNIQUE') &&
                        (err.message.includes('customers.username') || err.message.includes('idx_customers_username'));
                    if (uqLogin && attempt < 9) {
                        const prev = finalUsername;
                        finalUsername = this.generateUsername(phone);
                        logger.warn(
                            `[BILLING] Bentrok username login portal "${prev}" → "${finalUsername}" (bukan PPPoE; percobaan ${attempt + 2}/10)`
                        );
                        continue;
                    }
                    return reject(err);
                }
            }
            if (lastInsertErr || lastID == null) {
                return reject(lastInsertErr || new Error('Gagal insert pelanggan'));
            }

            const customer = { id: lastID, ...customerData, username: finalUsername };
                    
                    // Jika ada data ODP, buat cable route otomatis
                    if (odp_id) {
                        console.log(`🔧 Creating cable route for new customer ${finalUsername}, odp_id: ${odp_id}, cable_type: ${cable_type}`);
                        try {
                            // Insert cable route langsung ke database
                            const cableRouteSql = `
                                INSERT INTO cable_routes (customer_id, odp_id, cable_type, cable_length, port_number, status, notes)
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                            `;
                            
                            db.run(cableRouteSql, [
                                lastID,
                                odp_id,
                                cable_type || 'Fiber Optic',
                                cable_length || 0,
                                port_number || 1,
                                cable_status || 'connected',
                                cable_notes || `Auto-created for customer ${name}`
                            ], function(err) {
                                if (err) {
                                    console.error(`❌ Error creating cable route for customer ${finalUsername}:`, err.message);
                                } else {
                                    console.log(`✅ Successfully created cable route for customer ${finalUsername}`);
                                }
                            });
                        } catch (cableError) {
                            console.error(`❌ Error creating cable route for customer ${finalUsername}:`, cableError.message);
                            // Jangan reject, karena customer sudah berhasil dibuat di billing
                        }
                    }
                    
                    // Jika ada nomor telepon dan PPPoE username, coba tambahkan tag ke GenieACS
                    // Tambahkan timeout dan error handling untuk mencegah delay
                    if (!skipGenieacsSync && phone && pppoeUserStored) {
                        try {
                            // Timeout untuk operasi GenieACS
                            const genieacsPromise = new Promise(async (resolve, reject) => {
                                const timeout = setTimeout(() => reject(new Error('GenieACS operation timeout')), 3000); // 3 second timeout
                                
                                try {
                                    const genieacs = require('./genieacs');
                                    // Cari device berdasarkan PPPoE Username
                                    const device = await genieacs.findDeviceByPPPoE(pppoeUserStored);
                                    
                                    if (device) {
                                        // Tambahkan tag nomor telepon ke device
                                        await genieacs.addTagToDevice(device._id, phone);
                                        console.log(`✅ Successfully added phone tag ${phone} to device ${device._id} for customer ${finalUsername} (PPPoE: ${pppoeUserStored})`);
                                    } else {
                                        console.log(`ℹ️ No device found with PPPoE Username ${pppoeUserStored} for customer ${finalUsername} - this is normal for new customers`);
                                    }
                                    clearTimeout(timeout);
                                    resolve();
                                } catch (genieacsError) {
                                    clearTimeout(timeout);
                                    reject(genieacsError);
                                }
                            });
                            
                            await genieacsPromise;
                        } catch (genieacsError) {
                            console.log(`⚠️ GenieACS integration skipped for customer ${finalUsername} (timeout or error): ${genieacsError.message}`);
                            // Jangan reject, karena customer sudah berhasil dibuat di billing
                        }
                    } else if (!skipGenieacsSync && phone && finalUsername && !customerData.__billing_only_package) {
                        // Fallback: coba dengan username jika pppoe_username tidak ada
                        try {
                            // Timeout untuk operasi GenieACS
                            const genieacsPromise = new Promise(async (resolve, reject) => {
                                const timeout = setTimeout(() => reject(new Error('GenieACS operation timeout')), 3000); // 3 second timeout
                                
                                try {
                                    const genieacs = require('./genieacs');
                                    const device = await genieacs.findDeviceByPPPoE(finalUsername);
                                    
                                    if (device) {
                                        await genieacs.addTagToDevice(device._id, phone);
                                        console.log(`✅ Successfully added phone tag ${phone} to device ${device._id} for customer ${finalUsername} (using username as PPPoE)`);
                                    } else {
                                        console.log(`ℹ️ No device found with PPPoE Username ${finalUsername} for customer ${finalUsername} - this is normal for new customers`);
                                    }
                                    clearTimeout(timeout);
                                    resolve();
                                } catch (genieacsError) {
                                    clearTimeout(timeout);
                                    reject(genieacsError);
                                }
                            });
                            
                            await genieacsPromise;
                        } catch (genieacsError) {
                            console.log(`⚠️ GenieACS integration skipped for customer ${finalUsername} (timeout or error): ${genieacsError.message}`);
                        }
                    }
                    
                    if (!skipRadiusSync) {
                        try {
                            const radiusSyncResult = await syncCustomerToRadius({
                                ...customerData,
                                username: finalUsername,
                                pppoe_username: pppoeUserStored || ''
                            }, customerData);
                            if (!radiusSyncResult.success && !radiusSyncResult.skipped) {
                                logger.warn(`[BILLING] RADIUS sync create warning for ${pppoeUserStored || '(none)'}: ${radiusSyncResult.message}`);
                            }
                        } catch (radiusSyncError) {
                            logger.warn(`[BILLING] RADIUS sync create error for ${pppoeUserStored || '(none)'}: ${radiusSyncError.message}`);
                        }
                    }

            resolve(customer);
        });
    }

    /** Tabel master `areas` (admin) dipakai untuk cocokkan area_id pelanggan dengan teks di collector_areas. */
    async _hasAreasReferenceTable() {
        return new Promise((resolve) => {
            this.db.all(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='areas'",
                [],
                (err, rows) => resolve(!err && rows && rows.length > 0)
            );
        });
    }

    /**
     * SQL boolean: pelanggan c berada di wilayah yang sama dengan baris collector_areas (alias).
     * Mendukung c.area (teks) dan c.area_id → areas.nama_area / kode_area.
     */
    _sqlCustomerMatchesCollectorAreaRow(hasAreas, areaAlias = 'cra', customerAlias = 'c') {
        const a = areaAlias;
        const cust = customerAlias;
        const byCustomerAreaText = `(TRIM(IFNULL(${cust}.area, '')) != '' AND LOWER(TRIM(${cust}.area)) = LOWER(TRIM(${a}.area)))`;
        if (!hasAreas) {
            return byCustomerAreaText;
        }
        return `(
            ${byCustomerAreaText}
            OR (
                ${cust}.area_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM areas ar
                    WHERE ar.id = ${cust}.area_id
                    AND (
                        (TRIM(IFNULL(ar.nama_area, '')) != '' AND LOWER(TRIM(ar.nama_area)) = LOWER(TRIM(${a}.area)))
                        OR (TRIM(IFNULL(ar.kode_area, '')) != '' AND LOWER(TRIM(ar.kode_area)) = LOWER(TRIM(${a}.area)))
                    )
                )
            )
        )`;
    }

    /** Filter voucher bulanan (selaras dashboard & laporan kolektor). */
    _sqlInvoiceExcludeVoucher(hasInvoiceType) {
        if (hasInvoiceType) {
            return `(i.invoice_type != 'voucher' OR i.invoice_type IS NULL)`;
        }
        return `(i.invoice_number NOT LIKE 'INV-VCR-%' AND IFNULL(i.notes, '') NOT LIKE 'Voucher Hotspot%')`;
    }

    /**
     * Total tagihan bulanan — definisi tunggal untuk dashboard & terima setoran.
     * scope: 'all' = seluruh invoice bulanan; 'collector_territory' = pool area/penugasan kolektor.
     */
    async getMonthlyTagihanTotals(month, year, options = {}) {
        const scope = options.scope === 'collector_territory' ? 'collector_territory' : 'all';
        const m = parseInt(String(month), 10);
        const y = parseInt(String(year), 10);
        if (!Number.isFinite(m) || m < 1 || m > 12 || !Number.isFinite(y)) {
            return { total_tagihan: 0, total_lunas: 0, total_belum_lunas: 0 };
        }
        const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
        const endDate = new Date(y, m, 0).toISOString().split('T')[0];
        const hasAreas = await this._hasAreasReferenceTable();
        const hasInvoiceType = await new Promise((resolve) => {
            this.db.all('PRAGMA table_info(invoices)', (err, cols) => {
                if (err) resolve(false);
                else resolve((cols || []).some((c) => c.name === 'invoice_type'));
            });
        });
        const voucherExcl = this._sqlInvoiceExcludeVoucher(hasInvoiceType);
        let poolSql = '';
        if (scope === 'collector_territory') {
            const areaMatch = this._sqlCustomerMatchesCollectorAreaRow(hasAreas, 'ca', 'cust');
            poolSql = `AND (
                EXISTS (SELECT 1 FROM collector_areas ca WHERE ${areaMatch})
                OR EXISTS (SELECT 1 FROM collector_assignments casm WHERE casm.customer_id = cust.id)
            )`;
        }
        const sql = `
            SELECT
                COUNT(*) AS count_total,
                COALESCE(SUM(sub.amount), 0) AS total_tagihan,
                COALESCE(SUM(CASE WHEN sub.status = 'paid' THEN 1 ELSE 0 END), 0) AS count_lunas,
                COALESCE(SUM(CASE WHEN sub.status = 'paid' THEN sub.amount ELSE 0 END), 0) AS total_lunas,
                COALESCE(SUM(CASE WHEN sub.status = 'unpaid' THEN 1 ELSE 0 END), 0) AS count_belum_lunas,
                COALESCE(SUM(CASE WHEN sub.status = 'unpaid' THEN sub.amount ELSE 0 END), 0) AS total_belum_lunas
            FROM (
                SELECT DISTINCT i.id AS id, i.amount AS amount, i.status AS status
                FROM invoices i
                INNER JOIN customers cust ON cust.id = i.customer_id
                WHERE DATE(i.created_at) >= ? AND DATE(i.created_at) <= ?
                  AND ${voucherExcl}
                  AND i.status IN ('paid', 'unpaid')
                  ${poolSql}
            ) sub
        `;
        return new Promise((resolve, reject) => {
            this.db.get(sql, [startDate, endDate], (err, row) => {
                if (err) reject(err);
                else {
                    resolve({
                        count_total: Number(row && row.count_total) || 0,
                        total_tagihan: Number(row && row.total_tagihan) || 0,
                        count_lunas: Number(row && row.count_lunas) || 0,
                        total_lunas: Number(row && row.total_lunas) || 0,
                        count_belum_lunas: Number(row && row.count_belum_lunas) || 0,
                        total_belum_lunas: Number(row && row.total_belum_lunas) || 0
                    });
                }
            });
        });
    }

    /** Seluruh invoice belum lunas (non-voucher) — piutang aktif, semua periode. */
    async getOutstandingUnpaidTotals() {
        const hasInvoiceType = await new Promise((resolve) => {
            this.db.all('PRAGMA table_info(invoices)', (err, cols) => {
                if (err) resolve(false);
                else resolve((cols || []).some((c) => c.name === 'invoice_type'));
            });
        });
        const voucherExcl = this._sqlInvoiceExcludeVoucher(hasInvoiceType);
        const sql = `
            SELECT COUNT(*) AS count_unpaid, COALESCE(SUM(amount), 0) AS total_unpaid
            FROM invoices i
            WHERE i.status = 'unpaid' AND ${voucherExcl}
        `;
        return new Promise((resolve, reject) => {
            this.db.get(sql, [], (err, row) => {
                if (err) reject(err);
                else {
                    resolve({
                        count_unpaid: Number(row && row.count_unpaid) || 0,
                        total_unpaid: Number(row && row.total_unpaid) || 0
                    });
                }
            });
        });
    }

    /**
     * Kolektor yang "melihat" pelanggan ini di mobile (penugasan manual ∪ cocok area collector_areas).
     */
    async getCollectorIdsForCustomer(customerId) {
        const cid = parseInt(String(customerId), 10);
        if (!Number.isFinite(cid) || cid <= 0) return [];
        const hasAreas = await this._hasAreasReferenceTable();
        const areaRowMatch = this._sqlCustomerMatchesCollectorAreaRow(hasAreas, 'cra');
        const sql = `
            SELECT DISTINCT x.collector_id AS collector_id FROM (
                SELECT ca.collector_id AS collector_id
                FROM collector_assignments ca
                WHERE ca.customer_id = ?
                UNION
                SELECT cra.collector_id AS collector_id
                FROM customers c
                INNER JOIN collector_areas cra ON (${areaRowMatch})
                WHERE c.id = ?
            ) x
            WHERE x.collector_id IS NOT NULL
        `;
        return new Promise((resolve, reject) => {
            this.db.all(sql, [cid, cid], (err, rows) => {
                if (err) reject(err);
                else {
                    const out = [];
                    const seen = new Set();
                    for (const r of rows || []) {
                        const id = parseInt(String(r.collector_id), 10);
                        if (Number.isFinite(id) && id > 0 && !seen.has(id)) {
                            seen.add(id);
                            out.push(id);
                        }
                    }
                    resolve(out);
                }
            });
        });
    }

    async getCollectorCustomers(collectorId, month = null, year = null) {
        const hasAreas = await this._hasAreasReferenceTable();
        const areaRowMatch = this._sqlCustomerMatchesCollectorAreaRow(hasAreas, 'cra');
        return new Promise(async (resolve, reject) => {
            // Kita gabungkan customer yang di-mapping area-nya DAN yang di-mapping manual
            const sql = `
                SELECT DISTINCT c.*, p.name as package_name, p.price as package_price, p.image as package_image, p.tax_rate,
                       c.latitude, c.longitude,
                       r.name as router_name,
${year && month ? `
                       CASE 
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND strftime('%m', i.created_at) = '${String(month).padStart(2, '0')}' 
                               AND strftime('%Y', i.created_at) = '${String(year)}' 
                               AND i.status = 'paid'
                           ) THEN 'paid'
                           ELSE 'unpaid'
                       END as payment_status` : `
                       CASE 
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'unpaid' 
                               AND i.due_date < date('now','localtime')
                           ) THEN 'overdue'
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'unpaid'
                           ) THEN 'unpaid'
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'paid'
                           ) THEN 'paid'
                           ELSE 'no_invoice'
                       END as payment_status`}
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id
                LEFT JOIN customer_router_map m ON m.customer_id = c.id
                LEFT JOIN routers r ON r.id = m.router_id
                -- Area: teks customers.area ATAU area_id → areas.nama_area/kode_area (sama seperti filter admin)
                LEFT JOIN collector_areas cra ON (
                    cra.collector_id = ?
                    AND ${areaRowMatch}
                )
                -- Filter Manual: Ambil customer yang di-mapping manual ke collector
                LEFT JOIN collector_assignments ca ON (c.id = ca.customer_id AND ca.collector_id = ?)
                WHERE cra.collector_id IS NOT NULL OR ca.collector_id IS NOT NULL
                ORDER BY c.name ASC
            `;
            
            this.db.all(sql, [collectorId, collectorId], async (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    // Calculate price with tax for each customer
                    let processedRows = rows.map(row => {
                        if (row.package_price && row.tax_rate !== null) {
                            row.package_price = this.calculatePriceWithTax(row.package_price, row.tax_rate);
                        }
                        return row;
                    });
                    
                    // Jika menggunakan RADIUS mode, ambil profil dari RADIUS
                    try {
                        const { getUserAuthModeAsync, getRadiusConnection } = require('./mikrotik');
                        const authMode = await getUserAuthModeAsync();
                        
                        if (authMode === 'radius') {
                            const radiusConn = await getRadiusConnection();
                            const pppUsers = processedRows
                                .map(c => (c.pppoe_username && String(c.pppoe_username).trim()) || (c.username && String(c.username).trim()))
                                .filter(u => u && u.length > 0);
                            
                            if (pppUsers.length > 0) {
                                const placeholders = pppUsers.map(() => '?').join(',');
                                const [radProfiles] = await radiusConn.execute(`
                                    SELECT username, value as profile 
                                    FROM radreply 
                                    WHERE username IN (${placeholders}) AND attribute = 'Mikrotik-Group'
                                `, pppUsers);
                                
                                const profileMap = {};
                                radProfiles.forEach(rp => { profileMap[rp.username] = rp.profile; });
                                
                                processedRows = processedRows.map(c => {
                                    const user = (c.pppoe_username && String(c.pppoe_username).trim()) || (c.username && String(c.username).trim());
                                    if (user && profileMap[user]) c.pppoe_profile = profileMap[user];
                                    return c;
                                });
                            }
                            await radiusConn.end();
                        }
                    } catch (e) {
                        console.error('Error fetching RADIUS profiles for collector customers:', e.message);
                    }
                    
                    resolve(processedRows);
                }
            });
        });
    }

    async getCustomers(options = {}) {
        return new Promise(async (resolve, reject) => {
            let whereClause = '';
            const params = [];
            const joinMonth = parseInt(String(options.joinMonth ?? ''), 10);
            const joinYear = parseInt(String(options.joinYear ?? ''), 10);
            if (Number.isFinite(joinMonth) && joinMonth >= 1 && joinMonth <= 12
                && Number.isFinite(joinYear) && joinYear >= 2000) {
                const startDate = `${joinYear}-${String(joinMonth).padStart(2, '0')}-01`;
                const nextMonth = joinMonth === 12 ? 1 : joinMonth + 1;
                const nextYear = joinMonth === 12 ? joinYear + 1 : joinYear;
                const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
                whereClause = ' WHERE date(c.join_date) >= date(?) AND date(c.join_date) < date(?)';
                params.push(startDate, endDate);
            }

            const sql = `
                SELECT c.*, p.name as package_name, p.price as package_price, p.image as package_image, p.tax_rate,
                       c.latitude, c.longitude,
                        r.name as router_name,
                       COALESCE(col_ca.name, col_cra.name) as collector_name,
                       CASE 
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'unpaid' 
                               AND i.due_date < date('now','localtime')
                           ) THEN 'overdue'
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'unpaid'
                           ) THEN 'unpaid'
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'paid'
                           ) THEN 'paid'
                           ELSE 'no_invoice'
                       END as payment_status
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id
                LEFT JOIN customer_router_map m ON m.customer_id = c.id
                LEFT JOIN routers r ON r.id = m.router_id
                LEFT JOIN collector_assignments ca ON ca.customer_id = c.id
                LEFT JOIN collectors col_ca ON col_ca.id = ca.collector_id
                LEFT JOIN collector_areas cra ON (c.area IS NOT NULL AND c.area != '' AND c.area = cra.area)
                LEFT JOIN collectors col_cra ON col_cra.id = cra.collector_id
                ${whereClause}
                ORDER BY c.join_date ASC, c.name ASC
            `;
            
            this.db.all(sql, params, async (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    // Calculate price with tax for each customer
                    let processedRows = rows.map(row => {
                        if (row.package_price && row.tax_rate !== null) {
                            row.package_price = this.calculatePriceWithTax(row.package_price, row.tax_rate);
                        }
                        return row;
                    });
                    
                    // Jika menggunakan RADIUS mode, ambil profil dari RADIUS untuk customer yang punya pppoe_username
                    try {
                        const { getUserAuthModeAsync, getRadiusConnection } = require('./mikrotik');
                        const authMode = await getUserAuthModeAsync();
                        
                        if (authMode === 'radius') {
                            const radiusConn = await getRadiusConnection();
                            
                            // Kumpulkan semua pppoe_username yang valid
                            const pppUsers = processedRows
                                .map(c => (c.pppoe_username && String(c.pppoe_username).trim()) || (c.username && String(c.username).trim()))
                                .filter(u => u && u.length > 0);
                            
                            if (pppUsers.length > 0) {
                                // Batch query: ambil semua group sekaligus
                                const placeholders = pppUsers.map(() => '?').join(',');
                                const [allGroups] = await radiusConn.execute(
                                    `SELECT username, groupname FROM radusergroup WHERE username IN (${placeholders})`,
                                    pppUsers
                                );
                                
                                // Buat map untuk lookup cepat
                                // Jika user punya multiple groups, ambil yang pertama (biasanya hanya satu group per user)
                                const profileMap = new Map();
                                allGroups.forEach(g => {
                                    // Set group pertama yang ditemukan untuk setiap username
                                    // Jika ada multiple, yang terakhir akan menang (tapi seharusnya hanya satu)
                                    profileMap.set(g.username, g.groupname);
                                });
                                
                                // Update profil untuk setiap customer
                                processedRows.forEach(customer => {
                                    const pppUser = (customer.pppoe_username && String(customer.pppoe_username).trim()) || 
                                                   (customer.username && String(customer.username).trim());
                                    
                                    if (pppUser && profileMap.has(pppUser)) {
                                        // Gunakan profil dari RADIUS (ini adalah profil yang sebenarnya digunakan)
                                        customer.pppoe_profile = profileMap.get(pppUser);
                                        customer.pppoe_profile_source = 'radius'; // Flag untuk tracking
                                    }
                                });
                            }
                            
                            await radiusConn.end();
                        }
                    } catch (authError) {
                        // Jika error saat cek auth mode, tetap gunakan dari billing database
                        // logger.warn(`Failed to check auth mode or get RADIUS profiles: ${authError.message}`);
                    }
                    
                    resolve(processedRows);
                }
            });
        });
    }

    
    async getCustomerStatsByMonth(month, year, filters = {}) {
        const m = parseInt(String(month), 10);
        const y = parseInt(String(year), 10);
        const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
        const nextMonth = m === 12 ? 1 : m + 1;
        const nextYear = m === 12 ? y + 1 : y;
        const cohortEnd = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
        const endDateLast = new Date(y, m, 0).toISOString().split('T')[0];

        const monthStr = String(m).padStart(2, '0');
        const yearStr = String(y);

        let filterJoins = '';
        let filterWhere = '';
        const filterParams = [];

        if (filters.search) {
            filterWhere += ' AND (c.name LIKE ? OR c.phone LIKE ? OR c.pppoe_username LIKE ?)';
            const searchTerm = `%${filters.search}%`;
            filterParams.push(searchTerm, searchTerm, searchTerm);
        }
        if (filters.package_id) {
            filterWhere += ' AND c.package_id = ?';
            filterParams.push(filters.package_id);
        }
        if (filters.area) {
            filterWhere += ' AND c.area = ?';
            filterParams.push(filters.area);
        }
        if (filters.collector_id) {
            filterJoins += ' LEFT JOIN collector_assignments ca ON ca.customer_id = c.id';
            filterJoins += ' LEFT JOIN collector_areas cra ON (c.area IS NOT NULL AND c.area != "" AND c.area = cra.area)';
            filterWhere += ' AND (ca.collector_id = ? OR cra.collector_id = ?)';
            filterParams.push(filters.collector_id, filters.collector_id);
        }

        const fjSub = filterJoins.replace(/ ca/g, ' ca_sub').replace(/ cra/g, ' cra_sub').replace(/ c\./g, ' c_sub.');
        const fwSub = filterWhere.replace(/c\./g, 'c_sub.');
        const fjSum = filterJoins.replace(/ ca/g, ' ca_sum').replace(/ cra/g, ' cra_sum').replace(/ c\./g, ' c_sum.');
        const fwSum = filterWhere.replace(/c\./g, 'c_sum.');

        const hasInvoiceType = await new Promise((resolve) => {
            this.db.all('PRAGMA table_info(invoices)', (err, cols) => {
                if (err) resolve(false);
                else resolve((cols || []).some((c) => c.name === 'invoice_type'));
            });
        });
        const voucherExcl = this._sqlInvoiceExcludeVoucher(hasInvoiceType);

        const invoiceNominalSub = (extraInvoiceWhere = '', extraCustomerWhere = '') => `(
            SELECT COALESCE(SUM(sub.amount), 0)
            FROM (
                SELECT DISTINCT i.id AS id, i.amount AS amount
                FROM invoices i
                INNER JOIN customers c_sub ON c_sub.id = i.customer_id
                ${fjSub}
                WHERE DATE(i.created_at) >= ? AND DATE(i.created_at) <= ?
                  AND ${voucherExcl}
                  AND date(c_sub.join_date) < date(?)
                  ${extraInvoiceWhere}
                  ${extraCustomerWhere}
                  ${fwSub}
            ) sub
        )`;

        const nominalBaseParams = [startDate, endDateLast, cohortEnd, ...filterParams];

        /** Total paket (harga + pajak) per pelanggan — selaras penghitungan kartu Total / Isolir. */
        const packageNominalSub = (extraCustomerWhere = '') => `(
            SELECT COALESCE(SUM(line_amt), 0)
            FROM (
                SELECT c_sum.id AS id,
                    MAX(CASE WHEN p_sum.price IS NOT NULL
                        THEN CAST(ROUND(p_sum.price * (1.0 + COALESCE(p_sum.tax_rate, 0) / 100.0)) AS INTEGER)
                        ELSE 0 END) AS line_amt
                FROM customers c_sum
                LEFT JOIN packages p_sum ON p_sum.id = c_sum.package_id
                ${fjSum}
                WHERE date(c_sum.join_date) < date(?)
                ${extraCustomerWhere}
                ${fwSum}
                GROUP BY c_sum.id
            )
        )`;

        const sql = `
            SELECT 
                COUNT(DISTINCT c.id) as total,
                SUM(CASE WHEN c.status = 'active' THEN 1 ELSE 0 END) as aktif,
                SUM(CASE WHEN c.status = 'suspended' OR c.status = 'isolir' THEN 1 ELSE 0 END) as nonaktif,
                SUM(CASE WHEN date(c.join_date) >= date(?) AND date(c.join_date) < date(?) THEN 1 ELSE 0 END) as baru,
                (
                    SELECT COUNT(DISTINCT i.customer_id) 
                    FROM invoices i 
                    JOIN customers c_sub ON c_sub.id = i.customer_id
                    ${fjSub}
                    WHERE strftime('%m', i.created_at) = ? AND strftime('%Y', i.created_at) = ? AND i.status = 'paid'
                    ${fwSub}
                ) as lunas,
                (
                    SELECT COUNT(DISTINCT c2.id) 
                    FROM customers c2 
                    ${filterJoins.replace(/ ca/g, ' ca2').replace(/ cra/g, ' cra2').replace(/ c\./g, ' c2.')}
                    WHERE date(c2.join_date) < date(?)
                    AND NOT EXISTS (
                        SELECT 1 FROM invoices i 
                        WHERE i.customer_id = c2.id 
                        AND strftime('%m', i.created_at) = ? AND strftime('%Y', i.created_at) = ? AND i.status = 'paid'
                    )
                    ${filterWhere.replace(/c\./g, 'c2.')}
                ) as belum_lunas,
                ${packageNominalSub()} AS total_nominal,
                ${invoiceNominalSub("AND i.status IN ('paid', 'unpaid')", " AND c_sub.status = 'active'")} AS aktif_nominal,
                ${packageNominalSub(" AND (c_sum.status = 'suspended' OR c_sum.status = 'isolir')")} AS nonaktif_nominal,
                ${invoiceNominalSub("AND i.status = 'paid'")} AS lunas_nominal,
                ${invoiceNominalSub("AND i.status = 'unpaid'")} AS belum_lunas_nominal,
                ${packageNominalSub(' AND date(c_sum.join_date) >= date(?) AND date(c_sum.join_date) < date(?)')} AS baru_nominal
            FROM customers c
            ${filterJoins}
            WHERE date(c.join_date) < date(?) ${filterWhere}
        `;

        const params = [
            startDate, cohortEnd,
            monthStr, yearStr, ...filterParams,
            cohortEnd, monthStr, yearStr, ...filterParams,
            cohortEnd, ...filterParams,
            ...nominalBaseParams,
            cohortEnd, ...filterParams,
            ...nominalBaseParams,
            ...nominalBaseParams,
            cohortEnd, startDate, cohortEnd, ...filterParams,
            cohortEnd, ...filterParams
        ];

        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve({
                        total: (row && row.total) ? row.total : 0,
                        aktif: (row && row.aktif) ? row.aktif : 0,
                        nonaktif: (row && row.nonaktif) ? row.nonaktif : 0,
                        lunas: (row && row.lunas) ? row.lunas : 0,
                        belum_lunas: (row && row.belum_lunas) ? row.belum_lunas : 0,
                        baru: (row && row.baru) ? row.baru : 0,
                        total_nominal: Number(row && row.total_nominal) || 0,
                        aktif_nominal: Number(row && row.aktif_nominal) || 0,
                        nonaktif_nominal: Number(row && row.nonaktif_nominal) || 0,
                        lunas_nominal: Number(row && row.lunas_nominal) || 0,
                        belum_lunas_nominal: Number(row && row.belum_lunas_nominal) || 0,
                        baru_nominal: Number(row && row.baru_nominal) || 0
                    });
                }
            });
        });
    }

    // OPTIMASI: Get customers dengan pagination untuk menghindari load semua data sekaligus

    async getCustomersPaginated(limit = 50, offset = 0, filters = {}) {
        return new Promise(async (resolve, reject) => {
            // Build WHERE clause dari filters
            let whereClause = '';
            const params = [];
            
            if (filters.status) {
                whereClause += ' AND c.status = ?';
                params.push(filters.status);
            }
            
            if (filters.search) {
                whereClause += ' AND (c.name LIKE ? OR c.phone LIKE ? OR c.pppoe_username LIKE ?)';
                const searchTerm = `%${filters.search}%`;
                params.push(searchTerm, searchTerm, searchTerm);
            }
            
            if (filters.package_id) {
                whereClause += ' AND c.package_id = ?';
                params.push(filters.package_id);
            }

            if (filters.area) {
                whereClause += ' AND c.area = ?';
                params.push(filters.area);
            }

            if (filters.collector_id) {
                whereClause += ' AND (ca.collector_id = ? OR cra.collector_id = ?)';
                params.push(filters.collector_id, filters.collector_id);
            }

            if (filters.year && filters.month) {
                const year = filters.year;
                const month = String(filters.month).padStart(2, '0');
                const nextMonth = month === '12' ? '01' : String(parseInt(month) + 1).padStart(2, '0');
                const nextYear = month === '12' ? String(parseInt(year) + 1) : year;
                const startDate = `${year}-${month}-01`;
                const endDate = `${nextYear}-${nextMonth}-01`;

                whereClause += ' AND date(c.join_date) < date(?)';
                params.push(endDate);

                if (filters.customer_type === 'baru') {
                    whereClause += ' AND date(c.join_date) >= date(?)';
                    params.push(startDate);
                } else if (filters.customer_type === 'aktif') {
                    whereClause += " AND c.status = 'active'";
                } else if (filters.customer_type === 'nonaktif') {
                    whereClause += " AND (c.status = 'suspended' OR c.status = 'isolir')";
                }

                if (filters.payment_status === 'paid') {
                    whereClause += ` AND EXISTS (
                        SELECT 1 FROM invoices i 
                        WHERE i.customer_id = c.id 
                        AND strftime('%m', i.created_at) = ? AND strftime('%Y', i.created_at) = ? AND i.status = 'paid'
                    )`;
                    params.push(month, String(year));
                } else if (filters.payment_status === 'unpaid') {
                    whereClause += ` AND NOT EXISTS (
                        SELECT 1 FROM invoices i 
                        WHERE i.customer_id = c.id 
                        AND strftime('%m', i.created_at) = ? AND strftime('%Y', i.created_at) = ? AND i.status = 'paid'
                    )`;
                    params.push(month, String(year));
                }
            } else {
                if (filters.customer_type === 'aktif') {
                    whereClause += " AND c.status = 'active'";
                } else if (filters.customer_type === 'nonaktif') {
                    whereClause += " AND (c.status = 'suspended' OR c.status = 'isolir')";
                }
                
                // Filter status pembayaran (Lunas/Belum Lunas) Default
                if (filters.payment_status === 'paid') {
                    whereClause += ` AND NOT EXISTS (
                        SELECT 1 FROM invoices i 
                        WHERE i.customer_id = c.id 
                        AND i.status = 'unpaid'
                    ) AND EXISTS (
                        SELECT 1 FROM invoices i 
                        WHERE i.customer_id = c.id 
                        AND i.status = 'paid'
                    )`;
                } else if (filters.payment_status === 'unpaid') {
                    whereClause += ` AND (
                        EXISTS (
                            SELECT 1 FROM invoices i 
                            WHERE i.customer_id = c.id 
                            AND i.status = 'unpaid'
                        ) 
                        OR NOT EXISTS (
                            SELECT 1 FROM invoices i 
                            WHERE i.customer_id = c.id 
                            AND i.status = 'paid'
                        )
                    )`;
                }
            }

            const sql = `
                SELECT c.*, p.name as package_name, p.price as package_price, p.image as package_image, p.tax_rate,
                       c.latitude, c.longitude,
                       r.name as router_name,
                       COALESCE(col_ca.name, col_cra.name) as collector_name,
                       CASE 
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'unpaid' 
                               AND i.due_date < date('now','localtime')
                           ) THEN 'overdue'
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'unpaid'
                           ) THEN 'unpaid'
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'paid'
                           ) THEN 'paid'
                           ELSE 'no_invoice'
                       END as payment_status
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id
                LEFT JOIN customer_router_map m ON m.customer_id = c.id
                LEFT JOIN routers r ON r.id = m.router_id
                LEFT JOIN collector_assignments ca ON ca.customer_id = c.id
                LEFT JOIN collectors col_ca ON col_ca.id = ca.collector_id
                LEFT JOIN collector_areas cra ON (c.area IS NOT NULL AND c.area != '' AND c.area = cra.area)
                LEFT JOIN collectors col_cra ON col_cra.id = cra.collector_id
                WHERE 1=1 ${whereClause}
                ORDER BY c.id DESC
                LIMIT ? OFFSET ?
            `;
            
            const queryParams = [...params, limit, offset];
            
            // Get total count untuk pagination
            const countSql = `
                SELECT COUNT(DISTINCT c.id) as total
                FROM customers c
                LEFT JOIN customer_router_map m ON m.customer_id = c.id
                LEFT JOIN collector_assignments ca ON ca.customer_id = c.id
                LEFT JOIN collector_areas cra ON (c.area IS NOT NULL AND c.area != '' AND c.area = cra.area)
                WHERE 1=1 ${whereClause}
            `;
            
            this.db.get(countSql, params, async (err, countRow) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                const totalCount = countRow ? countRow.total : 0;
                
                this.db.all(sql, queryParams, async (err, rows) => {
                    if (err) {
                        reject(err);
                    } else {
                        // Calculate price with tax for each customer
                        let processedRows = rows.map(row => {
                            if (row.package_price && row.tax_rate !== null) {
                                row.package_price = this.calculatePriceWithTax(row.package_price, row.tax_rate);
                            }
                            return row;
                        });
                        
                        // Jika menggunakan RADIUS mode, ambil profil dari RADIUS untuk customer yang punya pppoe_username
                        try {
                            const { getUserAuthModeAsync, getRadiusConnection } = require('./mikrotik');
                            const authMode = await getUserAuthModeAsync();
                            
                            if (authMode === 'radius' && processedRows.length > 0) {
                                const radiusConn = await getRadiusConnection();
                                
                                // Kumpulkan semua pppoe_username yang valid
                                const pppUsers = processedRows
                                    .map(c => (c.pppoe_username && String(c.pppoe_username).trim()) || (c.username && String(c.username).trim()))
                                    .filter(u => u && u.length > 0);
                                
                                if (pppUsers.length > 0) {
                                    // Batch query: ambil semua group sekaligus
                                    const placeholders = pppUsers.map(() => '?').join(',');
                                    const [allGroups] = await radiusConn.execute(
                                        `SELECT username, groupname FROM radusergroup WHERE username IN (${placeholders})`,
                                        pppUsers
                                    );
                                    
                                    // Buat map untuk lookup cepat
                                    const profileMap = new Map();
                                    allGroups.forEach(g => {
                                        profileMap.set(g.username, g.groupname);
                                    });
                                    
                                    // Update profil untuk setiap customer
                                    processedRows.forEach(customer => {
                                        const pppUser = (customer.pppoe_username && String(customer.pppoe_username).trim()) || 
                                                       (customer.username && String(customer.username).trim());
                                        
                                        if (pppUser && profileMap.has(pppUser)) {
                                            customer.pppoe_profile = profileMap.get(pppUser);
                                            customer.pppoe_profile_source = 'radius';
                                        }
                                    });
                                }
                                
                                await radiusConn.end();
                            }
                        } catch (authError) {
                            // Jika error saat cek auth mode, tetap gunakan dari billing database
                        }
                        
                        resolve({
                            customers: processedRows,
                            totalCount: totalCount,
                            page: Math.floor(offset / limit) + 1,
                            totalPages: Math.ceil(totalCount / limit),
                            limit: limit,
                            offset: offset
                        });
                    }
                });
            });
        });
    }

    async getCustomerByUsername(username) {
        return new Promise((resolve, reject) => {
            // Cari di kedua kolom: username dan pppoe_username
            const sql = `
                SELECT c.*, p.name as package_name, p.price as package_price, p.speed as package_speed, p.image as package_image, p.tax_rate, p.pppoe_profile as package_pppoe_profile
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE c.username = ? OR c.pppoe_username = ?
            `;
            
            this.db.get(sql, [username, username], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    if (row && row.package_price && row.tax_rate !== null) {
                        // Calculate price with tax for customer display
                        row.package_price = this.calculatePriceWithTax(row.package_price, row.tax_rate);
                    }
                    resolve(row);
                }
            });
        });
    }

    // Search customers by name, phone, username, PPPoE, atau ID pelanggan (6 digit)
    async searchCustomers(searchTerm) {
        return new Promise((resolve, reject) => {
            const searchPattern = `%${searchTerm}%`;

            // Skema customers memakai join_date (bukan created_at/updated_at)
            const sql = `
                SELECT c.id, c.customer_id, c.username, c.password, c.name, c.phone, c.email, c.address,
                       c.pppoe_username, c.package_id, c.status, c.join_date,
                       p.name AS package_name
                FROM customers c
                LEFT JOIN packages p ON c.package_id = p.id
                WHERE c.name LIKE ? OR c.phone LIKE ? OR c.username LIKE ? OR c.pppoe_username LIKE ?
                   OR (c.customer_id IS NOT NULL AND TRIM(CAST(c.customer_id AS TEXT)) != '' AND CAST(c.customer_id AS TEXT) LIKE ?)
                ORDER BY c.name ASC
                LIMIT 20
            `;

            this.db.all(
                sql,
                [searchPattern, searchPattern, searchPattern, searchPattern, searchPattern],
                (err, rows) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(rows || []);
                    }
                }
            );
        });
    }

    // Get customer by ID
    async getCustomerById(id) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT c.*, p.name as package_name, p.speed, p.price, p.image as package_image, p.tax_rate
                FROM customers c
                LEFT JOIN packages p ON c.package_id = p.id
                WHERE c.id = ?
            `;
            
            this.db.get(sql, [id], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    // Get customer by customer_id (6 digit ID)
    async getCustomerByCustomerId(customerId) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT c.*, p.name as package_name, p.price as package_price, p.speed as package_speed, p.image as package_image, p.tax_rate
                FROM customers c
                LEFT JOIN packages p ON c.package_id = p.id
                WHERE c.customer_id = ?
            `;
            
            this.db.get(sql, [customerId], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    async getCustomerByPhone(phone) {
        return new Promise((resolve, reject) => {
            try {
                const variants = this.getIndonesianPhoneLookupVariants(phone);
                if (!variants.length) {
                    resolve(null);
                    return;
                }
                const placeholders = variants.map(() => '?').join(', ');

                const sql = `
                SELECT c.*, p.name as package_name, p.price as package_price, p.speed as package_speed, p.image as package_image, p.tax_rate,
                       CASE 
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'unpaid' 
                               AND i.due_date < date('now','localtime')
                           ) THEN 'overdue'
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'unpaid'
                           ) THEN 'unpaid'
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'paid'
                           ) THEN 'paid'
                           ELSE 'no_invoice'
                       END as payment_status
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE c.phone IN (${placeholders})
            `;

                this.db.get(sql, variants, (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        if (row && row.package_price && row.tax_rate !== null) {
                            // Calculate price with tax for customer display
                            row.package_price = this.calculatePriceWithTax(row.package_price, row.tax_rate);
                        }
                        resolve(row || null);
                    }
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    async getCustomerByNameOrPhone(searchTerm) {
        return new Promise((resolve, reject) => {
            // Bersihkan nomor telefon (hapus karakter non-digit)
            const cleanPhone = searchTerm.replace(/\D/g, '');
            
            const sql = `
                SELECT c.*, p.name as package_name, p.price as package_price, p.speed as package_speed, p.tax_rate,
                       CASE 
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'unpaid' 
                               AND i.due_date < date('now','localtime')
                           ) THEN 'overdue'
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'unpaid'
                           ) THEN 'unpaid'
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'paid'
                           ) THEN 'paid'
                           ELSE 'no_invoice'
                       END as payment_status
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE c.phone = ? 
                   OR c.name LIKE ? 
                   OR c.username LIKE ?
                ORDER BY 
                    CASE 
                        WHEN c.phone = ? THEN 1
                        WHEN c.name = ? THEN 2
                        WHEN c.name LIKE ? THEN 3
                        WHEN c.username LIKE ? THEN 4
                        ELSE 5
                    END
                LIMIT 1
            `;
            
            const likeTerm = `%${searchTerm}%`;
            const params = [
                cleanPhone,           // Exact phone match
                likeTerm,            // Name LIKE
                likeTerm,            // Username LIKE
                cleanPhone,          // ORDER BY phone exact
                searchTerm,          // ORDER BY name exact
                `${searchTerm}%`,    // ORDER BY name starts with
                likeTerm             // ORDER BY username LIKE
            ];
            
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    if (row && row.package_price && row.tax_rate !== null) {
                        // Calculate price with tax for customer display
                        row.package_price = this.calculatePriceWithTax(row.package_price, row.tax_rate);
                    }
                    resolve(row);
                }
            });
        });
    }

    async findCustomersByNameOrPhone(searchTerm) {
        return new Promise((resolve, reject) => {
            // Bersihkan nomor telefon (hapus karakter non-digit) 
            const cleanPhone = searchTerm.replace(/\D/g, '');
            
            const sql = `
                SELECT c.*, p.name as package_name, p.price as package_price, p.speed as package_speed,
                       CASE 
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'unpaid' 
                               AND i.due_date < date('now','localtime')
                           ) THEN 'overdue'
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'unpaid'
                           ) THEN 'unpaid'
                           WHEN EXISTS (
                               SELECT 1 FROM invoices i 
                               WHERE i.customer_id = c.id 
                               AND i.status = 'paid'
                           ) THEN 'paid'
                           ELSE 'no_invoice'
                       END as payment_status
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE c.phone = ? 
                   OR c.name LIKE ? 
                   OR c.username LIKE ?
                ORDER BY 
                    CASE 
                        WHEN c.phone = ? THEN 1
                        WHEN c.name = ? THEN 2
                        WHEN c.name LIKE ? THEN 3
                        WHEN c.username LIKE ? THEN 4
                        ELSE 5
                    END
                LIMIT 5
            `;
            
            const likeTerm = `%${searchTerm}%`;
            const params = [
                cleanPhone,           // Exact phone match
                likeTerm,            // Name LIKE
                likeTerm,            // Username LIKE
                cleanPhone,          // ORDER BY phone exact
                searchTerm,          // ORDER BY name exact
                `${searchTerm}%`,    // ORDER BY name starts with
                likeTerm             // ORDER BY username LIKE
            ];
            
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async updateCustomer(phone, customerData) {
        return this.updateCustomerByPhone(phone, customerData);
    }

    async updateCustomerByPhone(oldPhone, customerData) {
        return new Promise(async (resolve, reject) => {
            // Pastikan database sudah siap
            if (!this.db) {
                console.error('Database not initialized');
                return reject(new Error('Database not initialized'));
            }
            
            // Simpan reference database untuk digunakan di callback
            const db = this.db;
            const skipExternalSync = Boolean(customerData && customerData.__skip_external_sync);
            const skipGenieacsSync = skipExternalSync || Boolean(customerData && customerData.__skip_genieacs_sync);
            const skipRadiusSync = skipExternalSync || Boolean(customerData && customerData.__skip_radius_sync);
            
            const { name, username, password, phone, pppoe_username, email, address, area, package_id, odp_id, pppoe_profile, status, auto_suspension, billing_day, renewal_type, fix_date, latitude, longitude, cable_type, cable_length, port_number, cable_status, cable_notes, ktp_photo_path, house_photo_path } = customerData;
            
            // Dapatkan data customer lama untuk membandingkan nomor telepon
            try {
                const oldCustomer = await this.getCustomerByPhone(oldPhone);
                if (!oldCustomer) {
                    return reject(new Error('Pelanggan tidak ditemukan'));
                }
                
                const oldPPPoE = oldCustomer ? oldCustomer.pppoe_username : null;
                
                // Normalisasi billing_day (1-28) dengan fallback ke nilai lama atau 15
                const normBillingDay = Math.min(Math.max(parseInt(billing_day !== undefined ? billing_day : (oldCustomer?.billing_day ?? 15), 10) || 15, 1), 28);
                
                // Normalisasi renewal_type dan fix_date
                const normRenewalType = renewal_type || oldCustomer.renewal_type || 'renewal';
                const normFixDate = renewal_type === 'fix_date' ? 
                    (fix_date !== undefined ? Math.min(Math.max(parseInt(fix_date, 10) || 15, 1), 28) : (oldCustomer.fix_date || 15)) : 
                    null;
                
                let sql = `UPDATE customers SET name = ?, username = ?, phone = ?, pppoe_username = ?, email = ?, address = ?, area = ?, area_id = ?, package_id = ?, odp_id = ?, pppoe_profile = ?, status = ?, auto_suspension = ?, billing_day = ?, renewal_type = ?, fix_date = ?, latitude = ?, longitude = ?, cable_type = ?, cable_length = ?, port_number = ?, cable_status = ?, cable_notes = ?, ktp_photo_path = ?, house_photo_path = ?`;
                let params = [
                    name !== undefined ? name : oldCustomer.name, 
                    username || oldCustomer.username, 
                    phone || oldPhone, 
                    pppoe_username !== undefined ? pppoe_username : oldCustomer.pppoe_username, 
                    email !== undefined ? email : oldCustomer.email, 
                    address !== undefined ? address : oldCustomer.address, 
                    area !== undefined ? area : oldCustomer.area,
                    customerData.area_id !== undefined ? customerData.area_id : oldCustomer.area_id,
                    package_id !== undefined ? package_id : oldCustomer.package_id, 
                    odp_id !== undefined ? odp_id : oldCustomer.odp_id,
                    pppoe_profile !== undefined ? pppoe_profile : oldCustomer.pppoe_profile, 
                    status !== undefined ? status : oldCustomer.status, 
                    auto_suspension !== undefined ? auto_suspension : oldCustomer.auto_suspension, 
                    normBillingDay,
                    normRenewalType,
                    normFixDate,
                    latitude !== undefined ? parseFloat(latitude) : oldCustomer.latitude,
                    longitude !== undefined ? parseFloat(longitude) : oldCustomer.longitude,
                    cable_type !== undefined ? cable_type : oldCustomer.cable_type,
                    cable_length !== undefined ? cable_length : oldCustomer.cable_length,
                    port_number !== undefined ? port_number : oldCustomer.port_number,
                    cable_status !== undefined ? cable_status : oldCustomer.cable_status,
                    cable_notes !== undefined ? cable_notes : oldCustomer.cable_notes,
                    ktp_photo_path !== undefined ? ktp_photo_path : oldCustomer.ktp_photo_path,
                    house_photo_path !== undefined ? house_photo_path : oldCustomer.house_photo_path
                ];

                if (password !== undefined) {
                    sql += `, password = ?`;
                    params.push(password);
                }

                sql += ` WHERE id = ?`;
                params.push(oldCustomer.id);
                
                db.run(sql, params, async function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        // Jika nomor telepon atau PPPoE username berubah, update tag di GenieACS
                        const newPhone = phone || oldPhone;
                        if (!skipGenieacsSync && newPhone && (newPhone !== oldPhone || pppoe_username !== oldPPPoE)) {
                            try {
                                // Timeout untuk operasi GenieACS
                                const genieacsPromise = new Promise(async (resolve, reject) => {
                                    const timeout = setTimeout(() => reject(new Error('GenieACS operation timeout')), 3000); // 3 second timeout
                                    
                                    try {
                                        const genieacs = require('./genieacs');
                                        
                                        // Hapus tag lama jika ada
                                        if (oldPhone && oldPPPoE) {
                                            try {
                                                const oldDevice = await genieacs.findDeviceByPPPoE(oldPPPoE);
                                                if (oldDevice) {
                                                    await genieacs.removeTagFromDevice(oldDevice._id, oldPhone);
                                                    console.log(`Removed old phone tag ${oldPhone} from device ${oldDevice._id} for customer ${oldCustomer.username}`);
                                                }
                                            } catch (error) {
                                                console.warn(`Error removing old phone tag for customer ${oldCustomer.username}:`, error.message);
                                            }
                                        }
                                        
                                        // Tambahkan tag baru
                                        const pppoeToUse = pppoe_username || oldCustomer.username; // Fallback ke username jika pppoe_username kosong
                                        const device = await genieacs.findDeviceByPPPoE(pppoeToUse);
                                        
                                        if (device) {
                                            await genieacs.addTagToDevice(device._id, newPhone);
                                            console.log(`Successfully updated phone tag to ${newPhone} for device ${device._id} and customer ${oldCustomer.username} (PPPoE: ${pppoeToUse})`);
                                        } else {
                                            console.warn(`No device found with PPPoE Username ${pppoeToUse} for customer ${oldCustomer.username}`);
                                        }
                                        clearTimeout(timeout);
                                        resolve();
                                    } catch (genieacsError) {
                                        clearTimeout(timeout);
                                        reject(genieacsError);
                                    }
                                });
                                
                                await genieacsPromise;
                            } catch (genieacsError) {
                                console.error(`Error updating phone tag in GenieACS for customer ${oldCustomer.username} (timeout or error):`, genieacsError.message);
                                // Jangan reject, karena customer sudah berhasil diupdate di billing
                            }
                        }
                        
                        // Jika ada data ODP atau field kabel yang berubah, update cable route
                        if (
                            odp_id !== undefined ||
                            cable_type !== undefined ||
                            cable_length !== undefined ||
                            port_number !== undefined ||
                            cable_status !== undefined ||
                            cable_notes !== undefined
                        ) {
                            console.log(`🔧 Updating cable route for customer ${oldCustomer.username}, odp_id: ${odp_id}, cable_type: ${cable_type}`);
                            try {
                                const customerId = oldCustomer.id;
                                
                                // Cari cable route yang ada
                                const existingRoute = await new Promise((resolve, reject) => {
                                    db.get('SELECT * FROM cable_routes WHERE customer_id = ?', [customerId], (err, row) => {
                                        if (err) reject(err);
                                        else resolve(row);
                                    });
                                });
                                
                                if (existingRoute) {
                                    // Update cable route yang ada
                                    console.log(`📝 Found existing cable route for customer ${oldCustomer.username}, updating...`);
                                    console.log(`🔧 ODP: ${odp_id !== undefined ? odp_id : existingRoute.odp_id}, Port: ${port_number !== undefined ? port_number : existingRoute.port_number}`);
                                    const updateSql = `
                                        UPDATE cable_routes 
                                        SET odp_id = ?, cable_type = ?, cable_length = ?, port_number = ?, status = ?, notes = ?, updated_at = datetime('now','localtime')
                                        WHERE customer_id = ?
                                    `;
                                    
                                    db.run(updateSql, [
                                        odp_id !== undefined ? odp_id : existingRoute.odp_id,
                                        cable_type !== undefined ? cable_type : existingRoute.cable_type,
                                        cable_length !== undefined ? cable_length : existingRoute.cable_length,
                                        port_number !== undefined ? port_number : existingRoute.port_number,
                                        cable_status !== undefined ? cable_status : existingRoute.status,
                                        cable_notes !== undefined ? cable_notes : existingRoute.notes,
                                        customerId
                                    ], function(err) {
                                        if (err) {
                                            console.error(`❌ Error updating cable route for customer ${oldCustomer.username}:`, err.message);
                                        } else {
                                            console.log(`✅ Successfully updated cable route for customer ${oldCustomer.username}`);
                                        }
                                    });
                                } else if (odp_id) {
                                    // Buat cable route baru jika belum ada
                                    console.log(`📝 Creating new cable route for customer ${oldCustomer.username}...`);
                                    const cableRouteSql = `
                                        INSERT INTO cable_routes (customer_id, odp_id, cable_type, cable_length, port_number, status, notes)
                                        VALUES (?, ?, ?, ?, ?, ?, ?)
                                    `;
                                    
                                    db.run(cableRouteSql, [
                                        customerId,
                                        odp_id,
                                        cable_type || 'Fiber Optic',
                                        cable_length || 0,
                                        port_number || 1,
                                        cable_status || 'connected',
                                        cable_notes || `Auto-created for customer ${name}`
                                    ], function(err) {
                                        if (err) {
                                            console.error(`❌ Error creating cable route for customer ${oldCustomer.username}:`, err.message);
                                        } else {
                                            console.log(`✅ Successfully created cable route for customer ${oldCustomer.username}`);
                                        }
                                    });
                                }
                            } catch (cableError) {
                                console.error(`❌ Error handling cable route for customer ${oldCustomer.username}:`, cableError.message);
                                // Jangan reject, karena customer sudah berhasil diupdate di billing
                            }
                        }
                        
                        if (!skipRadiusSync) {
                            try {
                                const finalPPPoEUsername = pppoe_username !== undefined ? pppoe_username : oldCustomer.pppoe_username;
                                const finalUsername = username || oldCustomer.username;
                                const radiusSyncResult = await syncCustomerToRadius({
                                    ...oldCustomer,
                                    ...customerData,
                                    username: finalUsername,
                                    pppoe_username: finalPPPoEUsername
                                }, customerData);
                                if (!radiusSyncResult.success && !radiusSyncResult.skipped) {
                                    logger.warn(`[BILLING] RADIUS sync update warning for ${finalPPPoEUsername || finalUsername}: ${radiusSyncResult.message}`);
                                }
                            } catch (radiusSyncError) {
                                logger.warn(`[BILLING] RADIUS sync update error for ${oldCustomer.username}: ${radiusSyncError.message}`);
                            }
                        }

                        resolve({ username: oldCustomer.username, ...customerData });
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    async deleteCustomer(phone) {
        return new Promise(async (resolve, reject) => {
            try {
                // Dapatkan data customer sebelum dihapus
                const customer = await this.getCustomerByPhone(phone);
                if (!customer) {
                    reject(new Error('Pelanggan tidak ditemukan'));
                    return;
                }

                const db = this.db;
                const customerId = customer.id;

                const runQuery = (sql, params = []) => {
                    return new Promise((res) => {
                        db.run(sql, params, function(err) {
                            if (err) console.warn(`⚠️ Error executing clean up query for customer ${customer.username}:`, err.message);
                            res();
                        });
                    });
                };

                // Hapus semua data terkait untuk menghindari FOREIGN KEY constraint error
                await runQuery(`DELETE FROM invoices WHERE customer_id = ?`, [customerId]);
                await runQuery(`DELETE FROM cable_routes WHERE customer_id = ?`, [customerId]);
                await runQuery(`DELETE FROM trouble_reports WHERE phone = ?`, [customer.phone]);
                await runQuery(`DELETE FROM collector_assignments WHERE customer_id = ?`, [customerId]);
                await runQuery(`DELETE FROM collector_transactions WHERE customer_id = ?`, [customerId]);
                await runQuery(`DELETE FROM agent_customers WHERE customer_id = ?`, [customerId]);
                await runQuery(`DELETE FROM agent_transactions WHERE customer_id = ?`, [customerId]);
                await runQuery(`DELETE FROM installation_jobs WHERE customer_id = ?`, [customerId]);

                // Hapus customer
                db.run(`DELETE FROM customers WHERE phone = ?`, [phone], async function(err) {
                    if (err) {
                        return reject(err);
                    }
                    
                    // Hapus tag dari GenieACS jika ada nomor telepon
                    if (customer.phone) {
                        try {
                            const genieacs = require('./genieacs');
                            const pppoeToUse = customer.pppoe_username || customer.username;
                            const device = await genieacs.findDeviceByPPPoE(pppoeToUse);
                            if (device) {
                                await genieacs.removeTagFromDevice(device._id, customer.phone);
                                console.log(`Removed phone tag ${customer.phone} from GenieACS device ${device._id}`);
                            }
                        } catch (genieacsError) {
                            console.warn(`GenieACS cleanup skipped for ${customer.username}:`, genieacsError.message);
                        }
                    }
                    
                    // Hapus user PPPoE dari Mikrotik/RADIUS
                    try {
                        const { deletePPPoEUser } = require('./mikrotik');
                        const pppoeToUse = customer.pppoe_username || customer.username;
                        if (pppoeToUse) {
                            await deletePPPoEUser(pppoeToUse);
                            console.log(`✅ Deleted PPPoE user ${pppoeToUse} for customer ${customer.username}`);
                        }
                    } catch (pppoeError) {
                        console.warn(`⚠️ PPPoE deletion failed or skipped for ${customer.username}:`, pppoeError.message);
                    }
                    
                    resolve({ username: customer.username, deleted: true });
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    async deleteCustomerById(id) {
        return new Promise(async (resolve, reject) => {
            try {
                // Dapatkan data customer sebelum dihapus
                const customer = await this.getCustomerById(id);
                if (!customer) {
                    reject(new Error('Pelanggan tidak ditemukan'));
                    return;
                }

                const db = this.db;
                const customerId = customer.id;

                const runQuery = (sql, params = []) => {
                    return new Promise((res) => {
                        db.run(sql, params, function(err) {
                            if (err) console.warn(`⚠️ Error executing clean up query for customer ${customer.username}:`, err.message);
                            res();
                        });
                    });
                };

                // Hapus semua data terkait untuk menghindari FOREIGN KEY constraint error
                await runQuery(`DELETE FROM invoices WHERE customer_id = ?`, [customerId]);
                await runQuery(`DELETE FROM cable_routes WHERE customer_id = ?`, [customerId]);
                await runQuery(`DELETE FROM trouble_reports WHERE phone = ?`, [customer.phone]);
                await runQuery(`DELETE FROM collector_assignments WHERE customer_id = ?`, [customerId]);
                await runQuery(`DELETE FROM collector_transactions WHERE customer_id = ?`, [customerId]);
                await runQuery(`DELETE FROM agent_customers WHERE customer_id = ?`, [customerId]);
                await runQuery(`DELETE FROM agent_transactions WHERE customer_id = ?`, [customerId]);
                await runQuery(`DELETE FROM installation_jobs WHERE customer_id = ?`, [customerId]);

                // Hapus customer
                db.run(`DELETE FROM customers WHERE id = ?`, [id], async function(err) {
                    if (err) {
                        return reject(err);
                    }
                    
                    // Hapus tag dari GenieACS jika ada nomor telepon
                    if (customer.phone) {
                        try {
                            const genieacs = require('./genieacs');
                            const pppoeToUse = customer.pppoe_username || customer.username;
                            const device = await genieacs.findDeviceByPPPoE(pppoeToUse);
                            if (device) {
                                await genieacs.removeTagFromDevice(device._id, customer.phone);
                                console.log(`Removed phone tag ${customer.phone} from GenieACS device ${device._id}`);
                            }
                        } catch (genieacsError) {
                            console.warn(`GenieACS cleanup skipped for ${customer.username}:`, genieacsError.message);
                        }
                    }
                    
                    // Hapus user PPPoE dari Mikrotik/RADIUS
                    try {
                        const { deletePPPoEUser } = require('./mikrotik');
                        const pppoeToUse = customer.pppoe_username || customer.username;
                        if (pppoeToUse) {
                            await deletePPPoEUser(pppoeToUse);
                            console.log(`✅ Deleted PPPoE user ${pppoeToUse} for customer ${customer.username}`);
                        }
                    } catch (pppoeError) {
                        console.warn(`⚠️ PPPoE deletion failed or skipped for ${customer.username}:`, pppoeError.message);
                    }
                    
                    resolve({ username: customer.username, deleted: true });
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Perbaiki hanya kasus Excel: angka HP kehilangan awalan 0 (852… → 0852…).
     * Format 628… vs 085… sengaja tidak disamakan agar 2 langganan dengan "nomor sama" tetap terbeda.
     */
    fixExcelStrippedPhoneForStorage(raw) {
        let digits;
        if (raw != null && typeof raw === 'number' && Number.isFinite(raw)) {
            digits = String(Math.trunc(raw));
        } else {
            digits = String(raw ?? '').replace(/\D/g, '');
        }
        if (!digits || digits.length < 9 || digits.length > 15) return '';
        if (/^8[1-9][0-9]{7,11}$/.test(digits)) return `0${digits}`;
        return digits;
    }

    /** Varian nomor untuk pencarian saja (tidak mengubah nilai tersimpan di DB). */
    getIndonesianPhoneLookupVariants(raw) {
        const digits = String(raw ?? '').replace(/\D/g, '');
        if (!digits) return [];
        const excelFixed = this.fixExcelStrippedPhoneForStorage(digits) || digits;
        const intl = digits.startsWith('62')
            ? digits
            : (digits.startsWith('0') ? `62${digits.slice(1)}` : (/^8[1-9]/.test(digits) ? `62${digits}` : digits));
        const local08 = intl.startsWith('62') ? `0${intl.slice(2)}` : (digits.startsWith('0') ? digits : `0${digits}`);
        const bareEight = intl.startsWith('62') ? intl.slice(2) : digits;
        return Array.from(new Set([digits, excelFixed, intl, local08, bareEight].filter(Boolean)));
    }

    // Helper function to calculate price with tax
    calculatePriceWithTax(price, taxRate) {
        if (!taxRate || taxRate === 0) {
            return Math.round(price);
        }
        const amount = price * (1 + taxRate / 100);
        return Math.round(amount); // Konsisten rounding untuk menghilangkan desimal
    }

    // Invoice Management
    async createInvoice(invoiceData) {
        return new Promise((resolve, reject) => {
            const { customer_id, member_id, package_id, amount, due_date, notes, base_amount, tax_rate, invoice_type = 'monthly', package_name, description } = invoiceData;
            const invoice_number = this.generateInvoiceNumber();
            
            // Check if base_amount and tax_rate columns exist
            let sql, params;
            if (base_amount !== undefined && tax_rate !== undefined) {
                sql = `INSERT INTO invoices (customer_id, member_id, package_id, invoice_number, amount, base_amount, tax_rate, due_date, notes, invoice_type, package_name, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
                params = [customer_id || null, member_id || null, package_id, invoice_number, amount, base_amount, tax_rate, due_date, notes || null, invoice_type, package_name || null, description || null];
            } else {
                sql = `INSERT INTO invoices (customer_id, member_id, package_id, invoice_number, amount, due_date, notes, invoice_type, package_name, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
                params = [customer_id || null, member_id || null, package_id, invoice_number, amount, due_date, notes || null, invoice_type, package_name || null, description || null];
            }
            
            this.db.run(sql, params, function(err) {
                if (err) {
                    reject(err);
                } else {
                    const newId = this.lastID;
                    const cid = customer_id != null ? parseInt(String(customer_id), 10) : null;
                    if (Number.isFinite(cid) && cid > 0) {
                        const amtLbl =
                            amount != null
                                ? `Rp ${Number(amount).toLocaleString('id-ID')}`
                                : '';
                        setImmediate(() => {
                            try {
                                const cfn = require('./collectorFieldNotifications');
                                cfn.notifyNewInvoice(cid, newId, invoice_number, amtLbl);
                            } catch (_) {}
                        });
                    }
                    resolve({ id: newId, invoice_number, ...invoiceData });
                }
            });
        });
    }

    async getInvoicesWithFilters(filters = {}, limit = null, offset = null) {
        return new Promise((resolve, reject) => {
            // Check if renewal_type and invoice_type columns exist
            this.db.all("PRAGMA table_info(customers)", (pragmaErr, customerColumns) => {
                if (pragmaErr) {
                    reject(pragmaErr);
                    return;
                }
                
                this.db.all("PRAGMA table_info(invoices)", (invoicePragmaErr, invoiceColumns) => {
                    if (invoicePragmaErr) {
                        reject(invoicePragmaErr);
                        return;
                    }
                    
                    const hasRenewalType = customerColumns.some(col => col.name === 'renewal_type');
                    const hasFixDate = customerColumns.some(col => col.name === 'fix_date');
                    const hasCustomerId = customerColumns.some(col => col.name === 'customer_id');
                    const hasInvoiceType = invoiceColumns.some(col => col.name === 'invoice_type');
                    
                    // Build SELECT clause based on column existence
                    let selectClause = `SELECT i.*, c.username, c.name as customer_name, c.phone as customer_phone`;
                    if (hasCustomerId) selectClause += `, c.customer_id`;
                    if (hasRenewalType) selectClause += `, c.renewal_type`;
                    if (hasFixDate) selectClause += `, c.fix_date`;
                    selectClause += `, p.name as package_name, p.speed as package_speed`;
                    
                    let sql = `
                        ${selectClause}
                        FROM invoices i
                        LEFT JOIN customers c ON i.customer_id = c.id
                        LEFT JOIN packages p ON i.package_id = p.id
                        WHERE 1=1
                    `;
                    
                    const params = [];
                    
                    // Filter by month if provided (format: YYYY-MM)
                    if (filters.month) {
                        sql += ` AND strftime('%Y-%m', i.created_at) = ?`;
                        params.push(filters.month);
                    }
                    
                    // Filter by customer username
                    if (filters.customer_username) {
                        sql += ` AND c.username LIKE ?`;
                        params.push(`%${filters.customer_username}%`);
                    }
                    
                    // Filter by status
                    if (filters.status) {
                        if (filters.status === 'overdue') {
                            sql += ` AND i.status = 'unpaid' AND DATE(i.due_date) < DATE('now')`;
                        } else if (filters.status === 'unpaid') {
                            // Unified 'unpaid' now includes ALL unpaid regardless of due date
                            sql += ` AND i.status = 'unpaid'`;
                        } else {
                            sql += ` AND i.status = ?`;
                            params.push(filters.status);
                        }
                    }
                    
                    // Filter by invoice type (only if columns exist)
                    if (filters.type) {
                        if (filters.type === 'monthly' && hasRenewalType) {
                            sql += ` AND c.renewal_type = 'renewal'`;
                        } else if (filters.type === 'fix_date' && hasRenewalType) {
                            sql += ` AND c.renewal_type = 'fix_date'`;
                        } else if (filters.type === 'manual' && hasInvoiceType) {
                            sql += ` AND i.invoice_type = 'manual'`;
                        }
                    }
            
                    sql += ` ORDER BY i.created_at DESC`;
                    
                    if (limit) {
                        sql += ` LIMIT ?`;
                        params.push(limit);
                        
                        if (offset) {
                            sql += ` OFFSET ?`;
                            params.push(offset);
                        }
                    }
                    
                    this.db.all(sql, params, (err, rows) => {
                        if (err) {
                            reject(err);
                        } else {
                            // Tambahkan informasi tipe tagihan dan next due date berdasarkan renewal_type dan status
                            const currentDate = new Date();
                            const currentMonth = currentDate.getMonth();
                            const currentYear = currentDate.getFullYear();
                            
                            const processedRows = rows.map(row => {
                                let invoiceType = 'Renewal';
                                let nextDueDate = null;
                                
                                // Handle missing renewal_type column
                                const renewalType = hasRenewalType ? (row.renewal_type || 'renewal') : 'renewal';
                                const fixDate = hasFixDate ? row.fix_date : null;
                                
                                if (renewalType === 'fix_date') {
                                    invoiceType = `Fix Date (${fixDate || 'N/A'})`;
                                } else {
                                    invoiceType = 'Renewal';
                                }
                                
                                // Hitung next due date untuk invoice yang sudah lunas
                                if (row.status === 'paid' && row.payment_date) {
                                    try {
                                        const customer = {
                                            renewal_type: renewalType,
                                            fix_date: fixDate
                                        };
                                        nextDueDate = this.calculateNextDueDate(customer, row.due_date, row.payment_date);
                                    } catch (error) {
                                        console.error('Error calculating next due date:', error);
                                    }
                                }
                                
                                return {
                                    ...row,
                                    renewal_type: renewalType,
                                    fix_date: fixDate,
                                    invoice_type: invoiceType,
                                    next_due_date: nextDueDate
                                };
                            });
                            
                            resolve(processedRows);
                        }
                    });
                });
            });
        });
    }

    async getInvoicesCountWithFilters(filters = {}) {
        return new Promise((resolve, reject) => {
            // Check if renewal_type and invoice_type columns exist
            this.db.all("PRAGMA table_info(customers)", (pragmaErr, customerColumns) => {
                if (pragmaErr) {
                    reject(pragmaErr);
                    return;
                }
                
                this.db.all("PRAGMA table_info(invoices)", (invoicePragmaErr, invoiceColumns) => {
                    if (invoicePragmaErr) {
                        reject(invoicePragmaErr);
                        return;
                    }
                    
                    const hasRenewalType = customerColumns.some(col => col.name === 'renewal_type');
                    const hasInvoiceType = invoiceColumns.some(col => col.name === 'invoice_type');
                    
                    const currentDate = new Date();
                    const currentMonth = currentDate.getMonth();
                    const currentYear = currentDate.getFullYear();
                    
                    // Hitung tanggal awal bulan berjalan saja (tidak termasuk bulan sebelumnya)
                    const currentMonthStart = new Date(currentYear, currentMonth, 1);
                    const currentMonthStartStr = currentMonthStart.toISOString().split('T')[0]; // Format: YYYY-MM-DD
                    
                    let sql = `
                        SELECT COUNT(*) as count
                        FROM invoices i
                        LEFT JOIN customers c ON i.customer_id = c.id
                        WHERE 1=1
                    `;
                    
                    const params = [];
                    
                    // Filter by customer username
                    if (filters.customer_username) {
                        sql += ` AND c.username LIKE ?`;
                        params.push(`%${filters.customer_username}%`);
                    }
                    
                    // Filter by status
                    if (filters.status) {
                        if (filters.status === 'overdue') {
                            sql += ` AND i.status = 'unpaid' AND DATE(i.due_date) < DATE('now')`;
                        } else if (filters.status === 'unpaid') {
                            // Unified 'unpaid' logic
                            sql += ` AND i.status = 'unpaid'`;
                        } else {
                            sql += ` AND i.status = ?`;
                            params.push(filters.status);
                        }
                    }
                    
                    // Filter by invoice type (only if columns exist)
                    if (filters.type) {
                        if (filters.type === 'monthly' && hasRenewalType) {
                            sql += ` AND c.renewal_type = 'renewal'`;
                        } else if (filters.type === 'fix_date' && hasRenewalType) {
                            sql += ` AND c.renewal_type = 'fix_date'`;
                        } else if (filters.type === 'manual' && hasInvoiceType) {
                            sql += ` AND i.invoice_type = 'manual'`;
                        }
                    }
                    
                    this.db.get(sql, params, (err, row) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(row.count);
                        }
                    });
                });
            });
        });
    }

    async getInvoices(customerUsername = null, limit = null, offset = null) {
        return new Promise((resolve, reject) => {
            // Check if renewal_type and fix_date columns exist
            this.db.all("PRAGMA table_info(customers)", (pragmaErr, customerColumns) => {
                if (pragmaErr) {
                    reject(pragmaErr);
                    return;
                }
                
                // Check if members table exists
                this.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='members'", (memberTableErr, memberTables) => {
                    const hasMembersTable = memberTables && memberTables.length > 0;
                    
                    const hasRenewalType = customerColumns.some(col => col.name === 'renewal_type');
                    const hasFixDate = customerColumns.some(col => col.name === 'fix_date');
                    const hasCustomerId = customerColumns.some(col => col.name === 'customer_id');
                    
                    // Build SELECT clause based on column existence
                    let selectClause = `SELECT i.*, 
                        c.username, c.name as customer_name, c.phone as customer_phone,
                        m.hotspot_username as member_username, m.name as member_name, m.phone as member_phone, m.id as member_id_from_table`;
                    if (hasCustomerId) selectClause += `, c.customer_id`;
                    if (hasRenewalType) selectClause += `, c.renewal_type`;
                    if (hasFixDate) selectClause += `, c.fix_date`;
                    selectClause += `, 
                        COALESCE(p.name, mp.name) as package_name, 
                        COALESCE(p.speed, mp.speed) as package_speed`;
                    if (hasMembersTable) {
                        selectClause += `, mp.name as member_package_name`;
                    }
                    
                    let sql = `
                        ${selectClause}
                        FROM invoices i
                        LEFT JOIN customers c ON i.customer_id = c.id
                        LEFT JOIN members m ON i.member_id = m.id
                        LEFT JOIN packages p ON (i.customer_id IS NOT NULL AND i.package_id = p.id)
                    `;
                    if (hasMembersTable) {
                        sql += ` LEFT JOIN member_packages mp ON (i.member_id IS NOT NULL AND i.package_id = mp.id)`;
                    }
                    sql += ` WHERE 1=1`;
                    
                    const params = [];
                    
                    if (customerUsername) {
                        sql += ` AND (c.username = ? OR m.hotspot_username = ?)`;
                        params.push(customerUsername, customerUsername);
                    }
                    
                    sql += ` ORDER BY i.created_at DESC`;
                    
                    if (limit) {
                        sql += ` LIMIT ?`;
                        params.push(limit);
                        
                        if (offset) {
                            sql += ` OFFSET ?`;
                            params.push(offset);
                        }
                    }
                    
                    this.db.all(sql, params, (err, rows) => {
                        if (err) {
                            reject(err);
                        } else {
                        // Tambahkan informasi tipe tagihan dan next due date berdasarkan renewal_type dan status
                        const currentDate = new Date();
                        const currentMonth = currentDate.getMonth();
                        const currentYear = currentDate.getFullYear();
                        
                        const processedRows = rows.map(row => {
                            let invoiceType = 'Renewal';
                            let nextDueDate = null;
                            
                            // Handle missing renewal_type column
                            const renewalType = hasRenewalType ? (row.renewal_type || 'renewal') : 'renewal';
                            const fixDate = hasFixDate ? row.fix_date : null;
                            
                            // Cek apakah invoice ini dari bulan berjalan saja
                            const invoiceDate = new Date(row.created_at);
                            const invoiceMonth = invoiceDate.getMonth();
                            const invoiceYear = invoiceDate.getFullYear();
                            
                            // Hanya hitung next due date untuk invoice bulan berjalan
                            const isCurrentMonthInvoice = (invoiceYear === currentYear && invoiceMonth === currentMonth);
                            
                            if (row.status === 'paid') {
                                // Untuk invoice yang sudah lunas, next due date berdasarkan fix date atau renewal
                                if (renewalType === 'fix_date') {
                                    // Fix date: next due date adalah tanggal fix_date di bulan berikutnya
                                    const nextMonth = new Date(currentYear, currentMonth + 1, fixDate || 15);
                                    nextDueDate = nextMonth;
                                } else {
                                    // Renewal: next due date berdasarkan tanggal pembayaran
                                    if (row.payment_date) {
                                        // Jika ada tanggal pembayaran, gunakan tanggal pembayaran + 1 bulan
                                        const paymentDate = new Date(row.payment_date);
                                        const currentDueDate = new Date(row.due_date);
                                        
                                        if (paymentDate <= currentDueDate) {
                                            // Bayar sebelum atau tepat jatuh tempo: tanggal tetap
                                            const nextDue = new Date(currentDueDate);
                                            nextDue.setMonth(nextDue.getMonth() + 1);
                                            nextDueDate = nextDue;
                                        } else {
                                        // Bayar setelah jatuh tempo: tanggal berubah sesuai tanggal bayar
                                        const nextDue = new Date(paymentDate);
                                        nextDue.setMonth(nextDue.getMonth() + 1);
                                        nextDueDate = nextDue;
                                    }
                                } else {
                                    // Fallback: 30 hari dari due_date jika tidak ada payment_date
                                    const currentDueDate = new Date(row.due_date);
                                    nextDueDate = new Date(currentDueDate.getTime() + (30 * 24 * 60 * 60 * 1000));
                                }
                            }
                            } else {
                                // Untuk invoice yang belum lunas atau terlambat, next due date mengikuti tanggal jatuh tempo
                                nextDueDate = new Date(row.due_date);
                            }
                            
                            // Determine if this is a member invoice
                            const isMemberInvoice = row.member_id !== null && row.member_id !== undefined;
                            const displayName = isMemberInvoice ? (row.member_name || row.member_username) : (row.customer_name || row.username);
                            const displayUsername = isMemberInvoice ? (row.member_username || row.member_id) : row.username;
                            const displayPhone = isMemberInvoice ? row.member_phone : row.customer_phone;
                            const displayPackageName = isMemberInvoice ? (row.member_package_name || row.package_name) : row.package_name;
                            
                            return {
                                ...row,
                                renewal_type: renewalType,
                                fix_date: fixDate,
                                invoice_type_display: invoiceType,
                                next_due_date: nextDueDate,
                                is_member: isMemberInvoice,
                                display_name: displayName,
                                display_username: displayUsername,
                                display_phone: displayPhone,
                                display_package_name: displayPackageName
                            };
                        });
                        resolve(processedRows);
                    }
                });
                });
            });
        });
    }

    /**
     * Tagihan pelanggan (portal) — filter customer_id, tidak hanya username.
     * Dipakai notifikasi agar tagihan baru selalu ikut pelanggan yang login.
     */
    async getInvoicesByCustomerId(customerId, limit = 80) {
        const cid = parseInt(customerId, 10);
        const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 80));
        if (!Number.isFinite(cid) || cid <= 0) {
            return [];
        }
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT i.*,
                    c.username,
                    c.name AS customer_name,
                    c.phone AS customer_phone,
                    p.name AS package_name,
                    p.speed AS package_speed
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                LEFT JOIN packages p ON i.package_id = p.id
                WHERE c.id = ?
                ORDER BY datetime(i.created_at) DESC
                LIMIT ?
            `;
            this.db.all(sql, [cid, lim], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    /**
     * Tagihan untuk feed notifikasi portal: semua baris dengan customer_id ini,
     * plus tagihan member (member_id) bila username login = hotspot/username member (case-insensitive).
     */
    async getPortalFeedInvoices(customerId, username, limit = 160) {
        const cid = parseInt(customerId, 10);
        const lim = Math.min(250, Math.max(1, parseInt(limit, 10) || 160));
        if (!Number.isFinite(cid) || cid <= 0) {
            return [];
        }
        const uname = String(username || '').trim();

        return new Promise((resolve, reject) => {
            this.db.all(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='members'",
                (mErr, mtRows) => {
                    if (mErr) {
                        reject(mErr);
                        return;
                    }
                    const hasMembers = mtRows && mtRows.length > 0;
                    const pkgSel = hasMembers
                        ? 'COALESCE(p.name, mp.name) as package_name, COALESCE(p.speed, mp.speed) as package_speed'
                        : 'p.name as package_name, p.speed as package_speed';

                    let sql = `
                        SELECT i.*,
                            COALESCE(c.username, m.hotspot_username, m.username) as username,
                            COALESCE(c.name, m.name) as customer_name,
                            COALESCE(c.phone, m.phone) as customer_phone,
                            ${pkgSel}
                        FROM invoices i
                        LEFT JOIN customers c ON i.customer_id = c.id
                        LEFT JOIN members m ON i.member_id = m.id
                        LEFT JOIN packages p ON (i.customer_id IS NOT NULL AND i.package_id = p.id)
                    `;
                    const params = [];
                    if (hasMembers) {
                        sql += ' LEFT JOIN member_packages mp ON (i.member_id IS NOT NULL AND i.package_id = mp.id)';
                    }
                    sql += ' WHERE i.customer_id = ?';
                    params.push(cid);
                    if (uname && hasMembers) {
                        sql += ` OR (
                            i.member_id IS NOT NULL AND m.id IS NOT NULL AND (
                                LOWER(TRIM(COALESCE(m.hotspot_username,''))) = LOWER(?)
                                OR LOWER(TRIM(COALESCE(m.username,''))) = LOWER(?)
                            )
                        )`;
                        params.push(uname, uname);
                    }
                    sql += ' ORDER BY datetime(i.created_at) DESC LIMIT ?';
                    params.push(lim);

                    this.db.all(sql, params, (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows || []);
                    });
                }
            );
        });
    }

    async getUnpaidInvoices() {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT i.*, c.username, c.name as customer_name, c.phone as customer_phone,
                       p.name as package_name, p.speed as package_speed
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                JOIN packages p ON i.package_id = p.id
                WHERE i.status = 'unpaid'
                ORDER BY i.due_date ASC, i.created_at DESC
            `;

            this.db.all(sql, [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async getPaidInvoices() {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT i.*, c.username, c.name as customer_name, c.phone as customer_phone,
                       p.name as package_name, p.speed as package_speed,
                       pay.payment_date, pay.payment_method
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                JOIN packages p ON i.package_id = p.id
                LEFT JOIN payments pay ON i.id = pay.invoice_id
                WHERE i.status = 'paid'
                ORDER BY i.payment_date DESC, i.created_at DESC
            `;

            this.db.all(sql, [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async getInvoicesCount(customerUsername = null) {
        return new Promise((resolve, reject) => {
            const currentDate = new Date();
            const currentMonth = currentDate.getMonth();
            const currentYear = currentDate.getFullYear();
            
            // Hitung tanggal awal bulan berjalan saja
            const currentMonthStart = new Date(currentYear, currentMonth, 1);
            const currentMonthStartStr = currentMonthStart.toISOString().split('T')[0]; // Format: YYYY-MM-DD
            
            let sql = 'SELECT COUNT(*) as count FROM invoices i WHERE DATE(i.created_at) >= ?';
            const params = [currentMonthStartStr];
            
            if (customerUsername) {
                sql += ' AND EXISTS (SELECT 1 FROM customers c WHERE c.id = i.customer_id AND c.username = ?)';
                params.push(customerUsername);
            }
            
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row ? row.count : 0);
                }
            });
        });
    }

    async getInvoicesByCustomer(customerId) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT i.*, 
                       COALESCE(c.username, m.hotspot_username, m.username) as username,
                       COALESCE(c.name, m.name) as customer_name,
                       COALESCE(c.phone, m.phone) as customer_phone,
                       COALESCE(p.name, mp.name) as package_name,
                       COALESCE(p.speed, mp.speed) as package_speed
                FROM invoices i
                LEFT JOIN customers c ON i.customer_id = c.id
                LEFT JOIN members m ON i.member_id = m.id
                LEFT JOIN packages p ON (i.customer_id IS NOT NULL AND i.package_id = p.id)
                LEFT JOIN member_packages mp ON (i.member_id IS NOT NULL AND i.package_id = mp.id)
                WHERE i.customer_id = ? OR i.member_id = ?
                ORDER BY i.created_at DESC
            `;
            
            this.db.all(sql, [customerId, customerId], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async getCustomersByPackage(packageId) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT c.*, p.name as package_name, p.price as package_price, p.speed as package_speed
                FROM customers c
                LEFT JOIN packages p ON c.package_id = p.id
                WHERE c.package_id = ?
                ORDER BY c.name ASC
            `;
            
            this.db.all(sql, [packageId], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async getInvoicesByCustomerAndDateRange(customerUsername, startDate, endDate) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT i.*, c.username, c.name as customer_name, c.phone as customer_phone,
                       p.name as package_name, p.speed as package_speed
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                JOIN packages p ON i.package_id = p.id
                WHERE c.username = ? 
                AND i.created_at BETWEEN ? AND ?
                ORDER BY i.created_at DESC
            `;
            
            const params = [
                customerUsername,
                startDate.toISOString(),
                endDate.toISOString()
            ];
            
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    /** Satu query untuk cek duplikat bulanan — hindari N× getInvoicesByCustomerAndDateRange saat bulk generate */
    async getDistinctCustomerUsernamesWithInvoicesBetween(startDate, endDate) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT DISTINCT c.username
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                WHERE i.created_at BETWEEN ? AND ?
            `;
            this.db.all(sql, [startDate.toISOString(), endDate.toISOString()], (err, rows) => {
                if (err) reject(err);
                else resolve(new Set((rows || []).map((r) => r.username).filter(Boolean)));
            });
        });
    }

    /** Kunci yang dipakai scheduler member (hotspot_username || username) jika ada invoice di rentang tanggal */
    async getMemberIdentityKeysWithInvoicesBetween(startDate, endDate) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT m.hotspot_username, m.username
                FROM invoices i
                JOIN members m ON i.member_id = m.id
                WHERE i.created_at BETWEEN ? AND ?
            `;
            this.db.all(sql, [startDate.toISOString(), endDate.toISOString()], (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }
                const keys = new Set();
                for (const r of rows || []) {
                    const u = r.hotspot_username != null && String(r.hotspot_username).trim()
                        ? String(r.hotspot_username).trim()
                        : '';
                    const n = r.username != null && String(r.username).trim()
                        ? String(r.username).trim()
                        : '';
                    if (u) keys.add(u);
                    if (n) keys.add(n);
                }
                resolve(keys);
            });
        });
    }

    /** Semua baris packages untuk cache id → row (termasuk non-aktif) */
    async getAllPackagesByIdMap() {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT * FROM packages', [], (err, rows) => {
                if (err) reject(err);
                else resolve(new Map((rows || []).map((p) => [p.id, p])));
            });
        });
    }

    async getInvoiceById(id) {
        return new Promise((resolve, reject) => {
            // Check if members table exists
            this.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='members'", (memberTableErr, memberTables) => {
                const hasMembersTable = memberTables && memberTables.length > 0;
                
                let sql = `
                    SELECT i.*, 
                        c.username as customer_username, c.name as customer_name, c.phone as customer_phone, c.address as customer_address,
                        m.hotspot_username as member_username, m.name as member_name, m.phone as member_phone, m.address as member_address,
                        COALESCE(p.name, mp.name) as package_name, 
                        COALESCE(p.speed, mp.speed) as package_speed
                    FROM invoices i
                    LEFT JOIN customers c ON i.customer_id = c.id
                    LEFT JOIN members m ON i.member_id = m.id
                    LEFT JOIN packages p ON (i.customer_id IS NOT NULL AND i.package_id = p.id)
                `;
                if (hasMembersTable) {
                    sql += ` LEFT JOIN member_packages mp ON (i.member_id IS NOT NULL AND i.package_id = mp.id)`;
                }
                sql += ` WHERE i.id = ?`;
                
                this.db.get(sql, [id], (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        if (!row) {
                            resolve(null);
                            return;
                        }
                        
                        // Determine if this is a member invoice
                        const isMemberInvoice = row.member_id !== null && row.member_id !== undefined;
                        if (isMemberInvoice) {
                            row.customer_username = row.member_username;
                            row.customer_name = row.member_name;
                            row.customer_phone = row.member_phone;
                            row.customer_address = row.member_address;
                            row.is_member = true;
                        } else {
                            row.is_member = false;
                        }
                        
                        // Check if this is a voucher invoice by looking at invoice_number pattern
                        if (row && row.invoice_number && row.invoice_number.includes('INV-VCR-')) {
                            // Extract voucher package name from notes field
                            // Format: "Voucher Hotspot 10rb - 5 Hari x1"
                            const notes = row.notes || '';
                            const voucherMatch = notes.match(/Voucher Hotspot (.+?) x\d+/);
                            if (voucherMatch) {
                                row.package_name = voucherMatch[1]; // e.g., "10rb - 5 Hari"
                            }
                        }
                        resolve(row);
                    }
                });
            });
        });
    }

    async updateInvoiceStatus(id, status, paymentMethod = null) {
        return new Promise(async (resolve, reject) => {
            try {
                let prevInv = null;
                try {
                    prevInv = await this.getInvoiceById(id);
                } catch (_) {
                    prevInv = null;
                }
                const wasUnpaid = prevInv && String(prevInv.status || '').toLowerCase() !== 'paid';
                const paymentDate = status === 'paid' ? new Date().toISOString() : null;
                const sql = `UPDATE invoices SET status = ?, payment_date = ?, payment_method = ? WHERE id = ?`;
                
                this.db.run(sql, [status, paymentDate, paymentMethod, id], async (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (status === 'paid' && paymentDate && wasUnpaid && prevInv && prevInv.customer_id) {
                        setImmediate(() => {
                            try {
                                const cfn = require('./collectorFieldNotifications');
                                cfn.notifyInvoicePaid(
                                    Number(prevInv.customer_id),
                                    id,
                                    prevInv.invoice_number,
                                    Number(prevInv.amount) || 0
                                );
                            } catch (_) {}
                        });
                    }
                    
                    // If invoice is marked as paid, sync billing date for renewal customers and restore service if needed
                    if (status === 'paid' && paymentDate) {
                        try {
                            // Get invoice and customer data
                            const invoiceData = await this.getInvoiceById(id);
                            if (invoiceData) {
                                const customer = await this.getCustomerById(invoiceData.customer_id);
                                if (customer) {
                                    // Sync billing date for renewal customers
                                    if (customer.renewal_type === 'renewal') {
                                        // Calculate next due date
                                        const nextDueDate = this.calculateNextDueDate(
                                            customer, 
                                            invoiceData.due_date, 
                                            paymentDate
                                        );
                                        
                                        // Sync billing date
                                        const syncResult = await this.syncBillingDateForRenewal(
                                            customer.id, 
                                            nextDueDate
                                        );
                                        
                                        console.log(`[BILLING] Billing date synced for ${customer.name}:`, syncResult);
                                    }
                                    
                                    // Check if customer is suspended and restore service if no unpaid invoices
                                    const { shouldAutoRestoreCustomer } = require('../utils/customerSuspendReason');
                                    if (shouldAutoRestoreCustomer(customer)) {
                                        try {
                                            const customerInvoices = await this.getInvoicesByCustomer(customer.id);
                                            const unpaidInvoices = customerInvoices.filter(i => i.status === 'unpaid');
                                            
                                            if (unpaidInvoices.length === 0) {
                                                console.log(`[BILLING] Auto-restoring service for customer ${customer.name} - no unpaid invoices`);
                                                const serviceSuspension = require('./serviceSuspension');
                                                const restoreResult = await serviceSuspension.restoreCustomerService(
                                                    customer, 
                                                    `Payment via ${paymentMethod || 'online'} - Invoice ${invoiceData.invoice_number}`
                                                );
                                                
                                                if (restoreResult.success) {
                                                    console.log(`[BILLING] Customer ${customer.name} service successfully restored`);
                                                } else {
                                                    console.error(`[BILLING] Failed to restore customer ${customer.name}:`, restoreResult);
                                                }
                                            } else {
                                                console.log(`[BILLING] Customer ${customer.name} still has ${unpaidInvoices.length} unpaid invoices - keeping suspended`);
                                            }
                                        } catch (restoreError) {
                                            console.error(`[BILLING] Error restoring customer service:`, restoreError);
                                        }
                                    }
                                }
                            }
                        } catch (syncError) {
                            console.error('[BILLING] Error syncing billing date:', syncError);
                            // Don't reject the main operation if sync fails
                        }
                    }
                    
                    resolve({ id, status, payment_date: paymentDate, payment_method: paymentMethod });
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    async updateInvoice(id, invoiceData) {
        return new Promise((resolve, reject) => {
            const { customer_id, package_id, amount, due_date, notes } = invoiceData;
            const sql = `UPDATE invoices SET customer_id = ?, package_id = ?, amount = ?, due_date = ?, notes = ? WHERE id = ?`;
            
            // Use arrow function to preserve class context (this)
            this.db.run(sql, [customer_id, package_id, amount, due_date, notes, id], (err) => {
                if (err) {
                    reject(err);
                } else {
                    // Get the updated invoice
                    this.getInvoiceById(id).then(resolve).catch(reject);
                }
            });
        });
    }

    async deleteInvoice(id) {
        return new Promise((resolve, reject) => {
            // First get the invoice details before deleting
            this.getInvoiceById(id).then(invoice => {
                if (!invoice) {
                    reject(new Error('Invoice not found'));
                    return;
                }

                // Start a transaction to ensure all deletions succeed or fail together
                this.db.serialize(() => {
                    this.db.run('BEGIN TRANSACTION');
                    
                    // Delete related records first to avoid foreign key constraint violations
                    // Use a more robust approach with Promise-based deletion
                    // Note: activity_logs doesn't have invoice_id column, so we skip it
                    const deleteQueries = [
                        { query: 'DELETE FROM payments WHERE invoice_id = ?', name: 'payments' },
                        { query: 'DELETE FROM payment_gateway_transactions WHERE invoice_id = ?', name: 'payment_gateway_transactions' },
                        { query: 'DELETE FROM technician_activities WHERE invoice_id = ?', name: 'technician_activities' },
                        { query: 'DELETE FROM agent_monthly_payments WHERE invoice_id = ?', name: 'agent_monthly_payments' },
                        { query: 'DELETE FROM agent_payments WHERE invoice_id = ?', name: 'agent_payments' },
                        { query: 'DELETE FROM collector_payments WHERE invoice_id = ?', name: 'collector_payments' }
                        // activity_logs doesn't have invoice_id column, so we don't delete from it
                    ];
                    
                    let completedQueries = 0;
                    let hasError = false;
                    const errors = [];
                    
                    deleteQueries.forEach((queryObj, index) => {
                        // Check if table exists before trying to delete
                        this.db.run(queryObj.query, [id], function(err) {
                            if (err) {
                                // Ignore "no such table" and "no such column" errors, but log others
                                const ignorableErrors = ['no such table', 'no such column'];
                                const isIgnorable = ignorableErrors.some(errorType => 
                                    err.message.toLowerCase().includes(errorType)
                                );
                                
                                if (!isIgnorable) {
                                    console.error(`Error deleting from ${queryObj.name}:`, err.message);
                                    errors.push(`${queryObj.name}: ${err.message}`);
                                    hasError = true;
                                } else {
                                    // Log but don't fail for ignorable errors
                                    logger.debug(`Skipping deletion from ${queryObj.name}: ${err.message}`);
                                }
                            }
                            
                            completedQueries++;
                            if (completedQueries === deleteQueries.length) {
                                if (hasError) {
                                    this.db.run('ROLLBACK', (rollbackErr) => {
                                        if (rollbackErr) {
                                            console.error('Error rolling back transaction:', rollbackErr.message);
                                        }
                                        reject(new Error(`Failed to delete related records: ${errors.join('; ')}`));
                                    });
                                } else {
                                    // Now delete the invoice itself
                                    this.db.run('DELETE FROM invoices WHERE id = ?', [id], function(err) {
                                        if (err) {
                                            this.db.run('ROLLBACK', (rollbackErr) => {
                                                if (rollbackErr) {
                                                    console.error('Error rolling back transaction:', rollbackErr.message);
                                                }
                                            });
                                            reject(err);
                                        } else {
                                            this.db.run('COMMIT', (commitErr) => {
                                                if (commitErr) {
                                                    console.error('Error committing transaction:', commitErr.message);
                                                    reject(commitErr);
                                                } else {
                                                    console.log(`✅ Successfully deleted invoice ${invoice.invoice_number} (ID: ${id})`);
                                                    resolve(invoice);
                                                }
                                            });
                                        }
                                    }.bind(this));
                                }
                            }
                        }.bind(this));
                    });
                });
            }).catch(reject);
        });
    }

    // Payment Management
    async recordPayment(paymentData) {
        return new Promise(async (resolve, reject) => {
            try {
                await this._ensurePaymentsDiscountColumn();
                const { invoice_id, amount, payment_method, reference_number, notes, payment_date, discount_amount } =
                    paymentData;
                const disc = Math.max(0, Number(discount_amount) || 0);
                let sql = `INSERT INTO payments (invoice_id, amount, payment_method, reference_number, notes, discount_amount) VALUES (?, ?, ?, ?, ?, ?)`;
                let params = [invoice_id, amount, payment_method, reference_number, notes, disc];

                if (payment_date) {
                    sql = `INSERT INTO payments (invoice_id, amount, payment_method, reference_number, notes, payment_date, discount_amount) VALUES (?, ?, ?, ?, ?, ?, ?)`;
                    params = [invoice_id, amount, payment_method, reference_number, notes, payment_date, disc];
                }

                this.db.run(sql, params, function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ 
                            success: true, 
                            id: this.lastID, 
                            ...paymentData 
                        });
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    async recordCollectorPayment(paymentData) {
        await this._ensurePaymentsDiscountColumn();
        const {
            invoice_id,
            amount,
            payment_method,
            reference_number,
            notes,
            collector_id,
            commission_amount,
            discount_amount: discountAmountRaw
        } = paymentData;
        const discIns = Math.max(0, Number(discountAmountRaw) || 0);
        const self = this;
        return new Promise((resolve, reject) => {
            // Set database timeout and WAL mode for better concurrency
            this.db.run('PRAGMA busy_timeout=30000', (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                self.db.run('PRAGMA journal_mode=WAL', (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    
                    // Mulai transaction untuk operasi kompleks
                    self.db.run('BEGIN IMMEDIATE TRANSACTION', (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        // Insert payment
                        const sql = `INSERT INTO payments (
                            invoice_id, amount, payment_method, reference_number, notes, 
                            collector_id, commission_amount, payment_type, discount_amount
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'collector', ?)`;
                        
                        self.db.run(sql, [
                            invoice_id, amount, payment_method, reference_number, notes,
                            collector_id, commission_amount || 0,
                            discIns
                        ], function(err) {
                            if (err) {
                                self.db.run('ROLLBACK', (rollbackErr) => {
                                    if (rollbackErr) console.error('Rollback error:', rollbackErr.message);
                                    reject(err);
                                });
                                return;
                            }
                            
                            const paymentId = this.lastID;
                            
                            // Jika ada komisi, catat sebagai expense
                            if (commission_amount && commission_amount > 0) {
                                // Get collector name untuk deskripsi
                                self.db.get('SELECT name FROM collectors WHERE id = ?', [collector_id], (err, collector) => {
                                    if (err) {
                                        self.db.run('ROLLBACK', (rollbackErr) => {
                                            if (rollbackErr) console.error('Rollback error:', rollbackErr.message);
                                            reject(err);
                                        });
                                        return;
                                    }
                                    
                                    const collectorName = collector ? collector.name : 'Unknown Collector';
                                    
                                    // Insert commission as expense
                                    const expenseSql = `INSERT INTO expenses (
                                        description, amount, category, expense_date, 
                                        payment_method, notes
                                    ) VALUES (?, ?, ?, DATE('now'), ?, ?)`;
                                    
                                    self.db.run(expenseSql, [
                                        `Komisi Kolektor - ${collectorName}`,
                                        commission_amount,
                                        'Operasional',
                                        'Transfer Bank', // Default payment method for commission
                                        `Komisi ${commission_amount}% dari pembayaran invoice ${invoice_id} via kolektor ${collectorName}`
                                    ], function(err) {
                                        if (err) {
                                            self.db.run('ROLLBACK', (rollbackErr) => {
                                                if (rollbackErr) console.error('Rollback error:', rollbackErr.message);
                                                reject(err);
                                            });
                                            return;
                                        }
                                        
                                        // Commit transaction
                                        self.db.run('COMMIT', (err) => {
                                            if (err) {
                                                reject(err);
                                            } else {
                                                resolve({ 
                                                    success: true, 
                                                    id: paymentId, 
                                                    expenseId: this.lastID,
                                                    commissionRecorded: true,
                                                    ...paymentData 
                                                });
                                            }
                                        });
                                    });
                                });
                            } else {
                                // Commit transaction tanpa expense
                                self.db.run('COMMIT', (err) => {
                                    if (err) {
                                        reject(err);
                                    } else {
                                        resolve({ 
                                            success: true, 
                                            id: paymentId, 
                                            commissionRecorded: false,
                                            ...paymentData 
                                        });
                                    }
                                });
                            }
                        });
                    });
                });
            });
        });
    }

    async getCollectorById(collectorId) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM collectors WHERE id = ?', [collectorId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    async recordCollectorPaymentRecord(paymentData) {
        return new Promise((resolve, reject) => {
            const { collector_id, customer_id, amount, payment_amount, commission_amount, payment_method, notes, status } = paymentData;
            
            const sql = `INSERT INTO collector_payments (
                collector_id, customer_id, amount, payment_amount, commission_amount,
                payment_method, notes, status, collected_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`;
            
            this.db.run(sql, [
                collector_id, customer_id, amount, payment_amount, commission_amount,
                payment_method, notes, status
            ], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ 
                        success: true, 
                        id: this.lastID,
                        ...paymentData 
                    });
                }
            });
        });
    }

    async getCollectorAssignedCustomerCount(collectorId) {
        const hasAreas = await this._hasAreasReferenceTable();
        const areaRowMatch = this._sqlCustomerMatchesCollectorAreaRow(hasAreas, 'cra');
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT COUNT(DISTINCT c.id) as count 
                FROM customers c 
                LEFT JOIN collector_areas cra ON (
                    cra.collector_id = ?
                    AND ${areaRowMatch}
                )
                LEFT JOIN collector_assignments ca ON (c.id = ca.customer_id AND ca.collector_id = ?)
                WHERE cra.collector_id IS NOT NULL OR ca.collector_id IS NOT NULL
            `;
            this.db.get(sql, [collectorId, collectorId], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.count : 0);
            });
        });
    }

    async getCollectorAreas(collectorId) {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT area FROM collector_areas WHERE collector_id = ?', [collectorId], (err, rows) => {
                if (err) reject(err);
                else resolve((rows || []).map(r => r.area));
            });
        });
    }

    /**
     * Peta area → kolektor yang memegangnya (nama area persis seperti di collector_areas).
     */
    async _ensureCollectorAreaUniqueAreaIndex() {
        if (this._collectorAreaUniqueEnsured) return;
        await new Promise((resolve) => {
            this.db.run(
                `CREATE UNIQUE INDEX IF NOT EXISTS idx_collector_areas_area_lower_unique ON collector_areas(LOWER(TRIM(area)))`,
                (err) => {
                    if (err) {
                        console.warn('[billing] idx_collector_areas_area_lower_unique:', err.message);
                    }
                    this._collectorAreaUniqueEnsured = true;
                    resolve();
                }
            );
        });
    }

    async getCollectorAreaAssignmentMap() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT ca.area, ca.collector_id, c.name AS collector_name
                 FROM collector_areas ca
                 INNER JOIN collectors c ON c.id = ca.collector_id
                 WHERE TRIM(IFNULL(ca.area, '')) != ''`,
                [],
                (err, rows) => {
                    if (err) return reject(err);
                    const map = {};
                    (rows || []).forEach((r) => {
                        const key = String(r.area || '').trim();
                        if (!key) return;
                        map[key] = {
                            collectorId: Number(r.collector_id),
                            collectorName: r.collector_name || ''
                        };
                    });
                    resolve(map);
                }
            );
        });
    }

    async saveCollectorAreas(collectorId, areas) {
        await this._ensureCollectorAreaUniqueAreaIndex();
        const cid = parseInt(String(collectorId), 10);
        if (!Number.isFinite(cid) || cid <= 0) {
            throw new Error('ID kolektor tidak valid');
        }
        const normalized = [
            ...new Set(
                (areas || [])
                    .map((a) => String(a || '').trim())
                    .filter((a) => a.length > 0)
            )
        ];
        const conflicts = await new Promise((resolve, reject) => {
            if (normalized.length === 0) return resolve([]);
            const placeholders = normalized.map(() => 'LOWER(TRIM(?)) = LOWER(TRIM(ca.area))').join(' OR ');
            this.db.all(
                `SELECT ca.area, ca.collector_id, c.name AS collector_name
                 FROM collector_areas ca
                 INNER JOIN collectors c ON c.id = ca.collector_id
                 WHERE ca.collector_id != ?
                   AND (${placeholders})`,
                [cid, ...normalized],
                (err, rows) => (err ? reject(err) : resolve(rows || []))
            );
        });
        if (conflicts.length > 0) {
            const detail = conflicts
                .map((r) => `"${r.area}" → ${r.collector_name || 'kolektor lain'}`)
                .join(', ');
            throw new Error(`Area sudah di-assign ke kolektor lain: ${detail}`);
        }
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('DELETE FROM collector_areas WHERE collector_id = ?', [cid], (err) => {
                    if (err) return reject(err);

                    if (normalized.length === 0) return resolve();

                    const stmt = this.db.prepare(
                        'INSERT INTO collector_areas (collector_id, area) VALUES (?, ?)'
                    );
                    for (const area of normalized) {
                        stmt.run(cid, area);
                    }
                    stmt.finalize((errFinalize) => {
                        if (errFinalize) {
                            const msg = String(errFinalize.message || '');
                            if (msg.includes('UNIQUE') || msg.includes('unique')) {
                                reject(
                                    new Error(
                                        'Area tidak boleh dobel. Satu area hanya untuk satu kolektor.'
                                    )
                                );
                            } else {
                                reject(errFinalize);
                            }
                        } else {
                            resolve();
                        }
                    });
                });
            });
        });
    }

    async getCollectorTodayPayments(collectorId, startOfDay, endOfDay) {
        return new Promise((resolve, reject) => {
            this.db.get(`
                SELECT COALESCE(SUM(payment_amount), 0) as total
                FROM collector_payments 
                WHERE collector_id = ? AND date(collected_at) = date(?) AND status = 'completed'
            `, [collectorId, startOfDay.toISOString()], (err, row) => {
                if (err) reject(err);
                else resolve(Math.round(parseFloat(row ? row.total : 0)));
            });
        });
    }

    // Get current month's total commission (reset every month)
    async getCollectorTotalCommission(collectorId) {
        return new Promise((resolve, reject) => {
            const sql = "SELECT COALESCE(SUM(commission_amount), 0) as total FROM payments WHERE collector_id = ? AND status = 'completed'";
            this.db.get(sql, [collectorId], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.total : 0);
            });
        });
    }

    async getCollectorDashboardStats(collectorId, month = null, year = null) {
        const dateObj = new Date();
        const filterMonth = (month || (dateObj.getMonth() + 1)).toString().padStart(2, '0');
        const filterYear = (year || dateObj.getFullYear()).toString();
        
        const todayStr = new Date(dateObj.getTime() - (dateObj.getTimezoneOffset() * 60000)).toISOString().split('T')[0];

        try {
            await this._ensureRemittanceNetAppliedColumn();
            const hasAreas = await this._hasAreasReferenceTable();
            const areaRowMatch = this._sqlCustomerMatchesCollectorAreaRow(hasAreas, 'cra');
            /** Sama pool pelanggan dengan getCollectorCustomers: area kolektor ATAU penugasan manual. */
            const poolWhere = `
                (cra.collector_id IS NOT NULL OR casm.collector_id IS NOT NULL)
                AND strftime('%m', i.created_at) = ? AND strftime('%Y', i.created_at) = ?
            `;
            const poolJoin = `
                FROM invoices i
                INNER JOIN customers c ON i.customer_id = c.id
                LEFT JOIN collector_areas cra ON cra.collector_id = ? AND ${areaRowMatch}
                LEFT JOIN collector_assignments casm ON casm.customer_id = c.id AND casm.collector_id = ?
            `;
            /** Subquery DISTINCT agar 1 invoice tidak terjumlah 2x bila cocok >1 baris collector_areas. */
            const poolInvoiceDistinct = `
                SELECT DISTINCT i.id AS id, i.amount AS amount, i.status AS status, i.customer_id AS customer_id
                ${poolJoin}
                WHERE ${poolWhere}
            `;
            const qTagihan = `
                SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
                FROM (${poolInvoiceDistinct})
            `;

            /** Sama kohort dengan qTagihan, hanya invoice sudah lunas (admin / portal / kolektor). Untuk progress dashboard. */
            const qTagihanLunas = `
                SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
                FROM (${poolInvoiceDistinct})
                WHERE status = 'paid'
            `;
            
            const qLunas = `
                SELECT COUNT(DISTINCT i.customer_id) as count, COALESCE(SUM(p.amount), 0) as total
                FROM payments p
                INNER JOIN invoices i ON p.invoice_id = i.id
                WHERE p.collector_id = ?
                AND strftime('%m', p.payment_date) = ? AND strftime('%Y', p.payment_date) = ?
            `;
            
            const qBelumLunas = `
                SELECT COUNT(DISTINCT customer_id) as count, COALESCE(SUM(amount), 0) as total
                FROM (${poolInvoiceDistinct})
                WHERE status = 'unpaid'
            `;
            
            const qLunasHariIni = `
                SELECT COUNT(DISTINCT i.customer_id) as count, COALESCE(SUM(p.amount), 0) as total
                FROM payments p
                INNER JOIN invoices i ON p.invoice_id = i.id
                WHERE p.collector_id = ?
                AND strftime('%Y-%m-%d', p.payment_date) = ?
            `;
            
            const qSetoran = `
                SELECT 
                    COALESCE(SUM(COALESCE(p.remittance_net_applied, 0)), 0) as sudah_setor,
                    COALESCE(SUM(
                        CASE WHEN (p.remittance_status IS NULL OR p.remittance_status = 'pending')
                             AND (
                                (COALESCE(i.amount, 0) - COALESCE(p.discount_amount, 0) - COALESCE(p.commission_amount, 0))
                                - COALESCE(p.remittance_net_applied, 0)
                             ) > 0.009
                        THEN (COALESCE(i.amount, 0) - COALESCE(p.discount_amount, 0) - COALESCE(p.commission_amount, 0))
                             - COALESCE(p.remittance_net_applied, 0)
                        ELSE 0 END
                    ), 0) as belum_setor
                FROM payments p
                INNER JOIN invoices i ON i.id = p.invoice_id
                WHERE p.collector_id = ? AND p.payment_type = 'collector'
                AND strftime('%m', p.payment_date) = ? AND strftime('%Y', p.payment_date) = ?
            `;

            const runGet = (sql, params) => new Promise((resolve, reject) => {
                this.db.get(sql, params, (err, row) => err ? reject(err) : resolve(row || {}));
            });

            const poolParams = [collectorId, collectorId, filterMonth, filterYear];
            const [tagihan, tagihanLunas, lunas, belumLunas, hariIni, setoran] = await Promise.all([
                runGet(qTagihan, poolParams),
                runGet(qTagihanLunas, poolParams),
                runGet(qLunas, [collectorId, filterMonth, filterYear]),
                runGet(qBelumLunas, poolParams),
                runGet(qLunasHariIni, [collectorId, todayStr]),
                runGet(qSetoran, [collectorId, filterMonth, filterYear])
            ]);

            return { tagihan, tagihanLunas, lunas, belumLunas, hariIni, setoran };
        } catch (error) {
            console.error("Error getCollectorDashboardStats:", error);
            throw error;
        }
    }

    // Get current month's total commission (reset every month)
    async getCollectorTotalCommission(collectorId) {
        return new Promise((resolve, reject) => {
            const now = new Date();
            const year = now.getFullYear();
            const month = now.getMonth() + 1;
            const startDate = new Date(year, month - 1, 1).toISOString();
            const endDate = new Date(year, month, 0, 23, 59, 59).toISOString();
            
            this.db.get(`
                SELECT COALESCE(SUM(commission_amount), 0) as total
                FROM collector_payments 
                WHERE collector_id = ? AND date(collected_at) BETWEEN date(?) AND date(?) AND status = 'completed'
            `, [collectorId, startDate, endDate], (err, row) => {
                if (err) reject(err);
                else resolve(Math.round(parseFloat(row ? row.total : 0)));
            });
        });
    }

    // Get current month's total payments count (reset every month)
    async getCollectorTotalPayments(collectorId) {
        return new Promise((resolve, reject) => {
            const now = new Date();
            const year = now.getFullYear();
            const month = now.getMonth() + 1;
            const startDate = new Date(year, month - 1, 1).toISOString();
            const endDate = new Date(year, month, 0, 23, 59, 59).toISOString();
            
            this.db.get(`
                SELECT COUNT(*) as count
                FROM collector_payments 
                WHERE collector_id = ? AND date(collected_at) BETWEEN date(?) AND date(?) AND status = 'completed'
            `, [collectorId, startDate, endDate], (err, row) => {
                if (err) reject(err);
                else resolve(parseInt(row ? row.count : 0));
            });
        });
    }

    async getCollectorRecentPayments(collectorId, limit = 5) {
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT cp.*, c.name as customer_name, c.phone as customer_phone
                FROM collector_payments cp
                LEFT JOIN customers c ON cp.customer_id = c.id
                WHERE cp.collector_id = ? AND cp.status = 'completed'
                ORDER BY cp.collected_at DESC
                LIMIT ?
            `, [collectorId, limit], (err, rows) => {
                if (err) reject(err);
                else {
                    const validRows = (rows || []).map(row => ({
                        ...row,
                        payment_amount: Math.round(parseFloat(row.payment_amount || 0)),
                        commission_amount: Math.round(parseFloat(row.commission_amount || 0)),
                        customer_name: row.customer_name || 'Unknown Customer'
                    }));
                    resolve(validRows);
                }
            });
        });
    }

    async getCollectorAllPayments(collectorId) {
        return new Promise((resolve, reject) => {
            // Riwayat dari `payments` (bukan `collector_payments`): baris log kolektor
            // di collector_payments tidak dihapus saat admin membatalkan pembayaran,
            // sedangkan baris payments dihapus — supaya riwayat app kolektor selaras.
            this.db.all(
                `
                SELECT
                    p.id,
                    p.invoice_id,
                    p.collector_id,
                    i.customer_id,
                    p.amount AS payment_amount,
                    COALESCE(p.discount_amount, 0) AS discount_amount,
                    COALESCE(p.commission_amount, 0) AS commission_amount,
                    p.payment_method,
                    p.notes,
                    'completed' AS status,
                    COALESCE(p.payment_date, datetime('now','localtime')) AS collected_at,
                    c.name AS customer_name,
                    c.phone AS customer_phone
                FROM payments p
                INNER JOIN invoices i ON i.id = p.invoice_id
                LEFT JOIN customers c ON c.id = i.customer_id
                WHERE p.collector_id = ?
                  AND IFNULL(p.payment_type, 'collector') = 'collector'
                ORDER BY collected_at DESC
            `,
                [collectorId],
                (err, rows) => {
                    if (err) reject(err);
                    else {
                        const validRows = (rows || []).map((row) => ({
                            ...row,
                            payment_amount: Math.round(parseFloat(row.payment_amount || 0)),
                            discount_amount: Math.round(parseFloat(row.discount_amount || 0)),
                            commission_amount: Math.round(parseFloat(row.commission_amount || 0)),
                            customer_name: row.customer_name || 'Unknown Customer',
                            collected_at: row.collected_at || new Date().toISOString()
                        }));
                        resolve(validRows);
                    }
                }
            );
        });
    }

    async getUnpaidInvoicesCount() {
        return new Promise((resolve, reject) => {
            this.db.get(`
                SELECT COUNT(*) as count 
                FROM invoices 
                WHERE status = 'unpaid'
            `, [], (err, row) => {
                if (err) reject(err);
                else resolve(parseInt(row ? row.count : 0));
            });
        });
    }

    async getOverdueInvoicesCount() {
        return new Promise((resolve, reject) => {
            this.db.get(`
                SELECT COUNT(*) as count 
                FROM invoices 
                WHERE status = 'unpaid' AND due_date <= date('now','localtime')
            `, [], (err, row) => {
                if (err) reject(err);
                else resolve(parseInt(row ? row.count : 0));
            });
        });
    }

    // Monthly reset methods for collector summary
    async getCollectorMonthlyPayments(collectorId, year, month) {
        return new Promise((resolve, reject) => {
            const startDate = new Date(year, month - 1, 1).toISOString();
            const endDate = new Date(year, month, 0, 23, 59, 59).toISOString();
            
            this.db.get(`
                SELECT COALESCE(SUM(payment_amount), 0) as total
                FROM collector_payments 
                WHERE collector_id = ? AND collected_at >= ? AND collected_at <= ? AND status = 'completed'
            `, [collectorId, startDate, endDate], (err, row) => {
                if (err) reject(err);
                else resolve(Math.round(parseFloat(row ? row.total : 0)));
            });
        });
    }

    async getCollectorMonthlyCommission(collectorId, year, month) {
        return new Promise((resolve, reject) => {
            const startDate = new Date(year, month - 1, 1).toISOString();
            const endDate = new Date(year, month, 0, 23, 59, 59).toISOString();
            
            this.db.get(`
                SELECT COALESCE(SUM(commission_amount), 0) as total
                FROM collector_payments 
                WHERE collector_id = ? AND collected_at >= ? AND collected_at <= ? AND status = 'completed'
            `, [collectorId, startDate, endDate], (err, row) => {
                if (err) reject(err);
                else resolve(Math.round(parseFloat(row ? row.total : 0)));
            });
        });
    }

    async getCollectorMonthlyCount(collectorId, year, month) {
        return new Promise((resolve, reject) => {
            const startDate = new Date(year, month - 1, 1).toISOString();
            const endDate = new Date(year, month, 0, 23, 59, 59).toISOString();
            
            this.db.get(`
                SELECT COUNT(*) as count
                FROM collector_payments 
                WHERE collector_id = ? AND collected_at >= ? AND collected_at <= ? AND status = 'completed'
            `, [collectorId, startDate, endDate], (err, row) => {
                if (err) reject(err);
                else resolve(parseInt(row ? row.count : 0));
            });
        });
    }

    // Save collector monthly summary
    async saveCollectorMonthlySummary(collectorId, year, month, stats) {
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT OR REPLACE INTO collector_monthly_summary (
                    collector_id, year, month, total_payments, total_commission, 
                    payment_count, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
            `;
            
            this.db.run(sql, [
                collectorId, year, month, 
                stats.total_payments || 0,
                stats.total_commission || 0,
                stats.payment_count || 0
            ], function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, collectorId, year, month });
            });
        });
    }

    // Get collector monthly summary
    async getCollectorMonthlySummary(collectorId, year, month) {
        return new Promise((resolve, reject) => {
            this.db.get(`
                SELECT * FROM collector_monthly_summary 
                WHERE collector_id = ? AND year = ? AND month = ?
            `, [collectorId, year, month], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    // Get all collector monthly summaries
    async getAllCollectorMonthlySummaries(collectorId, limit = 12) {
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT * FROM collector_monthly_summary 
                WHERE collector_id = ?
                ORDER BY year DESC, month DESC
                LIMIT ?
            `, [collectorId, limit], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    async getPayments(invoiceId = null) {
        return new Promise((resolve, reject) => {
            let sql = `
                SELECT 
                    p.*, 
                    i.invoice_number, 
                    c.username, 
                    c.name as customer_name,
                    c.phone as customer_phone,
                    col.name as collector_name,
                    col.phone as collector_phone
                FROM payments p
                JOIN invoices i ON p.invoice_id = i.id
                JOIN customers c ON i.customer_id = c.id
                LEFT JOIN collectors col ON p.collector_id = col.id
            `;
            
            const params = [];
            if (invoiceId) {
                sql += ` WHERE p.invoice_id = ?`;
                params.push(invoiceId);
            }
            
            sql += ` ORDER BY p.payment_date DESC`;
            
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async getCollectorPayments(invoiceId = null) {
        return new Promise((resolve, reject) => {
            let sql = `
                SELECT 
                    p.*, 
                    i.invoice_number, 
                    c.username, 
                    c.name as customer_name,
                    c.phone as customer_phone,
                    col.name as collector_name,
                    col.phone as collector_phone
                FROM payments p
                JOIN invoices i ON p.invoice_id = i.id
                JOIN customers c ON i.customer_id = c.id
                LEFT JOIN collectors col ON p.collector_id = col.id
                WHERE p.collector_id IS NOT NULL AND col.id IS NOT NULL
            `;
            
            const params = [];
            if (invoiceId) {
                sql += ` AND p.invoice_id = ?`;
                params.push(invoiceId);
            }
            
            sql += ` ORDER BY p.payment_date DESC`;
            
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async getCollectorPaymentsWithFilters(filters) {
        return new Promise((resolve, reject) => {
            let sql = `
                SELECT 
                    p.*, 
                    i.invoice_number, 
                    c.username, 
                    c.name as customer_name,
                    c.phone as customer_phone,
                    col.name as collector_name,
                    col.phone as collector_phone
                FROM payments p
                JOIN invoices i ON p.invoice_id = i.id
                JOIN customers c ON i.customer_id = c.id
                LEFT JOIN collectors col ON p.collector_id = col.id
                WHERE 1=1
            `;
            
            const params = [];
            
            // Date range filter
            if (filters.from) {
                sql += ` AND DATE(p.payment_date) >= ?`;
                params.push(filters.from);
            }
            if (filters.to) {
                sql += ` AND DATE(p.payment_date) <= ?`;
                params.push(filters.to);
            }
            
            // Collector filter
            if (filters.collector_id) {
                sql += ` AND p.collector_id = ?`;
                params.push(filters.collector_id);
            }
            
            // Status filter
            if (filters.status) {
                if (filters.status === 'completed') {
                    sql += ` AND p.payment_date IS NOT NULL`;
                } else if (filters.status === 'received') {
                    sql += ` AND p.remittance_status = 'received'`;
                }
            }
            
            // Search filter
            if (filters.q) {
                sql += ` AND (
                    c.name LIKE ? OR 
                    c.phone LIKE ? OR 
                    i.invoice_number LIKE ? OR 
                    p.notes LIKE ?
                )`;
                const searchTerm = `%${filters.q}%`;
                params.push(searchTerm, searchTerm, searchTerm, searchTerm);
            }
            
            sql += ` ORDER BY p.payment_date DESC`;
            
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    /**
     * Riwayat pembayaran (admin + kolektor + tipe lain): pelanggan atau member.
     * Tanpa kolom remittance di UI — gunakan untuk halaman all-payments.
     */
    _allPaymentsHistoryWhere(filters) {
        let sql = `
            FROM payments p
            JOIN invoices i ON p.invoice_id = i.id
            LEFT JOIN customers c ON i.customer_id = c.id
            LEFT JOIN members m ON i.member_id = m.id
            LEFT JOIN collectors col ON p.collector_id = col.id
            WHERE 1=1
        `;
        const params = [];
        if (filters.from) {
            sql += ` AND date(p.payment_date) >= date(?)`;
            params.push(filters.from);
        }
        if (filters.to) {
            sql += ` AND date(p.payment_date) <= date(?)`;
            params.push(filters.to);
        }
        if (filters.collector_id) {
            sql += ` AND p.collector_id = ?`;
            params.push(filters.collector_id);
        }
        if (filters.q) {
            const term = `%${String(filters.q).trim()}%`;
            sql += ` AND (
                COALESCE(c.name, '') LIKE ? OR COALESCE(m.name, '') LIKE ?
                OR COALESCE(c.phone, '') LIKE ? OR COALESCE(m.phone, '') LIKE ?
                OR COALESCE(i.invoice_number, '') LIKE ?
                OR COALESCE(p.notes, '') LIKE ?
                OR COALESCE(col.name, '') LIKE ?
            )`;
            params.push(term, term, term, term, term, term, term);
        }
        return { sql, params };
    }

    async getAllPaymentsHistory(filters = {}) {
        await this._ensurePaymentsDiscountColumn();
        await this._ensureRemittanceNetAppliedColumn();
        const { sql: whereSql, params: whereParams } = this._allPaymentsHistoryWhere(filters);
        const limit = Math.min(2500, Math.max(1, parseInt(String(filters.limit || 1500), 10) || 1500));
        const params = [...whereParams, limit];
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT
                    p.id,
                    p.payment_date,
                    p.amount,
                    p.commission_amount,
                    p.payment_method,
                    p.payment_type,
                    p.notes,
                    p.collector_id,
                    p.invoice_id,
                    p.remittance_status,
                    COALESCE(p.discount_amount, 0) as discount_amount,
                    COALESCE(i.amount, 0) as invoice_amount,
                    i.invoice_number,
                    i.status as invoice_status,
                    COALESCE(c.name, m.name, '—') as customer_name,
                    COALESCE(c.phone, m.phone, '') as customer_phone,
                    col.name as collector_name
                ${whereSql}
                ORDER BY datetime(p.payment_date) DESC, p.id DESC
                LIMIT ?
            `;
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else {
                    const mapped = (rows || []).map((r) => {
                        const disc = effectivePaymentDiscount(r);
                        const tagihan = paymentInvoiceTagihan(r);
                        const jumlah = paymentJumlahSetelahDiskon({ ...r, discount_amount: disc });
                        return {
                            ...r,
                            discount_amount: disc,
                            invoice_tagihan: tagihan,
                            jumlah_setelah_diskon: jumlah
                        };
                    });
                    resolve(mapped);
                }
            });
        });
    }

    async getAllPaymentsHistorySummary(filters = {}) {
        await this._ensurePaymentsDiscountColumn();
        await this._ensureRemittanceNetAppliedColumn();
        const { sql: whereSql, params: whereParams } = this._allPaymentsHistoryWhere(filters);
        const aggSql = `
                SELECT
                    COUNT(*) as transaction_count,
                    COALESCE(SUM(p.amount), 0) as total_amount,
                    COALESCE(SUM(COALESCE(p.commission_amount, 0)), 0) as total_commission
                ${whereSql}
            `;
        const whereRestIdx = whereSql.indexOf('WHERE 1=1');
        const whereRest = whereRestIdx >= 0 ? whereSql.slice(whereRestIdx + 'WHERE 1=1'.length) : '';
        const discSql = `
                SELECT COALESCE(i.amount, 0) as invoice_amount, COALESCE(p.discount_amount, 0) as discount_amount, p.notes
                FROM payments p
                JOIN invoices i ON p.invoice_id = i.id
                LEFT JOIN customers c ON i.customer_id = c.id
                LEFT JOIN members m ON i.member_id = m.id
                LEFT JOIN collectors col ON p.collector_id = col.id
                WHERE 1=1
                ${whereRest}
            `;
        return new Promise((resolve, reject) => {
            this.db.get(aggSql, whereParams, (err, row) => {
                if (err) return reject(err);
                this.db.all(discSql, whereParams, (err2, discRows) => {
                    if (err2) return reject(err2);
                    let total_discount = 0;
                    let total_tagihan = 0;
                    for (const r of discRows || []) {
                        const disc = effectivePaymentDiscount({
                            discount_amount: r.discount_amount,
                            notes: r.notes
                        });
                        total_discount += disc;
                        const tag = paymentInvoiceTagihan(r);
                        total_tagihan += tag;
                    }
                    const total_commission = row ? Number(row.total_commission) || 0 : 0;
                    const total_net = Math.round(total_tagihan - total_discount - total_commission);
                    resolve({
                        transaction_count: row ? parseInt(row.transaction_count, 10) || 0 : 0,
                        total_amount: row ? Number(row.total_amount) || 0 : 0,
                        total_tagihan,
                        total_commission,
                        total_net,
                        total_discount
                    });
                });
            });
        });
    }

    /**
     * Batalkan satu baris pembayaran (admin): hapus baris payments, kembalikan invoice ke unpaid bila sisa pembayaran tidak menutupi tagihan.
     * Menghapus expense komisi kolektor yang cocok (jika ada). Tidak memblokir remitted/parsial — untuk bereskan data kacau di kantor.
     */
    async cancelPaymentById(paymentId) {
        const pid = parseInt(String(paymentId), 10);
        if (!Number.isFinite(pid) || pid <= 0) {
            throw new Error('ID pembayaran tidak valid');
        }

        const dbGet = (sql, params = []) =>
            new Promise((resolve, reject) => {
                this.db.get(sql, params, (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });
        const dbRun = (sql, params = []) =>
            new Promise((resolve, reject) => {
                this.db.run(sql, params, function (err) {
                    if (err) reject(err);
                    else resolve({ changes: this.changes });
                });
            });

        await dbRun('BEGIN IMMEDIATE');
        try {
            const payment = await dbGet('SELECT * FROM payments WHERE id = ?', [pid]);
            if (!payment) {
                throw new Error('Pembayaran tidak ditemukan');
            }

            const invoiceId = payment.invoice_id;
            const commission = Number(payment.commission_amount) || 0;
            const collectorId = payment.collector_id;

            if (commission > 0 && collectorId) {
                await dbRun(
                    `DELETE FROM expenses
                     WHERE category = 'Operasional'
                       AND description LIKE 'Komisi Kolektor%'
                       AND notes LIKE '%pembayaran invoice ' || ? || ' via kolektor%'
                       AND ABS(CAST(amount AS REAL) - ?) < 0.05`,
                    [String(invoiceId), commission]
                );
            }

            const del = await dbRun('DELETE FROM payments WHERE id = ?', [pid]);
            if (!del.changes) {
                throw new Error('Gagal menghapus pembayaran');
            }

            const inv = await dbGet('SELECT id, amount, status FROM invoices WHERE id = ?', [invoiceId]);
            const sumRow = await dbGet(
                'SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE invoice_id = ?',
                [invoiceId]
            );
            const totalPaid = Number(sumRow?.total) || 0;
            const invAmount = Number(inv?.amount) || 0;
            const tol = 0.009;
            let invoiceRevertedToUnpaid = false;
            if (totalPaid + tol < invAmount) {
                await this.updateInvoiceStatus(invoiceId, 'unpaid', null);
                invoiceRevertedToUnpaid = true;
            }

            await dbRun('COMMIT');
            try {
                logger.info(`[BILLING] Payment ${pid} cancelled; invoice ${invoiceId} unpaid=${invoiceRevertedToUnpaid}`);
            } catch (_) {}
            if (collectorId) {
                setImmediate(() => {
                    try {
                        const cfn = require('./collectorFieldNotifications');
                        cfn.notifyPaymentCancelled(
                            Number(collectorId),
                            pid,
                            `Invoice #${invoiceId} · baris pembayaran dihapus admin`
                        );
                    } catch (_) {}
                });
            }
            return {
                success: true,
                payment_id: pid,
                invoice_id: invoiceId,
                invoice_reverted_unpaid: invoiceRevertedToUnpaid
            };
        } catch (e) {
            await dbRun('ROLLBACK').catch(() => {});
            throw e;
        }
    }

    async getAllCollectors() {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT id, name, phone, status
                FROM collectors
                WHERE status = 'active'
                ORDER BY name ASC
            `;
            
            this.db.all(sql, [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async getPaymentById(id) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT 
                    p.*, 
                    i.invoice_number, 
                    c.username, 
                    c.name as customer_name,
                    col.name as collector_name,
                    col.phone as collector_phone
                FROM payments p
                JOIN invoices i ON p.invoice_id = i.id
                JOIN customers c ON i.customer_id = c.id
                LEFT JOIN collectors col ON p.collector_id = col.id
                WHERE p.id = ?
            `;
            
            this.db.get(sql, [id], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    async updatePayment(id, paymentData) {
        return new Promise((resolve, reject) => {
            const { amount, payment_method, reference_number, notes } = paymentData;
            const sql = `UPDATE payments SET amount = ?, payment_method = ?, reference_number = ?, notes = ? WHERE id = ?`;
            this.db.run(sql, [amount, payment_method, reference_number, notes, id], (err) => {
                if (err) {
                    reject(err);
                } else {
                    this.getPaymentById(id).then(resolve).catch(reject);
                }
            });
        });
    }

    async deletePayment(id) {
        return new Promise((resolve, reject) => {
            // Ambil payment terlebih dahulu untuk reference
            this.getPaymentById(id).then(payment => {
                if (!payment) return reject(new Error('Payment not found'));
                const sql = `DELETE FROM payments WHERE id = ?`;
                this.db.run(sql, [id], (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(payment);
                    }
                });
            }).catch(reject);
        });
    }

    // Utility functions
    generateInvoiceNumber() {
        const date = new Date();
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        return `INV-${year}${month}-${random}`;
    }

    // Calculate next due date based on renewal type
    calculateNextDueDate(customer, currentDueDate, paymentDate) {
        const renewalType = customer.renewal_type || 'renewal';
        const fixDate = customer.fix_date || customer.billing_day || 15;
        const payment = new Date(paymentDate);
        const currentDue = new Date(currentDueDate);
        
        if (renewalType === 'fix_date') {
            // Fix Date: Tanggal jatuh tempo tetap sesuai fix_date
            const nextDue = new Date(currentDue);
            nextDue.setMonth(nextDue.getMonth() + 1);
            nextDue.setDate(Math.min(fixDate, new Date(nextDue.getFullYear(), nextDue.getMonth() + 1, 0).getDate()));
            return nextDue.toISOString().split('T')[0];
        } else {
            // Renewal: Tanggal jatuh tempo mengikuti tanggal pembayaran
            // Jika bayar sebelum jatuh tempo, tanggal tetap
            // Jika bayar setelah jatuh tempo, tanggal berubah sesuai tanggal bayar
            
            if (payment <= currentDue) {
                // Bayar sebelum atau tepat jatuh tempo: tanggal tetap
                const nextDue = new Date(currentDue);
                nextDue.setMonth(nextDue.getMonth() + 1);
                return nextDue.toISOString().split('T')[0];
            } else {
                // Bayar setelah jatuh tempo: tanggal berubah sesuai tanggal bayar
                const nextDue = new Date(payment);
                nextDue.setMonth(nextDue.getMonth() + 1);
                return nextDue.toISOString().split('T')[0];
            }
        }
    }

    // Sync billing date for renewal customers after payment
    async syncBillingDateForRenewal(customerId, nextDueDate) {
        return new Promise((resolve, reject) => {
            // Get customer data
            this.db.get('SELECT * FROM customers WHERE id = ?', [customerId], (err, customer) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                if (!customer) {
                    reject(new Error('Customer not found'));
                    return;
                }
                
                // Only sync for renewal customers
                if (customer.renewal_type !== 'renewal') {
                    resolve({ success: true, message: 'Not a renewal customer, no sync needed' });
                    return;
                }
                
                // Extract day from next due date
                const nextDue = new Date(nextDueDate);
                const newBillingDay = nextDue.getDate();
                
                // Update billing_day in customers table
                this.db.run(
                    'UPDATE customers SET billing_day = ? WHERE id = ?',
                    [newBillingDay, customerId],
                    function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve({
                                success: true,
                                message: `Billing day updated to ${newBillingDay} for customer ${customer.name}`,
                                oldBillingDay: customer.billing_day,
                                newBillingDay: newBillingDay
                            });
                        }
                    }
                );
            });
        });
    }

    // Process direct payment with idempotency check
    async processDirectPaymentWithIdempotency(invoice, result, gateway) {
        try {
            logger.info(`[WEBHOOK] Processing direct payment for invoice: ${invoice.id}`);

            // Check if payment already exists to prevent duplicates
            const existingPaymentSql = `
                SELECT id FROM payments 
                WHERE invoice_id = ? AND reference_number = ? AND payment_method = 'online'
            `;
            
            const existingPayment = await new Promise((resolve, reject) => {
                this.db.get(existingPaymentSql, [invoice.id, result.order_id], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });

            if (existingPayment) {
                logger.warn(`[WEBHOOK] Payment already exists for invoice ${invoice.id}, order ${result.order_id}. Skipping duplicate.`);
                return { success: true, message: 'Payment already processed', duplicate: true };
            }

            // Mark invoice paid and record payment
            await this.updateInvoiceStatus(invoice.id, 'paid', 'online');
            const paymentData = {
                invoice_id: invoice.id,
                amount: result.amount || invoice.amount,
                payment_method: 'online',
                reference_number: result.order_id,
                notes: `Payment via ${gateway} - ${result.payment_type || 'online'}`
            };
            await this.recordPayment(paymentData);

            logger.info(`[WEBHOOK] Direct payment processed successfully for invoice: ${invoice.id}`);
            
            // Restore service if eligible (for both member and customer)
            const isMemberInvoice = invoice.member_id !== null && invoice.member_id !== undefined;
            
            try {
                if (isMemberInvoice) {
                    // Handle member payment
                    const member = await this.getMemberById(invoice.member_id);
                    if (member && (member.status === 'isolir' || member.status === 'suspend')) {
                        const memberInvoices = await this.getInvoices(member.hotspot_username || member.username);
                        const unpaid = memberInvoices.filter(i => i.status === 'unpaid');
                        if (unpaid.length === 0) {
                            const serviceSuspension = require('./serviceSuspension');
                            logger.info(`[WEBHOOK] Restoring member service (direct payment) for ${member.name} (${member.hotspot_username})`);
                            await serviceSuspension.restoreMemberService(member, `Payment via ${gateway} (direct payment)`);
                        }
                    }
                } else {
                    // Handle customer payment
                    const customer = await this.getCustomerById(invoice.customer_id);
                    const { shouldAutoRestoreCustomer: shouldRestoreDirect } = require('../utils/customerSuspendReason');
                    if (shouldRestoreDirect(customer)) {
                        const invoices = await this.getInvoicesByCustomer(customer.id);
                        const unpaid = invoices.filter(i => i.status === 'unpaid');
                        if (unpaid.length === 0) {
                            const serviceSuspension = require('./serviceSuspension');
                            await serviceSuspension.restoreCustomerService(customer);
                        }
                    }
                }
            } catch (restoreErr) {
                logger.error(`[WEBHOOK] Error restoring service after direct payment:`, restoreErr);
            }
            
            return { success: true, message: 'Payment processed successfully' };
        } catch (error) {
            logger.error(`[WEBHOOK] Error processing direct payment:`, error);
            throw error;
        }
    }

    // Generate username otomatis berdasarkan nomor telepon
    generateUsername(phone) {
        // Ambil 4 digit terakhir dari nomor telepon
        const last4Digits = phone.slice(-4);
        const timestamp = Date.now().toString().slice(-6);
        // Tambah random string untuk menghindari collision
        const randomStr = Math.random().toString(36).substring(2, 6);
        return `cust_${last4Digits}_${timestamp}_${randomStr}`;
    }

    // Generate PPPoE username otomatis
    generatePPPoEUsername(phone) {
        // Ambil 4 digit terakhir dari nomor telepon
        const last4Digits = phone.slice(-4);
        // Tambah random string untuk menghindari collision
        const randomStr = Math.random().toString(36).substring(2, 4);
        return `pppoe_${last4Digits}_${randomStr}`;
    }

    // Generate Customer ID 6 digit numerik yang unik
    async generateCustomerId() {
        return new Promise((resolve, reject) => {
            const maxAttempts = 100;
            let attempts = 0;
            
            // First, ensure customer_id column exists
            this.db.run("ALTER TABLE customers ADD COLUMN customer_id TEXT", (alterErr) => {
                // Ignore error if column already exists
                if (alterErr && !alterErr.message.includes('duplicate column name')) {
                    console.warn('Warning: Could not add customer_id column:', alterErr.message);
                }
                
                // Create index if not exists
                this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_customer_id ON customers(customer_id)", (indexErr) => {
                    if (indexErr) {
                        console.warn('Warning: Could not create index for customer_id:', indexErr.message);
                    }
                    
                    const tryGenerate = () => {
                        attempts++;
                        if (attempts > maxAttempts) {
                            return reject(new Error('Failed to generate unique customer ID after maximum attempts'));
                        }
                        
                        // Generate 6 digit number (100000 - 999999)
                        const customerId = Math.floor(100000 + Math.random() * 900000).toString();
                        
                        // Check if ID already exists
                        this.db.get('SELECT id FROM customers WHERE customer_id = ?', [customerId], (err, row) => {
                            if (err) {
                                // If column doesn't exist, try to add it and retry
                                if (err.message.includes('no such column: customer_id')) {
                                    // Column doesn't exist, add it and retry
                                    this.db.run("ALTER TABLE customers ADD COLUMN customer_id TEXT", (addErr) => {
                                        if (addErr && !addErr.message.includes('duplicate column name')) {
                                            return reject(new Error('Customer ID column does not exist and could not be created: ' + addErr.message));
                                        }
                                        // Retry after adding column
                                        setTimeout(() => tryGenerate(), 100);
                                    });
                                } else {
                                    return reject(err);
                                }
                            } else {
                                if (row) {
                                    // ID already exists, try again
                                    return tryGenerate();
                                } else {
                                    // ID is unique, return it
                                    resolve(customerId);
                                }
                            }
                        });
                    };
                    
                    tryGenerate();
                });
            });
        });
    }

    // Generate customer_id untuk customer yang sudah ada (tanpa customer_id)
    async generateCustomerIdsForExistingCustomers() {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT id FROM customers WHERE customer_id IS NULL OR customer_id = ""', [], async (err, rows) => {
                if (err) {
                    console.error('Error getting customers without customer_id:', err);
                    return reject(err);
                }
                
                if (!rows || rows.length === 0) {
                    return resolve();
                }
                
                console.log(`Generating customer_id for ${rows.length} existing customers...`);
                
                for (const row of rows) {
                    try {
                        const customerId = await this.generateCustomerId();
                        this.db.run('UPDATE customers SET customer_id = ? WHERE id = ?', [customerId, row.id], (updateErr) => {
                            if (updateErr) {
                                console.error(`Error updating customer_id for customer ${row.id}:`, updateErr);
                            } else {
                                console.log(`Generated customer_id ${customerId} for customer ${row.id}`);
                            }
                        });
                    } catch (genErr) {
                        console.error(`Error generating customer_id for customer ${row.id}:`, genErr);
                    }
                }
                
                resolve();
            });
        });
    }

    async getOverdueInvoicesCount() {
        return new Promise((resolve) => {
            const sql = "SELECT COUNT(*) as count FROM invoices WHERE status = 'unpaid' AND DATE(due_date) < DATE('now')";
            this.db.get(sql, [], (err, row) => resolve(row ? row.count : 0));
        });
    }

    async getUnpaidInvoicesCount() {
        return new Promise((resolve) => {
            const sql = "SELECT COUNT(*) as count FROM invoices WHERE status = 'unpaid'";
            this.db.get(sql, [], (err, row) => resolve(row ? row.count : 0));
        });
    }

    async getBillingStats() {
        return new Promise((resolve, reject) => {
            // Get current month date range
            const currentDate = new Date();
            const currentMonth = currentDate.getMonth();
            const currentYear = currentDate.getFullYear();
            const currentMonthStart = new Date(currentYear, currentMonth, 1);
            const currentMonthEnd = new Date(currentYear, currentMonth + 1, 0);
            const currentMonthStartStr = currentMonthStart.toISOString().split('T')[0];
            const currentMonthEndStr = currentMonthEnd.toISOString().split('T')[0];
            
            // Check if invoice_type column exists first
            this.db.get("PRAGMA table_info(invoices)", (err, pragmaResult) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                // Check all columns
                this.db.all("PRAGMA table_info(invoices)", (pragmaErr, columns) => {
                    if (pragmaErr) {
                        reject(pragmaErr);
                        return;
                    }
                    
                    const hasInvoiceType = columns.some(col => col.name === 'invoice_type');
                    
                    // Query yang lebih aman dan terpisah untuk menghindari duplikasi data
                    // Hanya menghitung data bulan berjalan untuk pendapatan
                    // Use conditional logic based on column existence
                    let sql;
                    let params;
                    
                    if (hasInvoiceType) {
                        // Query dengan invoice_type column - OPTIMASI: gunakan created_at >= ? instead of DATE(created_at) untuk bisa pakai index
                        sql = `
                            SELECT 
                                (SELECT COUNT(*) FROM customers) as total_customers,
                                (SELECT COUNT(*) FROM customers WHERE status = 'active') as active_customers,
                                (SELECT COUNT(*) FROM invoices WHERE created_at >= ?) as monthly_invoices,
                                (SELECT COUNT(*) FROM invoices WHERE invoice_type = 'voucher') as voucher_invoices,
                                (SELECT COUNT(*) FROM invoices WHERE created_at >= ? AND status = 'paid') as paid_monthly_invoices,
                                (SELECT COUNT(*) FROM invoices WHERE created_at >= ? AND status = 'unpaid' AND (invoice_type != 'voucher' OR invoice_type IS NULL)) as unpaid_monthly_invoices,
                                (SELECT COUNT(*) FROM invoices WHERE invoice_type = 'voucher' AND status = 'paid') as paid_voucher_invoices,
                                (SELECT COUNT(*) FROM invoices WHERE invoice_type = 'voucher' AND status = 'unpaid') as unpaid_voucher_invoices,
                                (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE created_at >= ? AND status = 'paid' AND (invoice_type != 'voucher' OR invoice_type IS NULL)) as monthly_revenue,
                                (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE invoice_type = 'voucher' AND status = 'paid') as voucher_revenue,
                                (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE created_at >= ? AND status = 'unpaid') as monthly_unpaid,
                                (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE invoice_type = 'voucher' AND status = 'unpaid') as voucher_unpaid
                        `;
                        // Gunakan timestamp dengan waktu 00:00:00 untuk comparison
                        params = [
                            currentMonthStartStr + ' 00:00:00',
                            currentMonthStartStr + ' 00:00:00',
                            currentMonthStartStr + ' 00:00:00',
                            currentMonthStartStr + ' 00:00:00',
                            currentMonthStartStr + ' 00:00:00'
                        ];
                    } else {
                        // Fallback query tanpa invoice_type (identify voucher by invoice_number pattern) - OPTIMASI: gunakan created_at >= ? instead of DATE()
                        sql = `
                            SELECT 
                                (SELECT COUNT(*) FROM customers) as total_customers,
                                (SELECT COUNT(*) FROM customers WHERE status = 'active') as active_customers,
                                (SELECT COUNT(*) FROM invoices WHERE created_at >= ?) as monthly_invoices,
                                (SELECT COUNT(*) FROM invoices WHERE invoice_number LIKE 'INV-VCR-%' OR notes LIKE 'Voucher Hotspot%') as voucher_invoices,
                                (SELECT COUNT(*) FROM invoices WHERE created_at >= ? AND status = 'paid') as paid_monthly_invoices,
                                (SELECT COUNT(*) FROM invoices WHERE created_at >= ? AND status = 'unpaid' AND invoice_number NOT LIKE 'INV-VCR-%' AND notes NOT LIKE 'Voucher Hotspot%') as unpaid_monthly_invoices,
                                (SELECT COUNT(*) FROM invoices WHERE (invoice_number LIKE 'INV-VCR-%' OR notes LIKE 'Voucher Hotspot%') AND status = 'paid') as paid_voucher_invoices,
                                (SELECT COUNT(*) FROM invoices WHERE (invoice_number LIKE 'INV-VCR-%' OR notes LIKE 'Voucher Hotspot%') AND status = 'unpaid') as unpaid_voucher_invoices,
                                (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE created_at >= ? AND status = 'paid' AND invoice_number NOT LIKE 'INV-VCR-%' AND notes NOT LIKE 'Voucher Hotspot%') as monthly_revenue,
                                (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE (invoice_number LIKE 'INV-VCR-%' OR notes LIKE 'Voucher Hotspot%') AND status = 'paid') as voucher_revenue,
                                (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE created_at >= ? AND status = 'unpaid') as monthly_unpaid,
                                (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE (invoice_number LIKE 'INV-VCR-%' OR notes LIKE 'Voucher Hotspot%') AND status = 'unpaid') as voucher_unpaid
                        `;
                        // Gunakan timestamp dengan waktu 00:00:00 untuk comparison
                        params = [
                            currentMonthStartStr + ' 00:00:00',
                            currentMonthStartStr + ' 00:00:00',
                            currentMonthStartStr + ' 00:00:00',
                            currentMonthStartStr + ' 00:00:00',
                            currentMonthStartStr + ' 00:00:00'
                        ];
                    }
                    
                    this.db.get(sql, params, (err, row) => {
                        if (err) {
                            reject(err);
                        } else {
                            // Pastikan semua nilai adalah angka dan tidak null
                            const stats = {
                                // Customer stats
                                total_customers: parseInt(row.total_customers) || 0,
                                active_customers: parseInt(row.active_customers) || 0,
                                
                                // Invoice counts by type
                                monthly_invoices: parseInt(row.monthly_invoices) || 0,
                                voucher_invoices: parseInt(row.voucher_invoices) || 0,
                                
                                // Paid invoices by type
                                paid_monthly_invoices: parseInt(row.paid_monthly_invoices) || 0,
                                paid_voucher_invoices: parseInt(row.paid_voucher_invoices) || 0,
                                
                                // Unpaid invoices by type
                                unpaid_monthly_invoices: parseInt(row.unpaid_monthly_invoices) || 0,
                                unpaid_voucher_invoices: parseInt(row.unpaid_voucher_invoices) || 0,
                                
                                // Revenue by type
                                monthly_revenue: parseFloat(row.monthly_revenue) || 0,
                                voucher_revenue: parseFloat(row.voucher_revenue) || 0,
                                
                                // Unpaid amounts by type
                                monthly_unpaid: parseFloat(row.monthly_unpaid) || 0,
                                voucher_unpaid: parseFloat(row.voucher_unpaid) || 0,
                                
                                // Legacy fields for backward compatibility
                                total_invoices: (parseInt(row.monthly_invoices) || 0) + (parseInt(row.voucher_invoices) || 0),
                                paid_invoices: (parseInt(row.paid_monthly_invoices) || 0) + (parseInt(row.paid_voucher_invoices) || 0),
                                unpaid_invoices: (parseInt(row.unpaid_monthly_invoices) || 0) + (parseInt(row.unpaid_voucher_invoices) || 0),
                                total_revenue: (parseFloat(row.monthly_revenue) || 0) + (parseFloat(row.voucher_revenue) || 0),
                                total_unpaid: (parseFloat(row.monthly_unpaid) || 0) + (parseFloat(row.voucher_unpaid) || 0)
                            };
                            
                            // Validasi logika: active_customers tidak boleh lebih dari total_customers
                            if (stats.active_customers > stats.total_customers) {
                                console.warn('Warning: Active customers count is higher than total customers. This indicates data inconsistency.');
                                // Set active_customers to total_customers as fallback
                                stats.active_customers = stats.total_customers;
                            }
                            
                            const finalizeStats = async () => {
                                try {
                                    const voucherInvoices = await this.getVoucherInvoices(currentMonthStartStr, currentMonthEndStr);
                                    const voucherStats = this.calculateVoucherStats(voucherInvoices);
                                    
                                    stats.voucher_summary = {
                                        total_vouchers: voucherStats.total_vouchers,
                                        recognized_vouchers: voucherStats.paid_vouchers,
                                        pending_vouchers: voucherStats.unpaid_vouchers,
                                        recognized_revenue: voucherStats.total_revenue,
                                        pending_revenue: voucherStats.unpaid_amount
                                    };
                                    
                                    stats.voucher_invoices = voucherStats.total_vouchers;
                                    stats.paid_voucher_invoices = voucherStats.paid_vouchers;
                                    stats.unpaid_voucher_invoices = voucherStats.unpaid_vouchers;
                                    stats.voucher_revenue = voucherStats.total_revenue;
                                    stats.voucher_unpaid = voucherStats.unpaid_amount;
                                    
                                    stats.total_invoices = (parseInt(row.monthly_invoices) || 0) + voucherStats.total_vouchers;
                                    stats.paid_invoices = (parseInt(row.paid_monthly_invoices) || 0) + voucherStats.paid_vouchers;
                                    stats.unpaid_invoices = (parseInt(row.unpaid_monthly_invoices) || 0) + voucherStats.unpaid_vouchers;
                                    stats.total_revenue = (parseFloat(row.monthly_revenue) || 0) + voucherStats.total_revenue;
                                    stats.total_unpaid = (parseFloat(row.monthly_unpaid) || 0) + voucherStats.unpaid_amount;
                                } catch (voucherErr) {
                                    logger.error(`Failed to compute voucher stats for dashboard: ${voucherErr.message}`);
                                    stats.voucher_summary = {
                                        total_vouchers: stats.voucher_invoices,
                                        recognized_vouchers: stats.paid_voucher_invoices,
                                        pending_vouchers: stats.unpaid_voucher_invoices,
                                        recognized_revenue: stats.voucher_revenue,
                                        pending_revenue: stats.voucher_unpaid
                                    };
                                }
                                try {
                                    const mNum = currentMonth + 1;
                                    const mt = await this.getMonthlyTagihanTotals(mNum, currentYear, {
                                        scope: 'all'
                                    });
                                    stats.monthly_total_tagihan = mt.total_tagihan;
                                    stats.monthly_invoice_count_canonical = mt.count_total;
                                    stats.monthly_lunas_canonical = mt.total_lunas;
                                    stats.monthly_lunas_count_canonical = mt.count_lunas;
                                    stats.monthly_belum_lunas_canonical = mt.total_belum_lunas;
                                    stats.monthly_belum_lunas_count_canonical = mt.count_belum_lunas;
                                    /** Selaras kartu dashboard: unpaid bulan ini (bukan seluruh piutang). */
                                    stats.monthly_unpaid = mt.total_belum_lunas;
                                    stats.unpaid_monthly_invoices = mt.count_belum_lunas;
                                    const piutang = await this.getOutstandingUnpaidTotals();
                                    stats.outstanding_unpaid_total = piutang.total_unpaid;
                                    stats.outstanding_unpaid_count = piutang.count_unpaid;
                                } catch (tagErr) {
                                    console.warn('[billing] monthly_total_tagihan:', tagErr.message);
                                    stats.monthly_total_tagihan =
                                        (stats.monthly_revenue || 0) + (stats.monthly_unpaid || 0);
                                } finally {
                                    resolve(stats);
                                }
                            };
                            
                            finalizeStats();
                        }
                    });
                });
            });
        });
    }

    // Fungsi untuk membersihkan data duplikat dan memperbaiki konsistensi
    async cleanupDataConsistency() {
        return new Promise((resolve, reject) => {
            const cleanupQueries = [
                // 1. Hapus duplikat customers berdasarkan phone (keep yang terbaru)
                `DELETE FROM customers 
                 WHERE id NOT IN (
                     SELECT MAX(id) 
                     FROM customers 
                     GROUP BY phone
                 )`,
                
                // 2. Update status customers yang tidak valid (tapi jangan ubah 'register' / 'isolir')
                `UPDATE customers 
                 SET status = 'inactive' 
                 WHERE status NOT IN ('active', 'inactive', 'suspended', 'isolir', 'register')`,
                
                // 3. Update status invoices yang tidak valid
                `UPDATE invoices 
                 SET status = 'unpaid' 
                 WHERE status NOT IN ('paid', 'unpaid', 'cancelled')`,
                
                // 4. Pastikan amount invoice tidak null atau negatif
                `UPDATE invoices 
                 SET amount = 0 
                 WHERE amount IS NULL OR amount < 0`,
                
                // 5. Hapus invoices yang tidak memiliki customer
                `DELETE FROM invoices 
                 WHERE customer_id NOT IN (SELECT id FROM customers)`
            ];
            
            let completed = 0;
            const total = cleanupQueries.length;
            
            cleanupQueries.forEach((query, index) => {
                this.db.run(query, [], (err) => {
                    if (err) {
                        console.warn(`Cleanup query ${index + 1} failed:`, err.message);
                    }
                    
                    completed++;
                    if (completed === total) {
                        console.log('Data consistency cleanup completed');
                        resolve(true);
                    }
                });
            });
        });
    }

    // Fungsi untuk mendapatkan invoice berdasarkan type
    async getInvoicesByType(invoiceType = 'monthly') {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT i.*, c.username as customer_username, c.name as customer_name, c.phone as customer_phone, c.address as customer_address,
                       p.name as package_name, p.speed as package_speed
                FROM invoices i
                LEFT JOIN customers c ON i.customer_id = c.id
                LEFT JOIN packages p ON i.package_id = p.id
                WHERE i.invoice_type = ?
                ORDER BY i.created_at DESC
            `;
            
            this.db.all(sql, [invoiceType], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    // Fungsi untuk mendapatkan statistik berdasarkan invoice type
    async getInvoiceStatsByType(invoiceType = 'monthly') {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT 
                    COUNT(*) as total_invoices,
                    COUNT(CASE WHEN status = 'paid' THEN 1 END) as paid_invoices,
                    COUNT(CASE WHEN status = 'unpaid' THEN 1 END) as unpaid_invoices,
                    COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as total_revenue,
                    COALESCE(SUM(CASE WHEN status = 'unpaid' THEN amount ELSE 0 END), 0) as total_unpaid
                FROM invoices 
                WHERE invoice_type = ?
            `;
            
            this.db.get(sql, [invoiceType], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve({
                        total_invoices: parseInt(row.total_invoices) || 0,
                        paid_invoices: parseInt(row.paid_invoices) || 0,
                        unpaid_invoices: parseInt(row.unpaid_invoices) || 0,
                        total_revenue: parseFloat(row.total_revenue) || 0,
                        total_unpaid: parseFloat(row.total_unpaid) || 0
                    });
                }
            });
        });
    }

    // Voucher cleanup methods
    async cleanupExpiredVoucherInvoices() {
        return new Promise((resolve, reject) => {
            const cleanupEnabled = getSetting('voucher_cleanup.enabled', true);
            const expiryHours = parseInt(getSetting('voucher_cleanup.expiry_hours', '24'));
            const deleteInvoices = getSetting('voucher_cleanup.delete_expired_invoices', true);
            const logActions = getSetting('voucher_cleanup.log_cleanup_actions', true);
            
            if (!cleanupEnabled) {
                resolve({ success: true, message: 'Voucher cleanup disabled', cleaned: 0 });
                return;
            }
            
            // Calculate expiry time
            const expiryTime = new Date();
            expiryTime.setHours(expiryTime.getHours() - expiryHours);
            const expiryTimeStr = expiryTime.toISOString();
            
            if (logActions) {
                console.log(`🧹 Starting voucher cleanup for invoices older than ${expiryHours} hours (before ${expiryTimeStr})`);
            }
            
            // First, get expired invoices for logging
            const selectSql = `
                SELECT i.id, i.invoice_number, i.amount, i.created_at, i.status, c.name as customer_name
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                WHERE i.invoice_type = 'voucher' 
                AND i.status = 'unpaid' 
                AND i.created_at < ?
                ORDER BY i.created_at ASC
            `;
            
            this.db.all(selectSql, [expiryTimeStr], (err, expiredInvoices) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                if (expiredInvoices.length === 0) {
                    if (logActions) {
                        console.log('✅ No expired voucher invoices found');
                    }
                    resolve({ success: true, message: 'No expired invoices found', cleaned: 0 });
                    return;
                }
                
                if (logActions) {
                    console.log(`📋 Found ${expiredInvoices.length} expired voucher invoices:`);
                    expiredInvoices.forEach(invoice => {
                        console.log(`   - ${invoice.invoice_number} (${invoice.customer_name}) - ${invoice.amount} - ${invoice.created_at}`);
                    });
                }
                
                if (deleteInvoices) {
                    // Delete expired invoices
                    const deleteSql = `
                        DELETE FROM invoices 
                        WHERE invoice_type = 'voucher' 
                        AND status = 'unpaid' 
                        AND created_at < ?
                    `;
                    
                    this.db.run(deleteSql, [expiryTimeStr], function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            const deletedCount = this.changes;
                            if (logActions) {
                                console.log(`🗑️  Deleted ${deletedCount} expired voucher invoices`);
                            }
                            resolve({ 
                                success: true, 
                                message: `Cleaned up ${deletedCount} expired voucher invoices`,
                                cleaned: deletedCount,
                                expiredInvoices: expiredInvoices
                            });
                        }
                    });
                } else {
                    // Just mark as expired without deleting
                    const updateSql = `
                        UPDATE invoices 
                        SET notes = COALESCE(notes, '') || ' [EXPIRED - NOT DELETED]'
                        WHERE invoice_type = 'voucher' 
                        AND status = 'unpaid' 
                        AND created_at < ?
                    `;
                    
                    this.db.run(updateSql, [expiryTimeStr], function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            const updatedCount = this.changes;
                            if (logActions) {
                                console.log(`🏷️  Marked ${updatedCount} expired voucher invoices as expired`);
                            }
                            resolve({ 
                                success: true, 
                                message: `Marked ${updatedCount} expired voucher invoices as expired`,
                                cleaned: updatedCount,
                                expiredInvoices: expiredInvoices
                            });
                        }
                    });
                }
            });
        });
    }
    
    async getExpiredVoucherInvoices() {
        return new Promise((resolve, reject) => {
            const expiryHours = parseInt(getSetting('voucher_cleanup.expiry_hours', '24'));
            
            const expiryTime = new Date();
            expiryTime.setHours(expiryTime.getHours() - expiryHours);
            const expiryTimeStr = expiryTime.toISOString();
            
            const sql = `
                SELECT i.id, i.invoice_number, i.amount, i.created_at, i.status, i.notes,
                       c.name as customer_name, c.phone as customer_phone
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                WHERE i.invoice_type = 'voucher' 
                AND i.status = 'unpaid' 
                AND i.created_at < ?
                ORDER BY i.created_at ASC
            `;
            
            this.db.all(sql, [expiryTimeStr], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    // Monthly summary methods
    async saveMonthlySummary(year, month, stats, notes = null) {
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT OR REPLACE INTO monthly_summary (
                    year, month, total_customers, active_customers,
                    monthly_invoices, voucher_invoices,
                    paid_monthly_invoices, paid_voucher_invoices,
                    unpaid_monthly_invoices, unpaid_voucher_invoices,
                    monthly_revenue, voucher_revenue,
                    monthly_unpaid, voucher_unpaid,
                    total_revenue, total_unpaid, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            
            const params = [
                year, month,
                stats.total_customers || 0,
                stats.active_customers || 0,
                stats.monthly_invoices || 0,
                stats.voucher_invoices || 0,
                stats.paid_monthly_invoices || 0,
                stats.paid_voucher_invoices || 0,
                stats.unpaid_monthly_invoices || 0,
                stats.unpaid_voucher_invoices || 0,
                stats.monthly_revenue || 0,
                stats.voucher_revenue || 0,
                stats.monthly_unpaid || 0,
                stats.voucher_unpaid || 0,
                stats.total_revenue || 0,
                stats.total_unpaid || 0,
                notes
            ];
            
            this.db.run(sql, params, function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id: this.lastID, year, month });
                }
            });
        });
    }

    async getMonthlySummary(year, month) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT * FROM monthly_summary 
                WHERE year = ? AND month = ?
            `;
            
            this.db.get(sql, [year, month], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    async getAllMonthlySummaries(limit = 12) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT * FROM monthly_summary 
                ORDER BY year DESC, month DESC 
                LIMIT ?
            `;
            
            this.db.all(sql, [limit], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async generateMonthlySummary() {
        try {
            const now = new Date();
            const year = now.getFullYear();
            const month = now.getMonth() + 1; // JavaScript months are 0-based
            
            // Get current stats
            const stats = await this.getBillingStats();
            
            // Save to monthly summary
            const notes = `Summary generated on ${now.toISOString().split('T')[0]}`;
            const result = await this.saveMonthlySummary(year, month, stats, notes);
            
            logger.info(`Monthly summary saved for ${year}-${month}: ${JSON.stringify(stats)}`);
            
            return {
                success: true,
                message: `Monthly summary saved for ${year}-${month}`,
                year,
                month,
                stats,
                id: result.id
            };
        } catch (error) {
            logger.error('Error generating monthly summary:', error);
            throw error;
        }
    }

    // Auto reset monthly summary for all collectors and admin
    async performMonthlyReset() {
        try {
            const now = new Date();
            const currentYear = now.getFullYear();
            const currentMonth = now.getMonth() + 1;
            
            // Get previous month for saving summary
            const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
            const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
            
            logger.info(`🔄 Starting monthly reset for ${currentYear}-${currentMonth}`);
            
            // 1. Save admin monthly summary for previous month
            const adminStats = await this.getBillingStats();
            await this.saveMonthlySummary(prevYear, prevMonth, adminStats, `Auto-generated on ${now.toISOString().split('T')[0]}`);
            logger.info(`✅ Admin monthly summary saved for ${prevYear}-${prevMonth}`);
            
            // 2. Save collector monthly summaries for previous month
            const collectors = await this.getAllCollectors();
            for (const collector of collectors) {
                const collectorStats = {
                    total_payments: await this.getCollectorMonthlyPayments(collector.id, prevYear, prevMonth),
                    total_commission: await this.getCollectorMonthlyCommission(collector.id, prevYear, prevMonth),
                    payment_count: await this.getCollectorMonthlyCount(collector.id, prevYear, prevMonth)
                };
                
                await this.saveCollectorMonthlySummary(collector.id, prevYear, prevMonth, collectorStats);
                logger.info(`✅ Collector ${collector.name} monthly summary saved for ${prevYear}-${prevMonth}`);
            }
            
            // 3. Create collector_monthly_summary table if not exists
            await this.ensureCollectorMonthlySummaryTable();
            
            logger.info(`🎉 Monthly reset completed successfully for ${currentYear}-${currentMonth}`);
            
            return {
                success: true,
                message: `Monthly reset completed for ${currentYear}-${currentMonth}`,
                year: currentYear,
                month: currentMonth,
                previousYear: prevYear,
                previousMonth: prevMonth,
                collectorsProcessed: collectors.length
            };
            
        } catch (error) {
            logger.error('Error performing monthly reset:', error);
            throw error;
        }
    }

    // Ensure collector_monthly_summary table exists
    async ensureCollectorMonthlySummaryTable() {
        return new Promise((resolve, reject) => {
            this.db.run(`
                CREATE TABLE IF NOT EXISTS collector_monthly_summary (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    collector_id INTEGER NOT NULL,
                    year INTEGER NOT NULL,
                    month INTEGER NOT NULL,
                    total_payments REAL NOT NULL DEFAULT 0,
                    total_commission REAL NOT NULL DEFAULT 0,
                    payment_count INTEGER NOT NULL DEFAULT 0,
                    created_at DATETIME DEFAULT (datetime('now','localtime')),
                    updated_at DATETIME DEFAULT (datetime('now','localtime')),
                    UNIQUE(collector_id, year, month)
                )
            `, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    // Get all collectors
    async getAllCollectors() {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT * FROM collectors WHERE status = "active"', (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    // Mobile dashboard specific methods
    async getTotalCustomers() {
        return new Promise((resolve, reject) => {
            const sql = `SELECT COUNT(*) as count FROM customers`;
            this.db.get(sql, [], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row.count || 0);
                }
            });
        });
    }

    async getTotalInvoices() {
        return new Promise((resolve, reject) => {
            const sql = `SELECT COUNT(*) as count FROM invoices`;
            this.db.get(sql, [], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row.count || 0);
                }
            });
        });
    }

    async getTotalRevenue() {
        return new Promise((resolve, reject) => {
            const sql = `SELECT SUM(amount) as total FROM invoices WHERE status = 'paid'`;
            this.db.get(sql, [], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row.total || 0);
                }
            });
        });
    }

    async getPendingPayments() {
        return new Promise((resolve, reject) => {
            const sql = `SELECT COUNT(*) as count FROM invoices WHERE status = 'unpaid'`;
            this.db.get(sql, [], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row.count || 0);
                }
            });
        });
    }

    async getReportsStats() {
        return new Promise((resolve, reject) => {
            try {
                // Get all stats in parallel with error handling for each query
                Promise.all([
                    // Active customers
                    new Promise((res, rej) => {
                        this.db.get(`SELECT COUNT(*) as count FROM customers WHERE status = 'active'`, [], (err, row) => {
                            if (err) {
                                console.error('Error getting active customers:', err);
                                res(0); // Return 0 on error instead of rejecting
                            } else {
                                res(row?.count || 0);
                            }
                        });
                    }),
                    // Inactive customers
                    new Promise((res, rej) => {
                        this.db.get(`SELECT COUNT(*) as count FROM customers WHERE status IN ('inactive', 'suspended')`, [], (err, row) => {
                            if (err) {
                                console.error('Error getting inactive customers:', err);
                                res(0);
                            } else {
                                res(row?.count || 0);
                            }
                        });
                    }),
                    // New customers this month
                    new Promise((res, rej) => {
                        this.db.get(`
                            SELECT COUNT(*) as count 
                            FROM customers 
                            WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime')
                        `, [], (err, row) => {
                            if (err) {
                                console.error('Error getting new customers this month:', err);
                                res(0);
                            } else {
                                res(row?.count || 0);
                            }
                        });
                    }),
                    // Invoices this month
                    new Promise((res, rej) => {
                        this.db.get(`
                            SELECT COUNT(*) as count 
                            FROM invoices 
                            WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime')
                        `, [], (err, row) => {
                            if (err) {
                                console.error('Error getting invoices this month:', err);
                                res(0);
                            } else {
                                res(row?.count || 0);
                            }
                        });
                    }),
                    // Paid invoices
                    new Promise((res, rej) => {
                        this.db.get(`SELECT COUNT(*) as count FROM invoices WHERE status = 'paid'`, [], (err, row) => {
                            if (err) {
                                console.error('Error getting paid invoices:', err);
                                res(0);
                            } else {
                                res(row?.count || 0);
                            }
                        });
                    }),
                    // Unpaid invoices
                    new Promise((res, rej) => {
                        this.db.get(`SELECT COUNT(*) as count FROM invoices WHERE status = 'unpaid'`, [], (err, row) => {
                            if (err) {
                                console.error('Error getting unpaid invoices:', err);
                                res(0);
                            } else {
                                res(row?.count || 0);
                            }
                        });
                    }),
                    // Successful payments
                    new Promise((res, rej) => {
                        this.db.get(`SELECT COUNT(*) as count FROM payments WHERE status = 'completed'`, [], (err, row) => {
                            if (err) {
                                console.error('Error getting successful payments:', err);
                                res(0);
                            } else {
                                res(row?.count || 0);
                            }
                        });
                    }),
                    // Failed payments
                    new Promise((res, rej) => {
                        this.db.get(`SELECT COUNT(*) as count FROM payments WHERE status = 'failed'`, [], (err, row) => {
                            if (err) {
                                console.error('Error getting failed payments:', err);
                                res(0);
                            } else {
                                res(row?.count || 0);
                            }
                        });
                    })
                ]).then(([
                    activeCustomers,
                    inactiveCustomers,
                    newCustomersThisMonth,
                    invoicesThisMonth,
                    paidInvoices,
                    unpaidInvoices,
                    successfulPayments,
                    failedPayments
                ]) => {
                    // Calculate retention rate
                    const totalCustomers = activeCustomers + inactiveCustomers;
                    const retentionRate = totalCustomers > 0 
                        ? Math.round((activeCustomers / totalCustomers) * 100) 
                        : 0;
                    
                    // Calculate payment rate
                    const totalInvoices = paidInvoices + unpaidInvoices;
                    const paymentRate = totalInvoices > 0 
                        ? Math.round((paidInvoices / totalInvoices) * 100) 
                        : 0;
                    
                    resolve({
                        activeCustomers: activeCustomers || 0,
                        inactiveCustomers: inactiveCustomers || 0,
                        newCustomersThisMonth: newCustomersThisMonth || 0,
                        invoicesThisMonth: invoicesThisMonth || 0,
                        paidInvoices: paidInvoices || 0,
                        unpaidInvoices: unpaidInvoices || 0,
                        successfulPayments: successfulPayments || 0,
                        failedPayments: failedPayments || 0,
                        retentionRate: retentionRate || 0,
                        paymentRate: paymentRate || 0
                    });
                }).catch((err) => {
                    console.error('Error in getReportsStats Promise.all:', err);
                    // Return default values instead of rejecting
                    resolve({
                        activeCustomers: 0,
                        inactiveCustomers: 0,
                        newCustomersThisMonth: 0,
                        invoicesThisMonth: 0,
                        paidInvoices: 0,
                        unpaidInvoices: 0,
                        successfulPayments: 0,
                        failedPayments: 0,
                        retentionRate: 0,
                        paymentRate: 0
                    });
                });
            } catch (error) {
                console.error('Error in getReportsStats:', error);
                // Return default values instead of rejecting
                resolve({
                    activeCustomers: 0,
                    inactiveCustomers: 0,
                    newCustomersThisMonth: 0,
                    invoicesThisMonth: 0,
                    paidInvoices: 0,
                    unpaidInvoices: 0,
                    successfulPayments: 0,
                    failedPayments: 0,
                    retentionRate: 0,
                    paymentRate: 0
                });
            }
        });
    }

    async getOverdueInvoices(limit = null) {
        return new Promise((resolve, reject) => {
            let sql = `
                SELECT i.*, 
                       c.username, c.name as customer_name, c.phone as customer_phone,
                       m.hotspot_username as member_hotspot_username, m.name as member_name, m.phone as member_phone,
                       p.name as package_name,
                       CASE WHEN i.customer_id IS NOT NULL THEN 'customer' ELSE 'member' END as invoice_type_entity
                FROM invoices i
                LEFT JOIN customers c ON i.customer_id = c.id
                LEFT JOIN members m ON i.member_id = m.id
                LEFT JOIN packages p ON i.package_id = p.id
                LEFT JOIN member_packages mp ON i.package_id = mp.id
                WHERE i.status = 'unpaid' AND date(i.due_date) < date('now', 'localtime')
                ORDER BY i.due_date ASC
            `;
            
            const params = [];
            if (limit) {
                sql += ` LIMIT ?`;
                params.push(limit);
            }
            
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    _normalizeAreaIds(area_ids) {
        const raw = Array.isArray(area_ids) ? area_ids : (area_ids != null ? [area_ids] : []);
        return [...new Set(raw.map((id) => parseInt(id, 10)).filter((id) => Number.isFinite(id) && id > 0))];
    }

    _buildCustomersInAreasWhere(areaIds, alias = '') {
        const a = alias ? `${alias}.` : '';
        const placeholders = areaIds.map(() => '?').join(',');
        return {
            clause: `(
                ${a}area_id IN (${placeholders})
                OR LOWER(TRIM(IFNULL(${a}area, ''))) IN (
                    SELECT LOWER(TRIM(nama_area)) FROM areas WHERE id IN (${placeholders})
                )
                OR LOWER(TRIM(IFNULL(${a}area, ''))) IN (
                    SELECT LOWER(TRIM(kode_area)) FROM areas
                    WHERE id IN (${placeholders}) AND kode_area IS NOT NULL AND TRIM(kode_area) != ''
                )
            )`,
            params: [...areaIds, ...areaIds, ...areaIds]
        };
    }

    /**
     * Update masal tanggal jatuh tempo (fix_date) per wilayah + sesuaikan invoice unpaid.
     */
    async bulkUpdateDueDateByAreas({ area_ids, due_day }) {
        const ids = this._normalizeAreaIds(area_ids);
        if (ids.length === 0) {
            throw new Error('Pilih minimal satu wilayah');
        }

        const normDay = Math.min(Math.max(parseInt(due_day, 10) || 15, 1), 28);
        const { clause, params: areaParams } = this._buildCustomersInAreasWhere(ids);

        return new Promise((resolve, reject) => {
            this.db.get(`SELECT COUNT(*) AS total FROM customers WHERE ${clause}`, areaParams, (err, countRow) => {
                if (err) return reject(err);

                const total = Number(countRow?.total || 0);
                const dbRef = this.db;

                this.db.serialize(() => {
                    this.db.run('BEGIN TRANSACTION');

                    this.db.run(
                        `UPDATE customers SET renewal_type = 'fix_date', fix_date = ? WHERE ${clause}`,
                        [normDay, ...areaParams],
                        function (uErr) {
                            if (uErr) {
                                dbRef.run('ROLLBACK');
                                return reject(uErr);
                            }

                            const updated = this.changes;
                            const failed = Math.max(0, total - updated);

                            const invoiceSql = `
                                UPDATE invoices SET due_date = date(
                                    CASE
                                        WHEN cast(strftime('%d','now','localtime') AS integer) <= ?
                                        THEN strftime('%Y-%m','now','localtime') || '-' || printf('%02d', ?)
                                        ELSE strftime('%Y-%m', date('now','localtime','start of month','+1 month')) || '-' || printf('%02d', ?)
                                    END
                                )
                                WHERE status = 'unpaid'
                                  AND customer_id IN (SELECT id FROM customers WHERE ${clause})
                            `;
                            const invoiceParams = [normDay, normDay, normDay, ...areaParams];

                            dbRef.run(invoiceSql, invoiceParams, function (iErr) {
                                if (iErr) {
                                    dbRef.run('ROLLBACK');
                                    return reject(iErr);
                                }

                                const invoicesUpdated = this.changes;
                                dbRef.run('COMMIT', (cErr) => {
                                    if (cErr) return reject(cErr);
                                    resolve({
                                        total,
                                        updated,
                                        failed,
                                        invoices_updated: invoicesUpdated,
                                        need_retry: failed > 0,
                                        due_day: normDay,
                                        area_ids: ids
                                    });
                                });
                            });
                        }
                    );
                });
            });
        });
    }

    /**
     * Update masal tanggal auto isolir per wilayah (kolom auto_suspension_day per pelanggan).
     */
    async bulkUpdateAutoIsolirDayByAreas({ area_ids, auto_suspension_day }) {
        const ids = this._normalizeAreaIds(area_ids);
        if (ids.length === 0) {
            throw new Error('Pilih minimal satu wilayah');
        }

        const normDay = Math.min(Math.max(parseInt(auto_suspension_day, 10) || 25, 1), 28);
        const { clause, params: areaParams } = this._buildCustomersInAreasWhere(ids);

        return new Promise((resolve, reject) => {
            this.db.get(`SELECT COUNT(*) AS total FROM customers WHERE ${clause}`, areaParams, (err, countRow) => {
                if (err) return reject(err);

                const total = Number(countRow?.total || 0);

                this.db.run(
                    `UPDATE customers SET auto_suspension_day = ? WHERE ${clause}`,
                    [normDay, ...areaParams],
                    function (uErr) {
                        if (uErr) return reject(uErr);

                        const updated = this.changes;
                        const failed = Math.max(0, total - updated);

                        resolve({
                            total,
                            updated,
                            failed,
                            need_retry: failed > 0,
                            auto_suspension_day: normDay,
                            area_ids: ids
                        });
                    }
                );
            });
        });
    }

    /**
     * Ringkasan tanggal auto isolir per pelanggan (setelah update massal per wilayah).
     */
    async getAutoIsolirScheduleSummary(area_ids) {
        const ids = this._normalizeAreaIds(area_ids);
        let whereClause = '';
        let areaParams = [];
        let joinWhereClause = '';
        if (ids.length > 0) {
            const built = this._buildCustomersInAreasWhere(ids);
            whereClause = `WHERE ${built.clause}`;
            areaParams = built.params;
            joinWhereClause = `WHERE ${this._buildCustomersInAreasWhere(ids, 'c').clause}`;
        }

        return new Promise((resolve, reject) => {
            const daySql = `
                SELECT auto_suspension_day AS day_value, COUNT(*) AS count
                FROM customers
                ${whereClause}
                GROUP BY auto_suspension_day
                ORDER BY count DESC, day_value ASC
            `;

            this.db.all(daySql, areaParams, (err, dayRows) => {
                if (err) return reject(err);

                const byAreaSql = `
                    SELECT
                        COALESCE(ar.nama_area, NULLIF(TRIM(c.area), ''), 'Tanpa wilayah') AS area_name,
                        c.auto_suspension_day AS day_value,
                        COUNT(*) AS count
                    FROM customers c
                    LEFT JOIN areas ar ON ar.id = c.area_id
                    ${joinWhereClause}
                    GROUP BY area_name, c.auto_suspension_day
                    ORDER BY area_name ASC, day_value ASC
                `;

                this.db.all(byAreaSql, areaParams, (aErr, areaRows) => {
                    if (aErr) return reject(aErr);

                    const listSql = `
                        SELECT
                            c.id,
                            c.username,
                            c.name,
                            COALESCE(ar.nama_area, NULLIF(TRIM(c.area), ''), '-') AS area_name,
                            c.auto_suspension_day
                        FROM customers c
                        LEFT JOIN areas ar ON ar.id = c.area_id
                        ${joinWhereClause}
                        ORDER BY area_name ASC, c.name ASC
                        LIMIT 500
                    `;

                    this.db.all(listSql, areaParams, (lErr, customers) => {
                        if (lErr) return reject(lErr);

                        const total = (dayRows || []).reduce((s, r) => s + Number(r.count || 0), 0);

                        resolve({
                            total,
                            area_ids: ids,
                            by_day: (dayRows || []).map((r) => ({
                                day_value: r.day_value,
                                count: Number(r.count || 0)
                            })),
                            by_area: (areaRows || []).map((r) => ({
                                area_name: r.area_name,
                                day_value: r.day_value,
                                count: Number(r.count || 0)
                            })),
                            customers: customers || []
                        });
                    });
                });
            });
        });
    }

    /**
     * Update masal siklus tagihan/isolir seluruh pelanggan + sesuaikan jatuh tempo invoice unpaid (fix_date).
     */
    async bulkUpdateCustomerBillingCycle({ renewal_type, billing_day, fix_date }) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT COUNT(*) AS total FROM customers', [], (err, countRow) => {
                if (err) return reject(err);

                const total = Number(countRow?.total || 0);
                let updateQuery;
                let params;
                let normFixDate = null;

                if (renewal_type === 'fix_date') {
                    normFixDate = Math.min(Math.max(parseInt(fix_date, 10) || 15, 1), 28);
                    updateQuery = 'UPDATE customers SET renewal_type = ?, fix_date = ?';
                    params = ['fix_date', normFixDate];
                } else {
                    const bDay = Math.min(Math.max(parseInt(billing_day, 10) || 30, 1), 365);
                    updateQuery = 'UPDATE customers SET renewal_type = ?, billing_day = ?';
                    params = ['renewal', bDay];
                }

                const dbRef = this.db;
                this.db.serialize(() => {
                    this.db.run('BEGIN TRANSACTION');

                    this.db.run(updateQuery, params, function (uErr) {
                        if (uErr) {
                            dbRef.run('ROLLBACK');
                            return reject(uErr);
                        }

                        const updated = this.changes;
                        const failed = Math.max(0, total - updated);

                        const done = (invoicesUpdated = 0) => {
                            dbRef.run('COMMIT', (cErr) => {
                                if (cErr) return reject(cErr);
                                resolve({
                                    total,
                                    updated,
                                    failed,
                                    invoices_updated: invoicesUpdated,
                                    need_retry: failed > 0,
                                    renewal_type: params[0],
                                    fix_date: normFixDate,
                                    billing_day: renewal_type === 'renewal' ? params[1] : null
                                });
                            });
                        };

                        if (renewal_type !== 'fix_date' || !normFixDate) {
                            return done(0);
                        }

                        const invoiceSql = `
                            UPDATE invoices SET due_date = date(
                                CASE
                                    WHEN cast(strftime('%d','now','localtime') AS integer) <= ?
                                    THEN strftime('%Y-%m','now','localtime') || '-' || printf('%02d', ?)
                                    ELSE strftime('%Y-%m', date('now','localtime','start of month','+1 month')) || '-' || printf('%02d', ?)
                                END
                            )
                            WHERE status = 'unpaid' AND customer_id IS NOT NULL
                        `;
                        dbRef.run(invoiceSql, [normFixDate, normFixDate, normFixDate], function (iErr) {
                            if (iErr) {
                                dbRef.run('ROLLBACK');
                                return reject(iErr);
                            }
                            done(this.changes);
                        });
                    });
                });
            });
        });
    }

    /** Semua tagihan belum lunas — dipakai isolir otomatis di tanggal tetap (mis. tgl 25). */
    async getUnpaidInvoicesForAutoSuspension(limit = null) {
        return new Promise((resolve, reject) => {
            let sql = `
                SELECT i.*, 
                       c.username, c.name as customer_name, c.phone as customer_phone,
                       m.hotspot_username as member_hotspot_username, m.name as member_name, m.phone as member_phone,
                       p.name as package_name,
                       CASE WHEN i.customer_id IS NOT NULL THEN 'customer' ELSE 'member' END as invoice_type_entity
                FROM invoices i
                LEFT JOIN customers c ON i.customer_id = c.id
                LEFT JOIN members m ON i.member_id = m.id
                LEFT JOIN packages p ON i.package_id = p.id
                LEFT JOIN member_packages mp ON i.package_id = mp.id
                WHERE i.status = 'unpaid'
                ORDER BY i.due_date ASC
            `;

            const params = [];
            if (limit) {
                sql += ` LIMIT ?`;
                params.push(limit);
            }

            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async getInvoicesByMemberAndDateRange(memberHotspotUsername, startDate, endDate) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT i.*, m.hotspot_username, m.name as member_name, m.phone as member_phone,
                       mp.name as package_name, mp.speed as package_speed
                FROM invoices i
                JOIN members m ON i.member_id = m.id
                LEFT JOIN member_packages mp ON i.package_id = mp.id
                WHERE m.hotspot_username = ? 
                AND i.created_at BETWEEN ? AND ?
                ORDER BY i.created_at DESC
            `;
            
            const params = [
                memberHotspotUsername,
                startDate.toISOString(),
                endDate.toISOString()
            ];
            
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    // Close database connection
    close() {
        if (this.db) {
            this.db.close((err) => {
                if (err) {
                    console.error('Error closing billing database:', err);
                } else {
                    console.log('Billing database connection closed');
                }
            });
        }
    }

    // Payment Gateway Methods
    async createOnlinePayment(invoiceId, gateway = null) {
        return new Promise(async (resolve, reject) => {
            try {
                // Get invoice details
                const invoice = await this.getInvoiceById(invoiceId);
                if (!invoice) {
                    throw new Error('Invoice not found');
                }

                // Get customer details
                const customer = await this.getCustomerById(invoice.customer_id);
                if (!customer) {
                    throw new Error('Customer not found');
                }

                // Prepare invoice data for payment gateway
                const paymentData = {
                    id: invoice.id,
                    invoice_number: invoice.invoice_number,
                    amount: invoice.amount,
                    customer_name: customer.name,
                    customer_phone: customer.phone,
                    customer_email: customer.email,
                    package_name: invoice.package_name,
                    package_id: invoice.package_id
                };

                // Create payment with selected gateway
                const paymentResult = await this.paymentGateway.createPayment(paymentData, gateway);

                // Save payment transaction to database
                const sql = `
                    INSERT INTO payment_gateway_transactions 
                    (invoice_id, gateway, order_id, payment_url, token, amount, status) 
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `;

                const db = this.db;
                db.run(sql, [
                    invoiceId,
                    paymentResult.gateway,
                    paymentResult.order_id,
                    paymentResult.payment_url,
                    paymentResult.token,
                    invoice.amount,
                    'pending'
                ], (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        // Update invoice with payment gateway info
                        const updateSql = `
                            UPDATE invoices 
                            SET payment_gateway = ?, payment_token = ?, payment_url = ?, payment_status = 'pending'
                            WHERE id = ?
                        `;

                        db.run(updateSql, [
                            paymentResult.gateway,
                            paymentResult.token,
                            paymentResult.payment_url,
                            invoiceId
                        ], (updateErr) => {
                            if (updateErr) {
                                reject(updateErr);
                            } else {
                                resolve(paymentResult);
                            }
                        });
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    // Create online payment with specific method (for customer choice)
    async createOnlinePaymentWithMethod(invoiceId, gateway = null, method = null, paymentType = 'invoice', customerPhoneOverride = null) {
        return new Promise(async (resolve, reject) => {
            try {
                // Get invoice details
                const invoice = await this.getInvoiceById(invoiceId);
                if (!invoice) {
                    throw new Error('Invoice not found');
                }

                // Get customer details
                const customer = await this.getCustomerById(invoice.customer_id);
                if (!customer) {
                    throw new Error('Customer not found');
                }

                // Prepare invoice data for payment gateway
                const paymentData = {
                    id: invoice.id,
                    invoice_number: invoice.invoice_number,
                    amount: invoice.amount,
                    customer_name: customer.name,
                    customer_phone: customerPhoneOverride || customer.phone,
                    customer_email: customer.email,
                    package_name: invoice.package_name,
                    package_id: invoice.package_id,
                    payment_method: method // Add specific method for Tripay
                };

                // Create payment with selected gateway and method
                const paymentResult = await this.paymentGateway.createPaymentWithMethod(paymentData, gateway, method, paymentType);

                // Save payment transaction to database
                const sql = `
                    INSERT INTO payment_gateway_transactions 
                    (invoice_id, gateway, order_id, payment_url, token, amount, status, payment_type) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `;

                const db = this.db;
                db.run(sql, [
                    invoiceId,
                    paymentResult.gateway,
                    paymentResult.order_id,
                    paymentResult.payment_url,
                    paymentResult.token,
                    invoice.amount,
                    'pending',
                    method || 'all'
                ], (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        // Update invoice with payment gateway info
                        const updateSql = `
                            UPDATE invoices 
                            SET payment_gateway = ?, payment_token = ?, payment_url = ?, payment_status = 'pending'
                            WHERE id = ?
                        `;

                        db.run(updateSql, [
                            paymentResult.gateway,
                            paymentResult.token,
                            paymentResult.payment_url,
                            invoiceId
                        ], (updateErr) => {
                            if (updateErr) {
                                reject(updateErr);
                            } else {
                                resolve(paymentResult);
                            }
                        });
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

async handlePaymentWebhook(payload, gateway) {
    return new Promise(async (resolve, reject) => {
        try {
            logger.info(`[WEBHOOK] Processing ${gateway} webhook:`, payload);

            // Normalize/parse from gateway
            const result = await this.paymentGateway.handleWebhook(payload, gateway);
            logger.info(`[WEBHOOK] Gateway result:`, result);

            // Find transaction by order_id
            const txSql = `
                SELECT * FROM payment_gateway_transactions
                WHERE order_id = ? AND gateway = ?
            `;

            this.db.get(txSql, [result.order_id, gateway], async (err, transaction) => {
                if (err) {
                    logger.error(`[WEBHOOK] Database error:`, err);
                    return reject(err);
                }

                // Fallback by invoice number
                if (!transaction) {
                    logger.warn(`[WEBHOOK] Transaction not found for order_id: ${result.order_id}`);
                    const invoiceNumber = (result.order_id || '').replace('INV-', '');
                    const fallbackSql = `
                        SELECT i.*
                        FROM invoices i
                        WHERE i.invoice_number = ?
                    `;
                    this.db.get(fallbackSql, [invoiceNumber], async (fbErr, invoice) => {
                        if (fbErr || !invoice) {
                            logger.error(`[WEBHOOK] Fallback search failed:`, fbErr);
                            return reject(new Error('Transaction and invoice not found'));
                        }
                        // Process direct payment with idempotency check
                        await this.processDirectPaymentWithIdempotency(invoice, result, gateway);
                        
                        // Immediate restore for fallback path - check if member or customer
                        const isMemberInvoice = invoice.member_id !== null && invoice.member_id !== undefined;
                        
                        try {
                            if (isMemberInvoice) {
                                // Handle member payment
                                const member = await this.getMemberById(invoice.member_id);
                                if (member && (member.status === 'isolir' || member.status === 'suspend')) {
                                    const memberInvoices = await this.getInvoices(member.hotspot_username || member.username);
                                    const unpaid = memberInvoices.filter(i => i.status === 'unpaid');
                                    if (unpaid.length === 0) {
                                        const serviceSuspension = require('./serviceSuspension');
                                        logger.info(`[WEBHOOK] Restoring member service (fallback) for ${member.name} (${member.hotspot_username})`);
                                        await serviceSuspension.restoreMemberService(member, `Payment via ${gateway} webhook (fallback)`);
                                    }
                                }
                            } else {
                                // Handle customer payment
                                const customer = await this.getCustomerById(invoice.customer_id);
                                const { shouldAutoRestoreCustomer } = require('../utils/customerSuspendReason');
                                if (shouldAutoRestoreCustomer(customer)) {
                                    const invoices = await this.getInvoicesByCustomer(customer.id);
                                    const unpaid = invoices.filter(i => i.status === 'unpaid');
                                    if (unpaid.length === 0) {
                                        const serviceSuspension = require('./serviceSuspension');
                                        await serviceSuspension.restoreCustomerService(customer);
                                    }
                                }
                            }
                        } catch (restoreErr) {
                            logger.error('[WEBHOOK] Immediate restore (fallback) failed:', restoreErr);
                        }
                        return resolve({ success: true, message: 'Payment processed via fallback method', invoice_id: invoice.id });
                    });
                    return; // stop here, fallback async handled
                }

                // Update transaction status
                const updateSql = `
                    UPDATE payment_gateway_transactions
                    SET status = ?, payment_type = ?, fraud_status = ?, updated_at = datetime('now','localtime')
                    WHERE id = ?
                `;
                this.db.run(updateSql, [
                    result.status,
                    result.payment_type || null,
                    result.fraud_status || null,
                    transaction.id
                ], async (updateErr) => {
                    if (updateErr) {
                        logger.error(`[WEBHOOK] Update transaction error:`, updateErr);
                        return reject(updateErr);
                    }

                    if (result.status !== 'success') {
                        logger.info(`[WEBHOOK] Payment status updated: ${result.status}`);
                        return resolve({ success: true, message: 'Payment status updated', status: result.status });
                    }

                    try {
                        logger.info(`[WEBHOOK] Processing successful payment for invoice: ${transaction.invoice_id}`);

                        // Check if payment already exists to prevent duplicates
                        const existingPaymentSql = `
                            SELECT id FROM payments 
                            WHERE invoice_id = ? AND reference_number = ? AND payment_method = 'online'
                        `;
                        
                        const existingPayment = await new Promise((resolve, reject) => {
                            this.db.get(existingPaymentSql, [transaction.invoice_id, result.order_id], (err, row) => {
                                if (err) reject(err);
                                else resolve(row);
                            });
                        });

                        if (existingPayment) {
                            logger.warn(`[WEBHOOK] Payment already exists for invoice ${transaction.invoice_id}, order ${result.order_id}. Skipping duplicate.`);
                            return resolve({ success: true, message: 'Payment already processed', duplicate: true });
                        }

                        // Mark invoice paid and record payment
                        await this.updateInvoiceStatus(transaction.invoice_id, 'paid', 'online');
                        const paymentData = {
                            invoice_id: transaction.invoice_id,
                            amount: result.amount || transaction.amount,
                            payment_method: 'online',
                            reference_number: result.order_id,
                            notes: `Payment via ${gateway} - ${result.payment_type || 'online'}`
                        };
                        await this.recordPayment(paymentData);

                        // Notify and restore
                        const invoice = await this.getInvoiceById(transaction.invoice_id);
                        const isMemberInvoice = invoice.member_id !== null && invoice.member_id !== undefined;
                        
                        if (isMemberInvoice) {
                            // Handle member payment
                            const member = await this.getMemberById(invoice.member_id);
                            if (member) {
                                try {
                                    // Send notification for member
                                    const memberForNotification = {
                                        name: member.name,
                                        phone: member.phone,
                                        username: member.hotspot_username || member.username
                                    };
                                    await this.sendPaymentSuccessNotification(memberForNotification, invoice);
                                } catch (notificationError) {
                                    logger.error(`[WEBHOOK] Failed send member notification:`, notificationError);
                                }
                                try {
                                    const refreshed = await this.getMemberById(invoice.member_id);
                                    if (refreshed && (refreshed.status === 'isolir' || refreshed.status === 'suspend')) {
                                        const memberInvoices = await this.getInvoices(refreshed.hotspot_username || refreshed.username);
                                        const unpaid = memberInvoices.filter(i => i.status === 'unpaid');
                                        if (unpaid.length === 0) {
                                            const serviceSuspension = require('./serviceSuspension');
                                            logger.info(`[WEBHOOK] Restoring member service for ${refreshed.name} (${refreshed.hotspot_username})`);
                                            await serviceSuspension.restoreMemberService(refreshed, 'Payment via webhook');
                                        }
                                    }
                                } catch (restoreErr) {
                                    logger.error('[WEBHOOK] Immediate member restore failed:', restoreErr);
                                }
                            } else {
                                logger.error(`[WEBHOOK] Member not found for invoice: ${transaction.invoice_id}`);
                            }
                        } else {
                            // Handle customer payment
                            const customer = await this.getCustomerById(invoice.customer_id);
                            if (customer) {
                                try {
                                    await this.sendPaymentSuccessNotification(customer, invoice);
                                } catch (notificationError) {
                                    logger.error(`[WEBHOOK] Failed send notification:`, notificationError);
                                }
                                try {
                                    const refreshed = await this.getCustomerById(invoice.customer_id);
                                    const { shouldAutoRestoreCustomer: shouldAutoRestore } = require('../utils/customerSuspendReason');
                                    if (shouldAutoRestore(refreshed)) {
                                        const invoices = await this.getInvoicesByCustomer(refreshed.id);
                                        const unpaid = invoices.filter(i => i.status === 'unpaid');
                                        if (unpaid.length === 0) {
                                            const serviceSuspension = require('./serviceSuspension');
                                            await serviceSuspension.restoreCustomerService(refreshed);
                                        }
                                    }
                                } catch (restoreErr) {
                                    logger.error('[WEBHOOK] Immediate restore failed:', restoreErr);
                                }
                            } else {
                                logger.error(`[WEBHOOK] Customer not found for invoice: ${transaction.invoice_id}`);
                            }
                        }

                        return resolve({ success: true, message: 'Payment processed successfully', invoice_id: transaction.invoice_id });
                    } catch (processingError) {
                        logger.error(`[WEBHOOK] Error in payment processing:`, processingError);
                        return resolve({ success: true, message: 'Payment processed successfully', invoice_id: transaction.invoice_id });
                    }
                });
            });
        } catch (error) {
            logger.error(`[WEBHOOK] Webhook processing error:`, error);
            reject(error);
        }
    });
    }

    async getFinancialReport(startDate, endDate, type = 'all') {
        return new Promise((resolve, reject) => {
            try {
                let sql = '';
                const params = [];
                
                if (type === 'income') {
                    // Laporan pemasukan dari pembayaran online, manual, dan kolektor
                    // Hanya menggunakan data dari payments untuk menghindari duplikasi dengan payment_gateway_transactions
                    sql = `
                        SELECT 
                            'income' as type,
                            p.payment_date as date,
                            p.amount as amount,
                            p.payment_method,
                            CASE 
                                WHEN p.payment_type = 'collector' THEN CONCAT('Kolektor - ', COALESCE(col.name, 'Unknown'))
                                WHEN p.payment_method = 'online' AND p.notes LIKE '%tripay%' THEN 'tripay'
                                WHEN p.payment_type = 'manual' THEN 'Manual Payment'
                                ELSE 'Direct Payment'
                            END as gateway_name,
                            i.invoice_number as invoice_number,
                            c.name as customer_name,
                            c.phone as customer_phone,
                            CASE 
                                WHEN p.payment_type = 'collector' THEN CONCAT('Pembayaran via kolektor ', COALESCE(col.name, 'Unknown'))
                                WHEN p.payment_method = 'online' AND p.notes LIKE '%tripay%' THEN p.notes
                                ELSE ''
                            END as description,
                            p.notes,
                            COALESCE(col.name, '') as collector_name,
                            COALESCE(p.commission_amount, 0) as commission_amount
                        FROM payments p
                        JOIN invoices i ON p.invoice_id = i.id
                        JOIN customers c ON i.customer_id = c.id
                        LEFT JOIN collectors col ON p.collector_id = col.id
                        WHERE DATE(p.payment_date) BETWEEN ? AND ?
                        AND p.payment_type IN ('direct', 'collector', 'online', 'manual')
                        AND i.customer_id IS NOT NULL
                        
                        UNION ALL
                        
                        -- Member payments
                        SELECT 
                            'income' as type,
                            p.payment_date as date,
                            p.amount as amount,
                            p.payment_method,
                            CASE 
                                WHEN p.payment_type = 'collector' THEN CONCAT('Kolektor - ', COALESCE(col.name, 'Unknown'))
                                WHEN p.payment_method = 'online' AND p.notes LIKE '%tripay%' THEN 'tripay'
                                WHEN p.payment_type = 'manual' THEN 'Manual Payment'
                                ELSE 'Direct Payment'
                            END as gateway_name,
                            i.invoice_number as invoice_number,
                            m.name as customer_name,
                            m.phone as customer_phone,
                            CASE 
                                WHEN p.payment_type = 'collector' THEN CONCAT('Pembayaran via kolektor ', COALESCE(col.name, 'Unknown'))
                                WHEN p.payment_method = 'online' AND p.notes LIKE '%tripay%' THEN p.notes
                                ELSE ''
                            END as description,
                            p.notes,
                            COALESCE(col.name, '') as collector_name,
                            COALESCE(p.commission_amount, 0) as commission_amount
                        FROM payments p
                        JOIN invoices i ON p.invoice_id = i.id
                        JOIN members m ON i.member_id = m.id
                        LEFT JOIN collectors col ON p.collector_id = col.id
                        WHERE DATE(p.payment_date) BETWEEN ? AND ?
                        AND p.payment_type IN ('direct', 'collector', 'online', 'manual')
                        AND i.member_id IS NOT NULL
                        
                        UNION ALL
                        
                        SELECT 
                            'income' as type,
                            inc.income_date as date,
                            inc.amount as amount,
                            inc.payment_method,
                            CONCAT('Pendapatan - ', inc.category) as gateway_name,
                            '' as invoice_number,
                            '' as customer_name,
                            '' as customer_phone,
                            inc.description as description,
                            inc.notes,
                            '' as collector_name,
                            0 as commission_amount
                        FROM income inc
                        WHERE DATE(inc.income_date) BETWEEN ? AND ?
                        
                        UNION ALL
                        
                        SELECT 
                            'income' as type,
                            gi.payment_date as date,
                            gi.total_amount as amount,
                            gi.payment_method,
                            'Invoice Penjualan' as gateway_name,
                            gi.invoice_number as invoice_number,
                            gi.customer_name as customer_name,
                            gi.customer_phone as customer_phone,
                            gi.notes as description,
                            gi.notes,
                            '' as collector_name,
                            0 as commission_amount
                        FROM goods_invoices gi
                        WHERE DATE(gi.payment_date) BETWEEN ? AND ?
                        AND gi.status = 'paid'
                        
                        ORDER BY date DESC
                    `;
                    params.push(startDate, endDate, startDate, endDate, startDate, endDate, startDate, endDate);
                } else if (type === 'expense') {
                    // Laporan pengeluaran dari tabel expenses
                    sql = `
                        SELECT 
                            'expense' as type,
                            e.expense_date as date,
                            e.amount as amount,
                            e.payment_method,
                            e.category as gateway_name,
                            e.description as description,
                            e.notes as notes,
                            '' as invoice_number,
                            '' as customer_name,
                            '' as customer_phone,
                            '' as collector_name,
                            0 as commission_amount
                        FROM expenses e
                        WHERE DATE(e.expense_date) BETWEEN ? AND ?
                        ORDER BY e.expense_date DESC
                    `;
                    params.push(startDate, endDate);
                } else {
                    // Laporan gabungan pemasukan dan pengeluaran
                    // Hanya menggunakan data dari payments untuk menghindari duplikasi dengan payment_gateway_transactions
                    sql = `
                        SELECT 
                            'income' as type,
                            p.payment_date as date,
                            p.amount as amount,
                            p.payment_method,
                            CASE 
                                WHEN p.payment_type = 'collector' THEN CONCAT('Kolektor - ', COALESCE(col.name, 'Unknown'))
                                WHEN p.payment_method = 'online' AND p.notes LIKE '%tripay%' THEN 'tripay'
                                WHEN p.payment_type = 'manual' THEN 'Manual Payment'
                                ELSE 'Direct Payment'
                            END as gateway_name,
                            i.invoice_number as invoice_number,
                            c.name as customer_name,
                            c.phone as customer_phone,
                            CASE 
                                WHEN p.payment_type = 'collector' THEN CONCAT('Pembayaran via kolektor ', COALESCE(col.name, 'Unknown'))
                                WHEN p.payment_method = 'online' AND p.notes LIKE '%tripay%' THEN p.notes
                                ELSE ''
                            END as description,
                            p.notes,
                            COALESCE(col.name, '') as collector_name,
                            COALESCE(p.commission_amount, 0) as commission_amount
                        FROM payments p
                        JOIN invoices i ON p.invoice_id = i.id
                        JOIN customers c ON i.customer_id = c.id
                        LEFT JOIN collectors col ON p.collector_id = col.id
                        WHERE DATE(p.payment_date) BETWEEN ? AND ?
                        AND p.payment_type IN ('direct', 'collector', 'online', 'manual')
                        AND i.customer_id IS NOT NULL
                        
                        UNION ALL
                        
                        -- Member payments
                        SELECT 
                            'income' as type,
                            p.payment_date as date,
                            p.amount as amount,
                            p.payment_method,
                            CASE 
                                WHEN p.payment_type = 'collector' THEN CONCAT('Kolektor - ', COALESCE(col.name, 'Unknown'))
                                WHEN p.payment_method = 'online' AND p.notes LIKE '%tripay%' THEN 'tripay'
                                WHEN p.payment_type = 'manual' THEN 'Manual Payment'
                                ELSE 'Direct Payment'
                            END as gateway_name,
                            i.invoice_number as invoice_number,
                            m.name as customer_name,
                            m.phone as customer_phone,
                            CASE 
                                WHEN p.payment_type = 'collector' THEN CONCAT('Pembayaran via kolektor ', COALESCE(col.name, 'Unknown'))
                                WHEN p.payment_method = 'online' AND p.notes LIKE '%tripay%' THEN p.notes
                                ELSE ''
                            END as description,
                            p.notes,
                            COALESCE(col.name, '') as collector_name,
                            COALESCE(p.commission_amount, 0) as commission_amount
                        FROM payments p
                        JOIN invoices i ON p.invoice_id = i.id
                        JOIN members m ON i.member_id = m.id
                        LEFT JOIN collectors col ON p.collector_id = col.id
                        WHERE DATE(p.payment_date) BETWEEN ? AND ?
                        AND p.payment_type IN ('direct', 'collector', 'online', 'manual')
                        AND i.member_id IS NOT NULL
                        
                        UNION ALL
                        
                        SELECT 
                            'income' as type,
                            inc.income_date as date,
                            inc.amount as amount,
                            inc.payment_method,
                            CONCAT('Pendapatan - ', inc.category) as gateway_name,
                            '' as invoice_number,
                            '' as customer_name,
                            '' as customer_phone,
                            inc.description as description,
                            inc.notes,
                            '' as collector_name,
                            0 as commission_amount
                        FROM income inc
                        WHERE DATE(inc.income_date) BETWEEN ? AND ?
                        
                        UNION ALL
                        
                        SELECT 
                            'income' as type,
                            gi.payment_date as date,
                            gi.total_amount as amount,
                            gi.payment_method,
                            'Invoice Penjualan' as gateway_name,
                            gi.invoice_number as invoice_number,
                            gi.customer_name as customer_name,
                            gi.customer_phone as customer_phone,
                            gi.notes as description,
                            gi.notes,
                            '' as collector_name,
                            0 as commission_amount
                        FROM goods_invoices gi
                        WHERE DATE(gi.payment_date) BETWEEN ? AND ?
                        AND gi.status = 'paid'
                        
                        UNION ALL
                        
                        SELECT 
                            'expense' as type,
                            e.expense_date as date,
                            e.amount as amount,
                            e.payment_method,
                            e.category as gateway_name,
                            e.description as description,
                            e.notes as notes,
                            '' as invoice_number,
                            '' as customer_name,
                            '' as customer_phone,
                            '' as collector_name,
                            0 as commission_amount
                        FROM expenses e
                        WHERE DATE(e.expense_date) BETWEEN ? AND ?
                        
                        ORDER BY date DESC
                    `;
                    params.push(startDate, endDate, startDate, endDate, startDate, endDate, startDate, endDate, startDate, endDate);
                }

                this.db.all(sql, params, async (err, rows) => {
                    if (err) {
                        reject(err);
                    } else {
                        try {
                            let transactions = Array.isArray(rows) ? [...rows] : [];
                            let voucherSummary = {
                                total_vouchers: 0,
                                recognized_vouchers: 0,
                                recognized_revenue: 0,
                                pending_vouchers: 0,
                                pending_revenue: 0
                            };
                            
                            if (type !== 'expense') {
                                const voucherInvoices = await this.getVoucherInvoices(startDate, endDate);
                                const voucherStats = this.calculateVoucherStats(voucherInvoices);
                                
                                voucherSummary = {
                                    total_vouchers: voucherStats.total_vouchers,
                                    recognized_vouchers: voucherStats.paid_vouchers,
                                    recognized_revenue: voucherStats.total_revenue,
                                    pending_vouchers: voucherStats.unpaid_vouchers,
                                    pending_revenue: voucherStats.unpaid_amount
                                };
                                
                                const voucherTransactions = this.buildVoucherTransactions(voucherInvoices);
                                if (voucherTransactions.length > 0) {
                                    transactions = transactions.concat(voucherTransactions);
                                }
                            }
                            
                            // Urutkan transaksi dari terbaru
                            transactions.sort((a, b) => {
                                const dateA = new Date(a.date || a.payment_date || 0).getTime();
                                const dateB = new Date(b.date || b.payment_date || 0).getTime();
                                return dateB - dateA;
                            });
                            
                            // Hitung total dan statistik
                            const totalIncome = transactions.filter(r => r.type === 'income')
                                .reduce((sum, r) => sum + (r.amount || 0), 0);
                            const totalExpense = transactions.filter(r => r.type === 'expense')
                                .reduce((sum, r) => sum + (r.amount || 0), 0);
                            const totalCommission = transactions.filter(r => r.type === 'income')
                                .reduce((sum, r) => sum + (r.commission_amount || 0), 0);
                            const netProfit = totalIncome - totalExpense;
                            
                            // Statistik per tipe pembayaran
                            const incomeByType = transactions.filter(r => r.type === 'income')
                                .reduce((acc, r) => {
                                    const gateway = r.gateway_name || 'Unknown';
                                    if (!acc[gateway]) {
                                        acc[gateway] = { count: 0, amount: 0, commission: 0 };
                                    }
                                    acc[gateway].count++;
                                    acc[gateway].amount += (r.amount || 0);
                                    acc[gateway].commission += (r.commission_amount || 0);
                                    return acc;
                                }, {});
                            
                            // Calculate profit and loss details
                            const profitLossData = await this.calculateProfitLoss(startDate, endDate);
                            
                            const result = {
                                transactions,
                                summary: {
                                    totalIncome,
                                    totalExpense,
                                    totalCommission,
                                    netProfit,
                                    transactionCount: transactions.length,
                                    incomeCount: transactions.filter(r => r.type === 'income').length,
                                    expenseCount: transactions.filter(r => r.type === 'expense').length,
                                    incomeByType
                                },
                                voucherSummary,
                                profitLossData,
                                dateRange: { startDate, endDate }
                            };
                            
                            resolve(result);
                        } catch (processError) {
                            reject(processError);
                        }
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    // Method untuk mengelola expenses
    async addExpense(expenseData) {
        return new Promise((resolve, reject) => {
            const { amount, category, account_expenses, expense_date, payment_method, notes } = expenseData;
            
            const sql = `INSERT INTO expenses (description, amount, category, account_expenses, expense_date, payment_method, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`;
            
            // Description dibuat dari account_expenses jika ada, atau dari category
            const description = account_expenses || category || '';
            
            this.db.run(sql, [description, amount, category, account_expenses || null, expense_date, payment_method || null, notes || null], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id: this.lastID, ...expenseData });
                }
            });
        });
    }

    async getExpenses(startDate = null, endDate = null) {
        return new Promise((resolve, reject) => {
            let sql = 'SELECT * FROM expenses';
            const params = [];
            
            if (startDate && endDate) {
                sql += ' WHERE expense_date BETWEEN ? AND ?';
                params.push(startDate, endDate);
            }
            
            sql += ' ORDER BY expense_date DESC';
            
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async updateExpense(id, expenseData) {
        return new Promise((resolve, reject) => {
            const { amount, category, account_expenses, expense_date, payment_method, notes } = expenseData;
            
            const sql = `UPDATE expenses SET description = ?, amount = ?, category = ?, account_expenses = ?, expense_date = ?, payment_method = ?, notes = ?, updated_at = datetime('now','localtime') WHERE id = ?`;
            
            // Description dibuat dari account_expenses jika ada, atau dari category
            const description = account_expenses || category || '';
            
            this.db.run(sql, [description, amount, category, account_expenses || null, expense_date, payment_method || null, notes || null, id], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id, ...expenseData });
                }
            });
        });
    }

    async deleteExpense(id) {
        return new Promise((resolve, reject) => {
            const sql = 'DELETE FROM expenses WHERE id = ?';
            
            this.db.run(sql, [id], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id, deleted: true });
                }
            });
        });
    }

    // Method untuk menghitung data laba rugi dengan rincian
    async calculateProfitLoss(startDate, endDate) {
        return new Promise(async (resolve, reject) => {
            try {
                // 2. Pendapatan Voucher (tidak bergantung pada invoice_type)
                const voucherInvoices = await this.getVoucherInvoices(startDate, endDate);
                const voucherStats = this.calculateVoucherStats(voucherInvoices);
                
                // 3. Pendapatan dari Invoice Penjualan (Goods Invoices)
                let goodsInvoiceTotal = 0;
                try {
                    const goodsInvoices = await new Promise((res, rej) => {
                        this.db.all(`SELECT SUM(total_amount) as total FROM goods_invoices WHERE status = 'paid' AND DATE(payment_date) BETWEEN ? AND ?`, [startDate, endDate], (err, row) => {
                            if (err) res([{ total: 0 }]); else res(row);
                        });
                    });
                    goodsInvoiceTotal = goodsInvoices[0]?.total || 0;
                } catch(e) {
                    console.log("[calculateProfitLoss] No goods_invoices table or error:", e.message);
                }

                // 4. Pendapatan lain-lain dari Manajemen Pendapatan
                const incomes = await this.getIncomes(startDate, endDate);
                const otherIncomeTotal = incomes.reduce((sum, inc) => sum + (inc.amount || 0), 0);
                
                // Group incomes by category
                const incomesByCategory = incomes.reduce((acc, inc) => {
                    const category = inc.category || 'Lainnya';
                    if (!acc[category]) {
                        acc[category] = 0;
                    }
                    acc[category] += (inc.amount || 0);
                    return acc;
                }, {});

                // 5. Pengeluaran dengan rincian
                const expenses = await this.getExpenses(startDate, endDate);
                
                // Group expenses by category and account_expenses
                const expensesByCategory = expenses.reduce((acc, exp) => {
                    const category = exp.category || 'Lainnya';
                    const account = exp.account_expenses || 'Tidak Diketahui';
                    
                    if (!acc[category]) {
                        acc[category] = {};
                    }
                    if (!acc[category][account]) {
                        acc[category][account] = 0;
                    }
                    acc[category][account] += (exp.amount || 0);
                    return acc;
                }, {});
                
                // Calculate total expenses by category
                const expensesTotalByCategory = {};
                Object.keys(expensesByCategory).forEach(category => {
                    expensesTotalByCategory[category] = Object.values(expensesByCategory[category])
                        .reduce((sum, amount) => sum + amount, 0);
                });
                
                // 1. Pendapatan Bulanan Pembayaran Pelanggan (bukan voucher)
                // Check if invoice_type column exists
                this.db.all("PRAGMA table_info(invoices)", (pragmaErr, columns) => {
                    if (pragmaErr) {
                        reject(pragmaErr);
                        return;
                    }
                    
                    try {
                        const hasInvoiceType = columns.some(col => col.name === 'invoice_type');
                        
                        // Separate queries for PPPoE and Member payments
                        let pppoePaymentSql, memberPaymentSql;
                        if (hasInvoiceType) {
                            pppoePaymentSql = `
                                SELECT SUM(p.amount) as total
                                FROM payments p
                                JOIN invoices i ON p.invoice_id = i.id
                                WHERE DATE(p.payment_date) BETWEEN ? AND ?
                                AND p.payment_type IN ('direct', 'collector', 'online', 'manual')
                                AND (i.invoice_type != 'voucher' OR i.invoice_type IS NULL)
                                AND i.invoice_number NOT LIKE 'VCHR-%'
                                AND i.customer_id IS NOT NULL
                                AND i.member_id IS NULL
                            `;
                            memberPaymentSql = `
                                SELECT SUM(p.amount) as total
                                FROM payments p
                                JOIN invoices i ON p.invoice_id = i.id
                                WHERE DATE(p.payment_date) BETWEEN ? AND ?
                                AND p.payment_type IN ('direct', 'collector', 'online', 'manual')
                                AND (i.invoice_type != 'voucher' OR i.invoice_type IS NULL)
                                AND i.invoice_number NOT LIKE 'VCHR-%'
                                AND i.member_id IS NOT NULL
                                AND i.customer_id IS NULL
                            `;
                        } else {
                            // If invoice_type column doesn't exist, filter by invoice_number pattern
                            pppoePaymentSql = `
                                SELECT SUM(p.amount) as total
                                FROM payments p
                                JOIN invoices i ON p.invoice_id = i.id
                                WHERE DATE(p.payment_date) BETWEEN ? AND ?
                                AND p.payment_type IN ('direct', 'collector', 'online', 'manual')
                                AND i.invoice_number NOT LIKE 'VCHR-%'
                                AND i.customer_id IS NOT NULL
                                AND i.member_id IS NULL
                            `;
                            memberPaymentSql = `
                                SELECT SUM(p.amount) as total
                                FROM payments p
                                JOIN invoices i ON p.invoice_id = i.id
                                WHERE DATE(p.payment_date) BETWEEN ? AND ?
                                AND p.payment_type IN ('direct', 'collector', 'online', 'manual')
                                AND i.invoice_number NOT LIKE 'VCHR-%'
                                AND i.member_id IS NOT NULL
                                AND i.customer_id IS NULL
                            `;
                        }
                        
                        // Get PPPoE payment total
                        this.db.get(pppoePaymentSql, [startDate, endDate], (err, pppoeRow) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            
                            const pppoePaymentTotal = pppoeRow?.total || 0;
                            console.log(`[calculateProfitLoss] PPPoE Payment Total: ${pppoePaymentTotal}, Date Range: ${startDate} to ${endDate}`);
                            
                            // Get Member payment total
                            this.db.get(memberPaymentSql, [startDate, endDate], (err, memberRow) => {
                                if (err) {
                                    reject(err);
                                    return;
                                }
                                
                                const memberPaymentTotal = memberRow?.total || 0;
                                console.log(`[calculateProfitLoss] Member Payment Total: ${memberPaymentTotal}, Date Range: ${startDate} to ${endDate}`);
                                const monthlyPaymentTotal = pppoePaymentTotal + memberPaymentTotal;
                                const voucherRevenue = voucherStats.total_revenue || 0;
                                const totalRevenue = monthlyPaymentTotal + voucherRevenue + goodsInvoiceTotal + otherIncomeTotal;
                                const totalExpenses = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
                                const netProfit = totalRevenue - totalExpenses;
                                
                                resolve({
                                    revenue: {
                                        pppoePayment: pppoePaymentTotal,
                                        memberPayment: memberPaymentTotal,
                                        monthlyPayment: monthlyPaymentTotal, // Keep for backward compatibility
                                        voucher: voucherRevenue,
                                        goodsInvoice: goodsInvoiceTotal,
                                        otherIncome: otherIncomeTotal,
                                        byCategory: incomesByCategory,
                                        total: totalRevenue
                                    },
                                    expenses: {
                                        byCategory: expensesByCategory,
                                        totalByCategory: expensesTotalByCategory,
                                        total: totalExpenses
                                    },
                                    netProfit: netProfit
                                });
                            });
                        });
                    } catch (error) {
                        reject(error);
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    // Method untuk mengelola income (pemasukan)
    async addIncome(incomeData) {
        return new Promise((resolve, reject) => {
            const { description, amount, category, income_date, payment_method, notes } = incomeData;
            
            const sql = `INSERT INTO income (description, amount, category, income_date, payment_method, notes) VALUES (?, ?, ?, ?, ?, ?)`;
            
            this.db.run(sql, [description, amount, category, income_date, payment_method, notes], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id: this.lastID, ...incomeData });
                }
            });
        });
    }

    async getIncomes(startDate = null, endDate = null) {
        return new Promise((resolve, reject) => {
            let sql = 'SELECT * FROM income';
            const params = [];
            
            if (startDate && endDate) {
                sql += ' WHERE income_date BETWEEN ? AND ?';
                params.push(startDate, endDate);
            }
            
            sql += ' ORDER BY income_date DESC';
            
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async updateIncome(id, incomeData) {
        return new Promise((resolve, reject) => {
            const { description, amount, category, income_date, payment_method, notes } = incomeData;
            
            const sql = `UPDATE income SET description = ?, amount = ?, category = ?, income_date = ?, payment_method = ?, notes = ?, updated_at = datetime('now','localtime') WHERE id = ?`;
            
            this.db.run(sql, [description, amount, category, income_date, payment_method, notes, id], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id, ...incomeData });
                }
            });
        });
    }

    async deleteIncome(id) {
        return new Promise((resolve, reject) => {
            const sql = 'DELETE FROM income WHERE id = ?';
            
            this.db.run(sql, [id], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id, deleted: true });
                }
            });
        });
    }

    // Method untuk mendapatkan statistik komisi kolektor
    async getCommissionStats(startDate = null, endDate = null) {
        return new Promise((resolve, reject) => {
            let sql = `
                SELECT 
                    c.id as collector_id,
                    c.name as collector_name,
                    COUNT(p.id) as payment_count,
                    SUM(p.amount) as total_collected,
                    SUM(p.commission_amount) as total_commission,
                    AVG(p.commission_amount) as avg_commission,
                    MAX(p.payment_date) as last_payment_date
                FROM collectors c
                LEFT JOIN payments p ON c.id = p.collector_id AND p.payment_type = 'collector'
            `;
            
            const params = [];
            if (startDate && endDate) {
                sql += ' WHERE DATE(p.payment_date) BETWEEN ? AND ?';
                params.push(startDate, endDate);
            }
            
            sql += ' GROUP BY c.id, c.name ORDER BY total_commission DESC';
            
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    // Hitung total komisi dari expenses
                    let expenseSql = `
                        SELECT SUM(amount) as total_commission_expenses
                        FROM expenses 
                        WHERE category = 'Operasional' AND description LIKE 'Komisi Kolektor%'
                    `;
                    
                    if (startDate && endDate) {
                        expenseSql += ' AND DATE(expense_date) BETWEEN ? AND ?';
                        params.push(startDate, endDate);
                    }
                    
                    this.db.get(expenseSql, params.slice(params.length - 2), (err, expenseRow) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve({
                                collectors: rows,
                                totalCommissionExpenses: expenseRow ? expenseRow.total_commission_expenses || 0 : 0,
                                totalCommissionFromPayments: rows.reduce((sum, row) => sum + (row.total_commission || 0), 0)
                            });
                        }
                    });
                }
            });
        });
    }

    // Method untuk mendapatkan kolektor dengan pending amounts dan statistik (untuk remittance)
    async getCollectorsWithPendingAmounts(month = null, year = null) {
        await this._ensureRemittanceNetAppliedColumn();
        const collectors = await new Promise((resolve, reject) => {
            this.db.all(
                `SELECT id, name, phone, commission_rate FROM collectors WHERE status = 'active' ORDER BY name`,
                [],
                (err, rows) => (err ? reject(err) : resolve(rows || []))
            );
        });
        let dateWhere = '';
        const payParams = [];
        if (month && year) {
            dateWhere = ` AND strftime('%m', p.payment_date) = ? AND strftime('%Y', p.payment_date) = ?`;
            payParams.push(String(month).padStart(2, '0'), String(year));
        }
        const payments = await new Promise((resolve, reject) => {
            this.db.all(
                `SELECT p.collector_id, p.amount, p.commission_amount, p.discount_amount, p.notes,
                        COALESCE(p.remittance_net_applied, 0) as remittance_net_applied, p.remittance_status, p.payment_date,
                        COALESCE(i.amount, 0) as invoice_amount
                 FROM payments p
                 INNER JOIN invoices i ON i.id = p.invoice_id
                 WHERE p.payment_type = 'collector' ${dateWhere}`,
                payParams,
                (err, rows) => (err ? reject(err) : resolve(rows || []))
            );
        });
        const sums = {};
        for (const c of collectors) {
            sums[c.id] = {
                total_lunas_gross: 0,
                sudah_setor: 0,
                pending_amount: 0,
                pending_payments_count: 0
            };
        }
        for (const p of payments) {
            const cid = p.collector_id;
            if (!sums[cid]) continue;
            const jumlah = paymentJumlahSetelahDiskon(p);
            sums[cid].total_lunas_gross += jumlah;
            sums[cid].sudah_setor += Number(p.remittance_net_applied) || 0;
            const pool = paymentRemittancePoolRp(p);
            const applied = Number(p.remittance_net_applied) || 0;
            const remain = pool - applied;
            if (
                (p.remittance_status == null || p.remittance_status === 'pending') &&
                remain > 0.009
            ) {
                sums[cid].pending_amount += remain;
                sums[cid].pending_payments_count += 1;
            }
        }
        return collectors.map((c) => ({
            ...c,
            ...(sums[c.id] || {
                total_lunas_gross: 0,
                sudah_setor: 0,
                pending_amount: 0,
                pending_payments_count: 0
            })
        }));
    }

    /**
     * Statistik area kolektor (sama logika kartu / kartu kolektor di halaman Laporan Kolektor admin).
     * month/year kosong atau 'all' = tanpa filter tanggal (seluruh riwayat).
     */
    async getCollectorReportsAreaRowsAndSummary(month, year, collectorId = null) {
        const m =
            month != null && String(month).trim() !== '' && String(month) !== 'all'
                ? parseInt(String(month), 10)
                : NaN;
        const y =
            year != null && String(year).trim() !== '' && String(year) !== 'all'
                ? parseInt(String(year), 10)
                : NaN;
        const useRange = Number.isFinite(m) && m >= 1 && m <= 12 && Number.isFinite(y);
        const hasAreas = await this._hasAreasReferenceTable();
        const areaMatch = this._sqlCustomerMatchesCollectorAreaRow(hasAreas, 'ca', 'cust');
        const joinCollectorArea = `JOIN collector_areas ca ON ca.collector_id = c.id AND ${areaMatch}`;
        let invDate = '1=1';
        let cpExtra = '';
        let cpCntExtra = '';
        if (useRange) {
            const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
            const endDate = new Date(y, m, 0).toISOString().split('T')[0];
            invDate = `DATE(i.created_at) >= '${startDate}' AND DATE(i.created_at) <= '${endDate}'`;
            cpExtra = `AND cp.collected_at >= '${startDate}' AND cp.collected_at <= '${endDate} 23:59:59'`;
            cpCntExtra = `AND cp2.collected_at >= '${startDate}' AND cp2.collected_at <= '${endDate} 23:59:59'`;
        }
        const colFilter =
            collectorId != null && Number.isFinite(parseInt(String(collectorId), 10))
                ? `AND c.id = ${parseInt(String(collectorId), 10)}`
                : '';
        const invSubFrom = `
                           FROM invoices i
                           JOIN customers cust ON i.customer_id = cust.id
                           ${joinCollectorArea}`;
        const sql = `
                SELECT c.*,
                       (
                           SELECT COALESCE(SUM(i.amount), 0)
                           ${invSubFrom}
                           WHERE (${invDate})
                       ) as total_tagihan_area,
                       (
                           SELECT COUNT(i.id)
                           ${invSubFrom}
                           WHERE (${invDate})
                       ) as count_tagihan_area,
                       (
                           SELECT COALESCE(SUM(i.amount), 0)
                           ${invSubFrom}
                           WHERE i.status = 'paid' AND (${invDate})
                       ) as total_lunas_area,
                       (
                           SELECT COUNT(i.id)
                           ${invSubFrom}
                           WHERE i.status = 'paid' AND (${invDate})
                       ) as count_lunas_area,
                       (
                           SELECT COALESCE(SUM(i.amount), 0)
                           ${invSubFrom}
                           WHERE i.status = 'unpaid' AND (${invDate})
                       ) as total_belum_lunas_amount,
                       (
                           SELECT COUNT(i.id)
                           ${invSubFrom}
                           WHERE i.status = 'unpaid' AND (${invDate})
                       ) as total_belum_lunas_count,
                       (
                           SELECT COUNT(*)
                           FROM collector_payments cp2
                           WHERE cp2.collector_id = c.id
                             AND cp2.status = 'completed'
                             ${useRange ? cpCntExtra : ''}
                       ) as total_payments,
                       COALESCE(SUM(cp.payment_amount), 0) as total_payment_amount,
                       COALESCE(SUM(cp.commission_amount), 0) as total_commission
                FROM collectors c
                LEFT JOIN collector_payments cp ON c.id = cp.collector_id
                    AND cp.status = 'completed'
                    ${useRange ? cpExtra : ''}
                WHERE c.status = 'active' ${colFilter}
                GROUP BY c.id
                ORDER BY c.name
            `;
        const list = await new Promise((resolve, reject) => {
            this.db.all(sql, [], (err, rows) => (err ? reject(err) : resolve(rows || [])));
        });
        let summary = {
            total_tagihan: 0,
            total_lunas: 0,
            total_belum_lunas: 0,
            total_komisi: 0
        };
        list.forEach((c) => {
            summary.total_komisi += Number(c.total_commission) || 0;
        });
        if (useRange) {
            const canon = await this.getMonthlyTagihanTotals(m, y, { scope: 'collector_territory' });
            const global = await this.getMonthlyTagihanTotals(m, y, { scope: 'all' });
            summary = {
                total_tagihan: canon.total_tagihan,
                total_lunas: canon.total_lunas,
                total_belum_lunas: canon.total_belum_lunas,
                total_komisi: summary.total_komisi,
                total_tagihan_global: global.total_tagihan,
                total_tagihan_outside_collector_pool: Math.max(
                    0,
                    global.total_tagihan - canon.total_tagihan
                )
            };
        } else {
            list.forEach((c) => {
                summary.total_tagihan += Number(c.total_tagihan_area) || 0;
                summary.total_lunas += Number(c.total_lunas_area) || 0;
                summary.total_belum_lunas += Number(c.total_belum_lunas_amount) || 0;
            });
        }
        return { rows: list, summary };
    }

    // Method untuk mendapatkan riwayat komisi (expenses) — bukan log setoran kasir (lihat getCollectorRemittanceReceipts).
    async getCommissionExpenses() {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT 
                    e.id,
                    e.description,
                    e.amount,
                    e.expense_date as received_at,
                    e.payment_method,
                    e.notes,
                    SUBSTR(e.description, 18) as collector_name
                FROM expenses e
                WHERE e.category = 'Operasional' 
                AND e.description LIKE 'Komisi Kolektor%'
                ORDER BY e.expense_date DESC
                LIMIT 20
            `;
            
            this.db.all(sql, [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    /** Tabel log penerimaan setoran ke kasir (Terima Setoran admin). */
    async ensureCollectorRemittanceReceiptsTable() {
        return new Promise((resolve, reject) => {
            const sql = `CREATE TABLE IF NOT EXISTS collector_remittance_receipts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collector_id INTEGER NOT NULL,
                amount_net REAL NOT NULL,
                payment_method TEXT,
                notes TEXT,
                received_at TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (collector_id) REFERENCES collectors(id)
            )`;
            this.db.run(sql, (err) => {
                if (err) return reject(err);
                this.db.run(
                    'CREATE INDEX IF NOT EXISTS idx_crr_collector ON collector_remittance_receipts(collector_id)',
                    () => {}
                );
                this.db.run(
                    'CREATE INDEX IF NOT EXISTS idx_crr_received ON collector_remittance_receipts(received_at)',
                    () => {}
                );
                // Satu kali: hapus entri expenses "Komisi Kolektor … Citra Dewi" yang dulu salah dipakai sebagai riwayat setoran di UI.
                const flagPath = path.join(path.dirname(this.dbPath), '.legacy_remittance_ui_cleanup_citra_dewi');
                if (!fs.existsSync(flagPath)) {
                    this.db.run(
                        `DELETE FROM expenses
                         WHERE category = 'Operasional'
                           AND description LIKE 'Komisi Kolektor%'
                           AND LOWER(description) LIKE '%citra%dewi%'`,
                        (delErr) => {
                            if (delErr) {
                                console.error('[billing] Cleanup legacy remittance UI (Citra Dewi):', delErr.message);
                            }
                            try {
                                fs.writeFileSync(flagPath, new Date().toISOString(), 'utf8');
                            } catch (wErr) {
                                console.warn('[billing] Could not write cleanup flag:', wErr.message);
                            }
                            resolve();
                        }
                    );
                } else {
                    resolve();
                }
            });
        });
    }

    /** Riwayat penerimaan setoran (nilai net yang disetor ke kasir). */
    async getCollectorRemittanceReceipts(limit = 80) {
        await this.ensureCollectorRemittanceReceiptsTable();
        const lim = Math.min(500, Math.max(1, parseInt(String(limit), 10) || 80));
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT 
                    r.id,
                    r.amount_net as amount,
                    r.payment_method,
                    r.notes,
                    r.received_at,
                    c.name as collector_name
                FROM collector_remittance_receipts r
                JOIN collectors c ON c.id = r.collector_id
                ORDER BY datetime(COALESCE(r.received_at, r.created_at)) DESC, r.id DESC
                LIMIT ?
            `;
            this.db.all(sql, [lim], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    /**
     * Riwayat penerimaan setoran untuk export (batas aman, filter periode opsional).
     * month/year = 'all' atau kosong → tanpa filter tanggal.
     */
    async getCollectorRemittanceReceiptsExported({ limit = 8000, month = null, year = null } = {}) {
        await this.ensureCollectorRemittanceReceiptsTable();
        const lim = Math.min(20000, Math.max(1, parseInt(String(limit), 10) || 8000));
        const m =
            month != null && String(month).trim() !== '' && String(month) !== 'all'
                ? parseInt(String(month), 10)
                : NaN;
        const y =
            year != null && String(year).trim() !== '' && String(year) !== 'all'
                ? parseInt(String(year), 10)
                : NaN;
        const useRange = Number.isFinite(m) && m >= 1 && m <= 12 && Number.isFinite(y);
        let dateWhere = '';
        const params = [];
        if (useRange) {
            const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
            const endDate = new Date(y, m, 0).toISOString().split('T')[0];
            dateWhere =
                ' WHERE date(COALESCE(r.received_at, r.created_at)) >= date(?) AND date(COALESCE(r.received_at, r.created_at)) <= date(?) ';
            params.push(startDate, endDate);
        }
        const sql = `
                SELECT
                    r.id,
                    r.amount_net as amount,
                    r.payment_method,
                    r.notes,
                    r.received_at,
                    c.name as collector_name
                FROM collector_remittance_receipts r
                JOIN collectors c ON c.id = r.collector_id
                ${dateWhere}
                ORDER BY datetime(COALESCE(r.received_at, r.created_at)) DESC, r.id DESC
                LIMIT ?
            `;
        params.push(lim);
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    async insertCollectorRemittanceReceipt({ collector_id, amount_net, payment_method, notes, received_at }) {
        await this.ensureCollectorRemittanceReceiptsTable();
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO collector_remittance_receipts (collector_id, amount_net, payment_method, notes, received_at)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    collector_id,
                    Number(amount_net) || 0,
                    payment_method != null ? String(payment_method) : '',
                    notes != null ? String(notes) : '',
                    received_at || new Date().toISOString()
                ],
                function (err) {
                    if (err) reject(err);
                    else resolve({ id: this.lastID });
                }
            );
        });
    }

    // Method untuk mencatat remittance (update status di payments) — mendukung setoran parsial sesuai jumlah di form (FIFO).
    async recordCollectorRemittance(remittanceData) {
        const { collector_id, amount, payment_method, notes, remittance_date } = remittanceData;
        const remitDate = remittance_date || new Date().toISOString();
        const noteStr = notes != null ? String(notes) : '';
        const collectorIdNum = parseInt(String(collector_id), 10);
        const targetNet = Number(amount);

        if (!Number.isFinite(collectorIdNum) || collectorIdNum <= 0) {
            throw new Error('ID kolektor tidak valid');
        }
        if (!Number.isFinite(targetNet) || targetNet <= 0) {
            throw new Error('Jumlah setoran harus lebih dari 0');
        }

        await this._ensurePaymentsDiscountColumn();
        await this._ensureRemittanceNetAppliedColumn();

        const targetCents = Math.round(targetNet * 100);

        const dbRun = (sql, params = []) =>
            new Promise((resolve, reject) => {
                this.db.run(sql, params, function (err) {
                    if (err) reject(err);
                    else resolve({ lastID: this.lastID, changes: this.changes });
                });
            });
        const dbAll = (sql, params = []) =>
            new Promise((resolve, reject) => {
                this.db.all(sql, params, (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                });
            });

        const rowsAll = await dbAll(
            `SELECT p.id, p.invoice_id, p.amount, p.commission_amount, p.payment_method, p.reference_number, p.notes, p.payment_date,
                    COALESCE(p.remittance_net_applied, 0) as remittance_net_applied,
                    COALESCE(i.amount, 0) as invoice_amount, COALESCE(p.discount_amount, 0) as discount_amount
             FROM payments p
             INNER JOIN invoices i ON i.id = p.invoice_id
             WHERE p.collector_id = ?
               AND p.payment_type = 'collector'
               AND (p.remittance_status IS NULL OR p.remittance_status = 'pending')
             ORDER BY datetime(COALESCE(p.payment_date, '1970-01-01')) ASC, p.id ASC`,
            [collectorIdNum]
        );
        const rows = (rowsAll || []).filter(
            (r) => paymentRemittancePoolRp(r) - (Number(r.remittance_net_applied) || 0) > 0.009
        );

        const normalized = rows.map((r) => {
            const poolRp = paymentRemittancePoolRp(r);
            const poolCents = Math.round(poolRp * 100);
            const appliedCents = Math.round((Number(r.remittance_net_applied) || 0) * 100);
            const pendingNetCents = Math.max(0, poolCents - appliedCents);
            return { ...r, _poolCents: poolCents, _appliedCents: appliedCents, _pendingNetCents: pendingNetCents };
        });

        const pendingNetCents = normalized.reduce((s, row) => s + row._pendingNetCents, 0);

        if (pendingNetCents <= 0) {
            throw new Error('Tidak ada sisa setoran untuk kolektor ini');
        }
        if (targetCents > pendingNetCents + 1) {
            const maxRp = pendingNetCents / 100;
            throw new Error(
                `Jumlah setoran (Rp ${targetNet.toLocaleString('id-ID')}) melebihi sisa belum setor (Rp ${maxRp.toLocaleString('id-ID')})`
            );
        }

        let rowsTouched = 0;
        let partialApplied = false;

        await dbRun('BEGIN IMMEDIATE');
        try {
            let remaining = targetCents;

            for (const row of normalized) {
                if (remaining <= 0) break;
                if (row._pendingNetCents <= 0) continue;

                if (remaining >= row._pendingNetCents) {
                    const newAppliedRp = row._poolCents / 100;
                    await dbRun(
                        `UPDATE payments SET
                            remittance_net_applied = ?,
                            remittance_status = 'remitted',
                            remittance_date = ?,
                            remittance_notes = ?
                         WHERE id = ?`,
                        [newAppliedRp, remitDate, noteStr, row.id]
                    );
                    remaining -= row._pendingNetCents;
                    rowsTouched += 1;
                } else {
                    const newAppliedCents = row._appliedCents + remaining;
                    const newAppliedRp = newAppliedCents / 100;
                    await dbRun(
                        `UPDATE payments SET
                            remittance_net_applied = ?,
                            remittance_status = 'pending',
                            remittance_notes = CASE
                                WHEN TRIM(?) != '' THEN ?
                                ELSE remittance_notes END
                         WHERE id = ?`,
                        [newAppliedRp, noteStr, noteStr, row.id]
                    );
                    partialApplied = true;
                    rowsTouched += 1;
                    remaining = 0;
                    break;
                }
            }

            if (remaining > 0) {
                throw new Error('Alokasi setoran tidak selesai; coba ulangi dengan jumlah yang lebih kecil');
            }

            await dbRun('COMMIT');

            let receiptLogId = null;
            try {
                const rec = await this.insertCollectorRemittanceReceipt({
                    collector_id: collectorIdNum,
                    amount_net: targetNet,
                    payment_method,
                    notes: noteStr,
                    received_at: remitDate
                });
                receiptLogId = rec && rec.id != null ? rec.id : null;
            } catch (logErr) {
                console.error('[billing] Gagal mencatat riwayat setoran (payments sudah commit):', logErr.message);
            }
            if (receiptLogId != null) {
                setImmediate(() => {
                    try {
                        const cfn = require('./collectorFieldNotifications');
                        cfn.notifyAdminRemittanceRecorded(collectorIdNum, receiptLogId, targetNet);
                    } catch (_) {}
                });
            }

            return {
                success: true,
                updatedPayments: rowsTouched,
                splitPayment: partialApplied,
                ...remittanceData
            };
        } catch (e) {
            await dbRun('ROLLBACK').catch(() => {});
            throw e;
        }
    }

    async getPaymentTransactions(invoiceId = null) {
        return new Promise((resolve, reject) => {
            let sql = `
                SELECT pgt.*, i.invoice_number, c.name as customer_name
                FROM payment_gateway_transactions pgt
                JOIN invoices i ON pgt.invoice_id = i.id
                JOIN customers c ON i.customer_id = c.id
            `;

            const params = [];
            if (invoiceId) {
                sql += ' WHERE pgt.invoice_id = ?';
                params.push(invoiceId);
            }

            sql += ' ORDER BY pgt.created_at DESC';

            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async getGatewayStatus() {
        return this.paymentGateway.getGatewayStatus();
    }

    // Send payment success notification
    async sendPaymentSuccessNotification(customer, invoice) {
        try {
            logger.info(`[NOTIFICATION] Sending payment success notification to ${customer.phone} for invoice ${invoice.invoice_number}`);
            
            // Use WhatsApp notification manager with template support
            const whatsappNotifications = require('./whatsapp-notifications');
            
            // Check if this is a member invoice
            const isMemberInvoice = invoice.member_id !== null && invoice.member_id !== undefined;
            
            if (isMemberInvoice) {
                // Use member payment notification
                const member = await this.getMemberById(invoice.member_id);
                if (member) {
                    // Get payment details
                    const payments = await this.getPayments();
                    const payment = payments.find(p => p.invoice_id === invoice.id);
                    
                    // Get member package
                    const packageData = await this.getMemberPackageById(invoice.package_id);
                    
                    const data = {
                        customer_name: member.name,
                        invoice_number: invoice.invoice_number,
                        amount: whatsappNotifications.formatCurrency(invoice.amount),
                        payment_method: payment?.payment_method || 'Online',
                        payment_date: payment?.payment_date ? whatsappNotifications.formatDate(payment.payment_date) : whatsappNotifications.formatDate(new Date()),
                        reference_number: payment?.reference_number || '-',
                        package_name: packageData?.name || '-',
                        package_speed: packageData?.speed || '-'
                    };
                    
                    return await whatsappNotifications.sendPaymentReceivedNotification(member.phone, data);
                }
            } else {
                // Use customer payment notification
                const packageData = await this.getPackageById(invoice.package_id);
                
                // Get payment details
                const payments = await this.getPayments();
                const payment = payments.find(p => p.invoice_id === invoice.id);
                
                const data = {
                    customer_name: customer.name,
                    invoice_number: invoice.invoice_number,
                    amount: whatsappNotifications.formatCurrency(invoice.amount),
                    payment_method: payment?.payment_method || 'Online',
                    payment_date: payment?.payment_date ? whatsappNotifications.formatDate(payment.payment_date) : whatsappNotifications.formatDate(new Date()),
                    reference_number: payment?.reference_number || '-',
                    package_name: packageData?.name || '-',
                    package_speed: packageData?.speed || '-'
                };
                
                return await whatsappNotifications.sendPaymentReceivedNotification(customer.phone, data);
            }
        } catch (error) {
            logger.error(`[NOTIFICATION] Error sending payment success notification to ${customer.phone}:`, error);
            return false;
        }
    }

    // Fungsi untuk mendapatkan statistik laporan keuangan voucher
    // Menggunakan tabel voucher_revenue (bukan invoices), karena invoice hanya untuk pelanggan PPPoE
    async getVoucherReportStats(startDate, endDate) {
        // Keperluan backward compat: gunakan getVoucherInvoices untuk statistik
        const invoices = await this.getVoucherInvoices(startDate, endDate);
        return this.calculateVoucherStats(invoices);
    }

    // Fungsi untuk mendapatkan statistik laporan keuangan PPPoE
    async getPPPoEReportStats(startDate, endDate) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT 
                    COUNT(*) as total_invoices,
                    SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_invoices,
                    SUM(CASE WHEN status = 'unpaid' THEN 1 ELSE 0 END) as unpaid_invoices,
                    COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as total_revenue,
                    COALESCE(SUM(CASE WHEN status = 'unpaid' THEN amount ELSE 0 END), 0) as unpaid_amount,
                    COUNT(DISTINCT customer_id) as total_customers,
                    COUNT(DISTINCT CASE WHEN status = 'paid' THEN customer_id ELSE NULL END) as paid_customers
                FROM invoices
                WHERE (invoice_type != 'voucher' OR invoice_type IS NULL)
                AND DATE(created_at) >= ? AND DATE(created_at) <= ?
            `;
            
            this.db.get(sql, [startDate, endDate], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve({
                        total_invoices: parseInt(row.total_invoices) || 0,
                        paid_invoices: parseInt(row.paid_invoices) || 0,
                        unpaid_invoices: parseInt(row.unpaid_invoices) || 0,
                        total_revenue: parseFloat(row.total_revenue) || 0,
                        unpaid_amount: parseFloat(row.unpaid_amount) || 0,
                        total_customers: parseInt(row.total_customers) || 0,
                        paid_customers: parseInt(row.paid_customers) || 0
                    });
                }
            });
        });
    }

    // Fungsi untuk mendapatkan daftar voucher revenue dengan filter tanggal
    // Menggunakan tabel voucher_revenue (bukan invoices), karena invoice hanya untuk pelanggan PPPoE
    async getVoucherInvoices(startDate, endDate) {
        return new Promise(async (resolve, reject) => {
            try {
                logger.info(`getVoucherInvoices called: startDate=${startDate}, endDate=${endDate}`);
                
                // Dapatkan semua voucher revenue dari billing.db
                let sql = `
                    SELECT 
                        id,
                        username as voucher_username,
                        price as amount,
                        profile,
                        created_at,
                        used_at,
                        status,
                        usage_count,
                        notes
                    FROM voucher_revenue
                    WHERE date(created_at) >= date(?)
                    AND date(created_at) <= date(?)
                `;
                
                const params = [startDate, endDate];
                
                sql += ` ORDER BY created_at DESC`;
                
                logger.info(`Executing SQL: ${sql} with params: [${params.join(', ')}]`);
                
                this.db.all(sql, params, async (err, voucherRows) => {
                    if (err) {
                        logger.error(`Error getting voucher revenue: ${err.message}`);
                        reject(err);
                        return;
                    }
                    
                    logger.info(`Found ${voucherRows ? voucherRows.length : 0} voucher revenue rows from database`);
                    
                    // Optimasi: Query radacct sekali saja untuk semua voucher menggunakan batch query
                    // Jangan query per voucher karena sangat lambat!
                    try {
                        const { getRadiusConnection } = require('./mikrotik');
                        const conn = await getRadiusConnection();
                        
                        // Ambil semua username dari voucherRows
                        const usernames = (voucherRows || []).map(v => v.voucher_username).filter(u => u);
                        
                        if (usernames.length === 0) {
                            await conn.end();
                            resolve(voucherRows || []);
                            return;
                        }
                        
                        // Batch query: ambil semua usage info sekaligus dengan satu query
                        const placeholders = usernames.map(() => '?').join(',');
                        const [usageRows] = await conn.execute(`
                            SELECT 
                                username,
                                MIN(acctstarttime) as first_used_at,
                                MAX(acctstoptime) as last_used_at,
                                COUNT(*) as usage_count
                            FROM radacct
                            WHERE username IN (${placeholders})
                            AND acctstarttime IS NOT NULL
                            GROUP BY username
                        `, usernames);
                        
                        await conn.end();
                        
                        // Buat map untuk lookup cepat
                        const usageMap = new Map();
                        (usageRows || []).forEach(usage => {
                            usageMap.set(usage.username, {
                                first_used_at: usage.first_used_at || null,
                                last_used_at: usage.last_used_at || null,
                                usage_count: parseInt(usage.usage_count) || 0
                            });
                        });
                        
                        // Helper untuk menentukan status penggunaan
                        const normalizeUsageInfo = (voucher) => {
                            const usage = usageMap.get(voucher.voucher_username);
                            const fallbackFirstUsed = (voucher.used_at && voucher.used_at !== '0000-00-00 00:00:00') ? voucher.used_at : null;
                            const firstUsedAt = usage && usage.first_used_at ? usage.first_used_at : fallbackFirstUsed;
                            const usageCount = usage ? usage.usage_count : (voucher.usage_count || 0);
                            const numericUsage = parseInt(usageCount, 10) || 0;
                            const hasUsage = numericUsage > 0 || (firstUsedAt && firstUsedAt !== '0000-00-00 00:00:00');
                            const statusFromDb = (voucher.status || '').toLowerCase();
                            const isPaid = statusFromDb === 'paid' || hasUsage;
                            
                            return {
                                ...voucher,
                                first_used_at: firstUsedAt,
                                last_used_at: usage && usage.last_used_at ? usage.last_used_at : (voucher.used_at || null),
                                usage_count: numericUsage,
                                computed_status: isPaid ? 'paid' : 'unpaid',
                                usage_status_label: isPaid ? 'Sudah Digunakan' : 'Belum Digunakan',
                                usage_status_badge: isPaid ? 'success' : 'secondary'
                            };
                        };
                        
                        const vouchersWithUsage = (voucherRows || []).map(normalizeUsageInfo);
                        
                        logger.info(`Returning ${vouchersWithUsage.length} vouchers with usage info (batch query)`);
                        resolve(vouchersWithUsage || []);
                    } catch (radiusError) {
                        logger.error(`Error connecting to RADIUS: ${radiusError.message}`);
                        logger.info(`Returning ${voucherRows ? voucherRows.length : 0} vouchers from database only`);
                        // Jika error, tetap return data dari voucher_revenue dengan normalisasi status dasar
                        const fallback = (voucherRows || []).map(voucher => {
                            const fallbackFirstUsed = (voucher.used_at && voucher.used_at !== '0000-00-00 00:00:00') ? voucher.used_at : null;
                            const numericUsage = parseInt(voucher.usage_count || 0, 10) || 0;
                            const hasUsage = numericUsage > 0 || Boolean(fallbackFirstUsed);
                            const isPaid = (voucher.status || '').toLowerCase() === 'paid' || hasUsage;
                            return {
                                ...voucher,
                                first_used_at: fallbackFirstUsed,
                                last_used_at: fallbackFirstUsed,
                                usage_count: numericUsage,
                                computed_status: isPaid ? 'paid' : 'unpaid',
                                usage_status_label: isPaid ? 'Sudah Digunakan' : 'Belum Digunakan',
                                usage_status_badge: isPaid ? 'success' : 'secondary'
                            };
                        });
                        resolve(fallback);
                    }
                });
            } catch (error) {
                logger.error(`Error in getVoucherInvoices: ${error.message}`);
                reject(error);
            }
        });
    }

    // Fungsi untuk mendapatkan daftar invoice PPPoE dengan filter tanggal
    async getPPPoEInvoices(startDate, endDate, status = null) {
        return new Promise((resolve, reject) => {
            let sql = `
                SELECT 
                    i.*,
                    c.name as customer_name,
                    c.username as customer_username,
                    c.phone as customer_phone,
                    p.name as package_name,
                    p.speed as package_speed
                FROM invoices i
                LEFT JOIN customers c ON i.customer_id = c.id
                LEFT JOIN packages p ON i.package_id = p.id
                WHERE (i.invoice_type != 'voucher' OR i.invoice_type IS NULL)
                AND DATE(i.created_at) >= ? AND DATE(i.created_at) <= ?
            `;
            
            const params = [startDate, endDate];
            
            if (status) {
                sql += ` AND i.status = ?`;
                params.push(status);
            }
            
            sql += ` ORDER BY i.created_at DESC`;
            
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }
}

// Create singleton instance
const billingManager = new BillingManager();

billingManager.calculateVoucherStats = function(invoices = []) {
    const totalVouchers = invoices.length;
    const paidInvoices = invoices.filter(inv => inv.computed_status === 'paid');
    const unpaidInvoices = invoices.filter(inv => inv.computed_status !== 'paid');
    
    const toNumber = (value) => {
        const num = parseFloat(value);
        return Number.isFinite(num) ? num : 0;
    };
    
    const totalRevenue = paidInvoices.reduce((sum, inv) => sum + toNumber(inv.amount || inv.price || 0), 0);
    const unpaidAmount = unpaidInvoices.reduce((sum, inv) => sum + toNumber(inv.amount || inv.price || 0), 0);
    const averagePrice = paidInvoices.length > 0 ? totalRevenue / paidInvoices.length : 0;
    
    return {
        total_vouchers: totalVouchers,
        paid_vouchers: paidInvoices.length,
        unpaid_vouchers: unpaidInvoices.length,
        total_revenue: totalRevenue,
        unpaid_amount: unpaidAmount,
        average_price: averagePrice
    };
};

billingManager.filterVoucherInvoicesByStatus = function(invoices = [], status = 'all') {
    if (!status || status === 'all') return invoices;
    const normalizedStatus = status.toLowerCase();
    return invoices.filter(inv => (inv.computed_status || '').toLowerCase() === normalizedStatus);
};

billingManager.normalizeVoucherDate = function(dateValue) {
    if (!dateValue) {
        return new Date().toISOString();
    }

    if (dateValue instanceof Date) {
        return dateValue.toISOString();
    }

    if (typeof dateValue === 'string') {
        let normalized = dateValue.trim();
        if (!normalized) {
            return new Date().toISOString();
        }

        // Replace space with T for ISO compliance
        if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}$/.test(normalized)) {
            normalized = normalized.replace(' ', 'T');
        }

        const parsed = new Date(normalized);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }

        // Fallback: assume local time string
        const fallback = normalized.replace(' ', 'T');
        const parsedFallback = new Date(fallback);
        if (!Number.isNaN(parsedFallback.getTime())) {
            return parsedFallback.toISOString();
        }
    }

    return new Date().toISOString();
};

billingManager.buildVoucherTransactions = function(voucherInvoices = []) {
    return voucherInvoices
        .filter(inv => (inv.computed_status || '').toLowerCase() === 'paid')
        .map(inv => {
            const amount = parseFloat(inv.amount || inv.price || 0) || 0;
            const dateSource = inv.first_used_at || inv.used_at || inv.created_at;
            const normalizedDate = this.normalizeVoucherDate(dateSource);
            const descriptionParts = [`Voucher ${inv.voucher_username}`];
            if (inv.profile) {
                descriptionParts.push(`(${inv.profile})`);
            }
            return {
                type: 'income',
                date: normalizedDate,
                amount,
                payment_method: 'voucher',
                gateway_name: 'Voucher',
                invoice_number: inv.invoice_number || `VCHR-${inv.voucher_username}`,
                customer_name: inv.voucher_username,
                customer_phone: '',
                description: descriptionParts.join(' '),
                notes: inv.notes || '',
                collector_name: '',
                commission_amount: 0
            };
        });
};

// ========== MEMBER PACKAGE MANAGEMENT ==========

billingManager.createMemberPackage = function(packageData) {
    return new Promise((resolve, reject) => {
        const { 
            name, speed, price, tax_rate, description, hotspot_profile, 
            upload_limit, download_limit, burst_limit_upload, burst_limit_download, 
            burst_threshold, burst_time 
        } = packageData;
        
        const sql = `INSERT INTO member_packages (name, speed, price, tax_rate, description, hotspot_profile, upload_limit, download_limit, burst_limit_upload, burst_limit_download, burst_threshold, burst_time, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`;
        
        this.db.run(sql, [
            name, 
            speed, 
            price, 
            tax_rate || 11.00, 
            description || null, 
            hotspot_profile || 'default',
            upload_limit || null,
            download_limit || null,
            burst_limit_upload || null,
            burst_limit_download || null,
            burst_threshold || null,
            burst_time || null
        ], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ id: this.lastID, ...packageData });
            }
        });
    });
};

billingManager.getAllMemberPackages = function(activeOnly = false) {
    return new Promise((resolve, reject) => {
        const sql = activeOnly 
            ? `SELECT * FROM member_packages WHERE is_active = 1 ORDER BY name ASC`
            : `SELECT * FROM member_packages ORDER BY name ASC`;
        
        this.db.all(sql, [], (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
};

billingManager.getMemberPackageById = function(id) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM member_packages WHERE id = ?`;
        
        this.db.get(sql, [id], (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row || null);
            }
        });
    });
};

billingManager.updateMemberPackage = function(id, packageData) {
    return new Promise((resolve, reject) => {
        const { 
            name, speed, price, tax_rate, description, hotspot_profile,
            upload_limit, download_limit, burst_limit_upload, burst_limit_download, 
            burst_threshold, burst_time 
        } = packageData;
        
        const sql = `UPDATE member_packages SET 
            name = ?, speed = ?, price = ?, tax_rate = ?, description = ?, hotspot_profile = ?, 
            upload_limit = ?, download_limit = ?, burst_limit_upload = ?, burst_limit_download = ?,
            burst_threshold = ?, burst_time = ?
            WHERE id = ?`;
        
        this.db.run(sql, [
            name, 
            speed, 
            price, 
            tax_rate || 11.00, 
            description, 
            hotspot_profile || 'default',
            upload_limit || null,
            download_limit || null,
            burst_limit_upload || null,
            burst_limit_download || null,
            burst_threshold || null,
            burst_time || null,
            id
        ], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ id, ...packageData });
            }
        });
    });
};

billingManager.deleteMemberPackage = function(id) {
    return new Promise((resolve, reject) => {
        const sql = `UPDATE member_packages SET is_active = 0 WHERE id = ?`;
        
        this.db.run(sql, [id], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ id, deleted: true });
            }
        });
    });
};

// ========== MEMBER MANAGEMENT ==========

billingManager.createMember = function(memberData) {
    return new Promise((resolve, reject) => {
        const { 
            name, username, phone, hotspot_username, email, address, 
            package_id, hotspot_profile, status, server_hotspot,
            auto_suspension, billing_day, latitude, longitude,
            ktp_photo_path, house_photo_path
        } = memberData;
        
        // Generate username jika tidak ada
        // PENTING: username tidak boleh null karena diperlukan untuk suspension
        // Jika username null, akan menyebabkan error NOT NULL constraint saat update status
        const finalUsername = username || this.generateUsername(phone);
        const finalHotspotUsername = hotspot_username || finalUsername;
        
        // Normalisasi billing_day (1-28)
        const normBillingDay = Math.min(Math.max(parseInt(billing_day ?? 15, 10) || 15, 1), 28);
        const finalStatus = (status !== undefined && status !== null && status !== '') ? status : 'active';
        
        // PENTING: auto_suspension default 1 (enabled) untuk memastikan suspension bekerja
        // Jika auto_suspension = 0, member tidak akan diisolir otomatis meskipun invoice terlambat
        const finalAutoSuspension = auto_suspension !== undefined ? auto_suspension : 1;
        
        const sql = `INSERT INTO members (username, name, phone, hotspot_username, email, address, area, package_id, hotspot_profile, status, server_hotspot, auto_suspension, billing_day, latitude, longitude, ktp_photo_path, house_photo_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        
        // Default coordinates untuk Jakarta jika tidak ada koordinat
        const finalLatitude = latitude !== undefined ? parseFloat(latitude) : -6.2088;
        const finalLongitude = longitude !== undefined ? parseFloat(longitude) : 106.8456;
        
        this.db.run(sql, [
            finalUsername, 
            name, 
            phone, 
            finalHotspotUsername, 
            email || null, 
            address || null, 
            memberData.area || null,
            package_id, 
            hotspot_profile || null, 
            finalStatus,
            server_hotspot || null,
            finalAutoSuspension,
            normBillingDay,
            finalLatitude,
            finalLongitude,
            ktp_photo_path || null,
            house_photo_path || null
        ], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ id: this.lastID, ...memberData });
            }
        });
    });
};

billingManager.getAllMembers = function(filters = {}) {
    return new Promise((resolve, reject) => {
        let sql = `SELECT m.*, mp.name as package_name, mp.speed as package_speed, mp.price as package_price 
                   FROM members m 
                   LEFT JOIN member_packages mp ON m.package_id = mp.id
                   LEFT JOIN collector_assignments ca ON ca.member_id = m.id`;
        
        const conditions = [];
        const params = [];
        
        if (filters.status) {
            conditions.push('m.status = ?');
            params.push(filters.status);
        }
        
        if (filters.package_id) {
            conditions.push('m.package_id = ?');
            params.push(filters.package_id);
        }
        
        if (filters.search) {
            conditions.push('(m.name LIKE ? OR m.phone LIKE ? OR m.hotspot_username LIKE ? OR m.username LIKE ?)');
            const searchTerm = `%${filters.search}%`;
            params.push(searchTerm, searchTerm, searchTerm, searchTerm);
        }
        
        if (filters.area) {
            conditions.push('m.area = ?');
            params.push(filters.area);
        }

        if (filters.collector_id) {
            conditions.push('ca.collector_id = ?');
            params.push(filters.collector_id);
        }

        // Filter status pembayaran (Lunas/Belum Lunas) - Member
        if (filters.payment_status === 'paid') {
            conditions.push(`NOT EXISTS (
                SELECT 1 FROM invoices i 
                WHERE i.member_id = m.id 
                AND i.status = 'unpaid'
            ) AND EXISTS (
                SELECT 1 FROM invoices i 
                WHERE i.member_id = m.id 
                AND i.status = 'paid'
            )`);
        } else if (filters.payment_status === 'unpaid') {
            conditions.push(`EXISTS (
                SELECT 1 FROM invoices i 
                WHERE i.member_id = m.id 
                AND i.status = 'unpaid'
            )`);
        }
        
        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        
        sql += ' ORDER BY m.join_date DESC';
        
        // Pagination logic if needed
        if (filters.limit) {
            sql += ' LIMIT ?';
            params.push(parseInt(filters.limit));
            if (filters.offset) {
                sql += ' OFFSET ?';
                params.push(parseInt(filters.offset));
            }
        }
        
        this.db.all(sql, params, (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
};

billingManager.getMemberById = function(id) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT m.*, mp.name as package_name, mp.speed as package_speed, mp.price as package_price 
                     FROM members m 
                     LEFT JOIN member_packages mp ON m.package_id = mp.id 
                     WHERE m.id = ?`;
        
        this.db.get(sql, [id], (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row || null);
            }
        });
    });
};

billingManager.getMemberByPhone = function(phone) {
    return new Promise((resolve, reject) => {
        // Normalize phone number to try multiple formats
        const normalizePhone = (input) => {
            if (!input) return '';
            let s = String(input).replace(/[^0-9+]/g, '');
            if (s.startsWith('+')) s = s.slice(1);
            if (s.startsWith('0')) return '62' + s.slice(1);
            if (s.startsWith('62')) return s;
            if (/^8[0-9]{7,13}$/.test(s)) return '62' + s;
            return s;
        };
        
        const generatePhoneVariants = (input) => {
            const raw = String(input || '');
            const norm = normalizePhone(raw);
            const local = norm.startsWith('62') ? '0' + norm.slice(2) : raw;
            const plus = norm.startsWith('62') ? '+62' + norm.slice(2) : raw;
            const shortLocal = local.startsWith('0') ? local.slice(1) : local;
            return Array.from(new Set([raw, norm, local, plus, shortLocal].filter(Boolean)));
        };
        
        const variants = generatePhoneVariants(phone);
        
        // Try each variant
        let found = false;
        let currentIndex = 0;
        
        const tryNext = () => {
            if (currentIndex >= variants.length) {
                resolve(null);
                return;
            }
            
            const variant = variants[currentIndex];
            const sql = `SELECT m.*, mp.name as package_name, mp.speed as package_speed, mp.price as package_price 
                         FROM members m 
                         LEFT JOIN member_packages mp ON m.package_id = mp.id 
                         WHERE m.phone = ?`;
            
            this.db.get(sql, [variant], (err, row) => {
                if (err) {
                    reject(err);
                } else if (row) {
                    resolve(row);
                } else {
                    currentIndex++;
                    tryNext();
                }
            });
        };
        
        tryNext();
    });
};

billingManager.getMemberByHotspotUsername = function(hotspotUsername) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT m.*, mp.name as package_name, mp.speed as package_speed, mp.price as package_price 
                     FROM members m 
                     LEFT JOIN member_packages mp ON m.package_id = mp.id 
                     WHERE m.hotspot_username = ?`;
        
        this.db.get(sql, [hotspotUsername], (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row || null);
            }
        });
    });
};

billingManager.updateMember = function(id, memberData) {
    return new Promise((resolve, reject) => {
        const { 
            name, username, phone, hotspot_username, email, address, area,
            package_id, hotspot_profile, status, server_hotspot,
            auto_suspension, billing_day, latitude, longitude,
            ktp_photo_path, house_photo_path
        } = memberData;
        
        const sql = `UPDATE members SET 
            name = ?, username = ?, phone = ?, hotspot_username = ?, email = ?, address = ?, area = ?,
            package_id = ?, hotspot_profile = ?, status = ?, server_hotspot = ?,
            auto_suspension = ?, billing_day = ?, latitude = ?, longitude = ?,
            ktp_photo_path = ?, house_photo_path = ?
            WHERE id = ?`;
        
        this.db.run(sql, [
            name, 
            username, 
            phone, 
            hotspot_username, 
            email || null, 
            address || null, 
            area || null,
            package_id, 
            hotspot_profile || null, 
            status,
            server_hotspot || null,
            auto_suspension !== undefined ? auto_suspension : 1,
            billing_day ? parseInt(billing_day) : 15,
            latitude !== undefined ? parseFloat(latitude) : null,
            longitude !== undefined ? parseFloat(longitude) : null,
            ktp_photo_path || null,
            house_photo_path || null,
            id
        ], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ id, ...memberData });
            }
        });
    });
};

billingManager.updateMemberByPhone = function(phone, memberData) {
    return new Promise((resolve, reject) => {
        const { 
            name, username, hotspot_username, email, address, area,
            package_id, hotspot_profile, status, server_hotspot,
            auto_suspension, billing_day, latitude, longitude 
        } = memberData;
        
        const sql = `UPDATE members SET 
            name = ?, username = ?, hotspot_username = ?, email = ?, address = ?, area = ?,
            package_id = ?, hotspot_profile = ?, status = ?, server_hotspot = ?,
            auto_suspension = ?, billing_day = ?, latitude = ?, longitude = ?
            WHERE phone = ?`;
        
        this.db.run(sql, [
            name, 
            username, 
            hotspot_username, 
            email || null, 
            address || null, 
            area || null,
            package_id, 
            hotspot_profile || null, 
            status,
            server_hotspot || null,
            auto_suspension !== undefined ? auto_suspension : 1,
            billing_day ? parseInt(billing_day) : 15,
            latitude !== undefined ? parseFloat(latitude) : null,
            longitude !== undefined ? parseFloat(longitude) : null,
            phone
        ], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ phone, ...memberData });
            }
        });
    });
};

billingManager.deleteMember = function(id) {
    return new Promise((resolve, reject) => {
        const sql = `UPDATE members SET status = 'inactive' WHERE id = ?`;
        
        this.db.run(sql, [id], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ id, deleted: true });
            }
        });
    });
};

/** Broadcast teks admin ke portal pelanggan (tabel customer_portal_broadcasts). */
billingManager.getPortalBroadcasts = function (limit = 10) {
    const lim = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT id, title, body, created_at
            FROM customer_portal_broadcasts
            WHERE is_active = 1
            ORDER BY datetime(created_at) DESC
            LIMIT ?
        `;
        this.db.all(sql, [lim], (err, rows) => {
            if (err) {
                if (String(err.message || '').includes('no such table')) {
                    return resolve([]);
                }
                return reject(err);
            }
            resolve(rows || []);
        });
    });
};

/** Sisip pengumuman portal (admin / skrip). */
billingManager.insertPortalBroadcast = function (title, body) {
    const t = String(title || '').trim();
    const b = String(body || '').trim();
    if (!t || !b) {
        return Promise.reject(new Error('title dan body wajib'));
    }
    return new Promise((resolve, reject) => {
        this.db.run(
            'INSERT INTO customer_portal_broadcasts (title, body) VALUES (?, ?)',
            [t, b],
            function (err) {
                if (err) return reject(err);
                resolve({ id: this.lastID });
            }
        );
    });
};

/** Permintaan ubah paket dari portal pelanggan → admin dashboard. */
billingManager.insertPortalPackageRequest = function (row) {
    const cid = parseInt(row.customer_id, 10);
    if (!Number.isFinite(cid) || cid <= 0) {
        return Promise.reject(new Error('customer_id tidak valid'));
    }
    const targetName = String(row.target_package_name || '').trim();
    if (!targetName) {
        return Promise.reject(new Error('target paket wajib'));
    }
    const sql = `INSERT INTO customer_portal_package_requests (
        customer_id, customer_username, customer_name, customer_phone,
        current_package_name, current_speed,
        target_package_name, target_speed, target_price_rupiah, note, status
    ) VALUES (?,?,?,?,?,?,?,?,?,?, 'pending')`;
    const params = [
        cid,
        String(row.customer_username || '').trim() || null,
        String(row.customer_name || '').trim() || null,
        String(row.customer_phone || '').trim() || null,
        String(row.current_package_name || '').trim() || null,
        String(row.current_speed || '').trim() || null,
        targetName,
        String(row.target_speed || '').trim() || null,
        row.target_price_rupiah != null && row.target_price_rupiah !== ''
            ? parseInt(row.target_price_rupiah, 10)
            : null,
        String(row.note || '').trim() || null,
    ];
    return new Promise((resolve, reject) => {
        this.db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ id: this.lastID });
        });
    });
};

billingManager.listPortalPackageRequestsPending = function (limit = 20) {
    const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT r.*, datetime(r.created_at) as created_at_sort
            FROM customer_portal_package_requests r
            WHERE COALESCE(r.status, 'pending') = 'pending'
            ORDER BY datetime(r.created_at) DESC
            LIMIT ?
        `;
        this.db.all(sql, [lim], (err, rows) => {
            if (err) {
                if (String(err.message || '').includes('no such table')) {
                    return resolve([]);
                }
                return reject(err);
            }
            resolve(rows || []);
        });
    });
};

/** Jumlah baris permintaan ubah paket portal yang masih pending (setelah reconcile di route lain). */
billingManager.countPortalPackageRequestsPending = function () {
    return new Promise((resolve, reject) => {
        this.db.get(
            `SELECT COUNT(*) AS n FROM customer_portal_package_requests WHERE COALESCE(status, 'pending') = 'pending'`,
            [],
            (err, row) => {
                if (err) {
                    if (String(err.message || '').includes('no such table')) return resolve(0);
                    return reject(err);
                }
                resolve(Number(row && row.n) || 0);
            }
        );
    });
};

/** Tandai permintaan ubah paket selesai jika paket pelanggan sudah sesuai target (nama atau kecepatan). */
billingManager.reconcilePortalPackageRequestsFulfilled = async function () {
    const normName = (s) =>
        String(s || '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    const speedMbpsNum = (s) => {
        const m = String(s || '').match(/(\d+)\s*(?:mb|mbps|mega)/i);
        return m ? parseInt(m[1], 10) : null;
    };

    const rows = await new Promise((resolve, reject) => {
        this.db.all(
            `SELECT id, customer_id, target_package_name, target_speed
             FROM customer_portal_package_requests
             WHERE COALESCE(status, 'pending') = 'pending'`,
            [],
            (err, r) => {
                if (err) {
                    if (String(err.message || '').includes('no such table')) return resolve([]);
                    return reject(err);
                }
                resolve(r || []);
            }
        );
    });

    let closed = 0;
    for (const row of rows) {
        try {
            const cust = await billingManager.getCustomerById(row.customer_id);
            if (!cust) continue;
            let curName = String(cust.package_name || '').trim();
            let curSpeed = String(cust.package_speed || '').trim();
            if (cust.package_id) {
                try {
                    const pkg = await billingManager.getPackageById(cust.package_id);
                    if (pkg) {
                        if (pkg.name) curName = String(pkg.name).trim();
                        if (pkg.speed) curSpeed = String(pkg.speed).trim();
                    }
                } catch (_) {
                    /* ignore */
                }
            }
            const nameMatch = normName(curName) === normName(row.target_package_name);
            const tn = speedMbpsNum(row.target_speed);
            const cn = speedMbpsNum(curSpeed);
            const speedMatch =
                tn != null && cn != null && tn === cn && tn > 0;

            if (nameMatch || speedMatch) {
                await new Promise((resolve, reject) => {
                    this.db.run(
                        `UPDATE customer_portal_package_requests SET status = 'fulfilled' WHERE id = ?`,
                        [row.id],
                        (e) => (e ? reject(e) : resolve())
                    );
                });
                closed += 1;
            }
        } catch (_) {
            /* baris berikutnya */
        }
    }
    return closed;
};

/** Jumlah badge pusat notifikasi admin: teknisi (belum dibaca) + kolektor (isolir/lunas saja) + portal (paket + laporan gangguan: telepon cocok atau customer_id). */
billingManager.getAdminNotificationBadgeCount = function () {
    const countOne = (sql) =>
        new Promise((resolve) => {
            this.db.get(sql, [], (err, row) => {
                if (err) {
                    if (String(err.message || '').includes('no such table')) return resolve(0);
                    return resolve(0);
                }
                if (!row) return resolve(0);
                resolve(Number(row.n) || 0);
            });
        });
    const troubleJoinPhoneMatch =
        `REPLACE(REPLACE(REPLACE(TRIM(COALESCE(c.phone,'')),' ',''),'-',''),'+','') = REPLACE(REPLACE(REPLACE(TRIM(COALESCE(tr.phone,'')),' ',''),'-',''),'+','')`;
    const troubleCustomerJoin = `(
               (LENGTH(TRIM(COALESCE(c.phone,''))) > 5 AND ${troubleJoinPhoneMatch})
               OR (COALESCE(tr.customer_id, 0) > 0 AND CAST(tr.customer_id AS INTEGER) = CAST(c.id AS INTEGER))
             )`;
    return Promise.all([
        countOne(`SELECT COUNT(*) AS n FROM technician_field_notifications WHERE read_at IS NULL`),
        countOne(
            `SELECT COUNT(*) AS n FROM collector_field_notifications
             WHERE read_at IS NULL
               AND UPPER(TRIM(COALESCE(kind,''))) IN ('ISOLIR','INVOICE_PAID')`
        ),
        countOne(
            `SELECT COUNT(*) AS n FROM customer_portal_package_requests WHERE COALESCE(status, 'pending') = 'pending'`
        ),
        countOne(
            `SELECT COUNT(*) AS n FROM trouble_reports tr
             INNER JOIN customers c ON ${troubleCustomerJoin}
             WHERE LOWER(COALESCE(tr.status,'')) IN ('open','in_progress')`
        ),
    ]).then((parts) => parts.reduce((a, b) => a + b, 0));
};

/**
 * Feed notifikasi terpusat admin (disaring): pekerjaan teknisi; pelanggan lunas & isolir (kolektor);
 * permintaan paket + laporan gangguan (nomor telepon cocok **atau** `trouble_reports.customer_id` = pelanggan).
 */
billingManager.getAdminUnifiedNotificationFeed = function (limit = 40) {
    const lim = Math.min(200, Math.max(10, parseInt(limit, 10) || 40));
    const chunk = Math.max(15, Math.ceil(lim * 0.28));
    const db = this.db;
    const troubleJoinPhoneMatch =
        `REPLACE(REPLACE(REPLACE(TRIM(COALESCE(c.phone,'')),' ',''),'-',''),'+','') = REPLACE(REPLACE(REPLACE(TRIM(COALESCE(tr.phone,'')),' ',''),'-',''),'+','')`;
    const troubleCustomerJoin = `(
               (LENGTH(TRIM(COALESCE(c.phone,''))) > 5 AND ${troubleJoinPhoneMatch})
               OR (COALESCE(tr.customer_id, 0) > 0 AND CAST(tr.customer_id AS INTEGER) = CAST(c.id AS INTEGER))
             )`;

    const safeAll = (sql, params) =>
        new Promise((res, rej) => {
            db.all(sql, params, (e, rows) => {
                if (e) {
                    if (String(e.message || '').includes('no such table')) return res([]);
                    return rej(e);
                }
                res(rows || []);
            });
        });

    return Promise.all([
        safeAll(
            `
            SELECT 'technician' AS source, n.id AS item_id, n.title, n.body, n.created_at, n.read_at,
                   n.kind, n.ref_id, n.technician_id AS actor_id,
                   COALESCE(t.name, '') AS actor_name, '' AS customer_phone,
                   NULL AS portal_username, NULL AS cur_pkg, NULL AS cur_spd, NULL AS tgt_pkg, NULL AS tgt_spd,
                   NULL AS tgt_price, NULL AS portal_note, NULL AS tr_location, NULL AS tr_desc_full, NULL AS tr_status,
                   NULL AS tr_category, NULL AS tr_created
            FROM technician_field_notifications n
            LEFT JOIN technicians t ON t.id = n.technician_id
            WHERE n.read_at IS NULL
            ORDER BY datetime(n.created_at) DESC
            LIMIT ?`,
            [chunk]
        ),
        safeAll(
            `
            SELECT 'collector' AS source, n.id AS item_id, n.title, n.body, n.created_at, n.read_at,
                   n.kind, n.ref_id, n.collector_id AS actor_id,
                   COALESCE(c.name, '') AS actor_name, '' AS customer_phone,
                   NULL AS portal_username, NULL AS cur_pkg, NULL AS cur_spd, NULL AS tgt_pkg, NULL AS tgt_spd,
                   NULL AS tgt_price, NULL AS portal_note, NULL AS tr_location, NULL AS tr_desc_full, NULL AS tr_status,
                   NULL AS tr_category, NULL AS tr_created
            FROM collector_field_notifications n
            LEFT JOIN collectors c ON c.id = n.collector_id
            WHERE n.read_at IS NULL
              AND UPPER(TRIM(COALESCE(n.kind,''))) IN ('ISOLIR','INVOICE_PAID')
            ORDER BY datetime(n.created_at) DESC
            LIMIT ?`,
            [chunk]
        ),
        safeAll(
            `
            SELECT 'portal' AS source, r.id AS item_id,
                   'Permintaan ubah paket' AS title,
                   (COALESCE(r.customer_name,'') || ' → ' || COALESCE(r.target_package_name,'')) AS body,
                   r.created_at, NULL AS read_at,
                   'PKGREQ' AS kind, CAST(r.id AS TEXT) AS ref_id, r.customer_id AS actor_id,
                   COALESCE(r.customer_name,'') AS actor_name, COALESCE(r.customer_phone,'') AS customer_phone,
                   r.customer_username AS portal_username,
                   r.current_package_name AS cur_pkg, r.current_speed AS cur_spd,
                   r.target_package_name AS tgt_pkg, r.target_speed AS tgt_spd,
                   r.target_price_rupiah AS tgt_price, r.note AS portal_note,
                   NULL AS tr_location, NULL AS tr_desc_full, NULL AS tr_status, NULL AS tr_category, NULL AS tr_created
            FROM customer_portal_package_requests r
            WHERE COALESCE(r.status, 'pending') = 'pending'
            ORDER BY datetime(r.created_at) DESC
            LIMIT ?`,
            [chunk]
        ),
        safeAll(
            `
            SELECT 'portal_report' AS source, tr.id AS item_id,
                   ('Laporan gangguan · ' || COALESCE(tr.status,'')) AS title,
                   (COALESCE(tr.category,'') ||
                    CASE WHEN COALESCE(TRIM(tr.description),'') != '' THEN ': ' || SUBSTR(TRIM(tr.description), 1, 220) ELSE '' END) AS body,
                   COALESCE(tr.updated_at, tr.created_at) AS created_at, NULL AS read_at,
                   'TROUBLE' AS kind, CAST(tr.id AS TEXT) AS ref_id, c.id AS actor_id,
                   COALESCE(tr.name, c.name, '') AS actor_name, COALESCE(tr.phone, c.phone, '') AS customer_phone,
                   NULL AS portal_username, NULL AS cur_pkg, NULL AS cur_spd, NULL AS tgt_pkg, NULL AS tgt_spd,
                   NULL AS tgt_price, NULL AS portal_note,
                   tr.location AS tr_location, tr.description AS tr_desc_full, tr.status AS tr_status,
                   tr.category AS tr_category, tr.created_at AS tr_created
            FROM trouble_reports tr
            INNER JOIN customers c ON ${troubleCustomerJoin}
            WHERE LOWER(COALESCE(tr.status,'')) IN ('open','in_progress')
            ORDER BY datetime(COALESCE(tr.updated_at, tr.created_at)) DESC
            LIMIT ?`,
            [chunk]
        ),
    ])
        .then(([techRows, colRows, portalRows, troubleRows]) => {
            const rows = [...techRows, ...colRows, ...portalRows, ...troubleRows];
            rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

            const hrefFor = (row) => {
                if (row.source === 'portal') {
                    if (row.customer_phone) {
                        return `/admin/billing/customers?editPhone=${encodeURIComponent(row.customer_phone)}`;
                    }
                    return '/admin/billing/customers';
                }
                if (row.source === 'portal_report') {
                    return `/admin/trouble/detail/${encodeURIComponent(row.item_id)}`;
                }
                if (row.source === 'collector') {
                    const k = String(row.kind || '').toUpperCase();
                    if (k === 'INVOICE_PAID') return '/admin/billing/invoices';
                    if (k === 'ISOLIR') return '/admin/billing/service-suspension';
                    return '/admin/billing/collector-remittance';
                }
                const k = String(row.kind || '').toUpperCase();
                if (k === 'INSTALL') return '/admin/installations';
                if (k === 'LEAVE') return '/admin/employees/leave-requests';
                if (k === 'TR' && row.ref_id) return `/admin/trouble/detail/${encodeURIComponent(row.ref_id)}`;
                return '/admin/trouble';
            };

            const actorLabel = (row) => {
                if (row.source === 'portal') return 'Pelanggan · permintaan paket';
                if (row.source === 'portal_report') return 'Pelanggan · laporan gangguan';
                if (row.source === 'collector') {
                    const k = String(row.kind || '').toUpperCase();
                    if (k === 'INVOICE_PAID') return row.actor_name ? `Lunas (kolektor: ${row.actor_name})` : 'Pelanggan lunas';
                    if (k === 'ISOLIR') return row.actor_name ? `Isolir sistem · ${row.actor_name}` : 'Isolir sistem';
                    return row.actor_name ? `Kolektor: ${row.actor_name}` : `Kolektor #${row.actor_id}`;
                }
                return row.actor_name ? `Teknisi: ${row.actor_name}` : `Teknisi #${row.actor_id}`;
            };

            const items = rows.slice(0, lim).map((row) => {
                const base = {
                    source: row.source,
                    id: row.item_id,
                    title: row.title,
                    body: row.body || '',
                    created_at: row.created_at,
                    actor_label: actorLabel(row),
                    href: hrefFor(row),
                    kind: row.kind,
                    ref_id: row.ref_id,
                    actor_id: row.actor_id,
                    actor_name: row.actor_name,
                    customer_phone: row.customer_phone,
                };
                if (row.source === 'portal') {
                    base.detail = {
                        type: 'portal_package',
                        customer_username: row.portal_username,
                        current_package_name: row.cur_pkg,
                        current_speed: row.cur_spd,
                        target_package_name: row.tgt_pkg,
                        target_speed: row.tgt_spd,
                        target_price_rupiah: row.tgt_price,
                        note: row.portal_note,
                    };
                } else if (row.source === 'portal_report') {
                    base.detail = {
                        type: 'portal_trouble',
                        status: row.tr_status,
                        category: row.tr_category,
                        location: row.tr_location,
                        description: row.tr_desc_full,
                        report_created_at: row.tr_created,
                    };
                } else {
                    base.detail = { type: row.source === 'collector' ? 'collector' : 'technician', kind: row.kind, ref_id: row.ref_id };
                }
                return base;
            });
            return { items };
        })
        .catch((err) => Promise.reject(err));
};

/**
 * Kosongkan pusat notifikasi admin: tandai semua notifikasi teknisi & kolektor sudah dibaca,
 * dan tiadakan permintaan ubah paket portal yang masih pending (status dismissed).
 * Laporan gangguan (tiket) tidak diubah — tetap di menu gangguan.
 */
billingManager.clearAdminUiNotifications = function (opts = {}) {
    const dismissPortal = opts.dismissPortalRequests !== false;
    const runUpdate = (sql) =>
        new Promise((resolve, reject) => {
            this.db.run(sql, [], function (err) {
                if (err) {
                    if (String(err.message || '').includes('no such table')) return resolve(0);
                    return reject(err);
                }
                resolve(Number(this.changes) || 0);
            });
        });
    const seq = dismissPortal
        ? Promise.resolve()
            .then(() => runUpdate(`UPDATE technician_field_notifications SET read_at = datetime('now','localtime') WHERE read_at IS NULL`))
            .then((t) =>
                runUpdate(`UPDATE collector_field_notifications SET read_at = datetime('now','localtime') WHERE read_at IS NULL`).then(
                    (c) => ({ t, c })
                )
            )
            .then(({ t, c }) =>
                runUpdate(
                    `UPDATE customer_portal_package_requests SET status = 'dismissed' WHERE COALESCE(status,'pending') = 'pending'`
                ).then((p) => ({ technician_cleared: t, collector_cleared: c, portal_dismissed: p }))
            )
        : Promise.resolve()
            .then(() => runUpdate(`UPDATE technician_field_notifications SET read_at = datetime('now','localtime') WHERE read_at IS NULL`))
            .then((t) =>
                runUpdate(`UPDATE collector_field_notifications SET read_at = datetime('now','localtime') WHERE read_at IS NULL`).then((c) => ({
                    technician_cleared: t,
                    collector_cleared: c,
                    portal_dismissed: 0,
                }))
            );
    return seq;
};

module.exports = billingManager; 