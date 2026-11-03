import 'package:http/http.dart' as http;

class Api {
  static final Api instance = Api._();
  static const String base = 'https://example.org';

  Api();
  Api._();

  static String avatarUrl(String id) => '$base/$id';

  Future<http.Response> load() => http.get(Uri.parse(base));
}
