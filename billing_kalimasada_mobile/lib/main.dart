import 'package:flutter/material.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:provider/provider.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'theme/colors.dart';
import 'store/auth_provider.dart';
import 'store/customer_provider.dart';
import 'store/task_provider.dart';
import 'store/notification_provider.dart';
import 'store/collector_provider.dart';
import 'store/collector_notification_provider.dart';
import 'screens/customer_list_screen.dart';
import 'navigation/root_navigator.dart';
import 'services/tenant_storage.dart';
import 'services/api_origin_cache.dart';
import 'services/api_origin_resolver.dart';
import 'services/api_client.dart';
import 'services/server_settings.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeDateFormatting('id_ID');
  try {
    await dotenv.load(fileName: ".env");
    print('Loaded API_URL: ${dotenv.env['API_URL']}');
  } catch (e) {
    print('dotenv load skipped: $e');
  }
  await ApiOriginCache.initialize();
  var cachedOrigin = ApiOriginCache.memory;
  if (cachedOrigin != null &&
      (cachedOrigin.contains('?') ||
          cachedOrigin.contains('#') ||
          !ApiOriginResolver.isOriginAllowedOnPlatform(cachedOrigin))) {
    await ApiOriginCache.clear();
    cachedOrigin = null;
  }
  await ServerSettings.initialize();
  if (ServerSettings.override == null) {
    ApiClient.setWorkingOrigin(ApiOriginCache.memory);
  }
  await TenantStorage.initialize();

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => AuthProvider()..initialize()),
        ChangeNotifierProvider(create: (_) => CustomerProvider()),
        ChangeNotifierProvider(create: (_) => TaskProvider()),
        ChangeNotifierProvider(create: (_) => NotificationProvider()),
        ChangeNotifierProvider(create: (_) => CollectorProvider()),
        ChangeNotifierProvider(create: (_) => CollectorNotificationProvider()),
      ],
      child: const MyApp(),
    ),
  );
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Billing Kalimasada',
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: AppColors.background,
        colorScheme: const ColorScheme.dark(
          primary: AppColors.primary,
          secondary: AppColors.secondary,
          surface: AppColors.surface,
          error: AppColors.error,
        ),
        useMaterial3: true,
      ),
      home: const RootNavigator(),
      routes: {
        '/customers': (context) => const CustomerListScreen(),
      },
    );
  }
}
