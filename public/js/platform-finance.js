(function () {
  'use strict';

  document.querySelectorAll('.js-period-form').forEach(function (form) {
    form.querySelectorAll('.js-autosubmit').forEach(function (el) {
      el.addEventListener('change', function () {
        var page = form.querySelector('input[name="page"]');
        if (page) page.value = '1';
        form.submit();
      });
    });
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
