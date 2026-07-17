const { Boom } = require('@hapi/boom');
let makeWASocket;
let DisconnectReason;
let useMultiFileAuthState;
let fetchLatestWaWebVersion;
let baileysLoadPromise = null;
try {
    const baileys = require('@whiskeysockets/baileys');
    makeWASocket = baileys.default;
    DisconnectReason = baileys.DisconnectReason;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    fetchLatestWaWebVersion = baileys.fetchLatestWaWebVersion;
} catch (err) {
    // Newer Baileys versions are ESM-only; load lazily with dynamic import in connectToWhatsApp().
    console.warn('[WHATSAPP] Baileys require() failed, will use dynamic import:', err.message);
}
const qrcode = require('qrcode-terminal');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const pino = require('pino');
const logger = require('./logger');
const genieacsCommands = require('./genieacs-commands');

const {
    addHotspotUser,
    addPPPoESecret,
    setPPPoEProfile,
    getResourceInfo,
    getActiveHotspotUsers,
    getActivePPPoEConnections,
    deleteHotspotUser,
    deletePPPoESecret,
    getInactivePPPoEUsers,
    getOfflinePPPoEUsers
} = require('./mikrotik');

// Import handler perintah MikroTik baru
const mikrotikCommands = require('./mikrotik-commands');

// Import handler perintah PPPoE notifications
const pppoeCommands = require('./pppoe-commands');

// Import modul addWAN
const { handleAddWAN } = require('./addWAN');

// Import modul customerTag
const { addCustomerTag, addTagByPPPoE } = require('./customerTag');

// Import billing commands
const billingCommands = require('./billing-commands');

// Import admin number dari environment
const { ADMIN_NUMBER } = process.env;

// Import settings manager
const { getSetting } = require('./settingsManager');

// Import message templates helper
const { getDeveloperSupportMessage } = require('./message-templates');

// Import WhatsApp notification manager
const whatsappNotifications = require('./whatsapp-notifications');

// Import help messages
const { getAdminHelpMessage, getCustomerHelpMessage, getGeneralHelpMessage } = require('./help-messages');

async function ensureBaileysLoaded() {
    if (makeWASocket && DisconnectReason && useMultiFileAuthState && fetchLatestWaWebVersion) {
        return;
    }

    if (!baileysLoadPromise) {
        baileysLoadPromise = import('@whiskeysockets/baileys').then((baileys) => {
            makeWASocket = baileys.default || baileys.makeWASocket;
            DisconnectReason = baileys.DisconnectReason;
            useMultiFileAuthState = baileys.useMultiFileAuthState;
            fetchLatestWaWebVersion = baileys.fetchLatestWaWebVersion;

            if (!makeWASocket || !useMultiFileAuthState || !fetchLatestWaWebVersion) {
                throw new Error('Export Baileys tidak lengkap');
            }
        }).catch((error) => {
            baileysLoadPromise = null;
            throw error;
        });
    }

    return baileysLoadPromise;
}

// Phone helpers: normalize and variants (08..., 62..., +62...)
function normalizePhone(input) {
    if (!input) return '';
    let s = String(input).replace(/[^0-9+]/g, '');
    if (s.startsWith('+')) s = s.slice(1);
    
    // Handle format WhatsApp internasional yang aneh (misal: 91908172980363)
    // Jika dimulai dengan 91 dan panjangnya > 12, coba konversi
    if (s.startsWith('91') && s.length > 12) {
        // Pattern: 91908172980363
        // Kemungkinan: 91 (prefix WhatsApp) + 90 (prefix lain) + 8172980363 (nomor)
        // Atau: 91 (prefix) + 08172980363 (nomor dengan 0)
        // Coba beberapa konversi:
        
        // Method 1: Hapus 91, lalu hapus 90 jika ada
        const without91 = s.slice(2);
        if (without91.startsWith('90')) {
            // Hapus 90 juga
            const without90 = without91.slice(2);
            if (without90.startsWith('0')) {
                return '62' + without90.slice(1);
            }
            if (without90.startsWith('62')) {
                return without90;
            }
            if (/^8[0-9]{7,13}$/.test(without90)) {
                return '62' + without90;
            }
        } else {
            // Tidak ada 90, langsung normalisasi
            if (without91.startsWith('0')) {
                return '62' + without91.slice(1);
            }
            if (without91.startsWith('62')) {
                return without91;
            }
            if (/^8[0-9]{7,13}$/.test(without91)) {
                return '62' + without91;
            }
        }
        
        console.warn(`⚠️ [NORMALIZE] Nomor dimulai dengan 91 (India): ${s}, tidak bisa dikonversi otomatis`);
        // Untuk sementara, tetap gunakan nomor asli dan biarkan isAdminNumber handle
    }
    
    if (s.startsWith('0')) return '62' + s.slice(1);
    if (s.startsWith('62')) return s;
    // Fallback: if it looks like local without leading 0, prepend 62
    if (/^8[0-9]{7,13}$/.test(s)) return '62' + s;
    
    // Jika nomor panjang dan tidak dimulai dengan 62, mungkin perlu konversi
    // Tapi untuk sekarang, return as is dan biarkan isAdminNumber handle
    return s;
}

function generatePhoneVariants(input) {
    const raw = String(input || '');
    const norm = normalizePhone(raw);
    const local = norm.startsWith('62') ? '0' + norm.slice(2) : raw;
    const plus = norm.startsWith('62') ? '+62' + norm.slice(2) : raw;
    const shortLocal = local.startsWith('0') ? local.slice(1) : local;
    return Array.from(new Set([raw, norm, local, plus, shortLocal].filter(Boolean)));
}

// Fungsi untuk mendekripsi nomor admin yang dienkripsi
function decryptAdminNumber(encryptedNumber) {
    try {
        // Ini adalah implementasi dekripsi sederhana menggunakan XOR dengan kunci statis
        // Dalam produksi, gunakan metode enkripsi yang lebih kuat
        const key = 'ALIJAYA_SECRET_KEY_2025';
        let result = '';
        for (let i = 0; i < encryptedNumber.length; i++) {
            result += String.fromCharCode(encryptedNumber.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        return result;
    } catch (error) {
        console.error('Error decrypting admin number:', error);
        return null;
    }
}

// Membaca nomor super admin dari file eksternal (optional)
// Jika file tidak ada, gunakan admins.0 dari settings.json sebagai fallback
function getSuperAdminNumber() {
    const filePath = path.join(__dirname, 'superadmin.txt');
    
    // Fallback ke admins.0 dari settings.json
    let adminUtama = null;
    try {
        const { getSetting } = require('./settingsManager');
        adminUtama = getSetting('admins.0', null);
    } catch (error) {
        console.warn('⚠️ Error getting admins.0:', error.message);
    }
    
    if (!fs.existsSync(filePath)) {
        // Gunakan admins.0 sebagai fallback
        if (adminUtama) {
            console.log(`ℹ️ File superadmin.txt tidak ditemukan, menggunakan admins.0 (${adminUtama}) sebagai super admin`);
            return adminUtama;
        }
        console.warn('⚠️ File superadmin.txt tidak ditemukan dan admins.0 tidak tersedia, superadmin features disabled');
        return null;
    }
    
    try {
        const number = fs.readFileSync(filePath, 'utf-8').trim();
        if (!number) {
            // Fallback ke admins.0 jika file kosong
            if (adminUtama) {
                console.log(`ℹ️ File superadmin.txt kosong, menggunakan admins.0 (${adminUtama}) sebagai super admin`);
                return adminUtama;
            }
            console.warn('⚠️ File superadmin.txt kosong dan admins.0 tidak tersedia, superadmin features disabled');
            return null;
        }
        return number;
    } catch (error) {
        console.error('❌ Error reading superadmin.txt:', error.message);
        // Fallback ke admins.0 jika error membaca file
        if (adminUtama) {
            console.log(`ℹ️ Error membaca superadmin.txt, menggunakan admins.0 (${adminUtama}) sebagai super admin`);
            return adminUtama;
        }
        return null;
    }
}

const superAdminNumber = getSuperAdminNumber();
let genieacsCommandsEnabled = true;

// Fungsi untuk mengecek apakah nomor adalah admin atau super admin
function isAdminNumber(number) {
    try {
        const { getSetting } = require('./settingsManager');
        
        // Normalisasi nomor dengan lebih hati-hati
        let cleanNumber = String(number).replace(/\D/g, '');
        
        // Handle format WhatsApp internasional yang aneh (misal: 91908172980363)
        // Jika dimulai dengan 91 dan panjangnya > 12, coba konversi
        if (cleanNumber.startsWith('91') && cleanNumber.length > 12) {
            // 91908172980363 -> coba ambil 8 digit terakhir dan tambahkan 62
            // Atau bisa jadi format: 91 + 90 + 8172980363 -> coba ambil bagian yang sesuai
            // Untuk Indonesia, biasanya: 62 + 8xxxxxxxxx
            // Jika nomor panjang dan dimulai dengan 91, mungkin perlu mapping khusus
            console.warn(`⚠️ [ADMIN] Nomor dimulai dengan 91 (India): ${cleanNumber}, panjang: ${cleanNumber.length}`);
            
            // Coba konversi: jika ada pola tertentu, bisa di-convert
            // Tapi lebih baik gunakan nomor dari settings langsung untuk perbandingan
            // Untuk sementara, coba hapus prefix 91 jika panjangnya sesuai
            if (cleanNumber.length === 14 && cleanNumber.startsWith('9190')) {
                // 91908172980363 -> coba 628172980363 (jika pattern sesuai)
                // Tapi ini tidak reliable, lebih baik gunakan mapping atau cara lain
            }
        }
        
        // Normalisasi standar
        if (cleanNumber.startsWith('0')) cleanNumber = '62' + cleanNumber.slice(1);
        if (!cleanNumber.startsWith('62')) {
            // Jika tidak dimulai dengan 62, coba tambahkan jika panjangnya sesuai
            if (cleanNumber.length >= 9 && cleanNumber.length <= 13) {
                cleanNumber = '62' + cleanNumber;
            }
        }
        
        console.log(`🔍 [ADMIN] Checking admin for number: ${number} -> normalized: ${cleanNumber}`);
        
        // PRIORITAS 1: Cek admins.0 sebagai admin utama dari settings.json
        const adminUtama = getSetting('admins.0', null);
        if (adminUtama) {
            let adminUtamaClean = String(adminUtama).replace(/\D/g, '');
            if (adminUtamaClean.startsWith('0')) adminUtamaClean = '62' + adminUtamaClean.slice(1);
            if (!adminUtamaClean.startsWith('62')) adminUtamaClean = '62' + adminUtamaClean;
            
            console.log(`🔍 [ADMIN] Comparing: ${cleanNumber} with admin utama: ${adminUtamaClean}`);
            
            if (cleanNumber === adminUtamaClean) {
                console.log(`✅ [ADMIN] Nomor ${cleanNumber} adalah admin utama (admins.0)`);
                return true;
            }
            
            // Coba juga dengan berbagai variasi nomor admin
            const adminVariants = generatePhoneVariants(adminUtama);
            for (const variant of adminVariants) {
                const variantClean = variant.replace(/\D/g, '');
                if (variantClean.startsWith('0')) {
                    const variant62 = '62' + variantClean.slice(1);
                    if (cleanNumber === variant62 || cleanNumber === variantClean) {
                        console.log(`✅ [ADMIN] Nomor ${cleanNumber} match dengan variant admin: ${variant}`);
                        return true;
                    }
                }
            }
        }
        
        // PRIORITAS 2: Cek super admin dari file superadmin.txt
        if (superAdminNumber && cleanNumber === superAdminNumber) {
            console.log(`✅ [ADMIN] Nomor ${cleanNumber} adalah super admin (superadmin.txt)`);
            return true;
        }
        
        // PRIORITAS 3: Gabungkan semua admins dari settings.json (array dan key numerik lainnya)
        let admins = getSetting('admins', []);
        if (!Array.isArray(admins)) admins = [];
        
        // Normalisasi adminUtama untuk perbandingan
        let adminUtamaClean = null;
        if (adminUtama) {
            adminUtamaClean = adminUtama.replace(/\D/g, '');
            if (adminUtamaClean.startsWith('0')) adminUtamaClean = '62' + adminUtamaClean.slice(1);
            if (!adminUtamaClean.startsWith('62')) adminUtamaClean = '62' + adminUtamaClean;
        }
        
        // Cek key numerik lainnya (admins.1, admins.2, dst)
        const settingsRaw = require('./adminControl').getSettings();
        Object.keys(settingsRaw).forEach(key => {
            if (key.startsWith('admins.') && typeof settingsRaw[key] === 'string') {
                let n = settingsRaw[key].replace(/\D/g, '');
                if (n.startsWith('0')) n = '62' + n.slice(1);
                if (!n.startsWith('62')) n = '62' + n;
                // Jangan duplikat admins.0 yang sudah dicek di atas
                if (adminUtamaClean && n !== adminUtamaClean) {
                    admins.push(n);
                } else if (!adminUtamaClean) {
                admins.push(n);
                }
            }
        });
        
        // Cek di daftar admin lainnya
        if (admins.includes(cleanNumber)) {
            console.log(`✅ [ADMIN] Nomor ${cleanNumber} adalah admin (daftar admin lainnya)`);
            return true;
        }
        
        // Log debug jika bukan admin (hanya di development, bisa di-comment di production)
        // console.log(`❌ [ADMIN] Nomor ${cleanNumber} bukan admin. Admin utama: ${adminUtama || 'tidak ada'}, Daftar admin: ${admins.join(', ') || 'kosong'}`);
        return false;
    } catch (error) {
        console.error('❌ [ADMIN] Error in isAdminNumber:', error);
        return false;
    }
}

// Helper untuk menambahkan header dan footer pada pesan
function formatWithHeaderFooter(message) {
    try {
        // Ambil header dan footer dari settings.json dengan format yang konsisten
        const COMPANY_HEADER = getSetting('company_header', "📱 SISTEM BILLING \n\n");
        const FOOTER_SEPARATOR = "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";
        const FOOTER_INFO = FOOTER_SEPARATOR + getSetting('footer_info', "Powered by Alijaya Digital Network");
        
        // Format pesan dengan header dan footer yang konsisten
        const formattedMessage = `${COMPANY_HEADER}${message}${FOOTER_INFO}`;
        
        return formattedMessage;
    } catch (error) {
        console.error('Error formatting message with header/footer:', error);
        // Fallback ke format default jika ada error
        return `📱 CV Lintas Multimedia 📱

${message}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Powered by Alijaya Digital Network`;
    }
}

// Helper untuk mengirim pesan dengan header dan footer
async function sendFormattedMessage(remoteJid, message, options = {}) {
    try {
        const formattedMessage = formatWithHeaderFooter(message);
        await sock.sendMessage(remoteJid, { text: formattedMessage }, options);
    } catch (error) {
        console.error('Error sending formatted message:', error);
        // Fallback ke pesan tanpa format jika ada error
        await sock.sendMessage(remoteJid, { text: message }, options);
    }
}

let sock = null;
let qrCodeDisplayed = false;
let isConnecting = false; // Flag untuk mencegah multiple connection attempts
let connectionTimeout = null; // Timeout untuk connection attempt

// Tambahkan variabel global untuk menyimpan QR code dan status koneksi
let whatsappStatus = {
    connected: false,
    qrCode: null,
    phoneNumber: null,
    connectedSince: null,
    status: 'disconnected'
};

function resetWhatsAppSessionDirectory(sessionDir) {
    try {
        const { getBaseSessionPath } = require('./baileys-config');
        const base = getBaseSessionPath();
        const resolved = path.resolve(sessionDir);
        // Jangan pernah wipe seluruh base jika berisi tenant-* — hanya file legacy
        if (resolved === path.resolve(base)) {
            if (!fs.existsSync(base)) {
                fs.mkdirSync(base, { recursive: true });
            } else {
                for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
                    if (ent.name.startsWith('tenant-')) continue;
                    fs.rmSync(path.join(base, ent.name), { recursive: true, force: true });
                }
            }
            console.warn(`🧹 Direktori sesi WhatsApp legacy dibersihkan (tenant-* dipertahankan): ${sessionDir}`);
        } else if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            console.warn(`🧹 Direktori sesi WhatsApp dibersihkan: ${sessionDir}`);
            fs.mkdirSync(sessionDir, { recursive: true });
        } else {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
    } catch (error) {
        console.error(`Gagal mengatur ulang direktori sesi WhatsApp (${sessionDir}):`, error);
    }
    try {
        const { clearOwnerTenantId } = require('./baileys-session-owner');
        clearOwnerTenantId('session_reset');
    } catch (_) { /* optional */ }
}

// Fungsi untuk set instance sock
function setSock(sockInstance) {
    sock = sockInstance;
}

// Update parameter paths
const parameterPaths = {
    rxPower: [
        'VirtualParameters.RXPower',
        'VirtualParameters.redaman',
        'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower'
    ],
    pppoeIP: [
        'VirtualParameters.pppoeIP',
        'VirtualParameters.pppIP',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress'
    ],
    ssid: [
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID'
    ],
    uptime: [
        'VirtualParameters.getdeviceuptime',
        'InternetGatewayDevice.DeviceInfo.UpTime'
    ],
    firmware: [
        'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
        'Device.DeviceInfo.SoftwareVersion'
    ],
    // Tambah path untuk PPPoE username
    pppUsername: [
        'VirtualParameters.pppoeUsername',
        'VirtualParameters.pppUsername',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username'
    ],
    userConnected: [
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations'
    ],
    userConnected5G: [
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations'
    ]
};

// Fungsi untuk cek status device
function getDeviceStatus(lastInform) {
    if (!lastInform) return false;
    const lastInformTime = new Date(lastInform).getTime();
    const currentTime = new Date().getTime();
    const diffMinutes = (currentTime - lastInformTime) / (1000 * 60);
    return diffMinutes < 5; // Online jika last inform < 5 menit
}

// Fungsi untuk format uptime
function formatUptime(uptime) {
    if (!uptime) return 'N/A';
    
    const seconds = parseInt(uptime);
    const days = Math.floor(seconds / (3600 * 24));
    const hours = Math.floor((seconds % (3600 * 24)) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    let result = '';
    if (days > 0) result += `${days} hari `;
    if (hours > 0) result += `${hours} jam `;
    if (minutes > 0) result += `${minutes} menit`;
    
    return result.trim() || '< 1 menit';
}

// Update fungsi untuk mendapatkan nilai parameter
function getParameterWithPaths(device, paths) {
    if (!device || !Array.isArray(paths)) return 'N/A';
    
    for (const path of paths) {
        const pathParts = path.split('.');
        let value = device;
        
        for (const part of pathParts) {
            if (!value || !value[part]) {
                value = null;
                break;
            }
            value = value[part];
        }
        
        if (value !== null && value !== undefined && value !== '') {
            // Handle jika value adalah object
            if (typeof value === 'object') {
                if (value._value !== undefined) {
                    return value._value;
                }
                if (value.value !== undefined) {
                    return value.value;
                }
            }
            return value;
        }
    }
    
    return 'N/A';
}

// Fungsi helper untuk format nomor telepon
function formatPhoneNumber(number) {
    // Hapus semua karakter non-digit
    let cleaned = number.replace(/\D/g, '');
    
    // Jika dimulai dengan 0, ganti dengan 62
    if (cleaned.startsWith('0')) {
        cleaned = '62' + cleaned.slice(1);
    }
    
    // Jika belum ada 62 di depan, tambahkan
    if (!cleaned.startsWith('62')) {
        cleaned = '62' + cleaned;
    }
    
    return cleaned;
}

// Tambahkan fungsi enkripsi sederhana
function generateWatermark() {
    const timestamp = new Date().getTime();
    const secretKey = getSetting('secret_key', 'alijaya-digital-network');
    const baseString = `ADN-${timestamp}`;
    // Enkripsi sederhana (dalam praktik nyata gunakan enkripsi yang lebih kuat)
    return Buffer.from(baseString).toString('base64');
}

// Update format pesan dengan watermark tersembunyi
function addWatermarkToMessage(message) {
    const watermark = generateWatermark();
    // Tambahkan karakter zero-width ke pesan
    return message + '\u200B' + watermark + '\u200B';
}

// Update fungsi koneksi WhatsApp dengan penanganan error yang lebih baik
async function connectToWhatsApp(tenantId = null) {
    const tid = parseInt(tenantId, 10);
    const normalizedTid = Number.isFinite(tid) && tid > 0 ? tid : null;

    // Multi-tenant Baileys: sesi terpisah via registry
    if (normalizedTid) {
        const registry = require('./baileys-session-registry');
        return registry.connect(normalizedTid);
    }

    // Cegah multiple connection attempts
    if (isConnecting) {
        console.log('⚠️ Koneksi WhatsApp sedang dalam proses, skip...');
        return sock;
    }
    
    // Cek apakah sudah connected dan masih valid
    if (sock && global.whatsappStatus?.connected) {
        try {
            // Test connection dengan simple check
            if (sock.user && sock.user.id) {
                console.log('✅ WhatsApp sudah terhubung, skip reconnection');
                return sock;
            }
        } catch (e) {
            // Socket mungkin invalid, lanjutkan dengan reconnect
            console.log('⚠️ Socket existing tapi invalid, akan reconnect...');
        }
    }
    
    // Cleanup socket lama jika ada
    if (sock) {
        try {
            console.log('🧹 Membersihkan socket lama...');
            if (sock.ev) {
                sock.ev.removeAllListeners();
            }
            if (sock.end) {
                sock.end();
            }
        } catch (cleanupError) {
            console.warn('⚠️ Error cleaning up old socket:', cleanupError.message);
        }
        sock = null;
    }
    
    isConnecting = true;
    
    // Clear connection timeout jika ada
    if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
    }
    
    try {
        console.log('Memulai koneksi WhatsApp...');
        await ensureBaileysLoaded();
        
        // Pastikan direktori sesi ada (legacy root — jangan pakai tenant-*)
        const { getBaseSessionPath } = require('./baileys-config');
        const sessionDir = getBaseSessionPath();
        if (!fs.existsSync(sessionDir)) {
            try {
                fs.mkdirSync(sessionDir, { recursive: true });
                console.log(`Direktori sesi WhatsApp dibuat: ${sessionDir}`);
            } catch (dirError) {
                console.error(`Error membuat direktori sesi: ${dirError.message}`);
                throw new Error(`Gagal membuat direktori sesi WhatsApp: ${dirError.message}`);
            }
        }
        
        // Gunakan logger dengan level yang dapat dikonfigurasi
        // Set ke 'error' untuk suppress Bad MAC warnings (normal behavior)
        const logLevel = getSetting('whatsapp_log_level', 'error');
        const logger = pino({ 
            level: logLevel,
            // Suppress specific error messages yang normal
            customLevels: {
                suppress: 100 // Level untuk suppress
            }
        });
        
        // Buat socket dengan konfigurasi yang lebih baik dan penanganan error
        let authState;
        try {
            authState = await useMultiFileAuthState(sessionDir);
        } catch (authError) {
            console.error(`Error loading WhatsApp auth state: ${authError.message}`);
            throw new Error(`Gagal memuat state autentikasi WhatsApp: ${authError.message}`);
        }
        
        const { state, saveCreds } = authState;
        
                // Fetch the latest WhatsApp Web version dynamically
        let version;
        const botName = 'CV Lintas Multimedia Genieacs Bot Mikrotik';
        
        try {
            const versionInfo = await fetchLatestWaWebVersion();
            version = versionInfo.version;
            console.log(`📱 [${botName}] Using WA Web v${version.join(".")}, isLatest: ${versionInfo.isLatest}`);
        } catch (error) {
            console.warn(`⚠️ [${botName}] Failed to fetch latest version, using fallback:`, error.message);
            // Fallback to a known working version
            version = [2, 3000, 1025190524];
        }
        
        sock = makeWASocket({
            auth: state,
            logger,
            browser: ['CV Lintas Multimedia Genieacs Bot Mikrotik', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            qrTimeout: 40000,
            defaultQueryTimeoutMs: 30000, // Timeout untuk query
            retryRequestDelayMs: 1000,
            version, // Tambahkan versi yang diambil secara dinamis
            printQRInTerminal: true, // Pastikan QR code ditampilkan
            markOnlineOnConnect: true // Mark online saat connect
        });
        
        console.log('✅ [CONNECT] WhatsApp socket created, setting up event listeners...');
        


        // Tangani update koneksi
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr, isNewLogin } = update;
            
            // Log update koneksi (kurangi verbosity, tapi log penting)
            if (connection === 'open' || connection === 'close' || qr || isNewLogin) {
                console.log('Connection update:', { 
                    connection, 
                    qr: !!qr, 
                    isNewLogin: isNewLogin !== undefined ? isNewLogin : 'undefined',
                    statusCode: lastDisconnect?.error?.output?.statusCode
                });
            }
            
            // Handle isNewLogin - ini normal saat first login atau session refresh
            // JANGAN reset session atau logout untuk isNewLogin
            if (isNewLogin === true) {
                console.log('🔄 isNewLogin detected - ini normal, session akan di-refresh oleh Baileys');
                // Biarkan Baileys handle isNewLogin, jangan interfere
                return; // Skip processing lebih lanjut untuk isNewLogin
            }
            
            // Tangani QR code
            if (qr) {
                // Simpan QR code dalam format yang bersih
                // Simpan QR code ke global status (untuk admin panel)
                if (!global.whatsappStatus || global.whatsappStatus.qrCode !== qr) {
                    global.whatsappStatus = {
                        connected: false,
                        qrCode: qr,
                        phoneNumber: null,
                        connectedSince: null,
                        status: 'qr_code'
                    };
                }

                
                // Tampilkan QR code di terminal
                console.log('QR Code tersedia, siap untuk dipindai');
                qrcode.generate(qr, { small: true });
            }
            
            // Tangani koneksi
            if (connection === 'open') {
                console.log('✅ WhatsApp terhubung!');
                isConnecting = false; // Reset flag setelah connected
                const connectedSince = new Date();

                try {
                    const { commitPendingOwnerOnConnect, getOwnerTenantId } = require('./baileys-session-owner');
                    const owner = commitPendingOwnerOnConnect();
                    console.log(`🔒 Baileys owner tenant: ${owner || getOwnerTenantId() || 'belum di-claim'}`);
                } catch (ownerErr) {
                    console.warn('⚠️ Gagal commit Baileys owner:', ownerErr.message);
                }
                
                // Update status global
                global.whatsappStatus = {
                    connected: true,
                    qrCode: null,
                    phoneNumber: sock.user?.id?.split(':')[0] || null,
                    connectedSince: connectedSince,
                    status: 'connected'
                };
                
                // PENTING: Start keep-alive mechanism untuk menjaga koneksi tetap hidup
                startKeepAlive(sock);
                
                // Set sock instance untuk modul lain
                setSock(sock);
                
                // Set sock instance untuk provider manager (BaileysProvider)
                try {
                    const { getProviderManager } = require('./whatsapp-provider-manager');
                    const providerManager = getProviderManager();
                    const provider = providerManager.getProvider();
                    if (provider && provider.setSock) {
                        provider.setSock(sock);
                        console.log('✅ [CONNECT] BaileysProvider socket updated');
                    }
                } catch (error) {
                    console.warn('⚠️ [CONNECT] Error setting sock for provider manager:', error.message);
                }
                
                // Set sock instance untuk modul sendMessage
                try {
                    const sendMessageModule = require('./sendMessage');
                    sendMessageModule.setSock(sock);
                } catch (error) {
                    console.error('Error setting sock for sendMessage:', error);
                }
                
                // Set sock instance untuk modul mikrotik-commands
                try {
                    const mikrotikCommands = require('./mikrotik-commands');
                    mikrotikCommands.setSock(sock);
                } catch (error) {
                    console.error('Error setting sock for mikrotik-commands:', error);
                }
                
                // Set sock instance untuk WhatsApp notification manager
                try {
                    whatsappNotifications.setSock(sock);
                } catch (error) {
                    console.error('Error setting sock for WhatsApp notifications:', error);
                }
                
                // PENTING: Start keep-alive mechanism untuk menjaga koneksi tetap hidup
                startKeepAlive(sock);
                
                // Kirim pesan ke admin bahwa bot telah terhubung
                try {
                    // Ambil port yang aktif dari global settings atau fallback
                    const activePort = global.appSettings?.port || getSetting('server_port', '3001');
                    const serverHost = global.appSettings?.host || getSetting('server_host', 'localhost');
                    
                    // Ambil header pendek untuk template sambutan
                    const companyHeaderShort = getSetting('company_header_short', 'CV Lintas Multimedia');
                    
                    // Skip sending notification to admin
                    console.log('✅ WhatsApp bot berhasil terhubung');
                    console.log(`📱 Bot aktif sejak: ${connectedSince.toLocaleString()}`);
                    console.log(`🏢 Company Header: ${companyHeaderShort}`);
                } catch (error) {
                    console.error('Error sending connection notification:', error);
                }
            } else if (connection === 'close') {
                isConnecting = false; // Reset flag saat disconnect
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const rawMessage = lastDisconnect?.error?.output?.payload?.message || lastDisconnect?.error?.message || '';
                const errorMessage = String(rawMessage).toLowerCase();
                const prevQrCode = global.whatsappStatus?.qrCode || null;
                const hasPendingQr = !!prevQrCode;
                let shouldReconnect = true;

                // Handle "Closing open session in favor of incoming prekey bundle" - ini bukan logout, ini normal session refresh
                if (errorMessage.includes('prekey bundle') || errorMessage.includes('closing open session') || errorMessage.includes('incoming prekey')) {
                    console.log('ℹ️ Session refresh detected (prekey bundle) - ini normal dari Baileys, akan reconnect otomatis...');
                    shouldReconnect = true;
                    // JANGAN reset session untuk prekey bundle - ini normal behavior
                } else if (statusCode === DisconnectReason.loggedOut) {
                    console.warn('⚠️ WhatsApp ter-logout dari server. Menghapus sesi untuk meminta QR baru.');
                    resetWhatsAppSessionDirectory(sessionDir);
                    qrCodeDisplayed = false;
                    shouldReconnect = false; // Jangan reconnect untuk loggedOut
                } else if (
                    statusCode === DisconnectReason.connectionReplaced ||
                    errorMessage.includes('conflict')
                ) {
                    console.warn('⚠️ Terdeteksi konflik sesi WhatsApp (connection replaced). Membersihkan kredensial dan mencoba ulang.');
                    resetWhatsAppSessionDirectory(sessionDir);
                    qrCodeDisplayed = false;
                } else if (statusCode === DisconnectReason.badSession) {
                    console.warn('⚠️ WhatsApp melaporkan bad session. Menghapus sesi dan melakukan login ulang.');
                    resetWhatsAppSessionDirectory(sessionDir);
                    qrCodeDisplayed = false;
                } else if (statusCode === DisconnectReason.restartRequired || errorMessage.includes('restart required')) {
                    console.warn('🔁 WhatsApp meminta restart koneksi. Akan mencoba koneksi ulang menggunakan sesi yang ada.');
                } else if (statusCode === DisconnectReason.multideviceMismatch) {
                    console.warn('⚠️ Multidevice mismatch terdeteksi. Menghapus sesi agar dapat login ulang.');
                    resetWhatsAppSessionDirectory(sessionDir);
                    qrCodeDisplayed = false;
                } else if (statusCode === DisconnectReason.forbidden) {
                    console.error('⛔ Akses WhatsApp ditolak. Menghapus sesi dan mencoba ulang.');
                    resetWhatsAppSessionDirectory(sessionDir);
                    qrCodeDisplayed = false;
                }

                console.log(`Koneksi WhatsApp terputus (code: ${statusCode ?? 'unknown'}, reason: ${rawMessage || 'n/a'}). Mencoba koneksi ulang: ${shouldReconnect}`);
                
                // Update status global
                global.whatsappStatus = {
                    connected: false,
                    // Jangan hilangkan QR yang sudah dihasilkan agar admin panel tetap bisa scan.
                    qrCode: hasPendingQr ? prevQrCode : null,
                    phoneNumber: null,
                    connectedSince: null,
                    status: hasPendingQr ? 'qr_code' : 'disconnected',
                    reason: rawMessage || 'connection_closed'
                };
                
                // Stop keep-alive dan monitoring
                stopKeepAlive();
                stopConnectionStateMonitoring();
                
                // Stop keep-alive dan monitoring
                stopKeepAlive();
                stopConnectionStateMonitoring();
                
                // Cleanup socket
                if (sock) {
                    try {
                        if (sock.ev) {
                            sock.ev.removeAllListeners();
                        }
                    } catch (e) {
                        // Ignore cleanup errors
                    }
                    sock = null;
                }
                
                // Reconnect jika bukan karena logout
                if (shouldReconnect) {
                    const reconnectDelay = Number(getSetting('reconnect_interval', 10000)) || 10000; // Increase delay to 10s
                    console.log(`⏳ Akan reconnect dalam ${reconnectDelay/1000} detik...`);
                    connectionTimeout = setTimeout(() => {
                        connectionTimeout = null;
                        connectToWhatsApp();
                    }, reconnectDelay);
                }
            }
        });
        
        // Tangani credentials update
        sock.ev.on('creds.update', saveCreds);
        
        // PERBAIKAN: Tangani pesan masuk dengan benar
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            console.log(`📨 [MESSAGE] messages.upsert event received, type: ${type}, messages count: ${messages?.length || 0}`);
            
            if (type === 'notify') {
                for (const message of messages) {
                    // Skip pesan dari bot sendiri
                    if (message.key.fromMe) {
                        console.log('📨 [MESSAGE] Skipping message from self');
                        continue;
                    }
                    
                    // Pastikan message ada
                    if (!message.message) {
                        console.log('📨 [MESSAGE] Skipping message without content');
                        continue;
                    }
                    
                    try {
                        // Extract message text untuk logging
                        const messageText = message.message?.conversation || 
                                          message.message?.extendedTextMessage?.text || 
                                          'Unknown message type';
                        const sender = message.key.remoteJid?.split('@')[0] || 'Unknown';
                        
                        console.log(`📨 [MESSAGE] Processing message from ${sender}: ${messageText.substring(0, 50)}...`);
                            
                            // Panggil fungsi handleIncomingMessage
                            await handleIncomingMessage(sock, message);
                        
                        console.log(`✅ [MESSAGE] Message processed successfully from ${sender}`);
                        } catch (error) {
                        // Skip error "Bad MAC" - ini normal dari Baileys saat session refresh
                        if (error.message && error.message.includes('Bad MAC')) {
                            console.debug('⚠️ [MESSAGE] Bad MAC error (normal during session refresh), skipping');
                            continue;
                        }
                        console.error(`❌ [MESSAGE] Error handling incoming message from ${message.key.remoteJid}:`, error.message);
                        console.error('Error stack:', error.stack);
                    }
                }
            } else {
                console.log(`📨 [MESSAGE] Ignoring message type: ${type}`);
            }
        });
        
        // Handle error dari Baileys (termasuk Bad MAC)
        sock.ev.on('error', (error) => {
            // Skip "Bad MAC" errors - ini normal saat session refresh
            if (error.message && error.message.includes('Bad MAC')) {
                // Baileys akan handle sendiri, tidak perlu action
                return;
            }
            // Log error lainnya
            console.error('⚠️ Baileys error:', error.message);
        });
        
        // PENTING: Tambahkan connection state monitoring
        // Monitor connection state secara berkala untuk detect silent disconnects
        startConnectionStateMonitoring(sock);
        
        isConnecting = false; // Reset flag setelah socket dibuat
        return sock;
    } catch (error) {
        console.error('❌ Error connecting to WhatsApp:', error.message);
        isConnecting = false; // Reset flag saat error
        
        // Cleanup socket jika ada
        if (sock) {
            try {
                if (sock.ev) {
                    sock.ev.removeAllListeners();
                }
            } catch (e) {
                // Ignore cleanup errors
            }
            sock = null;
        }
        
        // Coba koneksi ulang setelah interval (lebih lama untuk avoid loop)
        const reconnectDelay = Number(getSetting('reconnect_interval', 15000)) || 15000;
        console.log(`⏳ Akan coba reconnect dalam ${reconnectDelay/1000} detik...`);
        connectionTimeout = setTimeout(() => {
            connectionTimeout = null;
            connectToWhatsApp();
        }, reconnectDelay);
        
        return null;
    }
}

