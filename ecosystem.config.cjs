const path = require('path');

// cwd = folder repo (sama dengan lokasi ecosystem.config.cjs). app.js memuat .env dari sini.
// Path SQLite RADIUS: isi RADIUS_SQLITE_PATH di .env (path penuh sama file modul sql FreeRADIUS),
// atau path absolut / data/... di Pengaturan RADIUS — lihat .env.example.
//
// RAM Node: --max-old-space-size membatasi heap V8 (objek JS). RSS total bisa ~heap + native;
// max_memory_restart memicu restart PM2 jika RSS melampaui nilai ini (cegah leak membesar tanpa batas).
// Sesuaikan angka jika traffic berat atau OOM saat import besar: naikkan bertahap (mis. 512 / 768).
module.exports = {
  apps: [
    {
      name: 'billing-kalimasada',
      script: path.join(__dirname, 'app.js'),
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      node_args: '--max-old-space-size=400',
      max_memory_restart: '512M',
      kill_timeout: 8000,
      env: {
        NODE_ENV: 'production',
        PM2_APP_NAME: 'billing-kalimasada'
      }
    }
  ]
};
