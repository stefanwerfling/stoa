import 'package:flutter/material.dart';
import 'package:flutter/material.dart' as m;

// Call forms the 1.0.0 extractor missed: each one is unlabelled.
Widget forms() => Column(children: [
      const Image(image: AssetImage('a.png')), // image (const)
      new IconButton(onPressed: null, icon: Icon(Icons.add)), // iconButton (new)
      m.Image.asset('b.png'), // image (prefix)
      TextField(decoration: const InputDecoration(border: OutlineInputBorder())), // textField (const decoration, no label)
      TextField(decoration: const InputDecoration(labelText: 'Name')), // labelled: fine
    ]);
