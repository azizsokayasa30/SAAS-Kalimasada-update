#!/usr/bin/env node
'use strict';

/**
 * Import backup Manajemen Gudang + Absensi/Karyawan ke satu tenant SaaS.
 * Hanya menyentuh tabel warehouse_* / attendance_* / employees / employee_*.
 * Data billing (customers, invoices, dll) tidak diubah.
 *
 * Usage:
 *   node scripts/import-warehouse-attendance-to-tenant.js \
 *     --archive=/root/warehouse-attendance-export-....tar.gz \
 *     --tenant=skynet --dry-run
 *
 *   node scripts/import-warehouse-attendance-to-tenant.js \
 *     --archive=/root/warehouse-attendance-export-....tar.gz \
 *     --tenant=skynet --execute
 *
 *   node scripts/import-warehouse-attendance-to-tenant.js \
 *     --source-db=/path/warehouse_attendance.db --tenant=skynet --execute
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { createBillingDbBackup } = require('../utils/billingDbBackup');

const LIVE_DB = path.join(__dirname, '../data/billing.db');
const UPLOADS_DEST = path.join(__dirname, '../public/uploads');

/** Parent → child agar FK internal tetap konsisten. */
const IMPORT_TABLES = [
    'attendance_branches',
    'attendance_settings',
    'attendance_shifts',
    'warehouse_items',
    'warehouse_inbound_batches',
    'employees',
    'warehouse_units',
    'employee_attendance',
    'employee_leave_requests',
    'employee_payroll',
];

function parseArgs(argv) {
    const out = {
        archive: null,
        sourceDb: null,
        tenant: 'skynet',
        dryRun: false,
        execute: false,
        copyUploads: true,
        purge: true,
    };
    for (const arg of argv) {
        if (arg === '--dry-run') out.dryRun = true;
        else if (arg === '--execute') out.execute = true;
        else if (arg === '--no-uploads') out.copyUploads = false;
        else if (arg === '--no-purge') out.purge = false;
        else if (arg.startsWith('--archive=')) {
            out.archive = arg.slice('--archive='.length).replace(/^["']|["']$/g, '');
        } else if (arg.startsWith('--source-db=')) {
            out.sourceDb = arg.slice('--source-db='.length).replace(/^["']|["']$/g, '');
        } else if (arg.startsWith('--tenant=')) {
            out.tenant = arg.slice('--tenant='.length);
        }
    }
    return out;
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
    });
}

function isValidSqliteFile(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(16);
        fs.readSync(fd, buf, 0, 16, 0);
        fs.closeSync(fd);
        return buf.toString('utf8').startsWith('SQLite format 3');
    } catch (_) {
        return false;
    }
}

async function tableExists(db, schema, table) {
    const row = await get(
        db,
        `SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name=?`,
        [table]
    );
    return !!row;
}

async function getColumns(db, schema, table) {
    return all(db, `PRAGMA ${schema}.table_info(${table})`);
}

function extractSourceDb(archivePath, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    execFileSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' });

    const matches = [];
    function walk(dir) {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) walk(p);
            else if (
                (ent.name === 'warehouse_attendance.db' || ent.name === 'billing.db') &&
                p.includes(`${path.sep}sqlite${path.sep}`)
            ) {
                matches.push(p);
            }
        }
    }
    walk(destDir);
    if (!matches.length) {
        throw new Error('sqlite/warehouse_attendance.db (atau billing.db) tidak ditemukan di archive');
    }
    // Prefer mini warehouse_attendance.db jika ada
    const preferred = matches.find((p) => p.endsWith('warehouse_attendance.db'));
    return preferred || matches[0];
}

function copyEmployeeUploads(archivePathOrUploadsDir, destRoot) {
    const tmp = path.join('/tmp', `wh-att-uploads-${Date.now()}`);
    let uploadsRoot = null;

    if (fs.existsSync(archivePathOrUploadsDir) && fs.statSync(archivePathOrUploadsDir).isDirectory()) {
        uploadsRoot = archivePathOrUploadsDir;
    } else {
        fs.mkdirSync(tmp, { recursive: true });
        try {
            execFileSync('tar', ['-xzf', archivePathOrUploadsDir, '-C', tmp], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            console.warn('  catatan extract uploads:', err.message.split('\n')[0]);
        }
        function findUploads(dir) {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                    if (ent.name === 'uploads') return p;
                    const found = findUploads(p);
                    if (found) return found;
                }
            }
            return null;
        }
        uploadsRoot = findUploads(tmp);
    }

    let copied = 0;
    let skipped = 0;
    let overwritten = 0;

    function copyTree(srcDir, relBase) {
        if (!fs.existsSync(srcDir)) return;
        for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
            const src = path.join(srcDir, ent.name);
            const rel = path.join(relBase, ent.name);
            const dest = path.join(destRoot, rel);
            if (ent.isDirectory()) {
                fs.mkdirSync(dest, { recursive: true });
                copyTree(src, rel);
            } else {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                if (fs.existsSync(dest)) {
                    fs.copyFileSync(src, dest);
                    overwritten += 1;
                } else {
                    fs.copyFileSync(src, dest);
                    copied += 1;
                }
            }
        }
    }

    if (uploadsRoot) {
        // Hanya employees (+ subfolder) untuk paket ini
        const empDir = path.join(uploadsRoot, 'employees');
        if (fs.existsSync(empDir)) copyTree(empDir, 'employees');
        else copyTree(uploadsRoot, '');
    }

    if (fs.existsSync(tmp)) {
        try {
            fs.rmSync(tmp, { recursive: true, force: true });
        } catch (_) {
            /* ignore */
        }
    }
    return { copied, skipped, overwritten };
}

