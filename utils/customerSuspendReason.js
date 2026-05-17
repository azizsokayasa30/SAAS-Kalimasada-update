/**
 * Klasifikasi dan aturan auto-restore isolir pelanggan.
 * Mencegah pelanggan isolir manual otomatis kembali aktif setelah scheduler/pembayaran.
 */

function classifySuspendReason(reason) {
    const r = String(reason || '').toLowerCase();
    if (r.includes('telat bayar')) {
        return 'overdue';
    }
    return 'manual';
}

function isSuspendedStatus(status) {
    const st = String(status || '').toLowerCase();
    return st === 'suspended' || st === 'isolir';
}

/**
 * Hanya pelanggan yang diisolir karena telat bayar (atau legacy dengan auto_suspension aktif)
 * yang boleh dipulihkan otomatis oleh scheduler / webhook / pembayaran.
 */
function shouldAutoRestoreCustomer(customer) {
    if (!customer || !isSuspendedStatus(customer.status)) {
        return false;
    }
    const sr = String(customer.suspend_reason || '').toLowerCase();
    if (sr === 'manual') {
        return false;
    }
    if (sr === 'overdue') {
        return true;
    }
    // Legacy: belum ada suspend_reason — hormati flag auto_suspension
    return customer.auto_suspension !== 0 && customer.auto_suspension !== '0';
}

module.exports = {
    classifySuspendReason,
    isSuspendedStatus,
    shouldAutoRestoreCustomer
};
