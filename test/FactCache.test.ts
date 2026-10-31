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
        const allEntries: string[] = [];
        const walk = (d: string): void => {
            for (const entry of readdirSync(d, {withFileTypes: true})) {
                const abs = join(d, entry.name);
                if (entry.isDirectory()) {
                    walk(abs);
                } else {
                    allEntries.push(abs);
                }
            }
        };
        walk(dir);
        for (const entry of allEntries) {
            writeFileSync(entry, '{ not valid json');
        }
        assert.equal(cache.get('typescript', file), null);
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
