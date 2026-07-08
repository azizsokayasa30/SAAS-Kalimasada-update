import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Sandi tersimpan aman + preferensi ingat / sidik jari.
class CredentialStorage {
  static const _keyRemember = 'remember_credentials';
  static const _keyBiometric = 'biometric_login_enabled';
  static const _secureUsername = 'saved_username';
  static const _securePassword = 'saved_password';
  static const _secureTenant = 'saved_tenant';

  static const _storage = FlutterSecureStorage();

  static Future<bool> get rememberCredentials async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_keyRemember) ?? false;
  }

  static Future<bool> get biometricEnabled async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_keyBiometric) ?? false;
  }

  static Future<void> setBiometricEnabled(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_keyBiometric, value);
    if (!value) return;
  }

  static Future<void> saveCredentials({
    required String username,
    required String password,
    required bool enableBiometric,
    String? tenant,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_keyRemember, true);
    await prefs.setBool(_keyBiometric, enableBiometric);
    await _storage.write(key: _secureUsername, value: username);
    await _storage.write(key: _securePassword, value: password);
    if (tenant != null && tenant.trim().isNotEmpty) {
      await _storage.write(key: _secureTenant, value: tenant.trim().toLowerCase());
    }
  }

  static Future<void> clearCredentials() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_keyRemember, false);
    await prefs.setBool(_keyBiometric, false);
    await _storage.delete(key: _secureUsername);
    await _storage.delete(key: _securePassword);
    await _storage.delete(key: _secureTenant);
  }

  static Future<({String? username, String? password, String? tenant})>
      readCredentials() async {
    if (!await rememberCredentials) {
      return (username: null, password: null, tenant: null);
    }
    final username = await _storage.read(key: _secureUsername);
    final password = await _storage.read(key: _securePassword);
    final tenant = await _storage.read(key: _secureTenant);
    return (username: username, password: password, tenant: tenant);
  }
}
