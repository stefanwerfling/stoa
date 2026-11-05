import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {KnowledgeBase} from '../src/knowledge/KnowledgeBase.js';
import {analyze} from '../src/Pipeline.js';
import type {AnalysisResult} from '../src/Types.js';
import {solidRules} from '../src/rules/project/SolidRules.js';
import {SolidSrpResponsibilityCohesionRule} from '../src/rules/project/SolidSrpRule.js';
import type {ProjectRuleInput} from '../src/rules/ProjectRule.js';
import type {Finding} from '../src/Types.js';

// Flutter quality track E6e: R-SOLID-SRP-RESPONSIBILITY-COHESION — built and
// tested, but NOT registered (not even with --solid) until the real-app
// candidates are classified by hand (OQ-6). The rule is called directly here.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const project = join(here, 'fixtures', 'solid', 'srp');
const knowledgeBase = KnowledgeBase.loadFromDirectory(join(root, 'knowledge', 'marcus'), 'marcus@1');
const RULE = 'R-SOLID-SRP-RESPONSIBILITY-COHESION';

let result: AnalysisResult;
let findings: Finding[];

const inputOf = (lang: string): ProjectRuleInput => ({
    facts: result.facts,
    analyzedFiles: new Set(result.facts.map((fact) => fact.subject.file)),
    ruleSetId: 'default@test',
    knowledgeBase,
    lang
});

before(async () => {
    await initDart();
    result = analyze({rootPath: project, knowledgeDir: join(root, 'knowledge', 'marcus'), ruleSetDir: join(root, 'rules', 'default'), config: DEFAULT_CONFIG, solid: true});
    findings = new SolidSrpResponsibilityCohesionRule().evaluate(inputOf('en'));
});

test('E6e: a class whose members split into ≥ 2 groups with disjoint own fields and disjoint import groups is reported once, listing every group', () => {
    assert.deepEqual(
        findings.map((finding) => `${finding.location.file.slice(project.length + 1)}:${finding.location.range.startLine} ${finding.location.symbol}`),
        ['lib/mixed.dart:6 Mixed', 'lib/mixed.dart:69 Property', 'ts/service.ts:5 UserService']
    );
    const mixed = findings[0] as Finding;
    assert.equal(mixed.observation.statement, 'Mixed splits into 2 independent responsibilities: {fetch, ping} / {load, store}.');
    assert.deepEqual(mixed.observation.evidence.map((entry) => entry.value), [
        'group 1: {fetch, ping} uses _last, _net and net.dart, prefix:http',
        'group 2: {load, store} uses _cache and cache.dart'
    ]);
    // TS: a lower-case imported function resolves to its module, not to a Dart prefix
    assert.deepEqual((findings[2] as Finding).observation.evidence.map((entry) => entry.value), [
        'group 1: {notify} uses mailer and mailer.ts, node:fs',
        'group 2: {save} uses store and store.ts'
    ]);
    // a getter and its setter form one property
    assert.equal((findings[1] as Finding).observation.evidence[1]?.value, 'group 2: {set value, value} uses _cache and cache.dart');
});

test('E6e: shared state, a shared dependency, groups without dependency (plain data, dart:core only), inherited or framework members, test doubles and test paths are never reported', () => {
    const symbols = new Set(findings.map((finding) => finding.location.symbol));
    for (const excluded of ['Cohesive', 'SharedImport', 'PlainData', 'CoreOnly', 'SubMixed', 'MockMixed', 'SplitPage', 'Helper', 'Together']) {
        assert.ok(!symbols.has(excluded), excluded);
    }
});

test('E6e: finding shape — semantic-heuristic, info, 0.4, marcus.purpose / responsibility-boundaries, localized', () => {
    const mixed = findings[0] as Finding;
    assert.deepEqual([mixed.certaintyBasis, mixed.severity, mixed.confidence], ['semantic-heuristic', 'info', 0.4]);
    assert.equal(new SolidSrpResponsibilityCohesionRule().maturity, 'experimental');
    assert.deepEqual(mixed.interpretation.principles.map((principle) => principle.id), ['marcus.purpose']);
    assert.deepEqual(mixed.interpretation.dimensions, ['responsibility-boundaries']);
    const german = new SolidSrpResponsibilityCohesionRule().evaluate(inputOf('de'))[0] as Finding;
    assert.equal(german.observation.statement, 'Mixed zerfällt in 2 unabhängige Verantwortlichkeiten: {fetch, ping} / {load, store}.');
});

test('E6e: not registered — even with --solid the pipeline reports no SRP finding (OQ-6), and the rule is deterministic', () => {
    assert.ok(!solidRules().some((rule) => rule.id === RULE));
    assert.equal(result.report.findings.filter((finding) => finding.rule.id === RULE).length, 0);
    assert.equal(JSON.stringify(new SolidSrpResponsibilityCohesionRule().evaluate(inputOf('en'))), JSON.stringify(findings));
});
