import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadArchitectureConfig, type ArchitectureConfig} from '../src/architecture/ArchitectureConfig.js';
import {initDart} from '../src/analysis/DartAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze, type AnalysisResult} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

// Flutter quality track E6d: R-SOLID-DIP-LAYER-DIRECTION stage 2 against the
// declared architecture (--solid --architecture), replacing stage 1.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixture = join(here, 'fixtures', 'solid', 'dip-declared');
const project = join(fixture, 'project');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const RULE = 'R-SOLID-DIP-LAYER-DIRECTION';

let architecture: ArchitectureConfig;
let result: AnalysisResult;

before(async () => {
    await initDart();
    architecture = loadArchitectureConfig(join(fixture, 'stoa.architecture.json'));
    result = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true, architecture});
});

const of = (findings: readonly Finding[]): Finding[] => findings.filter((finding) => finding.rule.id === RULE);
const brief = (findings: readonly Finding[], base: string = project): string[] =>
    of(findings).map((finding) => `${finding.location.file.slice(base.length + 1)}:${finding.location.range.startLine} ${finding.rule.version} ${finding.observation.statement}`);

test('E6d: forbidden layer edges (Dart import/export, TS incl. import type) and banned packages (Dart, dart:, npm, scoped) — one finding each', () => {
    assert.deepEqual(brief(result.report.findings), [
        'lib/data/repo.dart:1 0.3.0 repo.dart (layer data) depends on widget.dart (layer ui); the declared architecture does not allow data → ui.',
        'lib/ui/barrel.dart:1 0.3.0 barrel.dart (layer ui) depends on repo.dart (layer data); the declared architecture does not allow ui → data.',
        'lib/ui/page.dart:1 0.3.0 page.dart (layer ui) imports the package dart:io, which the declared architecture forbids for ui.',
        'lib/ui/page.dart:2 0.3.0 page.dart (layer ui) imports the package http, which the declared architecture forbids for ui.',
        'lib/ui/page.dart:5 0.3.0 page.dart (layer ui) depends on repo.dart (layer data); the declared architecture does not allow ui → data.',
        'web/ui/view.ts:1 0.3.0 view.ts (layer ui) imports the package axios, which the declared architecture forbids for ui.',
        'web/ui/view.ts:2 0.3.0 view.ts (layer ui) imports the package @scope/net, which the declared architecture forbids for ui.',
        'web/ui/view.ts:3 0.3.0 view.ts (layer ui) depends on api.ts (layer data); the declared architecture does not allow ui → data.',
        'web/ui/view.ts:4 0.3.0 view.ts (layer ui) depends on dto.ts (layer data); the declared architecture does not allow ui → data.'
    ]);
    // never: an allowed edge (ui → domain via the own package: URI), the same layer (page → widget),
    // an end without a layer (page → misc/helper, helper → data), a package that is not banned (provider)
});

test('E6d: finding shape — syntactic, medium, 0.9, stable (no maturity tag), marcus.cooperation; evidence names the layer and every site, type-only marked', () => {
    const view = of(result.report.findings).find((finding) => finding.location.range.startLine === 4 && finding.location.file.endsWith('view.ts')) as Finding;
    assert.deepEqual([view.certaintyBasis, view.severity, view.confidence, view.ruleMaturity], ['syntactic', 'medium', 0.9, undefined]);
    assert.deepEqual(view.interpretation.principles.map((principle) => principle.id), ['marcus.cooperation']);
    assert.deepEqual(view.observation.evidence.map((entry) => `${entry.fact}: ${String(entry.value)}`), [
        'architecture: web/ui/view.ts ∈ ui (stoa.architecture.json 1.0.0)',
        "deps.import: view.ts:4 import type '../data/dto' → web/data/dto.ts (data)"
    ]);
});

