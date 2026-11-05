import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// End-to-end CLI coverage for Section 2 ("Baseline-Integrität") of the
// Analysis Integrity & Memory-Bounded Pipeline spec — exercised through the
// REAL `stoa analyze` process (execFileSync), not just the Baseline.ts unit
// tests (test/Baseline.test.ts), so the actual exit codes and the actual
// CLI wiring are what gets verified, not just the underlying functions.

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

test('2.4: --only-new without --baseline is rejected with a clear error and a non-zero exit code', () => {
    const result = runCli(['--only-new']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--only-new requires --baseline/);
});

test('2.4: --update-baseline without --baseline is rejected with a clear error and a non-zero exit code', () => {
    const result = runCli(['--update-baseline']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--update-baseline requires --baseline/);
});

test('2.4: --baseline pointing at a directory is rejected with a clear error, not a generic I/O exception', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-baseline-cli-'));
    try {
        const result = runCli(['--baseline', dir]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /is a directory, not a file/);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('2.5.5: a complete scan with --update-baseline still works end to end (the incomplete guard does not block the normal case)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-baseline-cli-'));
    try {
        const baselinePath = join(dir, 'baseline.json');
        const result = runCli(['--baseline', baselinePath, '--update-baseline', '--format', 'json']);
        assert.equal(result.status, 0);
        const written = JSON.parse(readFileSync(baselinePath, 'utf8')) as {version: number; findings: unknown[]};
        assert.equal(written.version, 1);
        assert.ok(Array.isArray(written.findings));
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('2.3/2.5.3/2.5.4/2.5.6: an INCOMPLETE scan with --update-baseline is blocked end to end, with a non-zero exit code, and leaves the existing baseline byte-identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-baseline-cli-'));
    try {
        const baselinePath = join(dir, 'baseline.json');
        // Seed a real, complete baseline first (a plausible pre-existing state).
        const seeded = runCli(['--baseline', baselinePath, '--update-baseline', '--format', 'json']);
        assert.equal(seeded.status, 0);
        const before = readFileSync(baselinePath, 'utf8');

        const blocked = runCli(['--baseline', baselinePath, '--update-baseline', '--format', 'json'], {STOA_TEST_FORCE_INCOMPLETE: '1'});
        assert.notEqual(blocked.status, 0, 'a blocked baseline update must signal a failed run, not exit 0');
        assert.match(blocked.stderr, /refusing to update baseline/);

        const after = readFileSync(baselinePath, 'utf8');
        assert.equal(after, before, 'the existing baseline must be left byte-identical when the update is blocked');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('2.2: an incomplete scan compared against a baseline reports nothing as fixed, and marks the comparison provisional', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-baseline-cli-'));
    try {
        const baselinePath = join(dir, 'baseline.json');
        // A baseline naming a finding that cannot possibly exist in this
        // fixture — on a COMPLETE scan this would be reported `fixed`.
        writeFileSync(baselinePath, `${JSON.stringify({version: 1, identity: 3, findings: [{file: 'does/not/exist.ts', rule: 'R-NONEXISTENT', symbol: 'x'}]}, null, 2)}\n`);

        const result = runCli(['--baseline', baselinePath, '--format', 'json'], {STOA_TEST_FORCE_INCOMPLETE: '1'});
        // Analysis Completion Integrity (2.2): an incomplete scan must NEVER
        // exit 0, even when merely comparing against a baseline (not
        // updating it) — exit 2 signals "partial", distinct from exit 1
        // ("execution/config error") and exit 0 ("complete").
        assert.equal(result.status, 2, 'comparing against a baseline on an incomplete scan is not a config/execution error, but it must still never report exit 0 — exit 2 signals "partial"');
        const report = JSON.parse(result.stdout) as {baseline?: {fixedCount: number; fixed: unknown[]; incomplete?: boolean}};
        assert.equal(report.baseline?.fixedCount, 0, 'the scan never got far enough to prove that finding is actually gone');
        assert.deepEqual(report.baseline?.fixed, []);
        assert.equal(report.baseline?.incomplete, true);
        assert.match(result.stderr, /baseline new\/known status is provisional/);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

// Unique identities: a Flutter project whose lifecycle/layout rules report several
// sites of one class/build() round-trips through --update-baseline (before, the
// written baseline repeated an identity and could not be read back); a project
// that still collides is refused loudly instead of producing an unreadable file.
const analyzeAt = (path: string, args: string[], env: NodeJS.ProcessEnv = {}): CliRun => {
    const result = spawnSync('node', ['--import', 'tsx', 'src/Cli.ts', 'analyze', path, ...args], {cwd: root, encoding: 'utf8', env: {...process.env, ...env}});
    return {status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr};
};

test('Flutter identities: --update-baseline then --baseline --only-new round-trips (0 new, exit 0) on several sites per class and per build()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-baseline-flutter-'));
    try {
        const path = join(dir, 'baseline.json');
        const project = join(here, 'fixtures', 'flutter-identity');
        const write = analyzeAt(project, ['--baseline', path, '--update-baseline', '--format', 'json']);
        assert.equal(write.status, 0, write.stderr);
        const entries = (JSON.parse(readFileSync(path, 'utf8')) as {findings: unknown[]}).findings;
        assert.ok(entries.length >= 8);
        const read = analyzeAt(project, ['--baseline', path, '--only-new', '--format', 'json']);
        assert.equal(read.status, 0, read.stderr);
        assert.equal((JSON.parse(read.stdout) as {findings: unknown[]}).findings.length, 0);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('--update-baseline on findings that share an identity exits 1 with the reason and leaves the existing baseline untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-baseline-collision-'));
    try {
        const project = join(dir, 'project');
        spawnSync('mkdir', ['-p', project]);
        // No rule produces a colliding identity any more; the test-only hook
        // STOA_TEST_DUPLICATE_IDENTITY repeats the first finding.
        writeFileSync(join(project, 'm.php'), '<?php\n$first = new class extends AbstractMigration {\n    public function up(Schema $schema): void {}\n};\n$second = new class extends AbstractMigration {\n    public function up(Schema $schema): void {}\n};\n');
        const path = join(dir, 'baseline.json');
        writeFileSync(path, '{"version": 1, "identity": 3, "findings": []}\n');
        const result = analyzeAt(project, ['--baseline', path, '--update-baseline', '--format', 'json'], {STOA_TEST_DUPLICATE_IDENTITY: '1'});
        assert.equal(result.status, 1);
        assert.match(result.stderr, /refusing to update baseline .*produced by more than one finding.*m\.php::R-MIGRATION-NO-DOWN::\(anonymous\)#0/);
        assert.equal(readFileSync(path, 'utf8'), '{"version": 1, "identity": 3, "findings": []}\n');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});
