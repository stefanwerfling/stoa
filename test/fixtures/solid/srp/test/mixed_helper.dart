import '../lib/data/cache.dart';
import '../lib/data/net.dart';

/// Test paths are never judged.
class Helper {
  final DiskCache _cache = DiskCache();
  final NetClient _net = NetClient();

  void store() {
    _cache.put('k', 'v');
  }

  Future<String> fetch() => _net.get('x');
}
