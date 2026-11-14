(function () {
    var API_BASE = '/management/mobile-app/api';
    var pollTimer = null;
    var tickTimer = null;
    var lastProgressPct = 0;
    var lastStatusRef = null;
    var LS_BUILD_DURATION = 'km_mobile_build_duration_ms';
    var DEFAULT_BUILD_MS = 8 * 60 * 1000;

    function el(id) { return document.getElementById(id); }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    var toastTimer = null;
    function notify(message, ok) {
        var box = el('mobToast');
        if (!box) { alert(message); return; }
        box.className = 'km-mob2-toast is-show ' + (ok === false ? 'is-err' : 'is-ok');
        box.innerHTML = '<i class="bi ' + (ok === false ? 'bi-x-circle-fill' : 'bi-check-circle-fill') + '"></i><span>' + escapeHtml(message) + '</span>';
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { box.classList.remove('is-show'); }, 4000);
    }

    function setText(id, value) {
        var node = el(id);
        if (node) node.textContent = value;
    }

    function setChip(chip, tone, icon, label) {
        if (!chip) return;
        chip.className = 'km-mob-chip is-' + tone;
        chip.innerHTML = '<i class="bi ' + icon + '"></i> ' + escapeHtml(label);
    }

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

    var lastReadiness = null;

    function setBuildControls(status) {
        var s = (status || 'idle').toLowerCase();
        el('btnCancelBuild').disabled = s !== 'running';
        el('btnBuildApk').disabled = s === 'running' || !!(lastReadiness && !lastReadiness.can_build);
    }

    function shortPublicPath(p) {
        return String(p || '').replace(/\\/g, '/').replace(/^.*\/public\//, 'public/');
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

        var labels = { idle: 'Siap', running: 'Berjalan', success: 'Sukses', failed: 'Gagal', cancelled: 'Dibatalkan' };
        var subs = { idle: 'Tidak ada proses', running: pct + '% selesai', success: 'Build terakhir berhasil', failed: 'Build terakhir gagal', cancelled: 'Build terakhir dibatalkan' };
        var tones = { idle: 'purple', running: 'blue', success: 'green', failed: 'red', cancelled: 'orange' };
        setText('statBuildStatus', labels[s] || s);
        setText('statBuildSub', subs[s] || '');
        var statIcon = el('statBuildIcon');
        if (statIcon) statIcon.className = 'km-set-stat__icon km-tone-' + (tones[s] || 'purple');
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
            ul.classList.remove('km-sx-filelist');
            ul.innerHTML = '<li class="km-sx-empty km-sx-empty--sm km-sx-boxed">' +
                '<span class="km-sx-empty__icon"><i class="bi bi-android2"></i></span>' +
                '<h4 class="km-sx-empty__title">Belum ada APK</h4>' +
                '<p class="km-sx-empty__text mb-0">Tekan <strong>Build APK</strong> setelah server siap. Hasil build akan muncul di sini.</p>' +
                '</li>';
            return;
        }
        var newest = files.reduce(function (m, f) { return Math.max(m, new Date(f.mtime).getTime() || 0); }, 0);
        ul.innerHTML = files.map(function (f) {
            var href = '/mobile-app/' + encodeURIComponent(f.name);
            var when = '';
            try { when = new Date(f.mtime).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) {}
            var isNewest = (new Date(f.mtime).getTime() || 0) === newest;
            return '<li class="km-sx-filelist__row">' +
                '<div class="km-sx-file">' +
                '<span class="km-sx-file__icon km-tone-green"><i class="bi bi-android2"></i></span>' +
                '<div class="min-w-0">' +
                '<div class="km-sx-file__name">' + escapeHtml(f.name) +
                (isNewest ? '<span class="km-sx-filelist__badge km-sx-filelist__badge--new">Terbaru</span>' : '') + '</div>' +
                '<div class="km-sx-file__meta">' + escapeHtml(f.size_mb) + ' MB' + (when ? ' · ' + escapeHtml(when) : '') + '</div>' +
                '</div></div>' +
                '<div class="km-sx-iconbtns">' +
                '<button type="button" class="btn btn-sm btn-outline-secondary" data-copy-url="' + escapeHtml(location.origin + href) + '" title="Salin link" aria-label="Salin link ' + escapeHtml(f.name) + '"><i class="bi bi-link-45deg"></i></button>' +
                '<a class="btn btn-sm btn-outline-success" href="' + href + '" download="' + escapeHtml(f.name) + '" title="Unduh" aria-label="Unduh ' + escapeHtml(f.name) + '"><i class="bi bi-download"></i></a>' +
                '</div>' +
                '</li>';
        }).join('');
        ul.classList.add('km-sx-filelist');
    }

    function renderReadiness(readiness) {
        var panel = el('readinessPanel');
        var text = el('readinessText');
        var icon = el('readinessIcon');
        var badge = el('readinessBadge');
        var btnBoot = el('btnBootstrapKeystore');
        var btnAdopt = el('btnAdoptKeystore');
        var ready = !!(readiness && readiness.ready);
        lastReadiness = readiness || null;

        var items = (readiness && readiness.items) || [];
        var readyCount = items.filter(function (i) { return i.ready; }).length;

        if (panel) {
            panel.className = 'km-mob-ready ' + (ready ? 'is-ready' : 'is-missing');
        }
        if (text) text.textContent = ready ? 'Server siap build' : 'Server belum siap build';
        setText('readinessCount', items.length ? readyCount + ' dari ' + items.length + ' komponen siap' : '');
        setText('statReady', items.length ? readyCount + '/' + items.length : '—');
        var bar = el('readinessBar');
        if (bar) bar.style.width = (items.length ? Math.round(readyCount * 100 / items.length) : 0) + '%';
        var readyIcon = el('statReadyIcon');
        if (readyIcon) readyIcon.className = 'km-set-stat__icon km-tone-' + (ready ? 'green' : 'orange');
        if (icon) {
            icon.className = ready ? 'bi bi-check-circle-fill' : 'bi bi-exclamation-triangle-fill';
        }

        setChip(badge, ready ? 'ok' : 'warn',
            ready ? 'bi-check-circle' : 'bi-exclamation-triangle',
            ready ? 'Server siap' : 'Server belum siap');

        var list = el('readinessList');
        if (list) {
            list.innerHTML = items.map(function (item) {
                var detail = item.detail ? shortPublicPath(item.detail).replace(/^.*[\\\/](billing_kalimasada_mobile)$/, '$1') : '';
                if (detail && String(item.label).indexOf(detail) !== -1) detail = '';
                return '<li class="' + (item.ready ? 'is-ok' : 'is-missing') + '"' +
                    (item.detail ? ' title="' + escapeHtml(item.detail) + '"' : '') + '>' +
                    '<i class="bi ' + (item.ready ? 'bi-check-circle-fill' : 'bi-x-circle-fill') + '"></i>' +
                    '<div><strong>' + escapeHtml(item.label) + '</strong>' +
                    (detail ? '<small>' + escapeHtml(detail) + '</small>' : '') + '</div></li>';
            }).join('');
        }

        var ks = (readiness && readiness.keystore) || {};
        if (btnBoot) {
            btnBoot.classList.toggle('d-none', !!(ks.ready && ks.matches_production));
        }
        if (btnAdopt) {
            btnAdopt.classList.toggle('d-none', !(ks.ready && !ks.matches_production && ks.sha256));
        }
        if (lastStatusRef && lastStatusRef.status === 'running') {
            el('btnBuildApk').disabled = true;
        } else {
            el('btnBuildApk').disabled = !(readiness && readiness.can_build);
        }
        el('btnBuildApk').title = (readiness && readiness.can_build)
            ? ''
            : 'Server belum siap build. Lengkapi komponen di panel Kesiapan Server.';
    }

    function renderKeystoreStatus(ks) {
        var okHint = el('keystoreOkHint');
        var badge = el('keystoreStatusBadge');
        if (!ks || (ks.ready && ks.matches_production)) {
            if (okHint) okHint.classList.toggle('d-none', !(ks && ks.ready && ks.matches_production));
            if (badge) {
                if (ks && ks.ready) {
                    setChip(badge, ks.matches_production ? 'ok' : 'warn', 'bi-shield-check', 'Keystore OK');
                } else {
                    badge.classList.add('d-none');
                }
            }
            return;
        }
        if (okHint) okHint.classList.add('d-none');
        setChip(badge, 'bad', 'bi-shield-x', ks.ready ? 'Keystore beda' : 'Keystore belum ada');
    }

    function fillForm(data) {
        el('apiUrl').value = data.api_url || '';
        el('appName').value = data.app_name || '';
        el('versionName').value = data.version_name || '';
        el('versionCode').value = data.version_code || 1;
        el('releaseNotes').value = data.release_notes || '';
        el('forceUpdate').checked = !!data.force_update;
        el('flutterPath').value = data.flutter_path || data.flutter_path_default || '';

        if (data.flutter_path_default && el('defaultFlutterPathHint')) {
            el('defaultFlutterPathHint').textContent = shortPublicPath(data.flutter_path_default);
        }
        if (data.apk_publish_dir && el('apkPublishDirHint')) {
            el('apkPublishDirHint').textContent = shortPublicPath(data.apk_publish_dir) + '/';
        }
        if (data.ota_manifest_url) el('otaManifestUrl').textContent = data.ota_manifest_url;
        if (data.apk_url) el('otaApkUrl').textContent = data.apk_url;

        var det = data.flutter_detected || {};
        var detHint = el('flutterDetectHint');
        if (detHint) {
            detHint.className = 'km-sx-hint ' + (det.exists ? 'is-ok' : 'is-warn');
            detHint.innerHTML = det.exists
                ? '<i class="bi bi-check-circle-fill"></i> Flutter terdeteksi di path ini.'
                : '<i class="bi bi-exclamation-triangle-fill"></i> Flutter belum ditemukan. Pasang SDK ke path default atau isi path lain.';
        }

        setChip(el('flutterStatusBadge'), det.exists ? 'ok' : 'warn',
            det.exists ? 'bi-check-circle' : 'bi-exclamation-triangle',
            det.exists ? 'Flutter OK' : 'Flutter belum ada');

        if (el('heroAppName') && data.app_name) el('heroAppName').textContent = data.app_name;

        if (data.min_build_number) {
            el('versionCode').min = data.min_build_number;
            if ((parseInt(el('versionCode').value, 10) || 0) < data.min_build_number) {
                el('versionCode').value = data.min_build_number;
                setText('versionCodeHint', 'Dinaikkan ke ' + data.min_build_number + ' untuk rilis baru.');
            } else {
                setText('versionCodeHint', 'Minimal ' + data.min_build_number + '.');
            }
        }

        setText('statVersion', data.version_name || '—');
        setText('statBuild', data.version_code || '—');
        setText('statApkCount', (data.latest_apk_files || []).length);

        renderKeystoreStatus(data.keystore);
        renderReadiness(data.readiness);
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
            notify(j.message || (j.success ? 'Konfigurasi tersimpan' : 'Gagal menyimpan'), !!j.success);
            if (j.success) loadConfig();
        } catch (err) {
            notify('Error: ' + err.message, false);
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
                notify(j.message || 'Gagal memulai build', false);
                if (j.data) renderReadiness(j.data);
                return;
            }
            lastProgressPct = 0;
            updateBuildProgress({ status: 'running', started_at: new Date().toISOString(), logs: [] });
            pollStatus();
            if (!pollTimer) pollTimer = setInterval(pollStatus, 2500);
        } catch (err) {
            notify('Error: ' + err.message, false);
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

    el('btnBootstrapKeystore').addEventListener('click', async function () {
        if (!confirm('Buat keystore baru di server ini?\n\nPerangkat yang sudah terpasang APK lama (sertifikat berbeda) harus install ulang untuk update OTA.')) return;
        try {
            var r = await fetch(API_BASE + '/keystore/bootstrap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ force: false })
            });
            var j = await r.json();
            notify(j.message || (j.success ? 'Berhasil' : 'Gagal'), !!j.success);
            if (j.success) loadConfig();
        } catch (err) {
            notify('Error: ' + err.message, false);
        }
    });

    el('btnAdoptKeystore').addEventListener('click', async function () {
        if (!confirm('Adopsi SHA keystore saat ini sebagai baseline OTA?\n\nPerangkat lama dengan sertifikat berbeda harus install ulang.')) return;
        try {
            var r = await fetch(API_BASE + '/keystore/adopt', { method: 'POST' });
            var j = await r.json();
            notify(j.message || (j.success ? 'Berhasil' : 'Gagal'), !!j.success);
            if (j.success) loadConfig();
        } catch (err) {
            notify('Error: ' + err.message, false);
        }
    });

    document.querySelectorAll('.km-mob-copy').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var target = el(btn.getAttribute('data-copy-target'));
            var value = target ? target.textContent.trim() : '';
            if (!/^https?:\/\//.test(value) || !navigator.clipboard) return;
            navigator.clipboard.writeText(value).then(function () {
                var iconEl = btn.querySelector('i');
                iconEl.className = 'bi bi-check2';
                setTimeout(function () { iconEl.className = 'bi bi-copy'; }, 1500);
            });
        });
    });

    el('apkList').addEventListener('click', function (e) {
        var btn = e.target.closest('[data-copy-url]');
        if (!btn || !navigator.clipboard) return;
        navigator.clipboard.writeText(btn.getAttribute('data-copy-url')).then(function () {
            var iconEl = btn.querySelector('i');
            iconEl.className = 'bi bi-check2';
            setTimeout(function () { iconEl.className = 'bi bi-link-45deg'; }, 1500);
            notify('Link APK disalin');
        });
    });

    loadConfig().then(pollStatus).catch(function (e) { notify(e.message, false); });
})();
