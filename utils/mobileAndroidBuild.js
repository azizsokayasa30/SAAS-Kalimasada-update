/**
 * Tool build APK Flutter (billing_kalimasada_mobile) dari panel admin.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getSetting, setSetting } = require('../config/settingsManager');
const { getPublicAppBaseUrl } = require('../config/public-endpoint');

const PROJECT_ROOT = path.join(__dirname, '..');
const MOBILE_DIR = path.join(PROJECT_ROOT, 'billing_kalimasada_mobile');
const ENV_PATH = path.join(MOBILE_DIR, '.env');
const PUBSPEC_PATH = path.join(MOBILE_DIR, 'pubspec.yaml');
const MANIFEST_XML_PATH = path.join(MOBILE_DIR, 'android/app/src/main/AndroidManifest.xml');
const PUBLIC_APK_DIR = path.join(PROJECT_ROOT, 'public/mobile-app');
const DEFAULT_FLUTTER_SDK_PATH = path.join(PUBLIC_APK_DIR, 'flutter-sdk/bin/flutter');
const DEFAULT_ANDROID_SDK_PATH = path.join(PUBLIC_APK_DIR, 'android-sdk');
const GRADLE_USER_HOME = path.join(PUBLIC_APK_DIR, '.gradle-home');
const PUB_CACHE_DIR = path.join(PUBLIC_APK_DIR, '.pub-cache');
const KEYSTORE_DIR = path.join(PUBLIC_APK_DIR, 'keystore');
const KEYSTORE_FILE = path.join(KEYSTORE_DIR, 'kalimasada.jks');
const KEY_PROPERTIES_PATH = path.join(MOBILE_DIR, 'android/key.properties');
/** SHA-256 sertifikat APK produksi 5.9.2 (build Windows) — wajib sama agar bisa update OTA. */
const PRODUCTION_CERT_SHA256 = 'e2eb457739d49234a2b0bae4123deb166376e102bd6b2a8de666c42b095f0825';
const MIN_KNOWN_PRODUCTION_BUILD = 91;
const OTA_LATEST_APK_NAME = 'kalimasada-mobile-latest.apk';
const BUILD_STATUS_PATH = path.join(PROJECT_ROOT, 'data/mobile-android-build.json');

/** APK universal (arm + arm64 + x86_64) — ~70 MB, kompatibel semua perangkat Android. */
const BUILD_APK_ARGS = ['build', 'apk', '--release', '--no-pub'];
const REQUIRED_APK_LIBS = [
    'lib/armeabi-v7a/libapp.so',
    'lib/arm64-v8a/libapp.so',
    'lib/x86_64/libapp.so'
];
const MIN_APK_BYTES = 55 * 1024 * 1024;

function normalizeSha256(hex) {
    return String(hex || '')
        .replace(/[^a-fA-F0-9]/g, '')
        .toLowerCase();
}

function readKeystoreCertSha256(keystorePath, storePass) {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
        'keytool',
        ['-list', '-v', '-keystore', keystorePath, '-storepass', storePass],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 }
    );
    const m = out.match(/SHA256:\s*([A-F0-9:]+)/i);
    return m ? normalizeSha256(m[1]) : '';
}

function readKeystoreConfig() {
    const storeFile = String(getSetting('mobile_android_keystore_path', '') || '').trim() || KEYSTORE_FILE;
    const storePassword = String(getSetting('mobile_android_keystore_password', '') || 'android');
    const keyAlias = String(getSetting('mobile_android_key_alias', '') || 'androiddebugkey');
    const keyPassword = String(getSetting('mobile_android_key_password', '') || storePassword);
    return { storeFile, storePassword, keyAlias, keyPassword };
}

