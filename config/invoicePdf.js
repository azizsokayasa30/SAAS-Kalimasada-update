const path = require('path');
const ejs = require('ejs');
const puppeteer = require('puppeteer');
const logger = require('./logger');
const billingManager = require('./billing');
const { getSetting } = require('./settingsManager');

function buildAppSettings() {
    return {
        companyHeader: getSetting('company_header', 'ISP Monitor'),
        footerInfo: getSetting('footer_info', ''),
        logoFilename: getSetting('logo_filename', 'logo.png'),
        company_slogan: getSetting('company_slogan', ''),
        company_website: getSetting('company_website', ''),
        invoice_notes: getSetting('invoice_notes', ''),
        payment_bank_name: getSetting('payment_bank_name', ''),
        payment_account_number: getSetting('payment_account_number', ''),
        payment_account_holder: getSetting('payment_account_holder', ''),
        payment_cash_address: getSetting('payment_cash_address', ''),
        payment_cash_hours: getSetting('payment_cash_hours', ''),
        contact_phone: getSetting('contact_phone', ''),
        contact_email: getSetting('contact_email', ''),
        contact_address: getSetting('contact_address', ''),
        contact_whatsapp: getSetting('contact_whatsapp', ''),
        suspension_grace_period_days: getSetting('suspension_grace_period_days', '3'),
        isolir_profile: getSetting('isolir_profile', 'isolir')
    };
}

async function renderInvoice(invoiceId) {
    const invoice = await billingManager.getInvoiceById(invoiceId);
    if (!invoice) {
        throw new Error(`Invoice not found for ID ${invoiceId}`);
    }

    const templatePath = path.join(__dirname, '../views/admin/billing/invoice-print.ejs');

    const html = await ejs.renderFile(
        templatePath,
        {
            title: 'Cetak Invoice',
            invoice,
            appSettings: buildAppSettings()
        },
        { async: true }
    );

    return { html, invoice };
}

async function generateInvoicePdf(invoiceId) {
    try {
        const { html, invoice } = await renderInvoice(invoiceId);

        const browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer'
            ]
        });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: {
                top: '0.4cm',
                bottom: '0.4cm',
                left: '0.4cm',
                right: '0.4cm'
            }
        });

        await browser.close();

        const buffer = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);

        return {
            buffer,
            fileName: `Invoice-${invoice.invoice_number || invoiceId}.pdf`,
            invoice
        };
    } catch (error) {
        logger.error('Error generating invoice PDF:', error);
        throw error;
    }
}

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

/**
 * PDF nota lunas untuk beberapa invoice yang dilunasi dalam satu sesi kolektor.
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
        if (!inv) continue;
        const totals = await billingManager.getCollectorReceiptTotalsForInvoice(id);
        invoices.push({ inv, totals });
    }
    if (!invoices.length) {
        throw new Error('Invoice batch tidak ditemukan');
    }

    const batchTotals = await billingManager.getCollectorReceiptTotalsForInvoices(
        invoices.map((x) => x.inv.id)
    );
    const settings = buildAppSettings();
    const first = invoices[0].inv;
    const customerName = first.customer_name || '-';
    const customerPhone = first.customer_phone || '-';
    const customerAddress = first.customer_address || '-';
    const paymentMethod = (batchTotals && batchTotals.payment_method) || first.payment_method || '-';
    const paymentDate = (batchTotals && batchTotals.payment_date) || first.payment_date || '-';
    const gross = batchTotals ? Number(batchTotals.invoice_amount) || 0 : 0;
    const discount = batchTotals ? Number(batchTotals.discount_amount) || 0 : 0;
    const paid = batchTotals ? Number(batchTotals.amount_paid) || 0 : 0;

    const rowsHtml = invoices
        .map(({ inv, totals }) => {
            const amount = totals ? Number(totals.invoice_amount) || Number(inv.amount) || 0 : Number(inv.amount) || 0;
            return `<tr>
              <td>${escapeHtml(inv.invoice_number || inv.id)}</td>
              <td>${escapeHtml(inv.package_name || '-')}</td>
              <td>${escapeHtml(inv.due_date || inv.created_at || '-')}</td>
              <td style="text-align:right">${escapeHtml(formatIdr(amount))}</td>
            </tr>`;
        })
        .join('');

    const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8"/>
<style>
  body { font-family: Arial, sans-serif; color: #111; font-size: 12px; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .muted { color: #555; }
  .badge { display:inline-block; margin-top:8px; padding:4px 10px; background:#e8f5e9; color:#0d5a16; font-weight:700; border-radius:4px; }
  table { width:100%; border-collapse:collapse; margin-top:16px; }
  th, td { border:1px solid #ccc; padding:8px; }
  th { background:#f1f5f9; text-align:left; }
  .totals { margin-top:16px; width:100%; }
  .totals td { border:none; padding:4px 0; }
  .totals .label { color:#555; }
  .totals .value { text-align:right; font-weight:700; }
</style>
</head>
<body>
  <h1>${escapeHtml(settings.companyHeader || 'ISP')}</h1>
  <div class="muted">${escapeHtml(settings.company_slogan || '')}</div>
  <div class="badge">LUNAS — ${invoices.length} Invoice</div>
  <p style="margin-top:16px">
    <strong>Pelanggan:</strong> ${escapeHtml(customerName)}<br/>
    <strong>Telepon:</strong> ${escapeHtml(customerPhone)}<br/>
    <strong>Alamat:</strong> ${escapeHtml(customerAddress)}<br/>
    <strong>Tanggal bayar:</strong> ${escapeHtml(paymentDate)}<br/>
    <strong>Metode:</strong> ${escapeHtml(paymentMethod)}
  </p>
  <table>
    <thead>
      <tr><th>No. Invoice</th><th>Paket</th><th>Periode / Jatuh tempo</th><th>Tagihan</th></tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <table class="totals">
    <tr><td class="label">Total tagihan</td><td class="value">${escapeHtml(formatIdr(gross))}</td></tr>
    ${discount > 0 ? `<tr><td class="label">Diskon</td><td class="value">- ${escapeHtml(formatIdr(discount))}</td></tr>` : ''}
    <tr><td class="label">Total dibayar</td><td class="value">${escapeHtml(formatIdr(paid))}</td></tr>
  </table>
  <p class="muted" style="margin-top:24px">${escapeHtml(settings.footerInfo || '')}</p>
</body>
</html>`;

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer'
        ]
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0.4cm', bottom: '0.4cm', left: '0.4cm', right: '0.4cm' }
        });
        const buffer = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
        return {
            buffer,
            fileName: `Resi-${invoices.length}-invoice.pdf`,
            invoice: first
        };
    } finally {
        await browser.close();
    }
}

module.exports = {
    generateInvoicePdf,
    generateCollectorBatchReceiptPdf
};

