'use strict';

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const TONES = ['rose', 'blue', 'violet', 'amber', 'teal', 'green'];
const SUCCESS_STATUSES = ['settlement', 'paid', 'capture', 'success', 'completed'];
const FAILED_STATUSES = ['expire', 'expired', 'cancel', 'cancelled', 'deny', 'failed', 'failure'];

function dateParts(value) {
    const p = String(value || '').slice(0, 10).split('-').map(Number);
    return p.length === 3 && p[0] && p[1] ? { d: p[2], m: p[1], y: p[0] } : null;
}

function fullDate(value) {
    const p = dateParts(value);
    return p ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : '-';
}

function timeOf(value) {
    const m = String(value || '').match(/[T ](\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : '';
}

function periodLabel(month, year) {
    return `${MONTHS[Number(month) - 1] || ''} ${year}`.trim();
}

function toneOf(name) {
    const s = String(name || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return TONES[h % TONES.length];
}

function methodIcon(method) {
    const s = String(method || '').toLowerCase();
    if (!s) return null;
    if (s.includes('cash') || s.includes('tunai')) return 'bi-cash-stack';
    if (s.includes('transfer') || s.includes('bank')) return 'bi-bank';
    if (['wallet', 'qris', 'dana', 'ovo', 'gopay', 'shopee'].some((k) => s.includes(k))) return 'bi-wallet2';
    if (s.includes('kartu') || s.includes('card')) return 'bi-credit-card';
    return 'bi-arrow-left-right';
}

function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function paymentStatus(status) {
    const s = String(status || 'settlement').toLowerCase();
    if (SUCCESS_STATUSES.includes(s)) return { key: 'paid', label: 'Berhasil', icon: 'bi-check-circle-fill' };
    if (FAILED_STATUSES.includes(s)) return { key: 'failed', label: s.charAt(0).toUpperCase() + s.slice(1), icon: 'bi-x-circle-fill' };
    return { key: 'pending', label: s.charAt(0).toUpperCase() + s.slice(1), icon: 'bi-hourglass-split' };
}

module.exports = {
    MONTHS,
    MONTHS_SHORT,
    SUCCESS_STATUSES,
    dateParts,
    fullDate,
    timeOf,
    periodLabel,
    toneOf,
    methodIcon,
    initials,
    paymentStatus,
};
