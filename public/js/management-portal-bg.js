/**
 * Kalimasada Management Portal — animated star network background
 */
(function () {
  'use strict';

  var canvas = document.getElementById('kmTechBgCanvas');
  if (!canvas || !canvas.getContext) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var root = document.documentElement;
  var ctx = canvas.getContext('2d', { alpha: true });
  var nodes = [];
  var width = 0;
  var height = 0;
  var frameId = 0;
  var running = false;
  var lastFrame = 0;
  var resizeTimer = 0;

  var CONNECT_DIST = 135;
  var CONNECT_DIST_SQ = CONNECT_DIST * CONNECT_DIST;
  var ALPHA_STEPS = 4;
  var TWO_PI = Math.PI * 2;

  // Perangkat lemah / layar kecil langsung pakai mode ringan.
  var cores = navigator.hardwareConcurrency || 4;
  var memory = navigator.deviceMemory || 8;
  var lite = cores <= 4 || memory <= 4 || window.matchMedia('(max-width: 767.98px)').matches;

  var fps = 30;
  var frameInterval = 1000 / fps;
  var speedScale = 60 / fps;
  var costSum = 0;
  var costCount = 0;

  var dark = root.getAttribute('data-theme') === 'dark';
  var palette = {};

  function buildPalette() {
    palette = {
      line: dark ? '96, 165, 250' : '37, 99, 235',
      lineMax: dark ? 0.13 : 0.1,
      dot: dark ? 'rgb(56, 189, 248)' : 'rgb(14, 165, 233)',
      dotMax: dark ? 1 : 0.85,
      core: dark ? 'rgb(186, 230, 253)' : 'rgb(255, 255, 255)',
      coreMax: dark ? 0.35 : 0.5
    };
    palette.lineStyles = [];
    for (var s = 0; s < ALPHA_STEPS; s++) {
      var alpha = ((s + 0.5) / ALPHA_STEPS) * palette.lineMax;
      palette.lineStyles.push('rgba(' + palette.line + ', ' + alpha.toFixed(3) + ')');
    }
  }

  function applyMode() {
    fps = lite ? 20 : 30;
    frameInterval = 1000 / fps;
    speedScale = 60 / fps;
    root.classList.toggle('km-bg-lite', lite);
  }

  function nodeCount() {
    var area = width * height;
    if (lite) return Math.min(55, Math.max(30, Math.floor(area / 30000)));
    return Math.min(90, Math.max(50, Math.floor(area / 18000)));
  }

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }

  function seedNodes() {
    var count = nodeCount();
    nodes = [];
    for (var i = 0; i < count; i++) {
      var isSmall = Math.random() > 0.55;
      nodes.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * (isSmall ? 0.22 : 0.3),
        vy: (Math.random() - 0.5) * (isSmall ? 0.22 : 0.3),
        r: isSmall ? Math.random() * 0.9 + 0.5 : Math.random() * 1.2 + 1.1,
        twinkle: Math.random() * TWO_PI,
        twinkleSpeed: 0.015 + Math.random() * 0.025,
        linked: !isSmall || Math.random() > 0.35
      });
    }
  }

  function draw() {
    var i;
    var j;
    var a;
    var b;
    var n = nodes.length;
    var buckets = [];
    for (i = 0; i < ALPHA_STEPS; i++) buckets.push([]);

    for (i = 0; i < n; i++) {
      a = nodes[i];
      a.x += a.vx * speedScale;
      a.y += a.vy * speedScale;
      a.twinkle += a.twinkleSpeed * speedScale;
      if (a.x <= 0 || a.x >= width) a.vx *= -1;
      if (a.y <= 0 || a.y >= height) a.vy *= -1;
    }

    for (i = 0; i < n; i++) {
      a = nodes[i];
      if (!a.linked) continue;
      for (j = i + 1; j < n; j++) {
        b = nodes[j];
        if (!b.linked) continue;
        var dx = a.x - b.x;
        if (dx > CONNECT_DIST || dx < -CONNECT_DIST) continue;
        var dy = a.y - b.y;
        var distSq = dx * dx + dy * dy;
        if (distSq >= CONNECT_DIST_SQ) continue;
        var strength = 1 - Math.sqrt(distSq) / CONNECT_DIST;
        var step = Math.min(ALPHA_STEPS - 1, Math.floor(strength * ALPHA_STEPS));
        buckets[step].push(a.x, a.y, b.x, b.y);
      }
    }

    ctx.clearRect(0, 0, width, height);

    ctx.lineWidth = 1;
    for (var s = 0; s < ALPHA_STEPS; s++) {
      var segs = buckets[s];
      if (!segs.length) continue;
      ctx.strokeStyle = palette.lineStyles[s];
      ctx.beginPath();
      for (var k = 0; k < segs.length; k += 4) {
        ctx.moveTo(segs[k], segs[k + 1]);
        ctx.lineTo(segs[k + 2], segs[k + 3]);
      }
      ctx.stroke();
    }

    ctx.fillStyle = palette.dot;
    for (i = 0; i < n; i++) {
      a = nodes[i];
      a.glow = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(a.twinkle));
      ctx.globalAlpha = a.glow * palette.dotMax;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, TWO_PI);
      ctx.fill();
    }

    if (!lite) {
      ctx.fillStyle = palette.core;
      for (i = 0; i < n; i++) {
        a = nodes[i];
        if (a.r <= 1.2) continue;
        ctx.globalAlpha = a.glow * palette.coreMax;
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r * 0.45, 0, TWO_PI);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function switchToLite() {
    lite = true;
    applyMode();
    seedNodes();
  }

  function loop(now) {
    if (!running) return;
    frameId = window.requestAnimationFrame(loop);
    var elapsed = now - lastFrame;
    if (elapsed < frameInterval) return;
    lastFrame = now - (elapsed % frameInterval);

    var t0 = performance.now();
    draw();
    if (!lite) {
      costSum += performance.now() - t0;
      costCount++;
      // Rata-rata > 6 ms per frame menandakan perangkat kewalahan.
      if (costCount >= 90) {
        if (costSum / costCount > 6) switchToLite();
        costSum = 0;
        costCount = 0;
      }
    }
  }

  function start() {
    if (running) return;
    running = true;
    lastFrame = 0;
    frameId = window.requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (frameId) window.cancelAnimationFrame(frameId);
    frameId = 0;
  }

  applyMode();
  buildPalette();
  resize();
  seedNodes();
  start();

  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resize();
      seedNodes();
    }, 200);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else start();
  });

  new MutationObserver(function () {
    var next = root.getAttribute('data-theme') === 'dark';
    if (next === dark) return;
    dark = next;
    buildPalette();
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
})();

/**
 * Bootstrap modal backdrop is appended to body (z-index 1050) while modals
 * live inside .km-shell (z-index 1) — backdrop blocks clicks. Move modals to body.
 */
(function () {
  'use strict';

  function relocatePortalModals() {
    if (!document.body.classList.contains('km-portal-body')) return;
    document.querySelectorAll('.modal').forEach(function (modalEl) {
      if (modalEl.parentElement !== document.body) {
        document.body.appendChild(modalEl);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', relocatePortalModals);
  } else {
    relocatePortalModals();
  }
})();
