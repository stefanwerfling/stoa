import 'package:http/http.dart' as http;

class Api {
  static final Api instance = Api._();

  Api._();

  static String avatarUrl(String id) => 'https://example.org/$id';

  Future<http.Response> load(String id) => http.get(Uri.parse(avatarUrl(id)));
}
