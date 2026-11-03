import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import {DATA_ACCESS_CATALOG_VERSION, STATE_HOLDER_CATALOG_VERSION, dataAccessOf, packageOfUri} from '../src/analysis/dart/DataAccessCatalog.js';
import type {DartDirectiveValue} from '../src/analysis/dart/DartDeclarations.js';
import {loadDartPackages} from '../src/analysis/dart/DartPackages.js';
import {flutterAwareIndex} from '../src/analysis/dart/FlutterCatalog.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {buildLayerClassification, classificationOf, type LayerClassification} from '../src/model/LayerClassification.js';
import {analyze} from '../src/Pipeline.js';
import type {Fact} from '../src/Types.js';

// Flutter quality track E5a: layer classification without a configuration.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const project = join(here, 'fixtures', 'dart-layers');

let facts: Fact[] = [];

before(async () => {
    await initDart();
    facts = analyze({rootPath: project, knowledgeDir: join(root, 'knowledge', 'marcus'), ruleSetDir: join(root, 'rules', 'default'), config: DEFAULT_CONFIG}).facts;
});

const classify = (input: readonly Fact[]): LayerClassification => {
    const dartFiles = [...new Set(input.map((fact) => fact.subject.file))].filter((file) => file.endsWith('.dart')).sort();
    return buildLayerClassification(input, flutterAwareIndex(input, loadDartPackages(dartFiles)));
};

const local = (file: string): string => file.slice(project.length + 1);

test('E5a: roles per module — UI by resolved Flutter base (direct or via project classes), data access by catalog import, else unknown', () => {
    const classification = classify(facts);
    assert.equal(classification.catalogVersion, DATA_ACCESS_CATALOG_VERSION);
    assert.deepEqual(
        classification.modules.map((module) => `${local(module.file)}: ${module.roles.join('+') || 'unknown'}`),
        [
            'lib/cycle.dart: unknown',
            'lib/data/api.dart: data-access',
            'lib/data/files.dart: data-access',
            'lib/io_undecided.dart: unknown',
            'lib/other.dart: unknown',
            'lib/platform.dart: unknown',
            'lib/ui/base_page.dart: ui',
            'lib/ui/derived.dart: ui',
            'lib/ui/getx_page.dart: unknown',
            'lib/ui/host.dart: data-access+ui',
            'lib/ui/host_part.dart: data-access+ui',
            'lib/ui/mixed_page.dart: data-access+ui',
            'lib/ui/page.dart: ui',
            'lib/ui/shadow.dart: unknown'
        ]
    );
});

test('E5a: evidence stays with the file it is written in; the chain names the project classes in between', () => {
    const classification = classify(facts);
    const of = (file: string) => classificationOf(classification, join(project, file));
    assert.deepEqual(of('lib/ui/page.dart')?.ui.map((ui) => `${ui.name}:${ui.base}`), ['HomePage:StatelessWidget', 'Counter:StatefulWidget', '_CounterState:State']);
    assert.deepEqual(of('lib/ui/derived.dart')?.ui.map((ui) => `${ui.name}:${ui.base}:${ui.chain.join('>')}`), ['DerivedPage:StatelessWidget:BasePage']);
    assert.deepEqual(of('lib/ui/host_part.dart')?.ui.map((ui) => ui.name), ['PartWidget']);
    assert.deepEqual(of('lib/ui/host_part.dart')?.dataAccess, []);
    assert.deepEqual(of('lib/ui/host.dart')?.dataAccess.map((entry) => `${entry.package} ${entry.uri}`), ['http package:http/http.dart']);
    assert.deepEqual(of('lib/ui/host.dart')?.library, join(project, 'lib/ui/host.dart'));
    assert.deepEqual(of('lib/ui/host_part.dart')?.library, join(project, 'lib/ui/host.dart'));
    assert.deepEqual(of('lib/io_undecided.dart')?.undecided.map((entry) => entry.package), ['dart:io']);
    assert.deepEqual(of('lib/data/files.dart')?.dataAccess.map((entry) => entry.package), ['dart:io']);
    assert.equal(of('lib/ui/getx_page.dart')?.ui.length, 0, 'a base class of another package is never UI');
    assert.equal(of('lib/ui/shadow.dart')?.ui.length, 0, 'a project class named StatelessWidget is not Flutter\'s');
    assert.equal(of('lib/missing.dart'), undefined);
});

test('E5a: deterministic under reversed fact order', () => {
    assert.equal(JSON.stringify(classify([...facts].reverse())), JSON.stringify(classify(facts)));
});

test('E5a: dart:io counts only with a show of I/O names; packages outside the catalog never count', () => {
    const directive = (uri: string, show: string[] = [], kind: DartDirectiveValue['kind'] = 'import'): DartDirectiveValue => ({
        kind, uri, libraryName: null, prefix: null, deferred: false, show, hide: [], conditionalUris: []
    });
    assert.deepEqual(dataAccessOf(directive('package:dio/dio.dart')), {package: 'dio', status: 'data-access'});
    assert.deepEqual(dataAccessOf(directive('dart:io', ['Socket'])), {package: 'dart:io', status: 'data-access'});
    assert.equal(dataAccessOf(directive('dart:io', ['Platform', 'exit'])), null);
    assert.deepEqual(dataAccessOf(directive('dart:io')), {package: 'dart:io', status: 'undecided'});
    assert.equal(dataAccessOf(directive('package:provider/provider.dart')), null);
    assert.equal(dataAccessOf(directive('package:http/http.dart', [], 'export')), null, 'only imports count');
    assert.equal(packageOfUri('package:http/http.dart'), 'http');
    assert.equal(packageOfUri('dart:io'), null);
    assert.equal(packageOfUri('package:broken'), null);
});

test('E6a: state holders — a ChangeNotifier subclass or mixin and a GetxController are state holders; a project class named ChangeNotifier is not', async () => {
    const dipProject = join(here, 'fixtures', 'solid', 'dip-layer');
    const dipFacts = analyze({rootPath: dipProject, knowledgeDir: join(root, 'knowledge', 'marcus'), ruleSetDir: join(root, 'rules', 'default'), config: DEFAULT_CONFIG}).facts;
    const classification = classify(dipFacts);
    assert.equal(classification.stateHolderCatalogVersion, STATE_HOLDER_CATALOG_VERSION);
    const summary = (file: string): string => {
        const module = classificationOf(classification, join(dipProject, file));
        return `${module?.roles.join('+')} ${module?.stateHolders.map((holder) => `${holder.name}:${holder.base}`).join(',')}`;
    };
    assert.equal(summary('lib/state/app_state.dart'), 'data-access+state-holder AppState:ChangeNotifier (package:flutter/foundation.dart)');
    assert.equal(summary('lib/state/mixed_in.dart'), 'data-access+state-holder Favorites:ChangeNotifier (package:flutter/foundation.dart)');
    assert.equal(summary('lib/state/get_controller.dart'), 'data-access+state-holder SessionController:GetxController (package:get/get.dart)');
    assert.equal(summary('lib/state/fake_notifier.dart'), 'data-access ');
});
