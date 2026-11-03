import 'package:flutter/cupertino.dart';

// Cupertino exports widgets.dart: Padding/Expanded are Flutter's.
Widget cupertino() => Padding(padding: EdgeInsets.zero, child: Expanded(child: Text('a')));
