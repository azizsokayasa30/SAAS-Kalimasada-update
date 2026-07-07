const billingManager = require('../../../config/billing');

const OFFLINE_STATUS_SQL = "('OFFLINE','LOS','POWER_OFF','DYING_GASP','DISABLED','AUTH_FAILED')";
const VALID_POLLING_INTERVALS = [1, 5, 10, 15];
const DEFAULT_POLLING_INTERVAL = 10;

function parseJson(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function stringifyJson(value) {
    if (value === undefined || value === null) return null;
    return JSON.stringify(value);
}

function defaultPortForMethod(method) {
    const normalized = String(method || '').toLowerCase();
    if (normalized === 'http_api') return 80;
    if (normalized === 'https_api') return 443;
    if (normalized === 'telnet') return 23;
    if (normalized === 'snmp_v2' || normalized === 'snmp_v3') return 161;
    return 22;
}

class OltRepository {
    constructor(db = billingManager.db) {
        this.db = db;
    }

    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, changes: this.changes });
            });
        });
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
        });
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
        });
    }

    normalizeOlt(row) {
        if (!row) return null;
        return {
            ...row,
            system_info: parseJson(row.system_info_json, {}),
            profile: row.profile_id ? {
                id: row.profile_id,
                name: row.profile_name,
                vendor: row.profile_vendor,
                model: row.profile_model,
                base_path: row.base_path,
                auth_type: row.auth_type,
                auth_header: row.auth_header,
                verify_tls: row.verify_tls,
                timeout_ms: row.timeout_ms,
                endpoints: parseJson(row.endpoints_json, {}),
                parser: parseJson(row.parser_json, {}),
                capabilities: parseJson(row.capabilities_json, {})
            } : null
        };
    }

    async listOlts(filters = {}) {
        const _t = billingManager._tenantWhere('o');
        const where = [];
        const params = [..._t.params];
        if (_t.sql) where.push(`1=1${_t.sql}`);
        if (filters.status) {
            where.push('o.status = ?');
            params.push(filters.status);
        }
        if (filters.vendor) {
            where.push('LOWER(o.vendor) = LOWER(?)');
            params.push(filters.vendor);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const rows = await this.all(
            `SELECT o.*,
                    COUNT(onu.id) AS total_onu,
                    SUM(CASE WHEN onu.status = 'ONLINE' THEN 1 ELSE 0 END) AS online_onu,
                    SUM(CASE WHEN onu.status IN ${OFFLINE_STATUS_SQL} THEN 1 ELSE 0 END) AS offline_onu,
                    p.id AS profile_id, p.name AS profile_name, p.vendor AS profile_vendor,
                    p.model AS profile_model, p.base_path, p.auth_type, p.auth_header,
                    p.verify_tls, p.timeout_ms, p.endpoints_json, p.parser_json, p.capabilities_json
             FROM olts o
             LEFT JOIN olt_api_profiles p ON p.id = o.api_profile_id
             LEFT JOIN onus onu ON onu.olt_id = o.id
             ${whereSql}
             GROUP BY o.id
             ORDER BY o.name COLLATE NOCASE`,
            params
        );
        return rows.map((row) => this.normalizeOlt(row));
    }

    async getOltById(id) {
        const _t = billingManager._tenantWhere('o');
        const row = await this.get(
            `SELECT o.*,
                    p.id AS profile_id, p.name AS profile_name, p.vendor AS profile_vendor,
                    p.model AS profile_model, p.base_path, p.auth_type, p.auth_header,
                    p.verify_tls, p.timeout_ms, p.endpoints_json, p.parser_json, p.capabilities_json
             FROM olts o
             LEFT JOIN olt_api_profiles p ON p.id = o.api_profile_id
             WHERE o.id = ?${_t.sql}`,
            [id, ..._t.params]
        );
        return this.normalizeOlt(row);
    }

    async createOlt(data) {
        const result = await this.run(
            `INSERT INTO olts (
                name, vendor, model, ip_address, port, username, password_encrypted,
                enable_password, connection_method, snmp_community, snmp_version,
                location, description, status, polling_interval, api_profile_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                data.name,
                data.vendor,
                data.model || null,
                data.ip_address,
                Number(data.port) || defaultPortForMethod(data.connection_method),
                data.username || null,
                data.password_encrypted || null,
                data.enable_password || null,
                data.connection_method || 'https_api',
                data.snmp_community || null,
                data.snmp_version || 'v2',
                data.location || null,
                data.description || null,
                data.status || 'active',
                VALID_POLLING_INTERVALS.includes(Number(data.polling_interval))
                    ? Number(data.polling_interval)
                    : DEFAULT_POLLING_INTERVAL,
                data.api_profile_id || null
            ]
        );
        return this.getOltById(result.id);
    }

    async updateOlt(id, data) {
        const current = await this.getOltById(id);
        if (!current) return null;
        await this.run(
            `UPDATE olts SET
                name = ?, vendor = ?, model = ?, ip_address = ?, port = ?, username = ?,
                password_encrypted = COALESCE(?, password_encrypted),
                enable_password = COALESCE(?, enable_password),
                connection_method = ?, snmp_community = ?, snmp_version = ?,
                location = ?, description = ?, status = ?, polling_interval = ?,
                api_profile_id = ?, updated_at = datetime('now','localtime')
             WHERE id = ?`,
            [
                data.name ?? current.name,
                data.vendor ?? current.vendor,
                data.model ?? current.model,
                data.ip_address ?? current.ip_address,
                Number(data.port ?? current.port) || current.port,
                data.username ?? current.username,
                data.password_encrypted || null,
                data.enable_password || null,
                data.connection_method ?? current.connection_method,
                data.snmp_community ?? current.snmp_community,
                data.snmp_version ?? current.snmp_version,
                data.location ?? current.location,
                data.description ?? current.description,
                data.status ?? current.status,
                VALID_POLLING_INTERVALS.includes(Number(data.polling_interval ?? current.polling_interval))
                    ? Number(data.polling_interval ?? current.polling_interval)
                    : current.polling_interval,
                data.api_profile_id ?? current.api_profile_id,
                id
            ]
        );
        return this.getOltById(id);
    }

    async deleteOlt(id) {
        return this.run('DELETE FROM olts WHERE id = ?', [id]);
    }

    async updateOltConnection(id, status, error = null, systemInfo = null) {
        await this.run(
            `UPDATE olts SET
                last_connection_status = ?,
                last_error = ?,
                system_info_json = COALESCE(?, system_info_json),
                updated_at = datetime('now','localtime')
             WHERE id = ?`,
            [status, error, systemInfo ? stringifyJson(systemInfo) : null, id]
        );
    }

    async markOltSynced(id, systemInfo = null) {
        await this.run(
            `UPDATE olts SET
                last_sync = datetime('now','localtime'),
                last_connection_status = 'connected',
                last_error = NULL,
                system_info_json = COALESCE(?, system_info_json),
                updated_at = datetime('now','localtime')
             WHERE id = ?`,
            [systemInfo ? stringifyJson(systemInfo) : null, id]
        );
    }

    async listApiProfiles() {
        const rows = await this.all('SELECT * FROM olt_api_profiles WHERE is_active = 1 ORDER BY name COLLATE NOCASE');
        return rows.map((row) => ({
            ...row,
            endpoints: parseJson(row.endpoints_json, {}),
            parser: parseJson(row.parser_json, {}),
            capabilities: parseJson(row.capabilities_json, {})
        }));
    }

    async createApiProfile(data) {
        const result = await this.run(
            `INSERT INTO olt_api_profiles (
                name, vendor, model, base_path, auth_type, auth_header, verify_tls,
                timeout_ms, endpoints_json, parser_json, capabilities_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                data.name,
                data.vendor || null,
                data.model || null,
                data.base_path || '',
                data.auth_type || 'basic',
                data.auth_header || null,
                data.verify_tls === 0 || data.verify_tls === false ? 0 : 1,
                Number(data.timeout_ms) || 10000,
                typeof data.endpoints_json === 'string' ? data.endpoints_json : stringifyJson(data.endpoints || {}),
                typeof data.parser_json === 'string' ? data.parser_json : stringifyJson(data.parser || {}),
                typeof data.capabilities_json === 'string' ? data.capabilities_json : stringifyJson(data.capabilities || {})
            ]
        );
        return this.get('SELECT * FROM olt_api_profiles WHERE id = ?', [result.id]);
    }

    async upsertPonPort(oltId, port) {
        const slot = port.slot == null ? '' : String(port.slot);
        const pon = port.pon == null ? String(port.name || 'unknown') : String(port.pon);
        await this.run(
            `INSERT INTO pon_ports (olt_id, slot, pon, name, onu_count, updated_at)
             VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))
             ON CONFLICT(olt_id, slot, pon) DO UPDATE SET
                name = excluded.name,
                onu_count = excluded.onu_count,
                updated_at = datetime('now','localtime')`,
            [oltId, slot, pon, port.name || `${slot}/${pon}`, Number(port.onu_count) || 0]
        );
        return this.get('SELECT * FROM pon_ports WHERE olt_id = ? AND slot = ? AND pon = ?', [oltId, slot, pon]);
    }

    async upsertOnu(oltId, ponPortId, onu) {
        const lookup = onu.onu_index || onu.onu_sn || onu.onu_id;
        const normalizedSn = onu.onu_sn && String(onu.onu_sn).trim() && !/^0+$/.test(String(onu.onu_sn).trim())
            ? String(onu.onu_sn).trim()
            : null;
        const existing = onu.onu_index
            ? await this.get(
                'SELECT * FROM onus WHERE olt_id = ? AND onu_index = ? LIMIT 1',
                [oltId, onu.onu_index]
            )
            : await this.get(
                'SELECT * FROM onus WHERE olt_id = ? AND onu_sn = ? LIMIT 1',
                [oltId, normalizedSn]
            );
        const status = onu.status || 'UNKNOWN';
        if (existing) {
            let serialForUpdate = normalizedSn;
            if (serialForUpdate) {
                const serialOwner = await this.get(
                    'SELECT id FROM onus WHERE olt_id = ? AND onu_sn = ? AND id <> ? LIMIT 1',
                    [oltId, serialForUpdate, existing.id]
                );
                if (serialOwner) serialForUpdate = null;
            }
            await this.run(
                `UPDATE onus SET
                    pon_port_id = ?, onu_index = COALESCE(?, onu_index), onu_id = ?,
                    onu_sn = COALESCE(?, onu_sn), onu_name = ?, vendor = ?, model = ?,
                    status = ?, rx_power = ?, tx_power = ?, signal_quality = ?, distance = ?,
                    mac_address = ?, ip_address = ?, last_seen = COALESCE(?, last_seen),
                    last_polled_at = datetime('now','localtime'), missing_since = NULL,
                    raw_data_json = ?, updated_at = datetime('now','localtime')
                 WHERE id = ?`,
                [
                    ponPortId || existing.pon_port_id,
                    onu.onu_index || null,
                    onu.onu_id || null,
                    serialForUpdate,
                    onu.onu_name || null,
                    onu.vendor || null,
                    onu.model || null,
                    status,
                    onu.rx_power ?? null,
                    onu.tx_power ?? null,
                    onu.signal_quality || null,
                    onu.distance ?? null,
                    onu.mac_address || null,
                    onu.ip_address || null,
                    status === 'ONLINE' ? new Date().toISOString() : null,
                    stringifyJson(onu.raw || onu),
                    existing.id
                ]
            );
            const updated = await this.get('SELECT * FROM onus WHERE id = ?', [existing.id]);
            return { previous: existing, current: updated, created: false };
        }

        let serialForInsert = normalizedSn;
        if (serialForInsert) {
            const serialOwner = await this.get(
                'SELECT id FROM onus WHERE olt_id = ? AND onu_sn = ? LIMIT 1',
                [oltId, serialForInsert]
            );
            if (serialOwner) serialForInsert = null;
        }
        const result = await this.run(
            `INSERT INTO onus (
                olt_id, pon_port_id, onu_index, onu_id, onu_sn, onu_name, vendor, model,
                status, rx_power, tx_power, signal_quality, distance, mac_address, ip_address,
                last_seen, last_polled_at, raw_data_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), ?)`,
            [
                oltId,
                ponPortId || null,
                lookup ? String(onu.onu_index || lookup) : null,
                onu.onu_id || null,
                serialForInsert,
                onu.onu_name || null,
                onu.vendor || null,
                onu.model || null,
                status,
                onu.rx_power ?? null,
                onu.tx_power ?? null,
                onu.signal_quality || null,
                onu.distance ?? null,
                onu.mac_address || null,
                onu.ip_address || null,
                status === 'ONLINE' ? new Date().toISOString() : null,
                stringifyJson(onu.raw || onu)
            ]
        );
        const current = await this.get('SELECT * FROM onus WHERE id = ?', [result.id]);
        return { previous: null, current, created: true };
    }

    async addOnuHistory(onu) {
        return this.run(
            `INSERT INTO onu_histories (onu_id, status, rx_power, tx_power, distance)
             VALUES (?, ?, ?, ?, ?)`,
            [onu.id, onu.status || 'UNKNOWN', onu.rx_power ?? null, onu.tx_power ?? null, onu.distance ?? null]
        );
    }

    async markMissingOnus(oltId, seenIds) {
        if (!seenIds.length) {
            await this.run(
                `UPDATE onus SET status = 'OFFLINE', missing_since = COALESCE(missing_since, datetime('now','localtime')),
                    updated_at = datetime('now','localtime')
                 WHERE olt_id = ?`,
                [oltId]
            );
            return;
        }
        const placeholders = seenIds.map(() => '?').join(',');
        await this.run(
            `UPDATE onus SET status = 'OFFLINE', missing_since = COALESCE(missing_since, datetime('now','localtime')),
                updated_at = datetime('now','localtime')
             WHERE olt_id = ? AND id NOT IN (${placeholders})`,
            [oltId, ...seenIds]
        );
    }

    async clearMissingFlags(oltId) {
        return this.run(
            `UPDATE onus SET missing_since = NULL, updated_at = datetime('now','localtime') WHERE olt_id = ?`,
            [oltId]
        );
    }

    async deleteOnusNotSeen(oltId, seenIds) {
        if (!seenIds.length) return { changes: 0 };
        const placeholders = seenIds.map(() => '?').join(',');
        return this.run(
            `DELETE FROM onus WHERE olt_id = ? AND id NOT IN (${placeholders})`,
            [oltId, ...seenIds]
        );
    }

    async listOnus(filters = {}) {
        const where = [];
        const params = [];
        if (filters.olt_id) {
            where.push('o.olt_id = ?');
            params.push(filters.olt_id);
        }
        if (filters.status) {
            where.push('o.status = ?');
            params.push(String(filters.status).toUpperCase());
        }
        if (filters.vendor) {
            where.push('LOWER(o.vendor) = LOWER(?)');
            params.push(filters.vendor);
        }
        if (filters.model) {
            where.push('LOWER(o.model) LIKE LOWER(?)');
            params.push(`%${filters.model}%`);
        }
        if (filters.pon) {
            where.push('(pp.pon = ? OR pp.name = ?)');
            params.push(filters.pon, filters.pon);
        }
        if (filters.customer) {
            where.push('(LOWER(c.name) LIKE LOWER(?) OR LOWER(c.username) LIKE LOWER(?))');
            params.push(`%${filters.customer}%`, `%${filters.customer}%`);
        }
        return this.all(
            `SELECT o.*, olt.name AS olt_name, olt.vendor AS olt_vendor,
                    pp.slot, pp.pon, pp.name AS pon_name,
                    c.id AS customer_id, c.name AS customer_name, c.username AS customer_username
             FROM onus o
             JOIN olts olt ON olt.id = o.olt_id
             LEFT JOIN pon_ports pp ON pp.id = o.pon_port_id
             LEFT JOIN customers c ON c.onu_id = o.id OR (c.olt_id = o.olt_id AND c.onu_sn = o.onu_sn)
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY olt.name COLLATE NOCASE, pp.slot, pp.pon, o.onu_index
             LIMIT ? OFFSET ?`,
            [...params, Number(filters.limit) || 500, Number(filters.offset) || 0]
        );
    }

    async getOnuById(id) {
        return this.get(
            `SELECT o.*, olt.name AS olt_name, pp.slot, pp.pon, c.id AS customer_id, c.name AS customer_name
             FROM onus o
             JOIN olts olt ON olt.id = o.olt_id
             LEFT JOIN pon_ports pp ON pp.id = o.pon_port_id
             LEFT JOIN customers c ON c.onu_id = o.id
             WHERE o.id = ?`,
            [id]
        );
    }

    async getOnuStatusCounts(oltId) {
        return this.get(
            `SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'ONLINE' THEN 1 ELSE 0 END) AS online,
                SUM(CASE WHEN status IN ${OFFLINE_STATUS_SQL} THEN 1 ELSE 0 END) AS offline,
                SUM(CASE WHEN status = 'UNKNOWN' THEN 1 ELSE 0 END) AS unknown
             FROM onus
             WHERE olt_id = ?`,
            [oltId]
        );
    }

    async getOnuHistory(onuId, limit = 100) {
        return this.all(
            'SELECT * FROM onu_histories WHERE onu_id = ? ORDER BY created_at DESC LIMIT ?',
            [onuId, Number(limit) || 100]
        );
    }

    async updateOnuLocal(id, data) {
        await this.run(
            `UPDATE onus SET
                onu_name = COALESCE(?, onu_name),
                model = COALESCE(?, model),
                ip_address = COALESCE(?, ip_address),
                updated_at = datetime('now','localtime')
             WHERE id = ?`,
            [
                data.onu_name || null,
                data.model || null,
                data.ip_address || null,
                id
            ]
        );
        return this.getOnuById(id);
    }

    async createAlert(alert) {
        return this.run(
            `INSERT INTO alerts (olt_id, onu_id, level, title, message, status)
             VALUES (?, ?, ?, ?, ?, 'open')`,
            [alert.olt_id || null, alert.onu_id || null, alert.level || 'info', alert.title, alert.message || null]
        );
    }

    async getDashboardStats() {
        const _t = billingManager._tenantWhere();
        const tLit = _t.sql ? parseInt(_t.params[0], 10) : null;
        const tOlt = tLit ? ` AND tenant_id = ${tLit}` : '';
        const tJoin = tLit ? ` AND olt.tenant_id = ${tLit}` : '';
        return this.get(
            `SELECT
                (SELECT COUNT(*) FROM olts WHERE 1=1${tOlt}) AS total_olts,
                (SELECT COUNT(*) FROM onus onu INNER JOIN olts olt ON onu.olt_id = olt.id WHERE 1=1${tJoin}) AS total_onus,
                (SELECT COUNT(*) FROM onus onu INNER JOIN olts olt ON onu.olt_id = olt.id WHERE onu.status = 'ONLINE'${tJoin}) AS onu_online,
                (SELECT COUNT(*) FROM onus onu INNER JOIN olts olt ON onu.olt_id = olt.id WHERE onu.status IN ${OFFLINE_STATUS_SQL}${tJoin}) AS onu_offline,
                (SELECT COUNT(*) FROM alerts a INNER JOIN olts olt ON a.olt_id = olt.id WHERE a.status = 'open'${tJoin}) AS open_alerts`
        );
    }

    async getChartData() {
        const _t = billingManager._tenantWhere('olt');
        const whereOlt = _t.sql ? `WHERE 1=1${_t.sql}` : '';
        const perOlt = await this.all(
            `SELECT olt.name,
                    SUM(CASE WHEN o.status = 'ONLINE' THEN 1 ELSE 0 END) AS online,
                    SUM(CASE WHEN o.status IN ${OFFLINE_STATUS_SQL} THEN 1 ELSE 0 END) AS offline
             FROM olts olt
             LEFT JOIN onus o ON o.olt_id = olt.id
             ${whereOlt}
             GROUP BY olt.id
             ORDER BY olt.name COLLATE NOCASE`,
            [..._t.params]
        );
        const trend = await this.all(
            `SELECT date(created_at) AS day,
                    SUM(CASE WHEN status = 'ONLINE' THEN 1 ELSE 0 END) AS online,
                    SUM(CASE WHEN status = 'LOS' THEN 1 ELSE 0 END) AS los
             FROM onu_histories
             WHERE created_at >= datetime('now','localtime','-14 days')
             GROUP BY date(created_at)
             ORDER BY day`
        );
        return { perOlt, trend };
    }

    async enqueueSyncJob(oltId, jobType = 'manual_sync', priority = 1) {
        await this.recoverStaleSyncJobs();
        const existing = await this.get(
            `SELECT id, status FROM olt_sync_jobs
             WHERE olt_id = ? AND job_type IN ('sync', 'manual_sync') AND status IN ('queued', 'running')
             ORDER BY created_at DESC
             LIMIT 1`,
            [oltId]
        );
        if (existing) {
            if (existing.status === 'queued') {
                await this.run(
                    `UPDATE olt_sync_jobs
                     SET job_type = ?, priority = MIN(priority, ?), run_after = datetime('now','localtime'),
                         updated_at = datetime('now','localtime')
                     WHERE id = ?`,
                    [jobType, priority, existing.id]
                );
            }
            return existing.id;
        }

        const result = await this.run(
            `INSERT INTO olt_sync_jobs (olt_id, job_type, priority, status, error_message, run_after)
             VALUES (?, ?, ?, 'queued', NULL, datetime('now','localtime'))`,
            [oltId, jobType, priority]
        );
        return result.id;
    }

    async enqueueDueJobs() {
        await this.recoverStaleSyncJobs();
        const olts = await this.all(
            `SELECT id FROM olts
             WHERE status IN ('active', 'connected')
               AND (
                   last_sync IS NULL
                   OR datetime(last_sync, '+' || polling_interval || ' minutes') <= datetime('now','localtime')
               )
               AND NOT EXISTS (
                   SELECT 1 FROM olt_sync_jobs j
                   WHERE j.olt_id = olts.id AND j.status IN ('queued', 'running')
               )
               AND NOT EXISTS (
                   SELECT 1 FROM olt_sync_jobs recent_failed
                   WHERE recent_failed.olt_id = olts.id
                     AND recent_failed.status = 'failed'
                     AND datetime(recent_failed.updated_at, '+15 minutes') > datetime('now','localtime')
               )`
        );
        for (const olt of olts) {
            await this.enqueueSyncJob(olt.id, 'sync', 5);
        }
        return olts.length;
    }

    async claimNextJob(workerId) {
        await this.recoverStaleSyncJobs();
        const job = await this.get(
            `SELECT * FROM olt_sync_jobs
             WHERE status = 'queued' AND datetime(run_after) <= datetime('now','localtime')
             ORDER BY priority ASC, created_at ASC
             LIMIT 1`
        );
        if (!job) return null;
        const result = await this.run(
            `UPDATE olt_sync_jobs SET status = 'running', locked_at = datetime('now','localtime'),
                locked_by = ?, attempts = attempts + 1, updated_at = datetime('now','localtime')
             WHERE id = ? AND status = 'queued'`,
            [workerId, job.id]
        );
        return result.changes ? this.get('SELECT * FROM olt_sync_jobs WHERE id = ?', [job.id]) : null;
    }

    async recoverStaleSyncJobs() {
        await this.run(
            `UPDATE olt_sync_jobs
             SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
                 error_message = COALESCE(error_message, 'Sync job timed out/stale'),
                 run_after = CASE WHEN attempts < max_attempts THEN datetime('now','localtime') ELSE run_after END,
                 updated_at = datetime('now','localtime')
             WHERE status = 'running'
               AND locked_at IS NOT NULL
               AND datetime(locked_at, '+5 minutes') < datetime('now','localtime')`
        );
        await this.run(
            `UPDATE olt_sync_jobs
             SET status = 'failed',
                 error_message = COALESCE(error_message, 'Superseded by newer pending sync job'),
                 updated_at = datetime('now','localtime')
             WHERE status = 'queued'
               AND job_type IN ('sync', 'manual_sync')
               AND id NOT IN (
                   SELECT MAX(id)
                   FROM olt_sync_jobs
                   WHERE status = 'queued' AND job_type IN ('sync', 'manual_sync')
                   GROUP BY olt_id
               )`
        );
        return this.run(
            `UPDATE olt_sync_runs
             SET status = 'failed',
                 finished_at = datetime('now','localtime'),
                 error_message = COALESCE(error_message, 'Sync run timed out/stale')
             WHERE status = 'running'
               AND datetime(started_at, '+5 minutes') < datetime('now','localtime')`
        );
    }

    async completeJob(jobId) {
        return this.run(
            `UPDATE olt_sync_jobs SET status = 'completed', updated_at = datetime('now','localtime') WHERE id = ?`,
            [jobId]
        );
    }

    async failJob(job, errorMessage) {
        const shouldRetry = Number(job.attempts || 0) < Number(job.max_attempts || 3);
        const delayMinutes = shouldRetry ? Math.min(Number(job.attempts || 1) * 2, 10) : 15;
        return this.run(
            `UPDATE olt_sync_jobs SET status = ?, error_message = ?, run_after = datetime('now','localtime','+' || ? || ' minutes'),
                updated_at = datetime('now','localtime') WHERE id = ?`,
            [shouldRetry ? 'queued' : 'failed', String(errorMessage || '').slice(0, 1000), delayMinutes, job.id]
        );
    }

    async getSyncJobStatus(jobId) {
        await this.recoverStaleSyncJobs();
        const job = await this.get(
            `SELECT j.*, o.name AS olt_name, o.ip_address AS olt_ip
             FROM olt_sync_jobs j
             JOIN olts o ON o.id = j.olt_id
             WHERE j.id = ?`,
            [jobId]
        );
        if (!job) return null;

        const run = await this.get(
            `SELECT *
             FROM olt_sync_runs
             WHERE job_id = ?
             ORDER BY id DESC
             LIMIT 1`,
            [jobId]
        );

        return {
            job,
            run,
            status: run?.status || job.status,
            error_message: run?.error_message || job.error_message || null,
            stats: run ? {
                pon_count: run.pon_count || 0,
                onu_count: run.onu_count || 0,
                online_count: run.online_count || 0,
                offline_count: run.offline_count || 0
            } : null
        };
    }

    async startSyncRun(oltId, jobId) {
        const result = await this.run(
            `INSERT INTO olt_sync_runs (olt_id, job_id, status) VALUES (?, ?, 'running')`,
            [oltId, jobId || null]
        );
        return result.id;
    }

    async finishSyncRun(runId, status, stats = {}, errorMessage = null) {
        return this.run(
            `UPDATE olt_sync_runs SET finished_at = datetime('now','localtime'), status = ?,
                pon_count = ?, onu_count = ?, online_count = ?, offline_count = ?, error_message = ?
             WHERE id = ?`,
            [
                status,
                Number(stats.pon_count) || 0,
                Number(stats.onu_count) || 0,
                Number(stats.online_count) || 0,
                Number(stats.offline_count) || 0,
                errorMessage ? String(errorMessage).slice(0, 1000) : null,
                runId
            ]
        );
    }

    async mapCustomerToOnu(customerId, onuId) {
        const onu = await this.getOnuById(onuId);
        if (!onu) throw new Error('ONU not found');
        await this.run(
            `UPDATE customers SET onu_id = ?, olt_id = ?, pon_port = ?, onu_sn = ? WHERE id = ?`,
            [onu.id, onu.olt_id, [onu.slot, onu.pon].filter(Boolean).join('/'), onu.onu_sn, customerId]
        );
        return onu;
    }
}

module.exports = OltRepository;
