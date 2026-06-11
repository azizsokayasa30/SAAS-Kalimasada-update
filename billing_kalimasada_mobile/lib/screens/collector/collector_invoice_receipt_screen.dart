import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:intl/intl.dart';
import '../../services/api_client.dart';
import '../../services/whatsapp_receipt_share.dart';
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

String _fmtIdDate(String? raw) {
  if (raw == null || raw.trim().isEmpty) return '—';
  final s = raw.trim();
  final d = DateTime.tryParse(s.length >= 10 ? s.substring(0, 10) : s);
  if (d == null) {
    if (s.length >= 10) return s.substring(0, 10);
    return s;
  }
  return DateFormat.yMMMd('id_ID').format(d);
}

String _methodLabel(String? m) {
  switch ((m ?? '').toLowerCase()) {
    case 'cash':
      return 'Tunai';
    case 'transfer':
      return 'Transfer bank';
    default:
      return m == null || m.isEmpty ? '—' : m;
  }
}

/// Resi / bukti invoice — isi setara halaman cetak admin, tema Field Collector (teks gelap).
class CollectorInvoiceReceiptScreen extends StatefulWidget {
  const CollectorInvoiceReceiptScreen({
    super.key,
    required this.customerId,
    this.invoiceId,
  });

  final int customerId;
  final int? invoiceId;

  @override
  State<CollectorInvoiceReceiptScreen> createState() => _CollectorInvoiceReceiptScreenState();
}

