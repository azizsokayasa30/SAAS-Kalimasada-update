const fs = require('fs');
const path = require('path');
const performanceMonitor = require('./performanceMonitor');

const settingsPath = path.join(process.cwd(), 'settings.json');

// In-memory cache untuk performa
let settingsCache = null;
let lastModified = null;
let cacheExpiry = null;
const CACHE_TTL = 5000; // 5 detik cache

function loadSettingsFromFile() {
  const startTime = Date.now();
  let wasCacheHit = false;
  
  try {
    const stats = fs.statSync(settingsPath);
    const fileModified = stats.mtime.getTime();
    
    // Jika file tidak berubah dan cache masih valid, gunakan cache
    if (settingsCache && 
        lastModified === fileModified && 
        cacheExpiry && 
        Date.now() < cacheExpiry) {
      wasCacheHit = true;
      performanceMonitor.recordCall(startTime, wasCacheHit);
      return settingsCache;
    }
    
    // Baca file dan update cache
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    settingsCache = JSON.parse(raw);
    lastModified = fileModified;
    cacheExpiry = Date.now() + CACHE_TTL;
    
    performanceMonitor.recordCall(startTime, wasCacheHit);
    return settingsCache;
  } catch (e) {
    performanceMonitor.recordCall(startTime, wasCacheHit);
    // Jika ada error, return cache lama atau empty object
    return settingsCache || {};
  }
}

function getSettingsWithCache() {
  return loadSettingsFromFile();
}

function getSetting(key, defaultValue) {
  const settings = getSettingsWithCache();
  return settings[key] !== undefined ? settings[key] : defaultValue;
}

function setSetting(key, value) {
  try {
    const settings = getSettingsWithCache();
    settings[key] = value;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    
    // Invalidate cache setelah write
    settingsCache = settings;
    lastModified = fs.statSync(settingsPath).mtime.getTime();
    cacheExpiry = Date.now() + CACHE_TTL;
    
    return true;
  } catch (e) {
    return false;
  }
}

function deleteSetting(key) {
    try {
        const settings = getSettingsWithCache();
        if (!(key in settings)) {
            return false;
        }

        delete settings[key];
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

        // Invalidate cache setelah write
        settingsCache = settings;
        lastModified = fs.statSync(settingsPath).mtime.getTime();
        cacheExpiry = Date.now() + CACHE_TTL;

        return true;
    } catch (e) {
        return false;
    }
}

// Clear cache function untuk debugging/maintenance
function clearSettingsCache() {
  settingsCache = null;
  lastModified = null;
  cacheExpiry = null;
}

// Helper function untuk mendapatkan timezone server
function getServerTimezone() {
    try {
        // Coba ambil dari environment variable TZ jika sudah di-set
        // (Hanya percaya jika bukan 'UTC' default kosong)
        if (process.env.TZ && process.env.TZ !== 'UTC') {
            return process.env.TZ;
        }
        
        // Coba baca dari /etc/timezone (Linux/Docker only)
        try {
            const timezoneFile = fs.readFileSync('/etc/timezone', 'utf8').trim();
            if (timezoneFile && timezoneFile !== 'UTC') {
                return timezoneFile;
            }
        } catch (e) {
            // File tidak ada (Windows), lanjut ke langkah berikutnya
        }
        
        // Coba baca dari timedatectl output (Linux only - skip di Windows)
        if (process.platform !== 'win32') {
            try {
                const { execSync } = require('child_process');
                const output = execSync('timedatectl show -p Timezone --value', { encoding: 'utf8', timeout: 1000 }).trim();
                if (output && output !== 'UTC') {
                    return output;
                }
            } catch (e) {
                // Command tidak tersedia, lanjuti
            }
        }
        
        // PENTING: Fallback ke Asia/Jakarta (WIB) bukan UTC
        // Aplikasi ini beroperasi di Indonesia, UTC menyebabkan offset -7 jam
        return 'Asia/Jakarta';
    } catch (error) {
        return 'Asia/Jakarta';
    }
}

// Helper function untuk mendapatkan timestamp WIB yang konsisten.
// Gunakan fungsi ini sebagai pengganti new Date().toISOString() / datetime('now','localtime') untuk data aplikasi.
// Format: YYYY-MM-DD HH:mm:ss — zona tetap Asia/Jakarta (WIB).
function getLocalTimestamp(date = null) {
    const d = date ? new Date(date) : new Date();
    const tz = 'Asia/Jakarta';
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(d);
    const pick = (type) => {
        const p = parts.find((x) => x.type === type);
        return p ? p.value : '00';
    };
    const y = pick('year');
    const mo = pick('month');
    const da = pick('day');
    const h = pick('hour');
    const mi = pick('minute');
    const se = pick('second');
    return `${y}-${mo}-${da} ${h}:${mi}:${se}`;
}

module.exports = { 
  getSettingsWithCache, 
  getSetting, 
  setSetting, 
  clearSettingsCache,
  deleteSetting,
  getServerTimezone,
  getLocalTimestamp,
  getPerformanceStats: () => performanceMonitor.getStats(),
  getPerformanceReport: () => performanceMonitor.getPerformanceReport(),
  getQuickStats: () => performanceMonitor.getQuickStats()
};