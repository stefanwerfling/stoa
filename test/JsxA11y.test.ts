import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadExpected} from '../src/evaluation/Corpus.js';
import {evaluate} from '../src/evaluation/Evaluator.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const corpus = join(here, 'fixtures', 'jsx', 'corpus');

// The TypeScript adapter parses JSX synchronously (ts-morph), so — unlike the
// tree-sitter HTML adapter — no async init is needed.
const analyzePath = (path: string): Finding[] => {
    return analyze({rootPath: path, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings;
};
const ids = (findings: Finding[], rule: string): string[] => findings.filter((f) => f.rule.id === rule).map((f) => f.location.symbol ?? '').sort();

test('the same ui.* a11y rules fire on JSX intrinsics, honouring dynamic values and spreads', () => {
    const findings = analyzePath(join(corpus, 'Widgets.tsx'));
    assert.deepEqual(ids(findings, 'R-A11Y-IMG-ALT'), ['img#0'], 'only the img with no alt; alt="…", alt={expr} and {...spread} are fine');
    assert.deepEqual(ids(findings, 'R-A11Y-ARIA-INVALID-ROLE'), ['role#0'], 'the typo role; a valid role is fine');
    assert.deepEqual(ids(findings, 'R-A11Y-ARIA-UNKNOWN-ATTR'), ['aria-attr#0'], 'the misspelled aria-* name');
    assert.deepEqual(ids(findings, 'R-A11Y-ARIA-INVALID-VALUE'), ['aria-val#0'], 'the out-of-range enumerated value');
    assert.deepEqual(ids(findings, 'R-A11Y-POSITIVE-TABINDEX'), ['tabindex#0'], 'the literal tabIndex={5}');
    assert.deepEqual(ids(findings, 'R-A11Y-ARIA-HIDDEN-FOCUSABLE'), ['aria-hidden#0'], 'the focusable aria-hidden control');
    assert.deepEqual(ids(findings, 'R-A11Y-FRAME-TITLE'), ['frame#0'], 'the untitled iframe; a titled one is fine');
});

test('JSX name rules: accessible name from text/aria/nested img, dynamic content and wrapping labels honoured', () => {
    const findings = analyzePath(join(corpus, 'Names.tsx'));
    assert.deepEqual(
        ids(findings, 'R-A11Y-CONTROL-NAME'),
        ['button#0', 'button#1'],
        'the empty button and the decorative-img-only button; text / {dynamic} / aria-label / nested span / component child / img[alt] are names'
    );
    assert.deepEqual(ids(findings, 'R-A11Y-LINK-NAME'), ['link#0'], 'the empty link; text, aria-label and a bare <a> without href are fine');
    assert.deepEqual(
        ids(findings, 'R-A11Y-FORM-LABEL'),
        ['field#0', 'field#1'],
        'the bare input and the bare select; aria-label, <label htmlFor> by literal id, a wrapping <label>, a submit input and a dynamic id are all not flagged'
    );
});

test('a React component element (<Button/>) is not treated as a DOM intrinsic', () => {
    const findings = analyzePath(join(corpus, 'Widgets.tsx'));
    // The <Button/> usage and the Button definition must not add a11y findings.
    assert.equal(findings.filter((f) => f.rule.id.startsWith('R-A11Y-')).length, 7, 'exactly the seven intrinsic-element findings');
});

test('R-A11Y-CONTRAST-TEXT works on style={{…}} object literals, honouring numeric fontSize and skipping dynamic/unresolvable', () => {
    const findings = analyzePath(join(corpus, 'Contrast.tsx'));
    assert.deepEqual(
        ids(findings, 'R-A11Y-CONTRAST-TEXT'),
        ['contrast#0', 'contrast#1'],
        'grey-on-white (normal) and a sub-3:1 large-text pair (fontSize: 24); a passing pair, a 3:1-ok large pair, black, a dynamic background, a colour with no background and a translucent colour are all fine'
    );
});

test('a clean JSX component produces no accessibility findings (no false positives)', () => {
    const findings = analyzePath(join(corpus, 'Clean.tsx')).filter((f) => f.rule.id.startsWith('R-A11Y-'));
    assert.deepEqual(findings, []);
});

test('JSX golden corpus: precision/recall 100% over the ported a11y rules', () => {
    const findings = analyzePath(corpus);
    const result = evaluate(findings, loadExpected(join(here, 'fixtures', 'jsx', 'expected.json')), corpus);
    assert.equal(result.overall.precision, 1);
    assert.equal(result.overall.recall, 1);
    assert.equal(result.overall.truePositives, 14);
    assert.equal(result.overall.falsePositives, 0);
    assert.equal(result.overall.falseNegatives, 0);

    const rules = result.perRule.map((item) => item.rule).sort();
    assert.deepEqual(rules, ['R-A11Y-ARIA-HIDDEN-FOCUSABLE', 'R-A11Y-ARIA-INVALID-ROLE', 'R-A11Y-ARIA-INVALID-VALUE', 'R-A11Y-ARIA-UNKNOWN-ATTR', 'R-A11Y-CONTRAST-TEXT', 'R-A11Y-CONTROL-NAME', 'R-A11Y-FORM-LABEL', 'R-A11Y-FRAME-TITLE', 'R-A11Y-IMG-ALT', 'R-A11Y-LINK-NAME', 'R-A11Y-POSITIVE-TABINDEX']);
    for (const rule of result.perRule) {
        assert.equal(rule.precision, 1, `${rule.rule} precision`);
        assert.equal(rule.recall, 1, `${rule.rule} recall`);
    }
});
