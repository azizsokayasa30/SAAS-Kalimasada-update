const { getSetting } = require('./settingsManager');
const { sendMessage, formatMessageWithHeaderFooter } = require('./sendMessage');
const { findDeviceByTag } = require('./addWAN');
const axios = require('axios');

// Import sock dari whatsapp.js
let sock = null;
const MIN_MONITORING_INTERVAL_MS = 10 * 1000;

// Fungsi untuk set sock instance
function setSock(sockInstance) {
    sock = sockInstance;
}

// Fungsi untuk mengecek status nomor teknisi
async function checkTechnicianNumbers() {
  try {
    const { getTechnicianNumbers } = require('./adminControl');
    const technicianNumbers = getTechnicianNumbers();
    
    console.log('📱 Checking technician numbers status...');
    
    if (!technicianNumbers || technicianNumbers.length === 0) {
      console.warn('⚠️ Tidak ada nomor teknisi dikonfigurasi');
      return;
    }
    
    for (const number of technicianNumbers) {
      const cleanNumber = number.replace(/\D/g, '');
      console.log(`📞 Checking: ${cleanNumber}`);
      
      try {
        if (sock) {
          const [result] = await sock.onWhatsApp(cleanNumber.replace(/^0/, '62'));
          if (result && result.exists) {
            console.log(`✅ ${cleanNumber} - Valid WhatsApp`);
          } else {
            console.warn(`❌ ${cleanNumber} - Tidak terdaftar di WhatsApp`);
          }
        } else {
          console.warn(`⚠️ ${cleanNumber} - Sock not available for validation`);
        }
      } catch (error) {
        console.error(`❌ ${cleanNumber} - Error: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('❌ Error checking technician numbers:', error.message);
  }
}

// Cache untuk tracking notifikasi per device
const notificationCache = {};

// Helper untuk mendapatkan parameter RX Power
function getParameterWithPaths(device, paths) {
  for (const path of paths) {
    const parts = path.split('.');
    let value = device;
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
        if (value && value._value !== undefined) value = value._value;
      } else {
        value = undefined;
        break;
      }
    }
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return 'N/A';
}

// Parameter paths untuk RX Power
const parameterPaths = {
  rxPower: [
    'VirtualParameters.RXPower',
    'VirtualParameters.redaman',
    'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower'
  ]
};

function scopedCachePrefix() {
  try {
    const { hasTenantContext, getTenantId } = require('./platform/tenantContext');
    if (hasTenantContext()) return `${getTenantId()}:`;
  } catch (_) { /* ignore */ }
  return '';
}

function scopedNumber(key, fallback) {
  const { readScopedSetting } = require('./whatsappMonitoringSettings');
  const parsed = parseFloat(readScopedSetting(key, fallback));
  return Number.isFinite(parsed) ? parsed : parseFloat(fallback);
}

// Fungsi untuk mengecek RX Power dan mengirim notifikasi
async function checkRXPowerAndNotify(options = {}) {
  if (!options.scoped) {
    try {
      const { hasTenantContext } = require('./platform/tenantContext');
      if (!hasTenantContext()) {
        const { runForEnabledTenants, claimTenantMonitorRun } = require('./whatsappMonitoringSettings');
        const seenUrls = new Set();
        await runForEnabledTenants('rx_power_threshold_wa', async (tenant) => {
          const hours = scopedNumber('rx_power_notification_interval_hours', '1');
          const gap = Math.max((hours > 0 ? hours : 1) * 60 * 60 * 1000, 60 * 1000);
          if (!claimTenantMonitorRun(tenant && tenant.id, 'rx_power_threshold_wa', gap)) return;
          let url = '';
          try {
            url = String(require('./genieacs').getConfiguredGenieacsUrlFromSettings() || '');
          } catch (_) { url = ''; }
          const fingerprint = url || `tenant:${tenant && tenant.id}`;
          if (seenUrls.has(fingerprint)) return;
          seenUrls.add(fingerprint);
          try {
            const { resetMikrotikConnectionCache } = require('./mikrotik');
            resetMikrotikConnectionCache();
          } catch (_) { /* optional */ }
          await checkRXPowerAndNotify({ scoped: true });
        });
        return;
      }
    } catch (err) {
      console.error('❌ Error scoping RX Power check:', err.message);
    }
  }

  try {
    const { isWaSystemMonitorEnabled } = require('./whatsappMonitoringSettings');
    if (!(await isWaSystemMonitorEnabled('rx_power_threshold_wa'))) {
      console.log('📊 RX Power WA monitoring is disabled for this tenant');
      return;
    }
  } catch (_) { /* lanjut jika modul tidak tersedia */ }

  try {
    console.log('📊 Checking RX Power for all devices...');
    
    // Ambil device dari GenieACS tenant ini bila URL-nya tersimpan di tenant.
    let genieacsUrl = getSetting('genieacs_url', 'http://localhost:7557');
    let username = getSetting('genieacs_username', '');
    let password = getSetting('genieacs_password', '');
    try {
      const { hasTenantContext } = require('./platform/tenantContext');
      if (hasTenantContext()) {
        const scopedUrl = require('./genieacs').getConfiguredGenieacsUrlFromSettings();
        if (scopedUrl) genieacsUrl = scopedUrl;
        const { getTenantSetting } = require('./platform/tenantSettings');
        const scopedUser = getTenantSetting('genieacs_username', '');
        const scopedPass = getTenantSetting('genieacs_password', '');
        if (scopedUser) username = scopedUser;
        if (scopedPass) password = scopedPass;
      }
    } catch (_) { /* pakai nilai di atas */ }
    
    // Gunakan axios sebagai pengganti fetch
    const response = await axios.get(`${genieacsUrl}/devices`, {
      auth: {
        username: username,
        password: password
      },
      timeout: 10000 // 10 detik timeout
    });
    
    const devices = response.data;
    
    const warningThreshold = scopedNumber('rx_power_warning', '-35');
    const criticalThreshold = scopedNumber('rx_power_critical', '-37');
    
    console.log(`📊 Checking ${devices.length} devices with thresholds: Warning=${warningThreshold}dBm, Critical=${criticalThreshold}dBm`);
    
    // Cek setiap device
    for (const device of devices) {
      try {
        const deviceId = device._id;
        const rxPower = getParameterWithPaths(device, parameterPaths.rxPower);
        
        // Skip jika RX Power tidak tersedia
        if (rxPower === 'N/A' || rxPower === null || rxPower === undefined) {
          continue;
        }
        
        const rxPowerValue = parseFloat(rxPower);
        
        // Cek apakah RX Power melebihi threshold
        if (rxPowerValue <= criticalThreshold) {
          await sendCriticalNotification(device, rxPowerValue, criticalThreshold);
        } else if (rxPowerValue <= warningThreshold) {
          await sendWarningNotification(device, rxPowerValue, warningThreshold);
        }
      } catch (deviceError) {
        console.error(`❌ Error processing device ${device._id}:`, deviceError.message);
        continue; // Lanjut ke device berikutnya
      }
    }
    
  } catch (error) {
    console.error('❌ Error checking RX Power:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.log('💡 GenieACS server tidak dapat diakses. Pastikan server berjalan.');
    }
  }
}

// Fungsi untuk mengirim notifikasi critical
async function sendCriticalNotification(device, rxPowerValue, threshold) {
  const deviceId = device._id;
  const cacheKey = `${scopedCachePrefix()}${deviceId}_critical`;
  const now = Date.now();
  
  // Ambil interval dalam jam, konversi ke milidetik (untuk caching notification)
  const intervalHours = scopedNumber('rx_power_notification_interval_hours', '1');
  const interval = intervalHours * 60 * 60 * 1000; // Convert hours to milliseconds
  
  // Cek apakah sudah pernah notifikasi dalam interval waktu
  if (notificationCache[cacheKey] && (now - notificationCache[cacheKey]) < interval) {
    return;
  }
  
  // Update cache
  notificationCache[cacheKey] = now;
  
  // Ambil info device
  const serialNumber = device?.DeviceID?.SerialNumber || device?._id || 'Unknown';
  const tags = Array.isArray(device?._tags) && device._tags.length > 0 ? device._tags : (device?.Tags || []);
  const phoneNumber = tags.find(tag => /^08\d{8,13}$/.test(tag)) || '-';
  // Ambil PPPoE Username
  const pppoeUsername = device.VirtualParameters?.pppoeUsername?._value || device.InternetGatewayDevice?.WANDevice?.[1]?.WANConnectionDevice?.[1]?.WANPPPConnection?.[1]?.Username?._value || device.InternetGatewayDevice?.WANDevice?.[0]?.WANConnectionDevice?.[0]?.WANPPPConnection?.[0]?.Username?._value || '-';
  // Buat pesan notifikasi
  const message = `🚨 *RX POWER CRITICAL ALERT*\n\n` +
    `Device: ${serialNumber}\n` +
    `PPPoE: ${pppoeUsername}\n` +
    `Phone: ${phoneNumber}\n` +
    `RX Power: ${rxPowerValue} dBm\n` +
    `Threshold: ${threshold} dBm\n\n` +
    `⚠️ RX Power sudah melewati batas kritis!\n` +
    `Segera lakukan pengecekan dan perbaikan.`;
  
  // Format pesan dengan header dan footer
  await sendToTechnicians(message, 'high');
  
  console.log(`🚨 Critical RX Power alert sent for device ${serialNumber} (${rxPowerValue} dBm)`);
}

// Fungsi untuk mengirim notifikasi warning
async function sendWarningNotification(device, rxPowerValue, threshold) {
  const deviceId = device._id;
  const cacheKey = `${scopedCachePrefix()}${deviceId}_warning`;
  const now = Date.now();
  
  // Ambil interval dalam jam, konversi ke milidetik (untuk caching notification)
  const intervalHours = scopedNumber('rx_power_notification_interval_hours', '1');
  const interval = intervalHours * 60 * 60 * 1000; // Convert hours to milliseconds
  
  // Cek apakah sudah pernah notifikasi dalam interval waktu
  if (notificationCache[cacheKey] && (now - notificationCache[cacheKey]) < interval) {
    return;
  }
  
  // Update cache
  notificationCache[cacheKey] = now;
  
  // Ambil info device
  const serialNumber = device?.DeviceID?.SerialNumber || device?._id || 'Unknown';
  const tags = Array.isArray(device?._tags) && device._tags.length > 0 ? device._tags : (device?.Tags || []);
  const phoneNumber = tags.find(tag => /^08\d{8,13}$/.test(tag)) || '-';
  // Ambil PPPoE Username
  const pppoeUsername = device.VirtualParameters?.pppoeUsername?._value || device.InternetGatewayDevice?.WANDevice?.[1]?.WANConnectionDevice?.[1]?.WANPPPConnection?.[1]?.Username?._value || device.InternetGatewayDevice?.WANDevice?.[0]?.WANConnectionDevice?.[0]?.WANPPPConnection?.[0]?.Username?._value || '-';
  // Buat pesan notifikasi
  const message = `⚠️ *RX POWER WARNING*\n\n` +
    `Device: ${serialNumber}\n` +
    `PPPoE: ${pppoeUsername}\n` +
    `Phone: ${phoneNumber}\n` +
    `RX Power: ${rxPowerValue} dBm\n` +
    `Threshold: ${threshold} dBm\n\n` +
    `RX Power mendekati batas kritis. Harap segera cek perangkat.`;
  
  // Format pesan dengan header dan footer
  await sendToTechnicians(message, 'normal');
  
  console.log(`⚠️ Warning RX Power alert sent for device ${serialNumber} (${rxPowerValue} dBm)`);
}

// Fungsi untuk mengirim pesan ke teknisi
async function sendToTechnicians(message, priority = 'normal') {
  try {
    try {
      const { isWaSystemMonitorEnabled } = require('./whatsappMonitoringSettings');
      if (!(await isWaSystemMonitorEnabled('rx_power_threshold_wa'))) {
        console.log('Master switch rx_power_threshold_wa off — skip RX power WA ke teknisi');
        return;
      }
    } catch (_) { /* ignore */ }

    // Ambil nomor teknisi dari adminControl helper agar kompatibel semua format
    const { getTechnicianNumbers } = require('./adminControl');
    const technicianNumbers = getTechnicianNumbers();
    const technicianGroupId = getSetting('technician_group_id', '');
    
    // Tambahkan prefix prioritas (tanpa header karena sudah diformat)
    let priorityMessage = message;
    if (priority === 'high') {
      // Tambahkan prefix PENTING di awal pesan (setelah header)
      const lines = message.split('\n');
      if (lines.length > 2) {
        lines.splice(2, 0, '🚨 *PENTING*');
        priorityMessage = lines.join('\n');
      } else {
        priorityMessage = '🚨 *PENTING*\n' + message;
      }
    }
    
    // Kirim ke grup teknisi jika ada
    if (technicianGroupId) {
      try {
        // Validasi group ID terlebih dahulu
        if (!technicianGroupId.includes('@g.us')) {
          console.error('❌ Invalid technician group ID format. Must end with @g.us');
        } else {
          await sendMessage(technicianGroupId, priorityMessage);
          console.log(`📤 Message sent to technician group`);
        }
      } catch (e) {
        if (e.message.includes('item-not-found')) {
          console.error('❌ Technician group not found. Please check group ID or add bot to group');
        } else {
          console.error('❌ Failed to send to technician group:', e.message);
        }
      }
    }
    
    // Kirim ke nomor teknisi individual
    if (technicianNumbers && technicianNumbers.length > 0) {
      for (const number of technicianNumbers) {
        try {
          const cleanNumber = number.replace(/\D/g, '');
          if (cleanNumber) {
            // Validasi nomor WhatsApp
            const waJid = cleanNumber.replace(/^0/, '62') + '@s.whatsapp.net';
            
            // Cek apakah nomor ada di WhatsApp
            try {
              if (sock) {
                const [result] = await sock.onWhatsApp(cleanNumber.replace(/^0/, '62'));
                if (!result || !result.exists) {
                  console.warn(`⚠️ Nomor ${cleanNumber} tidak terdaftar di WhatsApp`);
                  continue;
                }
                console.log(`✅ Nomor ${cleanNumber} valid di WhatsApp`);
              } else {
                console.warn(`⚠️ Skipping validation for ${cleanNumber}: sock not available`);
                // Lanjutkan pengiriman meskipun validasi tidak tersedia
              }
            } catch (validationError) {
              console.warn(`⚠️ Error validating number ${cleanNumber}: ${validationError.message}`);
              // Lanjutkan pengiriman meskipun validasi gagal
            }
            
            await sendMessage(waJid, priorityMessage);
            console.log(`📤 Message sent to technician ${cleanNumber}`);
          }
        } catch (e) {
          console.error(`❌ Failed to send to technician ${number}:`, e.message);
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Error sending to technicians:', error.message);
  }
}

// Fungsi untuk memulai monitoring RX Power
function startRXPowerMonitoring() {
  const interval = 60 * 1000;
  console.log('📊 Starting RX Power monitoring (per-tenant toggle, poll 60s)');
  
  // Jalankan pengecekan pertama dengan delay
  setTimeout(() => {
    checkRXPowerAndNotify().catch(err => {
      console.error('❌ Error in initial RX Power check:', err.message);
    });
  }, 10000); // Delay 10 detik setelah startup
  
  // Set interval untuk pengecekan berkala
  setInterval(() => {
    checkRXPowerAndNotify().catch(err => {
      console.error('❌ Error in periodic RX Power check:', err.message);
    });
  }, interval);
}

module.exports = {
  checkRXPowerAndNotify,
  startRXPowerMonitoring,
  sendToTechnicians,
  setSock,
  checkTechnicianNumbers
}; 