'use strict';

/**
 * Baileys multi-tenant session registry.
 * Each tenant gets: whatsapp-session/tenant-{id}/ + its own sock.
 * Legacy (no tenantId) uses whatsapp-session/ for bot/inbound.
 */
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { getSetting } = require('./settingsManager');
const logger = require('./logger');
const {
    getBaseSessionPath,
    sessionPathFor,
    normalizeTenantId,
    sessionKeyFor
} = require('./baileys-config');

/** Reconnect dengan creds — batasi agar tidak banjir socket */
const MAX_CONCURRENT_CONNECTING = 2;
/** Connect untuk scan QR — jangan terlalu banyak (WA sering 405 jika banjir dari 1 IP) */
const MAX_CONCURRENT_QR_CONNECTING = 3;
const DEFAULT_RECONNECT_MS = 12000;
const MAX_RECONNECT_MS = 180000;
const KEEP_ALIVE_MS = 25000;
const BAD_SESSION_WIPE_AFTER = 3;
const QR_QUEUE_RETRY_MS = 4000;
/** Versi WA Web known-good (fetchLatestBaileysVersion 2026-08); hindari fallback usang → 405 */
const FALLBACK_WA_VERSION = [2, 3000, 1043857760];
const METHOD_NOT_ALLOWED = 405;

/** @type {Map<string, object>} */
const sessions = new Map();

let makeWASocket = null;
let DisconnectReason = null;
let useMultiFileAuthState = null;
let fetchLatestWaWebVersion = null;
let fetchLatestBaileysVersion = null;
let baileysLoadPromise = null;
let connectingCount = 0;
/** @type {{ version: number[], source: string, fetchedAt: number } | null} */
let cachedWaVersion = null;

async function ensureBaileysLoaded() {
    if (makeWASocket && DisconnectReason && useMultiFileAuthState) {
        return;
    }
    try {
        const baileys = require('@whiskeysockets/baileys');
        makeWASocket = baileys.default;
        DisconnectReason = baileys.DisconnectReason;
        useMultiFileAuthState = baileys.useMultiFileAuthState;
        fetchLatestWaWebVersion = baileys.fetchLatestWaWebVersion;
        fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
        if (makeWASocket && useMultiFileAuthState) return;
    } catch (_) { /* ESM fallback */ }

    if (!baileysLoadPromise) {
        baileysLoadPromise = import('@whiskeysockets/baileys').then((baileys) => {
            makeWASocket = baileys.default || baileys.makeWASocket;
            DisconnectReason = baileys.DisconnectReason;
            useMultiFileAuthState = baileys.useMultiFileAuthState;
            fetchLatestWaWebVersion = baileys.fetchLatestWaWebVersion;
            fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
            if (!makeWASocket || !useMultiFileAuthState) {
                throw new Error('Export Baileys tidak lengkap');
            }
        }).catch((err) => {
            baileysLoadPromise = null;
            throw err;
        });
    }
    return baileysLoadPromise;
}

function parseEnvWaVersion() {
    const raw = String(process.env.WA_BAILEYS_VERSION || '').trim();
    if (!raw) return null;
    const parts = raw.split(/[.,\s]+/).map((n) => parseInt(n, 10));
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
        return parts.slice(0, 3);
    }
    return null;
}

/**
 * Ambil versi WA yang diterima server. fetchLatestWaWebVersion sering 429 → fallback usang → 405 loop.
 * Prioritas: env → cache → fetchLatestBaileysVersion → fetchLatestWaWebVersion (jika isLatest) → FALLBACK.
 */
