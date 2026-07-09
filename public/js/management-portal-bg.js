/**
 * Kalimasada Management Portal — animated star network background
 */
(function () {
  'use strict';

  var canvas = document.getElementById('kmTechBgCanvas');
  if (!canvas || !canvas.getContext) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var ctx = canvas.getContext('2d');
  var nodes = [];
  var width = 0;
  var height = 0;
  var frameId = 0;
  var running = true;
  var CONNECT_DIST = 130;

  function themeIsDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  function nodeCount() {
    var area = width * height;
    return Math.min(160, Math.max(95, Math.floor(area / 8500)));
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
        twinkle: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.015 + Math.random() * 0.025,
        linked: !isSmall || Math.random() > 0.35
      });
    }
  }

  function draw() {
    if (!running) return;

    var dark = themeIsDark();
    ctx.clearRect(0, 0, width, height);

    for (var i = 0; i < nodes.length; i++) {
      var a = nodes[i];
      a.x += a.vx;
      a.y += a.vy;
      a.twinkle += a.twinkleSpeed;

      if (a.x <= 0 || a.x >= width) a.vx *= -1;
      if (a.y <= 0 || a.y >= height) a.vy *= -1;

      if (a.linked) {
        for (var j = i + 1; j < nodes.length; j++) {
          var b = nodes[j];
          if (!b.linked) continue;

          var dx = a.x - b.x;
          var dy = a.y - b.y;
          var dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < CONNECT_DIST) {
            var alpha = 1 - dist / CONNECT_DIST;
            ctx.strokeStyle = dark
              ? 'rgba(96, 165, 250, ' + (alpha * 0.13).toFixed(3) + ')'
              : 'rgba(37, 99, 235, ' + (alpha * 0.1).toFixed(3) + ')';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      var glow = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(a.twinkle));
      ctx.fillStyle = dark
        ? 'rgba(56, 189, 248, ' + glow.toFixed(3) + ')'
        : 'rgba(14, 165, 233, ' + (glow * 0.85).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.fill();

      if (a.r > 1.2) {
        ctx.fillStyle = dark
          ? 'rgba(186, 230, 253, ' + (glow * 0.35).toFixed(3) + ')'
          : 'rgba(255, 255, 255, ' + (glow * 0.5).toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    frameId = window.requestAnimationFrame(draw);
  }

  function start() {
    if (!running) {
      running = true;
      draw();
    }
  }

  function stop() {
    running = false;
    if (frameId) window.cancelAnimationFrame(frameId);
  }

  resize();
  seedNodes();
  draw();

  window.addEventListener('resize', function () {
    resize();
    seedNodes();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else start();
  });

  window.addEventListener('storage', function (e) {
    if (e.key === 'kalimasada_theme') {
      ctx.clearRect(0, 0, width, height);
    }
  });
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
