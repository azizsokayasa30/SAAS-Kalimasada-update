(function () {
  'use strict';

  var REFRESH_MS = 25000;
  var timer = null;
  var busy = false;

  function $(id) {
    return document.getElementById(id);
  }

  function fmtNum(n) {
    return new Intl.NumberFormat('id-ID').format(Number(n) || 0);
  }

  function fmtMbps(n) {
    var v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return v.toFixed(2);
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('id-ID', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch (_) {
      return '—';
    }
  }

  function radiusClass(status) {
    if (status === 'running') return 'running';
    if (status === 'degraded') return 'degraded';
    if (status === 'not_running') return 'down';
    return 'error';
  }

  function trafficBarWidth(mbps) {
    var v = Math.min(Number(mbps) || 0, 1000);
    return Math.max(4, Math.round((v / 1000) * 100));
  }

  function setGaugeNas(online, total) {
    var pct = total > 0 ? Math.round((online / total) * 100) : 0;
    var ring = $('gaugeNasRing');
    var label = $('gaugeNasLabel');
    if (ring) {
      ring.dataset.value = String(pct);
      ring.style.setProperty('--gauge-pct', pct);
      var span = ring.querySelector('span');
      if (span) span.textContent = pct + '%';
    }
    if (label) {
      label.textContent = online + ' dari ' + total + ' NAS merespons';
    }
  }

  function setGaugeRadius(radius) {
    var servers = radius.servers || {};
    var total = Number(servers.total) || 0;
    var up = Number(servers.up) || 0;
    var pct = total > 0 ? Math.round((up / total) * 100) : 0;
    var ring = $('gaugeRadiusRing');
    var label = $('gaugeRadiusLabel');
    if (ring) {
      var status = up === total && total > 0 ? 'running' : up > 0 ? 'degraded' : total > 0 ? 'down' : 'error';
      ring.dataset.status = status;
      ring.className = 'km-dash-gauge-ring km-dash-gauge-ring--radius is-' + radiusClass(status);
      ring.style.setProperty('--gauge-pct', pct);
      ring.innerHTML = '<span>' + pct + '%</span>';
    }
    if (label) {
      label.textContent = total > 0
        ? up + ' dari ' + total + ' RADIUS server up'
        : (radius.message || 'Belum ada RADIUS server terdaftar');
    }
  }

  function renderTenantNas(rows) {
    var body = $('tenantNasBody');
    if (!body) return;
    if (!rows || !rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="text-center py-4 text-muted">Belum ada NAS terdaftar.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(function (row) {
      return (
        '<tr>' +
        '<td><strong>' + escapeHtml(row.tenant_name || '—') + '</strong><br><small class="text-muted">' + escapeHtml(row.tenant_subdomain || '') + '</small></td>' +
        '<td>' + fmtNum(row.customers) + '</td>' +
        '<td>' + fmtNum(row.routers) + '</td>' +
        '<td><span class="text-success">' + fmtNum(row.nas_online) + '</span> / <span class="text-danger">' + fmtNum(row.nas_offline) + '</span></td>' +
        '<td>' + fmtNum(row.active_sessions) + '</td>' +
        '<td class="text-end text-primary">' + fmtMbps(row.rx_mbps) + '</td>' +
        '<td class="text-end text-info">' + fmtMbps(row.tx_mbps) + '</td>' +
        '</tr>'
      );
    }).join('');
  }

  function renderNasLive(items) {
    var body = $('nasLiveBody');
    var count = $('nasTableCount');
    if (!body) return;
    if (count) count.textContent = (items && items.length) ? items.length + ' NAS' : '0 NAS';
    if (!items || !items.length) {
      body.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">Belum ada NAS terdaftar.</td></tr>';
      return;
    }
    body.innerHTML = items.map(function (item) {
      var badge = item.status === 'online'
        ? '<span class="badge bg-success">online</span>'
        : '<span class="badge bg-danger" title="' + escapeHtml(item.error || '') + '">offline</span>';
      return (
        '<tr>' +
        '<td><strong>' + escapeHtml(item.name) + '</strong></td>' +
        '<td>' + escapeHtml(item.tenant_name || '—') + '</td>' +
        '<td><code>' + escapeHtml(item.nas_ip || '—') + '</code></td>' +
        '<td>' + badge + '</td>' +
        '<td class="text-end">' + (item.status === 'online' ? fmtMbps(item.rx_mbps) : '—') + '</td>' +
        '<td class="text-end">' + (item.status === 'online' ? fmtMbps(item.tx_mbps) : '—') + '</td>' +
        '</tr>'
      );
    }).join('');
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function applyMetrics(data) {
    if (!data || !data.success) return;

    var stats = data.stats || {};
    var radius = data.radius || {};
    var network = data.network || {};
    var nas = network.nas || {};
    var traffic = network.traffic || {};

    if ($('kpiTotalTenants')) $('kpiTotalTenants').textContent = fmtNum(stats.totalTenants);
    if ($('kpiTotalCustomers')) $('kpiTotalCustomers').textContent = fmtNum(stats.totalCustomers);

    if ($('kpiRadiusTotal')) $('kpiRadiusTotal').textContent = fmtNum(radius.servers?.total ?? '—');
    if ($('kpiRadiusUp')) $('kpiRadiusUp').textContent = fmtNum(radius.servers?.up ?? '—') + ' up';
    if ($('kpiRadiusDown')) $('kpiRadiusDown').textContent = fmtNum(radius.servers?.down ?? '—') + ' down';

    if ($('kpiRxMbps')) $('kpiRxMbps').textContent = fmtMbps(traffic.rx_mbps);
    if ($('kpiTxMbps')) $('kpiTxMbps').textContent = fmtMbps(traffic.tx_mbps);
    if ($('kpiMainIface')) $('kpiMainIface').textContent = traffic.interface || network.main_interface || '—';
    if ($('kpiTrafficRouters')) $('kpiTrafficRouters').textContent = fmtNum(traffic.reporting);

    if ($('dashUpdatedAt')) $('dashUpdatedAt').textContent = 'Diperbarui ' + fmtTime(data.updatedAt);

    setGaugeNas(nas.online || 0, nas.total || 0);
    setGaugeRadius(radius);

    if ($('barRx')) $('barRx').style.width = trafficBarWidth(traffic.rx_mbps) + '%';
    if ($('barTx')) $('barTx').style.width = trafficBarWidth(traffic.tx_mbps) + '%';
    if ($('barRxLabel')) $('barRxLabel').textContent = fmtMbps(traffic.rx_mbps) + ' Mbps';
    if ($('barTxLabel')) $('barTxLabel').textContent = fmtMbps(traffic.tx_mbps) + ' Mbps';

    renderTenantNas(network.tenantBreakdown || []);
    renderNasLive(nas.items || []);
  }

  async function loadMetrics() {
    if (busy) return;
    busy = true;
    var btn = $('dashRefreshBtn');
    if (btn) btn.disabled = true;
    try {
      var res = await fetch('/management/dashboard/api/metrics', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      var data = await res.json();
      applyMetrics(data);
    } catch (err) {
      if ($('dashUpdatedAt')) $('dashUpdatedAt').textContent = 'Gagal memuat data live';
      console.error('[dashboard]', err);
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
    }
  }

  function startPolling() {
    if (timer) clearInterval(timer);
    timer = setInterval(loadMetrics, REFRESH_MS);
  }

  document.addEventListener('DOMContentLoaded', function () {
    loadMetrics();
    startPolling();
    var btn = $('dashRefreshBtn');
    if (btn) btn.addEventListener('click', loadMetrics);
  });
})();
