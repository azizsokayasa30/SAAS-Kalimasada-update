'use strict';

const tenantStore = require('./tenantStore');

const CACHE_TTL_MS = 45 * 1000;
let overviewCache = { ts: 0, key: '', payload: null };

function periodCacheKey(period) {
    if (!period) return 'current';
    return period.isFullYear ? `y:${period.year}` : `m:${period.year}-${period.month}`;
}

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

async function getChildBreakdown(periodOptions = {}) {
    const children = await listChildTenants();
    const period = tenantStore.resolveStatsPeriod(periodOptions);
    return Promise.all(
        children.map(async (child) => ({
            ...child,
            usage: await tenantStore.getTenantStats(child.id, {
                month: period.month,
                year: period.year,
                periodFilter: true,
            }),
        }))
    );
}

async function getMasterOverview({ bustCache = false, month, year } = {}) {
    const period = tenantStore.resolveStatsPeriod({ month, year });
    const cacheKey = periodCacheKey(period);
    if (!bustCache && overviewCache.payload && overviewCache.key === cacheKey
        && (Date.now() - overviewCache.ts) < CACHE_TTL_MS) {
        return overviewCache.payload;
    }

    const master = await tenantStore.getMasterTenant();
    const children = await getChildBreakdown({ month: period.month, year: period.year });
    const summary = emptySummary();
    children.forEach((child) => addSummary(summary, child.usage));

    const payload = {
        master,
        childCount: children.length,
        children,
        summary,
        period,
    };

    overviewCache = { ts: Date.now(), key: cacheKey, payload };
    return payload;
}

const CUSTOMER_SORTS = ['id', 'name', 'package', 'area', 'status', 'join_date', 'copied'];
const EMPTY_FILTER_VALUE = '__none__';

function normalizeCustomerListQuery(query = {}) {
    const sort = CUSTOMER_SORTS.includes(query.sort) ? query.sort : 'id';
    const dir = query.dir === 'asc' ? 'asc' : 'desc';
    const copyStatus = query.copy_status === 'yes' || query.copy_status === 'no' ? query.copy_status : '';
    const area = query.area != null ? String(query.area).slice(0, 120) : '';
    const pkg = query.package != null ? String(query.package).slice(0, 20) : '';
    const status = query.status != null ? String(query.status).slice(0, 60) : '';
    const q = query.q != null ? String(query.q).trim().replace(/^#/, '').slice(0, 80) : '';
    return { sort, dir, copy_status: copyStatus, area, package: pkg, status, q };
}

function dbAllAsync(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, result) => (err ? reject(err) : resolve(result || [])));
    });
}

