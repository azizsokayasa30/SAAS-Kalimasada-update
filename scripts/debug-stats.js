#!/usr/bin/env node
const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('data/billing.db');
const q = (s, p = []) => new Promise((r, j) => db.all(s, p, (e, rows) => (e ? j(e) : r(rows))));

(async () => {
    console.log('invoices by tenant', await q('SELECT tenant_id, COUNT(*) c FROM invoices GROUP BY tenant_id'));
    console.log('july invoices t2', await q(
        "SELECT COUNT(*) c FROM invoices WHERE tenant_id=2 AND DATE(created_at) >= '2026-07-01' AND DATE(created_at) <= '2026-07-31'"
    ));
    console.log('june invoices t2', await q(
        "SELECT COUNT(*) c FROM invoices WHERE tenant_id=2 AND DATE(created_at) >= '2026-06-01' AND DATE(created_at) <= '2026-06-30'"
    ));
    console.log('tenant mismatch', await q(
        'SELECT COUNT(*) c FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE c.tenant_id=2 AND (i.tenant_id IS NULL OR i.tenant_id != 2)'
    ));
    console.log('invoices without tenant_id col check', await q('PRAGMA table_info(invoices)').then((c) => c.some((x) => x.name === 'tenant_id')));
    const sample = await q('SELECT id, tenant_id, created_at, status FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id=2) ORDER BY created_at DESC LIMIT 5');
    console.log('sample invoices', sample);
    const dueJuly = await q(
        "SELECT COUNT(*) c FROM invoices WHERE tenant_id=2 AND DATE(due_date) >= '2026-07-01' AND DATE(due_date) <= '2026-07-31'"
    );
    const dueJune = await q(
        "SELECT COUNT(*) c FROM invoices WHERE tenant_id=2 AND DATE(due_date) >= '2026-06-01' AND DATE(due_date) <= '2026-06-30'"
    );
    console.log('due july', dueJuly[0], 'due june', dueJune[0]);
    const baruJuly = await q(
        "SELECT COUNT(*) c FROM customers WHERE tenant_id=2 AND date(COALESCE(join_date, created_at)) >= '2026-07-01' AND date(COALESCE(join_date, created_at)) < '2026-08-01'"
    );
    const baruJune = await q(
        "SELECT COUNT(*) c FROM customers WHERE tenant_id=2 AND date(COALESCE(join_date, created_at)) >= '2026-06-01' AND date(COALESCE(join_date, created_at)) < '2026-07-01'"
    );
    console.log('baru july', baruJuly[0], 'baru june', baruJune[0]);
    db.close();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
