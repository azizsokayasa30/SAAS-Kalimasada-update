import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';

import '../services/api_client.dart';
import 'new_task_screen.dart';

class AddNewCustomerScreen extends StatefulWidget {
  const AddNewCustomerScreen({super.key});

  @override
  State<AddNewCustomerScreen> createState() => _AddNewCustomerScreenState();
}

class _AddNewCustomerScreenState extends State<AddNewCustomerScreen> {
  static const _primary = Color(0xFF2563EB);
  static const _bg = Color(0xFFF4F6FA);
  static const _outline = Color(0xFFE2E8F0);
  static const _text = Color(0xFF0F172A);
  static const _muted = Color(0xFF64748B);

  final _formKey = GlobalKey<FormState>();
  final _nameCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _usernameCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _addressCtrl = TextEditingController();
  final _latitudeCtrl = TextEditingController();
  final _longitudeCtrl = TextEditingController();
  final _pppoeUsernameCtrl = TextEditingController();
  final _pppoePasswordCtrl = TextEditingController();
  final _staticIpCtrl = TextEditingController();
  final _assignedIpCtrl = TextEditingController();
  final _macAddressCtrl = TextEditingController();

  bool _loadingOptions = true;
  String? _savingMode;
  bool _createPppoeNow = false;
  String? _error;
  int? _selectedPackageId;
  int? _selectedAreaId;
  int? _selectedOdpId;
  String _selectedProfile = 'default';
  List<Map<String, dynamic>> _packages = [];
  List<Map<String, dynamic>> _areas = [];
  List<Map<String, dynamic>> _odps = [];
  List<Map<String, dynamic>> _profiles = [
    {'name': 'default'},
  ];

