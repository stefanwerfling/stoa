import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {ModuleResolver} from '../src/analysis/ModuleResolution.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {EMPTY_PROJECT_CONFIG, loadProjectConfig, type ProjectConfig} from '../src/config/ProjectConfig.js';
import {buildModuleGraph} from '../src/model/ModuleGraph.js';
import {buildSymbolGraph, type SymbolEdge} from '../src/model/SymbolGraph.js';
import {buildTypeModel} from '../src/model/TypeModel.js';
import {analyze} from '../src/Pipeline.js';
import type {Fact} from '../src/Types.js';

// Semantic consolidation, phase 2: the SymbolGraph as the ONE ES-module name
// resolver — `external` status, re-export chains (`deps.reexport`), and the
// TypeModel resolving TS types through it. Driven by the REAL TS adapter on
// test/fixtures/symbolgraph/reexport, so fact ranges and values are the
// adapter's, not hand-made.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const project = join(here, 'fixtures', 'symbolgraph', 'reexport');

const analyzeFixture = (cacheDir?: string) =>
    analyze({rootPath: project, knowledgeDir: join(root, 'knowledge', 'marcus'), ruleSetDir: join(root, 'rules', 'default'), config: DEFAULT_CONFIG, ...(cacheDir !== undefined ? {cacheDir} : {})});
const {facts} = analyzeFixture();
const files = new Set(facts.map((fact) => fact.subject.file));
const graphsOf = (input: readonly Fact[]) => {
    const moduleGraph = buildModuleGraph(input, files, new ModuleResolver(loadProjectConfig(project)));
    return {moduleGraph, symbolGraph: buildSymbolGraph(input, moduleGraph)};
};
const {moduleGraph, symbolGraph} = graphsOf(facts);
const rel = (path: string): string => path.slice(project.length + 1);
const edge = (name: string): SymbolEdge => {
    const found = symbolGraph.imports.find((candidate) => rel(candidate.fromFile) === 'consumer.ts' && candidate.importedName === name);
    assert.ok(found !== undefined, name);
    return found;
};
const brief = (name: string): string => {
    const found = edge(name);
    return `${found.status}${found.unresolvedReason !== undefined ? `(${found.unresolvedReason})` : ''} ${found.definitions.map((definition) => `${rel(definition.file)}#${definition.name}`).join(',')} via ${found.via.map((hop) => `${rel(hop.file)}>${hop.specifier}`).join(' ')}`;
};

test('deps.reexport facts: named (incl. alias, default as, type-only), star and namespace forms, from the real adapter', () => {
    const values = facts.filter((fact) => fact.kind === 'deps.reexport').map((fact) => `${rel(fact.subject.file)} ${JSON.stringify(fact.value)}`);
    assert.ok(values.includes('models/index.ts {"module":"./Account.js","name":"default","exportedAs":"Account","kind":"named","isTypeOnly":false}'));
    assert.ok(values.includes('models/index.ts {"module":"./User.js","name":"User","exportedAs":"Person","kind":"named","isTypeOnly":false}'));
    assert.ok(values.includes('models/index.ts {"module":"./User.js","name":"*","exportedAs":"*","kind":"star","isTypeOnly":false}'));
    assert.ok(values.includes('barrel.ts {"module":"./models/index.js","name":"*","exportedAs":"models","kind":"namespace","isTypeOnly":false}'));
    assert.ok(values.includes('types.ts {"module":"./models/User.js","name":"User","exportedAs":"UserType","kind":"named","isTypeOnly":true}'));
});

test('a named re-export has exactly the range of the deps.export the same specifier produces (local vs re-exported is decidable); deps.export itself is unchanged', () => {
    const reexport = facts.find((fact) => fact.kind === 'deps.reexport' && (fact.value as {exportedAs?: string}).exportedAs === 'Person');
    const exported = facts.find((fact) => fact.kind === 'deps.export' && fact.value === 'Person');
    assert.deepEqual(reexport?.subject.range, exported?.subject.range);
    assert.equal(facts.filter((fact) => fact.kind === 'deps.export' && rel(fact.subject.file) === 'barrel.ts').length, 0, '`export *` / `export * as` still emit no deps.export');
});

test('re-export chains: export * → named, `default as`, `X as Y`, `export * as ns`, type-only — resolved to the DEFINING file with every hop', () => {
    assert.equal(brief('User'), 'resolved models/User.ts#User via barrel.ts>./models/index.js models/index.ts>./User.js');
    assert.equal(brief('Person'), 'resolved models/User.ts#User via barrel.ts>./models/index.js models/index.ts>./User.js');
    assert.equal(brief('Account'), 'resolved models/Account.ts#default via barrel.ts>./models/index.js models/index.ts>./Account.js');
    assert.equal(brief('models'), 'resolved models/index.ts#* via barrel.ts>./models/index.js');
    assert.equal(brief('UserType'), 'resolved models/User.ts#User via types.ts>./models/User.js');
});

test('never an arbitrary pick: two `export *` with different definitions are ambiguous (both kept); `export *` never provides default', () => {
    assert.equal(brief('Dup'), 'ambiguous conflict/x.ts#Dup,conflict/y.ts#Dup via ');
    assert.equal(brief('default'), 'unresolved(export)  via ');
});

