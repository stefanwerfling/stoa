class Bird {
  void fly() {
    print('flap');
  }
}

// LSP: refuses a concrete inherited behaviour
class Penguin extends Bird {
  @override
  void fly() => throw UnsupportedError('cannot fly');
}

// negative: another exception is not "unsupported"
class Tired extends Bird {
  @override
  void fly() => throw StateError('tired');
}

// negative: a test double
class MockBird extends Bird {
  @override
  void fly() => throw UnimplementedError();
}
