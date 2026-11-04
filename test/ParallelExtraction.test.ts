import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import * as nodeModule from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {ExtractionPool} from '../src/ExtractionPool.js';
import {analyzeAsync, type AnalyzeAsyncOptions} from '../src/Pipeline.js';

// `analyzeAsync` with `jobs` > 1 parses and extracts on worker threads but
// applies every file's outcome in file order, so report and facts must equal
// the sequential run byte for byte — for every adapter (TS, PHP, Dart, C/C++,
// HTML, Vue, Angular: the workers load the same grammars).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');

const optionsFor = (rootPath: string, extra: Partial<AnalyzeAsyncOptions> = {}): AnalyzeAsyncOptions => ({
    rootPath,
    knowledgeDir,
    ruleSetDir,
    config: DEFAULT_CONFIG,
    deadExports: true,
    solid: true,
    ...extra
});

const FIXTURES = ['sample', 'php', 'dart', 'cpp', 'html', 'vue', 'angular', 'jsx', 'struct', 'validation-dataflow-corpus/corpus', 'flutter'];

for (const fixture of FIXTURES) {
    test(`jobs 3 equals the sequential run: ${fixture}`, async () => {
        const path = join(here, 'fixtures', fixture);
        const sequential = await analyzeAsync(optionsFor(path));
        const parallel = await analyzeAsync(optionsFor(path, {jobs: 3}));
        assert.ok(sequential.report.coverage.filesAnalyzed > 0);
        assert.equal(JSON.stringify(parallel.report), JSON.stringify(sequential.report));
        assert.equal(JSON.stringify(parallel.facts), JSON.stringify(sequential.facts));
    });
}

test('the whole fixture tree, every file selected, in parallel equals the sequential run', async () => {
    const path = join(here, 'fixtures');
    const all = {config: {...DEFAULT_CONFIG, include: ['**/*']}};
    const sequential = await analyzeAsync(optionsFor(path, all));
    const parallel = await analyzeAsync(optionsFor(path, {...all, jobs: 4}));
    assert.ok(sequential.report.coverage.filesAnalyzed > 100);
    assert.ok((sequential.report.coverage.excludedByReason.unsupported_language ?? 0) > 0);
    assert.equal(JSON.stringify(parallel.report), JSON.stringify(sequential.report));
    assert.equal(JSON.stringify(parallel.facts), JSON.stringify(sequential.facts));
});

test('unsupported and unreadable files between parsed ones keep their place in the excluded sample', {skip: process.getuid?.() === 0 ? 'root reads every file' : false}, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-parallel-'));
    try {
        for (let at = 0; at < 12; at += 1) {
            const name = String(at).padStart(2, '0');
            writeFileSync(join(dir, `${name}.ts`), `export const v${at} = ${at};\n`);
            writeFileSync(join(dir, `${name}.txt`), 'plain\n');
            if (at % 4 === 1) {
                writeFileSync(join(dir, `${name}-locked.ts`), 'export const locked = 1;\n');
                chmodSync(join(dir, `${name}-locked.ts`), 0o000);
            }
        }
        const all = {config: {...DEFAULT_CONFIG, include: ['**/*']}};
        const sequential = await analyzeAsync(optionsFor(dir, all));
        const parallel = await analyzeAsync(optionsFor(dir, {...all, jobs: 3}));
        assert.equal(sequential.report.coverage.status, 'partial');
        assert.equal(sequential.report.coverage.excludedByReason.read_error, 3);
        assert.equal(sequential.report.coverage.excludedByReason.unsupported_language, 12);
        assert.equal(JSON.stringify(parallel.report), JSON.stringify(sequential.report));
        assert.equal(JSON.stringify(parallel.facts), JSON.stringify(sequential.facts));
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('with the fact cache: a parallel run fills it, the next run is served from it, reports equal the sequential run', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'stoa-parallel-cache-'));
    try {
        const path = join(here, 'fixtures', 'struct');
        const sequential = await analyzeAsync(optionsFor(path));
        const first = await analyzeAsync(optionsFor(path, {jobs: 2, cacheDir}));
        const second = await analyzeAsync(optionsFor(path, {jobs: 2, cacheDir}));
        assert.equal(first.report.coverage.cacheHits, 0);
        assert.equal(second.report.coverage.cacheHits, sequential.report.coverage.filesAnalyzed);
        const withoutCacheHits = (report: typeof sequential.report): string => JSON.stringify({...report, coverage: {...report.coverage, cacheHits: undefined}});
        assert.equal(withoutCacheHits(first.report), withoutCacheHits(sequential.report));
        assert.equal(withoutCacheHits(second.report), withoutCacheHits(sequential.report));
        assert.equal(JSON.stringify(second.facts), JSON.stringify(sequential.facts));
    } finally {
        rmSync(cacheDir, {recursive: true, force: true});
    }
});

test('the main-thread memory guard stops a parallel run where it stops a sequential one', async () => {
    const path = join(here, 'fixtures', 'sample');
    const guard = {memoryGuard: {checkEveryFiles: 1, criticalRatio: 0}};
    const sequential = await analyzeAsync(optionsFor(path, guard));
    const parallel = await analyzeAsync(optionsFor(path, {...guard, jobs: 2}));
    assert.equal(parallel.report.coverage.status, 'partial');
    assert.equal(JSON.stringify(parallel.report), JSON.stringify(sequential.report));
});

