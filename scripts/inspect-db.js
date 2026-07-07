#!/usr/bin/env node
const sqlite3 = require('sqlite3');
const backup = process.argv[2];
const live = process.argv[3] || 'data/billing.db';

function q(db, sql, params = []) {
    return new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r))));
}

(async () => {
    for (const [label, dbPath] of [['backup', backup], ['live', live]]) {
        const db = new sqlite3.Database(dbPath);
        const tenants = await q(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'");
        const hasTenants = tenants.length > 0;
        const cust = await q(db, 'SELECT COUNT(*) c FROM customers');
        const inv = await q(db, 'SELECT COUNT(*) c FROM invoices');
        const cols = await q(db, 'PRAGMA table_info(customers)');
        const tenantCols = cols.some((c) => c.name === 'tenant_id') ? 'yes' : 'no';
        let tenant1 = [];
        if (hasTenants) tenant1 = await q(db, "SELECT id, slug, name FROM tenants WHERE slug='tenant1'");
        const byTenant =
            tenantCols === 'yes' ? await q(db, 'SELECT tenant_id, COUNT(*) c FROM customers GROUP BY tenant_id') : [];
        console.log('---', label, dbPath, '---');
        console.log('has tenants table:', hasTenants);
        console.log('customers:', cust[0].c, 'invoices:', inv[0].c, 'tenant_id col:', tenantCols);
        if (tenant1.length) console.log('tenant1:', tenant1[0]);
        if (byTenant.length) console.log('customers by tenant:', byTenant);
        db.close();
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
