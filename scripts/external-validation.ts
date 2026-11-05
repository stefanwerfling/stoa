#!/usr/bin/env node
// External validation: stoa over third-party projects pinned to a commit,
// with hand-classified findings (validation/external/, see
// src/evaluation/ExternalValidation.ts for what the data means and why it is
// kept apart from the golden corpora and the dogfooding targets).
//
// Usage:
//   npx tsx scripts/external-validation.ts fetch [<name>...]
//       clones each project at its commit into .stoa/external/<name> (shallow;
//       sparse where the manifest says so) and checks the commit
//   npx tsx scripts/external-validation.ts sample <name> [--per-rule N]
//       prints the deterministic review sample (N per rule, default 5) that is
//       not labeled yet, with location and statement, as label skeletons
//   npx tsx scripts/external-validation.ts report [<name>...] [--out <file.json>]
//       analyzes each project and counts its labels: per project, rule and
//       language — produced, reviewed, TP, FP, unclear, FN, precision and
//       recall (only over what was classified; recall only inside fnScope)
//
// Source code is never copied into the repository: the checkouts live under
// .stoa/ (ignored by git).

import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {loadLabels, sampleFindings, summarizeValidation, type ExternalManifest, type ValidationRow, type ValidationSummary} from '../src/evaluation/ExternalValidation.js';
import {findingKey, keyString} from '../src/FindingIdentity.js';
import {analyzeAsync} from '../src/Pipeline.js';
import type {AnalysisReport} from '../src/Types.js';
import {analysisOptionsOf, PACKAGE_ROOT} from './CompareTargets.js';

const CORPUS = join(PACKAGE_ROOT, 'validation', 'external');
const CHECKOUTS = join(PACKAGE_ROOT, '.stoa', 'external');

const manifests = (names: readonly string[]): ExternalManifest[] => {
    const all = readdirSync(CORPUS, {withFileTypes: true})
        .filter((entry) => entry.isDirectory())
        .map((entry) => JSON.parse(readFileSync(join(CORPUS, entry.name, 'manifest.json'), 'utf8')) as ExternalManifest)
        .sort((a, b) => a.name.localeCompare(b.name));
    const unknown = names.filter((name) => !all.some((manifest) => manifest.name === name));
    if (unknown.length > 0) {
        throw new Error(`no manifest for ${unknown.join(', ')} in ${CORPUS}`);
    }
    return names.length === 0 ? all : all.filter((manifest) => names.includes(manifest.name));
};

const git = (cwd: string, args: string[]): string => {
    const result = spawnSync('git', args, {cwd, encoding: 'utf8'});
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
};

const fetch = (manifest: ExternalManifest): void => {
    const dir = join(CHECKOUTS, manifest.name);
    rmSync(dir, {recursive: true, force: true});
    mkdirSync(dir, {recursive: true});
    git(dir, ['init', '-q']);
    git(dir, ['remote', 'add', 'origin', manifest.repository]);
    if (manifest.sparse !== undefined) {
        git(dir, ['sparse-checkout', 'init', '--no-cone']);
        git(dir, ['sparse-checkout', 'set', '--no-cone', ...manifest.sparse]);
    }
    git(dir, ['fetch', '-q', '--depth', '1', ...(manifest.sparse !== undefined ? ['--filter=blob:none'] : []), 'origin', manifest.commit]);
    git(dir, ['checkout', '-q', 'FETCH_HEAD']);
    const head = git(dir, ['rev-parse', 'HEAD']);
    if (head !== manifest.commit) {
        throw new Error(`${manifest.name}: checked out ${head}, expected ${manifest.commit}`);
    }
    process.stdout.write(`${manifest.name}: ${head}\n`);
};

const rootOf = (manifest: ExternalManifest): string => join(CHECKOUTS, manifest.name, manifest.root ?? '');

const analyzeProject = async (manifest: ExternalManifest): Promise<AnalysisReport> => {
    const rootPath = rootOf(manifest);
    if (!existsSync(rootPath)) {
        throw new Error(`${manifest.name}: ${rootPath} is missing — run "fetch ${manifest.name}" first`);
    }
    const head = git(join(CHECKOUTS, manifest.name), ['rev-parse', 'HEAD']);
    if (head !== manifest.commit) {
        throw new Error(`${manifest.name}: the checkout is at ${head}, the manifest pins ${manifest.commit} — run "fetch ${manifest.name}"`);
    }
    const options = analysisOptionsOf({name: manifest.name, path: rootPath, ...(manifest.analyze.solid === true ? {solid: true} : {}), ...(manifest.analyze.deadExports === true ? {deadExports: true} : {})});
    return (await analyzeAsync({...options, config: {...DEFAULT_CONFIG, exclude: [...DEFAULT_CONFIG.exclude, ...(manifest.analyze.exclude ?? [])]}})).report;
};