async function resolveWaVersion(forceRefresh = false) {
    const envVer = parseEnvWaVersion();
    if (envVer) {
        return { version: envVer, source: 'env' };
    }

    if (
        !forceRefresh &&
        cachedWaVersion &&
        Array.isArray(cachedWaVersion.version) &&
        Date.now() - cachedWaVersion.fetchedAt < 6 * 60 * 60 * 1000
    ) {
        return cachedWaVersion;
    }

    await ensureBaileysLoaded();

    if (typeof fetchLatestBaileysVersion === 'function') {
        try {
            const info = await fetchLatestBaileysVersion();
            if (info?.version?.length >= 3 && info.isLatest !== false) {
                cachedWaVersion = {
                    version: info.version,
                    source: 'baileys',
                    fetchedAt: Date.now()
                };
                return cachedWaVersion;
            }
            if (info?.version?.length >= 3) {
                cachedWaVersion = {
                    version: info.version,
                    source: 'baileys-cached',
                    fetchedAt: Date.now()
                };
                return cachedWaVersion;
            }
        } catch (err) {
            logger.warn(`⚠️ fetchLatestBaileysVersion gagal: ${err.message}`);
        }
    }

    if (typeof fetchLatestWaWebVersion === 'function') {
        try {
            const info = await fetchLatestWaWebVersion();
            // Abaikan hasil 429/stale (isLatest:false) — itu penyebab utama 405
            if (info?.version?.length >= 3 && info.isLatest === true && !info.error) {
                cachedWaVersion = {
                    version: info.version,
                    source: 'wa-web',
                    fetchedAt: Date.now()
                };
                return cachedWaVersion;
            }
            if (info?.error) {
                logger.warn(
                    `⚠️ fetchLatestWaWebVersion stale/error — pakai fallback (isLatest=${info.isLatest})`
                );
            }
        } catch (err) {
            logger.warn(`⚠️ fetchLatestWaWebVersion gagal: ${err.message}`);
        }
    }

    cachedWaVersion = {
        version: FALLBACK_WA_VERSION.slice(),
        source: 'fallback',
        fetchedAt: Date.now()
    };
    return cachedWaVersion;
}

function invalidateWaVersionCache() {
    cachedWaVersion = null;
}

function getOrCreateEntry(tenantId) {
    const key = sessionKeyFor(tenantId);
    if (!sessions.has(key)) {
        sessions.set(key, {
            key,
            tenantId: normalizeTenantId(tenantId),
            sock: null,
            status: 'disconnected',
            qrCode: null,
            qrUpdatedAt: null,
            phoneNumber: null,
            connectedSince: null,
            isConnecting: false,
            keepAliveTimer: null,
            reconnectTimer: null,
            sessionDir: sessionPathFor(tenantId),
            reason: null,
            reconnectAttempt: 0,
            badSessionStreak: 0,
            methodNotAllowedStreak: 0,
            lastDisconnectAt: null,
            lastConnectedAt: null
        });
    }
    const entry = sessions.get(key);
    entry.sessionDir = sessionPathFor(tenantId);
    return entry;
}

function getStatus(tenantId) {
    const entry = getOrCreateEntry(tenantId);
    const qrAgeMs = entry.qrUpdatedAt ? Date.now() - entry.qrUpdatedAt : null;
    // QR Baileys kadaluarsa ~60s — jangan sajikan yang sudah basi
    const qrFresh = !!(entry.qrCode && qrAgeMs != null && qrAgeMs < 55000);
    if (entry.qrCode && !qrFresh) {
        entry.qrCode = null;
        entry.qrUpdatedAt = null;
        if (entry.status === 'qr_code') entry.status = 'connecting';
    }
    return {
        connected: entry.status === 'connected' && !!entry.sock,
        status: entry.status,
        qrCode: qrFresh ? entry.qrCode : null,
        qr: qrFresh ? entry.qrCode : null,
        qrUpdatedAt: qrFresh ? entry.qrUpdatedAt : null,
        qrAgeMs: qrFresh ? qrAgeMs : null,
        phoneNumber: entry.phoneNumber,
        connectedSince: entry.connectedSince,
        reason: entry.reason,
        tenantId: entry.tenantId,
        sessionDir: entry.sessionDir,
        hasCreds: hasCreds(tenantId),
        reconnectAttempt: entry.reconnectAttempt || 0,
        lastDisconnectAt: entry.lastDisconnectAt || null,
        isConnecting: !!entry.isConnecting,
        connectingCount
    };
}

