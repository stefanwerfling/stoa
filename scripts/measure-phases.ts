#!/usr/bin/env node
// Memory and time per pipeline phase.
//
// Runs every target in a fresh Node process started with `--expose-gc` and
// samples memory after a full garbage collection at each pipeline phase
// (`AnalyzeOptions.onProgress`, see src/Pipeline.ts `AnalysisProgress`):
//   start            before the analysis (grammars, rule set, knowledge base not yet loaded)
//   afterIngestion   every file read and extracted — the facts
//   afterGraphs      Dart library index, ModuleGraph, SymbolGraph, widget graph built
//   afterEvaluation  every rule evaluated — the findings (the graphs still alive)
//   resultAlive      `analyzeAsync` returned, the result still referenced
//   released         the result dropped
// Retained memory (live objects after a collection) is reproducible for a
// given input; garbage that a run produces between two samples is not
// visible here — the peak RSS (`process.resourceUsage().maxRSS`) and the
// phase timings are reported alongside (both machine- and load-dependent).
// The analysis itself is the unchanged `analyzeAsync` of the given checkout:
// sampling only collects garbage, it changes no fact, finding or report.
//
// Usage:
//   npx tsx scripts/measure-phases.ts [--targets <file>] [--out <file.json>]
// Targets: see scripts/CompareTargets.ts. Output: one JSON line per target on
// stdout, a Markdown table at the end, and the rows in `--out` if given.

import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {analyzeAsync} from '../src/Pipeline.js';
import type {PipelineMetrics} from '../src/PipelineMetrics.js';
import {analysisOptionsOf, DEFAULT_TARGETS, readTargets, type Target} from './CompareTargets.js';

const SCRIPT = fileURLToPath(import.meta.url);
const POINTS = ['start', 'afterIngestion', 'afterGraphs', 'afterEvaluation', 'resultAlive', 'released'] as const;
type Point = (typeof POINTS)[number];

/** Memory after a full collection, in MB (one decimal). */
interface Sample {
    heapUsed: number;
    external: number;
    arrayBuffers: number;
    rss: number;
}

interface Row {
    target: string;
    files: number;
    facts: number;
    findings: number;
    status: string;
    samples: Record<Point, Sample>;
    peakRssMb: number;
    timingsMs: PipelineMetrics['timingsMs'];
}

const mb = (bytes: number): number => Math.round((bytes / 1048576) * 10) / 10;

const collectGarbage = (): void => {
    const gc: unknown = Reflect.get(globalThis, 'gc');
    if (typeof gc !== 'function') {
        throw new Error('measure-phases: run the measuring process with node --expose-gc');
    }
    // Twice: the first pass can leave objects that only became unreachable through it.
    gc();
    gc();
};

const sample = (): Sample => {
    collectGarbage();
    const usage = process.memoryUsage();
    return {heapUsed: mb(usage.heapUsed), external: mb(usage.external), arrayBuffers: mb(usage.arrayBuffers), rss: mb(usage.rss)};
};

/** One target, in this process (started with --expose-gc by `main`). */
const measure = async (target: Target): Promise<Row> => {
    const samples: Partial<Record<Point, Sample>> = {start: sample()};
    let evaluationCalls = 0;
    let metrics: PipelineMetrics | undefined;
    // In a function of its own: its frame, and with it the result, is gone
    // when it returns (a top-level `await` keeps its value reachable).
    const counts = await (async (): Promise<{files: number; facts: number; findings: number; status: string}> => {
        const result = await analyzeAsync({
            ...analysisOptionsOf(target),
            onProgress: (_snapshot, progress) => {
                if (progress.phase === 'evaluation') {
                    samples[evaluationCalls === 0 ? 'afterIngestion' : 'afterEvaluation'] = sample();
                    evaluationCalls += 1;
                } else if (progress.phase === 'graphs') {
                    samples.afterGraphs = sample();
                }
            },
            onMetrics: (collected) => {
                metrics = collected;
            }
        });
        samples.resultAlive = sample();
        return {files: result.report.coverage.filesAnalyzed, facts: result.facts.length, findings: result.report.findings.length, status: result.report.coverage.status};
    })();
    samples.released = sample();
    if (metrics === undefined) {
        throw new Error(`measure-phases: ${target.name} reported no metrics`);
    }
    const at = (point: Point): Sample => {
        const taken = samples[point];
        if (taken === undefined) {
            throw new Error(`measure-phases: ${target.name} did not pass the phase ${point}`);
        }
        return taken;
    };
    const complete: Record<Point, Sample> = {
        start: at('start'),
        afterIngestion: at('afterIngestion'),
        afterGraphs: at('afterGraphs'),
        afterEvaluation: at('afterEvaluation'),
        resultAlive: at('resultAlive'),
        released: at('released')
    };
    return {target: target.name, ...counts, samples: complete, peakRssMb: mb(metrics.peakRssBytes), timingsMs: metrics.timingsMs};
};

const table = (rows: readonly Row[]): string => {
    const heap = (row: Row, point: Point): string => `${row.samples[point].heapUsed}`;
    const lines = [
        '| target | files | facts | findings | heap MB start / ingestion / graphs / evaluation / result / released | rss after ingestion MB | peak rss MB | ms extraction / graphs / evaluation / total |',
        '|---|---|---|---|---|---|---|---|'
    ];
    for (const row of rows) {
        const t = row.timingsMs;
        lines.push(
            `| ${row.target} | ${row.files} | ${row.facts} | ${row.findings} | ${POINTS.map((point) => heap(row, point)).join(' / ')} | ${row.samples.afterIngestion.rss} | ${row.peakRssMb} | ${t.extraction} / ${t.graphs} / ${t.evaluation} / ${t.total} |`
        );
    }
    return `${lines.join('\n')}\n`;
};

const main = async (): Promise<number> => {
    const {values, positionals} = parseArgs({allowPositionals: true, options: {targets: {type: 'string'}, out: {type: 'string'}, target: {type: 'string'}}});
    const targets = readTargets(resolve(values.targets ?? DEFAULT_TARGETS));
    if (positionals[0] === 'one') {
        // The child: one target, its row as JSON on stdout.
        const target = targets.find((candidate) => candidate.name === values.target);
        if (target === undefined) {
            process.stderr.write(`measure-phases: no target named ${values.target ?? '(none)'}\n`);
            return 2;
        }
        process.stdout.write(`${JSON.stringify(await measure(target))}\n`);
        return 0;
    }
    const rows: Row[] = [];
    for (const target of targets) {
        const child = spawnSync(
            process.execPath,
            ['--expose-gc', '--import', 'tsx', SCRIPT, 'one', '--target', target.name, '--targets', resolve(values.targets ?? DEFAULT_TARGETS)],
            {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}
        );
        if (child.status !== 0) {
            process.stderr.write(`measure-phases: ${target.name} failed (exit ${child.status ?? 'signal'}):\n${child.stderr}`);
            return 1;
        }
        const line = child.stdout.trim().split('\n').pop() ?? '';
        process.stdout.write(`${line}\n`);
        rows.push(JSON.parse(line) as Row);
    }
    process.stdout.write(`\n${table(rows)}`);
    if (values.out !== undefined) {
        writeFileSync(resolve(values.out), `${JSON.stringify(rows, null, 1)}\n`, 'utf8');
    }
    return 0;
};

process.exit(await main());
