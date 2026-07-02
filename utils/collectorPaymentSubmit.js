/**
 * Logika submit pembayaran kolektor (dipakai web /collector/api/payment dan mobile-adapter).
 */
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const billingManager = require('../config/billing');
const serviceSuspension = require('../config/serviceSuspension');
const whatsappNotifications = require('../config/whatsapp-notifications');

const uploadDir = path.join(__dirname, '../public/uploads/payments');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination(req, file, cb) {
        cb(null, uploadDir);
    },
    filename(req, file, cb) {
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, `proof-${uniqueSuffix}${ext}`);
    }
});

const collectorPaymentMulter = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter(req, file, cb) {
        const ok =
            !file.mimetype ||
            file.mimetype.startsWith('image/') ||
            file.mimetype === 'application/octet-stream';
        cb(ok ? null : new Error('Bukti transfer harus berupa gambar (JPG/PNG)'), ok);
    }
});

/** Tangani error Multer agar Flutter mendapat JSON, bukan HTML 500. */
function collectorPaymentMulterSingle(fieldName) {
    return (req, res, next) => {
        collectorPaymentMulter.single(fieldName)(req, res, (err) => {
            if (!err) return next();
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({
                    success: false,
                    message: 'Ukuran foto bukti transfer maksimal 5 MB'
                });
            }
            return res.status(400).json({
                success: false,
                message: err.message || 'Gagal mengunggah bukti transfer'
            });
        });
    };
}

async function resolveCollectorInvoiceTargets(billingManager, collectorId, parsedInvoiceIds) {
    if (!parsedInvoiceIds.length) {
        return { ok: true, targets: [], allAlreadyRecorded: false, existingPaymentIds: [] };
    }
    const targets = [];
    const existingPaymentIds = [];
    for (const invoiceId of parsedInvoiceIds) {
        const inv = await billingManager.getInvoiceById(invoiceId);
        if (!inv) {
            return { ok: false, status: 400, message: `Tagihan #${invoiceId} tidak ditemukan` };
        }
        const isPaid = String(inv.status || '').toLowerCase() === 'paid';
        if (isPaid) {
            const existing = await billingManager.getCollectorPaymentForInvoice(invoiceId, collectorId);
            if (existing) {
                targets.push({ invoiceId, inv, skip: true, existingPaymentId: existing.id });
                existingPaymentIds.push(existing.id);
                continue;
            }
            const label = inv.invoice_number ? String(inv.invoice_number) : `#${invoiceId}`;
            return {
                ok: false,
                status: 409,
                message: `Tagihan ${label} sudah lunas. Jangan kirim ulang — refresh daftar tagihan.`
            };
        }
        targets.push({ invoiceId, inv, skip: false });
    }
    const allAlreadyRecorded = targets.length > 0 && targets.every((t) => t.skip);
    return { ok: true, targets, allAlreadyRecorded, existingPaymentIds };
}

function parseInvoiceIds(invoice_ids) {
    let parsed = [];
    if (Array.isArray(invoice_ids)) {
        parsed = invoice_ids;
    } else if (typeof invoice_ids === 'string') {
        const trimmed = invoice_ids.trim();
        if (trimmed) {
            try {
                parsed = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split(',');
            } catch (_) {
                parsed = trimmed.split(',');
            }
        }
    }
    return parsed.map((v) => Number(String(v).trim())).filter((v) => !Number.isNaN(v));
}

/**
 * @param {object} opts
 * @param {number} opts.collectorId
 * @param {string|number} opts.customer_id
 * @param {number|string} opts.payment_amount
 * @param {string} [opts.payment_method]
 * @param {string} [opts.notes]
 * @param {string[]|string|undefined} [opts.invoice_ids]
 * @param {number|string} [opts.discount_amount] total diskon (Rp), 0 jika tidak ada
 * @param {string|null} [opts.paymentProofRelativePath] e.g. '/uploads/payments/proof-....jpg'
 * @returns {Promise<{ ok: true, payment_id: number, commission_amount: number } | { ok: false, status: number, message: string }>}
 */
