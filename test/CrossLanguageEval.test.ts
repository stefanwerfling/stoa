import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import type {EvaluationResult} from '../src/evaluation/EvaluationTypes.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const corpus = join(here, 'fixtures', 'eval-multi');

// End-to-end: `stoa eval` must initialize every grammar (TS, PHP, Dart, C/C++)
// and report a per-language breakdown. Run through the real CLI so the async
// grammar initialization is exercised.
test('stoa eval produces a per-language breakdown across all four languages', () => {
    const out = execFileSync('node', ['--import', 'tsx', 'src/Cli.ts', 'eval', join(corpus, 'project'), '--expected', join(corpus, 'expected.json'), '--format', 'json'], {
        cwd: root,
        encoding: 'utf8'
    });
    const result = JSON.parse(out) as EvaluationResult;

    assert.equal(result.overall.truePositives, 4, 'one finding per language matched');
    assert.equal(result.overall.falseNegatives, 0, 'no language was silently skipped');
    assert.equal(result.overall.falsePositives, 0);

    const languages = result.byLanguage.map((item) => item.language).sort();
    assert.deepEqual(languages, ['C/C++', 'Dart', 'PHP', 'TypeScript/JavaScript']);
    for (const language of result.byLanguage) {
        assert.equal(language.truePositives, 1, `${language.language}: one true positive`);
        assert.equal(language.recall, 1, `${language.language}: full recall`);
        assert.equal(language.precision, 1, `${language.language}: full precision`);
    }
});

test('stoa eval is deterministic across runs (no grammar-init race)', () => {
    const run = () => execFileSync('node', ['--import', 'tsx', 'src/Cli.ts', 'eval', join(corpus, 'project'), '--expected', join(corpus, 'expected.json'), '--format', 'json'], {cwd: root, encoding: 'utf8'});
    assert.equal(run(), run());
});
