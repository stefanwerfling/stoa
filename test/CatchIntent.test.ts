import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import type {EvaluationResult} from '../src/evaluation/EvaluationTypes.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const corpus = join(here, 'fixtures', 'catch-intent');

// Regression for the SwipeMeister false positives: R-ERR-SWALLOWED must not
// fire on a catch that documents the deliberate ignore with a comment
// (doc.catchHasRationale) or that reads its error binding (`lastError = e`,
// `return {error}`), in every language — while the undocumented catches that
// never read the error stay reported. Run through the real `stoa eval` CLI so
// all four grammars are initialized.
test('R-ERR-SWALLOWED: commented or error-reading catches are not swallowed (all languages)', () => {
    const out = execFileSync('node', ['--import', 'tsx', 'src/Cli.ts', 'eval', join(corpus, 'project'), '--expected', join(corpus, 'expected.json'), '--format', 'json'], {
        cwd: root,
        encoding: 'utf8'
    });
    const result = JSON.parse(out) as EvaluationResult;

    assert.equal(result.overall.falsePositives, 0, 'no commented / error-reading catch is flagged');
    assert.equal(result.overall.falseNegatives, 0, 'the genuinely swallowing catches are still flagged');
    assert.equal(result.overall.truePositives, 6);

    const languages = result.byLanguage.map((item) => item.language).sort();
    assert.deepEqual(languages, ['C/C++', 'Dart', 'PHP', 'TypeScript/JavaScript']);
});
