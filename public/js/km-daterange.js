(function () {
  'use strict';

  var MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  var MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  var WEEKDAYS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
  var DAY_MS = 86400000;

  function pad(n) { return String(n).padStart(2, '0'); }
  function toIso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseIso(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function today() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function spanDays(a, b) { return Math.round((b - a) / DAY_MS) + 1; }
  function same(a, b) { return !!a && !!b && a.getTime() === b.getTime(); }
  function fmt(d) { return d.getDate() + ' ' + MONTHS_SHORT[d.getMonth()] + ' ' + d.getFullYear(); }
  function fmtRange(a, b) {
    if (same(a, b)) return fmt(a);
    if (a.getFullYear() !== b.getFullYear()) return fmt(a) + ' – ' + fmt(b);
    if (a.getMonth() !== b.getMonth()) return a.getDate() + ' ' + MONTHS_SHORT[a.getMonth()] + ' – ' + fmt(b);
    return a.getDate() + ' – ' + fmt(b);
  }

  function presets() {
    var t = today();
    return [
      { label: 'Hari ini', from: t, to: t },
      { label: 'Kemarin', from: addDays(t, -1), to: addDays(t, -1) },
      { label: '7 hari terakhir', from: addDays(t, -6), to: t },
      { label: '14 hari terakhir', from: addDays(t, -13), to: t },
      { label: '30 hari terakhir', from: addDays(t, -29), to: t },
      { label: '90 hari terakhir', from: addDays(t, -89), to: t },
      { label: 'Bulan ini', from: new Date(t.getFullYear(), t.getMonth(), 1), to: t },
      { label: 'Bulan lalu', from: new Date(t.getFullYear(), t.getMonth() - 1, 1), to: new Date(t.getFullYear(), t.getMonth(), 0) }
    ];
  }

  function init(root) {
    var form = root.closest('form');
    var fromInput = document.querySelector(root.getAttribute('data-drp-from'));
    var toInput = document.querySelector(root.getAttribute('data-drp-to'));
    var toggle = root.querySelector('[data-drp-toggle]');
    var panel = root.querySelector('[data-drp-panel]');
    if (!fromInput || !toInput || !toggle || !panel) return;

    var maxAttr = root.getAttribute('data-drp-max');
    var maxDate = maxAttr === 'today' ? today() : parseIso(maxAttr);
    var maxSpan = Number(root.getAttribute('data-drp-max-span')) || 0;
    var labels = {};
    root.querySelectorAll('[data-drp-label]').forEach(function (el) { labels[el.getAttribute('data-drp-label')] = el; });

    var st = { start: null, end: null, hover: null, view: 'days', y: 0, m: 0, yearPage: 0 };

    function isDisabled(d) { return !!maxDate && d > maxDate; }

    function renderLabels() {
      var a = parseIso(fromInput.value);
      var b = parseIso(toInput.value);
      if (labels.from) labels.from.textContent = a ? fmt(a) : 'Pilih tanggal';
      if (labels.to) labels.to.textContent = b ? fmt(b) : 'Pilih tanggal';
      if (labels.days) {
        labels.days.textContent = a && b ? spanDays(a, b) + ' hari' : '';
        labels.days.hidden = !(a && b);
      }
    }

    function syncFromInputs() {
      st.start = parseIso(fromInput.value);
      st.end = parseIso(toInput.value);
      st.hover = null;
      st.view = 'days';
      var anchor = st.end || st.start || today();
      st.y = anchor.getFullYear();
      st.m = anchor.getMonth();
    }

    function headTitle() {
      if (st.view === 'days') return MONTHS[st.m] + ' ' + st.y;
      if (st.view === 'months') return String(st.y);
      return st.yearPage + ' – ' + (st.yearPage + 11);
    }

    function navDisabled(step) {
      if (!maxDate || step < 0) return false;
      if (st.view === 'days') return new Date(st.y, st.m + 1, 1) > maxDate;
      if (st.view === 'months') return st.y + 1 > maxDate.getFullYear();
      return st.yearPage + 12 > maxDate.getFullYear();
    }

    function daysHtml() {
      var first = new Date(st.y, st.m, 1);
      var offset = (first.getDay() + 6) % 7;
      var cursor = addDays(first, -offset);
      var t = today();
      var html = '<div class="km-drp__weekdays">' + WEEKDAYS.map(function (w) { return '<span>' + w + '</span>'; }).join('') + '</div><div class="km-drp__days-grid">';
      for (var i = 0; i < 42; i++) {
        var d = addDays(cursor, i);
        var cls = ['km-drp__day'];
        if (d.getMonth() !== st.m) cls.push('is-outside');
        if (same(d, t)) cls.push('is-today');
        if ((d.getDay() + 6) % 7 >= 5) cls.push('is-weekend');
        var dis = isDisabled(d);
        html += '<button type="button" class="' + cls.join(' ') + '" data-date="' + toIso(d) + '"' + (dis ? ' disabled' : '') + '><span>' + d.getDate() + '</span></button>';
      }
      return html + '</div>';
    }

    function monthsHtml() {
      var html = '<div class="km-drp__grid">';
      var t = today();
      for (var m = 0; m < 12; m++) {
        var cls = ['km-drp__cell'];
        if (m === st.m) cls.push('is-active');
        if (st.y === t.getFullYear() && m === t.getMonth()) cls.push('is-now');
        var dis = isDisabled(new Date(st.y, m, 1));
        html += '<button type="button" class="' + cls.join(' ') + '" data-month="' + m + '"' + (dis ? ' disabled' : '') + '>' + MONTHS_SHORT[m] + '</button>';
      }
      return html + '</div>';
    }

    function yearsHtml() {
      var html = '<div class="km-drp__grid">';
      var nowY = today().getFullYear();
      for (var y = st.yearPage; y < st.yearPage + 12; y++) {
        var cls = ['km-drp__cell'];
        if (y === st.y) cls.push('is-active');
        if (y === nowY) cls.push('is-now');
        var dis = !!maxDate && y > maxDate.getFullYear();
        html += '<button type="button" class="' + cls.join(' ') + '" data-year="' + y + '"' + (dis ? ' disabled' : '') + '>' + y + '</button>';
      }
      return html + '</div>';
    }

    function presetsHtml() {
      return '<div class="km-drp__presets"><span class="km-drp__presets-title">Pilihan cepat</span>' +
        presets().map(function (p, i) {
          var active = same(p.from, st.start) && same(p.to, st.end);
          return '<button type="button" class="km-drp__preset' + (active ? ' is-active' : '') + '" data-preset="' + i + '">' + p.label + '</button>';
        }).join('') + '</div>';
    }

    function render() {
      panel.innerHTML = presetsHtml() +
        '<div class="km-drp__main">' +
          '<div class="km-drp__head">' +
            '<button type="button" class="km-drp__nav" data-nav="-1" aria-label="Sebelumnya"><i class="bi bi-chevron-left"></i></button>' +
            '<button type="button" class="km-drp__title" data-title' + (st.view === 'years' ? ' disabled' : '') + '>' + headTitle() + (st.view !== 'years' ? ' <i class="bi bi-chevron-down"></i>' : '') + '</button>' +
            '<button type="button" class="km-drp__nav" data-nav="1" aria-label="Berikutnya"' + (navDisabled(1) ? ' disabled' : '') + '><i class="bi bi-chevron-right"></i></button>' +
          '</div>' +
          '<div class="km-drp__body km-drp__body--' + st.view + '">' + (st.view === 'days' ? daysHtml() : st.view === 'months' ? monthsHtml() : yearsHtml()) + '</div>' +
          '<div class="km-drp__foot">' +
            '<div class="km-drp__summary" data-drp-summary></div>' +
            '<div class="km-drp__actions">' +
              '<button type="button" class="km-drp__btn km-drp__btn--ghost" data-cancel>Batal</button>' +
              '<button type="button" class="km-drp__btn km-drp__btn--primary" data-apply><i class="bi bi-check2"></i> Terapkan</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      paintRange();
    }

    function validRange() {
      return st.start && st.end && (!maxSpan || spanDays(st.start, st.end) <= maxSpan);
    }

    function paintRange() {
      var a = st.start;
      var b = st.end || (st.start && st.hover && st.hover >= st.start ? st.hover : null);
      panel.querySelectorAll('.km-drp__day').forEach(function (btn) {
        var d = parseIso(btn.getAttribute('data-date'));
        btn.classList.toggle('is-start', same(d, a));
        btn.classList.toggle('is-end', !!b && same(d, b));
        btn.classList.toggle('is-in-range', !!a && !!b && d > a && d < b);
        btn.classList.toggle('is-preview', !st.end && !!b);
        btn.classList.toggle('is-single', same(d, a) && (!b || same(a, b)));
      });

      var summary = panel.querySelector('[data-drp-summary]');
      var apply = panel.querySelector('[data-apply]');
      if (!summary || !apply) return;
      if (st.start && st.end) {
        var n = spanDays(st.start, st.end);
        var tooLong = maxSpan && n > maxSpan;
        summary.className = 'km-drp__summary' + (tooLong ? ' is-error' : '');
        summary.innerHTML = tooLong
          ? '<i class="bi bi-exclamation-triangle"></i> Maksimal ' + maxSpan + ' hari (dipilih ' + n + ' hari)'
          : '<i class="bi bi-calendar-check"></i> <span>' + fmtRange(st.start, st.end) + '</span> <em>' + n + ' hari</em>';
      } else {
        summary.className = 'km-drp__summary is-hint';
        summary.innerHTML = '<i class="bi bi-hand-index"></i> ' + (st.start ? 'Pilih tanggal akhir' : 'Pilih tanggal mulai');
      }
      apply.disabled = !validRange();
    }

    function open() {
      syncFromInputs();
      render();
      panel.hidden = false;
      root.classList.add('is-open');
      toggle.setAttribute('aria-expanded', 'true');
    }

    function close(focus) {
      panel.hidden = true;
      root.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      if (focus) toggle.focus();
    }

    function applyRange() {
      if (!validRange()) return;
      fromInput.value = toIso(st.start);
      toInput.value = toIso(st.end);
      renderLabels();
      close(false);
      if (!form) return;
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true }));
    }

    toggle.addEventListener('click', function () {
      if (panel.hidden) open();
      else close(false);
    });

    panel.addEventListener('click', function (e) {
      var el = e.target.closest('button');
      if (!el || el.disabled || !panel.contains(el)) return;

      if (el.hasAttribute('data-date')) {
        var d = parseIso(el.getAttribute('data-date'));
        if (!st.start || st.end) {
          st.start = d;
          st.end = null;
        } else if (d < st.start) {
          st.start = d;
        } else {
          st.end = d;
        }
        st.hover = null;
        if (d.getMonth() !== st.m) {
          st.y = d.getFullYear();
          st.m = d.getMonth();
          render();
        } else {
          paintRange();
          panel.querySelectorAll('.km-drp__preset').forEach(function (p) { p.classList.remove('is-active'); });
        }
      } else if (el.hasAttribute('data-preset')) {
        var p = presets()[Number(el.getAttribute('data-preset'))];
        st.start = p.from;
        st.end = p.to;
        applyRange();
      } else if (el.hasAttribute('data-nav')) {
        var step = Number(el.getAttribute('data-nav'));
        if (st.view === 'days') {
          var next = new Date(st.y, st.m + step, 1);
          st.y = next.getFullYear();
          st.m = next.getMonth();
        } else if (st.view === 'months') {
          st.y += step;
        } else {
          st.yearPage += step * 12;
        }
        render();
      } else if (el.hasAttribute('data-title')) {
        if (st.view === 'days') {
          st.view = 'months';
        } else if (st.view === 'months') {
          st.view = 'years';
          st.yearPage = st.y - 7;
        }
        render();
      } else if (el.hasAttribute('data-month')) {
        st.m = Number(el.getAttribute('data-month'));
        st.view = 'days';
        render();
      } else if (el.hasAttribute('data-year')) {
        st.y = Number(el.getAttribute('data-year'));
        st.view = 'months';
        render();
      } else if (el.hasAttribute('data-cancel')) {
        close(true);
      } else if (el.hasAttribute('data-apply')) {
        applyRange();
      }
    });

    panel.addEventListener('mouseover', function (e) {
      if (!st.start || st.end) return;
      var el = e.target.closest('.km-drp__day');
      var d = el && !el.disabled ? parseIso(el.getAttribute('data-date')) : null;
      if (same(d, st.hover)) return;
      st.hover = d;
      paintRange();
    });

    panel.addEventListener('mouseleave', function () {
      if (!st.hover) return;
      st.hover = null;
      paintRange();
    });

    document.addEventListener('click', function (e) {
      if (panel.hidden) return;
      if (e.composedPath().indexOf(root) === -1) close(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hidden) close(true);
    });

    renderLabels();
  }

  document.querySelectorAll('[data-drp]').forEach(init);
})();
