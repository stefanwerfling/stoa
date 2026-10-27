import 'dart:math';

// Actual nondeterministic calls — must be flagged.
int roll() {
  final rng = Random();
  return rng.nextInt(6);
}

DateTime stamp() {
  return DateTime.now();
}

// Mere mentions — a parameter named `now`, a variable named `Random`, a
// `DateTime` parameter type — with no nondeterministic call. Must NOT be flagged.
int pure(DateTime at, int now) {
  var Random = now + 1;
  return Random;
}
