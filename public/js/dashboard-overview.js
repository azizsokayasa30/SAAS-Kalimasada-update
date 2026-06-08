(function () {
  function rp(n) {
    return 'Rp ' + (Number(n) || 0).toLocaleString('id-ID');
  }

  function setCardValue(id, value) {
    const el = document.querySelector('#' + id + ' .sc-value');
    if (el) el.textContent = value;
  }

  function setCardBadge(id, text) {
    const el = document.querySelector('#' + id + ' .sc-badge');
    if (el) el.textContent = text;
  }

  function setCardSub(id, text) {
    const el = document.querySelector('#' + id + ' .sc-sub');
    if (el) el.textContent = text;
  }

  function applyBillingStats(bs) {
    const total = Number(bs.total_customers) || 0;
    const active = Number(bs.active_customers) || 0;
    const tagihanBln = bs.monthly_total_tagihan != null
      ? Number(bs.monthly_total_tagihan)
      : (Number(bs.monthly_revenue) || 0) + (Number(bs.monthly_unpaid) || 0);
    const lunasBln = bs.monthly_lunas_canonical != null ? Number(bs.monthly_lunas_canonical) : (Number(bs.monthly_revenue) || 0);
    const blmBln = bs.monthly_belum_lunas_canonical != null ? Number(bs.monthly_belum_lunas_canonical) : (Number(bs.monthly_unpaid) || 0);
    const invBln = bs.monthly_invoice_count_canonical != null ? Number(bs.monthly_invoice_count_canonical) : (Number(bs.monthly_invoices) || 0);
    const invBlmBln = bs.monthly_belum_lunas_count_canonical != null ? Number(bs.monthly_belum_lunas_count_canonical) : (Number(bs.unpaid_monthly_invoices) || 0);
    const piutangAll = bs.outstanding_unpaid_total != null ? Number(bs.outstanding_unpaid_total) : 0;
    const piutangCnt = bs.outstanding_unpaid_count != null ? Number(bs.outstanding_unpaid_count) : 0;

    setCardValue('sc-total-customer', String(total));
    setCardValue('sc-active', String(active));
    setCardValue('sc-inactive', String(Math.max(total - active, 0)));
    setCardValue('sc-total-invoice', rp(tagihanBln));
    setCardSub('sc-total-invoice', 'Lunas ' + rp(lunasBln) + ' · Blm ' + rp(blmBln));
    setCardBadge('sc-total-invoice', invBln + ' Inv');
    setCardValue('sc-unpaid', rp(blmBln));
    setCardBadge('sc-unpaid', invBlmBln + ' Inv · Bln Ini');
    setCardValue('sc-piutang-all', rp(piutangAll));
    setCardBadge('sc-piutang-all', piutangCnt + ' Inv');
  }

  function applyOperationalStats(ops, newCustomers) {
    setCardValue('sc-new-customer', String(newCustomers || 0));
    setCardValue('sc-pending-installations', String(ops.pendingInstallations || 0));
    setCardValue('sc-pending-trouble', String(ops.pendingTroubleTickets || 0));
    setCardValue('sc-attendance-today', String(ops.employeesAttendedToday || 0));
  }

  function renderRecentCustomers(rows) {
    const el = document.getElementById('dashRecentCustomers');
    if (!el) return;
    if (!rows || !rows.length) {
      el.innerHTML = '<div class="text-center py-4 text-muted small"><i class="bi bi-inbox d-block fs-3 mb-2 opacity-25"></i>Belum ada data</div>';
      return;
    }
    el.innerHTML = '<ul class="recent-list">' + rows.map(function (c) {
      const active = c.status === 'aktif' || c.status === 'active';
      return '<li class="recent-item"><div class="ri-avatar ri-avatar-blue"><i class="bi bi-person-fill"></i></div>'
        + '<div class="ri-info"><div class="ri-name">' + escapeHtml(c.name) + '</div><div class="ri-sub">' + escapeHtml(c.area || 'Tanpa Area') + '</div></div>'
        + '<div class="ri-right"><span class="badge-status ' + (active ? 'green' : 'brown') + '">' + (active ? 'Aktif' : 'Non-Aktif') + '</span></div></li>';
    }).join('') + '</ul>';
  }

  function renderRecentInvoices(rows) {
    const el = document.getElementById('dashRecentInvoices');
    if (!el) return;
    if (!rows || !rows.length) {
      el.innerHTML = '<div class="text-center py-4 text-muted small"><i class="bi bi-inbox d-block fs-3 mb-2 opacity-25"></i>Belum ada data</div>';
      return;
    }
    el.innerHTML = '<ul class="recent-list">' + rows.map(function (inv) {
      return '<li class="recent-item"><div class="ri-avatar ri-avatar-green"><i class="bi bi-check-lg"></i></div>'
        + '<div class="ri-info"><div class="ri-name">' + escapeHtml(inv.customer_name || 'N/A') + '</div><div class="ri-sub">' + escapeHtml(inv.invoice_number || '-') + '</div></div>'
        + '<div class="ri-right ri-amount">' + rp(inv.amount) + '</div></li>';
    }).join('') + '</ul>';
  }

  function renderRecentTickets(rows) {
    const el = document.getElementById('dashRecentTickets');
    if (!el) return;
    if (!rows || !rows.length) {
      el.innerHTML = '<div class="text-center py-4 text-muted small"><i class="bi bi-inbox d-block fs-3 mb-2 opacity-25"></i>Belum ada data</div>';
      return;
    }
    el.innerHTML = '<ul class="recent-list">' + rows.map(function (t) {
      const st = String(t.status || '').toLowerCase();
      const badge = st === 'selesai' || st === 'closed' || st === 'resolved' ? 'green' : (st === 'open' || st === 'baru' ? 'red' : 'yellow');
      return '<li class="recent-item"><div class="ri-avatar ri-avatar-red"><i class="bi bi-exclamation-triangle-fill"></i></div>'
        + '<div class="ri-info"><div class="ri-name">' + escapeHtml(t.name || t.customer_name || 'Pelanggan') + '</div><div class="ri-sub">' + escapeHtml(t.category || t.issue || '-') + '</div></div>'
        + '<div class="ri-right"><span class="badge-status ' + badge + '">' + escapeHtml(t.status || '-') + '</span></div></li>';
    }).join('') + '</ul>';
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  async function loadOverview() {
    try {
      let data = null;
      if (window.__dashOverviewPrefetch) {
        data = await window.__dashOverviewPrefetch;
        window.__dashOverviewPrefetch = null;
      }
      if (!data) {
        const res = await fetch('/admin/dashboard/api/overview', { credentials: 'same-origin' });
        data = await res.json();
      }
      if (!data || !data.success) return;

      applyBillingStats(data.billingStats || {});
      applyOperationalStats(data.operationalStats || {}, data.newCustomersThisMonth);
      renderRecentCustomers(data.recentCustomers);
      renderRecentInvoices(data.recentPaidInvoices);
      renderRecentTickets(data.recentTickets);

      const grid = document.getElementById('dashStatsGrid');
      if (grid) grid.classList.remove('dash-stat-loading');
    } catch (e) {
      console.warn('[dashboard-overview]', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadOverview);
  } else {
    loadOverview();
  }
})();