function readKeystoreStatus() {
    const cfg = readKeystoreConfig();
    const exists = fs.existsSync(cfg.storeFile);
    if (!exists) {
        return {
            ready: false,
            path: cfg.storeFile,
            matches_production: false,
            sha256: '',
            message:
                'Keystore belum ada. Salin debug.keystore dari PC Windows (tempat build 5.9.2) ke: public/mobile-app/keystore/kalimasada.jks'
        };
    }
    try {
        const sha256 = readKeystoreCertSha256(cfg.storeFile, cfg.storePassword);
        const matches = sha256 === PRODUCTION_CERT_SHA256;
        return {
            ready: true,
            path: cfg.storeFile,
            matches_production: matches,
            sha256,
            message: matches
                ? 'Keystore cocok dengan APK produksi — update OTA aman.'
                : 'Keystore TIDAK sama dengan APK produksi. Ganti file di public/mobile-app/keystore/kalimasada.jks (salin dari PC Windows).'
        };
    } catch (e) {
        return {
            ready: false,
            path: cfg.storeFile,
            matches_production: false,
            sha256: '',
            message: `Keystore tidak bisa dibaca: ${e.message}. Periksa password/alias di settings.`
        };
    }
}

function writeAndroidKeyProperties() {
    const cfg = readKeystoreConfig();
    const st = readKeystoreStatus();
    if (!st.ready) {
        throw new Error(st.message);
    }
    if (!st.matches_production) {
        throw new Error(
            `${st.message} Path: ${cfg.storeFile}`
        );
    }
    const dir = path.dirname(KEY_PROPERTIES_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const lines = [
        `storePassword=${cfg.storePassword}`,
        `keyPassword=${cfg.keyPassword}`,
        `keyAlias=${cfg.keyAlias}`,
        `storeFile=${cfg.storeFile}`
    ];
    fs.writeFileSync(KEY_PROPERTIES_PATH, lines.join('\n') + '\n', 'utf8');
    return cfg;
}

function resolveMinimumBuildNumber() {
    let max = MIN_KNOWN_PRODUCTION_BUILD;
    const settingBuild = parseInt(String(getSetting('mobile_app_build', '') || ''), 10);
    if (Number.isFinite(settingBuild) && settingBuild > max) max = settingBuild;
    if (fs.existsSync(PUBSPEC_PATH)) {
        const ver = parsePubspecVersion(fs.readFileSync(PUBSPEC_PATH, 'utf8'));
        if (ver.versionCode > max) max = ver.versionCode;
    }
    const manifestPath = path.join(PUBLIC_APK_DIR, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
        try {
            const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const bn = parseInt(String(m.build_number || ''), 10);
            if (Number.isFinite(bn) && bn > max) max = bn;
        } catch (_) {}
    }
    return max;
}

function normalizeBuildNumber(requested) {
    const req = parseInt(String(requested), 10);
    const min = resolveMinimumBuildNumber();
    if (!Number.isFinite(req) || req <= min) return min + 1;
    return req;
}

function validateBuiltApk(apkPath) {
    if (!fs.existsSync(apkPath)) {
        throw new Error(`APK tidak ditemukan: ${apkPath}`);
    }
    const st = fs.statSync(apkPath);
    const sizeMb = Math.round(st.size / (1024 * 1024));
    if (st.size < MIN_APK_BYTES) {
        throw new Error(
            `APK tidak valid: ukuran ${sizeMb} MB (harus ~70 MB universal). Build mungkin hanya 1 arsitektur — coba build ulang.`
        );
    }
    const { execFileSync } = require('child_process');
    let listing = '';
    try {
        listing = execFileSync('unzip', ['-l', apkPath], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    } catch (e) {
        throw new Error(`APK tidak valid: tidak bisa dibaca (${e.message})`);
    }
    const missing = REQUIRED_APK_LIBS.filter((lib) => !listing.includes(lib));
    if (missing.length) {
        throw new Error(
            `APK tidak lengkap — arsitektur hilang: ${missing.join(', ')}. Gunakan build universal (semua ABI).`
        );
    }
    appendBuildLog(`Validasi APK OK: ${sizeMb} MB, semua arsitektur (arm, arm64, x86_64).`);

    try {
        const { execFileSync } = require('child_process');
        const bt = path.join(DEFAULT_ANDROID_SDK_PATH, 'build-tools/35.0.0/apksigner');
        if (fs.existsSync(bt)) {
            const out = execFileSync(bt, ['verify', '--print-certs', apkPath], { encoding: 'utf8' });
            const m = out.match(/SHA-256 digest:\s*([a-f0-9]+)/i);
            if (m) {
                const fp = m[1].toLowerCase();
                if (fp !== PRODUCTION_CERT_SHA256) {
                    throw new Error(
                        'Sertifikat APK tidak sama dengan produksi 5.9.2 — instal/update akan gagal. Periksa keystore.'
                    );
                }
                appendBuildLog('Sertifikat APK cocok dengan produksi (sama dengan 5.9.2).');
            }
        }
    } catch (e) {
        if (e.message && e.message.includes('Sertifikat APK')) throw e;
    }

    return { size_mb: sizeMb };
}

function getDefaultFlutterSdkPath() {
    return DEFAULT_FLUTTER_SDK_PATH;
}

function resolveFlutterPathSetting(storedPath) {
    const trimmed = String(storedPath || '').trim();
    return trimmed || getDefaultFlutterSdkPath();
}

let activeBuildChild = null;

function readBuildStatus() {
    try {
        if (!fs.existsSync(BUILD_STATUS_PATH)) {
            return { status: 'idle', logs: [] };
        }
        return JSON.parse(fs.readFileSync(BUILD_STATUS_PATH, 'utf8'));
    } catch (_) {
        return { status: 'idle', logs: [] };
    }
}

function writeBuildStatus(patch) {
    const prev = readBuildStatus();
    const next = { ...prev, ...patch, updated_at: new Date().toISOString() };
    if (!Array.isArray(next.logs)) next.logs = [];
    const dir = path.dirname(BUILD_STATUS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(BUILD_STATUS_PATH, JSON.stringify(next, null, 2), 'utf8');
    return next;
}

function appendBuildLog(line) {
    const st = readBuildStatus();
    const logs = Array.isArray(st.logs) ? st.logs.slice() : [];
    logs.push({ at: new Date().toISOString(), line: String(line || '').trim() });
    if (logs.length > 400) logs.splice(0, logs.length - 400);
    writeBuildStatus({ logs });
}

function parsePubspecVersion(raw) {
    const m = String(raw || '').match(/version:\s*([0-9]+(?:\.[0-9]+)*)\+([0-9]+)/i);
    if (!m) return { versionName: '1.0.0', versionCode: 1 };
    return { versionName: m[1], versionCode: parseInt(m[2], 10) || 1 };
}

function readEnvApiUrl() {
    if (!fs.existsSync(ENV_PATH)) return '';
    const text = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const m = t.match(/^(?:API_URL|BILLING_API_URL|API_BASE_URL)\s*=\s*(.+)$/i);
        if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
    return '';
}

function writeEnvApiUrl(apiUrl) {
    const url = String(apiUrl || '').trim().replace(/\/+$/, '');
    let lines = [];
    if (fs.existsSync(ENV_PATH)) {
        lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
    } else if (fs.existsSync(path.join(MOBILE_DIR, '.env.example'))) {
        lines = fs.readFileSync(path.join(MOBILE_DIR, '.env.example'), 'utf8').split('\n');
    }

    const keys = ['API_URL', 'BILLING_API_URL', 'API_BASE_URL'];
    const found = new Set();
    const out = lines.map((line) => {
        const t = line.trim();
        for (const k of keys) {
            if (t.startsWith(`${k}=`) || t.match(new RegExp(`^${k}\\s*=`))) {
                found.add(k);
                return `${k}=${url}`;
            }
        }
        return line;
    });

    for (const k of keys) {
        if (!found.has(k)) out.push(`${k}=${url}`);
    }

    if (!fs.existsSync(MOBILE_DIR)) {
        throw new Error('Folder billing_kalimasada_mobile tidak ditemukan');
    }
    fs.writeFileSync(ENV_PATH, out.join('\n').replace(/\n*$/, '\n'), 'utf8');
    return url;
}

function readAppName() {
    if (!fs.existsSync(MANIFEST_XML_PATH)) return 'Kalimasada Mobile';
    const xml = fs.readFileSync(MANIFEST_XML_PATH, 'utf8');
    const m = xml.match(/android:label="([^"]*)"/);
    return m ? m[1] : 'Kalimasada Mobile';
}

function writeAppName(name) {
    const label = String(name || '').trim() || 'Kalimasada Mobile';
    if (!fs.existsSync(MANIFEST_XML_PATH)) {
        throw new Error('AndroidManifest.xml tidak ditemukan');
    }
    let xml = fs.readFileSync(MANIFEST_XML_PATH, 'utf8');
    if (!/android:label="/.test(xml)) {
        throw new Error('android:label tidak ditemukan di AndroidManifest.xml');
    }
    xml = xml.replace(/android:label="[^"]*"/, `android:label="${label.replace(/"/g, '')}"`);
    fs.writeFileSync(MANIFEST_XML_PATH, xml, 'utf8');
    return label;
}

function writePubspecVersion(versionName, versionCode) {
    const vn = String(versionName || '').trim() || '1.0.0';
    const vc = Math.max(1, parseInt(String(versionCode), 10) || 1);
    if (!fs.existsSync(PUBSPEC_PATH)) {
        throw new Error('pubspec.yaml tidak ditemukan');
    }
    let text = fs.readFileSync(PUBSPEC_PATH, 'utf8');
    if (/^version:\s*.+$/m.test(text)) {
        text = text.replace(/^version:\s*.+$/m, `version: ${vn}+${vc}`);
    } else {
        text = `version: ${vn}+${vc}\n${text}`;
    }
    fs.writeFileSync(PUBSPEC_PATH, text, 'utf8');
    return { versionName: vn, versionCode: vc };
}

function readMobileBuildConfig() {
    const pubspec = fs.existsSync(PUBSPEC_PATH) ? fs.readFileSync(PUBSPEC_PATH, 'utf8') : '';
    const ver = parsePubspecVersion(pubspec);
    let manifestJson = null;
    const manifestPath = path.join(PUBLIC_APK_DIR, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
        try {
            manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (_) {}
    }

    const suggestedApi =
        readEnvApiUrl() ||
        String(getSetting('mobile_android_default_api_url', '') || '').trim() ||
        getPublicAppBaseUrl() ||
        '';

    return {
        api_url: suggestedApi,
        app_name: readAppName(),
        version_name: ver.versionName,
        version_code: ver.versionCode,
        release_notes:
            (manifestJson && manifestJson.release_notes) ||
            String(getSetting('mobile_app_release_notes', '') || ''),
        force_update: !!(manifestJson && manifestJson.force_update),
        apk_url: (manifestJson && manifestJson.apk_url) || String(getSetting('mobile_app_apk_url', '') || ''),
        flutter_path: resolveFlutterPathSetting(getSetting('mobile_android_flutter_path', '')),
        flutter_path_default: getDefaultFlutterSdkPath(),
        apk_publish_dir: PUBLIC_APK_DIR,
        ota_manifest_url: `${getPublicAppBaseUrl()}/api/mobile-adapter/app-update/manifest`,
        project_dir: MOBILE_DIR,
        env_path: ENV_PATH,
        pubspec_path: PUBSPEC_PATH,
        manifest_publish_path: manifestPath,
        build_status: readBuildStatus().status || 'idle',
        flutter_detected: detectFlutterBinary(resolveFlutterPathSetting(getSetting('mobile_android_flutter_path', ''))),
        keystore: readKeystoreStatus(),
        min_build_number: resolveMinimumBuildNumber() + 1,
        latest_apk_files: listPublishedApks()
    };
}

function listPublishedApks() {
    if (!fs.existsSync(PUBLIC_APK_DIR)) return [];
    return fs
        .readdirSync(PUBLIC_APK_DIR)
        .filter((f) => f.toLowerCase().endsWith('.apk'))
        .map((f) => {
            const full = path.join(PUBLIC_APK_DIR, f);
            const st = fs.statSync(full);
            return {
                name: f,
                size_mb: Math.round((st.size / (1024 * 1024)) * 100) / 100,
                mtime: st.mtime.toISOString()
            };
        })
        .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
        .slice(0, 12);
}

function flutterBinaryRunnable(binPath) {
    if (!binPath) return false;
    try {
        const { execFileSync } = require('child_process');
        execFileSync(binPath, ['--version'], { stdio: 'ignore', timeout: 8000 });
        return true;
    } catch (_) {
        return false;
    }
}

function detectFlutterBinary(customPath) {
    const candidates = [];
    const resolved = resolveFlutterPathSetting(customPath);
    if (resolved) candidates.push(resolved);
    if (customPath && customPath !== resolved) candidates.push(customPath);
    candidates.push(getDefaultFlutterSdkPath());
    candidates.push('flutter');
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
        candidates.push(path.join(home, 'flutter/bin/flutter'));
        candidates.push(path.join(home, 'development/flutter/bin/flutter'));
        candidates.push(path.join(home, 'snap/flutter/common/flutter/bin/flutter'));
    }
    candidates.push('/opt/flutter/bin/flutter');
    candidates.push('/usr/local/bin/flutter');

    const seen = new Set();
    for (const c of candidates) {
        if (!c || seen.has(c)) continue;
        seen.add(c);
        if (c !== 'flutter' && !fs.existsSync(c)) continue;
        if (flutterBinaryRunnable(c)) {
            return { path: c, exists: true, mode: c === 'flutter' ? 'path' : 'file' };
        }
    }
    return { path: customPath || 'flutter', exists: false, mode: 'missing' };
}

function resolveFlutterExec(flutterPathSetting) {
    const det = detectFlutterBinary(flutterPathSetting);
    if (!det.exists && det.mode === 'missing') {
        throw new Error(
            'Flutter SDK tidak ditemukan. Isi path Flutter di Tool Android (mis. /home/user/flutter/bin/flutter) atau pasang Flutter di server.'
        );
    }
    return det.path;
}

function writePublishManifest({ versionName, versionCode, apkFileName, releaseNotes, forceUpdate }) {
    if (!fs.existsSync(PUBLIC_APK_DIR)) {
        fs.mkdirSync(PUBLIC_APK_DIR, { recursive: true });
    }
    const apk_url = `/mobile-app/${apkFileName}`;
    const manifest = {
        version: versionName,
        build_number: versionCode,
        apk_url,
        force_update: !!forceUpdate,
        release_notes: String(releaseNotes || '').trim() || 'Pembaruan aplikasi mobile.'
    };
    fs.writeFileSync(path.join(PUBLIC_APK_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    setSetting('mobile_app_version', versionName);
    setSetting('mobile_app_build', String(versionCode));
    setSetting('mobile_app_apk_url', apk_url);
    setSetting('mobile_app_release_notes', manifest.release_notes);

    return manifest;
}

function saveMobileBuildConfig(input) {
    const apiUrl = writeEnvApiUrl(input.api_url);
    const appName = writeAppName(input.app_name);
    const { versionName, versionCode } = writePubspecVersion(input.version_name, input.version_code);

    if (input.flutter_path != null) {
        setSetting('mobile_android_flutter_path', resolveFlutterPathSetting(input.flutter_path));
    }
    if (input.api_url) {
        setSetting('mobile_android_default_api_url', apiUrl);
    }

    let manifest = null;
    if (input.update_manifest !== false) {
        const apkName =
            input.apk_file_name ||
            `kalimasada-mobile-${versionName}.apk`;
        manifest = writePublishManifest({
            versionName,
            versionCode,
            apkFileName: apkName,
            releaseNotes: input.release_notes,
            forceUpdate: input.force_update
        });
    }

    return {
        api_url: apiUrl,
        app_name: appName,
        version_name: versionName,
        version_code: versionCode,
        manifest
    };
}

function ensureBuildCacheDirs() {
    for (const dir of [GRADLE_USER_HOME, PUB_CACHE_DIR]) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
}

function buildCommandEnv() {
    ensureBuildCacheDirs();
    const androidSdk =
        String(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '').trim() ||
        (fs.existsSync(DEFAULT_ANDROID_SDK_PATH) ? DEFAULT_ANDROID_SDK_PATH : '');
    const javaHome =
        String(process.env.JAVA_HOME || '').trim() ||
        (fs.existsSync('/usr/lib/jvm/java-17-openjdk-amd64') ? '/usr/lib/jvm/java-17-openjdk-amd64' : '');
    const pathParts = [process.env.PATH || ''];
    if (javaHome) pathParts.unshift(path.join(javaHome, 'bin'));
    if (androidSdk) {
        pathParts.unshift(
            path.join(androidSdk, 'platform-tools'),
            path.join(androidSdk, 'cmdline-tools', 'latest', 'bin')
        );
    }
    const env = {
        ...process.env,
        FLUTTER_SUPPRESS_ANALYTICS: 'true',
        GRADLE_USER_HOME: GRADLE_USER_HOME,
        PUB_CACHE: PUB_CACHE_DIR,
        PATH: pathParts.filter(Boolean).join(path.delimiter),
        // Gradle daemon + cache (jangan set CI=true — memperlambat build)
        ORG_GRADLE_PROJECT_org_gradle_daemon: 'true',
        ORG_GRADLE_PROJECT_org_gradle_parallel: 'true',
        ORG_GRADLE_PROJECT_org_gradle_caching: 'true',
        ORG_GRADLE_PROJECT_org_gradle_configureondemand: 'true',
        ORG_GRADLE_PROJECT_org_gradle_jvmargs: '-Xmx4096m -XX:MaxMetaspaceSize=512m -Dkotlin.daemon.jvm.options=-Xmx2048m',
        ORG_GRADLE_PROJECT_kotlin_incremental: 'true'
    };
    if (androidSdk) {
        env.ANDROID_HOME = androidSdk;
        env.ANDROID_SDK_ROOT = androidSdk;
    }
    if (javaHome) env.JAVA_HOME = javaHome;
    return env;
}

function runCommand(cmd, args, cwd, onLine) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd,
            env: buildCommandEnv(),
            shell: false
        });
        activeBuildChild = child;

        const handle = (buf) => {
            const s = buf.toString();
            s.split('\n').forEach((line) => {
                if (line.trim()) {
                    onLine(line);
                }
            });
        };

        child.stdout.on('data', handle);
        child.stderr.on('data', handle);
        child.on('error', (err) => {
            activeBuildChild = null;
            reject(err);
        });
        child.on('close', (code) => {
            activeBuildChild = null;
            if (code === 0) resolve();
            else reject(new Error(`Perintah gagal (exit ${code}): ${cmd} ${args.join(' ')}`));
        });
    });
}

async function startAndroidApkBuild(options = {}) {
    const st = readBuildStatus();
    if (st.status === 'running') {
        throw new Error('Build sedang berjalan. Tunggu selesai atau batalkan dulu.');
    }

    const cfg = readMobileBuildConfig();
    const versionName = options.version_name || cfg.version_name;
    const versionCode = normalizeBuildNumber(options.version_code || cfg.version_code);
    const releaseNotes = options.release_notes != null ? options.release_notes : cfg.release_notes;

    const flutterPath = resolveFlutterExec(resolveFlutterPathSetting(options.flutter_path || cfg.flutter_path));

    writeBuildStatus({
        status: 'running',
        started_at: new Date().toISOString(),
        finished_at: null,
        error: null,
        apk_path: null,
        logs: []
    });

    if (String(options.version_code || cfg.version_code) !== String(versionCode)) {
        appendBuildLog(
            `Build number disesuaikan ke ${versionCode} (min ${resolveMinimumBuildNumber() + 1} untuk update dari app ${MIN_KNOWN_PRODUCTION_BUILD}+)`
        );
    }

    writeAndroidKeyProperties();
    appendBuildLog('Keystore produksi OK — signing release dengan sertifikat yang sama seperti 5.9.2');

    saveMobileBuildConfig({
        api_url: options.api_url || cfg.api_url,
        app_name: options.app_name || cfg.app_name,
        version_name: versionName,
        version_code: versionCode,
        release_notes: releaseNotes,
        force_update: options.force_update,
        flutter_path: options.flutter_path || cfg.flutter_path,
        update_manifest: false
    });

    appendBuildLog(`Memulai build APK v${versionName}+${versionCode}`);
    appendBuildLog(`Flutter: ${flutterPath}`);

    try {
        if (!fs.existsSync(MOBILE_DIR)) {
            throw new Error('Folder billing_kalimasada_mobile tidak ada');
        }

        appendBuildLog('flutter pub get …');
        await runCommand(flutterPath, ['pub', 'get'], MOBILE_DIR, appendBuildLog);

        appendBuildLog('flutter build apk --release (universal ~70 MB, semua arsitektur) …');
        await runCommand(flutterPath, BUILD_APK_ARGS, MOBILE_DIR, appendBuildLog);

        const builtApk = path.join(MOBILE_DIR, 'build/app/outputs/flutter-apk/app-release.apk');
        const apkMeta = validateBuiltApk(builtApk);

        if (!fs.existsSync(PUBLIC_APK_DIR)) {
            fs.mkdirSync(PUBLIC_APK_DIR, { recursive: true });
        }
        const outName = `kalimasada-mobile-${versionName}.apk`;
        const dest = path.join(PUBLIC_APK_DIR, outName);
        fs.copyFileSync(builtApk, dest);

        const latestDest = path.join(PUBLIC_APK_DIR, OTA_LATEST_APK_NAME);
        fs.copyFileSync(builtApk, latestDest);

        const manifest = writePublishManifest({
            versionName,
            versionCode,
            apkFileName: outName,
            releaseNotes,
            forceUpdate: !!options.force_update
        });

        const otaApkAbs = `${getPublicAppBaseUrl()}${manifest.apk_url}`;
        const otaManifestAbs = `${getPublicAppBaseUrl()}/api/mobile-adapter/app-update/manifest`;

        writeBuildStatus({
            status: 'success',
            finished_at: new Date().toISOString(),
            apk_path: dest,
            apk_url: manifest.apk_url,
            apk_download_url: manifest.apk_url,
            apk_size_mb: apkMeta.size_mb,
            ota_apk_url: otaApkAbs,
            ota_manifest_url: otaManifestAbs,
            version: versionName,
            build_number: versionCode,
            error: null
        });
        appendBuildLog(`Selesai. APK: ${dest}`);
        appendBuildLog(`OTA APK: ${otaApkAbs}`);
        appendBuildLog(`OTA manifest: ${otaManifestAbs}`);
        appendBuildLog(`Pelanggan dapat update dari aplikasi (cek versi ${versionName}+${versionCode}).`);

        return { success: true, apk_path: dest, manifest };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        writeBuildStatus({
            status: 'failed',
            finished_at: new Date().toISOString(),
            error: msg
        });
        appendBuildLog(`ERROR: ${msg}`);
        throw err;
    }
}

function cancelActiveBuild() {
    if (activeBuildChild && !activeBuildChild.killed) {
        try {
            activeBuildChild.kill('SIGTERM');
        } catch (_) {}
        activeBuildChild = null;
        writeBuildStatus({ status: 'cancelled', finished_at: new Date().toISOString() });
        appendBuildLog('Build dibatalkan.');
        return true;
    }
    return false;
}

module.exports = {
    readMobileBuildConfig,
    saveMobileBuildConfig,
    startAndroidApkBuild,
    readBuildStatus,
    cancelActiveBuild,
    readKeystoreStatus,
    writeAndroidKeyProperties,
    normalizeBuildNumber,
    getDefaultFlutterSdkPath,
    resolveFlutterPathSetting,
    MOBILE_DIR,
    PUBLIC_APK_DIR,
    KEYSTORE_FILE,
    DEFAULT_FLUTTER_SDK_PATH
};
