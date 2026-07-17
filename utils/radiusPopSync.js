/**
 * Trigger sync VPS → FreeRADIUS POP segera setelah data user RADIUS berubah.
 * Debounce agar burst edit (bulk restore, dll) tidak spam SSH.
 */
const { spawn } = require('child_process');
const path = require('path');
const logger = require('../config/logger');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'radius-pop-sync-publish.sh');
const DEBOUNCE_MS = Math.max(
    500,
    parseInt(process.env.RADIUS_POP_SYNC_DEBOUNCE_MS || '1500', 10) || 1500
);

let timer = null;
let running = false;
let queued = false;
let lastReason = '';

function isDisabled() {
    return String(process.env.RADIUS_POP_SYNC_DISABLE || '').trim() === '1';
}

function runPublish() {
    if (isDisabled()) return;
    if (running) {
        queued = true;
        return;
    }
    running = true;
    const reason = lastReason || 'radius-write';
    lastReason = '';
    const started = Date.now();
    const child = spawn('bash', [SCRIPT], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 800) stderr = stderr.slice(-800);
    });
    child.on('error', (err) => {
        running = false;
        logger.warn(`[RADIUS-POP-SYNC] gagal spawn publish (${reason}): ${err.message}`);
        if (queued) {
            queued = false;
            schedule('retry-after-error');
        }
    });
    child.on('close', (code) => {
        running = false;
        const ms = Date.now() - started;
        if (code === 0) {
            logger.info(`[RADIUS-POP-SYNC] publish selesai (${reason}) ${ms}ms`);
        } else {
            logger.warn(
                `[RADIUS-POP-SYNC] publish exit=${code} (${reason}) ${ms}ms${stderr ? `: ${stderr.trim()}` : ''}`
            );
        }
        if (queued) {
            queued = false;
            schedule('queued');
        }
    });
}

function schedule(reason) {
    if (isDisabled()) return;
    if (reason) lastReason = String(reason).slice(0, 80);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        timer = null;
        runPublish();
    }, DEBOUNCE_MS);
}

/**
 * Jadwalkan push+apply ke POP (non-blocking).
 * @param {string} [reason]
 */
function triggerRadiusPopSync(reason = 'radius-write') {
    if (isDisabled()) return;
    schedule(reason);
}

module.exports = {
    triggerRadiusPopSync
};
