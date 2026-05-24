const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

/**
 * Satu koneksi tulis persisten + antrean operasi (hindari interleaved callback pada satu handle).
 * SELECT memakai koneksi read-only terpisah agar tidak memblokir tulis FreeRADIUS lebih lama.
 */
let _singletonConn = null;
let _singletonPath = null;

/** Serialize write/transaction ops (avoids interleaved callbacks on one sqlite3 handle). */
let _radiusOpQueue = Promise.resolve();

/** Separate read-only connection — SELECT queries bypass write queue (WAL allows concurrent reads). */
let _readOnlyConn = null;
let _readOnlyPath = null;
let _schemaInitialized = false;

/** Retry saat SQLITE_BUSY — cap rendah agar simpan user di UI tidak menunggu puluhan detik. */
const BUSY_MAX_ATTEMPTS = 3;
const BUSY_MAX_BACKOFF_MS = 200;

function enqueueRadiusOperation(fn) {
    const run = _radiusOpQueue.then(() => fn());
    _radiusOpQueue = run.catch(() => {});
    return run;
}

function isReadOnlySql(sql) {
    const u = String(sql || '').trim().toUpperCase();
    return u.startsWith('SELECT') || u.startsWith('PRAGMA') || u.startsWith('EXPLAIN');
}

const RADIUS_PERFORMANCE_PRAGMAS = [
    ['journal_mode', 'WAL'],
    // Billing: jangan tunggu 60s per statement (UI terasa hang). FreeRADIUS pakai busy_timeout sendiri di mods-enabled/sql.
    ['busy_timeout', '3000'],
    ['synchronous', 'NORMAL'],
    ['cache_size', '-64000'],
    ['mmap_size', '268435456'],
    ['temp_store', 'MEMORY'],
    ['wal_autocheckpoint', '1000']
];

function isSqliteBusyError(err) {
    if (!err) return false;
    const msg = String(err.message || '');
    return err.code === 'SQLITE_BUSY' || /database is locked/i.test(msg);
}

function delayMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Path file SQLite yang dipakai FreeRADIUS harus sama dengan yang dibaca aplikasi.
 * Prioritas: env RADIUS_SQLITE_PATH → path absolut → path relatif data/... dari akar proyek
 * → nama file saja di folder data/ (mis. radius → data/radius.db).
 */
async function resolveRadiusSqliteDbPath() {
    const { getRadiusConfig } = require('./radiusConfig');
    const config = await getRadiusConfig();
    const envPath = process.env.RADIUS_SQLITE_PATH && String(process.env.RADIUS_SQLITE_PATH).trim();
    if (envPath) {
        return {
            dbPath: path.resolve(envPath),
            source: 'environment:RADIUS_SQLITE_PATH'
        };
    }
    const raw = String(config.radius_database || 'radius').trim();
    if (!raw) {
        return {
            dbPath: path.join(__dirname, '..', 'data', 'radius.db'),
            source: 'default:data/radius.db'
        };
    }
    const rawSlash = raw.replace(/\\/g, '/');
    if (rawSlash.startsWith('data/')) {
        return {
            dbPath: path.normalize(path.join(__dirname, '..', raw)),
            source: `app_settings:${rawSlash}`
        };
    }
    if (path.isAbsolute(raw)) {
        const p = raw.endsWith('.db') ? raw : `${raw}.db`;
        return { dbPath: p, source: 'app_settings:absolute_path' };
    }
    const baseFile = raw.endsWith('.db') ? raw : `${raw}.db`;
    return {
        dbPath: path.join(__dirname, '..', 'data', baseFile),
        source: `app_settings:data/${baseFile}`
    };
}

class RADIUSDatabase {
    constructor(dbPath) {
        this.dbPath = dbPath;
        this.db = null;
        this._isSingleton = false;
        /** >0 while inside runInTransaction — skip outer queue to avoid deadlock. */
        this._txDepth = 0;
    }

