import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/api_client.dart';
import '../services/biometric_auth_service.dart';
import '../services/credential_storage.dart';
import '../services/session_service.dart';
import '../services/tenant_storage.dart';

class AuthProvider extends ChangeNotifier {
  bool _isInitialized = false;
  bool _loading = false;
  String? _error;
  String? _token;
  String? _role;
  Map<String, dynamic>? _user;
  Timer? _midnightLogoutTimer;
  bool _sessionExpiredMessage = false;

  bool get isInitialized => _isInitialized;
  bool get loading => _loading;
  String? get error => _error;
  String? get token => _token;
  String? get role => _role;
  Map<String, dynamic>? get user => _user;
  bool get sessionExpiredMessage => _sessionExpiredMessage;

  void clearSessionExpiredMessage() {
    _sessionExpiredMessage = false;
  }

  Future<void> initialize() async {
    try {
      final prefs = await SharedPreferences.getInstance().timeout(
        const Duration(seconds: 12),
      );
      _token = prefs.getString('token');
      ApiClient.setAuthToken(_token);
      _role = prefs.getString('role');

      final userStr = prefs.getString('user');
      if (userStr != null) {
        try {
          final decoded = jsonDecode(userStr);
          if (decoded is Map) {
            _user = Map<String, dynamic>.from(decoded);
          }
        } catch (_) {
          _user = null;
        }
      }

      if (_token != null) {
        if (prefs.getString('session_expires_at') == null) {
          await SessionService.markSessionValid();
        }
        await checkSessionExpiry(silent: true);
        if (_token != null) {
          _scheduleMidnightLogout();
        }
      }
    } catch (_) {
      /* SP lambat / gagal — tetap tampilkan login */
    } finally {
      _isInitialized = true;
      notifyListeners();
    }
  }

  void _scheduleMidnightLogout() {
    _midnightLogoutTimer?.cancel();
    SessionService.timeUntilMidnightLogout().then((remaining) {
      if (remaining == null || _token == null) return;
      _midnightLogoutTimer = Timer(remaining, () {
        logout(sessionExpired: true);
      });
    });
  }

  /// Cek sesi saat buka app / kembali dari background.
  Future<void> checkSessionExpiry({bool silent = false}) async {
    if (_token == null) return;
    if (!await SessionService.isSessionExpired()) return;
    await logout(sessionExpired: !silent);
  }

