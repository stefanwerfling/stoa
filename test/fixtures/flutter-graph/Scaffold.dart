import 'package:flutter/material.dart';

class DashboardPage extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Dashboard'),
      ),
      body: Column(
        children: [
          Text('Willkommen'),
          Row(
            children: [
              Icon(Icons.home),
              Text('Startseite'),
            ],
          ),
        ],
      ),
    );
  }
}
