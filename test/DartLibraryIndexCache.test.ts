import assert from 'node:assert/strict';
import {test} from 'node:test';
import {flutterAwareIndex} from '../src/analysis/dart/FlutterCatalog.js';
import type {Fact} from '../src/Types.js';

// Finding identity spec, phase 3: DartLibraryIndex memoizes `resolveUri`
// and a library's declarations (both pure over the index, which never
// changes after construction). The answers must stay those of a fresh
// computation — in particular a relative URI is resolved per directory.

const range = {startLine: 1, startCol: 0, endLine: 1, endCol: 1};

const fact = (file: string, kind: string, value: Record<string, unknown>): Fact => ({
    id: `fact:${file}:${kind}:${JSON.stringify(value)}`,
    kind,
    subject: {file, kindOf: 'file', range},
    value: value as Fact['value'],
    evidence: [{source: 'ast', detail: kind}],
    certainty: 'syntactic',
    producedBy: {adapter: 'test', version: '1'}
});

const directive = (file: string, kind: string, uri: string, prefix: string | null = null): Fact =>
    fact(file, 'dart.importSpec', {kind, uri, libraryName: null, prefix, deferred: false, show: [], hide: []});

const declares = (file: string, name: string): Fact => fact(file, 'dart.classDecl', {declKind: 'class', name, isAbstract: false});

const FACTS: Fact[] = [
    directive('/p/lib/a/main.dart', 'import', 'model.dart'),
    directive('/p/lib/b/main.dart', 'import', 'model.dart'),
    declares('/p/lib/a/model.dart', 'User'),
    declares('/p/lib/b/model.dart', 'Order'),
    directive('/p/lib/a/model.dart', 'part', 'model_part.dart'),
    directive('/p/lib/a/model_part.dart', 'part-of', 'model.dart'),
    declares('/p/lib/a/model_part.dart', 'Account')
];

test('DartLibraryIndex: one relative URI from two directories resolves to two files, repeatedly the same', () => {
    const index = flutterAwareIndex(FACTS);
    for (let round = 0; round < 3; round += 1) {
        assert.equal(index.resolveUri('/p/lib/a/main.dart', 'model.dart'), '/p/lib/a/model.dart');
        assert.equal(index.resolveUri('/p/lib/b/main.dart', 'model.dart'), '/p/lib/b/model.dart');
        assert.equal(index.resolveUri('/p/lib/a/main.dart', 'missing.dart'), null);
    }
});

test('DartLibraryIndex: names resolve through the cached URIs and declarations, parts included, the same on every lookup', () => {
    const index = flutterAwareIndex(FACTS);
    for (let round = 0; round < 3; round += 1) {
        assert.equal(index.resolve('/p/lib/a/main.dart', 'User', null).origin, 'file:/p/lib/a/model.dart');
        assert.equal(index.resolve('/p/lib/a/main.dart', 'Account', null).origin, 'file:/p/lib/a/model.dart', 'declared in a part of model.dart');
        assert.equal(index.resolve('/p/lib/a/main.dart', 'Order', null).status, 'unresolved');
        assert.equal(index.resolve('/p/lib/b/main.dart', 'Order', null).origin, 'file:/p/lib/b/model.dart');
        assert.equal(index.resolve('/p/lib/b/main.dart', 'User', null).status, 'unresolved');
        assert.equal(index.resolve('/p/lib/a/model_part.dart', 'User', null).via, 'local', 'a part sees its library');
    }
});
