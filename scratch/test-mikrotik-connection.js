/**
 * Test Mikrotik Connection - Skrip untuk cek apakah koneksi Mikrotik bisa nyambung dari lokal
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { RouterOSAPI } = require('node-routeros');

const DB_PATH = path.join(__dirname, '../data/billing.db');

async function main() {
    console.log('=== TEST KONEKSI MIKROTIK ===\n');
    
    // 1. Cek settings.json
    console.log('[1] Cek settings.json...');
    try {
        const settings = require('../settings.json');
        console.log(`    mikrotik_host: "${settings.mikrotik_host || '(kosong)'}"`);
        console.log(`    mikrotik_port: "${settings.mikrotik_port || '(kosong)'}"`);
        console.log(`    mikrotik_user: "${settings.mikrotik_user || '(kosong)'}"`);
        console.log(`    mikrotik_password: "${settings.mikrotik_password ? '***' : '(kosong)'}"`);
        
        if (!settings.mikrotik_host) {
            console.log('    ⚠️  Settings.json: Mikrotik host KOSONG - tidak bisa konek via legacy settings.\n');
        }
    } catch (e) {
        console.log(`    ❌ Error baca settings.json: ${e.message}\n`);
    }
    
    // 2. Cek tabel routers di database
    console.log('[2] Cek tabel routers di billing.db...');
    const db = new sqlite3.Database(DB_PATH);
    
    const routers = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM routers ORDER BY id', [], (err, rows) => {
            if (err) {
                console.log(`    ❌ Error query routers: ${err.message}`);
                resolve([]);
            } else {
                resolve(rows || []);
            }
        });
    });
    
    if (routers.length === 0) {
        console.log('    ⚠️  Tidak ada router yang terdaftar di database.');
        console.log('    💡 Anda perlu menambahkan router melalui menu Admin > NAS (RADIUS) terlebih dahulu.\n');
        db.close();
        return;
    }
    
    console.log(`    ✅ Ditemukan ${routers.length} router:\n`);
    
    // 3. Test koneksi ke setiap router
    for (const router of routers) {
        console.log(`--- Router #${router.id}: ${router.name || 'Unnamed'} ---`);
        console.log(`    IP: ${router.nas_ip || '(kosong)'}`);
        console.log(`    Port: ${router.port || router.nas_port || 8728}`);
        console.log(`    User: ${router.user || router.nas_user || router.username || '(kosong)'}`);
        console.log(`    Password: ${(router.secret || router.password) ? '***' : '(kosong)'}`);
        
        const host = router.nas_ip;
        const port = parseInt(router.port || router.nas_port || 8728);
        const user = router.user || router.nas_user || router.username;
        const password = router.secret || router.password;
        
        if (!host || !user || !password) {
            console.log(`    ❌ Data router tidak lengkap (IP/User/Password kosong). Lewati.\n`);
            continue;
        }
        
        console.log(`    🔌 Mencoba koneksi ke ${host}:${port}...`);
        
        try {
            const conn = new RouterOSAPI({
                host,
                port,
                user,
                password,
                keepalive: false,
                timeout: 15 // detik (node-routeros), bukan ms
            });
            
            await conn.connect();
            console.log(`    ✅ BERHASIL KONEK!`);
            
            // Test: ambil identity
            try {
                const identity = await conn.write('/system/identity/print');
                console.log(`    📛 Router Identity: ${identity[0]?.name || 'unknown'}`);
            } catch (e) {
                console.log(`    ⚠️  Gagal ambil identity: ${e.message}`);
            }
            
            // Test: ambil resource info
            try {
                const resource = await conn.write('/system/resource/print');
                if (resource && resource[0]) {
                    console.log(`    📊 RouterOS: v${resource[0].version || 'unknown'}`);
                    console.log(`    📊 Board: ${resource[0]['board-name'] || 'unknown'}`);
                    console.log(`    📊 Uptime: ${resource[0].uptime || 'unknown'}`);
                    console.log(`    📊 CPU Load: ${resource[0]['cpu-load'] || 'unknown'}%`);
                    console.log(`    📊 Free Memory: ${resource[0]['free-memory'] || 'unknown'} bytes`);
                }
            } catch (e) {
                console.log(`    ⚠️  Gagal ambil resource: ${e.message}`);
            }
            
            // Test: cek PPPoE secrets
            try {
                const secrets = await conn.write('/ppp/secret/print');
                console.log(`    👥 Total PPPoE Secrets: ${secrets?.length || 0}`);
            } catch (e) {
                console.log(`    ⚠️  Gagal ambil PPPoE secrets: ${e.message}`);
            }
            
            // Test: cek active PPPoE
            try {
                const active = await conn.write('/ppp/active/print');
                console.log(`    🟢 Active PPPoE: ${active?.length || 0}`);
            } catch (e) {
                console.log(`    ⚠️  Gagal ambil active PPPoE: ${e.message}`);
            }
            
            // Close connection
            try { conn.close(); } catch (e) {}
            console.log(`    🔒 Koneksi ditutup.\n`);
            
        } catch (error) {
            console.log(`    ❌ GAGAL KONEK: ${error.message}`);
            
            if (error.message.includes('ETIMEDOUT') || error.message.includes('timeout')) {
                console.log(`    💡 Kemungkinan penyebab:`);
                console.log(`       - Router tidak bisa dijangkau dari jaringan lokal ini`);
                console.log(`       - Port API (${port}) tidak dibuka di firewall router`);
                console.log(`       - IP ${host} salah atau router mati`);
            } else if (error.message.includes('ECONNREFUSED')) {
                console.log(`    💡 Koneksi ditolak: Router ada tapi port API (${port}) tidak terbuka`);
                console.log(`       - Pastikan /ip service > api enabled dan portnya benar`);
            } else if (error.message.includes('invalid user') || error.message.includes('cannot log in')) {
                console.log(`    💡 Username atau password salah`);
            }
            console.log('');
        }
    }
    
    db.close();
    console.log('=== TEST SELESAI ===');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
