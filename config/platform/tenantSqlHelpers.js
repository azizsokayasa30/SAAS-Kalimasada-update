'use strict';

const billingManager = require('../billing');
const { getTenantId, hasTenantContext } = require('./tenantContext');

/**
 * Potongan SQL ` AND {alias}.tenant_id = N` (literal integer aman).
 * Panggil SINKRON di handler HTTP sebelum callback sqlite.
 */
function tAnd(alias = '') {
    const t = billingManager._tenantWhere(alias);
    if (!t.sql) return '';
    const col = alias ? `${alias}.tenant_id` : 'tenant_id';
    return ` AND ${col} = ${parseInt(t.params[0], 10)}`;
}

/** Potongan SQL ` WHERE {alias}.tenant_id = N`. */
function tWhere(alias = '') {
    const t = billingManager._tenantWhere(alias);
    if (!t.sql) return '';
    const col = alias ? `${alias}.tenant_id` : 'tenant_id';
    return ` WHERE ${col} = ${parseInt(t.params[0], 10)}`;
}

/**
 * tenant_id untuk INSERT — tangkap SINKRON sebelum await/callback sqlite.
 * Prefer billingManager._resolveTenantIdForInsert agar perilaku seragam.
 */
function tenantIdForInsert(explicitTenantId = null) {
    if (explicitTenantId != null && Number.isFinite(Number(explicitTenantId))) {
        return parseInt(explicitTenantId, 10);
    }
    try {
        return billingManager._resolveTenantIdForInsert(explicitTenantId);
    } catch (_) {
        return hasTenantContext() ? getTenantId() : 1;
    }
}

/** SQL tenant dari req.tenantId (aman di dalam callback sqlite). */
function tenantSqlFromRequest(req) {
    const tid = req?.tenantId ?? (hasTenantContext() ? getTenantId() : null);
    const and = (alias = '') => {
        if (tid == null) return '';
        const col = alias ? `${alias}.tenant_id` : 'tenant_id';
        return ` AND ${col} = ${parseInt(tid, 10)}`;
    };
    const where = (alias = '') => {
        const clause = and(alias);
        return clause ? clause.replace(/^ AND /, ' WHERE ') : '';
    };
    const cond = (alias = '') => {
        const clause = and(alias);
        return clause ? clause.replace(/^ AND /, '') : '';
    };
    return { tid, and, where, cond };
}

module.exports = { tAnd, tWhere, tenantIdForInsert, tenantSqlFromRequest };
