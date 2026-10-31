import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {engineFingerprint, FactCache} from '../src/FactCache.js';
import type {Fact} from '../src/Types.js';

const sampleFact = (value: string): Fact => ({
    id: `fact:test:${value}`,
    kind: 'file.lineCount',
    subject: {file: '/x.ts', range: {startLine: 1, startCol: 0, endLine: 1, endCol: 0}, kindOf: 'file'},
    value,
    evidence: [],
    certainty: 'syntactic',
    producedBy: {adapter: 'test', version: '0.0.0'}
});

const allCacheEntryPaths = (dir: string): string[] => {
    const found: string[] = [];
    const walk = (d: string): void => {
        for (const entry of readdirSync(d, {withFileTypes: true})) {
            const abs = join(d, entry.name);
            if (entry.isDirectory()) {
                walk(abs);
            } else {
                found.push(abs);
            }
        }
    };
    walk(dir);
    return found;
};

test('engineFingerprint is stable across repeated calls within one process', () => {
    assert.equal(engineFingerprint(), engineFingerprint());
});

test('FactCache: a miss returns null, a set+get roundtrips the same facts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-factcache-'));
    try {
        const cache = new FactCache(dir);
        const file = {path: '/project/a.ts', content: 'export const x = 1;\n'};
        assert.equal(cache.get('typescript', file), null);
        const facts = [sampleFact('one'), sampleFact('two')];
        cache.set('typescript', file, facts);
        assert.deepEqual(cache.get('typescript', file), facts);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('FactCache: different file content misses, even at the same path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-factcache-'));
    try {
        const cache = new FactCache(dir);
        const v1 = {path: '/project/a.ts', content: 'export const x = 1;\n'};
        const v2 = {path: '/project/a.ts', content: 'export const x = 2;\n'};
        cache.set('typescript', v1, [sampleFact('v1')]);
        assert.equal(cache.get('typescript', v2), null, 'changed content must not be served the old entry');
        assert.deepEqual(cache.get('typescript', v1), [sampleFact('v1')], 'the original content is still correctly cached');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('FactCache: different adapter id for the same file/content is a distinct entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-factcache-'));
    try {
        const cache = new FactCache(dir);
        const file = {path: '/project/a.ts', content: 'export const x = 1;\n'};
        cache.set('typescript', file, [sampleFact('ts')]);
        assert.equal(cache.get('tsc', file), null, 'tsc facts are cached separately from the main adapter facts, even for the same file');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('FactCache: a corrupted cache entry degrades to a miss, not a crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-factcache-'));
    try {
        const cache = new FactCache(dir);
        const file = {path: '/project/a.ts', content: 'export const x = 1;\n'};
        cache.set('typescript', file, [sampleFact('one')]);
        // Corrupt every entry written so far — simulates disk corruption / a
        // partial write, without needing to know the exact hashed filename.
        for (const entry of allCacheEntryPaths(dir)) {
            writeFileSync(entry, '{ not valid json');
        }
        assert.equal(cache.get('typescript', file), null);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

// Phase 5.2 — structural validation of cache CONTENTS, not just "is this
// valid JSON with a facts array". Each of these is syntactically valid
// JSON (so the pre-existing JSON.parse try/catch does not catch them) but
// semantically wrong — exactly the case isValidFact() exists for.
test('FactCache: a syntactically valid but structurally wrong fact entry is a miss, never silently passed through', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-factcache-'));
    const file = {path: '/project/a.ts', content: 'export const x = 1;\n'};
    const cases: Array<{label: string; facts: unknown}> = [
        {label: 'missing required field (producedBy)', facts: [{id: 'x', kind: 'file.lineCount', subject: sampleFact('x').subject, value: 1, evidence: [], certainty: 'syntactic'}]},
        {label: 'wrong type (kind is a number)', facts: [{...sampleFact('x'), kind: 42}]},
        {label: 'invalid certainty value', facts: [{...sampleFact('x'), certainty: 'made-up'}]},
        {label: 'subject.range missing a field', facts: [{...sampleFact('x'), subject: {file: '/x.ts', kindOf: 'file', range: {startLine: 1, startCol: 0, endLine: 1}}}]},
        {label: 'evidence is not an array', facts: [{...sampleFact('x'), evidence: 'not-an-array'}]},
        {label: 'one good fact alongside one bad one — the whole entry is still rejected, not half-served', facts: [sampleFact('good'), {bad: true}]},
        {label: 'facts is not even an array', facts: {not: 'an array'}}
    ];
    try {
        const cache = new FactCache(dir);
        for (const {label, facts} of cases) {
            for (const path of allCacheEntryPaths(dir)) {
                rmSync(path, {force: true});
            }
            cache.set('typescript', file, [sampleFact('placeholder')]); // establishes the real path for this key
            for (const path of allCacheEntryPaths(dir)) {
                writeFileSync(path, JSON.stringify({facts}));
            }
            assert.equal(cache.get('typescript', file), null, label);
        }
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('FactCache: the cache directory is created on demand (no pre-existing dir required)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-factcache-'));
    const nested = join(dir, 'does', 'not', 'exist', 'yet');
    try {
        const cache = new FactCache(nested);
        const file = {path: '/project/a.ts', content: 'export const x = 1;\n'};
        cache.set('typescript', file, [sampleFact('one')]);
        assert.deepEqual(cache.get('typescript', file), [sampleFact('one')]);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});
