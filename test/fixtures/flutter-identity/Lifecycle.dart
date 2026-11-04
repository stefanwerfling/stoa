import 'package:flutter/material.dart';

// Several sites of one rule in one State class: each needs its own identity.
class Login extends StatefulWidget {
  const Login();
  @override
  State<Login> createState() => _LoginState();
}

class _LoginState extends State<Login> {
  final _url = TextEditingController(); // CONTROLLER 1
  final _user = TextEditingController(); // CONTROLLER 2
  String label = '';

  Future<void> signIn() async {
    await Future<void>.delayed(Duration.zero);
    setState(() => label = 'a'); // SETSTATE signIn#0
    await Future<void>.delayed(Duration.zero);
    setState(() => label = 'b'); // SETSTATE signIn#1
  }

  Future<void> reload() async {
    await Future<void>.delayed(Duration.zero);
    setState(() => label = 'c'); // SETSTATE reload#0
  }

  @override
  Widget build(BuildContext context) => Text(label);
}
