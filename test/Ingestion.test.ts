import assert from 'node:assert/strict';
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
