import 'package:flutter/material.dart';
import 'package:flutter/material.dart' as m;

Widget values(bool flag, double h) => Column(children: [
      ListView(
        shrinkWrap: true,
        primary: false,
        physics: NeverScrollableScrollPhysics(),
        itemExtent: 48.0,
        cacheExtent: -1.5,
        semanticChildCount: 3,
        restorationId: 'list',
        controller: null,
        scrollDirection: m.Axis.horizontal,
        clipBehavior: flag ? Clip.none : Clip.hardEdge,
        key: widget.key,
        children: [],
      ),
      Text('Hi $name', semanticsLabel: 'it\'s', textScaleFactor: 0xFF, maxLines: (2)),
      SizedBox(width: 100, height: double.infinity, child: Text('x')),
      SizedBox(height: h, child: Text('y')),
      ConstrainedBox(constraints: const BoxConstraints(maxHeight: 200, minWidth: 0.5), child: Text('z')),
      ConstrainedBox(constraints: BoxConstraints.tightFor(width: m.MediaQuery.of(context).size.width), child: Text('w')),
      Padding(padding: EdgeInsets.all(8), child: Text('p')),
      IconButton(onPressed: () {}, icon: Icon(Icons.add)),
    ]);
