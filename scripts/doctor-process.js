#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

function run(command) {
  return execSync(command, { encoding: 'utf8' });
}

function parsePs() {
  const out = run('ps -eo pid,user,args');
  return out
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) return null;
      return { pid: Number(m[1]), user: m[2], args: m[3] || '' };
    })
    .filter(Boolean);
}

function main() {
  const appPath = path.resolve(process.cwd(), 'app.js');
  const currentUser = os.userInfo().username;
  const desiredPort = Number(process.env.PORT || 3003);

  const processes = parsePs();
  const appProcs = processes.filter((p) => {
    const isNode = /\bnode\b|\bnodemon\b/.test(p.args);
    const sameApp = p.args.includes(appPath);
    const isEval = /\s-e\s/.test(p.args);
    return isNode && sameApp && !isEval;
  });

  const owners = [...new Set(appProcs.map((p) => p.user))];
  const hasMixedOwners = owners.length > 1;
  const hasForeignOwner = appProcs.some((p) => p.user !== currentUser);
  const ownerConflict = hasMixedOwners || hasForeignOwner;

  let portOutput = '';
  try {
    portOutput = run(`ss -ltnp | awk 'NR==1 || /:${desiredPort}/'`);
  } catch (_) {
    portOutput = '(gagal membaca status port)';
  }

  console.log('=== Doctor Process ===');
  console.log(`App path      : ${appPath}`);
  console.log(`Current user  : ${currentUser}`);
  console.log(`Target port   : ${desiredPort}`);
  console.log('');
  console.log(`Detected app.js processes: ${appProcs.length}`);
  if (appProcs.length === 0) {
    console.log('- Tidak ada proses app.js aktif.');
  } else {
    appProcs.forEach((p) => {
      console.log(`- PID ${p.pid} | user=${p.user}`);
    });
  }

  console.log('');
  console.log('Port listener summary:');
  console.log(portOutput.trim() || '(tidak ada output)');
  console.log('');

  if (appProcs.length > 1) {
    console.log('STATUS: CONFLICT - Lebih dari 1 proses app.js (risiko cron invoice dobel).');
    console.log('Perbaikan:');
    console.log(`  sudo pkill -f "${appPath}" ; pm2 start ecosystem.config.cjs --only billing-kalimasada --update-env`);
    return;
  }

  if (!ownerConflict) {
    console.log('STATUS: OK - Tidak ada konflik owner proses.');
    console.log('Catatan: app production hanya boleh via PM2 (lihat RUN_VIA_PM2 di ecosystem.config.cjs).');
    return;
  }

  const foreign = appProcs.filter((p) => p.user !== currentUser);
  const foreignPids = foreign.map((p) => p.pid).join(' ');

  console.log('STATUS: CONFLICT - Ditemukan proses app dengan owner campuran.');
  console.log('');
  console.log('One-shot fix command (copy-paste):');
  if (foreign.length > 0) {
    console.log(`sudo kill ${foreignPids} && pm2 restart billing-kalimasada --update-env`);
  } else {
    console.log('pm2 restart billing-kalimasada --update-env');
  }
  console.log('');
  console.log('Alternatif paksa (jika masih membandel):');
  console.log(`sudo pkill -f "${appPath}" && pm2 start ecosystem.config.cjs --only billing-kalimasada --update-env`);
}

main();
