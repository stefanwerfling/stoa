import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {KnowledgeBase} from '../src/knowledge/KnowledgeBase.js';
import {numberLiteral} from '../src/analysis/dart/DartValues.js';
import {argValueOf, buildFlutterWidgetGraph, type FlutterWidgetGraph, type WidgetNode} from '../src/model/FlutterWidgetGraph.js';
import {analyze, type AnalyzeOptions} from '../src/Pipeline.js';
import type {ProjectRule, ProjectRuleInput} from '../src/rules/ProjectRule.js';
import {RuleEngine} from '../src/rules/RuleEngine.js';
import {RuleSet} from '../src/rules/RuleSet.js';
import type {Fact} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixtures = join(here, 'fixtures', 'flutter-graph');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');

before(async () => {
    await initDart();
});

const run = (path: string, extra: Partial<AnalyzeOptions> = {}): {facts: Fact[]; graph: FlutterWidgetGraph} => {
    const result = analyze({rootPath: path, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, ...extra});
    return {facts: result.facts, graph: buildFlutterWidgetGraph(result.facts)};
};

// One line per node: path below the function, kind, name — the readable
// shape the assertions compare against.
const outline = (graph: FlutterWidgetGraph, owner?: string): string[] =>
    graph.nodes
        .filter((node) => owner === undefined || node.owner.startsWith(`${owner}@`))
        .map((node) => {
            const local = node.id.slice(node.id.lastIndexOf('#') + 1);
            const path = local.slice(local.indexOf('/') + 1);
            const name = node.name === null ? '' : ` ${node.prefix === null ? '' : `${node.prefix}|`}${node.name}${node.constructorName === null ? '' : `.${node.constructorName}`}`;
            return `${path} ${node.kind}${name}${node.status === 'known' ? '' : ` (${node.status})`}`;
        });

test('simple nesting: the Scaffold example becomes the exact parent/child structure with slots and order', () => {
    const {graph} = run(join(fixtures, 'Scaffold.dart'));
    assert.deepEqual(outline(graph), [
        'r0 widget Scaffold',
        'r0/appBar widget AppBar',
        'r0/appBar/title widget Text',
        'r0/body widget Column',
        'r0/body/children[0] widget Text',
        'r0/body/children[1] widget Row',
        'r0/body/children[1]/children[0] widget Icon',
        'r0/body/children[1]/children[1] widget Text'
    ]);
    const scaffold = graph.nodes.find((node) => node.name === 'Scaffold');
    assert.deepEqual(scaffold?.argNames, ['appBar', 'body']);
    assert.equal(scaffold?.owner.startsWith('build@'), true);
    assert.equal(scaffold?.range.startLine, 6);
    const row = graph.edges.find((edge) => edge.child.endsWith('/body/children[1]'));
    assert.deepEqual({kind: row?.kind, label: row?.label, index: row?.index}, {kind: 'children', label: 'children', index: 1});
    assert.equal(graph.edges.find((edge) => edge.child.endsWith('/appBar'))?.kind, 'slot');
    assert.equal(graph.roots.length, 1);
});

