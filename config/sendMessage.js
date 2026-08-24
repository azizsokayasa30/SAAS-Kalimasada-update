let sock = null;
const { getSetting } = require('./settingsManager');
const { getProviderManager } = require('./whatsapp-provider-manager');
const logger = require('./logger');

// Fungsi untuk set instance sock (untuk backward compatibility)
function setSock(sockInstance) {
    sock = sockInstance;
    // Update BaileysProvider jika provider manager sudah initialized
    try {
        const providerManager = getProviderManager();
        if (providerManager && providerManager.isInitialized()) {
            const provider = providerManager.getProvider();
            if (provider && provider.setSock) {
                provider.setSock(sockInstance);
            }
        }
    } catch (error) {
        // Ignore jika provider manager belum tersedia
    }
}

// Helper function untuk format nomor telepon
function formatPhoneNumber(number) {
    // Hapus karakter non-digit
    let cleaned = number.replace(/\D/g, '');
    
    // Hapus awalan 0 jika ada
    if (cleaned.startsWith('0')) {
        cleaned = cleaned.substring(1);
    }
    
    // Tambahkan kode negara 62 jika belum ada
    if (!cleaned.startsWith('62')) {
        cleaned = '62' + cleaned;
    }
    
    return cleaned;
}

// Helper function untuk mendapatkan header dan footer dari settings
function getHeaderFooter() {
    try {
        const { getCompanyHeader, getFooterInfo } = require('./message-templates');
        return {
            header: getCompanyHeader(),
            footer: getFooterInfo()
        };
    } catch (error) {
        return {
            header: 'PT. KALIMASADA INTI SARANA',
            footer: 'Internet Tanpa Batas'
        };
    }
}

function formatMessageWithHeaderFooter(message, includeHeader = true, includeFooter = true) {
    const { header, footer } = getHeaderFooter();
    const text = String(message || '');
    const alreadyHasHeader = header && text.includes(header);

    let formattedMessage = '';
    if (includeHeader && !alreadyHasHeader) {
        formattedMessage += `🏢 *${header}*\n\n`;
    }

    formattedMessage += text;

    if (includeFooter && footer && !text.includes(footer)) {
        formattedMessage += `\n\n${footer}`;
    }

    return formattedMessage;
}

// Fungsi untuk mengirim pesan (menggunakan provider manager)
async function sendMessage(number, message) {
    logger.info(`📱 Attempting to send WhatsApp message to: ${number}`);
    logger.debug(`📱 Message preview: ${typeof message === 'string' ? message.substring(0, 100) + '...' : 'Object message'}`);
    
    try {
        // Coba gunakan provider manager dulu (untuk Wablas/Baileys)
        const providerManager = getProviderManager();
        if (providerManager && providerManager.isInitialized()) {
            const provider = providerManager.getProvider();
            if (provider) {
                // Format nomor telepon
                let formattedNumber = number;
                
                // Jika JID (untuk group), extract nomor
                if (typeof number === 'string' && number.includes('@')) {
                    if (number.endsWith('@g.us')) {
                        // Group JID - untuk Wablas, kita perlu format khusus
                        formattedNumber = number.split('@')[0];
                    } else {
                        formattedNumber = formatPhoneNumber(number.split('@')[0]);
                    }
                } else {
                    formattedNumber = formatPhoneNumber(number);
                }
                
                // Format pesan dengan header dan footer
                let messageText = message;
                if (typeof message === 'string') {
                    messageText = formatMessageWithHeaderFooter(message);
                } else if (message && message.text) {
                    messageText = formatMessageWithHeaderFooter(message.text);
                }
                
                logger.info(`📱 Sending message via provider (${providerManager.getProviderType()}) to: ${formattedNumber}`);
                const result = await provider.sendMessage(formattedNumber, messageText);
                
                if (result && result.success) {
                    logger.info(`✅ WhatsApp message sent successfully to ${number} via ${providerManager.getProviderType()}`);
                    return { 
                        success: true, 
                        message: 'Pesan berhasil dikirim',
                        messageId: result.messageId || null,
                        provider: providerManager.getProviderType()
                    };
                } else {
                    logger.warn(`⚠️ Provider failed to send message: ${result?.error || 'Unknown error'}`);
                    // Fallback ke sock jika ada
                }
            }
        }
    } catch (providerError) {
        logger.warn(`⚠️ Provider error, falling back to sock: ${providerError.message}`);
    }
    
    // Fallback ke sock langsung untuk backward compatibility
    if (!sock) {
        logger.error('❌ WhatsApp belum terhubung - sock instance is null and provider not available');
        return { success: false, error: 'WhatsApp belum terhubung' };
    }
    
    try {
        let jid;
        if (typeof number === 'string' && number.endsWith('@g.us')) {
            // Jika group JID, gunakan langsung
            jid = number;
        } else {
            const formattedNumber = formatPhoneNumber(number);
            jid = `${formattedNumber}@s.whatsapp.net`;
        }
        
        logger.debug(`📱 Formatted JID: ${jid}`);
        
        // Format pesan dengan header dan footer
        let formattedMessage;
        if (typeof message === 'string') {
            formattedMessage = { text: formatMessageWithHeaderFooter(message) };
        } else if (message.text) {
            formattedMessage = { text: formatMessageWithHeaderFooter(message.text) };
        } else {
            formattedMessage = message;
        }
        
        logger.info(`📱 Sending message to ${jid} via sock (fallback)...`);
        const result = await sock.sendMessage(jid, formattedMessage);
        logger.info(`✅ WhatsApp message sent successfully to ${number} via sock`);
        
        // Handle response dari Baileys (bisa memiliki key.id)
        return { 
            success: true, 
            message: 'Pesan berhasil dikirim',
            messageId: result?.key?.id || null
        };
    } catch (error) {
        logger.error('❌ Error sending message:', error);
        return { success: false, error: error.message || 'Gagal mengirim pesan' };
    }
}

