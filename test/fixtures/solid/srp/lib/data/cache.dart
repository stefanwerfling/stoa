class DiskCache {
  final Map<String, String> _entries = {};
  void put(String key, String value) => _entries[key] = value;
  String? get(String key) => _entries[key];
}
