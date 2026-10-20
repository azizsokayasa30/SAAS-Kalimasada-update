'use strict';

/**
 * Manual WhatsApp broadcast ke pelanggan (filter + template + progress).
 * Cadangan scheduler otomatis — tidak mengganti cron tagihan/pengingat.
 */

const crypto = require('crypto');
const billingManager = require('./billing');
const logger = require('./logger');
const { runWithTenant } = require('./platform/tenantContext');
const { getRateLimit, getDailyUsed } = require('./whatsapp-rate-limit');

const CUSTOMER_TEMPLATE_KEYS = [
    'invoice_created',
    'due_date_reminder',
    'due_date_reminder_today',
    'payment_received',
    'service_announcement',
    'service_disruption',
    'welcome_message',
    'service_suspension',
    'service_restoration',
    'custom'
];

const INVOICE_UNPAID_KEYS = new Set([
    'invoice_created',
    'due_date_reminder',
    'due_date_reminder_today',
    'service_suspension'
]);

const INVOICE_PAID_KEYS = new Set(['payment_received']);

const jobs = new Map();
const activeByTenant = new Map();
const JOB_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_FAILURES_KEPT = 80;

function getWhatsAppNotifications() {
    return require('./whatsapp-notifications');
}

function normalizeTenantId(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function parsePositiveIds(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const ids = [];
    for (const raw of list) {
        const id = parseInt(raw, 10);
        if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

function chunkArray(list, size) {
    const out = [];
    const n = Math.max(1, size);
    for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
}

function hasPhone(row) {
    return String(row?.phone || '').replace(/\D/g, '').length >= 8;
}

function parseFilters(src = {}) {
    const filters = {};
    if (src.search) filters.search = String(src.search).trim();
    if (src.package_id) filters.package_id = src.package_id;
    if (src.status) filters.status = String(src.status).trim();
    if (src.payment_status) filters.payment_status = String(src.payment_status).trim();
    if (src.area) filters.area = String(src.area).trim();
    if (src.collector_id) filters.collector_id = src.collector_id;
    if (src.customer_type) filters.customer_type = String(src.customer_type).trim();
    const routerRaw = src.router_id || src.router;
    if (routerRaw) {
        const rid = parseInt(routerRaw, 10);
        if (Number.isFinite(rid) && rid > 0) filters.router_id = rid;
    }
    const now = new Date();
    const month = src.month != null && src.month !== '' ? parseInt(src.month, 10) : now.getMonth() + 1;
    const year = src.year != null && src.year !== '' ? parseInt(src.year, 10) : now.getFullYear();
    if (Number.isFinite(month) && month >= 1 && month <= 12) filters.month = month;
    if (Number.isFinite(year) && year >= 2000) filters.year = year;
    return filters;
}

function listPublicTemplates(templates = {}) {
    return CUSTOMER_TEMPLATE_KEYS.map((key) => {
        if (key === 'custom') {
            return {
                key: 'custom',
                title: 'Pesan kustom',
                enabled: true,
                needs_invoice: false,
                extra_fields: ['custom_message']
            };
        }
        const t = templates[key] || {};
        const extraFields = [];
        if (key === 'service_disruption') extraFields.push('disruption_type', 'affected_area', 'estimated_resolution');
        if (key === 'service_announcement') extraFields.push('announcement_content');
        if (key === 'service_suspension') extraFields.push('reason');
        return {
            key,
            title: t.title || key,
            enabled: t.enabled !== false,
            needs_invoice: INVOICE_UNPAID_KEYS.has(key) || INVOICE_PAID_KEYS.has(key),
            extra_fields: extraFields
        };
    });
}

async function getDailyQuota(tenantId) {
    const settings = await getRateLimit(tenantId);
    const used = await getDailyUsed(tenantId);
    const limited = !!(settings.enabled && Number(settings.dailyMessageLimit) > 0);
    const limit = limited ? Number(settings.dailyMessageLimit) : 0;
    return {
        limited,
        limit,
        used,
        remaining: limited ? Math.max(0, limit - used) : null,
        delayBetweenMessages: Number(settings.delayBetweenMessages) || 0,
        delayBetweenBatches: Number(settings.delayBetweenBatches) || 0,
        maxMessagesPerBatch: Number(settings.maxMessagesPerBatch) || 10,
        enabled: settings.enabled !== false
    };
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        billingManager.db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        billingManager.db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row || null);
        });
    });
}

