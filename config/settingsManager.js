const fs = require('fs');
const path = require('path');
const performanceMonitor = require('./performanceMonitor');

const settingsPath = path.join(process.cwd(), 'settings.json');
const settingsTemplatePath = path.join(process.cwd(), 'settings.server.template.json');

function ensureSettingsFile() {
  try {
    if (fs.existsSync(settingsPath)) return false;
    if (!fs.existsSync(settingsTemplatePath)) {
      console.warn('[settings] settings.json tidak ada dan template tidak ditemukan');
      return false;
    }
    fs.copyFileSync(settingsTemplatePath, settingsPath);
    console.log('[settings] settings.json dibuat dari settings.server.template.json');
    return true;
  } catch (e) {
    console.warn('[settings] ensureSettingsFile gagal:', e.message);
    return false;
  }
}

ensureSettingsFile();

// In-memory cache untuk performa
let settingsCache = null;
let lastModified = null;
let cacheExpiry = null;
const CACHE_TTL = 5000; // 5 detik cache

function backupSettingsFile() {
  try {
    if (!fs.existsSync(settingsPath)) return;
    const backupDir = path.join(process.cwd(), 'data');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `settings.json.bak-${Date.now()}`);
    fs.copyFileSync(settingsPath, backupPath);
  } catch (e) {
    console.warn(`[settings] Backup settings.json gagal: ${e.message}`);
  }
}

/** Baca settings.json dari disk (abaikan cache) — dipakai sebelum tulis agar tidak menimpa key lain. */
function readSettingsFromDisk() {
  try {
    if (!fs.existsSync(settingsPath)) return {};
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    if (!raw || !raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    console.error(`[settings] Gagal parse settings.json: ${e.message}`);
    return settingsCache && typeof settingsCache === 'object' ? { ...settingsCache } : {};
  }
}

function loadSettingsFromFile() {
  const startTime = Date.now();
  let wasCacheHit = false;

  ensureSettingsFile();

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
    settingsCache = readSettingsFromDisk();
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

function persistSettings(settings) {
  backupSettingsFile();
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  settingsCache = settings;
  lastModified = fs.statSync(settingsPath).mtime.getTime();
  cacheExpiry = Date.now() + CACHE_TTL;
}

function setSetting(key, value) {
  try {
    const settings = readSettingsFromDisk();
    settings[key] = value;
    persistSettings(settings);
    return true;
  } catch (e) {
    console.error(`[settings] setSetting(${key}) gagal: ${e.message}`);
    return false;
  }
}

function deleteSetting(key) {
    try {
        const settings = readSettingsFromDisk();
        if (!(key in settings)) {
            return false;
        }

        delete settings[key];
        persistSettings(settings);
        return true;
    } catch (e) {
        console.error(`[settings] deleteSetting(${key}) gagal: ${e.message}`);
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
  ensureSettingsFile,
  getServerTimezone,
  getLocalTimestamp,
  getPerformanceStats: () => performanceMonitor.getStats(),
  getPerformanceReport: () => performanceMonitor.getPerformanceReport(),
  getQuickStats: () => performanceMonitor.getQuickStats()
};