    async connect() {
        if (this.db) return;

        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    logger.error(`[RADIUS-SQLITE] Error opening database: ${err.message}`);
                    reject(err);
                } else {
                    logger.info(`[RADIUS-SQLITE] Connected to database: ${this.dbPath}`);
                    this._applyPerformancePragmas(this.db)
                        .then(() => this.initSchema())
                        .then(resolve)
                        .catch(reject);
                }
            });
        });
    }

    _applyPerformancePragmas(db) {
        return RADIUS_PERFORMANCE_PRAGMAS.reduce(
            (chain, [key, value]) =>
                chain.then(
                    () =>
                        new Promise((resolve, reject) => {
                            db.run(`PRAGMA ${key}=${value}`, (err) => (err ? reject(err) : resolve()));
                        })
                ),
            Promise.resolve()
        );
    }

    async initSchema() {
        if (_schemaInitialized) {
            return;
        }
        const schema = [
            `CREATE TABLE IF NOT EXISTS radcheck (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL DEFAULT '',
                attribute TEXT NOT NULL DEFAULT '',
                op TEXT NOT NULL DEFAULT '==',
                value TEXT NOT NULL DEFAULT '',
                UNIQUE(username, attribute)
            )`,
            `CREATE INDEX IF NOT EXISTS idx_radcheck_username ON radcheck (username)`,
            `CREATE TABLE IF NOT EXISTS radreply (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL DEFAULT '',
                attribute TEXT NOT NULL DEFAULT '',
                op TEXT NOT NULL DEFAULT '=',
                value TEXT NOT NULL DEFAULT '',
                UNIQUE(username, attribute)
            )`,
            `CREATE INDEX IF NOT EXISTS idx_radreply_username ON radreply (username)`,
            `CREATE TABLE IF NOT EXISTS radgroupcheck (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                groupname TEXT NOT NULL DEFAULT '',
                attribute TEXT NOT NULL DEFAULT '',
                op TEXT NOT NULL DEFAULT '==',
                value TEXT NOT NULL DEFAULT '',
                UNIQUE(groupname, attribute)
            )`,
            `CREATE INDEX IF NOT EXISTS idx_radgroupcheck_groupname ON radgroupcheck (groupname)`,
            `CREATE TABLE IF NOT EXISTS radgroupreply (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                groupname TEXT NOT NULL DEFAULT '',
                attribute TEXT NOT NULL DEFAULT '',
                op TEXT NOT NULL DEFAULT '=',
                value TEXT NOT NULL DEFAULT '',
                UNIQUE(groupname, attribute)
            )`,
            `CREATE INDEX IF NOT EXISTS idx_radgroupreply_groupname ON radgroupreply (groupname)`,
            `CREATE TABLE IF NOT EXISTS radusergroup (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL DEFAULT '',
                groupname TEXT NOT NULL DEFAULT '',
                priority INTEGER NOT NULL DEFAULT 1,
                UNIQUE(username, groupname)
            )`,
            `CREATE INDEX IF NOT EXISTS idx_radusergroup_username ON radusergroup (username)`,
            `CREATE TABLE IF NOT EXISTS radacct (
                radacctid INTEGER PRIMARY KEY AUTOINCREMENT,
                acctsessionid TEXT NOT NULL DEFAULT '',
                acctuniqueid TEXT NOT NULL DEFAULT '',
                username TEXT NOT NULL DEFAULT '',
                groupname TEXT NOT NULL DEFAULT '',
                realm TEXT DEFAULT '',
                nasipaddress TEXT NOT NULL DEFAULT '',
                nasportid TEXT DEFAULT NULL,
                nasporttype TEXT DEFAULT NULL,
                acctstarttime DATETIME DEFAULT NULL,
                acctupdatetime DATETIME DEFAULT NULL,
                acctstoptime DATETIME DEFAULT NULL,
                acctinterval INTEGER DEFAULT NULL,
                acctsessiontime INTEGER DEFAULT NULL,
                acctauthentic TEXT DEFAULT NULL,
                connectinfo_start TEXT DEFAULT NULL,
                connectinfo_stop TEXT DEFAULT NULL,
                acctinputoctets INTEGER DEFAULT NULL,
                acctoutputoctets INTEGER DEFAULT NULL,
                calledstationid TEXT NOT NULL DEFAULT '',
                callingstationid TEXT NOT NULL DEFAULT '',
                acctterminatecause TEXT NOT NULL DEFAULT '',
                servicetype TEXT DEFAULT NULL,
                framedprotocol TEXT DEFAULT NULL,
                framedipaddress TEXT NOT NULL DEFAULT '',
                framedipv6address TEXT NOT NULL DEFAULT '',
                framedipv6prefix TEXT NOT NULL DEFAULT '',
                framedinterfaceid TEXT NOT NULL DEFAULT '',
                delegatedipv6prefix TEXT NOT NULL DEFAULT ''
            )`,
            `CREATE INDEX IF NOT EXISTS idx_radacct_active ON radacct (acctstoptime, username, acctstarttime)`,
            `CREATE INDEX IF NOT EXISTS idx_radacct_stoptime ON radacct (acctstoptime)`,
            `CREATE INDEX IF NOT EXISTS idx_radacct_username_stoptime ON radacct (username, acctstoptime)`,
            `CREATE INDEX IF NOT EXISTS idx_radcheck_username_attr ON radcheck (username, attribute)`,
            `CREATE INDEX IF NOT EXISTS idx_radacct_sessionid ON radacct (acctsessionid)`,
            `CREATE TABLE IF NOT EXISTS radpostauth (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL DEFAULT '',
                pass TEXT NOT NULL DEFAULT '',
                reply TEXT NOT NULL DEFAULT '',
                authdate DATETIME DEFAULT (datetime('now','localtime'))
            )`,
            `CREATE TABLE IF NOT EXISTS nas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nasname TEXT NOT NULL,
                shortname TEXT,
                type TEXT DEFAULT 'other',
                ports INTEGER,
                secret TEXT NOT NULL,
                server TEXT,
                community TEXT,
                description TEXT DEFAULT 'RADIUS Client',
                UNIQUE(nasname)
            )`
        ];

        const cleanSchema = schema.map(s => s.replace(/\(\d+\)/g, ''));

        for (const statement of cleanSchema) {
            await new Promise((resolve, reject) => {
                this.db.run(statement, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }
        _schemaInitialized = true;
        logger.info('[RADIUS-SQLITE] Schema initialized');
    }

    _normalizeSql(sql) {
        let sqliteSQL = sql
            .replace(/ON DUPLICATE KEY UPDATE/gi, 'ON CONFLICT DO UPDATE SET')
            .replace(/NOW\(\)/gi, "datetime('now', 'localtime')")
            .replace(/TIMESTAMPDIFF\(SECOND, ([^,]+), ([^)]+)\)/gi, "(strftime('%s', $2) - strftime('%s', $1))");

        if (sqliteSQL.includes('radcheck') && sqliteSQL.includes('ON CONFLICT')) {
            sqliteSQL = sqliteSQL.replace(/INSERT INTO radcheck \((.*?)\) VALUES \((.*?)\) ON CONFLICT DO UPDATE SET (.*)/i,
                (match, cols, vals, update) => {
                    return `INSERT INTO radcheck (${cols}) VALUES (${vals}) ON CONFLICT(username, attribute) DO UPDATE SET ${update}`;
                }
            );
        }
        return sqliteSQL;
    }

    _executeOnce(sql, params = []) {
        const sqliteSQL = this._normalizeSql(sql);

        return new Promise((resolve, reject) => {
            if (!this.db) {
                reject(new Error('RADIUS SQLite write connection is not open'));
                return;
            }
            const sqlUpper = sqliteSQL.trim().toUpperCase();
            if (sqlUpper.startsWith('SELECT') || sqlUpper.startsWith('PRAGMA') || sqlUpper.startsWith('EXPLAIN')) {
                this.db.all(sqliteSQL, params, (err, rows) => {
                    if (err) {
                        logger.error(`[RADIUS-SQLITE] Query Error: ${err.message}\nSQL: ${sqliteSQL}`);
                        reject(err);
                    } else {
                        resolve([rows, []]);
                    }
                });
            } else {
                this.db.run(sqliteSQL, params, function(err) {
                    if (err) {
                        logger.error(`[RADIUS-SQLITE] Exec Error: ${err.message}\nSQL: ${sqliteSQL}`);
                        reject(err);
                    } else {
                        resolve([{
                            affectedRows: this.changes,
                            insertId: this.lastID
                        }, []]);
                    }
                });
            }
        });
    }

    async _executeWithRetry(sql, params = [], maxAttempts = BUSY_MAX_ATTEMPTS) {
        if (!isReadOnlySql(sql) && !this.db) {
            await this.connect();
        }
        let lastErr;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                return await this._executeOnce(sql, params);
            } catch (err) {
                lastErr = err;
                if (!isSqliteBusyError(err) || attempt >= maxAttempts - 1) {
                    throw err;
                }
                const backoff =
                    Math.min(BUSY_MAX_BACKOFF_MS, 25 * Math.pow(2, attempt)) +
                    Math.floor(Math.random() * 25);
                logger.warn(`[RADIUS-SQLITE] SQLITE_BUSY, retry ${attempt + 1}/${maxAttempts - 1} in ${backoff}ms`);
                await delayMs(backoff);
            }
        }
        throw lastErr;
    }

    async execute(sql, params = []) {
        if (isReadOnlySql(sql)) {
            const dbPath = this.dbPath || _singletonPath;
            if (!dbPath) {
                const resolved = await resolveRadiusSqliteDbPath();
                this.dbPath = resolved.dbPath;
            }
            const readConn = await getRadiusReadConnection(this.dbPath);
            return readConn._executeWithRetry(sql, params);
        }

        if (!this.db) await this.connect();

        const run = () => this._executeWithRetry(sql, params);
        if (this._txDepth > 0) {
            return run();
        }
        return enqueueRadiusOperation(run);
    }

    /**
     * Run multiple writes atomically with BEGIN IMMEDIATE (reduces SQLITE_BUSY vs separate statements).
     */
    async runInTransaction(fn) {
        const runTx = async () => {
            if (!this.db) await this.connect();
            const maxAttempts = BUSY_MAX_ATTEMPTS;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                this._txDepth++;
                let began = false;
                try {
                    await this._executeOnce('BEGIN IMMEDIATE', []);
                    began = true;
                    try {
                        const result = await fn(this);
                        await this._executeOnce('COMMIT', []);
                        return result;
                    } catch (innerErr) {
                        if (began) {
                            try {
                                await this._executeOnce('ROLLBACK', []);
                            } catch (_) {}
                        }
                        throw innerErr;
                    }
                } catch (err) {
                    if (began) {
                        try {
                            await this._executeOnce('ROLLBACK', []);
                        } catch (_) {}
                    }
                    if (isSqliteBusyError(err) && attempt < maxAttempts - 1) {
                        const backoff =
                            Math.min(BUSY_MAX_BACKOFF_MS, 25 * Math.pow(2, attempt)) +
                            Math.floor(Math.random() * 25);
                        logger.warn(`[RADIUS-SQLITE] transaction busy, retry ${attempt + 1} in ${backoff}ms`);
                        await delayMs(backoff);
                        continue;
                    }
                    throw err;
                } finally {
                    this._txDepth--;
                }
            }
            throw new Error('RADIUS transaction failed after retries');
        };

        return enqueueRadiusOperation(runTx);
    }

    async query(sql, params = []) {
        return this.execute(sql, params);
    }

    /**
     * end() is a NO-OP for singleton connections.
     * The connection stays open permanently to avoid repeated open/close
     * that caused SQLite SQLITE_BUSY errors and log spam.
     */
    async end() {
        if (this._isSingleton) {
            return; // Do NOT close - singleton is reused across all requests
        }
        if (this.db) {
            return new Promise((resolve, reject) => {
                this.db.close((err) => {
                    this.db = null;
                    if (err) reject(err);
                    else resolve();
                });
            });
        }
    }
}

