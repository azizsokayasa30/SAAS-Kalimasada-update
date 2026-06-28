import 'dart:async';
import 'dart:io' show File, Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../services/api_client.dart';

class AdminWarehouseScreen extends StatefulWidget {
  const AdminWarehouseScreen({super.key});

  @override
  State<AdminWarehouseScreen> createState() => _AdminWarehouseScreenState();
}

class _AdminWarehouseScreenState extends State<AdminWarehouseScreen> {
  static const _navy = Color(0xFF2563EB);
  static const _bg = Color(0xFFF4F6FA);
  static const _green = Color(0xFF10B981);
  static const _orange = Color(0xFFE49A16);
  static const _red = Color(0xFFE84C4F);

  final _count = NumberFormat.decimalPattern('id_ID');
  final _qtyCtrl = TextEditingController(text: '1');
  final _refCtrl = TextEditingController();
  final _inNotesCtrl = TextEditingController();
  final _recipientCtrl = TextEditingController();
  final _employeeCodeCtrl = TextEditingController();
  final _unitCodeCtrl = TextEditingController();
  final _outNotesCtrl = TextEditingController();

  int _tab = 0;
  bool _loading = true;
  bool _saving = false;
  String? _error;
  int? _selectedItemId;
  int? _selectedEmployeeId;
  Map<String, dynamic>? _selectedEmployee;
  Map<String, dynamic> _report = const {};
  List<Map<String, dynamic>> _items = const [];
  List<Map<String, dynamic>> _inbound = const [];
  List<Map<String, dynamic>> _outbound = const [];
  List<Map<String, dynamic>> _employees = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _qtyCtrl.dispose();
    _refCtrl.dispose();
    _inNotesCtrl.dispose();
    _recipientCtrl.dispose();
    _employeeCodeCtrl.dispose();
    _unitCodeCtrl.dispose();
    _outNotesCtrl.dispose();
    super.dispose();
  }

  List<Map<String, dynamic>> _list(dynamic value) {
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  int _int(dynamic value) {
    if (value is num) return value.round();
    return int.tryParse(value?.toString() ?? '') ?? 0;
  }

  String _shortDate(dynamic value) {
    final raw = value?.toString() ?? '';
    if (raw.length >= 16) return raw.substring(0, 16);
    return raw.isEmpty ? '-' : raw;
  }

  Future<Map<String, dynamic>> _decode(
    Future<dynamic> request,
    String label,
  ) async {
    final response = await request;
    final body = ApiClient.decodeJsonObject(response, debugLabel: label);
    if (response.statusCode < 200 ||
        response.statusCode >= 300 ||
        !ApiClient.jsonSuccess(body['success'])) {
      throw Exception(body['message']?.toString() ?? 'Aksi gagal');
    }
    return body;
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final results = await Future.wait<Map<String, dynamic>>([
        _decode(
          ApiClient.get('/api/mobile-adapter/admin/warehouse/items?all=1'),
          'warehouse/items',
        ),
        _decode(
          ApiClient.get(
            '/api/mobile-adapter/admin/warehouse/inbound-history?limit=100',
          ),
          'warehouse/inbound-history',
        ),
        _decode(
          ApiClient.get(
            '/api/mobile-adapter/admin/warehouse/outbound-history?limit=100',
          ),
          'warehouse/outbound-history',
        ),
        _decode(
          ApiClient.get('/api/mobile-adapter/admin/warehouse/report-summary'),
          'warehouse/report-summary',
        ),
        _decode(
          ApiClient.get('/api/mobile-adapter/admin/warehouse/employees'),
          'warehouse/employees',
        ),
      ]);
      if (!mounted) return;
      final activeItems = _list(
        results[0]['items'],
      ).where((item) => _int(item['is_active']) == 1).toList();
      setState(() {
        _items = _list(results[0]['items']);
        _inbound = _list(results[1]['rows']);
        _outbound = _list(results[2]['rows']);
        _report = results[3];
        _employees = _list(results[4]['employees']);
        if (!activeItems.any((item) => _int(item['id']) == _selectedItemId)) {
          _selectedItemId = null;
        }
        _loading = false;
        _error = null;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error =
            'Menu gudang belum tersedia dari server. Restart/deploy backend lalu muat ulang.';
        _loading = false;
      });
    }
  }

  Future<void> _runAction(Future<void> Function() action) async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      await action();
      await _load(silent: true);
    } catch (e) {
      _showMessage(e.toString().replaceFirst('Exception: ', ''), error: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _showMessage(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          message,
          style: const TextStyle(
            color: Colors.white,
            fontWeight: FontWeight.w700,
          ),
        ),
        backgroundColor: error ? _red : _green,
      ),
    );
  }

  Future<void> _saveInbound() async {
    await _runAction(() async {
      final itemId = _selectedItemId;
      final qty = int.tryParse(_qtyCtrl.text.trim()) ?? 0;
      if (itemId == null || qty < 1) {
        throw Exception('Pilih barang dan isi jumlah valid.');
      }
      final body = await _decode(
        ApiClient.post('/api/mobile-adapter/admin/warehouse/inbound', {
          'item_id': itemId,
          'quantity': qty,
          'reference': _refCtrl.text.trim(),
          'notes': _inNotesCtrl.text.trim(),
        }),
        'warehouse/inbound',
      );
      _refCtrl.clear();
      _inNotesCtrl.clear();
      _qtyCtrl.text = '1';
      final units = _list(body['units']).length;
      _showMessage(
        'Barang masuk tersimpan. Batch #${body['batch_id']} ($units unit QR).',
      );
    });
  }

  Future<void> _scanEmployee() async {
    final code = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder: (_) => const _WarehouseScanScreen(title: 'Scan QR karyawan'),
      ),
    );
    if (code == null || code.trim().isEmpty) return;
    _employeeCodeCtrl.text = code.trim();
    await _lookupEmployee(code.trim());
  }

  Future<void> _lookupEmployee(String code) async {
    await _runAction(() async {
      final body = await _decode(
        ApiClient.get(
          '/api/mobile-adapter/admin/warehouse/employee-lookup?code=${Uri.encodeQueryComponent(code)}',
        ),
        'warehouse/employee-lookup',
      );
      final raw = body['employee'];
      if (raw is! Map) throw Exception('Data karyawan tidak valid');
      final employee = Map<String, dynamic>.from(raw);
      setState(() {
        _selectedEmployee = employee;
        _selectedEmployeeId = _int(employee['id']);
        _recipientCtrl.clear();
      });
      _showMessage('Karyawan: ${employee['nama_lengkap'] ?? '-'}');
    });
  }

  Future<void> _scanUnit() async {
    final code = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder: (_) =>
            const _WarehouseScanScreen(title: 'Scan barcode barang'),
      ),
    );
    if (code == null || code.trim().isEmpty) return;
    _unitCodeCtrl.text = code.trim();
  }

  Future<void> _processOutbound() async {
    await _runAction(() async {
      final code = _unitCodeCtrl.text.trim();
      if (code.isEmpty) {
        throw Exception('Scan atau isi kode barang terlebih dahulu.');
      }
      final body = <String, dynamic>{
        'code': code,
        'notes': _outNotesCtrl.text.trim(),
      };
      if (_selectedEmployeeId != null) {
        body['employee_id'] = _selectedEmployeeId;
      } else {
        final recipient = _recipientCtrl.text.trim();
        if (recipient.isEmpty) {
          throw Exception('Scan QR karyawan atau isi nama penerima.');
        }
        body['recipient'] = recipient;
      }
      final response = await _decode(
        ApiClient.post(
          '/api/mobile-adapter/admin/warehouse/outbound-scan',
          body,
        ),
        'warehouse/outbound-scan',
      );
      final unit = response['unit'] is Map
          ? Map<String, dynamic>.from(response['unit'])
          : const {};
      _unitCodeCtrl.clear();
      _showMessage(
        'Keluar: ${unit['item_name'] ?? '-'} ke ${unit['recipient'] ?? '-'}',
      );
    });
  }

  Future<void> _exportReport() async {
    await _runAction(() async {
      final response = await ApiClient.download(
        '/api/mobile-adapter/admin/warehouse/export/laporan.xlsx',
        accept:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final message = response.body.trim().isEmpty
            ? 'Export laporan gagal'
            : response.body;
        throw Exception(message);
      }
      final dir = await getTemporaryDirectory();
      final date = DateFormat('yyyy-MM-dd').format(DateTime.now());
      final file = File('${dir.path}/laporan-gudang-$date.xlsx');
      await file.writeAsBytes(response.bodyBytes, flush: true);
      _showMessage('Laporan Excel berhasil dibuat.');
      await OpenFilex.open(file.path);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _navy,
        foregroundColor: Colors.white,
        title: const Text(
          'Gudang',
          style: TextStyle(fontWeight: FontWeight.w800),
        ),
        actions: [
          IconButton(
            tooltip: 'Muat ulang',
            onPressed: _saving ? null : _load,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return _ErrorState(message: _error!, onRetry: _load);
    return RefreshIndicator(
      onRefresh: () => _load(silent: true),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
        children: [
          _menuTabs(),
          const SizedBox(height: 14),
          if (_saving) const LinearProgressIndicator(minHeight: 2),
          if (_tab == 0) _buildInbound(),
          if (_tab == 1) _buildOutbound(),
          if (_tab == 2) _buildReport(),
        ],
      ),
    );
  }

  Widget _menuTabs() {
    const labels = ['Masuk', 'Keluar', 'Laporan'];
    const icons = [
      Icons.call_received_rounded,
      Icons.call_made_rounded,
      Icons.inventory_rounded,
    ];
    return Row(
      children: List.generate(labels.length, (index) {
        final selected = _tab == index;
        return Expanded(
          child: Padding(
            padding: EdgeInsets.only(right: index == labels.length - 1 ? 0 : 8),
            child: InkWell(
              borderRadius: BorderRadius.circular(16),
              onTap: () => setState(() => _tab = index),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 180),
                padding: const EdgeInsets.symmetric(vertical: 12),
                decoration: BoxDecoration(
                  color: selected ? _navy : Colors.white,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(
                    color: selected ? _navy : const Color(0xFFE2E8F0),
                  ),
                ),
                child: Column(
                  children: [
                    Icon(icons[index], color: selected ? Colors.white : _navy),
                    const SizedBox(height: 4),
                    Text(
                      labels[index],
                      style: TextStyle(
                        color: selected
                            ? Colors.white
                            : const Color(0xFF0F172A),
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      }),
    );
  }

  Widget _buildInbound() {
    final activeItems = _items
        .where((item) => _int(item['is_active']) == 1)
        .toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _sectionTitle('Catat barang masuk', Icons.add_box_rounded),
              const SizedBox(height: 12),
              DropdownButtonFormField<int>(
                key: const ValueKey('warehouse_inbound_item_dropdown'),
                dropdownColor: Colors.white,
                style: const TextStyle(
                  color: Color(0xFF0F172A),
                  fontWeight: FontWeight.w400,
                ),
                initialValue:
                    activeItems.any(
                      (item) => _int(item['id']) == _selectedItemId,
                    )
                    ? _selectedItemId
                    : null,
                hint: const Text(
                  'Pilih barang',
                  style: TextStyle(
                    color: Color(0xFF64748B),
                    fontWeight: FontWeight.w400,
                  ),
                ),
                items: activeItems
                    .map(
                      (item) => DropdownMenuItem<int>(
                        value: _int(item['id']),
                        child: Text(
                          '${item['name'] ?? '-'}${(item['unit'] ?? '').toString().isEmpty ? '' : ' (${item['unit']})'}',
                          style: const TextStyle(
                            color: Color(0xFF0F172A),
                            fontWeight: FontWeight.w400,
                          ),
                        ),
                      ),
                    )
                    .toList(),
                onChanged: (value) => setState(() => _selectedItemId = value),
                decoration: _inputDecoration('Nama barang'),
              ),
              const SizedBox(height: 12),
              _Field(
                controller: _qtyCtrl,
                label: 'Jumlah unit',
                keyboardType: TextInputType.number,
              ),
              _Field(controller: _refCtrl, label: 'Referensi / supplier'),
              _Field(controller: _inNotesCtrl, label: 'Catatan', maxLines: 2),
              FilledButton.icon(
                onPressed: _saving ? null : _saveInbound,
                icon: const Icon(Icons.save_rounded),
                label: const Text('Simpan barang masuk'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        _sectionHeader('Riwayat masuk', trailing: '${_inbound.length} batch'),
        ..._inbound.take(40).map(_inboundTile),
        if (_inbound.isEmpty)
          const _EmptyState(text: 'Belum ada barang masuk.'),
      ],
    );
  }

  Widget _inboundTile(Map<String, dynamic> row) {
    final out = _int(row['units_out']);
    final inside = _int(row['units_in_stock']);
    final locked = out > 0;
    return _Card(
      compact: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  row['item_name']?.toString() ?? '-',
                  style: const TextStyle(
                    color: Color(0xFF0F172A),
                    fontWeight: FontWeight.w700,
                    fontSize: 15,
                  ),
                ),
              ),
              _Badge(
                text: locked ? '$inside stok · $out keluar' : '$inside stok',
                color: locked ? _orange : _green,
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            '${_shortDate(row['created_at'])} · Qty ${_count.format(_int(row['quantity']))}',
            style: const TextStyle(
              color: Color(0xFF334155),
              fontWeight: FontWeight.w400,
            ),
          ),
          if ((row['reference'] ?? '').toString().isNotEmpty)
            Text(
              'Ref: ${row['reference']}',
              style: const TextStyle(
                color: Color(0xFF334155),
                fontWeight: FontWeight.w400,
              ),
            ),
          const SizedBox(height: 8),
          Row(
            children: [
              TextButton.icon(
                onPressed: () => _showEditBatchSheet(row),
                icon: const Icon(Icons.edit_rounded),
                label: const Text('Edit'),
              ),
              TextButton.icon(
                onPressed: locked ? null : () => _deleteBatch(row),
                icon: const Icon(Icons.delete_outline_rounded),
                label: const Text('Hapus'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildOutbound() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _sectionTitle('Catat barang keluar', Icons.outbox_rounded),
              const SizedBox(height: 12),
              if (_selectedEmployee != null)
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: const Color(0xFFEAF2FF),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.verified_user_rounded, color: _navy),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          '${_selectedEmployee?['nama_lengkap'] ?? '-'}\n${_selectedEmployee?['jabatan'] ?? '-'}',
                          style: const TextStyle(
                            color: Color(0xFF0F172A),
                            fontWeight: FontWeight.w400,
                          ),
                        ),
                      ),
                      TextButton(
                        onPressed: () => setState(() {
                          _selectedEmployee = null;
                          _selectedEmployeeId = null;
                          _employeeCodeCtrl.clear();
                        }),
                        child: const Text('Ganti'),
                      ),
                    ],
                  ),
                )
              else ...[
                Row(
                  children: [
                    Expanded(
                      child: _Field(
                        controller: _employeeCodeCtrl,
                        label: 'Kode QR karyawan',
                      ),
                    ),
                    const SizedBox(width: 8),
                    IconButton.filled(
                      onPressed: _scanEmployee,
                      style: IconButton.styleFrom(
                        backgroundColor: _navy,
                        foregroundColor: Colors.white,
                      ),
                      icon: const Icon(Icons.qr_code_scanner_rounded),
                    ),
                  ],
                ),
                if (_employeeCodeCtrl.text.trim().isNotEmpty)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton(
                      onPressed: () =>
                          _lookupEmployee(_employeeCodeCtrl.text.trim()),
                      child: const Text('Pakai kode karyawan'),
                    ),
                  ),
                DropdownButtonFormField<int>(
                  key: ValueKey(
                    'out_employee_${_selectedEmployeeId}_${_employees.length}',
                  ),
                  dropdownColor: Colors.white,
                  style: const TextStyle(
                    color: Color(0xFF0F172A),
                    fontWeight: FontWeight.w400,
                  ),
                  initialValue:
                      _employees.any(
                        (item) => _int(item['id']) == _selectedEmployeeId,
                      )
                      ? _selectedEmployeeId
                      : null,
                  items: _employees
                      .map(
                        (employee) => DropdownMenuItem<int>(
                          value: _int(employee['id']),
                          child: Text(
                            '${employee['nama_lengkap'] ?? '-'} (${employee['jabatan'] ?? '-'})',
                            style: const TextStyle(
                              color: Color(0xFF0F172A),
                              fontWeight: FontWeight.w400,
                            ),
                          ),
                        ),
                      )
                      .toList(),
                  onChanged: (value) {
                    final found = _employees
                        .where((e) => _int(e['id']) == value)
                        .toList();
                    setState(() {
                      _selectedEmployeeId = value;
                      _selectedEmployee = found.isEmpty ? null : found.first;
                      if (value != null) _recipientCtrl.clear();
                    });
                  },
                  decoration: _inputDecoration('Pilih karyawan aktif'),
                ),
                const SizedBox(height: 12),
                _Field(
                  controller: _recipientCtrl,
                  label: 'Atau nama penerima manual',
                  onChanged: (_) => setState(() {}),
                ),
              ],
              const Divider(height: 28),
              _sectionTitle('Scan barang keluar', Icons.qr_code_2_rounded),
              const SizedBox(height: 12),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: _Field(
                      controller: _unitCodeCtrl,
                      label: 'Kode unit barang (WH...)',
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: _saving ? null : _scanUnit,
                    style: IconButton.styleFrom(
                      backgroundColor: _navy,
                      foregroundColor: Colors.white,
                      disabledBackgroundColor: const Color(0xFFCBD5E1),
                      disabledForegroundColor: Colors.white70,
                    ),
                    icon: const Icon(Icons.document_scanner_rounded),
                  ),
                ],
              ),
              _Field(
                controller: _outNotesCtrl,
                label: 'Catatan keluar',
                maxLines: 2,
              ),
              FilledButton.icon(
                onPressed: _saving ? null : _processOutbound,
                icon: const Icon(Icons.outbox_rounded),
                label: const Text('Proses barang keluar'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        _sectionHeader('Riwayat keluar', trailing: '${_outbound.length} unit'),
        ..._outbound.take(50).map(_outboundTile),
        if (_outbound.isEmpty)
          const _EmptyState(text: 'Belum ada barang keluar.'),
      ],
    );
  }

  Widget _outboundTile(Map<String, dynamic> row) {
    final employee = (row['employee_name'] ?? '').toString();
    return _Card(
      compact: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  row['item_name']?.toString() ?? '-',
                  style: const TextStyle(
                    color: Color(0xFF0F172A),
                    fontWeight: FontWeight.w700,
                    fontSize: 15,
                  ),
                ),
              ),
              _Badge(text: _shortDate(row['outbound_at']), color: _navy),
            ],
          ),
          const SizedBox(height: 6),
          SelectableText(
            row['public_code']?.toString() ?? '-',
            style: const TextStyle(
              fontWeight: FontWeight.w400,
              color: Color(0xFF0F172A),
            ),
          ),
          Text(
            'Ke: ${row['outbound_recipient'] ?? '-'}${employee.isEmpty ? '' : ' · $employee'}',
            style: const TextStyle(
              color: Color(0xFF334155),
              fontWeight: FontWeight.w400,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildReport() {
    final items = _list(_report['items']);
    final lowStock = _list(_report['lowStock']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (lowStock.isNotEmpty)
          _Notice(
            color: _red,
            text:
                'Stok menipis: ${lowStock.map((e) => '${e['name']} (${_int(e['stock_in'])})').join(', ')}',
          )
        else
          const _Notice(
            color: _green,
            text: 'Tidak ada barang di bawah batas stok tipis.',
          ),
        const SizedBox(height: 14),
        _sectionHeader(
          'Ringkasan per barang',
          trailing: '${items.length} item',
        ),
        Row(
          children: [
            Expanded(
              child: FilledButton.icon(
                onPressed: _saving ? null : _showAddItemSheet,
                style: FilledButton.styleFrom(
                  backgroundColor: _navy,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                ),
                icon: const Icon(Icons.add_rounded),
                label: const Text('Tambah nama barang'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: FilledButton.icon(
                onPressed: _saving ? null : _exportReport,
                style: FilledButton.styleFrom(
                  backgroundColor: _green,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                ),
                icon: const Icon(Icons.file_download_rounded),
                label: const Text('Export Excel'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        ...items.map(_reportTile),
        if (items.isEmpty)
          const _EmptyState(text: 'Belum ada master barang aktif.'),
      ],
    );
  }

  Widget _reportTile(Map<String, dynamic> row) {
    final stock = _int(row['stock_in']);
    final low = _int(row['low_stock_threshold']);
    final danger = stock <= low;
    return _Card(
      compact: true,
      child: Row(
        children: [
          Icon(
            danger ? Icons.warning_amber_rounded : Icons.inventory_2_rounded,
            color: danger ? _orange : _navy,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  row['name']?.toString() ?? '-',
                  style: const TextStyle(
                    color: Color(0xFF0F172A),
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  '${row['unit'] ?? '-'} · keluar ${_count.format(_int(row['stock_out']))} · batas $low',
                  style: const TextStyle(
                    color: Color(0xFF334155),
                    fontWeight: FontWeight.w400,
                  ),
                ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              const Text(
                'Stok',
                style: TextStyle(
                  color: Color(0xFF64748B),
                  fontSize: 12,
                  fontWeight: FontWeight.w400,
                ),
              ),
              Text(
                _count.format(stock),
                style: TextStyle(
                  color: danger ? _orange : const Color(0xFF0F172A),
                  fontWeight: FontWeight.w900,
                  fontSize: 18,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _showAddItemSheet() async {
    final result = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (_) => const _AddWarehouseItemDialog(),
    );
    if (!mounted || result == null) return;
    await _saveNewItemFromForm(result);
  }

  Future<void> _saveNewItemFromForm(Map<String, dynamic> form) async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      await _createNewItem(form);
      await _load(silent: true);
      _showMessage('Nama barang ditambahkan.');
    } catch (e) {
      _showMessage(e.toString().replaceFirst('Exception: ', ''), error: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _createNewItem(Map<String, dynamic> form) async {
    await _decode(
      ApiClient.post('/api/mobile-adapter/admin/warehouse/items', form),
      'warehouse/items post',
    );
  }

  Future<void> _showEditBatchSheet(Map<String, dynamic> row) async {
    final itemCtrl = ValueNotifier<int>(_int(row['item_id']));
    final qtyCtrl = TextEditingController(text: '${_int(row['quantity'])}');
    final refCtrl = TextEditingController(
      text: row['reference']?.toString() ?? '',
    );
    final notesCtrl = TextEditingController(
      text: row['notes']?.toString() ?? '',
    );
    final locked = _int(row['units_out']) > 0;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) {
        return Padding(
          padding: EdgeInsets.fromLTRB(
            16,
            16,
            16,
            MediaQuery.of(context).viewInsets.bottom + 16,
          ),
          child: ValueListenableBuilder<int>(
            valueListenable: itemCtrl,
            builder: (context, itemId, _) {
              return ListView(
                shrinkWrap: true,
                children: [
                  _sectionTitle('Edit batch masuk', Icons.edit_note_rounded),
                  const SizedBox(height: 8),
                  Text(
                    locked
                        ? 'Batch sudah ada unit keluar. Hanya referensi dan catatan yang bisa diubah.'
                        : 'Barang dan qty bisa diubah karena semua unit masih di gudang.',
                    style: const TextStyle(
                      color: Color(0xFF64748B),
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (!locked) ...[
                    DropdownButtonFormField<int>(
                      key: ValueKey('edit_batch_item_$itemId'),
                      dropdownColor: Colors.white,
                      style: const TextStyle(
                        color: Color(0xFF0F172A),
                        fontWeight: FontWeight.w400,
                      ),
                      initialValue: itemId,
                      items: _items
                          .where((item) => _int(item['is_active']) == 1)
                          .map(
                            (item) => DropdownMenuItem<int>(
                              value: _int(item['id']),
                              child: Text(
                                item['name']?.toString() ?? '-',
                                style: const TextStyle(
                                  color: Color(0xFF0F172A),
                                  fontWeight: FontWeight.w400,
                                ),
                              ),
                            ),
                          )
                          .toList(),
                      onChanged: (value) {
                        if (value != null) itemCtrl.value = value;
                      },
                      decoration: _inputDecoration('Barang'),
                    ),
                    const SizedBox(height: 12),
                    _Field(
                      controller: qtyCtrl,
                      label: 'Jumlah',
                      keyboardType: TextInputType.number,
                    ),
                  ],
                  _Field(controller: refCtrl, label: 'Referensi'),
                  _Field(controller: notesCtrl, label: 'Catatan', maxLines: 2),
                  FilledButton(
                    onPressed: () {
                      Navigator.of(context).pop();
                      _saveBatch(
                        row,
                        itemCtrl.value,
                        qtyCtrl.text,
                        refCtrl.text,
                        notesCtrl.text,
                        locked,
                      );
                    },
                    child: const Text('Simpan perubahan'),
                  ),
                ],
              );
            },
          ),
        );
      },
    );
    itemCtrl.dispose();
    qtyCtrl.dispose();
    refCtrl.dispose();
    notesCtrl.dispose();
  }

  Future<void> _saveBatch(
    Map<String, dynamic> row,
    int itemId,
    String qty,
    String ref,
    String notes,
    bool locked,
  ) async {
    await _runAction(() async {
      final body = <String, dynamic>{
        'reference': ref.trim(),
        'notes': notes.trim(),
      };
      if (!locked) {
        body['item_id'] = itemId;
        body['quantity'] = int.tryParse(qty.trim()) ?? 0;
      }
      final response = await _decode(
        ApiClient.put(
          '/api/mobile-adapter/admin/warehouse/inbound-batches/${row['id']}',
          body,
        ),
        'warehouse/inbound-batches put',
      );
      _showMessage(response['message']?.toString() ?? 'Batch diperbarui.');
    });
  }

  Future<void> _deleteBatch(Map<String, dynamic> row) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Hapus batch?'),
        content: const Text(
          'Batch dan semua unit QR yang masih di gudang akan dihapus.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Batal'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Hapus'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await _runAction(() async {
      await _decode(
        ApiClient.delete(
          '/api/mobile-adapter/admin/warehouse/inbound-batches/${row['id']}',
        ),
        'warehouse/inbound-batches delete',
      );
      _showMessage('Batch dihapus.');
    });
  }

  Widget _sectionTitle(String title, IconData icon) {
    return Row(
      children: [
        Icon(icon, color: _navy),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            title,
            style: const TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w900,
              color: Color(0xFF0F172A),
            ),
          ),
        ),
      ],
    );
  }

  Widget _sectionHeader(String title, {String? trailing}) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 4, 2, 8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              title,
              style: const TextStyle(
                color: Color(0xFF0F172A),
                fontSize: 16,
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
          if (trailing != null)
            Text(
              trailing,
              style: const TextStyle(
                color: Color(0xFF64748B),
                fontWeight: FontWeight.w800,
              ),
            ),
        ],
      ),
    );
  }
}

class _AddWarehouseItemDialog extends StatefulWidget {
  const _AddWarehouseItemDialog();

  @override
  State<_AddWarehouseItemDialog> createState() =>
      _AddWarehouseItemDialogState();
}

class _AddWarehouseItemDialogState extends State<_AddWarehouseItemDialog> {
  final _nameCtrl = TextEditingController();
  final _unitCtrl = TextEditingController();
  final _lowCtrl = TextEditingController(text: '5');
  String? _errorText;

  @override
  void dispose() {
    _nameCtrl.dispose();
    _unitCtrl.dispose();
    _lowCtrl.dispose();
    super.dispose();
  }

  void _submit() {
    final name = _nameCtrl.text.trim();
    if (name.isEmpty) {
      setState(() => _errorText = 'Nama barang wajib diisi.');
      return;
    }
    Navigator.of(context).pop({
      'name': name,
      'unit': _unitCtrl.text.trim(),
      'low_stock_threshold': int.tryParse(_lowCtrl.text.trim()) ?? 0,
    });
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: Colors.white,
      insetPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 24),
      title: const Row(
        children: [
          Icon(Icons.add_box_rounded, color: Color(0xFF2563EB)),
          SizedBox(width: 8),
          Expanded(
            child: Text(
              'Tambah nama barang',
              style: TextStyle(
                color: Color(0xFF0F172A),
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
        ],
      ),
      content: SingleChildScrollView(
        child: DefaultTextStyle.merge(
          style: const TextStyle(color: Color(0xFF0F172A)),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              _Field(controller: _nameCtrl, label: 'Nama barang'),
              _Field(controller: _unitCtrl, label: 'Satuan'),
              _Field(
                controller: _lowCtrl,
                label: 'Batas stok tipis',
                keyboardType: TextInputType.number,
              ),
              if (_errorText != null)
                Container(
                  width: double.infinity,
                  margin: const EdgeInsets.only(bottom: 4),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: const Color(0xFFE84C4F).withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: const Color(0xFFE84C4F).withValues(alpha: 0.24),
                    ),
                  ),
                  child: Text(
                    _errorText!,
                    style: const TextStyle(
                      color: Color(0xFFE84C4F),
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Batal'),
        ),
        FilledButton.icon(
          onPressed: _submit,
          style: FilledButton.styleFrom(
            backgroundColor: const Color(0xFF2563EB),
            foregroundColor: Colors.white,
          ),
          icon: const Icon(Icons.save_rounded),
          label: const Text('Simpan'),
        ),
      ],
    );
  }
}

class _WarehouseScanScreen extends StatefulWidget {
  final String title;

  const _WarehouseScanScreen({required this.title});

  @override
  State<_WarehouseScanScreen> createState() => _WarehouseScanScreenState();
}

class _WarehouseScanScreenState extends State<_WarehouseScanScreen>
    with WidgetsBindingObserver {
  final MobileScannerController _controller = MobileScannerController(
    facing: CameraFacing.back,
  );
  final ImagePicker _imagePicker = ImagePicker();
  bool _handled = false;
  bool _loadingPermission = true;
  bool _cameraDenied = false;
  bool _showScanner = false;
  bool _analyzingImage = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_prepareCamera());
  }

  Future<void> _prepareCamera() async {
    if (kIsWeb || (!Platform.isAndroid && !Platform.isIOS)) {
      if (!mounted) return;
      setState(() {
        _loadingPermission = false;
        _cameraDenied = false;
        _showScanner = true;
      });
      return;
    }
    var status = await Permission.camera.status;
    if (!status.isGranted) status = await Permission.camera.request();
    if (!mounted) return;
    setState(() {
      _loadingPermission = false;
      _cameraDenied = !(status.isGranted || status.isLimited);
      _showScanner = status.isGranted || status.isLimited;
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed &&
        mounted &&
        !_handled &&
        _showScanner) {
      unawaited(_controller.start());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller.dispose();
    super.dispose();
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_handled || !mounted) return;
    final value = _firstBarcodeValue(capture);
    if (value == null) return;
    await _finishScan(value);
  }

  String? _firstBarcodeValue(BarcodeCapture capture) {
    for (final barcode in capture.barcodes) {
      final value = barcode.rawValue;
      if (value != null && value.trim().isNotEmpty) {
        return value.trim();
      }
    }
    return null;
  }

  Future<void> _finishScan(String value) async {
    if (_handled || !mounted) return;
    _handled = true;
    try {
      await _controller.stop();
    } catch (_) {}
    if (mounted) Navigator.of(context).pop<String>(value.trim());
  }

  Future<void> _pickImageFromGallery() async {
    if (_handled || _analyzingImage) return;
    try {
      final image = await _imagePicker.pickImage(source: ImageSource.gallery);
      if (image == null) return;
      if (!mounted) return;
      setState(() => _analyzingImage = true);
      final capture = await _controller.analyzeImage(image.path);
      final value = capture == null ? null : _firstBarcodeValue(capture);
      if (value == null) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('QR/barcode tidak terbaca dari gambar.'),
          ),
        );
        return;
      }
      await _finishScan(value);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('Gagal membaca gambar: $e')));
    } finally {
      if (mounted) setState(() => _analyzingImage = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: Text(widget.title),
        backgroundColor: const Color(0xFF070038),
        foregroundColor: Colors.white,
      ),
      body: _body(),
    );
  }

  Widget _body() {
    if (_loadingPermission) {
      return const Center(
        child: CircularProgressIndicator(color: Colors.white),
      );
    }
    if (_cameraDenied) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.videocam_off_rounded,
                color: Colors.white54,
                size: 52,
              ),
              const SizedBox(height: 16),
              const Text(
                'Izin kamera diperlukan untuk scan QR/barcode.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white),
              ),
              const SizedBox(height: 18),
              FilledButton(
                onPressed: openAppSettings,
                child: const Text('Buka pengaturan'),
              ),
              const SizedBox(height: 10),
              OutlinedButton.icon(
                onPressed: _analyzingImage ? null : _pickImageFromGallery,
                style: OutlinedButton.styleFrom(
                  foregroundColor: Colors.white,
                  side: const BorderSide(color: Colors.white70),
                ),
                icon: _analyzingImage
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : const Icon(Icons.photo_library_rounded),
                label: Text(
                  _analyzingImage ? 'Membaca gambar...' : 'Pilih dari galeri',
                ),
              ),
            ],
          ),
        ),
      );
    }
    if (!_showScanner) return const SizedBox.shrink();
    return Stack(
      fit: StackFit.expand,
      children: [
        MobileScanner(
          controller: _controller,
          onDetect: _onDetect,
          fit: BoxFit.cover,
          tapToFocus: true,
        ),
        Positioned(
          left: 24,
          right: 24,
          bottom: 34,
          child: Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: Colors.black54,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text(
                  'Arahkan kamera ke QR/barcode, atau pilih gambar dari WhatsApp.',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: _analyzingImage ? null : _pickImageFromGallery,
                  style: FilledButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: const Color(0xFF2563EB),
                  ),
                  icon: _analyzingImage
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.photo_library_rounded),
                  label: Text(
                    _analyzingImage
                        ? 'Membaca gambar...'
                        : 'Pilih gambar dari galeri',
                    style: const TextStyle(fontWeight: FontWeight.w900),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _Card extends StatelessWidget {
  final Widget child;
  final bool compact;

  const _Card({required this.child, this.compact = false});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: EdgeInsets.only(bottom: compact ? 10 : 0),
      padding: EdgeInsets.all(compact ? 14 : 16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.05),
            blurRadius: 16,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: DefaultTextStyle.merge(
        style: const TextStyle(color: Color(0xFF0F172A)),
        child: IconTheme.merge(
          data: const IconThemeData(color: Color(0xFF2563EB)),
          child: child,
        ),
      ),
    );
  }
}

class _Field extends StatelessWidget {
  final TextEditingController controller;
  final String label;
  final TextInputType? keyboardType;
  final int maxLines;
  final ValueChanged<String>? onChanged;

  const _Field({
    required this.controller,
    required this.label,
    this.keyboardType,
    this.maxLines = 1,
    this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextField(
        controller: controller,
        keyboardType: keyboardType,
        maxLines: maxLines,
        onChanged: onChanged,
        style: const TextStyle(
          color: Color(0xFF0F172A),
          fontWeight: FontWeight.w400,
        ),
        cursorColor: Color(0xFF2563EB),
        inputFormatters: keyboardType == TextInputType.number
            ? [FilteringTextInputFormatter.digitsOnly]
            : null,
        decoration: _inputDecoration(label),
      ),
    );
  }
}

InputDecoration _inputDecoration(String label) {
  return InputDecoration(
    labelText: label,
    labelStyle: const TextStyle(
      color: Color(0xFF64748B),
      fontWeight: FontWeight.w400,
    ),
    floatingLabelStyle: const TextStyle(
      color: Color(0xFF2563EB),
      fontWeight: FontWeight.w800,
    ),
    hintStyle: const TextStyle(
      color: Color(0xFF94A3B8),
      fontWeight: FontWeight.w400,
    ),
    filled: true,
    fillColor: const Color(0xFFF8FAFC),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(14),
      borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(14),
      borderSide: const BorderSide(color: Color(0xFF2563EB), width: 1.4),
    ),
  );
}

class _Badge extends StatelessWidget {
  final String text;
  final Color color;

  const _Badge({required this.text, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: color,
          fontWeight: FontWeight.w900,
          fontSize: 12,
        ),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  final Color color;
  final String text;

  const _Notice({required this.color, required this.text});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: color.withValues(alpha: 0.24)),
      ),
      child: Text(
        text,
        style: TextStyle(color: color, fontWeight: FontWeight.w800),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  final String text;

  const _EmptyState({required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 18),
      child: Center(
        child: Text(
          text,
          textAlign: TextAlign.center,
          style: const TextStyle(
            color: Color(0xFF64748B),
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _ErrorState({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.error_outline_rounded,
              size: 42,
              color: Color(0xFFE84C4F),
            ),
            const SizedBox(height: 12),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh_rounded),
              label: const Text('Muat ulang'),
            ),
          ],
        ),
      ),
    );
  }
}