// Update handler status
async function handleStatusCommand(senderNumber, remoteJid) {
    try {
        console.log(`Menjalankan perintah status untuk ${senderNumber}`);
        
        // Cari perangkat berdasarkan nomor pengirim
        const device = await getDeviceByNumber(senderNumber);
        
        if (!device) {
            await sock.sendMessage(remoteJid, { 
                text: `âŒ *Perangkat Tidak Ditemukan*\n\nMaaf, perangkat Anda tidak ditemukan dalam sistem kami. Silakan hubungi admin untuk bantuan.`
            });
            return;
        }
        
        // Ambil informasi perangkat
        const deviceId = device._id;
        const lastInform = new Date(device._lastInform);
        const now = new Date();
        const diffMinutes = Math.floor((now - lastInform) / (1000 * 60));
        const isOnline = diffMinutes < 15;
        
        // Gunakan parameterPaths yang sudah ada untuk mendapatkan nilai
        // Ambil informasi SSID
        let ssid = 'N/A';
        let ssid5G = 'N/A';
        
        // Coba ambil SSID langsung
        if (device.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.SSID?._value) {
            ssid = device.InternetGatewayDevice.LANDevice['1'].WLANConfiguration['1'].SSID._value;
        }
        
        // Coba ambil SSID 5G langsung
        if (device.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['5']?.SSID?._value) {
            ssid5G = device.InternetGatewayDevice.LANDevice['1'].WLANConfiguration['5'].SSID._value;
        } else if (device.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['2']?.SSID?._value) {
            ssid5G = device.InternetGatewayDevice.LANDevice['1'].WLANConfiguration['2'].SSID._value;
        }
        
        // Gunakan getParameterWithPaths untuk mendapatkan nilai dari parameter paths yang sudah ada
        const rxPower = getParameterWithPaths(device, parameterPaths.rxPower);
        const formattedRxPower = rxPower !== 'N/A' ? `${rxPower} dBm` : 'N/A';
        
        const pppUsername = getParameterWithPaths(device, parameterPaths.pppUsername);
        const ipAddress = getParameterWithPaths(device, parameterPaths.pppoeIP);
        
        // Ambil informasi pengguna terhubung
        let connectedUsers = getParameterWithPaths(device, parameterPaths.userConnected) || '0';
        let connectedUsers5G = getParameterWithPaths(device, parameterPaths.userConnected5G) || '0';
        
        // Jika kedua nilai tersedia, gabungkan
        let totalConnectedUsers = connectedUsers;
        if (connectedUsers !== 'N/A' && connectedUsers5G !== 'N/A' && connectedUsers5G !== '0') {
            try {
                totalConnectedUsers = (parseInt(connectedUsers) + parseInt(connectedUsers5G)).toString();
            } catch (e) {
                console.error('Error calculating total connected users:', e);
            }
        }

        // Ambil daftar user terhubung ke SSID 1 (2.4GHz) saja, lengkap dengan IP jika ada
        let associatedDevices = [];
        try {
            // Ambil dari AssociatedDevice (utama)
            const assocObj = device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.AssociatedDevice;
            if (assocObj && typeof assocObj === 'object') {
                for (const key in assocObj) {
                    if (!isNaN(key)) {
                        const entry = assocObj[key];
                        const mac = entry?.MACAddress?._value || entry?.MACAddress || '-';
                        const hostname = entry?.HostName?._value || entry?.HostName || '-';
                        const ip = entry?.IPAddress?._value || entry?.IPAddress || '-';
                        associatedDevices.push({ mac, hostname, ip });
                    }
                }
            }

            // Fallback: Jika AssociatedDevice kosong, ambil dari Hosts.Host yang interface-nya IEEE802_11 dan terkait SSID 1
            if (associatedDevices.length === 0) {
                const hostsObj = device?.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host;
                if (hostsObj && typeof hostsObj === 'object') {
                    for (const key in hostsObj) {
                        if (!isNaN(key)) {
                            const entry = hostsObj[key];
                            const interfaceType = entry?.InterfaceType?._value || entry?.InterfaceType || '';
                            const ssidRef = entry?.SSIDReference?._value || entry?.SSIDReference || '';
                            // Hanya WiFi SSID 1 (biasanya mengandung 'WLANConfiguration.1')
                            if (interfaceType === 'IEEE802_11' && (!ssidRef || ssidRef.includes('WLANConfiguration.1'))) {
                                const mac = entry?.MACAddress?._value || entry?.MACAddress || '-';
                                const hostname = entry?.HostName?._value || entry?.HostName || '-';
                                const ip = entry?.IPAddress?._value || entry?.IPAddress || '-';
                                associatedDevices.push({ mac, hostname, ip });
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Error parsing associated devices SSID 1:', e);
        }
        
        // Ambil informasi uptime
        let uptime = getParameterWithPaths(device, parameterPaths.uptime);
        if (uptime !== 'N/A') {
            uptime = formatUptime(uptime);
        }
        
        // Buat pesan status
        let statusMessage = `📊 *STATUS PERANGKAT*\n\n`;
        statusMessage += `📌 *Status:* ${isOnline ? '🟢 Online' : '🔴 Offline'}\n`;
        statusMessage += `📌 *Terakhir Online:* ${lastInform.toLocaleString()}\n`;
        statusMessage += `📌 *WiFi 2.4GHz:* ${ssid}\n`;
        statusMessage += `📌 *WiFi 5GHz:* ${ssid5G}\n`;
        statusMessage += `📌 *Pengguna Terhubung:* ${totalConnectedUsers}\n`;
        // Tambahkan detail user SSID 1 jika ada
        if (associatedDevices.length > 0) {
            statusMessage += `• *Daftar User SSID 1 (2.4GHz):*\n`;
            associatedDevices.forEach((dev, idx) => {
                statusMessage += `   ${idx + 1}. ${dev.hostname} (${dev.ip}) - ${dev.mac}\n`;
            });
        } else {
            statusMessage += `• Tidak ada user WiFi yang terhubung di SSID 1 (2.4GHz)\n`;
        }
        
        // Tambahkan RX Power dengan indikator kualitas
        if (rxPower !== 'N/A') {
            const rxValue = parseFloat(rxPower);
            let qualityIndicator = '';
            if (rxValue > -25) qualityIndicator = ' (🟢 Baik)';
            else if (rxValue > -27) qualityIndicator = ' (🟡 Warning)';
            else qualityIndicator = ' (🔴 Kritis)';
            statusMessage += `📌 *RX Power:* ${formattedRxPower}${qualityIndicator}\n`;
        } else {
            statusMessage += `📌 *RX Power:* ${formattedRxPower}\n`;
        }
        
        statusMessage += `📌 *PPPoE Username:* ${pppUsername}\n`;
        statusMessage += `📌 *IP Address:* ${ipAddress}\n`;
        
        // Tambahkan uptime jika tersedia
        if (uptime !== 'N/A') {
            statusMessage += `📌 *Uptime:* ${uptime}\n`;
        }
        statusMessage += `\n`;
        
        // Tambahkan informasi tambahan
        statusMessage += `â„¹ï¸ Untuk mengubah nama WiFi, ketik:\n`;
        statusMessage += `*gantiwifi [nama]*\n\n`;
        statusMessage += `â„¹ï¸ Untuk mengubah password WiFi, ketik:\n`;
        statusMessage += `*gantipass [password]*\n\n`;
        
        // Kirim pesan status dengan header dan footer
        await sendFormattedMessage(remoteJid, statusMessage);
        console.log(`Pesan status terkirim ke ${remoteJid}`);
        
        return true;
    } catch (error) {
        console.error('Error sending status message:', error);
        
        // Kirim pesan error dengan header dan footer
        await sendFormattedMessage(remoteJid, `âŒ *Error*\n\nTerjadi kesalahan saat mengambil status perangkat. Silakan coba lagi nanti.`);
        
        return false;
    }
}

async function handleHelpCommand(remoteJid, isAdmin = false) {
    try {
        let helpMessage;
        if (isAdmin) {
            helpMessage = getAdminHelpMessage();
        } else {
            helpMessage = getCustomerHelpMessage();
        }
        await sendFormattedMessage(remoteJid, helpMessage);
        return true;
    } catch (error) {
        console.error('Error sending help message:', error);
        return false;
    }
}

// Fungsi untuk menampilkan menu admin
async function sendAdminMenuList(remoteJid) {
        try {
            console.log(`Menampilkan menu admin ke ${remoteJid}`);
            
            // Gunakan help message dari file terpisah
            const adminMessage = getAdminHelpMessage();
            
            // Kirim pesan menu admin
            await sock.sendMessage(remoteJid, { text: adminMessage });
            console.log(`Pesan menu admin terkirim ke ${remoteJid}`);
            
        } catch (error) {
            console.error('Error sending admin menu:', error);
            await sock.sendMessage(remoteJid, { 
                text: `âŒ *ERROR*\n\nTerjadi kesalahan saat menampilkan menu admin:\n${error.message}` 
            });
        }
    }

// Update fungsi getDeviceByNumber
async function getDeviceByNumber(number) {
    try {
        console.log(`🔍 [GET_DEVICE] Mencari perangkat untuk nomor ${number}`);
        
        // Bersihkan nomor dari karakter non-digit
        let cleanNumber = number.replace(/\D/g, '');
        
        // PENTING: SELALU cari customer di database terlebih dahulu, baru cari device di GenieACS
        // Alur: Database Customer -> PPPoE Username -> GenieACS Device
        console.log(`🔍 [GET_DEVICE] Mencari customer di database terlebih dahulu...`);
        
        try {
            const sqlite3 = require('sqlite3').verbose();
            const path = require('path');
            const dbPath = path.join(__dirname, '../data/billing.db');
            const db = new sqlite3.Database(dbPath);
            
            // Coba berbagai kombinasi digit dari nomor untuk mencari customer
            const searchPatterns = [];
            
            // Untuk JID @lid yang panjang (seperti 113683606814724), coba berbagai kombinasi digit
            // karena JID @lid mungkin mengandung nomor telepon di dalamnya
            if (cleanNumber.length > 12) {
                // Coba berbagai kombinasi digit dari JID panjang
                // Contoh: 113683606814724 mungkin mengandung 083152818098 di dalamnya
                for (let start = 0; start <= cleanNumber.length - 8; start++) {
                    for (let len = 8; len <= 12 && start + len <= cleanNumber.length; len++) {
                        const digits = cleanNumber.substring(start, start + len);
                        if (digits.length >= 8) {
                            searchPatterns.push(`%${digits}%`);
                        }
                    }
                }
            } else {
                // Ambil beberapa digit terakhir (8-12 digit)
                for (let i = 8; i <= 12; i++) {
                    const digits = cleanNumber.slice(-i);
                    if (digits.length >= 8) {
                        searchPatterns.push(`%${digits}%`);
                    }
                }
                
                // Coba dengan beberapa digit di tengah juga
                if (cleanNumber.length > 12) {
                    const middleDigits = cleanNumber.slice(-11, -1); // 10 digit di tengah
                    if (middleDigits.length >= 8) {
                        searchPatterns.push(`%${middleDigits}%`);
                    }
                }
            }
            
            // Hapus duplikat pattern
            const uniquePatterns = [...new Set(searchPatterns)];
            
            // Jika masih belum ada pattern, coba semua kombinasi yang mungkin
            if (uniquePatterns.length === 0) {
                // Ambil beberapa digit terakhir sebagai fallback
                const last10 = cleanNumber.slice(-10);
                const last9 = cleanNumber.slice(-9);
                const last8 = cleanNumber.slice(-8);
                uniquePatterns.push(`%${last10}%`, `%${last9}%`, `%${last8}%`);
            }
            
            // Gunakan uniquePatterns sebagai searchPatterns
            const searchPatternsFinal = uniquePatterns.slice(0, 50); // Batasi maksimal 50 pattern untuk performa
            
            return new Promise((resolve) => {
                // Cari customer di database dengan semua pattern
                const query = 'SELECT phone, pppoe_username FROM customers WHERE ' + 
                             searchPatternsFinal.map(() => 'phone LIKE ?').join(' OR ') + ' LIMIT 1';
                
                db.get(query, searchPatterns, async (err, row) => {
                    if (!err && row && row.phone) {
                        console.log(`✅ [GET_DEVICE] Customer ditemukan di database: ${row.phone} (PPPoE: ${row.pppoe_username || 'N/A'})`);
                        
                        // PENTING: Verifikasi bahwa nomor customer benar-benar cocok dengan nomor pengirim
                        // Ini untuk mencegah kebocoran data ke pelanggan lain
                        const customerPhone = row.phone.replace(/\D/g, '');
                        const customerPhoneNormalized = normalizePhone(customerPhone);
                        const senderNumberNormalized = normalizePhone(cleanNumber);
                        
                        // Verifikasi bahwa nomor customer cocok dengan nomor pengirim
                        if (customerPhoneNormalized === senderNumberNormalized || 
                            customerPhone.includes(cleanNumber.slice(-10)) || 
                            cleanNumber.includes(customerPhone.slice(-10)) ||
                            customerPhone.slice(-10) === cleanNumber.slice(-10) ||
                            customerPhone.slice(-9) === cleanNumber.slice(-9) ||
                            customerPhone.slice(-8) === cleanNumber.slice(-8)) {
                            
                            console.log(`✅ [GET_DEVICE] Nomor customer (${row.phone}) cocok dengan nomor pengirim (${cleanNumber})`);
                            
                            // Jika ada PPPoE username, cari device di GenieACS berdasarkan PPPoE username
                            if (row.pppoe_username) {
                                try {
                                    const genieacsModule = require('./genieacs');
                                    const device = await genieacsModule.findDeviceByPPPoE(row.pppoe_username);
                                    if (device) {
                                        console.log(`✅ [GET_DEVICE] Device ditemukan di GenieACS dengan PPPoE username: ${row.pppoe_username} untuk customer: ${row.phone}`);
                                        db.close();
                                        resolve(device);
                                        return;
                                    } else {
                                        console.log(`⚠️ [GET_DEVICE] Device tidak ditemukan di GenieACS dengan PPPoE username: ${row.pppoe_username}`);
                                    }
                                } catch (pppoeError) {
                                    console.log(`⚠️ [GET_DEVICE] Error mencari device dengan PPPoE: ${pppoeError.message}`);
                                }
                            } else {
                                console.log(`⚠️ [GET_DEVICE] Customer tidak memiliki PPPoE username`);
                            }
                            
                            // Jika tidak ditemukan dengan PPPoE, coba cari dengan nomor telepon customer
                            console.log(`🔍 [GET_DEVICE] Mencoba mencari device dengan nomor customer: ${customerPhone}`);
                            const device = await searchDeviceWithFormats(customerPhone);
                            db.close();
                            resolve(device);
                            return;
                        } else {
                            console.log(`🔒 [GET_DEVICE] Keamanan: Nomor customer (${row.phone}) tidak cocok dengan nomor pengirim (${cleanNumber}), skip untuk mencegah kebocoran data`);
                        }
                    }
                    
                    // Jika tidak ditemukan dengan pattern, coba cari semua pelanggan dan match manual
                    console.log(`⚠️ [GET_DEVICE] Customer tidak ditemukan dengan pattern, mencoba mencari semua pelanggan...`);
                    
                    db.all('SELECT phone, pppoe_username FROM customers WHERE pppoe_username IS NOT NULL AND pppoe_username != "" ORDER BY id LIMIT 200', [], async (err2, rows) => {
                        if (!err2 && rows && rows.length > 0) {
                            console.log(`🔍 [GET_DEVICE] Mencari di ${rows.length} pelanggan dengan PPPoE username...`);
                            
                            // PENTING: Hanya cari device untuk customer yang nomornya cocok dengan nomor pengirim
                            // Jangan mencari device untuk semua customer untuk mencegah kebocoran data
                            console.log(`🔍 [GET_DEVICE] Mencoba match nomor pengirim dengan customer yang terdaftar...`);
                            for (const customer of rows) {
                                const customerPhone = customer.phone.replace(/\D/g, '');
                                
                                // Cek berbagai kombinasi digit (lebih agresif)
                                const customerPhoneLast10 = customerPhone.slice(-10);
                                const customerPhoneLast9 = customerPhone.slice(-9);
                                const customerPhoneLast8 = customerPhone.slice(-8);
                                const customerPhoneLast7 = customerPhone.slice(-7);
                                const customerPhoneLast6 = customerPhone.slice(-6);
                                
                                const numLast10 = cleanNumber.slice(-10);
                                const numLast9 = cleanNumber.slice(-9);
                                const numLast8 = cleanNumber.slice(-8);
                                const numLast7 = cleanNumber.slice(-7);
                                const numLast6 = cleanNumber.slice(-6);
                                
                                // Cek apakah ada match dengan berbagai kombinasi (lebih luas)
                                const isMatch = customerPhoneLast10 === numLast10 || 
                                    customerPhoneLast9 === numLast9 || 
                                    customerPhoneLast8 === numLast8 ||
                                    customerPhoneLast7 === numLast7 ||
                                    customerPhoneLast6 === numLast6 ||
                                    customerPhone.includes(numLast10) ||
                                    customerPhone.includes(numLast9) ||
                                    customerPhone.includes(numLast8) ||
                                    customerPhone.includes(numLast7) ||
                                    customerPhone.includes(numLast6) ||
                                    numLast10.includes(customerPhoneLast10) ||
                                    numLast9.includes(customerPhoneLast9) ||
                                    numLast8.includes(customerPhoneLast8) ||
                                    cleanNumber.includes(customerPhone) ||
                                    customerPhone.includes(cleanNumber.slice(-10)) ||
                                    customerPhone.includes(cleanNumber.slice(-9)) ||
                                    customerPhone.includes(cleanNumber.slice(-8));
                                
                                if (isMatch) {
                                    console.log(`✅ [GET_DEVICE] Customer ditemukan dengan match manual: ${customer.phone} (PPPoE: ${customer.pppoe_username || 'N/A'})`);
                                    
                                    // PENTING: Verifikasi bahwa nomor customer benar-benar cocok dengan nomor pengirim
                                    // Ini untuk mencegah kebocoran data ke pelanggan lain
                                    const customerPhoneNormalized = normalizePhone(customerPhone);
                                    const senderNumberNormalized = normalizePhone(cleanNumber);
                                    
                                    // Verifikasi bahwa nomor customer benar-benar cocok dengan nomor pengirim
                                    if (customerPhoneNormalized === senderNumberNormalized || 
                                        customerPhone.includes(cleanNumber.slice(-10)) || 
                                        cleanNumber.includes(customerPhone.slice(-10)) ||
                                        customerPhone.slice(-10) === cleanNumber.slice(-10) ||
                                        customerPhone.slice(-9) === cleanNumber.slice(-9) ||
                                        customerPhone.slice(-8) === cleanNumber.slice(-8)) {
                                        
                                        console.log(`✅ [GET_DEVICE] Nomor customer (${customer.phone}) cocok dengan nomor pengirim (${cleanNumber})`);
                                        
                                        // Jika ada PPPoE username, cari device di GenieACS berdasarkan PPPoE username (prioritas)
                                        if (customer.pppoe_username) {
                                            try {
                                                const genieacsModule = require('./genieacs');
                                                const device = await genieacsModule.findDeviceByPPPoE(customer.pppoe_username);
                                                if (device) {
                                                    console.log(`✅ [GET_DEVICE] Device ditemukan di GenieACS dengan PPPoE username: ${customer.pppoe_username} untuk customer: ${customer.phone}`);
                                                    db.close();
                                                    resolve(device);
                                                    return;
                                                } else {
                                                    console.log(`⚠️ [GET_DEVICE] Device tidak ditemukan di GenieACS dengan PPPoE username: ${customer.pppoe_username}`);
                                                }
                                            } catch (pppoeError) {
                                                console.log(`⚠️ [GET_DEVICE] Error mencari device dengan PPPoE: ${pppoeError.message}`);
                                            }
                                        }
                                        
                                        // Jika tidak ditemukan dengan PPPoE, coba cari dengan nomor telepon customer
                                        const device = await searchDeviceWithFormats(customerPhone);
                                        db.close();
                                        resolve(device);
                                        return;
                                    } else {
                                        console.log(`🔒 [GET_DEVICE] Keamanan: Nomor customer (${customer.phone}) tidak cocok dengan nomor pengirim (${cleanNumber}), skip untuk mencegah kebocoran data`);
                                    }
                                }
                            }
                            
                            // PENTING: Jangan mencari device untuk semua customer jika nomor tidak cocok
                            // Ini untuk mencegah kebocoran data ke pelanggan lain
                            console.log(`⚠️ [GET_DEVICE] Tidak ada customer yang nomornya cocok dengan nomor pengirim (${cleanNumber})`);
                            console.log(`🔒 [GET_DEVICE] Keamanan: Tidak mencari device untuk customer lain untuk mencegah kebocoran data`);
                        }
                        
                        // Jika tidak ditemukan di semua pelanggan, coba cari dengan format normal (fallback)
                        console.log(`⚠️ [GET_DEVICE] Customer tidak ditemukan di semua pelanggan, mencoba dengan format normal...`);
                        db.close();
                        const device = await searchDeviceWithFormats(cleanNumber);
                        resolve(device);
                    });
                });
            });
        } catch (dbError) {
            console.warn(`⚠️ [GET_DEVICE] Error searching database:`, dbError.message);
            // Fallback: cari dengan format normal
            return await searchDeviceWithFormats(cleanNumber);
        }
        
        // PENTING: Jika nomor terlalu panjang atau tidak terlihat seperti nomor telepon Indonesia,
        // coba cari di database pelanggan terlebih dahulu untuk mendapatkan nomor yang benar
        if (false && (cleanNumber.length > 15 || (!cleanNumber.startsWith('0') && !cleanNumber.startsWith('62') && !cleanNumber.startsWith('8')))) {
            console.log(`⚠️ [GET_DEVICE] Nomor tidak terlihat valid (${cleanNumber}, length: ${cleanNumber.length}), mencoba mencari di database...`);
            try {
                const sqlite3 = require('sqlite3').verbose();
                const path = require('path');
                const dbPath = path.join(__dirname, '../data/billing.db');
                const db = new sqlite3.Database(dbPath);
                
                // Coba cari pelanggan dengan nomor yang mungkin terkait
                // Coba berbagai kombinasi digit dari nomor
                const searchPatterns = [];
                
                // Ambil beberapa digit terakhir (8-12 digit)
                for (let i = 8; i <= 12; i++) {
                    const digits = cleanNumber.slice(-i);
                    if (digits.length >= 8) {
                        searchPatterns.push(`%${digits}%`);
                    }
                }
                
                // Coba dengan beberapa digit di tengah juga
                if (cleanNumber.length > 12) {
                    const middleDigits = cleanNumber.slice(-11, -1); // 10 digit di tengah
                    if (middleDigits.length >= 8) {
                        searchPatterns.push(`%${middleDigits}%`);
                    }
                }
                
                // Jika masih belum ada pattern, coba semua kombinasi yang mungkin
                if (searchPatterns.length === 0) {
                    // Ambil beberapa digit terakhir sebagai fallback
                    const last10 = cleanNumber.slice(-10);
                    const last9 = cleanNumber.slice(-9);
                    const last8 = cleanNumber.slice(-8);
                    searchPatterns.push(`%${last10}%`, `%${last9}%`, `%${last8}%`);
                }
                
                return new Promise((resolve) => {
                    const query = 'SELECT phone, pppoe_username FROM customers WHERE ' + 
                                 searchPatterns.map(() => 'phone LIKE ?').join(' OR ') + ' LIMIT 1';
                    
                    db.get(query, searchPatterns, async (err, row) => {
                        if (!err && row && row.phone) {
                            console.log(`✅ [GET_DEVICE] Nomor ditemukan di database: ${row.phone} (PPPoE: ${row.pppoe_username || 'N/A'})`);
                            const customerPhone = row.phone.replace(/\D/g, '');
                            
                            // Gunakan nomor dari database untuk mencari device
                            cleanNumber = customerPhone;
                            
                            // Jika ada PPPoE username, coba cari dengan itu juga (prioritas)
                            if (row.pppoe_username) {
                                try {
                                    const { genieacsApi } = require('./genieacs');
                                    const device = await genieacsApi.findDeviceByPPPoE(row.pppoe_username);
                                    if (device) {
                                        console.log(`✅ [GET_DEVICE] Device ditemukan dengan PPPoE username: ${row.pppoe_username}`);
                                        db.close();
                                        resolve(device);
                                        return;
                                    }
                                } catch (pppoeError) {
                                    console.log(`⚠️ [GET_DEVICE] Error mencari dengan PPPoE: ${pppoeError.message}`);
                                }
                            }
                            
                            // Lanjutkan dengan pencarian normal menggunakan nomor dari database
                            db.close();
                            const device = await searchDeviceWithFormats(customerPhone);
                            resolve(device);
                            return;
                        }
                        
                        // Jika tidak ditemukan dengan pattern, coba cari semua pelanggan dan match manual
                        console.log(`⚠️ [GET_DEVICE] Nomor tidak ditemukan dengan pattern, mencoba mencari semua pelanggan...`);
                        
                        db.all('SELECT phone, pppoe_username FROM customers LIMIT 200', [], async (err2, rows) => {
                            db.close();
                            if (!err2 && rows && rows.length > 0) {
                                // Coba match dengan berbagai kombinasi
                                for (const customer of rows) {
                                    const customerPhone = customer.phone.replace(/\D/g, '');
                                    const customerPhoneLast10 = customerPhone.slice(-10);
                                    const customerPhoneLast9 = customerPhone.slice(-9);
                                    const customerPhoneLast8 = customerPhone.slice(-8);
                                    
                                    const numLast10 = cleanNumber.slice(-10);
                                    const numLast9 = cleanNumber.slice(-9);
                                    const numLast8 = cleanNumber.slice(-8);
                                    
                                    // Cek apakah ada match
                                    if (customerPhoneLast10 === numLast10 || 
                                        customerPhoneLast9 === numLast9 || 
                                        customerPhoneLast8 === numLast8 ||
                                        customerPhone.includes(numLast10) ||
                                        customerPhone.includes(numLast9) ||
                                        customerPhone.includes(numLast8)) {
                                        console.log(`✅ [GET_DEVICE] Nomor ditemukan dengan match manual: ${customer.phone} (PPPoE: ${customer.pppoe_username || 'N/A'})`);
                                        
                                        // Jika ada PPPoE username, coba cari dengan itu juga (prioritas)
                                        if (customer.pppoe_username) {
                                            try {
                                                const { genieacsApi } = require('./genieacs');
                                                const device = await genieacsApi.findDeviceByPPPoE(customer.pppoe_username);
                                                if (device) {
                                                    console.log(`✅ [GET_DEVICE] Device ditemukan dengan PPPoE username: ${customer.pppoe_username}`);
                                                    resolve(device);
                                                    return;
                                                }
                                            } catch (pppoeError) {
                                                console.log(`⚠️ [GET_DEVICE] Error mencari dengan PPPoE: ${pppoeError.message}`);
                                            }
                                        }
                                        
                                        // Lanjutkan dengan pencarian normal menggunakan nomor dari database
                                        const device = await searchDeviceWithFormats(customerPhone);
                                        resolve(device);
                                        return;
                                    }
                                }
                            }
                            
                            // Jika tidak ditemukan di semua pelanggan, coba cari dengan format normal
                            console.log(`⚠️ [GET_DEVICE] Nomor tidak ditemukan di semua pelanggan, mencoba dengan format normal...`);
                            const device = await searchDeviceWithFormats(cleanNumber);
                            resolve(device);
                        });
                    });
                });
            } catch (dbError) {
                console.warn(`⚠️ [GET_DEVICE] Error searching database:`, dbError.message);
                // Lanjutkan dengan pencarian normal
                return await searchDeviceWithFormats(cleanNumber);
            }
        }
        
        // Jika nomor terlihat valid, langsung cari dengan format normal
        return await searchDeviceWithFormats(cleanNumber);
        
    } catch (error) {
        console.error('❌ [GET_DEVICE] Error getting device by number:', error);
        return null;
    }
}

// Helper function untuk mencari device dengan berbagai format nomor
async function searchDeviceWithFormats(cleanNumber) {
        // Format nomor dalam beberapa variasi yang mungkin digunakan sebagai tag
        const possibleFormats = [];
        
        // Format 1: Nomor asli yang dibersihkan
        possibleFormats.push(cleanNumber);
        
        // Format 2: Jika diawali 0, coba versi dengan 62 di depan (ganti 0 dengan 62)
        if (cleanNumber.startsWith('0')) {
            possibleFormats.push('62' + cleanNumber.substring(1));
        }
        
        // Format 3: Jika diawali 62, coba versi dengan 0 di depan (ganti 62 dengan 0)
        if (cleanNumber.startsWith('62')) {
            possibleFormats.push('0' + cleanNumber.substring(2));
        }
        
        // Format 4: Tanpa awalan, jika ada awalan
        if (cleanNumber.startsWith('0') || cleanNumber.startsWith('62')) {
            if (cleanNumber.startsWith('0')) {
                possibleFormats.push(cleanNumber.substring(1));
            } else if (cleanNumber.startsWith('62')) {
                possibleFormats.push(cleanNumber.substring(2));
            }
        }
        
    console.log(`🔍 [GET_DEVICE] Mencoba format nomor berikut: ${possibleFormats.join(', ')}`);
        
        // Coba cari dengan semua format yang mungkin
        for (const format of possibleFormats) {
            try {
                const device = await findDeviceByTag(format);
                if (device) {
                console.log(`✅ [GET_DEVICE] Perangkat ditemukan dengan tag nomor: ${format}`);
                    return device;
                }
            } catch (formatError) {
            console.log(`⚠️ [GET_DEVICE] Gagal mencari dengan format ${format}: ${formatError.message}`);
                // Lanjut ke format berikutnya
            }
        }
        
    // Jika tidak ditemukan dengan tag, coba cari dengan PPPoE username dari database
    try {
        const sqlite3 = require('sqlite3').verbose();
        const path = require('path');
        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);
        
        return new Promise((resolve) => {
            // Cari pelanggan dengan nomor yang cocok
            const searchPatterns = possibleFormats.map(f => `%${f}%`);
            const query = 'SELECT pppoe_username FROM customers WHERE ' + 
                         searchPatterns.map(() => 'phone LIKE ?').join(' OR ') + ' LIMIT 1';
            
            db.get(query, searchPatterns, async (err, row) => {
                db.close();
                if (!err && row && row.pppoe_username) {
                    console.log(`🔍 [GET_DEVICE] Mencari device dengan PPPoE username: ${row.pppoe_username}`);
                    try {
                        const { genieacsApi } = require('./genieacs');
                        const device = await genieacsApi.findDeviceByPPPoE(row.pppoe_username);
                        if (device) {
                            console.log(`✅ [GET_DEVICE] Device ditemukan dengan PPPoE username: ${row.pppoe_username}`);
                            resolve(device);
                            return;
                        }
                    } catch (pppoeError) {
                        console.log(`⚠️ [GET_DEVICE] Error mencari dengan PPPoE: ${pppoeError.message}`);
                    }
                }
                console.log(`❌ [GET_DEVICE] Perangkat tidak ditemukan untuk nomor dengan semua format yang dicoba`);
                resolve(null);
            });
        });
    } catch (dbError) {
        console.warn(`⚠️ [GET_DEVICE] Error searching database for PPPoE:`, dbError.message);
        return null;
    }
}

// Tambah handler untuk tombol refresh
async function handleRefreshCommand(senderNumber, remoteJid) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }

    try {
        // Kirim pesan bahwa proses refresh sedang berlangsung
        await sock.sendMessage(remoteJid, { 
            text: `⏳ *PROSES REFRESH*\n\nSedang memperbarui informasi perangkat...\nMohon tunggu sebentar.` 
        });

        // Cari perangkat berdasarkan nomor pengirim
        const device = await getDeviceByNumber(senderNumber);
        
        if (!device) {
            await sock.sendMessage(remoteJid, { 
                text: `âŒ *PERANGKAT TIDAK DITEMUKAN*\n\nMaaf, tidak dapat menemukan perangkat yang terkait dengan nomor Anda.` 
            });
            return;
        }

        // Lakukan refresh perangkat 
        const deviceId = device._id;
        console.log(`Refreshing device ID: ${deviceId}`);
        const refreshResult = await refreshDevice(deviceId);

        if (refreshResult.success) {
            // Tunggu sebentar untuk memastikan data telah diperbarui
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Ambil data terbaru 
            try {
                const updatedDevice = await getDeviceByNumber(senderNumber);
                const model = updatedDevice.InternetGatewayDevice?.DeviceInfo?.ModelName?._value || 'N/A';
                const serialNumber = updatedDevice.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value || 'N/A';
                const lastInform = new Date(updatedDevice._lastInform).toLocaleString();
                
                await sock.sendMessage(remoteJid, { 
                    text: `✅ *REFRESH BERHASIL*\n\n` +
                          `Perangkat berhasil diperbarui!\n\n` +
                          `📋 *Detail Perangkat:*\n` +
                          `• Serial Number: ${serialNumber}\n` +
                          `• Model: ${model}\n` +
                          `• Last Inform: ${lastInform}\n\n` +
                          `Gunakan perintah *status* untuk melihat informasi lengkap perangkat.`
                });
            } catch (updateError) {
                console.error('Error getting updated device info:', updateError);
                
                // Tetap kirim pesan sukses meskipun gagal mendapatkan info terbaru
                await sock.sendMessage(remoteJid, { 
                    text: `✅ *REFRESH BERHASIL*\n\n` +
                          `Perangkat berhasil diperbarui!\n\n` +
                          `Gunakan perintah *status* untuk melihat informasi lengkap perangkat.`
                });
            }
        } else {
            await sock.sendMessage(remoteJid, { 
                text: `âŒ *REFRESH GAGAL*\n\n` +
                      `Terjadi kesalahan saat memperbarui perangkat:\n` +
                      `${refreshResult.message || 'Kesalahan tidak diketahui'}\n\n` +
                      `Silakan coba lagi nanti atau hubungi admin.`
            });
        }
    } catch (error) {
        console.error('Error in handleRefreshCommand:', error);
        await sock.sendMessage(remoteJid, { 
            text: `âŒ *ERROR*\n\nTerjadi kesalahan saat memproses perintah:\n${error.message}`
        });
    }
}

// Fungsi untuk melakukan refresh perangkat
async function refreshDevice(deviceId) {
    try {
        console.log(`Refreshing device with ID: ${deviceId}`);
        if (!deviceId) {
            return { success: false, message: "Device ID tidak valid" };
        }
        // Ambil konfigurasi GenieACS dari helper (dari database genieacs_servers)
        const { genieacsUrl, genieacsUsername, genieacsPassword } = await getGenieacsConfig();
        // 2. Coba mendapatkan device terlebih dahulu untuk memastikan ID valid
        // Cek apakah device ada
        try {
            const checkResponse = await axios.get(`${genieacsUrl}/devices?query={"_id":"${deviceId}"}`, {
                auth: {
                    username: genieacsUsername,
                    password: genieacsPassword
                }
            });
            if (!checkResponse.data || checkResponse.data.length === 0) {
                console.error(`Device with ID ${deviceId} not found`);
                return { success: false, message: "Perangkat tidak ditemukan di sistem" };
            }
            const exactDeviceId = checkResponse.data[0]._id;
            console.log(`Using exact device ID: ${exactDeviceId}`);
            const encodedDeviceId = encodeURIComponent(exactDeviceId);
            console.log(`Sending refresh task to: ${genieacsUrl}/devices/${encodedDeviceId}/tasks`);
            const refreshResponse = await axios.post(
                `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
                {
                    name: "refreshObject",
                    objectName: "InternetGatewayDevice" // Gunakan object root
                },
                {
                    auth: {
                        username: genieacsUsername,
                        password: genieacsPassword
                    },
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );
            console.log(`Refresh response status: ${refreshResponse.status}`);
            return { success: true, message: "Perangkat berhasil diperbarui" };
        } catch (checkError) {
            console.error(`Error checking device: ${checkError.message}`);
            console.log(`Trying alternative approach for device ${deviceId}`);
            try {
                const encodedDeviceId1 = encodeURIComponent(deviceId);
                const encodedDeviceId2 = deviceId.replace(/:/g, '%3A').replace(/\//g, '%2F');
                const attempts = [encodedDeviceId1, encodedDeviceId2, deviceId];
                for (const attemptedId of attempts) {
                    try {
                        console.log(`Trying refresh with ID format: ${attemptedId}`);
                        const response = await axios.post(
                            `${genieacsUrl}/devices/${attemptedId}/tasks`,
                            {
                                name: "refreshObject",
                                objectName: ""  // Kosong untuk refresh semua
                            },
                            {
                                auth: {
                                    username: genieacsUsername,
                                    password: genieacsPassword
                                },
                                timeout: 5000
                            }
                        );
                        console.log(`Refresh successful with ID format: ${attemptedId}`);
                        return { success: true, message: "Perangkat berhasil diperbarui" };
                    } catch (attemptError) {
                        console.error(`Failed with ID format ${attemptedId}: ${attemptError.message}`);
                    }
                }
                throw new Error("Semua percobaan refresh gagal");
            } catch (altError) {
                console.error(`All refresh attempts failed: ${altError.message}`);
                throw altError;
            }
        }
    } catch (error) {
        console.error('Error refreshing device:', error);
        let errorMessage = "Kesalahan tidak diketahui";
        if (error.response) {
            errorMessage = `Error ${error.response.status}: ${error.response.data || 'No response data'}`;
        } else if (error.request) {
            errorMessage = "Tidak ada respons dari server GenieACS";
        } else {
            errorMessage = error.message;
        }
        return { 
            success: false, 
            message: `Gagal memperbarui perangkat: ${errorMessage}` 
        };
    }
}

// Tambahkan handler untuk menu admin
// Fungsi handleAdminMenu sudah didefinisikan di bawah, tidak perlu duplikat
// async function handleAdminMenu(remoteJid) {
//     // handleAdminMenu hanya memanggil sendAdminMenuList, tidak perlu perubahan
//     await sendAdminMenuList(remoteJid);
// }

// Update handler admin check ONU
async function handleAdminCheckONU(remoteJid, customerNumber) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }

    if (!customerNumber) {
        await sock.sendMessage(remoteJid, { 
            text: `âŒ *FORMAT SALAH*\n\n` +
                  `Format yang benar:\n` +
                  `admincheck [nomor_pelanggan]\n\n` +
                  `Contoh:\n` +
                  `admincheck 123456`
        });
        return;
    }

    try {
        // Kirim pesan bahwa proses sedang berlangsung
        await sock.sendMessage(remoteJid, { 
            text: `🔍 *MENCARI PERANGKAT*\n\nSedang mencari perangkat untuk pelanggan ${customerNumber}...\nMohon tunggu sebentar.` 
        });

        // Cari perangkat berdasarkan nomor pelanggan
        const device = await findDeviceByTag(customerNumber);
        
        if (!device) {
            await sock.sendMessage(remoteJid, { 
                text: `âŒ *PERANGKAT TIDAK DITEMUKAN*\n\n` +
                      `Tidak dapat menemukan perangkat untuk pelanggan dengan nomor ${customerNumber}.\n\n` +
                      `Pastikan nomor pelanggan benar dan perangkat telah terdaftar dalam sistem.`
            });
            return;
        }

        // Ekstrak informasi perangkat - Gunakan pendekatan yang sama dengan dashboard web
        // Coba ambil dari berbagai kemungkinan path untuk memastikan konsistensi dengan dashboard
        let serialNumber = device.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value || 
                          device.Device?.DeviceInfo?.SerialNumber?._value || 
                          device.DeviceID?.SerialNumber || 
                          device._id?.split('-')[2] || 'Unknown';
        
        // Coba ambil model dari berbagai kemungkinan path
        let modelName = device.InternetGatewayDevice?.DeviceInfo?.ModelName?._value || 
                        device.Device?.DeviceInfo?.ModelName?._value || 
                        device.DeviceID?.ProductClass || 
                        device._id?.split('-')[1] || 'Unknown';
        
        const lastInform = new Date(device._lastInform);
        const now = new Date();
        const diffMinutes = Math.floor((now - lastInform) / (1000 * 60));
        const isOnline = diffMinutes < 15;
        const statusText = isOnline ? '🟢 Online' : '🔴 Offline';
        
        // Informasi WiFi
        const ssid = device.InternetGatewayDevice?.LANDevice?.[1]?.WLANConfiguration?.[1]?.SSID?._value || 'N/A';
        const ssid5G = device.InternetGatewayDevice?.LANDevice?.[1]?.WLANConfiguration?.[5]?.SSID?._value || 'N/A';
        
        // Informasi IP
        const ipAddress = device.InternetGatewayDevice?.WANDevice?.[1]?.WANConnectionDevice?.[1]?.WANPPPConnection?.[1]?.ExternalIPAddress?._value || 'N/A';
        
        // Informasi PPPoE
        const pppoeUsername = 
            device.InternetGatewayDevice?.WANDevice?.[1]?.WANConnectionDevice?.[1]?.WANPPPConnection?.[1]?.Username?._value ||
            device.InternetGatewayDevice?.WANDevice?.[0]?.WANConnectionDevice?.[0]?.WANPPPConnection?.[0]?.Username?._value ||
            device.VirtualParameters?.pppoeUsername?._value ||
            'N/A';
        
        // Ambil RX Power dari semua kemungkinan path
        const rxPower = getParameterWithPaths(device, parameterPaths.rxPower);
        let rxPowerStatus = '';
        if (rxPower !== 'N/A') {
            const power = parseFloat(rxPower);
            if (power > -25) rxPowerStatus = '🟢 Baik';
            else if (power > -27) rxPowerStatus = '🟡 Warning';
            else rxPowerStatus = '🔴 Kritis';
        }
        
        // Informasi pengguna WiFi
        const users24ghz = device.InternetGatewayDevice?.LANDevice?.[1]?.WLANConfiguration?.[1]?.TotalAssociations?._value || 0;
        const users5ghz = device.InternetGatewayDevice?.LANDevice?.[1]?.WLANConfiguration?.[5]?.TotalAssociations?._value || 0;
        const totalUsers = parseInt(users24ghz) + parseInt(users5ghz);

        // Ambil daftar user terhubung ke SSID 1 (2.4GHz)
        let associatedDevices = [];
        try {
            const assocObj = device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.AssociatedDevice;
            if (assocObj && typeof assocObj === 'object') {
                for (const key in assocObj) {
                    if (!isNaN(key)) {
                        const entry = assocObj[key];
                        const mac = entry?.MACAddress?._value || entry?.MACAddress || '-';
                        const hostname = entry?.HostName?._value || entry?.HostName || '-';
                        associatedDevices.push({ mac, hostname });
                    }
                }
            }
        } catch (e) {
            console.error('Error parsing associated devices (admin):', e);
        }
        // Fallback: jika AssociatedDevice kosong, ambil dari Hosts.Host (hanya WiFi/802.11)
        if (associatedDevices.length === 0) {
            try {
                const hostsObj = device?.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host;
                if (hostsObj && typeof hostsObj === 'object') {
                    for (const key in hostsObj) {
                        if (!isNaN(key)) {
                            const entry = hostsObj[key];
                            // Hanya tampilkan yang interface-nya 802.11 (WiFi)
                            const iface = entry?.InterfaceType?._value || entry?.InterfaceType || entry?.Interface || '-';
                            // Pastikan iface adalah string sebelum memanggil toLowerCase()
                            if (iface && typeof iface === 'string' && iface.toLowerCase().includes('802.11')) {
                                const mac = entry?.MACAddress?._value || entry?.MACAddress || '-';
                                const hostname = entry?.HostName?._value || entry?.HostName || '-';
                                const ip = entry?.IPAddress?._value || entry?.IPAddress || '-';
                                associatedDevices.push({ mac, hostname, ip });
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('Error parsing Hosts.Host (admin):', e);
            }
        }

        // Buat pesan dengan informasi lengkap
        // Gunakan serial number dan model yang sudah diambil sebelumnya
        // Tidak perlu mengubah nilai yang sudah diambil dengan benar

        let message = `📋 *DETAIL PERANGKAT PELANGGAN*\n\n`;
        message += `👤 *Pelanggan:* ${customerNumber}\n`;
        message += `📋 *Serial Number:* ${serialNumber}\n`;
        message += `📋 *Model:* ${modelName}\n`;
        message += `📶 *Status:* ${statusText}\n`;
        message += `â±ï¸ *Last Seen:* ${lastInform.toLocaleString()}\n\n`;
        
        message += `🌐 *INFORMASI JARINGAN*\n`;
        message += `📌 IP Address: ${ipAddress}\n`;
        message += `📌 PPPoE Username: ${pppoeUsername}\n`;
        message += `📌 *RX Power:* ${rxPower ? rxPower + ' dBm' : 'N/A'}${rxPowerStatus ? ' (' + rxPowerStatus + ')' : ''}\n`;
        message += `📌 WiFi 2.4GHz: ${ssid}\n`;
        message += `📌 WiFi 5GHz: ${ssid5G}\n`;
        message += `📌 Pengguna WiFi: ${totalUsers} perangkat\n`;
        // Tambahkan detail user SSID 1 jika ada
        if (associatedDevices.length > 0) {
            message += `• *Daftar User WiFi (2.4GHz):*\n`;
            associatedDevices.forEach((dev, idx) => {
                let detail = `${idx + 1}. ${dev.hostname || '-'} (${dev.mac || '-'}`;
                if (dev.ip) detail += `, ${dev.ip}`;
                detail += ')';
                message += `   ${detail}\n`;
            });
        } else {
            message += `• Tidak ada data user WiFi (2.4GHz) tersedia\n`;
        }
        message += `\n`;
        
        if (rxPower) {
            message += `🔧 *KUALITAS SINYAL*\n`;
            message += `• RX Power: ${rxPower} dBm (${rxPowerStatus})\n\n`;
        }
        
        message += `💡 *TINDAKAN ADMIN*\n`;
        message += `• Ganti SSID: editssid ${customerNumber} [nama_baru]\n`;
        message += `• Ganti Password: editpass ${customerNumber} [password_baru]\n`;
        message += `• Refresh Perangkat: adminrefresh ${customerNumber}`;

        await sock.sendMessage(remoteJid, { text: message });
    } catch (error) {
        console.error('Error in handleAdminCheckONU:', error);
        await sock.sendMessage(remoteJid, { 
            text: `âŒ *ERROR*\n\nTerjadi kesalahan saat memeriksa perangkat:\n${error.message}`
        });
    }
}

// Fungsi untuk cek ONU dengan data billing lengkap
async function handleAdminCheckONUWithBilling(remoteJid, searchTerm) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }

    if (!searchTerm) {
        await sock.sendMessage(remoteJid, { 
            text: `❌ *FORMAT SALAH*\n\n` +
                  `Format yang benar:\n` +
                  `cek [nomor_pelanggan/pppoe_username/nama_pelanggan]\n\n` +
                  `Contoh:\n` +
                  `• cek 087786722675\n` +
                  `• cek server@ilik\n` +
                  `• cek maktub`
        });
        return;
    }

    try {
        // Kirim pesan bahwa proses sedang berlangsung
        await sock.sendMessage(remoteJid, { 
            text: `🔍 *MENCARI PERANGKAT*\n\nSedang mencari perangkat untuk: ${searchTerm}...\nMohon tunggu sebentar.` 
        });

        // Import billing manager untuk mendapatkan data customer
        const billingManager = require('./billing');
        
        // Cari customer di billing dengan berbagai metode
        let customer = null;
        
        // Method 1: Coba sebagai nomor telepon
        if (/^[0-9+]+$/.test(searchTerm)) {
            const phoneVariants = generatePhoneVariants(searchTerm);
            
            for (const variant of phoneVariants) {
                try {
                    customer = await billingManager.getCustomerByPhone(variant);
                    if (customer) {
                        console.log(`✅ Customer found in billing by phone with variant: ${variant}`);
                        break;
                    }
                } catch (error) {
                    console.log(`⚠️ Error searching with phone variant ${variant}:`, error.message);
                }
            }
        }
        
        // Method 2: Jika tidak ditemukan sebagai nomor, coba sebagai nama atau PPPoE username
        if (!customer) {
            try {
                // Cari berdasarkan nama pelanggan
                const customersByName = await billingManager.findCustomersByNameOrPhone(searchTerm);
                if (customersByName && customersByName.length > 0) {
                    customer = customersByName[0]; // Ambil yang pertama
                    console.log(`✅ Customer found in billing by name/pppoe: ${customer.name}`);
                }
            } catch (error) {
                console.log(`⚠️ Error searching by name/pppoe:`, error.message);
            }
        }
        
        let device = null;
        
        if (customer) {
            console.log(`✅ Customer found in billing: ${customer.name} (${customer.phone})`);
            console.log(`📋 Customer data:`, {
                name: customer.name,
                phone: customer.phone,
                username: customer.username,
                pppoe_username: customer.pppoe_username,
                package_id: customer.package_id
            });
            
            // Cari device berdasarkan PPPoE username dari billing (FAST PATH)
            if (customer.pppoe_username || customer.username) {
                try {
                    const { findDeviceByPPPoE } = require('./genieacs');
                    const pppoeToSearch = customer.pppoe_username || customer.username;
                    console.log(`🔍 Searching device by PPPoE username: ${pppoeToSearch}`);
                    
                    device = await findDeviceByPPPoE(pppoeToSearch);
                    if (device) {
                        console.log(`✅ Device found by PPPoE username: ${pppoeToSearch}`);
                        console.log(`📱 Device ID: ${device._id}`);
                    } else {
                        console.log(`⚠️ No device found by PPPoE username: ${pppoeToSearch}`);
                    }
                } catch (error) {
                    console.error('❌ Error finding device by PPPoE username:', error.message);
                    console.error('❌ Full error:', error);
                }
            } else {
                console.log(`⚠️ No PPPoE username or username found in customer data`);
            }
            
            // Jika tidak ditemukan dengan PPPoE, coba dengan tag sebagai fallback
            if (!device) {
                console.log(`🔍 Trying tag search as fallback...`);
                const tagVariants = generatePhoneVariants(customer.phone);
                
                for (const v of tagVariants) {
                    try {
                        device = await findDeviceByTag(v);
                        if (device) {
                            console.log(`✅ Device found by tag fallback: ${v}`);
                            break;
                        }
                    } catch (error) {
                        console.log(`⚠️ Error searching by tag ${v}:`, error.message);
                    }
                }
            }
        } else {
            // Customer tidak ditemukan di billing, coba cari device langsung berdasarkan search term
            console.log(`⚠️ Customer not found in billing, trying direct device search...`);
            
            // Method 1: Coba sebagai PPPoE username langsung
            if (searchTerm.includes('@')) {
                try {
                    const { findDeviceByPPPoE } = require('./genieacs');
                    console.log(`🔍 Trying direct PPPoE username search: ${searchTerm}`);
                    device = await findDeviceByPPPoE(searchTerm);
                    if (device) {
                        console.log(`✅ Device found by direct PPPoE username: ${searchTerm}`);
                        console.log(`📱 Device ID: ${device._id}`);
                    }
                } catch (error) {
                    console.log(`⚠️ Error searching by direct PPPoE username:`, error.message);
                }
            }
            
            // Method 2: Coba sebagai tag (jika search term adalah nomor)
            if (!device && /^[0-9+]+$/.test(searchTerm)) {
                const tagVariants = generatePhoneVariants(searchTerm);
                for (const v of tagVariants) {
                    try {
                        device = await findDeviceByTag(v);
                        if (device) {
                            console.log(`✅ Device found by tag: ${v}`);
                            console.log(`📱 Device ID: ${device._id}`);
                            break;
                        }
                    } catch (error) {
                        console.log(`⚠️ Error searching by tag ${v}:`, error.message);
                    }
                }
            }
        }
        
        // Method 3: Jika masih belum ditemukan, coba cari semua device dan cari manual
        if (!device) {
            console.log(`🔍 Trying comprehensive search in all devices...`);
            try {
                const { getDevices } = require('./genieacs');
                const allDevices = await getDevices();
                console.log(`📊 Total devices in GenieACS: ${allDevices.length}`);
                
                // Cari berdasarkan search term di berbagai field
                for (const dev of allDevices) {
                    // Cek di tags
                    if (dev._tags && dev._tags.some(tag => tag.includes(searchTerm))) {
                        console.log(`✅ Device found by tag match: ${dev._id}`);
                        device = dev;
                        break;
                    }
                    
                    // Cek di VirtualParameters
                    if (dev.VirtualParameters) {
                        for (const key in dev.VirtualParameters) {
                            const value = dev.VirtualParameters[key];
                            if (value && value._value && value._value.toString().includes(searchTerm)) {
                                console.log(`✅ Device found by VirtualParameters match: ${dev._id}`);
                                device = dev;
                                break;
                            }
                        }
                    }
                    
                    if (device) break;
                }
            } catch (error) {
                console.log(`⚠️ Error in comprehensive search:`, error.message);
            }
        }
        
        if (!device) {
            await sock.sendMessage(remoteJid, { 
                text: `❌ *PERANGKAT TIDAK DITEMUKAN*\n\n` +
                      `Tidak dapat menemukan perangkat untuk: ${searchTerm}\n\n` +
                      `Pastikan data yang dimasukkan benar:\n` +
                      `• Nomor telepon\n` +
                      `• PPPoE username (contoh: server@ilik)\n` +
                      `• Nama pelanggan\n\n` +
                      `Dan perangkat telah terdaftar dalam sistem.`
            });
            return;
        }

        // Ekstrak informasi perangkat - Gunakan pendekatan yang sama dengan dashboard web
        let serialNumber = device.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value || 
                          device.Device?.DeviceInfo?.SerialNumber?._value || 
                          device.DeviceID?.SerialNumber || 
                          device._id?.split('-')[2] || 'Unknown';
        
        let modelName = device.InternetGatewayDevice?.DeviceInfo?.ModelName?._value || 
                        device.Device?.DeviceInfo?.ModelName?._value || 
                        device.DeviceID?.ProductClass || 
                        device._id?.split('-')[1] || 'Unknown';
        
        const lastInform = new Date(device._lastInform);
        const now = new Date();
        const diffMinutes = Math.floor((now - lastInform) / (1000 * 60));
        const isOnline = diffMinutes < 15;
        const statusText = isOnline ? '🟢 Online' : '🔴 Offline';
        
        // Informasi WiFi
        const ssid = device.InternetGatewayDevice?.LANDevice?.[1]?.WLANConfiguration?.[1]?.SSID?._value || 'N/A';
        const ssid5G = device.InternetGatewayDevice?.LANDevice?.[1]?.WLANConfiguration?.[5]?.SSID?._value || 'N/A';
        
        // Informasi IP
        const ipAddress = device.InternetGatewayDevice?.WANDevice?.[1]?.WANConnectionDevice?.[1]?.WANPPPConnection?.[1]?.ExternalIPAddress?._value || 'N/A';
        
        // Informasi PPPoE
        const pppoeUsername = 
            device.InternetGatewayDevice?.WANDevice?.[1]?.WANConnectionDevice?.[1]?.WANPPPConnection?.[1]?.Username?._value ||
            device.InternetGatewayDevice?.WANDevice?.[0]?.WANConnectionDevice?.[0]?.WANPPPConnection?.[0]?.Username?._value ||
            device.VirtualParameters?.pppoeUsername?._value ||
            (customer ? (customer.pppoe_username || customer.username) : 'N/A');
        
        // Ambil RX Power dari semua kemungkinan path
        const rxPower = getParameterWithPaths(device, parameterPaths.rxPower);
        let rxPowerStatus = '';
        if (rxPower !== 'N/A') {
            const power = parseFloat(rxPower);
            if (power > -25) rxPowerStatus = '🟢 Baik';
            else if (power > -27) rxPowerStatus = '🟡 Warning';
            else rxPowerStatus = '🔴 Kritis';
        }
        
        // Informasi pengguna WiFi
        const users24ghz = device.InternetGatewayDevice?.LANDevice?.[1]?.WLANConfiguration?.[1]?.TotalAssociations?._value || 0;
        const users5ghz = device.InternetGatewayDevice?.LANDevice?.[1]?.WLANConfiguration?.[5]?.TotalAssociations?._value || 0;
        const totalUsers = parseInt(users24ghz) + parseInt(users5ghz);

        // Ambil daftar user terhubung ke SSID 1 (2.4GHz)
        let associatedDevices = [];
        try {
            const assocObj = device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.AssociatedDevice;
            if (assocObj && typeof assocObj === 'object') {
                for (const key in assocObj) {
                    if (!isNaN(key)) {
                        const entry = assocObj[key];
                        const mac = entry?.MACAddress?._value || entry?.MACAddress || '-';
                        const hostname = entry?.HostName?._value || entry?.HostName || '-';
                        associatedDevices.push({ mac, hostname });
                    }
                }
            }
        } catch (e) {
            console.error('Error parsing associated devices (admin):', e);
        }
        // Fallback: jika AssociatedDevice kosong, ambil dari Hosts.Host (hanya WiFi/802.11)
        if (associatedDevices.length === 0) {
            try {
                const hostsObj = device?.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host;
                if (hostsObj && typeof hostsObj === 'object') {
                    for (const key in hostsObj) {
                        if (!isNaN(key)) {
                            const entry = hostsObj[key];
                            // Hanya tampilkan yang interface-nya 802.11 (WiFi)
                            const iface = entry?.InterfaceType?._value || entry?.InterfaceType || entry?.Interface || '-';
                            // Pastikan iface adalah string sebelum memanggil toLowerCase()
                            if (iface && typeof iface === 'string' && iface.toLowerCase().includes('802.11')) {
                                const mac = entry?.MACAddress?._value || entry?.MACAddress || '-';
                                const hostname = entry?.HostName?._value || entry?.HostName || '-';
                                const ip = entry?.IPAddress?._value || entry?.IPAddress || '-';
                                associatedDevices.push({ mac, hostname, ip });
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('Error parsing Hosts.Host (admin):', e);
            }
        }

        // Buat pesan dengan informasi lengkap
        let message = `📋 *DETAIL PERANGKAT PELANGGAN*\n\n`;
        
        // Data billing jika ada
        if (customer) {
            message += `👤 *DATA BILLING:*\n`;
            message += `• Nama: ${customer.name}\n`;
            message += `• Telepon: ${customer.phone}\n`;
            message += `• Username: ${customer.username || 'N/A'}\n`;
            message += `• PPPoE Username: ${customer.pppoe_username || 'N/A'}\n`;
            message += `• Paket: ${customer.package_id || 'N/A'}\n`;
            message += `• Status: ${customer.status || 'N/A'}\n`;
            if (customer.address) {
                message += `• Alamat: ${customer.address}\n`;
            }
            message += `\n`;
        }
        
        message += `🔧 *DATA PERANGKAT:*\n`;
        message += `• Serial Number: ${serialNumber}\n`;
        message += `• Model: ${modelName}\n`;
        message += `• Status: ${statusText}\n`;
        message += `• Last Seen: ${lastInform.toLocaleString()}\n\n`;
        
        message += `🌐 *INFORMASI JARINGAN:*\n`;
        message += `• IP Address: ${ipAddress}\n`;
        message += `• PPPoE Username: ${pppoeUsername}\n`;
        message += `• RX Power: ${rxPower ? rxPower + ' dBm' : 'N/A'}${rxPowerStatus ? ' (' + rxPowerStatus + ')' : ''}\n`;
        message += `• WiFi 2.4GHz: ${ssid}\n`;
        message += `• WiFi 5GHz: ${ssid5G}\n`;
        message += `• Pengguna WiFi: ${totalUsers} perangkat\n`;
        
        // Tambahkan detail user SSID 1 jika ada
        if (associatedDevices.length > 0) {
            message += `• *Daftar User WiFi (2.4GHz):*\n`;
            associatedDevices.forEach((dev, idx) => {
                let detail = `${idx + 1}. ${dev.hostname || '-'} (${dev.mac || '-'}`;
                if (dev.ip) detail += `, ${dev.ip}`;
                detail += ')';
                message += `   ${detail}\n`;
            });
        } else {
            message += `• Tidak ada data user WiFi (2.4GHz) tersedia\n`;
        }
        message += `\n`;
        
        if (rxPower) {
            message += `🔧 *KUALITAS SINYAL:*\n`;
            message += `• RX Power: ${rxPower} dBm (${rxPowerStatus})\n\n`;
        }
        
        message += `💡 *TINDAKAN ADMIN:*\n`;
        const actionIdentifier = customer ? customer.phone : searchTerm;
        message += `• Ganti SSID: editssid ${actionIdentifier} [nama_baru]\n`;
        message += `• Ganti Password: editpass ${actionIdentifier} [password_baru]\n`;
        message += `• Refresh Perangkat: adminrefresh ${actionIdentifier}`;

        await sock.sendMessage(remoteJid, { text: message });
    } catch (error) {
        console.error('Error in handleAdminCheckONUWithBilling:', error);
        await sock.sendMessage(remoteJid, { 
            text: `❌ *ERROR*\n\nTerjadi kesalahan saat memeriksa perangkat:\n${error.message}`
        });
    }
}

// Fungsi untuk mencari perangkat berdasarkan tag
async function findDeviceByTag(tag) {
    try {
        console.log(`Searching for device with tag: ${tag}`);
        const { genieacsUrl, genieacsUsername, genieacsPassword } = await getGenieacsConfig();
        
        // Validasi URL GenieACS
        if (!genieacsUrl || typeof genieacsUrl !== 'string' || genieacsUrl.trim() === '') {
            console.error('❌ GenieACS URL tidak dikonfigurasi atau kosong');
            throw new Error('GenieACS URL tidak dikonfigurasi. Silakan konfigurasi GenieACS URL di Settings atau tambahkan GenieACS Server di /admin/genieacs-setting');
        }
        
        // Validasi format URL
        let validUrl;
        try {
            validUrl = new URL(genieacsUrl);
        } catch (urlError) {
            console.error(`❌ Format GenieACS URL tidak valid: ${genieacsUrl}`);
            throw new Error(`Format GenieACS URL tidak valid: ${genieacsUrl}. URL harus lengkap dengan protocol (http:// atau https://)`);
        }
        
        console.log('DEBUG GenieACS URL:', genieacsUrl);
        
        try {
            // Coba dengan query exact match
            const exactResponse = await axios.get(`${genieacsUrl}/devices/?query={"_tags":"${tag}"}`,
                {
                    auth: {
                        username: genieacsUsername,
                        password: genieacsPassword
                    },
                    timeout: 10000
                }
            );
            if (exactResponse.data && exactResponse.data.length > 0) {
                console.log(`✅ Device found with exact tag match: ${tag}`);
                return exactResponse.data[0];
            }
            console.log(`No exact match found for tag ${tag}, trying partial match...`);
            
            // Coba dengan partial match
            const partialResponse = await axios.get(`${genieacsUrl}/devices`, {
                auth: {
                    username: genieacsUsername,
                    password: genieacsPassword
                },
                timeout: 10000
            });
            if (partialResponse.data && partialResponse.data.length > 0) {
                for (const device of partialResponse.data) {
                    if (device._tags && Array.isArray(device._tags)) {
                        const matchingTag = device._tags.find(t => 
                            t === tag || 
                            t.includes(tag) || 
                            tag.includes(t)
                        );
                        if (matchingTag) {
                            console.log(`✅ Device found with partial tag match: ${matchingTag}`);
                            return device;
                        }
                    }
                }
            }
            console.log(`No device found with tag containing: ${tag}`);
            return null;
        } catch (queryError) {
            // Jika error adalah Invalid URL, jangan coba lagi dengan method alternatif
            if (queryError.code === 'ERR_INVALID_URL' || queryError.message.includes('Invalid URL')) {
                console.error('❌ Invalid URL error:', queryError.message);
                throw new Error(`GenieACS URL tidak valid: ${genieacsUrl}. Pastikan URL lengkap dengan protocol (http:// atau https://)`);
            }
            
            console.error('Error with tag query:', queryError.message);
            console.log('Trying alternative method: fetching all devices');
            
            try {
            const allDevicesResponse = await axios.get(`${genieacsUrl}/devices`, {
                auth: {
                    username: genieacsUsername,
                    password: genieacsPassword
                    },
                    timeout: 10000
            });
            const device = allDevicesResponse.data.find(d => {
                if (!d._tags) return false;
                return d._tags.some(t => 
                    t === tag || 
                    t.includes(tag) || 
                    tag.includes(t)
                );
            });
            return device || null;
            } catch (fallbackError) {
                console.error('❌ Fallback method also failed:', fallbackError.message);
                throw new Error(`Gagal mencari device: ${fallbackError.message}`);
            }
        }
    } catch (error) {
        console.error('❌ Error finding device by tag:', error.message);
        throw error;
    }
}

// Handler untuk pelanggan ganti SSID
async function handleChangeSSID(senderNumber, remoteJid, params) {
    try {
        console.log(`Handling change SSID request from ${senderNumber} with params:`, params);
        const { genieacsUrl, genieacsUsername, genieacsPassword } = await getGenieacsConfig();
        console.log('DEBUG GenieACS URL:', genieacsUrl);
        const device = await getDeviceByNumber(senderNumber);
        if (!device) {
            await sock.sendMessage(remoteJid, { 
                text: `${getSetting('company_header', 'CV Lintas Multimedia')}
❌ *NOMOR TIDAK TERDAFTAR*

Waduh, nomor kamu belum terdaftar nih.
Hubungi admin dulu yuk untuk daftar!${getSetting('footer_info', 'Internet Tanpa Batas')}` 
            });
            return;
        }
        if (params.length < 1) {
            await sock.sendMessage(remoteJid, { 
                text: `${getSetting('company_header', 'CV Lintas Multimedia')}
📋 *CARA GANTI NAMA WIFI*

⚠️ Format Perintah:
*gantiwifi [nama_wifi_baru]*

📋 Contoh:
*gantiwifi RumahKu*

💡 Nama WiFi akan langsung diperbarui
💡 Tunggu beberapa saat sampai perubahan aktif
💡 Perangkat yang terhubung mungkin akan terputus${getSetting('footer_info', 'Internet Tanpa Batas')}`,
            });
            return;
        }
        const newSSID = params.join(' ');
        const newSSID5G = `${newSSID}-5G`;
        await sock.sendMessage(remoteJid, { 
            text: `${getSetting('company_header', 'CV Lintas Multimedia')}
⏳ *PERMINTAAN DIPROSES*

Sedang mengubah nama WiFi Anda...
• WiFi 2.4GHz: ${newSSID}
• WiFi 5GHz: ${newSSID5G}

Mohon tunggu sebentar.${getSetting('footer_info', 'Internet Tanpa Batas')}`
        });
        const encodedDeviceId = encodeURIComponent(device._id);
        await axios.post(
            `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
            {
                name: "setParameterValues",
                parameterValues: [
                    ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", newSSID, "xsd:string"]
                ]
            },
            {
                auth: {
                    username: genieacsUsername,
                    password: genieacsPassword
                }
            }
        );
        let wifi5GFound = false;
        const ssid5gIndexes = [5, 6, 7, 8];
        for (const idx of ssid5gIndexes) {
            if (wifi5GFound) break;
            try {
                console.log(`Trying to update 5GHz SSID using config index ${idx}`);
                await axios.post(
                    `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
                    {
                        name: "setParameterValues",
                        parameterValues: [
                            [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.SSID`, newSSID5G, "xsd:string"]
                        ]
                    },
                    {
                        auth: {
                            username: genieacsUsername,
                            password: genieacsPassword
                        }
                    }
                );
                console.log(`Successfully updated 5GHz SSID using config index ${idx}`);
                wifi5GFound = true;
            } catch (error) {
                console.error(`Error updating 5GHz SSID with index ${idx}:`, error.message);
            }
        }
        if (!wifi5GFound) {
            console.warn('Tidak ada konfigurasi SSID 5GHz yang valid ditemukan. SSID 5GHz tidak diubah.');
        }
        try {
            await axios.post(
                `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
                {
                    name: "refreshObject",
                    objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration"
                },
                {
                    auth: {
                        username: genieacsUsername,
                        password: genieacsPassword
                    }
                }
            );
            console.log('Successfully sent refresh task');
        } catch (refreshError) {
            console.error('Error sending refresh task:', refreshError.message);
        }
        try {
            await axios.post(
                `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
                {
                    name: "reboot"
                },
                {
                    auth: {
                        username: genieacsUsername,
                        password: genieacsPassword
                    }
                }
            );
            console.log('Successfully sent reboot task');
        } catch (rebootError) {
            console.error('Error sending reboot task:', rebootError.message);
        }
        let responseMessage = `${getSetting('company_header', 'CV Lintas Multimedia')}
✅ *NAMA WIFI BERHASIL DIUBAH!*

📶 *Nama WiFi Baru:*
• WiFi 2.4GHz: ${newSSID}`;
        if (wifi5GFound) {
            responseMessage += `\n• WiFi 5GHz: ${newSSID5G}`;
        } else {
            responseMessage += `\n• WiFi 5GHz: Pengaturan tidak ditemukan atau gagal diubah`;
        }
        responseMessage += `\n
⏳ Perangkat akan melakukan restart untuk menerapkan perubahan.\n📋 Perangkat yang terhubung akan terputus dan perlu menghubungkan ulang ke nama WiFi baru.

_Perubahan selesai pada: ${new Date().toLocaleString()}_${getSetting('footer_info', 'Internet Tanpa Batas')}`;
        await sock.sendMessage(remoteJid, { text: responseMessage });
    } catch (error) {
        console.error('Error handling change SSID:', error);
        await sock.sendMessage(remoteJid, { 
            text: `${getSetting('company_header', 'CV Lintas Multimedia')}
❌ *GAGAL MENGUBAH NAMA WIFI*

Oops! Ada kendala teknis saat mengubah nama WiFi kamu.
Beberapa kemungkinan penyebabnya:
• Router sedang offline
• Masalah koneksi ke server
• Format nama tidak didukung

Pesan error: ${error.message}

Coba lagi nanti ya!${getSetting('footer_info', 'Internet Tanpa Batas')}` 
        });
    }
}

// Handler untuk admin mengubah password WiFi pelanggan
async function handleAdminEditPassword(adminJid, customerNumber, newPassword) {
    try {
        const { genieacsUrl, genieacsUsername, genieacsPassword } = await getGenieacsConfig();
        console.log(`Admin mengubah password WiFi untuk pelanggan ${customerNumber}`);
        
        // Validasi panjang password
        if (newPassword.length < 8) {
            await sock.sendMessage(adminJid, { 
                text: `${getSetting('company_header', 'CV Lintas Multimedia')}
âŒ *PASSWORD TERLALU PENDEK*

Password WiFi harus minimal 8 karakter.
Silakan coba lagi dengan password yang lebih panjang.${getSetting('footer_info', 'Internet Tanpa Batas')}`
            });
            return;
        }
        
        // Format nomor pelanggan untuk mencari di GenieACS
        const formattedNumber = formatPhoneNumber(customerNumber);
        console.log(`Mencari perangkat untuk nomor: ${formattedNumber}`);
        
        // Cari perangkat pelanggan
        const device = await getDeviceByNumber(formattedNumber);
        if (!device) {
            await sock.sendMessage(adminJid, { 
                text: `${getSetting('company_header', 'CV Lintas Multimedia')}
âŒ *NOMOR PELANGGAN TIDAK DITEMUKAN*

Nomor ${customerNumber} tidak terdaftar di sistem.
Periksa kembali nomor pelanggan.${getSetting('footer_info', 'Internet Tanpa Batas')}` 
            });
            return;
        }
        
        // Kirim pesan ke admin bahwa permintaan sedang diproses
        await sock.sendMessage(adminJid, { 
            text: `${getSetting('company_header', 'CV Lintas Multimedia')}
â³ *PERMINTAAN DIPROSES*

Sedang mengubah password WiFi pelanggan ${customerNumber}...
Password baru: ${newPassword}

Mohon tunggu sebentar.${getSetting('footer_info', 'Internet Tanpa Batas')}`
        });
        
        // Encode deviceId untuk URL
        const encodedDeviceId = encodeURIComponent(device._id);
        
        // Update password WiFi 2.4GHz di index 1
        await axios.post(
            `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
            {
                name: "setParameterValues",
                parameterValues: [
                    ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", newPassword, "xsd:string"]
                ]
            },
            {
                auth: {
                    username: genieacsUsername,
                    password: genieacsPassword
                }
            }
        );
        
        // Update password WiFi 5GHz di index 5, 6, 7, 8
        let wifi5GFound = false;
        const wifi5gIndexes = [5, 6, 7, 8];
        for (const idx of wifi5gIndexes) {
            if (wifi5GFound) break;
            try {
                console.log(`Trying to update 5GHz password using config index ${idx}`);
                await axios.post(
                    `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
                    {
                        name: "setParameterValues",
                        parameterValues: [
                            [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.KeyPassphrase`, newPassword, "xsd:string"]
                        ]
                    },
                    {
                        auth: {
                            username: genieacsUsername,
                            password: genieacsPassword
                        }
                    }
                );
                console.log(`Successfully updated 5GHz password using config index ${idx}`);
                wifi5GFound = true;
            } catch (error) {
                console.error(`Error updating 5GHz password with index ${idx}:`, error.message);
            }
        }
        
        // Tambahkan task refresh
        try {
            await axios.post(
                `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
                {
                    name: "refreshObject",
                    objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration"
                },
                {
                    auth: {
                        username: genieacsUsername,
                        password: genieacsPassword
                    }
                }
            );
            console.log('Successfully sent refresh task');
        } catch (refreshError) {
            console.error('Error sending refresh task:', refreshError.message);
        }
        
        // Reboot perangkat untuk menerapkan perubahan
        try {
            await axios.post(
                `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
                {
                    name: "reboot"
                },
                {
                    auth: {
                        username: genieacsUsername,
                        password: genieacsPassword
                    }
                }
            );
            console.log('Successfully sent reboot task');
        } catch (rebootError) {
            console.error('Error sending reboot task:', rebootError.message);
        }
        
        // Pesan sukses untuk admin
        const adminResponseMessage = `${getSetting('company_header', 'CV Lintas Multimedia')}
✅ *PASSWORD WIFI PELANGGAN BERHASIL DIUBAH!*

📋 *Pelanggan:* ${customerNumber}
🔐 *Password WiFi Baru:* ${newPassword}

â³ Perangkat akan melakukan restart untuk menerapkan perubahan.
📋 Perangkat yang terhubung akan terputus dan perlu menghubungkan ulang dengan password baru.

_Perubahan selesai pada: ${new Date().toLocaleString()}_${getSetting('footer_info', 'Internet Tanpa Batas')}`;

        await sock.sendMessage(adminJid, { text: adminResponseMessage });
        
        // Kirim notifikasi ke pelanggan tentang perubahan password WiFi
        try {
            // Format nomor pelanggan untuk WhatsApp
            let customerJid;
            if (customerNumber.includes('@')) {
                customerJid = customerNumber; // Sudah dalam format JID
            } else {
                // Format nomor untuk WhatsApp
                const cleanNumber = customerNumber.replace(/\D/g, '');
                customerJid = `${cleanNumber}@s.whatsapp.net`;
            }
            
            // Pesan notifikasi untuk pelanggan
            const customerNotificationMessage = `${getSetting('company_header', 'CV Lintas Multimedia')}
📢 *PEMBERITAHUAN PERUBAHAN PASSWORD WIFI*

Halo Pelanggan Setia,

Kami informasikan bahwa password WiFi Anda telah diubah oleh admin:

🔐 *Password WiFi Baru:* ${newPassword}

â³ Perangkat Anda akan melakukan restart untuk menerapkan perubahan.
📋 Perangkat yang terhubung akan terputus dan perlu menghubungkan ulang dengan password baru.

_Catatan: Simpan informasi ini sebagai dokumentasi jika Anda lupa password WiFi di kemudian hari.${getSetting('footer_info', 'Internet Tanpa Batas')}`;
            
            await sock.sendMessage(customerJid, { text: customerNotificationMessage });
            console.log(`Notification sent to customer ${customerNumber} about WiFi password change`);
        } catch (notificationError) {
            console.error(`Failed to send notification to customer ${customerNumber}:`, notificationError.message);
            // Kirim pesan ke admin bahwa notifikasi ke pelanggan gagal
            await sock.sendMessage(adminJid, { 
                text: `${getSetting('company_header', 'CV Lintas Multimedia')}
âš ï¸ *INFO*

Password WiFi pelanggan berhasil diubah, tetapi gagal mengirim notifikasi ke pelanggan.
Error: ${notificationError.message}${getSetting('footer_info', 'Internet Tanpa Batas')}` 
            });
        }
        
    } catch (error) {
        console.error('Error handling admin edit password:', error);
        await sock.sendMessage(adminJid, { 
            text: `${getSetting('company_header', 'CV Lintas Multimedia')}
âŒ *GAGAL MENGUBAH PASSWORD WIFI PELANGGAN*

Oops! Ada kendala teknis saat mengubah password WiFi pelanggan.
Beberapa kemungkinan penyebabnya:
• Router pelanggan sedang offline
• Masalah koneksi ke server
• Format password tidak didukung

Pesan error: ${error.message}

Coba lagi nanti ya!${getSetting('footer_info', 'Internet Tanpa Batas')}` 
        });
    }
}

// Handler untuk admin mengubah SSID pelanggan
async function handleAdminEditSSID(adminJid, customerNumber, newSSID) {
    try {
        const { genieacsUrl, genieacsUsername, genieacsPassword } = await getGenieacsConfig();
        console.log(`Admin mengubah SSID untuk pelanggan ${customerNumber} menjadi ${newSSID}`);
        
        // Format nomor pelanggan untuk mencari di GenieACS
        const formattedNumber = formatPhoneNumber(customerNumber);
        console.log(`Mencari perangkat untuk nomor: ${formattedNumber}`);
        
        // Cari perangkat pelanggan
        const device = await getDeviceByNumber(formattedNumber);
        if (!device) {
            await sock.sendMessage(adminJid, { 
                text: `${getSetting('company_header', 'CV Lintas Multimedia')}
âŒ *NOMOR PELANGGAN TIDAK DITEMUKAN*

Nomor ${customerNumber} tidak terdaftar di sistem.
Periksa kembali nomor pelanggan.${getSetting('footer_info', 'Internet Tanpa Batas')}` 
            });
            return;
        }
        
        // Buat nama SSID 5G berdasarkan SSID 2.4G
        const newSSID5G = `${newSSID}-5G`;
        
        // Kirim pesan ke admin bahwa permintaan sedang diproses
        await sock.sendMessage(adminJid, { 
            text: `${getSetting('company_header', 'CV Lintas Multimedia')}
â³ *PERMINTAAN DIPROSES*

Sedang mengubah nama WiFi pelanggan ${customerNumber}...
• WiFi 2.4GHz: ${newSSID}
• WiFi 5GHz: ${newSSID5G}

Mohon tunggu sebentar.${getSetting('footer_info', 'Internet Tanpa Batas')}`
        });
        
        // Encode deviceId untuk URL
        const encodedDeviceId = encodeURIComponent(device._id);
        
        // Update SSID 2.4GHz di index 1
        await axios.post(
            `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
            {
                name: "setParameterValues",
                parameterValues: [
                    ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", newSSID, "xsd:string"]
                ]
            },
            {
                auth: {
                    username: genieacsUsername,
                    password: genieacsPassword
                }
            }
        );
        
        // Update SSID 5GHz di index 5, 6, 7, 8
        let wifi5GFound = false;
        const ssid5gIndexes = [5, 6, 7, 8];
        for (const idx of ssid5gIndexes) {
            if (wifi5GFound) break;
            try {
                console.log(`Trying to update 5GHz SSID using config index ${idx}`);
                await axios.post(
                    `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
                    {
                        name: "setParameterValues",
                        parameterValues: [
                            [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.SSID`, newSSID5G, "xsd:string"]
                        ]
                    },
                    {
                        auth: {
                            username: genieacsUsername,
                            password: genieacsPassword
                        }
                    }
                );
                console.log(`Successfully updated 5GHz SSID using config index ${idx}`);
                wifi5GFound = true;
            } catch (error) {
                console.error(`Error updating 5GHz SSID with index ${idx}:`, error.message);
            }
        }
        
        // Tambahkan task refresh
        try {
            await axios.post(
                `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
                {
                    name: "refreshObject",
                    objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration"
                },
                {
                    auth: {
                        username: genieacsUsername,
                        password: genieacsPassword
                    }
                }
            );
            console.log('Successfully sent refresh task');
        } catch (refreshError) {
            console.error('Error sending refresh task:', refreshError.message);
        }
        
        // Reboot perangkat untuk menerapkan perubahan
        try {
            await axios.post(
                `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
                {
                    name: "reboot"
                },
                {
                    auth: {
                        username: genieacsUsername,
                        password: genieacsPassword
                    }
                }
            );
            console.log('Successfully sent reboot task');
        } catch (rebootError) {
            console.error('Error sending reboot task:', rebootError.message);
        }
        
        // Pesan sukses untuk admin
        let adminResponseMessage = `${getSetting('company_header', 'CV Lintas Multimedia')}
✅ *NAMA WIFI PELANGGAN BERHASIL DIUBAH!*

📋 *Pelanggan:* ${customerNumber}
ï¿½ï¿½ *Nama WiFi Baru:*
• WiFi 2.4GHz: ${newSSID}`;

        if (wifi5GFound) {
            adminResponseMessage += `\n• WiFi 5GHz: ${newSSID5G}`;
        } else {
            adminResponseMessage += `\n• WiFi 5GHz: Pengaturan tidak ditemukan atau gagal diubah`;
        }

        adminResponseMessage += `\n
â³ Perangkat akan melakukan restart untuk menerapkan perubahan.
📋 Perangkat yang terhubung akan terputus dan perlu menghubungkan ulang ke nama WiFi baru.

_Perubahan selesai pada: ${new Date().toLocaleString()}_${getSetting('footer_info', 'Internet Tanpa Batas')}`;

        await sock.sendMessage(adminJid, { text: adminResponseMessage });
        
        // Kirim notifikasi ke pelanggan tentang perubahan SSID
        try {
            // Format nomor pelanggan untuk WhatsApp
            let customerJid;
            if (customerNumber.includes('@')) {
                customerJid = customerNumber; // Sudah dalam format JID
            } else {
                // Format nomor untuk WhatsApp
                const cleanNumber = customerNumber.replace(/\D/g, '');
                customerJid = `${cleanNumber}@s.whatsapp.net`;
            }
            
            // Pesan notifikasi untuk pelanggan
            const customerNotificationMessage = `${getSetting('company_header', 'CV Lintas Multimedia')}
📢 *PEMBERITAHUAN PERUBAHAN WIFI*

Halo Pelanggan Setia,

Kami informasikan bahwa nama WiFi Anda telah diubah oleh admin:

📶 *Nama WiFi Baru:*
• WiFi 2.4GHz: ${newSSID}`;
            
            let fullCustomerMessage = customerNotificationMessage;
            if (wifi5GFound) {
                fullCustomerMessage += `\n• WiFi 5GHz: ${newSSID5G}`;
            }
            
            fullCustomerMessage += `\n
â³ Perangkat Anda akan melakukan restart untuk menerapkan perubahan.
📋 Perangkat yang terhubung akan terputus dan perlu menghubungkan ulang ke nama WiFi baru.

_Catatan: Simpan informasi ini sebagai dokumentasi jika Anda lupa nama WiFi di kemudian hari.${getSetting('footer_info', 'Internet Tanpa Batas')}`;
            
            await sock.sendMessage(customerJid, { text: fullCustomerMessage });
            console.log(`Notification sent to customer ${customerNumber} about SSID change`);
        } catch (notificationError) {
            console.error(`Failed to send notification to customer ${customerNumber}:`, notificationError.message);
            // Kirim pesan ke admin bahwa notifikasi ke pelanggan gagal
            await sock.sendMessage(adminJid, { 
                text: `${getSetting('company_header', 'CV Lintas Multimedia')}
âš ï¸ *INFO*

Nama WiFi pelanggan berhasil diubah, tetapi gagal mengirim notifikasi ke pelanggan.
Error: ${notificationError.message}${getSetting('footer_info', 'Internet Tanpa Batas')}` 
            });
        }
        
    } catch (error) {
        console.error('Error handling admin edit SSID:', error);
        await sock.sendMessage(adminJid, { 
            text: `${getSetting('company_header', 'CV Lintas Multimedia')}
âŒ *GAGAL MENGUBAH NAMA WIFI PELANGGAN*

Oops! Ada kendala teknis saat mengubah nama WiFi pelanggan.
Beberapa kemungkinan penyebabnya:
• Router pelanggan sedang offline
• Masalah koneksi ke server
• Format nama tidak didukung

Pesan error: ${error.message}

Coba lagi nanti ya!${getSetting('footer_info', 'Internet Tanpa Batas')}` 
        });
    }
}

// Handler untuk pelanggan ganti password
async function handleChangePassword(senderNumber, remoteJid, params) {
    try {
        console.log(`Handling change password request from ${senderNumber} with params:`, params);
        
        // Validasi parameter
        if (params.length < 1) {
            await sock.sendMessage(remoteJid, { 
                text: `${getSetting('company_header', 'CV Lintas Multimedia')}
âŒ *FORMAT SALAH*

âš ï¸ Format Perintah:
*gantipass [password_baru]*

📋 Contoh:
*gantipass Password123*

💡 Password harus minimal 8 karakter
💡 Hindari password yang mudah ditebak${getSetting('footer_info', 'Internet Tanpa Batas')}`
            });
            return;
        }
        
        const newPassword = params[0];
        
        // Validasi panjang password
        if (newPassword.length < 8) {
            await sock.sendMessage(remoteJid, { 
                text: `${getSetting('company_header', 'CV Lintas Multimedia')}
âŒ *PASSWORD TERLALU PENDEK*

Password WiFi harus minimal 8 karakter.
Silakan coba lagi dengan password yang lebih panjang.${getSetting('footer_info', 'Internet Tanpa Batas')}`
            });
            return;
        }
        
        // Cari perangkat berdasarkan nomor pengirim
        console.log(`Finding device for number: ${senderNumber}`);
        
        const device = await getDeviceByNumber(senderNumber);
        if (!device) {
            await sock.sendMessage(remoteJid, { 
                text: `${getSetting('company_header', 'CV Lintas Multimedia')}
âŒ *NOMOR TIDAK TERDAFTAR*

Waduh, nomor kamu belum terdaftar nih.
Hubungi admin dulu yuk untuk daftar!${getSetting('footer_info', 'Internet Tanpa Batas')}`
            });
            return;
        }
        
        // Dapatkan ID perangkat
        const deviceId = device._id;
        console.log(`Found device ID: ${deviceId}`);
        
        // Kirim pesan bahwa permintaan sedang diproses
        await sock.sendMessage(remoteJid, { 
            text: `${getSetting('company_header', 'CV Lintas Multimedia')}
â³ *PERMINTAAN DIPROSES*

Sedang mengubah password WiFi Anda...
Mohon tunggu sebentar.${getSetting('footer_info', 'Internet Tanpa Batas')}`
        });
        
        // Perbarui password WiFi
        const result = await changePassword(deviceId, newPassword);
        
        if (result.success) {
            await sock.sendMessage(remoteJid, { 
                text: `${getSetting('company_header', 'CV Lintas Multimedia')}
✅ *PASSWORD WIFI BERHASIL DIUBAH!*

🔐 *Password Baru:* ${newPassword}

â³ Tunggu bentar ya, perubahan akan aktif dalam beberapa saat.
📋 Perangkat yang terhubung mungkin akan terputus dan harus menghubungkan ulang dengan password baru.

_Perubahan selesai pada: ${new Date().toLocaleString()}_${getSetting('footer_info', 'Internet Tanpa Batas')}`
            });
        } else {
            await sock.sendMessage(remoteJid, { 
                text: `${getSetting('company_header', 'CV Lintas Multimedia')}
âŒ *GAGAL MENGUBAH PASSWORD*

Oops! Ada kendala teknis saat mengubah password WiFi kamu.
Beberapa kemungkinan penyebabnya:
• Router sedang offline
• Masalah koneksi ke server
• Format password tidak didukung

Pesan error: ${result.message}

Coba lagi nanti ya!${getSetting('footer_info', 'Internet Tanpa Batas')}`
            });
        }
    } catch (error) {
        console.error('Error handling password change:', error);
        await sock.sendMessage(remoteJid, { 
            text: `${getSetting('company_header', 'CV Lintas Multimedia')}
âŒ *TERJADI KESALAHAN*

Error: ${error.message}

Silakan coba lagi nanti atau hubungi admin.${getSetting('footer_info', 'Internet Tanpa Batas')}`
        });
    }
}

// Fungsi untuk mengubah password WiFi perangkat
async function changePassword(deviceId, newPassword) {
    try {
        const { genieacsUrl, genieacsUsername, genieacsPassword } = await getGenieacsConfig();
        console.log(`Changing password for device: ${deviceId}`);
        // Encode deviceId untuk URL
        const encodedDeviceId = encodeDeviceId(deviceId);
        // URL untuk tasks GenieACS
        const tasksUrl = `${genieacsUrl}/devices/${encodedDeviceId}/tasks?timeout=3000`;
        // Buat task untuk mengubah password
        // Perbarui parameter untuk 2.4GHz WiFi
        const updatePass24Task = {
            name: "setParameterValues",
            parameterValues: [
                ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", newPassword, "xsd:string"],
                ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase", newPassword, "xsd:string"]
            ]
        };
        
        console.log('Sending task to update password 2.4GHz');
        const response24 = await axios.post(
            tasksUrl,
            updatePass24Task,
            {
                auth: {
                    username: genieacsUsername,
                    password: genieacsPassword
                },
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log(`2.4GHz password update response:`, response24.status);
        
        // Perbarui parameter untuk 5GHz WiFi
        const updatePass5Task = {
            name: "setParameterValues",
            parameterValues: [
                ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase", newPassword, "xsd:string"],
                ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.KeyPassphrase", newPassword, "xsd:string"]
            ]
        };
        
        console.log('Sending task to update password 5GHz');
        const response5 = await axios.post(
            tasksUrl,
            updatePass5Task,
            {
                auth: {
                    username: genieacsUsername,
                    password: genieacsPassword
                },
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log(`5GHz password update response:`, response5.status);
        
        // Kirim refresh task untuk memastikan perubahan diterapkan
        const refreshTask = {
            name: "refreshObject",
            objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration"
        };
        
        console.log('Sending refresh task');
        await axios.post(
            tasksUrl,
            refreshTask,
            {
                auth: {
                    username: genieacsUsername,
                    password: genieacsPassword
                },
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );
        
        return { success: true, message: 'Password berhasil diubah' };
    } catch (error) {
        console.error('Error changing password:', error);
        return { 
            success: false, 
            message: error.response?.data?.message || error.message 
        };
    }
}

// Handler untuk admin mengubah password WiFi pelanggan
async function handleAdminEditPassword(remoteJid, customerNumber, newPassword) {
    try {
        const { genieacsUrl, genieacsUsername, genieacsPassword } = await getGenieacsConfig();
        console.log(`Handling admin edit password request`);
        
        // Validasi parameter
        if (!customerNumber || !newPassword) {
            await sock.sendMessage(remoteJid, { 
                text: `âŒ *FORMAT Salah!*

Format yang benar:
editpassword [nomor_pelanggan] [password_baru]

Contoh:
editpassword 123456 password123`
            });
            return;
        }
        // Validasi panjang password
        if (newPassword.length < 8) {
            await sock.sendMessage(remoteJid, { 
                text: `âŒ *Password terlalu pendek!*\n\nPassword harus minimal 8 karakter.`
            });
            return;
        }
        
        // Cari perangkat berdasarkan tag nomor pelanggan
        console.log(`Finding device for customer: ${customerNumber}`);
        
        const device = await findDeviceByTag(customerNumber);
        if (!device) {
            await sock.sendMessage(remoteJid, { 
                text: `âŒ *Perangkat tidak ditemukan!*\n\n` +
                      `Nomor pelanggan "${customerNumber}" tidak terdaftar di sistem.`
            });
            return;
        }
        
        // Dapatkan ID perangkat
        const deviceId = device._id;
        console.log(`Found device ID: ${deviceId}`);
        
        // Kirim pesan bahwa proses sedang berlangsung
        await sock.sendMessage(remoteJid, { 
            text: `⏳ *PROSES PERUBAHAN PASSWORD*\n\nSedang mengubah password WiFi untuk pelanggan ${customerNumber}...\nMohon tunggu sebentar.` 
        });
        
        // Encode deviceId untuk URL
        const encodedDeviceId = encodeURIComponent(deviceId);
        
        // URL untuk tasks GenieACS
        const tasksUrl = `${genieacsUrl}/devices/${encodedDeviceId}/tasks?timeout=3000`;
        
        // Buat task untuk mengubah password 2.4GHz
        const updatePass24Task = {
            name: "setParameterValues",
            parameterValues: [
                ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", newPassword, "xsd:string"],
                ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase", newPassword, "xsd:string"]
            ]
        };
        
        console.log('Sending task to update password 2.4GHz');
        const response24 = await axios.post(
            tasksUrl,
            updatePass24Task,
            {
                auth: {
                    username: genieacsUsername,
                    password: genieacsPassword
                },
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log(`2.4GHz password update response:`, response24.status);
        
        // Coba perbarui password untuk 5GHz pada index 5 terlebih dahulu
        let wifi5GFound = false;
        
        try {
            console.log('Trying to update 5GHz password using config index 5');
            const updatePass5Task = {
                name: "setParameterValues",
                parameterValues: [
                    ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase", newPassword, "xsd:string"],
                    ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.KeyPassphrase", newPassword, "xsd:string"]
                ]
            };
            
            await axios.post(
                tasksUrl,
                updatePass5Task,
                {
                    auth: {
                        username: genieacsUsername,
                        password: genieacsPassword
                    },
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );
            console.log('Successfully updated 5GHz password using config index 5');
            wifi5GFound = true;
        } catch (error5) {
            console.error('Error updating 5GHz password with index 5:', error5.message);
            
            // Mencoba dengan index lain selain 2 (3, 4, 6)
            const alternativeIndexes = [3, 4, 6];
            
            for (const idx of alternativeIndexes) {
                if (wifi5GFound) break;
                
                try {
                    console.log(`Trying to update 5GHz password using config index ${idx}`);
                    const updatePassAltTask = {
                        name: "setParameterValues",
                        parameterValues: [
                            [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.KeyPassphrase`, newPassword, "xsd:string"],
                            [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.PreSharedKey.1.KeyPassphrase`, newPassword, "xsd:string"]
                        ]
                    };
                    
                    await axios.post(
                        tasksUrl,
                        updatePassAltTask,
                        {
                            auth: {
                                username: genieacsUsername,
                                password: genieacsPassword
                            },
                            headers: {
                                'Content-Type': 'application/json'
                            }
                        }
                    );
                    console.log(`Successfully updated 5GHz password using config index ${idx}`);
                    wifi5GFound = true;
                    break;
                } catch (error) {
                    console.error(`Error updating 5GHz password with index ${idx}:`, error.message);
                }
            }
            
            // Jika index 5 dan alternatif (3, 4, 6) gagal, biarkan SSID 5GHz tidak berubah
            if (!wifi5GFound) {
                try {
                    console.log('Last resort: trying to update 5GHz password using config index 2');
                    const updatePass2Task = {
                        name: "setParameterValues",
                        parameterValues: [
                            ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.KeyPassphrase", newPassword, "xsd:string"],
                            ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.PreSharedKey.1.KeyPassphrase", newPassword, "xsd:string"]
                        ]
                    };
                    
                    await axios.post(
                        tasksUrl,
                        updatePass2Task,
                        {
                            auth: {
                                username: genieacsUsername,
                                password: genieacsPassword
                            },
                            headers: {
                                'Content-Type': 'application/json'
                            }
                        }
                    );
                    console.log('Successfully updated 5GHz password using config index 2');
                    wifi5GFound = true;
                } catch (error2) {
                    console.error('Error updating 5GHz password with index 2:', error2.message);
                }
            }
        }
        
        // Kirim refresh task untuk memastikan perubahan diterapkan
        try {
            await axios.post(
                tasksUrl,
                {
                    name: "refreshObject",
                    objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration"
                },
                {
                    auth: {
                        username: genieacsUsername,
                        password: genieacsPassword
                    },
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );
            console.log('Successfully sent refresh task');
        } catch (refreshError) {
            console.error('Error sending refresh task:', refreshError.message);
        }
        
        // Dapatkan informasi SSID dari perangkat untuk notifikasi
        const ssid24G = device.InternetGatewayDevice?.LANDevice?.[1]?.WLANConfiguration?.[1]?.SSID?._value || 'WiFi 2.4GHz';
        
        // Respons ke admin
        let responseMessage = `✅ *PASSWORD WIFI BERHASIL DIUBAH!*\n\n` +
              `Pelanggan: ${customerNumber}\n` +
              `Password baru: ${newPassword}\n\n`;
              
        if (wifi5GFound) {
            responseMessage += `Password berhasil diubah untuk WiFi 2.4GHz dan 5GHz.\n\n`;
        } else {
            responseMessage += `Password berhasil diubah untuk WiFi 2.4GHz.\n` +
                              `WiFi 5GHz: Pengaturan tidak ditemukan atau gagal diubah.\n\n`;
        }
        
        responseMessage += `Perubahan akan diterapkan dalam beberapa menit.`;
        
        // Coba kirim notifikasi ke pelanggan
        let notificationSent = false;
        if (customerNumber.match(/^\d+$/) && customerNumber.length >= 10) {
            try {
                console.log(`Sending password change notification to customer: ${customerNumber}`);
                
                // Format nomor telepon
                const formattedNumber = formatPhoneNumber(customerNumber);
                
                // Buat pesan notifikasi untuk pelanggan
                const notificationMessage = formatWithHeaderFooter(`📢 *INFORMASI PERUBAHAN PASSWORD WIFI*

Halo Pelanggan yang terhormat,

Password WiFi Anda telah diubah oleh administrator sistem. Berikut detail perubahannya:

🔧 *Nama WiFi:* ${ssid24G}
🔐 *Password Baru:* ${newPassword}

Silakan gunakan password baru ini untuk terhubung ke jaringan WiFi Anda.
Perubahan akan diterapkan dalam beberapa menit.`);

                // Kirim pesan menggunakan sock
                await sock.sendMessage(`${formattedNumber}@s.whatsapp.net`, { 
                    text: notificationMessage 
                });
                
                console.log(`Password change notification sent to customer: ${customerNumber}`);
                notificationSent = true;
                
                responseMessage += `\nNotifikasi sudah dikirim ke pelanggan.`;
            } catch (notificationError) {
                console.error(`Failed to send notification to customer: ${customerNumber}`, notificationError);
                responseMessage += `\n\nâš ï¸ *Peringatan:* Gagal mengirim notifikasi ke pelanggan.\n` +
                                  `Error: ${notificationError.message}`;
            }
        }

        // Kirim respons ke admin
        await sock.sendMessage(remoteJid, { text: responseMessage });
        
    } catch (error) {
        console.error('Error handling admin password change:', error);
        await sock.sendMessage(remoteJid, { 
            text: `âŒ *Terjadi kesalahan!*\n\n` +
                  `Error: ${error.message}\n\n` +
                  `Silakan coba lagi nanti.`
        });
    }
}

// Handler untuk admin edit SSID pelanggan
async function handleAdminEditSSIDWithParams(remoteJid, params) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }
    const { genieacsUrl, genieacsUsername, genieacsPassword } = await getGenieacsConfig();

    console.log(`Processing adminssid command with params:`, params);

    if (params.length < 2) {
        await sock.sendMessage(remoteJid, { 
            text: `âŒ *FORMAT SALAH*\n\n` +
                  `Format yang benar:\n` +
                  `editssid [nomor_pelanggan] [nama_wifi_baru]\n\n` +
                  `Contoh:\n` +
                  `editssid 123456 RumahBaru`
        });
        return;
    }

    // Ambil nomor pelanggan dari parameter pertama
    const customerNumber = params[0];
    
    // Gabungkan semua parameter setelah nomor pelanggan sebagai SSID baru
    // Ini menangani kasus di mana SSID terdiri dari beberapa kata
    const newSSID = params.slice(1).join(' ');
    const newSSID5G = `${newSSID}-5G`;

    console.log(`Attempting to change SSID for customer ${customerNumber} to "${newSSID}"`);

    try {
        // Kirim pesan bahwa proses sedang berlangsung
        await sock.sendMessage(remoteJid, { 
            text: `⏳ *PROSES PERUBAHAN SSID*\n\nSedang mengubah nama WiFi untuk pelanggan ${customerNumber}...\nMohon tunggu sebentar.` 
        });

        // Cari perangkat berdasarkan nomor pelanggan
        const device = await findDeviceByTag(customerNumber);
        
        if (!device) {
            console.log(`Device not found for customer number: ${customerNumber}`);
            await sock.sendMessage(remoteJid, { 
                text: `âŒ *PERANGKAT TIDAK DITEMUKAN*\n\n` +
                      `Tidak dapat menemukan perangkat untuk pelanggan dengan nomor ${customerNumber}.\n\n` +
                      `Pastikan nomor pelanggan benar dan perangkat telah terdaftar dalam sistem.`
            });
            return;
        }

        console.log(`Device found for customer ${customerNumber}: ${device._id}`);

        // Dapatkan SSID saat ini untuk referensi
        const currentSSID = device.InternetGatewayDevice?.LANDevice?.[1]?.WLANConfiguration?.[1]?.SSID?._value || 'N/A';
        console.log(`Current SSID: ${currentSSID}`);
        
        // Encode deviceId untuk URL
        const encodedDeviceId = encodeURIComponent(device._id);
        
        // Update SSID 2.4GHz hanya di index 1
        await axios.post(
            `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
            {
                name: "setParameterValues",
                parameterValues: [
                    ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", newSSID, "xsd:string"]
                ] // hanya index 1 untuk 2.4GHz
            },
            {
                auth: {
                    username: genieacsUsername,
                    password: genieacsPassword
                }
            }
        );
        
        // Update SSID 5GHz hanya di index 5, 6, 7, 8
        let wifi5GFound = false;
        const ssid5gIndexes = [5, 6, 7, 8];
        for (const idx of ssid5gIndexes) {
            if (wifi5GFound) break;
            try {
                console.log(`Trying to update 5GHz SSID using config index ${idx}`);
                await axios.post(
                    `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
                    {
                        name: "setParameterValues",
                        parameterValues: [
                            [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.SSID`, newSSID5G, "xsd:string"]
                        ]
                    },
                    {
                        auth: {
                            username: genieacsUsername,
                            password: genieacsPassword
                        }
                    }
                );
                console.log(`Successfully updated 5GHz SSID using config index ${idx}`);
                wifi5GFound = true;
            } catch (error) {
                console.error(`Error updating 5GHz SSID with index ${idx}:`, error.message);
            }
        }
        if (!wifi5GFound) {
            console.warn('Tidak ada konfigurasi SSID 5GHz yang valid ditemukan. SSID 5GHz tidak diubah.');
        }
        
        // Tambahkan task refresh
        try {
            await axios.post(
                `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
                {
                    name: "refreshObject",
                    objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration"
                },
                {
                    auth: {
                        username: genieacsUsername,
                        password: genieacsPassword
                    }
                }
            );
            console.log('Successfully sent refresh task');
        } catch (refreshError) {
            console.error('Error sending refresh task:', refreshError.message);
        }
        
        // Reboot perangkat untuk menerapkan perubahan
        try {
            await axios.post(
                `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
                {
                    name: "reboot"
                },
                {
                    auth: {
                        username: genieacsUsername,
                        password: genieacsPassword
                    }
                }
            );
            console.log('Successfully sent reboot task');
        } catch (rebootError) {
            console.error('Error sending reboot task:', rebootError.message);
        }

        let responseMessage = `✅ *PERUBAHAN SSID BERHASIL*\n\n` +
                      `Nama WiFi untuk pelanggan ${customerNumber} berhasil diubah!\n\n` +
                      `• SSID Lama: ${currentSSID}\n` +
                      `• SSID Baru: ${newSSID}\n`;
                      
        if (wifi5GFound) {
            responseMessage += `• SSID 5GHz: ${newSSID5G}\n\n`;
        } else {
            responseMessage += `• SSID 5GHz: Pengaturan tidak ditemukan atau gagal diubah\n\n`;
        }
        
        responseMessage += `Perangkat WiFi akan restart dalam beberapa saat. Pelanggan perlu menghubungkan kembali perangkat mereka ke jaringan WiFi baru.`;

        await sock.sendMessage(remoteJid, { text: responseMessage });
        
        // Kirim notifikasi ke pelanggan jika nomor pelanggan adalah nomor telepon
        if (customerNumber.match(/^\d+$/) && customerNumber.length >= 10) {
            try {
                const formattedNumber = formatPhoneNumber(customerNumber);
                
                let notificationMessage = `✅ *PERUBAHAN NAMA WIFI*\n\n` +
                                          `Halo Pelanggan yang terhormat,\n\n` +
                                          `Kami informasikan bahwa nama WiFi Anda telah diubah:\n\n` +
                                          `• Nama WiFi Baru: ${newSSID}\n`;
                                          
                if (wifi5GFound) {
                    notificationMessage += `• Nama WiFi 5GHz: ${newSSID5G}\n\n`;
                }
                
                notificationMessage += `Perangkat WiFi akan restart dalam beberapa saat. Silakan hubungkan kembali perangkat Anda ke jaringan WiFi baru.\n\n` +
                                      `Jika Anda memiliki pertanyaan, silakan balas pesan ini.`;
                
                await sock.sendMessage(`${formattedNumber}@s.whatsapp.net`, { 
                    text: notificationMessage
                });
                console.log(`Notification sent to customer: ${customerNumber}`);
            } catch (notifyError) {
                console.error('Error notifying customer:', notifyError);
            }
        }
    } catch (error) {
        console.error('Error in handleAdminEditSSID:', error);
        await sock.sendMessage(remoteJid, { 
            text: `âŒ *ERROR*\n\nTerjadi kesalahan saat mengubah nama WiFi:\n${error.message}`
        });
    }
}

// Fungsi untuk mengubah SSID
async function changeSSID(deviceId, newSSID) {
    try {
        const { genieacsUrl, genieacsUsername, genieacsPassword } = await getGenieacsConfig();
        console.log(`Changing SSID for device ${deviceId} to "${newSSID}"`);
        
        // Encode deviceId untuk URL
        const encodedDeviceId = encodeURIComponent(deviceId);
        
        // Implementasi untuk mengubah SSID melalui GenieACS
        // Ubah SSID 2.4GHz
        try {
            console.log(`Setting 2.4GHz SSID to "${newSSID}"`);
            await axios.post(`${genieacsUrl}/devices/${encodedDeviceId}/tasks`, {
                name: "setParameterValues",
                parameterValues: [
                    ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", newSSID, "xsd:string"]
                ] // hanya index 1 untuk 2.4GHz
            }, {
                auth: {
                    username: genieacsUsername,
                    password: genieacsPassword
                }
            });
            
            // Ubah SSID 5GHz dengan menambahkan suffix -5G
            console.log(`Setting 5GHz SSID to "${newSSID}-5G"`);
            await axios.post(`${genieacsUrl}/devices/${encodedDeviceId}/tasks`, {
                name: "setParameterValues",
                parameterValues: [
                    ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID", `${newSSID}-5G`, "xsd:string"]
                ]
            }, {
                auth: {
                    username: genieacsUsername,
                    password: genieacsPassword
                }
            });
            
            // Commit perubahan
            console.log(`Rebooting device to apply changes`);
            await axios.post(`${genieacsUrl}/devices/${encodedDeviceId}/tasks`, {
                name: "reboot"
            }, {
                auth: {
                    username: genieacsUsername,
                    password: genieacsPassword
                }
            });
            
            console.log(`SSID change successful`);
            
            // Invalidate GenieACS cache after successful update
            try {
                const cacheManager = require('./cacheManager');
                cacheManager.invalidatePattern('genieacs:*');
                console.log('🔄 GenieACS cache invalidated after SSID update');
            } catch (cacheError) {
                console.warn('⚠️ Failed to invalidate cache:', cacheError.message);
            }
            
            return { success: true, message: "SSID berhasil diubah" };
        } catch (apiError) {
            console.error(`API Error: ${apiError.message}`);
            
            // Coba cara alternatif jika cara pertama gagal
            if (apiError.response && apiError.response.status === 404) {
                console.log(`Trying alternative path for device ${deviceId}`);
                
                try {
                    // Coba dengan path alternatif untuk 2.4GHz
                    await axios.post(`${genieacsUrl}/devices/${encodedDeviceId}/tasks`, {
                        name: "setParameterValues",
                        parameterValues: [
                            ["Device.WiFi.SSID.1.SSID", newSSID, "xsd:string"]
                        ]
                    }, {
                        auth: {
                            username: genieacsUsername,
                            password: genieacsPassword
                        }
                    });
                    
                    // Coba dengan path alternatif untuk 5GHz
                    await axios.post(`${genieacsUrl}/devices/${encodedDeviceId}/tasks`, {
                        name: "setParameterValues",
                        parameterValues: [
                            ["Device.WiFi.SSID.2.SSID", `${newSSID}-5G`, "xsd:string"]
                        ]
                    }, {
                        auth: {
                            username: genieacsUsername,
                            password: genieacsPassword
                        }
                    });
                    
                    // Commit perubahan
                    await axios.post(`${genieacsUrl}/devices/${encodedDeviceId}/tasks`, {
                        name: "reboot"
                    }, {
                        auth: {
                            username: genieacsUsername,
                            password: genieacsPassword
                        }
                    });
                    
                    console.log(`SSID change successful using alternative path`);
                    
                    // Invalidate GenieACS cache after successful update
                    try {
                        const cacheManager = require('./cacheManager');
                        cacheManager.invalidatePattern('genieacs:*');
                        console.log('🔄 GenieACS cache invalidated after SSID update');
                    } catch (cacheError) {
                        console.warn('⚠️ Failed to invalidate cache:', cacheError.message);
                    }
                    
                    return { success: true, message: "SSID berhasil diubah (menggunakan path alternatif)" };
                } catch (altError) {
                    console.error(`Alternative path also failed: ${altError.message}`);
                    throw altError;
                }
            } else {
                throw apiError;
            }
        }
    } catch (error) {
        console.error('Error changing SSID:', error);
        return { 
            success: false, 
            message: error.response ? 
                `${error.message} (Status: ${error.response.status})` : 
                error.message 
        };
    }
}

// Update handler list ONU
async function handleListONU(remoteJid) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }

    try {
        // Kirim pesan bahwa proses sedang berlangsung
        await sock.sendMessage(remoteJid, { 
            text: `🔍 *MENCARI PERANGKAT*\n\nSedang mengambil daftar perangkat ONT...\nMohon tunggu sebentar.` 
        });

        // Ambil daftar perangkat dari GenieACS
        const devices = await getAllDevices();
        
        if (!devices || devices.length === 0) {
            await sock.sendMessage(remoteJid, { 
                text: `â„¹ï¸ *TIDAK ADA PERANGKAT*\n\nTidak ada perangkat ONT yang terdaftar dalam sistem.` 
            });
            return;
        }

        // Batasi jumlah perangkat yang ditampilkan untuk menghindari pesan terlalu panjang
        const maxDevices = 20;
        const displayedDevices = devices.slice(0, maxDevices);
        const remainingCount = devices.length - maxDevices;

        // Buat pesan dengan daftar perangkat
        let message = `📋 *DAFTAR PERANGKAT ONT*\n`;
        message += `Total: ${devices.length} perangkat\n\n`;

        displayedDevices.forEach((device, index) => {
            // Helper function untuk mengambil parameter dengan multiple paths
            const getParameterWithPaths = (device, paths) => {
                if (!device || !paths || !Array.isArray(paths)) return 'Unknown';

                for (const path of paths) {
                    try {
                        const pathParts = path.split('.');
                        let current = device;

                        for (const part of pathParts) {
                            if (current && typeof current === 'object') {
                                current = current[part];
                            } else {
                                break;
                            }
                        }

                        // Handle GenieACS parameter format
                        if (current && typeof current === 'object' && current._value !== undefined) {
                            const value = current._value;
                            // Make sure it's a string and not an object
                            if (typeof value === 'string' && value.trim() !== '') {
                                return value;
                            }
                        }

                        // Handle direct value - make sure it's a string
                        if (current !== null && current !== undefined && typeof current === 'string' && current.trim() !== '') {
                            return current;
                        }
                    } catch (error) {
                        // Continue to next path
                    }
                }
                return 'Unknown';
            };

            // Parameter paths untuk Serial Number
            const serialPaths = [
                'VirtualParameters.getSerialNumber',
                'InternetGatewayDevice.DeviceInfo.SerialNumber',
                'Device.DeviceInfo.SerialNumber'
            ];

            // Parameter paths untuk Model Name
            const modelPaths = [
                'InternetGatewayDevice.DeviceInfo.ModelName',
                'Device.DeviceInfo.ModelName'
            ];

            const serialNumber = getParameterWithPaths(device, serialPaths);
            const modelName = getParameterWithPaths(device, modelPaths);

            const lastInform = new Date(device._lastInform);
            const now = new Date();
            const diffMinutes = Math.floor((now - lastInform) / (1000 * 60));
            const isOnline = diffMinutes < 15;
            const statusText = isOnline ? '🟢 Online' : '🔴 Offline';

            const tags = device._tags || [];
            const customerInfo = tags.length > 0 ? tags[0] : 'No Tag';

            message += `${index + 1}. *${customerInfo}*\n`;
            message += `   • SN: ${serialNumber}\n`;
            message += `   • Model: ${modelName}\n`;
            message += `   • Status: ${statusText}\n`;
            message += `   • Last Seen: ${lastInform.toLocaleString()}\n\n`;
        });

        if (remainingCount > 0) {
            message += `...dan ${remainingCount} perangkat lainnya.\n`;
            message += `Gunakan panel admin web untuk melihat daftar lengkap.`;
        }

        await sock.sendMessage(remoteJid, { text: message });
    } catch (error) {
        console.error('Error in handleListONU:', error);
        await sock.sendMessage(remoteJid, { 
            text: `âŒ *ERROR*\n\nTerjadi kesalahan saat mengambil daftar perangkat:\n${error.message}`
        });
    }
}

// Fungsi untuk mengambil semua perangkat
async function getAllDevices() {
    try {
        // Cek apakah GenieACS URL sudah dikonfigurasi (dari database genieacs_servers)
        const { genieacsUrl } = await getGenieacsConfig();
        if (!genieacsUrl || genieacsUrl.trim() === '') {
            console.warn('⚠️ GenieACS URL tidak dikonfigurasi. Silakan konfigurasi di Settings.');
            return [];
        }
        
        // Gunakan fungsi dari config/genieacs.js yang sudah menangani error dengan baik
        const { getAllDevicesFromAllServers } = require('./genieacs');
        
        // Coba ambil dari semua server GenieACS
        const devices = await getAllDevicesFromAllServers();
        
        if (!devices || devices.length === 0) {
            console.warn('⚠️ Tidak ada perangkat ditemukan dari GenieACS');
            return [];
        }
        
        return devices;
    } catch (error) {
        console.error('Error getting all devices:', error);
        
        // Jika error karena URL tidak valid atau tidak dikonfigurasi, return empty array
        if (error.code === 'ERR_INVALID_URL' || error.message?.includes('Invalid URL') || error.message?.includes('tidak dikonfigurasi')) {
            console.warn('⚠️ GenieACS URL tidak dikonfigurasi dengan benar. Silakan konfigurasi di Settings.');
            return [];
        }
        
        // Untuk error lainnya, return empty array juga untuk mencegah crash
        return [];
    }
}

// Tambahkan handler untuk cek semua ONU (detail)
async function handleCheckAllONU(remoteJid) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }

    try {
        // Kirim pesan bahwa proses sedang berlangsung
        await sock.sendMessage(remoteJid, { 
            text: `🔍 *MEMERIKSA SEMUA PERANGKAT*\n\nSedang memeriksa status semua perangkat ONT...\nProses ini mungkin memakan waktu beberapa saat.` 
        });

        // Ambil daftar perangkat dari GenieACS
        const devices = await getAllDevices();
        
        if (!devices || devices.length === 0) {
            await sock.sendMessage(remoteJid, { 
                text: `â„¹ï¸ *TIDAK ADA PERANGKAT*\n\nTidak ada perangkat ONT yang terdaftar dalam sistem.` 
            });
            return;
        }

        // Hitung statistik perangkat
        let onlineCount = 0;
        let offlineCount = 0;
        let criticalRxPowerCount = 0;
        let warningRxPowerCount = 0;

        devices.forEach(device => {
            // Cek status online/offline
            const lastInform = new Date(device._lastInform);
            const now = new Date();
            const diffMinutes = Math.floor((now - lastInform) / (1000 * 60));
            const isOnline = diffMinutes < 15;
            
            if (isOnline) {
                onlineCount++;
            } else {
                offlineCount++;
            }

            // Cek RX Power
            const rxPower = device.InternetGatewayDevice?.X_GponLinkInfo?.RxPower?._value;
            if (rxPower) {
                const power = parseFloat(rxPower);
                if (power <= parseFloat(getSetting('rx_power_critical', -27))) {
                    criticalRxPowerCount++;
                } else if (power <= parseFloat(getSetting('rx_power_warning', -25))) {
                    warningRxPowerCount++;
                }
            }
        });

        // Buat pesan dengan statistik
        let message = `📊 *LAPORAN STATUS PERANGKAT*\n\n`;
        message += `📋 *Total Perangkat:* ${devices.length}\n\n`;
        message += `🟢 *Online:* ${onlineCount} (${Math.round(onlineCount/devices.length*100)}%)\n`;
        message += `🔴 *Offline:* ${offlineCount} (${Math.round(offlineCount/devices.length*100)}%)\n\n`;
        message += `🔧 *Status Sinyal:*\n`;
        message += `🔘 *Warning:* ${warningRxPowerCount} perangkat\n`;
        message += `🔥 *Critical:* ${criticalRxPowerCount} perangkat\n\n`;
        
        // Tambahkan daftar perangkat dengan masalah
        if (criticalRxPowerCount > 0) {
            message += `*PERANGKAT DENGAN SINYAL KRITIS:*\n`;
            let count = 0;
            
            for (const device of devices) {
    const rxPower = device.InternetGatewayDevice?.X_GponLinkInfo?.RxPower?._value;
    if (rxPower && parseFloat(rxPower) <= parseFloat(getSetting('rx_power_critical', -27))) {
        const tags = device._tags || [];
        const customerInfo = tags.length > 0 ? tags[0] : 'No Tag';
        const serialNumber = device.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value || 'Unknown';
        // Ambil PPPoE Username
        const pppoeUsername = device.VirtualParameters?.pppoeUsername?._value || device.InternetGatewayDevice?.WANDevice?.[1]?.WANConnectionDevice?.[1]?.WANPPPConnection?.[1]?.Username?._value || device.InternetGatewayDevice?.WANDevice?.[0]?.WANConnectionDevice?.[0]?.WANPPPConnection?.[0]?.Username?._value || '-';
        message += `${++count}. *${customerInfo}* (S/N: ${serialNumber})\n   PPPoE: ${pppoeUsername}\n   RX Power: ${rxPower} dBm\n`;
        // Batasi jumlah perangkat yang ditampilkan
        if (count >= 5) {
            message += `...dan ${criticalRxPowerCount - 5} perangkat lainnya.\n`;
            break;
        }
    }
}
            message += `\n`;
        }

        // Tambahkan daftar perangkat offline terbaru
        if (offlineCount > 0) {
            message += `*PERANGKAT OFFLINE TERBARU:*\n`;
            
            // Urutkan perangkat berdasarkan waktu terakhir online
            const offlineDevices = devices
                .filter(device => {
                    const lastInform = new Date(device._lastInform);
                    const now = new Date();
                    const diffMinutes = Math.floor((now - lastInform) / (1000 * 60));
                    return diffMinutes >= 15;
                })
                .sort((a, b) => new Date(b._lastInform) - new Date(a._lastInform));
            
            // Tampilkan 5 perangkat offline terbaru
            const recentOfflineDevices = offlineDevices.slice(0, 5);
            recentOfflineDevices.forEach((device, index) => {
    const tags = device._tags || [];
    const customerInfo = tags.length > 0 ? tags[0] : 'No Tag';
    const serialNumber = device.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value || 'Unknown';
    const lastInform = new Date(device._lastInform);
    // Ambil PPPoE Username
    const pppoeUsername = device.VirtualParameters?.pppoeUsername?._value || device.InternetGatewayDevice?.WANDevice?.[1]?.WANConnectionDevice?.[1]?.WANPPPConnection?.[1]?.Username?._value || device.InternetGatewayDevice?.WANDevice?.[0]?.WANConnectionDevice?.[0]?.WANPPPConnection?.[0]?.Username?._value || '-';
    message += `${index + 1}. *${customerInfo}* (S/N: ${serialNumber})\n   PPPoE: ${pppoeUsername}\n   Last Seen: ${lastInform.toLocaleString()}\n`;
});
            
            if (offlineCount > 5) {
                message += `...dan ${offlineCount - 5} perangkat offline lainnya.\n`;
            }
        }

        await sock.sendMessage(remoteJid, { text: message });
    } catch (error) {
        console.error('Error in handleCheckAllONU:', error);
        await sock.sendMessage(remoteJid, { 
            text: `âŒ *ERROR*\n\nTerjadi kesalahan saat memeriksa perangkat:\n${error.message}`
        });
    }
}

// Handler untuk menghapus user hotspot
async function handleDeleteHotspotUser(remoteJid, params) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }

    if (params.length < 1) {
        await sock.sendMessage(remoteJid, { 
            text: `❌ *FORMAT SALAH*\n\n` +
                  `Format yang benar:\n` +
                  `delhotspot [username]\n\n` +
                  `Contoh:\n` +
                  `• delhotspot user123`
        });
        return;
    }

    try {
        // Kirim pesan bahwa proses sedang berlangsung
        await sock.sendMessage(remoteJid, { 
            text: `⏳ *PROSES PENGHAPUSAN USER HOTSPOT*\n\nSedang menghapus user hotspot...\nMohon tunggu sebentar.` 
        });

        const [username] = params;
        console.log(`Deleting hotspot user: ${username}`);
        
        // Panggil fungsi untuk menghapus user hotspot
        const result = await deleteHotspotUser(username);
        console.log(`Hotspot user delete result:`, result);

        // Buat pesan respons berdasarkan result.success
        let responseMessage;
        if (result.success) {
            responseMessage = `✅ *BERHASIL MENGHAPUS USER HOTSPOT*\n\n` +
                             `• Username: ${username}\n` +
                             `• Status: ${result.message || 'User berhasil dihapus'}`;
        } else {
            responseMessage = `❌ *GAGAL MENGHAPUS USER HOTSPOT*\n\n` +
                             `• Username: ${username}\n` +
                             `• Alasan: ${result.message || 'User tidak ditemukan'}`;
        }

        // Kirim pesan respons dengan timeout
        setTimeout(async () => {
            try {
                await sock.sendMessage(remoteJid, { text: responseMessage });
                console.log(`Response message sent for delhotspot command`);
            } catch (sendError) {
                console.error('Error sending response message:', sendError);
                // Coba kirim ulang jika gagal
                setTimeout(async () => {
                    try {
                        await sock.sendMessage(remoteJid, { text: responseMessage });
                        console.log(`Response message sent on second attempt`);
                    } catch (retryError) {
                        console.error('Error sending response message on retry:', retryError);
                    }
                }, 2000);
            }
        }, 1500);
    } catch (error) {
        console.error('Error in handleDeleteHotspotUser:', error);
        
        // Kirim pesan error
        setTimeout(async () => {
            try {
                await sock.sendMessage(remoteJid, { 
                    text: `❌ *ERROR MENGHAPUS USER HOTSPOT*\n\n` +
                          `Terjadi kesalahan saat menghapus user hotspot:\n` +
                          `${error.message || 'Kesalahan tidak diketahui'}`
                });
            } catch (sendError) {
                console.error('Error sending error message:', sendError);
            }
        }, 1500);
    }
}

