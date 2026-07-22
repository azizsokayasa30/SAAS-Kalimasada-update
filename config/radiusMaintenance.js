/**
 * Pemeliharaan SQLite RADIUS terjadwal (radpostauth membesar → SQLITE_BUSY / timeout Mikrotik).
 */
const { spawn } = require('child_process');
const path = require('path');
const logger = require('./logger');
const { getSetting } = require('./settingsManager');

let timer = null;
let running = false;

function msUntilNextLocalHour(targetHour = 3) {
    const now = new Date();
    const next = new Date(now);
    next.setHours(targetHour, 15, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
}

function runMaintenanceJob() {
    if (running) return;
    const mode = String(getSetting('user_auth_mode', 'radius') || '').toLowerCase();
    if (mode !== 'radius') return;

    running = true;
    const script = path.join(__dirname, '..', 'scripts', 'fix-radius-sqlite-contention.js');
    const child = spawn(process.execPath, [script, '--yes', '--keep-postauth-days', '3'], {
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
        running = false;
        if (code === 0) {
            logger.info('[RADIUS-MAINT] Pemeliharaan SQLite selesai');
        } else {
            logger.warn(`[RADIUS-MAINT] Pemeliharaan gagal (exit ${code}): ${out.slice(-500)}`);
        }
    });

    try {
        const { closeStaleSqliteRadacctOpenSessions } = require('./radiusMysqlAccounting');
        closeStaleSqliteRadacctOpenSessions().catch((e) => {
            logger.warn(`[RADIUS-MAINT] Tutup sesi SQLite radacct: ${e.message}`);
        });
    } catch (_) {}
}

function startRadiusMaintenanceSchedule() {
    if (timer) return;
    const delay = msUntilNextLocalHour(3);
    logger.info(`[RADIUS-MAINT] Jadwal harian pembersihan radpostauth (mulai ~03:15, pertama dalam ${Math.round(delay / 60000)} menit)`);
    setTimeout(() => {
        runMaintenanceJob();
        timer = setInterval(runMaintenanceJob, 24 * 60 * 60 * 1000);
    }, delay);
}

module.exports = { startRadiusMaintenanceSchedule, runMaintenanceJob };
