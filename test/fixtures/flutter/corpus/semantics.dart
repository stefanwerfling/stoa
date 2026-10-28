import 'package:flutter/material.dart';

Widget build() {
  return Column(children: [
    // Named by an ancestor Semantics(label:) → not flagged, even without the
    // widget's own semanticLabel/tooltip/decoration label.
    Semantics(label: 'Company logo', child: Image.asset('logo.png')),
    Semantics(label: 'Close', child: IconButton(icon: Icon(Icons.close), onPressed: f)),
    Semantics(label: 'Full name', child: TextField()),
    // A Semantics without a label does not name the child → still flagged.
    Semantics(container: true, child: IconButton(icon: Icon(Icons.add), onPressed: f)),
  ]);
}