async function queryCustomers(filters = {}, options = {}) {
    const ids = parsePositiveIds(options.ids);
    if (ids.length > 400) {
        if (options.countOnly) {
            let total = 0;
            let withPhone = 0;
            for (const part of chunkArray(ids, 400)) {
                const partCounts = await queryCustomers(filters, { ...options, ids: part, countOnly: true });
                total += partCounts.total;
                withPhone += partCounts.with_phone;
            }
            return { total, with_phone: withPhone, without_phone: Math.max(0, total - withPhone) };
        }
        if (!(Number.isFinite(options.limit) && options.limit > 0)) {
            const rows = [];
            for (const part of chunkArray(ids, 400)) {
                const partRows = await queryCustomers(filters, { ...options, ids: part });
                if (Array.isArray(partRows)) rows.push(...partRows);
            }
            return rows;
        }
    }

    const { whereClause, params } = billingManager._buildCustomersListWhereClause(filters);
    let extraWhere = whereClause;
    const extraParams = [...params];
    if (ids.length) {
        extraWhere += ` AND c.id IN (${ids.map(() => '?').join(',')})`;
        extraParams.push(...ids);
    }

    const selectSql = `
        SELECT c.id, c.customer_id, c.name, c.phone, c.username, c.pppoe_username,
               c.address, c.area, c.status, c.package_id, c.tenant_id,
               p.name as package_name, p.speed as package_speed, p.price as package_price,
               ${billingManager._sqlCollectorNameExpr('c')} as collector_name,
               CASE
                   WHEN EXISTS (
                       SELECT 1 FROM invoices i
                       WHERE i.customer_id = c.id AND i.status = 'unpaid' AND CAST(i.amount AS REAL) > 0
                   ) THEN 'unpaid'
                   WHEN EXISTS (
                       SELECT 1 FROM invoices i
                       WHERE i.customer_id = c.id AND i.status = 'paid' AND CAST(i.amount AS REAL) > 0
                   ) THEN 'paid'
                   ELSE 'no_invoice'
               END as payment_status
        FROM customers c
        LEFT JOIN packages p ON c.package_id = p.id
        WHERE 1=1 ${extraWhere}
        ORDER BY c.id DESC
    `;

    if (options.countOnly) {
        const row = await dbGet(
            `SELECT COUNT(*) as total,
                    SUM(CASE WHEN LENGTH(REPLACE(REPLACE(REPLACE(IFNULL(c.phone,''),'+',''),' ',''),'-','')) >= 8 THEN 1 ELSE 0 END) as with_phone
             FROM customers c
             WHERE 1=1 ${extraWhere}`,
            extraParams
        );
        const total = Number(row?.total || 0);
        const withPhone = Number(row?.with_phone || 0);
        return { total, with_phone: withPhone, without_phone: Math.max(0, total - withPhone) };
    }

    if (Number.isFinite(options.limit) && options.limit > 0) {
        const limit = Math.min(Math.max(parseInt(options.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(options.offset, 10) || 0, 0);
        const rows = await dbAll(`${selectSql} LIMIT ? OFFSET ?`, [...extraParams, limit, offset]);
        const countRow = await dbGet(
            `SELECT COUNT(*) as total FROM customers c WHERE 1=1 ${extraWhere}`,
            extraParams
        );
        return {
            customers: rows,
            totalCount: Number(countRow?.total || 0),
            page: Math.floor(offset / limit) + 1,
            totalPages: Math.max(1, Math.ceil(Number(countRow?.total || 0) / limit)),
            limit,
            offset
        };
    }

    return dbAll(selectSql, extraParams);
}

async function loadLatestInvoices(customerIds, status, tenantId = null) {
    const ids = parsePositiveIds(customerIds);
    if (!ids.length) return new Map();
    let tenantSql = '';
    const tid = normalizeTenantId(tenantId);
    if (tid) tenantSql = ' AND i.tenant_id = ?';
    const map = new Map();
    for (const part of chunkArray(ids, 400)) {
        const partPlaceholders = part.map(() => '?').join(',');
        const partParams = [...part, status];
        if (tid) partParams.push(tid);
        const rows = await dbAll(
            `SELECT i.id, i.customer_id, i.invoice_number, i.amount, i.due_date, i.status,
                    i.notes, i.package_id, i.created_at, i.payment_method, i.payment_date
             FROM invoices i
             WHERE i.customer_id IN (${partPlaceholders})
               AND i.status = ?
               AND CAST(i.amount AS REAL) > 0${tenantSql}
             ORDER BY datetime(i.created_at) DESC, i.id DESC`,
            partParams
        );
        for (const row of rows) {
            if (!map.has(row.customer_id)) map.set(row.customer_id, row);
        }
    }
    return map;
}

function formatStatusLabel(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'active' || s === 'aktif') return 'Aktif';
    if (s === 'inactive' || s === 'nonaktif') return 'Nonaktif';
    if (s === 'suspended' || s === 'isolir') return 'Isolir';
    return status || '-';
}

function formatPaymentLabel(status) {
    if (status === 'unpaid') return 'Belum lunas';
    if (status === 'paid') return 'Lunas';
    if (status === 'no_invoice') return 'Belum ada tagihan';
    return status || '-';
}

function publicCustomerRow(row) {
    return {
        id: row.id,
        customer_id: row.customer_id || '',
        name: row.name || '',
        phone: row.phone || '',
        has_phone: hasPhone(row),
        package_name: row.package_name || '-',
        area: row.area || '-',
        collector_name: row.collector_name || '-',
        status: row.status || '',
        status_label: formatStatusLabel(row.status),
        payment_status: row.payment_status || '',
        payment_label: formatPaymentLabel(row.payment_status)
    };
}

function sanitizeExtra(templateKey, extra = {}) {
    const out = {};
    const src = extra && typeof extra === 'object' ? extra : {};
    if (templateKey === 'service_disruption') {
        out.disruption_type = String(src.disruption_type || src.disruptionType || 'Gangguan Jaringan').trim();
        out.affected_area = String(src.affected_area || src.affectedArea || 'Area terfilter').trim();
        out.estimated_resolution = String(src.estimated_resolution || src.estimatedResolution || 'Sedang dalam penanganan').trim();
    }
    if (templateKey === 'service_announcement') {
        out.announcement_content = String(src.announcement_content || src.message || '').trim();
    }
    if (templateKey === 'service_suspension') {
        out.reason = String(src.reason || 'Tagihan tertunggak').trim();
    }
    if (templateKey === 'custom') {
        out.custom_message = String(src.custom_message || src.message || '').trim();
    }
    return out;
}

async function buildCustomerMessage(customer, templateKey, templates, extra, invoice, tenantId) {
    const wa = getWhatsAppNotifications();
    const tpl = templateKey === 'custom'
        ? { template: extra.custom_message, enabled: true, title: 'Pesan kustom' }
        : templates[templateKey];

    if (!tpl || !tpl.template) {
        return { ok: false, skip: true, reason: 'Template tidak ditemukan' };
    }
    if (templateKey !== 'custom' && tpl.enabled === false) {
        return { ok: false, skip: true, reason: 'Template nonaktif di pengaturan' };
    }
    if (templateKey === 'custom' && !String(tpl.template).trim()) {
        return { ok: false, skip: true, reason: 'Isi pesan kustom masih kosong' };
    }

    const data = {
        customer_name: customer.name || 'Pelanggan',
        phone: customer.phone || '',
        area: customer.area || '-',
        package_name: customer.package_name || '-',
        package_speed: customer.package_speed || '-',
        username: customer.username || customer.pppoe_username || '',
        pppoe_username: customer.pppoe_username || '-',
        pppoe_password: customer.pppoe_password || '-',
        address: customer.address || '-'
    };

    if (templateKey === 'service_disruption') {
        data.disruption_type = extra.disruption_type;
        data.affected_area = extra.affected_area;
        data.estimated_resolution = extra.estimated_resolution;
    }
    if (templateKey === 'service_announcement') {
        data.announcement_content = extra.announcement_content || 'Pengumuman layanan';
    }
    if (templateKey === 'service_suspension') {
        data.reason = extra.reason || 'Tagihan tertunggak';
    }

    if (INVOICE_UNPAID_KEYS.has(templateKey) || INVOICE_PAID_KEYS.has(templateKey)) {
        if (!invoice) {
            const need = INVOICE_PAID_KEYS.has(templateKey) ? 'invoice lunas' : 'invoice belum lunas';
            return { ok: false, skip: true, reason: `Tidak ada ${need}` };
        }
        data.invoice_number = invoice.invoice_number || '-';
        data.amount = wa.formatCurrency(invoice.amount);
        data.due_date = invoice.due_date ? wa.formatDate(invoice.due_date) : '-';
        data.days_remaining = String(wa._calcDaysRemaining(invoice.due_date));
        data.notes = invoice.notes || 'Tagihan bulanan';
        data.payment_method = invoice.payment_method || 'Manual Admin';
        data.payment_date = wa.formatDate(invoice.payment_date || invoice.created_at || new Date());
        data.reference_number = invoice.invoice_number || '-';
    }

    const message = await wa.renderTemplate(tpl.template, data, tenantId);
    if (!String(message || '').trim()) {
        return { ok: false, skip: true, reason: 'Pesan hasil template kosong' };
    }
    return { ok: true, message, title: tpl.title || templateKey };
}

function estimateEtaSeconds(remaining, quota) {
    if (!quota.enabled || remaining <= 0) return 0;
    const batch = Math.max(1, quota.maxMessagesPerBatch || 10);
    const perMsg = Number(quota.delayBetweenMessages) || 0;
    const perBatch = Number(quota.delayBetweenBatches) || 0;
    const batches = Math.ceil(remaining / batch);
    return Math.round((remaining * perMsg) + (Math.max(0, batches - 1) * perBatch));
}

function publicJob(job) {
    if (!job) return null;
    const total = job.progress.total || 0;
    const processed = job.progress.processed || 0;
    const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : (job.status === 'completed' ? 100 : 0);
    return {
        job_id: job.job_id,
        status: job.status,
        template_key: job.template_key,
        template_title: job.template_title,
        created_at: job.created_at,
        started_at: job.started_at,
        finished_at: job.finished_at,
        progress: {
            total,
            processed,
            success: job.progress.success,
            failed: job.progress.failed,
            skipped: job.progress.skipped,
            percent,
            current_name: job.progress.current_name,
            current_phone: job.progress.current_phone,
            eta_seconds: job.progress.eta_seconds,
            last_error: job.progress.last_error
        },
        failures: job.failures.slice(-MAX_FAILURES_KEPT)
    };
}

function cleanupJobs() {
    const now = Date.now();
    for (const [id, job] of jobs.entries()) {
        const ts = new Date(job.finished_at || job.created_at).getTime();
        if (['completed', 'cancelled', 'failed'].includes(job.status) && now - ts > JOB_TTL_MS) {
            jobs.delete(id);
            if (activeByTenant.get(job.tenant_key) === id) activeByTenant.delete(job.tenant_key);
        }
    }
}

function tenantKey(tenantId) {
    return tenantId ? String(tenantId) : 'legacy';
}

async function getGatewayStatus(tenantId) {
    try {
        const wa = getWhatsAppNotifications();
        const resolved = await wa.resolveSendProvider(tenantId);
        return {
            connected: !!(resolved && resolved.provider),
            provider: resolved?.type || null,
            error: resolved?.error || null
        };
    } catch (err) {
        return { connected: false, provider: null, error: err.message };
    }
}

async function getPageMeta(tenantId) {
    const wa = getWhatsAppNotifications();
    const templates = await wa.getResolvedTemplates(tenantId);
    const _t = tenantId
        ? billingManager._tenantWhereExplicit(tenantId)
        : billingManager._tenantWhere();
    const [packages, collectors, uniqueAreas, gateway, quota] = await Promise.all([
        billingManager.getPackages(),
        dbAll(`SELECT id, name, phone FROM collectors WHERE status = "active"${_t.sql} ORDER BY name`, _t.params).catch(() => []),
        billingManager.getCustomerAreaFilterOptions({ tenantId }),
        getGatewayStatus(tenantId),
        getDailyQuota(tenantId)
    ]);
    return {
        templates: listPublicTemplates(templates),
        packages,
        collectors,
        uniqueAreas,
        gateway,
        quota
    };
}

async function listCustomers(filtersInput, query = {}) {
    const filters = parseFilters(filtersInput);
    // Tampilkan semua hasil filter (tanpa pagination) agar admin bisa lihat & centang lengkap.
    const [rows, quota, gateway] = await Promise.all([
        queryCustomers(filters, {}),
        getDailyQuota(query.tenantId),
        getGatewayStatus(query.tenantId)
    ]);
    const list = Array.isArray(rows) ? rows : [];
    const customers = list.map(publicCustomerRow);
    const withPhone = customers.filter((c) => c.has_phone).length;
    const total = customers.length;
    const warnQuota = !!(quota.limited && withPhone > Number(quota.remaining || 0));
    return {
        customers,
        pagination: {
            currentPage: 1,
            totalPages: 1,
            totalCount: total,
            limit: total,
            hasNextPage: false,
            hasPrevPage: false
        },
        stats: {
            total,
            with_phone: withPhone,
            without_phone: Math.max(0, total - withPhone)
        },
        quota,
        gateway,
        warn_quota: warnQuota,
        filters
    };
}

async function previewBroadcast({ filtersInput, templateKey, extraInput, customerIds, targetMode, tenantId }) {
    const key = CUSTOMER_TEMPLATE_KEYS.includes(templateKey) ? templateKey : null;
    if (!key) {
        return { success: false, error: 'Template tidak valid' };
    }
    const wa = getWhatsAppNotifications();
    const templates = await wa.getResolvedTemplates(tenantId);
    if (key !== 'custom' && !wa.isTemplateEnabled(key, templates)) {
        return { success: false, error: `Template "${key}" nonaktif di pengaturan WhatsApp` };
    }
    const extra = sanitizeExtra(key, extraInput);
    if (key === 'custom' && !extra.custom_message) {
        return { success: false, error: 'Isi pesan kustom wajib diisi' };
    }

    const filters = parseFilters(filtersInput);
    const ids = targetMode === 'selected' ? parsePositiveIds(customerIds) : [];
    if (targetMode === 'selected' && !ids.length) {
        return { success: false, error: 'Tidak ada pelanggan yang dipilih' };
    }

    const counts = await queryCustomers(filters, { countOnly: true, ids: targetMode === 'selected' ? ids : undefined });
    const sampleRows = await queryCustomers(filters, {
        limit: 1,
        offset: 0,
        ids: targetMode === 'selected' ? ids : undefined
    });
    const sample = (sampleRows.customers || [])[0] || null;
    let sampleMessage = '';
    let sampleSkip = null;
    if (sample) {
        let invoice = null;
        if (INVOICE_UNPAID_KEYS.has(key) || INVOICE_PAID_KEYS.has(key)) {
            const map = await loadLatestInvoices(
                [sample.id],
                INVOICE_PAID_KEYS.has(key) ? 'paid' : 'unpaid',
                tenantId
            );
            invoice = map.get(sample.id) || null;
        }
        const built = await buildCustomerMessage(sample, key, templates, extra, invoice, tenantId);
        if (built.ok) sampleMessage = built.message;
        else sampleSkip = built.reason;
    }

    const quota = await getDailyQuota(tenantId);
    const warnQuota = quota.limited && counts.with_phone > quota.remaining;
    return {
        success: true,
        template_key: key,
        template_title: key === 'custom' ? 'Pesan kustom' : (templates[key]?.title || key),
        target_mode: targetMode === 'selected' ? 'selected' : 'filter',
        stats: counts,
        quota,
        warn_quota: warnQuota,
        sample: sample
            ? {
                name: sample.name,
                phone: sample.phone,
                message: sampleMessage,
                skipped: sampleSkip
            }
            : null
    };
}

function createJobRecord({ tenantId, templateKey, templateTitle, extra, filters, targetMode, recipients, quota }) {
    cleanupJobs();
    const jobId = crypto.randomBytes(8).toString('hex');
    const job = {
        job_id: jobId,
        tenant_id: tenantId,
        tenant_key: tenantKey(tenantId),
        status: 'queued',
        cancelled: false,
        template_key: templateKey,
        template_title: templateTitle,
        extra,
        filters,
        target_mode: targetMode,
        recipients,
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        progress: {
            total: recipients.length,
            processed: 0,
            success: 0,
            failed: 0,
            skipped: 0,
            current_name: '',
            current_phone: '',
            eta_seconds: estimateEtaSeconds(recipients.length, quota || {}),
            last_error: ''
        },
        failures: []
    };
    jobs.set(jobId, job);
    return job;
}

async function runJob(job, tenant) {
    const wa = getWhatsAppNotifications();
    const tenantId = job.tenant_id;
    job.status = 'running';
    job.started_at = new Date().toISOString();
    const quota = await getDailyQuota(tenantId);
    const templates = await wa.getResolvedTemplates(tenantId);

    let invoiceMap = new Map();
    if (INVOICE_UNPAID_KEYS.has(job.template_key) || INVOICE_PAID_KEYS.has(job.template_key)) {
        invoiceMap = await loadLatestInvoices(
            job.recipients.map((r) => r.id),
            INVOICE_PAID_KEYS.has(job.template_key) ? 'paid' : 'unpaid',
            tenantId
        );
    }

    const batchSize = Math.max(1, quota.maxMessagesPerBatch || 10);
    let sentInBatch = 0;

    for (let i = 0; i < job.recipients.length; i++) {
        if (job.cancelled) {
            job.status = 'cancelled';
            const left = job.recipients.length - i;
            job.progress.skipped += left;
            job.progress.processed += left;
            break;
        }

        const customer = job.recipients[i];
        job.progress.current_name = customer.name || '';
        job.progress.current_phone = customer.phone || '';
        job.progress.eta_seconds = estimateEtaSeconds(job.recipients.length - i, await getDailyQuota(tenantId));

        if (!hasPhone(customer)) {
            job.progress.skipped++;
            job.progress.processed++;
            job.failures.push({ name: customer.name, phone: customer.phone || '-', reason: 'Nomor WhatsApp kosong' });
            continue;
        }

        const liveQuota = await getDailyQuota(tenantId);
        if (liveQuota.limited && liveQuota.remaining <= 0) {
            const left = job.recipients.length - i;
            job.progress.skipped += left;
            job.progress.processed += left;
            job.progress.last_error = 'Kuota harian WhatsApp habis';
            job.failures.push({ name: customer.name, phone: customer.phone, reason: 'Kuota harian habis' });
            job.status = 'completed';
            break;
        }

        try {
            const invoice = invoiceMap.get(customer.id) || null;
            const built = await buildCustomerMessage(
                customer,
                job.template_key,
                templates,
                job.extra,
                invoice,
                tenantId
            );
            if (!built.ok) {
                job.progress.skipped++;
                job.progress.processed++;
                job.failures.push({ name: customer.name, phone: customer.phone, reason: built.reason });
                continue;
            }

            const result = await wa.sendNotificationWithRetry(customer.phone, built.message, { tenantId });
            if (result && result.success) {
                job.progress.success++;
            } else {
                job.progress.failed++;
                const reason = result?.error || 'Gagal kirim';
                job.progress.last_error = reason;
                job.failures.push({ name: customer.name, phone: customer.phone, reason });
            }
        } catch (err) {
            job.progress.failed++;
            job.progress.last_error = err.message;
            job.failures.push({ name: customer.name, phone: customer.phone, reason: err.message });
            logger.error(`[WA-CUSTOMERS] Gagal kirim ke ${customer.phone}:`, err);
        }

        job.progress.processed++;
        sentInBatch++;

        const settings = await wa.getRateLimitSettings(tenantId);
        if (settings.enabled && i < job.recipients.length - 1 && !job.cancelled) {
            if (sentInBatch >= batchSize) {
                if (settings.delayBetweenBatches > 0) {
                    await wa.delay(settings.delayBetweenBatches * 1000);
                }
                sentInBatch = 0;
            } else if (settings.delayBetweenMessages > 0) {
                await wa.delay(settings.delayBetweenMessages * 1000);
            }
        }

        if (job.failures.length > MAX_FAILURES_KEPT * 3) {
            job.failures = job.failures.slice(-MAX_FAILURES_KEPT);
        }
    }

    if (job.status === 'running') job.status = 'completed';
    job.finished_at = new Date().toISOString();
    job.progress.current_name = '';
    job.progress.current_phone = '';
    job.progress.eta_seconds = 0;
    job.failures = job.failures.slice(-MAX_FAILURES_KEPT);
    if (activeByTenant.get(job.tenant_key) === job.job_id) {
        activeByTenant.delete(job.tenant_key);
    }
    logger.info(
        `[WA-CUSTOMERS] Job ${job.job_id} ${job.status}: ` +
        `${job.progress.success} ok / ${job.progress.failed} gagal / ${job.progress.skipped} dilewati ` +
        `dari ${job.progress.total}`
    );
}

async function startBroadcast({ filtersInput, templateKey, extraInput, customerIds, targetMode, tenantId, tenant }) {
    const key = CUSTOMER_TEMPLATE_KEYS.includes(templateKey) ? templateKey : null;
    if (!key) return { success: false, error: 'Template tidak valid' };

    const tKey = tenantKey(tenantId);
    const existingId = activeByTenant.get(tKey);
    if (existingId) {
        const existing = jobs.get(existingId);
        if (existing && (existing.status === 'queued' || existing.status === 'running')) {
            return { success: false, error: 'Masih ada pengiriman yang berjalan. Tunggu selesai atau batalkan dulu.', job_id: existingId };
        }
    }

    const wa = getWhatsAppNotifications();
    const templates = await wa.getResolvedTemplates(tenantId);
    if (key !== 'custom' && !wa.isTemplateEnabled(key, templates)) {
        return { success: false, error: `Template "${key}" nonaktif di pengaturan WhatsApp` };
    }
    const extra = sanitizeExtra(key, extraInput);
    if (key === 'custom' && !extra.custom_message) {
        return { success: false, error: 'Isi pesan kustom wajib diisi' };
    }

    const gateway = await getGatewayStatus(tenantId);
    if (!gateway.connected) {
        return { success: false, error: gateway.error || 'WhatsApp belum terhubung. Cek pengaturan gateway.' };
    }

    const filters = parseFilters(filtersInput);
    const ids = targetMode === 'selected' ? parsePositiveIds(customerIds) : [];
    if (targetMode === 'selected' && !ids.length) {
        return { success: false, error: 'Tidak ada pelanggan yang dipilih' };
    }

    const recipients = await queryCustomers(filters, { ids: targetMode === 'selected' ? ids : undefined });
    const list = Array.isArray(recipients) ? recipients : [];
    if (!list.length) {
        return { success: false, error: 'Tidak ada pelanggan sesuai filter' };
    }

    const job = createJobRecord({
        tenantId,
        templateKey: key,
        templateTitle: key === 'custom' ? 'Pesan kustom' : (templates[key]?.title || key),
        extra,
        filters,
        targetMode: targetMode === 'selected' ? 'selected' : 'filter',
        recipients: list,
        quota: await getDailyQuota(tenantId)
    });
    activeByTenant.set(tKey, job.job_id);

    const tenantObj = tenant && tenant.id ? tenant : (tenantId ? { id: tenantId } : null);
    setImmediate(() => {
        const runner = () => runJob(job, tenantObj).catch((err) => {
            job.status = 'failed';
            job.finished_at = new Date().toISOString();
            job.progress.last_error = err.message;
            if (activeByTenant.get(tKey) === job.job_id) activeByTenant.delete(tKey);
            logger.error(`[WA-CUSTOMERS] Job ${job.job_id} gagal:`, err);
        });
        if (tenantObj) runWithTenant(tenantObj, runner);
        else runner();
    });

    return {
        success: true,
        job_id: job.job_id,
        job: publicJob(job)
    };
}

function getJob(jobId, tenantId) {
    const job = jobs.get(String(jobId || ''));
    if (!job) return null;
    const tid = normalizeTenantId(tenantId);
    if (tid && job.tenant_id && job.tenant_id !== tid) return null;
    return publicJob(job);
}

function cancelJob(jobId, tenantId) {
    const job = jobs.get(String(jobId || ''));
    if (!job) return { success: false, error: 'Job tidak ditemukan' };
    const tid = normalizeTenantId(tenantId);
    if (tid && job.tenant_id && job.tenant_id !== tid) {
        return { success: false, error: 'Job tidak ditemukan' };
    }
    if (job.status === 'completed' || job.status === 'failed') {
        return { success: false, error: 'Pengiriman sudah selesai' };
    }
    job.cancelled = true;
    if (job.status === 'queued') {
        job.status = 'cancelled';
        job.finished_at = new Date().toISOString();
        if (activeByTenant.get(job.tenant_key) === job.job_id) activeByTenant.delete(job.tenant_key);
    }
    return { success: true, job: publicJob(job) };
}

function getActiveJob(tenantId) {
    const id = activeByTenant.get(tenantKey(tenantId));
    if (!id) return null;
    return getJob(id, tenantId);
}

module.exports = {
    CUSTOMER_TEMPLATE_KEYS,
    parseFilters,
    getPageMeta,
    listCustomers,
    previewBroadcast,
    startBroadcast,
    getJob,
    cancelJob,
    getActiveJob,
    getDailyQuota,
    getGatewayStatus,
    publicCustomerRow
};