// Handler untuk menghapus PPPoE secret
async function handleDeletePPPoESecret(remoteJid, params) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }

    if (params.length < 1) {
        await sock.sendMessage(remoteJid, { 
            text: `❌ *FORMAT SALAH*\n\n` +
                  `Format yang benar:\n` +
                  `delpppoe [username]\n\n` +
                  `Contoh:\n` +
                  `• delpppoe user123`
        });
        return;
    }

    try {
        // Kirim pesan bahwa proses sedang berlangsung
        await sock.sendMessage(remoteJid, { 
            text: `⏳ *PROSES PENGHAPUSAN SECRET PPPoE*\n\nSedang menghapus secret PPPoE...\nMohon tunggu sebentar.` 
        });

        const [username] = params;
        console.log(`Deleting PPPoE secret: ${username}`);
        
        const result = await deletePPPoESecret(username);
        console.log(`PPPoE secret delete result:`, result);

        // Buat pesan respons berdasarkan result.success
        let responseMessage;
        if (result.success) {
            responseMessage = `✅ *BERHASIL MENGHAPUS SECRET PPPoE*\n\n` +
                             `• Username: ${username}\n` +
                             `• Status: ${result.message || 'Secret berhasil dihapus'}`;
        } else {
            responseMessage = `❌ *GAGAL MENGHAPUS SECRET PPPoE*\n\n` +
                             `• Username: ${username}\n` +
                             `• Alasan: ${result.message || 'Secret tidak ditemukan'}`;
        }

        // Kirim pesan respons dengan timeout
        setTimeout(async () => {
            try {
                await sock.sendMessage(remoteJid, { text: responseMessage });
                console.log(`Response message sent for delpppoe command`);
            } catch (sendError) {
                console.error('Error sending response message:', sendError);
                // Coba kirim ulang jika gagal
                setTimeout(async () => {
                    try {
                        await sock.sendMessage(remoteJid, { text: responseMessage });
                        console.log(`Response message sent on second attempt`);
                    } catch (retryError) {
                        console.error('Error sending response message on retry:', retryError);
                    }
                }, 2000);
            }
        }, 1500);
    } catch (error) {
        console.error('Error in handleDeletePPPoESecret:', error);
        
        // Kirim pesan error
        setTimeout(async () => {
            try {
                await sock.sendMessage(remoteJid, { 
                    text: `❌ *ERROR MENGHAPUS SECRET PPPoE*\n\n` +
                          `Terjadi kesalahan saat menghapus secret PPPoE:\n` +
                          `${error.message || 'Kesalahan tidak diketahui'}`
                });
            } catch (sendError) {
                console.error('Error sending error message:', sendError);
            }
        }, 1500);
    }
}

