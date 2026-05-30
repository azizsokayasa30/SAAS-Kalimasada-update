const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const cacheManager = require('../config/cacheManager');

const CACHE_KEYS = {
    core: 'mapping:new:core',
    live: 'mapping:new:live',
    pppoe: 'mapping:pppoe:batch'
};
const CACHE_TTL = {
    core: 90 * 1000,
    live: 45 * 1000,
    pppoe: 30 * 1000
};

function invalidateMappingCache() {
    cacheManager.delete(CACHE_KEYS.core);
    cacheManager.delete(CACHE_KEYS.live);
    cacheManager.delete(CACHE_KEYS.pppoe);
}

function openBillingDb() {
    const dbPath = path.join(__dirname, '../data/billing.db');
    return new sqlite3.Database(dbPath);
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                console.error('❌ Mapping DB error:', err.message);
                resolve([]);
            } else {
                resolve(rows || []);
            }
        });
    });
}

async function loadMappingDbData(db) {
    const [customers, odps, cables, backboneCables] = await Promise.all([
        dbAll(db, `
            SELECT c.id, c.name, c.phone, c.pppoe_username, c.latitude, c.longitude,
                   c.address, c.package_id, c.status, c.join_date, c.odp_id,
                   p.name AS package_name,
                   o.name AS odp_name
            FROM customers c
            LEFT JOIN packages p ON c.package_id = p.id
            LEFT JOIN odps o ON c.odp_id = o.id
            WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL
            ORDER BY c.name
        `),
        dbAll(db, `
            SELECT id, name, code, latitude, longitude, address,
                   capacity, used_ports, status, installation_date, parent_odp_id
            FROM odps
            ORDER BY name
        `),
        dbAll(db, `
            SELECT cr.id, cr.customer_id, cr.odp_id, cr.cable_length, cr.cable_type,
                   cr.installation_date, cr.status, cr.port_number, cr.notes,
                   c.name as customer_name, c.phone as customer_phone,
                   c.latitude as customer_latitude, c.longitude as customer_longitude,
                   o.name as odp_name, o.code as odp_code,
                   o.latitude as odp_latitude, o.longitude as odp_longitude
            FROM cable_routes cr
            LEFT JOIN customers c ON cr.customer_id = c.id
            LEFT JOIN odps o ON cr.odp_id = o.id
            WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL
              AND o.latitude IS NOT NULL AND o.longitude IS NOT NULL
            ORDER BY cr.id
        `),
        dbAll(db, `
            SELECT ns.id, ns.name, ns.start_odp_id, ns.end_odp_id, ns.cable_length,
                   ns.segment_type, ns.installation_date, ns.status, ns.notes,
                   start_odp.name as start_odp_name, start_odp.code as start_odp_code,
                   start_odp.latitude as start_odp_latitude, start_odp.longitude as start_odp_longitude,
                   end_odp.name as end_odp_name, end_odp.code as end_odp_code,
                   end_odp.latitude as end_odp_latitude, end_odp.longitude as end_odp_longitude,
                   'network_segments' as source_table
            FROM network_segments ns
            LEFT JOIN odps start_odp ON ns.start_odp_id = start_odp.id
            LEFT JOIN odps end_odp ON ns.end_odp_id = end_odp.id
            WHERE start_odp.latitude IS NOT NULL AND start_odp.longitude IS NOT NULL
              AND end_odp.latitude IS NOT NULL AND end_odp.longitude IS NOT NULL
            UNION ALL
            SELECT oc.id + 10000 as id,
                   'Connection-' || from_odp.name || '-' || to_odp.name as name,
                   oc.from_odp_id as start_odp_id, oc.to_odp_id as end_odp_id,
                   oc.cable_length, oc.connection_type as segment_type,
                   oc.installation_date, oc.status, oc.notes,
                   from_odp.name as start_odp_name, from_odp.code as start_odp_code,
                   from_odp.latitude as start_odp_latitude, from_odp.longitude as start_odp_longitude,
                   to_odp.name as end_odp_name, to_odp.code as end_odp_code,
                   to_odp.latitude as end_odp_latitude, to_odp.longitude as end_odp_longitude,
                   'odp_connections' as source_table
            FROM odp_connections oc
            LEFT JOIN odps from_odp ON oc.from_odp_id = from_odp.id
            LEFT JOIN odps to_odp ON oc.to_odp_id = to_odp.id
            WHERE from_odp.latitude IS NOT NULL AND from_odp.longitude IS NOT NULL
              AND to_odp.latitude IS NOT NULL AND to_odp.longitude IS NOT NULL
              AND oc.status = 'active'
        `)
    ]);

    return { customers, odps, cables, backboneCables };
}

function formatCablesForFrontend(cables) {
    return (cables || []).map((cable) => ({
        id: cable.id,
        customer_id: cable.customer_id,
        coordinates: [
            [cable.odp_latitude, cable.odp_longitude],
            [cable.customer_latitude, cable.customer_longitude]
        ],
        from: cable.odp_name,
        to: cable.customer_name,
        type: 'Access Cable',
        length: cable.cable_length || 'N/A',
        status: cable.status,
        customer_name: cable.customer_name,
        customer_phone: cable.customer_phone,
        odp_name: cable.odp_name,
        port_number: cable.port_number,
        notes: cable.notes
    }));
}

