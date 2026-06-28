import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:provider/provider.dart';
import '../store/task_provider.dart';
import '../utils/pppoe_password_display.dart';
import 'job_execution_screen.dart';

class TaskDetailScreen extends StatefulWidget {
  final Map<String, dynamic> task;

  const TaskDetailScreen({super.key, required this.task});

  @override
  State<TaskDetailScreen> createState() => _TaskDetailScreenState();
}

class _TaskDetailScreenState extends State<TaskDetailScreen>
    with SingleTickerProviderStateMixin {
  Timer? _timer;
  Duration _elapsed = Duration.zero;
  bool _busy = false;
  late final AnimationController _spinCtrl;

  /// Default terbuka agar teknisi langsung melihat password PPPoE di halaman eksekusi (bisa disembunyikan).
  bool _pppoeObscure = false;

  Map<String, dynamic> get _task => widget.task;

  bool get _isTr => (_task['type']?.toString() ?? '') == 'TR';

  bool get _isInstall => (_task['type']?.toString() ?? '') == 'INSTALL';

  bool get _serverInProgress {
    final s = (_task['status'] ?? '').toString().toLowerCase();
    return s == 'in_progress';
  }

  /// TR atau PSB yang sedang in_progress — tampilkan timer + tombol "Sedang dikerjakan".
  bool get _workActive => _serverInProgress && (_isTr || _isInstall);

  /// Nilai string dari map tugas (API JSON).
  String _taskStr(String key) {
    final v = _task[key];
    if (v == null) return '';
    return v.toString().trim();
  }

  double? _taskDouble(String key) {
    final v = _task[key];
    if (v == null) return null;
    if (v is num) return v.toDouble();
    return double.tryParse(v.toString().trim());
  }

  ({double lat, double lng})? _customerCoordinate() {
    final latCandidates = <String>[
      'customer_latitude',
      'customer_lat',
      'latitude',
      'lat',
    ];
    final lngCandidates = <String>[
      'customer_longitude',
      'customer_lng',
      'longitude',
      'lng',
    ];

    double? lat;
    double? lng;
    for (final k in latCandidates) {
      lat = _taskDouble(k);
      if (lat != null) break;
    }
    for (final k in lngCandidates) {
      lng = _taskDouble(k);
      if (lng != null) break;
    }

    if (lat == null || lng == null) return null;
    return (lat: lat, lng: lng);
  }

  String _pppoeUserDisplay() {
    final u = _taskStr('pppoe_username');
    if (u.isNotEmpty) return u;
    return '';
  }

  String? _pppoePassRaw() {
    final p = _task['pppoe_password'];
    if (p == null) return null;
    final s = pppoeCleartextForTechnicianUi(p.toString());
    return s.isEmpty ? null : s;
  }

  String _maskedPass(String pass) {
    final n = pass.length.clamp(6, 24);
    return String.fromCharCodes(List.filled(n, 0x2022)); // bullet points
  }

  void _copyField(String text, String label) {
    final t = text.trim();
    if (t.isEmpty) return;
    Clipboard.setData(ClipboardData(text: t));
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text('$label disalin')));
  }

  DateTime? _parseWorkStart() =>
      parseTaskWorkStarted(_task['work_started_at']?.toString());

  @override
  void initState() {
    super.initState();
    _spinCtrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    );
    _syncTimerFromTask();
  }

  void _ensureSpin(bool active) {
    if (!mounted) return;
    if (active) {
      if (!_spinCtrl.isAnimating) _spinCtrl.repeat();
    } else {
      _spinCtrl.stop();
      _spinCtrl.reset();
    }
  }

  @override
  void didUpdateWidget(covariant TaskDetailScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.task != widget.task) {
      _syncTimerFromTask();
    }
  }

  void _syncTimerFromTask() {
    _timer?.cancel();
    if (!_workActive) {
      setState(() => _elapsed = Duration.zero);
      _ensureSpin(false);
      return;
    }
    final start = _parseWorkStart();
    if (start == null) {
      setState(() => _elapsed = Duration.zero);
      _ensureSpin(false);
      return;
    }
    void tick() {
      if (!mounted) return;
      setState(() => _elapsed = DateTime.now().difference(start));
    }

    tick();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) => tick());
    _ensureSpin(true);
  }

  @override
  void dispose() {
    _timer?.cancel();
    _spinCtrl.dispose();
    super.dispose();
  }

  String _formatDuration(Duration d) {
    final h = d.inHours;
    final m = d.inMinutes.remainder(60);
    final s = d.inSeconds.remainder(60);
    if (h > 0) {
      return '${h.toString().padLeft(2, '0')}:${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
    }
    return '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
  }

  Future<void> _onKerjakanTr(BuildContext context) async {
    final id = _task['id']?.toString();
    final type = _task['type']?.toString();
    if (id == null || type == null) return;
    final tasks = context.read<TaskProvider>();
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    final ok = await tasks.updateTaskStatus(id, type, 'in_progress');
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) {
      _task['status'] = 'in_progress';
      _task['work_started_at'] = DateTime.now().toIso8601String();
      _syncTimerFromTask();
    } else {
      messenger.showSnackBar(
        const SnackBar(content: Text('Gagal memulai tugas. Coba lagi.')),
      );
    }
  }

  void _openJobExecution(BuildContext context) {
    final tasks = context.read<TaskProvider>();
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) =>
            JobExecutionScreen(task: Map<String, dynamic>.from(_task)),
      ),
    ).then((result) async {
      if (!mounted) return;
      await tasks.fetchTasks(refresh: true);
      if (!mounted || !context.mounted) return;
      if (result == true) {
        Navigator.pop(context);
      }
    });
  }

  Future<void> _onKerjakanInstall(BuildContext context) async {
    final id = _task['id']?.toString();
    final type = _task['type']?.toString();
    if (id == null || type == null) return;
    if (_workActive) {
      _openJobExecution(context);
      return;
    }
    final tasks = context.read<TaskProvider>();
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    final ok = await tasks.updateTaskStatus(id, type, 'mulai');
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) {
      _task['status'] = 'in_progress';
      _task['work_started_at'] = DateTime.now().toIso8601String();
      _syncTimerFromTask();
    } else {
      messenger.showSnackBar(
        const SnackBar(content: Text('Gagal memulai tugas. Coba lagi.')),
      );
    }
  }

  Future<void> _showPendingReasonDialog() async {
    final tasks = context.read<TaskProvider>();
    final messenger = ScaffoldMessenger.of(context);
    final id = _task['id']?.toString();
    final type = _task['type']?.toString();
    if (id == null || type == null) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Data tugas tidak valid')),
      );
      return;
    }

    final ctrl = TextEditingController();
    final formKey = GlobalKey<FormState>();

    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (dialogCtx) {
        return AlertDialog(
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(20),
          ),
          title: const Text('Tandai pending'),
          content: SingleChildScrollView(
            child: Form(
              key: formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Jelaskan alasan penundaan. Teks ini dikirim ke admin billing (catatan job / riwayat tiket).',
                    style: TextStyle(
                      fontSize: 13,
                      color: Colors.grey.shade700,
                      height: 1.35,
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: ctrl,
                    maxLines: 4,
                    minLines: 3,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: InputDecoration(
                      hintText:
                          'Contoh: Menunggu ONT dari gudang / pelanggan tidak di lokasi …',
                      alignLabelWithHint: true,
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(14),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(14),
                        borderSide: BorderSide(color: Colors.grey.shade400),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(14),
                        borderSide: const BorderSide(
                          color: Color(0xFFDC2626),
                          width: 1.5,
                        ),
                      ),
                    ),
                    validator: (v) {
                      final t = v?.trim() ?? '';
                      if (t.length < 8) return 'Minimal 8 karakter';
                      return null;
                    },
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogCtx),
              child: const Text('Batal'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: const Color(0xFFDC2626),
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              onPressed: () async {
                if (!(formKey.currentState?.validate() ?? false)) return;
                final reason = ctrl.text.trim();
                Navigator.pop(dialogCtx);
                setState(() => _busy = true);
                final ok = await tasks.updateTaskStatus(
                  id,
                  type,
                  'pending',
                  pendingReason: reason,
                );
                if (!mounted) return;
                setState(() => _busy = false);
                if (ok) {
                  messenger.showSnackBar(
                    const SnackBar(
                      content: Text(
                        'Pending tersimpan. Admin dapat melihat alasan di web.',
                      ),
                    ),
                  );
                  Navigator.pop(context);
                } else {
                  messenger.showSnackBar(
                    const SnackBar(
                      content: Text('Gagal menyimpan pending. Coba lagi.'),
                    ),
                  );
                }
              },
              child: const Text('Kirim ke admin'),
            ),
          ],
        );
      },
    );
    ctrl.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final durLabel = _workActive ? _formatDuration(_elapsed) : '00:00';

    return Scaffold(
      backgroundColor: const Color(0xFFFCF8FF),
      appBar: AppBar(
        backgroundColor: const Color(0xFF2563EB),
        foregroundColor: Colors.white,
        elevation: 0,
        shape: const Border(
          bottom: BorderSide(color: Colors.white24, width: 1),
        ),
        title: const Text(
          'Eksekusi Tugas',
          style: TextStyle(
            fontSize: 22,
            fontWeight: FontWeight.w600,
            color: Colors.white,
          ),
        ),
        centerTitle: true,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.pop(context),
        ),
        actions: [
          IconButton(icon: const Icon(Icons.more_vert), onPressed: () {}),
        ],
      ),
      body: Stack(
        children: [
          SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 140),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: const Color(0xFF1B0C6B),
                    borderRadius: BorderRadius.circular(8),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withValues(alpha: 0.05),
                        blurRadius: 4,
                        offset: const Offset(0, 1),
                      ),
                    ],
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'DURASI',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 0.5,
                              color: Color(0xCC857ED9),
                            ),
                          ),
                          Text(
                            durLabel,
                            style: const TextStyle(
                              fontSize: 28,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 2,
                              color: Colors.white,
                            ),
                          ),
                        ],
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 6,
                        ),
                        decoration: BoxDecoration(
                          color: _workActive
                              ? const Color(0xFF14532D).withValues(alpha: 0.35)
                              : const Color(0xFF5A53AB).withValues(alpha: 0.2),
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              _workActive
                                  ? Icons.play_circle_filled
                                  : Icons.sync,
                              size: 14,
                              color: _workActive
                                  ? const Color(0xFFB8F5C8)
                                  : const Color(0xFFE4DFFF),
                            ),
                            const SizedBox(width: 8),
                            Text(
                              _workActive ? 'Dalam proses' : 'Menunggu',
                              style: TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w600,
                                color: _workActive
                                    ? const Color(0xFFB8F5C8)
                                    : const Color(0xFFE4DFFF),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0xFFC8C4D3)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: const [
                          Icon(
                            Icons.person,
                            size: 20,
                            color: Color(0xFF787582),
                          ),
                          SizedBox(width: 8),
                          Text(
                            'Detail Pelanggan',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                              color: Color(0xFF19163F),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      const Divider(color: Color(0xFFC8C4D3)),
                      const SizedBox(height: 8),
                      _buildDetailRow(
                        'Nama',
                        _task['customer']?.toString() ?? '-',
                      ),
                      const SizedBox(height: 8),
                      _buildDetailRow(
                        _isTr ? 'ID Tiket' : 'ID Tugas',
                        _task['id']?.toString() ?? '-',
                      ),
                      const SizedBox(height: 8),
                      _buildDetailRow(
                        'Alamat',
                        _task['address']?.toString() ?? '-',
                      ),
                      const SizedBox(height: 16),
                      Row(
                        children: [
                          Expanded(
                            child: _GradientActionChip(
                              borderRadius: 22,
                              gradient: const LinearGradient(
                                begin: Alignment.topLeft,
                                end: Alignment.bottomRight,
                                colors: [Color(0xFF25D366), Color(0xFF128C7E)],
                              ),
                              shadow: const Color(
                                0xFF25D366,
                              ).withValues(alpha: 0.35),
                              onTap: () async {
                                final phone = _task['phone']?.toString();
                                if (phone != null && phone.isNotEmpty) {
                                  final digits = phone.replaceAll(
                                    RegExp(r'\D'),
                                    '',
                                  );
                                  if (digits.isEmpty) {
                                    if (context.mounted) {
                                      ScaffoldMessenger.of(
                                        context,
                                      ).showSnackBar(
                                        const SnackBar(
                                          content: Text(
                                            'Nomor WhatsApp tidak valid',
                                          ),
                                        ),
                                      );
                                    }
                                    return;
                                  }
                                  final wa = digits.startsWith('62')
                                      ? digits
                                      : '62${digits.startsWith('0') ? digits.substring(1) : digits}';
                                  final uri = Uri.parse('https://wa.me/$wa');
                                  if (await canLaunchUrl(uri)) {
                                    await launchUrl(
                                      uri,
                                      mode: LaunchMode.externalApplication,
                                    );
                                  } else if (context.mounted) {
                                    ScaffoldMessenger.of(context).showSnackBar(
                                      const SnackBar(
                                        content: Text(
                                          'Tidak dapat membuka WhatsApp',
                                        ),
                                      ),
                                    );
                                  }
                                } else {
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    const SnackBar(
                                      content: Text(
                                        'Nomor WhatsApp tidak tersedia',
                                      ),
                                    ),
                                  );
                                }
                              },
                              icon: Icons.chat_rounded,
                              label: 'Hubungi',
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: _GradientActionChip(
                              borderRadius: 22,
                              gradient: const LinearGradient(
                                begin: Alignment.topLeft,
                                end: Alignment.bottomRight,
                                colors: [Color(0xFF5C9EFF), Color(0xFF1A56DB)],
                              ),
                              shadow: const Color(
                                0xFF4285F4,
                              ).withValues(alpha: 0.35),
                              onTap: () async {
                                final coord = _customerCoordinate();
                                if (coord != null) {
                                  final uri = Uri.parse(
                                    'https://www.google.com/maps/search/?api=1&query=${coord.lat},${coord.lng}',
                                  );
                                  if (await canLaunchUrl(uri)) {
                                    await launchUrl(
                                      uri,
                                      mode: LaunchMode.externalApplication,
                                    );
                                  } else if (context.mounted) {
                                    ScaffoldMessenger.of(context).showSnackBar(
                                      const SnackBar(
                                        content: Text(
                                          'Tidak dapat membuka peta',
                                        ),
                                      ),
                                    );
                                  }
                                  return;
                                }

                                final address = _task['address']?.toString();
                                if (address != null && address.isNotEmpty) {
                                  final uri = Uri.parse(
                                    'https://www.google.com/maps/search/?api=1&query=${Uri.encodeComponent(address)}',
                                  );
                                  if (await canLaunchUrl(uri)) {
                                    await launchUrl(
                                      uri,
                                      mode: LaunchMode.externalApplication,
                                    );
                                  } else if (context.mounted) {
                                    ScaffoldMessenger.of(context).showSnackBar(
                                      const SnackBar(
                                        content: Text(
                                          'Tidak dapat membuka peta',
                                        ),
                                      ),
                                    );
                                  }
                                } else {
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    const SnackBar(
                                      content: Text(
                                        'Koordinat/alamat pelanggan tidak tersedia',
                                      ),
                                    ),
                                  );
                                }
                              },
                              icon: Icons.map_rounded,
                              label: 'Peta',
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0xFFC8C4D3)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: const [
                          Icon(Icons.build, size: 20, color: Color(0xFF787582)),
                          SizedBox(width: 8),
                          Text(
                            'Status Teknis',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                              color: Color(0xFF19163F),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      const Divider(color: Color(0xFFC8C4D3)),
                      const SizedBox(height: 8),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SizedBox(
                            width: 108,
                            child: Container(
                              padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
                              decoration: BoxDecoration(
                                color: const Color(0xFFF0EBFF),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    _isTr ? 'Tipe' : 'Job ID',
                                    style: const TextStyle(
                                      fontSize: 10,
                                      fontWeight: FontWeight.w700,
                                      letterSpacing: 0.4,
                                      color: Color(0xFF474551),
                                    ),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    _isTr
                                        ? (_task['title']?.toString() ?? '-')
                                        : '#${_task['id']?.toString() ?? '-'}',
                                    style: const TextStyle(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w600,
                                      color: Color(0xFF19163F),
                                    ),
                                    maxLines: 3,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                  if (!_isTr &&
                                      _taskStr('job_number').isNotEmpty) ...[
                                    const SizedBox(height: 4),
                                    Text(
                                      _taskStr('job_number'),
                                      style: TextStyle(
                                        fontSize: 10,
                                        color: Colors.grey.shade700,
                                        fontWeight: FontWeight.w500,
                                      ),
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: const Color(0xFFF0EBFF),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  const Text(
                                    'Prioritas',
                                    style: TextStyle(
                                      fontSize: 12,
                                      fontWeight: FontWeight.w700,
                                      letterSpacing: 0.5,
                                      color: Color(0xFF474551),
                                    ),
                                  ),
                                  const SizedBox(height: 4),
                                  Row(
                                    children: [
                                      const Icon(
                                        Icons.priority_high,
                                        size: 16,
                                        color: Color(0xFFBA1A1A),
                                      ),
                                      const SizedBox(width: 4),
                                      Expanded(
                                        child: Text(
                                          _task['priority']?.toString() ?? '-',
                                          style: const TextStyle(
                                            fontSize: 16,
                                            fontWeight: FontWeight.w500,
                                            color: Color(0xFFBA1A1A),
                                          ),
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
                      const SizedBox(height: 16),
                      if (_isInstall) ...[
                        const Text(
                          'Detail PPPOE',
                          style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0.3,
                            color: Color(0xFF474551),
                          ),
                        ),
                        const SizedBox(height: 8),
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.fromLTRB(16, 18, 16, 18),
                          decoration: BoxDecoration(
                            color: const Color(0xFFF0EBFF),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(
                              color: const Color(
                                0xFFC8C4D3,
                              ).withValues(alpha: 0.6),
                            ),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Username PPPoE (login RADIUS / MikroTik)',
                                style: TextStyle(
                                  fontSize: 12,
                                  color: Colors.grey.shade800,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                              const SizedBox(height: 6),
                              Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Expanded(
                                    child: SelectableText(
                                      _pppoeUserDisplay().isNotEmpty
                                          ? _pppoeUserDisplay()
                                          : '— Belum ada di data pelanggan (pastikan job terhubung ke pelanggan & PPPoE terisi di admin, atau nomor HP job sama dengan data pelanggan).',
                                      style: TextStyle(
                                        fontSize: _pppoeUserDisplay().isNotEmpty
                                            ? 18
                                            : 13,
                                        fontWeight: FontWeight.w700,
                                        color: const Color(0xFF19163F),
                                        height: 1.35,
                                      ),
                                    ),
                                  ),
                                  if (_pppoeUserDisplay().isNotEmpty)
                                    IconButton(
                                      tooltip: 'Salin username',
                                      visualDensity: VisualDensity.compact,
                                      onPressed: () => _copyField(
                                        _pppoeUserDisplay(),
                                        'Username PPPoE',
                                      ),
                                      icon: const Icon(
                                        Icons.copy_outlined,
                                        size: 22,
                                        color: Color(0xFF474551),
                                      ),
                                    ),
                                ],
                              ),
                              const SizedBox(height: 16),
                              Row(
                                crossAxisAlignment: CrossAxisAlignment.center,
                                children: [
                                  Expanded(
                                    child: Text(
                                      'Password PPPoE',
                                      style: TextStyle(
                                        fontSize: 12,
                                        color: Colors.grey.shade800,
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                  ),
                                  if (_pppoePassRaw() != null && !_pppoeObscure)
                                    IconButton(
                                      tooltip: 'Salin password',
                                      visualDensity: VisualDensity.compact,
                                      onPressed: () => _copyField(
                                        _pppoePassRaw()!,
                                        'Password PPPoE',
                                      ),
                                      icon: const Icon(
                                        Icons.copy_outlined,
                                        size: 22,
                                        color: Color(0xFF474551),
                                      ),
                                    ),
                                  IconButton(
                                    tooltip: _pppoeObscure
                                        ? 'Tampilkan password'
                                        : 'Sembunyikan password',
                                    onPressed: _pppoePassRaw() == null
                                        ? null
                                        : () => setState(
                                            () =>
                                                _pppoeObscure = !_pppoeObscure,
                                          ),
                                    icon: Icon(
                                      _pppoeObscure
                                          ? Icons.visibility_outlined
                                          : Icons.visibility_off_outlined,
                                      size: 22,
                                    ),
                                    color: const Color(0xFF474551),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 4),
                              SelectableText(
                                _pppoePassRaw() == null
                                    ? kTechnicianPppoePasswordEmptyHint
                                    : (_pppoeObscure
                                          ? _maskedPass(_pppoePassRaw()!)
                                          : _pppoePassRaw()!),
                                style: _pppoePassRaw() == null
                                    ? TextStyle(
                                        fontSize: 13,
                                        fontWeight: FontWeight.w400,
                                        height: 1.35,
                                        color: Colors.grey.shade700,
                                      )
                                    : TextStyle(
                                        fontSize: 17,
                                        fontWeight: FontWeight.w600,
                                        color: const Color(0xFF19163F),
                                        letterSpacing: _pppoeObscure ? 1.2 : 0,
                                      ),
                              ),
                            ],
                          ),
                        ),
                      ] else ...[
                        const Text(
                          'Catatan Diagnosa',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0.5,
                            color: Color(0xFF474551),
                          ),
                        ),
                        const SizedBox(height: 4),
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: const Color(0xFFF0EBFF),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            _task['description']?.toString() ?? '-',
                            style: const TextStyle(
                              fontSize: 14,
                              color: Color(0xFF19163F),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: Container(
              padding: const EdgeInsets.all(16),
              decoration: const BoxDecoration(
                color: Colors.white,
                border: Border(top: BorderSide(color: Color(0xFFC8C4D3))),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _SmoothActionButton(
                    enabled: !_busy,
                    onTap: () async {
                      if (_isTr) {
                        if (_workActive) {
                          _openJobExecution(context);
                        } else {
                          await _onKerjakanTr(context);
                        }
                      } else {
                        await _onKerjakanInstall(context);
                      }
                    },
                    borderRadius: 18,
                    gradient: _workActive
                        ? const LinearGradient(
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                            colors: [Color(0xFF047857), Color(0xFF065F46)],
                          )
                        : const LinearGradient(
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                            colors: [Color(0xFF16A34A), Color(0xFF15803D)],
                          ),
                    shadowColor: const Color(0xFF16A34A),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        if (_workActive) ...[
                          const Icon(
                            Icons.lock_outline_rounded,
                            size: 20,
                            color: Colors.white,
                          ),
                          const SizedBox(width: 8),
                          RotationTransition(
                            turns: _spinCtrl,
                            child: const Icon(
                              Icons.settings_rounded,
                              size: 22,
                              color: Colors.white,
                            ),
                          ),
                          const SizedBox(width: 10),
                        ] else
                          const Icon(
                            Icons.play_arrow_rounded,
                            size: 26,
                            color: Colors.white,
                          ),
                        Text(
                          (_isTr || _isInstall)
                              ? (_workActive ? 'Sedang dikerjakan' : 'Kerjakan')
                              : 'Kerjakan',
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            color: Colors.white,
                            letterSpacing: 0.2,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 10),
                  _SmoothActionButton(
                    enabled: !_busy,
                    onTap: () async {
                      await _showPendingReasonDialog();
                    },
                    borderRadius: 18,
                    gradient: const LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [Color(0xFFEF4444), Color(0xFFB91C1C)],
                    ),
                    shadowColor: const Color(0xFFDC2626),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(
                          Icons.pause_circle_outline_rounded,
                          size: 22,
                          color: Colors.white,
                        ),
                        const SizedBox(width: 8),
                        const Text(
                          'Pending',
                          style: TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                            color: Colors.white,
                            letterSpacing: 0.2,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDetailRow(String label, String value) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.5,
            color: Color(0xFF474551),
          ),
        ),
        const SizedBox(height: 2),
        Text(
          value,
          style: const TextStyle(
            fontSize: 16,
            fontWeight: FontWeight.w500,
            color: Color(0xFF19163F),
          ),
        ),
      ],
    );
  }
}

/// Tombol Hubungi / Peta: gradien + sudut sangat membulat.
class _GradientActionChip extends StatelessWidget {
  const _GradientActionChip({
    required this.borderRadius,
    required this.gradient,
    required this.shadow,
    required this.onTap,
    required this.icon,
    required this.label,
  });

  final double borderRadius;
  final Gradient gradient;
  final Color shadow;
  final VoidCallback onTap;
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      elevation: 0,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(borderRadius),
        child: Ink(
          height: 48,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(borderRadius),
            gradient: gradient,
            boxShadow: [
              BoxShadow(
                color: shadow,
                blurRadius: 12,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 20, color: Colors.white),
              const SizedBox(width: 8),
              Text(
                label,
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w700,
                  fontSize: 15,
                  letterSpacing: 0.2,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Tombol aksi bawah: gradien + bayangan halus.
class _SmoothActionButton extends StatelessWidget {
  const _SmoothActionButton({
    required this.enabled,
    required this.onTap,
    required this.child,
    required this.gradient,
    required this.shadowColor,
    this.borderRadius = 18,
  });

  final bool enabled;
  final VoidCallback onTap;
  final Widget child;
  final Gradient gradient;
  final Color shadowColor;
  final double borderRadius;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: enabled ? 1 : 0.5,
      child: SizedBox(
        width: double.infinity,
        height: 52,
        child: DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(borderRadius),
            gradient: gradient,
            boxShadow: [
              BoxShadow(
                color: shadowColor.withValues(alpha: 0.34),
                blurRadius: 16,
                offset: const Offset(0, 6),
              ),
            ],
          ),
          child: Material(
            type: MaterialType.transparency,
            child: InkWell(
              onTap: enabled ? onTap : null,
              borderRadius: BorderRadius.circular(borderRadius),
              splashColor: Colors.white24,
              highlightColor: Colors.white12,
              child: Center(
                child: IconTheme(
                  data: const IconThemeData(color: Colors.white),
                  child: DefaultTextStyle.merge(
                    style: const TextStyle(color: Colors.white),
                    child: child,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
