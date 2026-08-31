'use strict';

/**
 * Captive-portal isolir: HTML cepat untuk probe HP + DNS sinkhole khusus klien isolir.
 * Probe OS (generate_204 / hotspot-detect) punya timeout pendek — jangan query DB.
 */
const dgram = require('dgram');
const logger = require('./logger');

const DNS_PORT = parseInt(process.env.ISOLIR_DNS_PORT || '5353', 10) || 5353;

const CAPTIVE_PROBE_PATHS = [
    '/hotspot-detect.html',
    '/library/test/success.html',
    '/generate_204',
    '/gen_204',
    '/generate204',
    '/connecttest.txt',
    '/ncsi.txt',
    '/canonical.html',
    '/success.txt',
    '/kindle-wifi/wifiredirect.html',
    '/kindle-wifi/wifistub.html',
    '/check_network_status.txt'
];

const DNS_PASSTHROUGH_SUFFIXES = [
    'whatsapp.com',
    'whatsapp.net',
    'facebook.com',
    'facebook.net',
    'fbcdn.net',
    'fbsbx.com'
];

function isCaptiveProbePath(urlPath) {
    const p = String(urlPath || '').split('?')[0].toLowerCase();
    return CAPTIVE_PROBE_PATHS.some((x) => p === x || p.endsWith(x));
}

function noCacheHeaders(res) {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
        'Connection': 'close',
        'Captive-Portal': 'true'
    });
}