/**
 * Read-only singleton for SELECT/PRAGMA — does not block on write queue.
 */
async function getRadiusReadConnection(dbPath) {
    if (_readOnlyConn && _readOnlyPath === dbPath && _readOnlyConn.db) {
        return _readOnlyConn;
    }
    if (_readOnlyConn && _readOnlyConn.db && _readOnlyPath !== dbPath) {
        try {
            _readOnlyConn._isSingleton = false;
            await _readOnlyConn.end();
        } catch (_) {}
        _readOnlyConn = null;
    }

    const conn = new RADIUSDatabase(dbPath);
    conn._isSingleton = true;
    await new Promise((resolve, reject) => {
        conn.db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
            if (err) {
                logger.error(`[RADIUS-SQLITE] Read-only open failed: ${err.message}`);
                reject(err);
            } else {
                conn._applyPerformancePragmas(conn.db).then(resolve).catch(reject);
            }
        });
    });

    _readOnlyConn = conn;
    _readOnlyPath = dbPath;
    return conn;
}

/**
 * Online backup via SQLite backup API — safe while FreeRADIUS is running (no file copy lock).
 */
async function backupRadiusDatabaseToPath(targetPath) {
    const conn = await getRadiusConnection();
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return enqueueRadiusOperation(
        () =>
            new Promise((resolve, reject) => {
                conn.db.backup(targetPath, (err) => {
                    if (err) {
                        logger.error(`[RADIUS-SQLITE] Online backup failed: ${err.message}`);
                        reject(err);
                    } else {
                        logger.info(`[RADIUS-SQLITE] Online backup completed: ${targetPath}`);
                        resolve(targetPath);
                    }
                });
            })
    );
}

