import 'package:tm_app/barrel.dart' as bar;
import 'mix.dart';

class Mid extends bar.Base with Mix, Later {
  @override
  void a() {}
  void c() {}
}

class Leaf extends Mid {
  void d() {}
}