// Handler untuk menambah user hotspot
async function handleAddHotspotUser(remoteJid, params) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }

    console.log(`Processing addhotspot command with params:`, params);

    if (params.length < 2) {
        await sock.sendMessage(remoteJid, { 
            text: `❌ *FORMAT SALAH*\n\n` +
                  `Format yang benar:\n` +
                  `addhotspot [username] [password] [profile]\n\n` +
                  `Contoh:\n` +
                  `• addhotspot user123 pass123\n` +
                  `• addhotspot user123 pass123 default`
        });
        return;
    }

    try {
        // Kirim pesan bahwa proses sedang berlangsung
        await sock.sendMessage(remoteJid, { 
            text: `⏳ *PROSES PENAMBAHAN USER HOTSPOT*\n\nSedang menambahkan user hotspot...\nMohon tunggu sebentar.` 
        });

        const [username, password, profile = "default"] = params;
        console.log(`Adding hotspot user: ${username} with profile: ${profile}`);
        
        // Panggil fungsi untuk menambah user hotspot
        const result = await addHotspotUser(username, password, profile);
        console.log(`Hotspot user add result:`, result);

        // Buat pesan respons berdasarkan hasil
        let responseMessage = '';
        if (result.success) {
            responseMessage = `✅ *BERHASIL MENAMBAHKAN USER HOTSPOT*\n\n` +
                             `${result.message || 'User hotspot berhasil ditambahkan'}\n\n` +
                             `• Username: ${username}\n` +
                             `• Password: ${password}\n` +
                             `• Profile: ${profile}`;
        } else {
            responseMessage = `❌ *GAGAL MENAMBAHKAN USER HOTSPOT*\n\n` +
                             `${result.message || 'Terjadi kesalahan saat menambahkan user hotspot'}\n\n` +
                             `• Username: ${username}\n` +
                             `• Password: ${password}\n` +
                             `• Profile: ${profile}`;
        }

        // Kirim pesan respons dengan timeout untuk memastikan pesan terkirim
        setTimeout(async () => {
            try {
                console.log(`Sending response message for addhotspot command:`, responseMessage);
                await sock.sendMessage(remoteJid, { text: responseMessage });
                console.log(`Response message sent successfully`);
            } catch (sendError) {
                console.error('Error sending response message:', sendError);
                // Coba kirim ulang jika gagal
                setTimeout(async () => {
                    try {
                        await sock.sendMessage(remoteJid, { text: responseMessage });
                        console.log(`Response message sent on second attempt`);
                    } catch (retryError) {
                        console.error('Error sending response message on retry:', retryError);
                    }
                }, 2000);
            }
        }, 1500); // Tunggu 1.5 detik sebelum mengirim respons
        
    } catch (error) {
        console.error('Error in handleAddHotspotUser:', error);
        
        // Kirim pesan error dengan timeout
        setTimeout(async () => {
            try {
                await sock.sendMessage(remoteJid, { 
                    text: `❌ *ERROR MENAMBAHKAN USER HOTSPOT*\n\n` +
                          `Terjadi kesalahan saat menambahkan user hotspot:\n` +
                          `${error.message || 'Kesalahan tidak diketahui'}`
                });
            } catch (sendError) {
                console.error('Error sending error message:', sendError);
            }
        }, 1500);
    }
}

