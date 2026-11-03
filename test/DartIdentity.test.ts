import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import {loadDartPackages} from '../src/analysis/dart/DartPackages.js';
import {FLUTTER_CATALOG, flutterAwareIndex, flutterLibraries} from '../src/analysis/dart/FlutterCatalog.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {buildFlutterWidgetGraph, type FlutterWidgetGraph} from '../src/model/FlutterWidgetGraph.js';
import {analyze} from '../src/Pipeline.js';
import type {Fact, Finding} from '../src/Types.js';

// Flutter quality track, Phase B: identity resolution (DartLibraryIndex +
// Flutter catalog) — resolved / ambiguous / unresolved, and rules that never
// treat an ambiguous or unresolved name as a Flutter widget.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const project = join(here, 'fixtures', 'dart-identity');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');

let facts: Fact[] = [];
let findings: Finding[] = [];

before(async () => {
    await initDart();
    const result = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    facts = result.facts;
    findings = result.report.findings.filter((finding) => finding.rule.id.includes('FLUTTER'));
});

const local = (file: string): string => file.slice(project.length + 1);

const brief = (list: readonly Finding[]): string[] =>
    list.map((finding) => `${finding.rule.id} ${local(finding.location.file)}:${finding.location.range.startLine}`).sort();

const projectGraph = (): FlutterWidgetGraph => {
    const dartFiles = [...new Set(facts.map((fact) => fact.subject.file))].filter((file) => file.endsWith('.dart')).sort();
    return buildFlutterWidgetGraph(facts, flutterAwareIndex(facts, loadDartPackages(dartFiles)));
};

// `file:line prefix.Name status origin` for every widget node of one file.
const resolutions = (graph: FlutterWidgetGraph, file: string): string[] =>
    graph.nodes
        .filter((node) => node.kind === 'widget' && local(node.file) === file && node.name !== 'Text' && node.name !== 'EdgeInsets')
        .map((node) => {
            const origin = node.resolution?.origin ?? null;
            const shown = origin === null ? '-' : origin.startsWith('file:') ? `file:${local(origin.slice('file:'.length))}` : origin;
            return `${node.range.startLine} ${node.prefix === null ? '' : `${node.prefix}.`}${node.name ?? '?'} ${node.resolution?.status ?? '-'} ${shown}`;
        });

const BASIC = 'package:flutter/src/widgets/basic.dart';

test('identity findings: only names resolved to a package:flutter declaration are reported', () => {
    assert.deepEqual(brief(findings), [
        'R-FLUTTER-PARENTDATA-MISUSE lib/flutter_import.dart:3',
        'R-FLUTTER-PARENTDATA-MISUSE lib/host_part.dart:4',
        'R-FLUTTER-PARENTDATA-MISUSE lib/prefixed.dart:6',
        'R-FLUTTER-PARENTDATA-MISUSE lib/show_hide.dart:7',
        'R-FLUTTER-PARENTDATA-MISUSE lib/via_barrel.dart:3',
        'R-FLUTTER-PARENTDATA-MISUSE lib/via_package_barrel.dart:5',
        'R-FLUTTER-PARENTDATA-MISUSE lib/via_package_only.dart:4',
        'R-FLUTTER-PARENTDATA-MISUSE lib/widgets_only.dart:5',
        'R-FLUTTER-PARENTDATA-MISUSE other/no_pubspec_sibling.dart:4',
        'R-FLUTTER-UNCANCELLED-SUBSCRIPTION lib/lifecycle_barrel.dart:18',
        'R-FLUTTER-UNDISPOSED-CONTROLLER lib/lifecycle_barrel.dart:12'
    ]);
});

test('Flutter import: framework names resolve to their declaring library (material → widgets/basic.dart)', () => {
    assert.deepEqual(resolutions(projectGraph(), 'lib/flutter_import.dart'), [`3 Padding resolved ${BASIC}`, `3 Expanded resolved ${BASIC}`]);
    assert.deepEqual(resolutions(projectGraph(), 'other/no_pubspec_sibling.dart'), [`4 Padding resolved ${BASIC}`, `4 Expanded resolved ${BASIC}`]);
});

test('local same-name class: a declaration in the library shadows Flutter — resolved to the file, no finding', () => {
    assert.deepEqual(resolutions(projectGraph(), 'lib/local_shadow.dart'), ['11 Padding resolved file:lib/local_shadow.dart', `11 Expanded resolved ${BASIC}`]);
});

