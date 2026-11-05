#!/usr/bin/env node
// Parallel-extraction comparison harness (finding identity spec, phase 5).
//
// Runs the built CLI (`dist/Cli.js analyze --format json`, so `npm run build`
// first) over a list of targets, without `--jobs` (the sequential default)
// and with every `--jobs N` asked for, and compares each run with the
// sequential one:
//   wall       wall-clock ms of the whole process
//   rss        peak resident set of the process, worker threads included
//              (`process.resourceUsage().maxRSS`, read in the CLI process by
//              a preload — no change to stoa itself)
//   cpu        user + system CPU seconds; cores = cpu / wall
//   findings   the findings array byte-identical (paths relative to the target)
//   ids        the same finding identities (file, rule, symbol)
//   order      the same identities in the same order
//   coverage   status, file counts, exclusions and fact count equal
//   exit       the exit code equal
// Every configuration runs `--runs` times; the order of configurations
// rotates per round, so drift in the machine's load spreads over all of them.
// The 1-minute load average before every run is recorded: wall-clock and CPU
// figures from a busy machine are only comparable within one round.
//
// `--cache` (on copies of the targets in the output directory — `--cache`
// writes into `<target>/.stoa/cache`, never into a target itself): a cold run
// that fills the cache and a warm run that reads it, for every pair of
// writer/reader configurations; reported: wall ms cold/warm, cache hits of
// the warm run against the files analyzed, findings equal to the sequential
// run.
//
// `--errors`: a generated project with files that fail to parse, an
// unreadable file and a non-source file, run in every configuration; plus the
// test-only hooks STOA_TEST_FORCE_INCOMPLETE (the memory guard stops the run
// at the first file) and STOA_TEST_WORKER_EXIT (a worker dies; parallel
// configurations only) — exit code, status and findings per configuration.
//
// Usage:
//   npx tsx scripts/compare-jobs.ts [--targets <file>] [--jobs 1,2,4,8] [--runs 3] [--out <dir>] [--cache] [--errors]
//
// Targets: the format of scripts/compare-findings.ts (default: this
// repository's scripts/compare-targets.json; your own projects in
// `.stoa/…`). Results: a Markdown summary on stdout and every run as JSON in
// `<out>/runs.json` (default out: `.stoa/compare-jobs`).