// Handler untuk menambah secret PPPoE
async function handleAddPPPoESecret(remoteJid, params) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }

    if (params.length < 2) {
        await sock.sendMessage(remoteJid, { 
            text: `❌ *FORMAT SALAH*\n\n` +
                  `Format yang benar:\n` +
                  `addpppoe [username] [password] [profile] [ip]\n\n` +
                  `Contoh:\n` +
                  `• addpppoe user123 pass123\n` +
                  `• addpppoe user123 pass123 default\n` +
                  `• addpppoe user123 pass123 default 10.0.0.1`
        });
        return;
    }

    try {
        // Kirim pesan bahwa proses sedang berlangsung
        await sock.sendMessage(remoteJid, { 
            text: `⏳ *PROSES PENAMBAHAN SECRET PPPoE*\n\nSedang menambahkan secret PPPoE...\nMohon tunggu sebentar.` 
        });

        const [username, password, profile = "default", localAddress = ""] = params;
        console.log(`Adding PPPoE secret: ${username} with profile: ${profile}, IP: ${localAddress || 'from pool'}`);
        
        const result = await addPPPoESecret(username, password, profile, localAddress);
        console.log(`PPPoE secret add result:`, result);

        // Buat pesan respons berdasarkan result.success
        let responseMessage;
        if (result.success) {
            responseMessage = `✅ *BERHASIL MENAMBAHKAN SECRET PPPoE*\n\n` +
                             `• Username: ${username}\n` +
                             `• Profile: ${profile}\n` +
                             `• IP: ${localAddress || 'Menggunakan IP dari pool'}\n` +
                             `• Status: ${result.message || 'Secret berhasil ditambahkan'}`;
        } else {
            responseMessage = `❌ *GAGAL MENAMBAHKAN SECRET PPPoE*\n\n` +
                             `• Username: ${username}\n` +
                             `• Profile: ${profile}\n` +
                             `• IP: ${localAddress || 'Menggunakan IP dari pool'}\n` +
                             `• Alasan: ${result.message || 'Terjadi kesalahan saat menambahkan secret'}`;
        }

        // Kirim pesan respons dengan timeout
        setTimeout(async () => {
            try {
                await sock.sendMessage(remoteJid, { text: responseMessage });
                console.log(`Response message sent for addpppoe command`);
            } catch (sendError) {
                console.error('Error sending response message:', sendError);
                // Coba kirim ulang jika gagal
                setTimeout(async () => {
                    try {
                        await sock.sendMessage(remoteJid, { text: responseMessage });
                        console.log(`Response message sent on second attempt`);
                    } catch (retryError) {
                        console.error('Error sending response message on retry:', retryError);
                    }
                }, 2000);
            }
        }, 1500);
    } catch (error) {
        console.error('Error in handleAddPPPoESecret:', error);
        
        // Kirim pesan error
        setTimeout(async () => {
            try {
                await sock.sendMessage(remoteJid, { 
                    text: `❌ *ERROR MENAMBAHKAN SECRET PPPoE*\n\n` +
                          `Terjadi kesalahan saat menambahkan secret PPPoE:\n` +
                          `${error.message || 'Kesalahan tidak diketahui'}`
                });
            } catch (sendError) {
                console.error('Error sending error message:', sendError);
            }
        }, 1500);
    }
}

// Handler untuk mengubah profile PPPoE
async function handleChangePPPoEProfile(remoteJid, params) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }

    if (params.length < 2) {
        await sock.sendMessage(remoteJid, { 
            text: `❌ *FORMAT SALAH*\n\n` +
                  `Format yang benar:\n` +
                  `setprofile [username] [new-profile]\n\n` +
                  `Contoh:\n` +
                  `setprofile user123 premium`
        });
        return;
    }

    try {
        // Kirim pesan bahwa proses sedang berlangsung
        await sock.sendMessage(remoteJid, { 
            text: `⏳ *PROSES PERUBAHAN PROFILE PPPoE*\n\nSedang mengubah profile PPPoE...\nMohon tunggu sebentar.` 
        });

        const [username, newProfile] = params;
        console.log(`Changing PPPoE profile for user ${username} to ${newProfile}`);
        
        // Ganti ke setPPPoEProfile (fungsi yang benar dari mikrotik.js)
        const result = await setPPPoEProfile(username, newProfile);
        console.log(`PPPoE profile change result:`, result);

        // Buat pesan respons berdasarkan result.success
        let responseMessage;
        if (result.success) {
            responseMessage = `✅ *BERHASIL MENGUBAH PROFILE PPPoE*\n\n` +
                             `• Username: ${username}\n` +
                             `• Profile Baru: ${newProfile}\n` +
                             `• Status: ${result.message || 'Profile berhasil diubah'}`;
        } else {
            responseMessage = `❌ *GAGAL MENGUBAH PROFILE PPPoE*\n\n` +
                             `• Username: ${username}\n` +
                             `• Profile Baru: ${newProfile}\n` +
                             `• Alasan: ${result.message || 'User tidak ditemukan'}`;
        }

        // Kirim pesan respons dengan timeout
        setTimeout(async () => {
            try {
                await sock.sendMessage(remoteJid, { text: responseMessage });
                console.log(`Response message sent for setprofile command`);
            } catch (sendError) {
                console.error('Error sending response message:', sendError);
                // Coba kirim ulang jika gagal
                setTimeout(async () => {
                    try {
                        await sock.sendMessage(remoteJid, { text: responseMessage });
                        console.log(`Response message sent on second attempt`);
                    } catch (retryError) {
                        console.error('Error sending response message on retry:', retryError);
                    }
                }, 2000);
            }
        }, 1500);
    } catch (error) {
        console.error('Error in handleChangePPPoEProfile:', error);
        
        // Kirim pesan error
        setTimeout(async () => {
            try {
                await sock.sendMessage(remoteJid, { 
                    text: `❌ *ERROR MENGUBAH PROFILE PPPoE*\n\n` +
                          `Terjadi kesalahan saat mengubah profile PPPoE:\n` +
                          `${error.message || 'Kesalahan tidak diketahui'}`
                });
            } catch (sendError) {
                console.error('Error sending error message:', sendError);
            }
        }, 1500);
    }
}

// Handler untuk monitoring resource
async function handleResourceInfo(remoteJid) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }

    try {
        // Kirim pesan sedang memproses
        await sock.sendMessage(remoteJid, {
            text: `⏳ *Memproses Permintaan*\n\nSedang mengambil informasi resource router...`
        });

        // Import modul mikrotik
        const mikrotik = require('./mikrotik');

        // Ambil informasi resource
        const result = await mikrotik.getResourceInfo();

        if (result.success) {
            const data = result.data;

            // Format CPU info
            let cpuInfo = `💻 *CPU*\n• Load: ${data.cpuLoad}%\n`;
            if (data.cpuCount > 0) cpuInfo += `• Count: ${data.cpuCount}\n`;
            if (data.cpuFrequency > 0) cpuInfo += `• Frequency: ${data.cpuFrequency} MHz\n`;

            // Format Memory info dengan penanganan data tidak tersedia
            let memoryInfo = `🧠 *MEMORY*\n`;
            if (data.totalMemory > 0) {
                const memUsagePercent = ((data.memoryUsed / data.totalMemory) * 100).toFixed(1);
                memoryInfo += `• Free: ${data.memoryFree.toFixed(2)} MB\n`;
                memoryInfo += `• Total: ${data.totalMemory.toFixed(2)} MB\n`;
                memoryInfo += `• Used: ${data.memoryUsed.toFixed(2)} MB\n`;
                memoryInfo += `• Usage: ${memUsagePercent}%\n`;
            } else {
                memoryInfo += `• Status: ⚠️ Data tidak tersedia\n`;
            }

            // Format Disk info
            let diskInfo = `💾 *DISK*\n`;
            if (data.totalDisk > 0) {
                const diskUsagePercent = ((data.diskUsed / data.totalDisk) * 100).toFixed(1);
                diskInfo += `• Total: ${data.totalDisk.toFixed(2)} MB\n`;
                diskInfo += `• Free: ${data.diskFree.toFixed(2)} MB\n`;
                diskInfo += `• Used: ${data.diskUsed.toFixed(2)} MB\n`;
                diskInfo += `• Usage: ${diskUsagePercent}%\n`;
            } else {
                diskInfo += `• Status: ⚠️ Data tidak tersedia\n`;
            }

            // Format System info
            let systemInfo = `🙏 *UPTIME*\n• ${data.uptime}\n\n`;
            systemInfo += `⚙️ *SYSTEM INFO*\n`;
            if (data.model !== 'N/A') systemInfo += `• Model: ${data.model}\n`;
            if (data.architecture !== 'N/A') systemInfo += `• Architecture: ${data.architecture}\n`;
            if (data.version !== 'N/A') systemInfo += `• Version: ${data.version}\n`;
            if (data.boardName !== 'N/A') systemInfo += `• Board: ${data.boardName}\n`;

            const message = `📊 *INFO RESOURCE ROUTER*

${cpuInfo}
${memoryInfo}
${diskInfo}
${systemInfo}`;

            await sock.sendMessage(remoteJid, { text: message });
        } else {
            await sock.sendMessage(remoteJid, {
                text: `❌ *ERROR*

${result.message}

Silakan coba lagi nanti.`
            });
        }
    } catch (error) {
        console.error('Error handling resource info command:', error);

        // Kirim pesan error
        try {
            await sock.sendMessage(remoteJid, {
                text: `❌ *ERROR*

Terjadi kesalahan saat mengambil informasi resource: ${error.message}

Silakan coba lagi nanti.`
            });
        } catch (sendError) {
            console.error('Error sending error message:', sendError);
        }
    }
}

// Handler untuk melihat user hotspot aktif
async function handleActiveHotspotUsers(remoteJid) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }

    try {
        // Kirim pesan sedang memproses
        await sock.sendMessage(remoteJid, { 
            text: `⏳ *Memproses Permintaan*\n\nSedang mengambil daftar user hotspot aktif...`
        });
        
        console.log('Fetching active hotspot users');
        
        // Import modul mikrotik
        const mikrotik = require('./mikrotik');
        
        // Ambil daftar user hotspot aktif
        const result = await mikrotik.getActiveHotspotUsers();

        if (result.success) {
            let message = '🔥 *DAFTAR USER HOTSPOT AKTIF*\n\n';
            
            if (result.data.length === 0) {
                message += 'Tidak ada user hotspot yang aktif';
            } else {
                result.data.forEach((user, index) => {
                    // Helper function untuk parsing bytes
                    const parseBytes = (value) => {
                        if (value === null || value === undefined || value === '') return 0;

                        // Jika sudah berupa number
                        if (typeof value === 'number') return value;

                        // Jika berupa string, parse sebagai integer
                        if (typeof value === 'string') {
                            const parsed = parseInt(value.replace(/[^0-9]/g, ''));
                            return isNaN(parsed) ? 0 : parsed;
                        }

                        return 0;
                    };

                    const bytesIn = parseBytes(user['bytes-in']);
                    const bytesOut = parseBytes(user['bytes-out']);

                    message += `${index + 1}. *User: ${user.user || 'N/A'}*\n` +
                              `   • IP: ${user.address || 'N/A'}\n` +
                              `   • Uptime: ${user.uptime || 'N/A'}\n` +
                              `   • Download: ${(bytesIn/1024/1024).toFixed(2)} MB\n` +
                              `   • Upload: ${(bytesOut/1024/1024).toFixed(2)} MB\n\n`;
                });
            }
            
            await sock.sendMessage(remoteJid, { text: message });
        } else {
            await sock.sendMessage(remoteJid, { 
                text: `❌ *ERROR*

${result.message}

Silakan coba lagi nanti.`
            });
        }
    } catch (error) {
        console.error('Error handling active hotspot users command:', error);
        
        // Kirim pesan error
        try {
            await sock.sendMessage(remoteJid, { 
                text: `❌ *ERROR*

Terjadi kesalahan saat mengambil daftar user hotspot aktif: ${error.message}

Silakan coba lagi nanti.`
            });
        } catch (sendError) {
            console.error('Error sending error message:', sendError);
        }
    }
}

// Perbaiki fungsi handleActivePPPoE
async function handleActivePPPoE(remoteJid) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }

    try {
        // Kirim pesan sedang memproses
        await sock.sendMessage(remoteJid, { 
            text: `⏳ *Memproses Permintaan*\n\nSedang mengambil daftar koneksi PPPoE aktif...`
        });
        
        console.log('Fetching active PPPoE connections');
        
        // Import modul mikrotik
        const mikrotik = require('./mikrotik');
        
        // Ambil daftar koneksi PPPoE aktif
        const result = await mikrotik.getActivePPPoEConnections();

        if (result.success) {
            let message = '📶 *DAFTAR KONEKSI PPPoE AKTIF*\n\n';
            
            if (result.data.length === 0) {
                message += 'Tidak ada koneksi PPPoE yang aktif';
            } else {
                result.data.forEach((conn, index) => {
                    message += `${index + 1}. *User: ${conn.name}*\n` +
                              `   • Service: ${conn.service}\n` +
                              `   • IP: ${conn.address}\n` +
                              `   • Uptime: ${conn.uptime}\n` +
                              `   • Encoding: ${conn.encoding}\n\n`;
                });
            }
            
            await sock.sendMessage(remoteJid, { text: message });
        } else {
            await sock.sendMessage(remoteJid, { 
                text: `❌ *ERROR*

${result.message}

Silakan coba lagi nanti.`
            });
        }
    } catch (error) {
        console.error('Error handling active PPPoE connections command:', error);
        
        // Kirim pesan error
        try {
            await sock.sendMessage(remoteJid, { 
                text: `❌ *ERROR*

Terjadi kesalahan saat mengambil daftar koneksi PPPoE aktif: ${error.message}

Silakan coba lagi nanti.`
            });
        } catch (sendError) {
            console.error('Error sending error message:', sendError);
        }
    }
}

// Tambahkan fungsi untuk mendapatkan daftar user offline
async function handleOfflineUsers(remoteJid) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }

    try {
        // Kirim pesan sedang memproses
        await sock.sendMessage(remoteJid, { 
            text: `⏳ *Memproses Permintaan*\n\nSedang mengambil daftar user PPPoE offline...`
        });
        
        console.log('Fetching offline PPPoE users');
        
        // Import modul mikrotik
        const mikrotik = require('./mikrotik');
        
        // Ambil daftar user PPPoE offline
        const result = await mikrotik.getInactivePPPoEUsers();

        if (result.success) {
            let message = `📊 *DAFTAR USER PPPoE OFFLINE*\n\n`;
            message += `Total User: ${result.totalSecrets}\n`;
            message += `User Aktif: ${result.totalActive} (${((result.totalActive/result.totalSecrets)*100).toFixed(2)}%)\n`;
            message += `User Offline: ${result.totalInactive} (${((result.totalInactive/result.totalSecrets)*100).toFixed(2)}%)\n\n`;
            
            if (result.data.length === 0) {
                message += 'Tidak ada user PPPoE yang offline';
            } else {
                // Batasi jumlah user yang ditampilkan untuk menghindari pesan terlalu panjang
                const maxUsers = 30;
                const displayUsers = result.data.slice(0, maxUsers);
                
                displayUsers.forEach((user, index) => {
                    message += `${index + 1}. *${user.name}*${user.comment ? ` (${user.comment})` : ''}\n`;
                });
                
                if (result.data.length > maxUsers) {
                    message += `\n... dan ${result.data.length - maxUsers} user lainnya`;
                }
            }
            
            await sock.sendMessage(remoteJid, { text: message });
        } else {
            await sock.sendMessage(remoteJid, { 
                text: `❌ *ERROR*

${result.message}

Silakan coba lagi nanti.`
            });
        }
    } catch (error) {
        console.error('Error handling offline users command:', error);
        
        // Kirim pesan error
        try {
            await sock.sendMessage(remoteJid, { 
                text: `❌ *ERROR*

Terjadi kesalahan saat mengambil daftar user offline: ${error.message}

Silakan coba lagi nanti.`
            });
        } catch (sendError) {
            console.error('Error sending error message:', sendError);
        }
    }
}

const sendMessage = require('./sendMessage');

// Export modul
// Keep-alive mechanism untuk menjaga koneksi tetap hidup
let keepAliveInterval = null;
let connectionStateInterval = null;

function startKeepAlive(sock) {
    // Stop existing keep-alive jika ada
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
    
    // Keep-alive setiap 30 detik dengan mengirim ping ke WhatsApp
    keepAliveInterval = setInterval(async () => {
        try {
            if (sock && sock.user) {
                // Cek apakah koneksi masih aktif dengan membaca status
                const status = global.whatsappStatus;
                if (status && status.connected) {
                    // Koneksi masih aktif, tidak perlu action
                    // Log hanya setiap 5 menit untuk mengurangi spam
                    const now = Date.now();
                    if (!global.lastKeepAliveLog || (now - global.lastKeepAliveLog) > 300000) {
                        console.log('💓 Keep-alive: Koneksi WhatsApp masih aktif');
                        global.lastKeepAliveLog = now;
                    }
                } else {
                    // Koneksi terputus, trigger reconnect
                    console.warn('⚠️ Keep-alive: Koneksi terputus, akan reconnect...');
                    if (keepAliveInterval) {
                        clearInterval(keepAliveInterval);
                        keepAliveInterval = null;
                    }
                    // Trigger reconnect
                    setTimeout(() => {
                        connectToWhatsApp();
                    }, 5000);
                }
            }
        } catch (error) {
            console.error('⚠️ Error in keep-alive:', error.message);
            // Jika error, mungkin koneksi terputus
            if (keepAliveInterval) {
                clearInterval(keepAliveInterval);
                keepAliveInterval = null;
            }
            // Trigger reconnect
            setTimeout(() => {
                connectToWhatsApp();
            }, 5000);
        }
    }, 30000); // Check setiap 30 detik
    
    console.log('✅ Keep-alive mechanism started');
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
        console.log('🛑 Keep-alive mechanism stopped');
    }
}

// Connection state monitoring untuk detect silent disconnects
function startConnectionStateMonitoring(sock) {
    // Stop existing monitoring jika ada
    if (connectionStateInterval) {
        clearInterval(connectionStateInterval);
        connectionStateInterval = null;
    }
    
    // Monitor connection state setiap 60 detik
    connectionStateInterval = setInterval(async () => {
        try {
            if (sock) {
                const waStatus = global.whatsappStatus || {};
                const statusLabel = String(waStatus.status || '').toLowerCase();
                const isQrPhase =
                    statusLabel === 'qr_code' ||
                    statusLabel === 'connecting' ||
                    statusLabel === 'session_deleted';

                // Cek apakah socket masih valid
                if (!sock.user || !sock.ev) {
                    // Saat fase QR, sock.user memang belum ada. Jangan reconnect paksa agar QR tetap valid untuk dipindai.
                    if (isQrPhase) {
                        return;
                    }
                    console.warn('⚠️ Connection state: Socket invalid, akan reconnect...');
                    if (connectionStateInterval) {
                        clearInterval(connectionStateInterval);
                        connectionStateInterval = null;
                    }
                    stopKeepAlive();
                    setTimeout(() => {
                        connectToWhatsApp();
                    }, 5000);
                    return;
                }
                
                // Cek status koneksi dari global
                const status = global.whatsappStatus;
                if (!status || !status.connected) {
                    const st = String(status?.status || '').toLowerCase();
                    if (st === 'qr_code' || st === 'connecting' || st === 'session_deleted') {
                        return;
                    }
                    console.warn('⚠️ Connection state: Status disconnected, akan reconnect...');
                    if (connectionStateInterval) {
                        clearInterval(connectionStateInterval);
                        connectionStateInterval = null;
                    }
                    stopKeepAlive();
                    setTimeout(() => {
                        connectToWhatsApp();
                    }, 5000);
                    return;
                }
                
                // Log setiap 5 menit untuk mengurangi spam
                const now = Date.now();
                if (!global.lastConnectionStateLog || (now - global.lastConnectionStateLog) > 300000) {
                    console.log('✅ Connection state: Koneksi WhatsApp sehat');
                    global.lastConnectionStateLog = now;
                }
            }
        } catch (error) {
            console.error('⚠️ Error in connection state monitoring:', error.message);
            if (connectionStateInterval) {
                clearInterval(connectionStateInterval);
                connectionStateInterval = null;
            }
            stopKeepAlive();
            setTimeout(() => {
                connectToWhatsApp();
            }, 5000);
        }
    }, 60000); // Check setiap 60 detik
    
    console.log('✅ Connection state monitoring started');
}

