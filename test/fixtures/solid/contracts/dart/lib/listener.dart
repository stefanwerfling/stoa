import 'package:other/other.dart';

abstract class Listener {
  void onStart();
  void onStop();
  void onPause();
  void onResume();
}

abstract class Hooks {
  void before() {}
  void after() {}
}

// two abstract members fulfilled empty: ISP
class Partial implements Listener {
  @override
  void onStart() {
    print('start');
  }

  @override
  void onStop() {}

  @override
  void onPause() {}

  @override
  void onResume() {
    print('resume');
  }
}

// only one empty: no finding
class Mostly implements Listener {
  @override
  void onStart() {
    print('start');
  }

  @override
  void onStop() {}

  @override
  void onPause() {
    print('pause');
  }

  @override
  void onResume() {
    print('resume');
  }
}

// extends an abstract class, two members only throw: ISP (abstract base members, so no LSP)
class Refuses extends Listener {
  @override
  void onStart() => throw UnimplementedError();

  @override
  void onStop() => throw UnsupportedError('no');

  @override
  void onPause() {
    print('pause');
  }

  @override
  void onResume() {
    print('resume');
  }
}

// concrete hooks overridden empty: not ISP (nothing was forced on it)
class Quiet extends Hooks {
  @override
  void before() {}

  @override
  void after() {}
}

// a stub is excluded by name
class StubListener implements Listener {
  @override
  void onStart() {}
  @override
  void onStop() {}
  @override
  void onPause() {}
  @override
  void onResume() {}
}

// a package interface: unknown, never judged
class Adapter implements ForeignListener {
  void a() {}
  void b() {}
}
