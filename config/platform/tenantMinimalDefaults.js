'use strict';

/**
 * Default minimal untuk tenant baru — tanpa kredensial/host produksi.
 * Jangan memuat settings.server.template.json ke tenant (itu untuk instalasi single-tenant).
 */
function loadMinimalTenantDefaults() {
    return {
        admin_username: 'admin',
        timezone: 'Asia/Jakarta',
        user_auth_mode: 'mikrotik',
        server_port: String(process.env.PORT || '3003'),
        otp_length: '4',
        otp_expiry_minutes: '5',
        customerPortalOtp: false,
        pppoe_monitor_enable: false,
        whatsapp_keep_alive: true,
        whatsapp_restart_on_error: true,
        auto_suspension_enabled: false,
        rx_power_notification_enable: false,
        rxpower_recap_enable: false,
        offline_notification_enable: false,
        logo_filename: 'logo.png',
        mikrotik_port: '8728',
        isolir_profile: 'isolir',
        static_ip_suspension_method: 'address_list',
        suspension_bandwidth_limit: '1k/1k',
        suspension_grace_period_days: '1',
        pppoe_notifications: {
            enabled: false,
            loginNotifications: false,
            logoutNotifications: false,
            includeOfflineList: false,
            maxOfflineListCount: '20',
        },
        trouble_report: {
            enabled: false,
            auto_ticket: false,
        },
        hotspot_config: {
            wifi_name: '',
            hotspot_url: '',
            hotspot_ip: '',
        },
        invoice_notes: 'Pembayaran dapat dilakukan melalui transfer bank atau pembayaran tunai di kantor kami.',
        payment_bank_name: '',
        payment_account_holder: '',
        payment_account_number: '',
        payment_cash_address: '',
        payment_cash_hours: '',
        billing_qr_filename: '',
    };
}

module.exports = { loadMinimalTenantDefaults };
