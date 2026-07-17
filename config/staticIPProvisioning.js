/**
 * Static IP package-speed provisioning (simple queue on Mikrotik).
 * Separate from isolir (staticIPSuspension) — queue name: cust_<customerId>
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

function queueNameForCustomer(customer) {
    const id = customer?.id != null ? String(customer.id) : null;
    if (!id) throw new Error('Customer id diperlukan untuk nama queue');
    return `cust_${id}`;
}

/**
 * Parse free-text speed like "10 Mbps", "10Mbps", "10M", "50/20" into Mikrotik max-limit.
 * Returns "download/upload" (Mikrotik simple-queue max-limit order).
 */
function parseSpeedToRateLimit(speed) {
    if (!speed || typeof speed !== 'string') return null;
    const s = speed.trim();
    if (!s) return null;

    // Already Mikrotik-ish max-limit (optional burst tail): "10M/5M" or "10M/10M 20M/20M ..."
    if (/^\d+(\.\d+)?[kKmMgG]\/\d+(\.\d+)?[kKmMgG](\s|$)/.test(s.replace(/\s+/g, ''))) {
        return s.replace(/\s+/g, '');
    }

    // "50/20 Mbps" or "50/20"
    const asym = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(Mbps|mbps|Mb|Mbit|M|Kbps|kbps|K|Gbps|G)?\s*$/i);
    if (asym) {
        const unit = normalizeUnit(asym[3] || 'M');
        return `${asym[1]}${unit}/${asym[2]}${unit}`;
    }

    // "10 Mbps", "10Mbps", "10 M"
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

/**
 * Resolve Mikrotik max-limit string from package row.
 * Prefer upload_limit/download_limit (+ burst); fallback parse package.speed.
 */
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
    if (fromLimits) return fromLimits;

    return parseSpeedToRateLimit(pkg.speed);
}

async function findQueueByName(mikrotik, name) {
    const queues = await mikrotik.write('/queue/simple/print', [`?name=${name}`]);
    return queues && queues.length > 0 ? queues[0] : null;
}

/**
 * Upsert package-speed simple queue for a static-IP customer.
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

        const name = queueNameForCustomer(customer);
        const packageLabel = (pkg && (pkg.name || pkg.pppoe_profile)) || 'package';
        const comment = `billing cust_${customer.id} package:${packageLabel}`;

        const mikrotik = await getMikrotikConnectionForCustomer(customer);
        const existing = await findQueueByName(mikrotik, name);

        if (existing) {
            await mikrotik.write('/queue/simple/set', [
                `=.id=${existing['.id']}`,
                `=target=${ip}`,
                `=max-limit=${rateLimit}`,
                `=comment=${comment}`,
                '=disabled=no'
            ]);
            logger.info(`[STATIC-IP-PROVISION] Updated queue ${name} target=${ip} max-limit=${rateLimit}`);
            return { success: true, action: 'updated', queue: name, target: ip, maxLimit: rateLimit };
        }

        await mikrotik.write('/queue/simple/add', [
            `=name=${name}`,
            `=target=${ip}`,
            `=max-limit=${rateLimit}`,
            `=comment=${comment}`,
            '=disabled=no'
        ]);
        logger.info(`[STATIC-IP-PROVISION] Created queue ${name} target=${ip} max-limit=${rateLimit}`);
        return { success: true, action: 'created', queue: name, target: ip, maxLimit: rateLimit };
    } catch (error) {
        logger.error(`[STATIC-IP-PROVISION] Failed for customer ${customer?.id}: ${error.message}`);
        return { success: false, message: error.message };
    }
}

async function updateStaticIPQueue(customer, pkg) {
    return provisionStaticIPQueue(customer, pkg);
}

/**
 * Remove package-speed queue (e.g. switched to PPPoE or IP cleared).
 */
async function removeStaticIPQueue(customer) {
    try {
        if (customer?.id == null) {
            return { success: false, skipped: true, message: 'Customer id kosong' };
        }
        const name = queueNameForCustomer(customer);
        const mikrotik = await getMikrotikConnectionForCustomer(customer);
        const existing = await findQueueByName(mikrotik, name);
        if (!existing) {
            return { success: true, skipped: true, message: `Queue ${name} tidak ada` };
        }
        await mikrotik.write('/queue/simple/remove', [`=.id=${existing['.id']}`]);
        logger.info(`[STATIC-IP-PROVISION] Removed queue ${name}`);
        return { success: true, action: 'removed', queue: name };
    } catch (error) {
        logger.error(`[STATIC-IP-PROVISION] Remove failed for customer ${customer?.id}: ${error.message}`);
        return { success: false, message: error.message };
    }
}

/**
 * Soft-isolir: set existing cust_* queue to suspension limit (do not create suspended_* duplicate).
 */
async function applySuspensionBandwidthToPackageQueue(customer, limitSpeed, reason) {
    try {
        if (customer?.id == null) {
            return { success: false, skipped: true, message: 'Customer id kosong' };
        }
        const name = queueNameForCustomer(customer);
        const mikrotik = await getMikrotikConnectionForCustomer(customer);
        const existing = await findQueueByName(mikrotik, name);
        if (!existing) {
            return { success: false, skipped: true, message: `Queue ${name} tidak ada` };
        }
        const comment = `SUSPENDED - ${reason || 'Telat bayar'} - ${new Date().toISOString()}`;
        await mikrotik.write('/queue/simple/set', [
            `=.id=${existing['.id']}`,
            `=max-limit=${limitSpeed}`,
            `=comment=${comment}`,
            '=disabled=no'
        ]);
        logger.info(`[STATIC-IP-PROVISION] Soft-isolir queue ${name} max-limit=${limitSpeed}`);
        return { success: true, action: 'suspended_limit', queue: name, maxLimit: limitSpeed };
    } catch (error) {
        logger.error(`[STATIC-IP-PROVISION] Soft-isolir failed: ${error.message}`);
        return { success: false, message: error.message };
    }
}

module.exports = {
    sanitizeIp,
    getCustomerStaticIp,
    queueNameForCustomer,
    parseSpeedToRateLimit,
    resolvePackageRateLimit,
    provisionStaticIPQueue,
    updateStaticIPQueue,
    removeStaticIPQueue,
    applySuspensionBandwidthToPackageQueue
};