test('complex structures: conditional, repeat, spreads, builders, references, dynamic — never an empty or invented subtree', () => {
    const lines = outline(run(join(fixtures, 'Complex.dart')).graph, 'build');
    for (const expected of [
        'r0/children[0] conditional',
        'r0/children[0]/then widget Icon',
        'r0/children[0]/else widget Text',
        'r0/children[1] repeat',
        'r0/children[1]/body widget Text',
        'r0/children[2] spread (dynamic)',
        'r0/children[2]/element reference items.map (dynamic)',
        'r0/children[2]/element/builder builder',
        'r0/children[2]/element/builder/return[0] widget Text',
        'r0/children[3] spread',
        'r0/children[3]/element[0] widget Text',
        'r0/children[3]/element[1] widget Text',
        'r0/children[4] reference _header (dynamic)',
        'r0/children[5] reference widget.child (dynamic)',
        'r0/children[6] widget ListView.builder',
        'r0/children[6]/itemBuilder builder',
        'r0/children[6]/itemBuilder/return[0] widget Text',
        'r0/children[6]/itemBuilder/return[1] widget ListTile',
        'r0/children[7] widget ElevatedButton',
        'r0/children[7]/child widget Text',
        'r0/children[8] widget Padding',
        'r0/children[8]/child dynamic if_null_expression (dynamic)',
        'r0/children[9] widget Container'
    ]) {
        assert.ok(lines.includes(expected), `missing "${expected}" in:\n${lines.join('\n')}`);
    }
    assert.equal(lines.some((line) => line.startsWith('r0/children[9]/')), false, '`child: null` is an absence, not a node');
    assert.equal(lines.some((line) => line.includes('EdgeInsets')), false, 'a non-slot argument (padding:) is data, not a child');
});

test('callbacks are not children: a dialog built in onPressed is its own root', () => {
    const lines = outline(run(join(fixtures, 'Complex.dart')).graph, 'build');
    assert.ok(lines.includes('r1 widget AlertDialog'));
    assert.ok(lines.includes('r1/title widget Text'));
    assert.equal(lines.some((line) => line.startsWith('r0/') && line.includes('AlertDialog')), false);
});

test('a function declared to return Widget that returns a variable gets a reference root', () => {
    assert.deepEqual(outline(run(join(fixtures, 'Complex.dart')).graph, '_header'), ['r0 reference header (dynamic)']);
});

test('identity: local class verified, prefixed/shown import heuristic, excluded or undeclared names unresolved', () => {
    const {graph} = run(join(fixtures, 'Identity.dart'));
    const byName = (name: string): WidgetNode | undefined => graph.nodes.find((node) => node.name === name);
    assert.deepEqual(byName('Image')?.identity, {status: 'verified', source: 'local', candidates: []}, 'the local class shadows Flutter');
    assert.deepEqual(byName('CupertinoButton')?.identity, {status: 'heuristic', source: 'import', candidates: ['package:flutter/cupertino.dart']});
    assert.deepEqual(byName('CupertinoSwitch')?.identity?.status, 'unresolved', 'not in the prefixed import\'s show list');
    const ghost = graph.nodes.find((node) => node.name === 'ghost.Thing');
    assert.deepEqual({kind: ghost?.kind, identity: ghost?.identity}, {kind: 'reference', identity: null}, 'undeclared prefix: syntactically receiver.method(), so a placeholder — not guessed to be a widget');
    assert.deepEqual(byName('Card')?.identity?.candidates, ['package:flutter/material.dart'], 'hidden from my_app, so only material can provide it');
    assert.deepEqual(byName('Column')?.identity?.candidates, ['package:flutter/material.dart', 'package:my_app/widgets.dart'], 'two unprefixed imports could provide it — not guessed');
    assert.equal(graph.nodes.find((node) => node.kind !== 'widget')?.identity ?? null, null);
});

test('unparsed Dart 3 syntax: the gap is an explicit `unparsed` node, the parsable part stays intact', () => {
    const lines = outline(run(join(fixtures, 'Dart3.dart')).graph);
    assert.ok(lines.includes('r0 widget Column'));
    assert.ok(lines.includes('r0/children[0] widget Text'));
    assert.ok(lines.some((line) => line.startsWith('r0/children[1] unparsed (unparsed)')), lines.join('\n'));
    assert.equal(lines.some((line) => line.includes("'one'")), false);
});

