import 'dart:async';

import 'package:flutter/material.dart';

import '../services/api_client.dart';

class AddTroubleTicketScreen extends StatefulWidget {
  const AddTroubleTicketScreen({super.key});

  @override
  State<AddTroubleTicketScreen> createState() => _AddTroubleTicketScreenState();
}

class _AddTroubleTicketScreenState extends State<AddTroubleTicketScreen> {
  static const _primary = Color(0xFF2563EB);
  static const _bg = Color(0xFFF5F7FB);
  static const _text = Color(0xFF0F172A);
  static const _muted = Color(0xFF64748B);
  static const _border = Color(0xFFE2E8F0);

  final _formKey = GlobalKey<FormState>();
  final _searchCtrl = TextEditingController();
  final _nameCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _locationCtrl = TextEditingController();
  final _descriptionCtrl = TextEditingController();

  final _categories = const [
    'Internet Mati',
    'Koneksi Lambat',
    'Kendala Router',
    'Kabel Putus',
    'Lainnya',
  ];
  Timer? _searchDebounce;
  List<Map<String, dynamic>> _customers = [];
  List<Map<String, dynamic>> _technicians = [];
  int? _selectedCustomerId;
  int? _selectedTechnicianId;
  String _category = 'Internet Mati';
  String _priority = 'Normal';
  bool _loadingOptions = true;
  bool _searchingCustomers = false;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadOptions();
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _searchCtrl.dispose();
    _nameCtrl.dispose();
    _phoneCtrl.dispose();
    _locationCtrl.dispose();
    _descriptionCtrl.dispose();
    super.dispose();
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
          if (item is Map) technicians.add(Map<String, dynamic>.from(item));
        }
      }
      setState(() => _technicians = technicians);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loadingOptions = false);
    }
  }

  void _onSearchChanged(String value) {
    _selectedCustomerId = null;
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
    setState(() {
      _selectedCustomerId = _asInt(customer['id']);
      _nameCtrl.text = customer['name']?.toString() ?? '';
      _phoneCtrl.text = customer['phone']?.toString() ?? '';
      _locationCtrl.text = customer['address']?.toString() ?? '';
      _searchCtrl.clear();
      _customers = [];
    });
  }

  Future<void> _saveTicket() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _saving = true);
    try {
      final response =
          await ApiClient.post('/api/mobile-adapter/tasks/trouble', {
            'customerId': _selectedCustomerId,
            'name': _nameCtrl.text.trim(),
            'phone': _phoneCtrl.text.trim(),
            'location': _locationCtrl.text.trim(),
            'category': _category,
            'description': _descriptionCtrl.text.trim(),
            'assignedTechnicianId': _selectedTechnicianId,
            'priority': _priority,
          });
      final body = ApiClient.decodeJsonObject(
        response,
        debugLabel: 'tasks/trouble',
      );
      if (response.statusCode == 200 &&
          ApiClient.jsonSuccess(body['success'])) {
        if (!mounted) return;
        _showSnack(body['message']?.toString() ?? 'Tiket berhasil dibuat');
        Navigator.pop(context, true);
        return;
      }
      throw Exception(body['message']?.toString() ?? 'Gagal membuat tiket');
    } catch (e) {
      if (mounted) _showSnack(e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
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
          'Tambah Tiket Gangguan',
          style: TextStyle(fontWeight: FontWeight.w600),
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
                  padding: const EdgeInsets.fromLTRB(14, 12, 14, 18),
                  children: [
                    _heroCard(),
                    const SizedBox(height: 10),
                    if (_error != null) ...[
                      _errorBanner(_error!),
                      const SizedBox(height: 10),
                    ],
                    _formCard(),
                  ],
                ),
              ),
            ),
    );
  }

  Widget _heroCard() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFF2563EB), Color(0xFF0EA5E9)],
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
      child: const Row(
        children: [
          Icon(
            Icons.confirmation_number_rounded,
            color: Colors.white,
            size: 30,
          ),
          SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Buat Laporan Gangguan Baru',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                SizedBox(height: 2),
                Text(
                  'Simpan tiket dan kirim notifikasi ke teknisi',
                  style: TextStyle(color: Colors.white70, fontSize: 11),
                ),
              ],
            ),
          ),
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
          _sectionTitle('Data Tiket', Icons.report_problem_rounded),
          const SizedBox(height: 10),
          _searchField(),
          if (_customers.isNotEmpty || _searchingCustomers) ...[
            const SizedBox(height: 6),
            _customerResults(),
          ],
          const SizedBox(height: 10),
          _textField(
            controller: _nameCtrl,
            label: 'Nama Pelapor *',
            icon: Icons.person,
            validator: _required,
          ),
          _textField(
            controller: _phoneCtrl,
            label: 'Nomor Telepon *',
            icon: Icons.phone,
            keyboardType: TextInputType.phone,
            validator: _required,
          ),
          _textField(
            controller: _locationCtrl,
            label: 'Lokasi / Alamat *',
            icon: Icons.location_on,
            validator: _required,
          ),
          _dropdown<String>(
            label: 'Kategori *',
            value: _category,
            icon: Icons.category,
            items: _categories
                .map((item) => DropdownMenuItem(value: item, child: Text(item)))
                .toList(),
            onChanged: (value) =>
                setState(() => _category = value ?? _category),
          ),
          _textField(
            controller: _descriptionCtrl,
            label: 'Deskripsi Masalah',
            icon: Icons.notes,
            maxLines: 2,
          ),
          _dropdown<int?>(
            label: 'Pilih Teknisi (Opsional)',
            value: _selectedTechnicianId,
            icon: Icons.engineering,
            items: [
              const DropdownMenuItem<int?>(
                value: null,
                child: Text('-- Pilih Teknisi --'),
              ),
              ..._technicians.map(
                (tech) => DropdownMenuItem<int?>(
                  value: _asInt(tech['id']),
                  child: Text(
                    '${tech['name'] ?? 'Teknisi'} (${tech['role'] ?? 'technician'})',
                  ),
                ),
              ),
            ],
            onChanged: (value) => setState(() => _selectedTechnicianId = value),
          ),
          _priorityPicker(),
          const SizedBox(height: 4),
          FilledButton.icon(
            onPressed: _saving ? null : _saveTicket,
            style: FilledButton.styleFrom(
              backgroundColor: _primary,
              foregroundColor: Colors.white,
              disabledBackgroundColor: _primary.withValues(alpha: 0.55),
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
                : const Icon(Icons.send_rounded),
            label: Text(
              _saving ? 'Menyimpan Tiket...' : 'Simpan & Kirim Notif',
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }

  Widget _searchField() {
    return TextField(
      controller: _searchCtrl,
      onChanged: _onSearchChanged,
      cursorColor: _primary,
      style: const TextStyle(color: _text, fontWeight: FontWeight.w500),
      decoration: InputDecoration(
        labelText: 'Cari Pelanggan',
        hintText: 'Ketik nama atau nomor HP (min 3 huruf)...',
        labelStyle: const TextStyle(color: _muted, fontWeight: FontWeight.w500),
        hintStyle: const TextStyle(color: _muted),
        prefixIcon: const Icon(Icons.search, color: _primary),
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 12,
          vertical: 12,
        ),
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
      ('Normal', 'Normal', Color(0xFF2563EB)),
      ('High', 'High', Color(0xFFF97316)),
      ('Urgent', 'Urgent', Color(0xFFDC2626)),
    ];
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Prioritas',
            style: TextStyle(
              color: _muted,
              fontSize: 12,
              fontWeight: FontWeight.w500,
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
                    borderRadius: BorderRadius.circular(9),
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
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                  ),
                );
              }).toList(),
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

  Widget _dropdown<T>({
    required String label,
    required T value,
    required IconData icon,
    required List<DropdownMenuItem<T>> items,
    required ValueChanged<T?> onChanged,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: DropdownButtonFormField<T>(
        initialValue: value,
        isExpanded: true,
        isDense: true,
        dropdownColor: Colors.white,
        iconSize: 20,
        style: const TextStyle(color: _text, fontWeight: FontWeight.w500),
        decoration: _inputDecoration(label, icon),
        items: items,
        onChanged: onChanged,
      ),
    );
  }

  Widget _textField({
    required TextEditingController controller,
    required String label,
    required IconData icon,
    TextInputType? keyboardType,
    int maxLines = 1,
    String? Function(String?)? validator,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: TextFormField(
        controller: controller,
        keyboardType: keyboardType,
        maxLines: maxLines,
        textAlignVertical: TextAlignVertical.center,
        style: const TextStyle(color: _text, fontWeight: FontWeight.w500),
        decoration: _inputDecoration(label, icon),
        validator: validator,
      ),
    );
  }

  InputDecoration _inputDecoration(String label, IconData icon) {
    return InputDecoration(
      labelText: label,
      labelStyle: const TextStyle(color: _muted, fontWeight: FontWeight.w500),
      prefixIcon: Icon(icon, color: _primary),
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      filled: true,
      fillColor: const Color(0xFFF8FAFC),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
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
        borderSide: const BorderSide(color: Colors.red),
      ),
    );
  }

  String? _required(String? value) {
    if (value == null || value.trim().isEmpty) return 'Wajib diisi';
    return null;
  }

  Widget _errorBanner(String message) {
    return Container(
      padding: const EdgeInsets.all(12),
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
              style: const TextStyle(
                color: Color(0xFF991B1B),
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
