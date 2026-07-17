import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../services/api_client.dart';

/// Notifikasi in-app kolektor (tagihan baru, isolir, pembatalan, setoran admin).
class CollectorNotificationProvider extends ChangeNotifier {
  Timer? _pollTimer;
  bool _loading = false;
  String? _error;
  List<Map<String, dynamic>> _items = [];
  int _unreadCount = 0;

  List<Map<String, dynamic>> get items => List.unmodifiable(_items);
  int get unreadCount => _unreadCount;
  bool get loading => _loading;
  String? get error => _error;

  void ensurePolling() {
    _pollTimer ??= Timer.periodic(const Duration(seconds: 42), (_) {
      fetchNotifications(silent: true);
    });
  }

  void stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  void clear() {
    stopPolling();
    _loading = false;
    _error = null;
    _items = [];
    _unreadCount = 0;
    notifyListeners();
  }

  Future<void> fetchNotifications({bool silent = false}) async {
    if (!silent) {
      if (_loading) return;
      _loading = true;
      _error = null;
      notifyListeners();
    }
    try {
      final response = await ApiClient.get('/api/mobile-adapter/collector/notifications?limit=80');
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data['success'] == true && data['data'] is Map) {
          final inner = data['data'] as Map<String, dynamic>;
          final list = inner['items'];
          _unreadCount = (inner['unread_count'] is int)
              ? inner['unread_count'] as int
              : int.tryParse('${inner['unread_count'] ?? 0}') ?? 0;
          if (list is List) {
            _items = list.map((e) => Map<String, dynamic>.from(e as Map)).toList();
          }
          _error = null;
        } else {
          _error = data['message']?.toString() ?? 'Gagal memuat notifikasi';
        }
      } else {
        _error = 'Gagal memuat notifikasi';
      }
    } catch (e) {
      _error = e.toString();
    } finally {
      if (!silent) _loading = false;
      notifyListeners();
    }
  }

  Future<bool> markRead(dynamic id) async {
    final nid = id is int ? id : int.tryParse(id.toString());
    if (nid == null) return false;
    try {
      final response = await ApiClient.post('/api/mobile-adapter/collector/notifications/$nid/read', {});
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data['success'] == true) {
          for (var i = 0; i < _items.length; i++) {
            final rid = _items[i]['id'];
            final match = rid == nid || (rid is num && rid.toInt() == nid);
            if (match) {
              _items[i]['read_at'] = DateTime.now().toIso8601String();
              _items[i]['unread'] = false;
              break;
            }
          }
          _unreadCount = _items.where((e) => e['unread'] == true).length;
          notifyListeners();
          return true;
        }
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  Future<void> markAllRead() async {
    try {
      final response = await ApiClient.post('/api/mobile-adapter/collector/notifications/read-all', {});
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data['success'] == true) {
          for (var i = 0; i < _items.length; i++) {
            _items[i]['unread'] = false;
          }
          _unreadCount = 0;
          notifyListeners();
          await fetchNotifications(silent: true);
        }
      }
    } catch (_) {}
  }
}
