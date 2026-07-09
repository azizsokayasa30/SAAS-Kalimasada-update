(function () {
    var API_BASE = '/management/mobile-app/api';
    var pollTimer = null;
    var tickTimer = null;
    var lastProgressPct = 0;
    var lastStatusRef = null;
    var LS_BUILD_DURATION = 'km_mobile_build_duration_ms';
    var DEFAULT_BUILD_MS = 8 * 60 * 1000;

    function el(id) { return document.getElementById(id); }

    function formatDuration(ms) {
        var sec = Math.max(15, Math.round(ms / 1000));
        if (sec < 60) return sec + ' detik';
        return Math.max(1, Math.round(sec / 60)) + ' menit';
    }

    function getStoredBuildDuration() {
        var n = parseInt(localStorage.getItem(LS_BUILD_DURATION) || '0', 10);
        return n > 60000 ? n : DEFAULT_BUILD_MS;
    }

    function storeBuildDuration(startedAt, finishedAt) {
        if (!startedAt || !finishedAt) return;
        var ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
        if (ms > 60000 && ms < 60 * 60 * 1000) {
            localStorage.setItem(LS_BUILD_DURATION, String(ms));
        }
    }

    function calcProgressFromLogs(logs) {
        if (!logs || !logs.length) return { pct: 0, phase: 'Memulai…' };
        var text = logs.map(function (e) { return e.line || ''; }).join('\n');
        var pct = 3;
        var phase = 'Menyiapkan build';

        if (text.indexOf('flutter pub get') !== -1) { pct = 8; phase = 'flutter pub get'; }
        if (text.indexOf('Resolving dependencies') !== -1) { pct = 10; phase = 'Resolving dependencies'; }
        if (text.indexOf('Downloading packages') !== -1) { pct = 14; phase = 'Mengunduh paket'; }
        if (text.indexOf('flutter build apk') !== -1) { pct = 22; phase = 'flutter build apk --release'; }
        if (text.indexOf('Running Gradle') !== -1) { pct = 35; phase = 'Gradle assembleRelease'; }

        var gradlePct = null;
        for (var i = logs.length - 1; i >= 0; i--) {
            var m = (logs[i].line || '').match(/(\d{1,3})%/);
            if (m) { gradlePct = Math.min(100, parseInt(m[1], 10)); break; }
        }
        if (gradlePct != null) {
            pct = 35 + Math.round(gradlePct * 0.55);
            phase = 'Kompilasi Gradle (' + gradlePct + '%)';
        }
        if (text.indexOf('Built build/app/outputs') !== -1 || text.indexOf('✓ Built') !== -1) {
            pct = 97; phase = 'APK berhasil dikompilasi';
        }
        if (text.indexOf('Selesai. APK:') !== -1 || text.indexOf('OTA APK:') !== -1) {
            pct = 100; phase = 'Menyalin APK & memperbarui manifest OTA';
        }

        return { pct: Math.min(99, pct), phase: phase };
    }

    function calcEta(status, pct) {
        var totalEst = getStoredBuildDuration();
        if (!status || !status.started_at) return 'Estimasi total: ~' + formatDuration(totalEst);
        var elapsed = Date.now() - new Date(status.started_at).getTime();
        if (pct >= 98) return 'Hampir selesai…';
        if (pct <= 3) return 'Estimasi total: ~' + formatDuration(totalEst);
        return 'Estimasi sisa: ~' + formatDuration(elapsed * (100 - pct) / Math.max(pct, 1));
    }

    function setBuildControls(status) {
        var s = (status || 'idle').toLowerCase();
        el('btnCancelBuild').disabled = s !== 'running';
        el('btnBuildApk').disabled = s === 'running';
    }

    function updateBuildProgress(status) {
        var data = status || {};
        var s = (data.status || 'idle').toLowerCase();
        var logs = data.logs || [];
        var headline = el('buildStatusHeadline');
        var bar = el('buildProgressBar');
        var phaseEl = el('buildProgressPhase');
        var etaEl = el('buildProgressEta');
        var pct = 0;
        var phase = 'Menunggu perintah build';
        var eta = '—';
        var barClass = 'progress-bar bg-secondary';
        var downloadRow = el('buildDownloadRow');

        if (s === 'success' && (data.apk_download_url || data.apk_url)) {
            var dlUrl = data.apk_download_url || data.apk_url;
            downloadRow.classList.remove('d-none');
            el('btnDownloadLatestApk').href = dlUrl;
            el('btnDownloadLatestApk').setAttribute('download', (dlUrl.split('/').pop() || 'kalimasada-mobile.apk'));
            el('buildDownloadSize').textContent = data.apk_size_mb
                ? ('(' + data.apk_size_mb + ' MB · universal arm/arm64/x86_64)')
                : '';
        } else {
            downloadRow.classList.add('d-none');
        }

        headline.className = 'km-build-status is-' + (s === 'running' ? 'running' : s === 'success' ? 'success' : s === 'failed' ? 'failed' : 'idle');

        if (s === 'running') {
            var prog = calcProgressFromLogs(logs);
            pct = Math.max(lastProgressPct, prog.pct);
            lastProgressPct = pct;
            phase = prog.phase;
            eta = calcEta(data, pct);
            headline.innerHTML = '<span class="km-build-spinner"></span><span id="buildStatusText">Sedang build aplikasi…</span>';
            barClass = 'progress-bar progress-bar-striped progress-bar-animated bg-primary';
        } else if (s === 'success') {
            pct = 100;
            lastProgressPct = 0;
            storeBuildDuration(data.started_at, data.finished_at);
            var ver = (data.version || '') + (data.build_number ? '+' + data.build_number : '');
            headline.innerHTML = '<i class="bi bi-check-circle-fill"></i><span id="buildStatusText">Build selesai' + (ver ? ' — ' + ver : '') + '</span>';
            phase = data.ota_apk_url ? 'OTA aktif — pengguna dapat update dari aplikasi' : 'APK siap diunduh';
            eta = data.finished_at ? new Date(data.finished_at).toLocaleString('id-ID') : 'Selesai';
            barClass = 'progress-bar bg-success';
        } else if (s === 'failed') {
            pct = Math.max(lastProgressPct, 5);
            headline.innerHTML = '<i class="bi bi-x-circle-fill"></i><span id="buildStatusText">Build gagal</span>';
            phase = data.error || 'Terjadi kesalahan saat build';
            eta = data.finished_at ? 'Gagal ' + new Date(data.finished_at).toLocaleString('id-ID') : 'Gagal';
            barClass = 'progress-bar bg-danger';
            lastProgressPct = 0;
        } else if (s === 'cancelled') {
            headline.innerHTML = '<i class="bi bi-slash-circle"></i><span id="buildStatusText">Build dibatalkan</span>';
            phase = 'Proses build dihentikan';
            barClass = 'progress-bar bg-warning';
            lastProgressPct = 0;
        } else {
            lastProgressPct = 0;
            headline.innerHTML = '<i class="bi bi-hourglass-split"></i><span id="buildStatusText">Siap build aplikasi</span>';
            eta = 'Estimasi total: ~' + formatDuration(getStoredBuildDuration());
        }

        bar.className = barClass;
        bar.style.width = pct + '%';
        bar.textContent = pct + '%';
        bar.setAttribute('aria-valuenow', String(pct));
        phaseEl.textContent = phase;
        etaEl.textContent = eta;
        setBuildControls(s);

        var statBuild = el('statBuildStatus');
        if (statBuild) {
            var labels = { idle: 'Siap', running: 'Berjalan', success: 'Sukses', failed: 'Gagal', cancelled: 'Dibatalkan' };
            statBuild.textContent = labels[s] || s;
        }
    }

    function startEtaTicker() {
        if (tickTimer) clearInterval(tickTimer);
        tickTimer = setInterval(function () {
            if (lastStatusRef && lastStatusRef.status === 'running') updateBuildProgress(lastStatusRef);
        }, 1000);
    }

    function stopEtaTicker() {
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }

    function renderLogs(logs) {
        var box = el('buildLog');
        if (!logs || !logs.length) {
            box.textContent = 'Belum ada log build.';
            box.classList.add('text-muted');
            return;
        }
        box.classList.remove('text-muted');
        box.textContent = logs.map(function (e) {
            var t = '';
            try { t = new Date(e.at).toLocaleTimeString('id-ID'); } catch (_) {}
            return '[' + t + '] ' + (e.line || '');
        }).join('\n');
        box.scrollTop = box.scrollHeight;
    }

    function renderApkList(files) {
        var ul = el('apkList');
        if (!files || !files.length) {
            ul.innerHTML = '<li class="text-muted">Belum ada APK di public/mobile-app/</li>';
            return;
        }
        ul.innerHTML = files.map(function (f) {
            var href = '/mobile-app/' + encodeURIComponent(f.name);
            return '<li>' +
                '<span class="km-apk-meta">' +
                '<strong>' + f.name + '</strong> — ' + f.size_mb + ' MB ' +
                '<span class="text-muted">(' + new Date(f.mtime).toLocaleString('id-ID') + ')</span>' +
                '</span>' +
                '<a class="btn btn-sm btn-outline-success" href="' + href + '" download="' + f.name + '">' +
                '<i class="bi bi-download me-1"></i>Unduh</a>' +
                '</li>';
        }).join('');
    }

    function renderKeystoreStatus(ks) {
        var box = el('keystoreAlert');
        var okHint = el('keystoreOkHint');
        var badge = el('keystoreStatusBadge');
        if (!ks || (ks.ready && ks.matches_production)) {
            box.classList.add('d-none');
            if (okHint) okHint.classList.toggle('d-none', !(ks && ks.ready && ks.matches_production));
            if (badge) {
                badge.classList.toggle('d-none', !(ks && ks.ready));
                if (ks && ks.ready) {
                    badge.className = 'badge ' + (ks.matches_production ? 'bg-success' : 'bg-warning text-dark');
                    badge.innerHTML = '<i class="bi bi-shield-check me-1"></i> Keystore OK';
                }
            }
            return;
        }
        if (okHint) okHint.classList.add('d-none');
        if (badge) {
            badge.classList.remove('d-none');
            badge.className = 'badge bg-danger';
            badge.innerHTML = '<i class="bi bi-shield-x me-1"></i> Keystore';
        }
        box.className = 'alert mb-3 ' + (ks.ready ? 'alert-warning' : 'alert-danger');
        box.textContent = ks.message || 'Keystore belum siap.';
        box.classList.remove('d-none');
    }

    function fillForm(data) {
        el('apiUrl').value = data.api_url || '';
        el('appName').value = data.app_name || '';
        el('versionName').value = data.version_name || '';
        el('versionCode').value = data.version_code || 1;
        el('releaseNotes').value = data.release_notes || '';
        el('forceUpdate').checked = !!data.force_update;
        el('flutterPath').value = data.flutter_path || data.flutter_path_default || '';

        if (data.flutter_path_default) {
            el('defaultFlutterPathHint').textContent = data.flutter_path_default.replace(/^.*public\//, 'public/');
        }
        if (data.apk_publish_dir) {
            el('apkPublishDirHint').textContent = data.apk_publish_dir.replace(/^.*public\//, 'public/') + '/';
        }
        if (data.ota_manifest_url) el('otaManifestUrl').textContent = data.ota_manifest_url;
        if (data.apk_url) el('otaApkUrl').textContent = data.apk_url;

        var det = data.flutter_detected || {};
        el('flutterDetectHint').textContent = det.exists
            ? 'Flutter terdeteksi: ' + det.path
            : 'Flutter belum terdeteksi — pasang SDK ke path default atau isi path lain.';

        var flutterBadge = el('flutterStatusBadge');
        if (flutterBadge) {
            flutterBadge.className = 'badge ' + (det.exists ? 'bg-success' : 'bg-warning text-dark');
            flutterBadge.innerHTML = det.exists
                ? '<i class="bi bi-check-circle me-1"></i> Flutter OK'
                : '<i class="bi bi-exclamation-triangle me-1"></i> Flutter belum terdeteksi';
        }

        if (data.min_build_number) {
            el('versionCode').min = data.min_build_number;
            el('versionCodeHint').textContent = 'Minimal ' + data.min_build_number + ' untuk update dari app 5.9.2+91';
            if (parseInt(el('versionCode').value, 10) < data.min_build_number) {
                el('versionCode').value = data.min_build_number;
            }
        }

        el('statVersion').textContent = data.version_name || '—';
        el('statBuild').textContent = data.version_code || '—';
        el('statApkCount').textContent = (data.latest_apk_files || []).length;

        renderKeystoreStatus(data.keystore);
        renderApkList(data.latest_apk_files);
        updateBuildProgress({ status: data.build_status || 'idle' });
    }

    function formPayload() {
        return {
            api_url: el('apiUrl').value.trim(),
            app_name: el('appName').value.trim(),
            version_name: el('versionName').value.trim(),
            version_code: parseInt(el('versionCode').value, 10) || 1,
            release_notes: el('releaseNotes').value.trim(),
            force_update: el('forceUpdate').checked,
            flutter_path: el('flutterPath').value.trim()
        };
    }

    async function loadConfig() {
        var r = await fetch(API_BASE + '/config');
        var j = await r.json();
        if (!j.success) throw new Error(j.message || 'Gagal memuat');
        fillForm(j.data || {});
    }

    async function pollStatus() {
        try {
            var r = await fetch(API_BASE + '/build-status');
            var j = await r.json();
            if (j.success && j.data) {
                lastStatusRef = j.data;
                updateBuildProgress(j.data);
                renderLogs(j.data.logs);
                if (j.data.status === 'running') {
                    startEtaTicker();
                    if (!pollTimer) pollTimer = setInterval(pollStatus, 2500);
                } else {
                    stopEtaTicker();
                    if (pollTimer) {
                        clearInterval(pollTimer);
                        pollTimer = null;
                        loadConfig();
                    }
                }
            }
        } catch (_) {}
    }

    el('mobileBuildForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        try {
            var r = await fetch(API_BASE + '/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formPayload())
            });
            var j = await r.json();
            alert(j.message || (j.success ? 'Tersimpan' : 'Gagal'));
            if (j.success) loadConfig();
        } catch (err) {
            alert('Error: ' + err.message);
        }
    });

    el('btnBuildApk').addEventListener('click', async function () {
        if (!confirm('Mulai build APK release? Proses bisa memakan beberapa menit.')) return;
        try {
            var r = await fetch(API_BASE + '/build', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formPayload())
            });
            var j = await r.json();
            if (!j.success) {
                alert(j.message || 'Gagal memulai build');
                return;
            }
            lastProgressPct = 0;
            updateBuildProgress({ status: 'running', started_at: new Date().toISOString(), logs: [] });
            pollStatus();
            if (!pollTimer) pollTimer = setInterval(pollStatus, 2500);
        } catch (err) {
            alert('Error: ' + err.message);
        }
    });

    el('btnCancelBuild').addEventListener('click', async function () {
        await fetch(API_BASE + '/build-cancel', { method: 'POST' });
        pollStatus();
    });

    el('btnClearLogView').addEventListener('click', function () {
        el('buildLog').textContent = '';
        el('buildLog').classList.add('text-muted');
    });

    loadConfig().then(pollStatus).catch(function (e) { alert(e.message); });
})();
