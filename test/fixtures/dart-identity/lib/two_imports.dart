import 'package:flutter/material.dart';
import 'src/own_widgets.dart';

// Padding is provided by BOTH imports (different declarations): ambiguous.
Widget twice() => Padding(child: Expanded(child: Text('a')));
