const { getSetting } = require('./settingsManager');

/** Selisih hari kalender: due_date − hari ini (0 = hari H jatuh tempo). */
function getDaysUntilDueDate(dueDateStr) {
    const raw = String(dueDateStr || '').slice(0, 10);
    const parts = raw.split('-').map((n) => parseInt(n, 10));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(parts[0], parts[1] - 1, parts[2]);
    due.setHours(0, 0, 0, 0);
    return Math.round((due - today) / (1000 * 60 * 60 * 24));
}

function normDay(value, defaultVal, min = 1, max = 30) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return defaultVal;
    return Math.min(Math.max(n, min), max);
}

function getBillingNotifySchedule() {
    const legacy = getSetting('billing_wa_reminder_days_before', null);
    const invoiceDefault = legacy != null && getSetting('billing_wa_invoice_notify_days_before', null) == null
        ? String(legacy)
        : '3';

    return {
        invoice_notify_days_before: normDay(
            getSetting('billing_wa_invoice_notify_days_before', invoiceDefault),
            3
        ),
        reminder_days_before: normDay(
            getSetting('billing_wa_reminder_days_before', '1'),
            1
        ),
        send_on_due_day: getSetting('billing_wa_send_on_due_day', 'true') !== 'false',
        cron_time: '09:00'
    };
}

/**
 * Tentukan jenis WA tagihan untuk invoice unpaid hari ini (null = tidak kirim).
 * @returns {'invoice_created'|'reminder_before'|'reminder_today'|null}
 */
function resolveBillingWaNotificationKind(daysUntilDue, schedule = null) {
    const s = schedule || getBillingNotifySchedule();
    if (daysUntilDue == null) return null;

    if (daysUntilDue === s.invoice_notify_days_before) {
        return 'invoice_created';
    }
    if (daysUntilDue === s.reminder_days_before) {
        return 'reminder_before';
    }
    if (daysUntilDue === 0 && s.send_on_due_day) {
        return 'reminder_today';
    }
    return null;
}

module.exports = {
    getDaysUntilDueDate,
    getBillingNotifySchedule,
    resolveBillingWaNotificationKind
};
