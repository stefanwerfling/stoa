import 'package:flutter/material.dart';
import 'package:identity_app/ui.dart';

// The barrel and Material reach the SAME declaration: one origin, resolved.
Widget viaPackageBarrel() => Padding(padding: EdgeInsets.zero, child: Expanded(child: Text('a')));
