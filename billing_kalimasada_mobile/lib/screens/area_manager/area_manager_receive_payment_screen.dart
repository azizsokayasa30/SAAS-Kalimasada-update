import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';

import '../../services/api_client.dart';

/// Terima pembayaran oleh Manager Area: dicatat atas namanya, tanpa komisi kolektor.
class AreaManagerReceivePaymentScreen extends StatefulWidget {
  const AreaManagerReceivePaymentScreen({
    super.key,
    required this.customerId,
    this.customerSnapshot,
  });

  final int customerId;
  final Map<String, dynamic>? customerSnapshot;

  @override
  State<AreaManagerReceivePaymentScreen> createState() =>
      _AreaManagerReceivePaymentScreenState();
}

class _AreaManagerReceivePaymentScreenState
    extends State<AreaManagerReceivePaymentScreen> {
  static const _primary = Color(0xFF2563EB);
  static const _bg = Color(0xFFF6F7FA);
  static const _border = Color(0xFFE2E8F0);
  static const _textMuted = Color(0xFF64748B);

  final _discount = TextEditingController();
  final _notes = TextEditingController();
  final _picker = ImagePicker();
  final _money = NumberFormat.currency(
    locale: 'id_ID',
    symbol: 'Rp ',
    decimalDigits: 0,
  );

  Map<String, dynamic>? _customer;
  List<Map<String, dynamic>> _invoices = [];
  final Set<int> _selected = {};
  bool _loading = true;
  String? _error;
  String _method = 'cash';
  XFile? _proof;
  bool _submitting = false;
  bool _done = false;

  @override
  void initState() {
    super.initState();
    _customer = widget.customerSnapshot;
    _loadInvoices();
  }

  @override
  void dispose() {
    _discount.dispose();
    _notes.dispose();
    super.dispose();
  }

  int _int(dynamic v) =>
      v is num ? v.round() : (num.tryParse('${v ?? ''}') ?? 0).round();

  int get _gross => _invoices
      .where((inv) => _selected.contains(_int(inv['id'])))
      .fold(0, (sum, inv) => sum + _int(inv['amount']));

  int get _discountValue {
    final d = int.tryParse(_discount.text.replaceAll(RegExp(r'[^0-9]'), ''));
    if (d == null || d < 0) return 0;
    return d > _gross ? _gross : d;
  }

  int get _total => _gross - _discountValue;

  Future<void> _loadInvoices() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final r = await ApiClient.get(
        '/api/mobile-adapter/area-manager/collect/customers/${widget.customerId}/invoices',
      );
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'area-manager/collect/invoices',
      );
      if (!mounted) return;
      if (r.statusCode == 200 && ApiClient.jsonSuccess(body['success'])) {
        final data = Map<String, dynamic>.from(body['data'] as Map);
        final list = (data['invoices'] as List? ?? const [])
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
        setState(() {
          if (data['customer'] is Map) {
            _customer = Map<String, dynamic>.from(data['customer'] as Map);
          }
          _invoices = list;
          _selected
            ..clear()
            ..addAll(list.map((e) => _int(e['id'])).where((id) => id > 0));
        });
      } else {
        setState(
          () => _error = body['message']?.toString() ?? 'Gagal memuat tagihan',
        );
      }
    } catch (e) {
      if (mounted) setState(() => _error = 'Gagal memuat tagihan: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
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
    final x = await _picker.pickImage(
      source: src,
      maxWidth: 1600,
      imageQuality: 85,
    );
    if (x != null && mounted) setState(() => _proof = x);
  }

  Future<bool> _confirm() async {
    final name = _customer?['name']?.toString() ?? 'pelanggan';
    final result = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Simpan pembayaran?'),
        content: Text(
          'Terima ${_money.format(_total)} dari $name '
          '(${_selected.length} tagihan) secara '
          '${_method == 'transfer' ? 'transfer' : (_method == 'cash' ? 'tunai' : 'metode lain')}.\n\n'
          'Pembayaran dicatat atas nama Anda sebagai Manager Area.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Batal'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: _primary),
            child: const Text('Simpan'),
          ),
        ],
      ),
    );
    return result == true;
  }

  Future<void> _submit() async {
    if (_submitting || _done) return;
    final messenger = ScaffoldMessenger.of(context);
    if (_selected.isEmpty) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Pilih minimal satu tagihan.')),
      );
      return;
    }
    if (_total <= 0) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Jumlah pembayaran harus lebih dari 0.')),
      );
      return;
    }
    if (_method == 'transfer' && _proof == null) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Unggah foto bukti transfer.')),
      );
      return;
    }
    if (!await _confirm() || !mounted) return;

    setState(() => _submitting = true);
    try {
      final files = <http.MultipartFile>[];
      if (_method == 'transfer' && _proof != null) {
        final bytes = await _proof!.readAsBytes();
        final name = _proof!.name.contains('.')
            ? _proof!.name
            : 'bukti_transfer.jpg';
        files.add(
          http.MultipartFile.fromBytes('payment_proof', bytes, filename: name),
        );
      }
      final resp = await ApiClient.postMultipart(
        '/api/mobile-adapter/area-manager/collect/payment',
        {
          'customer_id': widget.customerId.toString(),
          'invoice_ids': jsonEncode(_selected.toList()),
          'discount_amount': _discountValue.toString(),
          'payment_method': _method,
          'notes': _notes.text.trim(),
        },
        files: files,
      );
      final body = ApiClient.decodeJsonObject(
        resp,
        debugLabel: 'area-manager/collect/payment',
      );
      if (!mounted) return;
      if (resp.statusCode == 200 && ApiClient.jsonSuccess(body['success'])) {
        _done = true;
        messenger.showSnackBar(
          SnackBar(
            content: Text(
              body['message']?.toString() ?? 'Pembayaran tersimpan',
            ),
          ),
        );
        Navigator.of(context).pop(true);
        return;
      }
      final msg = body['message']?.toString() ?? 'Gagal menyimpan pembayaran';
      messenger.showSnackBar(SnackBar(content: Text(msg)));
      if (resp.statusCode == 409) _loadInvoices();
    } catch (e) {
      if (mounted) {
        messenger.showSnackBar(
          SnackBar(
            content: Text(
              'Gagal mengirim: $e\nRefresh daftar tagihan sebelum mencoba lagi.',
            ),
            duration: const Duration(seconds: 6),
          ),
        );
      }
    } finally {
      if (mounted && !_done) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = _customer ?? const <String, dynamic>{};
    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _primary,
        foregroundColor: Colors.white,
        elevation: 0,
        title: const Text(
          'Terima Pembayaran',
          style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          _card(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  c['name']?.toString() ?? 'Pelanggan',
                  style: const TextStyle(
                    fontWeight: FontWeight.w800,
                    fontSize: 17,
                  ),
                ),
                const SizedBox(height: 4),
                for (final line in [
                  [
                    c['area'],
                    c['package_name'],
                  ].where((v) => '${v ?? ''}'.trim().isNotEmpty).join(' · '),
                  c['phone']?.toString() ?? '',
                  c['address']?.toString() ?? '',
                ])
                  if (line.trim().isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        line,
                        style: const TextStyle(fontSize: 13, color: _textMuted),
                      ),
                    ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            'Tagihan belum lunas',
            style: TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
          ),
          const SizedBox(height: 8),
          ..._invoiceSection(),
          if (_invoices.isNotEmpty) ...[
            const SizedBox(height: 16),
            TextField(
              controller: _discount,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              onChanged: (_) => setState(() {}),
              decoration: _inputDecoration(
                'Diskon (Rp, opsional)',
                helper: 'Tidak boleh melebihi total tagihan terpilih',
              ),
            ),
            const SizedBox(height: 16),
            const Text(
              'Metode pembayaran',
              style: TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
            ),
            const SizedBox(height: 8),
            _card(
              padding: EdgeInsets.zero,
              child: RadioGroup<String>(
                groupValue: _method,
                onChanged: (v) {
                  if (v == null) return;
                  setState(() {
                    _method = v;
                    if (v != 'transfer') _proof = null;
                  });
                },
                child: const Column(
                  children: [
                    RadioListTile<String>(title: Text('Tunai'), value: 'cash'),
                    Divider(height: 1),
                    RadioListTile<String>(
                      title: Text('Transfer bank'),
                      value: 'transfer',
                    ),
                    Divider(height: 1),
                    RadioListTile<String>(
                      title: Text('Lainnya'),
                      value: 'other',
                    ),
                  ],
                ),
              ),
            ),
            if (_method == 'transfer') ...[
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: _pickProof,
                icon: const Icon(Icons.add_a_photo_outlined),
                label: Text(
                  _proof == null
                      ? 'Unggah bukti transfer'
                      : 'Ganti foto: ${_proof!.name}',
                ),
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size.fromHeight(48),
                ),
              ),
            ],
            const SizedBox(height: 16),
            TextField(
              controller: _notes,
              maxLines: 3,
              decoration: _inputDecoration('Catatan (opsional)'),
            ),
            const SizedBox(height: 16),
            _card(
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text(
                    'Jumlah diterima',
                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
                  ),
                  Text(
                    _money.format(_total),
                    style: const TextStyle(
                      fontWeight: FontWeight.w900,
                      fontSize: 18,
                      color: _primary,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'Dicatat sebagai pembayaran langsung atas nama Anda (tanpa komisi kolektor).',
              style: TextStyle(fontSize: 11, color: _textMuted),
            ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _submitting ? null : _submit,
              style: FilledButton.styleFrom(
                backgroundColor: _primary,
                padding: const EdgeInsets.symmetric(vertical: 16),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              child: _submitting
                  ? const SizedBox(
                      height: 22,
                      width: 22,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : const Text(
                      'Simpan pembayaran',
                      style: TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 16,
                      ),
                    ),
            ),
          ],
        ],
      ),
    );
  }

  List<Widget> _invoiceSection() {
    if (_loading) {
      return const [
        Padding(
          padding: EdgeInsets.all(24),
          child: Center(child: CircularProgressIndicator(color: _primary)),
        ),
      ];
    }
    if (_error != null) {
      return [
        _card(
          child: Column(
            children: [
              Text(_error!, textAlign: TextAlign.center),
              TextButton(
                onPressed: _loadInvoices,
                child: const Text('Coba lagi'),
              ),
            ],
          ),
        ),
      ];
    }
    if (_invoices.isEmpty) {
      return [
        _card(
          child: const Text(
            'Tidak ada tagihan yang belum lunas untuk pelanggan ini.',
            style: TextStyle(color: _textMuted),
          ),
        ),
      ];
    }
    return [
      for (final inv in _invoices)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: _invoiceTile(inv),
        ),
      Text(
        'Total terpilih: ${_money.format(_gross)}',
        style: const TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w600,
          color: _textMuted,
        ),
      ),
    ];
  }

  Widget _invoiceTile(Map<String, dynamic> inv) {
    final id = _int(inv['id']);
    final selected = _selected.contains(id);
    final due = DateTime.tryParse('${inv['due_date'] ?? ''}');
    final subtitle = [
      inv['package_name']?.toString() ?? '',
      if (due != null)
        'Jatuh tempo ${DateFormat('d MMM yyyy', 'id_ID').format(due)}',
    ].where((s) => s.isNotEmpty).join(' · ');
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(12),
      child: CheckboxListTile(
        value: selected,
        onChanged: (v) => setState(() {
          if (v == true) {
            _selected.add(id);
          } else {
            _selected.remove(id);
          }
        }),
        controlAffinity: ListTileControlAffinity.leading,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: const BorderSide(color: _border),
        ),
        title: Text(
          inv['invoice_number']?.toString() ?? 'INV-$id',
          style: const TextStyle(fontWeight: FontWeight.w700),
        ),
        subtitle: subtitle.isEmpty
            ? null
            : Text(subtitle, style: const TextStyle(fontSize: 12)),
        secondary: Text(
          _money.format(_int(inv['amount'])),
          style: const TextStyle(fontWeight: FontWeight.w800),
        ),
      ),
    );
  }

  Widget _card({required Widget child, EdgeInsets? padding}) {
    return Container(
      width: double.infinity,
      padding: padding ?? const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _border),
      ),
      child: child,
    );
  }

  InputDecoration _inputDecoration(String label, {String? helper}) {
    return InputDecoration(
      labelText: label,
      helperText: helper,
      filled: true,
      fillColor: Colors.white,
      alignLabelWithHint: true,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
    );
  }
}
