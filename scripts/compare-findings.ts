#!/usr/bin/env node
// Findings comparison harness.
//
// Checks that a change leaves stoa's findings as they were — the check behind
// every "reports byte-identical" claim in docs/*/implementation-status.md.
// `snapshot` runs stoa over a list of targets and writes each target's
// findings as JSON lines (in report order, paths relative to the target, so a
// snapshot does not depend on where the checkout lives) plus `snapshot.json`
// with the finding-identity scheme (src/FindingIdentity.ts; a snapshot
// without it is scheme 1). `diff` compares two snapshot directories file by
// file; for a file that differs it pairs the findings by their identity
// (file, rule, symbol — the evaluator's and the baseline's key, via
// src/FindingDiff.ts) and reports per target:
//   same       byte-identical
//   order      same findings, other order
//   moved      same findings, some at other positions (id/range only)
//   CHANGED    + added, - removed, ~ changed content (with the fields)
//   INTEGRITY  an identity a snapshot holds twice (a rule defect; listed with
//              "!", never merged)
// Two snapshots under different identity schemes are paired by position
// (Finding.id) instead, and a changed identity is listed as "= old -> new".
//
// Usage:
//   npx tsx scripts/compare-findings.ts snapshot <out-dir> [--targets <file>] [--jobs N]
//   npx tsx scripts/compare-findings.ts diff <before-dir> <after-dir>
//
// Typical use: snapshot into `before/` on the old commit, into `after/` on the
// new one (twice, to see that a run is stable; again with `--jobs 4`, to see
// that parallel extraction changes nothing), then diff. `diff` exits 1 if
// anything differs, positions included — the status words tell a shift from
// a change.
//
// Targets: a JSON array of {name, path, solid?, deadExports?, architecture?,
// contracts?}; relative paths resolve against the targets file's directory.
// The default (scripts/compare-targets.json) covers this repository only —
// keep a list of your own projects in `.stoa/compare-targets.json` (ignored by
// git, like the rest of `.stoa/`; architecture configs it names can sit next
// to it) and pass it with `--targets .stoa/compare-targets.json`. Keep an
// architecture config's file name: it appears in the findings' text.

import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {loadArchitectureConfig} from '../src/architecture/ArchitectureConfig.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {loadValidationContract} from '../src/contracts/ValidationContract.js';
import {diffFindings, isSemanticallyEqual} from '../src/FindingDiff.js';
import {IDENTITY_SCHEME, identityField, keyString, type FindingKey, type IdentityScheme} from '../src/FindingIdentity.js';
import {analyzeAsync} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGETS = join(PACKAGE_ROOT, 'scripts', 'compare-targets.json');
/** The snapshot's own description: the identity scheme its findings were named under. */
const SNAPSHOT_META = 'snapshot.json';
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
    writeFileSync(join(outDir, SNAPSHOT_META), `${JSON.stringify({identity: IDENTITY_SCHEME}, null, 2)}\n`, 'utf8');
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

type FindingDiff = ReturnType<typeof diffFindings>;
type DiffPairing = FindingDiff['pairing'];

/** A snapshot directory's identity scheme (`snapshot.json`); a snapshot without the file is scheme 1, as a baseline is. */
const snapshotScheme = (dir: string): IdentityScheme => {
    const metaPath = join(dir, SNAPSHOT_META);
    if (!existsSync(metaPath)) {
        return 1;
    }
    const scheme = identityField((JSON.parse(readFileSync(metaPath, 'utf8')) as {identity?: unknown}).identity);
    if (scheme === null) {
        throw new Error(`${metaPath}: "identity" must be 1 or 2`);
    }
    return scheme;
};

/** Where the relative paths of a snapshot are put back under, so the evaluator's `findingKey` reads them as they were. */
const SNAPSHOT_ROOT = resolve(sep, 'snapshot');

const readFindings = (file: string): Finding[] =>
    readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => {
        const finding = JSON.parse(line) as Finding;
        return {...finding, location: {...finding.location, file: join(SNAPSHOT_ROOT, finding.location.file)}};
    });

const keyList = (sign: string, keys: readonly FindingKey[]): string[] => keys.map((key) => `  ${sign} ${keyString(key)}`);

/** The lines for one target that differs: what was added, removed, changed, renamed, and which identities repeat. */
const diffLines = (diff: FindingDiff): string[] => [
    ...keyList('+', diff.added),
    ...keyList('-', diff.removed),
    ...diff.changed.map((entry) => `  ~ ${keyString(entry.key)} (${entry.fields.join(', ')})`),
    ...diff.renamed.map((entry) => `  = ${keyString(entry.before)} -> ${keyString(entry.after)}`),
    ...keyList('! duplicate before:', diff.duplicates.before),
    ...keyList('! duplicate after:', diff.duplicates.after)
];

/** One target's status word: same, order, moved (positions only), or CHANGED (anything semantic). */
const targetStatus = (diff: FindingDiff): string => {
    if (!isSemanticallyEqual(diff)) {
        return diff.duplicates.before.length + diff.duplicates.after.length > 0 ? 'INTEGRITY' : 'CHANGED  ';
    }
    return diff.moved.length > 0 ? 'moved    ' : 'order    ';
};

const diff = (beforeDir: string, afterDir: string): number => {
    const jsonl = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    const before = new Set(jsonl(beforeDir));
    const after = new Set(jsonl(afterDir));
    const schemes = [snapshotScheme(beforeDir), snapshotScheme(afterDir)];
    const pairing: DiffPairing = schemes[0] === schemes[1] ? 'identity' : 'position';
    if (pairing === 'position') {
        process.stdout.write(`identity schemes differ (before ${schemes[0]}, after ${schemes[1]}): findings are paired by position (Finding.id), a changed identity is listed as "=" (renamed)\n`);
    }
    let differs = false;
    for (const name of [...new Set([...before, ...after])].sort()) {
        if (!before.has(name) || !after.has(name)) {
            differs = true;
            process.stdout.write(`only in ${before.has(name) ? 'before' : 'after'}: ${name}\n`);
            continue;
        }
        if (readFileSync(join(beforeDir, name), 'utf8') === readFileSync(join(afterDir, name), 'utf8')) {
            process.stdout.write(`same      ${name}\n`);
            continue;
        }
        differs = true;
        const result = diffFindings(readFindings(join(beforeDir, name)), readFindings(join(afterDir, name)), SNAPSHOT_ROOT, pairing);
        const counts = `same ${result.same}, moved ${result.moved.length}, changed ${result.changed.length}, renamed ${result.renamed.length}, +${result.added.length} -${result.removed.length}`;
        process.stdout.write(`${targetStatus(result)} ${name} (${counts})\n`);
        const lines = diffLines(result);
        if (lines.length > 0) {
            process.stdout.write(`${lines.join('\n')}\n`);
        }
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
