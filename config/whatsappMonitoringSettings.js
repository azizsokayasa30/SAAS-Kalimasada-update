/**
 * Master switches untuk notifikasi WhatsApp otomatis / terjadwal (bukan template isi pesan).
 * Disimpan di settings.json sebagai object: whatsapp_system_monitors
 */
const { getSetting, setSetting } = require('./settingsManager');

const MONITOR_DEFINITIONS = [
    {
        id: 'pppoe_login_logout_wa',
        category: 'PPPoE & MikroTik',
        title: 'Login / logout PPPoE',
        description: 'Pesan ke admin & teknisi saat user PPPoE login atau logout (monitor interval).'
    },
    {
        id: 'rx_power_threshold_wa',
        category: 'GenieACS & RX',
        title: 'Peringatan RX power (ambang)',
        description: 'Notifikasi perangkat dengan redaman/RX mendekati kritis (interval rxPowerMonitor).'
    },
    {
        id: 'genieacs_rx_recap_wa',
        category: 'GenieACS & RX',
        title: 'Rekap redaman RX (GenieACS)',
        description: 'Ringkasan periodik perangkat RX rendah dari GenieACS ke teknisi.'
    },
    {
        id: 'genieacs_offline_digest_wa',
        category: 'GenieACS & RX',
        title: 'Digest perangkat offline',
        description: 'Ringkasan periodik ONU/perangkat offline ke teknisi.'
    },
    {
        id: 'billing_daily_due_wa',
        category: 'Billing',
        title: 'Jadwal WA tagihan (harian 09:00)',
        description: 'Tagihan baru H-X, pengingat H-Y, dan peringatan hari H — sesuai jadwal di WhatsApp Settings.'
    },
    {
        id: 'billing_scheduler_invoice_wa',
        category: 'Billing',
        title: 'WA tagihan baru (kirim manual / test)',
        description: 'Hanya untuk tombol test atau kirim manual dari admin — bukan saat invoice dibuat otomatis.'
    },
    {
        id: 'payment_received_wa',
        category: 'Billing',
        title: 'WA pembayaran diterima',
        description: 'Pesan otomatis ke pelanggan saat pembayaran/tagihan ditandai lunas.'
    },
    {
        id: 'customer_welcome_wa',
        category: 'Pelanggan',
        title: 'WA welcome pelanggan baru',
        description: 'Pesan sambutan otomatis setelah pelanggan dibuat/diaktifkan.'
    },
    {
        id: 'isolir_suspension_wa',
        category: 'Isolir & layanan',
        title: 'WA saat layanan diisolir',
        description: 'Notifikasi WhatsApp ke pelanggan saat isolir/suspensi otomatis.'
    },
    {
        id: 'isolir_restore_wa',
        category: 'Isolir & layanan',
        title: 'WA saat layanan dipulihkan',
        description: 'Notifikasi saat layanan diaktifkan kembali setelah pembayaran / restore.'
    },
    {
        id: 'member_isolir_wa',
        category: 'Isolir & layanan',
        title: 'WA isolir member hotspot',
        description: 'Pesan ke member hotspot saat proses isolir member.'
    },
    {
        id: 'trouble_report_routing_wa',
        category: 'Laporan gangguan',
        title: 'WA laporan gangguan',
        description: 'Notifikasi tiket baru ke grup teknisi dan update status ke pelanggan (selain toggle per-template).'
    },
    {
        id: 'installation_job_wa',
        category: 'Teknisi & instalasi',
        title: 'WA tugas instalasi / PSB',
        description: 'Pesan otomatis ke teknisi untuk assignment, update status, dan penyelesaian job instalasi.'
    },
    {
        id: 'broadcast_group_wa',
        category: 'Grup & broadcast',
        title: 'Kirim ke grup WA terdaftar',
        description: 'Saat broadcast gangguan/pengumuman atau alur yang memakai daftar group billing — kirim salinan ke grup.'
    }
];

const LEGACY_BOOLEAN_KEYS = {
    pppoe_login_logout_wa: ['pppoe_monitor_enable', 'pppoe_notifications.enabled'],
    rx_power_threshold_wa: ['rx_power_notification_enable'],
    genieacs_rx_recap_wa: ['rxpower_recap_enable'],
    genieacs_offline_digest_wa: ['offline_notification_enable']
};

function isExplicitlyFalse(value) {
    if (value === false || value === 0) return true;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized === 'false' || normalized === '0' || normalized === 'off' || normalized === 'no';
    }
    return false;
}

function defaultMonitorsObject() {
    const o = {};
    MONITOR_DEFINITIONS.forEach((m) => {
        o[m.id] = true;
    });
    Object.entries(LEGACY_BOOLEAN_KEYS).forEach(([monitorId, settingKeys]) => {
        if (settingKeys.some((key) => isExplicitlyFalse(getSetting(key, undefined)))) {
            o[monitorId] = false;
        }
    });
    return o;
}

function getMergedMonitors() {
    const saved = getSetting('whatsapp_system_monitors', null);
    const base = defaultMonitorsObject();
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        Object.keys(saved).forEach((k) => {
            if (k in base) {
                base[k] = saved[k] !== false;
            }
        });
    }
    return base;
}

function isWaSystemMonitorEnabled(id) {
    const m = getMergedMonitors();
    return m[id] !== false;
}

function setMonitorsPartial(partial) {
    const current = getMergedMonitors();
    if (partial && typeof partial === 'object') {
        Object.keys(partial).forEach((k) => {
            if (MONITOR_DEFINITIONS.some((d) => d.id === k)) {
                current[k] = partial[k] !== false;
            }
        });
    }
    setSetting('whatsapp_system_monitors', current);
    syncLegacyBooleanSettings(current);
    return getMergedMonitors();
}

function syncLegacyBooleanSettings(monitors) {
    Object.entries(LEGACY_BOOLEAN_KEYS).forEach(([monitorId, settingKeys]) => {
        const enabled = monitors[monitorId] !== false;
        settingKeys.forEach((key) => setSetting(key, enabled));
    });

    const currentPppoe = getSetting('pppoe_notifications', {});
    if (currentPppoe && typeof currentPppoe === 'object' && !Array.isArray(currentPppoe)) {
        setSetting('pppoe_notifications', {
            ...currentPppoe,
            enabled: monitors.pppoe_login_logout_wa !== false
        });
    }
}

module.exports = {
    MONITOR_DEFINITIONS,
    getMergedMonitors,
    isWaSystemMonitorEnabled,
    setMonitorsPartial,
    syncLegacyBooleanSettings
};