function stopConnectionStateMonitoring() {
    if (connectionStateInterval) {
        clearInterval(connectionStateInterval);
        connectionStateInterval = null;
        console.log('🛑 Connection state monitoring stopped');
    }
}

module.exports = {
    setSock,
    handleAddHotspotUser,
    handleAddPPPoESecret,
    handleChangePPPoEProfile,
    handleResourceInfo,
    handleActiveHotspotUsers,
    handleActivePPPoE,
    handleDeleteHotspotUser,
    handleDeletePPPoESecret,
    connectToWhatsApp,
    sendMessage,
    getWhatsAppStatus,
    deleteWhatsAppSession,
    getSock,
    handleOfflineUsers,
    handleInfoLayanan
};

// Fungsi untuk mengecek apakah perintah terkait dengan WiFi/SSID
function isWifiCommand(commandStr) {
    const command = commandStr.split(' ')[0].toLowerCase();
    const wifiKeywords = [
        'gantiwifi', 'ubahwifi', 'changewifi', 'wifi', 
        'gantissid', 'ubahssid', 'ssid',
        'namawifi', 'updatewifi', 'wifiname', 'namessid',
        'setwifi', 'settingwifi', 'changewifiname'
    ];
    
    // Hapus 'editssid' dan 'editwifi' dari daftar perintah WiFi biasa
    // karena ini adalah perintah khusus admin
    return wifiKeywords.includes(command);
}

// Fungsi untuk mengecek apakah perintah terkait dengan password/sandi
function isPasswordCommand(commandStr) {
    const command = commandStr.split(' ')[0].toLowerCase();
    const passwordKeywords = [
        'gantipass', 'ubahpass', 'editpass', 'changepass', 'password',
        'gantisandi', 'ubahsandi', 'editsandi', 'sandi',
        'gantipw', 'ubahpw', 'editpw', 'pw', 'pass',
        'gantipassword', 'ubahpassword', 'editpassword',
        'passwordwifi', 'wifipassword', 'passw', 'passwordwifi'
    ];
    
    return passwordKeywords.includes(command);
}

// Fungsi untuk mengirim pesan selamat datang
async function sendWelcomeMessage(remoteJid, isAdmin = false) {
    try {
        console.log(`Mengirim pesan selamat datang ke ${remoteJid}, isAdmin: ${isAdmin}`);
        
        // Pesan selamat datang
        let welcomeMessage = `👋 *Selamat Datang di Bot WhatsApp ${getSetting('company_header', 'CV Lintas Multimedia')}*\n\n`;
        
        if (isAdmin) {
            welcomeMessage += `Halo Admin! Anda dapat menggunakan berbagai perintah untuk mengelola sistem.\n\n`;
        } else {
            welcomeMessage += `Halo Pelanggan! Anda dapat menggunakan bot ini untuk mengelola perangkat Anda.\n\n`;
        }
        
        welcomeMessage += `Ketik *menu* untuk melihat daftar perintah yang tersedia.\n\n`;
        
        // Tambahkan footer
        welcomeMessage += `🏢 *${getSetting('company_header', 'CV Lintas Multimedia')}*\n`;
        welcomeMessage += `${getSetting('footer_info', 'Internet Tanpa Batas')}`;
        
        // Kirim pesan selamat datang
        await sock.sendMessage(remoteJid, { text: welcomeMessage });
        console.log(`Pesan selamat datang terkirim ke ${remoteJid}`);
        
        return true;
    } catch (error) {
        console.error('Error sending welcome message:', error);
        return false;
    }
}

// Fungsi untuk encode device ID
function encodeDeviceId(deviceId) {
    // Pastikan deviceId adalah string
    const idString = String(deviceId);
    
    // Encode komponen-komponen URL secara terpisah
    return idString.split('/').map(part => encodeURIComponent(part)).join('/');
}

// Fungsi untuk mendapatkan status WhatsApp
function getWhatsAppStatus(tenantId = null) {
    try {
        const tid = parseInt(tenantId, 10);
        const normalizedTid = Number.isFinite(tid) && tid > 0 ? tid : null;
        if (normalizedTid) {
            const registry = require('./baileys-session-registry');
            return registry.getStatus(normalizedTid);
        }

        // Gunakan global.whatsappStatus jika tersedia
        if (global.whatsappStatus) {
            return global.whatsappStatus;
        }
        
        if (!sock) {
            return {
                connected: false,
                status: 'disconnected',
                qrCode: null
            };
        }

        if (sock.user) {
            return {
                connected: true,
                status: 'connected',
                phoneNumber: sock.user.id.split(':')[0],
                connectedSince: new Date()
            };
        }

        return {
            connected: false,
            status: 'connecting',
            qrCode: null
        };
    } catch (error) {
        console.error('Error getting WhatsApp status:', error);
        return {
            connected: false,
            status: 'error',
            error: error.message,
            qrCode: null
        };
    }
}

// Fungsi untuk menghapus sesi WhatsApp
async function deleteWhatsAppSession(tenantId = null) {
    try {
        const tid = parseInt(tenantId, 10);
        const normalizedTid = Number.isFinite(tid) && tid > 0 ? tid : null;

        if (normalizedTid) {
            const registry = require('./baileys-session-registry');
            await registry.deleteSession(normalizedTid);
            setTimeout(() => {
                connectToWhatsApp(normalizedTid).catch(() => {});
            }, 2000);
            return { success: true, message: `Sesi WhatsApp tenant ${normalizedTid} berhasil dihapus` };
        }

        const registry = require('./baileys-session-registry');
        // Legacy: hapus file root saja, jangan hapus tenant-*
        await registry.deleteSession(null);

        console.log('Sesi WhatsApp legacy berhasil dihapus');

        try {
            const { clearOwnerTenantId } = require('./baileys-session-owner');
            clearOwnerTenantId('session_deleted');
        } catch (_) { /* optional */ }
        
        // Reset status
        global.whatsappStatus = {
            connected: false,
            qrCode: null,
            phoneNumber: null,
            connectedSince: null,
            status: 'session_deleted'
        };
        
        // Restart koneksi WhatsApp legacy
        if (sock) {
            try {
                sock.logout();
            } catch (error) {
                console.log('Error saat logout:', error);
            }
            try {
                if (sock.ev && typeof sock.ev.removeAllListeners === 'function') {
                    sock.ev.removeAllListeners();
                }
            } catch (_) {}
            sock = null;
        }
        
        // Mulai ulang koneksi setelah 2 detik
        setTimeout(() => {
            connectToWhatsApp();
        }, 2000);
        
        return { success: true, message: 'Sesi WhatsApp berhasil dihapus' };
    } catch (error) {
        console.error('Error saat menghapus sesi WhatsApp:', error);
        return { success: false, message: error.message };
    }
}

// Tambahkan fungsi ini di atas module.exports
function getSock() {
    return sock;
}

// Fungsi untuk menangani perintah member (username dan password berbeda)
async function handleMemberCommand(remoteJid, params) {
    try {
        // Format: member [username] [password] [profile] [buyer_number]
        if (params.length < 3) {
            await sock.sendMessage(remoteJid, { 
                text: `❌ *FORMAT SALAH*

Format yang benar:
member [username] [password] [profile] [nomer_pembeli]

Contoh:
• member user123 pass123 3k 08123456789
• member user123 pass123 3k`
            });
            return;
        }

        const username = params[0];
        const password = params[1];
        const profile = params[2];
        const buyerNumber = params[3];

        // Validasi username dan profile
        if (!username || !password || !profile) {
            await sock.sendMessage(remoteJid, { 
                text: `❌ *GAGAL MEMBUAT USER*\n\nUsername, password, dan profile harus diisi.`
            });
            return;
        }

        await sock.sendMessage(remoteJid, { 
            text: `⏳ *PROSES PEMBUATAN USER*\n\nSedang membuat user...\nMohon tunggu sebentar.` 
        });

        // Buat user di Mikrotik
        const result = await addHotspotUser(username, password, profile);
        
        // Format pesan untuk admin berdasarkan result.success
        let responseMessage;
        if (result.success) {
            responseMessage = `✅ *BERHASIL MEMBUAT USER*\n\n` +
                             `• Username: ${username}\n` +
                             `• Password: ${password}\n` +
                             `• Profile: ${profile}\n` +
                             `• Status: ${result.message || 'User berhasil dibuat'}`;
        } else {
            responseMessage = `❌ *GAGAL MEMBUAT USER*\n\n` +
                             `• Username: ${username}\n` +
                             `• Password: ${password}\n` +
                             `• Profile: ${profile}\n` +
                             `• Alasan: ${result.message || 'Terjadi kesalahan saat membuat user'}`;
        }

        // Jika ada nomor pembeli dan user berhasil dibuat, kirim juga ke pembeli
        if (buyerNumber && result.success) {
            // Hapus semua karakter non-angka
            let cleanNumber = buyerNumber.replace(/\D/g, '');
            
            // Jika nomor diawali 0, ganti dengan 62
            if (cleanNumber.startsWith('0')) {
                cleanNumber = '62' + cleanNumber.substring(1);
            } 
            // Jika nomor diawali 8 (tanpa 62), tambahkan 62
            else if (cleanNumber.startsWith('8')) {
                cleanNumber = '62' + cleanNumber;
            }
            
            const buyerJid = `${cleanNumber}@s.whatsapp.net`;
            
            // Dapatkan header dan footer dari settings
            const settings = getAppSettings();
            const header = settings.company_header || 'AKUN INTERNET ANDA';
            const footer = settings.footer_info || 'Terima kasih telah menggunakan layanan kami.';
            
            const buyerMessage = `📋 *${header.toUpperCase()}*\n\n` +
                               `Berikut detail akses internet Anda:\n` +
                               `• Username: ${username}\n` +
                               `• Password: ${password}\n` +
                               `• Kecepatan: ${profile}\n\n` +
                               `_${footer}_`;
            
            try {
                // Coba kirim pesan langsung tanpa cek nomor terdaftar
                await sock.sendMessage(buyerJid, { 
                    text: buyerMessage 
                }, { 
                    waitForAck: false 
                });
                responseMessage += '\n\n✅ Notifikasi berhasil dikirim ke pembeli.';
            } catch (error) {
                console.error('Gagal mengirim notifikasi ke pembeli:', error);
                responseMessage += '\n\n⚠️ Gagal mengirim notifikasi ke pembeli. Pastikan nomor WhatsApp aktif dan terdaftar.';
            }
        }

        await sock.sendMessage(remoteJid, { text: responseMessage });
    } catch (error) {
        console.error('Error in handleMemberCommand:', error);
        await sock.sendMessage(remoteJid, { 
            text: '❌ *TERJADI KESALAHAN*\n\nGagal memproses perintah. Silakan coba lagi.'
        });
    }
}

// Handler untuk membuat voucher hotspot
async function handleVoucherCommand(remoteJid, params) {
    if (!sock) {
        console.error('Sock instance not set');
        return;
    }

    if (params.length < 2) {
        await sock.sendMessage(remoteJid, { 
            text: `❌ *FORMAT SALAH*\n\n` +
                  `Format yang benar:\n` +
                  `vcr [username] [profile] [nomer_pembeli]\n\n` +
                  `Contoh:\n` +
                  `• vcr pelanggan1 1Mbps 62812345678\n` +
                  `• vcr pelanggan2 2Mbps`
        });
        return;
    }

    try {
        const username = params[0];
        const profile = params[1];
        const buyerNumber = params[2] ? params[2].replace(/[^0-9]/g, '') : null;
        
        // Kirim pesan bahwa proses sedang berlangsung
        await sock.sendMessage(remoteJid, { 
            text: `⏳ *MEMBUAT VOUCHER HOTSPOT*\n\n` +
                  `Sedang memproses pembuatan voucher...\n` +
                  `• Username: ${username}\n` +
                  `• Profile: ${profile}\n` +
                  `• Password: Sama dengan username\n`
        });

        // Buat user hotspot (password sama dengan username)
        const result = await addHotspotUser(username, username, profile);
        
        if (result.success) {
            // Pesan untuk admin
            let message = `✅ *VOUCHER BERHASIL DIBUAT*\n\n` +
                         `Detail Voucher:\n` +
                         `• Username: ${username}\n` +
                         `• Password: ${username}\n` +
                         `• Profile: ${profile}\n` +
                         `• Status: ${result.message || 'Voucher berhasil dibuat'}\n\n` +
                         `_Voucher ini akan aktif segera setelah perangkat terhubung ke jaringan._`;

            // Kirim ke admin
            await sock.sendMessage(remoteJid, { text: message });

            // Jika ada nomor pembeli, kirim juga ke pembeli
            if (buyerNumber) {
                // Hapus semua karakter non-angka
                let cleanNumber = buyerNumber.replace(/\D/g, '');
                
                // Jika nomor diawali 0, ganti dengan 62
                if (cleanNumber.startsWith('0')) {
                    cleanNumber = '62' + cleanNumber.substring(1);
                } 
                // Jika nomor diawali 8 (tanpa 62), tambahkan 62
                else if (cleanNumber.startsWith('8')) {
                    cleanNumber = '62' + cleanNumber;
                }
                
                const buyerJid = `${cleanNumber}@s.whatsapp.net`;
                
                // Dapatkan header dan footer dari settings
                const settings = getAppSettings();
                const header = settings.company_header || 'VOUCHER INTERNET ANDA';
                const footer = settings.footer_info || 'Terima kasih telah menggunakan layanan kami.';
                
                const buyerMessage = `📋 *${header.toUpperCase()}*\n\n` +
                                   `Berikut detail akses internet Anda:\n` +
                                   `• Username: ${username}\n` +
                                   `• Password: ${username}\n` +
                                   `• Harga: ${profile}\n\n` +
                                   `_${footer}_`;
                
                try {
                    // Coba kirim pesan langsung tanpa cek nomor terdaftar
                    const sendPromise = sock.sendMessage(buyerJid, { 
                        text: buyerMessage,
                        // Tambahkan opsi untuk menghindari error jika nomor tidak terdaftar
                        // dan tetap lanjutkan proses
                        waitForAck: false
                    });
                    
                    // Set timeout 10 detik (lebih cepat)
                    const timeoutPromise = new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Waktu pengiriman habis')), 10000)
                    );
                    
                    // Tunggu salah satu: pesan terkirim atau timeout
                    await Promise.race([sendPromise, timeoutPromise]);
                    
                    await sock.sendMessage(remoteJid, { 
                        text: `💎 Notifikasi voucher telah dikirim ke: ${buyerNumber}`
                    });
                } catch (error) {
                    console.error('Gagal mengirim notifikasi ke pembeli:', error);
                    // Tetap lanjutkan meskipun gagal kirim notifikasi
                    await sock.sendMessage(remoteJid, { 
                        text: `✅ *VOUCHER BERHASIL DIBUAT*\n\n` +
                              `Detail Voucher telah berhasil dibuat, namun notifikasi ke ${buyerNumber} gagal terkirim.\n` +
                              `Ini bisa terjadi jika nomor tidak terdaftar di WhatsApp atau ada masalah koneksi.`
                    });
                }
            }
        } else {
            // Kirim pesan error jika gagal membuat voucher
            await sock.sendMessage(remoteJid, { 
                text: `❌ *GAGAL MEMBUAT VOUCHER*\n\n` +
                      `• Username: ${username}\n` +
                      `• Profile: ${profile}\n` +
                      `• Alasan: ${result.message || 'Terjadi kesalahan saat membuat voucher'}`
            });
        }
    } catch (error) {
        console.error('Error in handleVoucherCommand:', error);
        
        // Kirim pesan error
        await sock.sendMessage(remoteJid, { 
            text: `❌ *ERROR MEMBUAT VOUCHER*\n\n` +
                  `Terjadi kesalahan saat membuat voucher:\n` +
                  `${error.message || 'Kesalahan tidak diketahui'}`
        });
    }
}

