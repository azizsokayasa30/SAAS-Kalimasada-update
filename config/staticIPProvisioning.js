/**
 * Static IP package-speed provisioning (simple queue on Mikrotik).
 * Queue name = Title Case nama pelanggan; target = IP; tanpa comment.
 * Isolasi: hanya router milik tenant pelanggan.
 */
const logger = require('./logger');
const { getMikrotikConnectionForCustomer, buildMikrotikRateLimit } = require('./mikrotik');

function sanitizeIp(value) {
    if (!value || typeof value !== 'string') return null;
    const ip = value.trim();
    if (!ip) return null;
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) ? ip : null;
}

function getCustomerStaticIp(customer) {
    return (
        sanitizeIp(customer?.static_ip) ||
        sanitizeIp(customer?.assigned_ip) ||
        sanitizeIp(customer?.ip_address) ||
        null
    );
}

function toTitleCase(raw) {
    const s = String(raw || '')
        .replace(/[_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!s) return '';
    return s
        .split(' ')
        .map((w) => {
            if (!w) return '';
            return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
        })
        .join(' ');
}

/**
 * Nama queue: Title Case nama pelanggan (aman untuk RouterOS).
 */
function queueNameForCustomer(customer) {
    const raw = customer?.customer_name || customer?.name || '';
    let name = toTitleCase(raw)
        .replace(/[^\w\s.\-]/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!name) {
        const id = customer?.id != null ? String(customer.id) : 'User';
        name = `Customer ${id}`;
    }
    // RouterOS simple queue name max ~64
    return name.slice(0, 63);
}

function legacyQueueName(customer) {
    return customer?.id != null ? `cust_${customer.id}` : null;
}

function targetMatchesIp(target, ip) {
    if (!ip || !target) return false;
    const first = String(target).split(',')[0].trim();
    return first === ip || first.startsWith(`${ip}/`) || first.startsWith(`${ip} `);
}

/**
 * Parse free-text speed like "10 Mbps", "10Mbps", "10M", "50/20" into Mikrotik max-limit.
 */
function parseSpeedToRateLimit(speed) {
    if (!speed || typeof speed !== 'string') return null;
    const s = speed.trim();
    if (!s) return null;

    if (/^\d+(\.\d+)?[kKmMgG]\/\d+(\.\d+)?[kKmMgG](\s|$)/.test(s.replace(/\s+/g, ''))) {
        return s.replace(/\s+/g, '');
    }

    const asym = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(Mbps|mbps|Mb|Mbit|M|Kbps|kbps|K|Gbps|G)?\s*$/i);
    if (asym) {
        const unit = normalizeUnit(asym[3] || 'M');
        return `${asym[1]}${unit}/${asym[2]}${unit}`;
    }

    const sym = s.match(/^(\d+(?:\.\d+)?)\s*(Mbps|mbps|Mb|Mbit|M|Kbps|kbps|K|Gbps|G)?\s*$/i);
    if (sym) {
        const unit = normalizeUnit(sym[2] || 'M');
        const v = `${sym[1]}${unit}`;
        return `${v}/${v}`;
    }

    return null;
}

function normalizeUnit(u) {
    if (!u) return 'M';
    const x = String(u).toLowerCase();
    if (x.startsWith('g')) return 'G';
    if (x.startsWith('k')) return 'k';
    return 'M';
}

function normalizeRateToken(raw) {
    if (raw == null) return null;
    let s = String(raw).trim().replace(/\s+/g, '');
    if (!s || s === '0') return '0';
    const m = s.match(/^(\d+(?:\.\d+)?)([kKmMgG])?(?:bps|bit|b)?$/i);
    if (m) {
        const n = m[1];
        let u = (m[2] || 'M').toUpperCase();
        if (u === 'K') u = 'k';
        return `${n}${u}`;
    }
    if (/^\d+(?:\.\d+)?$/.test(s)) return `${s}M`;
    return s;
}

