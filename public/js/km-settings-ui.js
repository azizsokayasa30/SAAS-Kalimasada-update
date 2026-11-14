(function () {
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-km-pass-toggle]');
    if (!btn) return;
    var input = btn.parentElement.querySelector('input');
    if (!input) return;
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    var icon = btn.querySelector('i');
    if (icon) icon.className = show ? 'bi bi-eye-slash' : 'bi bi-eye';
    btn.title = show ? 'Sembunyikan' : 'Tampilkan';
    btn.setAttribute('aria-label', btn.title);
  });

  document.querySelectorAll('.km-sx-drop').forEach(function (drop) {
    var input = drop.querySelector('input[type="file"]');
    var label = drop.querySelector('.km-sx-drop__file span');
    if (!input) return;
    function sync() {
      var file = input.files && input.files[0];
      drop.classList.toggle('has-file', !!file);
      if (label) {
        label.textContent = file
          ? file.name + ' · ' + (file.size >= 1048576 ? (file.size / 1048576).toFixed(2) + ' MB' : (file.size / 1024).toFixed(1) + ' KB')
          : '';
      }
    }
    input.addEventListener('change', sync);
    ['dragenter', 'dragover'].forEach(function (ev) {
      input.addEventListener(ev, function () { drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      input.addEventListener(ev, function () { drop.classList.remove('is-over'); });
    });
    var form = input.form;
    if (form) form.addEventListener('reset', function () { setTimeout(sync, 0); });
    sync();
  });

  document.querySelectorAll('form[data-km-dirty]').forEach(function (form) {
    var bar = form.querySelector('.km-sx-savebar');
    var initial = new FormData(form);
    var snapshot = JSON.stringify(Array.from(initial.entries()));
    var dirty = false;
    function check() {
      dirty = JSON.stringify(Array.from(new FormData(form).entries())) !== snapshot;
      if (bar) bar.classList.toggle('is-dirty', dirty);
    }
    form.addEventListener('input', check);
    form.addEventListener('change', check);
    form.addEventListener('submit', function () { dirty = false; });
    window.addEventListener('beforeunload', function (e) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });
  });
})();
