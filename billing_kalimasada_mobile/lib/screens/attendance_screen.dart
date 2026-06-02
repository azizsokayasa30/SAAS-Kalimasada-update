import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../store/notification_provider.dart';
import 'attendance_qr_scan_screen.dart';
import 'settings_screen.dart';

/// State mutable untuk bottom sheet izin/cuti (bukan `State` widget).
class _LeaveSheetModel {
  _LeaveSheetModel() : dateDisplay = TextEditingController();

  DateTime? startDate;
  String requestType = 'izin';
  bool submitting = false;
  final TextEditingController dateDisplay;

  void dispose() {
    dateDisplay.dispose();
  }
}

class AttendanceScreen extends StatefulWidget {
  const AttendanceScreen({super.key});

  @override
  State<AttendanceScreen> createState() => _AttendanceScreenState();
}

class _AttendanceScreenState extends State<AttendanceScreen> {
  bool _isLoading = true;
  bool _isActionLoading = false;
  String _status = 'awaiting'; // 'awaiting', 'checked_in', 'checked_out'
  Map<String, dynamic>? _attendanceData;
  String? _attendanceNotice;
  Timer? _timer;
  Timer? _statusRefreshTimer;
  DateTime _currentTime = DateTime.now();
  bool _autoCheckoutToastShown = false;

  /// `selfie` | `qr` — wajib sebelum masuk. GPS selalu dipakai saat masuk (bukan pilihan mode).
  String? _checkInMode;
  bool _employeeMatched = true;
  final List<String> _sessionLogs = [];
  /// Izin/cuti yang sudah diproses admin (30 hari), dari API `leave-requests/recent`.
  List<Map<String, dynamic>> _recentLeaves = [];

  // Stitch Design System Colors
  static const Color bgColor = Color(0xFFFCF8FF);
  static const Color surfaceColor = Colors.white;
  static const Color primaryDark = Color(0xFF070038);
  static const Color textMain = Color(0xFF19163F);
  static const Color textSecondary = Color(0xFF474551);
  static const Color borderColor = Color(0xFFE4DFFF);
  static const Color mutedPurple = Color(0xFFEAE5FF);
  static const Color iconColor = Color(0xFF5A53AB);

