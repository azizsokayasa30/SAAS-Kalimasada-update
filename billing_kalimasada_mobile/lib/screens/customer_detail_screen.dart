import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:intl/intl.dart';
import 'package:latlong2/latlong.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../services/api_client.dart';
import '../store/customer_provider.dart';
import '../store/auth_provider.dart';
import 'dart:convert';

class CustomerDetailScreen extends StatefulWidget {
  final Map<String, dynamic> customer;

  const CustomerDetailScreen({super.key, required this.customer});

  @override
  State<CustomerDetailScreen> createState() => _CustomerDetailScreenState();
}

class _CustomerDetailScreenState extends State<CustomerDetailScreen> {
  late Map<String, dynamic> customer;
  Map<String, dynamic>? _pppSession;
  List<Map<String, dynamic>> _paymentHistory = [];
  List<Map<String, dynamic>> _packageOptions = [];
  bool _paymentHistoryLoading = true;
  bool _statusActionLoading = false;
  bool _savingCustomerInfo = false;

  final _money = NumberFormat.currency(
    locale: 'id_ID',
    symbol: 'Rp. ',
    decimalDigits: 0,
  );

  String _pickString(Map<String, dynamic>? source, List<String> keys) {
    if (source == null) return '';
    for (final k in keys) {
      final v = source[k];
      if (v == null) continue;
      final s = v.toString().trim();
      if (s.isNotEmpty && s.toLowerCase() != 'null') return s;
    }
    return '';
  }

  int? _uptimeSecondsFromText(String raw) {
    final text = raw.trim().toLowerCase();
    if (text.isEmpty || text == '-') return null;
    if (RegExp(r'^\d+$').hasMatch(text)) {
      return int.tryParse(text);
    }
    final dMatch = RegExp(r'(\d+)\s*d').firstMatch(text);
    final hMatch = RegExp(r'(\d+)\s*h').firstMatch(text);
    final mMatch = RegExp(r'(\d+)\s*m').firstMatch(text);
    final sMatch = RegExp(r'(\d+)\s*s').firstMatch(text);
    final d = int.tryParse(dMatch?.group(1) ?? '0') ?? 0;
    final h = int.tryParse(hMatch?.group(1) ?? '0') ?? 0;
    final m = int.tryParse(mMatch?.group(1) ?? '0') ?? 0;
    final s = int.tryParse(sMatch?.group(1) ?? '0') ?? 0;
    final total = (d * 86400) + (h * 3600) + (m * 60) + s;
    return total > 0 ? total : null;
  }

