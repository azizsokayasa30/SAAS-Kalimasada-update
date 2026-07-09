'use strict';

const tenantStore = require('./tenantStore');
const { applyDefaults } = require('../paymentGatewayConfig');
const { ensureAppSettingsTable } = require('../radiusConfig');

const PLATFORM_KEY = 'payment_gateway';
const APP_SETTINGS_KEY = 'payment_gateway';

async function isPlatformPaymentConfigured() {
    const row = await tenantStore.dbGet(
        'SELECT 1 FROM platform_settings WHERE key = ? LIMIT 1',
        [PLATFORM_KEY]
    );
    return !!row;
}

async function readAppSettingsPaymentGateway() {
    await ensureAppSettingsTable();
    const row = await tenantStore.dbGet(
        'SELECT value FROM app_settings WHERE key = ? LIMIT 1',
        [APP_SETTINGS_KEY]
    );
    if (!row?.value) return null;
    try {
        return applyDefaults(JSON.parse(row.value));
    } catch (_) {
        return null;
    }
}

async function writeAppSettingsPaymentGateway(config) {
    await ensureAppSettingsTable();
    const normalized = applyDefaults(config);
    await tenantStore.dbRun(
        `INSERT OR REPLACE INTO app_settings (key, value, updated_at)
         VALUES (?, ?, datetime('now','localtime'))`,
        [APP_SETTINGS_KEY, JSON.stringify(normalized)]
    );
    return normalized;
}

/** Salin config lama app_settings → platform_settings jika platform belum punya data. */
async function migrateLegacyPaymentToPlatform() {
    if (await isPlatformPaymentConfigured()) return false;
    const legacy = await readAppSettingsPaymentGateway();
    if (!legacy) return false;

    await tenantStore.dbRun(
        `INSERT INTO platform_settings (key, value, updated_at)
         VALUES (?, ?, datetime('now','localtime'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [PLATFORM_KEY, JSON.stringify(legacy)]
    );
    return true;
}

/** Terapkan config platform ke app_settings agar runtime payment gateway ikut ter-update. */
async function syncPlatformToAppSettings(config) {
    return writeAppSettingsPaymentGateway(config);
}

async function reloadRuntimePaymentGateway() {
    try {
        const billing = require('../billing');
        if (billing && typeof billing.reloadPaymentGateway === 'function') {
            return billing.reloadPaymentGateway();
        }
    } catch (err) {
        console.warn('[paymentGatewaySync] reload warn:', err.message);
    }
    return null;
}

module.exports = {
    isPlatformPaymentConfigured,
    migrateLegacyPaymentToPlatform,
    syncPlatformToAppSettings,
    writeAppSettingsPaymentGateway,
    readAppSettingsPaymentGateway,
    reloadRuntimePaymentGateway,
};
