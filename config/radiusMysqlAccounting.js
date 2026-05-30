/**
 * Baca sesi accounting aktif dari MySQL FreeRADIUS (radacct).
 * Setelah migrasi FR ke MySQL, SQLite radacct tidak lagi di-update.
 */
const mysql = require('mysql2/promise');
const logger = require('./logger');

const MYSQL_PW = process.env.RADIUS_MYSQL_PASSWORD || 'oynFhZz8yD9zZ9jQF3CIdwi1d';
const MYSQL_USER = process.env.RADIUS_MYSQL_USER || 'radius';
const MYSQL_DB = process.env.RADIUS_MYSQL_DATABASE || 'radius';
const MYSQL_HOST = process.env.RADIUS_MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = parseInt(process.env.RADIUS_MYSQL_PORT || '3306', 10);

let _pool = null;
let _mysqlAvailable = null;
let _mysqlCheckedAt = 0;
const MYSQL_CHECK_TTL_MS = 60 * 1000;

function isRadiusAccountingOnMysql() {
    const env = String(process.env.RADIUS_ACCOUNTING_MYSQL || 'auto').toLowerCase();
    if (env === '0' || env === 'false' || env === 'sqlite') return false;
    if (env === '1' || env === 'true' || env === 'mysql') return true;
    return _mysqlAvailable !== false;
}

function getPool() {
    if (!_pool) {
        _pool = mysql.createPool({
            host: MYSQL_HOST,
            port: MYSQL_PORT,
            user: MYSQL_USER,
            password: MYSQL_PW,
            database: MYSQL_DB,
            waitForConnections: true,
            connectionLimit: 4,
            connectTimeout: 5000
        });
    }
    return _pool;
}

async function probeMysqlAccounting() {
    const now = Date.now();
    if (_mysqlAvailable != null && now - _mysqlCheckedAt < MYSQL_CHECK_TTL_MS) {
        return _mysqlAvailable;
    }
    try {
        await getPool().query('SELECT 1');
        _mysqlAvailable = true;
    } catch (e) {
        _mysqlAvailable = false;
        logger.debug(`[RADIUS-MYSQL-ACCT] MySQL tidak tersedia: ${e.message}`);
    }
    _mysqlCheckedAt = now;
    return _mysqlAvailable;
}

const OPEN_ACCT_SQL = `(acctstoptime IS NULL OR acctstoptime = '' OR acctstoptime = '0' OR acctstoptime = '0000-00-00 00:00:00')`;

async function getActiveSessionsFromMysqlRadacct(excludeUsernames = []) {
    if (!(await probeMysqlAccounting())) return [];
    const pool = getPool();
    let sql = `
        SELECT username, acctsessionid, acctstarttime, framedipaddress,
               acctinputoctets, acctoutputoctets, nasipaddress,
               TIMESTAMPDIFF(SECOND, acctstarttime, NOW()) AS session_time
        FROM radacct
        WHERE ${OPEN_ACCT_SQL}
    `;
    const params = [];
    if (excludeUsernames.length > 0) {
        sql += ` AND username NOT IN (${excludeUsernames.map(() => '?').join(',')})`;
        params.push(...excludeUsernames);
    }
    sql += ' ORDER BY acctstarttime DESC';
    const [rows] = await pool.query(sql, params);
    return Array.isArray(rows) ? rows : [];
}

async function closeStaleSqliteRadacctOpenSessions() {
    const { getRadiusConnection } = require('./radiusSQLite');
    let conn;
    try {
        conn = await getRadiusConnection();
        const [result] = await conn.execute(
            `UPDATE radacct SET acctstoptime = datetime('now','localtime')
             WHERE acctstoptime IS NULL OR acctstoptime = '' OR acctstoptime = '0' OR acctstoptime = '0000-00-00 00:00:00'`
        );
        const closed = result?.changes ?? result?.affectedRows ?? 0;
        if (closed > 0) {
            logger.info(`[RADIUS-ACCT] Menutup ${closed} sesi terbuka yatim di SQLite radacct`);
        }
        return closed;
    } catch (e) {
        logger.warn(`[RADIUS-ACCT] Gagal tutup sesi SQLite radacct: ${e.message}`);
        return 0;
    } finally {
        if (conn) {
            try {
                await conn.end();
            } catch (_) {}
        }
    }
}

module.exports = {
    isRadiusAccountingOnMysql,
    probeMysqlAccounting,
    getActiveSessionsFromMysqlRadacct,
    closeStaleSqliteRadacctOpenSessions
};
