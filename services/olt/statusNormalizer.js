const STATUS_MAP = {
    online: 'ONLINE',
    up: 'ONLINE',
    active: 'ONLINE',
    working: 'ONLINE',
    offline: 'OFFLINE',
    down: 'OFFLINE',
    inactive: 'OFFLINE',
    los: 'LOS',
    loss: 'LOS',
    poweroff: 'POWER_OFF',
    power_off: 'POWER_OFF',
    'power-off': 'POWER_OFF',
    dyinggasp: 'DYING_GASP',
    dying_gasp: 'DYING_GASP',
    disabled: 'DISABLED',
    disable: 'DISABLED',
    authfailed: 'AUTH_FAILED',
    auth_failed: 'AUTH_FAILED',
    unauthorized: 'AUTH_FAILED'
};

const VALID_STATUSES = new Set([
    'ONLINE',
    'OFFLINE',
    'LOS',
    'POWER_OFF',
    'DYING_GASP',
    'DISABLED',
    'AUTH_FAILED',
    'UNKNOWN'
]);

function normalizeStatus(value) {
    if (!value) return 'UNKNOWN';
    const raw = String(value).trim().toUpperCase();
    if (VALID_STATUSES.has(raw)) return raw;
    const key = raw.toLowerCase().replace(/[\s-]/g, '_');
    return STATUS_MAP[key] || STATUS_MAP[key.replace(/_/g, '')] || 'UNKNOWN';
}

function parseNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(String(value).replace(/[^\d.-]/g, ''));
    return Number.isFinite(number) ? number : null;
}

function getSignalQuality(rxPower) {
    const rx = parseNumber(rxPower);
    if (rx === null) return 'unknown';
    if (rx > -24) return 'green';
    if (rx >= -27) return 'yellow';
    return 'red';
}

module.exports = {
    normalizeStatus,
    parseNumber,
    getSignalQuality,
    VALID_STATUSES
};
