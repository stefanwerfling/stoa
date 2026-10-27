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
const corpus = join(here, 'fixtures', 'vue', 'corpus');

// Vue reuses the tree-sitter-html grammar, so the same async init applies.
before(async () => {
    await initHtml();
});

const analyzePath = (path: string): Finding[] => {
    return analyze({rootPath: path, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings;
};
const ids = (findings: Finding[], rule: string): string[] => findings.filter((f) => f.rule.id === rule).map((f) => f.location.symbol ?? '').sort();

test('the attribute/contrast a11y rules fire on a .vue template, honouring v-bind/:/@ and {{…}}', () => {
    const findings = analyzePath(join(corpus, 'Widget.vue'));
    assert.deepEqual(ids(findings, 'R-A11Y-IMG-ALT'), ['img#0'], 'only the img with no alt; alt="…", :alt and v-bind:alt bind the name');
    assert.deepEqual(ids(findings, 'R-A11Y-ARIA-INVALID-ROLE'), ['role#0'], 'the typo role; a bound :role is dynamic and skipped');
    assert.deepEqual(ids(findings, 'R-A11Y-ARIA-UNKNOWN-ATTR'), ['aria-attr#0'], 'the misspelled aria-* name');
    assert.deepEqual(ids(findings, 'R-A11Y-ARIA-INVALID-VALUE'), ['aria-val#0'], 'the out-of-range enumerated value');
    assert.deepEqual(ids(findings, 'R-A11Y-POSITIVE-TABINDEX'), ['tabindex#0'], 'the static tabindex="5"');
    assert.deepEqual(ids(findings, 'R-A11Y-ARIA-HIDDEN-FOCUSABLE'), ['aria-hidden#0'], 'the focusable aria-hidden control');
    assert.deepEqual(ids(findings, 'R-A11Y-FRAME-TITLE'), ['frame#0'], 'the untitled iframe');
    assert.deepEqual(ids(findings, 'R-A11Y-CONTRAST-TEXT'), ['contrast#0'], 'the static low-contrast style; :style is dynamic, and <style scoped> is outside <template>');
});

test('a React component element and content outside <template> are not analysed', () => {
    const findings = analyzePath(join(corpus, 'Widget.vue')).filter((f) => f.rule.id.startsWith('R-A11Y-'));
    assert.equal(findings.length, 8, 'exactly the eight template findings; <MyButton/>, <script> and <style> contribute none');
});

test('a clean .vue component produces no accessibility findings (no false positives)', () => {
    const findings = analyzePath(join(corpus, 'Clean.vue')).filter((f) => f.rule.id.startsWith('R-A11Y-'));
    assert.deepEqual(findings, []);
});

test('Vue golden corpus: precision/recall 100% over the ported template rules', () => {
    const findings = analyzePath(corpus);
    const result = evaluate(findings, loadExpected(join(here, 'fixtures', 'vue', 'expected.json')), corpus);
    assert.equal(result.overall.precision, 1);
    assert.equal(result.overall.recall, 1);
    assert.equal(result.overall.truePositives, 8);
    assert.equal(result.overall.falsePositives, 0);
    assert.equal(result.overall.falseNegatives, 0);

    const rules = result.perRule.map((item) => item.rule).sort();
    assert.deepEqual(rules, ['R-A11Y-ARIA-HIDDEN-FOCUSABLE', 'R-A11Y-ARIA-INVALID-ROLE', 'R-A11Y-ARIA-INVALID-VALUE', 'R-A11Y-ARIA-UNKNOWN-ATTR', 'R-A11Y-CONTRAST-TEXT', 'R-A11Y-FRAME-TITLE', 'R-A11Y-IMG-ALT', 'R-A11Y-POSITIVE-TABINDEX']);
});
