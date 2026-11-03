import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import type {Node} from 'web-tree-sitter';
import {DartAdapter, initDart} from '../src/analysis/DartAdapter.js';
import {asConstructor, callSites, importPrefixes, parseErrorCount} from '../src/analysis/dart/DartCallSite.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixtures = join(here, 'fixtures', 'dart-callsite');

before(async () => {
    await initDart();
});

// Parses `content` and hands the root to `use`, always releasing the tree
// afterwards — the same lifecycle the pipeline enforces.
const withTree = <T>(content: string, use: (root: Node) => T): T => {
    const parsed = new DartAdapter().parse({path: 'x.dart', content});
    assert.ok(parsed.ok);
    try {
        return use(parsed.handle as Node);
    } finally {
        parsed.release?.();
    }
};

const summarize = (content: string): string[] =>
    withTree(content, (tree) =>
        callSites(tree).map((site) => {
            const prefix = site.prefix === null ? '' : `${site.prefix}|`;
            const types = site.typeArguments.length === 0 ? '' : `<${site.typeArguments.join(',')}>`;
            return `${site.form}:${prefix}${site.names.join('.')}${types}@${site.range.startLine}`;
        })
    );

test('DartCallSite: bare, const, new, named-constructor, prefixed and generic sites share one shape', () => {
    const sites = summarize(readFileSync(join(fixtures, 'CallSites.dart'), 'utf8'));
    for (const expected of [
        'call:Column@6',
        'call:Text@7',
        'const:Text@8',
        'new:Row@9',
        'call:Image.asset@10',
        'const:EdgeInsets.all@11',
        'call:w|Text@12',
        'const:w|Text@13',
        'call:ValueListenableBuilder<int>@14',
        'call:Icon@15',
        'const:SizedBox@15',
        'call:items.map@16',
        'call:Image.asset@17'
    ]) {
        assert.ok(sites.includes(expected), `missing ${expected} in ${sites.join(' ')}`);
    }
    // Builder / map closures are traversed: their returned Text(...) are sites too.
    assert.equal(sites.filter((site) => site === 'call:Text@14').length, 1);
    assert.equal(sites.filter((site) => site === 'call:Text@16').length, 1);
});

test('DartCallSite: only the FIRST invocation of a chain is a site; member names and labels are not', () => {
    const sites = summarize(readFileSync(join(fixtures, 'CallSites.dart'), 'utf8'));
    assert.equal(sites.some((site) => site.includes('copyWith')), false, 'Image.asset(...).copyWith() is one site: Image.asset');
    assert.equal(sites.some((site) => /:(asset|children|valueListenable|builder)@/.test(site)), false);
});

test('DartCallSite: sites come back in source order and deterministically', () => {
    const content = readFileSync(join(fixtures, 'CallSites.dart'), 'utf8');
    const first = summarize(content);
    assert.deepEqual(summarize(content), first);
    const lines = first.map((site) => Number(site.split('@')[1]));
    assert.deepEqual(lines, [...lines].sort((a, b) => a - b));
});

test('DartCallSite: a prefix is only a prefix when this file declares it', () => {
    assert.deepEqual(summarize("import 'a.dart' as m;\nf() => m.Foo(1);"), ['call:m|Foo@2']);
    assert.deepEqual(summarize('f() => m.Foo(1);'), ['call:m.Foo@1'], 'undeclared: read as receiver + member, not guessed');
    assert.deepEqual(summarize("import 'a.dart' as m;\nf() => const m.Foo();"), ['const:m|Foo@2']);
    assert.deepEqual(summarize('f() => const Text.rich(t);'), ['const:Text.rich@1'], 'two names without a declared prefix: type + named constructor');
    assert.deepEqual(summarize('f() => new m.Image.asset(x);'), ['new:m|Image.asset@1'], 'three names: the first is a prefix by grammar');
    assert.deepEqual(
        withTree("import 'a.dart' as m show A hide B;\nimport 'b.dart';", (tree) => [...importPrefixes(tree)]),
        ['m'],
        'show/hide names are not prefixes'
    );
});

test('DartCallSite: index and null-assert selectors end a chain without a call', () => {
    assert.deepEqual(summarize('f() => xs[0];'), []);
    assert.deepEqual(summarize('f() => a!;'), []);
});

test('asConstructor: const/new always, bare calls only by the UpperCamelCase convention', () => {
    const refs = withTree(readFileSync(join(fixtures, 'CallSites.dart'), 'utf8'), (tree) =>
        callSites(tree).map((site) => {
            const ref = asConstructor(site);
            return ref === null ? null : `${ref.typeName}${ref.constructorName === null ? '' : `.${ref.constructorName}`}`;
        })
    );
    assert.ok(refs.includes('Image.asset'));
    assert.ok(refs.includes('EdgeInsets.all'));
    assert.ok(refs.includes('ValueListenableBuilder'));
    assert.ok(refs.includes(null), 'items.map(...) is not a constructor');
    assert.equal(refs.includes('items.map'), false);
});

test('parseErrorCount: 0 for a clean file, > 0 for Dart 3 syntax the grammar lacks', () => {
    assert.equal(withTree(readFileSync(join(fixtures, 'CallSites.dart'), 'utf8'), parseErrorCount), 0);
    assert.ok(withTree(readFileSync(join(fixtures, 'Dart3.dart'), 'utf8'), parseErrorCount) > 0);
    assert.ok(withTree('f() => Text("x";', parseErrorCount) > 0, 'a MISSING token counts');
});

test('file.parseErrors: emitted only for a recovered parse, never changes findings', () => {
    const run = (file: string) =>
        analyze({rootPath: join(fixtures, file), knowledgeDir: join(root, 'knowledge', 'marcus'), ruleSetDir: join(root, 'rules', 'default'), config: DEFAULT_CONFIG});
    assert.equal(run('CallSites.dart').facts.some((fact) => fact.kind === 'file.parseErrors'), false);
    const broken = run('Dart3.dart');
    const fact = broken.facts.find((candidate) => candidate.kind === 'file.parseErrors');
    assert.ok(fact !== undefined && typeof fact.value === 'number' && fact.value > 0);
    assert.equal(broken.report.coverage.status, 'complete', 'the parse still counts as successful (unchanged behaviour)');
    assert.equal(broken.report.findings.some((finding) => finding.observation.evidence.some((evidence) => evidence.fact === 'file.parseErrors')), false, 'no rule reads it');
});
