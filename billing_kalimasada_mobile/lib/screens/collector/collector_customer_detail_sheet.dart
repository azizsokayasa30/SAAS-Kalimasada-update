import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../store/collector_provider.dart';
import '../../utils/whatsapp_uri.dart';
import '../../theme/collector_colors.dart';
import 'collector_invoice_receipt_screen.dart';
import 'collector_receive_payment_screen.dart';

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

String? _waLaunchUri(String raw) => waLaunchUri(raw);

Uri? _mapsUri(double? lat, double? lng) {
  if (lat == null || lng == null) return null;
  if (lat == 0 && lng == 0) return null;
  return Uri.parse('https://www.google.com/maps/search/?api=1&query=$lat,$lng');
}

Future<void> showCollectorCustomerDetailSheet(
  BuildContext context, {
  required Map<String, dynamic> row,
  Future<void> Function()? onRefreshCustomers,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: FieldCollectorColors.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (sheetCtx) {
      final h = MediaQuery.sizeOf(sheetCtx).height;
      return SizedBox(
        height: h * 0.9,
        child: _CollectorCustomerDetailPanel(
          row: row,
          parentContext: context,
          onRefreshCustomers: onRefreshCustomers,
        ),
      );
    },
  );
}

class _CollectorCustomerDetailPanel extends StatefulWidget {
  const _CollectorCustomerDetailPanel({
    required this.row,
    required this.parentContext,
    this.onRefreshCustomers,
  });

  final Map<String, dynamic> row;
  final BuildContext parentContext;
  final Future<void> Function()? onRefreshCustomers;

  @override
  State<_CollectorCustomerDetailPanel> createState() =>
      _CollectorCustomerDetailPanelState();
}

