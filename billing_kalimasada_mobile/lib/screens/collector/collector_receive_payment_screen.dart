import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../services/api_client.dart';
import '../../store/collector_provider.dart';
import '../../theme/collector_colors.dart';

String _rupiah(num? v) {
  final n = (v ?? 0).round();
  return 'Rp ${NumberFormat.decimalPattern('id_ID').format(n)}';
}

num? _coerceNum(dynamic v) {
  if (v == null) return null;
  if (v is num) return v;
  if (v is String) return num.tryParse(v);
  return num.tryParse(v.toString());
}

int _parseNonNegativeInt(String raw) {
  final d = raw.replaceAll(RegExp(r'[^0-9]'), '');
  if (d.isEmpty) return 0;
  return int.tryParse(d) ?? 0;
}

/// Terima pembayaran — setara `/collector/payment?customer_id=…` dengan tema Field Collector.
class CollectorReceivePaymentScreen extends StatefulWidget {
  const CollectorReceivePaymentScreen({
    super.key,
    required this.customerId,
    this.customerSnapshot,
  });

  final int customerId;
  final Map<String, dynamic>? customerSnapshot;

  @override
  State<CollectorReceivePaymentScreen> createState() => _CollectorReceivePaymentScreenState();
}

class _CollectorReceivePaymentScreenState extends State<CollectorReceivePaymentScreen> {
  final _discount = TextEditingController();
  final _manualGross = TextEditingController();
  final _notes = TextEditingController();
  final _picker = ImagePicker();

