(function () {
  function isLoading(body) {
    var cell = body.querySelector('td[colspan]');
    return !!cell && /^memuat/i.test(cell.textContent.trim());
  }

  function dataRows(body) {
    return Array.prototype.filter.call(body.rows, function (tr) {
      return !tr.querySelector('td[colspan]');
    });
  }

  function markLoading(body) {
    Array.prototype.forEach.call(body.querySelectorAll('td[colspan]'), function (td) {
      td.classList.toggle('km-infra-loading', /^memuat/i.test(td.textContent.trim()));
    });
  }

  function watch(target, fn) {
    if (!target) return;
    fn();
    new MutationObserver(fn).observe(target, { childList: true, subtree: true, characterData: true, attributes: true });
  }

  document.querySelectorAll('.km-infra tbody[id]').forEach(function (body) {
    watch(body, function () { markLoading(body); });
  });

  document.querySelectorAll('[data-ix-rows]').forEach(function (el) {
    var body = document.querySelector(el.getAttribute('data-ix-rows'));
    watch(body, function () {
      el.textContent = isLoading(body) ? '…' : String(dataRows(body).length);
    });
  });

  document.querySelectorAll('[data-ix-unique]').forEach(function (el) {
    var body = document.querySelector(el.getAttribute('data-ix-unique'));
    var col = Number(el.getAttribute('data-ix-col') || 0);
    watch(body, function () {
      if (isLoading(body)) { el.textContent = '…'; return; }
      var seen = {};
      dataRows(body).forEach(function (tr) {
        var cell = tr.cells[col];
        if (cell) seen[cell.textContent.trim()] = true;
      });
      el.textContent = String(Object.keys(seen).length);
    });
  });

  document.querySelectorAll('[data-ix-mirror]').forEach(function (el) {
    var src = document.querySelector(el.getAttribute('data-ix-mirror'));
    var stat = el.closest('.km-infra-stat');
    watch(src, function () {
      el.textContent = src.textContent.trim();
      if (!stat) return;
      var ok = src.classList.contains('bg-success');
      stat.classList.toggle('km-infra-stat--green', ok);
      stat.classList.toggle('km-infra-stat--slate', !ok);
    });
  });

  document.querySelectorAll('[data-ix-input]').forEach(function (el) {
    var input = document.querySelector(el.getAttribute('data-ix-input'));
    if (!input) return;
    var suffix = el.getAttribute('data-ix-suffix') || '';
    var update = function () { el.textContent = (input.value || '—') + suffix; };
    update();
    input.addEventListener('input', update);
    setTimeout(update, 800);
    setTimeout(update, 2500);
  });
})();