  @override
  void initState() {
    super.initState();
    _fetchStatus();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      try {
        context.read<NotificationProvider>().fetchNotifications(silent: true);
      } catch (_) {}
    });
    _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (mounted) {
        setState(() {
          _currentTime = DateTime.now();
        });
      }
    });
    _statusRefreshTimer = Timer.periodic(const Duration(minutes: 1), (_) {
      _fetchStatus(silent: true, keepLoading: false);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _statusRefreshTimer?.cancel();
    super.dispose();
  }

  void _log(String message) {
    final line =
        '${DateTime.now().toIso8601String().substring(11, 19)}  $message';
    debugPrint('[absensi] $line');
    if (!mounted) return;
    setState(() {
      _sessionLogs.insert(0, line);
      if (_sessionLogs.length > 40) {
        _sessionLogs.removeLast();
      }
    });
  }

  double? _toDouble(dynamic value) {
    if (value is num) return value.toDouble();
    if (value == null) return null;
    return double.tryParse(value.toString().trim());
  }

  String _buildAttendanceErrorMessage(
    Map<String, dynamic> payload, {
    String fallback = 'Gagal memproses absensi',
  }) {
    final baseMessage = payload['message']?.toString().trim();
    final detailsRaw = payload['details'];
    final details = detailsRaw is Map
        ? Map<String, dynamic>.from(detailsRaw)
        : null;
    if (details == null) {
      return (baseMessage == null || baseMessage.isEmpty) ? fallback : baseMessage;
    }

    final branchName =
        details['branch_name']?.toString().trim().isNotEmpty == true
            ? details['branch_name'].toString().trim()
            : 'branch';
    final distance = _toDouble(details['distance_m']);
    final radius = _toDouble(details['radius_m']);
    final needCloser = _toDouble(details['need_closer_m']);
    if (distance != null && radius != null) {
      final distanceText = distance.round();
      final radiusText = radius.round();
      final needText = (needCloser != null && needCloser > 0)
          ? '\nDekati lokasi sekitar ${needCloser.round()} meter lagi.'
          : '';
      return 'Gagal absen: Anda di luar radius $branchName.\nJarak Anda $distanceText m (maksimal $radiusText m).$needText';
    }

    return (baseMessage == null || baseMessage.isEmpty) ? fallback : baseMessage;
  }

  Future<void> _fetchStatus({
    bool silent = false,
    bool keepLoading = true,
  }) async {
    if (keepLoading && mounted) {
      setState(() => _isLoading = true);
    }
    try {
      final res = await ApiClient.get('/api/mobile-adapter/attendance/status');
      final leaveRes = await ApiClient.get('/api/mobile-adapter/leave-requests/recent');
      if (leaveRes.statusCode == 200) {
        try {
          final leaveJson = jsonDecode(leaveRes.body) as Map<String, dynamic>;
          if (leaveJson['success'] == true && leaveJson['data'] is List) {
            _recentLeaves = (leaveJson['data'] as List)
                .map((e) => Map<String, dynamic>.from(e as Map))
                .toList();
          } else {
            _recentLeaves = [];
          }
        } catch (_) {
          _recentLeaves = [];
        }
      }
      if (res.statusCode == 200) {
        final response = jsonDecode(res.body) as Map<String, dynamic>;
        if (response['success'] == true) {
          _employeeMatched = response['employee_matched'] != false;
          final data = response['data'];
          final responseNotice = response['attendance_notice']?.toString();
          final autoCheckOut = response['auto_check_out_applied'] == true ||
              (data is Map && data['auto_check_out'] == true);
          if (data == null) {
            _status = 'awaiting';
            _attendanceData = null;
            _attendanceNotice = responseNotice;
          } else if (data['check_out'] != null) {
            _status = 'checked_out';
            _attendanceData = Map<String, dynamic>.from(
              data as Map<dynamic, dynamic>,
            );
            _attendanceNotice =
                responseNotice ??
                _attendanceData?['late_notice']?.toString() ??
                _extractLateNoticeFromNotes(_attendanceData?['notes']);
          } else if (data['check_in'] != null) {
            _status = 'checked_in';
            _attendanceData = Map<String, dynamic>.from(
              data as Map<dynamic, dynamic>,
            );
            _attendanceNotice =
                responseNotice ??
                _attendanceData?['late_notice']?.toString() ??
                _extractLateNoticeFromNotes(_attendanceData?['notes']);
          } else {
            _status = 'awaiting';
            _attendanceData = null;
            _attendanceNotice = responseNotice;
          }
          _log(
            'Status: $_status (karyawan DB: ${_employeeMatched ? "cocok" : "tidak cocok"})',
          );
          if (autoCheckOut && !_autoCheckoutToastShown && mounted) {
            _autoCheckoutToastShown = true;
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text(
                  'Absensi pulang otomatis dicatat (lewat jam shift +10 menit).',
                ),
                backgroundColor: Colors.green,
              ),
            );
          }
        }
      }
    } catch (e) {
      debugPrint('Error fetching attendance status: $e');
      if (!silent && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Gagal memuat status absensi: $e')),
        );
      }
    } finally {
      if (keepLoading && mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  String? _extractLateNoticeFromNotes(dynamic rawNotes) {
    final notes = (rawNotes ?? '').toString();
    if (notes.trim().isEmpty) return null;
    final marker = RegExp(r'\[LATE_MINUTES:(\d+)\]\s*([^|]*)');
    final m = marker.firstMatch(notes);
    if (m == null) return null;
    final minutes = int.tryParse((m.group(1) ?? '').trim()) ?? 0;
    final text = (m.group(2) ?? '').trim();
    if (text.isNotEmpty) return text;
    if (minutes > 0) return 'Anda terlambat $minutes menit';
    return null;
  }

  Future<Position?> _determinePosition() async {
    bool serviceEnabled;
    LocationPermission permission;

    serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Layanan lokasi dinonaktifkan. Harap nyalakan GPS.'),
          ),
        );
      }
      return null;
    }

    permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) {
        if (mounted) {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(const SnackBar(content: Text('Izin lokasi ditolak.')));
        }
        return null;
      }
    }

    if (permission == LocationPermission.deniedForever) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Izin lokasi ditolak permanen, harap izinkan di pengaturan.',
            ),
          ),
        );
      }
      return null;
    }

    return await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(accuracy: LocationAccuracy.high),
    );
  }

  Future<void> _performAction(String type) async {
    if (_status == 'checked_out' && type != 'check_out') return;

    if (type == 'check_in' && _checkInMode == null) {
      _log('Masuk ditolak: mode absensi belum dipilih');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Pilih mode absensi terlebih dahulu (Selfie atau Scan QR).',
            ),
            backgroundColor: Colors.deepOrange,
          ),
        );
      }
      return;
    }

    setState(() => _isActionLoading = true);
    final aksiLog = type == 'check_in' ? 'masuk' : 'pulang';
    _log('Memulai $aksiLog (mode: ${_checkInMode ?? "-"})');

    try {
      final position = await _determinePosition();
      if (position == null) {
        _log('GPS tidak tersedia — proses dibatalkan');
        setState(() => _isActionLoading = false);
        return;
      }
      _log(
        'GPS OK lat=${position.latitude.toStringAsFixed(5)} lng=${position.longitude.toStringAsFixed(5)}',
      );

      String? photoBase64;
      String? qrValue;

      if (type == 'check_in') {
        if (_checkInMode == 'selfie') {
          final picker = ImagePicker();
          final XFile? photo = await picker.pickImage(
            source: ImageSource.camera,
            preferredCameraDevice: CameraDevice.front,
            imageQuality: 50,
            maxWidth: 800,
          );
          if (photo == null) {
            _log('Selfie dibatalkan');
            setState(() => _isActionLoading = false);
            return;
          }
          final bytes = await photo.readAsBytes();
          photoBase64 = base64Encode(bytes);
          _log('Selfie OK (${photoBase64.length} karakter base64)');
        } else if (_checkInMode == 'qr') {
          if (!mounted) return;
          final scanned = await Navigator.push<String>(
            context,
            MaterialPageRoute(builder: (_) => const AttendanceQrScanScreen()),
          );
          if (scanned == null || scanned.isEmpty) {
            _log('QR dibatalkan atau kosong');
            setState(() => _isActionLoading = false);
            return;
          }
          qrValue = scanned;
          _log('QR OK (${qrValue.length} karakter)');
        }
      }

      final body = <String, dynamic>{
        'type': type,
        'location': {
          'latitude': position.latitude,
          'longitude': position.longitude,
        },
      };
      if (type == 'check_in') {
        body['check_in_mode'] = _checkInMode;
        if (photoBase64 != null) body['photo_base64'] = photoBase64;
        if (qrValue != null) body['qr_value'] = qrValue;
      }

      final res = await ApiClient.post('/api/mobile-adapter/attendance', body);
      _log('HTTP ${res.statusCode}');
      final preview = res.body.length > 220 ? '${res.body.substring(0, 220)}…' : res.body;
      _log('Body: $preview');

      if (res.statusCode == 200) {
        final Map<String, dynamic> response;
        try {
          response = ApiClient.decodeJsonObject(res, debugLabel: 'absensi');
        } on FormatException catch (e) {
          _log('JSON tidak valid: $e');
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text('Respons server tidak valid: $e'),
                backgroundColor: Colors.red,
              ),
            );
          }
          return;
        }
        if (response['success'] == true) {
          _log('Berhasil: ${response['message'] ?? "OK"}');
          if (type == 'check_in') {
            setState(() => _checkInMode = null);
          }
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text(response['message']?.toString() ?? 'Berhasil'),
                backgroundColor: Colors.green,
              ),
            );
          }
          await _fetchStatus();
        } else {
          _log('Server: ${response['message']}');
          final errorMessage = _buildAttendanceErrorMessage(
            response,
            fallback: 'Gagal memproses absensi',
          );
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text(errorMessage),
                backgroundColor: Colors.red,
              ),
            );
          }
        }
      } else {
        _log('Error HTTP ${res.statusCode}');
        String errorMessage = 'Server ${res.statusCode}';
        try {
          final err = ApiClient.decodeJsonObject(res, debugLabel: 'absensi-error');
          errorMessage = _buildAttendanceErrorMessage(
            err,
            fallback: errorMessage,
          );
        } catch (_) {}
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(errorMessage),
              backgroundColor: Colors.red,
            ),
          );
        }
      }
    } catch (e, st) {
      debugPrint('Error performing attendance action: $e\n$st');
      _log('Exception: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Gagal: $e'), backgroundColor: Colors.red),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _isActionLoading = false);
      }
    }
  }

  String _formatTime(DateTime time) {
    return '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}:${time.second.toString().padLeft(2, '0')}';
  }

  String _formatShortTime(String? dateStr) {
    if (dateStr == null) return '--:--';
    try {
      final dt = DateTime.parse(dateStr).toLocal();
      const monthNames = [
        'Jan',
        'Peb',
        'Mar',
        'Apr',
        'Mei',
        'Jun',
        'Jul',
        'Agu',
        'Sep',
        'Okt',
        'Nov',
        'Des',
      ];
      final month = monthNames[dt.month - 1];
      final day = dt.day.toString().padLeft(2, '0');
      final hour = dt.hour.toString().padLeft(2, '0');
      final minute = dt.minute.toString().padLeft(2, '0');
      return '$month $day, $hour:$minute';
    } catch (_) {
      return '--:--';
    }
  }

  void _showLeaveRequestForm(BuildContext context) {
    final reasonController = TextEditingController();
    final durationController = TextEditingController();
    final messenger = ScaffoldMessenger.of(context);
    final sheetDateFmt = DateFormat('dd/MM/yyyy');
    final apiDateFmt = DateFormat('yyyy-MM-dd');
    final model = _LeaveSheetModel();
    var sheetClosed = false;

    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: bgColor,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (sheetContext) {
        return StatefulBuilder(
          builder: (context, setModalState) {
            Future<void> submit() async {
              final reason = reasonController.text.trim();
              final days = int.tryParse(durationController.text.trim());
              if (model.startDate == null ||
                  reason.isEmpty ||
                  durationController.text.trim().isEmpty) {
                messenger.showSnackBar(
                  const SnackBar(
                    content: Text('Lengkapi jenis, tanggal mulai, jumlah hari, dan alasan.'),
                    backgroundColor: Colors.red,
                  ),
                );
                return;
              }
              if (days == null || days < 1 || days > 366) {
                messenger.showSnackBar(
                  const SnackBar(
                    content: Text('Jumlah hari tidak valid (1–366).'),
                    backgroundColor: Colors.red,
                  ),
                );
                return;
              }
              final endDate = model.startDate!.add(Duration(days: days - 1));
              setModalState(() => model.submitting = true);
              try {
                final res = await ApiClient.post('/api/mobile-adapter/leave-request', {
                  'request_type': model.requestType,
                  'start_date': apiDateFmt.format(model.startDate!),
                  'end_date': apiDateFmt.format(endDate),
                  'reason': reason,
                });
                if (res.statusCode != 200) {
                  messenger.showSnackBar(
                    SnackBar(
                      content: Text('Server ${res.statusCode}'),
                      backgroundColor: Colors.red,
                    ),
                  );
                  return;
                }
                final Map<String, dynamic> json;
                try {
                  json = ApiClient.decodeJsonObject(res, debugLabel: 'izin-cuti');
                } on FormatException catch (e) {
                  messenger.showSnackBar(
                    SnackBar(
                      content: Text('Respons tidak valid: $e'),
                      backgroundColor: Colors.red,
                    ),
                  );
                  return;
                }
                if (json['success'] == true) {
                  if (sheetContext.mounted) Navigator.pop(sheetContext);
                  messenger.showSnackBar(
                    SnackBar(
                      content: Text(
                        json['message']?.toString() ??
                            'Permintaan dikirim. Admin dapat menyetujui di halaman Permintaan Izin/Cuti.',
                      ),
                      backgroundColor: Colors.green,
                    ),
                  );
                  _log(
                    'Izin/cuti dikirim: ${model.requestType} ${apiDateFmt.format(model.startDate!)} s/d ${apiDateFmt.format(endDate)}',
                  );
                  await _fetchStatus();
                } else {
                  messenger.showSnackBar(
                    SnackBar(
                      content: Text(json['message']?.toString() ?? 'Gagal mengirim'),
                      backgroundColor: Colors.red,
                    ),
                  );
                }
              } catch (e) {
                messenger.showSnackBar(
                  SnackBar(
                    content: Text('Gagal mengirim: $e'),
                    backgroundColor: Colors.red,
                  ),
                );
              } finally {
                if (!sheetClosed && sheetContext.mounted) {
                  setModalState(() => model.submitting = false);
                }
              }
            }

            return Padding(
              padding: EdgeInsets.only(
                bottom: MediaQuery.of(sheetContext).viewInsets.bottom,
                left: 24,
                right: 24,
                top: 24,
              ),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(
                      'Formulir Izin/Cuti',
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.bold,
                        color: primaryDark,
                      ),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Permintaan masuk ke admin untuk disetujui atau ditolak.',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 12, color: textSecondary.withValues(alpha: 0.9)),
                    ),
                    const SizedBox(height: 20),
                    const Text('Jenis', style: TextStyle(color: textSecondary, fontSize: 13)),
                    const SizedBox(height: 8),
                    IgnorePointer(
                      ignoring: model.submitting,
                      child: SegmentedButton<String>(
                        segments: const [
                          ButtonSegment<String>(value: 'izin', label: Text('Izin')),
                          ButtonSegment<String>(value: 'cuti', label: Text('Cuti')),
                        ],
                        selected: {model.requestType},
                        onSelectionChanged: (Set<String> sel) {
                          if (sel.isNotEmpty) {
                            setModalState(() => model.requestType = sel.first);
                          }
                        },
                      ),
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      readOnly: true,
                      style: const TextStyle(color: textMain),
                      controller: model.dateDisplay,
                      decoration: InputDecoration(
                        labelText: 'Tanggal mulai',
                        labelStyle: const TextStyle(color: textSecondary),
                        prefixIcon: const Icon(Icons.calendar_today, color: iconColor),
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                        focusedBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                          borderSide: const BorderSide(color: primaryDark, width: 2),
                        ),
                      ),
                      onTap: model.submitting
                          ? null
                          : () async {
                              final d = await showDatePicker(
                                context: sheetContext,
                                initialDate: model.startDate ?? DateTime.now(),
                                firstDate: DateTime.now().subtract(const Duration(days: 1)),
                                lastDate: DateTime.now().add(const Duration(days: 365)),
                              );
                              if (d != null) {
                                setModalState(() {
                                  model.startDate = d;
                                  model.dateDisplay.text = sheetDateFmt.format(d);
                                });
                              }
                            },
                    ),
                    const SizedBox(height: 16),
                    TextField(
                      controller: durationController,
                      enabled: !model.submitting,
                      style: const TextStyle(color: textMain),
                      keyboardType: TextInputType.number,
                      decoration: InputDecoration(
                        labelText: 'Jumlah hari (termasuk hari mulai)',
                        labelStyle: const TextStyle(color: textSecondary),
                        prefixIcon: const Icon(Icons.access_time, color: iconColor),
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                        focusedBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                          borderSide: const BorderSide(color: primaryDark, width: 2),
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    TextField(
                      controller: reasonController,
                      enabled: !model.submitting,
                      style: const TextStyle(color: textMain),
                      maxLines: 3,
                      decoration: InputDecoration(
                        labelText: 'Alasan',
                        labelStyle: const TextStyle(color: textSecondary),
                        alignLabelWithHint: true,
                        prefixIcon: const Padding(
                          padding: EdgeInsets.only(bottom: 48.0),
                          child: Icon(Icons.edit_document, color: iconColor),
                        ),
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                        focusedBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                          borderSide: const BorderSide(color: primaryDark, width: 2),
                        ),
                      ),
                    ),
                    const SizedBox(height: 24),
                    ElevatedButton(
                      onPressed: model.submitting ? null : submit,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: primaryDark,
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                      child: model.submitting
                          ? const SizedBox(
                              height: 22,
                              width: 22,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Text(
                              'Kirim permintaan',
                              style: TextStyle(
                                color: Colors.white,
                                fontSize: 16,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                    ),
                    const SizedBox(height: 32),
                  ],
                ),
              ),
            );
          },
        );
      },
    ).whenComplete(() {
      sheetClosed = true;
      // Jangan dispose manual di sini: pada beberapa device, animasi penutupan
      // bottom sheet masih melakukan rebuild singkat sehingga controller bisa
      // tersentuh lagi dan memicu "used after being disposed".
    });
  }

  @override
  Widget build(BuildContext context) {
    final statusText = _status == 'awaiting'
        ? 'Belum masuk'
        : _status == 'checked_in'
        ? 'Sudah masuk'
        : 'Sudah pulang';

    return Scaffold(
      backgroundColor: bgColor,
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.pop(context),
        ),
        title: const Text(
          'Absensi',
          style: TextStyle(
            fontWeight: FontWeight.bold,
            fontSize: 20,
            color: primaryDark,
          ),
        ),
        centerTitle: false,
        backgroundColor: bgColor,
        elevation: 0,
        iconTheme: const IconThemeData(color: primaryDark),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 16.0),
            child: GestureDetector(
              onTap: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (context) => const SettingsScreen(),
                  ),
                );
              },
              child: CircleAvatar(
                backgroundColor: mutedPurple,
                radius: 16,
                child: const Icon(Icons.person, color: textSecondary, size: 20),
              ),
            ),
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator(color: primaryDark))
          : RefreshIndicator(
              onRefresh: () => _fetchStatus(silent: false, keepLoading: false),
              color: primaryDark,
              child: SingleChildScrollView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(20.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // Timer Section
                    Container(
                      padding: const EdgeInsets.symmetric(vertical: 32),
                      decoration: BoxDecoration(
                        color: surfaceColor,
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: borderColor),
                      ),
                      child: Column(
                        children: [
                          const Text(
                            'STATUS HARI INI',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                              letterSpacing: 1.2,
                              color: textSecondary,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            _formatTime(_currentTime),
                            style: const TextStyle(
                              fontSize: 40,
                              fontWeight: FontWeight.w800,
                              color: primaryDark,
                              fontFamily: 'Inter',
                            ),
                          ),
                          const SizedBox(height: 16),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 16,
                              vertical: 6,
                            ),
                            decoration: BoxDecoration(
                              color: mutedPurple,
                              borderRadius: BorderRadius.circular(20),
                              border: Border.all(color: borderColor),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Container(
                                  width: 8,
                                  height: 8,
                                  decoration: const BoxDecoration(
                                    color: textSecondary,
                                    shape: BoxShape.circle,
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Text(
                                  statusText,
                                  style: const TextStyle(
                                    fontSize: 14,
                                    fontWeight: FontWeight.w600,
                                    color: textSecondary,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 24),

                    if (_attendanceNotice != null &&
                        _attendanceNotice!.trim().isNotEmpty) ...[
                      Container(
                        margin: const EdgeInsets.only(bottom: 16),
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFFF4E5),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: const Color(0xFFFFD8A8)),
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Padding(
                              padding: EdgeInsets.only(top: 2),
                              child: Icon(
                                Icons.access_time_filled_rounded,
                                color: Color(0xFFB45309),
                                size: 18,
                              ),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                _attendanceNotice!,
                                style: const TextStyle(
                                  color: Color(0xFF92400E),
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                  height: 1.3,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],

                    if (_status == 'awaiting') ...[
                      if (!_employeeMatched)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 16),
                          child: Text(
                            'Nomor HP login tidak cocok dengan data karyawan. Hubungi admin agar absensi tercatat di database.',
                            style: TextStyle(
                              color: Colors.red.shade800,
                              fontSize: 13,
                              height: 1.35,
                            ),
                          ),
                        ),
                      Container(
                        padding: const EdgeInsets.all(24),
                        decoration: BoxDecoration(
                          color: surfaceColor,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(color: borderColor),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            const Row(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Icon(
                                  Icons.touch_app_outlined,
                                  color: primaryDark,
                                  size: 22,
                                ),
                                SizedBox(width: 8),
                                Text(
                                  'Pilihan mode absen',
                                  style: TextStyle(
                                    fontWeight: FontWeight.w700,
                                    fontSize: 16,
                                    color: primaryDark,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 8),
                            Text(
                              'Pilih Selfie atau Scan QR. Koordinat GPS selalu dilampirkan saat masuk untuk kedua mode.',
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                fontSize: 12,
                                height: 1.35,
                                color: textSecondary.withValues(alpha: 0.9),
                              ),
                            ),
                            const SizedBox(height: 20),
                            Row(
                              children: [
                                Expanded(
                                  child: _buildAbsenModeTile(
                                    mode: 'selfie',
                                    icon: Icons.camera_alt_outlined,
                                    label: 'Selfie',
                                  ),
                                ),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: _buildAbsenModeTile(
                                    mode: 'qr',
                                    icon: Icons.qr_code_scanner,
                                    label: 'Scan QR',
                                  ),
                                ),
                                const SizedBox(width: 12),
                                Expanded(child: _buildGpsLockedTile()),
                              ],
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 24),
                    ],

                    // Action Area Buttons
                    Row(
                      children: [
                        Expanded(
                          child: ElevatedButton(
                            onPressed: (_status == 'awaiting' && !_isActionLoading)
                                ? () => _performAction('check_in')
                                : null,
                            style: ElevatedButton.styleFrom(
                              backgroundColor: Colors.green.shade600,
                              disabledBackgroundColor: borderColor,
                              padding: const EdgeInsets.symmetric(vertical: 20),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(16),
                              ),
                              elevation: 0,
                            ),
                            child: _isActionLoading && _status == 'awaiting'
                                ? const SizedBox(
                                    width: 24,
                                    height: 24,
                                    child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                                  )
                                : const Row(
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    children: [
                                      Icon(Icons.login, color: Colors.white),
                                      SizedBox(width: 8),
                                      Text(
                                        'Masuk',
                                        style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w600),
                                      ),
                                    ],
                                  ),
                          ),
                        ),
                        const SizedBox(width: 16),
                        Expanded(
                          child: ElevatedButton(
                            onPressed: (_status == 'checked_in' && !_isActionLoading)
                                ? () => _performAction('check_out')
                                : null,
                            style: ElevatedButton.styleFrom(
                              backgroundColor: Colors.red.shade600,
                              disabledBackgroundColor: borderColor,
                              padding: const EdgeInsets.symmetric(vertical: 20),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(16),
                              ),
                              elevation: 0,
                            ),
                            child: _isActionLoading && _status == 'checked_in'
                                ? const SizedBox(
                                    width: 24,
                                    height: 24,
                                    child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                                  )
                                : const Row(
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    children: [
                                      Icon(Icons.logout, color: Colors.white),
                                      SizedBox(width: 8),
                                      Text(
                                        'Pulang',
                                        style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w600),
                                      ),
                                    ],
                                  ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    OutlinedButton.icon(
                      onPressed: () => _showLeaveRequestForm(context),
                      icon: const Icon(Icons.event_busy, color: primaryDark),
                      label: const Text(
                        'Ajukan Izin/Cuti',
                        style: TextStyle(
                          color: primaryDark,
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      style: OutlinedButton.styleFrom(
                        side: const BorderSide(color: primaryDark, width: 1.5),
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(16),
                        ),
                      ),
                    ),
                    if (_recentLeaves.isNotEmpty) ...[
                      const SizedBox(height: 16),
                      Container(
                        padding: const EdgeInsets.all(20),
                        decoration: BoxDecoration(
                          color: surfaceColor,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(color: borderColor),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Icon(Icons.event_note, color: iconColor, size: 22),
                                const SizedBox(width: 8),
                                const Expanded(
                                  child: Text(
                                    'Keputusan izin/cuti (30 hari)',
                                    style: TextStyle(
                                      fontWeight: FontWeight.w700,
                                      fontSize: 16,
                                      color: primaryDark,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 4),
                            Text(
                              'Disetujui tercatat di absensi admin; data di bawah disimpan maks. 30 hari.',
                              style: TextStyle(
                                fontSize: 11,
                                height: 1.3,
                                color: textSecondary.withValues(alpha: 0.9),
                              ),
                            ),
                            const SizedBox(height: 12),
                            ..._recentLeaves.map(_buildLeaveHistoryTile),
                          ],
                        ),
                      ),
                    ],
                    const SizedBox(height: 32),

                    // Logs
                    const Text(
                      'Log terkini',
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.bold,
                        color: primaryDark,
                      ),
                    ),
                    const SizedBox(height: 16),
                    if (_sessionLogs.isNotEmpty) ...[
                      const Text(
                        'Log sesi (perangkat)',
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: textMain,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF5F5F7),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: borderColor),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: _sessionLogs
                              .map(
                                (line) => Padding(
                                  padding: const EdgeInsets.symmetric(vertical: 2),
                                  child: Text(
                                    line,
                                    style: const TextStyle(
                                      fontSize: 11,
                                      fontFamily: 'monospace',
                                      height: 1.25,
                                      color: textSecondary,
                                    ),
                                  ),
                                ),
                              )
                              .toList(),
                        ),
                      ),
                      const SizedBox(height: 20),
                    ],
                    if (_attendanceData == null)
                      const Text(
                        'Belum ada log absensi server hari ini.',
                        style: TextStyle(color: textSecondary),
                      )
                    else
                      Container(
                        decoration: BoxDecoration(
                          color: surfaceColor,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(color: borderColor),
                        ),
                        child: Column(
                          children: [
                            if (_attendanceData!['check_out'] != null)
                              _buildLogItem(
                                'Pulang (server)',
                                _formatShortTime(_attendanceData!['check_out']),
                                Icons.logout,
                              ),
                            if (_attendanceData!['check_out'] != null)
                              const Divider(height: 1, color: borderColor),
                            if (_attendanceData!['check_in'] != null)
                              _buildLogItem(
                                'Masuk (server)',
                                _formatShortTime(_attendanceData!['check_in']),
                                Icons.login,
                              ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),
    );
  }

  Widget _buildLeaveHistoryTile(Map<String, dynamic> r) {
    final st = (r['status'] ?? '').toString().toLowerCase();
    final approved = st == 'approved';
    final type = (r['request_type'] ?? '').toString().toUpperCase();
    final start = r['start_date']?.toString() ?? '';
    final end = r['end_date']?.toString() ?? '';
    final reason = r['reason']?.toString() ?? '';
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            approved ? Icons.check_circle_outline : Icons.cancel_outlined,
            color: approved ? Colors.green.shade700 : Colors.deepOrange.shade800,
            size: 22,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  approved ? 'Disetujui' : 'Ditolak',
                  style: TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 13,
                    color: approved ? Colors.green.shade800 : Colors.deepOrange.shade900,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  '$type · $start s/d $end',
                  style: const TextStyle(fontSize: 12, color: textMain),
                ),
                if (reason.isNotEmpty)
                  Text(
                    reason,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11,
                      color: textSecondary.withValues(alpha: 0.95),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildAbsenModeTile({
    required String mode,
    required IconData icon,
    required String label,
  }) {
    final selected = _checkInMode == mode;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: () {
          setState(() => _checkInMode = mode);
          _log('Mode absen: $mode');
        },
        borderRadius: BorderRadius.circular(14),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 8),
          decoration: BoxDecoration(
            color: selected ? mutedPurple : surfaceColor,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: selected ? iconColor : borderColor,
              width: selected ? 2 : 1,
            ),
          ),
          child: Column(
            children: [
              Icon(icon, color: selected ? iconColor : textSecondary, size: 28),
              const SizedBox(height: 8),
              Text(
                label,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  color: selected ? primaryDark : textSecondary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildGpsLockedTile() {
    return Tooltip(
      message:
          'GPS tidak dipilih terpisah — lokasi selalu dikirim saat masuk.',
      child: Opacity(
        opacity: 0.45,
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 8),
          decoration: BoxDecoration(
            color: const Color(0xFFEEEEEE),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: borderColor),
          ),
          child: Column(
            children: [
              Icon(Icons.location_on_outlined, color: textSecondary, size: 28),
              const SizedBox(height: 8),
              Text(
                'GPS',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  color: textSecondary.withValues(alpha: 0.85),
                ),
              ),
              const SizedBox(height: 2),
              Text(
                'wajib',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 9,
                  color: textSecondary.withValues(alpha: 0.7),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildLogItem(String title, String time, IconData icon) {
    return Padding(
      padding: const EdgeInsets.all(20.0),
      child: Row(
        children: [
          Container(
            width: 48,
            height: 48,
            decoration: const BoxDecoration(
              color: mutedPurple,
              shape: BoxShape.circle,
            ),
            child: Icon(icon, color: textMain, size: 24),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 16,
                    color: primaryDark,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  time,
                  style: const TextStyle(color: textSecondary, fontSize: 14),
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            decoration: BoxDecoration(
              color: const Color(0xFFF0EBFF),
              borderRadius: BorderRadius.circular(6),
            ),
            child: const Text(
              'SITE B',
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w800,
                color: textSecondary,
                letterSpacing: 0.5,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
