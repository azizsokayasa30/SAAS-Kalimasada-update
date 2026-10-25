(function () {
  var grid = document.getElementById('nmsMrtgGrid');
  if (!grid || !window.NmsMrtg) return;
  var range = '24h';
  var query = '';
  var customFrom = '';
  var customTo = '';
  var lastPayload = null;
  var searchTimer = null;
  var searchInput = document.getElementById('nmsMrtgSearch');
  var customForm = document.getElementById('nmsMrtgCustom');
  var fromInput = document.getElementById('nmsMrtgFrom');
  var toInput = document.getElementById('nmsMrtgTo');

  function todayStamp(offsetDays) {
    var d = new Date();
    d.setDate(d.getDate() + (offsetDays || 0));
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  if (fromInput && toInput) {
    toInput.value = todayStamp(0);
    fromInput.value = todayStamp(-6);
    toInput.max = todayStamp(0);
    fromInput.max = todayStamp(0);
  }

  function filteredPayload() {
    if (!lastPayload || !Array.isArray(lastPayload.graphs)) return lastPayload;
    var q = query.trim().toLowerCase();
    if (!q) return lastPayload;
    return Object.assign({}, lastPayload, {
      graphs: lastPayload.graphs.filter(function (graph) {
        var hay = ((graph.tenantName || '') + ' ' + (graph.routerName || '')).toLowerCase();
        return hay.indexOf(q) !== -1;
      })
    });
  }

  function paint() {
    var emptyText = query.trim()
      ? 'Tidak ada graph untuk pencarian ini.'
      : 'Belum ada graph yang ditandai tampil di menu MRTG.';
    return window.NmsMrtg.render(grid, filteredPayload(), {
      audience: 'management',
      emptyText: emptyText
    });
  }

  function endpoint() {
    var url = '/management/nms/api/dashboard?range=' + encodeURIComponent(range);
    if (range === 'custom') {
      url += '&from=' + encodeURIComponent(customFrom) + '&to=' + encodeURIComponent(customTo);
    }
    return url;
  }

  function load() {
    grid.innerHTML = '<div class="col-12"><div class="nms-mrtg-empty">Memuat graph MRTG…</div></div>';
    fetch(endpoint(), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }).then(function (res) { return res.json(); }).then(function (data) {
      lastPayload = data;
      return paint();
    }).catch(function () {
      lastPayload = null;
      grid.innerHTML = '<div class="col-12"><div class="nms-mrtg-banner">Gagal memuat graph MRTG.</div></div>';
    });
  }

  function setRange(next) {
    range = next || '24h';
    document.querySelectorAll('[data-nms-range]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-nms-range') === range);
    });
    if (customForm) customForm.hidden = range !== 'custom';
  }

  document.querySelectorAll('[data-nms-range]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var next = btn.getAttribute('data-nms-range') || '24h';
      setRange(next);
      if (next === 'custom') return;
      load();
    });
  });

  if (customForm) {
    customForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      customFrom = fromInput ? fromInput.value : '';
      customTo = toInput ? toInput.value : '';
      if (!customFrom || !customTo) return;
      if (customFrom > customTo) {
        grid.innerHTML = '<div class="col-12"><div class="nms-mrtg-banner">Tanggal mulai tidak boleh setelah tanggal akhir.</div></div>';
        return;
      }
      setRange('custom');
      load();
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', function () {
      query = searchInput.value || '';
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        if (lastPayload) paint();
      }, 180);
    });
  }

  setRange('24h');
  load();
})();
