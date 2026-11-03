import 'package:flutter/material.dart';

class RootsPage extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final loc = AppLocalizations.of(context);
    final paint = Paint();
    final label = Text('kept as a reference where it is used');
    Navigator.of(context);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('saved')));
    return Column(children: [
      label,
      BottomNavigationBarItem(icon: Icon(Icons.home), label: 'Home'),
      Wrap(children: wide ? [Text('a'), Text('b')] : [Text('c')]),
    ]);
  }

  Widget? _icon() => Icon(Icons.star);
}
