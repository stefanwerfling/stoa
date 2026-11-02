import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EMPTY_PROJECT_CONFIG} from '../src/config/ProjectConfig.js';
import {ModuleResolver} from '../src/analysis/ModuleResolution.js';
import {buildModuleGraph} from '../src/model/ModuleGraph.js';
import {buildSymbolGraph, type SymbolEdge} from '../src/model/SymbolGraph.js';
import type {Fact} from '../src/Types.js';

// Phase 1, step 1 — the fact-based cross-file SymbolGraph. Driven with
// synthetic `deps.import` / `deps.importName` / `deps.export` facts plus a
// ModuleGraph built from them, so the binding resolution (resolved /
// unresolved / ambiguous), evidence preservation and determinism are covered
// directly, independent of any adapter or AST.

const emptyResolver = new ModuleResolver(EMPTY_PROJECT_CONFIG);

const importFact = (from: string, module: string, line = 1, isTypeOnly = false): Fact => ({
    id: `fact:${from}:deps.import:${module}:${line}`,
    kind: 'deps.import',
    subject: {file: from, kindOf: 'import', range: {startLine: line, startCol: 0, endLine: line, endCol: 0}},
    value: {module, isTypeOnly},
    evidence: [{source: 'deps', detail: `import ${module}`}],
    certainty: 'syntactic',
    producedBy: {adapter: 'test', version: '0'}
});

const importNameFact = (from: string, module: string, name: string, kind: 'named' | 'default' | 'namespace', line = 1): Fact => ({
    id: `fact:${from}:deps.importName:${module}:${name}:${kind}:${line}`,
    kind: 'deps.importName',
    subject: {file: from, kindOf: 'import', range: {startLine: line, startCol: 0, endLine: line, endCol: 0}},
    value: {module, name, kind},
    evidence: [{source: 'deps', detail: `import ${name}`}],
    certainty: 'syntactic',
    producedBy: {adapter: 'test', version: '0'}
});

const exportFact = (file: string, name: string, line = 1): Fact => ({
    id: `fact:${file}:deps.export:${name}:${line}`,
    kind: 'deps.export',
    subject: {file, kindOf: 'module', symbol: name, range: {startLine: line, startCol: 0, endLine: line, endCol: 0}},
    value: name,
    evidence: [{source: 'deps', detail: `export ${name}`}],
    certainty: 'syntactic',
    producedBy: {adapter: 'test', version: '0'}
});

const build = (facts: Fact[], analyzed: Set<string>) => buildSymbolGraph(facts, buildModuleGraph(facts, analyzed, emptyResolver));
const edgeFor = (graph: {imports: readonly SymbolEdge[]}, name: string): SymbolEdge | undefined => graph.imports.find((e) => e.importedName === name);

test('named import with a matching export is resolved, citing both the import site and the export definition', () => {
    const analyzed = new Set(['/p/a.ts', '/p/b.ts']);
    const facts = [importFact('/p/a.ts', './b', 1), importNameFact('/p/a.ts', './b', 'foo', 'named', 1), exportFact('/p/b.ts', 'foo', 42)];
    const edge = edgeFor(build(facts, analyzed), 'foo');
    assert.ok(edge !== undefined);
    assert.equal(edge.status, 'resolved');
    assert.equal(edge.toFile, '/p/b.ts');
    assert.equal(edge.importEvidence[0]?.factId, 'fact:/p/a.ts:deps.importName:./b:foo:named:1');
    assert.equal(edge.exportEvidence.length, 1);
    assert.equal(edge.exportEvidence[0]?.range.startLine, 42, 'export-definition evidence points at the real export site');
});

test('named import with NO matching export on the resolved target is unresolved (never a false binding)', () => {
    const analyzed = new Set(['/p/a.ts', '/p/b.ts']);
    const facts = [importFact('/p/a.ts', './b'), importNameFact('/p/a.ts', './b', 'missing', 'named'), exportFact('/p/b.ts', 'other')];
    const edge = edgeFor(build(facts, analyzed), 'missing');
    assert.equal(edge?.status, 'unresolved');
    assert.equal(edge?.toFile, null);
    assert.equal(edge?.exportEvidence.length, 0);
    assert.ok((edge?.importEvidence.length ?? 0) >= 1, 'the import site is still cited, so the unresolved case stays traceable');
});

test('default import matches a default export (name "default")', () => {
    const analyzed = new Set(['/p/a.ts', '/p/b.ts']);
    const facts = [importFact('/p/a.ts', './b'), importNameFact('/p/a.ts', './b', 'default', 'default'), exportFact('/p/b.ts', 'default')];
    const edge = edgeFor(build(facts, analyzed), 'default');
    assert.equal(edge?.status, 'resolved');
    assert.equal(edge?.kind, 'default');
    assert.equal(edge?.toFile, '/p/b.ts');
});

