async function lockMikrotikApi(id) {
  const btn = (typeof event !== 'undefined' && event && event.currentTarget) ? event.currentTarget : null;
  const old = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
  }
  try {
    const preview = await fetch('/admin/routers/' + id + '/lock-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ dryRun: true })
    }).then(function (r) { return r.json(); });
    if (!preview.success) {
      alert(preview.message || 'Tidak bisa menyiapkan kunci API');
      return;
    }
    const ips = (preview.allow || []).join('\n');
    const ok = confirm(
      'Kunci port API MikroTik (8728 dan 8729) supaya hanya IP server ini yang bisa login:\n\n'
      + ips
      + '\n\nScanner dari internet tidak bisa masuk ke API. Winbox tidak diubah. Lanjut?'
    );
    if (!ok) return;
    const res = await fetch('/admin/routers/' + id + '/lock-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ confirm: true })
    }).then(function (r) { return r.json(); });
    alert(res.message || (res.success ? 'API dikunci' : 'Gagal mengunci API'));
  } catch (e) {
    alert('Gagal menghubungi server: ' + (e && e.message ? e.message : e));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }
}
