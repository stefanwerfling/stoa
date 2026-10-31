import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {applyBaseline, loadBaseline, onlyNewFindings, saveBaseline} from '../src/Baseline.js';
import {toMarkdown} from '../src/reporting/Reporter.js';
import {toSarif} from '../src/reporting/SarifReporter.js';
import type {AnalysisReport, Finding} from '../src/Types.js';

const sampleFinding = (file: string, ruleId: string, symbol: string): Finding => ({
    id: `finding:${ruleId}:${file}:${symbol}`,
    rule: {id: ruleId, version: '1.0.0'},
    ruleSet: 'default@1',
    location: {file, range: {startLine: 1, startCol: 0, endLine: 1, endCol: 0}, symbol},
    observation: {statement: 'x', evidence: []},
    interpretation: {principles: [], dimensions: []},
    severity: 'low',
    confidence: 0.5,
    certaintyBasis: 'syntactic',
    remediation: {suggestion: 'x'},
    source: 'deterministic'
});

const reportOf = (findings: Finding[]): AnalysisReport => ({
    versions: {engine: '0.1.0', ruleSet: 'default@1', knowledgeBase: 'marcus@1', adapters: {}},
    coverage: {filesSelected: 1, filesAnalyzed: 1, filesSkipped: 0, factCount: 0},
    findings
});

test('loadBaseline returns null for a path that does not exist yet (the natural first-run state, not an error)', () => {
    assert.equal(loadBaseline('/does/not/exist/baseline.json'), null);
});

test('saveBaseline + loadBaseline roundtrip, sorted deterministically regardless of input order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-baseline-'));
    try {
        const path = join(dir, 'baseline.json');
        const findings = [sampleFinding('/root/b.ts', 'R-B', 'sym#0'), sampleFinding('/root/a.ts', 'R-A', 'sym#0')];
        saveBaseline(path, findings, '/root');
        const loaded = loadBaseline(path);
        assert.ok(loaded !== null);
        assert.equal(loaded.version, 1);
        assert.deepEqual(loaded.findings, [
            {file: 'a.ts', rule: 'R-A', symbol: 'sym#0'},
            {file: 'b.ts', rule: 'R-B', symbol: 'sym#0'}
        ]);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('a malformed baseline file throws (never silently treated as "no baseline" — that would mislabel every known finding as new)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-baseline-'));
    try {
        const path = join(dir, 'baseline.json');
        writeFileSync(path, '{ not valid json');
        assert.throws(() => loadBaseline(path), /not valid JSON/);

        writeFileSync(path, JSON.stringify({version: 1, findings: 'not-an-array'}));
        assert.throws(() => loadBaseline(path), /malformed/);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('applyBaseline: a finding present in the baseline is "known", one absent from it is "new"', () => {
    const baseline = {version: 1 as const, findings: [{file: 'a.ts', rule: 'R-A', symbol: 'sym#0'}]};
    const report = reportOf([sampleFinding('/root/a.ts', 'R-A', 'sym#0'), sampleFinding('/root/b.ts', 'R-B', 'sym#0')]);
    const result = applyBaseline(report, baseline, '/root');
    assert.equal(result.findings[0]?.baselineStatus, 'known');
    assert.equal(result.findings[1]?.baselineStatus, 'new');
    assert.deepEqual(result.baseline, {newCount: 1, knownCount: 1, fixedCount: 0, fixed: []});
});

test('applyBaseline: a baseline entry no longer reproduced by the current run is reported as "fixed", not fabricated as a Finding', () => {
    const baseline = {version: 1 as const, findings: [{file: 'a.ts', rule: 'R-A', symbol: 'sym#0'}, {file: 'gone.ts', rule: 'R-GONE', symbol: 'sym#0'}]};
    const report = reportOf([sampleFinding('/root/a.ts', 'R-A', 'sym#0')]);
    const result = applyBaseline(report, baseline, '/root');
    assert.equal(result.findings.length, 1, 'no extra Finding was invented for the fixed entry');
    assert.equal(result.baseline?.fixedCount, 1);
    assert.deepEqual(result.baseline?.fixed, [{file: 'gone.ts', rule: 'R-GONE', symbol: 'sym#0'}]);
});

test('applyBaseline with no baseline file yet (null): every finding is "new", nothing is "fixed"', () => {
    const report = reportOf([sampleFinding('/root/a.ts', 'R-A', 'sym#0')]);
    const result = applyBaseline(report, null, '/root');
    assert.equal(result.findings[0]?.baselineStatus, 'new');
    assert.deepEqual(result.baseline, {newCount: 1, knownCount: 0, fixedCount: 0, fixed: []});
});

test('onlyNewFindings filters out "known" findings but keeps "new" ones; is a no-op if baselineStatus was never set', () => {
    const baseline = {version: 1 as const, findings: [{file: 'a.ts', rule: 'R-A', symbol: 'sym#0'}]};
    const report = reportOf([sampleFinding('/root/a.ts', 'R-A', 'sym#0'), sampleFinding('/root/b.ts', 'R-B', 'sym#0')]);
    const stamped = applyBaseline(report, baseline, '/root');
    const filtered = onlyNewFindings(stamped);
    assert.equal(filtered.findings.length, 1);
    assert.equal(filtered.findings[0]?.location.file, '/root/b.ts');

    const unstamped = reportOf([sampleFinding('/root/a.ts', 'R-A', 'sym#0')]);
    assert.deepEqual(onlyNewFindings(unstamped).findings, unstamped.findings);
});

test('Markdown reporter: shows a baseline summary line and tags each finding [new]/[known]', () => {
    const baseline = {version: 1 as const, findings: [{file: 'a.ts', rule: 'R-A', symbol: 'sym#0'}]};
    const report = reportOf([sampleFinding('/root/a.ts', 'R-A', 'sym#0'), sampleFinding('/root/b.ts', 'R-B', 'sym#0')]);
    const stamped = applyBaseline(report, baseline, '/root');
    const markdown = toMarkdown(stamped);
    assert.match(markdown, /Baseline: 1 new, 1 known, 0 fixed/);
    assert.match(markdown, /R-A.*\[known\]/);
    assert.match(markdown, /R-B.*\[new\]/);
});

test('Markdown reporter: no baseline line at all when baseline was never applied', () => {
    const report = reportOf([sampleFinding('/root/a.ts', 'R-A', 'sym#0')]);
    assert.ok(!toMarkdown(report).includes('Baseline:'));
});

test('SARIF reporter: baselineState is "new"/"unchanged" per finding, absent entirely without a baseline', () => {
    const baseline = {version: 1 as const, findings: [{file: 'a.ts', rule: 'R-A', symbol: 'sym#0'}]};
    const report = reportOf([sampleFinding('/root/a.ts', 'R-A', 'sym#0'), sampleFinding('/root/b.ts', 'R-B', 'sym#0')]);
    const stamped = applyBaseline(report, baseline, '/root');
    const sarif = JSON.parse(toSarif(stamped, {baseDir: '/root'})) as {runs: Array<{results: Array<{ruleId: string; baselineState?: string}>}>};
    const results = sarif.runs[0]?.results ?? [];
    assert.equal(results.find((r) => r.ruleId === 'R-A')?.baselineState, 'unchanged');
    assert.equal(results.find((r) => r.ruleId === 'R-B')?.baselineState, 'new');

    const plainSarif = JSON.parse(toSarif(report, {baseDir: '/root'})) as {runs: Array<{results: Array<{baselineState?: string}>}>};
    assert.ok(plainSarif.runs[0]?.results.every((r) => r.baselineState === undefined));
});
