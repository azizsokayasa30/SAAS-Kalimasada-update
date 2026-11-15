import 'package:flutter/material.dart';
import '../services/api_client.dart';
import 'customer_detail_screen.dart';

class RouterPppoeActiveScreen extends StatefulWidget {
  const RouterPppoeActiveScreen({
    super.key,
    required this.routerId,
    required this.routerName,
  });

  final String routerId;
  final String routerName;

  @override
  State<RouterPppoeActiveScreen> createState() =>
      _RouterPppoeActiveScreenState();
}

class _RouterPppoeActiveScreenState extends State<RouterPppoeActiveScreen> {
  static const Color _primary = Color(0xFF15803D);
  static const Color _surface = Color(0xFFF8F9FF);
  static const Color _outline = Color(0xFFCBC3D5);
  static const Color _text = Color(0xFF0B1C30);
  static const Color _subtleText = Color(0xFF494453);

  final TextEditingController _searchCtrl = TextEditingController();
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _sessions = [];
  String _query = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = _sessions.isEmpty;
      _error = null;
    });
    try {
      final response = await ApiClient.get(
        '/api/mobile-adapter/network-status/routers/'
        '${Uri.encodeComponent(widget.routerId)}/pppoe-active',
      );
      var body = <String, dynamic>{};
      try {
        body = ApiClient.decodeJsonObject(
          response,
          debugLabel: 'network-status/pppoe-active',
        );
      } on FormatException {
        if (response.statusCode == 200) rethrow;
      }
      if (!mounted) return;
      if (response.statusCode == 200 &&
          ApiClient.jsonSuccess(body['success'])) {
        final raw = body['data'];
        setState(() {
          _sessions = (raw is List)
              ? raw
                    .whereType<Map>()
                    .map((e) => Map<String, dynamic>.from(e))
                    .toList()
              : [];
        });
      } else if (response.statusCode == 404 && body['success'] == null) {
        setState(
          () => _error =
              'Server belum mendukung daftar PPPoE aktif. Update backend terlebih dahulu.',
        );
      } else {
        setState(
          () => _error =
              body['message']?.toString() ??
              'Gagal memuat PPPoE aktif (server ${response.statusCode})',
        );
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'Gagal memuat PPPoE aktif: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  List<Map<String, dynamic>> get _filtered {
    final q = _query.trim().toLowerCase();
    if (q.isEmpty) return _sessions;
    return _sessions.where((s) {
      return [
        s['name'],
        s['customer_name'],
        s['address'],
        s['caller_id'],
      ].any((v) => (v?.toString().toLowerCase() ?? '').contains(q));
    }).toList();
  }

  Map<String, dynamic> _customerFromSession(Map<String, dynamic> session, int id) {
    final login = session['name']?.toString().trim() ?? '';
    final name = session['customer_name']?.toString().trim() ?? '';
    return {
      'id': id,
      'name': name.isNotEmpty ? name : (login.isNotEmpty ? login : 'Pelanggan'),
      'phone': session['customer_phone']?.toString() ?? '',
      'pppoe_username': login,
      'username': login,
      'status': 'active',
      'pppoe_active': true,
    };
  }

  Map<String, dynamic>? _pickCustomerById(dynamic raw, int id) {
    if (raw is Map && int.tryParse('${raw['id']}') == id) {
      return Map<String, dynamic>.from(raw);
    }
    if (raw is List) {
      for (final row in raw.whereType<Map>()) {
        if (int.tryParse('${row['id']}') == id) {
          return Map<String, dynamic>.from(row);
        }
      }
    }
    return null;
  }

  Future<Map<String, dynamic>?> _fetchCustomerForSession(
    Map<String, dynamic> session,
    int id,
  ) async {
    final login = session['name']?.toString().trim() ?? '';
    final customerName = session['customer_name']?.toString().trim() ?? '';

    // 1) Endpoint detail by id (setelah backend di-update)
    try {
      final r = await ApiClient.get('/api/mobile-adapter/customers/$id');
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'customers/by-id-pppoe-active',
      );
      if (r.statusCode == 200 && ApiClient.jsonSuccess(body['success'])) {
        final hit = _pickCustomerById(body['data'], id);
        if (hit != null) return hit;
      }
    } catch (_) {}

    // 2) Search keyword (mencakup pppoe_username di /customers/search)
    for (final key in <String>{login, customerName, '$id'}) {
      if (key.isEmpty) continue;
      try {
        final r = await ApiClient.get(
          '/api/mobile-adapter/customers/search'
          '?q=${Uri.encodeQueryComponent(key)}',
        );
        final body = ApiClient.decodeJsonObject(
          r,
          debugLabel: 'customers/search-pppoe-active',
        );
        if (r.statusCode == 200 && ApiClient.jsonSuccess(body['success'])) {
          final hit = _pickCustomerById(body['data'], id);
          if (hit != null) {
            return {
              ...hit,
              if (login.isNotEmpty) 'pppoe_username': login,
              if (login.isNotEmpty) 'username': hit['username'] ?? login,
              'pppoe_active': true,
              if ((hit['profile'] == null ||
                      hit['profile'].toString().trim().isEmpty) &&
                  hit['package_name'] != null)
                'profile': hit['package_name'],
            };
          }
        }
      } catch (_) {}
    }

    // 3) List search (setelah backend ikut cari pppoe_username)
    for (final key in <String>{login, customerName}) {
      if (key.isEmpty) continue;
      try {
        final r = await ApiClient.get(
          '/api/mobile-adapter/customers?page=1&limit=50&month=all'
          '&search=${Uri.encodeQueryComponent(key)}',
        );
        final body = ApiClient.decodeJsonObject(
          r,
          debugLabel: 'customers/list-search-pppoe-active',
        );
        if (r.statusCode == 200 && ApiClient.jsonSuccess(body['success'])) {
          final hit = _pickCustomerById(body['data'], id);
          if (hit != null) return hit;
        }
      } catch (_) {}
    }

    // 4) Fallback: data dari sesi PPPoE (cukup untuk buka detail + load by id)
    return _customerFromSession(session, id);
  }

  Future<void> _openCustomer(Map<String, dynamic> session) async {
    final id = int.tryParse('${session['customer_id'] ?? ''}');
    if (id == null) return;
    final navigator = Navigator.of(context);
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) =>
          const Center(child: CircularProgressIndicator(color: Colors.white)),
    );
    final customer = await _fetchCustomerForSession(session, id);
    if (!mounted) return;
    navigator.pop();
    await navigator.push(
      MaterialPageRoute(
        builder: (_) => CustomerDetailScreen(customer: customer!),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final items = _filtered;
    return Scaffold(
      backgroundColor: _surface,
      appBar: AppBar(
        backgroundColor: const Color(0xFF2563EB),
        foregroundColor: Colors.white,
        elevation: 0,
        scrolledUnderElevation: 0,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'PPPoE Aktif',
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
            ),
            Text(
              widget.routerName,
              style: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: Colors.white70,
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: Colors.white),
            onPressed: _loading ? null : _load,
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: TextField(
              controller: _searchCtrl,
              onChanged: (v) => setState(() => _query = v),
              style: const TextStyle(color: _text),
              cursorColor: _primary,
              decoration: InputDecoration(
                hintText: 'Cari username, nama, IP, atau MAC',
                hintStyle: const TextStyle(color: _subtleText),
                prefixIcon: const Icon(Icons.search, color: _subtleText),
                suffixIcon: _query.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.close, color: _subtleText),
                        onPressed: () {
                          _searchCtrl.clear();
                          setState(() => _query = '');
                        },
                      ),
                filled: true,
                fillColor: Colors.white,
                isDense: true,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: _outline),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: _outline),
                ),
              ),
            ),
          ),
          if (!_loading && _error == null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Row(
                children: [
                  const Icon(Icons.lan, size: 18, color: _primary),
                  const SizedBox(width: 6),
                  Text(
                    _query.isEmpty
                        ? '${_sessions.length} sesi aktif'
                        : '${items.length} dari ${_sessions.length} sesi aktif',
                    style: const TextStyle(
                      color: _primary,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
          Expanded(
            child: _loading
                ? const Center(
                    child: CircularProgressIndicator(color: _primary),
                  )
                : RefreshIndicator(
                    color: _primary,
                    onRefresh: _load,
                    child: _error != null
                        ? ListView(
                            padding: const EdgeInsets.all(16),
                            children: [_messageCard(_error!, isError: true)],
                          )
                        : items.isEmpty
                        ? ListView(
                            padding: const EdgeInsets.all(16),
                            children: [
                              _messageCard(
                                _query.isEmpty
                                    ? 'Tidak ada sesi PPPoE aktif di router ini.'
                                    : 'Tidak ada hasil untuk "$_query".',
                              ),
                            ],
                          )
                        : ListView.separated(
                            padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                            itemCount: items.length,
                            separatorBuilder: (_, _) =>
                                const SizedBox(height: 8),
                            itemBuilder: (_, i) => _sessionTile(items[i]),
                          ),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _sessionTile(Map<String, dynamic> s) {
    final login = s['name']?.toString() ?? '-';
    final customerName = s['customer_name']?.toString().trim() ?? '';
    final address = s['address']?.toString() ?? '-';
    final uptime = s['uptime']?.toString() ?? '-';
    final callerId = s['caller_id']?.toString() ?? '';
    final hasCustomer = s['customer_id'] != null;

    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: hasCustomer ? () => _openCustomer(s) : null,
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: _outline),
          ),
          child: Row(
            children: [
              Container(
                width: 10,
                height: 10,
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  color: Color(0xFF10B981),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      customerName.isNotEmpty ? customerName : login,
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                        color: _text,
                      ),
                    ),
                    if (customerName.isNotEmpty)
                      Text(
                        login,
                        style: const TextStyle(
                          fontSize: 12,
                          color: _subtleText,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    const SizedBox(height: 4),
                    Text(
                      'IP $address · Uptime $uptime',
                      style: const TextStyle(fontSize: 12, color: _subtleText),
                    ),
                    if (callerId.isNotEmpty)
                      Text(
                        'MAC $callerId',
                        style: const TextStyle(
                          fontSize: 11,
                          color: _subtleText,
                        ),
                      ),
                  ],
                ),
              ),
              if (hasCustomer)
                const Icon(Icons.chevron_right, color: _subtleText),
            ],
          ),
        ),
      ),
    );
  }

  Widget _messageCard(String message, {bool isError = false}) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: isError ? const Color(0xFFFFE9E9) : Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: isError ? const Color(0xFFFFCACA) : _outline),
      ),
      child: Text(
        message,
        style: TextStyle(
          color: isError ? const Color(0xFF8A1212) : _subtleText,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
