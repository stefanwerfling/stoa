import 'package:flutter/material.dart' show Padding, Widget, EdgeInsets, Text;
import 'package:flutter/widgets.dart' as w show Expanded;

// Expanded is neither shown unprefixed nor declared: unresolved.
Widget shown() => Padding(padding: EdgeInsets.zero, child: Expanded(child: Text('a')));
// The show-listed prefixed Expanded is Flutter's.
Widget shownPrefixed() => Padding(padding: EdgeInsets.zero, child: w.Expanded(child: Text('b')));
