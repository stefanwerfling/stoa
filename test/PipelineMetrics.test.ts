import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze, type AnalyzeOptions} from '../src/Pipeline.js';
import type {PipelineMetrics} from '../src/PipelineMetrics.js';
import type {AnalysisResult} from '../src/Types.js';

// Phase 4 of the evaluator-integrity track: opt-in, observational measurement
// of a run (`AnalyzeOptions.onMetrics`, CLI `--memory-stats`).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const solidFixtures = join(here, 'fixtures', 'solid');

before(async () => {
    await initDart();
});

const measured = (extra: Partial<AnalyzeOptions> = {}): {result: AnalysisResult; metrics: PipelineMetrics[]} => {
    const metrics: PipelineMetrics[] = [];
    const result = analyze({rootPath: solidFixtures, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, onMetrics: (m) => metrics.push(m), ...extra});
    return {result, metrics};
};

/** The deterministic half of the metrics (no timings, no RSS). */
const counts = (m: PipelineMetrics): Omit<PipelineMetrics, 'timingsMs' | 'peakRssBytes'> => {
    const {timingsMs: _timings, peakRssBytes: _rss, ...rest} = m;
    return rest;
};

test('called once; the counts agree with the report and the facts', () => {
    const {result, metrics} = measured({solid: true});
    assert.equal(metrics.length, 1);
    const m = metrics[0] as PipelineMetrics;
    assert.equal(m.facts, result.facts.length);
    assert.equal(m.facts, result.report.coverage.factCount);
    assert.equal(m.findings, result.report.findings.length);
    assert.deepEqual(
        [m.files.selected, m.files.analyzed, m.files.skipped, m.files.cancelled],
        [result.report.coverage.filesSelected, result.report.coverage.filesAnalyzed, result.report.coverage.filesSkipped, result.report.coverage.filesCancelled]
    );
    assert.equal(m.moduleGraph.nodes, m.files.analyzed);
    assert.ok(m.moduleGraph.edges > 0);
});

test('SymbolGraph and TypeModel are reported only when built: not for code without types, with counts when a rule needs them', () => {
    // No class, interface or mixin: no rule needs the TypeModel (R-FN-TOO-MANY-PARAMS reads
    // `type.overridesMember` only where a type is declared), so neither graph is built.
    const plain = measured({rootPath: join(here, 'fixtures', 'backend-validation', 'unvalidated.ts')}).metrics[0] as PipelineMetrics;
    assert.equal(plain.symbolGraph, null);
    assert.equal(plain.typeModel, null);
    // Declared types without --solid: R-FN-TOO-MANY-PARAMS needs the TypeModel (override facts).
    const typed = measured().metrics[0] as PipelineMetrics;
    assert.ok(typed.symbolGraph !== null && typed.typeModel !== null && typed.typeModel.types > 0);
    const solid = measured({solid: true}).metrics[0] as PipelineMetrics;
    assert.ok(solid.symbolGraph !== null && solid.symbolGraph.bindings > 0);
    assert.equal(Object.values(solid.symbolGraph.byStatus).reduce((sum, n) => sum + n, 0), solid.symbolGraph.bindings);
    assert.ok(solid.typeModel !== null && solid.typeModel.types > 0);
});

test('reproducible: the counts are identical across runs; timings are non-negative and within the total; peak RSS is positive', () => {
    const first = measured({solid: true}).metrics[0] as PipelineMetrics;
    const second = measured({solid: true}).metrics[0] as PipelineMetrics;
    assert.deepEqual(counts(first), counts(second));
    const t = first.timingsMs;
    for (const value of [t.discovery, t.read, t.extraction, t.graphs, t.evaluation]) {
        assert.ok(value >= 0);
    }
    assert.ok(t.discovery + t.read + t.extraction + t.graphs + t.evaluation <= t.total + 1);
    assert.ok(first.peakRssBytes > 0);
});

test('observational only: the report is identical with and without onMetrics', () => {
    const without = analyze({rootPath: solidFixtures, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true});
    const withMetrics = measured({solid: true}).result;
    assert.deepEqual(withMetrics.report, without.report);
});

test('CLI --memory-stats: a readable summary and one parseable metrics-json line on stderr; stdout unchanged', () => {
    const run = (extra: string[]): {stdout: string; stderr: string; status: number | null} =>
        spawnSync('node', ['--import', 'tsx', 'src/Cli.ts', 'analyze', solidFixtures, '--solid', '--format', 'json', ...extra], {cwd: root, encoding: 'utf8'});
    const plain = run([]);
    const stats = run(['--memory-stats']);
    assert.equal(stats.status, plain.status);
    assert.equal(stats.stdout, plain.stdout);
    assert.match(stats.stderr, /\[stoa\] metrics: \d+ files \| \d+ facts \| \d+ findings/);
    assert.match(stats.stderr, /\[stoa\] timings \(ms\): discovery [\d.]+ \| read [\d.]+ \| extraction [\d.]+ \| graphs [\d.]+ \| evaluation [\d.]+ \| total [\d.]+ \| peak rss \d+ MB/);
    const line = stats.stderr.split('\n').find((candidate) => candidate.startsWith('[stoa] metrics-json '));
    assert.ok(line !== undefined);
    const parsed = JSON.parse(line.slice('[stoa] metrics-json '.length)) as PipelineMetrics;
    assert.equal(parsed.findings, (JSON.parse(plain.stdout) as {findings: unknown[]}).findings.length);
    assert.equal(plain.stderr.includes('metrics-json'), false);
});
