'use strict';

const fs = require('fs');
const path = require('path');
const tenantStore = require('./tenantStore');

let schemaReady = false;

async function ensurePopSchema() {
    if (schemaReady) return;
    const migrationPath = path.join(__dirname, '../../migrations/add_platform_pop.sql');
    if (fs.existsSync(migrationPath)) {
        const sql = fs.readFileSync(migrationPath, 'utf8');
        const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
        for (const stmt of statements) {
            try {
                await tenantStore.dbRun(stmt);
            } catch (err) {
                const msg = String(err.message || '').toLowerCase();
                if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
                    console.warn('[popService] migration warn:', err.message);
                }
            }
        }
    }
    schemaReady = true;
}

function normalizeCode(code) {
    return String(code || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '-')
        .replace(/[^A-Z0-9_-]/g, '');
}

async function listPops() {
    await ensurePopSchema();
    const rows = await tenantStore.dbAll(
        `SELECT p.*,
                (SELECT COUNT(*) FROM platform_pop_switches s WHERE s.pop_id = p.id) AS switch_count,
                (SELECT COUNT(*) FROM platform_pop_radius_servers r WHERE r.pop_id = p.id) AS radius_count
         FROM platform_pops p
         ORDER BY p.name ASC`
    );
    return rows;
}

async function getPopById(id) {
    await ensurePopSchema();
    return tenantStore.dbGet('SELECT * FROM platform_pops WHERE id = ?', [id]);
}

async function createPop(data) {
    await ensurePopSchema();
    const code = normalizeCode(data.code);
    const name = String(data.name || '').trim();
    if (!code) throw new Error('Kode POP/CABANG wajib diisi.');
    if (!name) throw new Error('Nama POP/CABANG wajib diisi.');

    const existing = await tenantStore.dbGet('SELECT id FROM platform_pops WHERE code = ?', [code]);
    if (existing) throw new Error(`Kode POP "${code}" sudah digunakan.`);

    const result = await tenantStore.dbRun(
        `INSERT INTO platform_pops (code, name, location, address, latitude, longitude, description, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            code,
            name,
            String(data.location || '').trim() || null,
            String(data.address || '').trim() || null,
            data.latitude !== '' && data.latitude != null ? Number(data.latitude) : null,
            data.longitude !== '' && data.longitude != null ? Number(data.longitude) : null,
            String(data.description || '').trim() || null,
            data.is_active === '1' || data.is_active === 1 ? 1 : 0,
        ]
    );
    return getPopById(result.id);
}

async function updatePop(id, data) {
    await ensurePopSchema();
    const existing = await getPopById(id);
    if (!existing) throw new Error('POP/CABANG tidak ditemukan.');

    const code = normalizeCode(data.code ?? existing.code);
    const name = String(data.name ?? existing.name).trim();
    if (!code) throw new Error('Kode POP/CABANG wajib diisi.');
    if (!name) throw new Error('Nama POP/CABANG wajib diisi.');

    const duplicate = await tenantStore.dbGet(
        'SELECT id FROM platform_pops WHERE code = ? AND id != ?',
        [code, id]
    );
    if (duplicate) throw new Error(`Kode POP "${code}" sudah digunakan.`);

    await tenantStore.dbRun(
        `UPDATE platform_pops
         SET code = ?, name = ?, location = ?, address = ?, latitude = ?, longitude = ?,
             description = ?, is_active = ?, updated_at = datetime('now','localtime')
         WHERE id = ?`,
        [
            code,
            name,
            String(data.location ?? existing.location ?? '').trim() || null,
            String(data.address ?? existing.address ?? '').trim() || null,
            data.latitude !== '' && data.latitude != null ? Number(data.latitude) : null,
            data.longitude !== '' && data.longitude != null ? Number(data.longitude) : null,
            String(data.description ?? existing.description ?? '').trim() || null,
            data.is_active === '1' || data.is_active === 1 ? 1 : 0,
            id,
        ]
    );
    return getPopById(id);
}

async function deletePop(id) {
    await ensurePopSchema();
    const existing = await getPopById(id);
    if (!existing) throw new Error('POP/CABANG tidak ditemukan.');
    await tenantStore.dbRun('DELETE FROM platform_pops WHERE id = ?', [id]);
    return true;
}

async function listSwitches(popId = null) {
    await ensurePopSchema();
    const params = [];
    let where = '';
    if (popId) {
        where = 'WHERE s.pop_id = ?';
        params.push(popId);
    }
    return tenantStore.dbAll(
        `SELECT s.*, p.code AS pop_code, p.name AS pop_name
         FROM platform_pop_switches s
         JOIN platform_pops p ON p.id = s.pop_id
         ${where}
         ORDER BY p.name ASC, s.name ASC`,
        params
    );
}

async function getSwitchById(id) {
    await ensurePopSchema();
    return tenantStore.dbGet(
        `SELECT s.*, p.code AS pop_code, p.name AS pop_name
         FROM platform_pop_switches s
         JOIN platform_pops p ON p.id = s.pop_id
         WHERE s.id = ?`,
        [id]
    );
}

async function createSwitch(data) {
    await ensurePopSchema();
    const popId = parseInt(data.pop_id, 10);
    const name = String(data.name || '').trim();
    const ip = String(data.ip_address || '').trim();
    if (!Number.isFinite(popId) || popId <= 0) throw new Error('POP/CABANG wajib dipilih.');
    if (!name) throw new Error('Nama switch wajib diisi.');
    if (!ip) throw new Error('IP address switch wajib diisi.');

    const pop = await getPopById(popId);
    if (!pop) throw new Error('POP/CABANG tidak ditemukan.');

    const result = await tenantStore.dbRun(
        `INSERT INTO platform_pop_switches
         (pop_id, name, brand, model, ip_address, snmp_community, snmp_version, main_interface, include_in_aggregate, description, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            popId,
            name,
            String(data.brand || '').trim() || null,
            String(data.model || '').trim() || null,
            ip,
            String(data.snmp_community || '').trim() || null,
            String(data.snmp_version || 'v2c').trim() || 'v2c',
            String(data.main_interface || 'SFP+1').trim() || 'SFP+1',
            data.include_in_aggregate === '1' || data.include_in_aggregate === 1 ? 1 : 0,
            String(data.description || '').trim() || null,
            data.is_active === '1' || data.is_active === 1 ? 1 : 0,
        ]
    );
    return getSwitchById(result.id);
}

