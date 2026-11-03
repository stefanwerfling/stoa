import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze, type AnalysisResult} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

// Flutter quality track E6b: R-SOLID-LSP-CONTRACT-COMPATIBILITY and
// R-SOLID-ISP-INTERFACE-COHESION over the TypeModel (opt-in via --solid).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const project = join(here, 'fixtures', 'solid', 'contracts');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const LSP = 'R-SOLID-LSP-CONTRACT-COMPATIBILITY';
const ISP = 'R-SOLID-ISP-INTERFACE-COHESION';

let withSolid: AnalysisResult;
let withoutSolid: AnalysisResult;

before(async () => {
    await initDart();
    withSolid = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true});
    withoutSolid = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
});

const of = (rule: string, findings: readonly Finding[] = withSolid.report.findings): Finding[] => findings.filter((finding) => finding.rule.id === rule);
const brief = (rule: string): string[] => of(rule).map((finding) => `${finding.location.file.slice(project.length + 1)}:${finding.location.range.startLine} ${finding.location.symbol}`);

test('E6b LSP: an override that only throws unsupported against a CONCRETE project member — extends, implements, mixin on, without @override, Dart and TS', () => {
    assert.deepEqual(brief(LSP), [
        'dart/lib/birds.dart:7 Penguin.fly',
        'dart/lib/birds.dart:12 Kiwi.fly',
        'dart/lib/birds.dart:18 Drone.fly',
        'dart/lib/birds.dart:45 Grounded.fly',
        'dart/lib/shape.dart:18 Square.describe',
        'dart/lib/shape.dart:22 Square.reset',
        'ts/impl.ts:6 ReadOnlyStore.save',
        'ts/impl.ts:17 Once.stop'
    ]);
});

test('E6b LSP: abstract base members, other throws, test doubles, test paths and unresolved bases are never reported', () => {
    const symbols = new Set(of(LSP).map((finding) => finding.location.symbol));
    for (const excluded of ['Square.area', 'Once.run', 'Tired.fly', 'MockBird.fly', 'FakeStore.save', 'Mystery.fly', 'Local.save', 'Ostrich.fly']) {
        assert.ok(!symbols.has(excluded), excluded);
    }
});

test('E6b ISP: ≥ 2 abstract contract members fulfilled empty or only-throwing → one finding per (class, contract)', () => {
    assert.deepEqual(brief(ISP), ['dart/lib/listener.dart:16 Partial:Listener', 'dart/lib/listener.dart:56 Refuses:Listener', 'ts/impl.ts:23 Some:Handler']);
    assert.equal(of(ISP)[0]?.observation.statement, 'Partial implements Listener but fulfils 2 of its members only formally: onStop, onPause.');
    // Mostly (1 empty), Quiet (concrete hooks), StubListener (name), Adapter (package interface), Silent (test path), Most (1 empty): none
});

test('E6b: finding shape — certainty, severity, confidence, maturity, principles, evidence names both sides', () => {
    const lsp = of(LSP).find((finding) => finding.location.symbol === 'Penguin.fly') as Finding;
    assert.deepEqual([lsp.certaintyBasis, lsp.severity, lsp.confidence, lsp.ruleMaturity], ['syntactic', 'low', 0.8, 'experimental']);
    assert.deepEqual(lsp.interpretation.principles.map((principle) => principle.id), ['marcus.judgment']);
    assert.deepEqual(lsp.interpretation.dimensions, ['responsibility-boundaries']);
    assert.deepEqual(lsp.observation.evidence.map((entry) => entry.value), [
        'Penguin (birds.dart):7 fly (override) — body only throws UnsupportedError',
        'Bird (bird.dart):2 fly — concrete (normal body)'
    ]);
    const isp = of(ISP).find((finding) => finding.location.symbol === 'Some:Handler') as Finding;
    assert.deepEqual([isp.certaintyBasis, isp.severity, isp.confidence, isp.ruleMaturity], ['syntactic', 'info', 0.7, 'experimental']);
    assert.deepEqual(isp.interpretation.principles.map((principle) => principle.id), ['marcus.purpose']);
    assert.deepEqual(isp.observation.evidence.map((entry) => entry.value), ['Some (impl.ts) → Handler (base.ts) (interface)', 'impl.ts:24 a — empty body', 'impl.ts:26 b — empty body']);
});

test('E6b: without --solid not a single SOLID finding; with it the run is deterministic', () => {
    assert.equal(withoutSolid.report.findings.filter((finding) => finding.rule.id.startsWith('R-SOLID-')).length, 0);
    const again = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true});
    assert.equal(JSON.stringify(again.report.findings), JSON.stringify(withSolid.report.findings));
});
