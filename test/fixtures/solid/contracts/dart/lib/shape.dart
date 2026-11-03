abstract class Shape {
  double area();

  void describe() {
    print('shape');
  }

  void reset() {}
}

class Square extends Shape {
  // abstract base member: not LSP
  @override
  double area() => throw UnimplementedError();

  // concrete base member, only throws: LSP
  @override
  void describe() => throw UnsupportedError('no description');

  // concrete (empty) base member, only throws: LSP
  @override
  void reset() {
    throw UnsupportedError('fixed');
  }
}
