import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import {loadExpected} from '../src/evaluation/Corpus.js';
import {evaluate} from '../src/evaluation/Evaluator.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const corpus = join(here, 'fixtures', 'flutter', 'corpus');

// Dart uses tree-sitter (WASM), loaded asynchronously before analyze().
before(async () => {
    await initDart();
});

const analyzePath = (path: string): Finding[] => {
    return analyze({rootPath: path, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings;
};
const ids = (findings: Finding[], rule: string): string[] => findings.filter((f) => f.rule.id === rule).map((f) => f.location.symbol ?? '').sort();

test('R-A11Y-FLUTTER-IMAGE-LABEL flags Image with no semanticLabel, honouring excludeFromSemantics', () => {
    const findings = analyzePath(join(corpus, 'widget.dart'));
    assert.deepEqual(
        ids(findings, 'R-A11Y-FLUTTER-IMAGE-LABEL'),
        ['image#0', 'image#1'],
        'Image.network with no label and Image(excludeFromSemantics: false); a semanticLabel and excludeFromSemantics: true are fine'
    );
    const first = findings.find((f) => f.rule.id === 'R-A11Y-FLUTTER-IMAGE-LABEL');
    assert.equal(first?.interpretation.principles[0]?.id, 'marcus.purpose');
    assert.ok(first?.interpretation.dimensions.includes('accessibility'));
    // Evidence is the widget call itself (Image...), not the enclosing expression.
    assert.ok(String(first?.observation.evidence[0]?.value ?? '').startsWith('Image'), 'evidence shows the widget call');
});

test('R-A11Y-FLUTTER-ICONBUTTON-LABEL flags IconButton with no tooltip', () => {
    const findings = analyzePath(join(corpus, 'widget.dart'));
    assert.deepEqual(ids(findings, 'R-A11Y-FLUTTER-ICONBUTTON-LABEL'), ['iconButton#0'], 'the IconButton without tooltip; one with tooltip is fine');
});

test('R-A11Y-FLUTTER-TEXTFIELD-LABEL flags fields with no label, honouring labelText/hintText and unresolved decorations', () => {
    const findings = analyzePath(join(corpus, 'widget.dart'));
    assert.deepEqual(
        ids(findings, 'R-A11Y-FLUTTER-TEXTFIELD-LABEL'),
        ['textField#0', 'textField#1'],
        'TextField() with no decoration and TextField(InputDecoration(border: …)); labelText, hintText and a variable decoration are not flagged'
    );
});

test('a clean Flutter widget tree produces no accessibility findings (no false positives)', () => {
    const findings = analyzePath(join(corpus, 'clean.dart')).filter((f) => f.rule.id.startsWith('R-A11Y-'));
    assert.deepEqual(findings, []);
});

test('an ancestor Semantics(label: …) names the subtree, so a wrapped Image/IconButton/TextField is not flagged', () => {
    const findings = analyzePath(join(corpus, 'semantics.dart')).filter((f) => f.rule.id.startsWith('R-A11Y-'));
    // Only the IconButton in a label-less Semantics(container: true) is flagged; the
    // three widgets wrapped in Semantics(label: …) are treated as named.
    assert.deepEqual(
        findings.map((f) => `${f.rule.id}:${f.location.symbol}`),
        ['R-A11Y-FLUTTER-ICONBUTTON-LABEL:iconButton#0']
    );
});

test('IconButton.styleFrom (a static ButtonStyle factory) is not treated as an unlabelled IconButton widget', () => {
    // Regression for a real-world false positive: IconButton.styleFrom(...) inside an
    // IconButtonThemeData is a ButtonStyle factory, not a widget, so it needs no tooltip.
    const findings = analyzePath(join(corpus, 'clean.dart'));
    assert.deepEqual(ids(findings, 'R-A11Y-FLUTTER-ICONBUTTON-LABEL'), [], 'no IconButton-label finding on the clean tree that contains IconButton.styleFrom');
});

test('Flutter golden corpus: precision/recall 100% over the widget a11y rules', () => {
    const findings = analyzePath(corpus);
    const result = evaluate(findings, loadExpected(join(here, 'fixtures', 'flutter', 'expected.json')), corpus);
    assert.equal(result.overall.precision, 1);
    assert.equal(result.overall.recall, 1);
    assert.equal(result.overall.truePositives, 6);
    assert.equal(result.overall.falsePositives, 0);
    assert.equal(result.overall.falseNegatives, 0);

    const rules = result.perRule.map((item) => item.rule).sort();
    assert.deepEqual(rules, ['R-A11Y-FLUTTER-ICONBUTTON-LABEL', 'R-A11Y-FLUTTER-IMAGE-LABEL', 'R-A11Y-FLUTTER-TEXTFIELD-LABEL']);
});

// Phase 4 hardening (rule version 1.1.0).
const hardening = join(here, 'fixtures', 'flutter-a11y-hardening');
const a11yLines = (path: string): string[] =>
    analyzePath(path)
        .filter((f) => f.rule.id.startsWith('R-A11Y-FLUTTER-'))
        .map((f) => `${f.rule.id.replace('R-A11Y-FLUTTER-', '')} ${f.location.range.startLine}:${f.location.range.startCol} ${String(f.observation.evidence[0]?.value)}`);

test('1.1.0: const / new / prefixed call forms and a const InputDecoration are recognised', () => {
    assert.deepEqual(a11yLines(join(hardening, 'Forms.dart')), [
        "IMAGE-LABEL 6:12 const Image(image: AssetImage('a.png'))",
        'ICONBUTTON-LABEL 7:10 new IconButton(onPressed: null, icon: Icon(Icons.add))',
        "IMAGE-LABEL 8:6 m.Image.asset('b.png')",
        'TEXTFIELD-LABEL 9:6 TextField(decoration: const InputDecoration(border: OutlineInputBorder()))'
    ]);
});

test('1.1.0: Tooltip names an IconButton, ExcludeSemantics hides; empty message, excluding: false, MergeSemantics and callbacks do not', () => {
    assert.deepEqual(a11yLines(join(hardening, 'Wrappers.dart')), [
        "IMAGE-LABEL 6:48 Image.asset('shown.png')",
        'ICONBUTTON-LABEL 7:34 IconButton(onPressed: null, icon: Icon(Icons.add))',
        "IMAGE-LABEL 8:37 Image.asset('t.png')",
        'ICONBUTTON-LABEL 9:43 IconButton(onPressed: null, icon: Icon(Icons.add))',
        'ICONBUTTON-LABEL 14:68 IconButton(onPressed: null, icon: Icon(Icons.close))'
    ]);
});

test('1.1.0: identity — a same-file class shadows Flutter\'s, and without a Flutter import nothing is claimed', () => {
    assert.deepEqual(a11yLines(join(hardening, 'Identity.dart')), []);
    assert.deepEqual(a11yLines(join(hardening, 'NoFlutter.dart')), []);
});

test('the three Flutter a11y rules are at version 1.2.0 (Phase B identity)', () => {
    const versions = analyzePath(join(hardening, 'Forms.dart'))
        .filter((f) => f.rule.id.startsWith('R-A11Y-FLUTTER-'))
        .map((f) => `${f.rule.id}@${f.rule.version}`);
    assert.deepEqual([...new Set(versions)].sort(), ['R-A11Y-FLUTTER-ICONBUTTON-LABEL@1.2.0', 'R-A11Y-FLUTTER-IMAGE-LABEL@1.2.0', 'R-A11Y-FLUTTER-TEXTFIELD-LABEL@1.2.0']);
});
