abstract class Listener {
  void onStart();
  void onStop();
  void onPause();
}

// ISP: two of three abstract members fulfilled only formally
class Partial implements Listener {
  @override
  void onStart() {
    print('start');
  }

  @override
  void onStop() {}

  @override
  void onPause() {}
}

// negative: one empty member
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
}