function normalizeMaxLimit(raw) {
    if (!raw) return null;
    const parts = String(raw).trim().split(/\s+/);
    if (!parts.length) return null;
    const normalized = parts.map((chunk) => {
        if (!chunk.includes('/')) return normalizeRateToken(chunk) || chunk;
        const [a, b] = chunk.split('/');
        if (/^\d+$/.test(a) && /^\d+$/.test(b)) return `${a}/${b}`;
        return `${normalizeRateToken(a) || a}/${normalizeRateToken(b) || b}`;
    });
    return normalized.join(' ');
}

function resolvePackageRateLimit(pkg) {
    if (!pkg) return null;

    const fromLimits = buildMikrotikRateLimit({
        upload_limit: pkg.upload_limit,
        download_limit: pkg.download_limit,
        burst_limit_upload: pkg.burst_limit_upload,
        burst_limit_download: pkg.burst_limit_download,
        burst_threshold: pkg.burst_threshold,
        burst_time: pkg.burst_time
    });
    if (fromLimits) return normalizeMaxLimit(fromLimits);

    return normalizeMaxLimit(parseSpeedToRateLimit(pkg.speed));
}

async function listSimpleQueues(mikrotik) {
    try {
        return (
            (await mikrotik.write('/queue/simple/print', [
                '=.proplist=.id,name,target,max-limit,comment,disabled'
            ])) || []
        );
    } catch (e) {
        logger.warn(`[STATIC-IP-PROVISION] queue print: ${e.message}`);
        return [];
    }
}

async function findQueueForCustomer(mikrotik, customer, desiredName) {
    const all = await listSimpleQueues(mikrotik);
    const ip = getCustomerStaticIp(customer);
    const legacy = legacyQueueName(customer);

    let found = all.find((q) => String(q.name || '') === String(desiredName));
    if (found) return found;

    if (legacy) {
        found = all.find((q) => String(q.name || '') === legacy);
        if (found) return found;
    }

    if (ip) {
        found = all.find((q) => targetMatchesIp(q.target, ip));
        if (found) return found;
    }

    return null;
}

/** @deprecated — gunakan queueNameForCustomer (Title Case). Tetap export untuk kompatibilitas. */
async function findQueueByName(mikrotik, name) {
    const all = await listSimpleQueues(mikrotik);
    return all.find((q) => String(q.name || '') === String(name)) || null;
}

/**
 * Resolve router untuk customer static IP — wajib milik tenant yang sama.
 */
async function resolveStaticIpRouterId(customer, { routerId = null, tenantId = null } = {}) {
    const path = require('path');
    const sqlite3 = require('sqlite3').verbose();
    const dbPath = path.join(__dirname, '../data/billing.db');
    const db = new sqlite3.Database(dbPath);
    const get = (sql, params = []) =>
        new Promise((resolve) => {
            db.get(sql, params, (err, row) => resolve(err ? null : row || null));
        });
    const all = (sql, params = []) =>
        new Promise((resolve) => {
            db.all(sql, params, (err, rows) => resolve(err ? [] : rows || []));
        });

    const tid =
        tenantId != null
            ? tenantId
            : customer?.tenant_id != null
              ? customer.tenant_id
              : null;

    const assertTenantRouter = async (rid) => {
        if (!rid) return null;
        if (tid == null) {
            const row = await get(`SELECT id FROM routers WHERE id = ?`, [rid]);
            return row ? Number(row.id) : null;
        }
        const row = await get(`SELECT id FROM routers WHERE id = ? AND tenant_id = ?`, [rid, tid]);
        return row ? Number(row.id) : null;
    };

    try {
        const explicit = await assertTenantRouter(routerId);
        if (explicit) return explicit;

        const fromCustomer = await assertTenantRouter(customer?.router_id);
        if (fromCustomer) return fromCustomer;

        if (customer?.id) {
            const map = await get(
                `SELECT m.router_id FROM customer_router_map m
                 JOIN routers r ON r.id = m.router_id
                 WHERE m.customer_id = ? ${tid != null ? 'AND r.tenant_id = ?' : ''}
                 LIMIT 1`,
                tid != null ? [customer.id, tid] : [customer.id]
            );
            if (map && map.router_id) return Number(map.router_id);
        }

        const ip = getCustomerStaticIp(customer);
        if (ip && tid != null) {
            const { ipInPoolRange } = require('./staticIpPool');
            const pools = await all(
                `SELECT p.* FROM static_ip_pools p
                 JOIN routers r ON r.id = p.router_id
                 WHERE p.tenant_id = ? AND p.enabled = 1 AND r.tenant_id = ?`,
                [tid, tid]
            );
            const pool = pools.find((p) => ipInPoolRange(ip, p));
            if (pool) return Number(pool.router_id);
        }

        if (tid != null) {
            const routers = await all(`SELECT id FROM routers WHERE tenant_id = ? ORDER BY id`, [tid]);
            if (routers.length === 1) return Number(routers[0].id);
        }
        return null;
    } finally {
        db.close();
    }
}

