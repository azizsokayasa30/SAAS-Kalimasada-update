'use strict';

/**
 * Sync walled-garden isolir PPPoE/RADIUS ke MikroTik.
 * Berbeda dari static IP (address-list isolir_customer):
 * - RADIUS memberi Framed-Pool = isolir-pool
 * - MikroTik membatasi src-address range pool isolir + redirect HTTP ke portal isolir
 */
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const logger = require('./logger');
const { getMikrotikConnectionForRouter } = require('./mikrotik');
const {
    COMMENT_PPP,
    getIsolirAccessConfig,
    applyIsolirWalledGarden,
    safeWrite,
    hardenMikrotikConnection
} = require('./mikrotikIsolirWalledGarden');

const PER_ROUTER_TIMEOUT_MS = 45000;
const SYNC_CONCURRENCY = 2;

function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`Timeout ${Math.round(ms / 1000)}s: ${label}`)),
                ms
            );
        })
    ]);
}

async function mapPool(items, concurrency, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function run() {
        while (next < items.length) {
            const i = next++;
            results[i] = await worker(items[i], i);
        }
    }
    const n = Math.max(1, Math.min(concurrency, items.length || 1));
    await Promise.all(Array.from({ length: n }, () => run()));
    return results;
}

async function ensurePoolAndProfile(mikrotik, access) {
    try {
        const pools = ((await safeWrite(mikrotik, '/ip/pool/print', [])) || [])
            .filter((p) => String(p.name || '') === String(access.isolirPoolName));
        if (pools.length) {
            await safeWrite(mikrotik, '/ip/pool/set', [
                `=.id=${pools[0]['.id']}`,
                `=ranges=${access.poolRange}`,
                `=comment=${COMMENT_PPP} pool`
            ]);
        } else {
            await safeWrite(mikrotik, '/ip/pool/add', [
                `=name=${access.isolirPoolName}`,
                `=ranges=${access.poolRange}`,
                `=comment=${COMMENT_PPP} pool`
            ]);
        }
    } catch (e) {
        logger.warn(`[RADIUS-ISOLIR-SYNC] pool: ${e.message}`);
    }

    try {
        const profiles = ((await safeWrite(mikrotik, '/ppp/profile/print', [])) || [])
            .filter((p) => String(p.name || '') === String(access.isolirProfile));
        if (profiles.length) {
            await safeWrite(mikrotik, '/ppp/profile/set', [
                `=.id=${profiles[0]['.id']}`,
                `=local-address=${access.localAddress}`,
                `=remote-address=${access.isolirPoolName}`,
                `=dns-server=${access.localAddress}`,
                '=only-one=yes',
                `=comment=${COMMENT_PPP} profile`
            ]);
            try {
                await safeWrite(mikrotik, '/ppp/profile/set', [
                    `=.id=${profiles[0]['.id']}`,
                    '=use-ipv6=no'
                ]);
            } catch (_) {}
        } else {
            await safeWrite(mikrotik, '/ppp/profile/add', [
                `=name=${access.isolirProfile}`,
                `=local-address=${access.localAddress}`,
                `=remote-address=${access.isolirPoolName}`,
                `=dns-server=${access.localAddress}`,
                '=only-one=yes',
                `=comment=${COMMENT_PPP} profile`
            ]);
        }
    } catch (e) {
        logger.warn(`[RADIUS-ISOLIR-SYNC] ppp profile: ${e.message}`);
    }
}

async function ensurePppoeIsolirFirewallOnConnection(mikrotik, access = null) {
    const cfg = access || (await getIsolirAccessConfig());
    await ensurePoolAndProfile(mikrotik, cfg);
    return applyIsolirWalledGarden(mikrotik, 'pppoe', cfg);
}

async function listRoutersForTenant(tenantId) {
    const tid = parseInt(tenantId, 10);
    const db = new sqlite3.Database(path.join(__dirname, '../data/billing.db'));
    try {
        const cols = `id, name, nas_ip, port, tenant_id, user, password, secret, location, pop`;
        return await new Promise((resolve) => {
            if (Number.isFinite(tid) && tid > 0) {
                db.all(
                    `SELECT ${cols} FROM routers WHERE tenant_id = ? ORDER BY name`,
                    [tid],
                    (err, rows) => resolve(err ? [] : rows || [])
                );
            } else {
                db.all(`SELECT ${cols} FROM routers ORDER BY name`, [], (err, rows) =>
                    resolve(err ? [] : rows || [])
                );
            }
        });
    } finally {
        db.close();
    }
}