// Fungsi untuk menangani pesan masuk dengan penanganan error dan logging yang lebih baik
async function handleIncomingMessage(sock, message) {
    console.log('📱 [HANDLER] handleIncomingMessage called');
    
    try {
        // Validasi input
        if (!message || !message.key) {
            console.warn('⚠️ [HANDLER] Invalid message received', { message: typeof message });
            return;
        }
        
        // Ekstrak informasi pesan
        const remoteJid = message.key.remoteJid;
        if (!remoteJid) {
            console.warn('⚠️ [HANDLER] Message without remoteJid received', { messageKey: message.key });
            return;
        }
        
        console.log(`📱 [HANDLER] Processing message from: ${remoteJid}`);
        
        // Skip if message already processed by agent handler
        if (message._agentProcessed) {
            console.log('📱 [HANDLER] Message already processed by agent handler, skipping');
            return;
        }
        
        // Skip jika pesan dari grup dan bukan dari admin
        if (remoteJid.includes('@g.us')) {
            console.log('📱 [HANDLER] Message from group received', { groupJid: remoteJid });
            const participant = message.key.participant;
            if (!participant || !isAdminNumber(participant.split('@')[0])) {
                console.log('📱 [HANDLER] Group message not from admin, ignoring', { participant });
                return;
            }
            console.log('📱 [HANDLER] Group message from admin, processing', { participant });
        }
        
        // Cek tipe pesan dan ekstrak teks
        let messageText = '';
        if (!message.message) {
            console.warn('⚠️ [HANDLER] Message without content received', { messageType: 'unknown' });
            return;
        }
        
        if (message.message.conversation) {
            messageText = message.message.conversation;
            console.log('📱 [HANDLER] Conversation message received');
        } else if (message.message.extendedTextMessage) {
            messageText = message.message.extendedTextMessage.text;
            console.log('📱 [HANDLER] Extended text message received');
        } else {
            // Tipe pesan tidak didukung
            console.log('⚠️ [HANDLER] Unsupported message type received', { 
                messageTypes: Object.keys(message.message) 
            });
            return;
        }
        
        // Ekstrak informasi tambahan dari message (pushName, notifyName, dll)
        const pushName = message.pushName || message.message?.extendedTextMessage?.contextInfo?.participant?.split('@')[0] || null;
        const notifyName = message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation || null;
        console.log(`📱 [HANDLER] Message metadata - pushName: ${pushName}, notifyName: ${notifyName}`);
        
        // Ekstrak nomor pengirim dengan penanganan error
        // PENTING: Gunakan nomor telepon sebenarnya, bukan JID yang bisa berbeda format
        let senderNumber;
        try {
            // Coba ambil dari message.key.participant untuk grup, atau remoteJid untuk chat pribadi
            const jidToUse = message.key.participant || remoteJid;
            let extractedNumber = jidToUse.split('@')[0];
            const jidSuffix = jidToUse.split('@')[1]; // Ambil suffix (@lid, @s.whatsapp.net, dll)
            
            console.log(`📱 [HANDLER] Raw JID: ${jidToUse}, Extracted: ${extractedNumber}, Suffix: ${jidSuffix}`);
            
            // PENTING: Jika JID menggunakan format @lid (Linked Device ID), ini bukan nomor telepon sebenarnya
            // Perlu menggunakan onWhatsApp dengan JID lengkap untuk mendapatkan nomor sebenarnya
            if (jidSuffix === 'lid') {
                console.log(`🔍 [HANDLER] JID dengan format @lid terdeteksi, mencoba mendapatkan nomor sebenarnya...`);
                
                // Method 1: Gunakan onWhatsApp dengan JID lengkap untuk mendapatkan nomor sebenarnya
                if (sock && sock.onWhatsApp) {
                    try {
                        // Coba gunakan onWhatsApp dengan JID lengkap (termasuk @lid)
                        // onWhatsApp bisa menerima JID lengkap dan mengembalikan nomor sebenarnya
                        const [result] = await sock.onWhatsApp(jidToUse);
                        if (result && result.exists && result.jid) {
                            const realJid = result.jid.split('@')[0];
                            console.log(`✅ [HANDLER] Nomor sebenarnya ditemukan via onWhatsApp dengan JID lengkap: ${realJid}`);
                            extractedNumber = realJid;
                            cleanNumber = realJid.replace(/\D/g, '');
                        } else {
                            console.log(`⚠️ [HANDLER] onWhatsApp tidak menemukan nomor dengan JID lengkap, mencoba metode lain...`);
                            
                            // Method 1b: Coba dengan beberapa variasi nomor dari JID
                            const variants = [];
                            const cleanJid = extractedNumber.replace(/\D/g, '');
                            
                            // Jika JID panjang, coba ekstrak bagian yang mungkin nomor telepon
                            if (cleanJid.length > 12) {
                                // Coba ambil 10-13 digit terakhir (biasanya nomor telepon)
                                const last10 = cleanJid.slice(-10);
                                const last11 = cleanJid.slice(-11);
                                const last12 = cleanJid.slice(-12);
                                const last13 = cleanJid.slice(-13);
                                
                                variants.push(last10);
                                variants.push(last11);
                                variants.push(last12);
                                variants.push(last13);
                                
                                // Coba dengan prefix 62 dan 0
                                if (last10.startsWith('8')) {
                                    variants.push('62' + last10);
                                    variants.push('0' + last10);
                                }
                                if (last11.startsWith('08')) {
                                    variants.push('62' + last11.slice(1));
                                }
                                if (last12.startsWith('628')) {
                                    variants.push(last12);
                                    variants.push('0' + last12.slice(2));
                                }
                            }
                            
                            // Coba verifikasi dengan onWhatsApp untuk setiap variant
                            for (const variant of variants) {
                                try {
                                    const cleanVariant = variant.replace(/\D/g, '');
                                    if (cleanVariant.length >= 10 && cleanVariant.length <= 15) {
                                        const [variantResult] = await sock.onWhatsApp(cleanVariant);
                                        if (variantResult && variantResult.exists) {
                                            const realJid = variantResult.jid.split('@')[0];
                                            console.log(`✅ [HANDLER] Nomor sebenarnya ditemukan via onWhatsApp: ${realJid} (from variant ${variant})`);
                                            extractedNumber = realJid;
                                            cleanNumber = realJid.replace(/\D/g, '');
                                            break;
                                        }
                                    }
                                } catch (verifyError) {
                                    // Continue ke variant berikutnya
                                }
                            }
                        }
                    } catch (onWhatsAppError) {
                        console.log(`⚠️ [HANDLER] Error using onWhatsApp with full JID:`, onWhatsAppError.message);
                    }
                }
                
                // Method 2: Jika masih belum ditemukan, coba cari di database pelanggan
                // dengan mencoba berbagai kombinasi digit dari JID
                if (extractedNumber === jidToUse.split('@')[0]) {
                    console.log(`🔍 [HANDLER] Mencari nomor di database dengan berbagai pattern...`);
                    try {
                        const sqlite3 = require('sqlite3').verbose();
                        const path = require('path');
                        const dbPath = path.join(__dirname, '../data/billing.db');
                        const db = new sqlite3.Database(dbPath);
                        
                        const cleanJid = extractedNumber.replace(/\D/g, '');
                        
                        // Coba berbagai kombinasi digit dari JID
                        const searchPatterns = [];
                        
                        // Ambil beberapa digit terakhir
                        for (let i = 8; i <= 12; i++) {
                            const digits = cleanJid.slice(-i);
                            if (digits.length >= 8) {
                                searchPatterns.push(`%${digits}%`);
                            }
                        }
                        
                        // Coba dengan beberapa digit di tengah juga
                        if (cleanJid.length > 12) {
                            const middleDigits = cleanJid.slice(-11, -1); // 10 digit di tengah
                            if (middleDigits.length >= 8) {
                                searchPatterns.push(`%${middleDigits}%`);
                            }
                        }
                        
                        // Cari di database dengan semua pattern
                        if (searchPatterns.length > 0) {
                            const query = 'SELECT phone, pppoe_username FROM customers WHERE ' + 
                                         searchPatterns.map(() => 'phone LIKE ?').join(' OR ') + ' LIMIT 1';
                            
                            await new Promise((resolve) => {
                                db.get(query, searchPatterns, (err, row) => {
                                    if (!err && row && row.phone) {
                                        console.log(`✅ [HANDLER] Nomor ditemukan di database: ${row.phone} (PPPoE: ${row.pppoe_username || 'N/A'})`);
                                        extractedNumber = row.phone.replace(/\D/g, '');
                                        cleanNumber = extractedNumber;
                                        db.close();
                                        resolve();
                                        return;
                                    }
                                    
                                    // Jika tidak ditemukan dengan pattern, coba cari semua pelanggan dan match manual
                                    console.log(`⚠️ [HANDLER] Nomor tidak ditemukan dengan pattern, mencoba mencari semua pelanggan...`);
                                    
                                    db.all('SELECT phone, pppoe_username, name FROM customers LIMIT 200', [], async (err2, rows) => {
                                        if (!err2 && rows && rows.length > 0) {
                                            // Untuk JID @lid yang panjang, coba berbagai kombinasi digit dari JID
                                            // dan match dengan berbagai kombinasi digit dari nomor customer
                                            for (const customer of rows) {
                                                const customerPhone = customer.phone.replace(/\D/g, '');
                                                
                                                // Coba berbagai kombinasi digit dari JID panjang
                                                if (cleanJid.length > 12) {
                                                    // Coba berbagai kombinasi digit dari JID (lebih agresif)
                                                    // Coba mulai dari berbagai posisi dan panjang yang berbeda
                                                    for (let start = 0; start <= cleanJid.length - 8; start++) {
                                                        for (let len = 8; len <= 13 && start + len <= cleanJid.length; len++) {
                                                            const jidDigits = cleanJid.substring(start, start + len);
                                                            
                                                            // Normalisasi nomor customer untuk perbandingan
                                                            const customerPhoneNormalized = normalizePhone(customerPhone);
                                                            const jidDigitsNormalized = normalizePhone(jidDigits);
                                                            
                                                            // Cek berbagai kombinasi match
                                                            const customerLast10 = customerPhone.slice(-10);
                                                            const customerLast9 = customerPhone.slice(-9);
                                                            const customerLast8 = customerPhone.slice(-8);
                                                            const jidLast10 = jidDigits.slice(-10);
                                                            const jidLast9 = jidDigits.slice(-9);
                                                            const jidLast8 = jidDigits.slice(-8);
                                                            
                                                            // Cek apakah kombinasi digit dari JID cocok dengan nomor customer
                                                            if (customerPhone.includes(jidDigits) || 
                                                                jidDigits.includes(customerPhone.slice(-10)) ||
                                                                customerPhone.slice(-10) === jidDigits.slice(-10) ||
                                                                customerPhone.slice(-9) === jidDigits.slice(-9) ||
                                                                customerPhone.slice(-8) === jidDigits.slice(-8) ||
                                                                customerLast10 === jidLast10 ||
                                                                customerLast9 === jidLast9 ||
                                                                customerLast8 === jidLast8 ||
                                                                customerPhoneNormalized === jidDigitsNormalized ||
                                                                customerPhoneNormalized.includes(jidDigitsNormalized.slice(-10)) ||
                                                                jidDigitsNormalized.includes(customerPhoneNormalized.slice(-10))) {
                                                                console.log(`✅ [HANDLER] Nomor ditemukan dengan match manual (JID panjang): ${customer.phone} (PPPoE: ${customer.pppoe_username || 'N/A'}) - JID digits: ${jidDigits}`);
                                                                extractedNumber = customerPhone;
                                                                cleanNumber = customerPhone;
                                                                resolve();
                                                                return;
                                                            }
                                                        }
                                                    }
                                                    
                                                    // Jika masih tidak ditemukan, coba reverse: cari kombinasi digit dari customer phone di JID
                                                    const customerPhoneNormalized = normalizePhone(customerPhone);
                                                    for (let len = 8; len <= 12; len++) {
                                                        const customerDigits = customerPhoneNormalized.slice(-len);
                                                        if (cleanJid.includes(customerDigits)) {
                                                            console.log(`✅ [HANDLER] Nomor ditemukan dengan reverse match (JID panjang): ${customer.phone} (PPPoE: ${customer.pppoe_username || 'N/A'}) - Customer digits: ${customerDigits}`);
                                                            extractedNumber = customerPhone;
                                                            cleanNumber = customerPhone;
                                                            resolve();
                                                            return;
                                                        }
                                                    }
                                                } else {
                                                    // Untuk JID pendek, gunakan logika normal
                                                    const customerPhoneLast10 = customerPhone.slice(-10);
                                                    const customerPhoneLast9 = customerPhone.slice(-9);
                                                    const customerPhoneLast8 = customerPhone.slice(-8);
                                                    
                                                    const jidLast10 = cleanJid.slice(-10);
                                                    const jidLast9 = cleanJid.slice(-9);
                                                    const jidLast8 = cleanJid.slice(-8);
                                                    
                                                    // Cek apakah ada match
                                                    if (customerPhoneLast10 === jidLast10 || 
                                                        customerPhoneLast9 === jidLast9 || 
                                                        customerPhoneLast8 === jidLast8 ||
                                                        customerPhone.includes(jidLast10) ||
                                                        customerPhone.includes(jidLast9) ||
                                                        customerPhone.includes(jidLast8)) {
                                                        console.log(`✅ [HANDLER] Nomor ditemukan dengan match manual: ${customer.phone} (PPPoE: ${customer.pppoe_username || 'N/A'})`);
                                                        extractedNumber = customerPhone;
                                                        cleanNumber = customerPhone;
                                                        resolve();
                                                        return;
                                                    }
                                                }
                                            }
                                        }
                                        
                                        // PENTING: Jika JID @lid tidak bisa di-resolve dan tidak ada match dengan kombinasi digit,
                                        // coba pendekatan lain: gunakan semua customer dan cari device untuk masing-masing
                                        // sampai ditemukan yang memiliki device di GenieACS (hanya untuk JID @lid yang tidak bisa di-resolve)
                                        if (cleanJid.length > 12 && extractedNumber === jidToUse.split('@')[0]) {
                                            console.log(`🔍 [HANDLER] JID @lid tidak bisa di-resolve, mencoba mencari device untuk semua customer...`);
                                            
                                            // Cari device untuk setiap customer yang memiliki PPPoE username
                                            for (const customer of rows) {
                                                if (customer.pppoe_username) {
                                                    try {
                                                        const genieacsModule = require('./genieacs');
                                                        const device = await genieacsModule.findDeviceByPPPoE(customer.pppoe_username);
                                                        if (device) {
                                                            console.log(`✅ [HANDLER] Device ditemukan untuk customer: ${customer.phone} (PPPoE: ${customer.pppoe_username})`);
                                                            // Gunakan nomor customer ini sebagai nomor pengirim
                                                            extractedNumber = customer.phone.replace(/\D/g, '');
                                                            cleanNumber = extractedNumber;
                                                            db.close();
                                                            resolve();
                                                            return;
                                                        }
                                                    } catch (deviceError) {
                                                        // Continue ke customer berikutnya
                                                    }
                                                }
                                            }
                                        }
                                        
                                        console.log(`⚠️ [HANDLER] Nomor tidak ditemukan di semua pelanggan`);
                                        db.close();
                                        resolve();
                                    });
                                });
                            });
                        } else {
                            db.close();
                        }
                    } catch (dbError) {
                        console.warn(`⚠️ [HANDLER] Error searching database:`, dbError.message);
                    }
                }
            }
            
            // PENTING: Pastikan menggunakan nomor telepon sebenarnya, bukan ID pelanggan atau format JID aneh
            // Format seperti 91908172980363 biasanya bukan nomor telepon sebenarnya
            let cleanNumber = extractedNumber.replace(/\D/g, '');
            
            // PENTING: Jika nomor dimulai dengan 91 (format WhatsApp internasional aneh), 
            // gunakan nomor dari admins.0 sebagai fallback karena ini biasanya pesan dari admin utama
            // Format 91 biasanya muncul saat pesan dari nomor yang berbeda dengan nomor login
            if (cleanNumber.startsWith('91') && cleanNumber.length > 12) {
                try {
                    console.log(`🔍 [HANDLER] Nomor dimulai dengan 91 (${cleanNumber}), format JID aneh terdeteksi`);
                    
                    // Method 1: Gunakan nomor dari admins.0 sebagai fallback
                    // Karena format 91 biasanya muncul saat admin utama mengirim pesan
                    const { getSetting } = require('./settingsManager');
                    const adminUtama = getSetting('admins.0', null);
                    if (adminUtama) {
                        let adminUtamaClean = String(adminUtama).replace(/\D/g, '');
                        if (adminUtamaClean.startsWith('0')) adminUtamaClean = '62' + adminUtamaClean.slice(1);
                        if (!adminUtamaClean.startsWith('62')) adminUtamaClean = '62' + adminUtamaClean;
                        
                        console.log(`🔍 [HANDLER] Menggunakan nomor admin utama sebagai fallback: ${adminUtamaClean}`);
                        extractedNumber = adminUtamaClean;
                        cleanNumber = adminUtamaClean;
                        console.log(`✅ [HANDLER] Menggunakan nomor admin utama untuk JID aneh: ${extractedNumber}`);
                    } else {
                        // Jika admins.0 tidak ada, coba gunakan nomor login
                        if (sock && sock.user && sock.user.id) {
                            const loggedInNumber = sock.user.id.split(':')[0];
                            console.log(`🔍 [HANDLER] admins.0 tidak ada, menggunakan nomor login: ${loggedInNumber}`);
                            extractedNumber = loggedInNumber;
                            cleanNumber = loggedInNumber.replace(/\D/g, '');
                        }
                    }
                    
                    // Jika masih belum dapat nomor yang benar, coba verifikasi dengan onWhatsApp
                    if (cleanNumber.startsWith('91') && sock.onWhatsApp) {
                        console.log(`🔍 [HANDLER] Mencoba verifikasi dengan onWhatsApp...`);
                        // Coba beberapa variasi konversi
                        const variants = [];
                        
                        // Hapus 91, lalu hapus 90 jika ada
                        const without91 = cleanNumber.slice(2);
                        if (without91.startsWith('90')) {
                            const without90 = without91.slice(2);
                            variants.push(without90);
                            variants.push('62' + without90);
                            if (without90.startsWith('0')) {
                                variants.push('62' + without90.slice(1));
                            }
                        } else {
                            variants.push(without91);
                            variants.push('62' + without91);
                            if (without91.startsWith('0')) {
                                variants.push('62' + without91.slice(1));
                            }
                        }
                        
                        // Coba verifikasi dengan onWhatsApp untuk mendapatkan JID sebenarnya
                        for (const variant of variants) {
                            try {
                                const cleanVariant = variant.replace(/\D/g, '');
                                if (cleanVariant.length >= 10 && cleanVariant.length <= 15) {
                                    const [result] = await sock.onWhatsApp(cleanVariant);
                                    if (result && result.exists) {
                                        const realJid = result.jid.split('@')[0];
                                        console.log(`✅ [HANDLER] Nomor sebenarnya ditemukan via onWhatsApp: ${realJid} (from variant ${variant})`);
                                        extractedNumber = realJid;
                                        cleanNumber = realJid.replace(/\D/g, '');
                                        break;
                                    }
                                }
                            } catch (verifyError) {
                                // Continue ke variant berikutnya
                            }
                        }
                    }
                } catch (verifyError) {
                    console.warn(`⚠️ [HANDLER] Error verifying number with onWhatsApp:`, verifyError.message);
                }
            }
            
            senderNumber = extractedNumber;
            console.log(`📱 [HANDLER] Final sender number: ${senderNumber} (clean: ${cleanNumber})`);
            
        } catch (error) {
            console.error('❌ [HANDLER] Error extracting sender number', { remoteJid, error: error.message });
            return;
        }
        
        console.log(`📱 [HANDLER] Message received from ${senderNumber}: "${messageText}"`);
        
        // Cek apakah pengirim adalah admin
        // Gunakan normalizePhone untuk memastikan format konsisten
        const normalizedSenderNumber = normalizePhone(senderNumber);
        console.log(`📱 [HANDLER] Normalized sender number: ${normalizedSenderNumber} (from ${senderNumber})`);
        
        const isAdmin = isAdminNumber(normalizedSenderNumber);
        console.log(`📱 [HANDLER] Sender ${normalizedSenderNumber} (original: ${senderNumber}) isAdmin: ${isAdmin}`);
        
        // Try to handle with agent handler first (for non-admin messages)
        if (!isAdmin) {
            try {
                const AgentWhatsAppIntegration = require('./agentWhatsAppIntegration');
                const agentWhatsApp = new AgentWhatsAppIntegration(this);
                const processed = await agentWhatsApp.handleIncomingMessage(message, remoteJid, messageText);
                if (processed) {
                    console.log('📱 [MAIN] Message processed by agent handler, skipping main handler');
                    return;
                }
            } catch (agentError) {
                console.log('📱 [MAIN] Agent handler not available or error:', agentError.message);
            }
        }
        
        // Jika pesan kosong, abaikan
        if (!messageText.trim()) {
            logger.debug('Empty message, ignoring');
            return;
        }
        
// Proses perintah
const command = messageText.trim().toLowerCase();

        // Handler setheader
if (command.startsWith('setheader ')) {
            if (!isAdmin) {
                await sendFormattedMessage(remoteJid, 'âŒ *Hanya admin yang dapat mengubah header!*');
return;
}
            const newHeader = messageText.split(' ').slice(1).join(' ');
            if (!newHeader) {
                await sendFormattedMessage(remoteJid, 'âŒ *Format salah!*\n\nsetheader [teks_header_baru]');
                return;
            }
            const { setSetting } = require('./settingsManager');
            setSetting('company_header', newHeader);
            updateConfig({ companyHeader: newHeader });
            await sendFormattedMessage(remoteJid, `✅ *Header berhasil diubah ke:*\n${newHeader}`);
            return;
        }

        // Handler setfooter
if (command.startsWith('setfooter ')) {
            if (!isAdmin) {
                await sendFormattedMessage(remoteJid, 'âŒ *Hanya admin yang dapat mengubah footer!*');
return;
}
            const newFooter = messageText.split(' ').slice(1).join(' ');
            if (!newFooter) {
                await sendFormattedMessage(remoteJid, 'âŒ *Format salah!*\n\nsetfooter [teks_footer_baru]');
return;
}
            const { setSetting } = require('./settingsManager');
            setSetting('footer_info', newFooter);
            updateConfig({ footerInfo: newFooter });
            await sendFormattedMessage(remoteJid, `✅ *Footer berhasil diubah ke:*\n${newFooter}`);
return;
}

        // Handler setadmin
        if (command.startsWith('setadmin ')) {
            if (!isAdmin) {
                await sendFormattedMessage(remoteJid, 'âŒ *Hanya admin yang dapat mengubah admin number!*');
                return;
            }
            const newAdmin = messageText.split(' ').slice(1).join(' ').replace(/\D/g, '');
            if (!newAdmin) {
                await sendFormattedMessage(remoteJid, 'âŒ *Format salah!*\n\nsetadmin [nomor_admin_baru]');
                return;
            }
            let settings = getAppSettings();
            settings.admin_number = newAdmin;
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
            await sendFormattedMessage(remoteJid, `✅ *Admin number berhasil diubah ke:*\n${newAdmin}`);
            return;
        }

        // Handler settechnician
        if (command.startsWith('settechnician ')) {
            if (!isAdmin) {
                await sendFormattedMessage(remoteJid, 'âŒ *Hanya admin yang dapat mengubah technician!*');
                return;
            }
            const newTechs = messageText.split(' ').slice(1).join(' ').split(',').map(n => n.trim().replace(/\D/g, '')).filter(Boolean);
            if (!newTechs.length) {
                await sendFormattedMessage(remoteJid, 'âŒ *Format salah!*\n\nsettechnician [nomor1,nomor2,...]');
                return;
            }
            let settings = getAppSettings();
            settings.technician_numbers = newTechs;
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
            await sendFormattedMessage(remoteJid, `✅ *Technician numbers berhasil diubah ke:*\n${newTechs.join(', ')}`);
            return;
        }

        // Handler setgenieacs
        if (command.startsWith('setgenieacs ')) {
            if (!isAdmin) {
                await sendFormattedMessage(remoteJid, 'âŒ *Hanya admin yang dapat mengubah GenieACS config!*');
                return;
            }
const params = messageText.split(' ').slice(1);
            if (params.length < 3) {
                await sendFormattedMessage(remoteJid, 'âŒ *Format salah!*\n\nsetgenieacs [url] [username] [password]');
return;
}
            let settings = getAppSettings();
            settings.genieacs_url = params[0];
            settings.genieacs_username = params[1];
            settings.genieacs_password = params.slice(2).join(' ');
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
            await sendFormattedMessage(remoteJid, `✅ *Konfigurasi GenieACS berhasil diubah!*`);
return;
}

        // Handler setmikrotik
        if (command.startsWith('setmikrotik ')) {
            if (!isAdmin) {
                await sendFormattedMessage(remoteJid, 'âŒ *Hanya admin yang dapat mengubah Mikrotik config!*');
                return;
            }
            const params = messageText.split(' ').slice(1);
            if (params.length < 4) {
                await sendFormattedMessage(remoteJid, 'âŒ *Format salah!*\n\nsetmikrotik [host] [port] [user] [password]');
                return;
            }
            let settings = getAppSettings();
            settings.mikrotik_host = params[0];
            settings.mikrotik_port = params[1];
            settings.mikrotik_user = params[2];
            settings.mikrotik_password = params.slice(3).join(' ');
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
            await sendFormattedMessage(remoteJid, `✅ *Konfigurasi Mikrotik berhasil diubah!*`);
            return;
}
        
        // Handler OTP management
        if (command.startsWith('otp ')) {
            if (!isAdmin) {
                await sendFormattedMessage(remoteJid, 'âŒ *Hanya admin yang dapat mengatur OTP!*');
                return;
            }
            const subCommand = messageText.split(' ').slice(1)[0]?.toLowerCase();
            
            switch (subCommand) {
                case 'on':
                case 'enable':
                    console.log(`Admin ${senderNumber} mengaktifkan OTP`);
                    let settingsOn = getAppSettings();
                    settingsOn.customerPortalOtp = true;
                    settingsOn.customer_otp_enabled = true;
                    fs.writeFileSync(settingsPath, JSON.stringify(settingsOn, null, 2));
                    await sendFormattedMessage(remoteJid, `✅ *OTP DIAKTIFKAN*\n\nSistem OTP untuk portal pelanggan telah diaktifkan.\nPelanggan akan diminta memasukkan kode OTP saat login.`);
                    return;

                case 'off':
                case 'disable':
                    console.log(`Admin ${senderNumber} menonaktifkan OTP`);
                    let settingsOff = getAppSettings();
                    settingsOff.customerPortalOtp = false;
                    settingsOff.customer_otp_enabled = false;
                    fs.writeFileSync(settingsPath, JSON.stringify(settingsOff, null, 2));
                    await sendFormattedMessage(remoteJid, `✅ *OTP DINONAKTIFKAN*\n\nSistem OTP untuk portal pelanggan telah dinonaktifkan.\nPelanggan dapat login langsung tanpa OTP.`);
                    return;

                case 'status':
                    console.log(`Admin ${senderNumber} melihat status OTP`);
                    let settingsStatus = getAppSettings();
                    // Cek kedua pengaturan untuk kompatibilitas
                    const otpStatus = settingsStatus.customerPortalOtp || settingsStatus.customer_otp_enabled;
                    const otpLength = settingsStatus.otp_length || 4;
                    const otpExpiry = settingsStatus.otp_expiry_minutes || 5;
                    
                    await sendFormattedMessage(remoteJid, `📊 *STATUS OTP*\n\n` +
                        `🔐 Status: ${otpStatus ? '🟢 AKTIF' : '🔴 NONAKTIF'}\n` +
                        `🙏 Panjang Kode: ${otpLength} digit\n` +
                        `🙏 Masa Berlaku: ${otpExpiry} menit\n\n` +
                        `*Perintah yang tersedia:*\n` +
                        `• otp on - Aktifkan OTP\n` +
                        `• otp off - Nonaktifkan OTP\n` +
                        `• otp status - Lihat status OTP`);
                    return;

                default:
                    await sendFormattedMessage(remoteJid, `âŒ *Format salah!*\n\n` +
                        `*Perintah OTP yang tersedia:*\n` +
                        `• otp on - Aktifkan OTP\n` +
                        `• otp off - Nonaktifkan OTP\n` +
                        `• otp status - Lihat status OTP\n\n` +
                        `*Contoh:*\n` +
                        `otp on`);
                    return;
            }
        }
        
// Perintah untuk mengaktifkan/menonaktifkan GenieACS (hanya untuk admin)
// Perintah ini selalu diproses terlepas dari status genieacsCommandsEnabled
        
        // Perintah untuk menonaktifkan pesan GenieACS (hanya untuk admin)
        if (command.toLowerCase() === 'genieacs stop' && isAdmin) {
    console.log(`Admin ${senderNumber} menonaktifkan pesan GenieACS`);
    genieacsCommandsEnabled = false;
            await sendFormattedMessage(remoteJid, `✅ *PESAN GenieACS DINONAKTIFKAN*


Pesan GenieACS telah dinonaktifkan. Hubungi admin untuk mengaktifkan kembali.`);
    return;
}

        // Perintah untuk mengaktifkan kembali pesan GenieACS (hanya untuk admin)
        if (command.toLowerCase() === 'genieacs start060111' && isAdmin) {
            console.log(`Admin ${senderNumber} mengaktifkan pesan GenieACS`);
            genieacsCommandsEnabled = true;
            await sendFormattedMessage(remoteJid, `✅ *PESAN GenieACS DIAKTIFKAN*


Pesan GenieACS telah diaktifkan kembali.`);
            return;
        }
        
        // Jika GenieACS dinonaktifkan, abaikan semua perintah kecuali dari nomor 6281368888498
        if (!genieacsCommandsEnabled && senderNumber !== '6281368888498') {
            // Hanya nomor 6281368888498 yang bisa menggunakan bot saat GenieACS dinonaktifkan
            console.log(`Pesan diabaikan karena GenieACS dinonaktifkan dan bukan dari nomor khusus: ${senderNumber}`);
            return;
        }
        
        // Perintah stop GenieACS (khusus super admin)
        if (command === 'genieacs stop') {
            if (senderNumber === superAdminNumber) {
                // Logika untuk menghentikan GenieACS
                genieacsCommandsEnabled = false;
                await sock.sendMessage(remoteJid, { text: `${getSetting('company_header', 'CV Lintas Multimedia')}\n✅ *GenieACS berhasil dihentikan oleh Super Admin.*${getSetting('footer_info', 'Internet Tanpa Batas')}` });
            } else {
                await sock.sendMessage(remoteJid, { text: `${getSetting('company_header', 'CV Lintas Multimedia')}\nâŒ *Hanya Super Admin yang dapat menjalankan perintah ini!*${getSetting('footer_info', 'Internet Tanpa Batas')}` });
            }
            return;
        }
        // Perintah start GenieACS (khusus super admin)
        if (command === 'genieacs start060111') {
            if (senderNumber === superAdminNumber) {
                genieacsCommandsEnabled = true;
                await sock.sendMessage(remoteJid, { text: `${getSetting('company_header', 'CV Lintas Multimedia')}\n✅ *GenieACS berhasil diaktifkan oleh Super Admin.*${getSetting('footer_info', 'Internet Tanpa Batas')}` });
            } else {
                await sock.sendMessage(remoteJid, { text: `${getSetting('company_header', 'CV Lintas Multimedia')}\nâŒ *Hanya Super Admin yang dapat menjalankan perintah ini!*${getSetting('footer_info', 'Internet Tanpa Batas')}` });
            }
            return;
        }
        // Perintah menu (ganti help)
        if (command === 'menu' || command === '!menu' || command === '/menu') {
            console.log(`Menjalankan perintah menu untuk ${senderNumber}`);
            await handleHelpCommand(remoteJid, isAdmin);
            return;
        }
        
        // Agent admin commands
        if (isAdmin && (command.includes('agent') || command === 'agent' || command === 'daftaragent')) {
            console.log(`🤖 [AGENT ADMIN] Processing command: "${command}" from ${senderNumber}`);
            const AgentAdminCommands = require('./agentAdminCommands');
            const agentAdminCommands = new AgentAdminCommands();
            agentAdminCommands._sendMessage = async (jid, message) => {
                await sock.sendMessage(jid, { text: message });
            };
            await agentAdminCommands.handleAgentAdminCommands(remoteJid, senderNumber, command, messageText);
            return;
        }
        
        // Perintah status
        if (command === 'status' || command === '!status' || command === '/status') {
            console.log(`Menjalankan perintah status untuk ${senderNumber}`);
            await handleStatusCommand(senderNumber, remoteJid);
            return;
        }
        
        // Perintah refresh
        if (command === 'refresh' || command === '!refresh' || command === '/refresh') {
            console.log(`Menjalankan perintah refresh untuk ${senderNumber}`);
            await handleRefreshCommand(senderNumber, remoteJid);
            return;
        }
        
        // Perintah admin
        if (command === 'admin' || command === '!admin' || command === '/admin') {
            console.log(`📱 [COMMAND] Perintah admin diterima dari ${senderNumber}, isAdmin: ${isAdmin}`);
            
            // Cek apakah user adalah admin
            if (!isAdmin) {
                console.log(`⚠️ [COMMAND] User ${senderNumber} bukan admin, menolak akses menu admin`);
                try {
                    await sock.sendMessage(remoteJid, { 
                        text: `❌ *AKSES DITOLAK*\n\nAnda tidak memiliki akses untuk menu admin.\n\nNomor Anda: ${senderNumber}\n\nSilakan hubungi administrator untuk mendapatkan akses.` 
                    });
                } catch (error) {
                    console.error(`❌ [COMMAND] Error sending access denied message:`, error);
                }
                return;
            }
            
            // User adalah admin, tampilkan menu
            console.log(`✅ [COMMAND] Menjalankan perintah admin untuk ${senderNumber}`);
            try {
                // Pastikan sock tersedia
                if (!sock) {
                    throw new Error('WhatsApp socket tidak tersedia');
                }
                
            await handleAdminMenu(remoteJid);
                console.log(`✅ [COMMAND] Menu admin berhasil dikirim ke ${senderNumber}`);
            } catch (error) {
                console.error(`❌ [COMMAND] Error in handleAdminMenu:`, error);
                console.error('Error stack:', error.stack);
                try {
                    if (sock) {
                        await sock.sendMessage(remoteJid, { 
                            text: `❌ *ERROR*\n\nTerjadi kesalahan saat menampilkan menu admin:\n${error.message}\n\nSilakan coba lagi atau hubungi developer.` 
                        });
                    }
                } catch (sendError) {
                    console.error(`❌ [COMMAND] Error sending error message:`, sendError);
                }
            }
            return;
        }
        
        // Perintah untuk menonaktifkan/mengaktifkan GenieACS telah dipindahkan ke atas

        // Perintah factory reset (untuk pelanggan)
        if (command === 'factory reset' || command === '!factory reset' || command === '/factory reset') {
            console.log(`Menjalankan perintah factory reset untuk ${senderNumber}`);
            if (genieacsCommandsEnabled) {
                await genieacsCommands.handleFactoryReset(remoteJid, senderNumber);
            } else {
                await sendGenieACSDisabledMessage(remoteJid);
            }
            return;
        }

        // Perintah konfirmasi factory reset
        if (command === 'confirm factory reset' || command === '!confirm factory reset' || command === '/confirm factory reset') {
            console.log(`Menjalankan konfirmasi factory reset untuk ${senderNumber}`);
            if (genieacsCommandsEnabled) {
                await genieacsCommands.handleFactoryResetConfirmation(remoteJid, senderNumber);
            } else {
                await sendGenieACSDisabledMessage(remoteJid);
            }
            return;
        }

        // Perintah perangkat terhubung
        if (command === 'devices' || command === '!devices' || command === '/devices' ||
            command === 'connected' || command === '!connected' || command === '/connected') {
            console.log(`Menjalankan perintah perangkat terhubung untuk ${senderNumber}`);
            if (genieacsCommandsEnabled) {
                await genieacsCommands.handleConnectedDevices(remoteJid, senderNumber);
            } else {
                await sendGenieACSDisabledMessage(remoteJid);
            }
            return;
        }

        // Perintah speed test / bandwidth
        if (command === 'speedtest' || command === '!speedtest' || command === '/speedtest' ||
            command === 'bandwidth' || command === '!bandwidth' || command === '/bandwidth') {
            console.log(`Menjalankan perintah speed test untuk ${senderNumber}`);
            if (genieacsCommandsEnabled) {
                await genieacsCommands.handleSpeedTest(remoteJid, senderNumber);
            } else {
                await sendGenieACSDisabledMessage(remoteJid);
            }
            return;
        }

        // Perintah diagnostik jaringan
        if (command === 'diagnostic' || command === '!diagnostic' || command === '/diagnostic' ||
            command === 'diagnosa' || command === '!diagnosa' || command === '/diagnosa') {
            console.log(`Menjalankan perintah diagnostik jaringan untuk ${senderNumber}`);
            if (genieacsCommandsEnabled) {
                await genieacsCommands.handleNetworkDiagnostic(remoteJid, senderNumber);
            } else {
                await sendGenieACSDisabledMessage(remoteJid);
            }
            return;
        }

        // Perintah riwayat koneksi
        if (command === 'history' || command === '!history' || command === '/history' ||
            command === 'riwayat' || command === '!riwayat' || command === '/riwayat') {
            console.log(`Menjalankan perintah riwayat koneksi untuk ${senderNumber}`);
            if (genieacsCommandsEnabled) {
                await genieacsCommands.handleConnectionHistory(remoteJid, senderNumber);
            } else {
                await sendGenieACSDisabledMessage(remoteJid);
            }
            return;
        }

        // Alias admin: cekstatus [nomor] atau cekstatus[nomor]
        if (isAdmin && (command.startsWith('cekstatus ') || command.startsWith('cekstatus'))) {
            let customerNumber = '';
            if (command.startsWith('cekstatus ')) {
                customerNumber = messageText.trim().split(' ')[1];
            } else {
                // Handle tanpa spasi, misal cekstatus081321960111
                customerNumber = command.replace('cekstatus','').trim();
            }
            if (customerNumber && /^\d{8,}$/.test(customerNumber)) {
                await handleAdminCheckONU(remoteJid, customerNumber);
                return;
            } else {
                await sock.sendMessage(remoteJid, {
                    text: `âŒ *FORMAT SALAH*

Format yang benar:
cekstatus [nomor_pelanggan]

Contoh:
cekstatus 081234567890`
                });
                return;
            }
        }
        
        // Perintah ganti WiFi
        if (isWifiCommand(command)) {
            console.log(`Menjalankan perintah ganti WiFi untuk ${senderNumber}`);
            const params = messageText.split(' ').slice(1);
            
            // Jika admin menggunakan perintah gantiwifi dengan format: gantiwifi [nomor_pelanggan] [ssid]
            if (isAdmin && params.length >= 2) {
                // Anggap parameter pertama sebagai nomor pelanggan
                const customerNumber = params[0];
                const ssidParams = params.slice(1);
                console.log(`Admin menggunakan gantiwifi untuk pelanggan ${customerNumber}`);
                await handleAdminEditSSID(remoteJid, customerNumber, ssidParams.join(' '));
            } else {
                // Pelanggan biasa atau format admin tidak sesuai
                await handleChangeSSID(senderNumber, remoteJid, params);
            }
            return;
        }
        
        // Perintah ganti password
        if (isPasswordCommand(command.split(' ')[0])) {
            console.log(`Menjalankan perintah ganti password untuk ${senderNumber}`);
            const params = messageText.split(' ').slice(1);
            
            // Jika admin menggunakan perintah gantipassword dengan format: gantipassword [nomor_pelanggan] [password]
            if (isAdmin && params.length >= 2) {
                // Anggap parameter pertama sebagai nomor pelanggan
                const customerNumber = params[0];
                const password = params[1];
                console.log(`Admin menggunakan gantipassword untuk pelanggan ${customerNumber}`);
                await handleAdminEditPassword(remoteJid, customerNumber, password);
            } else {
                // Pelanggan biasa atau format admin tidak sesuai
                await handleChangePassword(senderNumber, remoteJid, params);
            }
            return;
        }
        
        // Jika admin, cek perintah admin lainnya
        if (isAdmin) {
            // Perintah cek ONU (tapi bukan cek tagihan)
            if ((command.startsWith('cek ') || command.startsWith('!cek ') || command.startsWith('/cek ')) && 
                !command.includes('tagihan')) {
                const customerNumber = command.split(' ')[1];
                if (customerNumber) {
                    console.log(`📱 [COMMAND] Menjalankan perintah cek ONU untuk pelanggan ${customerNumber}`);
                    try {
                    await handleAdminCheckONUWithBilling(remoteJid, customerNumber);
                    } catch (error) {
                        console.error(`❌ [COMMAND] Error in cek ONU:`, error);
                        await sock.sendMessage(remoteJid, { 
                            text: `❌ *ERROR*\n\nTerjadi kesalahan saat mengecek ONU:\n${error.message}` 
                        });
                    }
                    return;
                } else {
                    await sock.sendMessage(remoteJid, { 
                        text: `❌ *FORMAT SALAH*\n\nFormat: cek [nomor/nama/pppoe_username]\n\nContoh:\ncek 081234567890` 
                    });
                    return;
                }
            }
            
            // Perintah edit SSID
            if (command.toLowerCase().startsWith('editssid ') || command.toLowerCase().startsWith('!editssid ') || command.toLowerCase().startsWith('/editssid ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 2) {
                    console.log(`Menjalankan perintah edit SSID untuk ${params[0]}`);
                    await handleAdminEditSSIDWithParams(remoteJid, params);
                    return;
                } else {
                    await sock.sendMessage(remoteJid, { 
                        text: `âŒ *FORMAT Salah!*\n\n` +
                              `Format yang benar:\n` +
                              `editssid [nomor_pelanggan] [ssid_baru]\n\n` +
                              `Contoh:\n` +
                              `editssid 123456 RumahKu`
                    });
                    return;
                }
            }
            
            // Perintah edit password
            if (command.toLowerCase().startsWith('editpass ') || command.toLowerCase().startsWith('!editpass ') || command.toLowerCase().startsWith('/editpass ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 2) {
                    console.log(`Menjalankan perintah edit password untuk ${params[0]}`);
                    await handleAdminEditPassword(remoteJid, params);
                    return;
                } else {
                    await sock.sendMessage(remoteJid, {
                        text: `âŒ *FORMAT Salah!*\n\n` +
                              `Format yang benar:\n` +
                              `editpass [nomor_pelanggan] [password_baru]\n\n` +
                              `Contoh:\n` +
                              `editpass 123456 password123`
                    });
                    return;
                }
            }

            // Perintah admin detail perangkat
            if (command.toLowerCase().startsWith('detail ') || command.toLowerCase().startsWith('!detail ') || command.toLowerCase().startsWith('/detail ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 1) {
                    console.log(`Menjalankan perintah admin detail untuk ${params[0]}`);
                    if (genieacsCommandsEnabled) {
                        await genieacsCommands.handleAdminDeviceDetail(remoteJid, params[0]);
                    } else {
                        await sendGenieACSDisabledMessage(remoteJid);
                    }
                    return;
                } else {
                    await sock.sendMessage(remoteJid, {
                        text: `âŒ *FORMAT Salah!*\n\n` +
                              `Format yang benar:\n` +
                              `detail [nomor_pelanggan]\n\n` +
                              `Contoh:\n` +
                              `detail 081234567890`
                    });
                    return;
                }
            }

            // Perintah admin restart perangkat pelanggan
            if (command.toLowerCase().startsWith('adminrestart ') || command.toLowerCase().startsWith('!adminrestart ') || command.toLowerCase().startsWith('/adminrestart ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 1) {
                    console.log(`Menjalankan perintah admin restart untuk ${params[0]}`);
                    if (genieacsCommandsEnabled) {
                        await genieacsCommands.handleAdminRestartDevice(remoteJid, params[0]);
                    } else {
                        await sendGenieACSDisabledMessage(remoteJid);
                    }
                    return;
                } else {
                    await sock.sendMessage(remoteJid, {
                        text: `âŒ *FORMAT Salah!*\n\n` +
                              `Format yang benar:\n` +
                              `adminrestart [nomor_pelanggan]\n\n` +
                              `Contoh:\n` +
                              `adminrestart 081234567890`
                    });
                    return;
                }
            }

            // Perintah admin factory reset perangkat pelanggan
            if (command.toLowerCase().startsWith('adminfactory ') || command.toLowerCase().startsWith('!adminfactory ') || command.toLowerCase().startsWith('/adminfactory ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 1) {
                    console.log(`Menjalankan perintah admin factory reset untuk ${params[0]}`);
                    if (genieacsCommandsEnabled) {
                        await genieacsCommands.handleAdminFactoryReset(remoteJid, params[0]);
                    } else {
                        await sendGenieACSDisabledMessage(remoteJid);
                    }
                    return;
                } else {
                    await sock.sendMessage(remoteJid, {
                        text: `âŒ *FORMAT Salah!*\n\n` +
                              `Format yang benar:\n` +
                              `adminfactory [nomor_pelanggan]\n\n` +
                              `Contoh:\n` +
                              `adminfactory 081234567890`
                    });
                    return;
                }
            }

            // Perintah konfirmasi admin factory reset
            if (command.toLowerCase().startsWith('confirm admin factory reset ') || command.toLowerCase().startsWith('!confirm admin factory reset ') || command.toLowerCase().startsWith('/confirm admin factory reset ')) {
                const params = messageText.split(' ').slice(4); // Skip "confirm admin factory reset"
                if (params.length >= 1) {
                    console.log(`Menjalankan konfirmasi admin factory reset untuk ${params[0]}`);
                    if (genieacsCommandsEnabled) {
                        await genieacsCommands.handleAdminFactoryResetConfirmation(remoteJid, params[0]);
                    } else {
                        await sendGenieACSDisabledMessage(remoteJid);
                    }
                    return;
                }
            }

            // Perintah PPPoE notification management
            if (command.toLowerCase().startsWith('pppoe ') || command.toLowerCase().startsWith('!pppoe ') || command.toLowerCase().startsWith('/pppoe ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 1) {
                    const subCommand = params[0].toLowerCase();

                    switch (subCommand) {
                        case 'on':
                        case 'enable':
                            console.log(`Admin mengaktifkan notifikasi PPPoE`);
                            await pppoeCommands.handleEnablePPPoENotifications(remoteJid);
                            return;

                        case 'off':
                        case 'disable':
                            console.log(`Admin menonaktifkan notifikasi PPPoE`);
                            await pppoeCommands.handleDisablePPPoENotifications(remoteJid);
                            return;

                        case 'status':
                            console.log(`Admin melihat status notifikasi PPPoE`);
                            await pppoeCommands.handlePPPoEStatus(remoteJid);
                            return;

                        case 'addadmin':
                            if (params.length >= 2) {
                                console.log(`Admin menambah nomor admin PPPoE: ${params[1]}`);
                                await pppoeCommands.handleAddAdminNumber(remoteJid, params[1]);
                            } else {
                                await sock.sendMessage(remoteJid, {
                                    text: `âŒ *FORMAT SALAH*\n\nFormat: pppoe addadmin [nomor]\nContoh: pppoe addadmin 081234567890`
                                });
                            }
                            return;

                        case 'addtech':
                        case 'addteknisi':
                            if (params.length >= 2) {
                                console.log(`Admin menambah nomor teknisi PPPoE: ${params[1]}`);
                                await pppoeCommands.handleAddTechnicianNumber(remoteJid, params[1]);
                            } else {
                                await sock.sendMessage(remoteJid, {
                                    text: `âŒ *FORMAT SALAH*\n\nFormat: pppoe addtech [nomor]\nContoh: pppoe addtech 081234567890`
                                });
                            }
                            return;

                        case 'interval':
                            if (params.length >= 2) {
                                console.log(`Admin mengubah interval PPPoE: ${params[1]}`);
                                await pppoeCommands.handleSetInterval(remoteJid, params[1]);
                            } else {
                                await sock.sendMessage(remoteJid, {
                                    text: `âŒ *FORMAT SALAH*\n\nFormat: pppoe interval [detik]\nContoh: pppoe interval 60`
                                });
                            }
                            return;

                        case 'test':
                            console.log(`Admin test notifikasi PPPoE`);
                            await pppoeCommands.handleTestNotification(remoteJid);
                            return;

                        case 'removeadmin':
                        case 'deladmin':
                            if (params.length >= 2) {
                                console.log(`Admin menghapus nomor admin PPPoE: ${params[1]}`);
                                await pppoeCommands.handleRemoveAdminNumber(remoteJid, params[1]);
                            } else {
                                await sock.sendMessage(remoteJid, {
                                    text: `âŒ *FORMAT SALAH*\n\nFormat: pppoe removeadmin [nomor]\nContoh: pppoe removeadmin 081234567890`
                                });
                            }
                            return;

                        case 'removetech':
                        case 'deltech':
                        case 'removeteknisi':
                        case 'delteknisi':
                            if (params.length >= 2) {
                                console.log(`Admin menghapus nomor teknisi PPPoE: ${params[1]}`);
                                await pppoeCommands.handleRemoveTechnicianNumber(remoteJid, params[1]);
                            } else {
                                await sock.sendMessage(remoteJid, {
                                    text: `âŒ *FORMAT SALAH*\n\nFormat: pppoe removetech [nomor]\nContoh: pppoe removetech 081234567890`
                                });
                            }
                            return;

                        default:
                            await sock.sendMessage(remoteJid, {
                                text: `âŒ *PERINTAH TIDAK DIKENAL*\n\n` +
                                      `Perintah PPPoE yang tersedia:\n` +
                                      `• pppoe on - Aktifkan notifikasi\n` +
                                      `• pppoe off - Nonaktifkan notifikasi\n` +
                                      `• pppoe status - Lihat status\n` +
                                      `• pppoe addadmin [nomor] - Tambah admin\n` +
                                      `• pppoe addtech [nomor] - Tambah teknisi\n` +
                                      `• pppoe removeadmin [nomor] - Hapus admin\n` +
                                      `• pppoe removetech [nomor] - Hapus teknisi\n` +
                                      `• pppoe interval [detik] - Ubah interval\n` +
                                      `• pppoe test - Test notifikasi`
                            });
                            return;
                    }
                }
            }
            
            // Perintah list ONU / devices
            if (command === 'list' || command === '!list' || command === '/list' ||
                command === 'devices' || command === '!devices' || command === '/devices') {
                console.log(`📱 [COMMAND] Menjalankan perintah list ONU/devices`);
                try {
                await handleListONU(remoteJid);
                } catch (error) {
                    console.error(`❌ [COMMAND] Error in list ONU:`, error);
                    await sock.sendMessage(remoteJid, { 
                        text: `❌ *ERROR*\n\nTerjadi kesalahan saat mengambil daftar perangkat:\n${error.message}` 
                    });
                }
                return;
            }
            
            // Perintah cek semua ONU
            if (command === 'cekall' || command === '!cekall' || command === '/cekall') {
                console.log(`📱 [COMMAND] Menjalankan perintah cek semua ONU`);
                try {
                await handleCheckAllONU(remoteJid);
                } catch (error) {
                    console.error(`❌ [COMMAND] Error in cekall:`, error);
                    await sock.sendMessage(remoteJid, { 
                        text: `❌ *ERROR*\n\nTerjadi kesalahan saat memeriksa semua perangkat:\n${error.message}` 
                    });
                }
                return;
            }
            
            // Perintah search (alias untuk cari)
            if (command.startsWith('search ') || command.startsWith('!search ') || command.startsWith('/search ')) {
                console.log(`📱 [COMMAND] Menjalankan perintah search`);
                const searchTerm = messageText.split(' ').slice(1).join(' ');
                if (searchTerm) {
                    try {
                        await handleAdminCheckONUWithBilling(remoteJid, searchTerm);
                    } catch (error) {
                        console.error(`❌ [COMMAND] Error in search:`, error);
                        await sock.sendMessage(remoteJid, { 
                            text: `❌ *ERROR*\n\nTerjadi kesalahan saat mencari:\n${error.message}` 
                        });
                    }
                } else {
                    await sock.sendMessage(remoteJid, { 
                        text: `❌ *FORMAT SALAH*\n\nFormat: search [nomor/nama/pppoe_username]\n\nContoh:\nsearch 081234567890` 
                    });
                }
                return;
            }
            
            // Perintah hapus user hotspot
            if (command.startsWith('delhotspot ') || command.startsWith('!delhotspot ') || command.startsWith('/delhotspot ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 1) {
                    console.log(`Menjalankan perintah hapus user hotspot ${params[0]}`);
                    await handleDeleteHotspotUser(remoteJid, params);
                    return;
                }
            }
            
            // Perintah hapus secret PPPoE
            if (command.startsWith('delpppoe ') || command.startsWith('!delpppoe ') || command.startsWith('/delpppoe ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 1) {
                    console.log(`Menjalankan perintah hapus secret PPPoE ${params[0]}`);
                    await handleDeletePPPoESecret(remoteJid, params);
                    return;
                }
            }
            
            // Perintah tambah user hotspot
            if (command.startsWith('addhotspot ') || command.startsWith('!addhotspot ') || command.startsWith('/addhotspot ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 2) {
                    console.log(`Menjalankan perintah tambah user hotspot ${params[0]}`);
                    await handleAddHotspotUser(remoteJid, params);
                    return;
                }
            }
            
            // Perintah tambah secret PPPoE
            if (command.startsWith('addpppoe ') || command.startsWith('!addpppoe ') || command.startsWith('/addpppoe ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 2) {
                    console.log(`Menjalankan perintah tambah secret PPPoE ${params[0]}`);
                    await handleAddPPPoESecret(remoteJid, params);
                    return;
                }
            }
            
            // Perintah ubah profile PPPoE
            if (command.startsWith('setprofile ') || command.startsWith('!setprofile ') || command.startsWith('/setprofile ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 2) {
                    console.log(`Menjalankan perintah ubah profile PPPoE ${params[0]}`);
                    await handleChangePPPoEProfile(remoteJid, params);
                    return;
                }
            }
            
            // Perintah info resource
            if (command === 'resource' || command === '!resource' || command === '/resource') {
                console.log(`Menjalankan perintah info resource`);
                await handleResourceInfo(remoteJid);
                return;
            }
            
            // Perintah tambah WAN
            if (command.startsWith('addwan ') || command.startsWith('!addwan ') || command.startsWith('/addwan ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 3) {
                    console.log(`Menjalankan perintah tambah WAN untuk ${params[0]}`);
                    await handleAddWAN(remoteJid, params);
                    return;
                } else {
                    await sock.sendMessage(remoteJid, { 
                        text: `âŒ *FORMAT Salah!*\n\n` +
                              `Format yang benar:\n` +
                              `addwan [nomor_pelanggan] [tipe_wan] [mode_koneksi]\n\n` +
                              `Tipe WAN: ppp atau ip\n` +
                              `Mode Koneksi: bridge atau route\n\n` +
                              `Contoh:\n` +
                              `addwan 081234567890 ppp route\n` +
                              `addwan 081234567890 ppp bridge\n` +
                              `addwan 081234567890 ip bridge`
                    });
                    return;
                }
            }
            
            // Perintah tambah tag pelanggan
            if (command.startsWith('addtag ') || command.startsWith('!addtag ') || command.startsWith('/addtag ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 2) {
                    console.log(`Menjalankan perintah tambah tag untuk device ${params[0]}`);
                    await addCustomerTag(remoteJid, params);
                    return;
                } else {
                    await sock.sendMessage(remoteJid, { 
                        text: `âŒ *FORMAT Salah!*\n\n` +
                              `Format yang benar:\n` +
                              `addtag [device_id] [nomor_pelanggan]\n\n` +
                              `Contoh:\n` +
                              `addtag 202BC1-BM632w-000000 081234567890`
                    });
                    return;
                }
            }
            
            // Perintah tambah tag pelanggan berdasarkan PPPoE Username
            if (command.startsWith('addpppoe_tag ') || command.startsWith('!addpppoe_tag ') || command.startsWith('/addpppoe_tag ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 2) {
                    console.log(`Menjalankan perintah tambah tag untuk PPPoE Username ${params[0]}`);
                    await addTagByPPPoE(remoteJid, params, sock); // <-- TAMBAHKAN sock di sini!
                    return;
                } else {
                    await sock.sendMessage(remoteJid, { 
                        text: `âŒ *FORMAT Salah!*\n\n` +
                              `Format yang benar:\n` +
                              `addpppoe_tag [pppoe_username] [nomor_pelanggan]\n\n` +
                              `Contoh:\n` +
                              `addpppoe_tag user123 081234567890`
                    });
                    return;
                }
            }
            
            // Perintah buat voucher hotspot
            if (command.startsWith('vcr ') || command.startsWith('!vcr ') || command.startsWith('/vcr ')) {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: 'âŒ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                const params = messageText.split(' ').slice(1);
                console.log('Menjalankan perintah buat voucher dengan parameter:', params);
                await handleVoucherCommand(remoteJid, params);
                return;
            }
            
            // Perintah member (username dan password berbeda)
            if (command.startsWith('member ') || command.startsWith('!member ') || command.startsWith('/member ')) {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: 'âŒ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                const params = messageText.split(' ').slice(1);
                console.log('Menjalankan perintah member dengan parameter:', params);
                await handleMemberCommand(remoteJid, params);
                return;
            }
            
            // Perintah user hotspot aktif
            if (command === 'hotspot' || command === '!hotspot' || command === '/hotspot') {
                console.log(`Menjalankan perintah user hotspot aktif`);
                await handleActiveHotspotUsers(remoteJid);
                return;
            }
            
            // Perintah koneksi PPPoE aktif
            if (command === 'pppoe' || command === '!pppoe' || command === '/pppoe') {
                console.log(`Menjalankan perintah koneksi PPPoE aktif`);
                await handleActivePPPoE(remoteJid);
                return;
            }
            
            // Perintah user PPPoE offline
            if (command === 'offline' || command === '!offline' || command === '/offline') {
                console.log(`Menjalankan perintah user PPPoE offline`);
                await handleOfflineUsers(remoteJid);
                return;
            }

            // Perintah daftar interface
            if (command === 'interfaces' || command === '!interfaces' || command === '/interfaces') {
                console.log(`Menjalankan perintah daftar interface`);
                await mikrotikCommands.handleInterfaces(remoteJid);
                return;
            }

            // Perintah detail interface
            if (command.startsWith('interface ') || command.startsWith('!interface ') || command.startsWith('/interface ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 1) {
                    console.log(`Menjalankan perintah detail interface ${params[0]}`);
                    await mikrotikCommands.handleInterfaceDetail(remoteJid, params);
                    return;
                }
            }

            // Perintah enable interface
            if (command.startsWith('enableif ') || command.startsWith('!enableif ') || command.startsWith('/enableif ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 1) {
                    console.log(`Menjalankan perintah enable interface ${params[0]}`);
                    await mikrotikCommands.handleInterfaceStatus(remoteJid, params, true);
                    return;
                }
            }

            // Perintah disable interface
            if (command.startsWith('disableif ') || command.startsWith('!disableif ') || command.startsWith('/disableif ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 1) {
                    console.log(`Menjalankan perintah disable interface ${params[0]}`);
                    await mikrotikCommands.handleInterfaceStatus(remoteJid, params, false);
                    return;
                }
            }

            // Perintah daftar IP address
            if (command === 'ipaddress' || command === '!ipaddress' || command === '/ipaddress') {
                console.log(`Menjalankan perintah daftar IP address`);
                await mikrotikCommands.handleIPAddresses(remoteJid);
                return;
            }

            // Perintah routing table
            if (command === 'routes' || command === '!routes' || command === '/routes') {
                console.log(`Menjalankan perintah routing table`);
                await mikrotikCommands.handleRoutes(remoteJid);
                return;
            }

            // Perintah DHCP leases
            if (command === 'dhcp' || command === '!dhcp' || command === '/dhcp') {
                console.log(`Menjalankan perintah DHCP leases`);
                await mikrotikCommands.handleDHCPLeases(remoteJid);
                return;
            }

            // Perintah ping
            if (command.startsWith('ping ') || command.startsWith('!ping ') || command.startsWith('/ping ')) {
                const params = messageText.split(' ').slice(1);
                if (params.length >= 1) {
                    console.log(`Menjalankan perintah ping ${params[0]}`);
                    await mikrotikCommands.handlePing(remoteJid, params);
                    return;
                }
            }

            // ===== BILLING COMMANDS =====
            // Set sock untuk billing commands
            billingCommands.setSock(sock);

            // Perintah menu billing
            if (command === 'billing' || command === '!billing' || command === '/billing') {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah billing.'
                    });
                    return;
                }
                console.log(`Menjalankan menu billing`);
                await billingCommands.handleBillingMenu(remoteJid);
                return;
            }

            // Customer Management Commands
            if (command.startsWith('addcustomer ') || command.startsWith('!addcustomer ') || command.startsWith('/addcustomer ')) {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                const params = messageText.split(' ').slice(1);
                console.log(`Menjalankan perintah addcustomer dengan parameter:`, params);
                await billingCommands.handleAddCustomer(remoteJid, params);
                return;
            }

            if (command.startsWith('editcustomer ') || command.startsWith('!editcustomer ') || command.startsWith('/editcustomer ')) {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                const params = messageText.split(' ').slice(1);
                console.log(`Menjalankan perintah editcustomer dengan parameter:`, params);
                await billingCommands.handleEditCustomer(remoteJid, params);
                return;
            }

            if (command.startsWith('delcustomer ') || command.startsWith('!delcustomer ') || command.startsWith('/delcustomer ')) {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                const params = messageText.split(' ').slice(1);
                console.log(`Menjalankan perintah delcustomer dengan parameter:`, params);
                await billingCommands.handleDeleteCustomer(remoteJid, params);
                return;
            }

            if (command === 'listcustomers' || command === '!listcustomers' || command === '/listcustomers') {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                console.log(`Menjalankan perintah listcustomers`);
                await billingCommands.handleListCustomers(remoteJid);
                return;
            }

            if (command.startsWith('findcustomer ') || command.startsWith('!findcustomer ') || command.startsWith('/findcustomer ')) {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                const params = messageText.split(' ').slice(1);
                console.log(`Menjalankan perintah findcustomer dengan parameter:`, params);
                await billingCommands.handleFindCustomer(remoteJid, params);
                return;
            }

            // Payment Management Commands
            if (command.startsWith('payinvoice ') || command.startsWith('!payinvoice ') || command.startsWith('/payinvoice ')) {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                const params = messageText.split(' ').slice(1);
                console.log(`Menjalankan perintah payinvoice dengan parameter:`, params);
                await billingCommands.handlePayInvoice(remoteJid, params);
                return;
            }

            if (command.startsWith('checkpayment ') || command.startsWith('!checkpayment ') || command.startsWith('/checkpayment ')) {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                const params = messageText.split(' ').slice(1);
                console.log(`Menjalankan perintah checkpayment dengan parameter:`, params);
                await billingCommands.handleCheckPayment(remoteJid, params);
                return;
            }

            if (command === 'paidcustomers' || command === '!paidcustomers' || command === '/paidcustomers') {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                console.log(`Menjalankan perintah paidcustomers`);
                await billingCommands.handlePaidCustomers(remoteJid);
                return;
            }

            if (command === 'overduecustomers' || command === '!overduecustomers' || command === '/overduecustomers') {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                console.log(`Menjalankan perintah overduecustomers`);
                await billingCommands.handleOverdueCustomers(remoteJid);
                return;
            }

            if (command === 'billingstats' || command === '!billingstats' || command === '/billingstats') {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                console.log(`Menjalankan perintah billingstats`);
                await billingCommands.handleBillingStats(remoteJid);
                return;
            }

            // Package Management Commands
            if (command.startsWith('addpackage ') || command.startsWith('!addpackage ') || command.startsWith('/addpackage ')) {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                const params = messageText.split(' ').slice(1);
                console.log(`Menjalankan perintah addpackage dengan parameter:`, params);
                await billingCommands.handleAddPackage(remoteJid, params);
                return;
            }

            if (command === 'listpackages' || command === '!listpackages' || command === '/listpackages') {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                console.log(`Menjalankan perintah listpackages`);
                await billingCommands.handleListPackages(remoteJid);
                return;
            }

            // Invoice Management Commands
            if (command.startsWith('createinvoice ') || command.startsWith('!createinvoice ') || command.startsWith('/createinvoice ')) {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                const params = messageText.split(' ').slice(1);
                console.log(`Menjalankan perintah createinvoice dengan parameter:`, params);
                await billingCommands.handleCreateInvoice(remoteJid, params);
                return;
            }

            if (command.startsWith('listinvoices ') || command.startsWith('!listinvoices ') || command.startsWith('/listinvoices ') || 
                command === 'listinvoices' || command === '!listinvoices' || command === '/listinvoices') {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                const params = messageText.split(' ').slice(1);
                console.log(`Menjalankan perintah listinvoices dengan parameter:`, params);
                await billingCommands.handleListInvoices(remoteJid, params);
                return;
            }

            // Perintah help billing
            if (command === 'help billing' || command === '!help billing' || command === '/help billing') {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                console.log(`Menjalankan perintah help billing`);
                const { getBillingHelpMessage } = require('./help-messages');
                await sock.sendMessage(remoteJid, { text: getBillingHelpMessage() });
                return;
            }

            // ===== PERINTAH BAHASA INDONESIA =====
            // Perintah tambah pelanggan
            if (command.startsWith('tambah ') || command.startsWith('!tambah ') || command.startsWith('/tambah ')) {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                const params = messageText.split(' ').slice(1);
                console.log(`Menjalankan perintah tambah dengan parameter:`, params);
                await billingCommands.handleTambah(remoteJid, params);
                return;
            }

            // Perintah daftar pelanggan
            if (command === 'daftar' || command === '!daftar' || command === '/daftar') {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                console.log(`Menjalankan perintah daftar`);
                await billingCommands.handleDaftar(remoteJid);
                return;
            }

            // Perintah cari pelanggan
            if (command.startsWith('cari ') || command.startsWith('!cari ') || command.startsWith('/cari ')) {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                const params = messageText.split(' ').slice(1);
                console.log(`Menjalankan perintah cari dengan parameter:`, params);
                await billingCommands.handleCari(remoteJid, params);
                return;
            }

            // Perintah bayar
            if (command.startsWith('bayar ') || command.startsWith('!bayar ') || command.startsWith('/bayar ')) {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                const params = messageText.split(' ').slice(1);
                console.log(`[WHATSAPP] Menjalankan perintah bayar dengan:`, {
                    command: command,
                    messageText: messageText,
                    params: params,
                    sender: remoteJid
                });
                await billingCommands.handleBayar(remoteJid, params);
            return;
        }

        // Perintah isolir layanan
        if (command.startsWith('isolir ')) {
            if (!isAdmin) {
                await sock.sendMessage(remoteJid, { 
                    text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                });
                return;
            }
            const params = messageText.split(' ').slice(1);
            console.log(`Menjalankan perintah isolir dengan parameter:`, params);
            await billingCommands.handleIsolir(remoteJid, params);
            return;
        }

        // Perintah buka isolir (restore)
        if (command.startsWith('buka ')) {
            if (!isAdmin) {
                await sock.sendMessage(remoteJid, { 
                    text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                });
                return;
            }
            const params = messageText.split(' ').slice(1);
            console.log(`Menjalankan perintah buka (restore) dengan parameter:`, params);
            await billingCommands.handleBuka(remoteJid, params);
            return;
        }

            // Perintah sudah bayar
            if (command === 'sudahbayar' || command === '!sudahbayar' || command === '/sudahbayar') {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                console.log(`Menjalankan perintah sudahbayar`);
                await billingCommands.handleSudahBayar(remoteJid);
                return;
            }

            // Perintah terlambat
            if (command === 'terlambat' || command === '!terlambat' || command === '/terlambat') {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                console.log(`Menjalankan perintah terlambat`);
                await billingCommands.handleTerlambat(remoteJid);
                return;
            }

            // Perintah statistik
            if (command === 'statistik' || command === '!statistik' || command === '/statistik') {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                console.log(`Menjalankan perintah statistik`);
                await billingCommands.handleStatistik(remoteJid);
                return;
            }

            // Perintah daftar paket
            if (command === 'daftarpaket' || command === '!daftarpaket' || command === '/daftarpaket') {
                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { 
                        text: '❌ *AKSES DITOLAK*\n\nHanya admin yang dapat menggunakan perintah ini.'
                    });
                    return;
                }
                console.log(`Menjalankan perintah daftarpaket`);
                await billingCommands.handleDaftarPaket(remoteJid);
                return;
            }

            // Perintah system logs
            if (command === 'logs' || command === '!logs' || command === '/logs' ||
                command.startsWith('logs ') || command.startsWith('!logs ') || command.startsWith('/logs ')) {
                const params = messageText.split(' ').slice(1);
                console.log(`Menjalankan perintah system logs`);
                await mikrotikCommands.handleSystemLogs(remoteJid, params);
                return;
            }

            // Perintah profiles
            if (command === 'profiles' || command === '!profiles' || command === '/profiles' ||
                command.startsWith('profiles ') || command.startsWith('!profiles ') || command.startsWith('/profiles ')) {
                const params = messageText.split(' ').slice(1);
                console.log(`Menjalankan perintah profiles`);
                await mikrotikCommands.handleProfiles(remoteJid, params);
                return;
            }

            // Perintah firewall
            if (command === 'firewall' || command === '!firewall' || command === '/firewall' ||
                command.startsWith('firewall ') || command.startsWith('!firewall ') || command.startsWith('/firewall ')) {
                const params = messageText.split(' ').slice(1);
                console.log(`Menjalankan perintah firewall`);
                await mikrotikCommands.handleFirewall(remoteJid, params);
                return;
            }

            // Perintah semua user
            if (command === 'users' || command === '!users' || command === '/users') {
                console.log(`Menjalankan perintah semua user`);
                await mikrotikCommands.handleAllUsers(remoteJid);
                return;
            }

            // Perintah clock router
            if (command === 'clock' || command === '!clock' || command === '/clock') {
                console.log(`Menjalankan perintah clock router`);
                await mikrotikCommands.handleRouterClock(remoteJid);
                return;
            }

            // Perintah identity router
            if (command === 'identity' || command === '!identity' || command === '/identity' ||
                command.startsWith('identity ') || command.startsWith('!identity ') || command.startsWith('/identity ')) {
                const params = messageText.split(' ').slice(1);
                console.log(`Menjalankan perintah identity router`);
                await mikrotikCommands.handleRouterIdentity(remoteJid, params);
                return;
            }

            // Perintah restart router
            if (command === 'reboot' || command === '!reboot' || command === '/reboot') {
                console.log(`Menjalankan perintah restart router`);
                await mikrotikCommands.handleRestartRouter(remoteJid);
                return;
            }

            // Perintah konfirmasi restart
            if (command === 'confirm restart' || command === '!confirm restart' || command === '/confirm restart') {
                console.log(`Menjalankan konfirmasi restart router`);
                await mikrotikCommands.handleConfirmRestart(remoteJid);
                return;
            }

            // Perintah debug resource (admin only)
            if (command === 'debug resource' || command === '!debug resource' || command === '/debug resource') {
                console.log(`Admin menjalankan debug resource`);
                await mikrotikCommands.handleDebugResource(remoteJid);
                return;
            }

            // Perintah debug settings performance (admin only)
            if (command === 'debug settings' || command === '!debug settings' || command === '/debug settings') {
                console.log(`Admin menjalankan debug settings performance`);
                try {
                    const { getPerformanceReport } = require('./settingsManager');
                    const report = getPerformanceReport();
                    await sendFormattedMessage(remoteJid, `📊 *SETTINGS PERFORMANCE DEBUG*\n\n\`\`\`${report}\`\`\``);
                } catch (error) {
                    await sendFormattedMessage(remoteJid, `❌ *Error getting performance stats:* ${error.message}`);
                }
                return;
            }

            // Perintah quick settings stats (admin only)
            if (command === 'settings stats' || command === '!settings stats' || command === '/settings stats') {
                console.log(`Admin menjalankan settings stats`);
                try {
                    const { getQuickStats } = require('./settingsManager');
                    const stats = getQuickStats();
                    await sendFormattedMessage(remoteJid, `📊 *Settings Stats*\n${stats}`);
                } catch (error) {
                    await sendFormattedMessage(remoteJid, `❌ *Error:* ${error.message}`);
                }
                return;
            }
            
            // Perintah info wifi
            if (command === 'info wifi' || command === '!info wifi' || command === '/info wifi') {
                console.log(`Menjalankan perintah info wifi untuk ${senderNumber}`);
                if (genieacsCommandsEnabled) {
                    await genieacsCommands.handleWifiInfo(remoteJid, senderNumber);
                } else {
                    await sendGenieACSDisabledMessage(remoteJid);
                }
                return;
            }
            
            // Perintah info layanan
            if (command === 'info' || command === '!info' || command === '/info') {
                console.log(`Menjalankan perintah info layanan untuk ${senderNumber}`);
                await handleInfoLayanan(remoteJid, senderNumber);
                return;
            }
            
            // Perintah ganti nama WiFi
            if (command.startsWith('gantiwifi ') || command.startsWith('!gantiwifi ') || command.startsWith('/gantiwifi ')) {
                console.log(`Menjalankan perintah ganti nama WiFi untuk ${senderNumber}`);
                const newSSID = messageText.split(' ').slice(1).join(' ');
                if (genieacsCommandsEnabled) {
                    await genieacsCommands.handleChangeWifiSSID(remoteJid, senderNumber, newSSID);
                } else {
                    await sendGenieACSDisabledMessage(remoteJid);
                }
                return;
            }
            
            // Perintah ganti password WiFi
            if (command.startsWith('gantipass ') || command.startsWith('!gantipass ') || command.startsWith('/gantipass ')) {
                console.log(`Menjalankan perintah ganti password WiFi untuk ${senderNumber}`);
                const newPassword = messageText.split(' ').slice(1).join(' ');
                if (genieacsCommandsEnabled) {
                    await genieacsCommands.handleChangeWifiPassword(remoteJid, senderNumber, newPassword);
                } else {
                    await sendGenieACSDisabledMessage(remoteJid);
                }
                return;
            }
            
            // Perintah status perangkat
            if (command === 'status' || command === '!status' || command === '/status') {
                console.log(`Menjalankan perintah status perangkat untuk ${senderNumber}`);
                if (genieacsCommandsEnabled) {
                    await genieacsCommands.handleDeviceStatus(remoteJid, senderNumber);
                } else {
                    await sendGenieACSDisabledMessage(remoteJid);
                }
                // Setelah status perangkat, kirim juga status tagihan
                await sendBillingStatus(remoteJid, senderNumber);
                return;
            }
            
            // Perintah restart perangkat
            if (command === 'restart' || command === '!restart' || command === '/restart') {
                console.log(`Menjalankan perintah restart perangkat untuk ${senderNumber}`);
                if (genieacsCommandsEnabled) {
                    await genieacsCommands.handleRestartDevice(remoteJid, senderNumber);
                } else {
                    await sendGenieACSDisabledMessage(remoteJid);
                }
                return;
            }
            
            // Konfirmasi restart perangkat
            if ((command === 'ya' || command === 'iya' || command === 'yes') && global.pendingRestarts && global.pendingRestarts[senderNumber]) {
                console.log(`Konfirmasi restart perangkat untuk ${senderNumber}`);
                if (genieacsCommandsEnabled) {
                    await genieacsCommands.handleRestartConfirmation(remoteJid, senderNumber, true);
                } else {
                    await sendGenieACSDisabledMessage(remoteJid);
                }
                return;
            }
            
            // Batalkan restart perangkat
            if ((command === 'tidak' || command === 'no' || command === 'batal') && global.pendingRestarts && global.pendingRestarts[senderNumber]) {
                console.log(`Membatalkan restart perangkat untuk ${senderNumber}`);
                if (genieacsCommandsEnabled) {
                    await genieacsCommands.handleRestartConfirmation(remoteJid, senderNumber, false);
                } else {
                    await sendGenieACSDisabledMessage(remoteJid);
                }
                return;
            }

            // Perintah untuk cek status group dan nomor teknisi
            if (command === 'checkgroup' || command === '!checkgroup' || command === '/checkgroup') {
                try {
                    const technicianGroupId = getSetting('technician_group_id', '');
                    const technicianNumbers = getTechnicianNumbers();
                    
                    let message = `🔍 *STATUS GROUP & NOMOR TEKNISI*\n\n`;
                    
                    // Cek group ID
                    if (technicianGroupId) {
                        message += `📋 *Group ID:* ${technicianGroupId}\n`;
                        
                        try {
                            // Coba ambil metadata group
                            const groupMetadata = await sock.groupMetadata(technicianGroupId);
                            message += `✅ *Status:* Group ditemukan\n`;
                            message += `📋 *Nama:* ${groupMetadata.subject}\n`;
                            message += `👥 *Peserta:* ${groupMetadata.participants.length}\n`;
                        } catch (groupError) {
                            if (groupError.message.includes('item-not-found')) {
                                message += `❌ *Status:* Group tidak ditemukan\n`;
                                message += `💡 *Solusi:* Pastikan bot sudah ditambahkan ke group\n`;
                            } else {
                                message += `⚠️ *Status:* Error - ${groupError.message}\n`;
                            }
                        }
                    } else {
                        message += `❌ *Group ID:* Tidak dikonfigurasi\n`;
                    }
                    
                    message += `\n📱 *Nomor Teknisi:*\n`;
                    if (technicianNumbers && technicianNumbers.length > 0) {
                        for (let i = 0; i < technicianNumbers.length; i++) {
                            const number = technicianNumbers[i];
                            message += `${i + 1}. ${number}\n`;
                            
                            // Validasi nomor
                            try {
                                const cleanNumber = number.replace(/\D/g, '').replace(/^0/, '62');
                                const [result] = await sock.onWhatsApp(cleanNumber);
                                
                                if (result && result.exists) {
                                    message += `   ✅ Valid WhatsApp\n`;
                                } else {
                                    message += `   ❌ Tidak terdaftar di WhatsApp\n`;
                                }
                            } catch (validationError) {
                                message += `   ⚠️ Error validasi: ${validationError.message}\n`;
                            }
                        }
                    } else {
                        message += `❌ Tidak ada nomor teknisi dikonfigurasi\n`;
                    }
                    
                    message += `\n💡 *Tips:*\n`;
                    message += `• Pastikan bot sudah ditambahkan ke group\n`;
                    message += `• Pastikan nomor teknisi terdaftar di WhatsApp\n`;
                    message += `• Gunakan format: 628xxxxxxxxxx\n`;
                    
                    await sock.sendMessage(remoteJid, { text: message });
                } catch (error) {
                    await sock.sendMessage(remoteJid, { 
                        text: `❌ Error checking group status: ${error.message}` 
                    });
                }
                return;
            }
        }
        
        // Jika pesan tidak dikenali sebagai perintah, abaikan saja
        console.log(`Pesan tidak dikenali sebagai perintah: ${messageText}`);
        // Tidak melakukan apa-apa untuk pesan yang bukan perintah
        
    } catch (error) {
        console.error('Error handling incoming message:', error);
        
        // JANGAN kirim pesan error ke pengirim - hanya log error saja
        // Ini akan mencegah respon otomatis terhadap setiap pesan
        /*
        try {
            if (sock && message && message.key && message.key.remoteJid) {
                await sock.sendMessage(message.key.remoteJid, { 
                    text: `❌ *ERROR*

Terjadi kesalahan saat memproses pesan: ${error.message}

Silakan coba lagi nanti.`
                });
            }
        } catch (sendError) {
            console.error('Error sending error message:', sendError);
        }
        */
    }
}

