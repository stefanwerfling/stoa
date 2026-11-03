import 'package:flutter/material.dart' as m;
import 'src/own_widgets.dart';

// m.Padding is Flutter's, the unprefixed Padding is the project's own.
m.Widget prefixed() => m.Column(children: [
      m.Padding(padding: m.EdgeInsets.zero, child: m.Expanded(child: m.Text('a'))),
      Padding(child: m.Expanded(child: m.Text('b'))),
    ]);
