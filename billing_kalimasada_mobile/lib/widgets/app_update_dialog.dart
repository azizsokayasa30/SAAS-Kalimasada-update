import 'package:flutter/material.dart';

import '../services/app_update_service.dart';
import '../screens/app_update_screen.dart';

bool _updateCheckInProgress = false;
bool _updateCheckCompleted = false;

/// Dialog pembaruan otomatis — unduh & instal tanpa transfer APK manual.
Future<void> showAppUpdateDialogIfNeeded(BuildContext context) async {
  if (!context.mounted) return;
  if (_updateCheckInProgress || _updateCheckCompleted) return;
  _updateCheckInProgress = true;

  try {
    final current = await AppUpdateService.currentVersionInfo();
    final remote = await AppUpdateService.checkForUpdate();
    if (!context.mounted || remote == null) return;

    if (!AppUpdateService.isNewerThanInstalled(remote, current.version, current.build)) {
      return;
    }

    if (!remote.forceUpdate && remote.buildNumber > 0) {
      final dismissed = await AppUpdateService.wasDismissedForBuild(remote.buildNumber);
      if (dismissed) return;
    }

    if (!context.mounted) return;

    await showDialog<void>(
      context: context,
      barrierDismissible: !remote.forceUpdate,
      builder: (ctx) => _AppUpdateDialogContent(
        update: remote,
        currentLabel: '${current.version}+${current.build}',
      ),
    );
  } catch (_) {
    /* jaringan / server — app tetap jalan */
  } finally {
    _updateCheckInProgress = false;
    _updateCheckCompleted = true;
  }
}

class _AppUpdateDialogContent extends StatefulWidget {
  const _AppUpdateDialogContent({
    required this.update,
    required this.currentLabel,
  });

  final AppUpdateInfo update;
  final String currentLabel;

  @override
  State<_AppUpdateDialogContent> createState() => _AppUpdateDialogContentState();
}

class _AppUpdateDialogContentState extends State<_AppUpdateDialogContent> {
  bool _installing = false;
  double? _progress;

  Future<void> _install() async {
    setState(() {
      _installing = true;
      _progress = 0;
    });
    try {
      await AppUpdateService.downloadAndInstall(
        widget.update.apkUrl,
        onProgress: (p) {
          if (mounted) setState(() => _progress = p);
        },
      );
      if (!mounted) return;
      Navigator.of(context).pop();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Gagal update: $e')),
      );
      setState(() {
        _installing = false;
        _progress = null;
      });
    }
  }

  void _later() {
    if (widget.update.buildNumber > 0) {
      AppUpdateService.markDismissedForBuild(widget.update.buildNumber);
    }
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Pembaruan tersedia'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Versi terpasang: ${widget.currentLabel}'),
            const SizedBox(height: 6),
            Text(
              'Versi baru: ${widget.update.versionLabel}',
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 12),
            Text(
              widget.update.releaseNotes,
              style: const TextStyle(fontSize: 13, height: 1.35),
            ),
            if (_installing) ...[
              const SizedBox(height: 16),
              LinearProgressIndicator(value: _progress),
              const SizedBox(height: 6),
              Text(
                _progress != null
                    ? 'Mengunduh ${(_progress! * 100).toStringAsFixed(0)}%…'
                    : 'Mengunduh…',
                style: const TextStyle(fontSize: 12),
              ),
            ],
          ],
        ),
      ),
      actions: [
        if (!widget.update.forceUpdate && !_installing)
          TextButton(onPressed: _later, child: const Text('Nanti')),
        TextButton(
          onPressed: _installing
              ? null
              : () {
                  Navigator.of(context).pop();
                  Navigator.of(context).push(
                    MaterialPageRoute<void>(builder: (_) => const AppUpdateScreen()),
                  );
                },
          child: const Text('Detail'),
        ),
        FilledButton(
          onPressed: _installing ? null : _install,
          child: Text(_installing ? 'Mengunduh…' : 'Update sekarang'),
        ),
      ],
    );
  }
}