test('E6d: with a config the declaration REPLACES stage 1 (user decision); without --solid no SOLID finding, only the summary', () => {
    const dipLayer = join(here, 'fixtures', 'solid', 'dip-layer');
    const stage1 = analyze({rootPath: dipLayer, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true});
    assert.ok(of(stage1.report.findings).length > 0 && of(stage1.report.findings).every((finding) => finding.rule.version === '0.1.0'), 'stage 1 without a config');
    const unrelated = loadArchitectureConfig(join(fixture, 'unrelated.architecture.json'));
    const replaced = analyze({rootPath: dipLayer, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true, architecture: unrelated});
    assert.deepEqual(of(replaced.report.findings), [], 'no layer covers the files: unknown, and the heuristic does not run');
    const noSolid = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, architecture});
    assert.equal(noSolid.report.findings.filter((finding) => finding.rule.id.startsWith('R-SOLID-')).length, 0);
    assert.equal(noSolid.report.architecture?.layers.length, 3);
});

test('E6d: deterministic', () => {
    const again = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true, architecture});
    assert.equal(JSON.stringify(of(again.report.findings)), JSON.stringify(of(result.report.findings)));
});

// Semantic consolidation, phase 3 (0.3.0): the rule on the consolidated module
// model — TS re-exports judged, one finding per file pair, only `external`
// packages banned, aliases resolved, dynamic imports never judged.
const tsFixture = join(here, 'fixtures', 'solid', 'dip-declared-ts');
const tsProject = join(tsFixture, 'project');
const tsFindings = (): Finding[] =>
    of(analyze({rootPath: tsProject, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true, architecture: loadArchitectureConfig(join(tsFixture, 'stoa.architecture.json'))}).report.findings);
const sites = (finding: Finding): string[] => finding.observation.evidence.slice(1).map((entry) => `${entry.fact} ${entry.value}`);

test('phase 3: TS re-exports are dependencies — `export * from` a forbidden layer and from a banned package are reported as `export`', () => {
    const barrel = tsFindings().filter((finding) => finding.location.file.endsWith('barrel.ts'));
    assert.deepEqual(barrel.map((finding) => finding.location.symbol), ['src/data/api.ts', 'package:axios']);
    assert.deepEqual(barrel.map(sites), [
        ["deps.reexport barrel.ts:1 export '../data/api.js' → src/data/api.ts (data)"],
        ["deps.reexport barrel.ts:2 export 'axios' (package axios)"]
    ]);
});

test('phase 3: an import type and a re-export of ONE file are one dependency — one finding (one identity) citing both sites, type-only marked', () => {
    const both = tsFindings().filter((finding) => finding.location.file.endsWith('both.ts'));
    assert.equal(both.length, 1);
    assert.deepEqual(sites(both[0] as Finding), [
        "deps.import both.ts:1 import type '../data/types.js' → src/data/types.ts (data)",
        "deps.reexport both.ts:2 export type '../data/types.js' → src/data/types.ts (data)"
    ]);
});

test('phase 3: external packages stay separate from project modules — an unresolved tsconfig alias is never a banned package; a resolved alias is a layer edge', () => {
    const symbols = tsFindings().map((finding) => `${finding.location.file.slice(tsProject.length + 1)} ${finding.location.symbol ?? ''}`);
    assert.ok(symbols.includes('src/ui/alias.ts package:@scope/net'), 'a real (scoped) package is banned');
    assert.ok(!symbols.some((symbol) => symbol.includes('@app/missing')), '`@app/missing` matches the `@app/*` alias: a project reference that did not resolve, not a package — even though the config lists it');
    assert.ok(symbols.includes('src/ui/viaAlias.ts src/data/api.ts'), '`@app/data/api` resolves through the alias to the data layer');
});

test('phase 3: a dynamic import() is no recorded dependency and never a violation', () => {
    assert.ok(!tsFindings().some((finding) => finding.location.file.endsWith('lazy.ts')));
});

test('phase 3: exactly the expected findings on the TS fixture, deterministic, unique identities', () => {
    const first = tsFindings();
    assert.deepEqual(
        first.map((finding) => `${finding.location.file.slice(tsProject.length + 1)} ${finding.location.symbol ?? ''}`),
        ['src/ui/alias.ts package:@scope/net', 'src/ui/barrel.ts src/data/api.ts', 'src/ui/barrel.ts package:axios', 'src/ui/both.ts src/data/types.ts', 'src/ui/viaAlias.ts src/data/api.ts']
    );
    assert.equal(JSON.stringify(tsFindings()), JSON.stringify(first));
});
