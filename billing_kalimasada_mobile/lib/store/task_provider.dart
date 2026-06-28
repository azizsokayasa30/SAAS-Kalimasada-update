import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import '../services/api_client.dart';

/// Parse `work_started_at` dari API (wall clock lokal / ISO). Dipakai timer di layar tugas.
DateTime? parseTaskWorkStarted(String? raw) {
  if (raw == null) return null;
  var s = raw.trim();
  if (s.isEmpty) return null;
  try {
    if (s.endsWith('Z') || RegExp(r'[+-]\d{2}:\d{2}$').hasMatch(s)) {
      return DateTime.parse(s);
    }
    if (!s.contains('T')) {
      s = s.replaceFirst(' ', 'T');
    }
    return DateTime.parse(s);
  } catch (_) {
    return null;
  }
}

class TaskProvider extends ChangeNotifier {
  bool _loading = false;
  bool _historyLoading = false;
  String? _error;
  List<dynamic> _tasks = [];
  List<dynamic> _historyTasks = [];

  bool _weekPerfLoading = false;
  String? _weekPerfError;
  List<Map<String, dynamic>> _weekPerfDays = [];
  int _tasksWeekTotal = 0;
  double _attendanceWeekAvg = 0;
  bool _employeeMatched = false;
  int _tasksWeekMaxPerDay = 0;

  bool get loading => _loading;
  bool get historyLoading => _historyLoading;
  String? get error => _error;
  List<dynamic> get tasks => _tasks;
  List<dynamic> get historyTasks => _historyTasks;

  bool get weekPerfLoading => _weekPerfLoading;
  String? get weekPerfError => _weekPerfError;
  List<Map<String, dynamic>> get weekPerfDays => _weekPerfDays;
  int get tasksWeekTotal => _tasksWeekTotal;
  double get attendanceWeekAvg => _attendanceWeekAvg;
  bool get employeeMatched => _employeeMatched;
  int get tasksWeekMaxPerDay => _tasksWeekMaxPerDay;

  Future<void> fetchTasks({bool refresh = false}) async {
    if (_loading && !refresh) return;

    _loading = true;
    _error = null;
    if (refresh) notifyListeners();

    try {
      final path = refresh
          ? '/api/mobile-adapter/tasks?_=${DateTime.now().millisecondsSinceEpoch}'
          : '/api/mobile-adapter/tasks';
      final response = await ApiClient.get(path);

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (ApiClient.jsonSuccess(data['success'])) {
          final raw = data['data'];
          _tasks = raw is List ? raw : <dynamic>[];
        } else {
          _error = data['message']?.toString();
        }
      } else {
        _error = 'Gagal memuat data tugas';
      }
    } catch (e) {
      _error = 'Koneksi bermasalah: ${e.toString()}';
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  Future<void> fetchTaskHistory({bool refresh = false}) async {
    if (_historyLoading && !refresh) return;

    _historyLoading = true;
    if (refresh) notifyListeners();

    try {
      final path = refresh
          ? '/api/mobile-adapter/tasks?history=1&_=${DateTime.now().millisecondsSinceEpoch}'
          : '/api/mobile-adapter/tasks?history=1';
      final response = await ApiClient.get(path);

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (ApiClient.jsonSuccess(data['success'])) {
          final raw = data['data'];
          _historyTasks = raw is List ? raw : <dynamic>[];
        }
      }
    } catch (_) {
      // Riwayat bersifat pendukung untuk filter "Selesai"; daftar aktif tetap ditampilkan.
    } finally {
      _historyLoading = false;
      notifyListeners();
    }
  }

