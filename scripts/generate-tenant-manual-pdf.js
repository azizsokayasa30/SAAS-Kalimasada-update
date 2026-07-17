#!/usr/bin/env node
/**
 * Generate Tenant Operation Manual PDF from Markdown + figures.
 *
 * Usage:
 *   node scripts/generate-tenant-manual-pdf.js
 *
 * Env:
 *   MANUAL_MD   default docs/manual/TENANT_OPERATION_GUIDE.md
 *   MANUAL_PDF  default docs/BUKU_PANDUAN_TENANT_OPERATION.pdf
 */
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const MD_PATH = process.env.MANUAL_MD
  || path.join(ROOT, 'docs/manual/TENANT_OPERATION_GUIDE.md');
const PDF_PATH = process.env.MANUAL_PDF
  || path.join(ROOT, 'docs/BUKU_PANDUAN_TENANT_OPERATION.pdf');
const FIGURES_DIR = path.join(ROOT, 'docs/manual/figures');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineFormat(text) {
  let t = escapeHtml(text);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  t = t.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>'
  );
  return t;
}

function resolveImageSrc(src) {
  if (src.startsWith('http') || src.startsWith('data:')) return src;
  const abs = path.resolve(path.dirname(MD_PATH), src);
  if (!fs.existsSync(abs)) {
    console.warn('Missing figure:', abs);
    return '';
  }
  const buf = fs.readFileSync(abs);
  const b64 = buf.toString('base64');
  const ext = path.extname(abs).toLowerCase().replace('.', '') || 'png';
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
  return `data:${mime};base64,${b64}`;
}

function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let inUl = false;
  let inOl = false;
  let inTable = false;
  let inCode = false;
  let codeLang = '';
  let codeBuf = [];

  const closeLists = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };
  const closeTable = () => {
    if (inTable) { out.push('</tbody></table>'); inTable = false; }
  };

  while (i < lines.length) {
    const raw = lines[i];

    if (raw.startsWith('```')) {
      if (!inCode) {
        closeLists();
        closeTable();
        inCode = true;
        codeLang = raw.slice(3).trim();
        codeBuf = [];
      } else {
        out.push(`<pre class="code"><code class="lang-${escapeHtml(codeLang)}">${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        inCode = false;
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      i++;
      continue;
    }

    if (raw.trim() === '---') {
      closeLists();
      closeTable();
      out.push('<hr>');
      i++;
      continue;
    }

    // Images: ![alt](src)
    const imgMatch = raw.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imgMatch) {
      closeLists();
      closeTable();
      const src = resolveImageSrc(imgMatch[2]);
      if (src) {
        out.push(`<figure class="fig"><img src="${src}" alt="${escapeHtml(imgMatch[1])}"></figure>`);
      } else {
        out.push(`<p class="fig-missing">[Gambar tidak tersedia: ${escapeHtml(imgMatch[2])}]</p>`);
      }
      i++;
      continue;
    }

    // Caption lines like *Gambar 1.1 — ...*
    if (/^\*Gambar\s+[\d.]+\s+[—–-].*\*$/.test(raw.trim())) {
      closeLists();
      closeTable();
      out.push(`<p class="figcap">${inlineFormat(raw.trim().replace(/^\*|\*$/g, ''))}</p>`);
      i++;
      continue;
    }

    // Blockquote
    if (raw.startsWith('> ')) {
      closeLists();
      closeTable();
      const parts = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        parts.push(lines[i].slice(2));
        i++;
      }
      out.push(`<blockquote>${parts.map(inlineFormat).join('<br>')}</blockquote>`);
      continue;
    }

    // Headings
    const h = raw.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      closeLists();
      closeTable();
      const level = h[1].length;
      const text = h[2].replace(/#+\s*$/, '').trim();
      const id = text.toLowerCase()
        .replace(/[^a-z0-9\u00C0-\u024F\s-]/gi, '')
        .replace(/\s+/g, '-');
      out.push(`<h${level} id="${id}">${inlineFormat(text)}</h${level}>`);
      i++;
      continue;
    }

    // Table
    if (raw.includes('|') && raw.trim().startsWith('|')) {
      closeLists();
      const cells = raw.split('|').slice(1, -1).map((c) => c.trim());
      const next = lines[i + 1] || '';
      const isSep = /^\|?\s*:?-{3,}/.test(next.trim());
      if (!inTable) {
        out.push('<table><thead><tr>' + cells.map((c) => `<th>${inlineFormat(c)}</th>`).join('') + '</tr></thead><tbody>');
        inTable = true;
        i += isSep ? 2 : 1;
        continue;
      }
      if (/^\|?\s*:?-{3,}/.test(raw.trim())) {
        i++;
        continue;
      }
      out.push('<tr>' + cells.map((c) => `<td>${inlineFormat(c)}</td>`).join('') + '</tr>');
      i++;
      continue;
    } else {
      closeTable();
    }

    // Lists
    const ul = raw.match(/^\s*[-*]\s+(.+)$/);
    const ol = raw.match(/^\s*\d+\.\s+(.+)$/);
    const check = raw.match(/^\s*-\s+\[([ xX])\]\s+(.+)$/);
    if (check) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul class="checklist">'); inUl = true; }
      const done = check[1].toLowerCase() === 'x';
      out.push(`<li class="${done ? 'done' : ''}">${inlineFormat(check[2])}</li>`);
      i++;
      continue;
    }
    if (ul) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${inlineFormat(ul[1])}</li>`);
      i++;
      continue;
    }
    if (ol) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${inlineFormat(ol[1])}</li>`);
      i++;
      continue;
    }

    closeLists();

    if (!raw.trim()) {
      i++;
      continue;
    }

    out.push(`<p>${inlineFormat(raw)}</p>`);
    i++;
  }

  closeLists();
  closeTable();
  if (inCode) {
    out.push(`<pre class="code"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  }
  return out.join('\n');
}

