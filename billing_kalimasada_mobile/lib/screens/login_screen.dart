import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/colors.dart';
import '../store/auth_provider.dart';
import '../services/biometric_auth_service.dart';
import '../services/credential_storage.dart';
import '../widgets/app_update_dialog.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _phoneController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _obscurePassword = true;
  bool _rememberPassword = false;
  bool _enableBiometric = false;
  bool _biometricAvailable = false;
  bool _biometricLoginReady = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }

  Future<void> _bootstrap() async {
    if (mounted) {
      await showAppUpdateDialogIfNeeded(context);
    }
    if (!mounted) return;

    final auth = context.read<AuthProvider>();
    if (auth.sessionExpiredMessage && mounted) {
      auth.clearSessionExpiredMessage();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Sesi berakhir (jam 12 malam). Silakan login kembali.'),
          backgroundColor: AppColors.error,
        ),
      );
    }

    final remember = await CredentialStorage.rememberCredentials;
    final biometricOn = await CredentialStorage.biometricEnabled;
    final bioAvailable = await BiometricAuthService.canCheckBiometrics();
    final creds = await CredentialStorage.readCredentials();

    if (!mounted) return;
    setState(() {
      _rememberPassword = remember;
      _enableBiometric = biometricOn && remember;
      _biometricAvailable = bioAvailable;
      _biometricLoginReady =
          biometricOn && remember && creds.username != null && creds.password != null && bioAvailable;
      if (creds.username != null) {
        _phoneController.text = creds.username!;
      }
      if (remember && creds.password != null) {
        _passwordController.text = creds.password!;
      }
    });

    if (_biometricLoginReady && mounted && !auth.loading) {
      await Future<void>.delayed(const Duration(milliseconds: 400));
      if (!mounted || auth.loading) return;
      await context.read<AuthProvider>().loginWithBiometric();
    }
  }

  void _handleLogin() {
    final phone = _phoneController.text.trim();
    final password = _passwordController.text.trim();

    if (phone.isEmpty || password.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Operator ID dan Passcode tidak boleh kosong'),
          backgroundColor: AppColors.error,
        ),
      );
      return;
    }

    context.read<AuthProvider>().login(
          phone,
          password,
          rememberPassword: _rememberPassword,
          enableBiometric: _rememberPassword && _enableBiometric,
        );
  }

  Future<void> _handleBiometricLogin() async {
    await context.read<AuthProvider>().loginWithBiometric();
  }

  @override
  void dispose() {
    _phoneController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();

    const bgColor = Color(0xFFF7F9FC);
    const surfaceColor = Color(0xFFFFFFFF);
    const outlineColor = Color(0xFFC6C5D4);
    const outlineVariantColor = Color(0xFFE0E3E6);
    const primaryColor = Color(0xFF000666);
    const primaryContainerColor = Color(0xFF1A237E);
    const textOnSurfaceVariant = Color(0xFF454652);
    const textOnSurface = Color(0xFF191C1E);
    const secondaryColor = Color(0xFF4555B7);

    return Scaffold(
      backgroundColor: bgColor,
      body: Stack(
        children: [
          Positioned(
            top: -100,
            left: -100,
            child: Container(
              width: 300,
              height: 300,
              decoration: BoxDecoration(
                color: const Color(0xFFE0E0FF).withValues(alpha: 0.3),
                shape: BoxShape.circle,
              ),
            ),
          ),
          Positioned(
            bottom: -100,
            right: -100,
            child: Container(
              width: 400,
              height: 400,
              decoration: BoxDecoration(
                color: const Color(0xFFDEE0FF).withValues(alpha: 0.2),
                shape: BoxShape.circle,
              ),
            ),
          ),
          Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 48),
              child: Container(
                width: double.infinity,
                constraints: const BoxConstraints(maxWidth: 420),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 80,
                      height: 80,
                      margin: const EdgeInsets.only(bottom: 16),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: outlineVariantColor),
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withValues(alpha: 0.02),
                            offset: const Offset(0, 2),
                            blurRadius: 4,
                          ),
                        ],
                      ),
                      child: Image.network(
                        'https://lh3.googleusercontent.com/aida/ADBb0uigyPo7kYxetK4jpO52xkL5rz9NhnYgbkLaQdmEGtZTRqeOiB5GLIJCLXRdsLMcK14L3KZHpWIxumtbCqUt0LVHWJgZgosS6VjK5iPLigpCnsxSbny3Z-YqTZkLuWqfHhxN5Hhn2a5ddcEQuez0h_FjBimTr_Uz3awl6oZ3o_Z2yxa9lYfnZLJcB0MXw4XCwYynJi7Trqbq1rbDnBPg4OjN8CDMJSGWm2zv0qZPihuMgsOq0o595ptKMefm3APskap46c3K0wewyg',
                        fit: BoxFit.contain,
                        errorBuilder: (context, error, stackTrace) =>
                            const Icon(Icons.router, size: 40, color: primaryColor),
                      ),
                    ),
                    const Text(
                      'Kalimasada Mobile',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 32,
                        fontWeight: FontWeight.bold,
                        color: primaryColor,
                        letterSpacing: -0.02,
                      ),
                    ),
                    const SizedBox(height: 4),
                    const Text(
                      'Portal tim kalimasada',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 16,
                        color: textOnSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 32),
                    Container(
                      padding: const EdgeInsets.all(32),
                      decoration: BoxDecoration(
                        color: surfaceColor,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: outlineVariantColor),
                        boxShadow: [
                          BoxShadow(
                            color: const Color(0xFF1A237E).withValues(alpha: 0.06),
                            offset: const Offset(0, 4),
                            blurRadius: 24,
                          ),
                        ],
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (auth.error != null)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 16),
                              child: Text(
                                auth.error!,
                                textAlign: TextAlign.center,
                                style: const TextStyle(color: AppColors.error),
                              ),
                            ),
                          const Text(
                            'Operator ID / Email',
                            style: TextStyle(
                              color: textOnSurface,
                              fontSize: 14,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                          const SizedBox(height: 6),
                          TextField(
                            controller: _phoneController,
                            keyboardType: TextInputType.emailAddress,
                            style: const TextStyle(color: textOnSurface, fontSize: 16),
                            decoration: InputDecoration(
                              hintText: 'e.g. OP-8492 or email',
                              hintStyle: TextStyle(color: textOnSurfaceVariant.withValues(alpha: 0.5)),
                              prefixIcon: const Icon(Icons.person, color: textOnSurfaceVariant),
                              filled: true,
                              fillColor: bgColor,
                              contentPadding: const EdgeInsets.symmetric(vertical: 12),
                              enabledBorder: OutlineInputBorder(
                                borderSide: const BorderSide(color: outlineColor),
                                borderRadius: BorderRadius.circular(8),
                              ),
                              focusedBorder: OutlineInputBorder(
                                borderSide: const BorderSide(color: primaryColor, width: 2),
                                borderRadius: BorderRadius.circular(8),
                              ),
                            ),
                          ),
                          const SizedBox(height: 16),
                          const Text(
                            'Password',
                            style: TextStyle(
                              color: textOnSurface,
                              fontSize: 14,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                          const SizedBox(height: 6),
                          TextField(
                            controller: _passwordController,
                            obscureText: _obscurePassword,
                            style: const TextStyle(color: textOnSurface, fontSize: 16),
                            decoration: InputDecoration(
                              hintText: '••••••••',
                              hintStyle: TextStyle(color: textOnSurfaceVariant.withValues(alpha: 0.5)),
                              prefixIcon: const Icon(Icons.lock, color: textOnSurfaceVariant),
                              suffixIcon: IconButton(
                                icon: Icon(
                                  _obscurePassword ? Icons.visibility_off : Icons.visibility,
                                  color: textOnSurfaceVariant,
                                ),
                                onPressed: () {
                                  setState(() => _obscurePassword = !_obscurePassword);
                                },
                              ),
                              filled: true,
                              fillColor: bgColor,
                              contentPadding: const EdgeInsets.symmetric(vertical: 12),
                              enabledBorder: OutlineInputBorder(
                                borderSide: const BorderSide(color: outlineColor),
                                borderRadius: BorderRadius.circular(8),
                              ),
                              focusedBorder: OutlineInputBorder(
                                borderSide: const BorderSide(color: primaryColor, width: 2),
                                borderRadius: BorderRadius.circular(8),
                              ),
                            ),
                          ),
                          const SizedBox(height: 12),
                          CheckboxListTile(
                            value: _rememberPassword,
                            onChanged: (v) {
                              setState(() {
                                _rememberPassword = v ?? false;
                                if (!_rememberPassword) _enableBiometric = false;
                              });
                            },
                            contentPadding: EdgeInsets.zero,
                            controlAffinity: ListTileControlAffinity.leading,
                            dense: true,
                            title: const Text(
                              'Ingat sandi',
                              style: TextStyle(fontSize: 14, color: textOnSurface),
                            ),
                          ),
                          if (_biometricAvailable)
                            CheckboxListTile(
                              value: _enableBiometric,
                              onChanged: _rememberPassword
                                  ? (v) => setState(() => _enableBiometric = v ?? false)
                                  : null,
                              contentPadding: EdgeInsets.zero,
                              controlAffinity: ListTileControlAffinity.leading,
                              dense: true,
                              title: const Text(
                                'Login sidik jari',
                                style: TextStyle(fontSize: 14, color: textOnSurface),
                              ),
                            ),
                          const SizedBox(height: 16),
                          Container(
                            decoration: BoxDecoration(
                              borderRadius: BorderRadius.circular(8),
                              gradient: const LinearGradient(
                                begin: Alignment.topLeft,
                                end: Alignment.bottomRight,
                                colors: [primaryColor, primaryContainerColor],
                              ),
                              boxShadow: [
                                BoxShadow(
                                  color: Colors.black.withValues(alpha: 0.1),
                                  offset: const Offset(0, 1),
                                  blurRadius: 2,
                                ),
                              ],
                            ),
                            child: ElevatedButton(
                              onPressed: auth.loading ? null : _handleLogin,
                              style: ElevatedButton.styleFrom(
                                backgroundColor: Colors.transparent,
                                shadowColor: Colors.transparent,
                                foregroundColor: Colors.white,
                                padding: const EdgeInsets.symmetric(vertical: 14),
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(8),
                                ),
                              ),
                              child: auth.loading
                                  ? const SizedBox(
                                      height: 20,
                                      width: 20,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: Colors.white,
                                      ),
                                    )
                                  : const Text(
                                      'LOGIN YUK',
                                      style: TextStyle(
                                        fontSize: 14,
                                        fontWeight: FontWeight.w500,
                                        letterSpacing: 0.1,
                                      ),
                                    ),
                            ),
                          ),
                          if (_biometricLoginReady || (_biometricAvailable && _rememberPassword)) ...[
                            const SizedBox(height: 16),
                            OutlinedButton.icon(
                              onPressed: auth.loading ? null : _handleBiometricLogin,
                              icon: const Icon(Icons.fingerprint, size: 28),
                              label: const Text('Masuk dengan sidik jari'),
                              style: OutlinedButton.styleFrom(
                                foregroundColor: primaryColor,
                                side: const BorderSide(color: primaryColor),
                                padding: const EdgeInsets.symmetric(vertical: 12),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(height: 48),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                      decoration: BoxDecoration(
                        color: const Color(0xFFECEEF1),
                        borderRadius: BorderRadius.circular(50),
                        border: Border.all(color: outlineVariantColor),
                      ),
                      child: const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.shield, size: 14, color: secondaryColor),
                          SizedBox(width: 6),
                          Text(
                            'Sesi otomatis logout jam 12 malam',
                            style: TextStyle(
                              color: textOnSurfaceVariant,
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