async function setCustomerRouterMap(customerId, routerId) {
    if (!customerId || !routerId) return;
    const path = require('path');
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(path.join(__dirname, '../data/billing.db'));
    await new Promise((resolve, reject) => {
        db.run(
            `INSERT OR REPLACE INTO customer_router_map (customer_id, router_id) VALUES (?, ?)`,
            [customerId, routerId],
            (err) => (err ? reject(err) : resolve())
        );
    });
    db.close();
}

async function getPackageRowById(packageId) {
    if (!packageId) return null;
    const path = require('path');
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(path.join(__dirname, '../data/billing.db'));
    try {
        return await new Promise((resolve) => {
            db.get(`SELECT * FROM packages WHERE id = ?`, [packageId], (err, row) =>
                resolve(err ? null : row || null)
            );
        });
    } finally {
        db.close();
    }
}

async function ensureStaticIpAutomation(customer, pkg, options = {}) {
    const tenantId =
        options.tenantId != null
            ? options.tenantId
            : customer?.tenant_id != null
              ? customer.tenant_id
              : null;
    const result = {
        success: false,
        router_id: null,
        provision: null,
        pool_sync: null,
        message: ''
    };

    try {
        let packageRow = pkg;
        if (!packageRow && customer?.package_id) {
            packageRow = await getPackageRowById(customer.package_id);
        }
        if (!packageRow) {
            result.message = 'Paket tidak ditemukan untuk provision kecepatan';
            return result;
        }

        const routerId = await resolveStaticIpRouterId(customer, {
            routerId: options.routerId,
            tenantId
        });
        if (!routerId) {
            result.message = 'Router tidak bisa ditentukan / bukan milik tenant ini';
            return result;
        }
        result.router_id = routerId;
        if (customer?.id) await setCustomerRouterMap(customer.id, routerId);
        customer.router_id = routerId;

        result.provision = await provisionStaticIPQueue(customer, packageRow);

        if (options.skipPoolSync !== true) {
            try {
                const { syncPoolsForRouter } = require('./staticIpPoolSync');
                const syncRes = await syncPoolsForRouter(routerId, tenantId);
                result.pool_sync = syncRes;
            } catch (e) {
                result.pool_sync = { success: false, message: e.message };
                logger.warn(`[STATIC-IP-AUTO] pool sync: ${e.message}`);
            }
        }

        result.success = !!(result.provision && (result.provision.success || result.provision.skipped));
        result.message = result.provision?.message || (result.success ? 'OK' : 'Gagal');
        return result;
    } catch (e) {
        result.message = e.message;
        logger.error(`[STATIC-IP-AUTO] ${e.message}`);
        return result;
    }
}

/**
 * Upsert simple queue: name=Title Case, target=IP, tanpa comment.
 */
