/**
 * Data demo bawaan migrasi/script lama yang sering muncul kembali setelah dihapus
 * (INSERT OR IGNORE di migration, restore backup lama, atau npm run setup).
 */
const path = require('path');

const DEMO_COLLECTOR_PHONES = ['081234567890', '081234567891', '081234567892'];

const DEMO_ODP_NAMES = [
    'ODP-Central-01',
    'ODP-Branch-01',
    'ODP-Residential-01',
    'ODP-Industrial-01',
    'ODP-Commercial-01'
];

const DEMO_SEGMENT_NAMES = [
    'Backbone-Central-Branch',
    'Distribution-Branch-Residential',
    'Backbone-Central-Industrial',
    'Distribution-Industrial-Commercial'
];

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve({ changes: this.changes });
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

/**
 * Hapus kolektor & ODP demo dari database.
 * @param {import('sqlite3').Database} db
 * @param {{ dryRun?: boolean }} options
 */
async function purgeDemoSeedData(db, options = {}) {
    const dryRun = Boolean(options.dryRun);
    const result = {
        collectors: [],
        odps: [],
        collectorsRemoved: 0,
        odpsRemoved: 0
    };

    await run(db, 'PRAGMA foreign_keys = ON');

    const demoCollectors = await all(
        db,
        `SELECT id, name, phone FROM collectors
         WHERE phone IN (${DEMO_COLLECTOR_PHONES.map(() => '?').join(',')})
            OR (email IS NOT NULL AND email LIKE '%@example.com')`,
        DEMO_COLLECTOR_PHONES
    );
    result.collectors = demoCollectors;

    const demoOdps = await all(
        db,
        `SELECT id, name, code FROM odps WHERE name IN (${DEMO_ODP_NAMES.map(() => '?').join(',')})`,
        DEMO_ODP_NAMES
    );
    result.odps = demoOdps;

    if (dryRun) {
        return result;
    }

    if (demoCollectors.length) {
        const collectorIds = demoCollectors.map((c) => c.id);
        const ph = collectorIds.map(() => '?').join(',');
        await run(db, `DELETE FROM collector_payments WHERE collector_id IN (${ph})`, collectorIds);
        await run(db, `DELETE FROM collector_assignments WHERE collector_id IN (${ph})`, collectorIds);
        await run(db, `DELETE FROM collector_areas WHERE collector_id IN (${ph})`, collectorIds);
        try {
            await run(db, `DELETE FROM collector_remittance_receipts WHERE collector_id IN (${ph})`, collectorIds);
        } catch (_) {
            /* tabel belum ada di backup lama */
        }
        const del = await run(db, `DELETE FROM collectors WHERE id IN (${ph})`, collectorIds);
        result.collectorsRemoved = del.changes;
    }

    if (demoOdps.length) {
        const ids = demoOdps.map((o) => o.id);
        const ph = ids.map(() => '?').join(',');
        await run(db, `DELETE FROM odp_connections WHERE from_odp_id IN (${ph}) OR to_odp_id IN (${ph})`, [...ids, ...ids]);
        await run(
            db,
            `DELETE FROM network_segments WHERE name IN (${DEMO_SEGMENT_NAMES.map(() => '?').join(',')})`,
            DEMO_SEGMENT_NAMES
        );
        await run(
            db,
            `DELETE FROM network_segments WHERE start_odp_id IN (${ph}) OR end_odp_id IN (${ph})`,
            [...ids, ...ids]
        );
        const del = await run(db, `DELETE FROM odps WHERE id IN (${ph})`, ids);
        result.odpsRemoved = del.changes;
    }

    return result;
}

function getDemoSeedFlagPath(dbPath) {
    return path.join(path.dirname(dbPath), '.demo_seed_guard_enabled');
}

module.exports = {
    DEMO_COLLECTOR_PHONES,
    DEMO_ODP_NAMES,
    DEMO_SEGMENT_NAMES,
    purgeDemoSeedData,
    getDemoSeedFlagPath
};
