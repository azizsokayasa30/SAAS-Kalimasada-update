#!/usr/bin/env node

/**
 * Isolir ulang pelanggan dari CSV dengan label suspend_reason = manual.
 * Usage: node scripts/reapply-manual-isolir-from-csv.js [path-to-csv]
 */

const fs = require('fs');
const path = require('path');
const billingManager = require('../config/billing');
const serviceSuspension = require('../config/serviceSuspension');
const { isSuspendedStatus } = require('../utils/customerSuspendReason');

const CSV_PATH = process.argv[2] || path.join(__dirname, '../data/pelanggan-isolir-31-mei-2026-estimasi.csv');
const REASON = 'Isolir manual';
const CONCURRENCY = 8;

function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            inQ = !inQ;
            continue;
        }
        if (c === ',' && !inQ) {
            out.push(cur.trim());
            cur = '';
            continue;
        }
        cur += c;
    }
    out.push(cur.trim());
    return out;
}

function loadCsv(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const header = parseCsvLine(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        const row = {};
        header.forEach((h, idx) => {
            row[h] = cols[idx] || '';
        });
        rows.push(row);
    }
    return rows;
}

async function resolveCustomer(row) {
    const keys = [row.username, row.phone, row.pppoe_username].filter(Boolean);
    for (const key of keys) {
        try {
            const c = await billingManager.getCustomerByUsername(key);
            if (c) return c;
        } catch (_) {}
        try {
            const c = await billingManager.getCustomerByPhone(key);
            if (c) return c;
        } catch (_) {}
    }
    return null;
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
    if (!fs.existsSync(CSV_PATH)) {
        console.error('CSV tidak ditemukan:', CSV_PATH);
        process.exit(1);
    }

    const rows = loadCsv(CSV_PATH);
    console.log(`\n📋 ${rows.length} pelanggan dari CSV\n`);

    const summary = { ok: [], skipped: [], failed: [], notFound: [] };

    await runPool(rows, async (row) => {
        const label = row.name || row.username || row.phone;
        try {
            const customer = await resolveCustomer(row);
            if (!customer) {
                console.log(`❌ Tidak ditemukan: ${label}`);
                summary.notFound.push(row.username);
                return;
            }

            if (isSuspendedStatus(customer.status) && String(customer.suspend_reason || '').toLowerCase() === 'manual') {
                console.log(`⏭️  Sudah isolir manual: ${customer.name} (${customer.username})`);
                summary.skipped.push(customer.username);
                return;
            }

            const result = await serviceSuspension.suspendCustomerService(customer, REASON);
            if (result.success) {
                console.log(`✅ Isolir: ${customer.name} (${customer.pppoe_username || customer.username})`);
                summary.ok.push(customer.username);
            } else {
                console.log(`⚠️  Gagal sebagian: ${customer.name} — billing=${result.results?.billing} radius=${result.results?.mikrotik || result.results?.radius}`);
                summary.failed.push({ username: customer.username, result });
            }
        } catch (e) {
            console.log(`❌ Error ${label}: ${e.message}`);
            summary.failed.push({ username: row.username, error: e.message });
        }
    }, CONCURRENCY);

    console.log('\n--- Ringkasan ---');
    console.log(`Berhasil isolir: ${summary.ok.length}`);
    console.log(`Sudah isolir manual: ${summary.skipped.length}`);
    console.log(`Tidak ditemukan: ${summary.notFound.length}`);
    console.log(`Gagal: ${summary.failed.length}\n`);
    process.exit(summary.failed.length > 0 || summary.notFound.length > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
