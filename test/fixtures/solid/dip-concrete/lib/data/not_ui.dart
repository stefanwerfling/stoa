import 'package:http/http.dart' as http;
import 'api.dart';

// not a UI class: creating Api here is the data layer's own business
class Sync {
  final Api api = Api();
  Future<void> run() async => http.get(Uri.parse('x'));
}