/**
 * Alert untuk dashboard admin: hanya relevan jika tenant memakai Baileys.
 */
async function getDashboardAlertForTenant(tenantId) {
    const tid = normalizeTenantId(tenantId);
    if (!tid) return null;

    let activeProvider = null;
    let baileysEnabled = false;
    try {
        const { getFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
        const { getWhatsAppProviderSettingsFromObject } = require('./whatsapp-provider-settings');
        const ts = await getFullSettingsForTenantId(tid);
        const ps = getWhatsAppProviderSettingsFromObject(ts || {});
        activeProvider = ps?.activeProvider || null;
        baileysEnabled = !!(ps?.baileys && ps.baileys.enabled) || activeProvider === 'baileys';
    } catch (_) {
        return null;
    }

    if (activeProvider !== 'baileys' && !baileysEnabled) {
        return null;
    }

    const st = getStatus(tid);
    if (st.connected) {
        return {
            level: 'ok',
            connected: true,
            phoneNumber: st.phoneNumber,
            message: null
        };
    }

    const needsScan = !st.hasCreds || st.status === 'qr_code' || /logged out|logout/i.test(String(st.reason || ''));
    return {
        level: needsScan ? 'danger' : 'warning',
        connected: false,
        phoneNumber: null,
        status: st.status,
        reason: st.reason,
        hasCreds: st.hasCreds,
        needsScan,
        message: needsScan
            ? 'Koneksi WhatsApp (Baileys) terputus dan perlu scan QR ulang. Buka WhatsApp Settings untuk menghubungkan kembali.'
            : 'Koneksi WhatsApp (Baileys) terputus. Sistem sedang mencoba menghubungkan ulang otomatis — cek WhatsApp Settings jika belum pulih.'
    };
}

function getSock(tenantId) {
    const entry = sessions.get(sessionKeyFor(tenantId));
    if (!entry || !entry.sock) return null;
    if (entry.status !== 'connected') return null;
    try {
        if (entry.sock.user && entry.sock.user.id) return entry.sock;
    } catch (_) {
        return null;
    }
    return entry.sock;
}

function listActive() {
    const out = [];
    for (const entry of sessions.values()) {
        if (entry.status === 'connected' && entry.sock) {
            out.push({
                tenantId: entry.tenantId,
                key: entry.key,
                phoneNumber: entry.phoneNumber,
                sessionDir: entry.sessionDir
            });
        }
    }
    return out;
}

function hasCreds(tenantId) {
    const dir = sessionPathFor(tenantId);
    return fs.existsSync(path.join(dir, 'creds.json'));
}

function stopKeepAlive(entry) {
    if (entry.keepAliveTimer) {
        clearInterval(entry.keepAliveTimer);
        entry.keepAliveTimer = null;
    }
}

function startKeepAlive(entry) {
    stopKeepAlive(entry);
    entry.keepAliveTimer = setInterval(async () => {
        try {
            if (!entry.sock || entry.status !== 'connected') {
                stopKeepAlive(entry);
                if (hasCreds(entry.tenantId) || entry.tenantId == null) {
                    scheduleReconnect(entry, DEFAULT_RECONNECT_MS);
                }
                return;
            }
            // Presence + lightweight ping agar sesi tidak idle-timeout
            if (typeof entry.sock.sendPresenceUpdate === 'function') {
                await entry.sock.sendPresenceUpdate('available').catch(() => {});
            }
            // Pastikan user masih terbaca; jika tidak, anggap putus
            if (!entry.sock.user || !entry.sock.user.id) {
                entry.status = 'disconnected';
                entry.reason = 'keep_alive_user_missing';
                entry.lastDisconnectAt = new Date().toISOString();
                stopKeepAlive(entry);
                scheduleReconnect(entry, DEFAULT_RECONNECT_MS);
            }
        } catch (err) {
            logger.warn(`⚠️ Baileys keep-alive ${entry.key}: ${err.message}`);
            entry.status = 'disconnected';
            entry.reason = err.message;
            entry.lastDisconnectAt = new Date().toISOString();
            stopKeepAlive(entry);
            scheduleReconnect(entry, DEFAULT_RECONNECT_MS);
        }
    }, KEEP_ALIVE_MS);
}

function clearReconnect(entry) {
    if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = null;
    }
}

