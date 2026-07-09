'use strict';

function formatRupiah(amount) {
    const n = Math.round(Number(amount) || 0);
    return `Rp ${n.toLocaleString('id-ID')}`;
}

/** Ringkas untuk pill/kolom sempit; tooltip pakai formatRupiah penuh */
function formatRupiahShort(amount) {
    const n = Math.round(Number(amount) || 0);
    if (n >= 1_000_000_000) {
        const v = n / 1_000_000_000;
        const s = Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
        return `Rp ${s}M`;
    }
    if (n >= 1_000_000) {
        const v = n / 1_000_000;
        const s = Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
        return `Rp ${s}jt`;
    }
    if (n >= 10_000) {
        return `Rp ${Math.round(n / 1_000)}rb`;
    }
    return formatRupiah(n);
}

module.exports = { formatRupiah, formatRupiahShort };