  /// Data minggu Sen–Min (Asia/Jakarta) untuk kartu Performa: tugas selesai + skor absensi.
  Future<void> fetchWeekPerformance({bool refresh = false}) async {
    if (_weekPerfLoading && !refresh) return;
    _weekPerfLoading = true;
    _weekPerfError = null;
    if (refresh) notifyListeners();

    try {
      final path = refresh
          ? '/api/mobile-adapter/performance/week?_=${DateTime.now().millisecondsSinceEpoch}'
          : '/api/mobile-adapter/performance/week';
      final response = await ApiClient.get(path);
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (ApiClient.jsonSuccess(data['success']) && data['data'] is Map) {
          final inner = Map<String, dynamic>.from(data['data'] as Map);
          final rawDays = inner['days'];
          final list = <Map<String, dynamic>>[];
          if (rawDays is List) {
            for (final e in rawDays) {
              if (e is Map) {
                list.add(Map<String, dynamic>.from(e));
              }
            }
          }
          _weekPerfDays = list;
          _tasksWeekTotal = (inner['tasks_week_total'] as num?)?.toInt() ?? 0;
          final rawAvg = inner['attendance_week_avg'];
          _attendanceWeekAvg = rawAvg is num
              ? rawAvg.toDouble()
              : double.tryParse('$rawAvg') ?? 0;
          _employeeMatched = inner['employee_matched'] == true;
          _tasksWeekMaxPerDay =
              (inner['tasks_week_max_per_day'] as num?)?.toInt() ?? 0;
        } else {
          _weekPerfError =
              data['message']?.toString() ?? 'Gagal memuat performa';
        }
      } else {
        _weekPerfError = 'Gagal memuat performa (${response.statusCode})';
      }
    } catch (e) {
      _weekPerfError = e.toString();
    } finally {
      _weekPerfLoading = false;
      notifyListeners();
    }
  }

  Future<bool> updateTaskStatus(
    String id,
    String type,
    String status, {
    String? pendingReason,
  }) async {
    try {
      final body = <String, dynamic>{'status': status};
      final pr = pendingReason?.trim() ?? '';
      if (pr.isNotEmpty) {
        body['pending_reason'] = pr;
      }
      final response = await ApiClient.post(
        '/api/mobile-adapter/tasks/$type/$id/status',
        body,
      );

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data['success'] == true) {
          await fetchTasks(refresh: true);
          return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  /// Penyelesaian dari app (deskripsi wajib; foto opsional base64).
  /// Mengembalikan `null` jika sukses, atau pesan error.
  Future<String?> submitTaskCompletion(
    String id,
    String type, {
    required String completionDescription,
    String? completionPhotoBase64,

    /// Durasi eksekusi di layar penyelesaian (detik), dari timer app — disimpan di server untuk detail laporan.
    int? workDurationSeconds,
    double? completionLatitude,
    double? completionLongitude,
    double? cableLengthM,
    String? stickerPhotoBase64,
  }) async {
    try {
      final body = <String, dynamic>{
        'status': 'selesai',
        'completion_description': completionDescription.trim(),
      };
      if (workDurationSeconds != null && workDurationSeconds >= 0) {
        body['work_duration_seconds'] = workDurationSeconds;
      }
      if (completionLatitude != null && completionLongitude != null) {
        body['completion_latitude'] = completionLatitude;
        body['completion_longitude'] = completionLongitude;
      }
      if (cableLengthM != null && cableLengthM >= 0) {
        body['cable_length_m'] = cableLengthM;
      }
      if (stickerPhotoBase64 != null && stickerPhotoBase64.isNotEmpty) {
        body['sticker_photo_base64'] = stickerPhotoBase64;
      }
      if (completionPhotoBase64 != null && completionPhotoBase64.isNotEmpty) {
        body['completion_photo_base64'] = completionPhotoBase64;
      }
      final response = await ApiClient.post(
        '/api/mobile-adapter/tasks/$type/$id/status',
        body,
      );
      Map<String, dynamic> data;
      try {
        data = jsonDecode(response.body) as Map<String, dynamic>;
      } catch (_) {
        return 'Respons server tidak valid';
      }
      if (response.statusCode == 200 && data['success'] == true) {
        // Jangan tunggu refresh daftar — server sudah selesai; UI bisa tutup layar lebih cepat.
        unawaited(fetchTasks(refresh: true));
        unawaited(fetchWeekPerformance(refresh: true));
        return null;
      }
      return data['message']?.toString() ?? 'Gagal menyimpan penyelesaian';
    } catch (e) {
      return e.toString();
    }
  }
}
