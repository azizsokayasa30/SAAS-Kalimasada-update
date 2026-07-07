'use strict';

const { getTenantId, hasTenantContext } = require('./tenantContext');

/**
 * Prefix kunci cache dengan tenant aktif agar tidak bocor antar tenant.
 * @param {string} base
 * @param {number|string|null} [tenantId]
 */
function tenantCacheKey(base, tenantId = null) {
    const tid =
        tenantId != null
            ? tenantId
            : hasTenantContext()
              ? getTenantId()
              : 'global';
    return `t:${tid}:${base}`;
}

/** tenant_id dari request HTTP (host/query middleware), bukan sesi cookie. */
function resolveRequestTenantId(req) {
    if (!req) return null;
    const id = req.tenantId ?? req.tenant?.id ?? null;
    return id != null ? Number(id) : null;
}

module.exports = { tenantCacheKey, resolveRequestTenantId };