function dbGetAsync(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

async function ensureCopySchema() {
    try {
        const { ensureMasterMirrorSchema } = require('./masterCustomerCopyService');
        await ensureMasterMirrorSchema();
    } catch (_) { /* schema may not be ready yet */ }
}

async function getChildCopyStats(childId) {
    await ensureCopySchema();
    const db = tenantStore.getDb();
    try {
        const row = await dbGetAsync(
            db,
            `SELECT COUNT(*) AS copied
             FROM master_customer_copies mcc
             JOIN customers c ON c.id = mcc.source_customer_id AND c.tenant_id = mcc.source_tenant_id
             WHERE mcc.source_tenant_id = ?`,
            [childId]
        );
        return { copied: Number(row?.copied) || 0 };
    } catch (_) {
        return { copied: 0 };
    }
}

async function getChildCustomerFilterOptions(db, tenantId, withAreaJoin) {
    const areaExpr = withAreaJoin ? "COALESCE(NULLIF(TRIM(c.area), ''), a.nama_area)" : "NULLIF(TRIM(c.area), '')";
    const areaJoin = withAreaJoin ? 'LEFT JOIN areas a ON a.id = c.area_id AND a.tenant_id = c.tenant_id' : '';
    const [areas, packages, statuses] = await Promise.all([
        dbAllAsync(
            db,
            `SELECT ${areaExpr} AS area, COUNT(*) AS total
             FROM customers c ${areaJoin}
             WHERE c.tenant_id = ?
             GROUP BY ${areaExpr}
             ORDER BY area IS NULL, area COLLATE NOCASE`,
            [tenantId]
        ),
        dbAllAsync(
            db,
            `SELECT c.package_id AS id, p.name, p.speed, p.price, COUNT(*) AS total
             FROM customers c
             LEFT JOIN packages p ON p.id = c.package_id
             WHERE c.tenant_id = ?
             GROUP BY c.package_id
             ORDER BY c.package_id IS NULL, p.name COLLATE NOCASE`,
            [tenantId]
        ),
        dbAllAsync(
            db,
            `SELECT c.status, COUNT(*) AS total
             FROM customers c
             WHERE c.tenant_id = ?
             GROUP BY c.status
             ORDER BY c.status COLLATE NOCASE`,
            [tenantId]
        ),
    ]);
    return { areas, packages, statuses };
}

async function getChildCustomers(childId, { page = 1, limit = 50, query = {} } = {}) {
    const tenant = await getChildTenantById(childId);
    if (!tenant) return null;

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = parseInt(limit, 10);
    const safeLimit = parsedLimit === 100 ? 100 : 50;
    const offset = (safePage - 1) * safeLimit;
    const db = tenantStore.getDb();
    const listQuery = normalizeCustomerListQuery(query);

    await ensureCopySchema();

    const buildQuery = (withAreaJoin) => {
        const areaExpr = withAreaJoin ? "COALESCE(NULLIF(TRIM(c.area), ''), a.nama_area)" : "NULLIF(TRIM(c.area), '')";
        const from = `FROM customers c
             ${withAreaJoin ? 'LEFT JOIN areas a ON a.id = c.area_id AND a.tenant_id = c.tenant_id' : ''}
             LEFT JOIN packages p ON p.id = c.package_id
             LEFT JOIN master_customer_copies mcc
                ON mcc.source_tenant_id = c.tenant_id AND mcc.source_customer_id = c.id`;

        const where = ['c.tenant_id = ?'];
        const params = [tenant.id];
        if (listQuery.copy_status === 'yes') where.push('mcc.id IS NOT NULL');
        if (listQuery.copy_status === 'no') where.push('mcc.id IS NULL');
        if (listQuery.area === EMPTY_FILTER_VALUE) {
            where.push(`${areaExpr} IS NULL`);
        } else if (listQuery.area) {
            where.push(`${areaExpr} = ?`);
            params.push(listQuery.area);
        }
        if (listQuery.package === EMPTY_FILTER_VALUE) {
            where.push('c.package_id IS NULL');
        } else if (listQuery.package && /^\d+$/.test(listQuery.package)) {
            where.push('c.package_id = ?');
            params.push(parseInt(listQuery.package, 10));
        }
        if (listQuery.status === EMPTY_FILTER_VALUE) {
            where.push('c.status IS NULL');
        } else if (listQuery.status) {
            where.push('c.status = ?');
            params.push(listQuery.status);
        }
        if (listQuery.q) {
            const term = `%${listQuery.q.replace(/[%_]/g, '')}%`;
            where.push(`(
                c.name LIKE ? COLLATE NOCASE
                OR IFNULL(c.phone, '') LIKE ?
                OR CAST(c.id AS TEXT) LIKE ?
                OR IFNULL(CAST(c.customer_id AS TEXT), '') LIKE ?
            )`);
            params.push(term, term, term, term);
        }

        const dir = listQuery.dir.toUpperCase();
        const sortExpr = {
            id: `c.id ${dir}`,
            name: `c.name COLLATE NOCASE ${dir}`,
            package: `p.name IS NULL, p.name COLLATE NOCASE ${dir}, p.price ${dir}`,
            area: `${areaExpr} IS NULL, ${areaExpr} COLLATE NOCASE ${dir}`,
            status: `c.status COLLATE NOCASE ${dir}`,
            join_date: `COALESCE(c.join_date, c.created_at) ${dir}`,
            copied: `(mcc.id IS NOT NULL) ${dir}, mcc.copied_at DESC`,
        }[listQuery.sort];

        const whereSql = `WHERE ${where.join(' AND ')}`;
        return {
            listSql: `SELECT c.id, c.name, c.phone, c.email, c.status,
                    ${areaExpr} AS area,
                    c.package_id, p.name AS package_name, p.speed AS package_speed, p.price AS package_price,
                    c.join_date, c.created_at,
                    mcc.master_customer_id, mcc.copied_at
             ${from}
             ${whereSql}
             ORDER BY ${sortExpr}, c.id DESC
             LIMIT ? OFFSET ?`,
            countSql: `SELECT COUNT(*) AS total ${from} ${whereSql}`,
            params,
        };
    };

    let withAreaJoin = true;
    let rows;
    let totalRow;
    try {
        const q = buildQuery(true);
        rows = await dbAllAsync(db, q.listSql, [...q.params, safeLimit, offset]);
        totalRow = await dbGetAsync(db, q.countSql, q.params);
    } catch (err) {
        console.warn('[master-tenant] customer list area join failed, using fallback:', err.message);
        withAreaJoin = false;
        const q = buildQuery(false);
        rows = await dbAllAsync(db, q.listSql, [...q.params, safeLimit, offset]);
        totalRow = await dbGetAsync(db, q.countSql, q.params);
    }

    const decorated = rows.map((row) => ({
        ...row,
        copied_to_master: row.master_customer_id != null,
    }));

    const [filterOptions, copyStats, allTotalRow] = await Promise.all([
        getChildCustomerFilterOptions(db, tenant.id, withAreaJoin),
        getChildCopyStats(tenant.id),
        dbGetAsync(db, 'SELECT COUNT(*) AS total FROM customers WHERE tenant_id = ?', [tenant.id]),
    ]);

    const total = Number(totalRow?.total) || 0;
    return {
        tenant,
        rows: decorated,
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
        allTotal: Number(allTotalRow?.total) || 0,
        copiedTotal: copyStats.copied,
        query: listQuery,
        filterOptions,
        emptyFilterValue: EMPTY_FILTER_VALUE,
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
    overviewCache = { ts: 0, key: '', payload: null };
}

module.exports = {
    listChildTenants,
    getChildTenantById,
    getChildBreakdown,
    getMasterOverview,
    getChildCustomers,
    getChildCopyStats,
    normalizeCustomerListQuery,
    getChildInvoices,
    bustOverviewCache,
};
