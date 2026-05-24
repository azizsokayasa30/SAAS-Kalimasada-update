/**
 * Sinkronkan tabel RADIUS penting dari SQLite (billing) ke MySQL (FreeRADIUS).
 * Dipanggil setelah tulis user PPPoE agar auth di router tetap cocok dengan aplikasi.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const logger = require('./logger');

const execFileAsync = promisify(execFile);

const MYSQL_PW = process.env.RADIUS_MYSQL_PASSWORD || 'oynFhZz8yD9zZ9jQF3CIdwi1d';
const MYSQL_USER = process.env.RADIUS_MYSQL_USER || 'radius';
const MYSQL_DB = process.env.RADIUS_MYSQL_DATABASE || 'radius';

let _lastSync = 0;
const MIN_SYNC_INTERVAL_MS = 2000;

function runMysql(sql) {
    return execFileAsync(
        'mysql',
        ['-u', MYSQL_USER, `-p${MYSQL_PW}`, MYSQL_DB, '-e', sql],
        { maxBuffer: 32 * 1024 * 1024 }
    );
}

async function syncRadiusSqliteToMysql({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - _lastSync < MIN_SYNC_INTERVAL_MS) {
        return { skipped: true };
    }

    const { resolveRadiusSqliteDbPath } = require('./radiusSQLite');
    const { dbPath } = await resolveRadiusSqliteDbPath();
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "''");

    const tables = [
        { name: 'radcheck', cols: 'username,attribute,op,value' },
        { name: 'radusergroup', cols: 'username,groupname,priority' },
        { name: 'radgroupcheck', cols: 'groupname,attribute,op,value' },
        { name: 'radgroupreply', cols: 'groupname,attribute,op,value' },
        { name: 'nas', cols: 'nasname,shortname,type,ports,secret,server,community,description' }
    ];

    try {
        await runMysql('SET FOREIGN_KEY_CHECKS=0;');
        for (const { name, cols } of tables) {
            const colList = cols.split(',');
            const out = await execFileAsync(
                'sqlite3',
                ['-separator', '|', dbPath, `SELECT ${cols} FROM ${name};`],
                { maxBuffer: 64 * 1024 * 1024 }
            );
            const lines = out.stdout.split('\n').filter((l) => l.length > 0);
            await runMysql(`DELETE FROM ${name};`);
            if (lines.length === 0) continue;

            const values = [];
            for (const line of lines) {
                const parts = line.split('|');
                const vals = colList.map((_, i) => {
                    const v = parts[i];
                    if (v === undefined || v === '') return 'NULL';
                    return `'${esc(v)}'`;
                });
                values.push(`(${vals.join(',')})`);
            }
            for (let i = 0; i < values.length; i += 150) {
                const chunk = values.slice(i, i + 150);
                await runMysql(
                    `INSERT INTO ${name} (${cols}) VALUES ${chunk.join(',')};`
                );
            }
        }
        await runMysql('SET FOREIGN_KEY_CHECKS=1;');
        _lastSync = now;
        return { ok: true };
    } catch (err) {
        logger.warn(`[RADIUS-MYSQL-SYNC] Gagal: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

module.exports = { syncRadiusSqliteToMysql };
