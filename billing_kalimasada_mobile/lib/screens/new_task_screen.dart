import 'dart:async';

import 'package:flutter/material.dart';

import '../services/api_client.dart';

class NewTaskScreen extends StatefulWidget {
  final Map<String, dynamic>? prefillInstallation;

  const NewTaskScreen({super.key, this.prefillInstallation});

  @override
  State<NewTaskScreen> createState() => _NewTaskScreenState();
}

class _NewTaskScreenState extends State<NewTaskScreen> {
  static const _primary = Color(0xFF2563EB);
  static const _green = Color(0xFF16A34A);
  static const _bg = Color(0xFFF5F7FB);
  static const _text = Color(0xFF111827);
  static const _muted = Color(0xFF64748B);
  static const _border = Color(0xFFE2E8F0);

  final _formKey = GlobalKey<FormState>();
  final _searchCtrl = TextEditingController();
  late final TextEditingController _customerNameCtrl;
  late final TextEditingController _taskTypeCtrl;
  late final TextEditingController _dateCtrl;
  late final TextEditingController _notesCtrl;
  late final TextEditingController _equipmentCtrl;

  List<Map<String, dynamic>> _technicians = [];
  List<Map<String, dynamic>> _customers = [];
  Timer? _searchDebounce;
  int? _selectedCustomerId;
  int? _selectedPackageId;
  int? _selectedTechnicianId;
  String _priority = 'normal';
  bool _loadingOptions = true;
  bool _searchingCustomers = false;
  bool _saving = false;
  String? _error;

  Map<String, dynamic> get _prefill =>
      widget.prefillInstallation ?? const <String, dynamic>{};
  bool get _hasPrefill => _prefill.isNotEmpty;

  @override
  void initState() {
    super.initState();
    final customerName = _prefill['customer_name']?.toString() ?? '';
    final phone = _prefill['customer_phone']?.toString() ?? '';
    final address = _prefill['customer_address']?.toString() ?? '';
    final pppoeUsername = _prefill['pppoe_username']?.toString() ?? '';
    _selectedCustomerId = _asInt(_prefill['customer_id']);
    _selectedPackageId = _asInt(_prefill['package_id']);

    _customerNameCtrl = TextEditingController(text: customerName);
    _taskTypeCtrl = TextEditingController(text: 'Pemasangan Baru PSB');
    _dateCtrl = TextEditingController(text: _todayYmd());
    _notesCtrl = TextEditingController(
      text: [
        if (phone.isNotEmpty) 'Telepon: $phone',
        if (address.isNotEmpty) 'Alamat: $address',
        if (pppoeUsername.isNotEmpty) 'PPPoE: $pppoeUsername',
      ].join('\n'),
    );
    _equipmentCtrl = TextEditingController(
      text: 'ONT, kabel dropcore, konektor, alat instalasi',
    );
    _loadOptions();
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _searchCtrl.dispose();
    _customerNameCtrl.dispose();
    _taskTypeCtrl.dispose();
    _dateCtrl.dispose();
    _notesCtrl.dispose();
    _equipmentCtrl.dispose();
    super.dispose();
  }

  String _todayYmd() {
    final now = DateTime.now();
    return '${now.year.toString().padLeft(4, '0')}-'
        '${now.month.toString().padLeft(2, '0')}-'
        '${now.day.toString().padLeft(2, '0')}';
  }

  int? _asInt(dynamic value) {
    if (value is int) return value;
    return int.tryParse(value?.toString() ?? '');
  }