// Fungsi untuk mengirim pesan ke grup nomor (menggunakan provider manager)
async function sendGroupMessage(numbers, message) {
    try {
        const results = [];
        let sent = 0;
        let failed = 0;

        // Parse numbers jika berupa string
        let numberArray = numbers;
        if (typeof numbers === 'string') {
            numberArray = numbers.split(',').map(n => n.trim());
        }

        // Coba gunakan provider manager dulu
        try {
            const providerManager = getProviderManager();
            if (providerManager && providerManager.isInitialized()) {
                const provider = providerManager.getProvider();
                if (provider) {
                    logger.info(`📱 Sending group message via provider (${providerManager.getProviderType()})`);
                    
                    for (const number of numberArray) {
                        try {
                            // Validasi dan format nomor
                            let cleanNumber = number.replace(/\D/g, '');
                            
                            // Jika dimulai dengan 0, ganti dengan 62
                            if (cleanNumber.startsWith('0')) {
                                cleanNumber = '62' + cleanNumber.substring(1);
                            }
                            
                            // Jika tidak dimulai dengan 62, tambahkan
                            if (!cleanNumber.startsWith('62')) {
                                cleanNumber = '62' + cleanNumber;
                            }
                            
                            // Validasi panjang nomor (minimal 10 digit setelah 62)
                            if (cleanNumber.length < 12) {
                                logger.warn(`Skipping invalid WhatsApp number: ${number} (too short)`);
                                failed++;
                                results.push({ number, success: false, error: 'Invalid number format' });
                                continue;
                            }

                            // Kirim pesan via provider
                            const result = await provider.sendMessage(cleanNumber, formatMessageWithHeaderFooter(message));
                            if (result && result.success) {
                                logger.info(`✅ Message sent to: ${cleanNumber} via provider`);
                                sent++;
                                results.push({ number: cleanNumber, success: true });
                            } else {
                                logger.warn(`⚠️ Failed to send to ${cleanNumber}: ${result?.error || 'Unknown error'}`);
                                failed++;
                                results.push({ number: cleanNumber, success: false, error: result?.error || 'Failed to send' });
                            }
                            
                            // Delay antar pesan untuk rate limiting
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        } catch (error) {
                            logger.error(`Error sending message to ${number}:`, error.message);
                            failed++;
                            results.push({ number, success: false, error: error.message });
                        }
                    }
                    
                    return {
                        success: sent > 0,
                        sent,
                        failed,
                        results
                    };
                }
            }
        } catch (providerError) {
            logger.warn(`⚠️ Provider error, falling back to sock: ${providerError.message}`);
        }

        // Fallback ke sock langsung untuk backward compatibility
        if (!sock) {
            logger.error('Sock instance not set and provider not available');
            return { success: false, sent: 0, failed: numberArray.length, results: [] };
        }

        for (const number of numberArray) {
            try {
                // Validasi dan format nomor
                let cleanNumber = number.replace(/\D/g, '');
                
                // Jika dimulai dengan 0, ganti dengan 62
                if (cleanNumber.startsWith('0')) {
                    cleanNumber = '62' + cleanNumber.substring(1);
                }
                
                // Jika tidak dimulai dengan 62, tambahkan
                if (!cleanNumber.startsWith('62')) {
                    cleanNumber = '62' + cleanNumber;
                }
                
                // Validasi panjang nomor (minimal 10 digit setelah 62)
                if (cleanNumber.length < 12) {
                    logger.warn(`Skipping invalid WhatsApp number: ${number} (too short)`);
                    failed++;
                    results.push({ number, success: false, error: 'Invalid number format' });
                    continue;
                }

                // Cek apakah nomor terdaftar di WhatsApp (hanya untuk Baileys)
                if (sock.onWhatsApp) {
                    const [result] = await sock.onWhatsApp(cleanNumber);
                    if (!result || !result.exists) {
                        logger.warn(`Skipping invalid WhatsApp number: ${cleanNumber} (not registered)`);
                        failed++;
                        results.push({ number: cleanNumber, success: false, error: 'Not registered on WhatsApp' });
                        continue;
                    }
                }

                // Kirim pesan
                await sock.sendMessage(`${cleanNumber}@s.whatsapp.net`, { text: formatMessageWithHeaderFooter(message) });
                logger.info(`✅ Message sent to: ${cleanNumber} via sock`);
                sent++;
                results.push({ number: cleanNumber, success: true });

            } catch (error) {
                logger.error(`Error sending message to ${number}:`, error.message);
                failed++;
                results.push({ number, success: false, error: error.message });
            }
        }

        return {
            success: sent > 0,
            sent,
            failed,
            results
        };
    } catch (error) {
        logger.error('Error in sendGroupMessage:', error);
        return { success: false, sent: 0, failed: numberArray ? numberArray.length : 0, results: [] };
    }
}