import {spawnSync} from 'node:child_process';
import {accessSync, chmodSync, closeSync, constants, cpSync, existsSync, mkdirSync, lstatSync, openSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {loadavg} from 'node:os';
import {dirname, join, resolve, sep} from 'node:path';
import {parseArgs} from 'node:util';
import {findingKey, keyString} from '../src/FindingIdentity.js';
import type {Finding} from '../src/Types.js';
import {DEFAULT_TARGETS, PACKAGE_ROOT, readTargets, type Target} from './CompareTargets.js';

const CLI = join(PACKAGE_ROOT, 'dist', 'Cli.js');
const TIMEOUT_MS = 15 * 60 * 1000;

/** `null` = no `--jobs` (the sequential default). */
type Jobs = number | null;

interface Report {
    coverage: Record<string, unknown>;
    findings: Finding[];
}

interface Run {
    target: string;
    jobs: Jobs;
    round: number;
    load: number;
    wallMs: number;
    rssMB: number;
    cpuS: number;
    exit: number | null;
    timedOut: boolean;
    report: Report | null;
}

const label = (jobs: Jobs): string => (jobs === null ? 'sequential' : `--jobs ${jobs}`);

const PRELOAD = `import {writeFileSync} from 'node:fs';
import {isMainThread} from 'node:worker_threads';
if (isMainThread && process.env.STOA_BENCH_RUSAGE) {
    process.on('exit', () => writeFileSync(process.env.STOA_BENCH_RUSAGE, JSON.stringify(process.resourceUsage())));
}
`;

const cliArgs = (target: Target, path: string, jobs: Jobs, extra: readonly string[]): string[] => [
    CLI,
    'analyze',
    path,
    '--format',
    'json',
    ...(target.solid === true ? ['--solid'] : []),
    ...(target.deadExports === true ? ['--dead-exports'] : []),
    ...(target.architecture !== undefined ? ['--architecture', target.architecture] : []),
    ...(target.contracts !== undefined ? ['--contracts', target.contracts] : []),
    ...(jobs === null ? [] : ['--jobs', String(jobs)]),
    ...extra
];

/** One CLI run; the report is null when stdout held no JSON report. */
const runOnce = (out: string, target: Target, path: string, jobs: Jobs, round: number, extra: readonly string[] = [], env: Record<string, string> = {}): Run => {
    const stdoutFile = join(out, 'stdout.json');
    const rusageFile = join(out, 'rusage.json');
    rmSync(rusageFile, {force: true});
    const fd = openSync(stdoutFile, 'w');
    const load = loadavg()[0] ?? 0;
    const start = process.hrtime.bigint();
    const child = spawnSync(process.execPath, ['--import', join(out, 'preload.mjs'), ...cliArgs(target, path, jobs, extra)], {
        stdio: ['ignore', fd, 'ignore'],
        env: {...process.env, ...env, STOA_BENCH_RUSAGE: rusageFile},
        timeout: TIMEOUT_MS
    });
    const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
    closeSync(fd);
    const usage = existsSync(rusageFile) ? (JSON.parse(readFileSync(rusageFile, 'utf8')) as {maxRSS: number; userCPUTime: number; systemCPUTime: number}) : null;
    let report: Report | null = null;
    try {
        report = JSON.parse(readFileSync(stdoutFile, 'utf8')) as Report;
    } catch {
        // No report on stdout (a crash before rendering): `report: null` is the result.
    }
    return {
        target: target.name,
        jobs,
        round,
        load,
        wallMs,
        rssMB: usage === null ? Number.NaN : usage.maxRSS / 1024,
        cpuS: usage === null ? Number.NaN : (usage.userCPUTime + usage.systemCPUTime) / 1e6,
        exit: child.status,
        timedOut: child.error !== undefined,
        report
    };
};

/** The findings with the target's own path cut out, as one string. */
const findingsText = (report: Report | null, root: string): string => {
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    return report === null ? '' : JSON.stringify(report.findings).split(prefix).join('');
};

const identities = (report: Report | null, root: string): string[] => (report === null ? [] : report.findings.map((finding) => keyString(findingKey(root, finding))));

/** Coverage without what legitimately differs between runs (cache hits). */
const coverageText = (report: Report | null, root: string): string => {
    if (report === null) {
        return '';
    }
    const {cacheHits: _hits, ...rest} = report.coverage;
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    return JSON.stringify(rest).split(prefix).join('');
};

interface Verdict {
    findings: boolean;
    ids: boolean;
    order: boolean;
    coverage: boolean;
    exit: boolean;
}

const compare = (run: Run, runRoot: string, reference: Run, referenceRoot: string): Verdict => {
    const a = identities(reference.report, referenceRoot);
    const b = identities(run.report, runRoot);
    return {
        findings: findingsText(run.report, runRoot) === findingsText(reference.report, referenceRoot),
        ids: JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()),
        order: JSON.stringify(a) === JSON.stringify(b),
        coverage: coverageText(run.report, runRoot) === coverageText(reference.report, referenceRoot),
        exit: run.exit === reference.exit
    };
};

const verdictText = (verdict: Verdict): string => (Object.values(verdict).every(Boolean) ? 'identical' : Object.entries(verdict).filter(([, ok]) => !ok).map(([name]) => `DIFFERS: ${name}`).join(', '));

const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

const spread = (values: readonly number[], digits: number): string => `${median(values).toFixed(digits)} (${Math.min(...values).toFixed(digits)}–${Math.max(...values).toFixed(digits)})`;

const benchmark = (out: string, targets: readonly Target[], configs: readonly Jobs[], runs: number, all: Run[]): string[] => {
    const lines: string[] = [];
    for (const target of targets) {
        const own: Run[] = [];
        for (let round = 0; round < runs; round += 1) {
            for (let step = 0; step < configs.length; step += 1) {
                const jobs = configs[(step + round) % configs.length] as Jobs;
                own.push(runOnce(out, target, target.path, jobs, round));
                process.stderr.write(`${target.name} round ${round + 1}/${runs} ${label(jobs)}: ${own.at(-1)?.wallMs.toFixed(0)} ms\n`);
            }
        }
        all.push(...own);
        const reference = own.find((run) => run.jobs === null) as Run;
        const files = reference.report?.coverage.filesAnalyzed ?? '?';
        lines.push(`### ${target.name} (${files} files, ${reference.report?.findings.length ?? '?'} findings, load ${spread(own.map((run) => run.load), 1)})`, '');
        lines.push('| configuration | wall ms | peak RSS MB | CPU s | cores | vs sequential |', '|---|---|---|---|---|---|');
        for (const jobs of configs) {
            const mine = own.filter((run) => run.jobs === jobs);
            const verdicts = mine.map((run) => verdictText(compare(run, target.path, reference, target.path)));
            const verdict = [...new Set(verdicts)].join(' / ');
            const cores = mine.map((run) => run.cpuS / (run.wallMs / 1000));
            lines.push(`| ${label(jobs)} | ${spread(mine.map((run) => run.wallMs), 0)} | ${spread(mine.map((run) => run.rssMB), 0)} | ${spread(mine.map((run) => run.cpuS), 2)} | ${median(cores).toFixed(2)} | ${verdict} |`);
        }
        lines.push('');
    }
    return lines;
};

