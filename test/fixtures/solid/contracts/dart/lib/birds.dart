import 'package:other/other.dart';
import 'bird.dart';

// across files, with @override: LSP
class Penguin extends Bird {
  @override
  void fly() => throw UnsupportedError('cannot fly');
}

// without @override it still overrides: LSP
class Kiwi extends Bird {
  void fly() => throw UnsupportedError('cannot fly');
}

// implements a concrete project class: LSP
class Drone implements Bird {
  @override
  void fly() => throw UnimplementedError();

  @override
  void rest() {}
}

// another throw is not "unsupported": no finding
class Tired extends Bird {
  @override
  void fly() => throw StateError('tired');
}

// a test double is excluded by name
class MockBird extends Bird {
  @override
  void fly() => throw UnimplementedError();
}

// unresolved base: unknown, never judged
class Mystery extends Foreign {
  @override
  void fly() => throw UnsupportedError('?');
}

// a mixin on Bird refusing fly: LSP
mixin Grounded on Bird {
  @override
  void fly() => throw UnsupportedError('grounded');
}