async function provisionStaticIPQueue(customer, pkg) {
    try {
        const ip = getCustomerStaticIp(customer);
        if (!ip) {
            return { success: false, skipped: true, message: 'Tidak ada static IP untuk provision queue' };
        }
        if (customer?.id == null) {
            return { success: false, skipped: true, message: 'Customer id kosong' };
        }

        const rateLimit = resolvePackageRateLimit(pkg);
        if (!rateLimit) {
            return {
                success: false,
                skipped: true,
                message: 'Paket tidak punya upload/download limit atau speed yang bisa diparse'
            };
        }

        let name = queueNameForCustomer(customer);

        if (customer.router_id && customer.id) {
            try {
                await setCustomerRouterMap(customer.id, customer.router_id);
            } catch (_) {}
        }

        const mikrotik = await getMikrotikConnectionForCustomer(customer);
        const all = await listSimpleQueues(mikrotik);
        const legacy = legacyQueueName(customer);

        let existing =
            all.find((q) => String(q.name || '') === name) ||
            (legacy ? all.find((q) => String(q.name || '') === legacy) : null) ||
            all.find((q) => targetMatchesIp(q.target, ip)) ||
            null;

        // Nama sudah dipakai queue lain (beda IP) → unikkan dengan id
        const nameTakenByOther = all.find(
            (q) =>
                String(q.name || '') === name &&
                !targetMatchesIp(q.target, ip) &&
                String(q.name || '') !== legacy
        );
        if (nameTakenByOther && (!existing || existing['.id'] !== nameTakenByOther['.id'])) {
            name = `${name} ${customer.id}`.slice(0, 63);
            if (existing && String(existing.name || '') !== name) {
                // keep existing row, will rename below
            } else {
                existing =
                    all.find((q) => String(q.name || '') === name) ||
                    all.find((q) => targetMatchesIp(q.target, ip)) ||
                    (legacy ? all.find((q) => String(q.name || '') === legacy) : null) ||
                    null;
            }
        }

        if (existing) {
            await mikrotik.write('/queue/simple/set', [
                `=.id=${existing['.id']}`,
                `=name=${name}`,
                `=target=${ip}`,
                `=max-limit=${rateLimit}`,
                '=comment=',
                '=disabled=no'
            ]);
            logger.info(`[STATIC-IP-PROVISION] Updated queue "${name}" target=${ip} max-limit=${rateLimit}`);
            return { success: true, action: 'updated', queue: name, target: ip, maxLimit: rateLimit };
        }

        await mikrotik.write('/queue/simple/add', [
            `=name=${name}`,
            `=target=${ip}`,
            `=max-limit=${rateLimit}`,
            '=comment=',
            '=disabled=no'
        ]);
        logger.info(`[STATIC-IP-PROVISION] Created queue "${name}" target=${ip} max-limit=${rateLimit}`);
        return { success: true, action: 'created', queue: name, target: ip, maxLimit: rateLimit };
    } catch (error) {
        logger.error(`[STATIC-IP-PROVISION] Failed for customer ${customer?.id}: ${error.message}`);
        return { success: false, message: error.message };
    }
}

async function updateStaticIPQueue(customer, pkg) {
    return provisionStaticIPQueue(customer, pkg);
}

async function removeStaticIPQueue(customer) {
    try {
        if (customer?.id == null) {
            return { success: false, skipped: true, message: 'Customer id kosong' };
        }
        const mikrotik = await getMikrotikConnectionForCustomer(customer);
        const desired = queueNameForCustomer(customer);
        const existing = await findQueueForCustomer(mikrotik, customer, desired);
        if (!existing) {
            return { success: true, skipped: true, message: `Queue tidak ada` };
        }
        await mikrotik.write('/queue/simple/remove', [`=.id=${existing['.id']}`]);
        logger.info(`[STATIC-IP-PROVISION] Removed queue "${existing.name}"`);
        return { success: true, action: 'removed', queue: existing.name };
    } catch (error) {
        logger.error(`[STATIC-IP-PROVISION] Remove failed for customer ${customer?.id}: ${error.message}`);
        return { success: false, message: error.message };
    }
}