async function updateSwitch(id, data) {
    await ensurePopSchema();
    const existing = await getSwitchById(id);
    if (!existing) throw new Error('Switch tidak ditemukan.');

    const popId = parseInt(data.pop_id ?? existing.pop_id, 10);
    const name = String(data.name ?? existing.name).trim();
    const ip = String(data.ip_address ?? existing.ip_address).trim();
    if (!Number.isFinite(popId) || popId <= 0) throw new Error('POP/CABANG wajib dipilih.');
    if (!name) throw new Error('Nama switch wajib diisi.');
    if (!ip) throw new Error('IP address switch wajib diisi.');

    const pop = await getPopById(popId);
    if (!pop) throw new Error('POP/CABANG tidak ditemukan.');

    await tenantStore.dbRun(
        `UPDATE platform_pop_switches
         SET pop_id = ?, name = ?, brand = ?, model = ?, ip_address = ?, snmp_community = ?,
             snmp_version = ?, main_interface = ?, include_in_aggregate = ?, description = ?,
             is_active = ?, updated_at = datetime('now','localtime')
         WHERE id = ?`,
        [
            popId,
            name,
            String(data.brand ?? existing.brand ?? '').trim() || null,
            String(data.model ?? existing.model ?? '').trim() || null,
            ip,
            String(data.snmp_community ?? existing.snmp_community ?? '').trim() || null,
            String(data.snmp_version ?? existing.snmp_version ?? 'v2c').trim() || 'v2c',
            String(data.main_interface ?? existing.main_interface ?? 'SFP+1').trim() || 'SFP+1',
            data.include_in_aggregate === '1' || data.include_in_aggregate === 1 ? 1 : 0,
            String(data.description ?? existing.description ?? '').trim() || null,
            data.is_active === '1' || data.is_active === 1 ? 1 : 0,
            id,
        ]
    );
    return getSwitchById(id);
}

async function deleteSwitch(id) {
    await ensurePopSchema();
    const existing = await getSwitchById(id);
    if (!existing) throw new Error('Switch tidak ditemukan.');
    await tenantStore.dbRun('DELETE FROM platform_pop_switches WHERE id = ?', [id]);
    return true;
}

async function listRadiusServers(popId = null) {
    await ensurePopSchema();
    const params = [];
    let where = '';
    if (popId) {
        where = 'WHERE r.pop_id = ?';
        params.push(popId);
    }
    return tenantStore.dbAll(
        `SELECT r.*, p.code AS pop_code, p.name AS pop_name
         FROM platform_pop_radius_servers r
         JOIN platform_pops p ON p.id = r.pop_id
         ${where}
         ORDER BY p.name ASC, r.name ASC`,
        params
    );
}

async function getRadiusServerById(id) {
    await ensurePopSchema();
    return tenantStore.dbGet(
        `SELECT r.*, p.code AS pop_code, p.name AS pop_name
         FROM platform_pop_radius_servers r
         JOIN platform_pops p ON p.id = r.pop_id
         WHERE r.id = ?`,
        [id]
    );
}

