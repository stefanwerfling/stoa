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
const corpus = join(here, 'fixtures', 'html', 'corpus');

// The HTML grammar (tree-sitter/WASM) loads asynchronously; afterwards the
// pipeline parses HTML synchronously like the other adapters.
before(async () => {
    await initHtml();
});

const analyzePath = (path: string): Finding[] => {
    return analyze({rootPath: path, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings;
};
const ids = (findings: Finding[], rule: string): string[] => findings.filter((f) => f.rule.id === rule).map((f) => f.location.symbol ?? '').sort();

test('R-A11Y-IMG-ALT flags a missing alt, but not alt="" / a real alt / aria-hidden', () => {
    const findings = analyzePath(join(corpus, 'images.html')).filter((f) => f.rule.id === 'R-A11Y-IMG-ALT');
    assert.deepEqual(
        findings.map((f) => f.location.symbol),
        ['img#0'],
        'only the image with no alt attribute is flagged'
    );
    assert.equal(findings[0]?.interpretation.principles[0]?.id, 'marcus.purpose');
    assert.ok(findings[0]?.interpretation.dimensions.includes('accessibility'));
    assert.equal(findings[0]?.severity, 'high');
    assert.ok((findings[0]?.observation.evidence[0]?.fact ?? '') === 'ui.imageMissingAlt', 'observation cites the UI fact');
});

test('R-A11Y-CONTROL-NAME flags unnamed buttons, not text/aria-label/svg-title/img-alt ones', () => {
    const findings = analyzePath(join(corpus, 'buttons.html'));
    assert.deepEqual(ids(findings, 'R-A11Y-CONTROL-NAME'), ['button#0', 'button#5'], 'the empty button and the unlabeled icon-only button');
});

test('R-A11Y-FORM-LABEL flags unlabelled fields, not label-for / wrapping-label / aria / hidden / submit', () => {
    const findings = analyzePath(join(corpus, 'forms.html'));
    assert.deepEqual(
        ids(findings, 'R-A11Y-FORM-LABEL'),
        ['field#0', 'field#4', 'field#6'],
        'bare input, bare select and placeholder-only input; a placeholder is not a label'
    );
    const first = findings.find((f) => f.rule.id === 'R-A11Y-FORM-LABEL');
    assert.ok(first?.interpretation.dimensions.includes('accessibility'));
});

test('R-A11Y-LINK-NAME flags empty/icon-only links, not text / aria-label / a bare anchor', () => {
    const findings = analyzePath(join(corpus, 'links.html'));
    assert.deepEqual(
        ids(findings, 'R-A11Y-LINK-NAME'),
        ['link#1', 'link#3'],
        'the empty link and the unlabeled icon-only link; an <a> without href is not a link'
    );
});

test('R-A11Y-ARIA-HIDDEN-FOCUSABLE flags focusable aria-hidden elements, not decorative or tabindex=-1 ones', () => {
    const findings = analyzePath(join(corpus, 'aria-hidden.html'));
    assert.deepEqual(
        ids(findings, 'R-A11Y-ARIA-HIDDEN-FOCUSABLE'),
        ['aria-hidden#0', 'aria-hidden#1', 'aria-hidden#2'],
        'a hidden button, a hidden link and a hidden tabindex=0 widget; a decorative img/span and a tabindex=-1 button are fine'
    );
    const first = findings.find((f) => f.rule.id === 'R-A11Y-ARIA-HIDDEN-FOCUSABLE');
    assert.equal(first?.interpretation.principles[0]?.id, 'marcus.cooperation');
});

test('R-A11Y-ARIA-INVALID-ROLE flags typos/abstract roles, not valid roles / first-valid-token / doc-* / empty', () => {
    const findings = analyzePath(join(corpus, 'roles.html'));
    assert.deepEqual(
        ids(findings, 'R-A11Y-ARIA-INVALID-ROLE'),
        ['role#0', 'role#1'],
        'the typo and the abstract role; a valid role, a first-valid token list, a doc-* role and an empty role are fine'
    );
});

test('R-A11Y-ARIA-UNKNOWN-ATTR flags misspelled aria-* names, not valid ones / non-aria attributes', () => {
    const findings = analyzePath(join(corpus, 'aria-attrs.html'));
    assert.deepEqual(
        ids(findings, 'R-A11Y-ARIA-UNKNOWN-ATTR'),
        ['aria-attr#0', 'aria-attr#1', 'aria-attr#2'],
        'aria-labeledby, aria-hiden and aria-prezed; valid ARIA attributes and data-aria-*/class are fine'
    );
});

test('R-A11Y-ARIA-INVALID-VALUE flags out-of-range enumerated values, not valid tokens / empty / dynamic / free-form', () => {
    const findings = analyzePath(join(corpus, 'aria-values.html'));
    assert.deepEqual(
        ids(findings, 'R-A11Y-ARIA-INVALID-VALUE'),
        ['aria-val#0', 'aria-val#1', 'aria-val#2', 'aria-val#3'],
        'aria-hidden="yes", aria-current="yes", aria-live="rude", aria-relevant with a bad token; valid tokens, undefined, empty, {{...}} and free-form aria-label are fine'
    );
});

test('R-A11Y-POSITIVE-TABINDEX flags tabindex > 0, not 0 / negative / non-numeric / dynamic', () => {
    const findings = analyzePath(join(corpus, 'tabindex.html'));
    assert.deepEqual(
        ids(findings, 'R-A11Y-POSITIVE-TABINDEX'),
        ['tabindex#0', 'tabindex#1'],
        'tabindex="1" and tabindex="3"; 0, -1, "abc" and {{n}} are fine'
    );
    const first = findings.find((f) => f.rule.id === 'R-A11Y-POSITIVE-TABINDEX');
    assert.equal(first?.interpretation.principles[0]?.id, 'marcus.cooperation');
    assert.ok(first?.interpretation.dimensions.includes('usability'));
});

test('R-A11Y-HTML-LANG flags an <html> with no lang; pages that set lang="en" are fine', () => {
    const flagged = analyzePath(join(corpus, 'lang.html'));
    assert.deepEqual(ids(flagged, 'R-A11Y-HTML-LANG'), ['html#0'], 'the document root has no lang');
    const ok = analyzePath(join(corpus, 'clean.html'));
    assert.deepEqual(ids(ok, 'R-A11Y-HTML-LANG'), [], 'a page with <html lang="en"> is not flagged');
});

test('R-A11Y-META-VIEWPORT-ZOOM flags user-scalable=no / maximum-scale<2, not scalable viewports or other metas', () => {
    const findings = analyzePath(join(corpus, 'viewport.html'));
    assert.deepEqual(
        ids(findings, 'R-A11Y-META-VIEWPORT-ZOOM'),
        ['viewport#0', 'viewport#1'],
        'user-scalable=no and maximum-scale=1; maximum-scale=5/2.0, user-scalable=yes and a non-viewport meta are fine'
    );
});

test('R-A11Y-ARIA-DANGLING-IDREF flags references to absent ids, not resolvable ones / aria-controls', () => {
    const findings = analyzePath(join(corpus, 'idref.html'));
    assert.deepEqual(
        ids(findings, 'R-A11Y-ARIA-DANGLING-IDREF'),
        ['idref#0', 'idref#1', 'idref#2'],
        'aria-labelledby="missing", a dangling token in a describedby list, and one dangling token in a labelledby list; resolvable refs and aria-controls are fine'
    );
    assert.equal(findings.find((f) => f.rule.id === 'R-A11Y-ARIA-DANGLING-IDREF')?.severity, 'high');
});

test('R-A11Y-DUPLICATE-ID flags every occurrence of a repeated id, not unique ones', () => {
    const findings = analyzePath(join(corpus, 'dupids.html'));
    assert.deepEqual(
        ids(findings, 'R-A11Y-DUPLICATE-ID'),
        ['dupid#0', 'dupid#1', 'dupid#2', 'dupid#3'],
        'both uses of id="main" and both of id="dup2"; a unique id and an element with no id are fine'
    );
});

test('R-A11Y-FRAME-TITLE flags unnamed/empty-title frames, not titled / aria-label / aria-hidden / aria-labelledby', () => {
    const findings = analyzePath(join(corpus, 'frames.html'));
    assert.deepEqual(
        ids(findings, 'R-A11Y-FRAME-TITLE'),
        ['frame#0', 'frame#1'],
        'the untitled iframe and the empty-title one; a title, an aria-label, an aria-hidden frame and an aria-labelledby frame are fine'
    );
    assert.equal(findings.find((f) => f.rule.id === 'R-A11Y-FRAME-TITLE')?.severity, 'high');
});

test('a clean page produces no accessibility findings (no false positives)', () => {
    const findings = analyzePath(join(corpus, 'clean.html')).filter((f) => f.rule.id.startsWith('R-A11Y-'));
    assert.deepEqual(findings, []);
});

test('UI golden corpus: precision/recall 100% with a per-category breakdown', () => {
    const findings = analyzePath(corpus);
    const result = evaluate(findings, loadExpected(join(here, 'fixtures', 'html', 'expected.json')), corpus);
    assert.equal(result.overall.precision, 1);
    assert.equal(result.overall.recall, 1);
    assert.equal(result.overall.truePositives, 34);
    assert.equal(result.overall.falsePositives, 0);
    assert.equal(result.overall.falseNegatives, 0);

    const html = result.byLanguage.find((item) => item.language === 'HTML');
    assert.equal(html?.truePositives, 34, 'all findings are HTML findings');

    const rules = result.perRule.map((item) => item.rule).sort();
    assert.deepEqual(rules, ['R-A11Y-ARIA-DANGLING-IDREF', 'R-A11Y-ARIA-HIDDEN-FOCUSABLE', 'R-A11Y-ARIA-INVALID-ROLE', 'R-A11Y-ARIA-INVALID-VALUE', 'R-A11Y-ARIA-UNKNOWN-ATTR', 'R-A11Y-CONTROL-NAME', 'R-A11Y-DUPLICATE-ID', 'R-A11Y-FORM-LABEL', 'R-A11Y-FRAME-TITLE', 'R-A11Y-HTML-LANG', 'R-A11Y-IMG-ALT', 'R-A11Y-LINK-NAME', 'R-A11Y-META-VIEWPORT-ZOOM', 'R-A11Y-POSITIVE-TABINDEX']);
    for (const rule of result.perRule) {
        assert.equal(rule.precision, 1, `${rule.rule} precision`);
        assert.equal(rule.recall, 1, `${rule.rule} recall`);
    }
});
