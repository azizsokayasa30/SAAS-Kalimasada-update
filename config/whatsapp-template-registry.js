/**
 * Built-in WhatsApp notification templates (billing / teknisi / gangguan).
 * Digabung dengan data/whatsapp-templates.json saat runtime.
 */
const { getSetting } = require('./settingsManager');
const { getCompanyHeader } = require('./message-templates');

function getBuiltInWhatsAppTemplates() {
    return {
        invoice_created: {
            title: 'Tagihan Baru',
            template: `📋 *TAGIHAN BARU*

Halo {customer_name},

Tagihan bulanan Anda telah dibuat:

📄 *No. Invoice:* {invoice_number}
💰 *Jumlah:* Rp {amount}
📅 *Jatuh Tempo:* {due_date}
📦 *Paket:* {package_name} ({package_speed})
📝 *Catatan:* {notes}

Silakan lakukan pembayaran sebelum tanggal jatuh tempo untuk menghindari denda keterlambatan.

Terima kasih atas kepercayaan Anda.`,
            enabled: true
        },
        due_date_reminder: {
            title: 'Peringatan Sebelum Jatuh Tempo',
            template: `📋 *PEMBERITAHUAN TAGIHAN*

Halo {customer_name},

Tagihan Anda akan jatuh tempo dalam *{days_remaining} hari*:

📄 *No. Invoice:* {invoice_number}
💰 *Jumlah:* Rp {amount}
📅 *Jatuh Tempo:* {due_date}
📦 *Paket:* {package_name} ({package_speed})

Mohon persiapkan pembayaran sebelum tanggal jatuh tempo agar layanan tetap lancar.

Terima kasih.`,
            enabled: true
        },
        due_date_reminder_today: {
            title: 'Pengingat Hari H Jatuh Tempo',
            template: `🙏 *PENGINGAT PEMBAYARAN*

Halo {customer_name},

Hari ini (*{due_date}*) adalah tanggal jatuh tempo tagihan Anda:

📄 *No. Invoice:* {invoice_number}
💰 *Jumlah:* Rp {amount}
📦 *Paket:* {package_name} ({package_speed})

Apabila belum melakukan pembayaran, mohon kiranya dapat diselesaikan hari ini. Jika sudah bayar, abaikan pesan ini.

Terima kasih atas kerja samanya.`,
            enabled: true
        },
        payment_received: {
            title: 'Pembayaran Diterima',
            template: `✅ *PEMBAYARAN DITERIMA*

Halo {customer_name},

Terima kasih! Pembayaran Anda telah kami terima:

📄 *No. Invoice:* {invoice_number}
💰 *Jumlah:* Rp {amount}
💳 *Metode Pembayaran:* {payment_method}
📅 *Tanggal Pembayaran:* {payment_date}
🔢 *No. Referensi:* {reference_number}
📦 *Paket:* {package_name} {package_speed}

Layanan internet Anda akan tetap aktif. Terima kasih atas kepercayaan Anda.`,
            enabled: true
        },
        service_disruption: {
            title: 'Gangguan Layanan',
            template: `🚨 *GANGGUAN LAYANAN*

Halo Pelanggan Setia,

Kami informasikan bahwa sedang terjadi gangguan pada jaringan internet:

📡 *Jenis Gangguan:* {disruption_type}
📍 *Area Terdampak:* {affected_area}
⏰ *Perkiraan Selesai:* {estimated_resolution}
📞 *Hotline:* {support_phone}

Kami sedang bekerja untuk mengatasi masalah ini secepat mungkin. Mohon maaf atas ketidaknyamanannya.

Terima kasih atas pengertian Anda.`,
            enabled: true
        },
        service_announcement: {
            title: 'Pengumuman Layanan',
            template: `📢 *PENGUMUMAN LAYANAN*

Halo Pelanggan Setia,

{announcement_content}

Terima kasih atas perhatian Anda.`,
            enabled: true
        },
        service_suspension: {
            title: 'Service Suspension',
            template: `⚠️ *LAYANAN INTERNET DINONAKTIFKAN*

Halo {customer_name},

Layanan internet Anda telah dinonaktifkan karena:
📋 *Alasan:* {reason}

💡 *Cara Mengaktifkan Kembali:*
1. Lakukan pembayaran tagihan yang tertunggak
2. Layanan akan aktif otomatis setelah pembayaran dikonfirmasi

📞 *Butuh Bantuan?*
Hubungi kami di: ${getSetting('contact_whatsapp', '0813-6888-8498')}

*${getCompanyHeader()}*
Terima kasih atas perhatian Anda.`,
            enabled: true
        },
        service_restoration: {
            title: 'Service Restoration',
            template: `✅ *LAYANAN INTERNET DIAKTIFKAN*

Halo {customer_name},

Selamat! Layanan internet Anda telah diaktifkan kembali.

📋 *Informasi:*
• Status: AKTIF ✅
• Paket: {package_name}
• Kecepatan: {package_speed}

Terima kasih telah melakukan pembayaran tepat waktu.

*${getCompanyHeader()}*
Info: ${getSetting('contact_whatsapp', '0813-6888-8498')}`,
            enabled: true
        },
        welcome_message: {
            title: 'Welcome Message',
            template: `👋 *SELAMAT DATANG*

Halo {customer_name},

Selamat datang di layanan internet kami!

📦 *Paket:* {package_name} ({package_speed})
🌐 *PPPoE Username:* {pppoe_username}
🔑 *PPPoE Password:* {pppoe_password}
📞 *Support:* {support_phone}

Terima kasih telah memilih layanan kami.`,
            enabled: true
        },
        installation_job_assigned: {
            title: 'Tugas Instalasi Baru',
            template: `🔧 *TUGAS INSTALASI BARU*

Halo {technician_name},

Anda telah ditugaskan untuk instalasi baru:

📋 *Detail Job:*
• No. Job: {job_number}
• Pelanggan: {customer_name}
• Telepon: {customer_phone}
• Alamat: {customer_address}

📦 *Paket Internet:*
• Nama: {package_name}
• Harga: Rp {package_price}

📅 *Jadwal Instalasi:*
• Tanggal: {installation_date}
• Waktu: {installation_time}

📝 *Catatan:* {notes}
🛠️ *Peralatan:* {equipment_needed}

📍 *Lokasi:* {customer_address}
🔐 *PPPoE Username:* {pppoe_username}
🔑 *PPPoE Password:* {pppoe_password}

*Status:* Ditugaskan
*Prioritas:* {priority}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📱 *MENU KONFIRMASI:*

1️⃣ *KONFIRMASI PENERIMAAN*
Balas dengan: *TERIMA* atau *OK*

2️⃣ *MULAI INSTALASI*
Balas dengan: *MULAI* atau *START*

3️⃣ *SELESAI INSTALASI*
Balas dengan: *SELESAI* atau *DONE*

4️⃣ *BUTUH BANTUAN*
Balas dengan: *BANTU* atau *HELP*

5️⃣ *LAPOR MASALAH*
Balas dengan: *MASALAH* atau *ISSUE*

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💡 *HELPER RESPONS CEPAT:*
• *TERIMA* - Konfirmasi menerima tugas
• *MULAI* - Mulai proses instalasi
• *SELESAI* - Tandai instalasi selesai
• *BANTU* - Minta bantuan teknis
• *MASALAH* - Laporkan kendala

📞 *Support:* ${getSetting('contact_whatsapp', '0813-6888-8498')}

Silakan konfirmasi penerimaan tugas ini dengan balasan *TERIMA*.

*${getCompanyHeader()}*`,
            enabled: true
        },
        installation_status_update: {
            title: 'Update Status Instalasi',
            template: `🔄 *UPDATE STATUS INSTALASI*

Halo {technician_name},

Status instalasi telah diperbarui:

📋 *Detail Job:*
• No. Job: {job_number}
• Pelanggan: {customer_name}
• Status Baru: {new_status}
• Waktu Update: {update_time}

📝 *Catatan:* {notes}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📱 *MENU KONFIRMASI:*

1️⃣ *KONFIRMASI UPDATE*
Balas dengan: *KONFIRM* atau *OK*

2️⃣ *BUTUH BANTUAN*
Balas dengan: *BANTU* atau *HELP*

3️⃣ *LAPOR MASALAH*
Balas dengan: *MASALAH* atau *ISSUE*

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

*${getCompanyHeader()}*`,
            enabled: true
        },
        installation_completed: {
            title: 'Instalasi Selesai',
            template: `✅ *INSTALASI SELESAI*

Halo {technician_name},

Selamat! Instalasi telah berhasil diselesaikan:

📋 *Detail Job:*
• No. Job: {job_number}
• Pelanggan: {customer_name}
• Status: SELESAI ✅
• Waktu Selesai: {completion_time}

📝 *Catatan Penyelesaian:* {completion_notes}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📱 *MENU KONFIRMASI:*

1️⃣ *KONFIRMASI SELESAI*
Balas dengan: *KONFIRM* atau *OK*

2️⃣ *LAPOR TAMBAHAN*
Balas dengan: *LAPOR* atau *REPORT*

3️⃣ *BUTUH BANTUAN*
Balas dengan: *BANTU* atau *HELP*

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💡 *HELPER RESPONS CEPAT:*
• *KONFIRM* - Konfirmasi penyelesaian
• *LAPOR* - Laporkan detail tambahan
• *BANTU* - Minta bantuan teknis

*${getCompanyHeader()}*`,
            enabled: true
        },
        sales_order_new_customer: {
            title: 'Sales Order — Pelanggan Baru (ke teknisi)',
            template: `📋 *SALES ORDER - PELANGGAN BARU*

*No ID Pelanggan:* {customer_id}
*Nama Pelanggan:* {customer_name}
*No HP/WA:* {customer_phone}
*Email:* {customer_email}
*Alamat:* {customer_address}
*Paket:* {package_name} ({package_speed})
*PPPoE Username:* {pppoe_username}
*PPPoE Password:* {pppoe_password}
*PPPoE Profile:* {pppoe_profile}

✅ *Status:* Pelanggan telah di-accept dan siap untuk setting.

Silakan lakukan instalasi sesuai dengan data di atas.`,
            enabled: true
        },
        trouble_report_new_technician: {
            title: 'Laporan gangguan — notifikasi ke teknisi/admin',
            template: `🚨 *LAPORAN GANGGUAN BARU*

*{company_header}*

📝 *ID Tiket*: {report_id}
👤 *Pelanggan*: {customer_name}
📱 *No. HP*: {phone}
📍 *Lokasi*: {location}
🔧 *Kategori*: {category}
🕒 *Waktu Laporan*: {created_at}

💬 *Deskripsi Masalah*:
{description}

📌 *Status*: {status}

⚠️ *PRIORITAS TINGGI* - Silakan segera ditindaklanjuti!`,
            enabled: true
        },
        trouble_report_customer_update: {
            title: 'Laporan gangguan — update ke pelanggan',
            template: `📣 *UPDATE LAPORAN GANGGUAN*

*{company_header}*

📝 *ID Tiket*: {report_id}
🕒 *Update Pada*: {updated_at}
📌 *Status Baru*: {status_label}

{technician_note_section}{status_message}

Jika ada pertanyaan, silakan hubungi kami.`,
            enabled: true
        }
    };
}

function mergeWhatsAppTemplatesFromFile(builtIn, fileData) {
    const merged = {};
    const file = fileData && typeof fileData === 'object' ? fileData : {};
    for (const key of Object.keys(builtIn)) {
        merged[key] = { ...builtIn[key] };
        const f = file[key];
        if (f && typeof f === 'object') {
            if (f.title != null) merged[key].title = String(f.title);
            if (f.template != null) merged[key].template = String(f.template);
            if (typeof f.enabled === 'boolean') merged[key].enabled = f.enabled;
        }
    }
    return merged;
}

module.exports = {
    getBuiltInWhatsAppTemplates,
    mergeWhatsAppTemplatesFromFile
};
