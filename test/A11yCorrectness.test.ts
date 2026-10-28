import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initHtml} from '../src/analysis/HtmlAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

// Regression tests for the accessibility correctness pass: each asserts the fixed
// behaviour through the real analysis path (source → facts → rule → finding), not a
// helper in isolation. The existing golden corpora are left untouched; these use
// dedicated fixtures so a bug fix is pinned by its own true/false positives.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const fixtures = join(here, 'fixtures', 'a11y-correctness');

// HTML and Vue share the tree-sitter-html grammar (async WASM init); the JSX path
// uses the synchronous TS adapter and needs no init.
before(async () => {
    await initHtml();
});

const analyzeFixture = (file: string): Finding[] => {
    return analyze({rootPath: join(fixtures, file), knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings;
};
const ids = (findings: Finding[], rule: string): string[] =>
    findings.filter((f) => f.rule.id === rule).map((f) => f.location.symbol ?? '').sort();

test('HTML accessible name: aria-hidden text, empty/dangling/empty-target aria-labelledby and role=presentation do not count as a name', () => {
    const findings = analyzeFixture('html-names.html');
    assert.deepEqual(
        ids(findings, 'R-A11Y-CONTROL-NAME'),
        ['button#0', 'button#1', 'button#2', 'button#3', 'button#4'],
        'hidden-only text, empty aria-labelledby, dangling target, empty target, and role=presentation are all unnamed; resolvable/chained aria-labelledby, visible text and aria-label are fine'
    );
});

test('HTML focusability: a contenteditable editing host is focusable, a malformed tabindex is not', () => {
    const findings = analyzeFixture('html-focus.html');
    assert.deepEqual(
        ids(findings, 'R-A11Y-ARIA-HIDDEN-FOCUSABLE'),
        ['aria-hidden#0'],
        'only the contenteditable div is focusable+hidden; tabindex="3px" is not a clean integer and contenteditable="false"/a plain span are not focusable'
    );
});

test('HTML contrast: low contrast is reported even under aria-hidden / role=presentation (text is still visually rendered)', () => {
    const findings = analyzeFixture('html-contrast-hidden.html');
    assert.deepEqual(
        ids(findings, 'R-A11Y-CONTRAST-TEXT'),
        ['contrast#0', 'contrast#1'],
        'both the aria-hidden and the role=presentation paragraph are flagged'
    );
});

test('JSX accessible name & focusability: same semantics as HTML (hidden text, empty aria-labelledby, role=presentation, contentEditable)', () => {
    const findings = analyzeFixture('jsx-names.tsx');
    assert.deepEqual(
        ids(findings, 'R-A11Y-CONTROL-NAME'),
        ['button#0', 'button#1', 'button#2'],
        'hidden-only text, empty aria-labelledby and role=presentation are unnamed; aria-label is fine'
    );
    assert.deepEqual(
        ids(findings, 'R-A11Y-ARIA-HIDDEN-FOCUSABLE'),
        ['aria-hidden#0'],
        'the aria-hidden contentEditable div is focusable'
    );
});

test('HTML image: aria-label / resolving aria-labelledby is a text alternative; empty/dangling is not', () => {
    const findings = analyzeFixture('html-img.html');
    assert.deepEqual(
        ids(findings, 'R-A11Y-IMG-ALT'),
        ['img#2', 'img#3', 'img#4'],
        'bare img, empty aria-label and dangling aria-labelledby are flagged; a real aria-label and a resolving aria-labelledby are fine'
    );
});

test('JSX image: a non-empty aria-label(ledby) is a text alternative, an empty aria-label is not', () => {
    const findings = analyzeFixture('jsx-img.tsx');
    assert.deepEqual(
        ids(findings, 'R-A11Y-IMG-ALT'),
        ['img#0', 'img#1'],
        'the bare img and the empty-aria-label img are flagged; aria-label and non-empty aria-labelledby are fine'
    );
});

test('Vue template: the HTML correctness changes apply consistently (contrast under aria-hidden, empty aria-labelledby frame)', () => {
    const findings = analyzeFixture('vue-hidden.vue');
    assert.deepEqual(ids(findings, 'R-A11Y-CONTRAST-TEXT'), ['contrast#0'], 'low contrast under aria-hidden is flagged');
    assert.deepEqual(ids(findings, 'R-A11Y-FRAME-TITLE'), ['frame#0'], 'a frame with an empty aria-labelledby has no name');
});