/**
 * Soft-isolir: turunkan max-limit queue paket (tanpa comment).
 */
async function applySuspensionBandwidthToPackageQueue(customer, limitSpeed, reason) {
    try {
        if (customer?.id == null) {
            return { success: false, skipped: true, message: 'Customer id kosong' };
        }
        const mikrotik = await getMikrotikConnectionForCustomer(customer);
        const desired = queueNameForCustomer(customer);
        const existing = await findQueueForCustomer(mikrotik, customer, desired);
        if (!existing) {
            return { success: false, skipped: true, message: `Queue tidak ada` };
        }
        await mikrotik.write('/queue/simple/set', [
            `=.id=${existing['.id']}`,
            `=max-limit=${limitSpeed}`,
            '=comment=',
            '=disabled=no'
        ]);
        logger.info(
            `[STATIC-IP-PROVISION] Soft-isolir queue "${existing.name}" max-limit=${limitSpeed} (${reason || 'isolir'})`
        );
        return { success: true, action: 'suspended_limit', queue: existing.name, maxLimit: limitSpeed };
    } catch (error) {
        logger.error(`[STATIC-IP-PROVISION] Soft-isolir failed: ${error.message}`);
        return { success: false, message: error.message };
    }
}

/**
 * Parse rate token ke Mbps (angka). null jika tidak bisa diparse.
 */
