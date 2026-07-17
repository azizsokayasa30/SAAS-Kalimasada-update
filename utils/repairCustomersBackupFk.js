/**
 * Repair SQLite FK damage from ensureCustomersPhoneNonUnique.
 *
 * ALTER TABLE customers RENAME TO customers_backup_phone_unique_mig rewrites
 * child-table FOREIGN KEY clauses to the backup name. After the backup is
 * dropped, operations like DELETE FROM routers (CASCADE via customer_router_map)
 * fail with: no such table: main.customers_backup_phone_unique_mig
 */

const BACKUP_TABLE = 'customers_backup_phone_unique_mig';

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function rewriteCreateTableName(createSql, fromName, toName) {
    return String(createSql).replace(
        new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?["']?${fromName}["']?`, 'i'),
        `CREATE TABLE $1${toName}`
    );
}

/**
 * Rebuild every table whose CREATE SQL still references the leftover backup name.
 * @returns {{ repaired: string[] }}
 */
async function repairCustomersBackupPhoneUniqueFk(db, logger = console) {
    const broken = await dbAll(
        db,
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND sql LIKE ?`,
        [`%${BACKUP_TABLE}%`]
    );

    if (!broken.length) {
        return { repaired: [] };
    }

    const log = typeof logger.warn === 'function' ? logger.warn.bind(logger) : logger.log.bind(logger);
    log(`[FK-REPAIR] Memperbaiki ${broken.length} tabel yang masih mereferensikan ${BACKUP_TABLE}`);

    await dbRun(db, 'PRAGMA foreign_keys = OFF');
    await dbRun(db, 'BEGIN IMMEDIATE');

    const repaired = [];
    try {
        for (let i = 0; i < broken.length; i++) {
            const { name, sql } = broken[i];
            if (!sql) continue;

            const fixedSql = String(sql).replace(
                new RegExp(`["']?${BACKUP_TABLE}["']?`, 'g'),
                'customers'
            );
            const tempName = `${name}__cust_fk_fix_${i}`;
            const tempCreate = rewriteCreateTableName(fixedSql, name, tempName);

            const indexes = await dbAll(
                db,
                `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`,
                [name]
            );
            const triggers = await dbAll(
                db,
                `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql IS NOT NULL`,
                [name]
            );

            await dbRun(db, tempCreate);

            const cols = await dbAll(db, `PRAGMA table_info("${name}")`);
            const colList = cols.map((c) => `"${c.name}"`).join(', ');
            if (colList) {
                await dbRun(db, `INSERT INTO "${tempName}" (${colList}) SELECT ${colList} FROM "${name}"`);
            }

            await dbRun(db, `DROP TABLE "${name}"`);
            await dbRun(db, `ALTER TABLE "${tempName}" RENAME TO "${name}"`);

            for (const idx of indexes) {
                if (idx.sql) await dbRun(db, idx.sql);
            }
            for (const trg of triggers) {
                if (trg.sql) await dbRun(db, trg.sql);
            }

            repaired.push(name);
            log(`[FK-REPAIR] Rebuilt ${name}`);
        }

        await dbRun(db, 'COMMIT');
    } catch (err) {
        try { await dbRun(db, 'ROLLBACK'); } catch (_) {}
        throw err;
    } finally {
        try { await dbRun(db, 'PRAGMA foreign_keys = ON'); } catch (_) {}
    }

    return { repaired };
}

/**
 * Safer phone UNIQUE removal: create new table, copy, drop old, rename.
 * Does NOT rename customers first (that rewrites child FKs to the backup name).
 */
async function migrateCustomersPhoneNonUniqueSafe(db, logger = console) {
    const tableInfo = await dbGet(
        db,
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customers'`
    );
    const currentSql = String((tableInfo && tableInfo.sql) || '');
    if (!/phone\s+TEXT\s+UNIQUE\s+NOT\s+NULL/i.test(currentSql)) {
        return { migrated: false };
    }

    const migratedSql = currentSql.replace(
        /phone\s+TEXT\s+UNIQUE\s+NOT\s+NULL/i,
        'phone TEXT NOT NULL'
    );
    if (migratedSql === currentSql) return { migrated: false };

    const tempName = 'customers_phone_nonunique_new';
    const newTableSql = rewriteCreateTableName(migratedSql, 'customers', tempName);

    const log = typeof logger.warn === 'function' ? logger.warn.bind(logger) : logger.log.bind(logger);
    log('[IMPORT] Migrasi customers.phone UNIQUE -> non-UNIQUE (safe strategy)');

    const indexes = await dbAll(
        db,
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'customers' AND sql IS NOT NULL`
    );
    const triggers = await dbAll(
        db,
        `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'customers' AND sql IS NOT NULL`
    );
    const seqRow = await dbGet(db, `SELECT seq FROM sqlite_sequence WHERE name = 'customers'`);

    await dbRun(db, 'BEGIN IMMEDIATE');
    try {
        await dbRun(db, 'PRAGMA foreign_keys = OFF');
        await dbRun(db, newTableSql);

        const cols = await dbAll(db, 'PRAGMA table_info(customers)');
        const colList = cols.map((c) => `"${c.name}"`).join(', ');
        await dbRun(db, `INSERT INTO ${tempName} (${colList}) SELECT ${colList} FROM customers`);

        await dbRun(db, 'DROP TABLE customers');
        await dbRun(db, `ALTER TABLE ${tempName} RENAME TO customers`);

        if (seqRow && seqRow.seq != null) {
            await dbRun(db, `DELETE FROM sqlite_sequence WHERE name = 'customers'`);
            await dbRun(db, `INSERT INTO sqlite_sequence(name, seq) VALUES ('customers', ?)`, [seqRow.seq]);
        }

        for (const idx of indexes) {
            if (idx.sql) await dbRun(db, idx.sql);
        }
        for (const trg of triggers) {
            if (trg.sql) await dbRun(db, trg.sql);
        }

        await dbRun(db, 'PRAGMA foreign_keys = ON');
        await dbRun(db, 'COMMIT');
        return { migrated: true };
    } catch (err) {
        try { await dbRun(db, 'ROLLBACK'); } catch (_) {}
        try { await dbRun(db, 'PRAGMA foreign_keys = ON'); } catch (_) {}
        throw err;
    }
}

module.exports = {
    BACKUP_TABLE,
    repairCustomersBackupPhoneUniqueFk,
    migrateCustomersPhoneNonUniqueSafe
};
