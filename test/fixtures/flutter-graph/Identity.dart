import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart' as cupertino show CupertinoButton;
import 'package:my_app/widgets.dart' hide Card;

// A local class shadows Flutter's Image.
class Image extends StatelessWidget {}

Widget build() => Column(children: [
      Image(),
      cupertino.CupertinoButton(child: Text('ok')),
      cupertino.CupertinoSwitch(),
      ghost.Thing(),
      Card(),
    ]);