async function syncOneRouter(router, access) {
    const label = `${router.name || router.id} (${router.nas_ip})`;
    const started = Date.now();
    try {
        const sync = await withTimeout(
            (async () => {
                const mikrotik = hardenMikrotikConnection(await getMikrotikConnectionForRouter(router));
                return ensurePppoeIsolirFirewallOnConnection(mikrotik, access);
            })(),
            PER_ROUTER_TIMEOUT_MS,
            label
        );
        logger.info(
            `[RADIUS-ISOLIR-SYNC] OK ${label} in ${Date.now() - started}ms portal=${sync.billing_server_ip}:${sync.isolir_port} nat+${sync.nat?.added || 0}`
        );
        return {
            success: Boolean(sync.success),
            router_id: router.id,
            router_name: router.name,
            nas_ip: router.nas_ip,
            billing_server_ip: sync.billing_server_ip,
            isolir_range: sync.isolir_range,
            isolir_pool: sync.isolir_pool,
            isolir_port: sync.isolir_port,
            elapsed_ms: Date.now() - started,
            nat: sync.nat,
            error: sync.success
                ? undefined
                : 'NAT redirect gagal (cek server_host / isolir_billing_server_ip)'
        };
    } catch (e) {
        logger.warn(`[RADIUS-ISOLIR-SYNC] FAIL ${label}: ${e.message}`);
        return {
            success: false,
            router_id: router.id,
            router_name: router.name,
            nas_ip: router.nas_ip,
            elapsed_ms: Date.now() - started,
            error: e.message
        };
    }
}

async function syncPppoeIsolirFirewallForTenant(tenantId) {
    const { patchNodeRouterosEmptyReply } = require('./mikrotikIsolirWalledGarden');
    patchNodeRouterosEmptyReply();
    const access = await getIsolirAccessConfig();
    const routers = await listRoutersForTenant(tenantId);

    if (!routers.length) {
        return {
            success: false,
            message: 'Tidak ada router untuk tenant ini',
            billing_server_ip: access.billingServerIp || null,
            results: []
        };
    }

    // RADIUS profile sekali saja (bukan per-router)
    try {
        const { ensureIsolirProfileRadius } = require('./mikrotik');
        await withTimeout(ensureIsolirProfileRadius(), 15000, 'ensureIsolirProfileRadius');
    } catch (e) {
        logger.warn(`[RADIUS-ISOLIR-SYNC] ensureIsolirProfileRadius: ${e.message}`);
    }

    const t0 = Date.now();
    const results = await mapPool(routers, SYNC_CONCURRENCY, (router) => syncOneRouter(router, access));
    const ok = results.filter((r) => r.success).length;
    const failed = results.length - ok;
    const elapsed = Date.now() - t0;

    return {
        success: failed === 0,
        message: failed
            ? `Sync selesai ${elapsed}ms: ${ok} berhasil, ${failed} gagal (portal ${access.billingServerIp}:${access.isolirPort})`
            : `Sync berhasil ke ${ok} router dalam ${elapsed}ms (portal ${access.billingServerIp || '-'}:${access.isolirPort})`,
        billing_server_ip: access.billingServerIp || null,
        isolir_range: access.isolirRange,
        isolir_pool: access.isolirPoolName,
        isolir_port: access.isolirPort,
        elapsed_ms: elapsed,
        results
    };
}

async function getPppoeIsolirInfo() {
    const access = await getIsolirAccessConfig();
    return {
        method: 'radius_framed_pool',
        isolir_profile: access.isolirProfile,
        isolir_pool: access.isolirPoolName,
        isolir_range: access.isolirRange,
        billing_server_ip: access.billingServerIp || null,
        isolir_port: access.isolirPort,
        description:
            'PPPoE/RADIUS isolir memakai group isolir + Framed-Pool; MikroTik redirect range pool ke halaman isolir'
    };
}

module.exports = {
    getPppoeIsolirAccessConfig: getIsolirAccessConfig,
    getPppoeIsolirInfo,
    ensurePppoeIsolirFirewallOnConnection,
    syncPppoeIsolirFirewallForTenant,
    listRoutersForTenant
};