test('deep trees: 40 nested levels are extracted completely, without recursion problems', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-deep-'));
    try {
        const depth = 40;
        writeFileSync(join(dir, 'Deep.dart'), `Widget build() => ${'Padding(child: '.repeat(depth)}Text('leaf')${')'.repeat(depth)};\n`);
        const {graph} = run(join(dir, 'Deep.dart'));
        assert.equal(graph.nodes.length, depth + 1);
        assert.equal(graph.edges.length, depth);
        assert.ok(graph.nodes.some((node) => node.name === 'Text' && node.id.split('/child').length === depth + 1));
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('determinism: same graph across runs and regardless of fact order', () => {
    const first = run(fixtures);
    assert.equal(JSON.stringify(run(fixtures).graph), JSON.stringify(first.graph));
    assert.equal(JSON.stringify(buildFlutterWidgetGraph([...first.facts].reverse())), JSON.stringify(first.graph));
});

test('FactCache: a cache hit (no re-parse) yields the identical graph', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'stoa-wg-cache-'));
    try {
        const cold = run(fixtures, {cacheDir});
        const warm = analyze({rootPath: fixtures, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, cacheDir});
        assert.ok((warm.report.coverage.cacheHits ?? 0) > 0, 'second run is served from the cache');
        assert.equal(JSON.stringify(buildFlutterWidgetGraph(warm.facts)), JSON.stringify(cold.graph));
    } finally {
        rmSync(cacheDir, {recursive: true, force: true});
    }
});

test('evidence: every node points at an existing ui.flutterWidgetTree fact and lies within its function', () => {
    const {facts, graph} = run(fixtures);
    const byId = new Map(facts.map((fact) => [fact.id, fact]));
    assert.ok(graph.nodes.length > 0);
    for (const node of graph.nodes) {
        const fact = byId.get(node.factId);
        assert.equal(fact?.kind, 'ui.flutterWidgetTree', node.id);
        assert.ok(fact !== undefined && node.range.startLine >= fact.subject.range.startLine && node.range.endLine <= fact.subject.range.endLine, node.id);
        assert.equal(node.file, fact?.subject.file);
    }
    for (const edge of graph.edges) {
        assert.ok(graph.nodes.some((node) => node.id === edge.parent) && graph.nodes.some((node) => node.id === edge.child), `${edge.parent} -> ${edge.child}`);
    }
});

test('no AST leaks: the graph and the tree facts are plain JSON data', () => {
    const {facts, graph} = run(fixtures);
    assert.deepEqual(JSON.parse(JSON.stringify(graph)), graph);
    for (const fact of facts.filter((candidate) => candidate.kind === 'ui.flutterWidgetTree')) {
        assert.deepEqual(JSON.parse(JSON.stringify(fact.value)), fact.value);
    }
});

test('project rules receive the graph via ProjectRuleInput; without Flutter code it is omitted', () => {
    const seen: (FlutterWidgetGraph | undefined)[] = [];
    const spy: ProjectRule = {
        id: 'SPY',
        version: '0',
        evaluate: (input: ProjectRuleInput) => {
            seen.push(input.flutterWidgetGraph);
            return [];
        }
    };
    const engine = new RuleEngine(KnowledgeBase.loadFromDirectory(knowledgeDir, DEFAULT_CONFIG.knowledgeBase), RuleSet.loadFromDirectory(ruleSetDir, DEFAULT_CONFIG.ruleSet), 'en', [spy]);
    const {facts, graph} = run(join(fixtures, 'Scaffold.dart'));
    engine.evaluate(facts, undefined, undefined, graph);
    engine.evaluate(facts);
    assert.equal(seen[0], graph);
    assert.equal(seen[1], undefined);
});

