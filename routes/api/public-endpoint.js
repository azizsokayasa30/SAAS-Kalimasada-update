'use strict';

const express = require('express');
const router = express.Router();
const { getPublicEndpointConfig } = require('../../config/public-endpoint');
const tenantStore = require('../../config/platform/tenantStore');

/**
 * GET /api/public/client
 * Tanpa auth — supaya aplikasi Android bisa baca base URL setelah user isi host di konfigurasi,
 * atau setelah resolve DNS ke server Anda.
 */
router.get('/client', (req, res) => {
  try {
    res.json({
      success: true,
      ...getPublicEndpointConfig(),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || 'Config error' });
  }
});

/**
 * GET /api/public/tenants
 * Daftar tenant aktif (subdomain + nama) untuk pemilihan di login mobile — tanpa auth.
 */
router.get('/tenants', async (req, res) => {
  try {
    const rows = await tenantStore.listTenants();
    const data = rows
      .filter((t) => t.status === 'active')
      .map((t) => ({
        subdomain: t.subdomain,
        name: t.name || t.subdomain,
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'id'));
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || 'Gagal memuat daftar tenant' });
  }
});

module.exports = router;
