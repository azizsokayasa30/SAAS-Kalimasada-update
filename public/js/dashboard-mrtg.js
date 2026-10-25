(function () {
  var grid = document.getElementById('mrtgContainer');
  if (!grid || !window.NmsMrtg) return;
  var range = '24h';

  function load() {
    grid.innerHTML = '<div class="col-12 text-center text-muted py-4">Memuat graph MRTG…</div>';
    fetch('/admin/dashboard/api/mrtg?range=' + encodeURIComponent(range), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }).then(function (res) { return res.json(); }).then(function (data) {
      return window.NmsMrtg.render(grid, data, {
        audience: 'tenant',
        emptyText: 'Belum ada graph MRTG untuk router tenant ini. Pemetaan diatur dari portal management.'
      });
    }).catch(function () {
      grid.innerHTML = '<div class="col-12"><div class="nms-mrtg-banner">Gagal memuat graph MRTG.</div></div>';
    });
  }

  document.querySelectorAll('[data-tenant-mrtg-range]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      range = btn.getAttribute('data-tenant-mrtg-range') || '24h';
      document.querySelectorAll('[data-tenant-mrtg-range]').forEach(function (el) {
        el.classList.toggle('active', el === btn);
      });
      load();
    });
  });

  load();
})();