async function resolveTenant(db, slug) {
    const tenant = await get(
        db,
        `SELECT id, slug, name, subdomain, status FROM main.tenants
         WHERE (slug = ? OR subdomain = ? OR CAST(id AS TEXT) = ?)
           AND (deleted_at IS NULL OR deleted_at = '')`,
        [slug, slug, slug]
    );
    if (!tenant) {
        // Fallback tanpa filter deleted_at jika kolom tidak ada / soft-delete via status
        const fallback = await get(
            db,
            `SELECT id, slug, name, subdomain, status FROM main.tenants
             WHERE slug = ? OR subdomain = ? OR CAST(id AS TEXT) = ?`,
            [slug, slug, slug]
        );
        if (!fallback) throw new Error(`Tenant "${slug}" tidak ditemukan`);
        if (String(fallback.status).toLowerCase() === 'deleted') {
            throw new Error(`Tenant "${slug}" status deleted (id=${fallback.id})`);
        }
        return fallback;
    }
    if (String(tenant.status).toLowerCase() === 'deleted') {
        throw new Error(`Tenant "${slug}" status deleted (id=${tenant.id})`);
    }
    return tenant;
}

async function countSrcTables(db) {
    const counts = {};
    for (const table of IMPORT_TABLES) {
        if (!(await tableExists(db, 'src', table))) {
            counts[table] = null;
            continue;
        }
        const row = await get(db, `SELECT COUNT(*) AS c FROM src.${table}`);
        counts[table] = row?.c || 0;
    }
    return counts;
}

async function countLiveTables(db, tenantId) {
    const counts = {};
    for (const table of IMPORT_TABLES) {
        if (!(await tableExists(db, 'main', table))) {
            counts[table] = null;
            continue;
        }
        const cols = await getColumns(db, 'main', table);
        if (cols.some((c) => c.name === 'tenant_id')) {
            const row = await get(db, `SELECT COUNT(*) AS c FROM main.${table} WHERE tenant_id = ?`, [
                tenantId,
            ]);
            counts[table] = row?.c || 0;
        } else {
            const row = await get(db, `SELECT COUNT(*) AS c FROM main.${table}`);
            counts[table] = row?.c || 0;
        }
    }
    return counts;
}

async function purgeModuleTables(db, tenantId) {
    await run(db, 'PRAGMA foreign_keys=OFF');
    // Child dulu
    const purgeOrder = [
        'employee_attendance',
        'employee_leave_requests',
        'employee_payroll',
        'warehouse_units',
        'warehouse_inbound_batches',
        'warehouse_items',
        'employees',
        'attendance_branches',
        'attendance_settings',
        'attendance_shifts',
    ];
    for (const table of purgeOrder) {
        if (!(await tableExists(db, 'main', table))) continue;
        const cols = await getColumns(db, 'main', table);
        if (!cols.some((c) => c.name === 'tenant_id')) continue;
        await run(db, `DELETE FROM main.${table} WHERE tenant_id = ?`, [tenantId]);
    }
    await run(db, 'PRAGMA foreign_keys=ON');
}