test("a worker's own memory guard stops the run at the first file it was handed, keeping everything before it", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-parallel-'));
    try {
        // a.txt has no adapter (settled on the main thread), b.ts goes to a worker
        writeFileSync(join(dir, 'a.txt'), 'plain text\n');
        writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
        writeFileSync(join(dir, 'c.ts'), 'export const c = 2;\n');
        const {report, facts} = await analyzeAsync(optionsFor(dir, {jobs: 2, config: {...DEFAULT_CONFIG, include: ['**/*']}, memoryGuard: {checkEveryFiles: 1000, workerCriticalRatio: 0}}));
        assert.equal(report.coverage.status, 'partial');
        assert.equal(report.coverage.abortReason, 'memory_limit');
        assert.equal(report.coverage.stoppedAtFile, join(dir, 'b.ts'));
        assert.equal(report.coverage.filesCancelled, 2);
        assert.equal(report.coverage.filesAnalyzed, 0);
        assert.equal(report.coverage.excludedByReason.unsupported_language, 1);
        assert.equal(facts.length, 0);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('a worker that dies fails the run instead of hanging or losing files', async () => {
    const previous = process.env.STOA_TEST_WORKER_EXIT;
    process.env.STOA_TEST_WORKER_EXIT = '1';
    try {
        await assert.rejects(analyzeAsync(optionsFor(join(here, 'fixtures', 'sample'), {jobs: 2})), /extraction worker exited with code 3/);
    } finally {
        if (previous === undefined) {
            delete process.env.STOA_TEST_WORKER_EXIT;
        } else {
            process.env.STOA_TEST_WORKER_EXIT = previous;
        }
    }
});

test("an adapter error in a worker rejects that file's task", async () => {
    const pool = new ExtractionPool(1, {rootDir: '/', criticalRatio: 0.9});
    try {
        await assert.rejects(pool.extract(0, {path: '/x.unknown', size: 1}, {path: '/x.unknown', content: 'x'}), /no adapter for \/x\.unknown/);
        const outcome = await pool.extract(1, {path: '/y.ts', size: 20}, {path: '/y.ts', content: 'export const y = 1;\n'});
        assert.equal(outcome.kind, 'extracted');
    } finally {
        await pool.close();
    }
});

const runCli = (args: string[]): {status: number; stdout: string; stderr: string} => {
    const result = spawnSync('node', ['--import', 'tsx', 'src/Cli.ts', 'analyze', join(here, 'fixtures', 'sample'), '--format', 'json', ...args], {cwd: root, encoding: 'utf8'});
    return {status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr};
};

test('CLI --jobs 2 prints the same report as the sequential run', () => {
    const sequential = runCli([]);
    const parallel = runCli(['--jobs', '2']);
    assert.equal(sequential.status, 0);
    assert.equal(parallel.status, 0);
    assert.equal(parallel.stdout, sequential.stdout);
});

// The compile cache (ExtractionWorker.ts): only extraction workers turn it
// on, in Node's default place under the temp directory — a run without
// --jobs writes none there; NODE_DISABLE_COMPILE_CACHE=1 turns it off.
// (The test runs the CLI through tsx, which keeps a cache of its own there.)
const runCliIn = (temp: string, args: string[], env: Record<string, string> = {}): number => {
    const result = spawnSync('node', ['--import', 'tsx', 'src/Cli.ts', 'analyze', join(here, 'fixtures', 'sample'), '--format', 'json', ...args], {
        cwd: root,
        encoding: 'utf8',
        env: {...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, NODE_COMPILE_CACHE: '', ...env}
    });
    return result.status ?? 1;
};
const compileCacheIn = (temp: string): string[] => (existsSync(join(temp, 'node-compile-cache')) ? readdirSync(join(temp, 'node-compile-cache')) : []);
const hasCompileCache = typeof (nodeModule as {enableCompileCache?: unknown}).enableCompileCache === 'function';

test('only extraction workers fill the compile cache; a run without --jobs writes none', {skip: hasCompileCache ? false : 'this Node has no module.enableCompileCache'}, () => {
    const sequentialTemp = mkdtempSync(join(tmpdir(), 'stoa-cc-seq-'));
    const parallelTemp = mkdtempSync(join(tmpdir(), 'stoa-cc-par-'));
    const disabledTemp = mkdtempSync(join(tmpdir(), 'stoa-cc-off-'));
    try {
        assert.equal(runCliIn(sequentialTemp, []), 0);
        assert.deepEqual(compileCacheIn(sequentialTemp), []);
        assert.ok(!existsSync(join(sequentialTemp, 'node-compile-cache')));
        assert.equal(runCliIn(parallelTemp, ['--jobs', '2']), 0);
        assert.ok(compileCacheIn(parallelTemp).length > 0, 'the workers wrote a compile cache');
        assert.equal(runCliIn(disabledTemp, ['--jobs', '2'], {NODE_DISABLE_COMPILE_CACHE: '1'}), 0);
        assert.deepEqual(compileCacheIn(disabledTemp), []);
    } finally {
        for (const temp of [sequentialTemp, parallelTemp, disabledTemp]) {
            rmSync(temp, {recursive: true, force: true});
        }
    }
});

for (const bad of ['0', '-1', '1.5', 'two', '']) {
    test(`CLI --jobs '${bad}' is a usage error`, () => {
        const run = runCli([`--jobs=${bad}`]);
        assert.equal(run.status, 1);
        assert.match(run.stderr, /--jobs expects a whole number >= 1/);
        assert.equal(run.stdout, '');
    });
}
