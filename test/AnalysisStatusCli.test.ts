import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// End-to-end CLI coverage for the exit-code table (0 = complete, 1 =
// execution/config/internal error, 2 = analysis incomplete) — exercised
// through the REAL `stoa analyze` process, not just Pipeline.ts/Cli.ts in
// isolation, so the actual wiring (not just the underlying logic) is proven.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixture = join(here, 'fixtures', 'sample');

interface CliRun {
    status: number;
    stdout: string;
    stderr: string;
}

const runCli = (args: string[], env: Record<string, string | undefined> = {}): CliRun => {
    const result = spawnSync('node', ['--import', 'tsx', 'src/Cli.ts', 'analyze', fixture, ...args], {
        cwd: root,
        encoding: 'utf8',
        env: {...process.env, ...env}
    });
    return {status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr};
};

test('exit 0: a genuinely complete scan, on every format', () => {
    for (const format of ['markdown', 'json', 'sarif']) {
        const result = runCli(['--format', format]);
        assert.equal(result.status, 0, `format=${format}`);
    }
});

test('exit 2: a memory-guard-forced incomplete scan never exits 0, on every format', () => {
    for (const format of ['markdown', 'json', 'sarif']) {
        const result = runCli(['--format', format], {STOA_TEST_FORCE_INCOMPLETE: '1'});
        assert.equal(result.status, 2, `format=${format}`);
    }
});

test('exit 2: a JSON report for an incomplete scan carries status "partial" and a non-empty excludedByReason.analysis_cancelled', () => {
    const result = runCli(['--format', 'json'], {STOA_TEST_FORCE_INCOMPLETE: '1'});
    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout) as {coverage: {status: string; analysisIncomplete?: boolean; excludedByReason: Record<string, number>}};
    assert.equal(report.coverage.status, 'partial');
    assert.equal(report.coverage.analysisIncomplete, true);
    assert.ok((report.coverage.excludedByReason.analysis_cancelled ?? 0) > 0);
});

test('exit 2: a SARIF report for an incomplete scan still has a valid envelope, with invocations.executionSuccessful true (the tool ran) and analysisStatus "partial"', () => {
    const result = runCli(['--format', 'sarif'], {STOA_TEST_FORCE_INCOMPLETE: '1'});
    assert.equal(result.status, 2);
    const sarif = JSON.parse(result.stdout) as {runs: Array<{invocations: Array<{executionSuccessful: boolean; properties: {analysisStatus: string}}>}>};
    assert.equal(sarif.runs[0]?.invocations[0]?.executionSuccessful, true);
    assert.equal(sarif.runs[0]?.invocations[0]?.properties.analysisStatus, 'partial');
});

test('exit 1: a config error (nonexistent --knowledge dir) never crashes with a bare stack trace — a clean error on stderr, and a parseable status:"failed" report on stdout', () => {
    for (const format of ['markdown', 'json', 'sarif']) {
        const result = runCli(['--knowledge', '/does/not/exist/stoa-knowledge', '--format', format]);
        assert.equal(result.status, 1, `format=${format}`);
        assert.ok(result.stderr.length > 0, `format=${format}: the error is visible on stderr`);
        assert.doesNotMatch(result.stderr, /at Object\.<anonymous>|node:internal/, `format=${format}: not a bare uncaught-exception stack trace`);
    }
});

test('exit 1: the failed-report JSON is valid and self-describing (status "failed", an error message, zero findings)', () => {
    const result = runCli(['--knowledge', '/does/not/exist/stoa-knowledge', '--format', 'json']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout) as {coverage: {status: string}; error?: string; findings: unknown[]};
    assert.equal(report.coverage.status, 'failed');
    assert.ok(typeof report.error === 'string' && report.error.length > 0);
    assert.deepEqual(report.findings, []);
});

test('exit 1: the failed-report SARIF envelope is still valid, with executionSuccessful: false', () => {
    const result = runCli(['--knowledge', '/does/not/exist/stoa-knowledge', '--format', 'sarif']);
    assert.equal(result.status, 1);
    const sarif = JSON.parse(result.stdout) as {runs: Array<{invocations: Array<{executionSuccessful: boolean; properties: {analysisStatus: string}}>}>};
    assert.equal(sarif.runs[0]?.invocations[0]?.executionSuccessful, false);
    assert.equal(sarif.runs[0]?.invocations[0]?.properties.analysisStatus, 'failed');
});

test('exit 1: the failed-report Markdown shows the status label and the error message, not a crash', () => {
    const result = runCli(['--knowledge', '/does/not/exist/stoa-knowledge', '--format', 'markdown']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Status/);
    assert.match(result.stdout, /ENOENT|no such file|not exist/i);
});

test('eval command: exit code still means precision/recall pass/fail, unaffected by the analyze command\'s new 0/1/2 scheme', () => {
    const expected = join(here, 'corpus', 'expected.json');
    const corpus = join(here, 'corpus', 'project');
    const result = spawnSync('node', ['--import', 'tsx', 'src/Cli.ts', 'eval', corpus, '--expected', expected], {cwd: root, encoding: 'utf8'});
    assert.equal(result.status, 0, 'the existing golden-corpus eval still passes cleanly');
});
