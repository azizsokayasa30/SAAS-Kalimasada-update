#!/usr/bin/env node
/**
 * Perbaiki join_date di masa depan (biasanya salah isi / salah parse saat import Excel).
 *
 * Usage:
 *   node scripts/fix-join-date-future.js           # dry-run
 *   node scripts/fix-join-date-future.js --apply   # tulis ke DB
 */
const db = require('../config/billing').db;

const apply = process.argv.includes('--apply');

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
}

function runOne(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function pickFallbackJoinDate(row, today) {
    const firstInv = row.first_invoice_date ? String(row.first_invoice_date).slice(0, 10) : null;
    if (firstInv && firstInv <= today) {
        return { date: firstInv, reason: 'tanggal invoice pertama' };
    }
    // Import duplikat baru — join hari ini lebih masuk akal daripada tanggal depan
    if (Number(row.id) >= 2034) {
        return { date: today, reason: 'record import baru (tanpa invoice lama)' };
    }
    // Pelanggan lama tanpa invoice: tandai perlu cek manual (tanggal konservatif)
    return { date: '2019-01-01', reason: 'tidak ada invoice — perlu cek manual di admin' };
}

(async () => {
    const todayRow = await run(`SELECT date('now','localtime') as t`);
    const today = todayRow[0].t;
    console.log(`Hari ini (lokal): ${today}`);

    const future = await run(
        `SELECT c.id, c.name, c.pppoe_username, c.join_date, c.billing_day, c.fix_date,
                (SELECT MIN(date(i.created_at)) FROM invoices i WHERE i.customer_id = c.id) AS first_invoice_date
         FROM customers c
         WHERE date(c.join_date) > date('now','localtime')
         ORDER BY c.id`
    );
    console.log(`Pelanggan join_date > hari ini: ${future.length}`);

    const juneBaru = await run(
        `SELECT COUNT(*) as n FROM customers
         WHERE strftime('%Y-%m', join_date) = strftime('%Y-%m', 'now', 'localtime')
           AND date(join_date) <= date('now','localtime')`
    );
    console.log(`Pelanggan baru bulan berjalan (join <= hari ini): ${juneBaru[0].n}`);

    if (!future.length) {
        console.log('Tidak ada join_date masa depan.');
        process.exit(0);
    }

    if (!apply) {
        console.log('\nDry-run. Contoh 15 baris (rencana perbaikan):');
        future.slice(0, 15).forEach((r) => {
            const plan = pickFallbackJoinDate(r, today);
            console.log(
                `  id=${r.id} join=${r.join_date} inv=${r.first_invoice_date || '-'} → ${plan.date} (${plan.reason}) | ${r.name}`
            );
        });
        if (future.length > 15) {
            console.log(`  ... dan ${future.length - 15} baris lainnya`);
        }
        console.log('\nJalankan: node scripts/fix-join-date-future.js --apply');
        process.exit(0);
    }

    let fixed = 0;
    let needsManual = 0;
    for (const row of future) {
        const plan = pickFallbackJoinDate(row, today);
        if (plan.reason.includes('cek manual')) needsManual++;
        const joinStored = `${plan.date}T12:00:00+07:00`;
        const r = await runOne(`UPDATE customers SET join_date = ? WHERE id = ?`, [joinStored, row.id]);
        fixed += r.changes || 0;
    }
    console.log(`Diperbaiki: ${fixed} baris.`);
    if (needsManual) {
        console.log(`Perhatian: ${needsManual} baris dipakai tanggal sementara 2019-01-01 — silakan cek & koreksi di Kelola Pelanggan.`);
    }
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
