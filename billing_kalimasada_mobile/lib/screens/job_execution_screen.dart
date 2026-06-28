import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:geolocator/geolocator.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../store/auth_provider.dart';
import '../store/task_provider.dart';
import '../utils/pppoe_password_display.dart';

class JobExecutionScreen extends StatefulWidget {
  final Map<String, dynamic> task;

  const JobExecutionScreen({super.key, required this.task});

  @override
  State<JobExecutionScreen> createState() => _JobExecutionScreenState();
}

class _JobExecutionScreenState extends State<JobExecutionScreen> {
  Timer? _timer;
  Duration _elapsed = Duration.zero;
  bool _completing = false;
  final TextEditingController _deskripsiCtrl = TextEditingController();
  final TextEditingController _cableMeterCtrl = TextEditingController();
  final ImagePicker _picker = ImagePicker();
  XFile? _foto;
  XFile? _fotoStickerOnt;
  double? _tagLat;
  double? _tagLng;

  Map<String, dynamic> get _task => widget.task;

  bool get _isInstall => (_task['type']?.toString() ?? '') == 'INSTALL';

  DateTime? _parseWorkStart() =>
      parseTaskWorkStarted(_task['work_started_at']?.toString());

  @override
  void initState() {
    super.initState();
    _startTimer();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<AuthProvider>().refreshTechnicianProfile();
    });
  }

  void _startTimer() {
    _timer?.cancel();
    final start = _parseWorkStart() ?? DateTime.now();
    void tick() {
      if (!mounted) return;
      setState(() => _elapsed = DateTime.now().difference(start));
    }

    tick();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) => tick());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _deskripsiCtrl.dispose();
    _cableMeterCtrl.dispose();
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

  Future<void> _ambilFotoKamera() async {
    try {
      final file = await _picker.pickImage(
        source: ImageSource.camera,
        imageQuality: 82,
        maxWidth: 1600,
      );
      if (file != null && mounted) {
        setState(() => _foto = file);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Kamera: ${e.toString()}')));
      }
    }
  }

  Future<void> _ambilFotoStickerOnt() async {
    try {
      final file = await _picker.pickImage(
        source: ImageSource.camera,
        imageQuality: 82,
        maxWidth: 1600,
      );
      if (file != null && mounted) {
        setState(() => _fotoStickerOnt = file);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Kamera stiker: ${e.toString()}')),
        );
      }
    }
  }

  Future<void> _ambilLokasiWajib() async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final enabled = await Geolocator.isLocationServiceEnabled();
      if (!enabled) {
        messenger.showSnackBar(
          const SnackBar(
            content: Text('Aktifkan layanan lokasi di perangkat.'),
          ),
        );
        return;
      }
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) {
        perm = await Geolocator.requestPermission();
      }
      if (perm != LocationPermission.whileInUse &&
          perm != LocationPermission.always) {
        messenger.showSnackBar(
          const SnackBar(
            content: Text('Izin lokasi diperlukan untuk tag koordinat.'),
          ),
        );
        return;
      }
      final pos = await Geolocator.getCurrentPosition();
      if (!mounted) return;
      setState(() {
        _tagLat = pos.latitude;
        _tagLng = pos.longitude;
      });
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            'Lokasi: ${_tagLat!.toStringAsFixed(6)}, ${_tagLng!.toStringAsFixed(6)}',
          ),
        ),
      );
    } catch (e) {
      if (mounted) {
        messenger.showSnackBar(
          SnackBar(content: Text('Gagal ambil lokasi: $e')),
        );
      }
    }
  }

  Future<void> _mintaBantuan() async {
    final auth = context.read<AuthProvider>();
    await auth.refreshTechnicianProfile();
    if (!mounted) return;
    final fromUser = auth.user?['support_whatsapp']?.toString().trim() ?? '';
    final fromEnv = dotenv.env['SUPPORT_WHATSAPP']?.trim() ?? '';
    final raw = fromUser.isNotEmpty ? fromUser : fromEnv;
    final digits = raw.replaceAll(RegExp(r'\D'), '');
    if (digits.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Nomor WhatsApp bantuan belum diatur (admin: contact_whatsapp / .env SUPPORT_WHATSAPP).',
          ),
        ),
      );
      return;
    }
    final wa = digits.startsWith('62')
        ? digits
        : '62${digits.startsWith('0') ? digits.substring(1) : digits}';
    final tipe = _task['type']?.toString() ?? '';
    final tid = _task['id']?.toString() ?? '';
    final text = Uri.encodeComponent('Minta bantuan — tugas $tipe #$tid');
    final uri = Uri.parse('https://wa.me/$wa?text=$text');
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } else if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Tidak dapat membuka WhatsApp')),
      );
    }
  }

  Future<void> _selesai() async {
    final desc = _deskripsiCtrl.text.trim();
    if (desc.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Isi deskripsi penyelesaian terlebih dahulu.'),
        ),
      );
      return;
    }
    final id = _task['id']?.toString();
    final type = _task['type']?.toString();
    if (id == null || type == null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Data tugas tidak valid')));
      return;
    }

    final tasks = context.read<TaskProvider>();
    final messenger = ScaffoldMessenger.of(context);

    double? cableM;
    String? stickerB64;
    if (_isInstall) {
      cableM = double.tryParse(
        _cableMeterCtrl.text.trim().replaceAll(',', '.'),
      );
      if (cableM == null || cableM < 0 || cableM.isNaN) {
        messenger.showSnackBar(
          const SnackBar(
            content: Text('Isi panjang kabel (meter) dengan angka valid.'),
          ),
        );
        return;
      }
      if (_fotoStickerOnt == null) {
        messenger.showSnackBar(
          const SnackBar(
            content: Text('Ambil foto stiker belakang ONT dari kamera.'),
          ),
        );
        return;
      }
      if (_tagLat == null || _tagLng == null) {
        messenger.showSnackBar(
          const SnackBar(
            content: Text('Tag lokasi wajib — ketuk Ambil lokasi GPS.'),
          ),
        );
        return;
      }
      try {
        final bytes = await _fotoStickerOnt!.readAsBytes();
        stickerB64 = 'data:image/jpeg;base64,${base64Encode(bytes)}';
      } catch (e) {
        messenger.showSnackBar(
          SnackBar(content: Text('Gagal membaca foto stiker: $e')),
        );
        return;
      }
    }

    String? photoB64;
    if (_foto != null) {
      try {
        final bytes = await _foto!.readAsBytes();
        photoB64 = 'data:image/jpeg;base64,${base64Encode(bytes)}';
      } catch (e) {
        if (mounted) {
          messenger.showSnackBar(
            SnackBar(content: Text('Gagal membaca foto: $e')),
          );
        }
        return;
      }
    }

    setState(() => _completing = true);
    final durationSec = _elapsed.inSeconds;
    double? latOut;
    double? lngOut;
    if (_isInstall) {
      latOut = _tagLat;
      lngOut = _tagLng;
    } else {
      try {
        final enabled = await Geolocator.isLocationServiceEnabled();
        if (enabled) {
          var perm = await Geolocator.checkPermission();
          if (perm == LocationPermission.denied) {
            perm = await Geolocator.requestPermission();
          }
          if (perm == LocationPermission.whileInUse ||
              perm == LocationPermission.always) {
            final pos = await Geolocator.getCurrentPosition();
            latOut = pos.latitude;
            lngOut = pos.longitude;
          }
        }
      } catch (_) {
        /* koordinat opsional untuk TR */
      }
    }
    final err = await tasks.submitTaskCompletion(
      id,
      type,
      completionDescription: desc,
      completionPhotoBase64: photoB64,
      workDurationSeconds: durationSec,
      completionLatitude: latOut,
      completionLongitude: lngOut,
      cableLengthM: cableM,
      stickerPhotoBase64: stickerB64,
    );
    if (!mounted) return;
    setState(() => _completing = false);

    if (err == null) {
      messenger.showSnackBar(
        const SnackBar(
          content: Text(
            'Tugas diselesaikan. Notifikasi WA dikirim ke pelanggan.',
          ),
        ),
      );
      // Satu level pop: daftar tugas atau detail. Bila dari detail, pemanggil mem-pop detail.
      Navigator.of(context).pop(true);
    } else {
      messenger.showSnackBar(SnackBar(content: Text(err)));
    }
  }

  /// Input di kartu putih: app global [Brightness.dark] membuat teks field putih;
  /// bungkus dengan tema terang agar teks & hint terbaca.
  Widget _lightInputTheme({required Widget child}) {
    return Theme(
      data: ThemeData(
        brightness: Brightness.light,
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF15803D),
          brightness: Brightness.light,
        ),
      ),
      child: child,
    );
  }

  @override
  Widget build(BuildContext context) {
    const bgBackground = Color(0xFFFCF8FF);
    const textOnSurface = Color(0xFF19163F);
    const outline = Color(0xFFC8C4D3);
    const hijauSelesai = Color(0xFF15803D);

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
        title: Text(
          'Penyelesaian #${_task['id']}',
          style: const TextStyle(
            color: Colors.white,
            fontSize: 20,
            fontWeight: FontWeight.bold,
          ),
        ),
        centerTitle: true,
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(color: Colors.white24, height: 1),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: const Color(0xFFF0EBFF),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: outline),
              ),
              child: Column(
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Container(
                        width: 12,
                        height: 12,
                        decoration: const BoxDecoration(
                          color: Color(0xFF14532D),
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 8),
                      const Text(
                        'STATUS: DALAM PROSES',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.bold,
                          color: textOnSurface,
                          letterSpacing: 0.5,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _formatDuration(_elapsed),
                    style: const TextStyle(
                      fontSize: 32,
                      fontWeight: FontWeight.bold,
                      color: Color(0xFF1B0C6B),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: outline),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Ringkasan',
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                      color: textOnSurface,
                    ),
                  ),
                  const SizedBox(height: 12),
                  const Divider(color: outline),
                  const SizedBox(height: 12),
                  _buildSummaryItem(
                    Icons.business,
                    'PELANGGAN',
                    _task['customer']?.toString() ?? '-',
                  ),
                  const SizedBox(height: 12),
                  _buildSummaryItem(
                    Icons.build,
                    'LAYANAN',
                    _task['type'] == 'TR'
                        ? 'Perbaikan / gangguan'
                        : 'Pemasangan baru',
                  ),
                  const SizedBox(height: 12),
                  _buildSummaryItem(
                    Icons.location_on,
                    'ALAMAT',
                    _task['address']?.toString() ?? '-',
                  ),
                  if (_isInstall) ...[
                    const SizedBox(height: 12),
                    _buildPppoeUsernameSummaryRow(context),
                    const SizedBox(height: 12),
                    _buildPppoePasswordSummaryRow(context),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: outline),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Penyelesaian',
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                      color: textOnSurface,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _isInstall
                        ? 'Untuk PSB: isi panjang kabel, foto stiker ONT, tag lokasi (wajib), lalu ringkasan pekerjaan. Data tersimpan di server dan tampil di web admin.'
                        : 'Isi ringkasan pekerjaan. Data ini disimpan dan dikirim ke pelanggan via WhatsApp.',
                    style: TextStyle(
                      fontSize: 13,
                      color: Colors.grey.shade700,
                      height: 1.35,
                    ),
                  ),
                  if (_isInstall) ...[
                    const SizedBox(height: 20),
                    const Text(
                      'Panjang kabel (meter)',
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: textOnSurface,
                      ),
                    ),
                    const SizedBox(height: 8),
                    _lightInputTheme(
                      child: TextField(
                        controller: _cableMeterCtrl,
                        keyboardType: const TextInputType.numberWithOptions(
                          decimal: true,
                        ),
                        style: const TextStyle(
                          color: Color(0xFF19163F),
                          fontSize: 16,
                        ),
                        cursorColor: const Color(0xFF15803D),
                        decoration: InputDecoration(
                          hintText: 'Contoh: 45 atau 12.5',
                          hintStyle: TextStyle(
                            color: Colors.grey.shade600,
                            fontSize: 15,
                          ),
                          filled: true,
                          fillColor: const Color(0xFFF9FAFB),
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(10),
                            borderSide: const BorderSide(color: outline),
                          ),
                          enabledBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(10),
                            borderSide: const BorderSide(color: outline),
                          ),
                          focusedBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(10),
                            borderSide: const BorderSide(
                              color: Color(0xFF15803D),
                              width: 1.5,
                            ),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 20),
                    const Text(
                      'Foto stiker bagian belakang ONT',
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: textOnSurface,
                      ),
                    ),
                    const SizedBox(height: 8),
                    OutlinedButton.icon(
                      onPressed: _completing ? null : _ambilFotoStickerOnt,
                      icon: const Icon(
                        Icons.camera_alt_outlined,
                        color: Color(0xFF15803D),
                      ),
                      label: Text(
                        _fotoStickerOnt == null
                            ? 'Ambil dari kamera'
                            : 'Ganti foto stiker',
                      ),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: const Color(0xFF166534),
                        side: const BorderSide(color: Color(0xFF86EFAC)),
                        padding: const EdgeInsets.symmetric(
                          vertical: 14,
                          horizontal: 16,
                        ),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(10),
                        ),
                      ),
                    ),
                    if (_fotoStickerOnt != null) ...[
                      const SizedBox(height: 12),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(10),
                        child: Image.file(
                          File(_fotoStickerOnt!.path),
                          height: 160,
                          width: double.infinity,
                          fit: BoxFit.cover,
                        ),
                      ),
                    ],
                    const SizedBox(height: 20),
                    const Text(
                      'Tag lokasi (wajib)',
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: textOnSurface,
                      ),
                    ),
                    const SizedBox(height: 8),
                    OutlinedButton.icon(
                      onPressed: _completing ? null : _ambilLokasiWajib,
                      icon: const Icon(
                        Icons.my_location,
                        color: Color(0xFF1D4ED8),
                      ),
                      label: const Text('Ambil lokasi GPS'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: const Color(0xFF1E3A8A),
                        side: const BorderSide(color: Color(0xFF93C5FD)),
                        padding: const EdgeInsets.symmetric(
                          vertical: 14,
                          horizontal: 16,
                        ),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(10),
                        ),
                      ),
                    ),
                    if (_tagLat != null && _tagLng != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(
                          'Koordinat: ${_tagLat!.toStringAsFixed(6)}, ${_tagLng!.toStringAsFixed(6)}',
                          style: TextStyle(
                            fontSize: 13,
                            color: Colors.grey.shade800,
                          ),
                        ),
                      ),
                    const SizedBox(height: 20),
                  ],
                  const SizedBox(height: 16),
                  _lightInputTheme(
                    child: TextField(
                      controller: _deskripsiCtrl,
                      maxLines: 5,
                      minLines: 3,
                      textCapitalization: TextCapitalization.sentences,
                      style: const TextStyle(
                        color: Color(0xFF19163F),
                        fontSize: 16,
                        height: 1.45,
                      ),
                      cursorColor: const Color(0xFF15803D),
                      decoration: InputDecoration(
                        labelText: 'Deskripsi penyelesaian',
                        hintText:
                            'Contoh: kabel diganti, sinyal stabil, tes browsing OK…',
                        labelStyle: const TextStyle(
                          color: Color(0xFF474551),
                          fontWeight: FontWeight.w500,
                        ),
                        floatingLabelStyle: const TextStyle(
                          color: Color(0xFF15803D),
                          fontWeight: FontWeight.w600,
                        ),
                        hintStyle: TextStyle(
                          color: Colors.grey.shade600,
                          fontSize: 15,
                        ),
                        alignLabelWithHint: true,
                        filled: true,
                        fillColor: const Color(0xFFF9FAFB),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(10),
                          borderSide: const BorderSide(color: outline),
                        ),
                        enabledBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(10),
                          borderSide: const BorderSide(color: outline),
                        ),
                        focusedBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(10),
                          borderSide: const BorderSide(
                            color: Color(0xFF15803D),
                            width: 1.5,
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 20),
                  Text(
                    _isInstall
                        ? 'Foto dokumentasi (opsional)'
                        : 'Foto dokumentasi',
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      color: textOnSurface,
                    ),
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton.icon(
                    onPressed: _completing ? null : _ambilFotoKamera,
                    icon: const Icon(
                      Icons.photo_camera_outlined,
                      color: Color(0xFF15803D),
                    ),
                    label: Text(
                      _foto == null ? 'Ambil dari kamera' : 'Ganti foto',
                    ),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: const Color(0xFF166534),
                      side: const BorderSide(color: Color(0xFF86EFAC)),
                      padding: const EdgeInsets.symmetric(
                        vertical: 14,
                        horizontal: 16,
                      ),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(10),
                      ),
                    ),
                  ),
                  if (_foto != null) ...[
                    const SizedBox(height: 12),
                    ClipRRect(
                      borderRadius: BorderRadius.circular(10),
                      child: Image.file(
                        File(_foto!.path),
                        height: 180,
                        width: double.infinity,
                        fit: BoxFit.cover,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _completing ? null : _selesai,
              style: FilledButton.styleFrom(
                backgroundColor: hijauSelesai,
                foregroundColor: Colors.white,
                disabledBackgroundColor: hijauSelesai.withValues(alpha: 0.5),
                disabledForegroundColor: Colors.white70,
                padding: const EdgeInsets.symmetric(vertical: 16),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                elevation: 0,
              ),
              child: Text(
                _completing ? 'Menyimpan…' : 'Selesai',
                style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.2,
                  color: Colors.white,
                ),
              ),
            ),
            const SizedBox(height: 16),
            TextButton.icon(
              onPressed: _completing ? null : _mintaBantuan,
              icon: const Icon(Icons.chat_outlined, color: Color(0xFF0D9488)),
              label: const Text(
                'Minta bantuan',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: Color(0xFF0F766E),
                ),
              ),
              style: TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 12),
                backgroundColor: const Color(0xFFCCFBF1).withValues(alpha: 0.6),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
            ),
            const SizedBox(height: 48),
          ],
        ),
      ),
    );
  }

  Widget _buildSummaryItem(IconData icon, String label, String value) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 20, color: const Color(0xFF787582)),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF787582),
                  letterSpacing: 0.5,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                value,
                style: const TextStyle(fontSize: 16, color: Color(0xFF19163F)),
              ),
            ],
          ),
        ),
      ],
    );
  }

  void _copyPsbField(BuildContext context, String text, String label) {
    final t = text.trim();
    if (t.isEmpty) return;
    Clipboard.setData(ClipboardData(text: t));
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text('$label disalin')));
  }

  Widget _buildPppoeUsernameSummaryRow(BuildContext context) {
    final raw = _task['pppoe_username'];
    final user = raw == null ? '' : raw.toString().trim();
    final display = user.isEmpty ? '—' : user;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Icon(Icons.router_outlined, size: 20, color: Color(0xFF787582)),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'USERNAME PPPOE',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF787582),
                  letterSpacing: 0.5,
                ),
              ),
              const SizedBox(height: 4),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: SelectableText(
                      display,
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: user.isEmpty
                            ? FontWeight.w500
                            : FontWeight.w600,
                        color: const Color(0xFF19163F),
                      ),
                    ),
                  ),
                  if (user.isNotEmpty)
                    IconButton(
                      tooltip: 'Salin username',
                      visualDensity: VisualDensity.compact,
                      onPressed: () =>
                          _copyPsbField(context, user, 'Username PPPoE'),
                      icon: const Icon(
                        Icons.copy_outlined,
                        size: 20,
                        color: Color(0xFF474551),
                      ),
                    ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// Password PPPoE bisa disalin (SelectableText + tombol salin).
  Widget _buildPppoePasswordSummaryRow(BuildContext context) {
    final raw = _task['pppoe_password'];
    final pass = pppoeCleartextForTechnicianUi(raw?.toString());
    final display = pass.isEmpty ? kTechnicianPppoePasswordEmptyHint : pass;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Icon(Icons.key_outlined, size: 20, color: Color(0xFF787582)),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'PASSWORD PPPOE',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF787582),
                  letterSpacing: 0.5,
                ),
              ),
              const SizedBox(height: 4),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: SelectableText(
                      display,
                      style: TextStyle(
                        fontSize: pass.isEmpty ? 13 : 16,
                        fontWeight: pass.isEmpty
                            ? FontWeight.w400
                            : FontWeight.w600,
                        height: pass.isEmpty ? 1.35 : null,
                        color: pass.isEmpty
                            ? const Color(0xFF5C5A68)
                            : const Color(0xFF19163F),
                      ),
                    ),
                  ),
                  if (pass.isNotEmpty)
                    IconButton(
                      tooltip: 'Salin password',
                      visualDensity: VisualDensity.compact,
                      onPressed: () =>
                          _copyPsbField(context, pass, 'Password PPPoE'),
                      icon: const Icon(
                        Icons.copy_outlined,
                        size: 20,
                        color: Color(0xFF474551),
                      ),
                    ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}
