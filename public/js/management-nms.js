(function () {
  var devices = [];
  var alertEl = document.getElementById('nmsPageAlert');

  function showAlert(type, message) {
    if (!alertEl) return;
    alertEl.className = 'alert alert-' + type;
    alertEl.textContent = message;
  }

  function clearAlert() {
    if (!alertEl) return;
    alertEl.className = 'alert d-none';
    alertEl.textContent = '';
  }

  async function api(url, options) {
    var res = await fetch(url, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }
    }, options || {}));
    var data = null;
    try { data = await res.json(); } catch (_) { data = { success: false, message: 'Respons tidak valid' }; }
    if (!res.ok || data.success === false) {
      var err = new Error(data.message || 'Permintaan gagal');
      err.payload = data;
      throw err;
    }
    return data;
  }

  function selectedRouterIp() {
    var sel = document.getElementById('nmsRouter');
    var opt = sel && sel.selectedOptions[0];
    return opt ? (opt.getAttribute('data-ip') || '') : '';
  }

  function fillDevices(list) {
    devices = list || [];
    var sel = document.getElementById('nmsDevice');
    var body = document.getElementById('nmsDeviceBody');
    var routerIp = selectedRouterIp();
    if (sel) {
      var current = sel.value;
      sel.innerHTML = '<option value="">Pilih perangkat</option>' + devices.map(function (d) {
        var match = routerIp && d.ipAddress === routerIp ? ' (IP router)' : '';
        return '<option value="' + encodeURIComponent(d.id) + '">' + escapeText(d.name || d.id) + ' · ' + escapeText(d.ipAddress || '—') + match + '</option>';
      }).join('');
      if (current) sel.value = current;
    }
    if (!body) return;
    if (!devices.length) {
      body.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">Tidak ada perangkat, atau token belum valid.</td></tr>';
      return;
    }
    body.innerHTML = devices.map(function (d) {
      var match = routerIp && d.ipAddress === routerIp;
      var useBtn = sel
        ? '<button type="button" class="btn btn-sm btn-outline-primary" data-use-device="' + encodeURIComponent(d.id) + '">Pakai</button>'
        : '';
      return '<tr' + (match ? ' class="table-success"' : '') + '>'
        + '<td class="fw-semibold">' + escapeText(d.name || d.id) + '</td>'
        + '<td><code>' + escapeText(d.ipAddress || '—') + '</code></td>'
        + '<td>' + escapeText(d.location || '—') + '</td>'
        + '<td class="text-end">' + useBtn + '</td>'
        + '</tr>';
    }).join('');
  }

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function deviceById(id) {
    return devices.find(function (d) { return d.id === id; }) || null;
  }

  async function loadConnection() {
    var data = await api('/management/nms/api/connection');
    var baseUrl = document.getElementById('nmsBaseUrl');
    if (!baseUrl) return data;
    baseUrl.value = data.connection.baseUrl || '';
    document.getElementById('nmsTimeout').value = data.connection.timeoutMs || 8000;
    document.getElementById('nmsToken').value = '';
    document.getElementById('nmsTokenState').className = 'badge ' + (data.connection.tokenSet ? 'bg-success' : 'bg-secondary');
    document.getElementById('nmsTokenState').textContent = data.connection.tokenSet ? 'Token tersimpan' : 'Token kosong';
    return data;
  }

  async function loadDevices() {
    var body = document.getElementById('nmsDeviceBody');
    if (body) body.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">Memuat perangkat…</td></tr>';
    try {
      var data = await api('/management/nms/api/devices');
      fillDevices(data.devices);
    } catch (err) {
      fillDevices([]);
      if (body) body.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">' + escapeText(err.message) + '</td></tr>';
      else showAlert('danger', err.message);
    }
  }

  async function loadTenants() {
    var data = await api('/management/nms/api/tenants');
    var sel = document.getElementById('nmsTenant');
    sel.innerHTML = '<option value="">Pilih tenant</option>' + (data.tenants || []).map(function (t) {
      return '<option value="' + t.id + '">' + escapeText(t.name) + ' (' + escapeText(t.subdomain) + ')</option>';
    }).join('');
  }

  async function loadRouters(tenantId) {
    var sel = document.getElementById('nmsRouter');
    sel.disabled = true;
    sel.innerHTML = '<option value="">Memuat router…</option>';
    if (!tenantId) {
      sel.innerHTML = '<option value="">Pilih router</option>';
      return;
    }
    var data = await api('/management/nms/api/routers?tenant_id=' + encodeURIComponent(tenantId));
    var rows = data.routers || [];
    sel.innerHTML = '<option value="">Pilih router</option>' + rows.map(function (r) {
      return '<option value="' + r.id + '" data-ip="' + escapeText(r.nas_ip || '') + '">'
        + escapeText(r.name || ('Router ' + r.id)) + ' · ' + escapeText(r.nas_ip || '—') + '</option>';
    }).join('');
    sel.disabled = !rows.length;
    if (!rows.length) sel.innerHTML = '<option value="">Tenant ini belum punya router</option>';
    fillDevices(devices);
  }

  async function loadCatalog(deviceId) {
    var sel = document.getElementById('nmsGraph');
    sel.disabled = true;
    sel.innerHTML = '<option value="">Memuat graph…</option>';
    if (!deviceId) {
      sel.innerHTML = '<option value="">Pilih graph</option>';
      return;
    }
    var data = await api('/management/nms/api/devices/' + encodeURIComponent(deviceId) + '/catalog');
    var catalog = data.catalog || { graphs: [], interfaces: [], probes: [] };
    var html = '<option value="">Pilih graph</option>';
    (catalog.graphs || []).forEach(function (g) {
      html += '<option value="' + escapeText(encodeChoice({
        source: 'graph',
        id: g.id,
        key: g.key,
        kind: g.kind,
        name: g.name
      })) + '">' + escapeText(g.name || g.key || g.id) + ' · aktif</option>';
    });
    (catalog.interfaces || []).forEach(function (item) {
      if (item.added) return;
      html += '<option value="' + escapeText(encodeChoice({
        source: 'option',
        id: '',
        key: item.key,
        kind: 'interface',
        name: item.name
      })) + '">' + escapeText(item.name || item.key) + ' · belum di-capture</option>';
    });
    (catalog.probes || []).forEach(function (item) {
      if (item.added) return;
      html += '<option value="' + escapeText(encodeChoice({
        source: 'option',
        id: '',
        key: item.key,
        kind: 'probe',
        name: item.name
      })) + '">' + escapeText(item.name || item.key) + ' · belum di-capture</option>';
    });
    sel.innerHTML = html;
    sel.disabled = sel.options.length <= 1;
  }

  function encodeChoice(obj) {
    return encodeURIComponent(JSON.stringify(obj));
  }

  function badge(on, label) {
    return '<span class="badge ' + (on ? 'bg-success' : 'bg-secondary') + '">' + label + '</span>';
  }

  async function loadBindings() {
    var body = document.getElementById('nmsBindingBody');
    var data = await api('/management/nms/api/bindings');
    var rows = data.bindings || [];
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">Belum ada pemetaan.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(function (b) {
      var missing = Number(b.router_missing) === 1;
      return '<tr class="' + (b.is_active ? '' : 'opacity-50') + '">'
        + '<td>' + escapeText(b.tenant_name || '—') + '</td>'
        + '<td>' + escapeText(b.router_name || (missing ? 'Router dihapus' : '—')) + '<div class="small text-muted">' + escapeText(b.router_ip || '') + '</div></td>'
        + '<td>' + escapeText(b.nms_device_name || b.nms_device_id) + '<div class="small text-muted">' + escapeText(b.nms_device_ip || '') + '</div></td>'
        + '<td>' + escapeText(b.nms_graph_name || b.interface_key || b.nms_graph_id) + '<div class="small text-muted">' + escapeText(b.nms_graph_kind || '') + '</div></td>'
        + '<td>' + badge(b.show_on_management, b.show_on_management ? 'Ya' : 'Tidak') + '</td>'
        + '<td>' + badge(b.show_on_tenant, b.show_on_tenant ? 'Ya' : 'Tidak') + '</td>'
        + '<td class="text-end text-nowrap">'
        + '<button type="button" class="btn btn-sm btn-outline-secondary" data-toggle="' + b.id + '" data-active="' + (b.is_active ? '0' : '1') + '">' + (b.is_active ? 'Nonaktifkan' : 'Aktifkan') + '</button> '
        + '<button type="button" class="btn btn-sm btn-outline-danger" data-delete="' + b.id + '">Hapus</button>'
        + '</td></tr>';
    }).join('');
  }

  function connectionPayload() {
    return {
      baseUrl: document.getElementById('nmsBaseUrl').value.trim(),
      token: document.getElementById('nmsToken').value,
      timeoutMs: Number(document.getElementById('nmsTimeout').value)
    };
  }

  function on(id, event, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(event, fn);
  }

  on('nmsConnectionForm', 'submit', function (ev) {
    ev.preventDefault();
    clearAlert();
    api('/management/nms/connection', { method: 'POST', body: JSON.stringify(connectionPayload()) })
      .then(function (data) {
        showAlert('success', data.message || 'Koneksi disimpan.');
        return loadConnection();
      })
      .catch(function (err) { showAlert('danger', err.message); });
  });

  on('nmsTestBtn', 'click', function () {
    var box = document.getElementById('nmsTestResult');
    box.textContent = 'Menguji koneksi…';
    api('/management/nms/test', { method: 'POST', body: JSON.stringify(connectionPayload()) })
      .then(function (data) {
        var health = data.health || {};
        var extra = data.devices ? ' Perangkat: ' + data.devices.total + '.' : '';
        box.textContent = (data.message || '') + ' API ' + (health.api || '—') + ', database ' + (health.database || '—') + ', zabbix ' + (health.zabbix || '—') + '.' + extra;
        return loadConnection().then(loadDevices);
      })
      .catch(function (err) { box.textContent = err.message; });
  });

  on('nmsReloadDevices', 'click', loadDevices);
  on('nmsTenant', 'change', function () {
    loadRouters(this.value).catch(function (err) { showAlert('danger', err.message); });
  });
  on('nmsRouter', 'change', function () { fillDevices(devices); });
  on('nmsDevice', 'change', function () {
    var id = this.value ? decodeURIComponent(this.value) : '';
    loadCatalog(id).catch(function (err) { showAlert('danger', err.message); });
  });
  on('nmsDeviceBody', 'click', function (ev) {
    var btn = ev.target.closest('[data-use-device]');
    var sel = document.getElementById('nmsDevice');
    if (!btn || !sel) return;
    sel.value = btn.getAttribute('data-use-device');
    sel.dispatchEvent(new Event('change'));
  });

  on('nmsBindingForm', 'submit', function (ev) {
    ev.preventDefault();
    clearAlert();
    var graphRaw = document.getElementById('nmsGraph').value;
    if (!graphRaw) return;
    var choice;
    try { choice = JSON.parse(decodeURIComponent(graphRaw)); } catch (_) { showAlert('danger', 'Pilihan graph tidak valid.'); return; }
    var deviceId = decodeURIComponent(document.getElementById('nmsDevice').value || '');
    var device = deviceById(deviceId);
    var payload = {
      tenant_id: document.getElementById('nmsTenant').value,
      router_id: document.getElementById('nmsRouter').value,
      nms_device_id: deviceId,
      nms_device_name: device ? device.name : '',
      nms_device_ip: device ? device.ipAddress : '',
      nms_graph_id: choice.id || '',
      nms_graph_name: choice.name || '',
      nms_graph_kind: choice.kind || 'interface',
      interface_key: choice.key || '',
      show_on_management: document.getElementById('nmsShowManagement').checked,
      show_on_tenant: document.getElementById('nmsShowTenant').checked
    };
    api('/management/nms/api/bindings', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (data) {
        showAlert('success', data.message || 'Pemetaan disimpan.');
        var showManagement = document.getElementById('nmsShowManagement');
        var showTenant = document.getElementById('nmsShowTenant');
        if (showManagement) showManagement.checked = true;
        if (showTenant) showTenant.checked = true;
        return loadBindings();
      })
      .catch(function (err) { showAlert('danger', err.message); });
  });

  on('nmsBindingBody', 'click', function (ev) {
    var toggle = ev.target.closest('[data-toggle]');
    var del = ev.target.closest('[data-delete]');
    if (toggle) {
      api('/management/nms/api/bindings/' + toggle.getAttribute('data-toggle'), {
        method: 'POST',
        body: JSON.stringify({ is_active: toggle.getAttribute('data-active') === '1' })
      }).then(loadBindings).catch(function (err) { showAlert('danger', err.message); });
    }
    if (del) {
      if (!window.confirm('Hapus pemetaan ini dari portal? Graph di NMS tidak dihapus.')) return;
      api('/management/nms/api/bindings/' + del.getAttribute('data-delete'), { method: 'DELETE' })
        .then(function () { return loadBindings(); })
        .catch(function (err) { showAlert('danger', err.message); });
    }
  });

  var startup = [];
  if (document.getElementById('nmsConnectionForm')) startup.push(loadConnection());
  if (document.getElementById('nmsDeviceBody') || document.getElementById('nmsDevice')) startup.push(loadDevices());
  if (document.getElementById('nmsTenant')) startup.push(loadTenants());
  if (document.getElementById('nmsBindingBody')) startup.push(loadBindings());
  Promise.all(startup).catch(function (err) { showAlert('danger', err.message); });
})();
