import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {collectFiles} from '../src/Ingestion.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fixtures', 'ingestion');

const names = (include: string[], exclude: string[]): string[] =>
    collectFiles(dir, {include, exclude})
        .map((file) => basename(file.path))
        .sort();

test('include globs select by pattern; .md is not matched (but .d.ts matches *.ts)', () => {
    assert.deepEqual(names(['**/*.ts', '**/*.php'], []), ['keep.php', 'keep.ts', 'old.ts', 'skip.d.ts']);
});

test('exclude globs drop matching files (d.ts and a directory)', () => {
    assert.deepEqual(names(['**/*.ts', '**/*.php'], ['**/*.d.ts', 'legacy/**']), ['keep.php', 'keep.ts']);
});

test('a single-file root is returned as-is, bypassing the globs', () => {
    // php does not match the include, but an explicitly named file is still read.
    const files = collectFiles(join(dir, 'keep.php'), {include: ['**/*.ts'], exclude: []});
    assert.equal(files.length, 1);
    assert.equal(basename(files[0]?.path ?? ''), 'keep.php');
});

test('file selection is deterministic', () => {
    assert.deepEqual(names(['**/*.ts'], []), names(['**/*.ts'], []));
});

test('a file over maxFileBytes is excluded like a glob exclude, and reported via onExcluded (not silently dropped)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stoa-ingestion-size-'));
    try {
        writeFileSync(join(tmp, 'small.ts'), 'export const x = 1;\n');
        writeFileSync(join(tmp, 'huge.ts'), `export const x = '${'a'.repeat(200)}';\n`);
        const excluded: Array<{path: string; reason: string}> = [];
        const files = collectFiles(tmp, {
            include: ['**/*.ts'],
            exclude: [],
            maxFileBytes: 50,
            onExcluded: (path, reason) => excluded.push({path, reason})
        });
        assert.deepEqual(files.map((f) => basename(f.path)), ['small.ts']);
        assert.equal(excluded.length, 1);
        assert.ok(excluded[0]?.path.endsWith('huge.ts'));
        assert.match(excluded[0]?.reason ?? '', /exceeds maxFileBytes/);
    } finally {
        rmSync(tmp, {recursive: true, force: true});
    }
});

test('an explicitly named oversized file is still read (explicit selection bypasses maxFileBytes, same as the include/exclude globs)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stoa-ingestion-size-explicit-'));
    try {
        const huge = join(tmp, 'huge.ts');
        writeFileSync(huge, `export const x = '${'a'.repeat(200)}';\n`);
        const files = collectFiles(huge, {include: ['**/*.ts'], exclude: [], maxFileBytes: 50});
        assert.equal(files.length, 1);
    } finally {
        rmSync(tmp, {recursive: true, force: true});
    }
});

test('an unreadable subdirectory is pruned and reported, not a crash of the whole walk', {skip: process.getuid?.() === 0}, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stoa-ingestion-unreadable-'));
    try {
        writeFileSync(join(tmp, 'readable.ts'), 'export const x = 1;\n');
        const locked = join(tmp, 'locked');
        mkdirSync(locked);
        writeFileSync(join(locked, 'hidden.ts'), 'export const y = 2;\n');
        chmodSync(locked, 0o000);
        const excluded: Array<{path: string; reason: string}> = [];
        const files = collectFiles(tmp, {
            include: ['**/*.ts'],
            exclude: [],
            onExcluded: (path, reason) => excluded.push({path, reason})
        });
        assert.deepEqual(files.map((f) => basename(f.path)), ['readable.ts']);
        assert.equal(excluded.length, 1);
        assert.ok(excluded[0]?.path.endsWith('locked'));
        assert.match(excluded[0]?.reason ?? '', /not readable/);
    } finally {
        chmodSync(join(tmp, 'locked'), 0o755);
        rmSync(tmp, {recursive: true, force: true});
    }
});