function buildDocument(bodyHtml) {
  const logoPath = path.join(ROOT, 'public/img/logo.png');
  let logoData = '';
  if (fs.existsSync(logoPath)) {
    logoData = `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`;
  }

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<title>Buku Panduan Tenant Operation</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.55;
    color: #1a2332;
    margin: 0;
  }
  .cover {
    page-break-after: always;
    min-height: 240mm;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    padding: 24mm 8mm;
    background: linear-gradient(165deg, #0f2744 0%, #1a4a6e 45%, #0d3d56 100%);
    color: #fff;
    margin: -18mm -16mm 0;
    padding-left: 22mm;
    padding-right: 22mm;
  }
  .cover img.logo { height: 56px; margin-bottom: 28px; border-radius: 8px; background: #fff; padding: 6px; }
  .cover .eyebrow { letter-spacing: 0.12em; text-transform: uppercase; font-size: 10pt; opacity: 0.85; margin-bottom: 12px; }
  .cover h1 { font-size: 28pt; line-height: 1.2; margin: 0 0 14px; font-weight: 700; max-width: 140mm; }
  .cover .sub { font-size: 12pt; opacity: 0.9; max-width: 140mm; margin-bottom: 36px; }
  .cover .meta { font-size: 9.5pt; opacity: 0.75; border-top: 1px solid rgba(255,255,255,0.25); padding-top: 16px; width: 100%; }

  h1 { font-size: 18pt; color: #0f2744; border-bottom: 2px solid #2a6f97; padding-bottom: 6px; margin-top: 28px; page-break-after: avoid; }
  h2 { font-size: 13.5pt; color: #1a4a6e; margin-top: 22px; page-break-after: avoid; }
  h3 { font-size: 11.5pt; color: #245a78; margin-top: 16px; page-break-after: avoid; }
  p { margin: 8px 0; }
  a { color: #1a4a6e; text-decoration: none; }

  ul, ol { margin: 8px 0 12px; padding-left: 22px; }
  li { margin: 3px 0; }
  ul.checklist { list-style: none; padding-left: 4px; }
  ul.checklist li::before { content: "☐ "; color: #2a6f97; }
  ul.checklist li.done::before { content: "☑ "; }

  blockquote {
    margin: 12px 0;
    padding: 10px 14px;
    background: #eef6fb;
    border-left: 4px solid #2a6f97;
    color: #243447;
    page-break-inside: avoid;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0 16px;
    font-size: 9.5pt;
    page-break-inside: avoid;
  }
  th, td {
    border: 1px solid #c5d4e0;
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
  }
  th { background: #e8f1f8; color: #0f2744; font-weight: 600; }

  pre.code {
    background: #f4f7fa;
    border: 1px solid #d5e0ea;
    border-radius: 4px;
    padding: 10px 12px;
    font-size: 9pt;
    overflow: hidden;
    white-space: pre-wrap;
    page-break-inside: avoid;
  }
  code {
    font-family: "Consolas", "Courier New", monospace;
    font-size: 9pt;
    background: #f0f4f8;
    padding: 1px 4px;
    border-radius: 3px;
  }
  pre code { background: transparent; padding: 0; }

  figure.fig {
    margin: 14px 0 4px;
    text-align: center;
    page-break-inside: avoid;
  }
  figure.fig img {
    max-width: 100%;
    max-height: 170mm;
    height: auto;
    border: 1px solid #c5d4e0;
    border-radius: 4px;
    box-shadow: 0 1px 4px rgba(15, 39, 68, 0.08);
  }
  p.figcap {
    text-align: center;
    font-size: 9pt;
    color: #4a5d72;
    font-style: italic;
    margin: 2px 0 16px;
    page-break-before: avoid;
  }
  p.fig-missing {
    background: #fff3cd;
    border: 1px dashed #c9a227;
    padding: 16px;
    text-align: center;
    color: #6b5a1e;
    page-break-inside: avoid;
  }
  hr { border: none; border-top: 1px solid #d5e0ea; margin: 22px 0; }

  .toc-note { color: #4a5d72; font-size: 9.5pt; }
</style>
</head>
<body>
  <section class="cover">
    ${logoData ? `<img class="logo" src="${logoData}" alt="Logo">` : ''}
    <div class="eyebrow">Dokumentasi Operasional Tenant</div>
    <h1>Buku Panduan Tenant Operation</h1>
    <p class="sub">Setup aplikasi billing, alur NAS → pelanggan → keuangan, serta operasional gudang, absensi, teknisi, kolektor, dan agent.</p>
    <div class="meta">
      Kalimasada Inti Sarana · Aplikasi Billing ISP<br>
      Versi dokumen: ${new Date().toISOString().slice(0, 10)}
    </div>
  </section>
  <main>
    ${bodyHtml}
  </main>
</body>
</html>`;
}

async function main() {
  if (!fs.existsSync(MD_PATH)) {
    console.error('Markdown not found:', MD_PATH);
    process.exit(1);
  }
  const md = fs.readFileSync(MD_PATH, 'utf8');
  // Skip the first H1 on cover duplication — keep content starting after first hr following title block
  const bodyHtml = mdToHtml(md);
  const html = buildDocument(bodyHtml);

  const tmpHtml = path.join(ROOT, 'docs/manual/_manual_render.html');
  fs.writeFileSync(tmpHtml, html, 'utf8');
  console.log('HTML written:', tmpHtml);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.goto('file://' + tmpHtml, { waitUntil: 'networkidle0', timeout: 120000 });

  await page.pdf({
    path: PDF_PATH,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: `
      <div style="font-size:8px;width:100%;padding:0 16mm;color:#6b7c8f;display:flex;justify-content:space-between;">
        <span>Buku Panduan Tenant Operation</span>
        <span>Kalimasada Inti Sarana</span>
      </div>`,
    footerTemplate: `
      <div style="font-size:8px;width:100%;padding:0 16mm;color:#6b7c8f;display:flex;justify-content:space-between;">
        <span>Rahasia internal — jangan bagikan kredensial</span>
        <span>Halaman <span class="pageNumber"></span> / <span class="totalPages"></span></span>
      </div>`,
    margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' },
  });

  await browser.close();
  const size = fs.statSync(PDF_PATH).size;
  console.log(`PDF OK: ${PDF_PATH} (${Math.round(size / 1024)} KB)`);
  console.log(`Figures present: ${fs.existsSync(FIGURES_DIR) ? fs.readdirSync(FIGURES_DIR).filter((f) => f.endsWith('.png')).length : 0}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
