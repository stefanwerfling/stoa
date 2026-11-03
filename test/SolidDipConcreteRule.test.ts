import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze, type AnalysisResult} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

// Flutter quality track E6c: R-SOLID-DIP-CONCRETE-DEPENDENCY (opt-in via --solid).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const project = join(here, 'fixtures', 'solid', 'dip-concrete');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const RULE = 'R-SOLID-DIP-CONCRETE-DEPENDENCY';

let withSolid: AnalysisResult;
let withoutSolid: AnalysisResult;

before(async () => {
    await initDart();
    withSolid = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true});
    withoutSolid = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
});

const findings = (): Finding[] => withSolid.report.findings.filter((finding) => finding.rule.id === RULE);

test('E6c: a UI class creating, statically calling or reading a concrete data-access class is reported once per target, at the first site, listing every site', () => {
    assert.deepEqual(
        findings().map((finding) => `${finding.location.file.slice(project.length + 1)}:${finding.location.range.startLine} ${finding.location.symbol}`),
        ['lib/ui/page.dart:18 _ApiPageState:Api']
    );
    const [finding] = findings() as [Finding];
    assert.equal(finding.observation.statement, 'UI class _ApiPageState binds itself to the concrete data-access class Api (api.dart): Api(), data.Api(), Api.avatarUrl(), Api.base, Api.instance.');
    assert.deepEqual(finding.observation.evidence.map((entry) => entry.value), [
        '_ApiPageState extends State (package:flutter)',
        'Api (api.dart) — concrete class in a data-access library',
        'page.dart:18 api creates Api()',
        'page.dart:19 other creates data.Api()',
        'page.dart:21 refresh calls Api.avatarUrl()',
        'page.dart:21 refresh reads Api.base',
        'page.dart:21 refresh reads Api.instance'
    ]);
    assert.ok(!finding.observation.statement.includes('mystery'), 'a Type.name() that is neither a constructor nor a static method is unknown');
});

test('E6c: abstractions (factory of an abstract class), models without data access, state holders, DI lookups, ambiguous names, non-UI classes and the composition root (a library with a top-level main) are never reported', () => {
    const symbols = findings().map((finding) => finding.location.symbol ?? '');
    for (const excluded of ['CleanPage', 'AmbiguousPage', 'Sync', 'RootApp']) {
        assert.ok(!symbols.some((symbol) => symbol.startsWith(`${excluded}:`)), excluded);
    }
});

test('E6c: finding shape — semantic-heuristic, low, 0.5 (within the cap), experimental, marcus.cooperation / dependencies', () => {
    const [finding] = findings() as [Finding];
    assert.deepEqual([finding.certaintyBasis, finding.severity, finding.confidence, finding.ruleMaturity], ['semantic-heuristic', 'low', 0.5, 'experimental']);
    assert.deepEqual(finding.interpretation.principles.map((principle) => principle.id), ['marcus.cooperation']);
    assert.deepEqual(finding.interpretation.dimensions, ['dependencies']);
});

test('E6c: without --solid no SOLID finding; with it deterministic', () => {
    assert.equal(withoutSolid.report.findings.filter((finding) => finding.rule.id.startsWith('R-SOLID-')).length, 0);
    const again = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true});
    assert.equal(JSON.stringify(again.report.findings), JSON.stringify(withSolid.report.findings));
});
