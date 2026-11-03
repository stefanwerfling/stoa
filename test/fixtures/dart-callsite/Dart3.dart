// Dart 3 syntax tree-sitter-dart 1.0.0 cannot parse: the file still yields a
// tree (and facts), but file.parseErrors makes the recovery visible.
String label(int rank) => switch (rank) {
      1 => 'gold',
      _ => 'other',
    };
