(function () {
    const sectionBadge = document.getElementById('sbFinanceSectionBadge');
    const remittanceBadge = document.getElementById('sbFinanceRemittanceBadge');
    const paymentsBadge = document.getElementById('sbFinancePaymentsBadge');
    if (!sectionBadge && !remittanceBadge && !paymentsBadge) return;

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

    function applyCounts(data) {
        const remittance = Number(data && data.remittance) || 0;
        const payments = Number(data && data.payments) || 0;
        const total = Number(data && data.count) || remittance + payments;
        setBadge(remittanceBadge, remittance);
        setBadge(paymentsBadge, payments);
        setBadge(sectionBadge, total);
    }

    var inFlight = false;
    async function refreshFinanceBadge() {
        if (inFlight || document.hidden) return;
        inFlight = true;
        var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 10000) : null;
        try {
            const res = await fetch('/admin/billing/api/finance-badge', {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
                signal: ctrl ? ctrl.signal : undefined
            });
            if (!res.ok) return;
            const json = await res.json();
            if (json && json.success) applyCounts(json);
        } catch (_) { /* ignore */ }
        finally {
            if (timer) clearTimeout(timer);
            inFlight = false;
        }
    }

    refreshFinanceBadge();
    setInterval(function () {
        if (!document.hidden) refreshFinanceBadge();
    }, 25000);
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) refreshFinanceBadge();
    });
})();