  @override
  void initState() {
    super.initState();
    _loadOptions();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _phoneCtrl.dispose();
    _usernameCtrl.dispose();
    _emailCtrl.dispose();
    _addressCtrl.dispose();
    _latitudeCtrl.dispose();
    _longitudeCtrl.dispose();
    _pppoeUsernameCtrl.dispose();
    _pppoePasswordCtrl.dispose();
    _staticIpCtrl.dispose();
    _assignedIpCtrl.dispose();
    _macAddressCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadOptions() async {
    setState(() {
      _loadingOptions = true;
      _error = null;
    });
    try {
      final body = await _fetchOptionsBody();
      final statusCode = body['_statusCode'] is int
          ? body['_statusCode'] as int
          : 0;
      if (statusCode != 200 || !ApiClient.jsonSuccess(body['success'])) {
        throw Exception(
          body['message']?.toString() ?? 'Gagal memuat opsi form',
        );
      }
      final data = body['data'] is Map ? body['data'] as Map : const {};
      setState(() {
        _packages = _mapList(data['packages']);
        _areas = _mapList(data['areas']);
        _odps = _mapList(data['odps']);
        final profiles = _mapList(data['pppoe_profiles']);
        _profiles = profiles.isEmpty
            ? [
                {'name': 'default'},
              ]
            : profiles;
        if (!_profiles.any((p) => p['name']?.toString() == _selectedProfile)) {
          _selectedProfile = _profiles.first['name']?.toString() ?? 'default';
        }
        _loadingOptions = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString().replaceFirst('Exception: ', '');
        _loadingOptions = false;
      });
    }
  }

  Future<Map<String, dynamic>> _fetchOptionsBody() async {
    const endpoints = [
      '/api/mobile-adapter/customers/form-options',
      '/api/mobile-adapter/customers/form-option',
      '/api/mobile-adapter/customers/options',
    ];
    Object? lastError;
    for (final endpoint in endpoints) {
      try {
        final response = await ApiClient.get(endpoint);
        final body = ApiClient.decodeJsonObject(response, debugLabel: endpoint);
        body['_statusCode'] = response.statusCode;
        return body;
      } catch (e) {
        lastError = e;
      }
    }
    throw Exception(
      'Opsi form pelanggan belum tersedia dari server. Restart/deploy server billing lalu coba lagi. Detail: $lastError',
    );
  }

  List<Map<String, dynamic>> _mapList(dynamic raw) {
    if (raw is! List) return [];
    return raw
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  void _selectPackage(int? packageId) {
    Map<String, dynamic>? package;
    for (final item in _packages) {
      if (_asInt(item['id']) == packageId) {
        package = item;
        break;
      }
    }
    final profile = package?['pppoe_profile']?.toString().trim();
    setState(() {
      _selectedPackageId = packageId;
      if (profile != null && profile.isNotEmpty) {
        _selectedProfile = profile;
        if (!_profiles.any((p) => p['name']?.toString() == profile)) {
          _profiles = [
            ..._profiles,
            {'name': profile},
          ];
        }
      }
    });
  }

  void _uppercaseName(String value) {
    final upper = value.toUpperCase();
    if (value == upper) return;
    _nameCtrl.value = TextEditingValue(
      text: upper,
      selection: TextSelection.collapsed(offset: upper.length),
    );
  }

  String _formatMoney(dynamic value) {
    final number = value is num ? value : num.tryParse(value?.toString() ?? '');
    if (number == null) return 'Rp 0';
    final raw = number.round().toString();
    final buffer = StringBuffer();
    for (var i = 0; i < raw.length; i++) {
      if (i > 0 && (raw.length - i) % 3 == 0) buffer.write('.');
      buffer.write(raw[i]);
    }
    return 'Rp ${buffer.toString()}';
  }

  Future<void> _useCurrentLocation() async {
    try {
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        _showSnack('Izin lokasi belum diberikan');
        return;
      }
      final pos = await Geolocator.getCurrentPosition();
      setState(() {
        _latitudeCtrl.text = pos.latitude.toStringAsFixed(8);
        _longitudeCtrl.text = pos.longitude.toStringAsFixed(8);
      });
    } catch (e) {
      _showSnack('Gagal mengambil lokasi: $e');
    }
  }

  Future<void> _saveCustomer({bool createTask = false}) async {
    if (!_formKey.currentState!.validate()) return;
    if (_selectedPackageId == null) {
      _showSnack('Paket Internet wajib dipilih');
      return;
    }

    setState(() => _savingMode = createTask ? 'task' : 'save');
    try {
      final payload = <String, dynamic>{
        'name': _nameCtrl.text.trim(),
        'phone': _phoneCtrl.text.trim(),
        'username': _usernameCtrl.text.trim(),
        'email': _emailCtrl.text.trim(),
        'address': _addressCtrl.text.trim(),
        'area_id': _selectedAreaId,
        'latitude': _latitudeCtrl.text.trim(),
        'longitude': _longitudeCtrl.text.trim(),
        'package_id': _selectedPackageId,
        'odp_id': _selectedOdpId,
        'pppoe_username': _pppoeUsernameCtrl.text.trim(),
        'pppoe_profile': _selectedProfile,
        'create_pppoe_now': _createPppoeNow,
        'pppoe_password': _pppoePasswordCtrl.text.trim(),
        'static_ip': _staticIpCtrl.text.trim(),
        'assigned_ip': _assignedIpCtrl.text.trim(),
        'mac_address': _macAddressCtrl.text.trim(),
        'save_mode': createTask ? 'save_and_create_task' : 'save_only',
      };
      final response = await ApiClient.post(
        '/api/mobile-adapter/customers',
        payload,
      );
      final body = ApiClient.decodeJsonObject(
        response,
        debugLabel: 'customers/add',
      );
      if (response.statusCode == 200 &&
          ApiClient.jsonSuccess(body['success'])) {
        if (!mounted) return;
        if (createTask) {
          final prefill = body['prefill_installation'] is Map
              ? Map<String, dynamic>.from(body['prefill_installation'] as Map)
              : <String, dynamic>{};
          _showSnack(
            'Pelanggan berhasil disimpan, mengarahkan ke form buat tugas...',
          );
          Navigator.pushReplacement(
            context,
            MaterialPageRoute(
              builder: (context) => NewTaskScreen(prefillInstallation: prefill),
            ),
          );
        } else {
          _showSnack('Pelanggan berhasil ditambahkan');
          Navigator.pop(context, true);
        }
        return;
      }
      throw Exception(
        body['message']?.toString() ?? 'Gagal menambah pelanggan',
      );
    } catch (e) {
      if (!mounted) return;
      _showSnack(e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _savingMode = null);
    }
  }

  void _showSnack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        backgroundColor: _text,
        content: Text(message, style: const TextStyle(color: Colors.white)),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _primary,
        foregroundColor: Colors.white,
        elevation: 0,
        title: const Text(
          'Tambah Pelanggan',
          style: TextStyle(fontWeight: FontWeight.w800),
        ),
      ),
      body: _loadingOptions
          ? const Center(child: CircularProgressIndicator(color: _primary))
          : RefreshIndicator(
              color: _primary,
              onRefresh: _loadOptions,
              child: Form(
                key: _formKey,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
                  children: [
                    if (_error != null) ...[
                      _ErrorBanner(message: _error!, onRetry: _loadOptions),
                      const SizedBox(height: 12),
                    ],
                    _section(
                      icon: Icons.person,
                      title: 'Informasi Pelanggan',
                      children: [
                        _textField(
                          controller: _nameCtrl,
                          label: 'Nama Lengkap *',
                          validator: _required,
                          textCapitalization: TextCapitalization.characters,
                          onChanged: _uppercaseName,
                        ),
                        _textField(
                          controller: _phoneCtrl,
                          label: 'Nomor Telepon *',
                          keyboardType: TextInputType.phone,
                          validator: _required,
                        ),
                        _textField(
                          controller: _usernameCtrl,
                          label: 'Username',
                          hint: 'Auto-generate jika kosong',
                        ),
                        _textField(
                          controller: _emailCtrl,
                          label: 'Email',
                          keyboardType: TextInputType.emailAddress,
                        ),
                        _dropdown<int>(
                          label: 'Area *',
                          value: _selectedAreaId,
                          items: _areas
                              .map((area) {
                                final id = _asInt(area['id']);
                                final code =
                                    area['kode_area']?.toString() ?? '';
                                return DropdownMenuItem<int>(
                                  value: id,
                                  child: Text(
                                    '${area['nama_area'] ?? '-'}'
                                    '${code.isNotEmpty ? ' ($code)' : ''}',
                                    style: const TextStyle(color: _text),
                                  ),
                                );
                              })
                              .where((item) => item.value != null)
                              .toList(),
                          onChanged: (value) =>
                              setState(() => _selectedAreaId = value),
                          validator: (value) =>
                              value == null ? 'Area wajib dipilih' : null,
                        ),
                        _textField(
                          controller: _addressCtrl,
                          label: 'Alamat',
                          maxLines: 3,
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    _section(
                      icon: Icons.location_on,
                      title: 'Lokasi',
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: _textField(
                                controller: _latitudeCtrl,
                                label: 'Latitude',
                                keyboardType:
                                    const TextInputType.numberWithOptions(
                                      decimal: true,
                                      signed: true,
                                    ),
                              ),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: _textField(
                                controller: _longitudeCtrl,
                                label: 'Longitude',
                                keyboardType:
                                    const TextInputType.numberWithOptions(
                                      decimal: true,
                                      signed: true,
                                    ),
                              ),
                            ),
                          ],
                        ),
                        OutlinedButton.icon(
                          onPressed: _useCurrentLocation,
                          icon: const Icon(Icons.my_location),
                          label: const Text('Ambil Lokasi GPS'),
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    _section(
                      icon: Icons.router,
                      title: 'Layanan & Jaringan',
                      children: [
                        _dropdown<int>(
                          label: 'Paket Internet *',
                          value: _selectedPackageId,
                          items: _packages
                              .map((pkg) {
                                final id = _asInt(pkg['id']);
                                return DropdownMenuItem<int>(
                                  value: id,
                                  child: Text(
                                    '${pkg['name'] ?? '-'}'
                                    ' - ${_formatMoney(pkg['price'])}',
                                    style: const TextStyle(color: _text),
                                  ),
                                );
                              })
                              .where((item) => item.value != null)
                              .toList(),
                          onChanged: _selectPackage,
                          validator: (value) => value == null
                              ? 'Paket Internet wajib dipilih'
                              : null,
                        ),
                        _dropdown<String>(
                          label: 'PPPoE Profile (dari MikroTik)',
                          value: _selectedProfile,
                          items: _profiles
                              .map(
                                (profile) => DropdownMenuItem<String>(
                                  value:
                                      profile['name']?.toString() ?? 'default',
                                  child: Text(
                                    profile['name']?.toString() ?? 'default',
                                    style: const TextStyle(color: _text),
                                  ),
                                ),
                              )
                              .toList(),
                          onChanged: (value) => setState(
                            () => _selectedProfile = value ?? 'default',
                          ),
                        ),
                        _textField(
                          controller: _pppoeUsernameCtrl,
                          label: 'Username PPPoE',
                          hint: 'Jika kosong, gunakan username pelanggan',
                        ),
                        if (_createPppoeNow)
                          _textField(
                            controller: _pppoePasswordCtrl,
                            label: 'Password PPPoE',
                            hint: 'Kosongkan untuk samakan dengan username',
                            obscureText: true,
                          ),
                        SwitchListTile(
                          contentPadding: EdgeInsets.zero,
                          value: _createPppoeNow,
                          activeThumbColor: _primary,
                          title: const Text(
                            'Buat PPPoE di MikroTik sekarang?',
                            style: TextStyle(color: _text),
                          ),
                          subtitle: const Text(
                            'Secret PPPoE dibuat saat simpan',
                            style: TextStyle(color: _muted),
                          ),
                          onChanged: (value) =>
                              setState(() => _createPppoeNow = value),
                        ),
                        _dropdown<int>(
                          label: 'ODP (Opsional)',
                          value: _selectedOdpId,
                          items: [
                            const DropdownMenuItem<int>(
                              value: null,
                              child: Text(
                                'Pilih ODP (Opsional)',
                                style: TextStyle(color: _text),
                              ),
                            ),
                            ..._odps
                                .map((odp) {
                                  final id = _asInt(odp['id']);
                                  final used = odp['used_ports'] ?? 0;
                                  final cap = odp['capacity'] ?? 0;
                                  return DropdownMenuItem<int>(
                                    value: id,
                                    child: Text(
                                      '${odp['name'] ?? '-'} (${odp['code'] ?? '-'}) - $used/$cap ports',
                                      style: const TextStyle(color: _text),
                                    ),
                                  );
                                })
                                .where((item) => item.value != null),
                          ],
                          onChanged: (value) =>
                              setState(() => _selectedOdpId = value),
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    _section(
                      icon: Icons.settings_ethernet,
                      title: 'Opsional Teknis',
                      children: [
                        _textField(
                          controller: _macAddressCtrl,
                          label: 'MAC Address',
                          hint: 'XX:XX:XX:XX:XX:XX',
                        ),
                        _textField(
                          controller: _staticIpCtrl,
                          label: 'Static IP',
                        ),
                        _textField(
                          controller: _assignedIpCtrl,
                          label: 'Assigned IP',
                        ),
                      ],
                    ),
                    const SizedBox(height: 18),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        FilledButton.icon(
                          onPressed: _savingMode != null
                              ? null
                              : () => _saveCustomer(createTask: true),
                          style: FilledButton.styleFrom(
                            minimumSize: const Size.fromHeight(50),
                            backgroundColor: const Color(0xFF16A34A),
                            foregroundColor: Colors.white,
                            disabledBackgroundColor: const Color(
                              0xFF16A34A,
                            ).withValues(alpha: 0.55),
                            disabledForegroundColor: Colors.white,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12),
                            ),
                          ),
                          icon: _savingMode == 'task'
                              ? const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white,
                                  ),
                                )
                              : const Icon(Icons.assignment_add),
                          label: Text(
                            _savingMode == 'task'
                                ? 'Menyimpan...'
                                : 'Simpan & Buat Tugas',
                            textAlign: TextAlign.center,
                          ),
                        ),
                        const SizedBox(height: 10),
                        Row(
                          children: [
                            Expanded(
                              child: OutlinedButton(
                                onPressed: _savingMode != null
                                    ? null
                                    : () => Navigator.pop(context),
                                style: OutlinedButton.styleFrom(
                                  minimumSize: const Size.fromHeight(46),
                                  foregroundColor: _text,
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(12),
                                  ),
                                ),
                                child: const Text('Batal'),
                              ),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: FilledButton.icon(
                                onPressed: _savingMode != null
                                    ? null
                                    : () => _saveCustomer(),
                                style: FilledButton.styleFrom(
                                  minimumSize: const Size.fromHeight(46),
                                  backgroundColor: _primary,
                                  foregroundColor: Colors.white,
                                  disabledBackgroundColor: _primary.withValues(
                                    alpha: 0.55,
                                  ),
                                  disabledForegroundColor: Colors.white,
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(12),
                                  ),
                                ),
                                icon: _savingMode == 'save'
                                    ? const SizedBox(
                                        width: 16,
                                        height: 16,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                          color: Colors.white,
                                        ),
                                      )
                                    : const Icon(Icons.save),
                                label: Text(
                                  _savingMode == 'save'
                                      ? 'Menyimpan...'
                                      : 'Simpan',
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
    );
  }

  int? _asInt(dynamic value) {
    if (value is int) return value;
    return int.tryParse(value?.toString() ?? '');
  }

  String? _required(String? value) {
    if (value == null || value.trim().isEmpty) return 'Wajib diisi';
    return null;
  }

  Widget _section({
    required IconData icon,
    required String title,
    required List<Widget> children,
  }) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _outline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, color: _primary),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  title,
                  style: const TextStyle(
                    color: _text,
                    fontSize: 18,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ],
          ),
          const Divider(height: 24, color: _outline),
          ...children
              .expand((child) => [child, const SizedBox(height: 12)])
              .toList()
            ..removeLast(),
        ],
      ),
    );
  }

  Widget _textField({
    required TextEditingController controller,
    required String label,
    String? hint,
    int maxLines = 1,
    bool obscureText = false,
    TextInputType keyboardType = TextInputType.text,
    TextCapitalization textCapitalization = TextCapitalization.none,
    ValueChanged<String>? onChanged,
    String? Function(String?)? validator,
  }) {
    return TextFormField(
      controller: controller,
      maxLines: obscureText ? 1 : maxLines,
      obscureText: obscureText,
      keyboardType: keyboardType,
      textCapitalization: textCapitalization,
      onChanged: onChanged,
      validator: validator,
      style: const TextStyle(color: _text),
      cursorColor: _primary,
      decoration: _inputDecoration(label, hint),
    );
  }

  Widget _dropdown<T>({
    required String label,
    required T? value,
    required List<DropdownMenuItem<T>> items,
    required ValueChanged<T?> onChanged,
    String? Function(T?)? validator,
  }) {
    return DropdownButtonFormField<T>(
      key: ValueKey('$label-$value-${items.length}'),
      initialValue: value,
      isExpanded: true,
      dropdownColor: Colors.white,
      style: const TextStyle(color: _text),
      iconEnabledColor: _text,
      iconDisabledColor: _muted,
      decoration: _inputDecoration(label, null),
      items: items,
      validator: validator,
      onChanged: onChanged,
    );
  }

  InputDecoration _inputDecoration(String label, String? hint) {
    return InputDecoration(
      labelText: label,
      hintText: hint,
      labelStyle: const TextStyle(color: _muted),
      floatingLabelStyle: const TextStyle(color: _primary),
      hintStyle: const TextStyle(color: _muted),
      errorStyle: const TextStyle(color: Color(0xFFDC2626)),
      suffixIconColor: _muted,
      prefixIconColor: _muted,
      filled: true,
      fillColor: Colors.white,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: _outline),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: _outline),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: _primary, width: 1.5),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  final String message;
  final Future<void> Function() onRetry;

  const _ErrorBanner({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF1F2),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFFECACA)),
      ),
      child: Row(
        children: [
          const Icon(Icons.error_outline, color: Color(0xFFDC2626)),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(color: Color(0xFF7F1D1D)),
            ),
          ),
          TextButton(onPressed: onRetry, child: const Text('Muat ulang')),
        ],
      ),
    );
  }
}
