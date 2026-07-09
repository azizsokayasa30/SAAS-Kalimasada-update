'use strict';

const tenantStore = require('./tenantStore');

const CACHE_TTL_MS = 45 * 1000;
let overviewCache = { ts: 0, payload: null };

function emptySummary() {
    return {
        customers: { total: 0, active: 0, inactive: 0, new: 0 },
        invoices: { total: 0, paid: 0, unpaid: 0, isolir: 0 },
        routers: 0,
    };
}

function addSummary(target, usage) {
    const c = usage?.customers || {};
    const inv = usage?.invoices || {};
    target.customers.total += Number(c.total) || 0;
    target.customers.active += Number(c.active) || 0;
    target.customers.inactive += Number(c.inactive) || 0;
    target.customers.new += Number(c.new) || 0;
    target.invoices.total += Number(inv.total) || 0;
    target.invoices.paid += Number(inv.paid) || 0;
    target.invoices.unpaid += Number(inv.unpaid) || 0;
    target.invoices.isolir += Number(inv.isolir) || 0;
    target.routers += Number(usage?.routers) || 0;
}

async function listChildTenants() {
    return tenantStore.listOperationalTenants();
}

async function getChildTenantById(childId) {
    const tenant = await tenantStore.getTenantById(childId);
    if (!tenant || tenant.is_master) return null;
    return tenant;
}

async function getChildBreakdown() {
    const children = await listChildTenants();
    return Promise.all(
        children.map(async (child) => ({
            ...child,
            usage: await tenantStore.getTenantStats(child.id),
        }))
    );
}

async function getMasterOverview({ bustCache = false } = {}) {
    if (!bustCache && overviewCache.payload && (Date.now() - overviewCache.ts) < CACHE_TTL_MS) {
        return overviewCache.payload;
    }

    const master = await tenantStore.getMasterTenant();
    const children = await getChildBreakdown();
    const summary = emptySummary();
    children.forEach((child) => addSummary(summary, child.usage));

    const payload = {
        master,
        childCount: children.length,
        children,
        summary,
    };

    overviewCache = { ts: Date.now(), payload };
    return payload;
}

async function getChildCustomers(childId, { page = 1, limit = 25 } = {}) {
    const tenant = await getChildTenantById(childId);
    if (!tenant) return null;

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const offset = (safePage - 1) * safeLimit;
    const db = tenantStore.getDb();

    const rows = await new Promise((resolve, reject) => {
        db.all(
            `SELECT id, name, phone, email, status, join_date, created_at
             FROM customers
             WHERE tenant_id = ?
             ORDER BY id DESC
             LIMIT ? OFFSET ?`,
            [tenant.id, safeLimit, offset],
            (err, result) => (err ? reject(err) : resolve(result || []))
        );
    });

    const totalRow = await new Promise((resolve, reject) => {
        db.get(
            'SELECT COUNT(*) AS total FROM customers WHERE tenant_id = ?',
            [tenant.id],
            (err, row) => (err ? reject(err) : resolve(row))
        );
    });

    return {
        tenant,
        rows,
        page: safePage,
        limit: safeLimit,
        total: totalRow?.total || 0,
        totalPages: Math.ceil((totalRow?.total || 0) / safeLimit) || 1,
    };
}

async function getChildInvoices(childId, { page = 1, limit = 25 } = {}) {
    const tenant = await getChildTenantById(childId);
    if (!tenant) return null;

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const offset = (safePage - 1) * safeLimit;
    const db = tenantStore.getDb();

    const rows = await new Promise((resolve, reject) => {
        db.all(
            `SELECT i.id, i.invoice_number, i.amount, i.status, i.due_date, i.payment_date,
                    c.name AS customer_name
             FROM invoices i
             LEFT JOIN customers c ON c.id = i.customer_id AND c.tenant_id = i.tenant_id
             WHERE i.tenant_id = ?
               AND (i.invoice_type != 'voucher' OR i.invoice_type IS NULL)
             ORDER BY i.id DESC
             LIMIT ? OFFSET ?`,
            [tenant.id, safeLimit, offset],
            (err, result) => (err ? reject(err) : resolve(result || []))
        );
    });

    const totalRow = await new Promise((resolve, reject) => {
        db.get(
            `SELECT COUNT(*) AS total
             FROM invoices i
             WHERE i.tenant_id = ?
               AND (i.invoice_type != 'voucher' OR i.invoice_type IS NULL)`,
            [tenant.id],
            (err, row) => (err ? reject(err) : resolve(row))
        );
    });

    return {
        tenant,
        rows,
        page: safePage,
        limit: safeLimit,
        total: totalRow?.total || 0,
        totalPages: Math.ceil((totalRow?.total || 0) / safeLimit) || 1,
    };
}

function bustOverviewCache() {
    overviewCache = { ts: 0, payload: null };
}

module.exports = {
    listChildTenants,
    getChildTenantById,
    getChildBreakdown,
    getMasterOverview,
    getChildCustomers,
    getChildInvoices,
    bustOverviewCache,
};