async function submitCollectorPayment(opts) {
    const {
        collectorId,
        customer_id,
        payment_amount,
        payment_method = '',
        notes = '',
        invoice_ids: rawInvoiceIds,
        paymentProofRelativePath = null,
        discount_amount: rawDiscount = 0
    } = opts;

    const paymentAmountNum = Number(payment_amount);
    const parsedInvoiceIds = parseInvoiceIds(rawInvoiceIds);
    const discountTotal = Math.max(0, Math.round(Number(rawDiscount) || 0));

    if (!customer_id || !paymentAmountNum) {
        return { ok: false, status: 400, message: 'Customer ID dan jumlah pembayaran harus diisi' };
    }
    if (paymentAmountNum <= 0) {
        return { ok: false, status: 400, message: 'Jumlah pembayaran harus lebih dari 0' };
    }
    if (paymentAmountNum > 999999999) {
        return { ok: false, status: 400, message: 'Jumlah pembayaran terlalu besar (maksimal 999,999,999)' };
    }
    if (discountTotal > 999999999) {
        return { ok: false, status: 400, message: 'Diskon terlalu besar' };
    }
    if (parsedInvoiceIds.length === 0) {
        return { ok: false, status: 400, message: 'Pilih minimal satu tagihan yang akan dibayar.' };
    }

    const collector = await billingManager.getCollectorById(collectorId);
    if (!collector) {
        return { ok: false, status: 400, message: 'Collector not found' };
    }

    const commissionRate =
        collector.commission_rate !== null && collector.commission_rate !== undefined
            ? collector.commission_rate
            : 5;
    if (commissionRate < 0 || commissionRate > 100) {
        return { ok: false, status: 400, message: 'Rate komisi tidak valid (harus antara 0-100%)' };
    }

    const commissionAmount = Math.round((paymentAmountNum * commissionRate) / 100);

    const isTransfer = billingManager.isCollectorTransferPaymentMethod(payment_method);
    if (isTransfer && !paymentProofRelativePath) {
        return { ok: false, status: 400, message: 'Foto bukti transfer wajib diunggah' };
    }

    await billingManager._ensurePaymentsProofColumn();

    const invoiceTargets = await resolveCollectorInvoiceTargets(
        billingManager,
        collectorId,
        parsedInvoiceIds
    );
    if (!invoiceTargets.ok) {
        return invoiceTargets;
    }
    if (invoiceTargets.allAlreadyRecorded) {
        const firstExisting = invoiceTargets.existingPaymentIds[0] || null;
        return {
            ok: true,
            payment_id: firstExisting,
            commission_amount: commissionAmount,
            already_recorded: true,
            message: 'Pembayaran sudah tercatat sebelumnya (tidak diduplikasi).'
        };
    }

    if (parsedInvoiceIds.length > 0) {
        let grossSum = 0;
        for (const target of invoiceTargets.targets) {
            if (target.skip) continue;
            grossSum += parseFloat(target.inv?.amount || 0) || 0;
        }
        grossSum = Math.round(grossSum);
        if (discountTotal > grossSum) {
            return { ok: false, status: 400, message: 'Diskon tidak boleh melebihi total tagihan terpilih' };
        }
        const expectedNet = grossSum - discountTotal;
        if (Math.abs(paymentAmountNum - expectedNet) > 1) {
            return {
                ok: false,
                status: 400,
                message: 'Jumlah pembayaran tidak sesuai total tagihan setelah diskon'
            };
        }
    }

    let lastPaymentId = null;
    let proofAttached = false;
    const baseNotes = notes && String(notes).trim() ? String(notes).trim() : '';
    const discountNote =
        discountTotal > 0 ? `Diskon: Rp ${discountTotal.toLocaleString('id-ID')}` : '';
    const mergeLineNotes = (includeDiscount) => {
        const parts = [baseNotes, includeDiscount && discountNote ? discountNote : ''].filter(Boolean);
        return parts.join(' | ');
    };

    let isFirst = true;
    for (const target of invoiceTargets.targets) {
        const invoiceId = target.invoiceId;
        if (target.skip) {
            lastPaymentId = target.existingPaymentId || lastPaymentId;
            isFirst = false;
            continue;
        }
        const inv = target.inv;
        const invAmount = parseFloat(inv?.amount || 0) || 0;
        const dup = await billingManager.getCollectorPaymentForInvoice(invoiceId, collectorId);
        if (dup) {
            lastPaymentId = dup.id || lastPaymentId;
            isFirst = false;
            continue;
        }
        await billingManager.updateInvoiceStatus(invoiceId, 'paid', payment_method);
        const newPayment = await billingManager.recordCollectorPayment({
            invoice_id: invoiceId,
            amount: invAmount,
            payment_method,
            reference_number: '',
            notes: mergeLineNotes(isFirst),
            collector_id: collectorId,
            commission_amount: Math.round((invAmount * commissionRate) / 100),
            discount_amount: isFirst ? discountTotal : 0
        });
        lastPaymentId = newPayment?.id || lastPaymentId;
        if (newPayment?.id) {
            if (isTransfer && paymentProofRelativePath && !proofAttached) {
                await billingManager.updatePaymentProof(newPayment.id, paymentProofRelativePath);
                proofAttached = true;
            }
            if (isTransfer) {
                await billingManager.markCollectorPaymentAsOfficeTransferReceived(newPayment.id);
            }
        }
        isFirst = false;
    }

    // Notifikasi jangan await — blokir respons HTTP (Flutter / fetch) padahal DB sudah selesai.
    if (lastPaymentId) {
        setImmediate(() => {
            (async () => {
                try {
                    await whatsappNotifications.sendPaymentReceivedNotification(lastPaymentId);
                } catch (notificationError) {
                    console.error('Error sending payment WhatsApp (background):', notificationError);
                }
                try {
                    const emailNotifications = require('../config/email-notifications');
                    await emailNotifications.sendPaymentReceivedNotification(lastPaymentId);
                } catch (notificationError) {
                    console.error('Error sending payment email (background):', notificationError);
                }
            })();
        });
    }

    // Buka isolir di latar belakang — jangan await restore (Mikrotik/RADIUS) agar respons HTTP cepat untuk Flutter.
    // Status billing di-set aktif dulu agar refresh daftar konsisten; jaringan menyusul di restore.
    try {
        const customerIdNum = Number(customer_id);
        const allInvoices = await billingManager.getInvoicesByCustomer(customerIdNum);
        const unpaid = (allInvoices || []).filter((i) => i.status === 'unpaid');
        if (unpaid.length === 0) {
            const customer = await billingManager.getCustomerById(customerIdNum);
            const { shouldAutoRestoreCustomer } = require('./customerSuspendReason');
            if (shouldAutoRestoreCustomer(customer)) {
                try {
                    await billingManager.setCustomerStatusById(customerIdNum, 'active', { skipRadiusSync: true });
                } catch (e) {
                    console.error('Collector payment: set active after pay failed:', e);
                }
                setImmediate(() => {
                    billingManager
                        .getCustomerById(customerIdNum)
                        .then((fresh) => {
                            if (!fresh) return null;
                            return serviceSuspension.restoreCustomerService(
                                fresh,
                                'Pembayaran kolektor — tagihan lunas, layanan dipulihkan'
                            );
                        })
                        .catch((restoreErr) => {
                            console.error('Collector payment: restore after pay failed:', restoreErr);
                        });
                });
            }
        }
    } catch (restorePrepErr) {
        console.error('Collector payment: restore prep failed:', restorePrepErr);
    }

    if (!lastPaymentId) {
        return {
            ok: false,
            status: 400,
            message: 'Tidak ada tagihan yang dapat dibayar. Refresh daftar tagihan.'
        };
    }

    const paymentId = await billingManager.recordCollectorPaymentRecord({
        collector_id: collectorId,
        customer_id,
        amount: paymentAmountNum,
        payment_amount: paymentAmountNum,
        commission_amount: commissionAmount,
        payment_method,
        notes,
        status: 'completed'
    });

    return { ok: true, payment_id: paymentId?.id || lastPaymentId, commission_amount: commissionAmount };
}

module.exports = {
    submitCollectorPayment,
    collectorPaymentMulter,
    collectorPaymentMulterSingle,
    uploadDir
};
