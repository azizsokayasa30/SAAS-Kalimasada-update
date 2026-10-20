(function () {
  var itemBadge = document.getElementById('sbInstallProgressBadge');
  var sectionBadge = document.getElementById('sbInstallProgressSectionBadge');
  if (!itemBadge && !sectionBadge) return;

  window.__sbTeknisiBadge = window.__sbTeknisiBadge || { install: 0, trouble: 0 };

  function applyCount(n) {
    var count = Number(n) || 0;
    var text = count > 99 ? '99+' : String(count);
    window.__sbTeknisiBadge.install = count;
    if (itemBadge) {
      itemBadge.textContent = text;
      if (count > 0) {
        itemBadge.classList.remove('d-none');
        itemBadge.setAttribute('aria-hidden', 'false');
      } else {
        itemBadge.classList.add('d-none');
        itemBadge.setAttribute('aria-hidden', 'true');
      }
    }
    if (typeof window.__applyTeknisiSectionBadge === 'function') {
      window.__applyTeknisiSectionBadge();
    } else if (sectionBadge) {
      var total = count + (Number(window.__sbTeknisiBadge.trouble) || 0);
      var totalText = total > 99 ? '99+' : String(total);
      sectionBadge.textContent = totalText;
      if (total > 0) {
        sectionBadge.classList.remove('d-none');
        sectionBadge.setAttribute('aria-hidden', 'false');
      } else {
        sectionBadge.classList.add('d-none');
        sectionBadge.setAttribute('aria-hidden', 'true');
      }
    }
  }

  var inFlight = false;
  function poll() {
    if (inFlight || document.hidden) return;
    inFlight = true;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
    fetch('/admin/installations/progress-badge', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (r) {
        if (!r.ok) throw new Error('badge');
        return r.json();
      })
      .then(function (data) {
        if (data && data.success) applyCount(data.count);
      })
      .catch(function () {})
      .then(function () {
        if (timer) clearTimeout(timer);
        inFlight = false;
      });
  }

  poll();
  setInterval(function () {
    if (!document.hidden) poll();
  }, 25000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) poll();
  });
})();
