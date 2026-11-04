#!/usr/bin/env node
// Findings comparison harness.
//
// Checks that a change leaves stoa's findings as they were — the check behind
// every "reports byte-identical" claim in docs/*/implementation-status.md.
// `snapshot` runs stoa over a list of targets and writes each target's
// findings as JSON lines (in report order, paths relative to the target, so a
// snapshot does not depend on where the checkout lives); `diff` compares two
// snapshot directories file by file and, for a file that differs, by finding
// key (rule, file, symbol, statement), which separates real changes from
// shifted positions or order.
//
// Usage:
//   npx tsx scripts/compare-findings.ts snapshot <out-dir> [--targets <file>] [--jobs N]
//   npx tsx scripts/compare-findings.ts diff <before-dir> <after-dir>
//
// Typical use: snapshot into `before/` on the old commit, into `after/` on the
// new one (twice, to see that a run is stable; again with `--jobs 4`, to see
// that parallel extraction changes nothing), then diff. `diff` exits 1 if
// anything differs.
//
// Targets: a JSON array of {name, path, solid?, deadExports?, architecture?,
// contracts?}; relative paths resolve against the targets file's directory.
// The default (scripts/compare-targets.json) covers this repository only —
// keep a list of your own projects in `.stoa/compare-targets.json` (ignored by
// git, like the rest of `.stoa/`; architecture configs it names can sit next
// to it) and pass it with `--targets .stoa/compare-targets.json`. Keep an
// architecture config's file name: it appears in the findings' text.

import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {loadArchitectureConfig} from '../src/architecture/ArchitectureConfig.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {loadValidationContract} from '../src/contracts/ValidationContract.js';
import {analyzeAsync} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGETS = join(PACKAGE_ROOT, 'scripts', 'compare-targets.json');
const USAGE = 'Usage:\n'
    + '  npx tsx scripts/compare-findings.ts snapshot <out-dir> [--targets <file>] [--jobs N]\n'
    + '  npx tsx scripts/compare-findings.ts diff <before-dir> <after-dir>\n';

interface Target {
    name: string;
    path: string;
    solid?: boolean;
    deadExports?: boolean;
    architecture?: string;
    contracts?: string;
}

const readTargets = (file: string): Target[] => {
    const base = dirname(file);
    const targets = JSON.parse(readFileSync(file, 'utf8')) as Target[];
    return targets.map((t) => ({
        ...t,
        path: resolve(base, t.path),
        ...(t.architecture !== undefined ? {architecture: resolve(base, t.architecture)} : {}),
        ...(t.contracts !== undefined ? {contracts: resolve(base, t.contracts)} : {})
    }));
};

/** One finding per line, the target's own path cut from every path in it. */
const findingLines = (findings: readonly Finding[], rootPath: string): string => {
    const prefix = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
    return findings.map((f) => `${JSON.stringify(f).split(prefix).join('')}\n`).join('');
};

const snapshot = async (outDir: string, targetsFile: string, jobs: number): Promise<number> => {
    mkdirSync(outDir, {recursive: true});
    for (const target of readTargets(targetsFile)) {
        const result = await analyzeAsync({
            jobs,
            rootPath: target.path,
            knowledgeDir: join(PACKAGE_ROOT, 'knowledge', 'marcus'),
            ruleSetDir: join(PACKAGE_ROOT, 'rules', 'default'),
            config: DEFAULT_CONFIG,
            solid: target.solid === true,
            deadExports: target.deadExports === true,
            ...(target.architecture !== undefined ? {architecture: loadArchitectureConfig(target.architecture)} : {}),
            ...(target.contracts !== undefined ? {validationContract: loadValidationContract(target.contracts)} : {})
        });
        writeFileSync(join(outDir, `${target.name}.jsonl`), findingLines(result.report.findings, target.path), 'utf8');
        process.stdout.write(`${target.name}: ${result.report.findings.length} findings, ${result.report.coverage.status}\n`);
    }
    return 0;
};

/** What a finding says, without where exactly it sits: rule, file, symbol, statement. */
const keysOf = (file: string): string[] =>
    readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => {
        const f = JSON.parse(line) as Finding;
        return [f.rule.id, f.location.file, f.location.symbol ?? '', f.observation.statement].join(' | ');
    }).sort();

const keyedDiff = (before: string[], after: string[]): string[] => {
    const count = (keys: string[]): Map<string, number> =>
        keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
    const b = count(before);
    const a = count(after);
    const lines: string[] = [];
    for (const key of [...new Set([...before, ...after])].sort()) {
        const delta = (a.get(key) ?? 0) - (b.get(key) ?? 0);
        if (delta !== 0) {
            lines.push(`  ${delta > 0 ? '+' : '-'} ${key}${Math.abs(delta) > 1 ? ` (×${Math.abs(delta)})` : ''}`);
        }
    }
    return lines;
};

const diff = (beforeDir: string, afterDir: string): number => {
    const jsonl = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    const before = new Set(jsonl(beforeDir));
    const after = new Set(jsonl(afterDir));
    let differs = false;
    for (const name of [...new Set([...before, ...after])].sort()) {
        if (!before.has(name) || !after.has(name)) {
            differs = true;
            process.stdout.write(`only in ${before.has(name) ? 'before' : 'after'}: ${name}\n`);
            continue;
        }
        const b = readFileSync(join(beforeDir, name), 'utf8');
        const a = readFileSync(join(afterDir, name), 'utf8');
        if (a === b) {
            process.stdout.write(`same      ${name}\n`);
            continue;
        }
        differs = true;
        const changes = keyedDiff(keysOf(join(beforeDir, name)), keysOf(join(afterDir, name)));
        process.stdout.write(changes.length === 0
            ? `positions ${name} (same findings, other positions or order)\n`
            : `CHANGED   ${name}\n${changes.join('\n')}\n`);
    }
    return differs ? 1 : 0;
};

const main = async (): Promise<number> => {
    const {values, positionals} = parseArgs({
        allowPositionals: true,
        options: {
            targets: {type: 'string'},
            jobs: {type: 'string', default: '1'}
        }
    });
    const [command, first, second] = positionals;
    if (command === 'snapshot' && first !== undefined) {
        const jobs = Number.parseInt(values.jobs ?? '1', 10);
        if (!Number.isInteger(jobs) || jobs < 1) {
            process.stderr.write(`Invalid --jobs value: ${values.jobs}\n`);
            return 2;
        }
        return snapshot(resolve(first), resolve(values.targets ?? DEFAULT_TARGETS), jobs);
    }
    if (command === 'diff' && first !== undefined && second !== undefined) {
        return diff(resolve(first), resolve(second));
    }
    process.stderr.write(USAGE);
    return 2;
};

process.exit(await main());
