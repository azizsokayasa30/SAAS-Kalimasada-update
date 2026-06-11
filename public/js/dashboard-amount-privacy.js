/**
 * Sembunyikan/tampilkan nominal di dashboard (default: tersembunyi).
 * Simpan preferensi di localStorage; klik ikon mata untuk toggle.
 */
(function (global) {
    const STORAGE_KEY = 'dashboardAmountVisible';
    const MASK = 'Rp ••••••';

    function isVisible() {
        return global.localStorage.getItem(STORAGE_KEY) === '1';
    }

    function setVisible(visible) {
        global.localStorage.setItem(STORAGE_KEY, visible ? '1' : '0');
        applyAll(visible);
    }

    function toggle() {
        setVisible(!isVisible());
    }

    function syncElement(el, visible) {
        if (!el || !el.classList.contains('dash-amount')) return;
        const raw = (el.dataset.amount || el.textContent || '').trim();
        if (raw && !el.dataset.amount) {
            el.dataset.amount = raw;
        }
        el.textContent = visible ? el.dataset.amount : MASK;
    }

    function applyAll(visible) {
        const show = typeof visible === 'boolean' ? visible : isVisible();
        document.querySelectorAll('.dash-amount').forEach(function (el) {
            syncElement(el, show);
        });
        document.body.classList.toggle('dash-amounts-visible', show);
        document.body.classList.toggle('dash-amounts-hidden', !show);

        const icon = document.getElementById('dashAmountToggleIcon');
        const btn = document.getElementById('dashAmountToggle');
        if (icon) {
            icon.className = show ? 'bi bi-eye-slash' : 'bi bi-eye';
        }
        if (btn) {
            const label = show ? 'Sembunyikan nominal' : 'Tampilkan nominal';
            btn.setAttribute('title', label);
            btn.setAttribute('aria-label', label);
            btn.setAttribute('aria-pressed', show ? 'true' : 'false');
        }
    }

    /** Perbarui teks nominal (mis. setelah AJAX) — hormati state privasi. */
    function updateAmount(el, formattedText) {
        if (!el) return;
        el.classList.add('dash-amount');
        el.dataset.amount = formattedText;
        el.textContent = isVisible() ? formattedText : MASK;
    }

    function bindToggle() {
        const btn = document.getElementById('dashAmountToggle');
        if (!btn || btn.dataset.privacyBound === '1') return;
        btn.dataset.privacyBound = '1';
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            toggle();
        });
    }

    function init() {
        document.querySelectorAll('.dash-amount').forEach(function (el) {
            if (!el.dataset.amount) {
                el.dataset.amount = (el.textContent || '').trim();
            }
        });
        applyAll(isVisible());
        bindToggle();
    }

    global.DashboardAmountPrivacy = {
        isVisible: isVisible,
        setVisible: setVisible,
        toggle: toggle,
        applyAll: applyAll,
        updateAmount: updateAmount,
        MASK: MASK
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window);
