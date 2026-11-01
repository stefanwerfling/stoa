import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {collectFiles, readFileContent} from '../src/Ingestion.js';

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
        const excluded: Array<{path: string; reason: string; detail?: string}> = [];
        const files = collectFiles(tmp, {
            include: ['**/*.ts'],
            exclude: [],
            maxFileBytes: 50,
            onExcluded: (file) => excluded.push(file)
        });
        assert.deepEqual(files.map((f) => basename(f.path)), ['small.ts']);
        assert.equal(excluded.length, 1);
        assert.ok(excluded[0]?.path.endsWith('huge.ts'));
        assert.equal(excluded[0]?.reason, 'file_too_large');
        assert.match(excluded[0]?.detail ?? '', /exceeds maxFileBytes/);
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

// Phase 3.1 — discovery returns METADATA only; content is read lazily.

test('collectFiles returns metadata only (path + size, no content) — a separate call is needed to actually read a file', () => {
    const files = collectFiles(dir, {include: ['**/*.ts'], exclude: []});
    assert.ok(files.length > 0);
    for (const file of files) {
        assert.equal(typeof file.size, 'number');
        assert.ok(file.size >= 0);
        assert.ok(!('content' in file), 'collectFiles must not have read this file\'s content');
    }
});

test('readFileContent reads exactly the file a FileMeta points at', () => {
    const files = collectFiles(dir, {include: ['**/*.ts'], exclude: []});
    const keepTs = files.find((f) => basename(f.path) === 'keep.ts');
    assert.ok(keepTs !== undefined);
    const file = readFileContent(keepTs);
    assert.equal(file.path, keepTs.path);
    assert.equal(typeof file.content, 'string');
    assert.equal(file.content.length, keepTs.size, 'size reported at discovery time matches the actually-read content length (ASCII fixture, so bytes == characters)');
});

// Phase 3.1 — a root .gitignore is honored (a narrow, best-effort slice — see GitIgnore.ts).

test('a root .gitignore excludes matching files/directories, at any depth for a plain name and anchored for a path with a slash', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stoa-ingestion-gitignore-'));
    try {
        writeFileSync(join(tmp, '.gitignore'), ['*.log', 'build/', '/only-root.ts', '# a comment', '', '!not-supported.ts'].join('\n'));
        writeFileSync(join(tmp, 'keep.ts'), 'export const x = 1;\n');
        writeFileSync(join(tmp, 'debug.log'), 'noise');
        mkdirSync(join(tmp, 'nested'));
        writeFileSync(join(tmp, 'nested', 'debug.log'), 'noise');
        mkdirSync(join(tmp, 'build'));
        writeFileSync(join(tmp, 'build', 'output.ts'), 'export const y = 1;\n');
        writeFileSync(join(tmp, 'only-root.ts'), 'export const z = 1;\n');
        mkdirSync(join(tmp, 'nested2'));
        writeFileSync(join(tmp, 'nested2', 'only-root.ts'), 'export const w = 1;\n'); // NOT excluded: anchored to repo root only

        const files = collectFiles(tmp, {include: ['**/*.ts', '**/*.log'], exclude: []});
        const relPaths = files.map((f) => f.path.slice(tmp.length + 1)).sort();
        assert.deepEqual(relPaths, ['keep.ts', 'nested2/only-root.ts']);
    } finally {
        rmSync(tmp, {recursive: true, force: true});
    }
});

test('with no root .gitignore, behavior is unchanged from before', () => {
    const files = collectFiles(dir, {include: ['**/*.ts', '**/*.php'], exclude: []});
    assert.deepEqual(
        files.map((f) => basename(f.path)).sort(),
        ['keep.php', 'keep.ts', 'old.ts', 'skip.d.ts']
    );
});

test('a config exclude and a .gitignore exclude are reported under distinct structured reasons', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stoa-ingestion-reasons-'));
    try {
        writeFileSync(join(tmp, '.gitignore'), '*.log\n');
        writeFileSync(join(tmp, 'keep.ts'), 'export const x = 1;\n');
        writeFileSync(join(tmp, 'config-excluded.ts'), 'export const y = 1;\n');
        writeFileSync(join(tmp, 'debug.log'), 'noise');
        const excluded: Array<{path: string; reason: string}> = [];
        const files = collectFiles(tmp, {
            include: ['**/*.ts', '**/*.log'],
            exclude: ['**/config-excluded.ts'],
            onExcluded: (file) => excluded.push(file)
        });
        assert.deepEqual(files.map((f) => basename(f.path)), ['keep.ts']);
        const byReason = new Map(excluded.map((e) => [basename(e.path), e.reason]));
        assert.equal(byReason.get('config-excluded.ts'), 'excluded_by_config');
        assert.equal(byReason.get('debug.log'), 'excluded_by_gitignore');
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
        const excluded: Array<{path: string; reason: string; detail?: string}> = [];
        const files = collectFiles(tmp, {
            include: ['**/*.ts'],
            exclude: [],
            onExcluded: (file) => excluded.push(file)
        });
        assert.deepEqual(files.map((f) => basename(f.path)), ['readable.ts']);
        assert.equal(excluded.length, 1);
        assert.ok(excluded[0]?.path.endsWith('locked'));
        assert.equal(excluded[0]?.reason, 'read_error');
        assert.match(excluded[0]?.detail ?? '', /not readable/);
    } finally {
        chmodSync(join(tmp, 'locked'), 0o755);
        rmSync(tmp, {recursive: true, force: true});
    }
});
