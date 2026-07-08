'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPublicAppBaseUrl } = require('../config/public-endpoint');

function digitsOnly(s) {
    return String(s || '').replace(/\D/g, '');
}

/** Varian nomor untuk cocokkan no_hp karyawan ↔ phone teknisi */
function phoneDigitVariants(phone) {
    const d = digitsOnly(phone);
    if (!d || d.length < 8) return [];
    const s = new Set([d]);
    if (d.startsWith('62') && d.length > 2) s.add('0' + d.slice(2));
    if (d.startsWith('0') && d.length > 2) s.add('62' + d.slice(1));
    return [...s];
}

function pickTechnicianPhotoPath(technicianRow) {
    if (!technicianRow || typeof technicianRow !== 'object') return null;
    for (const key of ['foto_path', 'photo_path', 'photo']) {
        const value = technicianRow[key];
        if (value != null && String(value).trim()) return String(value).trim();
    }
    return null;
}

/**
 * Cari foto karyawan yang dipetakan ke teknisi (nama sama, atau nomor sama).
 * Prioritas: kolom foto di technicians, lalu employees by name/phone.
 * @param {import('sqlite3').Database} db
 * @param {{ name?: string, phone?: string, foto_path?: string, photo_path?: string }} technicianRow
 * @param {(err: Error|null, fotoPath: string|null) => void} callback
 */
function resolveEmployeePhotoPath(db, technicianRow, callback) {
    const direct = pickTechnicianPhotoPath(technicianRow);
    if (direct) {
        return process.nextTick(() => callback(null, direct));
    }

    const name = String(technicianRow.name || '').trim();
    const variants = phoneDigitVariants(technicianRow.phone);

    const finishPhone = () => {
        if (variants.length === 0) {
            return process.nextTick(() => callback(null, null));
        }
        const qs = variants.map(() => '?').join(',');
        db.get(
            `SELECT foto_path FROM employees
             WHERE LOWER(IFNULL(status, '')) != 'nonaktif'
               AND foto_path IS NOT NULL AND TRIM(foto_path) != ''
               AND REPLACE(REPLACE(REPLACE(IFNULL(no_hp, ''), ' ', ''), '-', ''), '+', '') IN (${qs})
             LIMIT 1`,
            variants,
            (e2, r2) => {
                if (e2) return callback(e2);
                callback(null, (r2 && r2.foto_path) || null);
            }
        );
    };

    if (name) {
        db.get(
            `SELECT foto_path FROM employees
             WHERE LOWER(IFNULL(status, '')) != 'nonaktif'
               AND foto_path IS NOT NULL AND TRIM(foto_path) != ''
               AND LOWER(TRIM(nama_lengkap)) = LOWER(?)
             LIMIT 1`,
            [name],
            (err, row) => {
                if (err) return callback(err);
                if (row && row.foto_path) return callback(null, row.foto_path);
                finishPhone();
            }
        );
        return;
    }

    finishPhone();
}

/** URL absolut untuk gambar di aplikasi mobile */
function buildPhotoUrl(relPath) {
    if (!relPath || typeof relPath !== 'string') return null;
    const p = relPath.startsWith('/') ? relPath : `/${relPath}`;
    const base = getPublicAppBaseUrl().replace(/\/+$/, '');
    return `${base}${p}`;
}

function getEmployeePhotoUploadDir() {
    return path.join(__dirname, '../public/uploads/employees');
}

function decodeProfilePhotoBase64(base64Input) {
    if (base64Input == null || base64Input === '') return null;
    let raw = String(base64Input).trim();
    if (!raw) return null;
    if (raw.includes(',')) raw = raw.split(',').pop();
    let buf;
    try {
        buf = Buffer.from(raw, 'base64');
    } catch (_) {
        throw new Error('Format foto tidak valid');
    }
    if (!buf || buf.length < 24) throw new Error('Foto tidak valid');
    const maxBytes = 4 * 1024 * 1024;
    if (buf.length > maxBytes) {
        throw new Error('Foto terlalu besar (maks 4MB)');
    }
    return buf;
}

function extFromImageBuffer(buf) {
    if (!buf || buf.length < 4) return '.jpg';
    if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
    if (buf[0] === 0x52 && buf[1] === 0x49) return '.webp';
    return '.jpg';
}

/**
 * Simpan foto profil teknisi ke folder employees (sama dengan admin).
 * @returns {{ absPath: string, relPath: string }}
 */
function saveTechnicianProfilePhotoFromBase64(base64Input) {
    const buf = decodeProfilePhotoBase64(base64Input);
    if (!buf) throw new Error('Foto wajib diisi');
    const dir = getEmployeePhotoUploadDir();
    fs.mkdirSync(dir, { recursive: true });
    const filename = `tech-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${extFromImageBuffer(buf)}`;
    const absPath = path.join(dir, filename);
    fs.writeFileSync(absPath, buf);
    return {
        absPath,
        relPath: `/public/uploads/employees/${filename}`,
    };
}

/**
 * Simpan foto profil kolektor (folder employees yang sama).
 * @returns {{ absPath: string, relPath: string }}
 */
function saveCollectorProfilePhotoFromBase64(base64Input) {
    const buf = decodeProfilePhotoBase64(base64Input);
    if (!buf) throw new Error('Foto wajib diisi');
    const dir = getEmployeePhotoUploadDir();
    fs.mkdirSync(dir, { recursive: true });
    const filename = `col-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${extFromImageBuffer(buf)}`;
    const absPath = path.join(dir, filename);
    fs.writeFileSync(absPath, buf);
    return {
        absPath,
        relPath: `/public/uploads/employees/${filename}`,
    };
}

function unlinkPhotoIfExists(relPath) {
    if (!relPath || typeof relPath !== 'string') return;
    const cleaned = relPath.trim();
    if (!cleaned) return;
    const candidates = [
        path.join(__dirname, '..', cleaned.replace(/^\//, '')),
        path.join(__dirname, '..', cleaned.replace(/^\/public\//, 'public/')),
    ];
    for (const abs of candidates) {
        try {
            if (fs.existsSync(abs)) fs.unlinkSync(abs);
        } catch (_) {
            /* ignore */
        }
    }
}

module.exports = {
    resolveEmployeePhotoPath,
    buildPhotoUrl,
    digitsOnly,
    phoneDigitVariants,
    saveTechnicianProfilePhotoFromBase64,
    saveCollectorProfilePhotoFromBase64,
    unlinkPhotoIfExists,
    pickTechnicianPhotoPath,
};
