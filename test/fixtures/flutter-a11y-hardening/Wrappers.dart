import 'package:flutter/material.dart';

Widget wrappers(BuildContext context) => Column(children: [
      Tooltip(message: 'Scan', child: IconButton(onPressed: null, icon: Icon(Icons.qr_code))), // named by Tooltip
      ExcludeSemantics(child: Image.asset('deco.png')), // hidden
      ExcludeSemantics(excluding: false, child: Image.asset('shown.png')), // FLAGGED: not excluded
      Tooltip(message: '', child: IconButton(onPressed: null, icon: Icon(Icons.add))), // FLAGGED: empty message
      Tooltip(message: 'Pic', child: Image.asset('t.png')), // FLAGGED: Tooltip names only IconButton
      MergeSemantics(child: Row(children: [IconButton(onPressed: null, icon: Icon(Icons.add)), Text('Add')])), // FLAGGED: MergeSemantics not resolved
      Semantics(label: 'Card', child: LayoutBuilder(builder: (c, box) => Image.asset('in-builder.png'))), // named through a builder
      Semantics(
        label: 'Open',
        child: GestureDetector(
          onTap: () => showDialog(context: context, builder: (_) => IconButton(onPressed: null, icon: Icon(Icons.close))), // FLAGGED: in a callback
          child: Text('Open'),
        ),
      ),
    ]);
