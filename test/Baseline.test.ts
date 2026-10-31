import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {applyBaseline, IncompleteAnalysisError, loadBaseline, onlyNewFindings, saveBaseline} from '../src/Baseline.js';
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

const incompleteReportOf = (findings: Finding[]): AnalysisReport => ({
    versions: {engine: '0.1.0', ruleSet: 'default@1', knowledgeBase: 'marcus@1', adapters: {}},
    coverage: {filesSelected: 10, filesAnalyzed: 3, filesSkipped: 0, factCount: 0, analysisIncomplete: true, stoppedAtFile: '/root/d.ts'},
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
        saveBaseline(path, reportOf(findings), '/root');
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

// Phase 5.1 — baseline SCHEMA validation, not just "findings is an array".

test('loadBaseline rejects a baseline whose entries are missing required fields, have the wrong type, or duplicate an identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-baseline-'));
    try {
        const path = join(dir, 'baseline.json');

        writeFileSync(path, JSON.stringify({version: 2, findings: []}));
        assert.throws(() => loadBaseline(path), /"version" must be 1/);

        writeFileSync(path, JSON.stringify({version: 1, findings: [{file: 'a.ts', rule: 'R-A'}]}));
        assert.throws(() => loadBaseline(path), /findings\[0\]/, 'missing "symbol" field');

        writeFileSync(path, JSON.stringify({version: 1, findings: [{file: 'a.ts', rule: 'R-A', symbol: 7}]}));
        assert.throws(() => loadBaseline(path), /findings\[0\]/, 'symbol must be a string, not a number');

        writeFileSync(path, JSON.stringify({version: 1, findings: [{file: '', rule: 'R-A', symbol: 'x'}]}));
        assert.throws(() => loadBaseline(path), /findings\[0\]/, 'file must be non-empty');

        writeFileSync(
            path,
            JSON.stringify({
                version: 1,
                findings: [
                    {file: 'a.ts', rule: 'R-A', symbol: 'x'},
                    {file: 'a.ts', rule: 'R-A', symbol: 'x'}
                ]
            })
        );
        assert.throws(() => loadBaseline(path), /duplicates an earlier entry/);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('loadBaseline rejects a directory path with a clear error instead of an unrelated read-error message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-baseline-'));
    try {
        assert.throws(() => loadBaseline(dir), /is a directory, not a file/);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

// Phase 2 — baseline integrity under an INCOMPLETE analysis
// (coverage.analysisIncomplete === true, see MemoryGuard.ts).

test('applyBaseline on an incomplete analysis: a missing baseline entry is NEVER reported as fixed', () => {
    const baseline = {version: 1 as const, findings: [{file: 'a.ts', rule: 'R-A', symbol: 'sym#0'}, {file: 'gone.ts', rule: 'R-GONE', symbol: 'sym#0'}]};
    const report = incompleteReportOf([sampleFinding('/root/a.ts', 'R-A', 'sym#0')]);
    const result = applyBaseline(report, baseline, '/root');
    assert.equal(result.baseline?.fixedCount, 0, 'fixedCount must be 0 — the scan never reached enough of the project to prove "gone.ts" is actually gone');
    assert.deepEqual(result.baseline?.fixed, []);
    assert.equal(result.baseline?.incomplete, true, 'the comparison is marked provisional');
});

test('applyBaseline on a COMPLETE analysis still correctly reports fixed entries (the incomplete guard does not weaken the normal case)', () => {
    const baseline = {version: 1 as const, findings: [{file: 'a.ts', rule: 'R-A', symbol: 'sym#0'}, {file: 'gone.ts', rule: 'R-GONE', symbol: 'sym#0'}]};
    const report = reportOf([sampleFinding('/root/a.ts', 'R-A', 'sym#0')]);
    const result = applyBaseline(report, baseline, '/root');
    assert.equal(result.baseline?.fixedCount, 1);
    assert.equal(result.baseline?.incomplete, undefined);
});

test('saveBaseline refuses to write when the analysis was incomplete, and the existing baseline file is left byte-identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-baseline-'));
    try {
        const path = join(dir, 'baseline.json');
        const completeReport = reportOf([sampleFinding('/root/a.ts', 'R-A', 'sym#0')]);
        saveBaseline(path, completeReport, '/root');
        const before = readFileSync(path, 'utf8');

        const incompleteReport = incompleteReportOf([sampleFinding('/root/b.ts', 'R-B', 'sym#0')]);
        assert.throws(() => saveBaseline(path, incompleteReport, '/root'), IncompleteAnalysisError);

        const after = readFileSync(path, 'utf8');
        assert.equal(after, before, 'the existing baseline must be byte-identical — the write must never even start');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('saveBaseline on a COMPLETE analysis still works (the incomplete guard does not block the normal case)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-baseline-'));
    try {
        const path = join(dir, 'baseline.json');
        saveBaseline(path, reportOf([sampleFinding('/root/a.ts', 'R-A', 'sym#0')]), '/root');
        const loaded = loadBaseline(path);
        assert.deepEqual(loaded?.findings, [{file: 'a.ts', rule: 'R-A', symbol: 'sym#0'}]);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});
