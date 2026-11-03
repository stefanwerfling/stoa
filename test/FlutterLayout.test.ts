import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {KnowledgeBase} from '../src/knowledge/KnowledgeBase.js';
import {buildFlutterWidgetGraph} from '../src/model/FlutterWidgetGraph.js';
import {analyze} from '../src/Pipeline.js';
import {flutterLayoutRules} from '../src/rules/project/FlutterLayoutRules.js';
import type {Finding} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixtures = join(here, 'fixtures', 'flutter-layout');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');

before(async () => {
    await initDart();
});

const layoutFindings = (path: string, lang = 'en'): Finding[] =>
    analyze({rootPath: path, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, lang}).report.findings.filter((finding) => finding.rule.id.startsWith('R-FLUTTER-'));

const brief = (findings: readonly Finding[]): string[] => findings.map((finding) => `${finding.rule.id} ${finding.location.range.startLine} ${String(finding.observation.evidence[0]?.value)}`);

test('positive fixture: every runtime layout error is reported exactly once, with parent, slot and child', () => {
    assert.deepEqual(brief(layoutFindings(join(fixtures, 'Positive.dart'))), [
        'R-FLUTTER-PARENTDATA-MISUSE 8 Padding.child > Expanded',
        'R-FLUTTER-PARENTDATA-MISUSE 9 Stack.children > Flexible',
        'R-FLUTTER-PARENTDATA-MISUSE 10 Row.children > Positioned',
        'R-FLUTTER-PARENTDATA-MISUSE 11 Center.child > Positioned.fill',
        'R-FLUTTER-UNBOUNDED-SCROLLABLE 12 Column.children > ListView',
        'R-FLUTTER-UNBOUNDED-SCROLLABLE 13 Column.children > GridView.count',
        'R-FLUTTER-TEXTFIELD-UNBOUNDED-WIDTH 14 Row.children > TextField',
        'R-FLUTTER-NESTED-SCROLL-UNBOUNDED 15 SingleChildScrollView.child > ListView.builder',
        'R-FLUTTER-NESTED-SCROLL-UNBOUNDED 22 ListView.children > ListView'
    ]);
});

test('negative fixture: valid or undecidable layouts (wrapped, shrinkWrap, unknown parent, reference, builder, explicit axis) stay silent', () => {
    assert.deepEqual(brief(layoutFindings(join(fixtures, 'Negative.dart'))), []);
});

test('identity: a locally declared widget name shadows the framework class, and without a Flutter import nothing is claimed', () => {
    assert.deepEqual(brief(layoutFindings(join(fixtures, 'Shadowed.dart'))), []);
    assert.deepEqual(brief(layoutFindings(join(fixtures, 'NoFlutter.dart'))), []);
});

test('finding shape: location at the child, robustness, marcus.judgment, evidence is a produced fact kind, localized text', () => {
    const result = analyze({rootPath: join(fixtures, 'Positive.dart'), knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    const factKinds = new Set(result.facts.map((fact) => fact.kind));
    const finding = result.report.findings.find((candidate) => candidate.rule.id === 'R-FLUTTER-PARENTDATA-MISUSE');
    assert.ok(finding !== undefined);
    assert.equal(finding.location.symbol, 'build');
    assert.deepEqual(finding.location.range, {startLine: 8, startCol: 47, endLine: 8, endCol: 73});
    assert.deepEqual(finding.interpretation.dimensions, ['robustness']);
    assert.equal(finding.interpretation.principles[0]?.id, 'marcus.judgment');
    assert.ok(finding.observation.evidence.every((evidence) => factKinds.has(evidence.fact)));
    assert.equal(finding.observation.statement, 'Expanded is placed in Padding.child, which is not a Row/Column/Flex.');
    const german = layoutFindings(join(fixtures, 'Positive.dart'), 'de')[0];
    assert.equal(german?.observation.statement, 'Expanded steht in Padding.child, das kein Row/Column/Flex ist.');
    assert.ok(!JSON.stringify(result.report.findings).includes('{'.concat('child}')), 'no unfilled placeholder');
});

test('rules need the graph: without one (non-Flutter run or a direct call) they report nothing', () => {
    const knowledgeBase = KnowledgeBase.loadFromDirectory(knowledgeDir, DEFAULT_CONFIG.knowledgeBase);
    for (const rule of flutterLayoutRules()) {
        assert.deepEqual(rule.evaluate({facts: [], analyzedFiles: new Set(), ruleSetId: 'default@1', knowledgeBase, lang: 'en'}), []);
    }
});

test('requiredFactKinds is truthful: evaluating on only those kinds yields identical findings', () => {
    const result = analyze({rootPath: fixtures, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    const knowledgeBase = KnowledgeBase.loadFromDirectory(knowledgeDir, DEFAULT_CONFIG.knowledgeBase);
    const analyzedFiles = new Set(result.facts.map((fact) => fact.subject.file));
    for (const rule of flutterLayoutRules()) {
        const kinds = new Set(rule.requiredFactKinds);
        const subset = result.facts.filter((fact) => kinds.has(fact.kind));
        const full = rule.evaluate({facts: result.facts, analyzedFiles, flutterWidgetGraph: buildFlutterWidgetGraph(result.facts), ruleSetId: 'default@1', knowledgeBase, lang: 'en'});
        const reduced = rule.evaluate({facts: subset, analyzedFiles, flutterWidgetGraph: buildFlutterWidgetGraph(subset), ruleSetId: 'default@1', knowledgeBase, lang: 'en'});
        assert.deepEqual(reduced, full, rule.id);
        assert.ok(full.length > 0, `${rule.id} fires on the fixtures`);
    }
});

test('determinism: two runs give byte-identical layout findings', () => {
    assert.equal(JSON.stringify(layoutFindings(fixtures)), JSON.stringify(layoutFindings(fixtures)));
});
