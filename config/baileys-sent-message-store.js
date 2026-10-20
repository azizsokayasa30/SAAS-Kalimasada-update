'use strict';

/**
 * Cache pesan keluar Baileys.
 * Saat HP lawan (atau HP yang memindai QR) gagal dekripsi, WhatsApp minta
 * kirim ulang. Tanpa pesan asli, bubble tetap "Menunggu pesan ini".
 */

const MAX_ENTRIES = 8000;
const TTL_MS = 6 * 60 * 60 * 1000;

/** @type {Map<string, { message: object, storedAt: number }>} */
const store = new Map();

function prune() {
    const now = Date.now();
    for (const [id, entry] of store) {
        if (now - entry.storedAt > TTL_MS) store.delete(id);
    }
    while (store.size > MAX_ENTRIES) {
        const oldest = store.keys().next().value;
        if (oldest == null) break;
        store.delete(oldest);
    }
}

function rememberWaMessage(msg) {
    const id = msg?.key?.id;
    const message = msg?.message;
    if (!id || !message) return;
    if (store.size >= MAX_ENTRIES) prune();
    store.set(String(id), { message, storedAt: Date.now() });
}

async function getMessage(key) {
    const id = key?.id;
    if (!id) return undefined;
    const entry = store.get(String(id));
    if (!entry) return undefined;
    if (Date.now() - entry.storedAt > TTL_MS) {
        store.delete(String(id));
        return undefined;
    }
    return entry.message;
}

function attachSentMessageStore(sock) {
    if (!sock?.ev || sock.__sentMessageStoreAttached) return;
    sock.__sentMessageStoreAttached = true;
    sock.ev.on('messages.upsert', ({ messages }) => {
        if (!Array.isArray(messages)) return;
        for (const msg of messages) {
            if (msg?.key?.fromMe) rememberWaMessage(msg);
        }
    });
}

module.exports = {
    rememberWaMessage,
    getMessage,
    attachSentMessageStore
};