/**
 * What the copy for the cache check takes: plain files and directories only
 * (no links, sockets, FIFOs), no dependencies, VCS or stoa data, nothing
 * unreadable (the analysis skips that too).
 */
const copyable = (source: string): boolean => {
    if (source.split(sep).some((part) => part === 'node_modules' || part === '.git' || part === '.stoa')) {
        return false;
    }
    try {
        const stats = lstatSync(source);
        if (!stats.isFile() && !stats.isDirectory()) {
            return false;
        }
        accessSync(source, stats.isDirectory() ? constants.R_OK | constants.X_OK : constants.R_OK);
        return true;
    } catch {
        // Unreadable: left out of the copy.
        return false;
    }
};

/** Cold run fills the cache, warm run reads it — every writer/reader pair, on a copy of each target. */
const cacheCheck = (out: string, targets: readonly Target[], configs: readonly Jobs[], all: Run[]): string[] => {
    const lines = ['### Fact cache (copies of the targets)', '', '| target | writer → reader | cold ms | warm ms | warm cache hits / files | vs sequential |', '|---|---|---|---|---|---|'];
    // Each configuration reads what it wrote; across: sequential ↔ the most workers.
    const most = configs.at(-1) as Jobs;
    const pairs: (readonly [Jobs, Jobs])[] = [...configs.map((jobs) => [jobs, jobs] as const), [null, most], [most, null]];
    for (const target of targets) {
        const copy = join(out, 'copies', target.name);
        rmSync(copy, {recursive: true, force: true});
        cpSync(target.path, copy, {recursive: true, filter: copyable});
        const reference = runOnce(out, target, copy, null, 0);
        for (const [writer, reader] of pairs) {
            rmSync(join(copy, '.stoa'), {recursive: true, force: true});
            const cold = runOnce(out, target, copy, writer, 0, ['--cache']);
            const warm = runOnce(out, target, copy, reader, 0, ['--cache']);
            all.push(cold, warm);
            const hits = warm.report?.coverage.cacheHits ?? '?';
            const files = warm.report?.coverage.filesAnalyzed ?? '?';
            const verdict = [cold, warm].map((run) => verdictText(compare(run, copy, reference, copy)));
            lines.push(`| ${target.name} | ${label(writer)} → ${label(reader)} | ${cold.wallMs.toFixed(0)} | ${warm.wallMs.toFixed(0)} | ${hits} / ${files} | ${[...new Set(verdict)].join(' / ')} |`);
        }
        rmSync(copy, {recursive: true, force: true});
    }
    lines.push('');
    return lines;
};

