import 'package:http/http.dart' as http;

import 'service.dart';

abstract class Repo extends http.BaseClient with Logging implements Store {
  static final Repo instance = Repo._();
  final http.Client client;
  late int _count = 0;
  String? name;

  Repo(this.client, {required this.name, int x = 1}) : super();
  Repo._() : client = http.Client();
  factory Repo.make() => Repo._();

  Future<void> load();

  @override
  void close() {}

  @override
  int get count => _count;

  set count(int v) {
    _count = v;
  }

  void unsupported() => throw UnsupportedError('no');

  void unimpl() {
    throw UnimplementedError();
  }

  void notUnsupported() {
    throw StateError('x');
  }

  int work(int a, http.Response r) {
    final c = http.Client();
    final s = Service.instance.run();
    final local = 1;
    return _count + a + this._count + helper() + local;
  }

  int helper() => 1;
}

mixin Logging on Object {
  void log(String message) {}
}

class Store {}

enum Mode { a, b }