function scheduleReconnect(entry, delayMs) {
    clearReconnect(entry);
    const attempt = (entry.reconnectAttempt || 0) + 1;
    entry.reconnectAttempt = attempt;
    // Exponential backoff + jitter, capped — tetap pakai creds yang ada
    const base = delayMs || DEFAULT_RECONNECT_MS;
    const expo = Math.min(MAX_RECONNECT_MS, base * Math.pow(1.6, Math.min(attempt - 1, 8)));
    const jitter = Math.floor(Math.random() * 4000);
    const wait = Math.max(3000, Math.floor(expo) + jitter);
    entry.status = entry.status === 'qr_code' ? 'qr_code' : 'reconnecting';
    entry.reconnectTimer = setTimeout(() => {
        entry.reconnectTimer = null;
        connect(entry.tenantId).catch((err) => {
            logger.warn(`⚠️ Baileys reconnect tenant=${entry.tenantId ?? 'legacy'} gagal: ${err.message}`);
            scheduleReconnect(entry, DEFAULT_RECONNECT_MS);
        });
    }, wait);
}

/** Antrean singkat tanpa naikkan reconnectAttempt (khusus tunggu slot connect / QR). */
function scheduleQueuedConnect(entry, delayMs = QR_QUEUE_RETRY_MS) {
    clearReconnect(entry);
    entry.status = entry.qrCode ? 'qr_code' : 'queued';
    entry.reason = entry.reason || 'max_concurrent_connecting';
    entry.reconnectTimer = setTimeout(() => {
        entry.reconnectTimer = null;
        connect(entry.tenantId).catch((err) => {
            logger.warn(`⚠️ Baileys queued connect tenant=${entry.tenantId ?? 'legacy'} gagal: ${err.message}`);
            scheduleQueuedConnect(entry, QR_QUEUE_RETRY_MS);
        });
    }, Math.max(500, delayMs));
}

function resetSessionDirectory(sessionDir) {
    try {
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        fs.mkdirSync(sessionDir, { recursive: true });
    } catch (err) {
        logger.warn(`⚠️ Gagal reset session dir ${sessionDir}: ${err.message}`);
    }
}

function writeTenantMeta(tenantId, sessionDir) {
    const tid = normalizeTenantId(tenantId);
    if (!tid) return;
    try {
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(
            path.join(sessionDir, 'owner-tenant.json'),
            JSON.stringify({
                tenantId: tid,
                claimedAt: new Date().toISOString(),
                source: 'baileys-session-registry'
            }, null, 2),
            'utf8'
        );
    } catch (err) {
        logger.warn(`⚠️ Gagal tulis owner meta tenant ${tid}: ${err.message}`);
    }
}

/**
 * Migrate root whatsapp-session/ (legacy shared) → tenant-{owner}/ once.
 */
