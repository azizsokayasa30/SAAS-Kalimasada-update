#!/usr/bin/env node
/**
 * Generate editable Word (.docx) version of the Tenant Operation Manual.
 *
 * Requires: pandoc (apt install pandoc)
 *
 * Usage:
 *   node scripts/generate-tenant-manual-docx.js
 *
 * Env:
 *   MANUAL_MD    default docs/manual/TENANT_OPERATION_GUIDE.md
 *   MANUAL_DOCX  default docs/BUKU_PANDUAN_TENANT_OPERATION.docx
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MD_PATH = process.env.MANUAL_MD
  || path.join(ROOT, 'docs/manual/TENANT_OPERATION_GUIDE.md');
const DOCX_PATH = process.env.MANUAL_DOCX
  || path.join(ROOT, 'docs/BUKU_PANDUAN_TENANT_OPERATION.docx');
const RESOURCE_PATH = path.join(ROOT, 'docs/manual');

function whichPandoc() {
  const r = spawnSync('pandoc', ['--version'], { encoding: 'utf8' });
  if (r.status === 0) return 'pandoc';
  return null;
}

function main() {
  if (!fs.existsSync(MD_PATH)) {
    console.error('Markdown not found:', MD_PATH);
    process.exit(1);
  }
  if (!whichPandoc()) {
    console.error('pandoc tidak ditemukan. Instal dengan: apt install pandoc');
    process.exit(1);
  }

  const args = [
    MD_PATH,
    '-o', DOCX_PATH,
    '--resource-path=' + RESOURCE_PATH,
    '--from', 'markdown',
    '--to', 'docx',
    '--toc',
    '--toc-depth=2',
  ];

  console.log('Running: pandoc', args.join(' '));
  const result = spawnSync('pandoc', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout || 'pandoc failed');
    process.exit(result.status || 1);
  }

  const size = fs.statSync(DOCX_PATH).size;
  console.log(`DOCX OK: ${DOCX_PATH} (${Math.round(size / 1024)} KB)`);
}

main();
