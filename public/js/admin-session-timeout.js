/**
 * Idle timeout untuk sesi admin.
 * Setelah tidak ada aktivitas selama admin_session_timeout_minutes,
 * browser otomatis mengarahkan ke halaman login.
 */
(function () {
  if (window.__adminSessionTimeoutInit) return;
  window.__adminSessionTimeoutInit = true;

  // Jangan jalankan di halaman login
  var path = (window.location.pathname || '').replace(/\/+$/, '') || '/';
  if (path === '/login' || path === '/admin/login' || /\/login$/.test(path)) return;

  var minutes = Number(window.__ADMIN_SESSION_TIMEOUT_MINUTES__);
  if (!Number.isFinite(minutes)) minutes = 60;
  minutes = Math.min(Math.max(Math.round(minutes), 5), 24 * 60);

  var timeoutMs = minutes * 60 * 1000;
  var loginUrl = '/login?timeout=1';
  var lastActivityAt = Date.now();
  var timerId = null;
  var redirecting = false;
  var throttleUntil = 0;

  function goLogin() {
    if (redirecting) return;
    redirecting = true;
    try {
      if (timerId) clearTimeout(timerId);
    } catch (_e) {}
    try {
      // Hapus sesi server dulu (best-effort), lalu reload ke login
      fetch('/admin/logout', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: true,
        redirect: 'manual'
      }).catch(function () {});
    } catch (_e2) {}
    window.location.href = loginUrl;
  }

  function schedule() {
    if (redirecting) return;
    if (timerId) clearTimeout(timerId);
    var remaining = timeoutMs - (Date.now() - lastActivityAt);
    if (remaining <= 0) {
      goLogin();
      return;
    }
    timerId = setTimeout(goLogin, remaining);
  }

  function noteActivity() {
    if (redirecting) return;
    var now = Date.now();
    if (now < throttleUntil) return;
    throttleUntil = now + 1000;
    lastActivityAt = now;
    schedule();
  }

  ['mousedown', 'keydown', 'scroll', 'touchstart', 'click', 'mousemove'].forEach(function (evt) {
    document.addEventListener(evt, noteActivity, { capture: true, passive: true });
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || redirecting) return;
    if (Date.now() - lastActivityAt > timeoutMs) {
      goLogin();
    } else {
      schedule();
    }
  });

  // Jika request AJAX/fetch dapat 401 karena sesi habis → ke login
  if (window.fetch) {
    var originalFetch = window.fetch.bind(window);
    window.fetch = function () {
      return originalFetch.apply(null, arguments).then(function (res) {
        if (res && res.status === 401 && !redirecting) {
          var url = '';
          try {
            url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url) || '';
          } catch (_e) {}
          // Abaikan endpoint login/logout sendiri
          if (url && (String(url).indexOf('/login') !== -1 || String(url).indexOf('/logout') !== -1)) {
            return res;
          }
          goLogin();
        }
        return res;
      });
    };
  }

  if (window.jQuery) {
    window.jQuery(document).ajaxError(function (_event, xhr) {
      if (xhr && xhr.status === 401) goLogin();
    });
  }

  schedule();
})();