function migrateLegacyOwnerIfNeeded() {
    const base = getBaseSessionPath();
    const rootCreds = path.join(base, 'creds.json');
    const rootOwner = path.join(base, 'owner-tenant.json');

    if (!fs.existsSync(rootCreds)) {
        return { migrated: false, reason: 'no_root_creds' };
    }

    let ownerId = null;
    try {
        if (fs.existsSync(rootOwner)) {
            const raw = JSON.parse(fs.readFileSync(rootOwner, 'utf8'));
            ownerId = normalizeTenantId(raw && raw.tenantId);
        }
    } catch (_) { /* ignore */ }

    if (!ownerId) {
        return { migrated: false, reason: 'no_owner_id' };
    }

    const dest = sessionPathFor(ownerId);
    const destCreds = path.join(dest, 'creds.json');
    if (fs.existsSync(destCreds)) {
        // Already migrated; clean leftover root auth files (keep tenant-* dirs)
        cleanupRootAuthFiles(base);
        return { migrated: false, reason: 'dest_already_has_creds', tenantId: ownerId };
    }

    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(base, { withFileTypes: true });
    for (const ent of entries) {
        if (ent.name.startsWith('tenant-')) continue;
        const src = path.join(base, ent.name);
        const dst = path.join(dest, ent.name);
        try {
            fs.renameSync(src, dst);
        } catch (err) {
            logger.warn(`⚠️ Migrate move ${ent.name} gagal: ${err.message}`);
        }
    }
    writeTenantMeta(ownerId, dest);
    logger.info(`✅ Migrasi Baileys legacy → tenant-${ownerId}`);
    return { migrated: true, tenantId: ownerId, sessionDir: dest };
}

function cleanupRootAuthFiles(base) {
    try {
        const entries = fs.readdirSync(base, { withFileTypes: true });
        for (const ent of entries) {
            if (ent.isDirectory()) continue;
            if (ent.name.startsWith('tenant-')) continue;
            try {
                fs.unlinkSync(path.join(base, ent.name));
            } catch (_) { /* ignore */ }
        }
    } catch (_) { /* ignore */ }
}