test('a re-export cycle is detected and bounded (unresolved: cycle), a missing module is unresolved (module), a package hop is external', () => {
    assert.equal(brief('Nothing'), 'unresolved(cycle)  via ');
    assert.equal(brief('Gone'), 'unresolved(module)  via missing.ts>./nope.js');
    assert.equal(brief('Thing'), 'external  via ext.ts>some-lib');
    assert.equal(brief('Other'), 'external  via ext.ts>other-lib', 'not in any analyzed module: it can only come from the one `export *` into a package');
});

test('TypeModel resolves TS types THROUGH the SymbolGraph: barrels, aliases, default-as, `ns.X` via a named `export * as`, ambiguous and external kept', () => {
    const model = buildTypeModel(facts, files, undefined, moduleGraph, symbolGraph);
    const supers = model.types
        .filter((node) => rel(node.file) === 'consumer.ts')
        .map((node) => `${node.name} ${node.supertypes.map((s) => `${s.status} ${s.target !== null ? rel(s.target) : (s.origin ?? '')} ${s.candidates.map(rel).join(',')}`.trim()).join('')}`);
    assert.deepEqual(supers, [
        'C1 project models/User.ts#User',
        'C2 project models/User.ts#User',
        'C3 project models/Account.ts#Account',
        'C4 project models/User.ts#User',
        'C5 ambiguous  conflict/x.ts#Dup,conflict/y.ts#Dup',
        'C6 external some-lib',
        'C7 unresolved',
        'C8 unresolved',
        'C9 external other-lib'
    ]);
});

test('deterministic: the symbol graph (re-exports included) is byte-identical regardless of fact order', () => {
    const reversed = graphsOf([...facts].reverse()).symbolGraph;
    assert.equal(JSON.stringify(reversed.imports), JSON.stringify(symbolGraph.imports));
    assert.equal(JSON.stringify(reversed.resolveExport(join(project, 'barrel.ts'), 'Account')), JSON.stringify(symbolGraph.resolveExport(join(project, 'barrel.ts'), 'Account')));
});

test('FactCache: a cache hit yields identical deps.reexport facts and the identical symbol graph', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'stoa-reexport-cache-'));
    try {
        analyzeFixture(cacheDir);
        const second = analyzeFixture(cacheDir);
        assert.ok((second.report.coverage.cacheHits ?? 0) > 0, 'second run served from the cache');
        const pick = (input: readonly Fact[]): string => JSON.stringify(input.filter((fact) => fact.kind === 'deps.reexport'));
        assert.equal(pick(second.facts), pick(facts));
        assert.equal(JSON.stringify(graphsOf(second.facts).symbolGraph.imports), JSON.stringify(symbolGraph.imports));
    } finally {
        rmSync(cacheDir, {recursive: true, force: true});
    }
});

test('ModuleGraph: re-exports are edges/unresolved entries with origin deps.reexport; unresolved TS entries carry `external`', () => {
    const reexportEdges = moduleGraph.edges.filter((entry) => entry.origin === 'deps.reexport').map((entry) => `${rel(entry.from)}>${rel(entry.to)}`);
    assert.ok(reexportEdges.includes('barrel.ts>models/index.ts') && reexportEdges.includes('cycle/a.ts>cycle/b.ts'));
    const unresolved = moduleGraph.unresolved.map((entry) => `${rel(entry.from)} ${entry.specifier} ${entry.origin ?? 'deps.import'} external=${String(entry.external)}`);
    assert.ok(unresolved.includes('ext.ts some-lib deps.reexport external=true'));
    assert.ok(unresolved.includes('missing.ts ./nope.js deps.reexport external=false'));
});

test('ModuleResolver.isExternal: only a bare specifier no configured mechanism claims is a package', () => {
    const config = (extra: Partial<ProjectConfig>): ProjectConfig => ({...EMPTY_PROJECT_CONFIG, configDir: '/p', ...extra});
    const analyzed = new Set(['/p/src/util/x.ts']);
    const plain = new ModuleResolver(EMPTY_PROJECT_CONFIG);
    assert.equal(plain.isExternal('react', analyzed), true);
    assert.equal(plain.isExternal('@scope/pkg/sub', analyzed), true);
    assert.equal(plain.isExternal('node:fs', analyzed), true);
    for (const local of ['./x', '../x', '/abs/x', '#internal']) {
        assert.equal(plain.isExternal(local, analyzed), false, local);
    }
    assert.equal(new ModuleResolver(config({paths: {'@app/*': ['src/*']}, pathsBasePath: '/p'})).isExternal('@app/missing', analyzed), false, 'a paths alias that did not resolve is a project reference');
    assert.equal(new ModuleResolver(config({packageName: 'mine'})).isExternal('mine/sub', analyzed), false, 'the own package');
    assert.equal(new ModuleResolver(config({baseUrl: '/p/src'})).isExternal('util/missing', analyzed), false, 'an analyzed directory below baseUrl');
    assert.equal(new ModuleResolver(config({baseUrl: '/p/src'})).isExternal('lodash', analyzed), true);
});
