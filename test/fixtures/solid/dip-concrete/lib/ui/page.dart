import 'package:flutter/material.dart';
import 'package:get_it/get_it.dart';
import 'package:dipc_app/data/api.dart';
import '../data/api.dart' as data;
import '../data/repo.dart';
import '../model.dart';
import '../state/app_state.dart';

class ApiPage extends StatefulWidget {
  const ApiPage({super.key});

  @override
  State<ApiPage> createState() => _ApiPageState();
}

class _ApiPageState extends State<ApiPage> {
  // creates the concrete class: reported (one finding with every site)
  final Api api = Api();
  final data.Api other = data.Api();

  void refresh() {
    Api.instance.load();
    print(Api.avatarUrl('1'));
    print(Api.base);
    // not a declared constructor or static method: unknown, not a site
    Api.mystery();
  }

  @override
  Widget build(BuildContext context) => const Placeholder();
}

class CleanPage extends StatelessWidget {
  const CleanPage({super.key});

  void wire() {
    // an abstraction (factory of an abstract class): fine
    Repo();
    // a model without data access: fine
    Item('a');
    // a state holder: fine (user decision, as in E6a)
    AppState();
    // DI lookup: unknown
    GetIt.I.get<Api>();
  }

  @override
  Widget build(BuildContext context) => const Placeholder();
}
