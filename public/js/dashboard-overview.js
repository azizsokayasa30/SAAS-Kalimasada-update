(function () {
  function num(n) {
    return (Number(n) || 0).toLocaleString('id-ID');
  }

  function rp(n) {
    return 'Rp ' + (Number(n) || 0).toLocaleString('id-ID');
  }

  function setCardValue(id, value) {
    const el = document.querySelector('#' + id + ' .sc-value');
    if (!el) return;
    if (el.classList.contains('dash-amount') && window.DashboardAmountPrivacy) {
      window.DashboardAmountPrivacy.updateAmount(el, value);
      return;
    }
    el.textContent = value;
  }

  function setAmountEl(id, formatted) {
    const el = document.getElementById(id);
    if (!el) return;
    if (window.DashboardAmountPrivacy) {
      window.DashboardAmountPrivacy.updateAmount(el, formatted);
      return;
    }
    el.textContent = formatted;
  }

  function setCardBadge(id, text) {
    const count = document.querySelector('#' + id + ' .sc-count');
    if (count) {
      count.textContent = text;
      return;
    }
    const el = document.querySelector('#' + id + ' .sc-badge');
    if (el && !el.querySelector('i')) el.textContent = text;
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

    setCardValue('sc-total-customer', num(total));
    setCardValue('sc-active', num(active));
    setCardValue('sc-inactive', num(Math.max(total - active, 0)));
    setCardValue('sc-total-invoice', rp(tagihanBln));
    setAmountEl('sc-total-invoice-paid', rp(lunasBln));
    setAmountEl('sc-total-invoice-unpaid', rp(blmBln));
    setCardBadge('sc-total-invoice', num(invBln) + ' Inv');
    setCardValue('sc-unpaid', rp(blmBln));
    setCardBadge('sc-unpaid', num(invBlmBln) + ' Inv');
    setCardValue('sc-piutang-all', rp(piutangAll));
    setCardBadge('sc-piutang-all', num(piutangCnt) + ' Inv');
    renderInvoiceDonut(bs);
  }

  function applyOperationalStats(ops, newCustomers) {
    setCardValue('sc-new-customer', num(newCustomers || 0));
    setCardValue('sc-pending-installations', num(ops.pendingInstallations || 0));
    setCardValue('sc-pending-trouble', num(ops.pendingTroubleTickets || 0));
    setCardValue('sc-attendance-today', num(ops.employeesAttendedToday || 0));
  }

  function emptyFeed(message) {
    return '<div class="isp-empty"><i class="bi bi-inbox"></i><div>' + message + '</div></div>';
  }

  function renderTopAreas(rows) {
    const el = document.getElementById('dashTopAreas');
    if (!el) return;
    if (!rows || !rows.length) {
      el.innerHTML = emptyFeed('Belum ada data area pelanggan.');
      return;
    }
    const max = rows.reduce(function (hi, row) {
      return Math.max(hi, Number(row.count) || 0);
    }, 1);
    el.innerHTML = '<ol class="isp-area-rank">' + rows.map(function (row, index) {
      const count = Number(row.count) || 0;
      const width = Math.max(8, Math.round((count / max) * 100));
      const name = row.name || 'Tanpa Area';
      const href = '/admin/billing/customers?area=' + encodeURIComponent(name);
      return '<li>'
        + '<div class="isp-area-meta">'
        + '<span class="isp-area-pos">' + (index + 1) + '</span>'
        + '<a href="' + href + '">' + escapeHtml(name) + '</a>'
        + '<b>' + num(count) + '</b>'
        + '</div>'
        + '<div class="isp-area-track" aria-hidden="true"><span style="width:' + width + '%"></span></div>'
        + '</li>';
    }).join('') + '</ol>';
  }

  function renderRecentCustomers(rows) {
    const el = document.getElementById('dashRecentCustomers');
    if (!el) return;
    if (!rows || !rows.length) {
      el.innerHTML = emptyFeed('Belum ada aktivitas terbaru.');
      return;
    }
    el.innerHTML = '<ul class="recent-list">' + rows.map(function (c) {
      const active = c.status === 'aktif' || c.status === 'active';
      return '<li class="recent-item"><div class="ri-info"><div class="ri-name">' + escapeHtml(c.name) + '</div><div class="ri-sub">' + escapeHtml(c.area || 'Tanpa Area') + '</div></div>'
        + '<div class="ri-right"><span class="badge-status ' + (active ? 'green' : 'brown') + '">' + (active ? 'Aktif' : 'Non-Aktif') + '</span></div></li>';
    }).join('') + '</ul>';
  }

  function renderRecentInvoices(rows) {
    const el = document.getElementById('dashRecentInvoices');
    if (!el) return;
    if (!rows || !rows.length) {
      el.innerHTML = emptyFeed('Belum ada aktivitas terbaru.');
      return;
    }
    el.innerHTML = '<ul class="recent-list">' + rows.map(function (inv) {
      const amount = rp(inv.amount);
      return '<li class="recent-item"><div class="ri-info"><div class="ri-name">' + escapeHtml(inv.customer_name || 'N/A') + '</div><div class="ri-sub">' + escapeHtml(inv.invoice_number || '-') + '</div></div>'
        + '<div class="ri-right ri-amount dash-amount" data-amount="' + escapeHtml(amount) + '">' + escapeHtml(amount) + '</div></li>';
    }).join('') + '</ul>';
    if (window.DashboardAmountPrivacy) window.DashboardAmountPrivacy.applyAll();
  }

  function renderRecentTickets(rows) {
    const el = document.getElementById('dashRecentTickets');
    if (!el) return;
    if (!rows || !rows.length) {
      el.innerHTML = emptyFeed('Belum ada laporan gangguan.');
      return;
    }
    el.innerHTML = '<ul class="recent-list">' + rows.map(function (t) {
      const st = String(t.status || '').toLowerCase();
      let badge = 'brown';
      let label = t.status || '-';
      if (st === 'open' || st === 'baru' || st === 'pending') {
        badge = 'red';
        label = 'Pending';
      } else if (st === 'in_progress' || st === 'proses') {
        badge = 'yellow';
        label = 'Proses';
      } else if (st === 'resolved' || st === 'closed' || st === 'selesai') {
        badge = 'green';
        label = 'Selesai';
      }
      return '<li class="recent-item"><div class="ri-info"><div class="ri-name">' + escapeHtml(t.name || t.customer_name || 'Pelanggan') + '</div><div class="ri-sub">' + escapeHtml(t.category || t.description || '-') + '</div></div>'
        + '<div class="ri-right"><span class="badge-status ' + badge + '">' + escapeHtml(label) + '</span></div></li>';
    }).join('') + '</ul>';
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function pctLabel(part, total) {
    if (!total) return '0%';
    return (part / total * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + '%';
  }

  function paintDonut() {
    const state = window.__dashDonutState;
    if (!state) return;
    const center = document.getElementById('dashDonutCenterValue');
    if (center) center.textContent = num(state.totalCustomers);
    const lunasEl = document.getElementById('dashDonutLunas');
    const belumEl = document.getElementById('dashDonutBelum');
    const totalInv = state.lunas + state.belum;
    if (lunasEl) lunasEl.textContent = num(state.lunas) + ' · ' + pctLabel(state.lunas, totalInv);
    if (belumEl) belumEl.textContent = num(state.belum) + ' · ' + pctLabel(state.belum, totalInv);
    const empty = document.getElementById('dashDonutEmpty');
    if (empty) empty.classList.toggle('d-none', totalInv > 0);
    const canvas = document.getElementById('dashInvoiceDonut');
    if (totalInv === 0) {
      if (window.__dashDonutChart) {
        window.__dashDonutChart.destroy();
        window.__dashDonutChart = null;
      }
      return;
    }
    if (!canvas || typeof Chart === 'undefined') return;
    if (window.__dashDonutChart) {
      window.__dashDonutChart.destroy();
      window.__dashDonutChart = null;
    }
    window.__dashDonutChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: ['Lunas', 'Belum Lunas'],
        datasets: [{
          data: [state.lunas, state.belum],
          backgroundColor: ['#10B981', '#F59E0B'],
          borderWidth: 0,
          hoverOffset: 4
        }]
      },
      options: {
        cutout: '68%',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } }
      }
    });
  }

  function renderInvoiceDonut(bs) {
    const lunas = bs.monthly_lunas_count_canonical != null
      ? Number(bs.monthly_lunas_count_canonical)
      : (Number(bs.paid_monthly_invoices) || 0);
    const belum = bs.monthly_belum_lunas_count_canonical != null
      ? Number(bs.monthly_belum_lunas_count_canonical)
      : (Number(bs.unpaid_monthly_invoices) || 0);
    window.__dashDonutState = {
      lunas: lunas || 0,
      belum: belum || 0,
      totalCustomers: Number(bs.total_customers) || 0
    };
    paintDonut();
  }

  window.__renderDashDonut = paintDonut;

  function chartTheme() {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    return {
      text: light ? '#64748b' : '#94a3b8',
      grid: light ? 'rgba(15, 23, 42, 0.08)' : 'rgba(255, 255, 255, 0.08)'
    };
  }

  function renderCustomerTrend(rows) {
    if (rows) window.__dashCustomerTrend = rows;
    const host = document.getElementById('dashCustomerTrend');
    if (!host) return;
    const series = window.__dashCustomerTrend || [];
    const total = series.reduce(function (sum, row) {
      return sum + (Number(row.total) || 0);
    }, 0);
    if (!series.length || total === 0) {
      if (window.__dashCustomerChart) {
        window.__dashCustomerChart.destroy();
        window.__dashCustomerChart = null;
      }
      host.innerHTML = emptyFeed(series.length ? 'Belum ada pelanggan pada 6 bulan terakhir.' : 'Riwayat pelanggan 6 bulan belum tersedia.');
      return;
    }
    if (typeof Chart === 'undefined') return;
    if (!host.querySelector('#dashCustomerTrendChart')) {
      host.innerHTML = '<div class="isp-trend-stage"><canvas id="dashCustomerTrendChart" aria-label="Total pelanggan dan nonaktif 6 bulan terakhir"></canvas></div>'
        + '<p class="isp-trend-note">Jumlah sampai akhir bulan, dihitung dari tanggal bergabung. Garis total naik saat pelanggan bertambah.</p>';
    }
    const canvas = document.getElementById('dashCustomerTrendChart');
    if (!canvas) return;
    const colors = chartTheme();
    const labels = series.map(function (row) { return row.label || row.month; });
    const totals = series.map(function (row) { return Number(row.total) || 0; });
    const inactive = series.map(function (row) { return Number(row.inactive) || 0; });
    if (window.__dashCustomerChart) {
      window.__dashCustomerChart.destroy();
      window.__dashCustomerChart = null;
    }
    window.__dashCustomerChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Total Pelanggan',
            data: totals,
            borderColor: '#10B981',
            backgroundColor: 'rgba(16, 185, 129, 0.14)',
            pointBackgroundColor: '#10B981',
            fill: true,
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 3,
            pointHoverRadius: 4
          },
          {
            label: 'Nonaktif',
            data: inactive,
            borderColor: '#F43F5E',
            backgroundColor: 'rgba(244, 63, 94, 0.12)',
            pointBackgroundColor: '#F43F5E',
            fill: true,
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 3,
            pointHoverRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: colors.text,
              boxWidth: 8,
              boxHeight: 8,
              usePointStyle: true,
              pointStyle: 'circle',
              padding: 14
            }
          },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return ' ' + ctx.dataset.label + ': ' + num(ctx.parsed.y);
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: colors.text },
            grid: { color: colors.grid }
          },
          y: {
            beginAtZero: true,
            ticks: {
              color: colors.text,
              precision: 0,
              callback: function (value) { return num(value); }
            },
            grid: { color: colors.grid }
          }
        }
      }
    });
  }

  window.__renderCustomerTrend = function () {
    renderCustomerTrend();
  };

  if (!window.__dashTrendThemeWatch) {
    window.__dashTrendThemeWatch = new MutationObserver(function () {
      if (window.__dashCustomerTrend) renderCustomerTrend();
    });
    window.__dashTrendThemeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
  }

  function showOverviewError() {
    const grid = document.getElementById('dashStatsGrid');
    if (grid) grid.classList.remove('dash-stat-loading');
    const err = document.getElementById('dashOverviewError');
    if (err) err.classList.remove('d-none');
    ['sc-total-customer', 'sc-active', 'sc-inactive', 'sc-new-customer', 'sc-pending-installations', 'sc-pending-trouble', 'sc-attendance-today'].forEach(function (id) {
      setCardValue(id, '—');
    });
    setCardValue('sc-total-invoice', '—');
    setCardValue('sc-unpaid', '—');
    setCardValue('sc-piutang-all', '—');
    const areas = document.getElementById('dashTopAreas');
    if (areas) areas.innerHTML = emptyFeed('Peringkat area gagal dimuat.');
    renderCustomerTrend([]);
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
      if (!data || !data.success) {
        showOverviewError();
        return;
      }

      applyBillingStats(data.billingStats || {});
      applyOperationalStats(data.operationalStats || {}, data.newCustomersThisMonth);
      renderRecentCustomers(data.recentCustomers);
      renderRecentInvoices(data.recentPaidInvoices);
      renderRecentTickets(data.recentTickets);
      renderTopAreas(data.topAreas);
      renderCustomerTrend(data.customerTrend || []);

      const grid = document.getElementById('dashStatsGrid');
      if (grid) grid.classList.remove('dash-stat-loading');
      const err = document.getElementById('dashOverviewError');
      if (err) err.classList.add('d-none');
    } catch (e) {
      console.warn('[dashboard-overview]', e);
      showOverviewError();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadOverview);
  } else {
    loadOverview();
  }
})();