  String _formatUptimeDdHhMmSs(String raw) {
    final secs = _uptimeSecondsFromText(raw);
    if (secs == null) return raw.trim().isEmpty ? '-' : raw;
    final d = secs ~/ 86400;
    final h = (secs % 86400) ~/ 3600;
    final m = (secs % 3600) ~/ 60;
    final s = secs % 60;
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(d)}:${two(h)}:${two(m)}:${two(s)}';
  }

  double? _toDouble(dynamic v) {
    if (v is num) return v.toDouble();
    return double.tryParse(v?.toString() ?? '');
  }

  num _numVal(dynamic value) {
    if (value is num) return value;
    return num.tryParse(value?.toString() ?? '') ?? 0;
  }

  String _formatDate(dynamic value) {
    final raw = value?.toString().trim() ?? '';
    if (raw.isEmpty) return '-';
    final parsed = DateTime.tryParse(raw);
    if (parsed == null) return raw;
    return DateFormat('dd MMM yyyy', 'id_ID').format(parsed);
  }

  /// Nomor internasional tanpa `+` untuk `https://wa.me/...` (utama: Indonesia 0… → 62…).
  String? _whatsappDigitsFromDisplay(String? raw) {
    if (raw == null) return null;
    final d = raw.replaceAll(RegExp(r'\D'), '');
    if (d.isEmpty) return null;
    if (d.startsWith('0') && d.length >= 9) {
      return '62${d.substring(1)}';
    }
    if (d.startsWith('62')) return d;
    return d;
  }

  Future<void> _openWhatsAppForPhone(String phoneDisplay) async {
    final wa = _whatsappDigitsFromDisplay(phoneDisplay);
    if (wa == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Nomor HP tidak valid untuk WhatsApp.')),
        );
      }
      return;
    }
    final uri = Uri.parse('https://wa.me/$wa');
    final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Tidak dapat membuka WhatsApp.')),
      );
    }
  }

  Future<void> _openGoogleMapsDirections(double lat, double lng) async {
    final navUri = Uri.parse('google.navigation:q=$lat,$lng');
    final webUri = Uri.parse(
      'https://www.google.com/maps/dir/?api=1&destination=$lat,$lng&travelmode=driving',
    );

    final navOk = await launchUrl(navUri, mode: LaunchMode.externalApplication);
    if (navOk) return;

    final webOk = await launchUrl(webUri, mode: LaunchMode.externalApplication);

    if (!webOk && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Gagal membuka Google Maps.'),
          backgroundColor: Colors.red,
        ),
      );
    }
  }

  @override
  void initState() {
    super.initState();
    customer = Map<String, dynamic>.from(widget.customer);
    _loadPppSession();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final role = context.read<AuthProvider>().role;
      if (role == 'technician') {
        setState(() => _paymentHistoryLoading = false);
        return;
      }
      _loadPaymentHistory();
    });
  }

  List<Map<String, dynamic>> _mapList(dynamic raw) {
    if (raw is! List) return [];
    return raw
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  Future<void> _loadPppSession() async {
    final id = customer['id'];
    if (id == null) return;
    try {
      final res = await ApiClient.get(
        '/api/mobile-adapter/customers/$id/ppp-session',
      );
      if (res.statusCode != 200) return;
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (data['success'] == true && data['data'] is Map) {
        if (!mounted) return;
        setState(() {
          _pppSession = Map<String, dynamic>.from(data['data'] as Map);
        });
      }
    } catch (_) {}
  }

  Future<void> _loadPaymentHistory() async {
    final id = customer['id'];
    if (id == null) {
      setState(() => _paymentHistoryLoading = false);
      return;
    }
    try {
      final res = await ApiClient.get(
        '/api/mobile-adapter/customers/$id/payment-history',
      );
      if (res.statusCode != 200) {
        if (mounted) setState(() => _paymentHistoryLoading = false);
        return;
      }
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      final raw = data['data'];
      if (!mounted) return;
      setState(() {
        _paymentHistory = raw is List
            ? raw
                  .whereType<Map>()
                  .map((e) => Map<String, dynamic>.from(e))
                  .toList()
            : <Map<String, dynamic>>[];
        _paymentHistoryLoading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _paymentHistoryLoading = false);
    }
  }

  Future<void> _changeCustomerStatus(String nextStatus) async {
    final id = customer['id'];
    if (id == null || _statusActionLoading) return;
    setState(() => _statusActionLoading = true);
    try {
      final res = await ApiClient.post(
        '/api/mobile-adapter/customers/$id/status',
        {'status': nextStatus},
      );
      final body = ApiClient.decodeJsonObject(
        res,
        debugLabel: 'customer/status',
      );
      final success =
          res.statusCode == 200 && ApiClient.jsonSuccess(body['success']);
      if (!mounted) return;
      if (success) {
        setState(() {
          customer = {
            ...customer,
            'status': body['data'] is Map
                ? (body['data']['status'] ?? nextStatus)
                : nextStatus,
          };
        });
        _loadPppSession();
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            success
                ? 'Status pelanggan berhasil diperbarui'
                : (body['message']?.toString() ?? 'Gagal memperbarui status'),
          ),
          backgroundColor: success ? Colors.green : Colors.red,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Gagal memperbarui status pelanggan'),
          backgroundColor: Colors.red,
        ),
      );
    } finally {
      if (mounted) setState(() => _statusActionLoading = false);
    }
  }

  Future<void> _ensurePackageOptions() async {
    if (_packageOptions.isNotEmpty) return;
    final res = await ApiClient.get(
      '/api/mobile-adapter/customers/form-options',
    );
    final body = ApiClient.decodeJsonObject(
      res,
      debugLabel: 'customers/form-options',
    );
    if (res.statusCode != 200 || !ApiClient.jsonSuccess(body['success'])) {
      throw Exception(body['message']?.toString() ?? 'Gagal memuat paket');
    }
    final data = body['data'];
    if (!mounted) return;
    setState(() {
      _packageOptions = _mapList(data is Map ? data['packages'] : null);
    });
  }

  Future<void> _saveContactInfo({
    required String name,
    required String phone,
    required String email,
    required String address,
  }) async {
    final id = customer['id'];
    if (id == null || _savingCustomerInfo) return;
    setState(() => _savingCustomerInfo = true);
    try {
      final res =
          await ApiClient.patch('/api/mobile-adapter/customers/$id/contact', {
            'name': name.trim(),
            'phone': phone.trim(),
            'email': email.trim(),
            'address': address.trim(),
          });
      final body = ApiClient.decodeJsonObject(
        res,
        debugLabel: 'customers/contact',
      );
      final success =
          res.statusCode == 200 && ApiClient.jsonSuccess(body['success']);
      if (!mounted) return;
      if (success) {
        setState(() {
          customer = {
            ...customer,
            'name': name.trim(),
            'phone': phone.trim(),
            'email': email.trim(),
            'address': address.trim(),
          };
        });
        Navigator.of(context).pop();
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            success
                ? 'Info kontak berhasil diperbarui'
                : (body['message']?.toString() ?? 'Gagal menyimpan kontak'),
          ),
          backgroundColor: success ? Colors.green : Colors.red,
        ),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Gagal menyimpan info kontak'),
          backgroundColor: Colors.red,
        ),
      );
    } finally {
      if (mounted) setState(() => _savingCustomerInfo = false);
    }
  }

  Future<void> _saveCustomerPackage(int packageId) async {
    final id = customer['id'];
    if (id == null || _savingCustomerInfo) return;
    final package = _packageOptions.firstWhere(
      (item) => _asInt(item['id']) == packageId,
      orElse: () => <String, dynamic>{},
    );
    setState(() => _savingCustomerInfo = true);
    try {
      final res = await ApiClient.patch(
        '/api/mobile-adapter/customers/$id/package',
        {'package_id': packageId},
      );
      final body = ApiClient.decodeJsonObject(
        res,
        debugLabel: 'customers/package',
      );
      final success =
          res.statusCode == 200 && ApiClient.jsonSuccess(body['success']);
      if (!mounted) return;
      if (success) {
        setState(() {
          customer = {
            ...customer,
            'package_id': packageId,
            'profile': package['name']?.toString() ?? customer['profile'],
          };
        });
        Navigator.of(context).pop();
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            success
                ? 'Paket pelanggan berhasil diperbarui'
                : (body['message']?.toString() ?? 'Gagal menyimpan paket'),
          ),
          backgroundColor: success ? Colors.green : Colors.red,
        ),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Gagal menyimpan paket pelanggan'),
          backgroundColor: Colors.red,
        ),
      );
    } finally {
      if (mounted) setState(() => _savingCustomerInfo = false);
    }
  }

  int? _asInt(dynamic value) {
    if (value is int) return value;
    return int.tryParse(value?.toString() ?? '');
  }

  Future<void> _showEditContactDialog() async {
    final nameCtrl = TextEditingController(
      text: customer['name']?.toString() ?? '',
    );
    final phoneCtrl = TextEditingController(
      text: customer['phone']?.toString() ?? '',
    );
    final emailCtrl = TextEditingController(
      text: customer['email']?.toString() ?? '',
    );
    final addressCtrl = TextEditingController(
      text: customer['address']?.toString() ?? '',
    );
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        title: const Text(
          'Edit Info Kontak',
          style: TextStyle(color: Colors.black, fontWeight: FontWeight.w800),
        ),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              _dialogTextField(nameCtrl, 'Nama pelanggan'),
              const SizedBox(height: 10),
              _dialogTextField(phoneCtrl, 'Nomor HP'),
              const SizedBox(height: 10),
              _dialogTextField(emailCtrl, 'Email'),
              const SizedBox(height: 10),
              _dialogTextField(addressCtrl, 'Alamat', maxLines: 3),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: _savingCustomerInfo
                ? null
                : () => Navigator.of(dialogContext).pop(),
            child: const Text('Batal'),
          ),
          FilledButton(
            onPressed: _savingCustomerInfo
                ? null
                : () => _saveContactInfo(
                    name: nameCtrl.text,
                    phone: phoneCtrl.text,
                    email: emailCtrl.text,
                    address: addressCtrl.text,
                  ),
            child: Text(_savingCustomerInfo ? 'Menyimpan...' : 'Simpan'),
          ),
        ],
      ),
    );
    nameCtrl.dispose();
    phoneCtrl.dispose();
    emailCtrl.dispose();
    addressCtrl.dispose();
  }

  Future<void> _showEditPackageDialog() async {
    try {
      await _ensurePackageOptions();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: Colors.red,
        ),
      );
      return;
    }
    if (!mounted) return;
    int? selectedPackageId = _asInt(customer['package_id']);
    if (selectedPackageId == null && _packageOptions.isNotEmpty) {
      final currentProfile = customer['profile']?.toString();
      for (final item in _packageOptions) {
        if (item['name']?.toString() == currentProfile) {
          selectedPackageId = _asInt(item['id']);
          break;
        }
      }
    }
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          backgroundColor: Colors.white,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(18),
          ),
          title: const Text(
            'Edit Paket Pelanggan',
            style: TextStyle(color: Colors.black, fontWeight: FontWeight.w800),
          ),
          content: DropdownButtonFormField<int>(
            value: selectedPackageId,
            isExpanded: true,
            dropdownColor: Colors.white,
            style: const TextStyle(color: Colors.black),
            decoration: InputDecoration(
              labelText: 'Paket layanan',
              labelStyle: const TextStyle(color: Colors.black87),
              filled: true,
              fillColor: Colors.white,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: const BorderSide(color: Color(0xFFC7D7FE)),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: const BorderSide(
                  color: Color(0xFF2563EB),
                  width: 1.4,
                ),
              ),
            ),
            items: _packageOptions
                .map(
                  (item) => DropdownMenuItem<int>(
                    value: _asInt(item['id']),
                    child: Text(
                      item['name']?.toString() ?? 'Paket',
                      style: const TextStyle(color: Colors.black),
                    ),
                  ),
                )
                .where((item) => item.value != null)
                .toList(),
            onChanged: (value) =>
                setDialogState(() => selectedPackageId = value),
          ),
          actions: [
            TextButton(
              onPressed: _savingCustomerInfo
                  ? null
                  : () => Navigator.of(dialogContext).pop(),
              child: const Text('Batal'),
            ),
            FilledButton(
              onPressed: _savingCustomerInfo || selectedPackageId == null
                  ? null
                  : () => _saveCustomerPackage(selectedPackageId!),
              child: Text(_savingCustomerInfo ? 'Menyimpan...' : 'Simpan'),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final role = context.watch<AuthProvider>().role;
    final isAdmin = role == 'admin';
    final isTechnician = role == 'technician';
    final status = customer['status']?.toString().toLowerCase() ?? 'active';
    final customerLat = _toDouble(customer['latitude']);
    final customerLng = _toDouble(customer['longitude']);

    // Default to active colors
    Color statusColor = const Color(0xFF0D5930); // Dark Green text
    Color statusBgColor = const Color(0xFFD3F5E4); // Light green bg
    Color statusBorderColor = const Color(0xFFB2E9CD);
    String statusLabel = 'Status langganan: Aktif';
    IconData statusIcon = Icons.check_circle;

    if (status == 'suspended') {
      statusColor = const Color(0xFFB45309);
      statusBgColor = const Color(0xFFFFF7ED);
      statusBorderColor = const Color(0xFFFED7AA);
      statusLabel = 'Status langganan: Isolir';
      statusIcon = Icons.block;
    } else if (status == 'isolated') {
      statusColor = const Color(0xFF93000A); // on-error-container
      statusBgColor = const Color(0xFFFFDAD6); // error-container
      statusBorderColor = const Color(0xFFFFB4AB);
      statusLabel = 'Status langganan: Nonaktif';
      statusIcon = Icons.error;
    }

    // Colors from Stitch design
    const bgBackground = Color(0xFFF6FAFF);
    const bgSurfaceContainerLowest = Color(0xFFFFFFFF);
    const bgSurfaceContainer = Color(0xFFEAF2FF);

    const primaryColor = Color(0xFF2563EB);
    const errorContainerColor = Color(0xFFFFDAD6);
    const textOnErrorContainer = Color(0xFF93000A);

    const textOnBackground = Color(0xFF19163F);
    const textOnSurfaceVariant = Color(0xFF474551);
    const textOnPrimary = Color(0xFFFFFFFF);
    const outlineVariant = Color(0xFFC7D7FE);
    const outline = Color(0xFF787582);
    const surfaceTint = Color(0xFF2E9DEB);

    return Scaffold(
      backgroundColor: bgBackground,
      appBar: AppBar(
        backgroundColor: const Color(0xFF2563EB),
        foregroundColor: Colors.white,
        elevation: 0,
        scrolledUnderElevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.white),
          onPressed: () => Navigator.pop(context),
        ),
        title: const Text(
          'Customer Detail',
          style: TextStyle(
            color: Colors.white,
            fontSize: 18,
            fontWeight: FontWeight.bold,
          ),
        ),
        centerTitle: true,
        actions: [
          IconButton(
            icon: const Icon(Icons.more_vert, color: Colors.white),
            onPressed: () {},
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(color: Colors.white24, height: 1),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(14.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Profile Header Area
            Container(
              decoration: BoxDecoration(
                color: bgSurfaceContainer,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: outlineVariant),
              ),
              child: Stack(
                children: [
                  Container(
                    height: 54,
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [
                          surfaceTint.withValues(alpha: 0.16),
                          Colors.transparent,
                        ],
                      ),
                      borderRadius: const BorderRadius.vertical(
                        top: Radius.circular(12),
                      ),
                    ),
                  ),
                  SizedBox(
                    width: double.infinity,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(14, 14, 14, 12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          Container(
                            width: 74,
                            height: 74,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              border: Border.all(
                                color: bgSurfaceContainerLowest,
                                width: 3,
                              ),
                              boxShadow: [
                                BoxShadow(
                                  color: Colors.black.withValues(alpha: 0.05),
                                  blurRadius: 4,
                                  offset: const Offset(0, 2),
                                ),
                              ],
                              image: const DecorationImage(
                                image: NetworkImage(
                                  'https://via.placeholder.com/150',
                                ), // Placeholder avatar
                                fit: BoxFit.cover,
                              ),
                            ),
                          ),
                          const SizedBox(height: 10),
                          Text(
                            customer['name'] ?? 'Unknown Customer',
                            style: const TextStyle(
                              fontSize: 19,
                              fontWeight: FontWeight.w700,
                              color: textOnBackground,
                            ),
                            textAlign: TextAlign.center,
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'ID: ${customer['customer_id'] ?? '-'}',
                            style: const TextStyle(
                              fontSize: 12,
                              color: textOnSurfaceVariant,
                            ),
                            textAlign: TextAlign.center,
                          ),
                          const SizedBox(height: 8),
                          Wrap(
                            spacing: 8,
                            runSpacing: 8,
                            alignment: WrapAlignment.center,
                            children: [
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 10,
                                  vertical: 4,
                                ),
                                decoration: BoxDecoration(
                                  color: statusBgColor,
                                  borderRadius: BorderRadius.circular(16),
                                  border: Border.all(color: statusBorderColor),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Icon(
                                      statusIcon,
                                      size: 13,
                                      color: statusColor,
                                    ),
                                    const SizedBox(width: 4),
                                    Text(
                                      statusLabel,
                                      style: TextStyle(
                                        fontSize: 12,
                                        fontWeight: FontWeight.bold,
                                        color: statusColor,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),

            const SizedBox(height: 12),

            // Primary Actions
            if (isAdmin)
              Row(
                children: [
                  Expanded(
                    child: _statusActionButton(
                      label: 'Aktifkan',
                      icon: Icons.power_settings_new,
                      bgColor: primaryColor,
                      fgColor: textOnPrimary,
                      onPressed: () => _changeCustomerStatus('active'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _statusActionButton(
                      label: 'Nonaktifkan',
                      icon: Icons.power_off_rounded,
                      bgColor: bgSurfaceContainerLowest,
                      fgColor: textOnBackground,
                      borderColor: primaryColor,
                      onPressed: () => _changeCustomerStatus('isolated'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _statusActionButton(
                      label: 'Isolir',
                      icon: Icons.block,
                      bgColor: errorContainerColor,
                      fgColor: textOnErrorContainer,
                      borderColor: const Color(0xFFFFB4AB),
                      onPressed: () => _changeCustomerStatus('suspended'),
                    ),
                  ),
                ],
              ),

            const SizedBox(height: 14),

            // Info Kontak
            Container(
              decoration: BoxDecoration(
                color: bgSurfaceContainerLowest,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: outlineVariant),
              ),
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Row(
                        children: [
                          Icon(Icons.contact_mail, color: surfaceTint),
                          SizedBox(width: 8),
                          Text(
                            'Info Kontak',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                              color: textOnBackground,
                            ),
                          ),
                        ],
                      ),
                      if (!isTechnician)
                        InkWell(
                          onTap: _showEditContactDialog,
                          borderRadius: BorderRadius.circular(10),
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 10,
                              vertical: 6,
                            ),
                            decoration: BoxDecoration(
                              color: bgSurfaceContainer,
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(color: outlineVariant),
                            ),
                            child: const Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(Icons.edit, color: surfaceTint, size: 17),
                                SizedBox(height: 1),
                                Text(
                                  'Edit',
                                  style: TextStyle(
                                    fontSize: 10,
                                    fontWeight: FontWeight.w800,
                                    color: surfaceTint,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                    ],
                  ),
                  const Divider(height: 16, color: outlineVariant),
                  _buildInfoRow(
                    Icons.call,
                    'PRIMARY PHONE',
                    customer['phone'] ?? '-',
                    textOnBackground,
                    textOnSurfaceVariant,
                    outline,
                    onValueTap: () {
                      final p = _pickString(customer, [
                        'phone',
                        'mobile',
                        'tel',
                        'phone_number',
                      ]);
                      final display = p.isNotEmpty
                          ? p
                          : (customer['phone']?.toString().trim() ?? '');
                      if (display.isEmpty || display == '-') return;
                      _openWhatsAppForPhone(display);
                    },
                  ),
                  const SizedBox(height: 10),
                  _buildInfoRow(
                    Icons.mail,
                    'EMAIL ADDRESS',
                    () {
                      final e = _pickString(customer, [
                        'email',
                        'contact_email',
                        'mail',
                      ]);
                      return e.isEmpty ? '-' : e;
                    }(),
                    textOnBackground,
                    textOnSurfaceVariant,
                    outline,
                  ),
                  const SizedBox(height: 10),
                  _buildInfoRow(
                    Icons.location_on,
                    'SERVICE ADDRESS',
                    customer['address'] ?? '-',
                    textOnBackground,
                    textOnSurfaceVariant,
                    outline,
                  ),

                  const SizedBox(height: 10),
                  if (customerLat != null && customerLng != null)
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Text(
                          'LOKASI PELANGGAN',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.bold,
                            color: textOnSurfaceVariant,
                            letterSpacing: 1.1,
                          ),
                        ),
                        const SizedBox(height: 6),
                        Container(
                          height: 105,
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: outlineVariant),
                          ),
                          clipBehavior: Clip.antiAlias,
                          child: FlutterMap(
                            options: MapOptions(
                              initialCenter: LatLng(customerLat, customerLng),
                              initialZoom: 15.5,
                              interactionOptions: const InteractionOptions(
                                flags: InteractiveFlag.none,
                              ),
                            ),
                            children: [
                              TileLayer(
                                urlTemplate:
                                    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                                userAgentPackageName:
                                    'com.example.billing_kalimasada_mobile',
                              ),
                              MarkerLayer(
                                markers: [
                                  Marker(
                                    point: LatLng(customerLat, customerLng),
                                    width: 28,
                                    height: 28,
                                    child: const Center(
                                      child: Icon(
                                        Icons.location_on,
                                        color: Color(0xFFE53935),
                                        size: 26,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 10),
                      ],
                    ),
                  OutlinedButton.icon(
                    onPressed: (customerLat != null && customerLng != null)
                        ? () => _openGoogleMapsDirections(
                            customerLat,
                            customerLng,
                          )
                        : null,
                    icon: Icon(
                      customer['latitude'] != null
                          ? Icons.edit_location
                          : Icons.my_location,
                      color: surfaceTint,
                      size: 20,
                    ),
                    label: const Text(
                      'Dapatkan Arah',
                      style: TextStyle(
                        color: textOnBackground,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    style: OutlinedButton.styleFrom(
                      backgroundColor: Colors.transparent,
                      side: const BorderSide(color: outlineVariant),
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                      minimumSize: const Size.fromHeight(40),
                    ),
                  ),
                ],
              ),
            ),

            const SizedBox(height: 12),

            // Layanan Jaringan
            Container(
              decoration: BoxDecoration(
                color: bgSurfaceContainerLowest,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: outlineVariant),
              ),
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Row(
                        children: [
                          Icon(Icons.router, color: surfaceTint),
                          SizedBox(width: 8),
                          Text(
                            'Layanan Jaringan',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                              color: textOnBackground,
                            ),
                          ),
                        ],
                      ),
                      if (!isTechnician)
                        InkWell(
                          onTap: _showEditPackageDialog,
                          borderRadius: BorderRadius.circular(10),
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 10,
                              vertical: 6,
                            ),
                            decoration: BoxDecoration(
                              color: bgSurfaceContainer,
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(color: outlineVariant),
                            ),
                            child: const Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(Icons.edit, color: surfaceTint, size: 17),
                                SizedBox(height: 1),
                                Text(
                                  'Edit',
                                  style: TextStyle(
                                    fontSize: 10,
                                    fontWeight: FontWeight.w800,
                                    color: surfaceTint,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                    ],
                  ),
                  const Divider(height: 16, color: outlineVariant),

                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: bgSurfaceContainer,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: outlineVariant),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(Icons.speed, color: surfaceTint),
                        const SizedBox(width: 12),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'SERVICE PLAN',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.bold,
                                color: textOnSurfaceVariant,
                                letterSpacing: 1.1,
                              ),
                            ),
                            Text(
                              customer['profile'] ?? 'Standard Package',
                              style: const TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w600,
                                color: textOnBackground,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),

                  const SizedBox(height: 10),

                  Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'ASSIGNED IP',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.bold,
                                color: textOnSurfaceVariant,
                                letterSpacing: 1.1,
                              ),
                            ),
                            Text(
                              _pppSession?['ip_address']?.toString() ??
                                  customer['ip_address']?.toString() ??
                                  'DHCP/Dynamic',
                              style: const TextStyle(
                                fontSize: 13,
                                color: textOnBackground,
                                fontFamily: 'monospace',
                              ),
                            ),
                          ],
                        ),
                      ),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'MAC ADDRESS',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.bold,
                                color: textOnSurfaceVariant,
                                letterSpacing: 1.1,
                              ),
                            ),
                            Text(
                              () {
                                final mac = _pickString(_pppSession, const [
                                  'mac_address',
                                  'caller-id',
                                  'caller_id',
                                  'callerid',
                                  'mac-address',
                                  'mac',
                                ]);
                                return mac.isEmpty ? '-' : mac;
                              }(),
                              style: const TextStyle(
                                fontSize: 13,
                                color: textOnBackground,
                                fontFamily: 'monospace',
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),

                  const SizedBox(height: 10),

                  Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'IP PPPoE ACTIVE',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.bold,
                                color: textOnSurfaceVariant,
                                letterSpacing: 1.1,
                              ),
                            ),
                            Text(
                              _pppSession?['ip_address']?.toString() ?? '-',
                              style: const TextStyle(
                                fontSize: 13,
                                color: textOnBackground,
                                fontFamily: 'monospace',
                              ),
                            ),
                          ],
                        ),
                      ),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'UPTIME PPPoE ACTIVE',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.bold,
                                color: textOnSurfaceVariant,
                                letterSpacing: 1.1,
                              ),
                            ),
                            Text(
                              () {
                                final uptime = _pickString(_pppSession, const [
                                  'uptime',
                                  'session_time',
                                ]);
                                return uptime.isEmpty
                                    ? '-'
                                    : _formatUptimeDdHhMmSs(uptime);
                              }(),
                              style: const TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                                color: Color(0xFF16A34A),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),

            if (!isTechnician) ...[
              const SizedBox(height: 14),
              _buildPaymentHistorySection(
                bgSurfaceContainerLowest,
                bgSurfaceContainer,
                outlineVariant,
                textOnBackground,
                textOnSurfaceVariant,
                surfaceTint,
              ),
            ],

            const SizedBox(height: 28), // Padding
          ],
        ),
      ),
    );
  }

  Widget _statusActionButton({
    required String label,
    required IconData icon,
    required Color bgColor,
    required Color fgColor,
    required VoidCallback onPressed,
    Color? borderColor,
  }) {
    return ElevatedButton.icon(
      onPressed: _statusActionLoading ? null : onPressed,
      icon: _statusActionLoading
          ? SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2, color: fgColor),
            )
          : Icon(icon, color: fgColor, size: 16),
      label: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: fgColor,
          fontSize: 11,
          fontWeight: FontWeight.w800,
        ),
      ),
      style: ElevatedButton.styleFrom(
        backgroundColor: bgColor,
        foregroundColor: fgColor,
        disabledBackgroundColor: bgColor.withValues(alpha: 0.55),
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 6),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: borderColor == null
              ? BorderSide.none
              : BorderSide(color: borderColor),
        ),
        elevation: borderColor == null ? 1 : 0,
      ),
    );
  }

  Widget _dialogTextField(
    TextEditingController controller,
    String label, {
    int maxLines = 1,
  }) {
    return TextField(
      controller: controller,
      maxLines: maxLines,
      style: const TextStyle(color: Colors.black),
      cursorColor: const Color(0xFF2563EB),
      decoration: InputDecoration(
        labelText: label,
        labelStyle: const TextStyle(color: Colors.black87),
        floatingLabelStyle: const TextStyle(color: Color(0xFF2563EB)),
        hintStyle: const TextStyle(color: Colors.black54),
        filled: true,
        fillColor: Colors.white,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: Color(0xFFC7D7FE)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: Color(0xFF2563EB), width: 1.4),
        ),
      ),
    );
  }

  Widget _buildPaymentHistorySection(
    Color bgColor,
    Color softBgColor,
    Color borderColor,
    Color textColor,
    Color mutedColor,
    Color accentColor,
  ) {
    return Container(
      decoration: BoxDecoration(
        color: bgColor,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: borderColor),
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.receipt_long_rounded, color: accentColor, size: 18),
              const SizedBox(width: 8),
              Text(
                'Riwayat Pembayaran',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w800,
                  color: textColor,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          if (_paymentHistoryLoading)
            const Center(
              child: Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            )
          else if (_paymentHistory.isEmpty)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: softBgColor,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                'Belum ada riwayat pembayaran.',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: mutedColor,
                ),
              ),
            )
          else
            ..._paymentHistory
                .take(8)
                .map(
                  (item) => _paymentHistoryTile(
                    item,
                    softBgColor,
                    borderColor,
                    textColor,
                    mutedColor,
                  ),
                ),
        ],
      ),
    );
  }

  Widget _paymentHistoryTile(
    Map<String, dynamic> item,
    Color bgColor,
    Color borderColor,
    Color textColor,
    Color mutedColor,
  ) {
    final status = item['status']?.toString().toLowerCase() ?? '';
    final isPaid = status == 'paid' || status == 'lunas';
    final color = isPaid ? const Color(0xFF16A34A) : const Color(0xFFBA1A1A);
    final amount = _money.format(_numVal(item['amount']));
    final date = _formatDate(
      item['payment_date'] ?? item['due_date'] ?? item['created_at'],
    );
    final invoice = item['invoice_number']?.toString().trim();

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
      decoration: BoxDecoration(
        color: bgColor,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: borderColor.withValues(alpha: 0.75)),
      ),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 38,
            decoration: BoxDecoration(
              color: color,
              borderRadius: BorderRadius.circular(6),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  invoice == null || invoice.isEmpty ? 'Invoice' : invoice,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                    color: textColor,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  date,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: mutedColor,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                amount,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w900,
                  color: textColor,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                isPaid ? 'Lunas' : 'Belum bayar',
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w800,
                  color: color,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildInfoRow(
    IconData icon,
    String label,
    String value,
    Color textColor,
    Color labelColor,
    Color iconColor, {
    VoidCallback? onValueTap,
  }) {
    final trimmed = value.trim();
    final canTap = onValueTap != null && trimmed.isNotEmpty && trimmed != '-';
    final valueStyle = TextStyle(
      fontSize: 16,
      color: canTap ? const Color(0xFF128C7E) : textColor,
      fontWeight: canTap ? FontWeight.w600 : FontWeight.w400,
      decoration: canTap ? TextDecoration.underline : TextDecoration.none,
      decorationColor: const Color(0xFF128C7E),
    );
    final valueWidget = Text(value, style: valueStyle);

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Icon(icon, color: iconColor, size: 20),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                  color: labelColor,
                  letterSpacing: 1.1,
                ),
              ),
              const SizedBox(height: 2),
              if (canTap)
                InkWell(
                  onTap: onValueTap,
                  borderRadius: BorderRadius.circular(4),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Flexible(child: valueWidget),
                        const SizedBox(width: 6),
                        Icon(Icons.chat, size: 18, color: valueStyle.color),
                      ],
                    ),
                  ),
                )
              else
                valueWidget,
            ],
          ),
        ),
      ],
    );
  }
}

