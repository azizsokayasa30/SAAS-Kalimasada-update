const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const logger = require('./logger');
const billingManager = require('./billing');

const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer'
];

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatIdr(amount) {
    const n = Math.round(Number(amount) || 0);
    return `Rp ${n.toLocaleString('id-ID')}`;
}

function formatDateId(value) {
    if (value == null || String(value).trim() === '') return '—';
    const raw = String(value).trim();
    const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        return raw.length >= 10 ? raw.slice(0, 10) : raw;
    }
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}

function labelPaymentMethod(method) {
    const s = String(method || '').trim().toLowerCase();
    if (!s) return '—';
    if (s === 'cash' || s === 'tunai') return 'Tunai';
    if (s.includes('qris')) return 'QRIS';
    if (s.includes('transfer')) return 'Transfer';
    return String(method).trim();
}

function safeFileName(value) {
    return String(value || 'kwitansi')
        .replace(/[^\w.-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80) || 'kwitansi';
}

async function loadTenantReceiptSettings(tenantId) {
    const tid = parseInt(String(tenantId), 10);
    if (!Number.isFinite(tid) || tid <= 0) {
        return {};
    }
    const { getFullSettingsForTenantId } = require('./platform/tenantSettingsManager');
    return getFullSettingsForTenantId(tid);
}

function logoDataUri(filename) {
    const safe = path.basename(String(filename || '').trim());
    if (!safe || safe === '.' || safe === '..') return '';
    const file = path.join(__dirname, '../public/img', safe);
    if (!fs.existsSync(file)) return '';
    const ext = path.extname(safe).slice(1).toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'webp'
            ? 'image/webp'
            : ext === 'gif'
                ? 'image/gif'
                : 'image/png';
    try {
        return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
    } catch (err) {
        logger.warn(`[invoicePdf] logo tidak dibaca: ${err.message}`);
        return '';
    }
}

function fieldHtml(label, value) {
    return `<div class="kv"><span class="k">${escapeHtml(label)}</span><span class="c">:</span><span class="v">${escapeHtml(value || '—')}</span></div>`;
}

const ICON_USER = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.2" fill="none" stroke="#3b82f6" stroke-width="1.8"/><path d="M6.2 18.2c1.2-2.6 3.2-3.8 5.8-3.8s4.6 1.2 5.8 3.8" fill="none" stroke="#3b82f6" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_CARD = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6" width="17" height="12" rx="2" fill="none" stroke="#d97706" stroke-width="1.8"/><path d="M3.5 10h17" stroke="#d97706" stroke-width="1.8"/></svg>';
const ICON_DOC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4.5h6l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-8.5A1.5 1.5 0 0 1 6.5 19V6A1.5 1.5 0 0 1 8 4.5z" fill="none" stroke="#3b82f6" stroke-width="1.7"/><path d="M14 4.8V9h4.2M9 13h6M9 16h4" fill="none" stroke="#3b82f6" stroke-width="1.7" stroke-linecap="round"/></svg>';
const ICON_HAND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 13.5V8.2a1.2 1.2 0 0 1 2.4 0V12M10.4 11.2V7.4a1.2 1.2 0 0 1 2.4 0V12M12.8 11.4V8.6a1.2 1.2 0 0 1 2.4 0v5.2c0 2.6-1.6 4.7-4.4 4.7-2.2 0-3.6-1.2-4.4-2.4L5 13.4" fill="none" stroke="#3b82f6" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 12.2l2.4 2.4L16.2 9.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Kwitansi lunas yang dikirim ke pelanggan.
 * Tidak mencantumkan nomor rekening — pembayaran sudah diverifikasi.
 */
function buildPaidReceiptHtml({ settings, customer, lines, payment, totals }) {
    const logo = logoDataUri('logo-mark.png') || logoDataUri('logo.png');
    const phone = String((settings && settings.contact_phone) || '').trim();
    const whatsapp = String((settings && settings.contact_whatsapp) || '').trim();
    const telp = phone || whatsapp;
    const gross = Number(totals.gross) || 0;
    const discount = Number(totals.discount) || 0;
    const paid = Number(totals.paid) || 0;

    const lineRows = (lines || []).map((line) => `
        <tr>
          <td>${escapeHtml(line.invoiceNumber || '—')}</td>
          <td>${escapeHtml(line.packageName || '—')}</td>
          <td>${escapeHtml(line.dueDate || '—')}</td>
          <td class="num">${escapeHtml(formatIdr(line.amount))}</td>
        </tr>`).join('');

    return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8"/>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Segoe UI", Arial, sans-serif;
    color: #1c2430;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .sheet {
    position: relative;
    overflow: hidden;
    min-height: 1000px;
    padding: 36px 40px 48px;
  }
  .wm {
    position: absolute;
    left: 50%;
    top: 48%;
    transform: translate(-50%, -50%) rotate(-28deg);
    font-size: 132px;
    font-weight: 800;
    letter-spacing: 16px;
    color: rgba(22, 140, 74, 0.14);
    white-space: nowrap;
    z-index: 0;
    pointer-events: none;
  }
  .art {
    position: absolute;
    right: -8px;
    bottom: -6px;
    width: 220px;
    height: 160px;
    z-index: 0;
    pointer-events: none;
  }
  .content { position: relative; z-index: 1; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; }
  .brand { display: flex; align-items: center; gap: 14px; }
  .brand img { width: 74px; height: 60px; object-fit: contain; }
  .co1 { margin: 0; font-size: 20px; font-weight: 800; letter-spacing: 0.2px; color: #111; line-height: 1.05; }
  .co2 { margin: 3px 0 0; font-size: 13px; font-weight: 800; letter-spacing: 2.4px; color: #111; }
  .doc { text-align: right; }
  .doc h1 { margin: 0; font-size: 32px; letter-spacing: 0.5px; color: #16324f; font-weight: 800; }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    padding: 4px 12px 4px 8px;
    border: 1.5px solid #1f9d55;
    color: #178a49;
    border-radius: 999px;
    font-weight: 800;
    letter-spacing: 0.8px;
    font-size: 13px;
    background: #fff;
  }
  .badge svg { width: 16px; height: 16px; }
  .block { margin-top: 26px; }
  .block-h { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .block-h h2 { margin: 0; font-size: 16px; font-weight: 800; color: #1a2332; }
  .ico {
    width: 32px; height: 32px; border-radius: 10px;
    display: flex; align-items: center; justify-content: center; flex: 0 0 32px;
  }
  .ico svg { width: 18px; height: 18px; }
  .ico-blue { background: #e8f2fc; }
  .ico-amber { background: #fff4df; }
  .kv { display: flex; align-items: baseline; gap: 8px; margin: 3px 0 3px 42px; font-size: 13px; }
  .kv .k { width: 108px; color: #8b95a1; flex: 0 0 108px; }
  .kv .c { color: #8b95a1; }
  .kv .v { font-weight: 700; color: #1c2430; }
  .table-wrap { margin-top: 8px; border: 1px solid #e6ebf1; border-radius: 10px; overflow: hidden; }
  table.lines { width: 100%; border-collapse: collapse; }
  .lines th {
    background: #f4f7fb;
    color: #8b95a1;
    font-weight: 600;
    font-size: 12px;
    text-align: left;
    padding: 10px 12px;
  }
  .lines td { padding: 12px; font-size: 13px; font-weight: 700; border-top: 1px solid #eef2f6; }
  .num { text-align: right; white-space: nowrap; }
  .sum { margin: 14px 4px 0 auto; width: 280px; border-collapse: collapse; }
  .sum td { padding: 3px 0; font-size: 13px; }
  .sum .label { color: #8b95a1; text-align: right; padding-right: 18px; }
  .sum .value { text-align: right; font-weight: 800; white-space: nowrap; }
  .paid {
    margin-top: 14px;
    background: #1f8f4c;
    color: #fff;
    border-radius: 12px;
    padding: 12px 18px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .paid .left { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; }
  .paid .left svg { width: 18px; height: 18px; }
  .paid .amt { font-size: 22px; font-weight: 800; }
  .foot { margin-top: 22px; padding-top: 14px; border-top: 1px solid #e6ebf1; }
  .thanks { display: flex; align-items: center; gap: 10px; margin: 0 0 6px; font-weight: 800; font-size: 14px; }
  .muted { margin: 0 0 2px 42px; color: #8b95a1; font-size: 12.5px; }
</style>
</head>
<body>
  <div class="sheet">
    <div class="wm">LUNAS</div>
    <svg class="art" viewBox="0 0 220 160" aria-hidden="true">
      <polygon points="220,160 90,160 220,40" fill="#7ec8f0" opacity="0.85"/>
      <polygon points="220,160 150,160 220,95" fill="#f2c14e" opacity="0.9"/>
      <polygon points="220,160 40,160 160,70" fill="#d7ecfb" opacity="0.55"/>
    </svg>
    <div class="content">
      <div class="top">
        <div class="brand">
          ${logo ? `<img src="${logo}" alt=""/>` : ''}
          <div>
            <p class="co1">PT. KALIMASADA</p>
            <p class="co2">INTI SARANA</p>
          </div>
        </div>
        <div class="doc">
          <h1>KWITANSI</h1>
          <div class="badge">${ICON_CHECK} LUNAS</div>
        </div>
      </div>

      <div class="block">
        <div class="block-h"><span class="ico ico-blue">${ICON_USER}</span><h2>Diterima dari</h2></div>
        ${fieldHtml('Nama', customer.name)}
        ${fieldHtml('Telepon', customer.phone)}
        ${fieldHtml('Alamat', customer.address)}
      </div>

      <div class="block">
        <div class="block-h"><span class="ico ico-amber">${ICON_CARD}</span><h2>Pembayaran</h2></div>
        ${fieldHtml('Tanggal bayar', formatDateId(payment.date))}
        ${fieldHtml('Metode', labelPaymentMethod(payment.method))}
      </div>

      <div class="block">
        <div class="block-h"><span class="ico ico-blue">${ICON_DOC}</span><h2>Rincian tagihan</h2></div>
        <div class="table-wrap">
          <table class="lines">
            <thead>
              <tr>
                <th>No. invoice</th>
                <th>Paket</th>
                <th>Jatuh tempo</th>
                <th class="num">Tagihan</th>
              </tr>
            </thead>
            <tbody>${lineRows}</tbody>
          </table>
        </div>
        <table class="sum">
          <tr><td class="label">Total tagihan</td><td class="value">${escapeHtml(formatIdr(gross))}</td></tr>
          ${discount > 0 ? `<tr><td class="label">Diskon</td><td class="value">- ${escapeHtml(formatIdr(discount))}</td></tr>` : ''}
        </table>
        <div class="paid">
          <div class="left">${ICON_CHECK} Total dibayar</div>
          <div class="amt">${escapeHtml(formatIdr(paid))}</div>
        </div>
      </div>

      <div class="foot">
        <p class="thanks"><span class="ico ico-blue">${ICON_HAND}</span>Terima kasih. Pembayaran ini sudah kami terima.</p>
        ${telp ? `<p class="muted">Telp ${escapeHtml(telp)}</p>` : ''}
        <p class="muted">Simpan kwitansi ini sebagai bukti pembayaran.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function resolvePaidLine(invoice) {
    const totals = await billingManager.getCollectorReceiptTotalsForInvoice(invoice.id);
    const amount = totals
        ? Number(totals.invoice_amount) || Number(invoice.amount) || 0
        : Number(invoice.amount) || 0;
    const discount = totals ? Number(totals.discount_amount) || 0 : 0;
    const paid = totals
        ? Number(totals.amount_paid) || Math.max(0, amount - discount)
        : Math.max(0, amount - discount);
    return {
        line: {
            invoiceNumber: invoice.invoice_number || String(invoice.id),
            packageName: invoice.package_name || '—',
            dueDate: formatDateId(invoice.due_date),
            amount
        },
        amount,
        discount,
        paid,
        paymentDate: (totals && totals.payment_date) || invoice.payment_date || '',
        paymentMethod: (totals && totals.payment_method) || invoice.payment_method || ''
    };
}

function customerFromInvoice(invoice) {
    return {
        name: invoice.customer_name || '—',
        phone: invoice.customer_phone || '—',
        address: invoice.customer_address || '—'
    };
}

async function renderPdf(html) {
    const browser = await puppeteer.launch({
        headless: true,
        args: PUPPETEER_ARGS
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0.6cm', bottom: '0.6cm', left: '0.6cm', right: '0.6cm' }
        });
        return Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
    } finally {
        await browser.close();
    }
}

async function generateInvoicePdf(invoiceId) {
    try {
        const invoice = await billingManager.getInvoiceById(invoiceId);
        if (!invoice) {
            throw new Error(`Invoice not found for ID ${invoiceId}`);
        }
        const settings = await loadTenantReceiptSettings(invoice.tenant_id);
        const fact = await resolvePaidLine(invoice);
        const html = buildPaidReceiptHtml({
            settings,
            customer: customerFromInvoice(invoice),
            lines: [fact.line],
            payment: { date: fact.paymentDate, method: fact.paymentMethod },
            totals: { gross: fact.amount, discount: fact.discount, paid: fact.paid }
        });
        const buffer = await renderPdf(html);
        const fileName = `Kwitansi-${safeFileName(invoice.invoice_number || invoiceId)}.pdf`;
        return { buffer, fileName, invoice };
    } catch (error) {
        logger.error('Error generating invoice PDF:', error);
        throw error;
    }
}

/**
 * PDF kwitansi lunas untuk beberapa invoice yang dilunasi dalam satu sesi.
 */
async function generateCollectorBatchReceiptPdf(invoiceIds) {
    const ids = [...new Set((invoiceIds || [])
        .map((v) => parseInt(String(v), 10))
        .filter((id) => Number.isFinite(id) && id > 0))];
    if (!ids.length) {
        throw new Error('Tidak ada invoice untuk resi batch');
    }
    if (ids.length === 1) {
        return generateInvoicePdf(ids[0]);
    }

    const invoices = [];
    for (const id of ids) {
        const inv = await billingManager.getInvoiceById(id);
        if (inv) invoices.push(inv);
    }
    if (!invoices.length) {
        throw new Error('Invoice batch tidak ditemukan');
    }

    const facts = [];
    for (const inv of invoices) {
        facts.push(await resolvePaidLine(inv));
    }
    const first = invoices[0];
    const settings = await loadTenantReceiptSettings(first.tenant_id);
    const batch = await billingManager.getCollectorReceiptTotalsForInvoices(invoices.map((inv) => inv.id));
    const gross = batch ? Number(batch.invoice_amount) || 0 : facts.reduce((s, f) => s + f.amount, 0);
    const discount = batch ? Number(batch.discount_amount) || 0 : facts.reduce((s, f) => s + f.discount, 0);
    const paid = batch ? Number(batch.amount_paid) || 0 : facts.reduce((s, f) => s + f.paid, 0);
    const paymentDate = (batch && batch.payment_date) || facts.map((f) => f.paymentDate).find(Boolean) || '';
    const paymentMethod = (batch && batch.payment_method) || facts.map((f) => f.paymentMethod).find(Boolean) || '';

    const html = buildPaidReceiptHtml({
        settings,
        customer: customerFromInvoice(first),
        lines: facts.map((f) => f.line),
        payment: { date: paymentDate, method: paymentMethod },
        totals: { gross, discount, paid }
    });
    const buffer = await renderPdf(html);
    return {
        buffer,
        fileName: `Kwitansi-${invoices.length}-invoice.pdf`,
        invoice: first
    };
}

module.exports = {
    generateInvoicePdf,
    generateCollectorBatchReceiptPdf,
    buildPaidReceiptHtml
};
