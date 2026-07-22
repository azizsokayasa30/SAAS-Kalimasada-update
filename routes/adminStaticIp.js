/**
 * Static IP Connection — overlay pelanggan billing (bukan modul RADIUS/PPPoE).
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const ExcelJS = require('exceljs');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const { getSettingsWithCache } = require('../config/settingsManager');
const { getTenantId } = require('../config/platform/tenantContext');
const billingManager = require('../config/billing');
const {
    listStaticIpCustomers,
    listPools,
    getPoolById,
    createPool,
    updatePool,
    deletePool,
    analyzePool,
    assertIpAvailable,
    ipInPoolRange,
} = require('../config/staticIpPool');
const { syncPoolToMikrotik, syncAllPools, syncPoolsForRouter } = require('../config/staticIpPoolSync');
const {
    provisionStaticIPQueue,
    removeStaticIPQueue,
    getCustomerStaticIp,
    sanitizeIp,
    ensureStaticIpAutomation,
    checkStaticIpQueuesForCustomers,
    validateMinPackageMbps,
    resolvePackageRateLimit
} = require('../config/staticIPProvisioning');
const { getStaticIpOnlineSetForRouter } = require('../config/mikrotik');
const serviceSuspension = require('../config/serviceSuspension');
const logger = require('../config/logger');

function dbPath() {
    return path.join(__dirname, '../data/billing.db');
}

function listRouters(tenantId) {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(dbPath());
        const tid = parseInt(tenantId, 10) || getTenantId();
        db.all(
            `SELECT id, name, nas_ip, port FROM routers WHERE tenant_id = ? ORDER BY name`,
            [tid],
            (err, rows) => {
                db.close();
                if (err) {
                    logger.warn(`[STATIC-IP] listRouters: ${err.message}`);
                    resolve([]);
                    return;
                }
                resolve(rows || []);
            }
        );
    });
}

function getRouterForTenant(routerId, tenantId) {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(dbPath());
        db.get(
            `SELECT * FROM routers WHERE id = ? AND tenant_id = ?`,
            [routerId, tenantId],
            (err, row) => {
                db.close();
                resolve(err ? null : row || null);
            }
        );
    });
}

function setCustomerRouter(customerId, routerId) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath());
        if (!routerId) {
            db.run(`DELETE FROM customer_router_map WHERE customer_id = ?`, [customerId], (err) => {
                db.close();
                err ? reject(err) : resolve();
            });
            return;
        }
        db.run(
            `INSERT OR REPLACE INTO customer_router_map (customer_id, router_id) VALUES (?, ?)`,
            [customerId, routerId],
            (err) => {
                db.close();
                err ? reject(err) : resolve();
            }
        );
    });
}

async function enrichOnlineStatus(customers) {
    const tenantId = getTenantId();
    const pools = await listPools(tenantId).catch(() => []);
    const tenantRouters = await listRouters(tenantId).catch(() => []);
    const soleRouterId = tenantRouters.length === 1 ? tenantRouters[0].id : null;

    const resolveRouterId = (c) => {
        if (c.router_id) return Number(c.router_id);
        const ip = getCustomerStaticIp(c);
        if (ip) {
            const pool = pools.find((p) => p.enabled !== 0 && ipInPoolRange(ip, p));
            if (pool) return Number(pool.router_id);
        }
        return soleRouterId ? Number(soleRouterId) : null;
    };

    const byRouter = new Map();
    for (const c of customers) {
        const ip = getCustomerStaticIp(c);
        const routerId = resolveRouterId(c);
        c.router_id = routerId;
        if (!ip || !routerId) {
            c.online = false;
            continue;
        }
        if (!byRouter.has(routerId)) byRouter.set(routerId, []);
        byRouter.get(routerId).push(c);
    }

    for (const [routerId, list] of byRouter) {
        try {
            const db = new sqlite3.Database(dbPath());
            const router = await new Promise((resolve) => {
                db.get(
                    `SELECT * FROM routers WHERE id = ? AND tenant_id = ?`,
                    [routerId, tenantId],
                    (err, row) => {
                        db.close();
                        resolve(row || null);
                    }
                );
            });
            if (!router) {
                for (const c of list) c.online = false;
                continue;
            }
            const ips = list.map((c) => getCustomerStaticIp(c)).filter(Boolean);
            // Jangan race ke Set kosong — biarkan fungsi ARP selesai (punya timeout internal).
            const onlineSet = await getStaticIpOnlineSetForRouter(router, ips);
            for (const c of list) {
                const ip = getCustomerStaticIp(c);
                c.online = !!(ip && onlineSet.has(ip));
            }
        } catch (e) {
            for (const c of list) c.online = false;
            logger.warn(`[STATIC-IP] online enrich router ${routerId}: ${e.message}`);
        }
    }
    return customers;
}

async function syncPoolAfterCustomerChange(customer) {
    try {
        const routerId = customer.router_id;
        if (routerId) {
            await syncPoolsForRouter(routerId);
            return;
        }
        const db = new sqlite3.Database(dbPath());
        const map = await new Promise((resolve) => {
            db.get(
                `SELECT router_id FROM customer_router_map WHERE customer_id = ?`,
                [customer.id],
                (err, row) => {
                    db.close();
                    resolve(row || null);
                }
            );
        });
        if (map && map.router_id) await syncPoolsForRouter(map.router_id);
    } catch (e) {
        logger.warn(`[STATIC-IP] pool sync after customer change: ${e.message}`);
    }
}

// ——— Pages ———

router.get('/users', async (req, res) => {
    try {
        const settings = getSettingsWithCache();
        const tenantId = getTenantId();
        // Jangan tunggu ARP MikroTik — biar halaman cepat; online diisi via AJAX.
        const customers = await listStaticIpCustomers(tenantId);
        const packages = await billingManager.getPackages();
        const routers = await listRouters(tenantId);
        res.render('admin/static-ip/users', {
            title: 'User Static IP',
            page: 'static-ip-users',
            settings,
            customers,
            packages,
            routers
        });
    } catch (error) {
        logger.error('[STATIC-IP] users page:', error);
        res.status(500).send('Gagal memuat User Static IP');
    }
});

router.get('/users/online-status', async (req, res) => {
    try {
        const tenantId = getTenantId();
        const customers = await listStaticIpCustomers(tenantId);
        // Pastikan selalu ada kunci untuk setiap user (hindari UI blank)
        const online = {};
        for (const c of customers) online[String(c.id)] = false;
        try {
            await enrichOnlineStatus(customers);
            for (const c of customers) {
                online[String(c.id)] = !!c.online;
            }
        } catch (inner) {
            logger.warn(`[STATIC-IP] online-status enrich: ${inner.message}`);
        }
        const onlineCount = Object.values(online).filter(Boolean).length;
        res.json({
            success: true,
            online,
            total: customers.length,
            online_count: onlineCount
        });
    } catch (error) {
        logger.warn(`[STATIC-IP] online-status: ${error.message}`);
        res.json({ success: false, online: {}, message: error.message });
    }
});

router.get('/profiles', async (req, res) => {
    try {
        const settings = getSettingsWithCache();
        const tenantId = getTenantId();
        const packages = await billingManager.getPackages();
        const customers = await listStaticIpCustomers(tenantId);
        const counts = {};
        for (const c of customers) {
            if (!c.package_id) continue;
            counts[c.package_id] = (counts[c.package_id] || 0) + 1;
        }
        const profiles = (packages || []).map((p) => ({
            ...p,
            static_users: counts[p.id] || 0
        }));
        res.render('admin/static-ip/profiles', {
            title: 'Profil Bandwidth',
            page: 'static-ip-profiles',
            settings,
            profiles
        });
    } catch (error) {
        logger.error('[STATIC-IP] profiles page:', error);
        res.status(500).send('Gagal memuat Profil Bandwidth');
    }
});

router.get('/ip-config', async (req, res) => {
    try {
        const settings = getSettingsWithCache();
        const tenantId = getTenantId();
        const pools = await listPools(tenantId);
        const routers = await listRouters(tenantId);
        const poolId = parseInt(req.query.pool_id, 10);

        const poolStats = [];
        let globalTotal = 0;
        let globalUsed = 0;
        let globalUnused = 0;
        let globalReserved = 0;

        for (const p of pools) {
            const analysis = await analyzePool(p, tenantId);
            poolStats.push({
                ...p,
                stats: {
                    total: analysis.total,
                    used: analysis.used.length,
                    unused: analysis.unused.length,
                    reserved: (analysis.reserved || []).length
                },
                analysis
            });
            globalTotal += analysis.total;
            globalUsed += analysis.used.length;
            globalUnused += analysis.unused.length;
            globalReserved += (analysis.reserved || []).length;
        }

        let selected = null;
        let analysis = null;
        if (poolId) {
            selected = poolStats.find((p) => Number(p.id) === poolId) || null;
        }
        if (!selected && poolStats.length) {
            selected = poolStats[0];
        }
        if (selected) {
            analysis = selected.analysis;
        }

        res.render('admin/static-ip/ip-config', {
            title: 'Konfigurasi IP',
            page: 'static-ip-config',
            settings,
            pools: poolStats,
            routers,
            selected,
            analysis,
            globalStats: {
                total: globalTotal,
                used: globalUsed,
                unused: globalUnused,
                reserved: globalReserved,
                pools: pools.length
            }
        });
    } catch (error) {
        logger.error('[STATIC-IP] ip-config page:', error);
        res.status(500).send('Gagal memuat Konfigurasi IP');
    }
});

// ——— Users API ———

router.post('/users', async (req, res) => {
    try {
        const tenantId = getTenantId();
        const name = String(req.body.name || '').trim();
        const phone = String(req.body.phone || '').trim();
        const staticIp = sanitizeIp(req.body.static_ip);
        const packageId = parseInt(req.body.package_id, 10);
        const routerId = parseInt(req.body.router_id, 10);
        const mac = String(req.body.mac_address || '').trim() || null;
        const status = String(req.body.status || 'active').trim() || 'active';

        if (!name || !phone || !staticIp || !packageId || !routerId) {
            return res.status(400).json({ success: false, message: 'Nama, HP, IP, paket, dan router wajib' });
        }

        const router = await getRouterForTenant(routerId, tenantId);
        if (!router) {
            return res.status(400).json({ success: false, message: 'Router tidak valid untuk tenant ini' });
        }

        await assertIpAvailable(staticIp, { routerId, tenantId });

        const created = await billingManager.createCustomer({
            name,
            phone,
            package_id: packageId,
            static_ip: staticIp,
            assigned_ip: staticIp,
            mac_address: mac,
            status,
            connection_type: 'static_ip',
            pppoe_username: '',
            pppoe_profile: null,
            create_pppoe_user: '0',
            __skip_radius_sync: true
        });

        await setCustomerRouter(created.id, routerId);
        const pkg = await billingManager.getPackageById(packageId);
        const customer = await billingManager.getCustomerById(created.id);
        customer.router_id = routerId;
        customer.tenant_id = tenantId;
        const auto = await ensureStaticIpAutomation(customer, pkg, { routerId, tenantId });

        res.json({
            success: true,
            customer,
            provision: auto.provision,
            pool_sync: auto.pool_sync,
            automation: auto
        });
    } catch (error) {
        logger.error('[STATIC-IP] create user:', error);
        res.status(400).json({ success: false, message: error.message });
    }
});

router.put('/users/:id', async (req, res) => {
    try {
        const tenantId = getTenantId();
        const id = parseInt(req.params.id, 10);
        const existing = await billingManager.getCustomerById(id);
        if (!existing) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });

        const staticIp = req.body.static_ip !== undefined ? sanitizeIp(req.body.static_ip) : getCustomerStaticIp(existing);
        const packageId = req.body.package_id !== undefined ? parseInt(req.body.package_id, 10) : existing.package_id;
        const routerId = req.body.router_id !== undefined ? parseInt(req.body.router_id, 10) : existing.router_id;
        const mac = req.body.mac_address !== undefined ? (String(req.body.mac_address || '').trim() || null) : existing.mac_address;
        const name = req.body.name !== undefined ? String(req.body.name || '').trim() : existing.name;
        const phone = req.body.phone !== undefined ? String(req.body.phone || '').trim() : existing.phone;
        const status = req.body.status !== undefined ? String(req.body.status || '').trim() : existing.status;

        if (routerId) {
            const router = await getRouterForTenant(routerId, tenantId);
            if (!router) {
                return res.status(400).json({ success: false, message: 'Router tidak valid untuk tenant ini' });
            }
        }

        if (staticIp) {
            await assertIpAvailable(staticIp, { routerId, excludeCustomerId: id, tenantId });
        }

        await billingManager.updateCustomer(existing.phone || existing.username, {
            name,
            phone,
            package_id: packageId,
            static_ip: staticIp,
            assigned_ip: staticIp,
            mac_address: mac,
            status,
            connection_type: 'static_ip',
            pppoe_username: '',
            pppoe_profile: null,
            __skip_radius_sync: true
        });

        if (routerId) await setCustomerRouter(id, routerId);

        const customer = await billingManager.getCustomerById(id);
        customer.router_id = routerId || customer.router_id;
        customer.tenant_id = tenantId;
        const pkg = packageId ? await billingManager.getPackageById(packageId) : null;
        let auto = null;
        if (pkg && staticIp) {
            auto = await ensureStaticIpAutomation(customer, pkg, {
                routerId: customer.router_id,
                tenantId
            });
        }

        res.json({
            success: true,
            customer,
            provision: auto && auto.provision,
            pool_sync: auto && auto.pool_sync,
            automation: auto
        });
    } catch (error) {
        logger.error('[STATIC-IP] update user:', error);
        res.status(400).json({ success: false, message: error.message });
    }
});

router.delete('/users/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const customer = await billingManager.getCustomerById(id);
        if (!customer) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
        await billingManager.deleteCustomerById(id);
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

router.post('/users/:id/suspend', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const customer = await billingManager.getCustomerById(id);
        if (!customer) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
        const reason = String(req.body.reason || 'Isolir manual').trim();
        const result = await serviceSuspension.suspendCustomerService(customer, reason);
        await syncPoolAfterCustomerChange(customer);
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

router.post('/users/:id/restore', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const customer = await billingManager.getCustomerById(id);
        if (!customer) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
        const result = await serviceSuspension.restoreCustomerService(customer);
        await syncPoolAfterCustomerChange(customer);
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// ——— Profiles: cek queue (read-only) + edit bandwidth ———

router.post('/profiles/:packageId/sync', async (req, res) => {
    try {
        const tenantId = getTenantId();
        const packageId = parseInt(req.params.packageId, 10);
        const pkg = await billingManager.getPackageById(packageId);
        if (!pkg) return res.status(404).json({ success: false, message: 'Paket tidak ditemukan' });
        const customers = (await listStaticIpCustomers(tenantId)).filter(
            (c) => Number(c.package_id) === packageId
        );
        for (const c of customers) c.tenant_id = tenantId;
        const report = await checkStaticIpQueuesForCustomers(
            customers,
            async () => pkg,
            { tenantId }
        );
        res.json({
            success: true,
            mode: 'check',
            package_id: packageId,
            package_name: pkg.name,
            expected_limit: resolvePackageRateLimit(pkg),
            ...report
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

router.post('/profiles/sync-all', async (req, res) => {
    try {
        const tenantId = getTenantId();
        const customers = await listStaticIpCustomers(tenantId);
        for (const c of customers) c.tenant_id = tenantId;
        const pkgCache = new Map();
        const report = await checkStaticIpQueuesForCustomers(
            customers.filter((c) => c.package_id),
            async (c) => {
                const id = Number(c.package_id);
                if (pkgCache.has(id)) return pkgCache.get(id);
                let pkg = null;
                try {
                    pkg = await billingManager.getPackageById(id);
                } catch (_) {
                    pkg = null;
                }
                pkgCache.set(id, pkg);
                return pkg;
            },
            { tenantId }
        );
        res.json({ success: true, mode: 'check', ...report });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

router.put('/profiles/:packageId', async (req, res) => {
    try {
        const tenantId = getTenantId();
        const packageId = parseInt(req.params.packageId, 10);
        const pkg = await billingManager.getPackageById(packageId);
        if (!pkg) return res.status(404).json({ success: false, message: 'Paket tidak ditemukan' });

        const upload_limit = String(req.body.upload_limit != null ? req.body.upload_limit : pkg.upload_limit || '')
            .trim();
        const download_limit = String(
            req.body.download_limit != null ? req.body.download_limit : pkg.download_limit || ''
        ).trim();
        let speed = String(req.body.speed != null ? req.body.speed : pkg.speed || '').trim();

        if (!upload_limit && !download_limit && !speed) {
            return res.status(400).json({ success: false, message: 'Isi speed / upload / download' });
        }

        // Samakan speed text jika upload+download diisi
        if (upload_limit && download_limit) {
            speed = `${download_limit}/${upload_limit}`;
        }

        const minCheck = validateMinPackageMbps(
            { upload_limit, download_limit, speed },
            10
        );
        if (!minCheck.ok) {
            return res.status(400).json({ success: false, message: minCheck.message });
        }

        const pickBurst = (key) => {
            if (Object.prototype.hasOwnProperty.call(req.body, key)) {
                const v = req.body[key];
                if (v == null) return null;
                const s = String(v).trim();
                return s || null;
            }
            return pkg[key] || null;
        };
        const burst_limit_upload = pickBurst('burst_limit_upload');
        const burst_limit_download = pickBurst('burst_limit_download');
        const burst_threshold = pickBurst('burst_threshold');
        const burst_time = pickBurst('burst_time');

        const hasAnyBurst = !!(burst_limit_upload || burst_limit_download || burst_threshold || burst_time);
        if (hasAnyBurst) {
            if (!burst_limit_upload || !burst_limit_download) {
                return res.status(400).json({
                    success: false,
                    message: 'Burst max limit download & upload wajib diisi bersamaan'
                });
            }
            if (!burst_time) {
                return res.status(400).json({
                    success: false,
                    message: 'Burst time wajib diisi jika memakai burst'
                });
            }
        }

        const updated = await billingManager.updatePackage(packageId, {
            name: pkg.name,
            speed,
            price: pkg.price,
            tax_rate: pkg.tax_rate,
            description: pkg.description,
            pppoe_profile: pkg.pppoe_profile,
            image: pkg.image,
            router_id: pkg.router_id,
            nas_ip: pkg.nas_ip,
            upload_limit: upload_limit || null,
            download_limit: download_limit || null,
            burst_limit_upload,
            burst_limit_download,
            burst_threshold,
            burst_time,
            billing_only: !pkg.pppoe_profile || String(pkg.pppoe_profile).trim() === ''
        });

        logger.info(
            `[STATIC-IP] tenant=${tenantId} edit profile package=${packageId} speed=${speed} up=${upload_limit} down=${download_limit} burst=${burst_limit_download || '-'}/${burst_limit_upload || '-'} thr=${burst_threshold || '-'} time=${burst_time || '-'}`
        );

        res.json({
            success: true,
            package: updated || {
                id: packageId,
                name: pkg.name,
                speed,
                upload_limit,
                download_limit
            }
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// ——— Pool CRUD + sync ———

router.post('/pools', async (req, res) => {
    try {
        const tenantId = getTenantId();
        const routerId = parseInt(req.body.router_id, 10);
        const router = await getRouterForTenant(routerId, tenantId);
        if (!router) {
            return res.status(400).json({ success: false, message: 'Router tidak valid untuk tenant ini' });
        }
        const pool = await createPool(req.body, tenantId);
        let sync = null;
        try {
            sync = await syncPoolToMikrotik(pool, tenantId);
        } catch (e) {
            sync = { success: false, message: e.message };
            logger.warn(`[STATIC-IP] sync after create pool ${pool.id}: ${e.message}`);
        }
        res.json({ success: true, pool, sync });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

router.put('/pools/:id', async (req, res) => {
    try {
        const tenantId = getTenantId();
        if (req.body.router_id !== undefined) {
            const routerId = parseInt(req.body.router_id, 10);
            const router = await getRouterForTenant(routerId, tenantId);
            if (!router) {
                return res.status(400).json({ success: false, message: 'Router tidak valid untuk tenant ini' });
            }
        }
        const pool = await updatePool(parseInt(req.params.id, 10), req.body, tenantId);
        let sync = null;
        try {
            sync = await syncPoolToMikrotik(pool, tenantId);
        } catch (e) {
            sync = { success: false, message: e.message };
            logger.warn(`[STATIC-IP] sync after update pool ${pool.id}: ${e.message}`);
        }
        res.json({ success: true, pool, sync });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

router.delete('/pools/:id', async (req, res) => {
    try {
        const tenantId = getTenantId();
        await deletePool(parseInt(req.params.id, 10), tenantId);
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

router.post('/pools/:id/sync', async (req, res) => {
    try {
        const tenantId = getTenantId();
        const result = await syncPoolToMikrotik(parseInt(req.params.id, 10), tenantId);
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

router.post('/pools/sync-all', async (req, res) => {
    try {
        const results = await syncAllPools(getTenantId());
        res.json({ success: true, results });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// ——— Export / Import ———

router.get('/export/users.xlsx', async (req, res) => {
    try {
        const tenantId = getTenantId();
        const customers = await listStaticIpCustomers(tenantId);
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Static IP Users');
        ws.columns = [
            { header: 'Nama', key: 'name', width: 24 },
            { header: 'Phone', key: 'phone', width: 16 },
            { header: 'Static IP', key: 'static_ip', width: 16 },
            { header: 'Paket', key: 'package_name', width: 20 },
            { header: 'Router', key: 'router_name', width: 18 },
            { header: 'MAC', key: 'mac_address', width: 18 },
            { header: 'Status', key: 'status', width: 12 }
        ];
        for (const c of customers) {
            ws.addRow({
                name: c.customer_name || c.name,
                phone: c.phone,
                static_ip: getCustomerStaticIp(c),
                package_name: c.package_name,
                router_name: c.router_name,
                mac_address: c.mac_address,
                status: c.status
            });
        }
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=static-ip-users.xlsx');
        await wb.xlsx.write(res);
        res.end();
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/import/template', async (req, res) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Static IP Users');
    ws.columns = [
        { header: 'Nama', key: 'name', width: 24 },
        { header: 'Phone', key: 'phone', width: 16 },
        { header: 'Static IP', key: 'static_ip', width: 16 },
        { header: 'Paket', key: 'package_name', width: 20 },
        { header: 'Router', key: 'router_name', width: 18 },
        { header: 'MAC', key: 'mac_address', width: 18 },
        { header: 'Status', key: 'status', width: 12 }
    ];
    ws.addRow({
        name: 'Contoh Pelanggan',
        phone: '081234567890',
        static_ip: '10.10.10.50',
        package_name: '10 Mbps',
        router_name: '',
        mac_address: '',
        status: 'active'
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=static-ip-import-template.xlsx');
    await wb.xlsx.write(res);
    res.end();
});

router.post('/import/users', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'File Excel wajib' });
        }
        const tenantId = getTenantId();
        const packages = await billingManager.getPackages();
        const routers = await listRouters(tenantId);
        const pkgByName = new Map((packages || []).map((p) => [String(p.name).trim().toLowerCase(), p]));
        const routerByName = new Map((routers || []).map((r) => [String(r.name).trim().toLowerCase(), r]));

        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(req.file.buffer);
        const ws = wb.worksheets[0];
        const header = {};
        ws.getRow(1).eachCell((cell, col) => {
            header[String(cell.value || '').trim().toLowerCase()] = col;
        });
        const col = (names) => {
            for (const n of names) if (header[n] != null) return header[n];
            return null;
        };
        const cName = col(['nama', 'name']);
        const cPhone = col(['phone', 'hp', 'telepon']);
        const cIp = col(['static ip', 'static_ip', 'ip']);
        const cPkg = col(['paket', 'package', 'package_name']);
        const cRouter = col(['router', 'router_name', 'nas']);
        const cMac = col(['mac', 'mac_address']);
        const cStatus = col(['status']);

        let created = 0;
        let updated = 0;
        let failed = 0;
        const errors = [];

        for (let i = 2; i <= ws.rowCount; i++) {
            const row = ws.getRow(i);
            const name = String(row.getCell(cName).value || '').trim();
            const phone = String(row.getCell(cPhone).value || '').trim();
            const ip = sanitizeIp(String(row.getCell(cIp).value || '').trim());
            if (!name && !phone && !ip) continue;
            try {
                const pkgName = String(row.getCell(cPkg).value || '').trim().toLowerCase();
                const routerName = String(row.getCell(cRouter).value || '').trim().toLowerCase();
                const mac = cMac ? String(row.getCell(cMac).value || '').trim() || null : null;
                const status = cStatus ? String(row.getCell(cStatus).value || 'active').trim() : 'active';
                const pkg = pkgByName.get(pkgName);
                const router = routerByName.get(routerName) || routers[0];
                if (!pkg) throw new Error(`Paket tidak ditemukan: ${pkgName}`);
                if (!router) throw new Error('Router tidak ditemukan');
                if (!ip) throw new Error('Static IP wajib');

                const existing = (await listStaticIpCustomers(tenantId)).find(
                    (c) => getCustomerStaticIp(c) === ip || String(c.phone) === phone
                );
                if (existing) {
                    await assertIpAvailable(ip, { routerId: router.id, excludeCustomerId: existing.id, tenantId });
                    await billingManager.updateCustomer(existing.phone, {
                        name,
                        phone,
                        package_id: pkg.id,
                        static_ip: ip,
                        assigned_ip: ip,
                        mac_address: mac,
                        status,
                        connection_type: 'static_ip',
                        pppoe_username: '',
                        __skip_radius_sync: true
                    });
                    await setCustomerRouter(existing.id, router.id);
                    const cust = await billingManager.getCustomerById(existing.id);
                    await provisionStaticIPQueue(cust, pkg);
                    updated++;
                } else {
                    await assertIpAvailable(ip, { routerId: router.id, tenantId });
                    const createdRow = await billingManager.createCustomer({
                        name,
                        phone,
                        package_id: pkg.id,
                        static_ip: ip,
                        assigned_ip: ip,
                        mac_address: mac,
                        status,
                        connection_type: 'static_ip',
                        pppoe_username: '',
                        create_pppoe_user: '0',
                        __skip_radius_sync: true
                    });
                    await setCustomerRouter(createdRow.id, router.id);
                    const cust = await billingManager.getCustomerById(createdRow.id);
                    await provisionStaticIPQueue(cust, pkg);
                    created++;
                }
            } catch (e) {
                failed++;
                errors.push({ row: i, message: e.message });
            }
        }

        try {
            await syncAllPools(tenantId);
        } catch (_) {}

        res.json({ success: true, created, updated, failed, errors });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

module.exports = router;