class _TagLocationDialog extends StatefulWidget {
  final Map<String, dynamic> customer;
  const _TagLocationDialog({required this.customer});

  @override
  State<_TagLocationDialog> createState() => _TagLocationDialogState();
}

class _TagLocationDialogState extends State<_TagLocationDialog>
    with SingleTickerProviderStateMixin {
  LatLng? _selectedLocation;
  LatLng? _currentLocation;
  bool _isLocating = false;
  final MapController _mapController = MapController();
  late LatLng _defaultLocation;
  late final AnimationController _gpsPulseController;

  @override
  void initState() {
    super.initState();
    _gpsPulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1700),
    )..repeat();
    if (widget.customer['latitude'] != null &&
        widget.customer['longitude'] != null) {
      _defaultLocation = LatLng(
        widget.customer['latitude'] as double,
        widget.customer['longitude'] as double,
      );
      _selectedLocation = _defaultLocation;
    } else {
      _defaultLocation = const LatLng(-7.404620, 109.724536);
    }
    _loadCurrentLocation(showError: false);
  }

  @override
  void dispose() {
    _gpsPulseController.dispose();
    super.dispose();
  }

  Widget _buildGpsPulseMarker() {
    return AnimatedBuilder(
      animation: _gpsPulseController,
      builder: (context, _) {
        final pulse = Curves.easeOut.transform(_gpsPulseController.value);
        final ringScale = 1.0 + (pulse * 1.2);
        final ringOpacity = (0.30 * (1 - pulse)).clamp(0.0, 1.0);
        return SizedBox(
          width: 42,
          height: 42,
          child: Stack(
            alignment: Alignment.center,
            children: [
              Transform.scale(
                scale: ringScale,
                child: Container(
                  width: 24,
                  height: 24,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: const Color(
                      0xFF1A73E8,
                    ).withValues(alpha: ringOpacity),
                  ),
                ),
              ),
              Container(
                width: 16,
                height: 16,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: const Color(0xFF1A73E8),
                  border: Border.all(color: Colors.white, width: 2),
                  boxShadow: const [
                    BoxShadow(
                      color: Colors.black26,
                      blurRadius: 4,
                      offset: Offset(0, 1),
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _loadCurrentLocation({bool showError = true}) async {
    if (_isLocating) return;
    setState(() => _isLocating = true);
    try {
      final serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        if (showError && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text(
                'GPS belum aktif. Silakan aktifkan lokasi di perangkat.',
              ),
              backgroundColor: Colors.red,
            ),
          );
        }
        return;
      }

      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        if (showError && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text(
                'Izin lokasi ditolak. Berikan izin lokasi untuk fitur ini.',
              ),
              backgroundColor: Colors.red,
            ),
          );
        }
        return;
      }

      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
        ),
      );
      if (!mounted) return;
      final point = LatLng(pos.latitude, pos.longitude);
      setState(() {
        _currentLocation = point;
      });
      _mapController.move(point, 18.0);
    } catch (_) {
      if (showError && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Gagal mengambil lokasi GPS saat ini.'),
            backgroundColor: Colors.red,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isLocating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: const Color(0xFFFCF8FF),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'Tambahkan Lokasi Pelanggan',
              style: TextStyle(
                color: Color(0xFF2563EB),
                fontSize: 16,
                fontWeight: FontWeight.bold,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 16),
            Container(
              height: 300,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: const Color(0xFFC8C4D3)),
              ),
              clipBehavior: Clip.antiAlias,
              child: Stack(
                children: [
                  FlutterMap(
                    mapController: _mapController,
                    options: MapOptions(
                      initialCenter: _defaultLocation,
                      initialZoom: 15.0,
                      onTap: (tapPosition, point) {
                        setState(() {
                          _selectedLocation = point;
                        });
                      },
                    ),
                    children: [
                      TileLayer(
                        urlTemplate:
                            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                        userAgentPackageName:
                            'com.example.billing_kalimasada_mobile',
                      ),
                      if (_currentLocation != null)
                        MarkerLayer(
                          markers: [
                            Marker(
                              point: _currentLocation!,
                              width: 34,
                              height: 34,
                              child: _buildGpsPulseMarker(),
                            ),
                          ],
                        ),
                      if (_selectedLocation != null)
                        MarkerLayer(
                          markers: [
                            Marker(
                              point: _selectedLocation!,
                              width: 36,
                              height: 36,
                              child: Container(
                                decoration: BoxDecoration(
                                  color: Colors.white,
                                  borderRadius: BorderRadius.circular(10),
                                  boxShadow: const [
                                    BoxShadow(
                                      color: Colors.black26,
                                      blurRadius: 4,
                                      offset: Offset(0, 2),
                                    ),
                                  ],
                                ),
                                child: const Center(
                                  child: Icon(
                                    Icons.wifi,
                                    color: Colors.green,
                                    size: 22,
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                    ],
                  ),
                  Positioned(
                    right: 12,
                    bottom: 12,
                    child: Material(
                      color: Colors.white,
                      shape: const CircleBorder(),
                      elevation: 2,
                      child: IconButton(
                        tooltip: 'My Location',
                        onPressed: _isLocating
                            ? null
                            : () => _loadCurrentLocation(),
                        icon: _isLocating
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(
                                Icons.my_location,
                                color: Color(0xFF2563EB),
                              ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: _selectedLocation == null
                  ? null
                  : () async {
                      showDialog(
                        context: context,
                        barrierDismissible: false,
                        builder: (context) =>
                            const Center(child: CircularProgressIndicator()),
                      );

                      final success = await context
                          .read<CustomerProvider>()
                          .updateLocation(
                            widget.customer['id'].toString(),
                            _selectedLocation!.latitude,
                            _selectedLocation!.longitude,
                          );

                      if (context.mounted) {
                        Navigator.pop(context); // Close loading dialog
                      }

                      if (success && context.mounted) {
                        Navigator.pop(
                          context,
                          _selectedLocation,
                        ); // Close tag dialog and return new location
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text('Lokasi Pelanggan Berhasil Disimpan'),
                            backgroundColor: Colors.green,
                          ),
                        );
                      } else if (context.mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text('Gagal menyimpan lokasi'),
                            backgroundColor: Colors.red,
                          ),
                        );
                      }
                    },
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF2563EB),
                foregroundColor: Colors.white,
                minimumSize: const Size.fromHeight(48),
              ),
              child: const Text(
                'Simpan Lokasi Pelanggan',
                style: TextStyle(fontWeight: FontWeight.bold),
              ),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text(
                'Batal',
                style: TextStyle(color: Color(0xFF2563EB)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
