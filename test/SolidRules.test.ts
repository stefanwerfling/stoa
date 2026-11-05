import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {applyFindingFilter} from '../src/FindingFilter.js';
import {KnowledgeBase} from '../src/knowledge/KnowledgeBase.js';
import {analyze} from '../src/Pipeline.js';
import type {AnalysisResult} from '../src/Types.js';
import {SolidDipLayerDirectionRule} from '../src/rules/project/SolidRules.js';
import type {ProjectRuleInput} from '../src/rules/ProjectRule.js';
import type {Fact, Finding} from '../src/Types.js';

// Flutter quality track E6a: R-SOLID-DIP-LAYER-DIRECTION stage 1 (opt-in via --solid).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const project = join(here, 'fixtures', 'solid', 'dip-layer');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const RULE = 'R-SOLID-DIP-LAYER-DIRECTION';

let withSolid: AnalysisResult;
let withoutSolid: AnalysisResult;

before(async () => {
    await initDart();
    withSolid = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true});
    withoutSolid = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
});

const local = (file: string): string => file.slice(project.length + 1);
const brief = (findings: readonly Finding[]): string[] =>
    findings.filter((finding) => finding.rule.id === RULE).map((finding) => `${local(finding.location.file)}:${finding.location.range.startLine} ${finding.observation.statement}`);

test('E6a: a UI library importing a data-access package or a project data-access module is reported once, at its first such import', () => {
    assert.deepEqual(brief(withSolid.report.findings), [
        'lib/ui/direct_page.dart:2 UI library direct_page.dart (DirectPage) depends directly on data access: shared_preferences.',
        // the UI class lives in the part, the import in the library file
        'lib/ui/part_host.dart:2 UI library part_host.dart (PartWidget) depends directly on data access: http.',
        // a package: and a relative import of project modules whose only role is data access
        'lib/ui/service_page.dart:2 UI library service_page.dart (ServicePage, _ServicePageState) depends directly on data access: api.dart, store.dart.',
        // state holders (ChangeNotifier subclass/mixin, GetxController) are not targets; a project class NAMED ChangeNotifier is no state holder
        'lib/ui/state_page.dart:5 UI library state_page.dart (StatePage) depends directly on data access: fake_notifier.dart.'
    ]);
});

test('E6a: negative and unknown cases stay silent (no data access, dart:io for Platform or without show, UI → UI import, export only, foreign or shadowed base, non-UI importer)', () => {
    const reported = new Set(withSolid.report.findings.filter((finding) => finding.rule.id === RULE).map((finding) => local(finding.location.file)));
    for (const file of ['lib/ui/clean_page.dart', 'lib/ui/platform_page.dart', 'lib/ui/undecided_page.dart', 'lib/ui/imports_ui.dart', 'lib/ui/export_only.dart', 'lib/ui/getx_page.dart', 'lib/ui/shadow_page.dart', 'lib/data/repo.dart', 'lib/data/api.dart']) {
        assert.equal(reported.has(file), false, file);
    }
});

test('E6a: finding shape — experimental, semantic-heuristic 0.5, low, cooperation + control, dependencies; evidence names classes and imports', () => {
    const finding = withSolid.report.findings.find((candidate) => candidate.rule.id === RULE && candidate.location.file.endsWith('service_page.dart')) as Finding;
    assert.equal(finding.ruleMaturity, 'experimental');
    assert.equal(finding.certaintyBasis, 'semantic-heuristic');
    assert.equal(finding.confidence, 0.5);
    assert.equal(finding.severity, 'low');
    assert.deepEqual(finding.interpretation.principles.map((principle) => principle.id), ['marcus.cooperation', 'marcus.control']);
    assert.deepEqual(finding.interpretation.dimensions, ['dependencies']);
    assert.deepEqual(finding.location.symbol, 'ServicePage');
    assert.deepEqual(finding.observation.evidence.map((evidence) => evidence.value), [
        'ServicePage extends StatefulWidget (package:flutter)',
        '_ServicePageState extends State (package:flutter)',
        "service_page.dart:2 import 'package:dip_app/data/api.dart' → api.dart (data access: http)",
        "service_page.dart:3 import '../data/store.dart' → store.dart (data access: dart:io)"
    ]);
    assert.ok((finding.missingContext?.[0] ?? '').startsWith('Library level only'));
});

test('E6a: without --solid not a single SOLID finding, and every other finding is identical', () => {
    assert.equal(withoutSolid.report.findings.some((finding) => finding.rule.id.startsWith('R-SOLID-')), false);
    assert.deepEqual(
        withSolid.report.findings.filter((finding) => !finding.rule.id.startsWith('R-SOLID-')),
        withoutSolid.report.findings
    );
});

test('E6a: --no-experimental hides the hints and counts them', () => {
    const filtered = applyFindingFilter(withSolid.report, {excludeExperimental: true});
    assert.equal(filtered.findings.some((finding) => finding.rule.id === RULE), false);
    assert.equal(filtered.filter?.hiddenCount, 4);
});

test('E6a: German text, and deterministic under reversed fact order', () => {
    const german = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true, lang: 'de'});
    assert.match(brief(german.report.findings)[0] ?? '', /UI-Bibliothek direct_page\.dart \(DirectPage\) hängt direkt von Datenzugriff ab: shared_preferences\./);

    const knowledgeBase = KnowledgeBase.loadFromDirectory(knowledgeDir, DEFAULT_CONFIG.knowledgeBase);
    const inputOf = (facts: Fact[]): ProjectRuleInput => ({facts, analyzedFiles: new Set(facts.map((fact) => fact.subject.file)), ruleSetId: 'default@test', knowledgeBase, lang: 'en'});
    const rule = new SolidDipLayerDirectionRule();
    const forward = rule.evaluate(inputOf(withSolid.facts));
    const reversed = rule.evaluate(inputOf([...withSolid.facts].reverse()));
    assert.equal(JSON.stringify(reversed), JSON.stringify(forward));
    // Without the pipeline's package map the own package: URI stays opaque: only
    // the relative store.dart import is seen for service_page — never a guess.
    assert.ok(forward.some((finding) => finding.location.file.endsWith('service_page.dart') && finding.observation.statement.endsWith('store.dart.')));
});