  Future<void> login(
    String phone,
    String password, {
    String? tenant,
    bool rememberPassword = false,
    bool enableBiometric = false,
  }) async {
    _loading = true;
    _error = null;
    _sessionExpiredMessage = false;
    notifyListeners();

    try {
      final tenantSlug = tenant?.trim().toLowerCase();
      if (tenantSlug == null || tenantSlug.isEmpty) {
        _error = 'Kode tenant wajib diisi (mis. default, skynet)';
        return;
      }

      await TenantStorage.save(tenantSlug);
      // Pastikan X-Tenant ikut di request login (runtime tenant).
      ApiClient.setRuntimeTenant(tenantSlug);

      final response = await ApiClient.post('/api/auth/login', {
        'username': phone.trim(),
        'password': password,
        'tenant': tenantSlug,
      });

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data['success'] == true) {
          _token = data['token'];
          _user = data['user'];
          _role = _user?['role'];
          ApiClient.setAuthToken(_token);

          final prefs = await SharedPreferences.getInstance();
          // Persist session di background — UI tidak perlu menunggu disk I/O.
          unawaited(() async {
            await prefs.setString('token', _token!);
            await prefs.setString('role', _role ?? '');
            await prefs.setString('user', jsonEncode(_user));
            await SessionService.markSessionValid();
            if (rememberPassword) {
              await CredentialStorage.saveCredentials(
                username: phone,
                password: password,
                enableBiometric: enableBiometric,
                tenant: tenantSlug,
              );
            } else {
              await CredentialStorage.clearCredentials();
            }
          }());
          _scheduleMidnightLogout();
        } else {
          _error = data['message'] ?? 'Login gagal';
        }
      } else {
        final data = jsonDecode(response.body);
        _error = data['message'] ?? 'Gagal menghubungi server';
      }
    } catch (e) {
      _error = 'Koneksi bermasalah: ${e.toString()}';
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  Future<void> loginWithBiometric() async {
    if (!await CredentialStorage.biometricEnabled) {
      _error = 'Login sidik jari belum diaktifkan';
      notifyListeners();
      return;
    }

    final creds = await CredentialStorage.readCredentials();
    if (creds.username == null || creds.password == null) {
      _error = 'Sandi tersimpan tidak ditemukan. Login manual dulu.';
      notifyListeners();
      return;
    }

    if (creds.tenant != null && creds.tenant!.trim().isNotEmpty) {
      await TenantStorage.save(creds.tenant);
    }

    final authResult = await BiometricAuthService.authenticate();
    if (!authResult.ok) {
      _error = authResult.error ?? 'Sidik jari gagal atau dibatalkan';
      notifyListeners();
      return;
    }

    await login(
      creds.username!,
      creds.password!,
      tenant: creds.tenant ?? ApiClient.apiTenant,
      rememberPassword: true,
      enableBiometric: true,
    );
  }

  /// Muat ulang profil teknisi dari server (sinkron dengan web / tabel technicians).
  Future<void> refreshTechnicianProfile() async {
    if (_role != 'technician' || _token == null) return;
    try {
      final response = await ApiClient.get('/api/mobile-adapter/me');
      if (response.statusCode != 200) return;
      final data = jsonDecode(response.body);
      if (data['success'] == true && data['data'] != null) {
        final merged = Map<String, dynamic>.from(data['data'] as Map);
        merged['role'] = 'technician';
        _user = merged;
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('user', jsonEncode(_user));
        notifyListeners();
      }
    } catch (_) {
      /* biarkan cache login */
    }
  }

  Future<String?> updateTechnicianProfile({
    required String name,
    required String phone,
    String? email,
    String? address,
  }) async {
    if (_role != 'technician' || _token == null) {
      return 'Akun teknisi tidak aktif';
    }
    try {
      final response = await ApiClient.put('/api/mobile-adapter/me', {
        'name': name,
        'phone': phone,
        'email': email ?? '',
        'address': address ?? '',
      });
      final data = jsonDecode(response.body);
      if (response.statusCode == 200 && data['success'] == true) {
        await refreshTechnicianProfile();
        return null;
      }
      return data['message']?.toString() ?? 'Gagal menyimpan';
    } catch (e) {
      return e.toString();
    }
  }

  /// Upload foto profil teknisi (JPEG/PNG base64) ke backend.
  Future<String?> updateTechnicianPhotoBase64(String photoBase64) async {
    if (_role != 'technician' || _token == null) {
      return 'Akun teknisi tidak aktif';
    }
    final payload = photoBase64.trim();
    if (payload.isEmpty) return 'Foto wajib diisi';
    try {
      final response = await ApiClient.post('/api/mobile-adapter/me/photo', {
        'photo_base64': payload,
      });
      final data = jsonDecode(response.body);
      if (response.statusCode == 200 && data['success'] == true) {
        final photoUrl = data is Map && data['data'] is Map
            ? (data['data'] as Map)['photo_url']?.toString()
            : null;
        if (photoUrl != null && photoUrl.trim().isNotEmpty && _user != null) {
          _user = {..._user!, 'photo_url': photoUrl};
          final prefs = await SharedPreferences.getInstance();
          await prefs.setString('user', jsonEncode(_user));
          notifyListeners();
        }
        await refreshTechnicianProfile();
        return null;
      }
      return data['message']?.toString() ?? 'Gagal mengunggah foto';
    } catch (e) {
      return e.toString();
    }
  }

  Future<void> logout({bool sessionExpired = false, bool clearSavedCredentials = false}) async {
    _midnightLogoutTimer?.cancel();
    _midnightLogoutTimer = null;

    _token = null;
    _role = null;
    _user = null;
    _sessionExpiredMessage = sessionExpired;
    ApiClient.setAuthToken(null);

    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('token');
    await prefs.remove('role');
    await prefs.remove('user');
    await SessionService.clearSessionMarker();

    if (clearSavedCredentials) {
      await CredentialStorage.clearCredentials();
    }

    notifyListeners();
  }

  @override
  void dispose() {
    _midnightLogoutTimer?.cancel();
    super.dispose();
  }
}
