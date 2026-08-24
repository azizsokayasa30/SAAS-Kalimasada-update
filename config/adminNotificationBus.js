/**
 * Bus in-process untuk mendorong pusat notifikasi admin (SSE).
 * Klien tetap memuat data per-tenant lewat session; event hanya sinyal "ada yang baru".
 */
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(200);

function pingAdminNotifications(kind) {
    try {
        bus.emit('notif', { kind: kind ? String(kind) : null, at: Date.now() });
    } catch (_) {}
}

function subscribeAdminNotifications(handler) {
    if (typeof handler !== 'function') return () => {};
    bus.on('notif', handler);
    return () => {
        try {
            bus.off('notif', handler);
        } catch (_) {}
    };
}

module.exports = {
    pingAdminNotifications,
    subscribeAdminNotifications
};
