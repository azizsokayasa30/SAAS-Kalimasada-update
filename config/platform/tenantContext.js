'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

const DEFAULT_TENANT_ID = 1;

/**
 * Run callback within tenant async context (used by HTTP middleware).
 */
function runWithTenant(tenant, callback) {
    return storage.run({ tenant }, callback);
}

function getStore() {
    return storage.getStore();
}

function getTenant() {
    return getStore()?.tenant || null;
}

function getTenantId() {
    const tenant = getTenant();
    return tenant?.id ?? DEFAULT_TENANT_ID;
}

function hasTenantContext() {
    return getTenant() !== null;
}

function isCentralHost() {
    return getStore()?.isCentral === true;
}

function runAsCentral(callback) {
    return storage.run({ isCentral: true, tenant: null }, callback);
}

module.exports = {
    runWithTenant,
    runAsCentral,
    getTenant,
    getTenantId,
    hasTenantContext,
    isCentralHost,
    DEFAULT_TENANT_ID,
};
