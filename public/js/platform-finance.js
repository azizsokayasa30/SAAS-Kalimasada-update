(function () {
  'use strict';

  (function initLedgerCategories() {
    var modal = document.getElementById('ledgerCategoryModal');
    if (!modal || modal.getAttribute('data-cat-ready') === '1') return;
    modal.setAttribute('data-cat-ready', '1');

    function clearEditing(exceptRow) {
      modal.querySelectorAll('.km-fin-cat-row.is-editing').forEach(function (row) {
        if (row !== exceptRow) row.classList.remove('is-editing');
      });
    }

    modal.addEventListener('click', function (e) {
      var actionEl = e.target.closest('[data-cat-action]');
      if (!actionEl || !modal.contains(actionEl)) return;

      var action = actionEl.getAttribute('data-cat-action');
      var row = actionEl.closest('.km-fin-cat-row');
      if (!row) return;

      if (action === 'edit') {
        e.preventDefault();
        clearEditing(row);
        row.classList.add('is-editing');
        var input = row.querySelector('.km-fin-cat-row__edit input[name="name"]');
        if (input) {
          setTimeout(function () {
            input.focus();
            input.select();
          }, 50);
        }
        return;
      }

      if (action === 'cancel') {
        e.preventDefault();
        row.classList.remove('is-editing');
        var original = row.querySelector('.km-fin-cat-row__view .km-fin-cat');
        var editInput = row.querySelector('.km-fin-cat-row__edit input[name="name"]');
        if (original && editInput) editInput.value = original.textContent.trim();
        return;
      }

      if (action === 'delete') {
        e.preventDefault();
        var name = actionEl.getAttribute('data-cat-name') || '';
        var msg = name
          ? 'Hapus kategori "' + name + '"? Catatan yang sudah memakai kategori ini tidak dihapus.'
          : 'Hapus kategori ini? Catatan yang sudah memakai kategori ini tidak dihapus.';
        if (!window.confirm(msg)) return;
        var form = row.querySelector('[data-cat-delete-form]');
        if (form) form.submit();
      }
    });
  })();

  document.querySelectorAll('.js-period-form').forEach(function (form) {
    form.querySelectorAll('.js-autosubmit').forEach(function (el) {
      el.addEventListener('change', function () {
        var page = form.querySelector('input[name="page"]');
        if (page) page.value = '1';
        form.submit();
      });
    });
  });

  var NOW = new Date();
  document.querySelectorAll('[data-pp]').forEach(function (form) {
    var picker = form.querySelector('.js-pp-picker');
    if (!picker) return;
    var keep = form.getAttribute('data-pp-keep') || '';
    var monthInput = form.querySelector('input[name="month"]');
    var activeMonth = monthInput ? Number(monthInput.value) : 0;
    var activeYear = Number(form.getAttribute('data-pp-year'));
    var viewYear = activeYear;
    var yearLabel = picker.querySelector('.js-pp-year-label');
    var chips = picker.querySelectorAll('.js-pp-month');

    function renderYear() {
      if (yearLabel) yearLabel.textContent = viewYear;
      chips.forEach(function (chip) {
        var m = Number(chip.getAttribute('data-month'));
        chip.setAttribute('href', '?month=' + m + '&year=' + viewYear + keep);
        chip.classList.toggle('is-active', viewYear === activeYear && m === activeMonth);
        chip.classList.toggle('is-now', viewYear === NOW.getFullYear() && m === NOW.getMonth() + 1);
      });
    }

    picker.querySelectorAll('.js-pp-year').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        viewYear += Number(btn.getAttribute('data-step')) || 0;
        renderYear();
      });
    });

    picker.addEventListener('toggle', function () {
      if (picker.open) return;
      viewYear = activeYear;
      renderYear();
    });
  });

  var pops = document.querySelectorAll('.js-pp-pop');

  function visibleOptions(pop) {
    return Array.prototype.filter.call(pop.querySelectorAll('.km-pp__opt'), function (o) {
      return !o.classList.contains('d-none');
    });
  }

  pops.forEach(function (pop) {
    var search = pop.querySelector('.js-pp-menu-search');
    var empty = pop.querySelector('.km-pp__menu-empty');

    pop.addEventListener('toggle', function () {
      if (!pop.open) return;
      pops.forEach(function (other) { if (other !== pop) other.open = false; });
      var active = pop.querySelector('.km-pp__opt.is-active');
      if (active) active.scrollIntoView({ block: 'nearest' });
      if (search) search.focus();
    });

    if (search) {
      search.addEventListener('input', function () {
        var q = search.value.trim().toLowerCase();
        var shown = 0;
        pop.querySelectorAll('.km-pp__opt').forEach(function (o) {
          var match = !q || (o.getAttribute('data-search') || '').indexOf(q) !== -1;
          o.classList.toggle('d-none', !match);
          if (match) shown++;
        });
        if (empty) empty.classList.toggle('d-none', shown > 0);
      });
      search.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          var first = visibleOptions(pop)[0];
          if (first) first.click();
        }
      });
    }

    pop.addEventListener('keydown', function (e) {
      if (!pop.open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      var opts = visibleOptions(pop);
      if (!opts.length) return;
      e.preventDefault();
      var idx = opts.indexOf(document.activeElement);
      idx = e.key === 'ArrowDown' ? Math.min(idx + 1, opts.length - 1) : Math.max(idx - 1, 0);
      opts[idx].focus();
    });
  });

  document.addEventListener('click', function (e) {
    pops.forEach(function (pop) {
      if (pop.open && !pop.contains(e.target)) pop.open = false;
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    pops.forEach(function (pop) {
      if (!pop.open) return;
      pop.open = false;
      pop.querySelector('summary').focus();
    });
  });

  var selects = [];

  function closeSelects(except) {
    selects.forEach(function (s) { if (s !== except) s.close(); });
  }

  function enhanceSelect(select) {
    var wrap = document.createElement('div');
    wrap.className = 'km-sel';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = select.className + ' km-sel__btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    if (select.id) {
      var lbl = document.querySelector('label[for="' + select.id + '"]');
      if (lbl) lbl.addEventListener('click', function (e) { e.preventDefault(); btn.focus(); });
    }
    var menu = document.createElement('div');
    menu.className = 'km-sel__menu';
    menu.setAttribute('role', 'listbox');

    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    select.classList.add('km-sel__native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    function render() {
      var current = select.options[select.selectedIndex];
      btn.textContent = current ? current.text : '';
      menu.innerHTML = '';
      Array.prototype.forEach.call(select.options, function (opt, i) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'km-sel__opt' + (i === select.selectedIndex ? ' is-active' : '');
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', i === select.selectedIndex ? 'true' : 'false');
        item.innerHTML = '<span></span>' + (i === select.selectedIndex ? '<i class="bi bi-check2"></i>' : '');
        item.firstChild.textContent = opt.text;
        item.disabled = opt.disabled;
        item.addEventListener('click', function () {
          if (select.selectedIndex !== i) {
            select.selectedIndex = i;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
          api.close();
          btn.focus();
        });
        menu.appendChild(item);
      });
    }

    var api = {
      open: function () {
        closeSelects(api);
        render();
        wrap.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
        var active = menu.querySelector('.is-active') || menu.querySelector('.km-sel__opt');
        if (active) { active.scrollIntoView({ block: 'nearest' }); active.focus(); }
      },
      close: function () {
        wrap.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
      },
      contains: function (el) { return wrap.contains(el); }
    };

    btn.addEventListener('click', function () {
      if (wrap.classList.contains('is-open')) api.close(); else api.open();
    });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); api.open(); }
    });
    menu.addEventListener('keydown', function (e) {
      var items = Array.prototype.slice.call(menu.querySelectorAll('.km-sel__opt:not(:disabled)'));
      var idx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        idx = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
        if (items[idx]) items[idx].focus();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        api.close();
        btn.focus();
      } else if (e.key === 'Tab') {
        api.close();
      }
    });
    select.addEventListener('change', render);
    if (select.form) select.form.addEventListener('reset', function () { setTimeout(render, 0); });

    render();
    selects.push(api);
  }

  document.querySelectorAll('.km-fin-page select.form-select, .modal select.form-select').forEach(function (select) {
    if (select.multiple || select.hasAttribute('data-native')) return;
    enhanceSelect(select);
  });

  document.addEventListener('click', function (e) {
    selects.forEach(function (s) { if (!s.contains(e.target)) s.close(); });
  });

  document.querySelectorAll('[data-fin-search]').forEach(function (input) {
    var body = document.querySelector(input.getAttribute('data-fin-search'));
    if (!body) return;
    var rows = body.querySelectorAll('.js-search-row');
    var empty = body.querySelector('.js-search-empty');
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      rows.forEach(function (row) {
        var match = !q || (row.getAttribute('data-search') || '').indexOf(q) !== -1;
        row.classList.toggle('d-none', !match);
        if (match) shown++;
      });
      if (empty) empty.classList.toggle('d-none', shown > 0);
    });
  });

  document.querySelectorAll('[data-fin-highlight]').forEach(function (input) {
    var body = document.querySelector(input.getAttribute('data-fin-highlight'));
    if (!body) return;

    function applyHighlight() {
      var q = input.value.trim().toLowerCase();
      var rows = body.querySelectorAll('.js-highlight-row');
      var firstMatch = null;
      Array.prototype.forEach.call(rows, function (row) {
        var hay = (row.getAttribute('data-search') || '').toLowerCase();
        if (!hay) {
          var nameEl = row.querySelector('.km-recap-tenant-name');
          hay = ((nameEl && nameEl.textContent) || '').toLowerCase();
        }
        var match = !!q && hay.indexOf(q) !== -1;
        row.classList.toggle('is-search-match', match);
        if (match && !firstMatch) firstMatch = row;
      });
      if (firstMatch) {
        try { firstMatch.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* ignore */ }
      }
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') e.preventDefault();
    });
    input.addEventListener('input', applyHighlight);
    input.addEventListener('search', applyHighlight);
  });

  document.querySelectorAll('.js-fin-drop').forEach(function (drop) {
    var input = drop.querySelector('input[type="file"]');
    var label = drop.querySelector('.js-fin-drop-name');
    if (!input) return;
    var defaultText = label ? label.textContent : '';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (label) label.textContent = file ? file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)' : defaultText;
      drop.classList.toggle('has-file', !!file);
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function () { drop.classList.add('is-dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function () { drop.classList.remove('is-dragover'); });
    });
  });

})();