async function importTable(db, table, tenantId, validAreaIds) {
    if (!(await tableExists(db, 'src', table))) {
        return { table, skipped: true, reason: 'not in backup' };
    }
    if (!(await tableExists(db, 'main', table))) {
        return { table, skipped: true, reason: 'not in live db' };
    }

    const srcCols = await getColumns(db, 'src', table);
    const destCols = await getColumns(db, 'main', table);
    const destNames = new Set(destCols.map((c) => c.name));
    const srcNames = new Set(srcCols.map((c) => c.name));

    let insertCols = destCols
        .map((c) => c.name)
        .filter((name) => name !== 'rowid' && (srcNames.has(name) || name === 'tenant_id'));

    // Pastikan tenant_id selalu ikut
    if (destNames.has('tenant_id') && !insertCols.includes('tenant_id')) {
        insertCols.push('tenant_id');
    }

    if (insertCols.length === 0) {
        return { table, skipped: true, reason: 'no common columns' };
    }

    const selectExprs = insertCols.map((col) => {
        if (col === 'tenant_id' && destNames.has('tenant_id')) {
            return `${Number(tenantId)} AS tenant_id`;
        }
        // area_id harus milik tenant target; jika tidak → NULL
        if (col === 'area_id' && table === 'employees' && srcNames.has('area_id')) {
            if (!validAreaIds.size) return 'NULL AS area_id';
            const ids = [...validAreaIds].join(',');
            return `CASE WHEN src.${table}.area_id IN (${ids}) THEN src.${table}.area_id ELSE NULL END AS area_id`;
        }
        if (!srcNames.has(col)) {
            return `NULL AS ${col}`;
        }
        return `src.${table}.${col}`;
    });

    const sql = `INSERT OR REPLACE INTO main.${table} (${insertCols.join(', ')})
                 SELECT ${selectExprs.join(', ')} FROM src.${table}`;

    const result = await run(db, sql);
    return { table, imported: result.changes };
}