/**
 * Returns the singleton RADIUS connection.
 * Creates once, reuses forever to prevent SQLite locking deadlocks.
 */
async function getRadiusConnection() {
    const { dbPath, source } = await resolveRadiusSqliteDbPath();

    // Reuse singleton if path matches and connection is still alive
    if (_singletonConn && _singletonPath === dbPath && _singletonConn.db) {
        return _singletonConn;
    }

    // Path changed - close old connection before creating new one
    if (_singletonConn && _singletonConn.db && _singletonPath !== dbPath) {
        try {
            _singletonConn._isSingleton = false;
            await _singletonConn.end();
        } catch (_) {}
        _singletonConn = null;
    }

    const conn = new RADIUSDatabase(dbPath);
    conn._isSingleton = true;
    await conn.connect();

    const [tables] = await conn.execute("SELECT name FROM sqlite_master WHERE type='table'");
    const existingTables = Array.isArray(tables) ? tables.map((t) => t.name) : [];
    const requiredTables = ['radcheck'];
    const missingRequired = requiredTables.filter((t) => !existingTables.includes(t));
    if (missingRequired.length > 0) {
        logger.error(`[RADIUS-SQLITE] Missing required tables: ${missingRequired.join(', ')}`);
        throw new Error(`RADIUS database unusable. Missing: ${missingRequired.join(', ')}`);
    }
    const optionalTables = ['radreply', 'radgroupcheck', 'radgroupreply', 'radusergroup', 'radacct', 'nas'];
    const missingOptional = optionalTables.filter((t) => !existingTables.includes(t));
    if (missingOptional.length > 0) {
        logger.warn(`[RADIUS-SQLITE] ${dbPath} — tabel opsional tidak ada (fitur terbatas): ${missingOptional.join(', ')}`);
    }
    logger.info(
        `[RADIUS-SQLITE] Using ${dbPath} [${source}] (${existingTables.length} tables, radcheck OK)`
    );

    _singletonConn = conn;
    _singletonPath = dbPath;
    return conn;
}