test('multiple same-name imports: Flutter and an own widget both provide Padding → ambiguous, no finding', () => {
    const graph = projectGraph();
    assert.deepEqual(resolutions(graph, 'lib/two_imports.dart'), ['5 Padding ambiguous -', `5 Expanded resolved ${BASIC}`]);
    const padding = graph.nodes.find((node) => local(node.file) === 'lib/two_imports.dart' && node.name === 'Padding');
    assert.deepEqual(padding?.resolution?.origins.map((origin) => (origin.startsWith('file:') ? local(origin.slice(5)) : origin)), ['lib/src/own_widgets.dart', BASIC]);
});

test('prefixed imports / aliases: m.Padding is Flutter\'s, the unprefixed Padding is the project\'s own', () => {
    assert.deepEqual(resolutions(projectGraph(), 'lib/prefixed.dart'), [
        `5 m.Column resolved ${BASIC}`,
        `6 m.Padding resolved ${BASIC}`,
        `6 m.Expanded resolved ${BASIC}`,
        '7 Padding resolved file:lib/src/own_widgets.dart',
        `7 m.Expanded resolved ${BASIC}`
    ]);
});

test('show / hide: a name outside the show list is unresolved; a show-listed prefixed import resolves', () => {
    assert.deepEqual(resolutions(projectGraph(), 'lib/show_hide.dart'), [`5 Padding resolved ${BASIC}`, '5 Expanded unresolved -', `7 Padding resolved ${BASIC}`, `7 w.Expanded resolved ${BASIC}`]);
});

test('barrels / re-exports: relative and package: barrels re-exporting Material resolve; the same declaration twice is ONE origin', () => {
    const graph = projectGraph();
    assert.deepEqual(resolutions(graph, 'lib/via_barrel.dart'), [`3 Padding resolved ${BASIC}`, `3 Expanded resolved ${BASIC}`]);
    assert.deepEqual(resolutions(graph, 'lib/via_package_only.dart'), [`4 Padding resolved ${BASIC}`, `4 Expanded resolved ${BASIC}`]);
    assert.deepEqual(resolutions(graph, 'lib/via_package_barrel.dart'), [`5 Padding resolved ${BASIC}`, `5 Expanded resolved ${BASIC}`]);
});

test('without the package map (focused graph build) the own package: barrel stays opaque — unresolved, never guessed', () => {
    const graph = buildFlutterWidgetGraph(facts);
    assert.deepEqual(resolutions(graph, 'lib/via_package_only.dart'), ['4 Padding unresolved -', '4 Expanded unresolved -']);
    const padding = graph.nodes.find((node) => local(node.file) === 'lib/via_package_only.dart' && node.name === 'Padding');
    assert.deepEqual(padding?.resolution?.possible, ['package:identity_app/ui.dart']);
});

test('Flutter libraries: widgets.dart does not export TextField (absent → unresolved); a part file uses its library\'s imports', () => {
    const graph = projectGraph();
    assert.deepEqual(resolutions(graph, 'lib/widgets_only.dart'), [`4 Row resolved ${BASIC}`, '4 TextField unresolved -', `5 Padding resolved ${BASIC}`, `5 Expanded resolved ${BASIC}`]);
    assert.deepEqual(resolutions(graph, 'lib/host_part.dart'), [`4 Padding resolved ${BASIC}`, `4 Expanded resolved ${BASIC}`]);
});

test('unknown: names only an uninspectable third-party library could provide are unresolved, with the import as possible', () => {
    const graph = projectGraph();
    assert.deepEqual(resolutions(graph, 'lib/unknown.dart'), ['4 Padding unresolved -', '4 Expanded unresolved -']);
    const padding = graph.nodes.find((node) => local(node.file) === 'lib/unknown.dart' && node.name === 'Padding');
    assert.deepEqual(padding?.resolution?.possible, ['package:some_ui_kit/some_ui_kit.dart']);
});