function trampolineHtml(isolirHref) {
    const href = isolirHref || '/isolir';
    return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0;url=${href}">
  <title>Login WiFi</title>
</head>
<body style="font-family:sans-serif;padding:24px;text-align:center">
  <p>Koneksi internet dibatasi (isolir).</p>
  <p><a href="${href}">Buka halaman isolir</a></p>
  <script>location.replace(${JSON.stringify(href)});</script>
</body>
</html>`;
}

async function resolveTenantQuery(req) {
    try {
        const vpnService = require('./platform/vpnService');
        const remoteIp = String(
            (req.headers['x-forwarded-for'] || '').split(',')[0] ||
            req.ip ||
            req.socket?.remoteAddress ||
            ''
        ).trim().replace(/^::ffff:/, '');
        if (!remoteIp) return '';
        const peer = await vpnService.getPeerByTunnelIp(remoteIp);
        const tid = Number(peer?.tenant_id);
        return Number.isFinite(tid) && tid > 0 ? `?tenant=${tid}` : '';
    } catch (_) {
        return '';
    }
}

function captiveProbeMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const pathOnly = String(req.path || req.url || '').split('?')[0];
    if (!isCaptiveProbePath(pathOnly)) {
        return next();
    }
    // `/` juga trampoline cepat — OS kadang probe root; halaman lengkap tetap di /isolir
    const handle = async () => {
        const qs = await resolveTenantQuery(req);
        const href = `/isolir${qs}`;
        noCacheHeaders(res);
        res.status(200).type('html').send(trampolineHtml(href));
    };
    handle().catch(() => {
        noCacheHeaders(res);
        res.status(200).type('html').send(trampolineHtml('/isolir'));
    });
}

function rootTrampolineMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const pathOnly = String(req.path || req.url || '').split('?')[0];
    if (pathOnly !== '/' && pathOnly !== '') return next();
    const handle = async () => {
        const qs = await resolveTenantQuery(req);
        const href = `/isolir${qs}`;
        noCacheHeaders(res);
        res.status(200).type('html').send(trampolineHtml(href));
    };
    handle().catch(() => {
        noCacheHeaders(res);
        res.status(200).type('html').send(trampolineHtml('/isolir'));
    });
}

function isolirNoCacheMiddleware(req, res, next) {
    noCacheHeaders(res);
    next();
}

function readDnsName(buf, offset) {
    const labels = [];
    let pos = offset;
    let end = offset;
    let jumped = false;
    for (let i = 0; i < 64; i++) {
        if (pos >= buf.length) break;
        const len = buf[pos];
        if (len === 0) {
            pos += 1;
            if (!jumped) end = pos;
            break;
        }
        if ((len & 0xc0) === 0xc0) {
            if (pos + 1 >= buf.length) break;
            const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
            if (!jumped) end = pos + 2;
            pos = ptr;
            jumped = true;
            continue;
        }
        labels.push(buf.slice(pos + 1, pos + 1 + len).toString('ascii').toLowerCase());
        pos += 1 + len;
        if (!jumped) end = pos;
    }
    return { name: labels.join('.'), end };
}

function isPassthroughName(name) {
    const n = String(name || '').toLowerCase();
    return DNS_PASSTHROUGH_SUFFIXES.some((s) => n === s || n.endsWith(`.${s}`));
}

function buildFlags(byte2) {
    // QR=1, copy opcode/RD, RA=1, RCODE=0
    return 0x8180 | (byte2 & 0x0100);
}

function buildDnsAResponse(query, ipv4) {
    if (!query || query.length < 16) return null;
    const q = readDnsName(query, 12);
    if (!q.end || q.end + 4 > query.length) return null;
    const qtype = query.readUInt16BE(q.end);
    const question = query.slice(12, q.end + 4);
    const header = Buffer.alloc(12);
    query.copy(header, 0, 0, 12);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4); // QDCOUNT
    header.writeUInt16BE(0, 8); // NS
    header.writeUInt16BE(0, 10); // AR

    if (qtype === 28) {
        header.writeUInt16BE(0, 6); // AAAA NODATA
        return Buffer.concat([header, question]);
    }
    if (qtype !== 1) {
        header.writeUInt16BE(0, 6);
        header.writeUInt16BE(0x8184, 2); // NOTIMP
        return Buffer.concat([header, question]);
    }

    const oct = String(ipv4 || '103.132.40.78').split('.').map((n) => parseInt(n, 10) || 0);
    const answer = Buffer.alloc(16);
    answer.writeUInt16BE(0xc00c, 0);
    answer.writeUInt16BE(1, 2);
    answer.writeUInt16BE(1, 4);
    answer.writeUInt32BE(15, 6);
    answer.writeUInt16BE(4, 10);
    answer.writeUInt8(oct[0], 12);
    answer.writeUInt8(oct[1], 13);
    answer.writeUInt8(oct[2], 14);
    answer.writeUInt8(oct[3], 15);
    header.writeUInt16BE(1, 6);
    return Buffer.concat([header, question, answer]);
}

function startIsolirDnsServer(getSinkholeIp) {
    if (!DNS_PORT || DNS_PORT < 1) return null;
    const socket = dgram.createSocket('udp4');
    const forward = dgram.createSocket('udp4');
    const pending = new Map();

    forward.on('message', (msg, rinfo) => {
        if (!msg || msg.length < 2) return;
        const id = msg.readUInt16BE(0);
        const wait = pending.get(id);
        if (!wait) return;
        pending.delete(id);
        try {
            socket.send(msg, wait.port, wait.address);
        } catch (_) {}
    });

    socket.on('message', (msg, rinfo) => {
        try {
            if (!msg || msg.length < 16) return;
            const q = readDnsName(msg, 12);
            const id = msg.readUInt16BE(0);
            if (isPassthroughName(q.name)) {
                pending.set(id, { address: rinfo.address, port: rinfo.port, at: Date.now() });
                setTimeout(() => pending.delete(id), 1500);
                forward.send(msg, 53, '1.1.1.1');
                return;
            }
            const ip = typeof getSinkholeIp === 'function' ? getSinkholeIp() : getSinkholeIp;
            const reply = buildDnsAResponse(msg, ip || '103.132.40.78');
            if (reply) socket.send(reply, rinfo.port, rinfo.address);
        } catch (e) {
            logger.warn(`[ISOLIR-DNS] ${e.message}`);
        }
    });

    socket.on('error', (err) => {
        logger.warn(`[ISOLIR-DNS] ${err.message}`);
    });

    forward.bind(0, () => {
        socket.bind(DNS_PORT, '0.0.0.0', () => {
            logger.info(`✅ DNS isolir sinkhole aktif di udp/0.0.0.0:${DNS_PORT}`);
        });
    });

    return { socket, forward, port: DNS_PORT };
}

module.exports = {
    DNS_PORT,
    isCaptiveProbePath,
    captiveProbeMiddleware,
    isolirNoCacheMiddleware,
    rootTrampolineMiddleware,
    trampolineHtml,
    startIsolirDnsServer
};
