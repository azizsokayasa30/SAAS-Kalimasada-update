(function () {
  'use strict';

  var root = document.getElementById('kmDashboard');
  if (!root) return;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window) || !window.requestAnimationFrame) return;

  var COUNTER_RE = /^(Rp\s?)?([\d.]+)(%?)$/;
  var numberFmt = new Intl.NumberFormat('id-ID');

  function countUp(el) {
    var text = (el.textContent || '').trim();
    var m = text.match(COUNTER_RE);
    if (!m) return;
    var target = parseInt(m[2].replace(/\./g, ''), 10);
    if (!target || !isFinite(target)) return;
    var prefix = m[1] || '';
    var suffix = m[3] || '';
    var duration = 1100;
    var start = null;
    var last = text;
    function frame(ts) {
      if (el.textContent !== last) return;
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / duration);
      var eased = 1 - Math.pow(1 - p, 3);
      last = prefix + numberFmt.format(Math.round(target * eased)) + suffix;
      el.textContent = last;
      if (p < 1) window.requestAnimationFrame(frame);
    }
    last = prefix + '0' + suffix;
    el.textContent = last;
    window.requestAnimationFrame(frame);
  }

  var COUNTER_SEL = '.km-gcard__value, .km-dash-fin-tile__body strong, .km-donut__hole strong, .km-rank-list strong';

  function runCounters(scope) {
    if (scope.matches && scope.matches(COUNTER_SEL)) countUp(scope);
    scope.querySelectorAll(COUNTER_SEL).forEach(countUp);
  }

  root.querySelectorAll('.km-hero-pill b:not([id])').forEach(countUp);

  var selectors = [
    '.km-dash-section-title',
    '.km-quick-grid > .km-quick',
    '.km-gcards > .km-gcard',
    '.km-dash-fin-tiles > .km-dash-fin-tile',
    '.km-dash-panel'
  ];
  var items = [];
  selectors.forEach(function (sel) {
    root.querySelectorAll(sel).forEach(function (el) {
      if (items.indexOf(el) === -1) items.push(el);
    });
  });
  items.sort(function (a, b) {
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  root.classList.add('km-fx');
  items.forEach(function (el) { el.classList.add('km-reveal'); });

  var io = new IntersectionObserver(function (entries) {
    var batch = entries.filter(function (e) { return e.isIntersecting; }).map(function (e) { return e.target; });
    batch.sort(function (a, b) { return items.indexOf(a) - items.indexOf(b); });
    batch.forEach(function (el, i) {
      io.unobserve(el);
      var delay = Math.min(i, 8) * 70;
      el.style.setProperty('--rv-delay', delay + 'ms');
      el.classList.add('is-in');
      setTimeout(function () {
        el.classList.add('km-seen');
        runCounters(el);
      }, delay + 120);
      el.addEventListener('animationend', function done(ev) {
        if (ev.target !== el) return;
        el.removeEventListener('animationend', done);
        el.classList.remove('km-reveal', 'is-in');
        el.style.removeProperty('--rv-delay');
      });
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -30px 0px' });

  items.forEach(function (el) { io.observe(el); });
})();
