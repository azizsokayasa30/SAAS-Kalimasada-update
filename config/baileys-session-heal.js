'use strict';

/**
 * Kirim 1:1 yang stabil.
 * Sesi Signal yang sudah rusak membuat sebagian bubble hanya menampilkan
 * "Menunggu pesan ini". Sesi lawan dihapus dulu supaya pesan berikutnya
 * memakai prekey baru (pkmsg) yang bisa dibuka HP penerima.
 */

const fs = require('fs');
const { rememberWaMessage } = require('./baileys-sent-message-store');

const locks = new Map();
/** phone user -> { lidJid: string|null, at: number } */
const lidCache = new Map();
const LID_CACHE_MS = 6 * 60 * 60 * 1000;

function userFromJid(jid) {
    const raw = String(jid || '').split('@')[0].split(':')[0];
    return /^\d{8,}$/.test(raw) ? raw : '';
}

function isDirectUserJid(jid) {
    const value = String(jid || '');
    return value.endsWith('@s.whatsapp.net') && !!userFromJid(value);
}

function ownUser(sock) {
    return userFromJid(sock?.user?.id || sock?.authState?.creds?.me?.id || '');
}

async function dropRecipientSessions(sock, jid) {
    const user = userFromJid(jid);
    if (!user || user === ownUser(sock)) return 0;
    const ids = new Set([`${user}.0`]);
    const dir = sock?.sessionDir;
    if (dir && fs.existsSync(dir)) {
        let names = [];
        try {
            names = fs.readdirSync(dir);
        } catch (_) {
            names = [];
        }
        const prefix = `session-${user}.`;
        for (const name of names) {
            if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
            ids.add(name.slice('session-'.length, -'.json'.length));
        }
    }
    const session = {};
    for (const id of ids) session[id] = null;
    if (sock?.authState?.keys?.set) {
        await sock.authState.keys.set({ session });
    }
    return ids.size;
}

function withJidLock(jid, fn) {
    const key = userFromJid(jid) || String(jid);
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    locks.set(key, run);
    run.finally(() => {
        if (locks.get(key) === run) locks.delete(key);
    });
    return run;
}

function normalizeLidJid(lid) {
    const value = String(lid || '').trim();
    if (!value) return '';
    if (value.endsWith('@lid')) return value.split(':')[0];
    const user = value.split('@')[0].split(':')[0];
    return /^\d{6,}$/.test(user) ? `${user}@lid` : '';
}

async function resolveTargetJid(sock, phoneJid) {
    const user = userFromJid(phoneJid);
    if (!user || typeof sock?.onWhatsApp !== 'function') return phoneJid;
    const cached = lidCache.get(user);
    if (cached && Date.now() - cached.at < LID_CACHE_MS) {
        return cached.lidJid || phoneJid;
    }
    let lidJid = '';
    try {
        const rows = await sock.onWhatsApp(phoneJid);
        const row = Array.isArray(rows) ? rows[0] : null;
        if (row && row.exists !== false) lidJid = normalizeLidJid(row.lid);
    } catch (_) {
        return phoneJid;
    }
    lidCache.set(user, { lidJid, at: Date.now() });
    return lidJid || phoneJid;
}

async function sendOnce(sock, jid, content, options) {
    const sent = await sock.sendMessage(jid, content, options);
    rememberWaMessage(sent);
    return sent;
}

/**
 * Kirim ke chat 1:1. Grup dilewatkan tanpa reset sesi.
 */
async function sendStableMessage(sock, jid, content, options = {}) {
    if (!sock?.sendMessage) {
        throw new Error('Socket WhatsApp tidak siap');
    }
    if (!isDirectUserJid(jid)) {
        return sendOnce(sock, jid, content, options);
    }
    return withJidLock(jid, async () => {
        const target = await resolveTargetJid(sock, jid);
        await dropRecipientSessions(sock, jid);
        if (target !== jid) await dropRecipientSessions(sock, target);
        try {
            return await sendOnce(sock, target, content, options);
        } catch (error) {
            await dropRecipientSessions(sock, jid);
            if (target !== jid) {
                try {
                    return await sendOnce(sock, jid, content, options);
                } catch (_) { /* lanjut ke error LID */ }
            }
            await dropRecipientSessions(sock, target);
            try {
                return await sendOnce(sock, target, content, options);
            } catch (retryError) {
                retryError.message = `${retryError.message} (setelah sesi direset)`;
                throw retryError;
            }
        }
    });
}

module.exports = {
    dropRecipientSessions,
    sendStableMessage,
    isDirectUserJid
};
