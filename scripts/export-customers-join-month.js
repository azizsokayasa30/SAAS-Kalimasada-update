#!/usr/bin/env node
/**
 * Export pelanggan XLSX filter join_date per bulan.
 * Usage: node scripts/export-customers-join-month.js [month] [year] [outputPath]
 * Example: node scripts/export-customers-join-month.js 5 2026
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const billingManager = require('../config/billing');

const month = parseInt(process.argv[2] || '5', 10);
const year = parseInt(process.argv[3] || '2026', 10);
const outArg = process.argv[4];

const monthNames = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

function formatDate(val) {
    if (val == null || val === '') return '';
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return String(val);
    return d.toLocaleDateString('id-ID');
}

const COLUMNS = [
    { header: 'ID DB', key: 'id', width: 8 },
    { header: 'Kode Pelanggan', key: 'customer_id', width: 16 },
    { header: 'Username', key: 'username', width: 16 },
    { header: 'Nama', key: 'name', width: 28 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Area', key: 'area', width: 18 },
    { header: 'Kolektor', key: 'collector_name', width: 20 },
    { header: 'Paket', key: 'package_name', width: 22 },
    { header: 'Harga Paket', key: 'package_price', width: 14 },
    { header: 'Status Layanan', key: 'status', width: 14 },
    { header: 'Status Bayar', key: 'payment_status', width: 14 },
    { header: 'PPPoE Username', key: 'pppoe_username', width: 20 },
    { header: 'PPPoE Profile', key: 'pppoe_profile', width: 16 },
    { header: 'Router', key: 'router_name', width: 16 },
    { header: 'Email', key: 'email', width: 24 },
    { header: 'Alamat', key: 'address', width: 36 },
    { header: 'Latitude', key: 'latitude', width: 12 },
    { header: 'Longitude', key: 'longitude', width: 12 },
    { header: 'Package ID', key: 'package_id', width: 10 },
    { header: 'Billing Day', key: 'billing_day', width: 12 },
    { header: 'Join Date', key: 'join_date', width: 14 }
];

(async () => {
    const customers = await billingManager.getCustomers({ joinMonth: month, joinYear: year });
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Pelanggan');
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.columns = COLUMNS.map((c) => ({ ...c }));
    ws.getRow(1).font = { bold: true };

    for (const c of customers) {
        ws.addRow({
            id: c.id || '',
            customer_id: c.customer_id || '',
            username: c.username || '',
            name: c.name || '',
            phone: c.phone || '',
            area: c.area || '',
            collector_name: c.collector_name || '',
            package_name: c.package_name || '',
            package_price: c.package_price != null ? Number(c.package_price) : '',
            status: c.status || '',
            payment_status: c.payment_status || '',
            pppoe_username: c.pppoe_username || '',
            pppoe_profile: c.pppoe_profile || '',
            router_name: c.router_name || '',
            email: c.email || '',
            address: c.address || '',
            latitude: c.latitude || '',
            longitude: c.longitude || '',
            package_id: c.package_id || '',
            billing_day: c.billing_day || '',
            join_date: formatDate(c.join_date)
        });
    }

    const summary = workbook.addWorksheet('Summary');
    summary.addRow(['Filter Join Date', `${monthNames[month] || month} ${year}`]);
    summary.addRow(['Total Pelanggan', customers.length]);
    summary.addRow(['Tanggal Export', new Date().toLocaleString('id-ID')]);

    const defaultName = `export-pelanggan-join-${String(month).padStart(2, '0')}-${year}.xlsx`;
    const outPath = outArg
        ? path.resolve(outArg)
        : path.join(__dirname, '../tmp', defaultName);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await workbook.xlsx.writeFile(outPath);
    console.log(`Export selesai: ${outPath}`);
    console.log(`Total: ${customers.length} pelanggan (join ${monthNames[month] || month} ${year})`);
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
