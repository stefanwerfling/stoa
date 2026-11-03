import 'package:http/http.dart' as http;
import 'data/cache.dart';
import 'data/net.dart';

/// Two responsibilities: caching (DiskCache) and fetching (NetClient, http).
class Mixed {
  final DiskCache _cache = DiskCache();
  final NetClient _net = NetClient();
  String? _last;

  void store(String key, String value) {
    _cache.put(key, value);
  }

  String? load(String key) => _cache.get(key);

  Future<void> fetch(String path) async {
    _last = await _net.get(path);
  }

  Future<void> ping() async {
    await http.get(Uri.parse(_last ?? ''));
  }
}

/// Every method meets on _cache → one group.
class Cohesive {
  final DiskCache _cache = DiskCache();
  NetClient? _net;

  void store(String key) {
    _cache.put(key, key);
  }

  Future<void> fetch(String path) async {
    _cache.put(path, await (_net ?? NetClient()).get(path));
  }
}

/// Disjoint fields, but both groups depend on the same file → not split by dependencies.
class SharedImport {
  final DiskCache _a = DiskCache();
  final DiskCache _b = DiskCache();

  void first() {
    _a.put('a', 'a');
  }

  void second() {
    _b.put('b', 'b');
  }
}

/// Two groups without any import (plain data) → not reported.
class PlainData {
  int _count = 0;
  String _name = '';

  void increment() {
    _count++;
  }

  void rename(String name) {
    _name = name;
  }
}

/// A getter and its setter are one property: still two groups (store/value vs. fetch).
class Property {
  final DiskCache _cache = DiskCache();
  final NetClient _net = NetClient();

  String? get value => _cache.get('v');
  set value(String? next) => _cache.put('v', next ?? '');

  Future<String> fetch() => _net.get('x');
}

/// Inherited members are not visible to the cohesion graph → unknown.
class SubMixed extends Mixed {
  final NetClient _other = NetClient();

  Future<String> other() => _other.get('o');
}

/// Test doubles are never judged.
class MockMixed {
  final DiskCache _cache = DiskCache();
  final NetClient _net = NetClient();

  void store() {
    _cache.put('k', 'v');
  }

  Future<String> fetch() => _net.get('x');
}

/// The second group uses only dart:core (Uri) → no dependency evidence, one qualifying group → not reported.
class CoreOnly {
  final DiskCache _cache = DiskCache();
  String _raw = '';

  void store() {
    _cache.put('k', 'v');
  }

  Uri parse() => Uri.parse(_raw);
}