async function connect(tenantId = null) {
    const entry = getOrCreateEntry(tenantId);
    const label = entry.tenantId ? `tenant-${entry.tenantId}` : 'legacy';
    const needsQr = !hasCreds(tenantId);
    const maxSlots = needsQr ? MAX_CONCURRENT_QR_CONNECTING : MAX_CONCURRENT_CONNECTING;

    if (entry.isConnecting) {
        logger.info(`⏳ Baileys ${label} sedang connecting, skip`);
        return entry.sock;
    }

    if (entry.sock && entry.status === 'connected') {
        try {
            if (entry.sock.user && entry.sock.user.id) {
                return entry.sock;
            }
        } catch (_) { /* reconnect */ }
    }

    // QR segar + socket masih hidup — jangan restart (QR hangus / picu 405)
    if (
        needsQr &&
        entry.sock &&
        entry.qrCode &&
        entry.qrUpdatedAt &&
        Date.now() - entry.qrUpdatedAt < 50000 &&
        entry.status === 'qr_code'
    ) {
        return entry.sock;
    }

    // Sudah dijadwalkan reconnect — biarkan timer, jangan dobel-kick dari poll UI
    if (entry.reconnectTimer && !entry.sock && !entry.isConnecting) {
        if (!entry.status || entry.status === 'disconnected') {
            entry.status = needsQr ? 'queued' : 'reconnecting';
        }
        return entry.sock;
    }

    if (connectingCount >= maxSlots) {
        entry.status = entry.qrCode && entry.sock ? 'qr_code' : 'queued';
        entry.reason = 'max_concurrent_connecting';
        logger.info(
            `⏳ Baileys ${label} antre (connecting=${connectingCount}/${maxSlots}, qr=${needsQr})`
        );
        scheduleQueuedConnect(entry, needsQr ? QR_QUEUE_RETRY_MS : 5000);
        return null;
    }

    entry.isConnecting = true;
    connectingCount += 1;
    clearReconnect(entry);
    // QR lama invalid saat sock baru dibuat
    entry.qrCode = null;
    entry.qrUpdatedAt = null;
    entry.status = 'connecting';
    entry.reason = null;

    try {
        await ensureBaileysLoaded();
        fs.mkdirSync(entry.sessionDir, { recursive: true });
        writeTenantMeta(entry.tenantId, entry.sessionDir);

        // Cleanup previous sock for this entry only
        if (entry.sock) {
            try {
                if (entry.sock.ev) entry.sock.ev.removeAllListeners();
                if (entry.sock.end) entry.sock.end(undefined);
            } catch (_) { /* ignore */ }
            entry.sock = null;
        }

        const logLevel = getSetting('whatsapp_log_level', 'error');
        const baileysLogger = pino({ level: logLevel });
        const { state, saveCreds } = await useMultiFileAuthState(entry.sessionDir);

        const forceVersionRefresh = (entry.methodNotAllowedStreak || 0) > 0;
        const versionInfo = await resolveWaVersion(forceVersionRefresh);
        const version = versionInfo.version;
        logger.info(
            `📱 Baileys ${label} WA version ${version.join('.')} (${versionInfo.source})`
        );

        const sock = makeWASocket({
            auth: state,
            logger: baileysLogger,
            // Browser “normal” mengurangi penolakan pairing (405) vs label bot per-tenant
            browser: ['Windows', 'Chrome', '120.0.0'],
            connectTimeoutMs: 90000,
            qrTimeout: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            retryRequestDelayMs: 1000,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            version,
            printQRInTerminal: false
        });

        entry.sock = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            // Jangan early-return pada isNewLogin — bisa mengunci status open/QR

            if (qr) {
                entry.qrCode = qr;
                entry.qrUpdatedAt = Date.now();
                entry.status = 'qr_code';
                entry.phoneNumber = null;
                entry.connectedSince = null;
                entry.reason = null;
                // QR means socket created; allow another tenant to start connecting
                if (entry.isConnecting) {
                    entry.isConnecting = false;
                    connectingCount = Math.max(0, connectingCount - 1);
                }
                logger.info(`📱 QR Baileys siap untuk ${label}`);
                try {
                    qrcode.generate(qr, { small: true });
                } catch (_) { /* ignore */ }

                if (!entry.tenantId) {
                    global.whatsappStatus = {
                        connected: false,
                        qrCode: qr,
                        phoneNumber: null,
                        connectedSince: null,
                        status: 'qr_code'
                    };
                }
            }

            if (connection === 'open') {
                if (entry.isConnecting) {
                    entry.isConnecting = false;
                    connectingCount = Math.max(0, connectingCount - 1);
                }
                entry.status = 'connected';
                entry.qrCode = null;
                entry.phoneNumber = sock.user?.id?.split(':')[0] || null;
                entry.connectedSince = new Date();
                entry.lastConnectedAt = entry.connectedSince.toISOString();
                entry.reason = null;
                entry.reconnectAttempt = 0;
                entry.badSessionStreak = 0;
                entry.methodNotAllowedStreak = 0;
                startKeepAlive(entry);
                writeTenantMeta(entry.tenantId, entry.sessionDir);
                logger.info(`✅ Baileys terhubung (${label}) phone=${entry.phoneNumber || '-'}`);

                if (!entry.tenantId) {
                    global.whatsappStatus = {
                        connected: true,
                        qrCode: null,
                        phoneNumber: entry.phoneNumber,
                        connectedSince: entry.connectedSince,
                        status: 'connected'
                    };
                    global.whatsappSocket = sock;
                    global.getWhatsAppSocket = () => sock;
                }
            } else if (connection === 'close') {
                if (entry.isConnecting) {
                    entry.isConnecting = false;
                    connectingCount = Math.max(0, connectingCount - 1);
                }
                stopKeepAlive(entry);
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const rawMessage = lastDisconnect?.error?.output?.payload?.message
                    || lastDisconnect?.error?.message
                    || '';
                const errorMessage = String(rawMessage).toLowerCase();
                const hadCreds = hasCreds(entry.tenantId);
                let shouldReconnect = true;
                let wipeSession = false;
                let reconnectDelay = DEFAULT_RECONNECT_MS;

                // Pertahankan creds sebisa mungkin agar jarang scan QR ulang
                if (
                    errorMessage.includes('prekey bundle')
                    || errorMessage.includes('closing open session')
                    || errorMessage.includes('incoming prekey')
                    || statusCode === DisconnectReason.restartRequired
                    || errorMessage.includes('restart required')
                    || statusCode === DisconnectReason.timedOut
                    || statusCode === DisconnectReason.connectionLost
                    || statusCode === DisconnectReason.connectionClosed
                ) {
                    shouldReconnect = true;
                    wipeSession = false;
                    entry.methodNotAllowedStreak = 0;
                    // 515 setelah scan QR = normal, reconnect cepat
                    if (statusCode === DisconnectReason.restartRequired) {
                        reconnectDelay = 2500;
                    }
                } else if (statusCode === METHOD_NOT_ALLOWED || errorMessage.includes('method not allowed')) {
                    // 405 = versi WA ditolak / banjir connect — JANGAN loop agresif
                    entry.methodNotAllowedStreak = (entry.methodNotAllowedStreak || 0) + 1;
                    invalidateWaVersionCache();
                    shouldReconnect = true;
                    wipeSession = false;
                    reconnectDelay = Math.min(
                        MAX_RECONNECT_MS,
                        20000 + entry.methodNotAllowedStreak * 15000
                    );
                    logger.warn(
                        `⚠️ Baileys ${label} 405 Method Not Allowed (streak=${entry.methodNotAllowedStreak}) — refresh versi WA, delay ${reconnectDelay}ms`
                    );
                    // Tanpa creds: pairing gagal berulang → biarkan QR baru setelah delay
                    // Dengan creds rusak berulang → wipe supaya bisa scan ulang
                    if (hadCreds && entry.methodNotAllowedStreak >= BAD_SESSION_WIPE_AFTER) {
                        wipeSession = true;
                        entry.methodNotAllowedStreak = 0;
                    }
                } else if (statusCode === DisconnectReason.loggedOut) {
                    wipeSession = true;
                    shouldReconnect = false;
                } else if (statusCode === DisconnectReason.badSession) {
                    entry.badSessionStreak = (entry.badSessionStreak || 0) + 1;
                    if (entry.badSessionStreak >= BAD_SESSION_WIPE_AFTER) {
                        wipeSession = true;
                        shouldReconnect = true;
                        entry.badSessionStreak = 0;
                    } else {
                        wipeSession = false;
                        shouldReconnect = true;
                    }
                } else if (
                    statusCode === DisconnectReason.connectionReplaced
                    || errorMessage.includes('conflict')
                ) {
                    entry.badSessionStreak = (entry.badSessionStreak || 0) + 1;
                    wipeSession = entry.badSessionStreak >= BAD_SESSION_WIPE_AFTER;
                    shouldReconnect = true;
                    reconnectDelay = 20000;
                    if (wipeSession) entry.badSessionStreak = 0;
                } else if (
                    statusCode === DisconnectReason.multideviceMismatch
                    || statusCode === DisconnectReason.forbidden
                ) {
                    wipeSession = true;
                    shouldReconnect = true;
                }

                // Socket mati = QR pairing sudah invalid — jangan tampilkan QR mati
                entry.sock = null;
                entry.phoneNumber = null;
                entry.connectedSince = null;
                entry.qrCode = null;
                entry.qrUpdatedAt = null;
                entry.reason = rawMessage || (statusCode === METHOD_NOT_ALLOWED ? 'method_not_allowed_405' : 'connection_closed');
                entry.lastDisconnectAt = new Date().toISOString();
                entry.status = shouldReconnect ? 'reconnecting' : 'disconnected';

                if (wipeSession) {
                    logger.warn(`🧹 Baileys ${label}: wipe session (code=${statusCode ?? 'n/a'})`);
                    resetSessionDirectory(entry.sessionDir);
                    entry.status = shouldReconnect ? 'reconnecting' : 'disconnected';
                    entry.reconnectAttempt = 0;
                }

                if (!entry.tenantId) {
                    global.whatsappStatus = {
                        connected: false,
                        qrCode: null,
                        phoneNumber: null,
                        connectedSince: null,
                        status: entry.status,
                        reason: entry.reason
                    };
                }

                logger.warn(
                    `⚠️ Baileys ${label} close code=${statusCode ?? 'n/a'} wipe=${wipeSession} reconnect=${shouldReconnect}`
                );
                if (shouldReconnect) {
                    scheduleReconnect(entry, wipeSession ? 8000 : reconnectDelay);
                }
            }
        });

        return sock;
    } catch (err) {
        entry.isConnecting = false;
        connectingCount = Math.max(0, connectingCount - 1);
        entry.status = 'error';
        entry.reason = err.message;
        logger.error(`❌ Baileys connect ${label} gagal: ${err.message}`);
        scheduleReconnect(entry, DEFAULT_RECONNECT_MS);
        throw err;
    }
}

