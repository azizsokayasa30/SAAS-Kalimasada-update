#!/usr/bin/env node
const sqlite3 = require('sqlite3');
const livePath = 'data/billing.db';
const tenantId = 2;

function q(db, sql, params = []) {
    return new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r))));
}

const TABLES = [
    'customers', 'packages', 'invoices', 'payments', 'routers', 'odps', 'areas',
    'network_segments', 'onus', 'onu_devices', 'installation_jobs', 'trouble_reports',
];

(async () => {
    const db = new sqlite3.Database(livePath);
    for (const table of TABLES) {
        try {
            const cols = await q(db, `PRAGMA table_info(${table})`);
            const hasTenant = cols.some((c) => c.name === 'tenant_id');
            if (hasTenant) {
                const rows = await q(db, `SELECT tenant_id, COUNT(*) c FROM ${table} GROUP BY tenant_id`);
                console.log(table, rows);
            } else {
                const rows = await q(db, `SELECT COUNT(*) c FROM ${table}`);
                console.log(table, 'no tenant_id, total=', rows[0].c);
            }
        } catch (e) {
            console.log(table, 'ERR', e.message);
        }
    }
    db.close();
})();