class _CollectorInvoiceReceiptScreenState extends State<CollectorInvoiceReceiptScreen> {
  bool _loading = true;
  bool _sendingWa = false;
  String? _error;
  Map<String, dynamic>? _invoice;
  Map<String, dynamic>? _settings;
  final GlobalKey _receiptCaptureKey = GlobalKey();
  final ScrollController _scrollController = ScrollController();
  bool _logoPrecached = false;
  Uint8List? _logoBytes;

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _fetch());
  }

  Future<void> _fetch() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      var path = '/api/mobile-adapter/collector/customers/${widget.customerId}/receipt';
      if (widget.invoiceId != null) {
        path += '?invoice_id=${widget.invoiceId}';
      }
      final r = await ApiClient.get(path);
      final body = ApiClient.decodeJsonObject(r, debugLabel: 'collector/receipt');
      if (r.statusCode == 200 && body['success'] == true && body['data'] is Map) {
        final d = Map<String, dynamic>.from(body['data'] as Map);
        final inv = d['invoice'];
        final st = d['settings'];
        if (mounted) {
          setState(() {
            _invoice = inv is Map ? Map<String, dynamic>.from(inv) : null;
            _settings = st is Map ? Map<String, dynamic>.from(st) : null;
            _loading = false;
            _logoPrecached = false;
            _logoBytes = null;
          });
          WidgetsBinding.instance.addPostFrameCallback((_) => _precacheLogo());
        }
      } else {
        if (mounted) {
          setState(() {
            _error = body['message']?.toString() ?? 'Gagal memuat resi';
            _loading = false;
          });
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  Future<void> _precacheLogo() async {
    if (_logoPrecached || _settings == null) return;
    final logoName = _settings!['logoFilename']?.toString().trim();
    final name = logoName != null && logoName.isNotEmpty ? logoName : 'logo.png';
    final logoUri = Uri.parse(ApiClient.apiOrigin).replace(path: '/img/$name');
    try {
      final res = await http.get(logoUri).timeout(const Duration(seconds: 20));
      if (res.statusCode == 200 && res.bodyBytes.isNotEmpty) {
        _logoBytes = res.bodyBytes;
        if (mounted) {
          setState(() => _logoPrecached = true);
        } else {
          _logoPrecached = true;
        }
        return;
      }
    } catch (_) {}
    try {
      await precacheImage(NetworkImage(logoUri.toString()), context);
    } catch (_) {}
    _logoPrecached = true;
  }

  Widget _logoWidget({double height = 40}) {
    final bytes = _logoBytes;
    if (bytes != null && bytes.isNotEmpty) {
      return Image.memory(bytes, height: height, fit: BoxFit.contain, gaplessPlayback: true);
    }
    return Icon(Icons.business, size: height, color: FieldCollectorColors.primaryContainer);
  }

  Future<void> _waitForReceiptCaptureReady() async {
    await _precacheLogo();
    for (var attempt = 0; attempt < 16; attempt++) {
      await WidgetsBinding.instance.endOfFrame;
      if (SchedulerBinding.instance.schedulerPhase != SchedulerPhase.idle) {
        await Future<void>.delayed(const Duration(milliseconds: 40));
      }
      if (!mounted) return;
      final boundary = _receiptCaptureKey.currentContext?.findRenderObject() as RenderRepaintBoundary?;
      if (boundary != null &&
          boundary.attached &&
          boundary.size.width > 0 &&
          boundary.size.height > 0 &&
          !boundary.debugNeedsPaint) {
        await Future<void>.delayed(const Duration(milliseconds: 80));
        return;
      }
      await Future<void>.delayed(const Duration(milliseconds: 60));
    }
  }

  Future<Uint8List> _captureReceiptPng() async {
    await _waitForReceiptCaptureReady();

    final boundary = _receiptCaptureKey.currentContext?.findRenderObject() as RenderRepaintBoundary?;
    if (boundary == null || !boundary.attached || boundary.size.width <= 0 || boundary.size.height <= 0) {
      throw Exception('Tampilan resi belum siap');
    }

    const maxTextureSide = 8192.0;
    final logicalW = boundary.size.width;
    final logicalH = boundary.size.height;
    final maxLogical = math.max(logicalW, logicalH);
    var preferredRatio = 2.0;
    if (maxLogical * preferredRatio > maxTextureSide) {
      preferredRatio = (maxTextureSide / maxLogical).clamp(1.0, 2.0);
    }

    final ratios = <double>{
      preferredRatio,
      if (preferredRatio > 1.5) 1.5,
      1.0,
    }.toList()
      ..sort((a, b) => b.compareTo(a));

    Object? lastError;
    for (final ratio in ratios) {
      try {
        if (SchedulerBinding.instance.schedulerPhase != SchedulerPhase.idle) {
          await WidgetsBinding.instance.endOfFrame;
        }
        final image = await boundary.toImage(pixelRatio: ratio);
        try {
          final byteData = await image.toByteData(format: ui.ImageByteFormat.png);
          if (byteData != null && byteData.lengthInBytes > 0) {
            return byteData.buffer.asUint8List();
          }
          lastError = Exception('Gagal mengonversi resi ke gambar');
        } finally {
          image.dispose();
        }
      } catch (e) {
        lastError = e;
      }
    }

    final msg = lastError?.toString() ?? 'Gagal mengonversi resi ke gambar';
    if (msg.contains('LateInitializationError') || msg.contains('not been initialized')) {
      throw Exception('Gambar resi belum siap — coba lagi setelah halaman selesai dimuat');
    }
    throw Exception(lastError ?? 'Gagal mengonversi resi ke gambar');
  }

  Widget _receiptContent() {
    return _ReceiptBody(
      invoice: _invoice!,
      settings: _settings!,
      logoWidget: _logoWidget(height: 40),
    );
  }

  Widget _receiptCaptureLayer(double captureWidth) {
    return Positioned(
      left: -captureWidth * 2,
      top: 0,
      width: captureWidth,
      child: RepaintBoundary(
        key: _receiptCaptureKey,
        child: MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: TextScaler.noScaling),
          child: ColoredBox(
            color: FieldCollectorColors.background,
            child: _receiptContent(),
          ),
        ),
      ),
    );
  }

  Future<void> _sendReceiptWhatsApp() async {
    if (_sendingWa || _invoice == null || _settings == null) return;
    final phone = _invoice!['customer_phone']?.toString().trim() ?? '';
    if (phone.isEmpty) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Nomor WhatsApp pelanggan belum diisi')),
      );
      return;
    }

    setState(() => _sendingWa = true);
    try {
      final invNo = _invoice!['invoice_number']?.toString() ?? 'invoice';
      final customerName = _invoice!['customer_name']?.toString().trim() ?? 'Pelanggan';

      await _precacheLogo();
      if (!mounted) return;

      final pngBytes = await _captureReceiptPng();
      if (pngBytes.isEmpty) {
        throw Exception('Gambar resi kosong');
      }

      await WhatsAppReceiptShare.shareImageToCustomer(
        pngBytes: pngBytes,
        fileName: 'Resi-$invNo.png',
        customerPhone: phone,
        prefilledText: 'Halo $customerName, berikut resi pembayaran $invNo.',
      );

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'WhatsApp terbuka — gambar resi sudah terlampir. '
            'Pilih chat $customerName lalu tap Kirim.',
          ),
          duration: const Duration(seconds: 6),
        ),
      );
    } on PlatformException catch (e) {
      if (!mounted) return;
      final msg = e.message?.trim();
      final detail = (msg != null && msg.isNotEmpty) ? msg : 'Gagal membuka WhatsApp';
      if (detail.contains('not been initialized')) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Gagal membuka WhatsApp — coba lagi. Pastikan WhatsApp terpasang.'),
            backgroundColor: Colors.red,
            duration: Duration(seconds: 5),
          ),
        );
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(detail),
          backgroundColor: Colors.red.shade700,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      var detail = e.toString().replaceFirst('Exception: ', '');
      if (detail.contains('LateInitializationError') || detail.contains('not been initialized')) {
        detail = 'Gambar resi belum siap — tunggu halaman selesai dimuat lalu coba lagi';
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Gagal menyiapkan gambar resi. $detail'),
          backgroundColor: Colors.red.shade700,
          duration: const Duration(seconds: 5),
        ),
      );
    } finally {
      if (mounted) setState(() => _sendingWa = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    const bg = FieldCollectorColors.background;

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
          title: const Text('Resi / Invoice'),
          actions: [
            if (!_loading)
              IconButton(
                tooltip: 'Muat ulang',
                onPressed: _fetch,
                icon: const Icon(Icons.refresh),
              ),
          ],
        ),
        body: _loading
            ? const Center(child: CircularProgressIndicator(color: FieldCollectorColors.primaryContainer))
            : _error != null
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: FieldCollectorColors.onSurface)),
                          const SizedBox(height: 16),
                          FilledButton(
                            onPressed: _fetch,
                            style: FilledButton.styleFrom(backgroundColor: FieldCollectorColors.primaryContainer),
                            child: const Text('Coba lagi'),
                          ),
                        ],
                      ),
                    ),
                  )
                : _invoice == null || _settings == null
                    ? const Center(child: Text('Data tidak tersedia', style: TextStyle(color: FieldCollectorColors.onSurface)))
                    : LayoutBuilder(
                        builder: (context, constraints) {
                          final captureWidth = MediaQuery.sizeOf(context).width;
                          return Stack(
                            clipBehavior: Clip.none,
                            children: [
                              Column(
                                children: [
                                  Expanded(
                                    child: SingleChildScrollView(
                                      controller: _scrollController,
                                      child: ColoredBox(
                                        color: FieldCollectorColors.background,
                                        child: _ReceiptBody(
                                          invoice: _invoice!,
                                          settings: _settings!,
                                          logoWidget: _logoWidget(height: 40),
                                        ),
                                      ),
                                    ),
                                  ),
                                  SafeArea(
                                    top: false,
                                    child: Padding(
                                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                                      child: SizedBox(
                                        width: double.infinity,
                                        child: FilledButton.icon(
                                          onPressed: _sendingWa ? null : _sendReceiptWhatsApp,
                                          style: FilledButton.styleFrom(
                                            backgroundColor: const Color(0xFF25D366),
                                            foregroundColor: Colors.white,
                                            padding: const EdgeInsets.symmetric(vertical: 14),
                                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                                          ),
                                          icon: _sendingWa
                                              ? const SizedBox(
                                                  width: 20,
                                                  height: 20,
                                                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                                                )
                                              : const Icon(Icons.send_rounded),
                                          label: Text(_sendingWa ? 'Menyiapkan gambar…' : 'Kirim resi (WhatsApp)'),
                                        ),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                              _receiptCaptureLayer(captureWidth),
                            ],
                          );
                        },
                      ),
      ),
    );
  }
}

class _ReceiptBody extends StatelessWidget {
  const _ReceiptBody({
    required this.invoice,
    required this.settings,
    required this.logoWidget,
  });

  final Map<String, dynamic> invoice;
  final Map<String, dynamic> settings;
  final Widget logoWidget;

  @override
  Widget build(BuildContext context) {
    final company = settings['companyHeader']?.toString() ?? 'ISP';
    final slogan = settings['company_slogan']?.toString() ?? '';
    final invNo = invoice['invoice_number']?.toString() ?? '—';
    final amount = _coerceNum(invoice['amount']) ?? 0;
    final base = _coerceNum(invoice['base_amount']);
    final taxRate = _coerceNum(invoice['tax_rate']);
    final notes = invoice['notes']?.toString().trim() ?? '';
    final invoiceNotes = settings['invoice_notes']?.toString().trim() ?? '';

    num taxAmount = 0;
    if (base != null && base > 0) {
      final tr = taxRate ?? 11;
      taxAmount = base * (tr / 100);
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: FieldCollectorColors.outlineVariant),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        ClipRRect(
                          borderRadius: BorderRadius.circular(6),
                          child: logoWidget,
                        ),
                        const SizedBox(height: 8),
                        Text(company, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: FieldCollectorColors.onSurface)),
                        if (slogan.isNotEmpty)
                          Text(slogan, style: const TextStyle(fontSize: 11, color: FieldCollectorColors.onSurfaceVariant)),
                      ],
                    ),
                  ),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(
                        'INVOICE',
                        style: TextStyle(
                          fontWeight: FontWeight.w900,
                          fontSize: 18,
                          color: FieldCollectorColors.primaryContainer,
                        ),
                      ),
                      Text(invNo, style: const TextStyle(fontWeight: FontWeight.w700, color: FieldCollectorColors.onSurface)),
                    ],
                  ),
                ],
              ),
              const Divider(height: 24),
              const Text('Informasi pelanggan', style: TextStyle(fontWeight: FontWeight.w800, color: FieldCollectorColors.primaryContainer)),
              const SizedBox(height: 8),
              _kv('Nama', invoice['customer_name']?.toString() ?? '—'),
              _kv('Username', invoice['customer_username']?.toString() ?? '—'),
              _kv('Telepon', invoice['customer_phone']?.toString() ?? '—'),
              _kv('Alamat', (invoice['customer_address']?.toString().trim().isNotEmpty ?? false)
                  ? invoice['customer_address'].toString()
                  : 'Alamat tidak tersedia'),
              const SizedBox(height: 16),
              const Text('Informasi invoice', style: TextStyle(fontWeight: FontWeight.w800, color: FieldCollectorColors.primaryContainer)),
              const SizedBox(height: 8),
              _kv('Tanggal dibuat', _fmtIdDate(invoice['created_at']?.toString())),
              _kv('Jatuh tempo', _fmtIdDate(invoice['due_date']?.toString())),
              if ((invoice['payment_date']?.toString() ?? '').trim().isNotEmpty)
                _kv('Tanggal bayar', _fmtIdDate(invoice['payment_date']?.toString())),
              _kv('Metode', _methodLabel(invoice['payment_method']?.toString())),
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    const SizedBox(
                      width: 108,
                      child: Text(
                        'Status',
                        style: TextStyle(
                          fontWeight: FontWeight.w600,
                          fontSize: 12,
                          color: FieldCollectorColors.onSurfaceVariant,
                        ),
                      ),
                    ),
                    Expanded(
                      child: Text(
                        'LUNAS',
                        style: TextStyle(
                          fontSize: 22,
                          fontWeight: FontWeight.w900,
                          letterSpacing: 0.6,
                          color: const Color(0xFF0D5A16),
                          height: 1.2,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 12),
          decoration: BoxDecoration(
            color: FieldCollectorColors.primaryContainer,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Text(
            'Total tagihan: ${_rupiah(amount)}',
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 16),
          ),
        ),
        const SizedBox(height: 12),
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: FieldCollectorColors.outlineVariant),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Detail layanan', style: TextStyle(fontWeight: FontWeight.w800, color: FieldCollectorColors.primaryContainer)),
              const SizedBox(height: 10),
              Table(
                border: TableBorder.all(color: FieldCollectorColors.outlineVariant),
                children: [
                  TableRow(
                    decoration: const BoxDecoration(color: Color(0xFFF1F5F9)),
                    children: ['Layanan', 'Kecepatan', 'Dasar', 'PPN', 'Total']
                        .map(
                          (h) => Padding(
                            padding: const EdgeInsets.all(6),
                            child: Text(h, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: FieldCollectorColors.onSurface)),
                          ),
                        )
                        .toList(),
                  ),
                  TableRow(
                    children: [
                      Padding(
                        padding: const EdgeInsets.all(6),
                        child: Text(
                          invoice['package_name']?.toString() ?? '—',
                          style: const TextStyle(fontSize: 12, color: FieldCollectorColors.onSurface),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(6),
                        child: Text(
                          invoice['package_speed']?.toString().isNotEmpty == true
                              ? invoice['package_speed'].toString()
                              : '—',
                          style: const TextStyle(fontSize: 12, color: FieldCollectorColors.onSurface),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(6),
                        child: Text(
                          _rupiah(base != null && base > 0 ? base.round() : amount.round()),
                          textAlign: TextAlign.end,
                          style: const TextStyle(fontSize: 12, color: FieldCollectorColors.onSurface),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(6),
                        child: Text(
                          taxRate != null && taxRate == 0 ? '0%' : '${(taxRate ?? 11).toStringAsFixed(0)}%',
                          style: const TextStyle(fontSize: 12, color: FieldCollectorColors.onSurface),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(6),
                        child: Text(
                          _rupiah(amount),
                          textAlign: TextAlign.end,
                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w800, color: FieldCollectorColors.onSurface),
                        ),
                      ),
                    ],
                  ),
                  TableRow(
                    decoration: const BoxDecoration(color: Color(0xFFE8EDF5)),
                    children: [
                      const Padding(
                        padding: EdgeInsets.all(6),
                        child: Text('Subtotal', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 11, color: FieldCollectorColors.onSurface)),
                      ),
                      const Padding(padding: EdgeInsets.all(6), child: SizedBox.shrink()),
                      Padding(
                        padding: const EdgeInsets.all(6),
                        child: Text(
                          _rupiah(base != null && base > 0 ? base.round() : amount.round()),
                          textAlign: TextAlign.end,
                          style: const TextStyle(fontSize: 11, color: FieldCollectorColors.onSurface),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(6),
                        child: Text(
                          _rupiah(taxAmount.round()),
                          textAlign: TextAlign.end,
                          style: const TextStyle(fontSize: 11, color: FieldCollectorColors.onSurface),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(6),
                        child: Text(
                          _rupiah(amount),
                          textAlign: TextAlign.end,
                          style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: FieldCollectorColors.onSurface),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ),
        if (notes.isNotEmpty) ...[
          const SizedBox(height: 12),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: const Color(0xFFE3F2FD),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFF90CAF9)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Catatan', style: TextStyle(fontWeight: FontWeight.w800, color: FieldCollectorColors.primaryContainer)),
                const SizedBox(height: 6),
                Text(notes, style: const TextStyle(fontSize: 13, color: FieldCollectorColors.onSurface, height: 1.35)),
              ],
            ),
          ),
        ],
        if (invoiceNotes.isNotEmpty) ...[
          const SizedBox(height: 12),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: const Color(0xFFFFF8E1),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFFFE082)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Informasi penting', style: TextStyle(fontWeight: FontWeight.w800, color: Color(0xFF856404))),
                const SizedBox(height: 6),
                Text(invoiceNotes, style: const TextStyle(fontSize: 13, color: FieldCollectorColors.onSurface, height: 1.35)),
              ],
            ),
          ),
        ],
        const SizedBox(height: 16),
        const Text('Cara pembayaran', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15, color: FieldCollectorColors.onSurface)),
        const SizedBox(height: 8),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: _PayCard(
                title: 'Transfer bank',
                child: Text(
                  'Bank: ${settings['payment_bank_name']}\nNo. rekening: ${settings['payment_account_number']}\nAtas nama: ${settings['payment_account_holder']}',
                  style: const TextStyle(fontSize: 12, height: 1.4, color: FieldCollectorColors.onSurface),
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _PayCard(
                title: 'Tunai',
                child: Text(
                  'Kantor:\n${settings['payment_cash_address']}\nJam: ${settings['payment_cash_hours']}',
                  style: const TextStyle(fontSize: 12, height: 1.4, color: FieldCollectorColors.onSurface),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 20),
        const Text(
          'Terima kasih telah mempercayai layanan kami.',
          style: TextStyle(fontWeight: FontWeight.w700, color: FieldCollectorColors.onSurface),
        ),
        const SizedBox(height: 8),
        Text(
          'Telp: ${settings['contact_phone']}\nEmail: ${settings['contact_email']}\nAlamat: ${settings['contact_address']}',
          style: const TextStyle(fontSize: 12, color: FieldCollectorColors.onSurfaceVariant, height: 1.4),
        ),
        if ((settings['footerInfo']?.toString().trim().isNotEmpty ?? false)) ...[
          const SizedBox(height: 8),
          Text(settings['footerInfo'].toString(), style: const TextStyle(fontSize: 11, color: FieldCollectorColors.onSurfaceVariant)),
        ],
        const SizedBox(height: 8),
        Text(
          'WA: ${settings['contact_whatsapp']}\nWeb: ${settings['company_website']}',
          style: const TextStyle(fontSize: 11, color: FieldCollectorColors.onSurfaceVariant, height: 1.4),
        ),
        const SizedBox(height: 8),
        const Text(
          'Simpan layar ini sebagai bukti pembayaran.',
          style: TextStyle(fontSize: 11, fontStyle: FontStyle.italic, color: FieldCollectorColors.onSurfaceVariant),
        ),
        ],
      ),
    );
  }

  static Widget _kv(String k, String v, {Color? valueColor}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 108,
            child: Text(k, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: FieldCollectorColors.onSurfaceVariant)),
          ),
          Expanded(
            child: Text(v, style: TextStyle(fontSize: 13, color: valueColor ?? FieldCollectorColors.onSurface, height: 1.3)),
          ),
        ],
      ),
    );
  }
}

class _PayCard extends StatelessWidget {
  const _PayCard({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: FieldCollectorColors.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13, color: FieldCollectorColors.primaryContainer)),
          const SizedBox(height: 8),
          child,
        ],
      ),
    );
  }
}
