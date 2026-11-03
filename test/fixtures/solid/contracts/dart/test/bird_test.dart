import '../lib/bird.dart';
import '../lib/listener.dart';

// test paths are excluded
class Ostrich extends Bird {
  @override
  void fly() => throw UnsupportedError('test');
}

class Silent implements Listener {
  @override
  void onStart() {}
  @override
  void onStop() {}
  @override
  void onPause() {}
  @override
  void onResume() {}
}