/** Untuk halaman tes / diagnosa: path ter-resolve + ringkasan isi radcheck (tanpa membuka billing). */
async function getRadiusSqliteFileDiagnostics() {
    const resolved = await resolveRadiusSqliteDbPath();
    const out = {
        ...resolved,
        fileExists: fs.existsSync(resolved.dbPath),
        fileSizeBytes: null,
        radcheckRowCount: null,
        radcheckPasswordUserCount: null,
        error: null
    };
    try {
        if (out.fileExists) {
            out.fileSizeBytes = fs.statSync(resolved.dbPath).size;
        }
        const conn = await getRadiusConnection();
        const [r1] = await conn.execute('SELECT COUNT(*) as n FROM radcheck');
        out.radcheckRowCount = Array.isArray(r1) && r1[0] != null ? r1[0].n : null;
        const [r2] = await conn.execute(`
            SELECT COUNT(DISTINCT username) as n FROM radcheck
            WHERE LOWER(TRIM(attribute)) IN (
                'cleartext-password','user-password','crypt-password','md5-password',
                'sha-password','smd5-password','mikrotik-password'
            )
        `);
        out.radcheckPasswordUserCount = Array.isArray(r2) && r2[0] != null ? r2[0].n : null;
        await conn.end();
    } catch (e) {
        out.error = e.message;
    }
    return out;
}

module.exports = {
    getRadiusConnection,
    getRadiusReadConnection,
    backupRadiusDatabaseToPath,
    resolveRadiusSqliteDbPath,
    getRadiusSqliteFileDiagnostics
};
