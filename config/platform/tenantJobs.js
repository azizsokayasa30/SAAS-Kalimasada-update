'use strict';

/**
 * Helper job lintas-tenant: jalankan callback dalam runWithTenant per tenant operasional.
 * Pastikan setting tenant ter-merge (defaults) agar getTenantSetting akurat.
 */
const logger = require('../logger');
const tenantStore = require('./tenantStore');
const { runWithTenant } = require('./tenantContext');
const { mergeSettings, loadMinimalTenantDefaults } = require('./tenantSettingsManager');

function enrichTenantForJob(tenant) {
    if (!tenant) return tenant;
    return {
        ...tenant,
        settings: mergeSettings(loadMinimalTenantDefaults(), tenant.settings || {})
    };
}

/**
 * @param {(tenant: object) => Promise<any>|any} jobFn
 * @param {{ skipInactive?: boolean, label?: string }} [options]
 */
async function forEachOperationalTenant(jobFn, options = {}) {
    const skipInactive = options.skipInactive !== false;
    const label = options.label || 'tenant-job';
    const tenants = await tenantStore.listTenants({ operationalOnly: true });
    const results = [];

    for (const raw of tenants || []) {
        const tid = Number(raw.id);
        if (!Number.isFinite(tid)) continue;
        if (skipInactive && String(raw.status || '').toLowerCase() === 'inactive') {
            continue;
        }
        const tenant = enrichTenantForJob(raw);
        try {
            const value = await runWithTenant(tenant, () => jobFn(tenant));
            results.push({ tenant_id: tid, success: true, value });
        } catch (err) {
            logger.error(`[${label}] tenant #${tid} (${tenant.subdomain || tenant.name || '-'}): ${err.message}`);
            results.push({ tenant_id: tid, success: false, error: err.message });
        }
    }

    return results;
}

module.exports = {
    forEachOperationalTenant,
    enrichTenantForJob
};
