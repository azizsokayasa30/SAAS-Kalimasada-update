'use strict';

const { RouterOSAPI } = require('node-routeros');
const logger = require('./logger');

const COMMENT = 'KALIMASADA-LOCK-API';

function isIpv4(value) {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(value || '').trim());
    if (!match) return false;
    return match.slice(1).every((part) => {
        const n = Number(part);
        return n >= 0 && n <= 255;
    });
}

function normalizeIp(value) {
    const match = String(value || '').trim().match(/(\d{1,3}(?:\.\d{1,3}){3})/);
    if (!match || !isIpv4(match[1])) return '';
    if (match[1] === '0.0.0.0' || match[1] === '255.255.255.255') return '';
    return match[1];
}

function isPublicIpv4(value) {
    const ip = normalizeIp(value);
    if (!ip) return false;
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    return true;
}

function addIp(set, value) {
    const ip = normalizeIp(value);
    if (ip) set.add(ip);
}

async function configuredAllowIps() {
    const ips = new Set();
    try {
        const { getSetting } = require('./settingsManager');
        addIp(ips, getSetting('server_host', ''));
    } catch (_) {
        /* settings belum siap */
    }
    addIp(ips, process.env.KALIMASADA_SERVER_IP);
    addIp(ips, process.env.PUBLIC_APP_HOST);
    String(process.env.MIKROTIK_API_ALLOW_IPS || '')
        .split(/[\s,]+/)
        .forEach((item) => addIp(ips, item));
    try {
        const vpnService = require('./platform/vpnService');
        const server = await vpnService.getServer();
        if (server) {
            addIp(ips, server.public_endpoint);
            addIp(ips, server.tunnel_address);
        }
    } catch (err) {
        logger.warn(`[MIKROTIK-LOCK] IP VPN tidak dibaca: ${err.message}`);
    }
    return ips;
}

async function detectSessionSources(conn, port) {
    const wanted = new Set([String(port || 8728), '8728', '8729']);
    const found = new Set();
    let rows = [];
    try {
        rows = await conn.write('/ip/firewall/connection/print', ['?protocol=tcp', `?dst-port=${port || 8728}`]);
    } catch (err) {
        logger.warn(`[MIKROTIK-LOCK] connection print gagal: ${err.message}`);
        rows = [];
    }
    for (const row of rows || []) {
        const dst = String(row['dst-port'] || '');
        if (dst && !wanted.has(dst)) continue;
        addIp(found, row['src-address']);
    }
    if (String(port || 8728) !== '8729') {
        try {
            const sslRows = await conn.write('/ip/firewall/connection/print', ['?protocol=tcp', '?dst-port=8729']);
            for (const row of sslRows || []) addIp(found, row['src-address']);
        } catch (_) {
            /* api-ssl boleh tidak ada */
        }
    }
    return found;
}

function connectApi({ host, port, user, password }) {
    const conn = new RouterOSAPI({
        host,
        port,
        user,
        password,
        keepalive: false,
        timeout: 15,
    });
    const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Timeout koneksi API ke ${host}:${port}`)), 20000);
    });
    return Promise.race([conn.connect().then(() => conn), timeout]);
}

async function restrictApiServices(conn, allowIps) {
    const addressList = allowIps.map((ip) => `${ip}/32`).join(',');
    const services = await conn.write('/ip/service/print');
    const targets = (services || []).filter((row) => row.name === 'api' || row.name === 'api-ssl');
    if (!targets.length) {
        throw new Error('Service api / api-ssl tidak ditemukan di router.');
    }
    for (const svc of targets) {
        await conn.write('/ip/service/set', [
            `=.id=${svc['.id']}`,
            `=address=${addressList}`,
        ]);
    }
    return targets.map((row) => row.name);
}

/**
 * Batasi service API/API-SSL MikroTik ke IP server billing.
 * Winbox, SSH, dan trafik pelanggan tidak diubah.
 */
async function lockRouterApi(routerRow, options = {}) {
    const dryRun = !!options.dryRun;
    const confirm = !!options.confirm;
    if (!routerRow || !routerRow.nas_ip) {
        throw new Error('Data router tidak lengkap');
    }
    const host = String(routerRow.nas_ip).trim();
    const port = parseInt(routerRow.port || routerRow.nas_port || 8728, 10);
    const user = routerRow.user || routerRow.nas_user || routerRow.username;
    const password = routerRow.password || routerRow.secret || '';
    if (!user || !password) throw new Error('Username atau password API kosong');

    let conn = null;
    try {
        conn = await connectApi({ host, port, user, password });
        const sessionIps = await detectSessionSources(conn, port);
        const allow = new Set(sessionIps);
        const extras = await configuredAllowIps();
        extras.forEach((ip) => allow.add(ip));
        const allowList = [...allow].slice(0, 8);
        const publicNas = isPublicIpv4(host);
        const base = {
            success: true,
            dryRun,
            host,
            port,
            publicNas,
            sessionSources: [...sessionIps],
            allow: allowList,
        };

        if (!allowList.length) {
            return {
                ...base,
                success: false,
                message: 'IP server tidak terdeteksi. Isi server_host atau MIKROTIK_API_ALLOW_IPS sebelum mengunci API, supaya billing tidak terputus dari router.',
            };
        }

        const summary = allowList.join(', ');
        if (dryRun || !confirm) {
            return {
                ...base,
                message: publicNas
                    ? `NAS ${host} memakai IP publik. API akan dibatasi ke: ${summary}. Scanner internet tidak bisa login, Winbox tidak diubah.`
                    : `API akan dibatasi ke: ${summary}.`,
            };
        }

        if (sessionIps.size === 0) {
            return {
                ...base,
                success: false,
                message: `Sesi API dari server ini tidak terlihat di router. Kunci dibatalkan supaya ${host} tidak terkunci dari billing. Pastikan service connection tracking aktif, lalu coba lagi.`,
            };
        }

        const services = await restrictApiServices(conn, allowList);
        logger.info(`[MIKROTIK-LOCK] ${host}:${port} services=${services.join(',')} allow=${summary}`);
        return {
            ...base,
            services,
            message: `Port API ${host} dikunci. Hanya IP ini yang boleh login API/API-SSL: ${summary}. Winbox tidak diubah.`,
        };
    } finally {
        if (conn && typeof conn.close === 'function') {
            try { conn.close(); } catch (_) { /* socket sudah tertutup */ }
        }
    }
}

module.exports = {
    COMMENT,
    isPublicIpv4,
    isIpv4,
    lockRouterApi,
};
