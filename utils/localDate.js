'use strict';

/**
 * Format tanggal kalender lokal (mengikuti process.env.TZ / Asia/Jakarta).
 * JANGAN pakai Date#toISOString().split('T')[0] — itu UTC dan geser hari di WIB.
 */
function toLocalDateString(date = new Date()) {
    if (typeof date === 'string') {
        const s = String(date).trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
        const parsed = new Date(s);
        if (!Number.isNaN(parsed.getTime())) return toLocalDateString(parsed);
        return s.slice(0, 10);
    }
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) {
        return toLocalDateString(new Date());
    }
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Rentang YYYY-MM-DD bulan kalender lokal (monthIndex0: 0=Jan). */
function localMonthDateRange(year, monthIndex0) {
    const y = Number(year);
    const m = Number(monthIndex0);
    const startStr = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(y, m + 1, 0).getDate();
    const endStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { startStr, endStr, year: y, month: m + 1, ymKey: `${y}-${String(m + 1).padStart(2, '0')}` };
}

function currentLocalMonthDateRange(now = new Date()) {
    const d = now instanceof Date ? now : new Date(now);
    return localMonthDateRange(d.getFullYear(), d.getMonth());
}

/** DATETIME lokal `YYYY-MM-DD HH:MM:SS` (untuk SQLite; ganti CURRENT_TIMESTAMP UTC). */
function toLocalDateTimeString(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return toLocalDateTimeString(new Date());
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

module.exports = {
    toLocalDateString,
    localMonthDateRange,
    currentLocalMonthDateRange,
    toLocalDateTimeString
};
