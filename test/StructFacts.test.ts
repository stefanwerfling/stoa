import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import {expandMembers, type StructMember, type StructTypeDeclValue} from '../src/analysis/StructFacts.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Fact} from '../src/Types.js';

// Flutter quality track E3: neutral class-model facts (struct.typeDecl with an
// embedded, compact member table) for Dart and TypeScript.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixtures = join(here, 'fixtures', 'struct');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');

let facts: Fact[] = [];

before(async () => {
    await initDart();
    facts = analyze({rootPath: fixtures, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).facts;
});

const typeDecls = (input: readonly Fact[]): Fact[] => input.filter((fact) => fact.kind === 'struct.typeDecl');
const typeDecl = (file: string, name: string): StructTypeDeclValue => {
    const fact = typeDecls(facts).find((candidate) => candidate.subject.file === join(fixtures, file) && candidate.subject.symbol === name);
    assert.ok(fact !== undefined, `${file} ${name}`);
    return fact.value as unknown as StructTypeDeclValue;
};
const member = (file: string, owner: string, name: string, kind?: StructMember['memberKind']): StructMember => {
    const found = expandMembers(typeDecl(file, owner)).find((candidate) => candidate.name === name && (kind === undefined || candidate.memberKind === kind));
    assert.ok(found !== undefined, `${owner}.${name}`);
    return found;
};
const ref = (text: string): {prefix: string | null; name: string} => {
    const [prefix, name] = text.includes('.') ? text.split('.') : [null, text];
    return {prefix, name: name as string};
};

test('E3 Dart: declaration kinds and supertypes (prefixed, with, implements, mixin on)', () => {
    assert.deepEqual(typeDecl('dart/lib/repo.dart', 'Repo').supertypes, [
        {...ref('http.BaseClient'), kind: 'extends'},
        {...ref('Logging'), kind: 'with'},
        {...ref('Store'), kind: 'implements'}
    ]);
    assert.equal(typeDecl('dart/lib/repo.dart', 'Repo').declKind, 'abstract-class');
    assert.deepEqual(typeDecl('dart/lib/repo.dart', 'Logging').supertypes, [{...ref('Object'), kind: 'on'}]);
    assert.equal(typeDecl('dart/lib/repo.dart', 'Logging').declKind, 'mixin');
    assert.equal(typeDecl('dart/lib/repo.dart', 'Mode').declKind, 'enum');
    assert.deepEqual(typeDecl('dart/lib/repo.dart', 'Mode').members, []);
});

test('E3 Dart: member kinds in source order, static, abstract, @override, setter distinct from getter', () => {
    assert.deepEqual(
        expandMembers(typeDecl('dart/lib/repo.dart', 'Repo')).map((entry) => `${entry.memberKind} ${entry.name}${entry.isStatic ? ' static' : ''}${entry.isAbstract ? ' abstract' : ''}${entry.isOverride ? ' override' : ''}`),
        [
            'field instance static',
            'field client',
            'field _count',
            'field name',
            'constructor Repo',
            'constructor _',
            'constructor make',
            'method load abstract',
            'method close override',
            'getter count override',
            'setter count',
            'method unsupported',
            'method unimpl',
            'method notUnsupported',
            'method work',
            'method helper'
        ]
    );
});

test('E3 Dart: body shapes — abstract, empty, throws-unsupported (=> and block), other throws are normal', () => {
    const shape = (name: string): string => {
        const found = member('dart/lib/repo.dart', 'Repo', name);
        return `${found.body} ${found.throwsType}`;
    };
    assert.equal(shape('load'), 'abstract null');
    assert.equal(shape('close'), 'empty null');
    assert.equal(shape('unsupported'), 'throws-unsupported UnsupportedError');
    assert.equal(shape('unimpl'), 'throws-unsupported UnimplementedError');
    assert.equal(shape('notUnsupported'), 'normal null');
    assert.equal(member('dart/lib/repo.dart', 'Repo', 'client').body, null, 'fields have no body shape');
});

test('E3 Dart: field formals, prefixed types, refs (own members, shadowed locals, import prefixes, candidates), instantiation, static access', () => {
    assert.deepEqual(member('dart/lib/repo.dart', 'Repo', 'Repo', 'constructor').params, [
        {name: 'client', type: null, isFieldFormal: true},
        {name: 'name', type: null, isFieldFormal: true},
        {name: 'x', type: ref('int'), isFieldFormal: false}
    ]);
    assert.deepEqual(member('dart/lib/repo.dart', 'Repo', 'client').declaredType, ref('http.Client'));
    const work = member('dart/lib/repo.dart', 'Repo', 'work');
    assert.deepEqual(work.params.map((param) => param.type), [ref('int'), ref('http.Response')]);
    assert.deepEqual(work.refsMembers, ['_count', 'helper']);
    assert.deepEqual(work.refsImports, ['Service', 'http']);
    assert.deepEqual(work.instantiates, [{...ref('http.Client'), member: null}]);
    assert.deepEqual(work.staticAccess, [{...ref('Service'), member: 'instance'}]);
    // initializer lists and `=>` factories are code too
    assert.deepEqual(member('dart/lib/repo.dart', 'Repo', '_', 'constructor').instantiates, [{...ref('http.Client'), member: null}]);
    assert.deepEqual(member('dart/lib/repo.dart', 'Repo', 'make', 'constructor').instantiates, [{...ref('Repo'), member: '_'}]);
    assert.deepEqual(member('dart/lib/repo.dart', 'Repo', 'instance').instantiates, [{...ref('Repo'), member: '_'}]);
    // a constructor name is not an own-member reference
    assert.deepEqual(member('dart/lib/repo.dart', 'Repo', 'instance').refsMembers, []);
});

test('E3 TS: interface and class supertypes, parameter properties as field formals AND fields, override, body shapes, refs', () => {
    assert.deepEqual(typeDecl('ts/repo.ts', 'Store').supertypes, [{...ref('db.Base'), kind: 'extends'}, {...ref('Other'), kind: 'extends'}]);
    assert.equal(typeDecl('ts/repo.ts', 'Store').declKind, 'interface');
    assert.deepEqual(typeDecl('ts/repo.ts', 'Repo').supertypes, [{...ref('db.Base'), kind: 'extends'}, {...ref('Store'), kind: 'implements'}]);
    assert.deepEqual(member('ts/repo.ts', 'Store', 'load').body, 'abstract');
    assert.deepEqual(member('ts/repo.ts', 'Repo', 'constructor').params, [
        {name: 'http', type: ref('Http'), isFieldFormal: true},
        {name: 'log', type: ref('Logger'), isFieldFormal: true}
    ]);
    assert.deepEqual(member('ts/repo.ts', 'Repo', 'http').declaredType, ref('Http'));
    assert.equal(member('ts/repo.ts', 'Repo', 'http').memberKind, 'field');
    assert.equal(member('ts/repo.ts', 'Repo', 'load').body, 'abstract');
    assert.equal(member('ts/repo.ts', 'Repo', 'clear').body, 'empty');
    assert.equal(`${member('ts/repo.ts', 'Repo', 'remove').body} ${member('ts/repo.ts', 'Repo', 'remove').throwsType}`, 'throws-unsupported Error');
    assert.equal(member('ts/repo.ts', 'Repo', 'fail').body, 'normal');
    const save = member('ts/repo.ts', 'Repo', 'save');
    assert.equal(save.isOverride, true);
    assert.deepEqual(save.refsMembers, ['cache', 'name']);
    assert.deepEqual(save.refsImports, ['Logger', 'db']);
    assert.deepEqual(save.instantiates, [{...ref('db.Connection'), member: null}]);
    assert.deepEqual(save.staticAccess, [{...ref('Logger'), member: 'level'}]);
    assert.equal(member('ts/repo.ts', 'Repo', 'instance').isStatic, true);
    assert.equal(member('ts/repo.ts', 'Repo', 'size').memberKind, 'getter');
});

test('E3: a declaration with a syntax error is flagged (Dart and TS); a clean one is not', () => {
    assert.equal(typeDecl('dart/lib/broken.dart', 'Broken').hasParseError, true);
    assert.equal(typeDecl('ts/broken.ts', 'Broken').hasParseError, true);
    assert.equal(typeDecl('dart/lib/repo.dart', 'Repo').hasParseError, false);
    assert.equal(typeDecl('ts/repo.ts', 'Repo').hasParseError, false);
});

test('E3: compact storage omits defaults; expandMembers restores them', () => {
    const stored = typeDecl('dart/lib/repo.dart', 'Repo').members.find((entry) => entry.name === 'name');
    assert.deepEqual(stored, {name: 'name', memberKind: 'field', range: [9, 2, 9, 14], declaredType: ref('String')});
    const expanded = member('dart/lib/repo.dart', 'Repo', 'name');
    assert.equal(expanded.isStatic, false);
    assert.deepEqual(expanded.params, []);
    assert.equal(expanded.body, null);
});

test('E3: deterministic across runs and identical from the FactCache', () => {
    const again = analyze({rootPath: fixtures, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).facts;
    assert.equal(JSON.stringify(typeDecls(again)), JSON.stringify(typeDecls(facts)));
    const cacheDir = mkdtempSync(join(tmpdir(), 'stoa-struct-cache-'));
    try {
        const cold = analyze({rootPath: fixtures, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, cacheDir});
        const warm = analyze({rootPath: fixtures, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, cacheDir});
        assert.ok((warm.report.coverage.cacheHits ?? 0) > 0);
        assert.equal(JSON.stringify(typeDecls(warm.facts)), JSON.stringify(typeDecls(cold.facts)));
        assert.equal(JSON.stringify(typeDecls(cold.facts)), JSON.stringify(typeDecls(facts)));
    } finally {
        rmSync(cacheDir, {recursive: true, force: true});
    }
});

test('E4: struct.importBindings — one per TS file with types and imports, local name → module and exported name', () => {
    const bindings = facts.filter((fact) => fact.kind === 'struct.importBindings');
    assert.deepEqual(bindings.map((fact) => fact.subject.file), [join(fixtures, 'ts/repo.ts')], 'broken.ts has no imports; Dart files never get one');
    assert.deepEqual((bindings[0]?.value as {bindings: unknown[]}).bindings, [
        {local: 'Http', module: './http', importedName: 'Http', kind: 'named'},
        {local: 'Logger', module: './logger', importedName: 'default', kind: 'default'},
        {local: 'db', module: './db', importedName: '*', kind: 'namespace'}
    ]);
});