function formatBackboneForFrontend(backboneCables) {
    return (backboneCables || []).map((cable) => ({
        id: cable.id,
        coordinates: [
            [cable.start_odp_latitude, cable.start_odp_longitude],
            [cable.end_odp_latitude, cable.end_odp_longitude]
        ],
        from: cable.start_odp_name,
        to: cable.end_odp_name,
        type: cable.segment_type || 'Backbone',
        length: cable.cable_length || 'N/A',
        status: cable.status,
        name: cable.name,
        notes: cable.notes
    }));
}

function buildCustomerPppoeMap(customers) {
    const map = new Map();
    for (const row of customers || []) {
        const raw = row && row.pppoe_username != null ? String(row.pppoe_username).trim() : '';
        if (raw) {
            const key = raw.toLowerCase();
            if (!map.has(key)) {
                map.set(key, row);
            }
        }
    }
    return map;
}

function enrichCustomersWithPppoe(customers, pppoeBatch) {
    const onlineLoginSet = pppoeBatch?.names || new Set();
    const pppoeUptimeByLogin = pppoeBatch?.uptimeByLogin || Object.create(null);
    const onlineLower = new Set([...onlineLoginSet].map((n) => String(n).toLowerCase()));

    return (customers || []).map((customer) => {
        const pppoeLogin =
            customer && customer.pppoe_username != null
                ? String(customer.pppoe_username).trim()
                : '';
        if (!pppoeLogin) {
            return {
                ...customer,
                pppoe_active: null,
                network_down: true,
                down_reason: 'PPPoE username tidak ada',
                pppoe_uptime_display: null
            };
        }
        const isActive = onlineLower.has(pppoeLogin.toLowerCase());
        return {
            ...customer,
            pppoe_active: isActive,
            network_down: !isActive,
            down_reason: isActive ? null : 'PPPoE inactive',
            pppoe_uptime_display: isActive
                ? pppoeUptimeByLogin[String(pppoeLogin).toLowerCase()] || null
                : null
        };
    });
}

function buildCoreCustomers(customers) {
    return (customers || []).map((customer) => ({
        ...customer,
        pppoe_active: null,
        network_down: true,
        down_reason: 'Menunggu cek PPPoE',
        pppoe_uptime_display: null
    }));
}

function buildMappingStatistics(customers, odps, cables, backboneCables, onuDevices) {
    return {
        totalCustomers: customers.length,
        downCustomers: customers.filter((c) => c.network_down === true).length,
        totalONU: onuDevices.length,
        onlineONU: onuDevices.filter((d) => d.status === 'Online').length,
        offlineONU: onuDevices.filter((d) => d.status === 'Offline').length,
        totalODP: odps.length,
        totalCables: cables.length,
        totalBackboneCables: backboneCables.length,
        connectedCables: cables.filter((c) => c.status === 'connected').length,
        disconnectedCables: cables.filter((c) => c.status === 'disconnected').length
    };
}

async function getPppoeBatchCached() {
    const cached = cacheManager.get(CACHE_KEYS.pppoe);
    if (cached) {
        return cached;
    }
    try {
        const { getActivePppoeLoginNamesSetWithUptimeMap } = require('../config/mikrotik');
        const batch = await getActivePppoeLoginNamesSetWithUptimeMap();
        cacheManager.set(CACHE_KEYS.pppoe, batch, CACHE_TTL.pppoe);
        return batch;
    } catch (e) {
        console.warn('⚠️ PPPoE batch (mapping):', e.message || e);
        return { names: new Set(), uptimeByLogin: Object.create(null) };
    }
}

function buildCorePayload(dbData) {
    const { customers, odps, cables, backboneCables } = dbData;
    const formattedCables = formatCablesForFrontend(cables);
    const formattedBackboneCables = formatBackboneForFrontend(backboneCables);
    const coreCustomers = buildCoreCustomers(customers);

    return {
        customers: coreCustomers,
        onuDevices: [],
        odps,
        cables: formattedCables,
        backboneCables: formattedBackboneCables,
        statistics: buildMappingStatistics(coreCustomers, odps, cables, backboneCables, [])
    };
}

async function buildLivePayload(customers) {
    const pppoeBatch = await getPppoeBatchCached();
    const enrichedCustomers = enrichCustomersWithPppoe(customers, pppoeBatch);

    return {
        enrichedCustomers
    };
}

module.exports = {
    CACHE_KEYS,
    CACHE_TTL,
    invalidateMappingCache,
    openBillingDb,
    loadMappingDbData,
    formatCablesForFrontend,
    formatBackboneForFrontend,
    buildCustomerPppoeMap,
    enrichCustomersWithPppoe,
    buildCoreCustomers,
    buildMappingStatistics,
    getPppoeBatchCached,
    buildCorePayload,
    buildLivePayload
};
