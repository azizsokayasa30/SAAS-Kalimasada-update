#!/usr/bin/env node
/**
 * Perbaiki join_date & created_at di DB dari file export/import XLSX (kolom Join Date / Created At).
 * Matching: PPPoE Username (sama seperti import restore).
 *
 * Dry-run (default):
 *   node scripts/reapply-customer-join-dates-from-xlsx.js path/to/pelanggan.xlsx
 *
 * Terapkan:
 *   node scripts/reapply-customer-join-dates-from-xlsx.js path/to/pelanggan.xlsx --apply
 */

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const ExcelJS = require('exceljs');

const DB_PATH = path.join(__dirname, '..', 'data', 'billing.db');

const HEADER_MAP = {
    'join date': 'join_date',
    join_date: 'join_date',
    'tanggal gabung': 'join_date',
    'created at': 'created_at',
    created_at: 'created_at',
    'pppoe username': 'pppoe_username',
    pppoe_username: 'pppoe_username'
};

function parseJoinDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date && !isNaN(value.getTime())) {
        return value.toISOString().slice(0, 10);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        const jsDate = new Date(Math.round((value - 25569) * 86400 * 1000));
        return isNaN(jsDate.getTime()) ? null : jsDate.toISOString().slice(0, 10);
    }
    const s = String(value).trim();
    if (!s) return null;
    const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) {
        const day = parseInt(slash[1], 10);
        const month = parseInt(slash[2], 10);
        const year = parseInt(slash[3], 10);
        const d = new Date(Date.UTC(year, month - 1, day));
        if (!isNaN(d.getTime())) {
            return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
    }
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return null;
}

function resolveJoinFromRow(joinRaw, createdRaw) {
    const preferred = (joinRaw !== '' && joinRaw != null) ? joinRaw : createdRaw;
    const iso = parseJoinDate(preferred);
    if (!iso) return null;
    const today = new Date().toISOString().slice(0, 10);
    return iso > today ? null : iso;
}

function formatStored(isoYmd) {
    return `${isoYmd}T12:00:00+07:00`;
}

function normalizeHeader(h) {
    const key = String(h || '').trim().toLowerCase();
    return HEADER_MAP[key] || key.replace(/\s+/g, '_');
}

async function main() {
    const xlsxPath = process.argv[2];
    const apply = process.argv.includes('--apply');
    if (!xlsxPath) {
        console.error('Usage: node scripts/reapply-customer-join-dates-from-xlsx.js <file.xlsx> [--apply]');
        process.exit(1);
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.resolve(xlsxPath));
    const ws = workbook.getWorksheet('Pelanggan') || workbook.worksheets[0];
    if (!ws) {
        console.error('Sheet Pelanggan tidak ditemukan.');
        process.exit(1);
    }

    const headerRow = ws.getRow(1);
    const colByKey = {};
    headerRow.eachCell((cell, colNumber) => {
        const norm = normalizeHeader(cell.value);
        if (norm) colByKey[norm] = colNumber;
    });

    const getVal = (row, key) => {
        const col = colByKey[key];
        if (!col) return '';
        const cell = row.getCell(col);
        if (!cell || cell.value == null) return '';
        if (cell.value && typeof cell.value === 'object' && cell.value.result != null) {
            return cell.value.result;
        }
        return cell.value;
    };

    const db = new sqlite3.Database(DB_PATH);
    const dbGet = (sql, params = []) => new Promise((res, rej) => {
        db.get(sql, params, (e, r) => (e ? rej(e) : res(r)));
    });
    const dbRun = (sql, params = []) => new Promise((res, rej) => {
        db.run(sql, params, function (e) { if (e) rej(e); else res(this.changes); });
    });

    await dbRun('ALTER TABLE customers ADD COLUMN created_at DATETIME').catch(() => {});

    let scanned = 0;
    let matched = 0;
    let updated = 0;
    let skippedNoDate = 0;
    let skippedNoPppoe = 0;
    const samples = [];

    for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        if (!row || !row.hasValues) continue;
        const name = String(getVal(row, 'name') || '').trim();
        if (!name || /^contoh\b/i.test(name)) continue;
        scanned++;

        const pppoe = String(getVal(row, 'pppoe_username') || '').trim();
        if (!pppoe) {
            skippedNoPppoe++;
            continue;
        }

        const iso = resolveJoinFromRow(getVal(row, 'join_date'), getVal(row, 'created_at'));
        if (!iso) {
            skippedNoDate++;
            continue;
        }

        const cust = await dbGet(
            `SELECT id, join_date, created_at FROM customers WHERE TRIM(COALESCE(pppoe_username,'')) = ? LIMIT 1`,
            [pppoe]
        );
        if (!cust) continue;
        matched++;

        const stored = formatStored(iso);
        const oldJoin = cust.join_date ? String(cust.join_date).slice(0, 10) : '';
        const oldCreated = cust.created_at ? String(cust.created_at).slice(0, 10) : '';
        const needs = oldJoin !== iso || oldCreated !== iso;

        if (needs && samples.length < 8) {
            samples.push({ pppoe, name, from: oldJoin || oldCreated, to: iso });
        }

        if (needs && apply) {
            await dbRun(
                `UPDATE customers SET join_date = ?, created_at = ? WHERE id = ?`,
                [stored, stored, cust.id]
            );
            updated++;
        } else if (needs) {
            updated++;
        }
    }

    const juneCount = await dbGet(
        `SELECT COUNT(*) AS cnt FROM customers
         WHERE strftime('%Y-%m', COALESCE(join_date, created_at)) = '2026-06'
           AND date(COALESCE(join_date, created_at)) <= date('now','localtime')`
    );

    console.log(apply ? '=== APPLY ===' : '=== DRY-RUN (tambah --apply untuk simpan) ===');
    console.log('File:', xlsxPath);
    console.log('Baris dipindai:', scanned);
    console.log('Match PPPoE + tanggal valid:', matched);
    console.log('Akan diperbarui join_date/created_at:', updated);
    console.log('Tanpa PPPoE:', skippedNoPppoe);
    console.log('Tanpa tanggal valid:', skippedNoDate);
    console.log('Pelanggan baru Juni 2026 (setelah perubahan):', juneCount?.cnt ?? 0);
    if (samples.length) {
        console.log('\nContoh perubahan:');
        samples.forEach((s) => console.log(`  ${s.pppoe} | ${s.name}: ${s.from || '(kosong)'} → ${s.to}`));
    }

    db.close();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
