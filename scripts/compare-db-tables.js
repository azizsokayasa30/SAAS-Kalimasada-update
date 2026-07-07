#!/usr/bin/env node
const sqlite3 = require('sqlite3');

const backupPath = process.argv[2];
const livePath = process.argv[3] || 'data/billing.db';

function q(db, sql, params = []) {
    return new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r))));
}

const TABLES = [
    'customers', 'packages', 'invoices', 'payments', 'routers', 'technicians',
    'collectors', 'areas', 'odps', 'members', 'member_packages', 'expenses',
    'income', 'installation_jobs', 'trouble_reports', 'employees', 'warehouse_items',
    'customer_router_map', 'collector_assignments', 'app_settings', 'activity_logs',
];

(async () => {
    const backup = new sqlite3.Database(backupPath);
    const live = new sqlite3.Database(livePath);

    console.log('table\tbackup\tlive(tenant1)\tlive(all)');
    for (const table of TABLES) {
        try {
            const b = await q(backup, `SELECT COUNT(*) c FROM ${table}`);
            const liveCols = await q(live, `PRAGMA table_info(${table})`);
            const hasTenant = liveCols.some((c) => c.name === 'tenant_id');
            let l1 = { c: 'n/a' };
            let la = await q(live, `SELECT COUNT(*) c FROM ${table}`);
            if (hasTenant) {
                l1 = await q(live, `SELECT COUNT(*) c FROM ${table} WHERE tenant_id = 2`);
            }
            const diff = Number(b[0].c) !== Number(l1.c) ? ' <-- DIFF' : '';
            console.log(`${table}\t${b[0].c}\t${l1.c}\t${la[0].c}${diff}`);
        } catch (e) {
            console.log(`${table}\tERR\t${e.message}`);
        }
    }

    backup.close();
    live.close();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