test('lifecycle: State/controller via a barrel and Timer via dart:async resolve; an ambiguous controller name is not reported', () => {
    const index = flutterAwareIndex(facts, loadDartPackages([join(project, 'lib', 'lifecycle_barrel.dart')]));
    const barrel = join(project, 'lib', 'lifecycle_barrel.dart');
    assert.equal(index.resolve(barrel, 'State', null).origin, 'package:flutter/src/widgets/framework.dart');
    assert.equal(index.resolve(barrel, 'Timer', null).origin, 'dart:async');
    const ambiguous = index.resolve(join(project, 'lib', 'lifecycle_ambiguous.dart'), 'TextEditingController', null);
    assert.equal(ambiguous.status, 'ambiguous');
    assert.equal(findings.some((finding) => finding.location.file.endsWith('lifecycle_ambiguous.dart')), false);
});

test('Dart core types: the implicit dart:core import is not modelled — String is unresolved, never a Flutter name', () => {
    const index = flutterAwareIndex(facts);
    const resolution = index.resolve(join(project, 'lib', 'flutter_import.dart'), 'String', null);
    assert.equal(resolution.status, 'unresolved');
    assert.deepEqual(resolution.possible, ['package:flutter/material.dart']);
});

test('a11y extraction stays file-local: a TextField reached only through a project barrel is not claimed (documented limit)', () => {
    assert.equal(findings.some((finding) => finding.rule.id.startsWith('R-A11Y-FLUTTER-')), false);
});

test('determinism: the resolution of every widget node is independent of the fact order', () => {
    const forward = projectGraph().nodes.map((node) => JSON.stringify(node.resolution));
    const reversed = [...facts].reverse();
    const dartFiles = [...new Set(facts.map((fact) => fact.subject.file))].filter((file) => file.endsWith('.dart')).sort();
    const backward = buildFlutterWidgetGraph(reversed, flutterAwareIndex(reversed, loadDartPackages([...dartFiles].reverse()))).nodes.map((node) => JSON.stringify(node.resolution));
    assert.deepEqual(backward, forward);
});

test('catalog answers: exported → origin, provably absent, otherwise unknown', () => {
    assert.deepEqual(flutterLibraries('package:flutter/material.dart', 'Column'), {origin: BASIC});
    assert.deepEqual(flutterLibraries('package:flutter/cupertino.dart', 'Column'), {origin: BASIC});
    assert.equal(flutterLibraries('package:flutter/widgets.dart', 'TextField'), 'absent');
    assert.equal(flutterLibraries('package:flutter/cupertino.dart', 'Theme'), 'absent');
    assert.equal(flutterLibraries('package:flutter/material.dart', 'NotAFlutterName'), 'unknown');
    assert.equal(flutterLibraries('package:flutter/rendering.dart', 'Column'), 'unknown');
    assert.deepEqual(flutterLibraries('dart:async', 'Timer'), {origin: 'dart:async'});
});

test('catalog covers every framework name the Flutter rules and the a11y extractor look up', () => {
    const names = new Set<string>();
    for (const file of ['src/rules/project/FlutterLayoutRules.ts', 'src/rules/project/FlutterLifecycleRules.ts', 'src/analysis/dart/FlutterA11y.ts']) {
        const source = readFileSync(join(root, file), 'utf8').replace(/const KNOWN_MIXINS[\s\S]*?\]\);/, '');
        for (const block of source.match(/new Set\(\[[\s\S]*?\]\)|const (SINGLE_CHILD_BOXES|MULTI_CHILD_NON_FLEX) = \[[\s\S]*?\]/g) ?? []) {
            for (const match of block.matchAll(/'([A-Z][A-Za-z]+)'/g)) {
                names.add(match[1] as string);
            }
        }
    }
    assert.ok(names.size > 50);
    assert.deepEqual([...names].filter((name) => !(name in FLUTTER_CATALOG)), []);
});

const SDK = join(process.env.FLUTTER_ROOT ?? '/usr/bin/flutter', 'packages', 'flutter', 'lib');

test('catalog matches the local Flutter SDK (each origin declares its name)', {skip: existsSync(SDK) ? false : 'no Flutter SDK (set FLUTTER_ROOT)'}, () => {
    const missing: string[] = [];
    for (const [name, [origin]] of Object.entries(FLUTTER_CATALOG)) {
        const path = join(SDK, origin);
        const declared = existsSync(path) && new RegExp(`^(?:abstract |base |final |sealed |interface |mixin )*(?:class|enum|mixin) ${name}\\b`, 'm').test(readFileSync(path, 'utf8'));
        if (!declared) {
            missing.push(`${name} ← ${origin}`);
        }
    }
    assert.deepEqual(missing, []);
});
