import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import '../theme/colors.dart';
import '../store/auth_provider.dart';
import '../services/biometric_auth_service.dart';
import '../services/credential_storage.dart';
import '../services/tenant_service.dart';
import '../services/tenant_storage.dart';
import '../services/api_client.dart';
import '../services/server_settings.dart';
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
  List<TenantOption> _tenantOptions = const [];
  String? _selectedTenant;
  bool _loadingTenants = true;
  String? _tenantLoadError;
  String? _tenantLoadOrigin;
  bool? _serverHealthy;
  bool _checkingServerHealth = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }

  String get _displayServerOrigin =>
      ApiClient.normalizeOrigin(ServerSettings.displayOrigin());

  String get _companyLogoUrl {
    final origin = ApiClient.apiOrigin;
    return Uri.parse(origin).replace(path: '/public/img/logo.png').toString();
  }

  Future<void> _bootstrap() async {
    final remember = await CredentialStorage.rememberCredentials;
    final biometricOn = await CredentialStorage.biometricEnabled;
    final bioAvailable = await BiometricAuthService.canCheckBiometrics();
    final creds = await CredentialStorage.readCredentials();
    final savedTenant = await TenantStorage.load();

    if (!mounted) return;
    await Future.wait([
      _loadTenants(
        preferredSlug: creds.tenant?.trim().isNotEmpty == true
            ? creds.tenant
            : savedTenant,
      ),
      _checkServerHealth(),
    ]);

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

    if (!mounted) return;
    setState(() {
      _rememberPassword = remember;
      _enableBiometric = biometricOn && remember;
      _biometricAvailable = bioAvailable;
      _biometricLoginReady =
          biometricOn &&
          remember &&
          creds.username != null &&
          creds.password != null &&
          bioAvailable;
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

  Future<void> _checkServerHealth() async {
    if (!mounted) return;
    setState(() => _checkingServerHealth = true);
    try {
      final origin = ApiClient.normalizeOrigin(ServerSettings.displayOrigin());
      final uri = Uri.parse(origin).resolve('/api/mobile-adapter/health');
      final response = await http
          .get(uri, headers: const {'Accept': 'application/json'})
          .timeout(const Duration(seconds: 5));
      if (!mounted) return;
      setState(() {
        _serverHealthy = response.statusCode >= 200 && response.statusCode < 300;
        _checkingServerHealth = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _serverHealthy = false;
        _checkingServerHealth = false;
      });
    }
  }

  Future<void> _loadTenants({String? preferredSlug}) async {
    setState(() {
      _loadingTenants = true;
      _tenantLoadError = null;
      _tenantLoadOrigin = null;
    });

    final result = await TenantService.fetchActiveTenants();
    if (!mounted) return;

    final tenants = result.tenants;
    final normalizedPreferred = preferredSlug?.trim().toLowerCase();
    String? selected;
    // Jangan auto-pilih tenant pertama — itu bisa tenant lain (kebocoran data).
    // Hanya preselect jika user punya slug tersimpan / dari credential.
    if (normalizedPreferred != null &&
        normalizedPreferred.isNotEmpty &&
        tenants.any((t) => t.subdomain == normalizedPreferred)) {
      selected = normalizedPreferred;
    } else if (normalizedPreferred != null &&
        normalizedPreferred.isNotEmpty &&
        tenants.isEmpty) {
      selected = normalizedPreferred;
    }

    setState(() {
      _loadingTenants = false;
      _tenantOptions = tenants;
      _selectedTenant = selected;
      _tenantLoadOrigin = result.usedOrigin;
      _tenantLoadError = result.ok ? null : result.error;
      if (result.ok) _serverHealthy = true;
    });

    // Sinkron status server setelah daftar tenant.
    await _checkServerHealth();
  }

  List<TenantOption> get _dropdownTenants {
    final slug = _selectedTenant?.trim().toLowerCase();
    if (slug == null || slug.isEmpty) return _tenantOptions;
    if (_tenantOptions.any((t) => t.subdomain == slug)) return _tenantOptions;
    return [
      TenantOption(subdomain: slug, name: slug),
      ..._tenantOptions,
    ];
  }

  String _tenantLabel(TenantOption tenant) {
    if (tenant.name.isEmpty || tenant.name == tenant.subdomain) {
      return tenant.subdomain;
    }
    return '${tenant.name} (${tenant.subdomain})';
  }

  void _handleLogin() {
    final tenant = _selectedTenant?.trim().toLowerCase();
    final phone = _phoneController.text.trim();
    final password = _passwordController.text.trim();

    if (tenant == null || tenant.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Pilih tenant terlebih dahulu'),
          backgroundColor: AppColors.error,
        ),
      );
      return;
    }

    if (phone.isEmpty || password.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Username/ID dan Password tidak boleh kosong'),
          backgroundColor: AppColors.error,
        ),
      );
      return;
    }

    context.read<AuthProvider>().login(
      phone,
      password,
      tenant: tenant,
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

  InputDecoration _fieldDecoration({
    required Color bgColor,
    required Color outlineColor,
    required Color primaryColor,
    required Color textOnSurfaceVariant,
    String? hintText,
    Widget? prefixIcon,
    Widget? suffixIcon,
    EdgeInsetsGeometry? contentPadding,
  }) {
    return InputDecoration(
      hintText: hintText,
      hintStyle: TextStyle(color: textOnSurfaceVariant.withValues(alpha: 0.5)),
      prefixIcon: prefixIcon,
      suffixIcon: suffixIcon,
      filled: true,
      fillColor: bgColor,
      isDense: true,
      contentPadding:
          contentPadding ??
          const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      enabledBorder: OutlineInputBorder(
        borderSide: BorderSide(color: outlineColor),
        borderRadius: BorderRadius.circular(8),
      ),
      focusedBorder: OutlineInputBorder(
        borderSide: BorderSide(color: primaryColor, width: 2),
        borderRadius: BorderRadius.circular(8),
      ),
    );
  }

  Widget _buildTenantDropdown({
    required bool authLoading,
    required Color bgColor,
    required Color outlineColor,
    required Color primaryColor,
    required Color textOnSurface,
    required Color textOnSurfaceVariant,
  }) {
    if (_loadingTenants) {
      return InputDecorator(
        decoration: _fieldDecoration(
          bgColor: bgColor,
          outlineColor: outlineColor,
          primaryColor: primaryColor,
          textOnSurfaceVariant: textOnSurfaceVariant,
          prefixIcon: Icon(
            Icons.apartment,
            size: 20,
            color: textOnSurfaceVariant,
          ),
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 10,
            vertical: 8,
          ),
        ),
        child: Row(
          children: [
            const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: 10),
            Text(
              'Memuat tenant…',
              style: TextStyle(color: textOnSurfaceVariant, fontSize: 13),
            ),
          ],
        ),
      );
    }

    if (_tenantOptions.isEmpty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InputDecorator(
            decoration: _fieldDecoration(
              bgColor: bgColor,
              outlineColor: outlineColor,
              primaryColor: primaryColor,
              textOnSurfaceVariant: textOnSurfaceVariant,
              prefixIcon: Icon(
                Icons.apartment,
                size: 20,
                color: textOnSurfaceVariant,
              ),
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 10,
                vertical: 8,
              ),
            ),
            child: Text(
              _tenantLoadError ?? 'Tenant tidak tersedia',
              style: TextStyle(color: textOnSurfaceVariant, fontSize: 13),
            ),
          ),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: authLoading
                  ? null
                  : () => _loadTenants(preferredSlug: _selectedTenant),
              icon: const Icon(Icons.refresh, size: 16),
              label: const Text('Muat ulang', style: TextStyle(fontSize: 12)),
              style: TextButton.styleFrom(
                visualDensity: VisualDensity.compact,
                padding: const EdgeInsets.symmetric(horizontal: 8),
              ),
            ),
          ),
        ],
      );
    }

    final items = _dropdownTenants;
    final value = items.any((t) => t.subdomain == _selectedTenant)
        ? _selectedTenant
        : null;

    return InputDecorator(
      decoration: _fieldDecoration(
        bgColor: bgColor,
        outlineColor: outlineColor,
        primaryColor: primaryColor,
        textOnSurfaceVariant: textOnSurfaceVariant,
        prefixIcon: Icon(Icons.apartment, size: 20, color: textOnSurfaceVariant),
        contentPadding: const EdgeInsets.fromLTRB(8, 2, 8, 2),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          value: value,
          isExpanded: true,
          isDense: true,
          iconSize: 20,
          hint: Text(
            'Pilih tenant',
            style: TextStyle(
              color: textOnSurfaceVariant.withValues(alpha: 0.5),
              fontSize: 14,
            ),
          ),
          style: TextStyle(color: textOnSurface, fontSize: 14),
          dropdownColor: Colors.white,
          items: items
              .map(
                (tenant) => DropdownMenuItem<String>(
                  value: tenant.subdomain,
                  child: Text(
                    _tenantLabel(tenant),
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: Color(0xFF191C1E),
                      fontSize: 14,
                    ),
                  ),
                ),
              )
              .toList(),
          onChanged: authLoading
              ? null
              : (slug) => setState(() => _selectedTenant = slug),
        ),
      ),
    );
  }

  Widget _buildOptionRow({
    required bool value,
    required ValueChanged<bool?>? onChanged,
    required String label,
    required IconData icon,
    required Color primaryColor,
    required Color textColor,
    required Color mutedColor,
  }) {
    final enabled = onChanged != null;
    final toggle = onChanged;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: toggle == null ? null : () => toggle(!value),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            children: [
              SizedBox(
                width: 28,
                height: 28,
                child: Checkbox(
                  value: value,
                  onChanged: toggle,
                  activeColor: primaryColor,
                  checkColor: Colors.white,
                  side: BorderSide(
                    color: enabled ? primaryColor : mutedColor,
                    width: 1.6,
                  ),
                  materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  visualDensity: VisualDensity.compact,
                ),
              ),
              const SizedBox(width: 8),
              Icon(
                icon,
                size: 18,
                color: enabled ? primaryColor : mutedColor,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  label,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: enabled ? textColor : mutedColor,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildServerStatusFooter({
    required Color outlineVariantColor,
    required Color textOnSurfaceVariant,
  }) {
    final origin = _tenantLoadOrigin ?? _displayServerOrigin;
    final healthy = _serverHealthy;
    final Color statusColor;
    final String statusLabel;
    final IconData statusIcon;

    if (_checkingServerHealth && healthy == null) {
      statusColor = const Color(0xFF94A3B8);
      statusLabel = 'Cek…';
      statusIcon = Icons.hourglass_top_rounded;
    } else if (healthy == true) {
      statusColor = const Color(0xFF16A34A);
      statusLabel = 'Server aman';
      statusIcon = Icons.verified_user_rounded;
    } else {
      statusColor = const Color(0xFFDC2626);
      statusLabel = 'Server capek';
      statusIcon = Icons.error_outline_rounded;
    }

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: outlineVariantColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Server',
            style: TextStyle(
              color: textOnSurfaceVariant,
              fontSize: 11,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.3,
            ),
          ),
          const SizedBox(height: 6),
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: Text(
                  origin,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF0F172A),
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: statusColor.withValues(alpha: 0.35)),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (_checkingServerHealth && healthy == null)
                      SizedBox(
                        width: 12,
                        height: 12,
                        child: CircularProgressIndicator(
                          strokeWidth: 1.8,
                          color: statusColor,
                        ),
                      )
                    else
                      Icon(statusIcon, size: 14, color: statusColor),
                    const SizedBox(width: 5),
                    Text(
                      statusLabel,
                      style: TextStyle(
                        color: statusColor,
                        fontSize: 11,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
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

    return Theme(
      data: ThemeData.light(useMaterial3: true).copyWith(
        scaffoldBackgroundColor: bgColor,
        colorScheme: ColorScheme.fromSeed(
          seedColor: primaryColor,
          brightness: Brightness.light,
        ),
        checkboxTheme: CheckboxThemeData(
          fillColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.selected)) return primaryColor;
            return Colors.white;
          }),
          checkColor: const WidgetStatePropertyAll(Colors.white),
          side: const BorderSide(color: primaryColor, width: 1.6),
        ),
      ),
      child: Scaffold(
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
                padding: const EdgeInsets.symmetric(
                  horizontal: 24,
                  vertical: 40,
                ),
                child: Container(
                  width: double.infinity,
                  constraints: const BoxConstraints(maxWidth: 420),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 96,
                        height: 96,
                        margin: const EdgeInsets.only(bottom: 14),
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(18),
                          border: Border.all(color: outlineVariantColor),
                          boxShadow: [
                            BoxShadow(
                              color: Colors.black.withValues(alpha: 0.04),
                              offset: const Offset(0, 2),
                              blurRadius: 8,
                            ),
                          ],
                        ),
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Image.network(
                            _companyLogoUrl,
                            fit: BoxFit.contain,
                            errorBuilder: (context, error, stackTrace) =>
                                const Icon(
                                  Icons.business_rounded,
                                  size: 42,
                                  color: primaryColor,
                                ),
                          ),
                        ),
                      ),
                      const Text(
                        'Kalimasada Mobile',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 28,
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
                          fontSize: 15,
                          color: textOnSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 24),
                      Container(
                        padding: const EdgeInsets.fromLTRB(24, 24, 24, 20),
                        decoration: BoxDecoration(
                          color: surfaceColor,
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: outlineVariantColor),
                          boxShadow: [
                            BoxShadow(
                              color: const Color(
                                0xFF1A237E,
                              ).withValues(alpha: 0.06),
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
                                padding: const EdgeInsets.only(bottom: 14),
                                child: Text(
                                  auth.error!,
                                  textAlign: TextAlign.center,
                                  style: const TextStyle(color: AppColors.error),
                                ),
                              ),
                            const Text(
                              'Tenant / Area',
                              style: TextStyle(
                                color: textOnSurface,
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 6),
                            _buildTenantDropdown(
                              authLoading: auth.loading,
                              bgColor: bgColor,
                              outlineColor: outlineColor,
                              primaryColor: primaryColor,
                              textOnSurface: textOnSurface,
                              textOnSurfaceVariant: textOnSurfaceVariant,
                            ),
                            if (_tenantLoadError != null &&
                                _tenantLoadError!.isNotEmpty)
                              Padding(
                                padding: const EdgeInsets.only(top: 6),
                                child: Text(
                                  _tenantLoadError!,
                                  style: const TextStyle(
                                    color: textOnSurfaceVariant,
                                    fontSize: 11,
                                  ),
                                ),
                              ),
                            const SizedBox(height: 14),
                            const Text(
                              'Username/ID',
                              style: TextStyle(
                                color: textOnSurface,
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 6),
                            TextField(
                              controller: _phoneController,
                              keyboardType: TextInputType.emailAddress,
                              style: const TextStyle(
                                color: textOnSurface,
                                fontSize: 15,
                              ),
                              decoration: _fieldDecoration(
                                bgColor: bgColor,
                                outlineColor: outlineColor,
                                primaryColor: primaryColor,
                                textOnSurfaceVariant: textOnSurfaceVariant,
                                hintText: 'Username atau ID',
                                prefixIcon: const Icon(
                                  Icons.person,
                                  color: textOnSurfaceVariant,
                                  size: 20,
                                ),
                              ),
                            ),
                            const SizedBox(height: 14),
                            const Text(
                              'Password',
                              style: TextStyle(
                                color: textOnSurface,
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 6),
                            TextField(
                              controller: _passwordController,
                              obscureText: _obscurePassword,
                              style: const TextStyle(
                                color: textOnSurface,
                                fontSize: 15,
                              ),
                              decoration: _fieldDecoration(
                                bgColor: bgColor,
                                outlineColor: outlineColor,
                                primaryColor: primaryColor,
                                textOnSurfaceVariant: textOnSurfaceVariant,
                                hintText: '••••••••',
                                prefixIcon: const Icon(
                                  Icons.lock,
                                  color: textOnSurfaceVariant,
                                  size: 20,
                                ),
                                suffixIcon: IconButton(
                                  icon: Icon(
                                    _obscurePassword
                                        ? Icons.visibility_off
                                        : Icons.visibility,
                                    color: textOnSurfaceVariant,
                                    size: 20,
                                  ),
                                  onPressed: () {
                                    setState(
                                      () =>
                                          _obscurePassword = !_obscurePassword,
                                    );
                                  },
                                ),
                              ),
                            ),
                            const SizedBox(height: 10),
                            _buildOptionRow(
                              value: _rememberPassword,
                              onChanged: (v) {
                                setState(() {
                                  _rememberPassword = v ?? false;
                                  if (!_rememberPassword) {
                                    _enableBiometric = false;
                                  }
                                });
                              },
                              label: 'Ingat sandi',
                              icon: Icons.lock_clock_outlined,
                              primaryColor: primaryColor,
                              textColor: textOnSurface,
                              mutedColor: textOnSurfaceVariant,
                            ),
                            if (_biometricAvailable)
                              _buildOptionRow(
                                value: _enableBiometric,
                                onChanged: _rememberPassword
                                    ? (v) => setState(
                                        () => _enableBiometric = v ?? false,
                                      )
                                    : null,
                                label: 'Login sidik jari',
                                icon: Icons.fingerprint,
                                primaryColor: primaryColor,
                                textColor: textOnSurface,
                                mutedColor: textOnSurfaceVariant,
                              ),
                            const SizedBox(height: 14),
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
                                  padding: const EdgeInsets.symmetric(
                                    vertical: 14,
                                  ),
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
                                          fontWeight: FontWeight.w600,
                                          letterSpacing: 0.1,
                                        ),
                                      ),
                              ),
                            ),
                            if (_biometricLoginReady ||
                                (_biometricAvailable &&
                                    _rememberPassword)) ...[
                              const SizedBox(height: 12),
                              OutlinedButton.icon(
                                onPressed: auth.loading
                                    ? null
                                    : _handleBiometricLogin,
                                icon: const Icon(Icons.fingerprint, size: 24),
                                label: const Text('Masuk dengan sidik jari'),
                                style: OutlinedButton.styleFrom(
                                  foregroundColor: primaryColor,
                                  side: const BorderSide(color: primaryColor),
                                  padding: const EdgeInsets.symmetric(
                                    vertical: 11,
                                  ),
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                      _buildServerStatusFooter(
                        outlineVariantColor: outlineVariantColor,
                        textOnSurfaceVariant: textOnSurfaceVariant,
                      ),
                      const SizedBox(height: 16),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 6,
                        ),
                        decoration: BoxDecoration(
                          color: const Color(0xFFECEEF1),
                          borderRadius: BorderRadius.circular(50),
                          border: Border.all(color: outlineVariantColor),
                        ),
                        child: const Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              Icons.shield,
                              size: 14,
                              color: secondaryColor,
                            ),
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
      ),
    );
  }
}
