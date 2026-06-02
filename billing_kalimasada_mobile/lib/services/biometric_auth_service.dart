import 'package:local_auth/local_auth.dart';
import 'package:local_auth_android/local_auth_android.dart';

class BiometricAuthService {
  static final LocalAuthentication _auth = LocalAuthentication();

  static Future<bool> isDeviceSupported() async {
    try {
      return await _auth.isDeviceSupported();
    } catch (_) {
      return false;
    }
  }

  static Future<bool> canCheckBiometrics() async {
    try {
      if (!await isDeviceSupported()) return false;
      final types = await _auth.getAvailableBiometrics();
      return types.isNotEmpty;
    } catch (_) {
      return false;
    }
  }

  static Future<({bool ok, String? error})> authenticate({
    String reason = 'Verifikasi sidik jari untuk masuk Kalimasada',
  }) async {
    try {
      if (!await isDeviceSupported()) {
        return (ok: false, error: 'Perangkat tidak mendukung sidik jari');
      }
      final types = await _auth.getAvailableBiometrics();
      if (types.isEmpty) {
        return (ok: false, error: 'Sidik jari belum didaftarkan di HP');
      }

      final ok = await _auth.authenticate(
        localizedReason: reason,
        persistAcrossBackgrounding: true,
        biometricOnly: true,
        authMessages: const [
          AndroidAuthMessages(
            signInTitle: 'Login Kalimasada',
            cancelButton: 'Batal',
          ),
        ],
      );
      if (ok) return (ok: true, error: null);
      return (ok: false, error: 'Sidik jari dibatalkan');
    } on LocalAuthException catch (e) {
      return (ok: false, error: e.description ?? 'Sidik jari gagal');
    } catch (e) {
      return (ok: false, error: 'Sidik jari gagal: $e');
    }
  }
}
