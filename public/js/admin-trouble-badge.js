(function () {
    const itemBadge = document.getElementById('sbTroubleProgressBadge');
    if (!itemBadge && !document.getElementById('sbInstallProgressSectionBadge')) return;

    window.__sbTeknisiBadge = window.__sbTeknisiBadge || { install: 0, trouble: 0 };

    function formatCount(n) {
        const v = Number(n) || 0;
        if (v <= 0) return '0';
        return v > 99 ? '99+' : String(v);
    }

    function setBadge(el, count) {
        if (!el) return;
        el.textContent = formatCount(count);
        if (count > 0) {
            el.classList.remove('d-none');
            el.setAttribute('aria-hidden', 'false');
        } else {
            el.classList.add('d-none');
            el.setAttribute('aria-hidden', 'true');
        }
    }

    function applyTeknisiSection() {
        const total = (Number(window.__sbTeknisiBadge.install) || 0) + (Number(window.__sbTeknisiBadge.trouble) || 0);
        setBadge(document.getElementById('sbInstallProgressSectionBadge'), total);
    }

    window.__applyTeknisiSectionBadge = applyTeknisiSection;

    function applyTroubleCount(n) {
        const count = Number(n) || 0;
        window.__sbTeknisiBadge.trouble = count;
        setBadge(itemBadge, count);
        applyTeknisiSection();
    }

    var inFlight = false;
    async function refreshTroubleBadge() {
        if (inFlight || document.hidden) return;
        inFlight = true;
        var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
        try {
            const res = await fetch('/admin/trouble/api/progress-badge', {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
                signal: ctrl ? ctrl.signal : undefined
            });
            if (!res.ok) return;
            const json = await res.json();
            if (json && json.success) applyTroubleCount(json.count);
        } catch (_) { /* ignore */ }
        finally {
            if (timer) clearTimeout(timer);
            inFlight = false;
        }
    }

    refreshTroubleBadge();
    setInterval(function () {
        if (!document.hidden) refreshTroubleBadge();
    }, 25000);
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) refreshTroubleBadge();
    });
})();
