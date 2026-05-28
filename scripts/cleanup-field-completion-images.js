#!/usr/bin/env node
/**
 * Bersihkan foto penyelesaian tugas lapangan (bebaskan ruang disk).
 * Usage:
 *   node scripts/cleanup-field-completion-images.js           # normal
 *   node scripts/cleanup-field-completion-images.js --aggressive  # hapus foto job selesai >1 hari
 */
require('dotenv').config();
const {
    cleanupFieldCompletionImages,
    getUploadDir
} = require('../utils/fieldCompletionStorage');

const aggressive = process.argv.includes('--aggressive');

(async () => {
    console.log('Upload dir:', getUploadDir());
    console.log('Mode:', aggressive ? 'aggressive' : 'normal');
    const r = await cleanupFieldCompletionImages({ aggressive, syncDb: true });
    console.log('Deleted files:', r.deleted);
    console.log('Freed (approx):', Math.round((r.freedBytes || 0) / 1024 / 1024), 'MB');
    console.log('DB rows cleared:', r.dbCleared);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
