import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

class AppState extends ChangeNotifier {
  Future<SharedPreferences> prefs() => SharedPreferences.getInstance();
}