const labelsPath = (manifest: ExternalManifest): string => join(CORPUS, manifest.name, 'labels.json');

const sample = async (manifest: ExternalManifest, perRule: number): Promise<void> => {
    const report = await analyzeProject(manifest);
    const rootPath = rootOf(manifest);
    const labeled = existsSync(labelsPath(manifest)) ? new Set(loadLabels(labelsPath(manifest)).labels.map(keyString)) : new Set<string>();
    const byKey = new Map(report.findings.map((finding) => [keyString(findingKey(rootPath, finding)), finding]));
    const open = sampleFindings(report.findings, rootPath, perRule).filter((key) => !labeled.has(keyString(key)));
    const skeletons = open.map((key) => {
        const finding = byKey.get(keyString(key));
        return {...key, verdict: 'unclear', reason: '', line: finding?.location.range.startLine, statement: finding?.observation.statement};
    });
    process.stdout.write(`${JSON.stringify(skeletons, null, 2)}\n`);
};

const percent = (value: number | null): string => (value === null ? '–' : `${(value * 100).toFixed(1)} %`);

const rowLine = (label: string, row: ValidationRow): string =>
    `| ${label} | ${row.produced} | ${row.reviewed} | ${row.truePositives} | ${row.falsePositives} | ${row.unclear} | ${row.falseNegatives} | ${percent(row.precision)} | ${percent(row.recall)} |`;

const HEADER = '| | produced | reviewed | TP | FP | unclear | FN | precision | recall |\n|---|---|---|---|---|---|---|---|---|';

interface ProjectResult {
    manifest: ExternalManifest;
    status: string;
    filesAnalyzed: number;
    filesSkipped: number;
    summary: ValidationSummary;
}

const report = async (selected: readonly ExternalManifest[], out: string | undefined): Promise<void> => {
    const results: ProjectResult[] = [];
    for (const manifest of selected) {
        if (!existsSync(labelsPath(manifest))) {
            process.stderr.write(`${manifest.name}: no labels.json — skipped\n`);
            continue;
        }
        const analysis = await analyzeProject(manifest);
        const summary = summarizeValidation(analysis.findings, loadLabels(labelsPath(manifest)), rootOf(manifest));
        results.push({manifest, status: analysis.coverage.status, filesAnalyzed: analysis.coverage.filesAnalyzed, filesSkipped: analysis.coverage.filesSkipped, summary});
    }
    const lines = ['## Projects', '', '| project | language | commit | status | files analyzed / skipped | produced | reviewed | TP | FP | unclear | FN | precision | recall |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
    for (const {manifest, status, filesAnalyzed, filesSkipped, summary} of results) {
        const t = summary.total;
        lines.push(
            `| ${manifest.name} | ${manifest.language} | \`${manifest.commit.slice(0, 12)}\` | ${status} | ${filesAnalyzed} / ${filesSkipped} | ${t.produced} | ${t.reviewed} | ${t.truePositives} | ${t.falsePositives} | ${t.unclear} | ${t.falseNegatives} | ${percent(t.precision)} | ${percent(t.recall)} |`
        );
    }
    for (const {manifest, summary} of results) {
        lines.push('', `## ${manifest.name}`, '', HEADER, ...summary.byRule.map((row) => rowLine(row.key, row)), ...summary.byLanguage.map((row) => rowLine(`_${row.key}_`, row)));
        if (summary.stale.length > 0) {
            lines.push('', `Stale labels (no longer produced): ${summary.stale.map(keyString).join(', ')}`);
        }
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    if (out !== undefined) {
        writeFileSync(resolve(out), `${JSON.stringify(results.map(({manifest, ...rest}) => ({project: manifest.name, language: manifest.language, commit: manifest.commit, ...rest})), null, 1)}\n`, 'utf8');
    }
};

const main = async (): Promise<number> => {
    const {values, positionals} = parseArgs({allowPositionals: true, options: {'per-rule': {type: 'string', default: '5'}, out: {type: 'string'}}});
    const [command, ...names] = positionals;
    if (command === 'fetch') {
        manifests(names).forEach(fetch);
        return 0;
    }
    const [only] = command === 'sample' && names.length === 1 ? manifests(names) : [];
    if (only !== undefined) {
        await sample(only, Number.parseInt(values['per-rule'] ?? '5', 10));
        return 0;
    }
    if (command === 'report') {
        await report(manifests(names), values.out);
        return 0;
    }
    process.stderr.write('Usage: npx tsx scripts/external-validation.ts fetch [<name>...] | sample <name> [--per-rule N] | report [<name>...] [--out <file.json>]\n');
    return 2;
};

process.exit(await main());