function rateTokenToMbps(raw) {
    if (raw == null || raw === '') return null;
    const s = String(raw).trim().replace(/\s+/g, '');
    if (!s || s === '0') return 0;
    const m = s.match(/^(\d+(?:\.\d+)?)([kKmMgG])?(?:bps|bit|b)?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    const u = (m[2] || 'M').toUpperCase();
    if (u === 'K') return n / 1000;
    if (u === 'M') return n;
    if (u === 'G') return n * 1000;
    return n;
}

/**
 * Ambil Mbps upload & download dari field paket (upload_limit/download_limit/speed).
 */
function packageSpeedToMbps(pkg) {
    const up = rateTokenToMbps(pkg?.upload_limit);
    const down = rateTokenToMbps(pkg?.download_limit);
    if (up != null || down != null) {
        return { uploadMbps: up, downloadMbps: down };
    }
    const speedRaw = String(pkg?.speed || '').trim();
    // "50Mbps/50Mbps" atau "50M/50M"
    const both = speedRaw.match(
        /^(\d+(?:\.\d+)?)\s*(Mbps|mbps|Mb|Mbit|M|Kbps|kbps|K|Gbps|G)?\s*\/\s*(\d+(?:\.\d+)?)\s*(Mbps|mbps|Mb|Mbit|M|Kbps|kbps|K|Gbps|G)?\s*$/i
    );
    if (both) {
        const left = rateTokenToMbps(both[1] + (both[2] || 'M'));
        const right = rateTokenToMbps(both[3] + (both[4] || both[2] || 'M'));
        return { uploadMbps: right, downloadMbps: left };
    }
    const parsed = parseSpeedToRateLimit(speedRaw);
    if (!parsed) return { uploadMbps: null, downloadMbps: null };
    const first = String(parsed).trim().split(/\s+/)[0];
    const [a, b] = first.split('/');
    const left = rateTokenToMbps(a);
    const right = rateTokenToMbps(b != null ? b : a);
    return { uploadMbps: right, downloadMbps: left };
}

/**
 * Validasi minimal Mbps (default 10). Return { ok, message }.
 */
function validateMinPackageMbps(pkgOrFields, minMbps = 10) {
    const fields =
        pkgOrFields && typeof pkgOrFields === 'object'
            ? pkgOrFields
            : { speed: pkgOrFields };
    const { uploadMbps, downloadMbps } = packageSpeedToMbps(fields);
    const values = [uploadMbps, downloadMbps].filter((v) => v != null);
    if (!values.length) {
        return { ok: false, message: `Speed tidak valid. Minimal ${minMbps} Mbps` };
    }
    const tooLow = values.find((v) => v < minMbps);
    if (tooLow != null) {
        return {
            ok: false,
            message: `Minimal ${minMbps} Mbps. Nilai di bawah batas tidak diizinkan.`
        };
    }
    return { ok: true };
}

function normalizeLimitKey(raw) {
    const n = normalizeMaxLimit(raw);
    if (!n) return '';
    // bandingkan hanya bagian max-limit utama (abaikan burst)
    return String(n).trim().split(/\s+/)[0].toLowerCase();
}

function nameMatchesRule(queueName, customer) {
    const desired = queueNameForCustomer(customer);
    const actual = String(queueName || '').trim();
    if (actual === desired) return true;
    if (actual === `${desired} ${customer.id}`) return true;
    if (actual === legacyQueueName(customer)) return false; // legacy = tidak sesuai rule baru
    return false;
}

/**
 * Cek (read-only) apakah queue MikroTik sesuai rule billing.
 * Tidak menulis ke router.
 */
async function checkStaticIpQueueCompliance(customer, pkg, { tenantId = null } = {}) {
    const ip = getCustomerStaticIp(customer);
    const desiredName = queueNameForCustomer(customer);
    const expectedLimit = resolvePackageRateLimit(pkg);
    const base = {
        customer_id: customer?.id,
        customer_name: customer?.customer_name || customer?.name || '',
        ip,
        package_id: pkg?.id || customer?.package_id || null,
        expected_name: desiredName,
        expected_limit: expectedLimit || null
    };

    if (!ip) {
        return {
            ...base,
            ok: false,
            issues: ['no_static_ip'],
            message: 'Tidak ada static IP'
        };
    }
    if (!expectedLimit) {
        return {
            ...base,
            ok: false,
            issues: ['package_limit_invalid'],
            message: 'Paket tidak punya speed/limit yang valid'
        };
    }

    try {
        const routerId = await resolveStaticIpRouterId(customer, {
            routerId: customer?.router_id,
            tenantId: tenantId != null ? tenantId : customer?.tenant_id
        });
        if (!routerId) {
            return {
                ...base,
                ok: false,
                issues: ['no_router'],
                message: 'Router tenant tidak ditemukan'
            };
        }

        const customerWithRouter = { ...customer, router_id: routerId, tenant_id: tenantId || customer?.tenant_id };
        const mikrotik = await getMikrotikConnectionForCustomer(customerWithRouter);
        const queue = await findQueueForCustomer(mikrotik, customerWithRouter, desiredName);

        if (!queue) {
            return {
                ...base,
                ok: false,
                issues: ['missing_queue'],
                message: 'Queue belum ada di MikroTik',
                actual: null
            };
        }

        const issues = [];
        const actualName = String(queue.name || '');
        const actualTarget = String(queue.target || '');
        const actualLimit = String(queue['max-limit'] || queue.max_limit || '');
        const actualComment = String(queue.comment || '').trim();
        const disabled = String(queue.disabled || 'false').toLowerCase() === 'true';

        if (!nameMatchesRule(actualName, customer)) {
            issues.push('wrong_name');
        }
        if (!targetMatchesIp(actualTarget, ip)) {
            issues.push('wrong_target');
        }
        if (normalizeLimitKey(actualLimit) !== normalizeLimitKey(expectedLimit)) {
            issues.push('wrong_limit');
        }
        if (actualComment) {
            issues.push('has_comment');
        }
        if (disabled) {
            issues.push('disabled');
        }

        const issueLabels = {
            wrong_name: `nama "${actualName}" ≠ "${desiredName}"`,
            wrong_target: `target "${actualTarget}" ≠ ${ip}`,
            wrong_limit: `max-limit "${actualLimit}" ≠ ${expectedLimit}`,
            has_comment: 'ada comment (harusnya kosong)',
            disabled: 'queue disabled'
        };

        return {
            ...base,
            ok: issues.length === 0,
            issues,
            message:
                issues.length === 0
                    ? 'Sesuai'
                    : issues.map((i) => issueLabels[i] || i).join('; '),
            actual: {
                name: actualName,
                target: actualTarget,
                max_limit: actualLimit,
                comment: actualComment,
                disabled
            }
        };
    } catch (error) {
        return {
            ...base,
            ok: false,
            issues: ['check_error'],
            message: error.message
        };
    }
}

/**
 * Bandingkan satu customer vs daftar queue yang sudah di-load (read-only).
 */
function compareCustomerAgainstQueues(customer, pkg, queues) {
    const ip = getCustomerStaticIp(customer);
    const desiredName = queueNameForCustomer(customer);
    const expectedLimit = resolvePackageRateLimit(pkg);
    const base = {
        customer_id: customer?.id,
        customer_name: customer?.customer_name || customer?.name || '',
        ip,
        package_id: pkg?.id || customer?.package_id || null,
        expected_name: desiredName,
        expected_limit: expectedLimit || null
    };

    if (!ip) {
        return { ...base, ok: false, issues: ['no_static_ip'], message: 'Tidak ada static IP', actual: null };
    }
    if (!expectedLimit) {
        return {
            ...base,
            ok: false,
            issues: ['package_limit_invalid'],
            message: 'Paket tidak punya speed/limit yang valid',
            actual: null
        };
    }

    const legacy = legacyQueueName(customer);
    const queue =
        (queues || []).find((q) => String(q.name || '') === desiredName) ||
        (legacy ? (queues || []).find((q) => String(q.name || '') === legacy) : null) ||
        (queues || []).find((q) => targetMatchesIp(q.target, ip)) ||
        null;

    if (!queue) {
        return {
            ...base,
            ok: false,
            issues: ['missing_queue'],
            message: 'Queue belum ada di MikroTik',
            actual: null
        };
    }

    const issues = [];
    const actualName = String(queue.name || '');
    const actualTarget = String(queue.target || '');
    const actualLimit = String(queue['max-limit'] || queue.max_limit || '');
    const actualComment = String(queue.comment || '').trim();
    const disabled = String(queue.disabled || 'false').toLowerCase() === 'true';

    if (!nameMatchesRule(actualName, customer)) issues.push('wrong_name');
    if (!targetMatchesIp(actualTarget, ip)) issues.push('wrong_target');
    if (normalizeLimitKey(actualLimit) !== normalizeLimitKey(expectedLimit)) issues.push('wrong_limit');
    if (actualComment) issues.push('has_comment');
    if (disabled) issues.push('disabled');

    const issueLabels = {
        wrong_name: `nama "${actualName}" ≠ "${desiredName}"`,
        wrong_target: `target "${actualTarget}" ≠ ${ip}`,
        wrong_limit: `max-limit "${actualLimit}" ≠ ${expectedLimit}`,
        has_comment: 'ada comment (harusnya kosong)',
        disabled: 'queue disabled'
    };

    return {
        ...base,
        ok: issues.length === 0,
        issues,
        message: issues.length === 0 ? 'Sesuai' : issues.map((i) => issueLabels[i] || i).join('; '),
        actual: {
            name: actualName,
            target: actualTarget,
            max_limit: actualLimit,
            comment: actualComment,
            disabled
        }
    };
}

/**
 * Cek batch pelanggan (read-only). Load queue sekali per router.
 */
async function checkStaticIpQueuesForCustomers(customers, getPkgFn, { tenantId = null } = {}) {
    const { getMikrotikConnectionForRouter } = require('./mikrotik');
    const path = require('path');
    const sqlite3 = require('sqlite3').verbose();
    const results = [];
    let ok = 0;
    let mismatch = 0;
    let errors = 0;

    const byRouter = new Map(); // routerId -> [{ customer, pkg }]
    for (const c of customers || []) {
        try {
            const pkg = await getPkgFn(c);
            if (!pkg) {
                results.push({
                    customer_id: c.id,
                    customer_name: c.customer_name || c.name || '',
                    ip: getCustomerStaticIp(c),
                    ok: false,
                    issues: ['no_package'],
                    message: 'Paket tidak ditemukan',
                    actual: null
                });
                mismatch++;
                continue;
            }
            const routerId = await resolveStaticIpRouterId(c, {
                routerId: c.router_id,
                tenantId: tenantId != null ? tenantId : c.tenant_id
            });
            if (!routerId) {
                results.push({
                    customer_id: c.id,
                    customer_name: c.customer_name || c.name || '',
                    ip: getCustomerStaticIp(c),
                    package_id: pkg.id,
                    expected_name: queueNameForCustomer(c),
                    expected_limit: resolvePackageRateLimit(pkg),
                    ok: false,
                    issues: ['no_router'],
                    message: 'Router tenant tidak ditemukan',
                    actual: null
                });
                mismatch++;
                continue;
            }
            if (!byRouter.has(routerId)) byRouter.set(routerId, []);
            byRouter.get(routerId).push({ customer: c, pkg });
        } catch (e) {
            results.push({
                customer_id: c.id,
                ok: false,
                issues: ['check_error'],
                message: e.message,
                actual: null
            });
            errors++;
        }
    }

    for (const [routerId, items] of byRouter.entries()) {
        let queues = [];
        try {
            const db = new sqlite3.Database(path.join(__dirname, '../data/billing.db'));
            const router = await new Promise((resolve) => {
                const tid = tenantId;
                const sql =
                    tid != null
                        ? `SELECT * FROM routers WHERE id = ? AND tenant_id = ?`
                        : `SELECT * FROM routers WHERE id = ?`;
                const params = tid != null ? [routerId, tid] : [routerId];
                db.get(sql, params, (err, row) => {
                    db.close();
                    resolve(err ? null : row || null);
                });
            });
            if (!router) {
                for (const { customer, pkg } of items) {
                    results.push({
                        customer_id: customer.id,
                        customer_name: customer.customer_name || customer.name || '',
                        ip: getCustomerStaticIp(customer),
                        package_id: pkg.id,
                        ok: false,
                        issues: ['no_router'],
                        message: 'Router bukan milik tenant',
                        actual: null
                    });
                    mismatch++;
                }
                continue;
            }
            const conn = await getMikrotikConnectionForRouter(router);
            queues = await listSimpleQueues(conn);
        } catch (e) {
            for (const { customer } of items) {
                results.push({
                    customer_id: customer.id,
                    customer_name: customer.customer_name || customer.name || '',
                    ok: false,
                    issues: ['check_error'],
                    message: e.message,
                    actual: null
                });
                errors++;
            }
            continue;
        }

        for (const { customer, pkg } of items) {
            const row = compareCustomerAgainstQueues(customer, pkg, queues);
            results.push(row);
            if (row.ok) ok++;
            else mismatch++;
        }
    }

    return {
        success: true,
        checked: results.length,
        ok,
        mismatch,
        errors,
        mismatches: results.filter((r) => !r.ok),
        results
    };
}

module.exports = {
    sanitizeIp,
    getCustomerStaticIp,
    toTitleCase,
    queueNameForCustomer,
    parseSpeedToRateLimit,
    normalizeMaxLimit,
    resolvePackageRateLimit,
    rateTokenToMbps,
    packageSpeedToMbps,
    validateMinPackageMbps,
    checkStaticIpQueueCompliance,
    checkStaticIpQueuesForCustomers,
    getPackageRowById,
    resolveStaticIpRouterId,
    setCustomerRouterMap,
    ensureStaticIpAutomation,
    provisionStaticIPQueue,
    updateStaticIPQueue,
    removeStaticIPQueue,
    applySuspensionBandwidthToPackageQueue,
    findQueueForCustomer
};