// Tambahkan di bagian deklarasi fungsi sebelum 
    // Fungsi untuk menampilkan menu pelanggan
    async function sendCustomerMenu(remoteJid) {
        try {
            console.log(`Menampilkan menu pelanggan ke ${remoteJid}`);
            
            // Gunakan help message dari file terpisah
            const customerMessage = getCustomerHelpMessage();
            
            // Kirim pesan menu pelanggan
            await sock.sendMessage(remoteJid, { text: customerMessage });
            console.log(`Pesan menu pelanggan terkirim ke ${remoteJid}`);
            
        } catch (error) {
            console.error('Error sending customer menu:', error);
            await sock.sendMessage(remoteJid, { 
                text: `âŒ *ERROR*\n\nTerjadi kesalahan saat menampilkan menu pelanggan:\n${error.message}` 
            });
        }
    }

module.exports

// Fungsi untuk menampilkan menu admin
async function handleAdminMenu(remoteJid) {
    try {
        console.log(`Menampilkan menu admin ke ${remoteJid}`);
        
        // Pesan menu admin
        let adminMessage = `📋🔍 *MENU ADMIN*\n\n`;
        
        adminMessage += `*Perintah Admin:*\n`;
        adminMessage += `• 📋 *list* * Daftar semua ONU\n`;
        adminMessage += `• 🔍 *cekall* * Cek status semua ONU\n`;
        adminMessage += `• 🔍 *cek [nomor]* * Cek status ONU pelanggan\n`;
        adminMessage += `• 🔧 *editssid [nomor] [ssid]* * Edit SSID pelanggan\n`;
        adminMessage += `• 🔧 *editpass [nomor] [password]* * Edit password WiFi pelanggan\n`;
        adminMessage += `• 🔐 *otp [on/off/status]* * Kelola sistem OTP\n`;
        adminMessage += `• 📊 *billing* * Menu billing admin\n\n`;
        
        // Status GenieACS (tanpa menampilkan perintah)
        adminMessage += `*Status Sistem:*\n`;
        adminMessage += `• ${genieacsCommandsEnabled ? '✅' : 'âŒ'} *GenieACS:* ${genieacsCommandsEnabled ? 'Aktif' : 'Nonaktif'}\n`;
        
        // Tambahkan status OTP
        const settings = getAppSettings();
        const otpStatus = settings.customerPortalOtp || settings.customer_otp_enabled;
        adminMessage += `• ${otpStatus ? '✅' : 'âŒ'} *OTP Portal:* ${otpStatus ? 'Aktif' : 'Nonaktif'}\n\n`;
        
        // Tambahkan footer
        adminMessage += `🏢 *${getSetting('company_header', 'CV Lintas Multimedia')}*\n`;
        adminMessage += `${getSetting('footer_info', 'Internet Tanpa Batas')}`;
        
        // Kirim pesan menu admin
        await sock.sendMessage(remoteJid, { text: adminMessage });
        console.log(`Pesan menu admin terkirim ke ${remoteJid}`);
        
        return true;
    } catch (error) {
        console.error('Error sending admin menu:', error);
        return false;
    }
}

// Fungsi untuk mendapatkan nilai SSID dari perangkat
function getSSIDValue(device, configIndex) {
    try {
        // Coba cara 1: Menggunakan notasi bracket untuk WLANConfiguration
        if (device.InternetGatewayDevice && 
            device.InternetGatewayDevice.LANDevice && 
            device.InternetGatewayDevice.LANDevice['1'] && 
            device.InternetGatewayDevice.LANDevice['1'].WLANConfiguration && 
            device.InternetGatewayDevice.LANDevice['1'].WLANConfiguration[configIndex] && 
            device.InternetGatewayDevice.LANDevice['1'].WLANConfiguration[configIndex].SSID) {
            
            const ssidObj = device.InternetGatewayDevice.LANDevice['1'].WLANConfiguration[configIndex].SSID;
            if (ssidObj._value !== undefined) {
                return ssidObj._value;
            }
        }
        
        // Coba cara 2: Menggunakan getParameterWithPaths
        const ssidPath = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${configIndex}.SSID`;
        const ssidValue = getParameterWithPaths(device, [ssidPath]);
        if (ssidValue && ssidValue !== 'N/A') {
            return ssidValue;
        }
        
        // Coba cara 3: Cari di seluruh objek
        for (const key in device) {
            if (device[key]?.LANDevice?.['1']?.WLANConfiguration?.[configIndex]?.SSID?._value) {
                return device[key].LANDevice['1'].WLANConfiguration[configIndex].SSID._value;
            }
        }
        
        // Coba cara 4: Cari di parameter virtual
        if (device.VirtualParameters?.SSID?._value) {
            return device.VirtualParameters.SSID._value;
        }
        
        if (configIndex === '5' && device.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['2']?.SSID?._value) {
            return device.InternetGatewayDevice.LANDevice['1'].WLANConfiguration['2'].SSID._value;
        }
        
        return 'N/A';
    } catch (error) {
        console.error(`Error getting SSID for config ${configIndex}:`, error);
        return 'N/A';
    }
}

const settingsPath = path.join(__dirname, '../settings.json');

function getAppSettings() {
    try {
        // Gunakan settingsManager yang sudah ada
        const { getSettingsWithCache } = require('./settingsManager');
        return getSettingsWithCache();
    } catch (e) {
        console.error('Error getting app settings:', e);
        // Fallback ke pembacaan langsung file
        try {
            const { getSettingsWithCache } = require('./settingsManager');
            return getSettingsWithCache();
        } catch (fallbackError) {
            console.error('Error reading settings file directly:', fallbackError);
            return {};
        }
    }
}

// Deklarasi helper agar DRY
// PRIORITAS: Ambil dari database genieacs_servers, fallback ke settings.json
async function getGenieacsConfig() {
    try {
        // PRIORITAS 1: Ambil dari database genieacs_servers
        const { getAllGenieacsServers } = require('./genieacs');
        const servers = await getAllGenieacsServers();
        
        if (servers && servers.length > 0) {
            // Gunakan server pertama sebagai default (bisa diubah nanti untuk multi-server)
            const server = servers[0];
            console.log(`✅ Using GenieACS server from database: ${server.name} (${server.url})`);
            return {
                genieacsUrl: server.url.trim(),
                genieacsUsername: server.username,
                genieacsPassword: server.password,
                serverId: server.id,
                serverName: server.name
            };
        }
        
        // PRIORITAS 2: Fallback ke settings.json (untuk kompatibilitas)
        console.warn('⚠️ No GenieACS servers found in database, falling back to settings.json');
    const { getSetting } = require('./settingsManager');
        const genieacsUrl = getSetting('genieacs_url', '');
        const genieacsUsername = getSetting('genieacs_username', 'admin');
        const genieacsPassword = getSetting('genieacs_password', 'password');
        
        if (!genieacsUrl || genieacsUrl.trim() === '') {
            console.warn('⚠️ GenieACS URL tidak dikonfigurasi di settings.json');
    return {
                genieacsUrl: '',
                genieacsUsername: genieacsUsername,
                genieacsPassword: genieacsPassword,
            };
        }
        
        return {
            genieacsUrl: genieacsUrl.trim(),
            genieacsUsername: genieacsUsername,
            genieacsPassword: genieacsPassword,
        };
    } catch (error) {
        console.error('❌ Error getting GenieACS config:', error.message);
        // Fallback ke settings.json jika error
        const { getSetting } = require('./settingsManager');
        const genieacsUrl = getSetting('genieacs_url', '');
        const genieacsUsername = getSetting('genieacs_username', 'admin');
        const genieacsPassword = getSetting('genieacs_password', 'password');
        
        return {
            genieacsUrl: genieacsUrl.trim() || '',
            genieacsUsername: genieacsUsername,
            genieacsPassword: genieacsPassword,
        };
    }
}

// Fungsi untuk menangani info layanan (tambahan billing)
async function handleInfoLayanan(remoteJid, senderNumber) {
    try {
        console.log(`Menampilkan info layanan ke ${remoteJid}`);
        
        const { getSetting } = require('./settingsManager');
        const billingManager = require('./billing');
        
        // Ambil nomor admin dan teknisi dengan format yang benar
        const adminNumber = getSetting('admins.0', '628xxxxxxxxxx');
        
        // Ambil semua nomor teknisi
        const technicianNumbers = [];
        let i = 0;
        while (true) {
            const number = getSetting(`technician_numbers.${i}`, '');
            if (!number) break;
            technicianNumbers.push(number);
            i++;
        }
        const technicianNumbersText = technicianNumbers.length > 0 ? technicianNumbers.join(', ') : '628xxxxxxxxxx';
        
        let message = formatWithHeaderFooter(`🏢 *INFORMASI LAYANAN*

📱 *CV Lintas Multimedia*
Layanan internet cepat dan stabil untuk kebutuhan Anda.

🔧 *FITUR LAYANAN:*
• Internet Unlimited 24/7
• Kecepatan tinggi dan stabil
• Dukungan teknis 24 jam
• Monitoring perangkat real-time
• Manajemen WiFi via WhatsApp

📞 *KONTAK DUKUNGAN:*
• WhatsApp: ${adminNumber}
• Teknisi: ${technicianNumbersText}
• Jam Operasional: 24/7

💡 *CARA PENGGUNAAN:*
• Ketik *menu* untuk melihat menu lengkap
• Ketik *status* untuk cek status perangkat
• Ketik *help* untuk bantuan teknis

🛠️ *LAYANAN PELANGGAN:*
• Ganti nama WiFi: *gantiwifi [nama]*
• Ganti password WiFi: *gantipass [password]*
• Cek perangkat terhubung: *devices*
• Test kecepatan: *speedtest*
• Diagnostik jaringan: *diagnostic*

📋 *INFORMASI TEKNIS:*
• Teknologi: Fiber Optic
• Protokol: PPPoE
• Monitoring: GenieACS
• Router: Mikrotik
• ONU: GPON/EPON

Untuk bantuan lebih lanjut, silakan hubungi teknisi kami.`);
        
        // Tambahkan ringkasan tagihan pelanggan (jika nomor terdaftar)
        try {
            let customer = await billingManager.getCustomerByPhone(senderNumber);
            if (!customer && senderNumber && senderNumber.startsWith('62')) {
                const altPhone = '0' + senderNumber.slice(2);
                customer = await billingManager.getCustomerByPhone(altPhone);
            }

            const bankName = getSetting('payment_bank_name', '');
            const accountNumber = getSetting('payment_account_number', '');
            const accountHolder = getSetting('payment_account_holder', '');
            const contactWa = getSetting('contact_whatsapp', '');
            const dana = getSetting('payment_dana', '');
            const ovo = getSetting('payment_ovo', '');
            const gopay = getSetting('payment_gopay', '');

            if (customer) {
                const invoices = await billingManager.getInvoicesByCustomer(customer.id);
                const unpaid = invoices.filter(i => i.status === 'unpaid');
                const totalUnpaid = unpaid.reduce((sum, inv) => sum + parseFloat(inv.amount || 0), 0);
                const nextDue = unpaid
                    .map(i => new Date(i.due_date))
                    .sort((a, b) => a - b)[0];

                message += `\n\n📋 *INFORMASI TAGIHAN*\n`;
                if (unpaid.length > 0) {
                    message += `• Status: BELUM LUNAS (${unpaid.length} tagihan)\n`;
                    message += `• Total: Rp ${totalUnpaid.toLocaleString('id-ID')}\n`;
                    if (nextDue) message += `• Jatuh Tempo Berikutnya: ${nextDue.toLocaleDateString('id-ID')}\n`;
                } else {
                    message += `• Status: LUNAS ✅\n`;
                }

                // Info pembayaran
                if (bankName && accountNumber) {
                    message += `\n🏦 *PEMBAYARAN*\n`;
                    message += `• Bank: ${bankName}\n`;
                    message += `• No. Rekening: ${accountNumber}\n`;
                    if (accountHolder) message += `• A/N: ${accountHolder}\n`;
                }
                const ewallets = [];
                if (dana) ewallets.push(`DANA: ${dana}`);
                if (ovo) ewallets.push(`OVO: ${ovo}`);
                if (gopay) ewallets.push(`GoPay: ${gopay}`);
                if (ewallets.length > 0) {
                    message += `• E-Wallet: ${ewallets.join(' | ')}\n`;
                }
                if (contactWa) {
                    message += `• Konfirmasi: ${contactWa}\n`;
                }
            } else {
                message += `\n\n📋 *INFORMASI TAGIHAN*\n• Nomor Anda belum terdaftar di sistem billing. Silakan hubungi admin untuk sinkronisasi.`;
            }
        } catch (billErr) {
            console.error('Gagal menambahkan info tagihan pada info layanan:', billErr);
        }

        await sock.sendMessage(remoteJid, { text: message });
        console.log(`Pesan info layanan terkirim ke ${remoteJid}`);
        
    } catch (error) {
        console.error('Error sending info layanan:', error);
        await sock.sendMessage(remoteJid, { 
            text: `❌ *ERROR*\n\nTerjadi kesalahan saat menampilkan info layanan:\n${error.message}` 
        });
    }
}

// Helper untuk mengirim status tagihan pelanggan (dipakai pada perintah status)
async function sendBillingStatus(remoteJid, senderNumber) {
    try {
        const { getSetting } = require('./settingsManager');
        const billingManager = require('./billing');

        let customer = await billingManager.getCustomerByPhone(senderNumber);
        if (!customer && senderNumber && senderNumber.startsWith('62')) {
            const altPhone = '0' + senderNumber.slice(2);
            customer = await billingManager.getCustomerByPhone(altPhone);
        }

        const bankName = getSetting('payment_bank_name', '');
        const accountNumber = getSetting('payment_account_number', '');
        const accountHolder = getSetting('payment_account_holder', '');
        const contactWa = getSetting('contact_whatsapp', '');
        const dana = getSetting('payment_dana', '');
        const ovo = getSetting('payment_ovo', '');
        const gopay = getSetting('payment_gopay', '');

        let text = `📋 *INFORMASI TAGIHAN*\n`;
        if (customer) {
            const invoices = await billingManager.getInvoicesByCustomer(customer.id);
            const unpaid = invoices.filter(i => i.status === 'unpaid');
            const totalUnpaid = unpaid.reduce((sum, inv) => sum + parseFloat(inv.amount || 0), 0);
            const nextDue = unpaid
                .map(i => new Date(i.due_date))
                .sort((a, b) => a - b)[0];

            if (unpaid.length > 0) {
                text += `• Status: BELUM LUNAS (${unpaid.length} tagihan)\n`;
                text += `• Total: Rp ${totalUnpaid.toLocaleString('id-ID')}\n`;
                if (nextDue) text += `• Jatuh Tempo Berikutnya: ${nextDue.toLocaleDateString('id-ID')}\n`;
            } else {
                text += `• Status: LUNAS ✅\n`;
            }

            if (bankName && accountNumber) {
                text += `\n🏦 *PEMBAYARAN*\n`;
                text += `• Bank: ${bankName}\n`;
                text += `• No. Rekening: ${accountNumber}\n`;
                if (accountHolder) text += `• A/N: ${accountHolder}\n`;
            }
            const ewallets = [];
            if (dana) ewallets.push(`DANA: ${dana}`);
            if (ovo) ewallets.push(`OVO: ${ovo}`);
            if (gopay) ewallets.push(`GoPay: ${gopay}`);
            if (ewallets.length > 0) {
                text += `• E-Wallet: ${ewallets.join(' | ')}\n`;
            }
            if (contactWa) {
                text += `• Konfirmasi: ${contactWa}\n`;
            }
        } else {
            text += `• Nomor Anda belum terdaftar di sistem billing. Silakan hubungi admin untuk sinkronisasi.`;
        }

        await sock.sendMessage(remoteJid, { text });
    } catch (e) {
        console.error('Error sending billing status:', e);
    }
}

// ... (rest of the code remains the same)

