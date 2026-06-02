#!/usr/bin/env node

/**
 * Emergency bulk restore: set semua pelanggan suspended/isolir kembali ke active
 * dan pulihkan group RADIUS dari PREVGROUP atau profil paket billing.
 * Tanpa notifikasi WA/email (beda dengan restoreCustomerService).
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const billingManager = require('../config/billing');
const {
    getRadiusConnection,
    getUserAuthModeAsync,
    unsuspendUserRadius,
    syncRadiusToFreeRadiusMysql,
    resolvePppoeProfileHintToRadiusGroup
} = require('../config/mikrotik');
const staticIPSuspension = require('../config/staticIPSuspension');

const dbPath = path.join(__dirname, '../data/billing.db');
const CONCURRENCY = 15;
const REASON = 'Bulk restore tanggal 1 — rollback isolir otomatis';

async function getSuspendedCustomers() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        db.all(
            `SELECT c.*, p.pppoe_profile AS package_pppoe_profile, p.name AS package_name
             FROM customers c
             LEFT JOIN packages p ON c.package_id = p.id
             WHERE c.status IN ('suspended', 'isolir')`,
            [],
            (err, rows) => {
                db.close();
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
}

async function bulkUpdateBillingStatus(countBefore) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        db.run(
            `UPDATE customers SET status = 'active', suspend_reason = NULL
             WHERE status IN ('suspended', 'isolir')`,
            function (err) {
                db.close();
                if (err) return reject(err);
                resolve(this.changes);
            }
        );
    });
}

async function bulkRestoreRadiusViaSql(customers) {
    const authMode = await getUserAuthModeAsync();
    if (authMode !== 'radius') {
        console.log(`Auth mode ${authMode}, skip bulk RADIUS SQL restore`);
        return { restored: 0, skipped: customers.length };
    }

    const conn = await getRadiusConnection();
    let restored = 0;
    let skipped = 0;

    for (const customer of customers) {
        const pppUser = String(customer.pppoe_username || customer.username || '').trim();
        if (!pppUser) {
            skipped++;
            continue;
        }

        try {
            const [current] = await conn.execute(
                "SELECT groupname FROM radusergroup WHERE username = ? LIMIT 1",
                [pppUser]
            );
            if (!current || !current.length || current[0].groupname !== 'isolir') {
                skipped++;
                continue;
            }

            const [prevGroup] = await conn.execute(
                "SELECT value FROM radcheck WHERE username = ? AND attribute = 'NT-Password' AND value LIKE 'PREVGROUP:%' LIMIT 1",
                [pppUser]
            );

            let groupToAssign = null;
            if (prevGroup && prevGroup.length > 0) {
                const val = prevGroup[0].value;
                if (val && val.startsWith('PREVGROUP:')) {
                    groupToAssign = val.substring('PREVGROUP:'.length);
                }
            }

            if (!groupToAssign) {
                groupToAssign = customer.pppoe_profile || customer.package_pppoe_profile || 'default';
            }

            const resolved = await resolvePppoeProfileHintToRadiusGroup(conn, groupToAssign);
            groupToAssign = resolved || groupToAssign || 'default';

            await conn.execute('DELETE FROM radusergroup WHERE username = ?', [pppUser]);
            await conn.execute(
                'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)',
                [pppUser, groupToAssign]
            );
            await conn.execute(
                "DELETE FROM radcheck WHERE username = ? AND attribute = 'NT-Password' AND value LIKE 'PREVGROUP:%'",
                [pppUser]
            );
            await conn.execute(
                "DELETE FROM radreply WHERE username = ? AND attribute IN ('Framed-Pool', 'Framed-IP-Address') AND value LIKE '%isolir%'",
                [pppUser]
            );
            restored++;
        } catch (e) {
            console.error(`  RADIUS error ${pppUser}: ${e.message}`);
            skipped++;
        }
    }

    try {
        if (typeof conn.end === 'function') await conn.end();
    } catch (_) {}

    await syncRadiusToFreeRadiusMysql({ force: true });
    return { restored, skipped };
}

async function runPool(items, worker, concurrency) {
    const results = [];
    let idx = 0;
    async function next() {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await worker(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
    return results;
}

async function main() {
    console.log(`\n🔄 Bulk restore semua pelanggan suspended/isolir\n`);
    console.log(`Alasan: ${REASON}\n`);

    const customers = await getSuspendedCustomers();
    console.log(`📋 Ditemukan ${customers.length} pelanggan suspended/isolir\n`);

    if (customers.length === 0) {
        console.log('✅ Tidak ada pelanggan yang perlu di-restore');
        process.exit(0);
    }

    const billingUpdated = await bulkUpdateBillingStatus(customers.length);
    console.log(`✅ Billing DB: ${billingUpdated} pelanggan di-set ke active\n`);

    const authMode = await getUserAuthModeAsync();
    console.log(`Auth mode: ${authMode}`);

    if (authMode === 'radius') {
        console.log('⏳ Restore group RADIUS (bulk SQL)...');
        const radiusResult = await bulkRestoreRadiusViaSql(customers);
        console.log(`✅ RADIUS: ${radiusResult.restored} user dipulihkan, ${radiusResult.skipped} dilewati\n`);
    } else {
        console.log('⏳ Restore via serviceSuspension (Mikrotik API)...');
        const serviceSuspension = require('../config/serviceSuspension');
        let ok = 0;
        let fail = 0;
        await runPool(
            customers,
            async (customer) => {
                try {
                    customer.status = 'active';
                    const r = await serviceSuspension.restoreCustomerService(customer, REASON);
                    if (r.success) ok++;
                    else fail++;
                    process.stdout.write(`\r  Progress: ${ok + fail}/${customers.length}`);
                } catch (e) {
                    fail++;
                    console.error(`\n  Error ${customer.username}: ${e.message}`);
                }
            },
            CONCURRENCY
        );
        console.log(`\n✅ Mikrotik restore: ${ok} ok, ${fail} gagal\n`);
    }

    const staticCustomers = customers.filter((c) => {
        const hasPpp = String(c.pppoe_username || c.username || '').trim();
        return !hasPpp && (c.static_ip || c.mac_address);
    });
    if (staticCustomers.length > 0) {
        console.log(`⏳ Restore ${staticCustomers.length} pelanggan static IP...`);
        for (const c of staticCustomers) {
            try {
                c.status = 'active';
                await staticIPSuspension.restoreStaticIPCustomer(c, REASON);
            } catch (e) {
                console.error(`  Static IP error ${c.username}: ${e.message}`);
            }
        }
    }

    const after = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        db.get(
            "SELECT COUNT(*) AS c FROM customers WHERE status IN ('suspended','isolir')",
            [],
            (err, row) => {
                db.close();
                if (err) reject(err);
                else resolve(row?.c || 0);
            }
        );
    });

    console.log(`\n📊 Sisa suspended/isolir di billing: ${after}`);
    console.log('✅ Bulk restore selesai.\n');
    console.log('Catatan: sesi PPPoE aktif mungkin perlu reconnect agar dapat profil normal.');
    process.exit(0);
}

main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
});
