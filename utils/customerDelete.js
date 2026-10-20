'use strict';

const sqlite3 = require('sqlite3').verbose();

function quoteIdent(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ''))) {
        throw new Error(`Identifier SQL tidak valid: ${name}`);
    }
    return `"${name}"`;
}

function dbRun(conn, sql, params = []) {
    return new Promise((resolve, reject) => {
        conn.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve({ changes: this.changes });
        });
    });
}

function dbAll(conn, sql, params = []) {
    return new Promise((resolve, reject) => {
        conn.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function primaryKeyColumn(columns) {
    const pks = (columns || []).filter((col) => col.pk > 0).sort((a, b) => a.pk - b.pk);
    if (pks.length === 1) return pks[0].name;
    return 'rowid';
}

async function loadSchema(conn) {
    const tables = (await dbAll(
        conn,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    )).map((row) => row.name);
    const foreignKeys = {};
    const columns = {};
    for (const table of tables) {
        foreignKeys[table] = await dbAll(conn, `PRAGMA foreign_key_list(${quoteIdent(table)})`);
        columns[table] = await dbAll(conn, `PRAGMA table_info(${quoteIdent(table)})`);
    }
    return { tables, foreignKeys, columns };
}

async function selectIds(conn, table, pk, whereCol, parentIds) {
    const ids = [];
    for (const part of chunk(parentIds, 400)) {
        const placeholders = part.map(() => '?').join(',');
        const rows = await dbAll(
            conn,
            `SELECT ${quoteIdent(pk)} AS pk FROM ${quoteIdent(table)} WHERE ${quoteIdent(whereCol)} IN (${placeholders})`,
            part
        );
        for (const row of rows) {
            if (row.pk != null) ids.push(row.pk);
        }
    }
    return ids;
}

/**
 * Hapus (atau null-kan) semua baris yang menunjuk ke parent lewat foreign key,
 * termasuk cucu, sebelum baris parent dihapus.
 */
async function purgeForeignKeyDependents(conn, schema, parentTable, parentColumn, parentIds, visiting) {
    const pending = [];
    for (const id of parentIds) {
        const key = `${parentTable}.${parentColumn}:${id}`;
        if (visiting.has(key)) continue;
        visiting.add(key);
        pending.push(id);
    }
    if (!pending.length) return;

    for (const child of schema.tables) {
        if (child === parentTable) continue;
        const links = schema.foreignKeys[child] || [];
        for (const fk of links) {
            if (fk.table !== parentTable || fk.to !== parentColumn) continue;
            const onDelete = String(fk.on_delete || '').toUpperCase();
            try {
                if (onDelete === 'SET NULL' || onDelete === 'SET DEFAULT') {
                    for (const part of chunk(pending, 400)) {
                        const placeholders = part.map(() => '?').join(',');
                        await dbRun(
                            conn,
                            `UPDATE ${quoteIdent(child)} SET ${quoteIdent(fk.from)} = NULL WHERE ${quoteIdent(fk.from)} IN (${placeholders})`,
                            part
                        );
                    }
                    continue;
                }

                const childPk = primaryKeyColumn(schema.columns[child]);
                const childIds = await selectIds(conn, child, childPk, fk.from, pending);
                if (childIds.length) {
                    await purgeForeignKeyDependents(conn, schema, child, childPk, childIds, visiting);
                }
                for (const part of chunk(pending, 400)) {
                    const placeholders = part.map(() => '?').join(',');
                    await dbRun(
                        conn,
                        `DELETE FROM ${quoteIdent(child)} WHERE ${quoteIdent(fk.from)} IN (${placeholders})`,
                        part
                    );
                }
            } catch (err) {
                const wrapped = new Error(
                    `Gagal membersihkan ${child}.${fk.from} sebelum menghapus ${parentTable}: ${err.message}`
                );
                wrapped.cause = err;
                throw wrapped;
            }
        }
    }
}

async function purgeLooseCustomerLinks(conn, schema, customer) {
    const linkedByFk = new Set();
    for (const table of schema.tables) {
        for (const fk of schema.foreignKeys[table] || []) {
            if (fk.table === 'customers') linkedByFk.add(table);
        }
    }

    for (const table of schema.tables) {
        if (table === 'customers' || linkedByFk.has(table)) continue;
        const cols = schema.columns[table] || [];
        if (!cols.some((col) => col.name === 'customer_id')) continue;
        const pk = primaryKeyColumn(cols);
        const ids = await selectIds(conn, table, pk, 'customer_id', [customer.id]);
        if (!ids.length) continue;
        await purgeForeignKeyDependents(conn, schema, table, pk, ids, new Set());
        await dbRun(conn, `DELETE FROM ${quoteIdent(table)} WHERE customer_id = ?`, [customer.id]);
    }

    if (customer.phone && schema.columns.trouble_reports) {
        await dbRun(
            conn,
            `DELETE FROM trouble_reports WHERE phone = ? AND (customer_id IS NULL OR customer_id = ?)`,
            [customer.phone, customer.id]
        );
    }
}

function withImmediateTransaction(dbPath, work) {
    const conn = new sqlite3.Database(dbPath);
    return (async () => {
        try {
            await dbRun(conn, 'PRAGMA foreign_keys = ON');
            await dbRun(conn, 'PRAGMA busy_timeout = 15000');
            await dbRun(conn, 'BEGIN IMMEDIATE');
            const result = await work(conn);
            await dbRun(conn, 'COMMIT');
            return result;
        } catch (err) {
            try { await dbRun(conn, 'ROLLBACK'); } catch (_) { /* koneksi sudah batal */ }
            throw err;
        } finally {
            await new Promise((resolve) => conn.close(() => resolve()));
        }
    })();
}

/**
 * Hapus pelanggan beserta data yang menahannya (tagihan, pembayaran, dll).
 * Berlaku untuk semua tenant karena membaca foreign key langsung dari skema.
 */
async function deleteCustomerRecord(dbPath, customer) {
    if (!customer || customer.id == null) {
        throw new Error('Pelanggan tidak ditemukan');
    }
    return withImmediateTransaction(dbPath, async (conn) => {
        const schema = await loadSchema(conn);
        await purgeLooseCustomerLinks(conn, schema, customer);
        await purgeForeignKeyDependents(conn, schema, 'customers', 'id', [customer.id], new Set());
        const deleted = await dbRun(conn, 'DELETE FROM customers WHERE id = ?', [customer.id]);
        if (!deleted.changes) {
            throw new Error('Pelanggan tidak ditemukan');
        }
        return { username: customer.username, deleted: true };
    });
}

module.exports = {
    deleteCustomerRecord,
    purgeForeignKeyDependents,
    loadSchema,
};
