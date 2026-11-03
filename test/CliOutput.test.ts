import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// Regression: the CLI ended with process.exit(), which terminates before an
// asynchronous stdout (a pipe on POSIX) is drained — a report larger than the
// 64 KiB pipe buffer arrived truncated (`stoa analyze … | jq` failed).

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('CLI: a report larger than the 64 KiB pipe buffer arrives complete through a pipe, with the usual exit code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-cli-output-'));
    try {
        for (let index = 0; index < 120; index++) {
            writeFileSync(join(dir, `clock${index}.ts`), `export const stamp${index} = (): number => Date.now() + Math.random();\n`);
        }
        // spawnSync reads the child's stdout through a pipe — the case that truncated
        const result = spawnSync('node', ['--import', 'tsx', 'src/Cli.ts', 'analyze', dir, '--format', 'json'], {cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
        assert.ok(result.stdout.length > 64 * 1024, `the fixture must exceed the pipe buffer (got ${result.stdout.length} bytes)`);
        const report = JSON.parse(result.stdout) as {findings: unknown[]; coverage: {status: string}};
        assert.ok(report.findings.length >= 120);
        assert.equal(report.coverage.status, 'complete');
        assert.equal(result.status, 0);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});
