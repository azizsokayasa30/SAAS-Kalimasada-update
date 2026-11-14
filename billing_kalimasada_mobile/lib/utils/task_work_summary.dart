import '../store/task_provider.dart';

String _str(dynamic v) => v?.toString().trim() ?? '';

/// Nama teknisi yang ditugaskan; kosong bila belum ada.
String taskTechnicianName(Map task) {
  final name = _str(task['technician_name']);
  if (name.isNotEmpty) return name;
  return _str(task['assigned_technician_name']);
}

/// Waktu selesai tugas (jam lokal server), bila tersedia.
DateTime? taskCompletedAt(Map task) =>
    parseTaskWorkStarted(_str(task['completed_at']));

/// Lama pengerjaan: nilai tersimpan dari timer, atau selisih mulai–selesai.
Duration? taskWorkDuration(Map task) {
  final stored = int.tryParse(_str(task['work_duration_seconds']));
  if (stored != null && stored > 0) return Duration(seconds: stored);
  final start = parseTaskWorkStarted(_str(task['work_started_at']));
  final end = taskCompletedAt(task);
  if (start == null || end == null) return null;
  final diff = end.difference(start);
  if (diff.isNegative || diff.inDays > 7) return null;
  return diff;
}

/// Contoh: `2 jam 15 mnt`, `45 mnt`, `30 dtk`.
String formatWorkDuration(Duration d) {
  final h = d.inHours;
  final m = d.inMinutes.remainder(60);
  if (h > 0) return m > 0 ? '$h jam $m mnt' : '$h jam';
  if (d.inMinutes > 0) return '${d.inMinutes} mnt';
  return '${d.inSeconds} dtk';
}
