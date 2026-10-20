'use strict';

const fs = require('fs');
const path = require('path');
const multer = require('multer');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function sniffImage(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    const gif = buf.toString('ascii', 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
    return null;
}

function createSafeImageUpload({ destination, filename, maxBytes }) {
    const limit = maxBytes || DEFAULT_MAX_BYTES;

    const storage = {
        _handleFile(req, file, cb) {
            const chunks = [];
            let size = 0;
            let settled = false;

            const fail = (err) => {
                if (settled) return;
                settled = true;
                cb(err);
            };

            file.stream.on('data', (chunk) => {
                if (settled) return;
                size += chunk.length;
                if (size > limit) {
                    file.stream.destroy();
                    fail(new Error('Ukuran file melebihi batas unggah'));
                    return;
                }
                chunks.push(chunk);
            });
            file.stream.on('error', (err) => fail(err));
            file.stream.on('end', () => {
                if (settled) return;
                const buf = Buffer.concat(chunks);
                const kind = sniffImage(buf);
                if (!kind) {
                    fail(new Error('File ditolak. Hanya gambar JPG, PNG, WEBP, atau GIF yang valid.'));
                    return;
                }
                const ext = kind === 'jpg' ? '.jpg' : `.${kind}`;
                const doneDest = (err, dest) => {
                    if (err) return fail(err);
                    const doneName = (nerr, chosen) => {
                        if (nerr) return fail(nerr);
                        const safeName = path.basename(String(chosen || ''));
                        if (!safeName || safeName !== String(chosen || '') || safeName.includes('..')) {
                            return fail(new Error('Nama file tidak valid'));
                        }
                        try {
                            fs.mkdirSync(dest, { recursive: true });
                            const full = path.join(dest, safeName);
                            fs.writeFileSync(full, buf, { mode: 0o644 });
                            settled = true;
                            cb(null, {
                                destination: dest,
                                filename: safeName,
                                path: full,
                                size: buf.length,
                            });
                        } catch (writeErr) {
                            fail(writeErr);
                        }
                    };
                    if (typeof filename === 'function') filename(req, file, ext, doneName);
                    else doneName(null, `upload-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
                };
                if (typeof destination === 'function') destination(req, file, doneDest);
                else doneDest(null, destination);
            });
        },
        _removeFile(req, file, cb) {
            fs.unlink(file.path, () => cb(null));
        },
    };

    return multer({
        storage,
        limits: { fileSize: limit, files: 4 },
    });
}

module.exports = {
    createSafeImageUpload,
    sniffImage,
};