// Fungsi untuk mengirim pesan ke grup teknisi
async function sendTechnicianMessage(message, priority = 'normal') {
    try {
        // Ambil daftar teknisi dari database dengan whatsapp_group_id
        const sqlite3 = require('sqlite3').verbose();
        const path = require('path');

        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);

        const technicians = await new Promise((resolve, reject) => {
            const query = `
                SELECT phone, name, role, whatsapp_group_id
                FROM technicians
                WHERE is_active = 1
                ORDER BY role, name
            `;

            db.all(query, [], (err, rows) => {
                db.close();
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        const technicianNumbers = technicians.map(tech => tech.phone);
        const technicianGroupId = getSetting('technician_group_id', '');
        let sentToGroup = false;
        let sentToNumbers = false;
        let sentToIndividualGroups = false;

        // Penambahan prioritas pesan
        let priorityIcon = '';
        if (priority === 'high') {
            priorityIcon = '🟠 *PENTING* ';
        } else if (priority === 'low') {
            priorityIcon = '🟢 *Info* ';
        }
        const priorityMessage = priorityIcon + message;

        // 1. Kirim ke grup utama (dari settings.json) jika ada
        if (technicianGroupId) {
            try {
                await sendMessage(technicianGroupId, priorityMessage);
                sentToGroup = true;
                console.log(`✅ Pesan dikirim ke grup teknisi utama: ${technicianGroupId}`);
            } catch (e) {
                console.error('❌ Gagal mengirim ke grup teknisi utama:', e);
            }
        }

        // 2. Kirim ke grup individual teknisi jika ada
        const techniciansWithGroups = technicians.filter(tech => tech.whatsapp_group_id && tech.whatsapp_group_id.trim() !== '');
        if (techniciansWithGroups.length > 0) {
            console.log(`📱 Mengirim ke ${techniciansWithGroups.length} grup teknisi individual...`);

            for (const tech of techniciansWithGroups) {
                try {
                    await sendMessage(tech.whatsapp_group_id, priorityMessage);
                    console.log(`✅ Pesan dikirim ke grup ${tech.name}: ${tech.whatsapp_group_id}`);
                    sentToIndividualGroups = true;
                } catch (e) {
                    console.error(`❌ Gagal mengirim ke grup ${tech.name} (${tech.whatsapp_group_id}):`, e);
                }
            }
        }

        // 3. Kirim ke nomor teknisi individual jika ada
        if (technicianNumbers && technicianNumbers.length > 0) {
            console.log(`📤 Mengirim ke ${technicianNumbers.length} nomor teknisi: ${technicianNumbers.join(', ')}`);
            const result = await sendGroupMessage(technicianNumbers, priorityMessage);
            sentToNumbers = result.success;
            console.log(`📊 Hasil pengiriman ke nomor teknisi: ${result.sent} berhasil, ${result.failed} gagal`);

            if (result.sent > 0) {
                sentToNumbers = true;
            }
        } else {
            console.log(`⚠️ Tidak ada nomor teknisi yang terdaftar, fallback ke admin`);
            // Jika tidak ada nomor teknisi, fallback ke admin
            const adminNumber = getSetting('admins.0', '');
            if (adminNumber) {
                console.log(`📤 Fallback: Mengirim ke admin ${adminNumber}`);
                const adminResult = await sendMessage(adminNumber, priorityMessage);
                sentToNumbers = adminResult;
                console.log(`📊 Hasil fallback admin: ${adminResult ? 'berhasil' : 'gagal'}`);
            } else {
                console.log(`❌ Tidak ada admin number yang tersedia untuk fallback`);
            }
        }

        const overallSuccess = sentToGroup || sentToIndividualGroups || sentToNumbers;

        console.log(`\n📊 RINGKASAN PENGIRIMAN TEKNISI:`);
        console.log(`   - Grup utama: ${sentToGroup ? '✅' : '❌'}`);
        console.log(`   - Grup individual: ${sentToIndividualGroups ? '✅' : '❌'} (${techniciansWithGroups.length} grup)`);
        console.log(`   - Nomor individual: ${sentToNumbers ? '✅' : '❌'} (${technicianNumbers.length} nomor)`);
        console.log(`   - Status keseluruhan: ${overallSuccess ? '✅ BERHASIL' : '❌ GAGAL'}`);

        return overallSuccess;
    } catch (error) {
        console.error('Error sending message to technician group:', error);
        return false;
    }
}

module.exports = {
    setSock,
    sendMessage,
    sendGroupMessage,
    sendTechnicianMessage,
    formatMessageWithHeaderFooter,
    getHeaderFooter
};
