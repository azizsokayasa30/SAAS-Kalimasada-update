'use strict';

const fs = require('fs');
const path = require('path');
const tenantStore = require('./tenantStore');
const { isCopiedOrigin } = require('./masterRecordGuard');

let schemaReady = false;
let schemaPromise = null;

function dbRun(sql, params = []) {
    return tenantStore.dbRun(sql, params);
}

function dbGet(sql, params = []) {
    return tenantStore.dbGet(sql, params);
}

function dbAll(sql, params = []) {
    return tenantStore.dbAll(sql, params);
}

async function ensureMasterMirrorSchema() {
    if (schemaReady) return;
    if (schemaPromise) return schemaPromise;
    schemaPromise = (async () => {
        const migrationPath = path.join(__dirname, '../../migrations/add_master_customer_mirrors.sql');
        if (fs.existsSync(migrationPath)) {
            const sql = fs.readFileSync(migrationPath, 'utf8');
            const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
            for (const stmt of statements) {
                try {
                    await dbRun(stmt);
                } catch (err) {
                    const msg = String(err.message || '').toLowerCase();
                    if (
                        !msg.includes('duplicate column')
                        && !msg.includes('already exists')
                        && !msg.includes('duplicate')
                    ) {
                        console.warn('[masterCopy] migration warn:', err.message);
                    }
                }
            }
        }
        schemaReady = true;
    })();
    try {
        await schemaPromise;
    } finally {
        schemaPromise = null;
    }
}

async function beginImmediate() {
    await dbRun('BEGIN IMMEDIATE');
}

async function commitTx() {
    await dbRun('COMMIT');
}

async function rollbackTx() {
    try {
        await dbRun('ROLLBACK');
    } catch (_) { /* ignore */ }
}

function mirrorInvoiceNumber(sourceTenantId, invoiceNumber, sourceInvoiceId) {
    const raw = String(invoiceNumber || `INV-${sourceInvoiceId}`).trim();
    if (raw.toUpperCase().startsWith('MST-')) return raw;
    const prefixed = `MST-${sourceTenantId}-${raw}`;
    return prefixed.slice(0, 180);
}

function mirrorUsername(sourceTenantId, sourceCustomerId) {
    return `mst${sourceTenantId}_${sourceCustomerId}`;
}

async function generateUniqueCustomerId() {
    for (let i = 0; i < 20; i++) {
        const id = String(100000 + Math.floor(Math.random() * 900000));
        const exists = await dbGet('SELECT id FROM customers WHERE customer_id = ? LIMIT 1', [id]);
        if (!exists) return id;
    }
    return String(Date.now()).slice(-6);
}

