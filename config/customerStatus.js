'use strict';

/**
 * Klasifikasi status pelanggan (canonical + alias lapangan).
 * Canonical: active | suspended | isolir | inactive | register
 *
 * Bucket untuk statistik tenant/billing:
 * - active  → active / aktif
 * - isolir  → suspended / suspend / isolir / isolated / *isolir*
 * - inactive → inactive / nonaktif
 */

const ACTIVE_ALIASES = new Set(['active', 'aktif']);
const INACTIVE_ALIASES = new Set(['inactive', 'nonaktif']);
const ISOLIR_ALIASES = new Set(['suspended', 'suspend', 'isolir', 'isolated']);

/** SQL expr: lower(trim(status)) — alias kolom opsional, default "status" */
function statusNormSql(column = 'status') {
    return `LOWER(TRIM(COALESCE(${column}, '')))`;
}

/** SQL CASE/WHEN: 1 jika bucket aktif (bukan isolir) */
function sqlIsActive(column = 'status') {
    const n = statusNormSql(column);
    return `(${n} IN ('active', 'aktif'))`;
}

/** SQL: 1 jika isolir / suspend (termasuk disable/isolir) */
function sqlIsIsolir(column = 'status') {
    const n = statusNormSql(column);
    return `(${n} IN ('suspended', 'suspend', 'isolir', 'isolated') OR ${n} LIKE '%isolir%')`;
}

/** SQL: 1 jika nonaktif */
function sqlIsInactive(column = 'status') {
    const n = statusNormSql(column);
    return `(${n} IN ('inactive', 'nonaktif'))`;
}

/** Untuk filter WHERE — daftar nilai literal + LIKE isolir */
function sqlStatusInActive(column = 'status') {
    return sqlIsActive(column);
}

function sqlStatusInIsolir(column = 'status') {
    return sqlIsIsolir(column);
}

function sqlStatusInInactive(column = 'status') {
    return sqlIsInactive(column);
}

/** "Pelanggan berlangganan" = aktif + isolir (bukan nonaktif) — legacy filter customer_type=aktif */
function sqlIsSubscribed(column = 'status') {
    return `(${sqlIsActive(column)} OR ${sqlIsIsolir(column)})`;
}

/**
 * Map status mentah → canonical untuk normalisasi DB.
 * @returns {'active'|'suspended'|'isolir'|'inactive'|'register'|null} null = biarkan
 */
function canonicalizeStatus(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return null;
    if (ACTIVE_ALIASES.has(s)) return 'active';
    if (INACTIVE_ALIASES.has(s)) return 'inactive';
    if (s === 'suspended' || s === 'suspend') return 'suspended';
    if (s === 'isolir' || s === 'isolated' || s.includes('isolir')) return 'isolir';
    if (s === 'register') return 'register';
    return null;
}

/**
 * Normalisasi status sebelum INSERT/UPDATE — selalu kembalikan nilai canonical.
 * @param {*} raw
 * @param {string} [fallback='active']
 */
function normalizeCustomerStatusForWrite(raw, fallback = 'active') {
    const canon = canonicalizeStatus(raw);
    if (canon) return canon;
    const fb = canonicalizeStatus(fallback);
    return fb || 'active';
}

function classifyBucket(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (ACTIVE_ALIASES.has(s)) return 'active';
    if (INACTIVE_ALIASES.has(s)) return 'inactive';
    if (ISOLIR_ALIASES.has(s) || s.includes('isolir')) return 'isolir';
    return 'other';
}

module.exports = {
    ACTIVE_ALIASES,
    INACTIVE_ALIASES,
    ISOLIR_ALIASES,
    statusNormSql,
    sqlIsActive,
    sqlIsIsolir,
    sqlIsInactive,
    sqlIsSubscribed,
    sqlStatusInActive,
    sqlStatusInIsolir,
    sqlStatusInInactive,
    canonicalizeStatus,
    normalizeCustomerStatusForWrite,
    classifyBucket
};