test('namespace import is resolved once the target file resolves, with no per-name export match', () => {
    const analyzed = new Set(['/p/a.ts', '/p/b.ts']);
    // target has SOME exports, but a namespace binding does not match a single name
    const facts = [importFact('/p/a.ts', './b'), importNameFact('/p/a.ts', './b', '*', 'namespace'), exportFact('/p/b.ts', 'x')];
    const edge = edgeFor(build(facts, analyzed), '*');
    assert.equal(edge?.status, 'resolved');
    assert.equal(edge?.kind, 'namespace');
    assert.equal(edge?.toFile, '/p/b.ts');
    assert.equal(edge?.exportEvidence.length, 0, 'whole-module binding cites no single export definition');
});

test('namespace import whose module does not resolve is unresolved', () => {
    const analyzed = new Set(['/p/a.ts']);
    const facts = [importFact('/p/a.ts', './gone'), importNameFact('/p/a.ts', './gone', '*', 'namespace')];
    const edge = edgeFor(build(facts, analyzed), '*');
    assert.equal(edge?.status, 'unresolved');
    assert.equal(edge?.toFile, null);
});

test('an import of an unresolvable (external) module is unresolved, with no assumption about the module', () => {
    const analyzed = new Set(['/p/a.ts']);
    const facts = [importFact('/p/a.ts', 'react'), importNameFact('/p/a.ts', 'react', 'useState', 'named')];
    const edge = edgeFor(build(facts, analyzed), 'useState');
    assert.equal(edge?.status, 'unresolved');
    assert.equal(edge?.toFile, null);
});

test('ambiguous: the resolved target declares the same export name twice', () => {
    const analyzed = new Set(['/p/a.ts', '/p/b.ts']);
    const facts = [importFact('/p/a.ts', './b'), importNameFact('/p/a.ts', './b', 'dup', 'named'), exportFact('/p/b.ts', 'dup', 3), exportFact('/p/b.ts', 'dup', 9)];
    const edge = edgeFor(build(facts, analyzed), 'dup');
    assert.equal(edge?.status, 'ambiguous');
    assert.equal(edge?.exportEvidence.length, 2, 'both candidate export definitions are retained as evidence');
});

test('multiple import declarations from the SAME file resolve independently, each to its own target', () => {
    const analyzed = new Set(['/p/a.ts', '/p/b.ts', '/p/c.ts']);
    const facts = [
        importFact('/p/a.ts', './b', 1),
        importNameFact('/p/a.ts', './b', 'fromB', 'named', 1),
        importFact('/p/a.ts', './c', 2),
        importNameFact('/p/a.ts', './c', 'fromC', 'named', 2),
        exportFact('/p/b.ts', 'fromB'),
        exportFact('/p/c.ts', 'fromC')
    ];
    const graph = build(facts, analyzed);
    assert.equal(edgeFor(graph, 'fromB')?.toFile, '/p/b.ts');
    assert.equal(edgeFor(graph, 'fromC')?.toFile, '/p/c.ts');
});

test('the SAME binding imported in two declarations collapses to one edge carrying BOTH import sites', () => {
    const analyzed = new Set(['/p/a.ts', '/p/b.ts']);
    const facts = [
        importFact('/p/a.ts', './b', 1),
        importNameFact('/p/a.ts', './b', 'foo', 'named', 1),
        importFact('/p/a.ts', './b', 5),
        importNameFact('/p/a.ts', './b', 'foo', 'named', 5),
        exportFact('/p/b.ts', 'foo')
    ];
    const matches = build(facts, analyzed).imports.filter((e) => e.importedName === 'foo');
    assert.equal(matches.length, 1, 'one binding, one edge');
    assert.equal(matches[0]?.importEvidence.length, 2, 'both import sites preserved');
    assert.deepEqual(matches[0]?.importEvidence.map((s) => s.range.startLine).sort((x, y) => x - y), [1, 5]);
});

test('deterministic: the graph is byte-identical regardless of fact order', () => {
    const analyzed = new Set(['/p/a.ts', '/p/b.ts', '/p/c.ts']);
    const factsA = [
        importFact('/p/a.ts', './b', 1), importNameFact('/p/a.ts', './b', 'foo', 'named', 1),
        importFact('/p/a.ts', './c', 2), importNameFact('/p/a.ts', './c', 'bar', 'named', 2),
        exportFact('/p/b.ts', 'foo'), exportFact('/p/c.ts', 'bar')
    ];
    const factsB = [...factsA].reverse();
    const g1 = build(factsA, analyzed);
    const g2 = build(factsB, analyzed);
    assert.equal(JSON.stringify(g1), JSON.stringify(g2), 'serialized symbol graph is identical across both orderings');
});

test('empty input yields an empty symbol graph, not an error', () => {
    const graph = build([], new Set());
    assert.deepEqual(graph.imports, []);
});
