(function () {
  var devices = [];
  var bindingsCache = [];
  var tenantsCache = [];
  var alertEl = document.getElementById('nmsPageAlert');
  var editModalEl = document.getElementById('nmsEditBindingModal');
  var editAlertEl = document.getElementById('nmsEditAlert');

  function getEditModal() {
    if (!editModalEl || !window.bootstrap || !window.bootstrap.Modal) return null;
    return window.bootstrap.Modal.getOrCreateInstance(editModalEl);
  }

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

  function showEditAlert(type, message) {
    if (!editAlertEl) return;
    editAlertEl.className = 'alert alert-' + type;
    editAlertEl.textContent = message;
  }

  function clearEditAlert() {
    if (!editAlertEl) return;
    editAlertEl.className = 'alert d-none';
    editAlertEl.textContent = '';
  }

  function editingId() {
    var el = document.getElementById('nmsEditBindingId');
    return el && el.value ? String(el.value) : '';
  }

  function resetBindingForm() {
    var form = document.getElementById('nmsBindingForm');
    if (!form) return;
    var tenant = document.getElementById('nmsTenant');
    var router = document.getElementById('nmsRouter');
    var device = document.getElementById('nmsDevice');
    var graph = document.getElementById('nmsGraph');
    var showManagement = document.getElementById('nmsShowManagement');
    var showTenant = document.getElementById('nmsShowTenant');
    if (tenant) tenant.value = '';
    if (router) {
      router.innerHTML = '<option value="">Pilih tenant dulu</option>';
      router.disabled = true;
    }
    if (device) device.value = '';
    if (graph) {
      graph.innerHTML = '<option value="">Pilih graph</option>';
      graph.disabled = true;
    }
    if (showManagement) showManagement.checked = true;
    if (showTenant) showTenant.checked = true;
    fillDevices(devices);
  }

  function selectGraphForBinding(b, selId) {
    var sel = document.getElementById(selId || 'nmsGraph');
    if (!sel || !b) return;
    var targetId = String(b.nms_graph_id || '');
    var targetKey = String(b.interface_key || '');
    var found = false;
    Array.prototype.forEach.call(sel.options, function (opt) {
      if (!opt.value || found) return;
      try {
        var choice = JSON.parse(decodeURIComponent(opt.value));
        if ((targetId && String(choice.id || '') === targetId)
          || (targetKey && String(choice.key || '') === targetKey)) {
          sel.value = opt.value;
          found = true;
        }
      } catch (_) { /* ignore */ }
    });
    if (!found) {
      var choice = {
        source: 'binding',
        id: b.nms_graph_id || '',
        key: b.interface_key || '',
        kind: b.nms_graph_kind || 'interface',
        name: b.nms_graph_name || b.interface_key || b.nms_graph_id || 'Graph'
      };
      var opt = document.createElement('option');
      opt.value = encodeChoice(choice);
      opt.textContent = (choice.name || 'Graph tersimpan') + ' · tersimpan';
      sel.appendChild(opt);
      sel.value = opt.value;
    }
    sel.disabled = sel.options.length <= 1;
  }

  function ensureOption(sel, value, label) {
    if (!sel || value == null || value === '') return;
    var val = String(value);
    var exists = Array.prototype.some.call(sel.options, function (o) { return o.value === val; });
    if (!exists) {
      var opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label || val;
      sel.appendChild(opt);
    }
    sel.value = val;
    sel.disabled = false;
  }

  function fillTenantSelect(selId, selectedId) {
    var sel = document.getElementById(selId);
    if (!sel) return;
    var current = selectedId != null ? String(selectedId) : sel.value;
    sel.innerHTML = '<option value="">Pilih tenant</option>' + (tenantsCache || []).map(function (t) {
      return '<option value="' + t.id + '">' + escapeText(t.name) + ' (' + escapeText(t.subdomain) + ')</option>';
    }).join('');
    if (current) sel.value = current;
  }

  function fillDeviceSelect(selId, preferredValue) {
    var sel = document.getElementById(selId);
    if (!sel) return;
    var current = preferredValue != null ? preferredValue : sel.value;
    sel.innerHTML = '<option value="">Pilih perangkat</option>' + devices.map(function (d) {
      return '<option value="' + encodeURIComponent(d.id) + '">'
        + escapeText(d.name || d.id) + ' · ' + escapeText(d.ipAddress || '—') + '</option>';
    }).join('');
    if (current) {
      ensureOption(sel, current, current);
      sel.value = current;
    }
  }

  async function beginEdit(binding) {
    if (!binding || !editModalEl) return;
    clearAlert();
    clearEditAlert();

    var idEl = document.getElementById('nmsEditBindingId');
    var title = document.getElementById('nmsEditBindingTitle');
    if (idEl) idEl.value = String(binding.id);
    if (title) title.textContent = 'Edit Pemetaan · ' + (binding.tenant_name || ('#' + binding.id));

    fillTenantSelect('nmsEditTenant', binding.tenant_id);
    ensureOption(
      document.getElementById('nmsEditTenant'),
      String(binding.tenant_id || ''),
      (binding.tenant_name || 'Tenant') + (binding.tenant_subdomain ? ' (' + binding.tenant_subdomain + ')' : '')
    );

    var router = document.getElementById('nmsEditRouter');
    if (router) {
      router.disabled = false;
      if (binding.router_id != null && binding.router_id !== '') {
        router.innerHTML = '<option value="">— Tanpa router (langsung dari NMS) —</option>';
        ensureOption(
          router,
          String(binding.router_id),
          (binding.router_name || ('Router ' + binding.router_id)) + ' · ' + (binding.router_ip || '—')
        );
      } else {
        router.innerHTML = '<option value="">— Tanpa router (langsung dari NMS) —</option>';
        router.value = '';
      }
    }

    fillDeviceSelect(
      'nmsEditDevice',
      binding.nms_device_id ? encodeURIComponent(String(binding.nms_device_id)) : ''
    );
    ensureOption(
      document.getElementById('nmsEditDevice'),
      binding.nms_device_id ? encodeURIComponent(String(binding.nms_device_id)) : '',
      (binding.nms_device_name || binding.nms_device_id || 'Perangkat') + ' · ' + (binding.nms_device_ip || '—')
    );

    var graph = document.getElementById('nmsEditGraph');
    if (graph) {
      graph.innerHTML = '<option value="">Pilih graph</option>';
      selectGraphForBinding(binding, 'nmsEditGraph');
    }

    var showManagement = document.getElementById('nmsEditShowManagement');
    var showTenant = document.getElementById('nmsEditShowTenant');
    if (showManagement) showManagement.checked = !!Number(binding.show_on_management);
    if (showTenant) showTenant.checked = !!Number(binding.show_on_tenant);

    var modal = getEditModal();
    if (modal) modal.show();
    else {
      editModalEl.classList.add('show');
      editModalEl.style.display = 'block';
      editModalEl.removeAttribute('aria-hidden');
      document.body.classList.add('modal-open');
    }

    try {
      if (!devices.length) await loadDevices();
      fillDeviceSelect(
        'nmsEditDevice',
        binding.nms_device_id ? encodeURIComponent(String(binding.nms_device_id)) : ''
      );
    } catch (err) {
      console.warn('[nms] loadDevices saat edit:', err);
    }

    try {
      await loadRouters(binding.tenant_id, {
        routerId: 'nmsEditRouter',
        skipFillDevices: true
      });
      if (router) {
        if (binding.router_id != null && binding.router_id !== '') {
          ensureOption(
            router,
            String(binding.router_id),
            (binding.router_name || ('Router ' + binding.router_id)) + ' · ' + (binding.router_ip || '—')
          );
        } else {
          router.value = '';
        }
      }
    } catch (err) {
      console.warn('[nms] loadRouters saat edit:', err);
      showEditAlert('warning', 'Router gagal dimuat. Data tersimpan tetap bisa diubah.');
    }

    if (binding.nms_device_id) {
      try {
        await loadCatalog(String(binding.nms_device_id), {
          graphId: 'nmsEditGraph',
          keepBinding: binding
        });
      } catch (err) {
        console.warn('[nms] loadCatalog saat edit:', err);
        selectGraphForBinding(binding, 'nmsEditGraph');
        showEditAlert('warning', 'Katalog graph lambat/gagal. Graph tersimpan tetap terpilih.');
      }
    }
  }

  function closeEditModal() {
    var idEl = document.getElementById('nmsEditBindingId');
    if (idEl) idEl.value = '';
    clearEditAlert();
    var modal = getEditModal();
    if (modal) modal.hide();
    else if (editModalEl) {
      editModalEl.classList.remove('show');
      editModalEl.style.display = 'none';
      editModalEl.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('modal-open');
      var backdrop = document.querySelector('.modal-backdrop');
      if (backdrop) backdrop.remove();
    }
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
        ? '<button type="button" class="btn btn-sm btn-outline-primary km-infra-btn-label" data-use-device="' + encodeURIComponent(d.id) + '">Pakai</button>'
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
    tenantsCache = data.tenants || [];
    fillTenantSelect('nmsTenant');
    fillTenantSelect('nmsEditTenant');
  }

  async function loadRouters(tenantId, opts) {
    opts = opts || {};
    var sel = document.getElementById(opts.routerId || 'nmsRouter');
    if (!sel) return;
    sel.disabled = true;
    sel.innerHTML = '<option value="">Memuat router…</option>';
    if (!tenantId) {
      sel.innerHTML = '<option value="">Pilih tenant dulu</option>';
      if (!opts.skipFillDevices) fillDevices(devices);
      return;
    }
    var data = await api('/management/nms/api/routers?tenant_id=' + encodeURIComponent(tenantId));
    var rows = data.routers || [];
    var emptyLabel = rows.length
      ? '— Tanpa router (langsung dari NMS) —'
      : '— Tanpa router (tenant belum punya router) —';
    sel.innerHTML = '<option value="">' + emptyLabel + '</option>' + rows.map(function (r) {
      return '<option value="' + r.id + '" data-ip="' + escapeText(r.nas_ip || '') + '">'
        + escapeText(r.name || ('Router ' + r.id)) + ' · ' + escapeText(r.nas_ip || '—') + '</option>';
    }).join('');
    sel.disabled = false;
    if (!opts.skipFillDevices) fillDevices(devices);
  }

  async function loadCatalog(deviceId, opts) {
    opts = opts || {};
    var sel = document.getElementById(opts.graphId || 'nmsGraph');
    if (!sel) return;
    var keepBinding = opts.keepBinding || null;
    sel.disabled = true;
    if (!keepBinding) sel.innerHTML = '<option value="">Memuat graph…</option>';
    if (!deviceId) {
      sel.innerHTML = '<option value="">Pilih graph</option>';
      if (keepBinding) selectGraphForBinding(keepBinding, opts.graphId || 'nmsGraph');
      return;
    }
    try {
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
      if (keepBinding) selectGraphForBinding(keepBinding, opts.graphId || 'nmsGraph');
    } catch (err) {
      if (keepBinding) selectGraphForBinding(keepBinding, opts.graphId || 'nmsGraph');
      else {
        sel.innerHTML = '<option value="">Pilih graph</option>';
        sel.disabled = true;
      }
      throw err;
    }
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
    bindingsCache = rows;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">Belum ada pemetaan.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(function (b) {
      var missing = Number(b.router_missing) === 1;
      var noRouter = b.router_id == null || b.router_id === '';
      var routerLabel = b.router_name || (missing ? 'Router dihapus' : (noRouter ? 'Tanpa router' : '—'));
      return '<tr class="' + (b.is_active ? '' : 'opacity-50') + '">'
        + '<td>' + escapeText(b.tenant_name || '—') + '</td>'
        + '<td>' + (noRouter ? '<span class="text-muted fst-italic">' + escapeText(routerLabel) + '</span>' : escapeText(routerLabel)) + '<div class="small text-muted">' + escapeText(b.router_ip || '') + '</div></td>'
        + '<td>' + escapeText(b.nms_device_name || b.nms_device_id) + '<div class="small text-muted">' + escapeText(b.nms_device_ip || '') + '</div></td>'
        + '<td>' + escapeText(b.nms_graph_name || b.interface_key || b.nms_graph_id) + '<div class="small text-muted">' + escapeText(b.nms_graph_kind || '') + '</div></td>'
        + '<td>' + badge(b.show_on_management, b.show_on_management ? 'Ya' : 'Tidak') + '</td>'
        + '<td>' + badge(b.show_on_tenant, b.show_on_tenant ? 'Ya' : 'Tidak') + '</td>'
        + '<td class="text-end">'
        + '<div class="km-infra-actions">'
        + '<button type="button" class="btn btn-sm btn-outline-primary km-infra-btn-label" data-edit="' + b.id + '"><i class="bi bi-pencil-square"></i> Edit</button>'
        + '<button type="button" class="btn btn-sm btn-outline-secondary km-infra-btn-label" data-toggle="' + b.id + '" data-active="' + (b.is_active ? '0' : '1') + '">' + (b.is_active ? 'Nonaktifkan' : 'Aktifkan') + '</button>'
        + '<button type="button" class="btn btn-sm btn-outline-danger km-infra-btn-label" data-delete="' + b.id + '">Hapus</button>'
        + '</div>'
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

  function buildBindingPayload(prefix) {
    var isEdit = prefix === 'edit';
    var graphEl = document.getElementById(isEdit ? 'nmsEditGraph' : 'nmsGraph');
    var deviceEl = document.getElementById(isEdit ? 'nmsEditDevice' : 'nmsDevice');
    var tenantEl = document.getElementById(isEdit ? 'nmsEditTenant' : 'nmsTenant');
    var routerEl = document.getElementById(isEdit ? 'nmsEditRouter' : 'nmsRouter');
    var showMgmt = document.getElementById(isEdit ? 'nmsEditShowManagement' : 'nmsShowManagement');
    var showTen = document.getElementById(isEdit ? 'nmsEditShowTenant' : 'nmsShowTenant');
    var graphRaw = graphEl && graphEl.value;
    if (!graphRaw) return null;
    var choice;
    try { choice = JSON.parse(decodeURIComponent(graphRaw)); } catch (_) { return { error: 'Pilihan graph tidak valid.' }; }
    var deviceId = decodeURIComponent((deviceEl && deviceEl.value) || '');
    var device = deviceById(deviceId);
    var payload = {
      tenant_id: tenantEl ? tenantEl.value : '',
      router_id: routerEl ? routerEl.value : '',
      nms_device_id: deviceId,
      nms_device_name: device ? device.name : '',
      nms_device_ip: device ? device.ipAddress : '',
      nms_graph_id: choice.id || '',
      nms_graph_name: choice.name || '',
      nms_graph_kind: choice.kind || 'interface',
      interface_key: choice.key || '',
      show_on_management: !!(showMgmt && showMgmt.checked),
      show_on_tenant: !!(showTen && showTen.checked)
    };
    if (!device && isEdit) {
      var existing = bindingsCache.find(function (b) { return String(b.id) === String(editingId()); });
      if (existing) {
        payload.nms_device_name = existing.nms_device_name || '';
        payload.nms_device_ip = existing.nms_device_ip || '';
      }
    }
    return payload;
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
    var payload = buildBindingPayload('create');
    if (!payload) return;
    if (payload.error) { showAlert('danger', payload.error); return; }
    api('/management/nms/api/bindings', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (data) {
        showAlert('success', data.message || 'Pemetaan disimpan.');
        resetBindingForm();
        return loadBindings();
      })
      .catch(function (err) { showAlert('danger', err.message); });
  });

  on('nmsEditTenant', 'change', function () {
    loadRouters(this.value, { routerId: 'nmsEditRouter', skipFillDevices: true })
      .catch(function (err) { showEditAlert('danger', err.message); });
  });
  on('nmsEditDevice', 'change', function () {
    var id = this.value ? decodeURIComponent(this.value) : '';
    var keepId = editingId();
    var keep = bindingsCache.find(function (b) { return String(b.id) === String(keepId); });
    loadCatalog(id, { graphId: 'nmsEditGraph', keepBinding: keep || null })
      .catch(function (err) { showEditAlert('danger', err.message); });
  });

  on('nmsEditBindingForm', 'submit', function (ev) {
    ev.preventDefault();
    clearEditAlert();
    var id = editingId();
    if (!id) {
      showEditAlert('danger', 'ID pemetaan tidak ditemukan.');
      return;
    }
    var payload = buildBindingPayload('edit');
    if (!payload) {
      showEditAlert('danger', 'Lengkapi graph / interface.');
      return;
    }
    if (payload.error) { showEditAlert('danger', payload.error); return; }
    var submitBtn = document.getElementById('nmsEditBindingSubmit');
    if (submitBtn) submitBtn.disabled = true;
    api('/management/nms/api/bindings/' + encodeURIComponent(id), {
      method: 'POST',
      body: JSON.stringify(payload)
    })
      .then(function (data) {
        closeEditModal();
        showAlert('success', data.message || 'Pemetaan diperbarui.');
        return loadBindings();
      })
      .catch(function (err) { showEditAlert('danger', err.message); })
      .finally(function () {
        if (submitBtn) submitBtn.disabled = false;
      });
  });

  if (editModalEl) {
    editModalEl.addEventListener('hidden.bs.modal', function () {
      var idEl = document.getElementById('nmsEditBindingId');
      if (idEl) idEl.value = '';
      clearEditAlert();
    });
  }

  on('nmsBindingBody', 'click', function (ev) {
    var edit = ev.target.closest('[data-edit]');
    var toggle = ev.target.closest('[data-toggle]');
    var del = ev.target.closest('[data-delete]');
    if (edit) {
      ev.preventDefault();
      ev.stopPropagation();
      var id = edit.getAttribute('data-edit');
      var binding = bindingsCache.find(function (b) { return String(b.id) === String(id); });
      if (!binding) {
        showAlert('danger', 'Pemetaan tidak ditemukan. Muat ulang halaman.');
        return;
      }
      edit.disabled = true;
      var prevHtml = edit.innerHTML;
      edit.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';
      beginEdit(binding)
        .catch(function (err) { showAlert('danger', err.message || 'Gagal membuka form edit.'); })
        .finally(function () {
          edit.disabled = false;
          edit.innerHTML = prevHtml;
        });
      return;
    }
    if (toggle) {
      api('/management/nms/api/bindings/' + toggle.getAttribute('data-toggle'), {
        method: 'POST',
        body: JSON.stringify({ is_active: toggle.getAttribute('data-active') === '1' })
      }).then(loadBindings).catch(function (err) { showAlert('danger', err.message); });
    }
    if (del) {
      if (!window.confirm('Hapus pemetaan ini dari portal? Graph di NMS tidak dihapus.')) return;
      var deleteId = del.getAttribute('data-delete');
      api('/management/nms/api/bindings/' + deleteId, { method: 'DELETE' })
        .then(function () {
          if (editingId() && String(editingId()) === String(deleteId)) closeEditModal();
          return loadBindings();
        })
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
