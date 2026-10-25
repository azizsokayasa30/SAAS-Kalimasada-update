(function () {
  var CHART_SRC = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.6/dist/chart.umd.min.js';

  function loadChart() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (window.__nmsChartLoading) return window.__nmsChartLoading;
    window.__nmsChartLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = CHART_SRC;
      s.async = true;
      s.onload = function () { resolve(window.Chart); };
      s.onerror = function () { reject(new Error('Chart.js gagal dimuat')); };
      document.head.appendChild(s);
    });
    return window.__nmsChartLoading;
  }

  function formatValue(value, unit) {
    if (value == null || !isFinite(Number(value))) return '—';
    var n = Number(value);
    var u = String(unit || '');
    if (u === 'bps' || u === 'Bps' || u === 'bit/s') {
      var abs = Math.abs(n);
      if (abs >= 1e9) return (n / 1e9).toFixed(2) + ' Gbps';
      if (abs >= 1e6) return (n / 1e6).toFixed(2) + ' Mbps';
      if (abs >= 1e3) return (n / 1e3).toFixed(2) + ' Kbps';
      return n.toFixed(0) + ' bps';
    }
    if (u === '%') return n.toFixed(1) + '%';
    if (u === 'ms') return Math.round(n) + ' ms';
    return n.toFixed(1) + (u ? ' ' + u : '');
  }

  function thresholdPercent(graph) {
    var pct = Number(graph && graph.thresholdPct);
    if (!isFinite(pct)) return 95;
    return Math.min(100, Math.max(1, pct));
  }

  function directionTh(stats, percent) {
    if (!stats) return null;
    if (stats.billed != null && isFinite(Number(stats.billed))) return Number(stats.billed);
    if (stats.max == null || !isFinite(Number(stats.max))) return null;
    return Number(stats.max) * percent / 100;
  }

  function lineThreshold(graph) {
    if (graph.threshold != null && isFinite(Number(graph.threshold))) return Number(graph.threshold);
    var pct = thresholdPercent(graph);
    var inbound = directionTh(graph.inbound, pct);
    var outbound = directionTh(graph.outbound, pct);
    var values = [inbound, outbound].filter(function (v) { return v != null && isFinite(v); });
    if (!values.length) return null;
    return Math.max.apply(null, values);
  }

  function statOf(obj, key) {
    if (!obj || obj[key] == null) return null;
    return obj[key];
  }

  function formatTick(ts, spanMs) {
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    var time = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    if (spanMs != null && spanMs <= 24 * 60 * 60 * 1000) return time;
    var day = d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
    return day + ' ' + time;
  }

  function chartTheme() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var cs = getComputedStyle(document.documentElement);
    var text = (cs.getPropertyValue('--text-muted') || '').trim();
    return {
      text: text || (dark ? '#cbd5e1' : '#64748b'),
      grid: dark ? 'rgba(148, 163, 184, 0.22)' : 'rgba(15, 23, 42, 0.08)'
    };
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function interfaceName(graph) {
    return graph.name || graph.graphName || graph.interfaceKey || 'Graph';
  }

  function cardTitle(graph, audience) {
    if (audience === 'management') {
      var parts = [];
      if (graph.tenantName) parts.push(graph.tenantName);
      if (graph.routerName) parts.push(graph.routerName);
      if (parts.length) return parts.join(', ');
    }
    return interfaceName(graph);
  }

  function cardMeta(graph, audience) {
    if (audience === 'management') return interfaceName(graph);
    var parts = [];
    if (graph.routerName) parts.push(graph.routerName);
    if (graph.deviceName) parts.push(graph.deviceName);
    if (graph.interfaceKey) parts.push(graph.interfaceKey);
    return parts.join(' · ');
  }

  function statBits(label, value, unit) {
    return label + ' <b>' + formatValue(value, unit) + '</b>';
  }

  function directionRow(label, color, stats, unit, percent) {
    var th = directionTh(stats, percent);
    return '<div class="nms-mrtg-legend__row"><i class="nms-mrtg-swatch" style="background:' + escapeHtml(color) + '"></i><span>'
      + escapeHtml(label) + ' '
      + statBits('Min', statOf(stats, 'min'), unit) + ' · '
      + statBits('Avg', statOf(stats, 'avg'), unit) + ' · '
      + statBits('Max 100%', statOf(stats, 'max'), unit) + ' · '
      + statBits('TH ' + percent + '%', th, unit)
      + '</span></div>';
  }

  function statsHtml(graph) {
    var unit = graph.unit;
    if (graph.kind === 'probe') {
      return '<div class="nms-mrtg-legend"><div class="nms-mrtg-legend__row"><span>'
        + statBits('Min', graph.min, unit) + ' · '
        + statBits('Avg', graph.avg, unit) + ' · '
        + statBits('Max', graph.max, unit) + ' · '
        + statBits('Ambang', graph.threshold, unit)
        + '</span></div></div>';
    }
    var pct = thresholdPercent(graph);
    return '<div class="nms-mrtg-legend">'
      + directionRow('Masuk', graph.colorIn || '#1f8a3b', graph.inbound, unit, pct)
      + directionRow('Keluar', graph.colorOut || '#1d4e89', graph.outbound, unit, pct)
      + '</div>';
  }

  function draw(canvas, graph, axis) {
    if (!window.Chart || !canvas) return;
    var existing = window.Chart.getChart(canvas);
    if (existing) existing.destroy();
    var points = Array.isArray(graph.points) ? graph.points : [];
    if (!points.length) return;
    var xMin = points[0].t;
    var xMax = points[points.length - 1].t;
    points.forEach(function (p) {
      if (p.t < xMin) xMin = p.t;
      if (p.t > xMax) xMax = p.t;
    });
    if (axis && isFinite(axis.min) && axis.min < xMin && (xMin - axis.min) < 2 * 60 * 1000) xMin = axis.min;
    if (axis && isFinite(axis.max) && axis.max > xMax && (axis.max - xMax) < 2 * 60 * 1000) xMax = axis.max;
    if (!(xMax > xMin)) xMax = xMin + 60 * 1000;
    var pct = thresholdPercent(graph);
    var limit = lineThreshold(graph);
    var datasets = graph.kind === 'probe'
      ? [{
          label: interfaceName(graph),
          data: points.map(function (p) { return { x: p.t, y: p.v }; }),
          borderColor: graph.colorProbe || '#1f8a3b',
          backgroundColor: 'rgba(31, 138, 59, 0.18)',
          fill: true,
          tension: 0.2,
          pointRadius: 0,
          spanGaps: true
        }]
      : [
          {
            label: 'Masuk',
            data: points.map(function (p) { return { x: p.t, y: p.in }; }),
            borderColor: graph.colorIn || '#1f8a3b',
            backgroundColor: 'rgba(31, 138, 59, 0.16)',
            fill: true,
            tension: 0.15,
            pointRadius: 0,
            spanGaps: true
          },
          {
            label: 'Keluar',
            data: points.map(function (p) { return { x: p.t, y: p.out }; }),
            borderColor: graph.colorOut || '#1d4e89',
            tension: 0.15,
            pointRadius: 0,
            spanGaps: true
          }
        ];
    if (limit != null) {
      datasets.push({
        label: 'TH ' + pct + '%',
        thLine: true,
        data: [
          { x: xMin, y: limit },
          { x: xMax, y: limit }
        ],
        borderColor: graph.colorThreshold || '#c42318',
        borderDash: [4, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
        tension: 0
      });
    }
    var span = xMax - xMin;
    var colors = chartTheme();
    var chart = new window.Chart(canvas, {
      type: 'line',
      data: { datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        layout: { padding: { left: 0, right: 2, top: 8, bottom: 0 } },
        color: colors.text,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: function (item) { return !item.dataset.thLine; },
            callbacks: {
              title: function (items) { return items.length ? formatTick(items[0].parsed.x) : ''; },
              label: function (item) { return item.dataset.label + ': ' + formatValue(item.parsed.y, graph.unit); }
            }
          },
          thLabel: { value: limit, text: 'TH ' + pct + '%', color: graph.colorThreshold || '#c42318' }
        },
        scales: {
          x: {
            type: 'linear',
            min: xMin,
            max: xMax,
            offset: false,
            bounds: 'data',
            grace: 0,
            ticks: {
              color: colors.text,
              maxTicksLimit: span > 8 * 24 * 60 * 60 * 1000 ? 8 : 6,
              maxRotation: 0,
              autoSkip: true,
              callback: function (v) { return formatTick(v, span); }
            },
            grid: { color: colors.grid, offset: false },
            border: { color: colors.grid }
          },
          y: {
            min: 0,
            ticks: {
              color: colors.text,
              maxTicksLimit: 5,
              callback: function (v) { return formatValue(v, graph.unit); }
            },
            grid: { color: colors.grid },
            border: { color: colors.grid }
          }
        }
      },
      plugins: [{
        id: 'tightX',
        beforeBuildTicks: function (chart) {
          var x = chart.scales && chart.scales.x;
          if (!x) return;
          x.options.min = xMin;
          x.options.max = xMax;
          x.options.offset = false;
          x.options.grace = 0;
          x.min = xMin;
          x.max = xMax;
        },
        afterBuildTicks: function (chart) {
          var x = chart.scales && chart.scales.x;
          if (!x) return;
          x.min = xMin;
          x.max = xMax;
        }
      }, {
        id: 'thLabel',
        afterDraw: function (chart, args, opts) {
          if (opts.value == null || !chart.scales.y) return;
          var y = chart.scales.y.getPixelForValue(opts.value);
          var area = chart.chartArea;
          if (y < area.top || y > area.bottom) return;
          var ctx = chart.ctx;
          ctx.save();
          ctx.fillStyle = opts.color || '#c42318';
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(opts.text || '', area.right - 4, Math.max(area.top + 12, y - 4));
          ctx.restore();
        }
      }]
    });
    requestAnimationFrame(function () {
      if (!canvas.isConnected || !window.Chart) return;
      var live = window.Chart.getChart(canvas);
      if (live) live.resize();
    });
  }

  function axisFromPayload(payload) {
    var min = Number(payload && payload.fromMs);
    var max = Number(payload && payload.toMs);
    if (!isFinite(min) || !isFinite(max) || !(max > min)) return null;
    return { min: min, max: max };
  }

  var renderSeq = 0;
  var lastRender = null;

  function render(el, payload, options) {
    lastRender = { el: el, payload: payload, options: options };
    if (!el) return Promise.resolve();
    var seq = ++renderSeq;
    var audience = options && options.audience === 'management' ? 'management' : 'tenant';
    var emptyText = options && options.emptyText
      ? options.emptyText
      : 'Belum ada graph MRTG yang dipetakan.';
    if (!payload || payload.success === false) {
      el.innerHTML = '<div class="col-12"><div class="nms-mrtg-banner">'
        + escapeHtml((payload && payload.message) || 'Gagal memuat graph MRTG.')
        + '</div></div>';
      return Promise.resolve();
    }
    var graphs = Array.isArray(payload.graphs) ? payload.graphs : [];
    if (!graphs.length) {
      el.innerHTML = '<div class="col-12"><div class="nms-mrtg-empty">' + escapeHtml(emptyText) + '</div></div>';
      return Promise.resolve();
    }
    var axis = axisFromPayload(payload);
    var colClass = audience === 'management' ? 'col-12' : 'col-xl-6';
    el.innerHTML = graphs.map(function (graph, index) {
      var body = graph.error
        ? '<div class="nms-mrtg-card__error">' + escapeHtml(graph.error) + '</div>'
        : (graph.points && graph.points.length
            ? '<div class="nms-mrtg-card__canvas"><canvas id="nmsMrtgCanvas-' + index + '"></canvas></div>'
            : '<div class="nms-mrtg-card__error">Belum ada histori pada rentang ini.</div>');
      var meta = cardMeta(graph, audience);
      return '<div class="' + colClass + '"><div class="nms-mrtg-card' + (audience === 'management' ? ' nms-mrtg-card--management' : '') + '">'
        + '<div class="nms-mrtg-card__head"><div>'
        + '<div class="nms-mrtg-card__title">' + escapeHtml(cardTitle(graph, audience)) + '</div>'
        + (meta ? '<div class="nms-mrtg-card__meta">' + escapeHtml(meta) + '</div>' : '')
        + '</div></div>'
        + (graph.error ? '' : statsHtml(graph))
        + body
        + '</div></div>';
    }).join('');
    var needsChart = graphs.some(function (g) { return !g.error && g.points && g.points.length; });
    if (!needsChart) return Promise.resolve();
    return loadChart().then(function () {
      if (seq !== renderSeq) return;
      graphs.forEach(function (graph, index) {
        if (graph.error || !graph.points || !graph.points.length) return;
        draw(document.getElementById('nmsMrtgCanvas-' + index), graph, axis);
      });
    }).catch(function () {
      el.insertAdjacentHTML('afterbegin', '<div class="col-12"><div class="nms-mrtg-banner">Grafik tidak dapat digambar. Data NMS tetap dimuat, tetapi library chart gagal dibuka.</div></div>');
    });
  }

  if (!window.__nmsMrtgThemeWatch) {
    window.__nmsMrtgThemeWatch = true;
    new MutationObserver(function () {
      if (!lastRender || !lastRender.el || !document.body.contains(lastRender.el)) return;
      render(lastRender.el, lastRender.payload, lastRender.options);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  window.NmsMrtg = { render: render, loadChart: loadChart };
})();