async function ensureShadowPackage(masterTenantId, sourceTenantId, sourcePackageId) {
    if (sourcePackageId == null) {
        const fallback = await dbGet(
            `SELECT id FROM packages
             WHERE tenant_id = ? AND name = 'Paket Master'
             LIMIT 1`,
            [masterTenantId]
        );
        if (fallback) return fallback.id;
        const insert = await dbRun(
            `INSERT INTO packages (name, speed, price, tax_rate, description, pppoe_profile, is_active, tenant_id)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
            ['Paket Master', '-', 0, 0, 'Paket catatan master tenant', null, masterTenantId]
        );
        return insert.id;
    }

    const mapped = await dbGet(
        `SELECT master_package_id FROM master_package_mirrors
         WHERE master_tenant_id = ? AND source_tenant_id = ? AND source_package_id = ?`,
        [masterTenantId, sourceTenantId, sourcePackageId]
    );
    if (mapped?.master_package_id) return mapped.master_package_id;

    const src = await dbGet('SELECT * FROM packages WHERE id = ? AND tenant_id = ?', [sourcePackageId, sourceTenantId]);
    const insert = await dbRun(
        `INSERT INTO packages (
            name, speed, price, tax_rate, description, pppoe_profile, is_active, tenant_id
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        [
            src?.name || 'Paket Master',
            src?.speed || '-',
            src?.price != null ? src.price : 0,
            src?.tax_rate != null ? src.tax_rate : 0,
            src?.description || `Paket tenant #${sourceTenantId}`,
            src?.pppoe_profile || null,
            masterTenantId,
        ]
    );
    await dbRun(
        `INSERT INTO master_package_mirrors (
            master_tenant_id, source_tenant_id, source_package_id, master_package_id
         ) VALUES (?, ?, ?, ?)`,
        [masterTenantId, sourceTenantId, sourcePackageId, insert.id]
    );
    return insert.id;
}

async function listCopiedSourceIds(sourceTenantId) {
    await ensureMasterMirrorSchema();
    const rows = await dbAll(
        `SELECT source_customer_id, master_customer_id
         FROM master_customer_copies
         WHERE source_tenant_id = ?`,
        [sourceTenantId]
    );
    const map = new Map();
    for (const row of rows) {
        map.set(Number(row.source_customer_id), Number(row.master_customer_id));
    }
    return map;
}

async function copyInvoicesAndPayments(masterTenantId, masterCustomerId, sourceTenantId, sourceCustomerId, packageMap) {
    const invoices = await dbAll(
        `SELECT * FROM invoices
         WHERE tenant_id = ?
           AND customer_id = ?
           AND (invoice_type != 'voucher' OR invoice_type IS NULL)
         ORDER BY id ASC`,
        [sourceTenantId, sourceCustomerId]
    );

    const sourceIds = invoices.map((inv) => inv.id);
    const existingBySource = new Map();
    if (sourceIds.length) {
        const placeholders = sourceIds.map(() => '?').join(',');
        const existing = await dbAll(
            `SELECT id, source_invoice_id FROM invoices
             WHERE tenant_id = ? AND customer_id = ? AND source_invoice_id IN (${placeholders})`,
            [masterTenantId, masterCustomerId, ...sourceIds]
        );
        existing.forEach((row) => existingBySource.set(Number(row.source_invoice_id), row));
    }

    const liveSourceIds = new Set(sourceIds.map((id) => Number(id)));

    for (const inv of invoices) {
        const masterPackageId = await ensureShadowPackage(
            masterTenantId,
            sourceTenantId,
            inv.package_id != null ? inv.package_id : packageMap
        );
        const existing = existingBySource.get(Number(inv.id));
        if (existing) {
            await dbRun(
                `UPDATE invoices SET
                    amount = ?, due_date = ?, status = ?, payment_date = ?, payment_method = ?,
                    notes = ?, description = ?, invoice_type = ?, package_name = ?,
                    base_amount = ?, tax_rate = ?, package_id = ?, source_missing = 0
                 WHERE id = ? AND tenant_id = ?`,
                [
                    inv.amount,
                    inv.due_date,
                    inv.status,
                    inv.payment_date || null,
                    inv.payment_method || null,
                    inv.notes || null,
                    inv.description || null,
                    inv.invoice_type || 'monthly',
                    inv.package_name || null,
                    inv.base_amount != null ? inv.base_amount : null,
                    inv.tax_rate != null ? inv.tax_rate : null,
                    masterPackageId,
                    existing.id,
                    masterTenantId,
                ]
            );
            await copyPaymentsForInvoice(masterTenantId, existing.id, inv.id, sourceTenantId);
        } else {
            const invoiceNumber = mirrorInvoiceNumber(sourceTenantId, inv.invoice_number, inv.id);
            let inserted;
            try {
                inserted = await dbRun(
                    `INSERT INTO invoices (
                        customer_id, member_id, package_id, invoice_number, amount, due_date, status,
                        payment_date, payment_method, notes, description, invoice_type, package_name,
                        created_at, tenant_id, tax_rate, base_amount, source_invoice_id, source_missing
                     ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
                    [
                        masterCustomerId,
                        masterPackageId,
                        invoiceNumber,
                        inv.amount,
                        inv.due_date,
                        inv.status,
                        inv.payment_date || null,
                        inv.payment_method || null,
                        inv.notes || null,
                        inv.description || null,
                        inv.invoice_type || 'monthly',
                        inv.package_name || null,
                        inv.created_at || null,
                        masterTenantId,
                        inv.tax_rate != null ? inv.tax_rate : null,
                        inv.base_amount != null ? inv.base_amount : null,
                        inv.id,
                    ]
                );
            } catch (err) {
                if (String(err.message || '').includes('UNIQUE')) {
                    inserted = await dbRun(
                        `INSERT INTO invoices (
                            customer_id, member_id, package_id, invoice_number, amount, due_date, status,
                            payment_date, payment_method, notes, description, invoice_type, package_name,
                            created_at, tenant_id, tax_rate, base_amount, source_invoice_id, source_missing
                         ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
                        [
                            masterCustomerId,
                            masterPackageId,
                            `${invoiceNumber}-${inv.id}`,
                            inv.amount,
                            inv.due_date,
                            inv.status,
                            inv.payment_date || null,
                            inv.payment_method || null,
                            inv.notes || null,
                            inv.description || null,
                            inv.invoice_type || 'monthly',
                            inv.package_name || null,
                            inv.created_at || null,
                            masterTenantId,
                            inv.tax_rate != null ? inv.tax_rate : null,
                            inv.base_amount != null ? inv.base_amount : null,
                            inv.id,
                        ]
                    );
                } else {
                    throw err;
                }
            }
            await copyPaymentsForInvoice(masterTenantId, inserted.id, inv.id, sourceTenantId);
        }
    }

    const mirrored = await dbAll(
        `SELECT id, source_invoice_id FROM invoices
         WHERE tenant_id = ? AND customer_id = ? AND source_invoice_id IS NOT NULL`,
        [masterTenantId, masterCustomerId]
    );
    for (const row of mirrored) {
        if (!liveSourceIds.has(Number(row.source_invoice_id))) {
            await dbRun(
                `UPDATE invoices SET source_missing = 1 WHERE id = ? AND tenant_id = ?`,
                [row.id, masterTenantId]
            );
        }
    }
}

async function copyPaymentsForInvoice(masterTenantId, masterInvoiceId, sourceInvoiceId, sourceTenantId) {
    const payments = await dbAll(
        `SELECT * FROM payments WHERE invoice_id = ? AND tenant_id = ? ORDER BY id ASC`,
        [sourceInvoiceId, sourceTenantId]
    );
    for (const pay of payments) {
        const exists = await dbGet(
            `SELECT id FROM payments WHERE tenant_id = ? AND source_payment_id = ? LIMIT 1`,
            [masterTenantId, pay.id]
        );
        if (exists) continue;
        await dbRun(
            `INSERT INTO payments (
                invoice_id, amount, payment_date, payment_method, reference_number, notes,
                payment_type, tenant_id, discount_amount, source_payment_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                masterInvoiceId,
                pay.amount,
                pay.payment_date || null,
                pay.payment_method || 'manual',
                pay.reference_number || null,
                pay.notes || null,
                pay.payment_type || 'direct',
                masterTenantId,
                pay.discount_amount != null ? pay.discount_amount : 0,
                pay.id,
            ]
        );
    }
}

async function insertCopiedCustomer(master, sourceTenant, source) {
    const username = mirrorUsername(sourceTenant.id, source.id);
    const customerId = await generateUniqueCustomerId();
    const packageId = await ensureShadowPackage(master.id, sourceTenant.id, source.package_id);
    const pppoeUsername = source.pppoe_username && String(source.pppoe_username).trim()
        ? String(source.pppoe_username).trim()
        : null;
    const insert = await dbRun(
        `INSERT INTO customers (
            customer_id, username, password, name, phone, pppoe_username, email, address, area, area_id,
            package_id, odp_id, pppoe_profile, status, auto_suspension, auto_suspension_day,
            billing_day, renewal_type, fix_date, static_ip, assigned_ip, mac_address, connection_type,
            cable_type, cable_length, port_number, cable_status, cable_notes,
            ktp_photo_path, house_photo_path,
            latitude, longitude, join_date, created_at, tenant_id, suspend_reason,
            master_origin, source_tenant_id, source_customer_id, source_tenant_name
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'copied', ?, ?, ?)`,
        [
            customerId,
            username,
            source.password || null,
            source.name,
            source.phone,
            pppoeUsername,
            source.email || null,
            source.address || null,
            source.area || null,
            packageId,
            source.odp_id || null,
            source.pppoe_profile || null,
            source.status || 'active',
            source.auto_suspension_day != null ? source.auto_suspension_day : null,
            source.billing_day != null ? source.billing_day : 15,
            source.renewal_type || 'fix_date',
            source.fix_date != null ? source.fix_date : null,
            source.static_ip || null,
            source.assigned_ip || null,
            source.mac_address || null,
            source.connection_type || (pppoeUsername ? 'pppoe' : 'static_ip'),
            source.cable_type || null,
            source.cable_length != null ? source.cable_length : null,
            source.port_number != null ? source.port_number : null,
            source.cable_status || null,
            source.cable_notes || null,
            source.ktp_photo_path || null,
            source.house_photo_path || null,
            source.latitude != null ? source.latitude : null,
            source.longitude != null ? source.longitude : null,
            source.join_date || null,
            source.created_at || source.join_date || null,
            master.id,
            source.suspend_reason || null,
            sourceTenant.id,
            source.id,
            sourceTenant.name || sourceTenant.subdomain || `Tenant #${sourceTenant.id}`,
        ]
    );
    return { id: insert.id, packageId, username, customerId };
}

async function copyCustomerFromTenant(sourceTenantId, sourceCustomerId, actor = {}) {
    await ensureMasterMirrorSchema();
    const master = await tenantStore.getMasterTenant();
    if (!master) {
        throw new Error('Master tenant belum dibuat. Setup dulu di /management/master-tenant/setup.');
    }
    const sourceTenant = await tenantStore.getTenantById(sourceTenantId);
    if (!sourceTenant || sourceTenant.is_master) {
        throw new Error('Tenant sumber tidak valid.');
    }

    const existingLink = await dbGet(
        `SELECT * FROM master_customer_copies
         WHERE source_tenant_id = ? AND source_customer_id = ?`,
        [sourceTenant.id, sourceCustomerId]
    );
    if (existingLink) {
        const err = new Error('Pelanggan ini sudah tersalin ke master tenant.');
        err.code = 'ALREADY_COPIED';
        err.masterCustomerId = existingLink.master_customer_id;
        throw err;
    }

    const source = await dbGet(
        `SELECT * FROM customers WHERE id = ? AND tenant_id = ?`,
        [sourceCustomerId, sourceTenant.id]
    );
    if (!source) {
        throw new Error('Pelanggan tidak ditemukan di tenant sumber.');
    }

    await beginImmediate();
    try {
        const copied = await insertCopiedCustomer(master, sourceTenant, source);
        await dbRun(
            `INSERT INTO master_customer_copies (
                master_tenant_id, master_customer_id, source_tenant_id, source_customer_id
             ) VALUES (?, ?, ?, ?)`,
            [master.id, copied.id, sourceTenant.id, source.id]
        );
        await copyInvoicesAndPayments(
            master.id,
            copied.id,
            sourceTenant.id,
            source.id,
            copied.packageId
        );
        await dbRun(
            `INSERT INTO master_copy_audit (
                master_tenant_id, source_tenant_id, source_customer_id, master_customer_id,
                actor_type, actor_id, action, details
             ) VALUES (?, ?, ?, ?, ?, ?, 'copy_customer', ?)`,
            [
                master.id,
                sourceTenant.id,
                source.id,
                copied.id,
                actor.actorType || 'SuperAdmin',
                actor.actorId || null,
                JSON.stringify({
                    source_name: source.name,
                    source_phone: source.phone,
                    master_username: copied.username,
                }),
            ]
        );
        await commitTx();
        return {
            masterCustomerId: copied.id,
            username: copied.username,
            sourceTenantId: sourceTenant.id,
            sourceCustomerId: source.id,
        };
    } catch (err) {
        await rollbackTx();
        throw err;
    }
}

async function syncMirroredCustomer(masterCustomerId) {
    await ensureMasterMirrorSchema();
    const master = await tenantStore.getMasterTenant();
    if (!master) return null;

    const mirror = await dbGet(
        `SELECT * FROM customers WHERE id = ? AND tenant_id = ?`,
        [masterCustomerId, master.id]
    );
    if (!mirror || !isCopiedOrigin(mirror) || !mirror.source_tenant_id || !mirror.source_customer_id) {
        return null;
    }

    const source = await dbGet(
        `SELECT * FROM customers WHERE id = ? AND tenant_id = ?`,
        [mirror.source_customer_id, mirror.source_tenant_id]
    );
    if (!source) {
        await dbRun(
            `UPDATE customers SET source_tenant_name = COALESCE(source_tenant_name, source_tenant_name)
             WHERE id = ? AND tenant_id = ?`,
            [mirror.id, master.id]
        );
        return { skipped: true, reason: 'source_missing' };
    }

    const packageId = await ensureShadowPackage(master.id, mirror.source_tenant_id, source.package_id);
    const pppoeUsername = source.pppoe_username && String(source.pppoe_username).trim()
        ? String(source.pppoe_username).trim()
        : null;
    await dbRun(
        `UPDATE customers SET
            name = ?, phone = ?, email = ?, address = ?, area = ?, password = ?,
            status = ?, suspend_reason = ?, billing_day = ?, renewal_type = ?, fix_date = ?,
            package_id = ?, auto_suspension = 0, auto_suspension_day = ?,
            pppoe_username = ?, pppoe_profile = ?,
            static_ip = ?, assigned_ip = ?, mac_address = ?, connection_type = ?,
            odp_id = ?, cable_type = ?, cable_length = ?, port_number = ?, cable_status = ?, cable_notes = ?,
            ktp_photo_path = ?, house_photo_path = ?,
            latitude = ?, longitude = ?
         WHERE id = ? AND tenant_id = ?`,
        [
            source.name,
            source.phone,
            source.email || null,
            source.address || null,
            source.area || null,
            source.password || null,
            source.status || 'active',
            source.suspend_reason || null,
            source.billing_day != null ? source.billing_day : mirror.billing_day,
            source.renewal_type || mirror.renewal_type,
            source.fix_date != null ? source.fix_date : mirror.fix_date,
            packageId,
            source.auto_suspension_day != null ? source.auto_suspension_day : null,
            pppoeUsername,
            source.pppoe_profile || null,
            source.static_ip || null,
            source.assigned_ip || null,
            source.mac_address || null,
            source.connection_type || (pppoeUsername ? 'pppoe' : 'static_ip'),
            source.odp_id || null,
            source.cable_type || null,
            source.cable_length != null ? source.cable_length : null,
            source.port_number != null ? source.port_number : null,
            source.cable_status || null,
            source.cable_notes || null,
            source.ktp_photo_path || null,
            source.house_photo_path || null,
            source.latitude != null ? source.latitude : null,
            source.longitude != null ? source.longitude : null,
            mirror.id,
            master.id,
        ]
    );
    await copyInvoicesAndPayments(
        master.id,
        mirror.id,
        mirror.source_tenant_id,
        mirror.source_customer_id,
        packageId
    );
    return { synced: true, masterCustomerId: mirror.id };
}

async function syncAllMirroredCustomers() {
    await ensureMasterMirrorSchema();
    const master = await tenantStore.getMasterTenant();
    if (!master) return { synced: 0 };
    const rows = await dbAll(
        `SELECT id FROM customers WHERE tenant_id = ? AND master_origin = 'copied'`,
        [master.id]
    );
    let synced = 0;
    for (const row of rows) {
        try {
            const result = await syncMirroredCustomer(row.id);
            if (result?.synced) synced += 1;
        } catch (err) {
            console.warn(`[masterCopy] sync customer #${row.id}:`, err.message);
        }
    }
    return { synced, total: rows.length };
}

async function maybeSyncOnMasterView(customerOrId) {
    try {
        const id = typeof customerOrId === 'object' ? customerOrId?.id : customerOrId;
        if (id == null) return;
        const row = typeof customerOrId === 'object' && customerOrId.master_origin
            ? customerOrId
            : await dbGet('SELECT id, master_origin FROM customers WHERE id = ?', [id]);
        if (!isCopiedOrigin(row)) return;
        await syncMirroredCustomer(row.id);
    } catch (err) {
        console.warn('[masterCopy] maybeSyncOnMasterView:', err.message);
    }
}

module.exports = {
    ensureMasterMirrorSchema,
    listCopiedSourceIds,
    copyCustomerFromTenant,
    syncMirroredCustomer,
    syncAllMirroredCustomers,
    maybeSyncOnMasterView,
    mirrorUsername,
    mirrorInvoiceNumber,
};