/** A small project with broken, unreadable and non-source files, and the two failure hooks. */
const errorCheck = (out: string, configs: readonly Jobs[], all: Run[]): string[] => {
    const root = join(out, 'errors-project');
    rmSync(root, {recursive: true, force: true});
    const files: Record<string, string> = {
        'ok.ts': 'export const ok = (a: number): number => (a > 0 ? a : -a);\n',
        'broken.ts': 'export const = ;\nexport function (\n',
        'ok.php': '<?php\nfunction ok($a) { return $a; }\n',
        'broken.php': '<?php\nclass {\n',
        'broken.dart': 'class {\n  void f( {\n',
        'ok.dart': 'int ok(int a) => a;\n',
        'broken.c': 'int f( {\n',
        'unreadable.ts': 'export const hidden = 1;\n',
        'notes.bin': '\u0000\u0001binary\u0000',
        'readme.md': '# not source\n'
    };
    for (const [name, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, name)), {recursive: true});
        writeFileSync(join(root, name), content);
    }
    chmodSync(join(root, 'unreadable.ts'), 0o000);
    const target: Target = {name: 'errors', path: root};
    const lines = ['### Error behaviour (generated project)', '', '| case | configuration | exit | status | analyzed / skipped | findings | wall ms | vs sequential |', '|---|---|---|---|---|---|---|---|'];
    const cases: {name: string; env: Record<string, string>; configs: readonly Jobs[]}[] = [
        {name: 'broken, unreadable and non-source files', env: {}, configs},
        {name: 'memory guard stops at the first file (STOA_TEST_FORCE_INCOMPLETE)', env: {STOA_TEST_FORCE_INCOMPLETE: '1'}, configs},
        {name: 'a worker dies (STOA_TEST_WORKER_EXIT)', env: {STOA_TEST_WORKER_EXIT: '1'}, configs: configs.filter((jobs) => jobs !== null && jobs > 1)}
    ];
    try {
        for (const entry of cases) {
            const reference = runOnce(out, target, root, null, 0, [], entry.env);
            for (const jobs of entry.configs) {
                const run = jobs === null ? reference : runOnce(out, target, root, jobs, 0, [], entry.env);
                all.push(run);
                const coverage = run.report?.coverage;
                const vs = entry.env.STOA_TEST_WORKER_EXIT === undefined ? verdictText(compare(run, root, reference, root)) : '— (no worker without --jobs)';
                lines.push(
                    `| ${entry.name} | ${label(jobs)} | ${run.timedOut ? 'TIMEOUT' : String(run.exit)} | ${String(coverage?.status ?? 'no report')} | ${String(coverage?.filesAnalyzed ?? '?')} / ${String(coverage?.filesSkipped ?? '?')} | ${run.report?.findings.length ?? '?'} | ${run.wallMs.toFixed(0)} | ${vs} |`
                );
            }
        }
    } finally {
        chmodSync(join(root, 'unreadable.ts'), 0o644);
        rmSync(root, {recursive: true, force: true});
    }
    lines.push('');
    return lines;
};

const main = (): number => {
    const {values} = parseArgs({
        options: {
            targets: {type: 'string'},
            jobs: {type: 'string', default: '1,2,4,8'},
            runs: {type: 'string', default: '3'},
            out: {type: 'string'},
            cache: {type: 'boolean', default: false},
            errors: {type: 'boolean', default: false}
        }
    });
    if (!existsSync(CLI)) {
        process.stderr.write(`${CLI} not found — run \`npm run build\` first\n`);
        return 2;
    }
    const jobsList = values.jobs.split(',').map(Number);
    const runs = Number(values.runs);
    if (jobsList.some((jobs) => !Number.isInteger(jobs) || jobs < 1) || !Number.isInteger(runs) || runs < 1) {
        process.stderr.write('--jobs expects a list of whole numbers >= 1, --runs a whole number >= 1\n');
        return 2;
    }
    const out = resolve(values.out ?? join(PACKAGE_ROOT, '.stoa', 'compare-jobs'));
    mkdirSync(out, {recursive: true});
    writeFileSync(join(out, 'preload.mjs'), PRELOAD);
    const targets = readTargets(resolve(values.targets ?? DEFAULT_TARGETS));
    const configs: Jobs[] = [null, ...jobsList];
    const all: Run[] = [];
    let differs = false;
    // Each section is printed (and every run so far saved) as soon as it is done — a later failure loses nothing measured.
    const emit = (section: readonly string[]): void => {
        differs ||= section.some((line) => line.includes('DIFFERS'));
        process.stdout.write(`${section.join('\n')}\n`);
        writeFileSync(join(out, 'runs.json'), `${JSON.stringify(all.map(({report, ...run}) => ({...run, findings: report?.findings.length ?? null, status: report?.coverage.status ?? null})), null, 2)}\n`);
    };
    emit([`## stoa --jobs comparison (${new Date().toISOString()}, ${runs} runs, node ${process.version})`, '']);
    emit(benchmark(out, targets, configs, runs, all));
    if (values.cache) {
        emit(cacheCheck(out, targets, configs, all));
    }
    if (values.errors) {
        emit(errorCheck(out, configs, all));
    }
    return differs ? 1 : 0;
};

process.exitCode = main();