  Future<void> _loadOptions() async {
    setState(() {
      _loadingOptions = true;
      _error = null;
    });
    try {
      final response = await ApiClient.get(
        '/api/mobile-adapter/tasks/form-options',
      );
      final body = ApiClient.decodeJsonObject(
        response,
        debugLabel: 'tasks/form-options',
      );
      if (response.statusCode != 200 ||
          !ApiClient.jsonSuccess(body['success'])) {
        throw Exception(body['message']?.toString() ?? 'Gagal memuat teknisi');
      }
      final data = body['data'];
      final rawTechnicians = data is Map ? data['technicians'] : null;
      final technicians = <Map<String, dynamic>>[];
      if (rawTechnicians is List) {
        for (final item in rawTechnicians) {
          if (item is Map) {
            technicians.add(Map<String, dynamic>.from(item));
          }
        }
      }
      setState(() {
        _technicians = technicians;
        final ids = _technicians.map((t) => _asInt(t['id'])).whereType<int>();
        if (_selectedTechnicianId != null &&
            !ids.contains(_selectedTechnicianId)) {
          _selectedTechnicianId = null;
        }
        if (_selectedTechnicianId == null && _technicians.length == 1) {
          _selectedTechnicianId = _asInt(_technicians.first['id']);
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loadingOptions = false);
    }
  }

  Future<void> _saveTask() async {
    if (!_formKey.currentState!.validate()) return;
    final customerId = _selectedCustomerId;
    final packageId = _selectedPackageId;
    final customerName = _customerNameCtrl.text.trim();
    if (customerName.isEmpty) {
      _showSnack('Nama pelanggan wajib diisi.');
      return;
    }
    if (_hasPrefill && (customerId == null || customerId <= 0)) {
      _showSnack('Data pelanggan prefill tidak lengkap.');
      return;
    }
    setState(() => _saving = true);
    try {
      final response =
          await ApiClient.post('/api/mobile-adapter/tasks/installations', {
            'customer_id': customerId,
            'package_id': packageId,
            'customer_name': customerName,
            'assigned_technician_id': _selectedTechnicianId,
            'installation_date': _dateCtrl.text.trim(),
            'priority': _priority,
            'notes': _notesCtrl.text.trim(),
            'equipment_needed': _equipmentCtrl.text.trim(),
          });
      final body = ApiClient.decodeJsonObject(
        response,
        debugLabel: 'tasks/installations',
      );
      if (response.statusCode == 200 &&
          ApiClient.jsonSuccess(body['success'])) {
        if (!mounted) return;
        _showSnack(body['message']?.toString() ?? 'Tugas berhasil disimpan');
        Navigator.pop(context, true);
        return;
      }
      throw Exception(body['message']?.toString() ?? 'Gagal menyimpan tugas');
    } catch (e) {
      if (!mounted) return;
      _showSnack(e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _onSearchChanged(String value) {
    _searchDebounce?.cancel();
    if (value.trim().length < 3) {
      setState(() => _customers = []);
      return;
    }
    _searchDebounce = Timer(const Duration(milliseconds: 300), () {
      _searchCustomers(value.trim());
    });
  }

  Future<void> _searchCustomers(String query) async {
    setState(() => _searchingCustomers = true);
    try {
      final q = Uri.encodeQueryComponent(query);
      final response = await ApiClient.get(
        '/api/mobile-adapter/customers/search?q=$q',
      );
      final body = ApiClient.decodeJsonObject(
        response,
        debugLabel: 'customers/search',
      );
      if (response.statusCode != 200 ||
          !ApiClient.jsonSuccess(body['success'])) {
        throw Exception(
          body['message']?.toString() ?? 'Gagal mencari pelanggan',
        );
      }
      final raw = body['data'];
      final customers = <Map<String, dynamic>>[];
      if (raw is List) {
        for (final item in raw) {
          if (item is Map) customers.add(Map<String, dynamic>.from(item));
        }
      }
      if (mounted) setState(() => _customers = customers);
    } catch (e) {
      if (mounted) _showSnack(e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _searchingCustomers = false);
    }
  }

  void _selectCustomer(Map<String, dynamic> customer) {
    final packageId = _asInt(customer['package_id']);
    setState(() {
      _selectedCustomerId = _asInt(customer['id']);
      _selectedPackageId = packageId;
      _customerNameCtrl.text = customer['name']?.toString() ?? '';
      final phone = customer['phone']?.toString() ?? '';
      final address = customer['address']?.toString() ?? '';
      _notesCtrl.text = [
        if (phone.isNotEmpty) 'Telepon: $phone',
        if (address.isNotEmpty) 'Alamat: $address',
      ].join('\n');
      _searchCtrl.clear();
      _customers = [];
    });
  }

  Future<void> _pickDate() async {
    final current = DateTime.tryParse(_dateCtrl.text) ?? DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: current,
      firstDate: DateTime.now().subtract(const Duration(days: 30)),
      lastDate: DateTime.now().add(const Duration(days: 365)),
      builder: (context, child) {
        return Theme(
          data: Theme.of(
            context,
          ).copyWith(colorScheme: ColorScheme.fromSeed(seedColor: _primary)),
          child: child!,
        );
      },
    );
    if (picked == null) return;
    setState(() {
      _dateCtrl.text =
          '${picked.year.toString().padLeft(4, '0')}-'
          '${picked.month.toString().padLeft(2, '0')}-'
          '${picked.day.toString().padLeft(2, '0')}';
    });
  }

  void _showSnack(String message) {
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
        centerTitle: true,
        title: const Text(
          'Buat Tugas',
          style: TextStyle(fontWeight: FontWeight.w600),
        ),
      ),
      body: RefreshIndicator(
        onRefresh: _loadOptions,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 18),
          children: [
            _heroCard(),
            const SizedBox(height: 10),
            if (_error != null) ...[
              _errorBanner(_error!),
              const SizedBox(height: 10),
            ],
            Form(key: _formKey, child: _formCard()),
          ],
        ),
      ),
    );
  }