async function disconnect(tenantId = null) {
    const entry = getOrCreateEntry(tenantId);
    clearReconnect(entry);
    stopKeepAlive(entry);
    if (entry.sock) {
        try {
            if (entry.sock.ev) entry.sock.ev.removeAllListeners();
            if (entry.sock.end) entry.sock.end();
        } catch (_) { /* ignore */ }
    }
    entry.sock = null;
    entry.status = 'disconnected';
    entry.qrCode = null;
    entry.qrUpdatedAt = null;
    entry.phoneNumber = null;
    entry.connectedSince = null;
    entry.isConnecting = false;
}

/**
 * Delete only this tenant/legacy session dir — never sibling tenant-* folders.
 */
async function deleteSession(tenantId = null) {
    const entry = getOrCreateEntry(tenantId);
    await disconnect(tenantId);

    const base = getBaseSessionPath();
    const dir = entry.sessionDir;
    const isTenantDir = normalizeTenantId(tenantId) != null;

    if (isTenantDir) {
        resetSessionDirectory(dir);
    } else {
        // Legacy: wipe files in base but keep tenant-* directories
        try {
            if (!fs.existsSync(base)) {
                fs.mkdirSync(base, { recursive: true });
            } else {
                for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
                    if (ent.name.startsWith('tenant-')) continue;
                    const p = path.join(base, ent.name);
                    fs.rmSync(p, { recursive: true, force: true });
                }
            }
        } catch (err) {
            logger.warn(`⚠️ deleteSession legacy gagal: ${err.message}`);
        }
    }

    entry.status = 'session_deleted';
    entry.reason = 'deleted';
    return { success: true, tenantId: entry.tenantId, sessionDir: dir };
}

/**
 * Stagger reconnect for tenants that already have creds (boot helper).
 */
async function startTenantsWithExistingCreds(tenantIds = [], staggerMs = 12000) {
    const ids = (tenantIds || []).map(normalizeTenantId).filter(Boolean);
    let delay = 0;
    for (const id of ids) {
        if (!hasCreds(id)) continue;
        const wait = delay;
        delay += staggerMs;
        setTimeout(() => {
            connect(id).catch((err) => {
                logger.warn(`⚠️ Boot connect tenant ${id}: ${err.message}`);
            });
        }, wait);
    }
}

module.exports = {
    getSessionDir: sessionPathFor,
    getStatus,
    getSock,
    getOrCreateEntry,
    getDashboardAlertForTenant,
    listActive,
    hasCreds,
    connect,
    disconnect,
    deleteSession,
    migrateLegacyOwnerIfNeeded,
    startTenantsWithExistingCreds,
    resolveWaVersion,
    invalidateWaVersionCache,
    sessions
};
