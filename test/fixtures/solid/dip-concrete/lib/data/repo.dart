import 'package:http/http.dart' as http;

abstract class Repo {
  factory Repo() = HttpRepo;
  Future<String> fetch();
}

class HttpRepo implements Repo {
  @override
  Future<String> fetch() async => (await http.get(Uri.parse('x'))).body;
}