  Widget _heroCard() {
    final phone = _prefill['customer_phone']?.toString() ?? '';
    final address = _prefill['customer_address']?.toString() ?? '';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFF2563EB), Color(0xFF14B8A6)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(18),
        boxShadow: [
          BoxShadow(
            color: _primary.withValues(alpha: 0.16),
            blurRadius: 12,
            offset: const Offset(0, 6),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.18),
                  borderRadius: BorderRadius.circular(13),
                ),
                child: const Icon(Icons.assignment_add, color: Colors.white),
              ),
              const SizedBox(width: 10),
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Buat Tugas Pemasangan Baru',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    SizedBox(height: 2),
                    Text(
                      'PSB untuk pelanggan yang baru disimpan',
                      style: TextStyle(color: Colors.white70, fontSize: 11),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (_customerNameCtrl.text.trim().isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(
              _customerNameCtrl.text.trim(),
              style: const TextStyle(
                color: Colors.white,
                fontSize: 18,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
          if (phone.isNotEmpty || address.isNotEmpty) ...[
            const SizedBox(height: 5),
            Text(
              [
                if (phone.isNotEmpty) phone,
                if (address.isNotEmpty) address,
              ].join(' - '),
              style: const TextStyle(color: Colors.white, height: 1.35),
            ),
          ],
        ],
      ),
    );
  }

  Widget _formCard() {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _border),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.04),
            blurRadius: 10,
            offset: const Offset(0, 5),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _sectionTitle('Detail Tugas', Icons.task_alt),
          const SizedBox(height: 10),
          _searchField(),
          if (_customers.isNotEmpty || _searchingCustomers) ...[
            const SizedBox(height: 6),
            _customerResults(),
          ],
          const SizedBox(height: 10),
          _textField(
            controller: _customerNameCtrl,
            label: 'Nama Pelanggan',
            icon: Icons.person,
            readOnly: _hasPrefill,
            onChanged: _hasPrefill
                ? null
                : (_) {
                    _selectedCustomerId = null;
                    _selectedPackageId = null;
                  },
            validator: _required,
          ),
          _textField(
            controller: _taskTypeCtrl,
            label: 'Jenis Tugas',
            icon: Icons.home_repair_service,
            readOnly: true,
          ),
          _technicianDropdown(),
          _textField(
            controller: _dateCtrl,
            label: 'Tanggal',
            icon: Icons.calendar_today,
            readOnly: true,
            onTap: _pickDate,
          ),
          const SizedBox(height: 4),
          _priorityPicker(),
          const SizedBox(height: 10),
          _textField(
            controller: _equipmentCtrl,
            label: 'Peralatan',
            icon: Icons.construction,
            maxLines: 2,
          ),
          _textField(
            controller: _notesCtrl,
            label: 'Catatan',
            icon: Icons.notes,
            maxLines: 2,
          ),
          const SizedBox(height: 4),
          FilledButton.icon(
            onPressed: _saving || _loadingOptions ? null : _saveTask,
            style: FilledButton.styleFrom(
              backgroundColor: _green,
              foregroundColor: Colors.white,
              disabledBackgroundColor: _green.withValues(alpha: 0.55),
              minimumSize: const Size.fromHeight(46),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
            ),
            icon: _saving
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : const Icon(Icons.save),
            label: Text(
              _saving ? 'Menyimpan Tugas...' : 'Simpan Tugas',
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }

  Widget _sectionTitle(String title, IconData icon) {
    return Row(
      children: [
        Container(
          width: 30,
          height: 30,
          decoration: BoxDecoration(
            color: _primary.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(icon, color: _primary, size: 18),
        ),
        const SizedBox(width: 8),
        Text(
          title,
          style: const TextStyle(
            color: _text,
            fontSize: 16,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }

  Widget _technicianDropdown() {
    final technicianItems = _technicians
        .map(
          (tech) => DropdownMenuItem<int?>(
            value: _asInt(tech['id']),
            child: Text(
              [
                tech['name']?.toString() ?? 'Teknisi',
                if ((tech['area_coverage']?.toString() ?? '').isNotEmpty)
                  tech['area_coverage'].toString(),
              ].join(' - '),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        )
        .where((item) => item.value != null)
        .toList();

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: DropdownButtonFormField<int?>(
        initialValue: _selectedTechnicianId,
        isExpanded: true,
        isDense: true,
        menuMaxHeight: 320,
        dropdownColor: Colors.white,
        iconSize: 20,
        style: const TextStyle(color: _text, fontWeight: FontWeight.w500),
        decoration: _inputDecoration(
          label: 'Pilih Teknisi',
          icon: Icons.engineering,
          suffix: _loadingOptions
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : null,
        ),
        hint: Text(
          _loadingOptions ? 'Memuat teknisi...' : 'Pilih teknisi',
          style: const TextStyle(color: _muted),
        ),
        items: [
          const DropdownMenuItem<int?>(
            value: null,
            child: Text('-- Semua teknisi --'),
          ),
          ...technicianItems,
        ],
        onChanged: _loadingOptions
            ? null
            : (value) => setState(() => _selectedTechnicianId = value),
      ),
    );
  }

  Widget _searchField() {
    return TextField(
      controller: _searchCtrl,
      onChanged: _onSearchChanged,
      cursorColor: _primary,
      autofocus: widget.prefillInstallation == null,
      style: const TextStyle(color: _text, fontWeight: FontWeight.w500),
      decoration: InputDecoration(
        labelText: 'Cari Pelanggan',
        hintText: 'Ketik nama atau nomor HP (min 3 huruf)...',
        labelStyle: const TextStyle(color: _muted, fontWeight: FontWeight.w500),
        hintStyle: const TextStyle(color: _muted),
        prefixIcon: const Icon(Icons.search, color: _primary),
        suffixIcon: _searchingCustomers
            ? const Padding(
                padding: EdgeInsets.all(12),
                child: SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              )
            : null,
        filled: true,
        fillColor: const Color(0xFFF8FAFC),
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 12,
          vertical: 12,
        ),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: _border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: _primary, width: 1.4),
        ),
      ),
    );
  }

  Widget _customerResults() {
    if (_searchingCustomers && _customers.isEmpty) {
      return const Text(
        'Mencari pelanggan...',
        style: TextStyle(color: _muted),
      );
    }
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _border),
      ),
      child: Column(
        children: _customers
            .map(
              (customer) => ListTile(
                dense: true,
                visualDensity: const VisualDensity(vertical: -3),
                contentPadding: const EdgeInsets.symmetric(horizontal: 10),
                leading: const Icon(Icons.person_pin_circle, color: _primary),
                title: Text(
                  customer['name']?.toString() ?? '-',
                  style: const TextStyle(
                    color: _text,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                subtitle: Text(
                  [
                    customer['phone']?.toString() ?? '',
                    customer['address']?.toString() ?? '',
                    customer['package_name']?.toString() ?? '',
                  ].where((item) => item.trim().isNotEmpty).join(' - '),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: _muted),
                ),
                onTap: () => _selectCustomer(customer),
              ),
            )
            .toList(),
      ),
    );
  }

  Widget _priorityPicker() {
    const options = [
      ('Rendah', 'low', Color(0xFF0F766E)),
      ('Normal', 'normal', Color(0xFF2563EB)),
      ('Tinggi', 'high', Color(0xFFDC2626)),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Prioritas',
          style: TextStyle(
            color: _muted,
            fontSize: 12,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.2,
          ),
        ),
        const SizedBox(height: 6),
        Container(
          padding: const EdgeInsets.all(4),
          decoration: BoxDecoration(
            color: const Color(0xFFF1F5F9),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: _border),
          ),
          child: Row(
            children: options.map((option) {
              final selected = _priority == option.$2;
              return Expanded(
                child: InkWell(
                  borderRadius: BorderRadius.circular(11),
                  onTap: () => setState(() => _priority = option.$2),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 160),
                    height: 36,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: selected ? option.$3 : Colors.transparent,
                      borderRadius: BorderRadius.circular(9),
                    ),
                    child: Text(
                      option.$1,
                      style: TextStyle(
                        color: selected ? Colors.white : _muted,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
              );
            }).toList(),
          ),
        ),
      ],
    );
  }

  Widget _textField({
    required TextEditingController controller,
    required String label,
    required IconData icon,
    bool readOnly = false,
    int maxLines = 1,
    VoidCallback? onTap,
    ValueChanged<String>? onChanged,
    String? Function(String?)? validator,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: TextFormField(
        controller: controller,
        readOnly: readOnly,
        onTap: onTap,
        onChanged: onChanged,
        maxLines: maxLines,
        textAlignVertical: TextAlignVertical.center,
        style: const TextStyle(color: _text, fontWeight: FontWeight.w500),
        validator: validator,
        decoration: _inputDecoration(label: label, icon: icon),
      ),
    );
  }

  InputDecoration _inputDecoration({
    required String label,
    required IconData icon,
    Widget? suffix,
  }) {
    return InputDecoration(
      labelText: label,
      labelStyle: const TextStyle(color: _muted, fontWeight: FontWeight.w500),
      prefixIcon: Icon(icon, color: _primary),
      suffixIcon: suffix == null
          ? null
          : Padding(padding: const EdgeInsets.all(12), child: suffix),
      isDense: true,
      filled: true,
      fillColor: const Color(0xFFF8FAFC),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: _border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: _border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: _primary, width: 1.4),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: Color(0xFFDC2626)),
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
    );
  }

  String? _required(String? value) {
    if ((value ?? '').trim().isEmpty) return 'Wajib diisi';
    return null;
  }

  Widget _errorBanner(String message) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFFEF2F2),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFFECACA)),
      ),
      child: Row(
        children: [
          const Icon(Icons.error_outline, color: Color(0xFFB91C1C)),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(
                color: Color(0xFF7F1D1D),
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          IconButton(
            onPressed: _loadOptions,
            icon: const Icon(Icons.refresh, color: Color(0xFFB91C1C)),
          ),
        ],
      ),
    );
  }
}