  List<Map<String, dynamic>> _invoices = [];
  final Set<int> _selectedIds = {};
  bool _loadingInvoices = true;
  String? _invoiceError;
  String _method = 'cash';
  XFile? _proof;
  bool _submitting = false;
  bool _paymentSucceeded = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final col = context.read<CollectorProvider>();
      if (col.me == null) col.fetchMe();
      _loadInvoices();
    });
  }

  @override
  void dispose() {
    _discount.dispose();
    _manualGross.dispose();
    _notes.dispose();
    super.dispose();
  }

  num _grossFromSelectedInvoices() {
    num sum = 0;
    for (final inv in _invoices) {
      final id = _coerceNum(inv['id'])?.toInt();
      if (id == null || !_selectedIds.contains(id)) continue;
      sum += _coerceNum(inv['amount']) ?? 0;
    }
    return sum;
  }

  /// Total sebelum diskon: tagihan terpilih, atau input manual bila tidak ada daftar tagihan.
  num _grossBeforeDiscount() {
    if (_invoices.isNotEmpty) return _grossFromSelectedInvoices();
    return _parseNonNegativeInt(_manualGross.text);
  }

  int _discountParsedClamped() {
    final gross = _grossBeforeDiscount().round();
    final d = _parseNonNegativeInt(_discount.text);
    return d > gross ? gross : d;
  }

  int _finalPaymentAmount() {
    final g = _grossBeforeDiscount().round();
    final d = _discountParsedClamped();
    final n = g - d;
    return n < 0 ? 0 : n;
  }

  Future<void> _loadInvoices() async {
    setState(() {
      _loadingInvoices = true;
      _invoiceError = null;
    });
    try {
      final r = await ApiClient.get(
        '/api/mobile-adapter/collector/customer-invoices/${widget.customerId}',
      );
      final body = ApiClient.decodeJsonObject(r, debugLabel: 'collector/invoices');
      if (r.statusCode == 200 && body['success'] == true) {
        final raw = body['data'];
        final list = <Map<String, dynamic>>[];
        if (raw is List) {
          for (final e in raw) {
            if (e is Map) list.add(Map<String, dynamic>.from(e));
          }
        }
        _selectedIds
          ..clear()
          ..addAll(list.map((m) => _coerceNum(m['id'])?.toInt()).whereType<int>());
        _invoices = list;
        _clampDiscountToGross();
      } else {
        _invoiceError = body['message']?.toString() ?? 'Gagal memuat tagihan';
        _invoices = [];
      }
    } catch (e) {
      _invoiceError = e.toString();
      _invoices = [];
    } finally {
      if (mounted) setState(() => _loadingInvoices = false);
    }
  }

  void _clampDiscountToGross() {
    final gross = _grossBeforeDiscount().round();
    final d = _parseNonNegativeInt(_discount.text);
    if (d > gross) {
      _discount.text = gross > 0 ? gross.toString() : '';
    }
  }

  double _commissionRateFromMe(Map<String, dynamic>? me) {
    final r = _coerceNum(me?['commission_rate']);
    if (r == null) return 5;
    final d = r.toDouble();
    if (d < 0 || d > 100) return 5;
    return d;
  }

  num _commissionPreview(double ratePct) {
    final amt = _finalPaymentAmount();
    return (amt * ratePct) / 100;
  }

  Future<void> _pickProof() async {
    final src = await showModalBottomSheet<ImageSource>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_camera),
              title: const Text('Kamera'),
              onTap: () => Navigator.pop(ctx, ImageSource.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Galeri'),
              onTap: () => Navigator.pop(ctx, ImageSource.gallery),
            ),
          ],
        ),
      ),
    );
    if (src == null) return;
    final x = await _picker.pickImage(source: src, maxWidth: 1600, imageQuality: 85);
    if (x != null && mounted) setState(() => _proof = x);
  }

  Future<void> _submit() async {
    if (_paymentSucceeded || _submitting) return;
    if (_invoices.isNotEmpty && _selectedIds.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Pilih minimal satu tagihan, atau gunakan mode setoran manual jika tidak ada tagihan.')),
      );
      return;
    }
    final finalAmt = _finalPaymentAmount();
    if (finalAmt <= 0) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Jumlah pembayaran harus lebih dari 0 (periksa tagihan / nominal / diskon).')),
      );
      return;
    }
    if (_method == 'transfer' && _proof == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Unggah bukti transfer.')),
      );
      return;
    }

    setState(() => _submitting = true);
    try {
      final idsJson = jsonEncode(_selectedIds.map((e) => e.toString()).toList());
      final disc = _discountParsedClamped();
      final fields = <String, String>{
        'customer_id': widget.customerId.toString(),
        'payment_amount': finalAmt.toString(),
        'discount_amount': disc.toString(),
        'payment_method': _method,
        'notes': _notes.text.trim(),
        'invoice_ids': idsJson,
      };
      final files = <http.MultipartFile>[];
      if (_method == 'transfer' && _proof != null) {
        final p = _proof!;
        final bytes = await p.readAsBytes();
        var fname = p.name.trim();
        if (fname.isEmpty) {
          fname = 'bukti_transfer.jpg';
        } else if (!fname.contains('.')) {
          fname = '$fname.jpg';
        }
        files.add(http.MultipartFile.fromBytes('payment_proof', bytes, filename: fname));
      }
      final resp = await ApiClient.postMultipart(
        '/api/mobile-adapter/collector/payment',
        fields,
        files: files,
      );
      final body = ApiClient.decodeJsonObject(resp, debugLabel: 'collector/payment');
      if (!mounted) return;
      if (resp.statusCode == 200 && body['success'] == true) {
        _paymentSucceeded = true;
        context.read<CollectorProvider>().bumpCustomersReload();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(body['message']?.toString() ?? 'Pembayaran tersimpan')),
        );
        final paidIds = <int>[];
        final rawIds = body['paid_invoice_ids'];
        if (rawIds is List) {
          for (final v in rawIds) {
            final id = int.tryParse(v.toString());
            if (id != null && id > 0) paidIds.add(id);
          }
        }
        if (paidIds.isEmpty) {
          paidIds.addAll(_selectedIds);
        }
        Navigator.of(context).pop(<String, dynamic>{
          'success': true,
          'paid_invoice_ids': paidIds,
        });
        return;
      }
      final errMsg = body['message']?.toString() ?? 'Gagal menyimpan';
      final isDuplicate = resp.statusCode == 409 ||
          errMsg.toLowerCase().contains('sudah lunas') ||
          errMsg.toLowerCase().contains('tidak diduplikasi');
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            isDuplicate
                ? '$errMsg\nTutup layar ini dan refresh daftar — jangan kirim ulang.'
                : errMsg,
          ),
          duration: Duration(seconds: isDuplicate ? 6 : 4),
        ),
      );
      if (isDuplicate) {
        context.read<CollectorProvider>().bumpCustomersReload();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              'Gagal mengirim: $e\nJika ragu, refresh daftar tagihan sebelum mencoba lagi.',
            ),
            duration: const Duration(seconds: 6),
          ),
        );
      }
    } finally {
      if (mounted && !_paymentSucceeded) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final me = context.watch<CollectorProvider>().me;
    final ratePct = _commissionRateFromMe(me);
    final snap = widget.customerSnapshot;
    final name = snap?['name']?.toString() ?? 'Pelanggan';
    final phone = snap?['phone']?.toString() ?? '';
    final addr = snap?['address']?.toString() ?? '';
    const bg = FieldCollectorColors.background;
    final finalPay = _finalPaymentAmount();

    // Rute push tidak mewarisi Theme dari _CollectorTabs — hanya MaterialApp (dark).
    // Tanpa Theme.light di sini, onSurface putih sehingga teks hilang di kartu/field putih.
    return Theme(
      data: ThemeData(
        useMaterial3: true,
        brightness: Brightness.light,
        scaffoldBackgroundColor: bg,
        colorScheme: ColorScheme.fromSeed(
          seedColor: FieldCollectorColors.primaryContainer,
          brightness: Brightness.light,
        ).copyWith(
          surface: Colors.white,
          onSurface: FieldCollectorColors.onSurface,
          onSurfaceVariant: FieldCollectorColors.onSurfaceVariant,
        ),
        appBarTheme: const AppBarTheme(
          backgroundColor: Colors.white,
          foregroundColor: FieldCollectorColors.primaryContainer,
          surfaceTintColor: Colors.transparent,
          elevation: 0,
          titleTextStyle: TextStyle(
            color: FieldCollectorColors.primaryContainer,
            fontWeight: FontWeight.w800,
            fontSize: 18,
          ),
          iconTheme: IconThemeData(color: FieldCollectorColors.primaryContainer),
        ),
      ),
      child: Scaffold(
        backgroundColor: bg,
        appBar: AppBar(
          title: const Text('Terima pembayaran'),
          bottom: const PreferredSize(preferredSize: Size.fromHeight(1), child: Divider(height: 1)),
        ),
        body: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
          children: [
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: FieldCollectorColors.outlineVariant),
              boxShadow: const [BoxShadow(color: Color(0x0A000000), blurRadius: 6, offset: Offset(0, 2))],
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
                const SizedBox(height: 6),
                Text('ID: ${widget.customerId}', style: const TextStyle(fontSize: 12, color: FieldCollectorColors.onSurfaceVariant)),
                if (phone.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(phone, style: const TextStyle(fontSize: 13, color: FieldCollectorColors.onSurfaceVariant)),
                ],
                if (addr.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Icon(Icons.location_on_outlined, size: 16, color: FieldCollectorColors.onSurfaceVariant),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(addr, style: const TextStyle(fontSize: 13, color: FieldCollectorColors.onSurfaceVariant, height: 1.35)),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 16),
          const Text('Tagihan belum lunas', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
          const SizedBox(height: 8),
          if (_loadingInvoices)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: CircularProgressIndicator(color: FieldCollectorColors.primaryContainer)),
            )
          else if (_invoiceError != null)
            Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                children: [
                  Text(_invoiceError!, textAlign: TextAlign.center),
                  TextButton(onPressed: _loadInvoices, child: const Text('Coba lagi')),
                ],
              ),
            )
          else if (_invoices.isEmpty)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: FieldCollectorColors.outlineVariant),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Tidak ada tagihan unpaid. Anda bisa mencatat setoran manual: isi nominal di bawah, lalu simpan.',
                    style: TextStyle(fontSize: 13, color: FieldCollectorColors.onSurfaceVariant, height: 1.35),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _manualGross,
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    decoration: InputDecoration(
                      labelText: 'Nominal sebelum diskon (Rp)',
                      filled: true,
                      fillColor: Colors.white,
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                    onChanged: (_) {
                      _clampDiscountToGross();
                      setState(() {});
                    },
                  ),
                ],
              ),
            )
          else
            ..._invoices.map((inv) {
              final id = _coerceNum(inv['id'])?.toInt() ?? 0;
              final invNo = inv['invoice_number']?.toString() ?? 'INV-$id';
              final pkg = inv['package_name']?.toString() ?? '—';
              final amount = _coerceNum(inv['amount'])?.round() ?? 0;
              final sel = _selectedIds.contains(id);
              return Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Material(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(12),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: () {
                      setState(() {
                        if (sel) {
                          _selectedIds.remove(id);
                        } else {
                          _selectedIds.add(id);
                        }
                        _clampDiscountToGross();
                      });
                    },
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      child: Row(
                        children: [
                          Checkbox(
                            value: sel,
                            activeColor: FieldCollectorColors.primaryContainer,
                            onChanged: (v) {
                              setState(() {
                                if (v == true) {
                                  _selectedIds.add(id);
                                } else {
                                  _selectedIds.remove(id);
                                }
                                _clampDiscountToGross();
                              });
                            },
                          ),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(invNo, style: const TextStyle(fontWeight: FontWeight.w700)),
                                Text(pkg, style: const TextStyle(fontSize: 12, color: FieldCollectorColors.onSurfaceVariant)),
                              ],
                            ),
                          ),
                          Text(_rupiah(amount), style: const TextStyle(fontWeight: FontWeight.w800)),
                        ],
                      ),
                    ),
                  ),
                ),
              );
            }),
          const SizedBox(height: 20),
          if (_invoices.isNotEmpty) ...[
            Text(
              'Total terpilih: ${_rupiah(_grossFromSelectedInvoices())}',
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: FieldCollectorColors.onSurfaceVariant),
            ),
            const SizedBox(height: 8),
          ],
          TextField(
            controller: _discount,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: InputDecoration(
              labelText: 'Diskon (Rp)',
              hintText: '0',
              helperText: 'Jumlah pembayaran = total tagihan terpilih (atau nominal manual) − diskon',
              filled: true,
              fillColor: Colors.white,
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
            ),
            onChanged: (_) {
              _clampDiscountToGross();
              setState(() {});
            },
          ),
          const SizedBox(height: 8),
          const Text('Metode pembayaran', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
          const Padding(
            padding: EdgeInsets.only(top: 4, bottom: 4),
            child: Text(
              'Tunai wajib disetor ke kasir. Transfer langsung ke kantor (tidak masuk setoran).',
              style: TextStyle(fontSize: 11, color: FieldCollectorColors.onSurfaceVariant),
            ),
          ),
          Container(
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: FieldCollectorColors.outlineVariant),
            ),
            child: Column(
              children: [
                RadioListTile<String>(
                  title: const Text('Tunai'),
                  value: 'cash',
                  groupValue: _method,
                  activeColor: FieldCollectorColors.primaryContainer,
                  onChanged: (v) {
                    if (v == null) return;
                    setState(() {
                      _method = v;
                      _proof = null;
                    });
                  },
                ),
                const Divider(height: 1),
                RadioListTile<String>(
                  title: const Text('Transfer bank'),
                  value: 'transfer',
                  groupValue: _method,
                  activeColor: FieldCollectorColors.primaryContainer,
                  onChanged: (v) {
                    if (v == null) return;
                    setState(() => _method = v);
                  },
                ),
                const Divider(height: 1),
                RadioListTile<String>(
                  title: const Text('Lainnya'),
                  value: 'other',
                  groupValue: _method,
                  activeColor: FieldCollectorColors.primaryContainer,
                  onChanged: (v) {
                    if (v == null) return;
                    setState(() {
                      _method = v;
                      _proof = null;
                    });
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: FieldCollectorColors.outlineVariant),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('Jumlah pembayaran', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                Text(
                  _rupiah(finalPay),
                  style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 17, color: FieldCollectorColors.primaryContainer),
                ),
              ],
            ),
          ),
          if (_method == 'transfer') ...[
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: _pickProof,
              icon: const Icon(Icons.add_a_photo_outlined),
              label: Text(_proof == null ? 'Unggah bukti transfer' : 'Ganti foto: ${_proof!.name}'),
              style: OutlinedButton.styleFrom(
                foregroundColor: FieldCollectorColors.primaryContainer,
                side: const BorderSide(color: FieldCollectorColors.outlineVariant),
                minimumSize: const Size.fromHeight(48),
              ),
            ),
          ],
          const SizedBox(height: 16),
          TextField(
            controller: _notes,
            maxLines: 3,
            decoration: InputDecoration(
              labelText: 'Catatan (opsional)',
              filled: true,
              fillColor: Colors.white,
              alignLabelWithHint: true,
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
            ),
          ),
          const SizedBox(height: 16),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: const Color(0xFFFFF8E6),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFFFE082)),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('Estimasi komisi Anda', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                Text(
                  _rupiah(_commissionPreview(ratePct).round()),
                  style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: Color(0xFF856404)),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _submitting ? null : _submit,
            style: FilledButton.styleFrom(
              backgroundColor: FieldCollectorColors.primaryContainer,
              foregroundColor: Colors.white,
              padding: const EdgeInsets.symmetric(vertical: 16),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            child: _submitting
                ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Simpan pembayaran', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
          ),
        ],
      ),
      ),
    );
  }
}
