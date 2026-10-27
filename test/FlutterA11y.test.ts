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

test('Flutter golden corpus: precision/recall 100% over the widget a11y rules', () => {
    const findings = analyzePath(corpus);
    const result = evaluate(findings, loadExpected(join(here, 'fixtures', 'flutter', 'expected.json')), corpus);
    assert.equal(result.overall.precision, 1);
    assert.equal(result.overall.recall, 1);
    assert.equal(result.overall.truePositives, 5);
    assert.equal(result.overall.falsePositives, 0);
    assert.equal(result.overall.falseNegatives, 0);

    const rules = result.perRule.map((item) => item.rule).sort();
    assert.deepEqual(rules, ['R-A11Y-FLUTTER-ICONBUTTON-LABEL', 'R-A11Y-FLUTTER-IMAGE-LABEL', 'R-A11Y-FLUTTER-TEXTFIELD-LABEL']);
});
