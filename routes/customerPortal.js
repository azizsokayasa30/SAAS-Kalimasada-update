const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { findDeviceByTag } = require('../config/addWAN');
const { findDeviceByPPPoE } = require('../config/genieacs');
const { sendMessage } = require('../config/sendMessage');
const { getSettingsWithCache, getSetting } = require('../config/settingsManager');
const billingManager = require('../config/billing');
const router = express.Router();

const { createSafeImageUpload } = require('../utils/safeImageUpload');

const customerPhotoUpload = createSafeImageUpload({
    destination: path.join(__dirname, '../public/uploads/customers'),
    maxBytes: 5 * 1024 * 1024,
    filename: function (req, file, ext, cb) {
        const phone = req.body.phone ? String(req.body.phone).replace(/\D/g, '') : String(Date.now());
        const type = file.fieldname === 'ktp_photo' ? 'ktp' : 'house';
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `customer-${phone}-${type}-${uniqueSuffix}${ext}`);
    }
});

// Phone helpers: normalize and variants (08..., 62..., +62...)
function normalizePhone(input) {
  if (!input) return '';
  let s = String(input).replace(/[^0-9+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0')) return '62' + s.slice(1);
  if (s.startsWith('62')) return s;
  // Fallback: if it looks like local without leading 0, prepend 62
  if (/^8[0-9]{7,13}$/.test(s)) return '62' + s;
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

// Validasi nomor member
async function isValidMember(phone) {
  try {
    const variants = generatePhoneVariants(phone);
    console.log(`🔍 [VALIDATION] Checking member with phone variants:`, variants);
    
    for (const v of variants) {
      try {
        const member = await billingManager.getMemberByPhone(v);
        if (member) {
          console.log(`✅ [VALIDATION] Member found in billing database: ${v} (input: ${phone})`);
          return true;
        }
      } catch (error) {
        console.log(`⚠️ [VALIDATION] Error checking member variant ${v}:`, error.message);
      }
    }
    return false;
  } catch (error) {
    console.error('❌ [VALIDATION] Error in isValidMember:', error);
    return false;
  }
}

// Validasi nomor pelanggan - PRIORITAS KE BILLING SYSTEM
async function isValidCustomer(phone) {
  try {
    // 1. Cek di database billing terlebih dahulu (coba semua varian)
    const variants = generatePhoneVariants(phone);
    console.log(`🔍 [VALIDATION] Checking customer with phone variants:`, variants);
    
    for (const v of variants) {
      try {
        const customer = await billingManager.getCustomerByPhone(v);
        if (customer) {
          console.log(`✅ [VALIDATION] Customer found in billing database: ${v} (input: ${phone})`);
          return true; // Pelanggan valid jika ada di billing
        }
      } catch (error) {
        console.log(`⚠️ [VALIDATION] Error checking variant ${v}:`, error.message);
      }
    }
    
    // Check member as fallback
    const isMember = await isValidMember(phone);
    if (isMember) {
      console.log(`✅ [VALIDATION] Member found in billing database: ${phone}`);
      return true;
    }
    
    // 2. Jika tidak ada di billing, cek di GenieACS sebagai fallback dengan semua varian
    let device = null;
    for (const v of variants) {
      try {
        device = await findDeviceByTag(v);
        if (device) {
          console.log(`✅ [VALIDATION] Device found in GenieACS with tag: ${v}`);
          break;
        }
      } catch (error) {
        console.log(`⚠️ [VALIDATION] Error searching GenieACS with tag ${v}:`, error.message);
      }
    }
    
    // Jika tidak ditemukan di GenieACS, coba cari berdasarkan PPPoE username dari billing
    if (!device) {
      try {
        // Coba lagi dengan semua varian phone untuk PPPoE search
        for (const v of variants) {
          const customer = await billingManager.getCustomerByPhone(v);
          if (customer && customer.pppoe_username) {
            const { findDeviceByPPPoE } = require('../config/genieacs');
            device = await findDeviceByPPPoE(customer.pppoe_username);
            if (device) {
              console.log(`✅ [VALIDATION] Device found by PPPoE username: ${customer.pppoe_username} (phone: ${v})`);
              break;
            }
          }
        }
      } catch (error) {
        console.error('❌ [VALIDATION] Error finding device by PPPoE username:', error);
      }
    }
    
    if (device) {
      console.log(`✅ [VALIDATION] Customer found in GenieACS: ${phone}`);
      return true;
    }
    
    console.log(`❌ [VALIDATION] Customer not found in billing or GenieACS: ${phone}`);
    return false;
    
  } catch (error) {
    console.error('❌ [VALIDATION] Error in isValidCustomer:', error);
    return false;
  }
}

// Simpan OTP sementara di memory (bisa diganti redis/db)
const otpStore = {};

// parameterPaths dan getParameterWithPaths dari WhatsApp bot
const parameterPaths = {
  rxPower: [
    'VirtualParameters.RXPower',
    'VirtualParameters.redaman',
    'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_ALU-COM_RxPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.RxPower',
    'Device.Optical.Interface.1.RxPower'
  ],
  pppoeIP: [
    'VirtualParameters.pppoeIP',
    'VirtualParameters.pppIP',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
    'Device.PPP.Interface.1.IPCPExtensions.RemoteIPAddress'
  ],
  pppUsername: [
    'VirtualParameters.pppoeUsername',
    'VirtualParameters.pppUsername',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
    'Device.PPP.Interface.1.Username'
  ],
  uptime: [
    'VirtualParameters.getdeviceuptime',
    'InternetGatewayDevice.DeviceInfo.UpTime',
    'Device.DeviceInfo.UpTime'
  ],
  softwareVersion: [
    'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
    'Device.DeviceInfo.SoftwareVersion',
    'VirtualParameters.softwareVersion'
  ],
  userConnected: [
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
    'VirtualParameters.activedevices',
    'Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries'
  ]
};
function getParameterWithPaths(device, paths) {
  for (const path of paths) {
    const parts = path.split('.');
    let value = device;
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
        // Handle GenieACS VirtualParameters structure yang menggunakan _value
        if (value && typeof value === 'object' && value._value !== undefined) {
          value = value._value;
        }
      } else {
        value = undefined;
        break;
      }
    }
    // Return value jika valid (bukan undefined, null, atau empty string)
    if (value !== undefined && value !== null && value !== '') {
      // Convert to string jika perlu, tapi pertahankan angka untuk RX Power
      return value;
    }
  }
  return '-';
}

// Helper: Ambil info perangkat dan user terhubung - PRIORITAS KE BILLING SYSTEM
async function getCustomerDeviceData(phone) {
  try {
    // 1. Ambil data customer dari billing terlebih dahulu (coba semua varian phone)
    let customer = null;
    const phoneVariants = generatePhoneVariants(phone);
    
    console.log(`🔍 [SEARCH] Searching customer with phone variants:`, phoneVariants);
    
    for (const variant of phoneVariants) {
      try {
        customer = await billingManager.getCustomerByPhone(variant);
        if (customer) {
          console.log(`✅ [SEARCH] Customer found in billing with variant: ${variant}`);
          console.log(`📋 [SEARCH] Customer data:`, {
            name: customer.name,
            phone: customer.phone,
            username: customer.username,
            pppoe_username: customer.pppoe_username,
            package_id: customer.package_id
          });
          break;
        }
      } catch (error) {
        console.log(`⚠️ [SEARCH] Error searching with variant ${variant}:`, error.message);
      }
    }
    
    let device = null;
    let billingData = null;
    
    if (customer) {
      console.log(`✅ Customer found in billing: ${customer.name} (${customer.phone}) - searched with: ${phone}`);
      
      // 2. CUSTOMER BILLING: Cari device berdasarkan PPPoE username (FAST PATH)
      if (customer.pppoe_username || customer.username) {
        try {
          const { findDeviceByPPPoE, testPPPoEUsernameSearch } = require('../config/genieacs');
          const pppoeToSearch = customer.pppoe_username || customer.username;
          console.log(`🔍 [BILLING] Searching device by PPPoE username: ${pppoeToSearch}`);
          console.log(`📋 [BILLING] Customer data:`, {
            name: customer.name,
            phone: customer.phone,
            username: customer.username,
            pppoe_username: customer.pppoe_username,
            package_id: customer.package_id
          });
          
          // Debug: cek apakah username yang dicari benar
          console.log(`🔍 [BILLING] Will search for username: "${pppoeToSearch}"`);
          console.log(`🔍 [BILLING] Customer.pppoe_username: "${customer.pppoe_username}"`);
          console.log(`🔍 [BILLING] Customer.username: "${customer.username}"`);
          
          // Test langsung untuk username server@ilik jika ini customer yang dimaksud
          if (pppoeToSearch === 'server@ilik' || customer.pppoe_username === 'server@ilik' || customer.username === 'server@ilik') {
            console.log(`🧪 [TEST] Testing direct search for server@ilik...`);
            try {
              const testResult = await testPPPoEUsernameSearch('server@ilik');
              if (testResult) {
                console.log(`✅ [TEST] Direct test successful for server@ilik`);
                device = testResult;
              } else {
                console.log(`❌ [TEST] Direct test failed for server@ilik`);
              }
            } catch (testError) {
              console.error('❌ [TEST] Direct test error:', testError.message);
            }
          }
          
          // Jika test tidak berhasil, coba search normal (dengan customer untuk multi-server)
          if (!device) {
            try {
              device = await findDeviceByPPPoE(pppoeToSearch, customer);
              if (device) {
                console.log(`✅ [BILLING] Device found by PPPoE username: ${pppoeToSearch}`);
                console.log(`📱 [BILLING] Device details:`, {
                  id: device._id,
                  serialNumber: device.DeviceID?.SerialNumber,
                  model: device.DeviceID?.ProductClass,
                  lastInform: device._lastInform
                });
              } else {
                console.log(`⚠️ [BILLING] No device found by PPPoE username: ${pppoeToSearch}`);
              }
            } catch (pppoeError) {
              console.error(`❌ [BILLING] Error finding device by PPPoE username ${pppoeToSearch}:`, pppoeError.message);
              // Continue dengan fallback ke tag search
            }
          }
        } catch (error) {
          console.error('❌ [BILLING] Error finding device by PPPoE username:', error.message);
          console.error('❌ [BILLING] Full error:', error);
        }
      } else {
        console.log(`⚠️ [BILLING] No PPPoE username or username found in customer data`);
        console.log(`📋 [BILLING] Customer fields:`, Object.keys(customer));
        console.log(`📋 [BILLING] Customer.pppoe_username: "${customer.pppoe_username}"`);
        console.log(`📋 [BILLING] Customer.username: "${customer.username}"`);
      }
      
      // 3. Jika tidak ditemukan dengan PPPoE, coba dengan tag sebagai fallback
      if (!device) {
        console.log(`🔍 [BILLING] Trying tag search as fallback...`);
        const tagVariants = generatePhoneVariants(phone);
        
        for (const v of tagVariants) {
          try {
            device = await findDeviceByTag(v);
            if (device) {
              console.log(`✅ [BILLING] Device found by tag fallback: ${v}`);
              break;
            }
          } catch (error) {
            console.log(`⚠️ Error searching by tag ${v}:`, error.message);
          }
        }
      }
      
      // 4. Siapkan data billing
      try {
        const invoices = await billingManager.getInvoicesByCustomer(customer.id);
        billingData = {
          customer: customer,
          invoices: invoices || []
        };
      } catch (error) {
        console.error('Error getting billing data:', error);
        billingData = {
          customer: customer,
          invoices: []
        };
      }
      
    } else {
      // 5. CUSTOMER NON-BILLING: Cari device berdasarkan tag saja (FAST PATH)
      console.log(`⚠️ Customer not found in billing, searching GenieACS by tag only`);
      
      const tagVariants = generatePhoneVariants(phone);
      for (const v of tagVariants) {
        try {
          device = await findDeviceByTag(v);
          if (device) {
            console.log(`✅ [NON-BILLING] Device found by tag: ${v}`);
            break;
          }
        } catch (error) {
          console.log(`⚠️ Error searching by tag ${v}:`, error.message);
        }
      }
    }
    
    // 6. Jika tidak ada device di GenieACS, buat data default yang informatif
    if (!device) {
      console.log(`⚠️ No device found in GenieACS for: ${phone}`);
      
      const defaultData = {
        phone: phone,
        ssid: customer ? `WiFi-${customer.username}` : 'WiFi-Default',
        status: 'Unknown',
        lastInform: '-',
        softwareVersion: '-',
        rxPower: '-',
        pppoeIP: '-',
        pppoeUsername: customer ? (customer.pppoe_username || customer.username) : '-',
        totalAssociations: '0',
        connectedUsers: [],
        billingData: billingData,
        deviceFound: false,
        searchMethod: customer ? 'pppoe_username_fallback_tag' : 'tag_only',
        message: customer ? 
          'Device ONU tidak ditemukan di GenieACS. Silakan hubungi teknisi untuk setup device.' :
          'Customer tidak terdaftar di sistem billing. Silakan hubungi admin.'
      };
      
      return defaultData;
    }
    
    // 7. Jika ada device di GenieACS, ambil data lengkap
    console.log(`✅ Processing device data for: ${device._id}`);
    console.log(`📊 Device data structure:`, {
      hasVirtualParameters: !!device.VirtualParameters,
      virtualParamsKeys: device.VirtualParameters ? Object.keys(device.VirtualParameters) : [],
      hasInternetGatewayDevice: !!device.InternetGatewayDevice,
      lastInform: device._lastInform,
      // Debug: cek struktur RX Power
      rxPowerDirect: device?.VirtualParameters?.RXPower,
      rxPowerIGD: device?.InternetGatewayDevice?.WANDevice?.['1']?.WANPONInterfaceConfig?.RXPower,
      // Debug: cek struktur PPPoE IP
      pppoeIPDirect: device?.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.ExternalIPAddress,
      // Debug: cek Software Version
      softwareVersionIGD: device?.InternetGatewayDevice?.DeviceInfo?.SoftwareVersion
    });
    
    const ssid = device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.SSID?._value || 
                 device?.VirtualParameters?.SSID || 
                 (customer ? `WiFi-${customer.username}` : 'WiFi-Default');
    
    const lastInform = device?._lastInform
      ? new Date(device._lastInform).toLocaleString('id-ID')
      : device?.Events?.Inform
        ? new Date(device.Events.Inform).toLocaleString('id-ID')
        : device?.InternetGatewayDevice?.DeviceInfo?.['1']?.LastInform?._value
          ? new Date(device.InternetGatewayDevice.DeviceInfo['1'].LastInform._value).toLocaleString('id-ID')
          : '-';
    
    // Tentukan status berdasarkan lastInform (Online jika < 5 menit)
    let status = 'Unknown';
    if (device?._lastInform) {
      const lastInformTime = new Date(device._lastInform).getTime();
      const currentTime = Date.now();
      const diffMinutes = (currentTime - lastInformTime) / (1000 * 60);
      status = diffMinutes < 5 ? 'Online' : 'Offline';
    }
    
    // User terhubung (WiFi)
    let connectedUsers = [];
    try {
      const totalAssociations = getParameterWithPaths(device, parameterPaths.userConnected);
      if (totalAssociations && totalAssociations !== '-' && totalAssociations !== 'N/A' && totalAssociations > 0) {
        connectedUsers = Array.from({ length: parseInt(totalAssociations) }, (_, i) => ({
          id: i + 1,
          name: `User ${i + 1}`,
          ip: `192.168.1.${100 + i}`,
          mac: `00:00:00:00:00:${(i + 1).toString().padStart(2, '0')}`,
          connectedTime: 'Unknown'
        }));
      }
    } catch (error) {
      console.error('Error getting connected users:', error);
    }
    
    // Ambil data lengkap device - gunakan akses langsung seperti di adminGenieacs untuk konsistensi
    // Software Version - cek langsung di struktur device (VirtualParameters menggunakan _value jika ada)
    const softwareVersion = (device?.InternetGatewayDevice?.DeviceInfo?.SoftwareVersion?._value !== undefined && device?.InternetGatewayDevice?.DeviceInfo?.SoftwareVersion?._value !== null && device?.InternetGatewayDevice?.DeviceInfo?.SoftwareVersion?._value !== '') ? device.InternetGatewayDevice.DeviceInfo.SoftwareVersion._value :
                           (device?.Device?.DeviceInfo?.SoftwareVersion?._value !== undefined && device?.Device?.DeviceInfo?.SoftwareVersion?._value !== null && device?.Device?.DeviceInfo?.SoftwareVersion?._value !== '') ? device.Device.DeviceInfo.SoftwareVersion._value :
                           (device?.VirtualParameters?.softwareVersion?._value !== undefined && device?.VirtualParameters?.softwareVersion?._value !== null && device?.VirtualParameters?.softwareVersion?._value !== '') ? device.VirtualParameters.softwareVersion._value :
                           (device?.VirtualParameters?.softwareVersion !== undefined && device?.VirtualParameters?.softwareVersion !== null && device?.VirtualParameters?.softwareVersion !== '' && typeof device.VirtualParameters.softwareVersion !== 'object') ? device.VirtualParameters.softwareVersion :
                           getParameterWithPaths(device, parameterPaths.softwareVersion);
    
    // RX Power - cek langsung di struktur device dulu (VirtualParameters menggunakan _value)
    const rxPower = (device?.VirtualParameters?.RXPower?._value !== undefined && device?.VirtualParameters?.RXPower?._value !== null && device?.VirtualParameters?.RXPower?._value !== '') ? device.VirtualParameters.RXPower._value :
                    (device?.VirtualParameters?.redaman?._value !== undefined && device?.VirtualParameters?.redaman?._value !== null && device?.VirtualParameters?.redaman?._value !== '') ? device.VirtualParameters.redaman._value :
                    (device?.InternetGatewayDevice?.WANDevice?.['1']?.WANPONInterfaceConfig?.RXPower?._value !== undefined && device?.InternetGatewayDevice?.WANDevice?.['1']?.WANPONInterfaceConfig?.RXPower?._value !== null) ? device.InternetGatewayDevice.WANDevice['1'].WANPONInterfaceConfig.RXPower._value :
                    (device?.InternetGatewayDevice?.WANDevice?.['1']?.WANPONInterfaceConfig?.RXPower !== undefined && device?.InternetGatewayDevice?.WANDevice?.['1']?.WANPONInterfaceConfig?.RXPower !== null) ? device.InternetGatewayDevice.WANDevice['1'].WANPONInterfaceConfig.RXPower :
                    getParameterWithPaths(device, parameterPaths.rxPower);
    
    // PPPoE IP - akses langsung seperti di adminGenieacs (VirtualParameters menggunakan _value)
    const pppoeIP = (device?.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.ExternalIPAddress?._value !== undefined && device?.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.ExternalIPAddress?._value !== null && device?.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.ExternalIPAddress?._value !== '') ? device.InternetGatewayDevice.WANDevice['1'].WANConnectionDevice['1'].WANPPPConnection['1'].ExternalIPAddress._value :
                    (device?.VirtualParameters?.pppoeIP?._value !== undefined && device?.VirtualParameters?.pppoeIP?._value !== null && device?.VirtualParameters?.pppoeIP?._value !== '') ? device.VirtualParameters.pppoeIP._value :
                    (device?.VirtualParameters?.pppIP?._value !== undefined && device?.VirtualParameters?.pppIP?._value !== null && device?.VirtualParameters?.pppIP?._value !== '') ? device.VirtualParameters.pppIP._value :
                    (device?.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.ExternalIPAddress !== undefined && device?.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.ExternalIPAddress !== null) ? device.InternetGatewayDevice.WANDevice['1'].WANConnectionDevice['1'].WANPPPConnection['1'].ExternalIPAddress :
                    getParameterWithPaths(device, parameterPaths.pppoeIP);
    
    // Total Associations
    const totalAssociations = device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.TotalAssociations?._value ||
                              device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.TotalAssociations ||
                              device?.VirtualParameters?.activedevices?._value ||
                              device?.VirtualParameters?.activedevices ||
                              getParameterWithPaths(device, parameterPaths.userConnected) || '0';
    
    // Uptime - cek langsung di struktur device (VirtualParameters menggunakan _value)
    const uptime = (device?.InternetGatewayDevice?.DeviceInfo?.UpTime?._value !== undefined && device?.InternetGatewayDevice?.DeviceInfo?.UpTime?._value !== null && device?.InternetGatewayDevice?.DeviceInfo?.UpTime?._value !== '') ? device.InternetGatewayDevice.DeviceInfo.UpTime._value :
                   (device?.InternetGatewayDevice?.DeviceInfo?.['1']?.UpTime?._value !== undefined && device?.InternetGatewayDevice?.DeviceInfo?.['1']?.UpTime?._value !== null && device?.InternetGatewayDevice?.DeviceInfo?.['1']?.UpTime?._value !== '') ? device.InternetGatewayDevice.DeviceInfo['1'].UpTime._value :
                   (device?.VirtualParameters?.getdeviceuptime?._value !== undefined && device?.VirtualParameters?.getdeviceuptime?._value !== null && device?.VirtualParameters?.getdeviceuptime?._value !== '') ? device.VirtualParameters.getdeviceuptime._value :
                   (device?.VirtualParameters?.getdeviceuptime !== undefined && device?.VirtualParameters?.getdeviceuptime !== null && device?.VirtualParameters?.getdeviceuptime !== '' && typeof device.VirtualParameters.getdeviceuptime !== 'object') ? device.VirtualParameters.getdeviceuptime :
                   getParameterWithPaths(device, parameterPaths.uptime);
    
    console.log(`📋 Extracted device parameters:`, {
      softwareVersion,
      rxPower,
      pppoeIP,
      totalAssociations,
      uptime,
      status,
      hasVirtualParams: !!device.VirtualParameters,
      virtualKeys: device.VirtualParameters ? Object.keys(device.VirtualParameters) : []
    });
    
    const deviceData = {
      phone: phone,
      ssid: ssid,
      status: status,
      lastInform: lastInform,
      softwareVersion: softwareVersion,
      rxPower: rxPower,
      pppoeIP: pppoeIP,
      pppoeUsername: customer ? (customer.pppoe_username || customer.username) : 
                     getParameterWithPaths(device, parameterPaths.pppUsername),
      totalAssociations: totalAssociations,
      connectedUsers: connectedUsers,
      billingData: billingData,
      deviceFound: true,
      deviceId: device._id,
      serialNumber: device.DeviceID?.SerialNumber || device._id,
      model: device.DeviceID?.ProductClass || 
             device.InternetGatewayDevice?.DeviceInfo?.ModelName?._value || '-',
      uptime: uptime,
      searchMethod: customer ? 'pppoe_username' : 'tag',
      message: 'Device ONU ditemukan dan berfungsi normal'
    };
    
    return deviceData;
    
  } catch (error) {
    console.error('Error in getCustomerDeviceData:', error);
    
    // Return error data yang informatif
    return {
      phone: phone,
      ssid: 'Error',
      status: 'Error',
      lastInform: '-',
      softwareVersion: '-',
      rxPower: '-',
      pppoeIP: '-',
      pppoeUsername: '-',
      totalAssociations: '0',
      connectedUsers: [],
      billingData: null,
      deviceFound: false,
      error: error.message,
      message: 'Terjadi kesalahan saat mengambil data device. Silakan coba lagi atau hubungi teknisi.'
    };
  }
}

// Helper: Update SSID (real ke GenieACS) - Legacy
async function updateSSID(phone, newSSID) {
  try {
    // Cari device berdasarkan nomor telepon (tag)
    let device = await findDeviceByTag(phone);
    
    // Jika tidak ditemukan, coba cari berdasarkan PPPoE username dari billing
    if (!device) {
      try {
        const customer = await billingManager.getCustomerByPhone(phone);
        if (customer && customer.pppoe_username) {
          const { findDeviceByPPPoE } = require('../config/genieacs');
          device = await findDeviceByPPPoE(customer.pppoe_username);
        }
      } catch (error) {
        console.error('Error finding device by PPPoE username:', error);
      }
    }
    
    if (!device) return false;
    const deviceId = device._id;
    const encodedDeviceId = encodeURIComponent(deviceId);
    const settings = getSettingsWithCache();
    const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
    const username = settings.genieacs_username || '';
    const password = settings.genieacs_password || '';
    // Update SSID 2.4GHz
    await axios.post(
      `${genieacsUrl}/devices/${encodedDeviceId}/tasks?connection_request`,
      {
        name: "setParameterValues",
        parameterValues: [
          ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", newSSID, "xsd:string"]
        ]
      },
      { auth: { username, password } }
    );
    // Update SSID 5GHz (index 5-8, ambil yang berhasil saja)
    const newSSID5G = `${newSSID}-5G`;
    const ssid5gIndexes = [5, 6, 7, 8];
    for (const idx of ssid5gIndexes) {
      try {
        await axios.post(
          `${genieacsUrl}/devices/${encodedDeviceId}/tasks?connection_request`,
          {
            name: "setParameterValues",
            parameterValues: [
              [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.SSID`, newSSID5G, "xsd:string"]
            ]
          },
          { auth: { username, password } }
        );
        break;
      } catch (e) {}
    }
    // Hanya refresh, tidak perlu reboot
    await axios.post(
      `${genieacsUrl}/devices/${encodedDeviceId}/tasks?connection_request`,
      { name: "refreshObject", objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration" },
      { auth: { username, password } }
    );
    return true;
  } catch (e) {
    return false;
  }
}

// Helper: Update SSID Optimized (seperti WhatsApp command) - Fast Response
async function updateSSIDOptimized(phone, newSSID) {
  try {
    console.log(`🔄 Optimized SSID update for phone: ${phone} to: ${newSSID}`);
    
    // STEP 1: Ambil customer terlebih dahulu untuk mendapatkan GenieACS server yang tepat
    let customer = null;
    try {
      const phoneVariants = generatePhoneVariants(phone);
      for (const variant of phoneVariants) {
        try {
          customer = await billingManager.getCustomerByPhone(variant);
          if (customer) {
            console.log(`✅ Customer found in billing: ${customer.name} (${variant})`);
            
            // Ambil router_id dari customer_router_map jika belum ada di customer object
            if (!customer.router_id && customer.id) {
              try {
                const sqlite3 = require('sqlite3').verbose();
                const dbPath = require('path').join(__dirname, '../data/billing.db');
                const db = new sqlite3.Database(dbPath);
                const mapRow = await new Promise((resolve) => {
                  db.get(`SELECT router_id FROM customer_router_map WHERE customer_id = ?`, [customer.id], (err, row) => {
                    db.close();
                    resolve(row || null);
                  });
                });
                if (mapRow) {
                  customer.router_id = mapRow.router_id;
                  console.log(`✅ Router mapping found for customer: router_id = ${mapRow.router_id}`);
                } else {
                  console.log(`⚠️ Customer ${customer.id} tidak memiliki router mapping`);
                }
              } catch (mapError) {
                console.error('Error getting router mapping:', mapError);
              }
            }
            
            break;
          }
        } catch (e) {
          // Continue to next variant
        }
      }
    } catch (error) {
      console.error('Error getting customer:', error);
    }
    
    // STEP 2: Get GenieACS server dari customer router (multi-server support)
    let genieacsServer = null;
    if (customer) {
      try {
        const { getGenieacsServerForCustomer } = require('../config/genieacs');
        genieacsServer = await getGenieacsServerForCustomer(customer);
        if (genieacsServer) {
          console.log(`✅ GenieACS server found for customer: ${genieacsServer.name} (${genieacsServer.url})`);
        } else {
          console.log(`⚠️ No GenieACS server mapped to customer router, using default`);
        }
      } catch (e) {
        console.error('Error getting GenieACS server for customer:', e);
      }
    }
    
    // STEP 3: Cari device berdasarkan nomor pelanggan dengan multiple format
    let device = null;
    
    // Method 1: Jika ada customer dengan PPPoE username, coba cari device dengan itu (lebih akurat)
    if (customer && customer.pppoe_username) {
      try {
        const { findDeviceByPPPoE } = require('../config/genieacs');
        device = await findDeviceByPPPoE(customer.pppoe_username, customer);
        if (device) {
          console.log(`✅ Device found by PPPoE username: ${customer.pppoe_username}`);
        }
      } catch (error) {
        console.error('Error finding device by PPPoE username:', error);
      }
    }
    
    // Method 2: Jika belum ditemukan, coba dengan format tag
    if (!device) {
      device = await findDeviceByTag(phone);
      if (device) {
        console.log(`✅ Device found by tag: ${phone}`);
      }
    }
    
    // Method 3: Jika masih gagal, coba dengan format alternatif tag
    if (!device) {
      const phoneVariants = [];
      
      // Jika format internasional (62), coba format lokal (0)
      if (phone.startsWith('62')) {
        phoneVariants.push('0' + phone.substring(2));
      }
      // Jika format lokal (0), coba format internasional (62)
      else if (phone.startsWith('0')) {
        phoneVariants.push('62' + phone.substring(1));
      }
      // Jika tanpa prefix, coba kedua format
      else {
        phoneVariants.push('0' + phone);
        phoneVariants.push('62' + phone);
      }
      
      // Coba setiap variant
      for (const variant of phoneVariants) {
        console.log(`🔍 Trying phone variant: ${variant}`);
        device = await findDeviceByTag(variant);
        if (device) {
          console.log(`✅ Device found with variant: ${variant}`);
          break;
        }
      }
    }
    
    if (!device) {
      console.log(`❌ SSID update failed for ${phone}: Device tidak ditemukan`);
      return { success: false, message: 'Device tidak ditemukan' };
    }
    
    // STEP 4: Gunakan server dari customer jika ada, fallback ke settings.json
    const settings = getSettingsWithCache();
    const genieacsUrl = genieacsServer ? genieacsServer.url : (settings.genieacs_url || 'http://localhost:7557');
    const username = genieacsServer ? genieacsServer.username : (settings.genieacs_username || '');
    const password = genieacsServer ? genieacsServer.password : (settings.genieacs_password || '');
    
    console.log(`🌐 Using GenieACS server: ${genieacsUrl} (${genieacsServer ? genieacsServer.name : 'Default'})`);
    console.log(`📱 Device ID: ${device._id}`);
    
    const deviceId = device._id;
    const encodedDeviceId = encodeURIComponent(deviceId);
    
    // Buat nama SSID 5G berdasarkan SSID 2.4G (seperti di WhatsApp)
    const newSSID5G = `${newSSID}-5G`;
    
    // Concurrent API calls untuk speed up
    const axiosConfig = {
      auth: { username, password },
      timeout: 10000 // 10 second timeout
    };
    
    // Update SSID 2.4GHz dan 5GHz secara concurrent
    const tasks = [];
    
    // Task 1: Update SSID 2.4GHz
    const task1Url = `${genieacsUrl}/devices/${encodedDeviceId}/tasks`;
    console.log(`📤 Task 1 URL: ${task1Url}`);
    tasks.push(
      axios.post(
        task1Url,
        {
          name: "setParameterValues",
          parameterValues: [
            ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", newSSID, "xsd:string"]
          ]
        },
        axiosConfig
      ).catch((err) => {
        console.error(`❌ Task 1 error:`, err.response?.status, err.response?.data || err.message);
        throw err;
      })
    );
    
    // Task 2: Update SSID 5GHz (coba index 5 dulu, yang paling umum)
    tasks.push(
      axios.post(
        `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
        {
          name: "setParameterValues",
          parameterValues: [
            ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID", newSSID5G, "xsd:string"]
          ]
        },
        axiosConfig
      ).catch((err) => {
        console.log(`⚠️ Task 2 (5GHz) error (ignored):`, err.message);
        return null; // Ignore error jika index 5 tidak ada
      })
    );
    
    // Task 3: Refresh object
    tasks.push(
      axios.post(
        `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
        {
          name: "refreshObject",
          objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration"
        },
        axiosConfig
      ).catch((err) => {
        console.log(`⚠️ Task 3 (refresh) error (ignored):`, err.message);
        return null; // Ignore error jika refresh gagal
      })
    );
    
    // Jalankan semua tasks secara concurrent
    const results = await Promise.allSettled(tasks);
    
    // Check results dengan logging detail
    console.log(`📊 Task results:`, results.map((r, i) => ({
      task: i + 1,
      status: r.status,
      error: r.status === 'rejected' ? (r.reason?.response?.data || r.reason?.message) : null
    })));
    
    const mainTaskSuccess = results[0].status === 'fulfilled';
    const wifi5GFound = results[1].status === 'fulfilled';
    
    if (mainTaskSuccess) {
      console.log(`✅ SSID update completed for ${phone}: ${newSSID}`);
      console.log(`✅ WiFi 5GHz update: ${wifi5GFound ? 'Success' : 'Failed/Not found'}`);
      
      // Invalidate GenieACS cache after successful update
      try {
        const cacheManager = require('../config/cacheManager');
        cacheManager.invalidatePattern('genieacs:*');
        console.log('🔄 GenieACS cache invalidated after SSID update');
      } catch (cacheError) {
        console.warn('⚠️ Failed to invalidate cache:', cacheError.message);
      }
      
      return { success: true, wifi5GFound };
    } else {
      const errorMsg = results[0].reason?.response?.data || results[0].reason?.message || 'Unknown error';
      console.error(`❌ SSID update failed for ${phone}:`, errorMsg);
      console.error(`❌ Full error:`, results[0].reason);
      return { success: false, message: `Gagal update SSID: ${errorMsg}` };
    }
    
  } catch (error) {
    console.error('Error in updateSSIDOptimized:', error);
    return { success: false, message: error.message };
  }
}
// Helper: Add admin number and company info to customer data
function addAdminNumber(customerData) {
  const adminNumber = getSetting('admins.0', '6281368888498');
  const companyHeader = getSetting('company_header', 'CV Lintas Multimedia');
  
  // Convert to display format (remove country code if present)
  const displayNumber = adminNumber.startsWith('62') ? '0' + adminNumber.slice(2) : adminNumber;
  
  if (customerData && typeof customerData === 'object') {
    customerData.adminNumber = displayNumber;
    customerData.adminNumberWA = adminNumber;
    customerData.companyHeader = companyHeader;
  }
  return customerData;
}

// Helper: Update Password (real ke GenieACS) - Legacy
async function updatePassword(phone, newPassword) {
  try {
    if (newPassword.length < 8) return false;
    
    // Cari device berdasarkan nomor telepon (tag)
    let device = await findDeviceByTag(phone);
    
    // Jika tidak ditemukan, coba cari berdasarkan PPPoE username dari billing
    if (!device) {
      try {
        const customer = await billingManager.getCustomerByPhone(phone);
        if (customer && customer.pppoe_username) {
          const { findDeviceByPPPoE } = require('../config/genieacs');
          device = await findDeviceByPPPoE(customer.pppoe_username);
        }
      } catch (error) {
        console.error('Error finding device by PPPoE username:', error);
      }
    }
    
    if (!device) return false;
    const deviceId = device._id;
    const encodedDeviceId = encodeURIComponent(deviceId);
    const settings = getSettingsWithCache();
    const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
    const username = settings.genieacs_username || '';
    const password = settings.genieacs_password || '';
    const tasksUrl = `${genieacsUrl}/devices/${encodedDeviceId}/tasks`;
    // Update password 2.4GHz
    await axios.post(`${tasksUrl}?connection_request`, {
      name: "setParameterValues",
      parameterValues: [
        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", newPassword, "xsd:string"],
        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase", newPassword, "xsd:string"]
      ]
    }, { auth: { username, password } });
    // Update password 5GHz
    await axios.post(`${tasksUrl}?connection_request`, {
      name: "setParameterValues",
      parameterValues: [
        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase", newPassword, "xsd:string"],
        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.KeyPassphrase", newPassword, "xsd:string"]
      ]
    }, { auth: { username, password } });
    // Refresh
    await axios.post(`${tasksUrl}?connection_request`, {
      name: "refreshObject",
      objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration"
    }, { auth: { username, password } });
    return true;
  } catch (e) {
    return false;
  }
}

// Helper: Update Password Optimized (seperti WhatsApp command) - Fast Response
async function updatePasswordOptimized(phone, newPassword) {
  try {
    console.log(`🔄 Optimized password update for phone: ${phone}`);
    
    // STEP 1: Ambil customer terlebih dahulu untuk mendapatkan GenieACS server yang tepat
    let customer = null;
    try {
      const phoneVariants = generatePhoneVariants(phone);
      for (const variant of phoneVariants) {
        try {
          customer = await billingManager.getCustomerByPhone(variant);
          if (customer) {
            console.log(`✅ Customer found in billing: ${customer.name} (${variant})`);
            
            // Ambil router_id dari customer_router_map jika belum ada di customer object
            if (!customer.router_id && customer.id) {
              try {
                const sqlite3 = require('sqlite3').verbose();
                const dbPath = require('path').join(__dirname, '../data/billing.db');
                const db = new sqlite3.Database(dbPath);
                const mapRow = await new Promise((resolve) => {
                  db.get(`SELECT router_id FROM customer_router_map WHERE customer_id = ?`, [customer.id], (err, row) => {
                    db.close();
                    resolve(row || null);
                  });
                });
                if (mapRow) {
                  customer.router_id = mapRow.router_id;
                  console.log(`✅ Router mapping found for customer: router_id = ${mapRow.router_id}`);
                } else {
                  console.log(`⚠️ Customer ${customer.id} tidak memiliki router mapping`);
                }
              } catch (mapError) {
                console.error('Error getting router mapping:', mapError);
              }
            }
            
            break;
          }
        } catch (e) {
          // Continue to next variant
        }
      }
    } catch (error) {
      console.error('Error getting customer:', error);
    }
    
    // STEP 2: Get GenieACS server dari customer router (multi-server support)
    let genieacsServer = null;
    if (customer) {
      try {
        const { getGenieacsServerForCustomer } = require('../config/genieacs');
        genieacsServer = await getGenieacsServerForCustomer(customer);
        if (genieacsServer) {
          console.log(`✅ GenieACS server found for customer: ${genieacsServer.name} (${genieacsServer.url})`);
        } else {
          console.log(`⚠️ No GenieACS server mapped to customer router, using default`);
        }
      } catch (e) {
        console.error('Error getting GenieACS server for customer:', e);
      }
    }
    
    // STEP 3: Cari device berdasarkan nomor pelanggan dengan multiple format
    let device = null;
    
    // Method 1: Jika ada customer dengan PPPoE username, coba cari device dengan itu (lebih akurat)
    if (customer && customer.pppoe_username) {
      try {
        const { findDeviceByPPPoE } = require('../config/genieacs');
        device = await findDeviceByPPPoE(customer.pppoe_username, customer);
        if (device) {
          console.log(`✅ Device found by PPPoE username: ${customer.pppoe_username}`);
        }
      } catch (error) {
        console.error('Error finding device by PPPoE username:', error);
      }
    }
    
    // Method 2: Jika belum ditemukan, coba dengan format tag
    if (!device) {
      device = await findDeviceByTag(phone);
      if (device) {
        console.log(`✅ Device found by tag: ${phone}`);
      }
    }
    
    // Method 3: Jika masih gagal, coba dengan format alternatif tag
    if (!device) {
      const phoneVariants = [];
      
      // Jika format internasional (62), coba format lokal (0)
      if (phone.startsWith('62')) {
        phoneVariants.push('0' + phone.substring(2));
      }
      // Jika format lokal (0), coba format internasional (62)
      else if (phone.startsWith('0')) {
        phoneVariants.push('62' + phone.substring(1));
      }
      // Jika tanpa prefix, coba kedua format
      else {
        phoneVariants.push('0' + phone);
        phoneVariants.push('62' + phone);
      }
      
      // Coba setiap variant
      for (const variant of phoneVariants) {
        console.log(`🔍 Trying phone variant: ${variant}`);
        device = await findDeviceByTag(variant);
        if (device) {
          console.log(`✅ Device found with variant: ${variant}`);
          break;
        }
      }
    }
    
    if (!device) {
      console.log(`❌ Password update failed for ${phone}: Device tidak ditemukan`);
      return { success: false, message: 'Device tidak ditemukan' };
    }
    
    // STEP 4: Gunakan server dari customer jika ada, fallback ke settings.json
    const settings = getSettingsWithCache();
    const genieacsUrl = genieacsServer ? genieacsServer.url : (settings.genieacs_url || 'http://localhost:7557');
    const username = genieacsServer ? genieacsServer.username : (settings.genieacs_username || '');
    const passwordAuth = genieacsServer ? genieacsServer.password : (settings.genieacs_password || '');
    
    console.log(`🌐 Using GenieACS server: ${genieacsUrl} (${genieacsServer ? genieacsServer.name : 'Default'})`);
    console.log(`📱 Device ID: ${device._id}`);
    
    const deviceId = device._id;
    const encodedDeviceId = encodeURIComponent(deviceId);
    
    // Concurrent API calls untuk speed up
    const axiosConfig = {
      auth: { username, password: passwordAuth },
      timeout: 10000 // 10 second timeout
    };
    
    // Update password 2.4GHz dan 5GHz secara concurrent
    const tasks = [];
    
    // Task 1: Update password 2.4GHz
    const task1Url = `${genieacsUrl}/devices/${encodedDeviceId}/tasks`;
    console.log(`📤 Task 1 URL: ${task1Url}`);
    tasks.push(
      axios.post(
        task1Url,
        {
          name: "setParameterValues",
          parameterValues: [
            ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", newPassword, "xsd:string"]
          ]
        },
        axiosConfig
      ).catch((err) => {
        console.error(`❌ Task 1 error:`, err.response?.status, err.response?.data || err.message);
        throw err;
      })
    );
    
    // Task 2: Update password 5GHz (coba index 5 dulu)
    tasks.push(
      axios.post(
        `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
        {
          name: "setParameterValues",
          parameterValues: [
            ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase", newPassword, "xsd:string"]
          ]
        },
        axiosConfig
      ).catch((err) => {
        console.log(`⚠️ Task 2 (5GHz) error (ignored):`, err.message);
        return null; // Ignore error jika index 5 tidak ada
      })
    );
    
    // Task 3: Refresh object
    tasks.push(
      axios.post(
        `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
        {
          name: "refreshObject",
          objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration"
        },
        axiosConfig
      ).catch((err) => {
        console.log(`⚠️ Task 3 (refresh) error (ignored):`, err.message);
        return null; // Ignore error jika refresh gagal
      })
    );
    
    // Jalankan semua tasks secara concurrent
    const results = await Promise.allSettled(tasks);
    
    // Check results dengan logging detail
    console.log(`📊 Task results:`, results.map((r, i) => ({
      task: i + 1,
      status: r.status,
      error: r.status === 'rejected' ? (r.reason?.response?.data || r.reason?.message) : null
    })));
    
    const mainTaskSuccess = results[0].status === 'fulfilled';
    
    if (mainTaskSuccess) {
      console.log(`✅ Password update completed for ${phone}`);
      
      // Invalidate GenieACS cache after successful update
      try {
        const cacheManager = require('../config/cacheManager');
        cacheManager.invalidatePattern('genieacs:*');
        console.log('🔄 GenieACS cache invalidated after password update');
      } catch (cacheError) {
        console.warn('⚠️ Failed to invalidate cache:', cacheError.message);
      }
      
      return { success: true };
    } else {
      const errorMsg = results[0].reason?.response?.data || results[0].reason?.message || 'Unknown error';
      console.error(`❌ Password update failed for ${phone}:`, errorMsg);
      console.error(`❌ Full error:`, results[0].reason);
      return { success: false, message: `Gagal update password: ${errorMsg}` };
    }
    
  } catch (error) {
    console.error('Error in updatePasswordOptimized:', error);
    return { success: false, message: error.message };
  }
}

// GET: Login page
router.get('/login', (req, res) => {
  res.redirect('/login');
});

// GET: API untuk mendapatkan packages (untuk registrasi)
router.get('/api/packages', async (req, res) => {
  try {
    const packages = await billingManager.getPackages();
    res.json({
      success: true,
      packages: packages
    });
  } catch (error) {
    console.error('Error getting packages:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal memuat daftar paket'
    });
  }
});

// POST: Registrasi pelanggan baru
router.post('/register', customerPhotoUpload.fields([
  { name: 'ktp_photo', maxCount: 1 },
  { name: 'house_photo', maxCount: 1 }
]), async (req, res) => {
  try {
    const { name, phone, email, address, package_id } = req.body;
    
    // Validate required fields
    if (!name || !phone || !package_id) {
      return res.status(400).json({
        success: false,
        message: 'Nama, No Handphone, dan Paket wajib diisi',
        details: 'Silakan lengkapi semua field yang bertanda (*)'
      });
    }
    
    // Validate photos
    if (!req.files || !req.files.ktp_photo || req.files.ktp_photo.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Foto KTP wajib diupload',
        details: 'Silakan upload foto KTP Anda'
      });
    }
    
    if (!req.files || !req.files.house_photo || req.files.house_photo.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Foto Rumah Tampak Depan wajib diupload',
        details: 'Silakan upload foto rumah tampak depan'
      });
    }
    
    // Normalize phone
    const normalizedPhone = normalizePhone(phone);
    
    // Check if customer already exists
    const existingCustomer = await billingManager.getCustomerByPhone(normalizedPhone);
    if (existingCustomer) {
      // Delete uploaded files if customer already exists
      if (req.files.ktp_photo && req.files.ktp_photo[0]) {
        try { fs.unlinkSync(req.files.ktp_photo[0].path); } catch (e) {}
      }
      if (req.files.house_photo && req.files.house_photo[0]) {
        try { fs.unlinkSync(req.files.house_photo[0].path); } catch (e) {}
      }
      
      return res.status(400).json({
        success: false,
        message: 'Nomor telepon sudah terdaftar',
        details: 'Nomor telepon yang Anda masukkan sudah digunakan. Silakan login atau gunakan nomor yang berbeda.'
      });
    }
    
    // Auto-generate email if empty
    let finalEmail = email;
    if (!finalEmail || finalEmail.trim() === '') {
      // Generate email from name
      let cleanEmail = name.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, '')
        .substring(0, 30);
      if (!cleanEmail) cleanEmail = 'user';
      finalEmail = cleanEmail + '@gmail.com';
    }
    
    // Get photo paths (relative to public folder)
    const ktpPhotoPath = req.files.ktp_photo[0].path.replace(path.join(__dirname, '../public'), '').replace(/\\/g, '/');
    const housePhotoPath = req.files.house_photo[0].path.replace(path.join(__dirname, '../public'), '').replace(/\\/g, '/');
    
    // Prepare customer data (system will auto-generate username, customer_id, etc.)
    // Status 'register' - akan diubah menjadi 'active' setelah admin accept
    const customerData = {
      name: name.trim(),
      phone: normalizedPhone,
      email: finalEmail.trim(),
      address: address ? address.trim() : null,
      package_id: parseInt(package_id),
      status: 'register', // Status register - menunggu accept dari admin
      auto_suspension: 1,
      billing_day: 15,
      renewal_type: 'renewal',
      ktp_photo_path: ktpPhotoPath,
      house_photo_path: housePhotoPath
    };
    
    // Create customer
    const result = await billingManager.createCustomer(customerData);
    
    // Get full customer data with package info
    const newCustomer = await billingManager.getCustomerById(result.id);
    
    // JANGAN kirim welcome message saat registrasi
    // Welcome message akan dikirim setelah admin accept customer
    // Hanya kirim notifikasi ke admin/technician bahwa ada pendaftaran baru
    try {
      await sendNewCustomerNotificationToAdmin(newCustomer);
    } catch (notifError) {
      console.error('Error sending notification to admin/technicians:', notifError);
      // Don't fail registration if notification fails
    }
    
    res.json({
      success: true,
      message: 'Registrasi berhasil! Akun Anda telah dibuat.',
      customer_id: newCustomer.customer_id,
      customer: {
        id: newCustomer.id,
        name: newCustomer.name,
        phone: newCustomer.phone,
        email: newCustomer.email
      }
    });
  } catch (error) {
    console.error('Error registering customer:', error);
    
    // Delete uploaded files on error
    if (req.files) {
      if (req.files.ktp_photo && req.files.ktp_photo[0]) {
        try { fs.unlinkSync(req.files.ktp_photo[0].path); } catch (e) {}
      }
      if (req.files.house_photo && req.files.house_photo[0]) {
        try { fs.unlinkSync(req.files.house_photo[0].path); } catch (e) {}
      }
    }
    
    // Handle specific errors
    let errorMessage = 'Gagal mendaftarkan pelanggan';
    let errorDetails = '';
    
    if (error.message.includes('UNIQUE constraint failed')) {
      if (error.message.includes('phone')) {
        errorMessage = 'Nomor telepon sudah terdaftar';
        errorDetails = 'Nomor telepon yang Anda masukkan sudah digunakan. Silakan login atau gunakan nomor yang berbeda.';
      } else if (error.message.includes('username')) {
        errorMessage = 'Username sudah digunakan';
        errorDetails = 'Terjadi konflik username. Silakan coba lagi.';
      } else {
        errorMessage = 'Data duplikat terdeteksi';
        errorDetails = 'Data yang Anda masukkan sudah ada dalam sistem.';
      }
    } else if (error.message.includes('FOREIGN KEY constraint failed')) {
      errorMessage = 'Paket tidak valid';
      errorDetails = 'Paket yang dipilih tidak ditemukan. Silakan pilih paket yang tersedia.';
    } else if (error.message.includes('Hanya file gambar')) {
      errorMessage = 'Format file tidak valid';
      errorDetails = error.message;
    } else if (error.message.includes('File too large')) {
      errorMessage = 'Ukuran file terlalu besar';
      errorDetails = 'Ukuran file maksimal 20MB. Silakan kompres gambar atau gunakan file yang lebih kecil.';
    } else {
      errorDetails = error.message || 'Silakan coba lagi atau hubungi administrator.';
    }
    
    res.status(400).json({
      success: false,
      message: errorMessage,
      details: errorDetails
    });
  }
});

// Helper function to send new customer notification to admin and technicians
async function sendNewCustomerNotificationToAdmin(customer) {
  try {
    const whatsappNotifications = require('../config/whatsapp-notifications');
    const { getSetting } = require('../config/settingsManager');
    
    // Get admin phone
    const adminPhone = getSetting('admin_phone') || getSetting('contact_phone');
    
    // Format registration date
    const registrationDate = new Date().toLocaleDateString('id-ID', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    // Build notification message
    const message = `🎉 *PELANGGAN BARU DAFTAR ONLINE*\n\n` +
      `*No ID Pelanggan:* ${customer.customer_id || 'N/A'}\n` +
      `*Nama Pelanggan:* ${customer.name}\n` +
      `*No HP/WA:* ${customer.phone}\n` +
      `*Paket:* ${customer.package_name || 'N/A'} (${customer.package_speed || 'N/A'})\n` +
      `*Tanggal Daftar:* ${registrationDate}\n` +
      `*Alamat:* ${customer.address || 'Tidak diisi'}\n` +
      `*Email:* ${customer.email || 'Tidak diisi'}\n\n` +
      `Pelanggan ini telah terdaftar melalui Portal Pelanggan.`;
    
    // Send to admin (try multiple admin numbers from settings)
    let adminNotified = false;
    let adminIndex = 0;
    while (adminIndex < 5) { // Try up to 5 admin numbers
      const adminNum = getSetting(`admins.${adminIndex}`, '');
      if (!adminNum) break;
      
      try {
        await whatsappNotifications.sendNotification(adminNum, message);
        console.log(`New customer notification sent to admin ${adminIndex}: ${adminNum}`);
        adminNotified = true;
        break; // Success, no need to try more
      } catch (adminError) {
        console.error(`Error sending notification to admin ${adminIndex}:`, adminError);
      }
      adminIndex++;
    }
    
    // Also try admin_phone and contact_phone if not already notified
    if (!adminNotified && adminPhone) {
      try {
        await whatsappNotifications.sendNotification(adminPhone, message);
        console.log(`New customer notification sent to admin (fallback): ${adminPhone}`);
        adminNotified = true;
      } catch (adminError) {
        console.error('Error sending notification to admin (fallback):', adminError);
      }
    }
    
    // Send to active technicians
    try {
      const db = require('../config/billing').db;
      const technicians = await new Promise((resolve, reject) => {
        db.all('SELECT phone, name FROM technicians WHERE is_active = 1 AND phone IS NOT NULL AND phone != ""', [], (err, rows) => {
          if (err) {
            // If table doesn't exist, just return empty array
            if (err.message.includes('no such table')) {
              return resolve([]);
            }
            reject(err);
          } else {
            resolve(rows || []);
          }
        });
      });
      
      for (const tech of technicians) {
        try {
          await whatsappNotifications.sendNotification(tech.phone, message);
          console.log(`New customer notification sent to technician: ${tech.name} (${tech.phone})`);
        } catch (techError) {
          console.error(`Error sending notification to technician ${tech.name}:`, techError);
        }
      }
    } catch (techError) {
      console.error('Error getting technicians:', techError);
      // Don't fail if technicians table doesn't exist
    }
  } catch (error) {
    console.error('Error in sendNewCustomerNotificationToAdmin:', error);
    throw error;
  }
}

// GET: Base customer portal - redirect appropriately
router.get('/', (req, res) => {
  const phone = req.session && req.session.phone;
  if (phone) return res.redirect('/customer/dashboard');
  return res.redirect('/login');
});

// POST: Proses login - Redirected to unified login
router.post('/login', async (req, res) => {
  res.redirect('/login');
});

// GET: Halaman OTP - Redirected to unified login
router.get('/otp', (req, res) => {
  res.redirect('/login');
});

// POST: Verifikasi OTP - Redirected to unified login
router.post('/otp', async (req, res) => {
  res.redirect('/login');
});

router.get('/billing', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/login');
  const settings = getSettingsWithCache();
  
  try {
    const customer = await billingManager.getCustomerByPhone(phone);
    
    if (!customer) {
      // Pelanggan belum ada di sistem billing, tapi tetap bisa akses halaman billing
      console.log(`⚠️ [BILLING_REDIRECT] Customer not found in billing system for phone: ${phone}, but allowing access`);
      
      // Buat session customer_username sementara berdasarkan phone
      req.session.customer_username = `temp_${phone}`;
      req.session.customer_phone = phone; // Backup phone untuk referensi
      
      // Redirect ke billing dashboard yang akan menangani customer tanpa data billing
      return res.redirect('/customer/billing/dashboard');
    }
    
    const invoices = await billingManager.getInvoicesByCustomer(customer.id);
    
    // Set customer_username session for customer billing compatibility
    req.session.customer_username = customer.username;
    req.session.customer_phone = phone; // Backup phone untuk referensi
    console.log(`✅ [BILLING_REDIRECT] Set session customer_username: ${customer.username} for phone: ${phone}`);
    
    // Redirect to new customer billing dashboard with payment method selection
    res.redirect('/customer/billing/dashboard');
  } catch (error) {
    console.error('Error loading billing page:', error);
    res.render('error', { 
      message: 'Terjadi kesalahan saat memuat data tagihan',
      settings 
    });
  }
});

// POST: Restart device
router.post('/restart-device', async (req, res) => {
  // Prioritas: customer_username dari billing, fallback ke phone
  const customerUsername = req.session && req.session.customer_username;
  const phone = req.session && req.session.phone;
  
  if (!customerUsername && !phone) {
    return res.status(401).json({ success: false, message: 'Session tidak valid' });
  }
  
  try {
    console.log(`🔄 Restart device request from customer: ${customerUsername || phone}`);
    console.log(`🔄 Session data - customer_username: ${customerUsername}, phone: ${phone}`);
    
    // Ambil data customer dari billing
    let customer = null;
    if (phone) {
      try {
        const billingManager = require('../config/billing');
        customer = await billingManager.getCustomerByPhone(phone);
        console.log(`📋 [RESTART] Customer from billing:`, customer ? {
          id: customer.id, 
          username: customer.username, 
          pppoe_username: customer.pppoe_username,
          phone: customer.phone
        } : 'Not found');
      } catch (error) {
        console.error(`❌ [RESTART] Error getting customer from billing:`, error);
      }
    }
    
    let device = null;
    
    // Prioritas 1: Cari berdasarkan PPPoE Username dari billing
    if (customer && customer.pppoe_username) {
      console.log(`🔍 [RESTART] Searching by PPPoE username: ${customer.pppoe_username}`);
      try {
        device = await findDeviceByPPPoE(customer.pppoe_username);
        if (device) {
          console.log(`✅ [RESTART] Device found by PPPoE username: ${customer.pppoe_username}`);
        }
      } catch (error) {
        console.error(`❌ [RESTART] Error finding device by PPPoE:`, error);
      }
    }
    
    // Prioritas 2: Fallback ke pencarian berdasarkan tag (berbagai format)
    if (!device) {
      const searchVariants = [];
      
      if (customer) {
        // Gunakan data customer dari billing
        searchVariants.push(
          customer.username,           // Username billing
          customer.phone,             // Phone dari billing 
          customer.pppoe_username     // PPPoE username
        );
        
        // Extract nomor dari customer username jika format cust_xxxx_xxxxxx
        if (customer.username && customer.username.startsWith('cust_')) {
          const extracted = customer.username.replace(/^cust_/, '').replace(/_/g, '');
          searchVariants.push(extracted);
          searchVariants.push('0' + extracted);
        }
      }
      
      // Selalu coba dengan phone variants, bahkan tanpa billing data
      if (phone) {
        searchVariants.push(
          phone,                          // Format asli (087828060111)
          phone.replace(/^0/, '62'),     // 62878280601111  
          phone.replace(/^0/, '+62'),    // +62878280601111
          phone.replace(/^0/, ''),       // 87828060111
          phone.substring(1)             // 87828060111
        );
      }
      
      // Jika tidak ada billing data, coba dengan customerUsername dari session
      if (!customer && customerUsername) {
        console.log(`📱 [RESTART] No billing data, trying session customerUsername: ${customerUsername}`);
        searchVariants.push(customerUsername);
        
        // Extract dari customer username jika format cust_xxxx_xxxxxx
        if (customerUsername.startsWith('cust_')) {
          const extracted = customerUsername.replace(/^cust_/, '').replace(/_/g, '');
          searchVariants.push(extracted);
          searchVariants.push('0' + extracted);
        }
      }
      
      // Remove duplicates dan filter empty values
      const uniqueVariants = [...new Set(searchVariants.filter(v => v && v.trim()))];
      console.log(`📱 [RESTART] Searching device by tag with variants:`, uniqueVariants);
      
      // Cari device berdasarkan tag variants
      for (const variant of uniqueVariants) {
        console.log(`🔍 [RESTART] Trying tag variant: ${variant}`);
        device = await findDeviceByTag(variant);
        if (device) {
          console.log(`✅ [RESTART] Device found by tag variant: ${variant}`);
          break;
        }
      }
    }
    
    if (!device) {
      console.log(`❌ Device not found for customer: ${customerUsername || phone}`);
      console.log(`❌ Customer data:`, customer ? {
        username: customer.username,
        pppoe_username: customer.pppoe_username,
        phone: customer.phone
      } : 'No billing data');
      return res.status(404).json({ 
        success: false, 
        message: `Perangkat tidak ditemukan untuk customer: ${customerUsername || phone}` 
      });
    }
    
    console.log(`✅ Device found: ${device._id}`);
    
    // Cek status device
    const lastInform = device._lastInform ? new Date(device._lastInform) : null;
    const minutesAgo = lastInform ? Math.floor((Date.now() - lastInform.getTime()) / (1000 * 60)) : 999;
    
    if (minutesAgo > 5) {
      console.log(`⚠️ Device is offline. Last inform: ${lastInform ? lastInform.toLocaleString() : 'Never'}`);
      console.log(`⏰ Time since last inform: ${minutesAgo} minutes`);
      return res.status(400).json({ 
        success: false, 
        message: 'Perangkat offline. Restart hanya tersedia untuk perangkat yang online.' 
      });
    }
    
    console.log(`✅ Device is online. Last inform: ${lastInform.toLocaleString()}`);
    
    // Ambil konfigurasi GenieACS
    const settings = getSettingsWithCache();
    const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
    const username = settings.genieacs_username || 'admin';
    const password = settings.genieacs_password || 'admin';
    
    console.log(`🔗 GenieACS URL: ${genieacsUrl}`);
    
    // Encode device ID
    const deviceId = device._id;
    let encodedDeviceId = deviceId;
    
    try {
      // Coba encode device ID
      encodedDeviceId = encodeURIComponent(deviceId);
      console.log(`🔧 Using encoded device ID: ${encodedDeviceId}`);
    } catch (error) {
      console.log(`🔧 Using original device ID: ${deviceId}`);
    }
    
    // Kirim task restart ke GenieACS
    try {
      console.log(`📤 Sending restart task to GenieACS for device: ${deviceId}`);
      
      const response = await axios.post(`${genieacsUrl}/devices/${encodedDeviceId}/tasks`, {
        name: "reboot"
      }, {
        auth: { username, password },
        timeout: 10000
      });
      
      console.log(`✅ GenieACS response:`, response.data);
      console.log(`🔄 Restart command sent successfully. Device will be offline during restart process.`);
      
      // Kirim notifikasi WhatsApp ke pelanggan
      try {
        const waJid = phone.replace(/^0/, '62') + '@s.whatsapp.net';
        const msg = `🔄 *RESTART PERANGKAT*\n\nPerintah restart telah dikirim ke perangkat Anda.\n\n⏰ Perangkat akan restart dalam beberapa detik dan koneksi internet akan terputus sementara (1-2 menit).\n\n📱 Silakan tunggu hingga perangkat selesai restart.`;
        await sendMessage(waJid, msg);
        console.log(`✅ WhatsApp notification sent to ${phone}`);
      } catch (e) {
        console.error('❌ Gagal mengirim notifikasi restart:', e);
      }
      
      res.json({ 
        success: true, 
        message: 'Perintah restart berhasil dikirim. Perangkat akan restart dalam beberapa detik.' 
      });
      
    } catch (taskError) {
      console.error(`❌ Error sending restart task:`, taskError.response?.data || taskError.message);
      
      // Fallback: coba dengan device ID asli
      try {
        console.log(`🔄 Trying with original device ID: ${deviceId}`);
        const response = await axios.post(`${genieacsUrl}/devices/${deviceId}/tasks`, {
          name: "reboot"
        }, {
          auth: { username, password },
          timeout: 10000
        });
        
        console.log(`✅ Fallback restart successful`);
        res.json({ 
          success: true, 
          message: 'Perintah restart berhasil dikirim. Perangkat akan restart dalam beberapa detik.' 
        });
        
      } catch (fallbackError) {
        console.error(`❌ Fallback restart failed:`, fallbackError.response?.data || fallbackError.message);
        res.status(500).json({ 
          success: false, 
          message: 'Gagal mengirim perintah restart. Silakan coba lagi atau hubungi admin.' 
        });
      }
    }
    
  } catch (error) {
    console.error('❌ Error restart device:', error.message);
    console.error('❌ Error details:', error.response?.data || error);
    res.status(500).json({ 
      success: false, 
      message: 'Terjadi kesalahan saat restart perangkat. Silakan coba lagi.' 
    });
  }
});

// GET: Dashboard pelanggan
router.get('/dashboard', async (req, res) => {
  console.log(`🔍 [CUSTOMER_DASHBOARD] Route hit! Checking if member...`);
  const phone = req.session && req.session.phone;
  const isMember = req.session && req.session.is_member;
  
  console.log(`🔍 [CUSTOMER_DASHBOARD] Session:`, {
    phone: phone,
    is_member: isMember,
    customer_username: req.session?.customer_username,
    member_id: req.session?.member_id
  });
  
  // If member, redirect to billing dashboard
  if (isMember) {
    console.log(`✅ [CUSTOMER_DASHBOARD] Member detected, redirecting to billing dashboard`);
    return res.redirect('/customer/billing/dashboard');
  }
  
  if (!phone) return res.redirect('/customer/login');
  const settings = getSettingsWithCache();
  
  try {
    const data = await getCustomerDeviceData(phone);
    
    // Pastikan data tidak null
    if (!data) {
      console.log(`❌ No data returned for phone: ${phone}`);
      return res.render('dashboard', { 
        customer: { phone, ssid: '-', status: 'Tidak ditemukan', lastInform: '-' }, 
        connectedUsers: [], 
        notif: 'Data perangkat tidak ditemukan.',
        settings,
        billingData: null
      });
    }
    
    const customerWithAdmin = addAdminNumber(data);
    res.render('dashboard', { 
      customer: customerWithAdmin, 
      connectedUsers: data.connectedUsers || [],
      settings,
      billingData: data.billingData || null,
      notif: null
    });
  } catch (error) {
    console.error('Error loading dashboard:', error);
    // Fallback jika ada error, tetap tampilkan data minimal
    const fallbackCustomer = addAdminNumber({ 
      phone, 
      ssid: '-', 
      status: 'Error', 
      lastInform: '-',
      softwareVersion: '-',
      rxPower: '-',
      pppoeIP: '-',
      pppoeUsername: '-',
      totalAssociations: '0'
    });
    res.render('dashboard', { 
      customer: fallbackCustomer, 
      connectedUsers: [], 
      notif: 'Terjadi kesalahan saat memuat data.',
      settings,
      billingData: null
    });
  }
});

router.post('/change-ssid', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/login');
  const { ssid } = req.body;
  const ok = await updateSSIDOptimized(phone, ssid);
  if (ok) {
    // Kirim notifikasi WhatsApp ke pelanggan
    const waJid = phone.replace(/^0/, '62') + '@s.whatsapp.net';
    const msg = `✅ *PERUBAHAN NAMA WIFI*\n\nNama WiFi Anda telah diubah menjadi:\n• WiFi 2.4GHz: ${ssid}\n• WiFi 5GHz: ${ssid}-5G\n\nSilakan hubungkan ulang perangkat Anda ke WiFi baru.`;
    try { await sendMessage(waJid, msg); } catch (e) {}
  }
  const data = await getCustomerDeviceData(phone);
  const customerWithAdmin = addAdminNumber(data || { phone, ssid: '-', status: '-', lastChange: '-' });
  res.render('dashboard', { 
    customer: customerWithAdmin, 
    connectedUsers: data ? data.connectedUsers : [], 
    notif: ok ? 'Nama WiFi (SSID) berhasil diubah.' : 'Gagal mengubah SSID.',
    settings: getSettingsWithCache()
  });
});

// API: Ganti SSID (Ajax endpoint - optimized like WhatsApp)
router.post('/api/change-ssid', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.status(401).json({ success: false, message: 'Session tidak valid' });
  
  const { ssid } = req.body;
  
  if (!ssid || ssid.length < 3 || ssid.length > 32) {
    return res.status(400).json({ success: false, message: 'SSID harus berisi 3-32 karakter!' });
  }
  
  try {
    // Kirim response cepat ke frontend
    res.json({ 
      success: true, 
      message: 'SSID sedang diproses...',
      newSSID: ssid,
      processing: true
    });
    
    // Proses update di background (non-blocking)
    updateSSIDOptimized(phone, ssid).then(result => {
      if (result.success) {
        // Kirim notifikasi WhatsApp ke pelanggan (non-blocking)
        const waJid = phone.replace(/^0/, '62') + '@s.whatsapp.net';
        const msg = `✅ *PERUBAHAN NAMA WIFI*\n\nNama WiFi Anda telah diubah menjadi:\n• WiFi 2.4GHz: ${ssid}\n• WiFi 5GHz: ${ssid}-5G\n\nSilakan hubungkan ulang perangkat Anda ke WiFi baru.`;
        sendMessage(waJid, msg).catch(e => {
          console.error('Error sending WhatsApp notification:', e);
        });
        
        console.log(`✅ SSID update completed for ${phone}: ${ssid}`);
      } else {
        console.error(`❌ SSID update failed for ${phone}: ${result.message}`);
      }
    }).catch(error => {
      console.error('Error in background SSID update:', error);
    });
    
  } catch (error) {
    console.error('Error in change SSID API:', error);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server' });
  }
});

router.post('/change-password', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/login');
  const { password } = req.body;
  const ok = await updatePassword(phone, password);
  if (ok) {
    // Kirim notifikasi WhatsApp ke pelanggan
    const waJid = phone.replace(/^0/, '62') + '@s.whatsapp.net';
    const msg = `✅ *PERUBAHAN PASSWORD WIFI*\n\nPassword WiFi Anda telah diubah menjadi:\n• Password Baru: ${password}\n\nSilakan hubungkan ulang perangkat Anda dengan password baru.`;
    try { await sendMessage(waJid, msg); } catch (e) {}
  }
  const data = await getCustomerDeviceData(phone);
  const customerWithAdmin = addAdminNumber(data || { phone, ssid: '-', status: '-', lastChange: '-' });
  res.render('dashboard', { 
    customer: customerWithAdmin, 
    connectedUsers: data ? data.connectedUsers : [], 
    notif: ok ? 'Password WiFi berhasil diubah.' : 'Gagal mengubah password.',
    settings: getSettingsWithCache()
  });
});

// API: Ganti Password (Ajax endpoint - optimized like WhatsApp)
router.post('/api/change-password', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.status(401).json({ success: false, message: 'Session tidak valid' });
  
  const { password } = req.body;
  
  if (!password || password.length < 8 || password.length > 63) {
    return res.status(400).json({ success: false, message: 'Password harus berisi 8-63 karakter!' });
  }
  
  try {
    // Kirim response cepat ke frontend
    res.json({ 
      success: true, 
      message: 'Password sedang diproses...',
      processing: true
    });
    
    // Proses update di background (non-blocking)
    updatePasswordOptimized(phone, password).then(result => {
      if (result.success) {
        // Kirim notifikasi WhatsApp ke pelanggan (non-blocking)
        const waJid = phone.replace(/^0/, '62') + '@s.whatsapp.net';
        const msg = `✅ *PERUBAHAN PASSWORD WIFI*\n\nPassword WiFi Anda telah diubah menjadi:\n• Password Baru: ${password}\n\nSilakan hubungkan ulang perangkat Anda dengan password baru.`;
        sendMessage(waJid, msg).catch(e => {
          console.error('Error sending WhatsApp notification:', e);
        });
        
        console.log(`✅ Password update completed for ${phone}`);
      } else {
        console.error(`❌ Password update failed for ${phone}: ${result.message}`);
      }
    }).catch(error => {
      console.error('Error in background password update:', error);
    });
    
  } catch (error) {
    console.error('Error in change password API:', error);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server' });
  }
});

// POST: Logout pelanggan
// Logout route - support both GET and POST methods
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Import dan gunakan route laporan gangguan
const troubleReportRouter = require('./troubleReport');
router.use('/trouble', troubleReportRouter);

module.exports = router; 
 
router.get('/dashboard/mobile', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/login');
  const settings = getSettingsWithCache();
  try {
    const data = await getCustomerDeviceData(phone);
    if (!data) {
      return res.render('dashboard-mobile', {
        customer: { phone, ssid: '-', status: 'Tidak ditemukan', lastInform: '-' },
        connectedUsers: [],
        notif: 'Data perangkat tidak ditemukan.',
        settings,
        billingData: null
      });
    }
    const customerWithAdmin = addAdminNumber(data);
    res.render('dashboard-mobile', {
      customer: customerWithAdmin,
      connectedUsers: data.connectedUsers || [],
      settings,
      billingData: data.billingData || null,
      notif: null
    });
  } catch (error) {
    console.error('Error loading mobile dashboard:', error);
    const fallbackCustomer = addAdminNumber({
      phone,
      ssid: '-',
      status: 'Error',
      lastInform: '-',
      softwareVersion: '-',
      rxPower: '-',
      pppoeIP: '-',
      pppoeUsername: '-',
      totalAssociations: '0'
    });
    res.render('dashboard-mobile', {
      customer: fallbackCustomer,
      connectedUsers: [],
      notif: 'Terjadi kesalahan saat memuat data.',
      settings,
      billingData: null
    });
  }
});