async function bumpSequences(db) {
    if (!(await tableExists(db, 'main', 'sqlite_sequence'))) return;
    for (const table of IMPORT_TABLES) {
        if (!(await tableExists(db, 'main', table))) continue;
        const row = await get(db, `SELECT MAX(id) AS m FROM main.${table}`);
        const maxId = row?.m || 0;
        if (!maxId) continue;
        const existing = await get(db, `SELECT seq FROM main.sqlite_sequence WHERE name = ?`, [table]);
        if (existing) {
            if (existing.seq < maxId) {
                await run(db, `UPDATE main.sqlite_sequence SET seq = ? WHERE name = ?`, [maxId, table]);
            }
        } else {
            await run(db, `INSERT INTO main.sqlite_sequence(name, seq) VALUES (?, ?)`, [table, maxId]);
        }
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.dryRun && !args.execute) {
        console.error('Wajib pilih --dry-run atau --execute');
        process.exit(1);
    }
    if (args.dryRun && args.execute) {
        console.error('Pilih salah satu: --dry-run atau --execute');
        process.exit(1);
    }

    let workDir = null;
    let sourceDb = args.sourceDb ? path.resolve(args.sourceDb) : null;
    let archivePath = args.archive ? path.resolve(args.archive) : null;

    if (!sourceDb && !archivePath) {
        console.error('Berikan --archive=... atau --source-db=...');
        process.exit(1);
    }

    if (archivePath) {
        if (!fs.existsSync(archivePath)) {
            console.error('Archive tidak ditemukan:', archivePath);
            process.exit(1);
        }
        workDir = path.join('/tmp', `wh-att-import-${Date.now()}`);
        console.log('Extract archive ke', workDir);
        sourceDb = extractSourceDb(archivePath, workDir);
        console.log('Source DB:', sourceDb);
    }

    if (!isValidSqliteFile(sourceDb)) {
        console.error('Source bukan SQLite valid:', sourceDb);
        process.exit(1);
    }
    if (!fs.existsSync(LIVE_DB)) {
        console.error('Live DB tidak ditemukan:', LIVE_DB);
        process.exit(1);
    }

    const db = new sqlite3.Database(LIVE_DB);

    try {
        await run(db, 'PRAGMA wal_checkpoint(TRUNCATE)');
        await run(db, `ATTACH DATABASE ? AS src`, [sourceDb.replace(/\\/g, '/')]);

        const tenant = await resolveTenant(db, args.tenant);
        const tenantId = tenant.id;
        console.log(
            `Target tenant: ${tenant.name} (slug=${tenant.slug || '-'}, subdomain=${tenant.subdomain || '-'}, id=${tenantId})`
        );

        const srcCounts = await countSrcTables(db);
        const liveBefore = await countLiveTables(db, tenantId);

        console.log('\n=== Sumber (backup) ===');
        for (const [t, c] of Object.entries(srcCounts)) {
            console.log(`  ${t}: ${c === null ? '(tidak ada)' : c}`);
        }
        console.log('\n=== Live tenant sebelum import ===');
        for (const [t, c] of Object.entries(liveBefore)) {
            console.log(`  ${t}: ${c === null ? '(tidak ada)' : c}`);
        }

        // Cek collision NIK / public_code dengan tenant lain
        const nikCollisions = await all(
            db,
            `SELECT e.nik, e.nama_lengkap AS src_name, l.id AS live_id, l.tenant_id AS live_tenant
             FROM src.employees e
             JOIN main.employees l ON l.nik = e.nik AND l.tenant_id != ?`,
            [tenantId]
        );
        const codeCollisions = await all(
            db,
            `SELECT u.public_code, l.id AS live_id, l.tenant_id AS live_tenant
             FROM src.warehouse_units u
             JOIN main.warehouse_units l ON l.public_code = u.public_code AND l.tenant_id != ?`,
            [tenantId]
        );

        if (nikCollisions.length) {
            console.warn(`\n⚠ Collision NIK dengan tenant lain: ${nikCollisions.length}`);
            nikCollisions.slice(0, 5).forEach((r) => {
                console.warn(`  NIK ${r.nik} → live id=${r.live_id} tenant=${r.live_tenant}`);
            });
        }
        if (codeCollisions.length) {
            console.warn(`\n⚠ Collision warehouse public_code: ${codeCollisions.length}`);
            codeCollisions.slice(0, 5).forEach((r) => {
                console.warn(`  ${r.public_code} → live id=${r.live_id} tenant=${r.live_tenant}`);
            });
        }

        if (args.dryRun) {
            console.log('\n=== DRY RUN — tidak ada perubahan ===');
            console.log('Jalankan ulang dengan --execute untuk impor.');
            return;
        }

        if (nikCollisions.length || codeCollisions.length) {
            throw new Error(
                'Abort: ada collision UNIQUE global (NIK / warehouse public_code). Selesaikan dulu.'
            );
        }

        const pre = await createBillingDbBackup(LIVE_DB, { prefix: 'pre_wh_att_import', db });
        console.log('\nCadangan pra-import:', pre.filename);

        if (args.purge) {
            console.log('Purge data modul gudang/absensi tenant', tenantId, '...');
            await purgeModuleTables(db, tenantId);
        }

        const areaRows = await all(db, `SELECT id FROM main.areas WHERE tenant_id = ?`, [tenantId]);
        const validAreaIds = new Set(areaRows.map((r) => r.id));

        console.log('Mengimpor tabel...');
        await run(db, 'PRAGMA foreign_keys=OFF');
        const summary = [];
        for (const table of IMPORT_TABLES) {
            try {
                const result = await importTable(db, table, tenantId, validAreaIds);
                if (result.imported != null) {
                    summary.push(`${table}: ${result.imported}`);
                    console.log(`  ✓ ${table}: ${result.imported}`);
                } else if (result.skipped) {
                    console.log(`  skip ${table} (${result.reason})`);
                }
            } catch (err) {
                console.error(`  ✗ ${table}: ${err.message}`);
                throw err;
            }
        }
        await bumpSequences(db);
        await run(db, 'PRAGMA foreign_keys=ON');
        await run(db, 'PRAGMA wal_checkpoint(TRUNCATE)');

        if (args.copyUploads && archivePath) {
            console.log('\nMenyalin foto karyawan...');
            const up = copyEmployeeUploads(archivePath, UPLOADS_DEST);
            console.log(`  uploads: copied=${up.copied}, overwritten=${up.overwritten}`);
        } else if (args.copyUploads && workDir) {
            const uploadsDir = path.join(workDir);
            // cari uploads di workDir
            function findUploads(dir) {
                for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                    const p = path.join(dir, ent.name);
                    if (ent.isDirectory()) {
                        if (ent.name === 'uploads') return p;
                        const found = findUploads(p);
                        if (found) return found;
                    }
                }
                return null;
            }
            const found = findUploads(uploadsDir);
            if (found) {
                const up = copyEmployeeUploads(found, UPLOADS_DEST);
                console.log(`  uploads: copied=${up.copied}, overwritten=${up.overwritten}`);
            }
        }

        const liveAfter = await countLiveTables(db, tenantId);
        console.log('\n=== Selesai — live tenant setelah import ===');
        for (const [t, c] of Object.entries(liveAfter)) {
            const src = srcCounts[t];
            const mark = src != null && c === src ? 'OK' : src == null ? '-' : `src=${src}`;
            console.log(`  ${t}: ${c === null ? '(tidak ada)' : c}  [${mark}]`);
        }
        console.log('\nTabel diimpor:', summary.length);
        console.log('Restart / reload app jika perlu agar cache refresh.');
    } finally {
        try {
            await run(db, 'DETACH DATABASE src');
        } catch (_) {
            /* ignore */
        }
        db.close();
        if (workDir && fs.existsSync(workDir)) {
            try {
                fs.rmSync(workDir, { recursive: true, force: true });
            } catch (_) {
                /* ignore */
            }
        }
    }
}

main().catch((err) => {
    console.error('Import gagal:', err);
    process.exit(1);
});
