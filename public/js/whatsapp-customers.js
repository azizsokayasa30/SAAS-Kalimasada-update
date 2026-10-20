(function () {
    'use strict';

    const boot = window.WA_CUSTOMERS_BOOT || { templates: [], activeJob: null };
    const selectedIds = new Set();
    let pollTimer = null;
    let currentJobId = null;
    let lastPreview = null;
    let searchTimer = null;
    let lastQuota = null;
    let lastStats = null;
    let listedCount = 0;
    let listedWithPhone = 0;

    const $ = (id) => document.getElementById(id);

    function toast(msg, type) {
        if (typeof window.showAlert === 'function') window.showAlert(msg, type);
        else window.alert(msg);
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function getFilters() {
        const form = $('waFilterForm');
        const data = new FormData(form);
        const out = {};
        data.forEach((value, key) => {
            if (String(value).trim() !== '') out[key] = String(value).trim();
        });
        return out;
    }

    function currentTemplate() {
        const key = $('templateKey').value;
        return (boot.templates || []).find((t) => t.key === key) || { key, extra_fields: [] };
    }

    function extraPayload() {
        return {
            disruption_type: ($('extra_disruption_type') || {}).value || '',
            affected_area: ($('extra_affected_area') || {}).value || '',
            estimated_resolution: ($('extra_estimated_resolution') || {}).value || '',
            announcement_content: ($('extra_announcement_content') || {}).value || '',
            reason: ($('extra_reason') || {}).value || '',
            custom_message: ($('extra_custom_message') || {}).value || ''
        };
    }

    function renderExtraFields() {
        const tpl = currentTemplate();
        const fields = tpl.extra_fields || [];
        const box = $('extraFields');
        const html = [];
        if (fields.includes('disruption_type')) {
            html.push(fieldHtml('extra_disruption_type', 'Jenis gangguan', 'Gangguan Jaringan'));
            html.push(fieldHtml('extra_affected_area', 'Area terdampak', 'Area terfilter'));
            html.push(fieldHtml('extra_estimated_resolution', 'Estimasi selesai', 'Sedang dalam penanganan'));
        }
        if (fields.includes('announcement_content')) {
            html.push(areaHtml('extra_announcement_content', 'Isi pengumuman', 'Tulis pengumuman untuk pelanggan…'));
        }
        if (fields.includes('reason')) {
            html.push(fieldHtml('extra_reason', 'Alasan isolir', 'Tagihan tertunggak'));
        }
        if (fields.includes('custom_message')) {
            html.push(areaHtml('extra_custom_message', 'Pesan kustom', 'Halo {customer_name}, …\nPlaceholder: {customer_name} {package_name} {area} {phone} {company_header}'));
        }
        box.innerHTML = html.join('');
    }

    function fieldHtml(id, label, placeholder) {
        return `<div class="mb-3"><label class="form-label">${escapeHtml(label)}</label>
            <input type="text" class="form-control" id="${id}" placeholder="${escapeHtml(placeholder)}"></div>`;
    }

    function areaHtml(id, label, placeholder) {
        return `<div class="mb-3"><label class="form-label">${escapeHtml(label)}</label>
            <textarea class="form-control" id="${id}" rows="4" placeholder="${escapeHtml(placeholder)}"></textarea></div>`;
    }

    function plannedRecipientCount() {
        if (($('targetMode') || {}).value === 'selected') {
            return selectedIds.size;
        }
        return listedWithPhone || lastStats?.with_phone || 0;
    }

    function updateSelectedLabel() {
        $('selectedCountLabel').textContent = `${selectedIds.size} dipilih · ${listedCount} ditampilkan`;
        updateQuotaWarning();
    }

    function updateQuotaWarning(forceRecipients) {
        const quota = lastQuota;
        const banner = $('quotaWarnBanner');
        const quotaCard = $('statQuotaCard');
        if (!quota || !quota.limited) {
            banner.classList.remove('show');
            if (quotaCard) quotaCard.classList.remove('warn');
            return false;
        }
        const recipients = Number.isFinite(forceRecipients) ? forceRecipients : plannedRecipientCount();
        const remaining = Number(quota.remaining || 0);
        const over = recipients > remaining;
        banner.classList.toggle('show', over);
        if (quotaCard) quotaCard.classList.toggle('warn', over);
        if (over) {
            const mode = ($('targetMode') || {}).value === 'selected' ? 'terpilih' : 'hasil filter';
            $('quotaWarnText').textContent =
                `${recipients} penerima (${mode}) melebihi sisa kuota ${remaining}/${quota.limit}. ` +
                `Sisa pesan setelah kuota habis tidak akan terkirim.`;
        }
        return over;
    }

    function renderStats(stats, quota, gateway) {
        lastStats = stats || lastStats;
        lastQuota = quota || lastQuota;
        $('statTotal').textContent = stats?.total ?? 0;
        $('statWithPhone').textContent = stats?.with_phone ?? 0;
        $('statWithoutPhone').textContent = stats?.without_phone ?? 0;
        if (quota?.limited) {
            $('statQuota').textContent = `${quota.remaining}/${quota.limit}`;
            $('statQuotaHint').textContent = `${quota.used} sudah terkirim hari ini`;
        } else {
            $('statQuota').textContent = '∞';
            $('statQuotaHint').textContent = 'Tidak dibatasi';
            const quotaCard = $('statQuotaCard');
            if (quotaCard) quotaCard.classList.remove('warn');
        }
        const connected = !!(gateway && gateway.connected);
        const gatewayCard = $('statGatewayCard');
        if (gatewayCard) gatewayCard.classList.toggle('off', !connected);
        $('statGateway').innerHTML = `<span class="gateway-dot ${connected ? 'on' : 'off'}"></span>${escapeHtml(gateway?.provider || '—')}`;
        $('statGatewayHint').textContent = connected ? 'Siap mengirim' : (gateway?.error || 'Belum terhubung');
        updateQuotaWarning();
    }

    function statusBadge(label, kind) {
        let cls = 'secondary';
        if (kind === 'active' || kind === 'aktif' || kind === 'paid') cls = 'success';
        if (kind === 'unpaid') cls = 'danger';
        if (kind === 'isolir' || kind === 'suspended') cls = 'warning';
        if (kind === 'inactive' || kind === 'nonaktif' || kind === 'no_invoice') cls = 'secondary';
        return `<span class="badge bg-${cls}">${escapeHtml(label)}</span>`;
    }

    function renderTable(customers) {
        const body = $('customerTableBody');
        listedCount = customers?.length || 0;
        listedWithPhone = (customers || []).filter((c) => c.has_phone).length;
        if (!customers || !customers.length) {
            body.innerHTML = '<tr><td colspan="9" class="text-center text-muted py-4">Tidak ada pelanggan sesuai filter.</td></tr>';
            $('selectPage').checked = false;
            updateSelectedLabel();
            return;
        }
        body.innerHTML = customers.map((c) => {
            const disabled = c.has_phone ? '' : 'disabled';
            const rowClass = c.has_phone ? '' : 'no-phone';
            const checked = selectedIds.has(Number(c.id)) ? 'checked' : '';
            const phone = c.has_phone
                ? escapeHtml(c.phone)
                : `${escapeHtml(c.phone || '-')} <span class="badge bg-secondary">tanpa WA</span>`;
            return `<tr class="${rowClass}">
                <td><input type="checkbox" class="form-check-input row-check" value="${c.id}" ${checked} ${disabled}></td>
                <td><span class="badge bg-primary">${escapeHtml(c.customer_id || '-')}</span></td>
                <td>${escapeHtml(c.name)}</td>
                <td>${phone}</td>
                <td>${escapeHtml(c.package_name)}</td>
                <td>${escapeHtml(c.area)}</td>
                <td>${escapeHtml(c.collector_name)}</td>
                <td>${statusBadge(c.status_label, c.status)}</td>
                <td>${statusBadge(c.payment_label, c.payment_status)}</td>
            </tr>`;
        }).join('');

        body.querySelectorAll('.row-check').forEach((box) => {
            box.addEventListener('change', () => {
                const id = Number(box.value);
                if (box.checked) selectedIds.add(id);
                else selectedIds.delete(id);
                updateSelectedLabel();
                syncSelectAll();
            });
        });
        syncSelectAll();
        updateSelectedLabel();
    }

    function syncSelectAll() {
        const boxes = [...document.querySelectorAll('.row-check:not(:disabled)')];
        $('selectPage').checked = boxes.length > 0 && boxes.every((b) => b.checked);
    }

    async function loadCustomers() {
        const params = new URLSearchParams(getFilters());
        params.set('all', '1');
        const res = await fetch(`/admin/billing/whatsapp-customers/customers?${params.toString()}`, {
            headers: { Accept: 'application/json' }
        });
        const data = await res.json();
        if (!data.success) {
            toast(data.message || 'Gagal memuat pelanggan', 'danger');
            return;
        }
        // Hapus pilihan yang tidak lagi ada di hasil filter
        const visibleIds = new Set((data.customers || []).map((c) => Number(c.id)));
        [...selectedIds].forEach((id) => {
            if (!visibleIds.has(id)) selectedIds.delete(id);
        });
        renderTable(data.customers || []);
        renderStats(data.stats, data.quota, data.gateway);
        if (data.warn_quota) updateQuotaWarning(data.stats?.with_phone);
        $('pageInfo').textContent = `Menampilkan semua ${data.stats?.total || 0} pelanggan hasil filter`;
    }

    async function requestPreview() {
        const body = {
            filters: getFilters(),
            template_key: $('templateKey').value,
            extra: extraPayload(),
            target_mode: $('targetMode').value,
            customer_ids: [...selectedIds]
        };
        const res = await fetch('/admin/billing/whatsapp-customers/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!data.success) {
            $('messagePreview').textContent = data.message || 'Gagal membuat preview';
            lastPreview = null;
            return null;
        }
        lastPreview = data;
        if (data.sample && data.sample.message) {
            $('messagePreview').textContent = `Contoh untuk ${data.sample.name}:\n\n${data.sample.message}`;
        } else if (data.sample && data.sample.skipped) {
            $('messagePreview').textContent = `Contoh dilewati: ${data.sample.skipped}`;
        } else {
            $('messagePreview').textContent = 'Tidak ada pelanggan untuk preview.';
        }
        renderStats(data.stats, data.quota, data.gateway);
        updateQuotaWarning(data.stats?.with_phone);
        return data;
    }

    function setProgress(job) {
        const wrap = $('progressWrap');
        if (!job) {
            wrap.classList.remove('active');
            $('btnCancelJob').disabled = true;
            $('btnBroadcast').disabled = false;
            return;
        }
        wrap.classList.add('active');
        const p = job.progress || {};
        const running = job.status === 'queued' || job.status === 'running';
        $('btnCancelJob').disabled = !running;
        $('btnBroadcast').disabled = running;
        $('progressPercent').textContent = `${p.percent || 0}%`;
        $('progressBar').style.width = `${p.percent || 0}%`;
        $('progressBar').classList.toggle('progress-bar-animated', running);
        const statusLabel = {
            queued: 'Antrian',
            running: 'Mengirim',
            completed: 'Selesai',
            cancelled: 'Dibatalkan',
            failed: 'Gagal'
        }[job.status] || job.status;
        $('progressLabel').textContent = `${statusLabel} · ${job.template_title || ''}`;
        const eta = p.eta_seconds > 0 ? ` · sisa ±${Math.ceil(p.eta_seconds / 60)} mnt` : '';
        const current = p.current_name ? ` · ${p.current_name}` : '';
        $('progressDetail').textContent =
            `${p.processed || 0}/${p.total || 0} diproses · ${p.success || 0} sukses · ${p.failed || 0} gagal · ${p.skipped || 0} dilewati${eta}${current}`;
        const fails = (job.failures || []).slice(-5);
        $('progressFailures').innerHTML = fails.length
            ? fails.map((f) => `<div class="text-danger">${escapeHtml(f.name)} (${escapeHtml(f.phone)}): ${escapeHtml(f.reason)}</div>`).join('')
            : '';
        if (!running) {
            stopPoll();
            currentJobId = job.job_id;
        }
    }

    function stopPoll() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    async function pollJob(jobId) {
        const res = await fetch(`/admin/billing/whatsapp-customers/jobs/${encodeURIComponent(jobId)}`, {
            headers: { Accept: 'application/json' }
        });
        const data = await res.json();
        if (!data.success) return;
        setProgress(data.job);
        if (data.job && (data.job.status === 'completed' || data.job.status === 'cancelled' || data.job.status === 'failed')) {
            stopPoll();
            loadCustomers().catch(() => {});
        }
    }

    function startPoll(jobId) {
        currentJobId = jobId;
        stopPoll();
        pollJob(jobId).catch(() => {});
        pollTimer = setInterval(() => pollJob(jobId).catch(() => {}), 1500);
    }

    async function startBroadcast() {
        const body = {
            filters: getFilters(),
            template_key: $('templateKey').value,
            extra: extraPayload(),
            target_mode: $('targetMode').value,
            customer_ids: [...selectedIds]
        };
        const res = await fetch('/admin/billing/whatsapp-customers/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!data.success) {
            toast(data.message || 'Gagal memulai pengiriman', 'danger');
            return;
        }
        toast('Pengiriman dimulai', 'success');
        if (data.job) setProgress(data.job);
        startPoll(data.job_id);
    }

    function bind() {
        $('waFilterForm').addEventListener('submit', (e) => {
            e.preventDefault();
            loadCustomers().catch((err) => toast(err.message, 'danger'));
        });
        $('filterSearch').addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                loadCustomers().catch(() => {});
            }, 320);
        });
        ['filterStatus', 'filterPayment', 'filterArea', 'filterCollector', 'filterPackage', 'filterMonth', 'filterYear']
            .forEach((id) => {
                const el = $(id);
                if (!el) return;
                el.addEventListener('change', () => {
                    loadCustomers().catch(() => {});
                });
            });
        $('btnResetFilter').addEventListener('click', () => {
            $('waFilterForm').reset();
            selectedIds.clear();
            updateSelectedLabel();
            loadCustomers().catch(() => {});
        });
        $('selectPage').addEventListener('change', () => {
            document.querySelectorAll('.row-check:not(:disabled)').forEach((box) => {
                box.checked = $('selectPage').checked;
                const id = Number(box.value);
                if (box.checked) selectedIds.add(id);
                else selectedIds.delete(id);
            });
            updateSelectedLabel();
        });
        $('targetMode').addEventListener('change', () => updateQuotaWarning());
        $('templateKey').addEventListener('change', () => {
            renderExtraFields();
            requestPreview().catch(() => {});
        });
        $('btnRefreshPreview').addEventListener('click', () => {
            requestPreview().catch((err) => toast(err.message, 'danger'));
        });
        $('btnBroadcast').addEventListener('click', async () => {
            const preview = await requestPreview();
            if (!preview) {
                toast('Tidak bisa membuat preview. Periksa template dan filter.', 'warning');
                return;
            }
            const mode = $('targetMode').value === 'selected' ? 'pelanggan tercentang' : 'semua hasil filter';
            const n = preview.stats?.with_phone ?? 0;
            $('confirmText').textContent =
                `Kirim template "${preview.template_title}" ke ${n} pelanggan (${mode})? Nomor kosong akan dilewati.`;
            const over = !!(preview.warn_quota || (lastQuota?.limited && n > Number(lastQuota.remaining || 0)));
            $('confirmQuotaWarn').classList.toggle('d-none', !over);
            if (over && lastQuota) {
                $('confirmQuotaWarnText').textContent =
                    `${n} penerima melebihi sisa kuota harian ${lastQuota.remaining}/${lastQuota.limit}. ` +
                    `Setelah kuota habis, sisa pesan tidak akan terkirim.`;
            }
            $('confirmPreview').textContent = preview.sample?.message || preview.sample?.skipped || 'Tidak ada contoh pesan.';
            const modal = bootstrap.Modal.getOrCreateInstance($('confirmModal'));
            modal.show();
        });
        $('btnConfirmSend').addEventListener('click', async () => {
            const modal = bootstrap.Modal.getInstance($('confirmModal'));
            if (modal) modal.hide();
            await startBroadcast();
        });
        $('btnCancelJob').addEventListener('click', async () => {
            if (!currentJobId) return;
            const res = await fetch(`/admin/billing/whatsapp-customers/jobs/${encodeURIComponent(currentJobId)}/cancel`, {
                method: 'POST',
                headers: { Accept: 'application/json' }
            });
            const data = await res.json();
            if (!data.success) {
                toast(data.message || 'Gagal membatalkan', 'danger');
                return;
            }
            toast('Pengiriman dibatalkan', 'warning');
            if (data.job) setProgress(data.job);
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        renderExtraFields();
        bind();
        loadCustomers().catch((err) => toast(err.message, 'danger'));
        if (boot.activeJob && boot.activeJob.job_id) {
            setProgress(boot.activeJob);
            if (boot.activeJob.status === 'queued' || boot.activeJob.status === 'running') {
                startPoll(boot.activeJob.job_id);
            }
        }
    });
})();