test('graph findings on the graph fixtures: only the real layout errors (ListView.builder in a Column; a horizontal shrink-wrapped ListView in a Column)', () => {
    const findings = analyze({rootPath: fixtures, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings;
    const graphFindings = findings.filter((finding) => finding.observation.evidence.some((evidence) => evidence.fact === 'ui.flutterWidgetTree'));
    assert.deepEqual(
        graphFindings.map((finding) => `${finding.rule.id} ${finding.location.file.slice(finding.location.file.lastIndexOf('/') + 1)}:${finding.location.range.startLine}`),
        ['R-FLUTTER-UNBOUNDED-SCROLLABLE Complex.dart:13', 'R-FLUTTER-UNBOUNDED-SCROLLABLE Values.dart:5']
    );
});

test('roots: only structural calls (slot/builder) or Widget-function returns; slot-less calls outside a tree are not structure', () => {
    const {graph} = run(join(fixtures, 'Roots.dart'));
    const build = outline(graph, 'build');
    assert.equal(build.some((line) => /AppLocalizations|Paint|Navigator|ScaffoldMessenger/.test(line)), false, build.join('\n'));
    assert.equal(build.some((line) => line.includes("Text") && line.startsWith('r') && !line.includes('/')), false, 'a slot-less Text in a local variable is no root');
    assert.ok(build.includes('r0/children[0] reference label (dynamic)'), 'its use site is the placeholder');
    assert.ok(build.some((line) => / widget SnackBar$/.test(line)), 'SnackBar(content: …) passed to a method call is a root (has a slot)');
    assert.deepEqual(outline(graph, '_icon'), ['r0 widget Icon'], 'a slot-less widget returned from a Widget? function is a root');
});

test('literals in a slot are provably not widgets (no node); list values in branches fan out', () => {
    const build = outline(run(join(fixtures, 'Roots.dart')).graph, 'build');
    const item = build.find((line) => line.endsWith('widget BottomNavigationBarItem'));
    assert.ok(item !== undefined);
    const itemPath = item.split(' ')[0] as string;
    assert.deepEqual(build.filter((line) => line.startsWith(`${itemPath}/`)), [`${itemPath}/icon widget Icon`], "label: 'Home' adds no node");
    assert.equal(build.some((line) => line.includes(' dynamic string_literal')), false);
    // `children: wide ? [...] : [...]` is ONE expression in the slot (no index).
    for (const expected of ['r0/children[2]/children conditional', 'r0/children[2]/children/then list', 'r0/children[2]/children/then/element[0] widget Text', 'r0/children[2]/children/then/element[1] widget Text', 'r0/children[2]/children/else/element[0] widget Text']) {
        assert.ok(build.some((line) => line.includes(expected)), `missing ${expected} in\n${build.join('\n')}`);
    }
});

// Phase A: value semantics of widget arguments.
const valueGraph = (): FlutterWidgetGraph => run(join(fixtures, 'Values.dart')).graph;
const widgetNamed = (graph: FlutterWidgetGraph, name: string, nth = 0): WidgetNode => {
    const found = graph.nodes.filter((node) => node.kind === 'widget' && node.name === name)[nth];
    assert.ok(found !== undefined, `${name}#${nth} present`);
    return found;
};

test('values: typed literals (bool, null, int, double incl. negative, string) are recognised, unknowns stay unknown', () => {
    const list = widgetNamed(valueGraph(), 'ListView');
    assert.deepEqual(argValueOf(list, 'shrinkWrap'), {kind: 'bool', value: true});
    assert.deepEqual(argValueOf(list, 'primary'), {kind: 'bool', value: false});
    assert.deepEqual(argValueOf(list, 'itemExtent'), {kind: 'double', value: 48});
    assert.deepEqual(argValueOf(list, 'cacheExtent'), {kind: 'double', value: -1.5});
    assert.deepEqual(argValueOf(list, 'semanticChildCount'), {kind: 'int', value: 3});
    assert.deepEqual(argValueOf(list, 'restorationId'), {kind: 'string', value: 'list'});
    assert.deepEqual(argValueOf(list, 'controller'), {kind: 'null'});
    assert.deepEqual(argValueOf(list, 'physics'), {kind: 'object', type: 'NeverScrollableScrollPhysics', constructorName: null, args: []});
    assert.deepEqual(argValueOf(list, 'scrollDirection'), {kind: 'member', target: 'Axis', name: 'horizontal'}, 'declared prefix m. is dropped');
    assert.deepEqual(argValueOf(list, 'clipBehavior'), {kind: 'expression'}, 'a conditional is not evaluated');
    assert.deepEqual(argValueOf(list, 'key'), {kind: 'reference'}, 'a property access is unknown');
    assert.deepEqual(argValueOf(list, 'children'), {kind: 'widget'});
    assert.equal(argValueOf(list, 'reverse'), undefined, 'absent is not unknown');
    assert.equal(list.argValues.length, list.argNames.length);
});

test('values: strings only as plain literals; hex, parenthesised and closures', () => {
    const text = widgetNamed(valueGraph(), 'Text');
    assert.deepEqual(argValueOf(text, 'semanticsLabel'), {kind: 'string', value: null}, 'an escape keeps the type, not the content');
    assert.deepEqual(argValueOf(text, 'textScaleFactor'), {kind: 'int', value: 255});
    assert.deepEqual(argValueOf(text, 'maxLines'), {kind: 'int', value: 2});
    assert.deepEqual(argValueOf(widgetNamed(valueGraph(), 'IconButton'), 'onPressed'), {kind: 'closure'});
});

test('values: constraint groundwork — SizedBox extents, double.infinity, BoxConstraints one level deep', () => {
    const graph = valueGraph();
    const fixed = widgetNamed(graph, 'SizedBox', 0);
    assert.equal(numberLiteral(argValueOf(fixed, 'width')), 100);
    assert.equal(numberLiteral(argValueOf(fixed, 'height')), Number.POSITIVE_INFINITY);
    assert.equal(numberLiteral(argValueOf(widgetNamed(graph, 'SizedBox', 1), 'height')), null, 'a variable height is unknown');
    assert.deepEqual(argValueOf(widgetNamed(graph, 'ConstrainedBox', 0), 'constraints'), {
        kind: 'object',
        type: 'BoxConstraints',
        constructorName: null,
        args: [
            {name: 'maxHeight', value: {kind: 'int', value: 200}},
            {name: 'minWidth', value: {kind: 'double', value: 0.5}}
        ]
    });
    assert.deepEqual(argValueOf(widgetNamed(graph, 'ConstrainedBox', 1), 'constraints'), {
        kind: 'object',
        type: 'BoxConstraints',
        constructorName: 'tightFor',
        args: [{name: 'width', value: {kind: 'expression'}}]
    });
    assert.deepEqual(argValueOf(widgetNamed(graph, 'Padding'), 'padding'), {kind: 'object', type: 'EdgeInsets', constructorName: 'all', args: [{name: '#0', value: {kind: 'int', value: 8}}]});
});

test('values: deterministic, plain JSON in the fact, identical after a FactCache hit', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'stoa-values-cache-'));
    try {
        const path = join(fixtures, 'Values.dart');
        const cold = run(path, {cacheDir});
        const warm = analyze({rootPath: path, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, cacheDir});
        assert.ok((warm.report.coverage.cacheHits ?? 0) > 0);
        assert.equal(JSON.stringify(buildFlutterWidgetGraph(warm.facts)), JSON.stringify(cold.graph));
        assert.equal(JSON.stringify(run(path).graph), JSON.stringify(cold.graph));
        for (const fact of cold.facts.filter((candidate) => candidate.kind === 'ui.flutterWidgetTree')) {
            const value = fact.value as unknown as {v: number; nodes: unknown[][]};
            assert.equal(value.v, 2);
            assert.deepEqual(JSON.parse(JSON.stringify(value)), value, 'round-trips through JSON (no AST, no functions)');
            for (const node of value.nodes) {
                assert.equal((node[13] as unknown[]).length, node[3] === 'widget' ? (node[11] as unknown[]).length : 0, 'argValues aligned with argNames on widgets, empty elsewhere');
            }
        }
    } finally {
        rmSync(cacheDir, {recursive: true, force: true});
    }
});
