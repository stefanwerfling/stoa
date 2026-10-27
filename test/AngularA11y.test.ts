import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initHtml} from '../src/analysis/HtmlAdapter.js';
import {loadExpected} from '../src/evaluation/Corpus.js';
import {evaluate} from '../src/evaluation/Evaluator.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const corpus = join(here, 'fixtures', 'angular', 'corpus');

// Angular reuses the tree-sitter-html grammar, so the same async init applies.
before(async () => {
    await initHtml();
});

const analyzePath = (path: string): Finding[] => {
    return analyze({rootPath: path, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings;
};
const ids = (findings: Finding[], rule: string): string[] => findings.filter((f) => f.rule.id === rule).map((f) => f.location.symbol ?? '').sort();

test('the attribute/contrast a11y rules fire on an Angular *.component.html, honouring [attr.x]/[x]/(x)/*ngX', () => {
    const findings = analyzePath(join(corpus, 'widget.component.html'));
    assert.deepEqual(ids(findings, 'R-A11Y-IMG-ALT'), ['img#0'], 'only the img with no alt; [alt] and [attr.alt] bind the name, so they are not flagged');
    assert.deepEqual(ids(findings, 'R-A11Y-ARIA-INVALID-ROLE'), ['role#0'], 'the static typo role; a bound [attr.role] is dynamic and skipped');
    assert.deepEqual(ids(findings, 'R-A11Y-ARIA-UNKNOWN-ATTR'), ['aria-attr#0']);
    assert.deepEqual(ids(findings, 'R-A11Y-ARIA-INVALID-VALUE'), ['aria-val#0']);
    assert.deepEqual(ids(findings, 'R-A11Y-POSITIVE-TABINDEX'), ['tabindex#0']);
    assert.deepEqual(ids(findings, 'R-A11Y-ARIA-HIDDEN-FOCUSABLE'), ['aria-hidden#0']);
    assert.deepEqual(ids(findings, 'R-A11Y-FRAME-TITLE'), ['frame#0']);
    assert.deepEqual(ids(findings, 'R-A11Y-CONTRAST-TEXT'), ['contrast#0'], 'the static low-contrast style; [style.color] is dynamic');
});

test('*.component.html is handled by the Angular adapter, not treated as plain HTML', () => {
    // If it were plain HTML, <img [alt]> / <img [attr.alt]> would be reported as
    // missing alt (three img findings). Exactly one proves the Angular dialect ran.
    const findings = analyzePath(join(corpus, 'widget.component.html'));
    assert.equal(ids(findings, 'R-A11Y-IMG-ALT').length, 1);
});

test('a clean Angular template produces no accessibility findings (no false positives)', () => {
    const findings = analyzePath(join(corpus, 'clean.component.html')).filter((f) => f.rule.id.startsWith('R-A11Y-'));
    assert.deepEqual(findings, []);
});

test('Angular golden corpus: precision/recall 100% over the ported template rules', () => {
    const findings = analyzePath(corpus);
    const result = evaluate(findings, loadExpected(join(here, 'fixtures', 'angular', 'expected.json')), corpus);
    assert.equal(result.overall.precision, 1);
    assert.equal(result.overall.recall, 1);
    assert.equal(result.overall.truePositives, 8);
    assert.equal(result.overall.falsePositives, 0);
    assert.equal(result.overall.falseNegatives, 0);
});