class _CollectorCustomerDetailPanelState
    extends State<_CollectorCustomerDetailPanel> {
  List<Map<String, dynamic>> _history = [];
  Map<String, dynamic> _pppSession = {};
  bool _loadingDetail = true;
  String? _detailError;
  bool _isolirLoading = false;
  late String _phoneDisplay;
  bool _phoneSaving = false;
  bool _dueDateSaving = false;

  int? get _customerId => int.tryParse(widget.row['id']?.toString() ?? '');

  Map<String, dynamic>? _primaryOpenInvoice() {
    for (final inv in _history) {
      final st = (inv['status']?.toString() ?? '').toLowerCase();
      if (st.isNotEmpty && st != 'paid') return inv;
    }
    return null;
  }

  int? _latestPaidInvoiceId() {
    Map<String, dynamic>? best;
    DateTime? bestAt;
    for (final inv in _history) {
      final st = (inv['status']?.toString() ?? '').toLowerCase();
      if (st != 'paid') continue;
      final raw = inv['payment_date']?.toString() ??
          inv['updated_at']?.toString() ??
          inv['created_at']?.toString();
      final dt = raw != null ? DateTime.tryParse(raw) : null;
      if (best == null || (dt != null && (bestAt == null || dt.isAfter(bestAt)))) {
        best = inv;
        bestAt = dt;
      }
    }
    if (best == null) return null;
    return int.tryParse(best['id']?.toString() ?? '');
  }

  String _formatDueDateLabel(String? iso) {
    if (iso == null || iso.isEmpty) return '—';
    final d = DateTime.tryParse(iso);
    if (d == null) return iso;
    return DateFormat('EEEE, d MMMM yyyy', 'id_ID').format(d);
  }

  String _toYmd(DateTime d) {
    String p(int n) => n.toString().padLeft(2, '0');
    return '${d.year}-${p(d.month)}-${p(d.day)}';
  }

  @override
  void initState() {
    super.initState();
    _phoneDisplay = widget.row['phone']?.toString().trim() ?? '';
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadDetail());
  }

  Future<void> _loadDetail() async {
    final id = _customerId;
    if (id == null) {
      setState(() {
        _loadingDetail = false;
        _detailError = 'ID pelanggan tidak valid';
      });
      return;
    }
    setState(() {
      _loadingDetail = true;
      _detailError = null;
    });
    try {
      final col = context.read<CollectorProvider>();
      final hist = await col.fetchCustomerInvoiceHistory(id);
      final ppp = await col.fetchCustomerPppSession(id);
      if (!mounted) return;
      setState(() {
        _history = hist;
        _pppSession = ppp;
        _loadingDetail = false;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _loadingDetail = false;
          _detailError = e.toString();
        });
      }
    }
  }

  Future<void> _editPhone() async {
    final cid = _customerId;
    if (cid == null) return;
    final ctrl = TextEditingController(text: _phoneDisplay);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Edit nomor WhatsApp'),
        content: TextField(
          controller: ctrl,
          keyboardType: TextInputType.phone,
          decoration: const InputDecoration(
            labelText: 'Nomor HP / WA',
            hintText: '08xxxxxxxxxx',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Batal'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Simpan'),
          ),
        ],
      ),
    );
    final newPhone = ctrl.text.trim();
    ctrl.dispose();
    if (ok != true || !mounted) return;
    setState(() => _phoneSaving = true);
    final err = await context.read<CollectorProvider>().updateCustomerPhone(
      cid,
      newPhone,
    );
    if (!mounted) return;
    setState(() {
      _phoneSaving = false;
      if (err == null) _phoneDisplay = newPhone;
    });
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
    } else {
      widget.row['phone'] = newPhone;
      await widget.onRefreshCustomers?.call();
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('Nomor HP diperbarui')));
      }
    }
  }

  Future<void> _editDueDate(Map<String, dynamic> inv) async {
    final cid = _customerId;
    final invoiceId = int.tryParse(inv['id']?.toString() ?? '');
    if (cid == null || invoiceId == null) return;
    final currentIso = inv['due_date']?.toString() ?? '';
    final initial = DateTime.tryParse(currentIso) ?? DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(2020),
      lastDate: DateTime(2035, 12, 31),
      helpText: 'Pilih jatuh tempo',
      cancelText: 'Batal',
      confirmText: 'Simpan',
    );
    if (picked == null || !mounted) return;
    setState(() => _dueDateSaving = true);
    final ymd = _toYmd(picked);
    final err = await context.read<CollectorProvider>().updateInvoiceDueDate(
      cid,
      invoiceId,
      ymd,
    );
    if (!mounted) return;
    setState(() => _dueDateSaving = false);
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
      return;
    }
    setState(() {
      final idx = _history.indexWhere(
        (h) => h['id']?.toString() == invoiceId.toString(),
      );
      if (idx >= 0) {
        _history[idx] = Map<String, dynamic>.from(_history[idx])
          ..['due_date'] = ymd;
      }
    });
    if (mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Jatuh tempo diperbarui')));
    }
  }

  Future<void> _promptIsolir() async {
    final cid = _customerId;
    if (cid == null) return;
    final reasonCtrl = TextEditingController(
      text: 'Peringatan penagihan kolektor',
    );
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Isolir pelanggan?'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Layanan internet akan ditangguhkan (status isolir). Gunakan untuk peringatan penagihan sesuai kebijakan perusahaan.',
                style: TextStyle(fontSize: 14, height: 1.35),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: reasonCtrl,
                decoration: const InputDecoration(
                  labelText: 'Alasan / catatan',
                  border: OutlineInputBorder(),
                ),
                maxLines: 2,
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Batal'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFF93000A),
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Isolir'),
          ),
        ],
      ),
    );
    final reasonText = reasonCtrl.text.trim();
    reasonCtrl.dispose();
    if (confirm != true || !mounted) return;

    setState(() => _isolirLoading = true);
    final err = await context.read<CollectorProvider>().collectorIsolirCustomer(
      cid,
      reason: reasonText.isNotEmpty
          ? reasonText
          : 'Isolir manual oleh kolektor (peringatan)',
    );
    if (!mounted) return;
    setState(() => _isolirLoading = false);
    if (err != null) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(err)));
      }
      return;
    }
    if (!mounted) return;
    Navigator.pop(context);
    final parentCtx = widget.parentContext;
    final refresh = widget.onRefreshCustomers;
    if (refresh != null) {
      unawaited(refresh());
    }
    if (parentCtx.mounted) {
      ScaffoldMessenger.of(parentCtx).showSnackBar(
        const SnackBar(
          content: Text('Status isolir disimpan. Daftar pelanggan diperbarui.'),
        ),
      );
    }
  }

  /// Tanpa mengandalkan [canLaunchUrl] saja (Android 11+ sering false tanpa &lt;queries&gt;).
  Future<void> _launchExternal(Uri uri) async {
    try {
      final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!ok && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              'Tidak ada aplikasi untuk membuka: ${uri.scheme}://${uri.host}${uri.path}',
            ),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Gagal membuka tautan: $e')));
      }
    }
  }

  String _authModeLabel(String? m) {
    switch (m) {
      case 'radius':
        return 'RADIUS';
      case 'mikrotik':
        return 'Mikrotik';
      default:
        return '—';
    }
  }

  @override
  Widget build(BuildContext context) {
    final row = widget.row;
    final name = row['name']?.toString() ?? '';
    final phone = _phoneDisplay;
    final addr = row['address']?.toString() ?? '';
    final ps = row['payment_status']?.toString() ?? '';
    final lifePs =
        row['lifetime_payment_status']?.toString() ?? ps;
    final st = row['status']?.toString().toLowerCase() ?? '';
    final price = _coerceNum(row['package_price'])?.round() ?? 0;
    final pkg = row['package_name']?.toString() ?? '';
    final custId = row['customer_id']?.toString();
    final username = row['username']?.toString() ?? '';
    final idLine = custId != null && custId.isNotEmpty
        ? 'ID: $custId'
        : (username.isNotEmpty ? 'User: $username' : 'ID: ${row['id']}');

    final lat = _coerceNum(row['latitude'])?.toDouble();
    final lng = _coerceNum(row['longitude'])?.toDouble();
    final mapUri = _mapsUri(lat, lng);
    final waUri = phone.isNotEmpty ? _waLaunchUri(phone) : null;

    final pppoeRaw = row['pppoe_username']?.toString().trim() ?? '';
    final pppUser = pppoeRaw.isNotEmpty ? pppoeRaw : username;
    final pppProfile = row['pppoe_profile']?.toString().trim() ?? '';
    final routerName = row['router_name']?.toString().trim() ?? '';
    final loginChecked = _pppSession['login_checked']?.toString() ?? '';
    final pppOnline = _pppSession['online'] == true;
    final pppAuth = _pppSession['auth_mode']?.toString();

    final cid = _customerId;
    final isIsolir = st == 'suspended';
    final isInactive = st == 'inactive';
    final isPaid = ps == 'paid' || (ps == 'no_invoice' && lifePs == 'paid');
    final isLifetimeNew = lifePs == 'no_invoice';
    // Belum bayar = punya tagihan unpaid/overdue; bukan baru / nonaktif.
    final isUnpaidLike = !isInactive && !isLifetimeNew && (ps == 'unpaid' || ps == 'overdue');
    final hasUnpaidInvoiceInHistory =
        !_loadingDetail &&
        _history.any((inv) {
          final s = (inv['status']?.toString() ?? '').toLowerCase();
          return s.isNotEmpty && s != 'paid';
        });
    // Terisolir tetap bisa ditagih bila ada tunggakan (ringkasan atau riwayat faktur).
    final showTagih =
        cid != null &&
        !isInactive &&
        !isPaid &&
        (isUnpaidLike || (isIsolir && hasUnpaidInvoiceInHistory));
    final showResi = !isIsolir && !isInactive && isPaid;

    late String badge;
    late Color badgeBg;
    late Color badgeFg;
    if (isInactive) {
      badge = 'Nonaktif';
      badgeBg = const Color(0xFFE8E8E8);
      badgeFg = const Color(0xFF5F5F5F);
    } else if (isIsolir) {
      badge = 'Isolir';
      badgeBg = FieldCollectorColors.errorContainer;
      badgeFg = FieldCollectorColors.onErrorContainer;
    } else if (ps == 'paid' || (ps == 'no_invoice' && lifePs == 'paid')) {
      badge = 'Lunas';
      badgeBg = const Color(0xFFD3F5D6);
      badgeFg = const Color(0xFF0D5A16);
    } else if (isLifetimeNew) {
      badge = 'Baru';
      badgeBg = const Color(0xFFD4E3FF);
      badgeFg = const Color(0xFF001C3A);
    } else {
      badge = 'Belum bayar';
      badgeBg = const Color(0xFFFFDAD6);
      badgeFg = const Color(0xFF93000A);
    }

    final parent = widget.parentContext;
    final tahunBerjalan = DateTime.now().year;

    return Column(
      children: [
        const SizedBox(height: 10),
        Center(
          child: Container(
            width: 40,
            height: 4,
            decoration: BoxDecoration(
              color: FieldCollectorColors.outlineVariant,
              borderRadius: BorderRadius.circular(99),
            ),
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          name,
                          style: Theme.of(context).textTheme.headlineSmall
                              ?.copyWith(
                                fontWeight: FontWeight.w700,
                                color: FieldCollectorColors.onSurface,
                              ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          idLine,
                          style: const TextStyle(
                            color: FieldCollectorColors.onSurfaceVariant,
                            fontSize: 13,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 6,
                    ),
                    decoration: BoxDecoration(
                      color: badgeBg,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      badge,
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w800,
                        color: badgeFg,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              _buildDueDateSection(context),
              const SizedBox(height: 12),
              _phoneContactTile(context, phone: phone, waUri: waUri),
              const SizedBox(height: 8),
              if (addr.isNotEmpty) ...[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(
                      Icons.home_work_outlined,
                      size: 20,
                      color: FieldCollectorColors.onSurfaceVariant,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        addr,
                        style: const TextStyle(
                          fontSize: 14,
                          height: 1.35,
                          color: FieldCollectorColors.onSurface,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
              ],
              _linkTile(
                context,
                icon: Icons.map_outlined,
                title: 'Peta',
                subtitle: mapUri != null
                    ? 'Buka lokasi di Google Maps'
                    : 'Koordinat belum diisi',
                enabled: mapUri != null,
                onTap: mapUri == null
                    ? null
                    : () {
                        _launchExternal(mapUri);
                      },
              ),
              const SizedBox(height: 16),
              _sectionCard(
                context,
                title: 'Status PPP (sesi)',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (_loadingDetail)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 8),
                        child: Center(
                          child: SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: FieldCollectorColors.primaryContainer,
                            ),
                          ),
                        ),
                      )
                    else if (!_pppSession.containsKey('online'))
                      const Text(
                        'Status sesi tidak dapat dimuat dari server.',
                        style: TextStyle(
                          fontSize: 12,
                          color: FieldCollectorColors.onSurfaceVariant,
                          height: 1.35,
                        ),
                      )
                    else if (loginChecked.isEmpty)
                      const Text(
                        'Login PPPoE belum diatur — tidak dapat mengecek sesi seperti di admin Mikrotik.',
                        style: TextStyle(
                          fontSize: 12,
                          color: FieldCollectorColors.onSurfaceVariant,
                          height: 1.35,
                        ),
                      )
                    else ...[
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 4,
                            ),
                            decoration: BoxDecoration(
                              color: pppOnline
                                  ? const Color(0xFFD3F5D6)
                                  : const Color(0xFFE7E8E9),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(
                              pppOnline ? 'Online' : 'Offline',
                              style: TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w800,
                                color: pppOnline
                                    ? const Color(0xFF0D5A16)
                                    : FieldCollectorColors.onSurfaceVariant,
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              'Sama dengan indikator sesi di /admin/mikrotik (${_authModeLabel(pppAuth)}).',
                              style: const TextStyle(
                                fontSize: 11,
                                color: FieldCollectorColors.onSurfaceVariant,
                                height: 1.3,
                              ),
                            ),
                          ),
                        ],
                      ),
                      if (isIsolir)
                        const Padding(
                          padding: EdgeInsets.only(top: 8),
                          child: Text(
                            'Akun billing: terisolir (suspensi).',
                            style: TextStyle(
                              fontSize: 11,
                              color: Color(0xFF93000A),
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      const SizedBox(height: 10),
                      _kv('Login PPPoE', pppUser.isEmpty ? '—' : pppUser),
                      if (loginChecked.isNotEmpty && loginChecked != pppUser)
                        _kv('Dicek ke Mikrotik', loginChecked),
                      if (pppProfile.isNotEmpty) _kv('Profil', pppProfile),
                      if (routerName.isNotEmpty)
                        _kv('Router / NAS', routerName),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 12),
              _sectionCard(
                context,
                title: 'Ringkasan tagihan',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _kv('Paket', pkg.isEmpty ? '—' : pkg),
                    _kv('Estimasi / tagihan bulanan', _rupiah(price)),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              Text(
                'Riwayat tagihan (tahun $tahunBerjalan)',
                style: Theme.of(context).textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w700,
                  color: FieldCollectorColors.onSurface,
                ),
              ),
              const SizedBox(height: 8),
              if (_loadingDetail)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 24),
                  child: Center(
                    child: CircularProgressIndicator(
                      color: FieldCollectorColors.primaryContainer,
                    ),
                  ),
                )
              else if (_detailError != null)
                Text(
                  _detailError!,
                  style: const TextStyle(
                    color: FieldCollectorColors.onErrorContainer,
                  ),
                )
              else if (_history.isEmpty)
                Text(
                  'Belum ada faktur tercatat pada tahun $tahunBerjalan.',
                  style: const TextStyle(
                    color: FieldCollectorColors.onSurfaceVariant,
                    height: 1.35,
                  ),
                )
              else
                ..._history.map((inv) => _historyInvoiceTile(context, inv)),
            ],
          ),
        ),
        Padding(
          padding: EdgeInsets.fromLTRB(
            20,
            8,
            20,
            MediaQuery.paddingOf(context).bottom + 16,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (showTagih)
                FilledButton.icon(
                  style: FilledButton.styleFrom(
                    backgroundColor: FieldCollectorColors.primaryContainer,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                  onPressed: () async {
                    Navigator.pop(context);
                    await Future<void>.delayed(Duration.zero);
                    if (!parent.mounted) return;
                    final result = await Navigator.of(parent).push<Object?>(
                      MaterialPageRoute<Object?>(
                        builder: (_) => CollectorReceivePaymentScreen(
                          customerId: cid,
                          customerSnapshot: Map<String, dynamic>.from(row),
                        ),
                      ),
                    );
                    var paidOk = false;
                    List<int>? paidInvoiceIds;
                    if (result is Map) {
                      paidOk = result['success'] == true || result['paid_invoice_ids'] != null;
                      final raw = result['paid_invoice_ids'];
                      if (raw is List) {
                        paidInvoiceIds = raw
                            .map((e) => int.tryParse(e.toString()))
                            .whereType<int>()
                            .where((e) => e > 0)
                            .toList();
                      }
                    } else if (result == true) {
                      paidOk = true;
                    }
                    if (paidOk) {
                      await widget.onRefreshCustomers?.call();
                    }
                    if (paidOk && parent.mounted) {
                      await Navigator.of(parent).push<void>(
                        MaterialPageRoute<void>(
                          builder: (_) => CollectorInvoiceReceiptScreen(
                            customerId: cid,
                            invoiceIds: paidInvoiceIds,
                            invoiceId: (paidInvoiceIds != null && paidInvoiceIds.length == 1)
                                ? paidInvoiceIds.first
                                : null,
                          ),
                        ),
                      );
                    }
                  },
                  icon: const Icon(Icons.payments_outlined),
                  label: Text(isIsolir ? 'Bayar / aktifkan' : 'Tagih'),
                ),
              if (showResi && cid != null) ...[
                if (showTagih) const SizedBox(height: 8),
                OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(
                    foregroundColor: FieldCollectorColors.onSurface,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    side: const BorderSide(
                      color: FieldCollectorColors.outlineVariant,
                    ),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                  onPressed: () async {
                    Navigator.pop(context);
                    await Future<void>.delayed(Duration.zero);
                    if (!parent.mounted) return;
                    final paidInvId = _latestPaidInvoiceId();
                    await Navigator.of(parent).push<void>(
                      MaterialPageRoute<void>(
                        builder: (_) => CollectorInvoiceReceiptScreen(
                          customerId: cid,
                          invoiceId: paidInvId,
                        ),
                      ),
                    );
                  },
                  icon: const Icon(Icons.receipt_long_outlined),
                  label: const Text('Resi'),
                ),
              ],
              if (!isIsolir && cid != null) ...[
                if (showTagih || showResi) const SizedBox(height: 8),
                OutlinedButton.icon(
                  onPressed: _isolirLoading ? null : _promptIsolir,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: const Color(0xFF93000A),
                    side: const BorderSide(color: Color(0xFFC62828)),
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                  icon: _isolirLoading
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Color(0xFF93000A),
                          ),
                        )
                      : const Icon(Icons.portable_wifi_off_outlined),
                  label: Text(
                    _isolirLoading ? 'Memproses…' : 'Isolir (peringatan)',
                  ),
                ),
              ],
              const SizedBox(height: 10),
              OutlinedButton(
                onPressed: _isolirLoading ? null : () => Navigator.pop(context),
                style: OutlinedButton.styleFrom(
                  foregroundColor: FieldCollectorColors.onSurfaceVariant,
                  side: const BorderSide(
                    color: FieldCollectorColors.outlineVariant,
                  ),
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                ),
                child: const Text('Batal'),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildDueDateSection(BuildContext context) {
    const green = Color(0xFF1B5E20);
    const greenBg = Color(0xFFE8F5E9);
    if (_loadingDetail) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: greenBg,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: const Color(0xFFA5D6A7)),
        ),
        child: const Center(
          child: SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2, color: green),
          ),
        ),
      );
    }
    final inv = _primaryOpenInvoice();
    if (inv == null) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: FieldCollectorColors.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: FieldCollectorColors.outlineVariant),
        ),
        child: const Text(
          'Belum ada tagihan terbuka — jatuh tempo akan tampil setelah faktur dibuat.',
          style: TextStyle(
            fontSize: 13,
            height: 1.35,
            color: FieldCollectorColors.onSurfaceVariant,
          ),
        ),
      );
    }
    final dueIso = inv['due_date']?.toString() ?? '';
    final dueLabel = _formatDueDateLabel(dueIso);
    final invNo = inv['invoice_number']?.toString() ?? '#${inv['id']}';
    return Material(
      color: greenBg,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: _dueDateSaving ? null : () => _editDueDate(inv),
        borderRadius: BorderRadius.circular(12),
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.fromLTRB(16, 14, 12, 14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: const Color(0xFF66BB6A), width: 1.5),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'JATUH TEMPO',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.8,
                        color: green.withValues(alpha: 0.85),
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      dueLabel,
                      style: const TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w900,
                        height: 1.2,
                        color: green,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      invNo,
                      style: TextStyle(
                        fontSize: 12,
                        color: green.withValues(alpha: 0.75),
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Ketuk untuk ubah tanggal',
                      style: TextStyle(
                        fontSize: 11,
                        color: green.withValues(alpha: 0.65),
                      ),
                    ),
                  ],
                ),
              ),
              if (_dueDateSaving)
                const Padding(
                  padding: EdgeInsets.only(top: 4),
                  child: SizedBox(
                    width: 24,
                    height: 24,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: green,
                    ),
                  ),
                )
              else
                Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      Icons.edit_calendar_rounded,
                      color: green.withValues(alpha: 0.9),
                      size: 28,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'Edit',
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w600,
                        color: green.withValues(alpha: 0.85),
                      ),
                    ),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _phoneContactTile(
    BuildContext context, {
    required String phone,
    required String? waUri,
  }) {
    return Material(
      color: const Color(0xFFF3F4F6),
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
        child: Row(
          children: [
            Expanded(
              child: InkWell(
                onTap: waUri == null
                    ? null
                    : () => _launchExternal(Uri.parse(waUri)),
                borderRadius: BorderRadius.circular(10),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 12,
                  ),
                  child: Row(
                    children: [
                      Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.chat_outlined,
                            color: phone.isNotEmpty
                                ? FieldCollectorColors.primaryContainer
                                : FieldCollectorColors.onSurfaceVariant,
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'Chat',
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w600,
                              color: phone.isNotEmpty
                                  ? FieldCollectorColors.primaryContainer
                                  : FieldCollectorColors.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'WhatsApp',
                              style: TextStyle(
                                fontWeight: FontWeight.w700,
                                fontSize: 13,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              phone.isNotEmpty
                                  ? phone
                                  : 'Belum diisi — ketuk Edit untuk isi',
                              style: TextStyle(
                                fontSize: 13,
                                color: phone.isNotEmpty
                                    ? FieldCollectorColors.primaryContainer
                                    : FieldCollectorColors.onSurfaceVariant,
                                decoration: phone.isNotEmpty
                                    ? TextDecoration.underline
                                    : null,
                              ),
                            ),
                          ],
                        ),
                      ),
                      if (phone.isNotEmpty)
                        Icon(
                          Icons.open_in_new,
                          size: 18,
                          color: FieldCollectorColors.onSurfaceVariant
                              .withValues(alpha: 0.8),
                        ),
                    ],
                  ),
                ),
              ),
            ),
            InkWell(
              onTap: _phoneSaving ? null : _editPhone,
              borderRadius: BorderRadius.circular(10),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _phoneSaving
                        ? const SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(
                            Icons.edit_outlined,
                            color: FieldCollectorColors.primaryContainer,
                          ),
                    const SizedBox(height: 2),
                    const Text(
                      'Edit',
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w600,
                        color: FieldCollectorColors.primaryContainer,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _kv(String k, String v) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(
              k,
              style: const TextStyle(
                fontSize: 12,
                color: FieldCollectorColors.onSurfaceVariant,
              ),
            ),
          ),
          Expanded(
            child: Text(
              v,
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: FieldCollectorColors.onSurface,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _sectionCard(
    BuildContext context, {
    required String title,
    required Widget child,
  }) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: FieldCollectorColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: FieldCollectorColors.outlineVariant),
        boxShadow: const [
          BoxShadow(
            color: Color(0x0A000000),
            blurRadius: 4,
            offset: Offset(0, 1),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title.toUpperCase(),
            style: const TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.6,
              color: FieldCollectorColors.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }

  Widget _linkTile(
    BuildContext context, {
    required IconData icon,
    required String title,
    required String subtitle,
    required bool enabled,
    required VoidCallback? onTap,
  }) {
    return Material(
      color: const Color(0xFFF3F4F6),
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: enabled ? onTap : null,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          child: Row(
            children: [
              Icon(
                icon,
                color: enabled
                    ? FieldCollectorColors.primaryContainer
                    : FieldCollectorColors.onSurfaceVariant,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: const TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 13,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: TextStyle(
                        fontSize: 13,
                        color: enabled
                            ? FieldCollectorColors.primaryContainer
                            : FieldCollectorColors.onSurfaceVariant,
                        decoration: enabled ? TextDecoration.underline : null,
                      ),
                    ),
                  ],
                ),
              ),
              Icon(
                Icons.open_in_new,
                size: 18,
                color: FieldCollectorColors.onSurfaceVariant.withValues(
                  alpha: enabled ? 1 : 0.4,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _historyInvoiceTile(BuildContext context, Map<String, dynamic> inv) {
    final numStr = inv['invoice_number']?.toString() ?? '#${inv['id']}';
    final amt = _coerceNum(inv['amount'])?.round() ?? 0;
    final due = inv['due_date']?.toString() ?? '';
    final created = inv['created_at']?.toString() ?? '';
    final pkgName =
        inv['package_name']?.toString() ?? inv['description']?.toString() ?? '';
    final stInv = (inv['status']?.toString() ?? '').toLowerCase();
    final isPaidInv = stInv == 'paid';

    String dueLabel = due;
    if (due.isNotEmpty) {
      try {
        final d = DateTime.tryParse(due);
        if (d != null) {
          dueLabel = DateFormat.yMMMd('id_ID').format(d);
        }
      } catch (_) {}
    }
    String createdLabel = created;
    if (created.isNotEmpty) {
      try {
        final d = DateTime.tryParse(created);
        if (d != null) {
          createdLabel = DateFormat.yMMMd('id_ID').format(d);
        }
      } catch (_) {}
    }

    final amtColor = isPaidInv
        ? const Color(0xFF1B5E20)
        : const Color(0xFFBA1A1A);
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: FieldCollectorColors.outlineVariant),
        color: Colors.white,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  numStr,
                  style: const TextStyle(
                    fontWeight: FontWeight.w800,
                    fontSize: 13,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: isPaidInv
                      ? const Color(0xFFD3F5D6)
                      : const Color(0xFFFFDAD6),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  isPaidInv ? 'Lunas' : 'Belum lunas',
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w800,
                    color: isPaidInv
                        ? const Color(0xFF0D5A16)
                        : const Color(0xFF93000A),
                  ),
                ),
              ),
            ],
          ),
          if (pkgName.isNotEmpty)
            Text(
              pkgName,
              style: const TextStyle(
                fontSize: 12,
                color: FieldCollectorColors.onSurfaceVariant,
              ),
            ),
          const SizedBox(height: 6),
          Text(
            'Terbit: $createdLabel',
            style: const TextStyle(
              fontSize: 11,
              color: FieldCollectorColors.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 4),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Jatuh tempo: $dueLabel',
                style: const TextStyle(
                  fontSize: 11,
                  color: FieldCollectorColors.onSurfaceVariant,
                ),
              ),
              Text(
                _rupiah(amt),
                style: TextStyle(
                  fontWeight: FontWeight.w800,
                  fontSize: 15,
                  color: amtColor,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