async function createRadiusServer(data) {
    await ensurePopSchema();
    const popId = parseInt(data.pop_id, 10);
    const name = String(data.name || '').trim();
    const host = String(data.host || '').trim();
    if (!Number.isFinite(popId) || popId <= 0) throw new Error('POP/CABANG wajib dipilih.');
    if (!name) throw new Error('Nama radius manager wajib diisi.');
    if (!host) throw new Error('Host/IP radius manager wajib diisi.');

    const pop = await getPopById(popId);
    if (!pop) throw new Error('POP/CABANG tidak ditemukan.');

    const result = await tenantStore.dbRun(
        `INSERT INTO platform_pop_radius_servers
         (pop_id, name, host, auth_port, acct_port, radius_secret, description, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            popId,
            name,
            host,
            Number(data.auth_port) || 1812,
            Number(data.acct_port) || 1813,
            String(data.radius_secret || '').trim() || null,
            String(data.description || '').trim() || null,
            data.is_active === '1' || data.is_active === 1 ? 1 : 0,
        ]
    );
    return getRadiusServerById(result.id);
}

async function updateRadiusServer(id, data) {
    await ensurePopSchema();
    const existing = await getRadiusServerById(id);
    if (!existing) throw new Error('Radius manager tidak ditemukan.');

    const popId = parseInt(data.pop_id ?? existing.pop_id, 10);
    const name = String(data.name ?? existing.name).trim();
    const host = String(data.host ?? existing.host).trim();
    if (!Number.isFinite(popId) || popId <= 0) throw new Error('POP/CABANG wajib dipilih.');
    if (!name) throw new Error('Nama radius manager wajib diisi.');
    if (!host) throw new Error('Host/IP radius manager wajib diisi.');

    const pop = await getPopById(popId);
    if (!pop) throw new Error('POP/CABANG tidak ditemukan.');

    const secret = data.radius_secret !== undefined && String(data.radius_secret).trim() !== ''
        ? String(data.radius_secret).trim()
        : existing.radius_secret;

    await tenantStore.dbRun(
        `UPDATE platform_pop_radius_servers
         SET pop_id = ?, name = ?, host = ?, auth_port = ?, acct_port = ?, radius_secret = ?,
             description = ?, is_active = ?, updated_at = datetime('now','localtime')
         WHERE id = ?`,
        [
            popId,
            name,
            host,
            Number(data.auth_port ?? existing.auth_port) || 1812,
            Number(data.acct_port ?? existing.acct_port) || 1813,
            secret,
            String(data.description ?? existing.description ?? '').trim() || null,
            data.is_active === '1' || data.is_active === 1 ? 1 : 0,
            id,
        ]
    );
    return getRadiusServerById(id);
}

async function deleteRadiusServer(id) {
    await ensurePopSchema();
    const existing = await getRadiusServerById(id);
    if (!existing) throw new Error('Radius manager tidak ditemukan.');
    await tenantStore.dbRun('DELETE FROM platform_pop_radius_servers WHERE id = ?', [id]);
    return true;
}

async function listActivePops() {
    await ensurePopSchema();
    return tenantStore.dbAll(
        `SELECT id, code, name FROM platform_pops WHERE is_active = 1 ORDER BY name ASC`
    );
}

/**
 * Pastikan FreeRADIUS lokal di VPS terdaftar di Radius Manager
 * agar dashboard bisa memonitor mesin FreeRADIUS Kalimasada.
 */
async function ensureLocalRadiusServer() {
    await ensurePopSchema();

    const localHosts = ['127.0.0.1', 'localhost', '::1'];
    const existingLocal = await tenantStore.dbGet(
        `SELECT id FROM platform_pop_radius_servers
         WHERE lower(host) IN (${localHosts.map(() => '?').join(',')})
         LIMIT 1`,
        localHosts
    );
    if (existingLocal) return getRadiusServerById(existingLocal.id);

    let pop = await tenantStore.dbGet(
        `SELECT id FROM platform_pops WHERE upper(code) IN ('HQ', 'VPS', 'PUSAT') LIMIT 1`
    );
    if (!pop) {
        pop = await createPop({
            code: 'HQ',
            name: 'VPS Pusat',
            location: 'Central VPS',
            description: 'POP virtual untuk infrastruktur pusat di VPS management',
            is_active: '1',
        });
    }

    return createRadiusServer({
        pop_id: pop.id,
        name: 'FreeRADIUS VPS Pusat',
        host: '127.0.0.1',
        auth_port: 1812,
        acct_port: 1813,
        description: 'FreeRADIUS lokal di VPS management Kalimasada',
        is_active: '1',
    });
}

module.exports = {
    ensurePopSchema,
    listPops,
    getPopById,
    createPop,
    updatePop,
    deletePop,
    listSwitches,
    getSwitchById,
    createSwitch,
    updateSwitch,
    deleteSwitch,
    listRadiusServers,
    getRadiusServerById,
    createRadiusServer,
    updateRadiusServer,
    deleteRadiusServer,
    ensureLocalRadiusServer,
    listActivePops,
};
