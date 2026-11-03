#!/usr/bin/env node
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {initCpp} from './analysis/CppAdapter.js';
import {initDart} from './analysis/DartAdapter.js';
import {initHtml} from './analysis/HtmlAdapter.js';
import {applyBaseline, IncompleteAnalysisError, loadBaseline, onlyNewFindings, saveBaseline} from './Baseline.js';
import {applyFindingFilter, parseFindingFilter} from './FindingFilter.js';
import {loadConfig} from './Config.js';
import {loadValidationContract} from './contracts/ValidationContract.js';
import {loadArchitectureConfig, type ArchitectureConfig} from './architecture/ArchitectureConfig.js';
import {loadExpected} from './evaluation/Corpus.js';
import {evaluate} from './evaluation/Evaluator.js';
import {toMarkdown as evaluationMarkdown} from './evaluation/EvaluationReporter.js';
import {analyze} from './Pipeline.js';
import {toJson, toMarkdown} from './reporting/Reporter.js';
import {toSarif} from './reporting/SarifReporter.js';
import {createSemanticAdapter} from './semantic/SemanticAdapters.js';
import {augmentWithSemantics} from './semantic/SemanticRunner.js';
import {ENGINE_VERSION} from './Version.js';
import type {AnalysisReport, AnalysisResult, Fact} from './Types.js';

// Exit codes for `stoa analyze` (see docs implementation-status — "Analysis
// Completion Integrity"): 0 only for a genuinely complete scan, 1 for a
// config/usage/internal error (nothing resembling a report was produced, or
// the invocation itself was invalid), 2 whenever `coverage.status` is not
// `'complete'` — an incomplete scan must never be indistinguishable from a
// clean one by exit code alone, regardless of which output format was asked for.
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_INCOMPLETE = 2;

/**
 * A caught setup/config/internal exception never reaches the point of
 * producing a real `AnalysisReport` — this synthesizes a minimal, validly-
 * shaped one (`status: 'failed'`, zero coverage, no findings) so JSON/SARIF/
 * Markdown output stays parseable instead of the caller seeing a bare stack
 * trace on stderr with nothing on stdout.
 */
const buildFailedReport = (message: string): AnalysisReport => ({
    versions: {engine: ENGINE_VERSION, ruleSet: '', knowledgeBase: '', adapters: {}},
    coverage: {
        status: 'failed',
        filesSelected: 0,
        filesAnalyzed: 0,
        filesSkipped: 0,
        filesCancelled: 0,
        excludedByReason: {},
        excludedSample: [],
        factCount: 0,
        analysisIncomplete: true
    },
    findings: [],
    error: message
});

type CliValues = {
    format?: string;
    config?: string;
    knowledge?: string;
    rules?: string;
    expected?: string;
    semantic?: string;
    lang?: string;
    typecheck?: boolean;
    'dead-exports'?: boolean;
    solid?: boolean;
    contracts?: string;
    architecture?: string;
    include?: string[];
    exclude?: string[];
    'memory-stats'?: boolean;
    cache?: boolean;
    baseline?: string;
    'update-baseline'?: boolean;
    'only-new'?: boolean;
    'min-confidence'?: string;
    certainty?: string[];
    'no-experimental'?: boolean;
    help?: boolean;
};

const formatMB = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

// `--memory-stats` only — summed once, at the very end, from the already-
// collected facts (never accumulated incrementally; see AnalyzeOptions.onProgress's
// own doc comment on why a diagnostic must not become its own growth source).
const evidenceGraphTotals = (facts: readonly Fact[]): {nodes: number; edges: number} => {
    let nodes = 0;
    let edges = 0;
    for (const fact of facts) {
        if (fact.kind !== 'validation.dataflowGraph') {
            continue;
        }
        const value = fact.value as unknown as {graph?: {nodes?: unknown[]; edges?: unknown[]}};
        nodes += value.graph?.nodes?.length ?? 0;
        edges += value.graph?.edges?.length ?? 0;
    }
    return {nodes, edges};
};

const configFor = (values: CliValues) => {
    const base = loadConfig(values.config ?? null);
    const include = values.include !== undefined && values.include.length > 0 ? values.include : base.include;
    const exclude = values.exclude !== undefined && values.exclude.length > 0 ? values.exclude : base.exclude;
    return {...base, include, exclude};
};

const USAGE = [
    'stoa – Stoic Code Analysis Engine',
    '',
    'Usage:',
    '  stoa analyze <path> [--format markdown|json|sarif] [--lang en|de] [--include <glob>]... [--exclude <glob>]... [--typecheck] [--dead-exports] [--solid] [--architecture <file>] [--contracts <file>] [--semantic noop|anthropic] [--config <file>] [--knowledge <dir>] [--rules <dir>] [--memory-stats] [--cache] [--baseline <file>] [--update-baseline] [--only-new] [--min-confidence <0..1>] [--certainty <list>]... [--no-experimental]',
    '  stoa eval <path> --expected <file> [--format markdown|json] [--contracts <file>] [--knowledge <dir>] [--rules <dir>]',
    ''
].join('\n');

// Resolve bundled knowledge/rules relative to the installed package (this file
// is dist/Cli.js or src/Cli.ts; the package root is one level up), so the CLI
// works from any working directory after a global install or `npm link`.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const knowledgeDirOf = (values: CliValues): string => {
    return values.knowledge !== undefined ? resolve(values.knowledge) : join(PACKAGE_ROOT, 'knowledge', 'marcus');
};

const ruleSetDirOf = (values: CliValues): string => {
    return values.rules !== undefined ? resolve(values.rules) : join(PACKAGE_ROOT, 'rules', 'default');
};

const render = (format: string | undefined, report: AnalysisReport, lang: string): string => {
    if (format === 'json') {
        return toJson(report);
    }
    if (format === 'sarif') {
        return toSarif(report, {baseDir: process.cwd()});
    }
    return toMarkdown(report, {lang});
};

// A malformed/unreadable contract is an explicit configuration error, fail
// fast — never silently analyze (or evaluate) with the feature half-engaged.
// Shared by `analyze` and `eval`: both accept --contracts and must treat a
// bad contract identically rather than one of them silently ignoring it.
const loadContractOrFail = (values: CliValues): {contract: ReturnType<typeof loadValidationContract> | null} | null => {
    if (values.contracts === undefined) {
        return {contract: null};
    }
    try {
        return {contract: loadValidationContract(resolve(values.contracts))};
    } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`);
        return null;
    }
};

// Same fail-fast discipline for --architecture (E5b): a broken config is an
// explicit error, never a silently layer-less run.
const loadArchitectureOrFail = (values: CliValues): {config: ArchitectureConfig | null} | null => {
    if (values.architecture === undefined) {
        return {config: null};
    }
    try {
        return {config: loadArchitectureConfig(resolve(values.architecture))};
    } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`);
        return null;
    }
};

// Both user-supplied inputs of `analyze`; null = one of them failed (already reported).
const loadAnalyzeInputsOrFail = (values: CliValues): {contract: ReturnType<typeof loadValidationContract> | null; architecture: ArchitectureConfig | null} | null => {
    const loadedContract = loadContractOrFail(values);
    const loadedArchitecture = loadedContract === null ? null : loadArchitectureOrFail(values);
    return loadedContract === null || loadedArchitecture === null ? null : {contract: loadedContract.contract, architecture: loadedArchitecture.config};
};

const runAnalyze = async (values: CliValues, target: string): Promise<number> => {
    // Option-combination validation up front, before any analysis work —
    // an invalid combination is a usage error, not something that should
    // cost a full (possibly long) scan before being reported.
    if (values['only-new'] === true && values.baseline === undefined) {
        process.stderr.write('error: --only-new requires --baseline <file>\n');
        return EXIT_ERROR;
    }
    if (values['update-baseline'] === true && values.baseline === undefined) {
        process.stderr.write('error: --update-baseline requires --baseline <file>\n');
        return EXIT_ERROR;
    }
    const findingFilter = parseFindingFilter({
        ...(values['min-confidence'] !== undefined ? {minConfidence: values['min-confidence']} : {}),
        ...(values.certainty !== undefined ? {certainty: values.certainty} : {}),
        noExperimental: values['no-experimental'] === true
    });
    if ('error' in findingFilter) {
        process.stderr.write(`${findingFilter.error}\n`);
        return EXIT_ERROR;
    }

    const lang = values.lang ?? 'en';
    const inputs = loadAnalyzeInputsOrFail(values);
    if (inputs === null) {
        return EXIT_ERROR;
    }
    const validationContract = inputs.contract;
    // Load the tree-sitter (WASM) grammars once before the synchronous pipeline
    // runs. Sequentially, not concurrently: both call the shared web-tree-sitter
    // Parser.init(), which is not safe to race. On failure those files are skipped.
    await initDart().catch(() => undefined);
    await initCpp().catch(() => undefined);
    await initHtml().catch(() => undefined);
    const memoryStats = values['memory-stats'] === true;
    const rootPath = resolve(target);
    let result: AnalysisResult;
    try {
        result = analyze({
            rootPath,
            knowledgeDir: knowledgeDirOf(values),
            ruleSetDir: ruleSetDirOf(values),
            config: configFor(values),
            lang,
            typecheck: values.typecheck === true,
            deadExports: values['dead-exports'] === true,
            solid: values.solid === true,
            validationContract,
            architecture: inputs.architecture,
            ...(values.cache === true ? {cacheDir: join(rootPath, '.stoa', 'cache')} : {}),
            ...(memoryStats
                ? {
                      onProgress: (snapshot, progress) => {
                          const elapsed = (progress.elapsedMs / 1000).toFixed(1);
                          process.stderr.write(
                              `[stoa] ${progress.phase}: files ${progress.filesProcessed}/${progress.filesSelected} | facts ${progress.factsExtracted} | heap ${formatMB(snapshot.heapUsed)}/${formatMB(snapshot.heapSizeLimit)} (total ${formatMB(snapshot.heapTotal)}) | rss ${formatMB(snapshot.rss)} | external ${formatMB(snapshot.external)} | ${elapsed}s\n`
                          );
                      }
                  }
                : {}),
            // Test-only hook, not a documented flag: deterministically forces
            // `coverage.status: 'partial'` without needing to actually exhaust
            // memory, so the baseline-vs-incomplete-scan interaction (Section
            // 2.3) can be tested end-to-end through the real CLI, not just at
            // the Baseline.ts unit level. Invisible to a normal run.
            ...(process.env.STOA_TEST_FORCE_INCOMPLETE === '1' ? {memoryGuard: {checkEveryFiles: 1, criticalRatio: 0}} : {})
        });
    } catch (error) {
        // A setup/config error (bad rootPath, malformed rule set/knowledge
        // base, …) never reaches a real report — synthesize a minimal
        // `status: 'failed'` one so JSON/SARIF/Markdown output stays
        // parseable, rather than crashing with a bare stack trace.
        const message = (error as Error).message;
        process.stderr.write(`${message}\n`);
        process.stdout.write(`${render(values.format, buildFailedReport(message), lang)}\n`);
        return EXIT_ERROR;
    }

    const semanticId = values.semantic ?? 'noop';
    if (semanticId !== 'noop') {
        // Optional, async, off the deterministic path: augment findings with a
        // grounded LLM verdict. Failures degrade gracefully to the plain report.
        result = await augmentWithSemantics(result, createSemanticAdapter(semanticId));
    }

    if (memoryStats) {
        const cacheNote = result.report.coverage.cacheHits !== undefined ? `, ${result.report.coverage.cacheHits} cache hits` : '';
        const evidence = evidenceGraphTotals(result.facts);
        process.stderr.write(
            `[stoa] done: ${result.report.coverage.filesAnalyzed} analyzed, ${result.report.coverage.filesSkipped} skipped, ${result.report.coverage.factCount} facts, ${result.report.findings.length} findings, ${evidence.nodes} evidence nodes / ${evidence.edges} evidence edges${cacheNote}\n`
        );
    }
    // The run did not fully complete: say so loudly, on every format, not
    // only buried in `coverage` — a truncated analysis must never read like
    // a complete one. Covers both a memory-guard abort and a coverage gap
    // (a selected file that could not be read/parsed) — see Pipeline.ts.
    if (result.report.coverage.status === 'partial') {
        const abortNote = result.report.coverage.stoppedAtFile !== undefined ? ` before reaching "${result.report.coverage.stoppedAtFile}"` : '';
        process.stderr.write(`[stoa] WARNING: analysis is only partial${abortNote} — this report covers only the files actually reached, not the full selection (see coverage.excludedByReason/excludedSample).\n`);
    }

    if (values.baseline !== undefined) {
        const baselinePath = resolve(values.baseline);
        let baseline;
        try {
            baseline = loadBaseline(baselinePath);
        } catch (error) {
            // A malformed baseline is a configuration error, never silently
            // treated as "no baseline" — that would make every known finding
            // look new, the opposite of what a baseline is for.
            process.stderr.write(`${(error as Error).message}\n`);
            return EXIT_ERROR;
        }
        let report = applyBaseline(result.report, baseline, rootPath);
        if (report.baseline?.incomplete === true) {
            // Same visibility as the partial-analysis warning above — a
            // provisional baseline comparison must never read like a
            // complete one, on any output format.
            process.stderr.write('[stoa] WARNING: the analysis was incomplete — baseline new/known status is provisional, and nothing is reported as fixed (a file the scan never reached was never actually re-checked).\n');
        }
        if (values['update-baseline'] === true) {
            // Reflects the CURRENT run (pre-filter) — updating the baseline
            // and asking to see only the new findings in the same invocation
            // would otherwise make the "new" set invisible to itself.
            try {
                saveBaseline(baselinePath, result.report, rootPath);
            } catch (error) {
                if (error instanceof IncompleteAnalysisError) {
                    // Not a separate failure mode — the underlying analysis
                    // being non-'complete' is already what drives the exit
                    // code below; just make the specific refusal visible too.
                    process.stderr.write(`${error.message}\n`);
                } else {
                    // A genuine I/O/config error writing the baseline — this
                    // IS its own execution error, independent of coverage status.
                    process.stderr.write(`${(error as Error).message}\n`);
                    return EXIT_ERROR;
                }
            }
        }
        if (values['only-new'] === true) {
            report = onlyNewFindings(report);
        }
        result = {...result, report};
    }

    // E1c: output filters act last — after the baseline comparison and after
    // any baseline update above, both of which saw every finding.
    result = {...result, report: applyFindingFilter(result.report, findingFilter)};

    process.stdout.write(`${render(values.format, result.report, lang)}\n`);
    return result.report.coverage.status === 'complete' ? EXIT_OK : EXIT_INCOMPLETE;
};

const runEval = async (values: CliValues, target: string): Promise<number> => {
    if (values.expected === undefined) {
        process.stdout.write(`${USAGE}\n`);
        return 1;
    }
    const loadedContract = loadContractOrFail(values);
    if (loadedContract === null) {
        return 1;
    }
    // Load the tree-sitter grammars so eval covers Dart and C/C++ too, not only
    // the synchronously-parsed TS/PHP. Sequentially (shared Parser.init() is not
    // safe to race); on failure those files are skipped.
    await initDart().catch(() => undefined);
    await initCpp().catch(() => undefined);
    await initHtml().catch(() => undefined);
    const root = resolve(target);
    let expected;
    try {
        expected = loadExpected(resolve(values.expected));
    } catch (error) {
        // A malformed/unreadable manifest is an explicit evaluation error, not a pass.
        process.stderr.write(`${(error as Error).message}\n`);
        return 1;
    }
    const analyzed = analyze({
        rootPath: root,
        knowledgeDir: knowledgeDirOf(values),
        ruleSetDir: ruleSetDirOf(values),
        config: configFor(values),
        validationContract: loadedContract.contract
    });
    // `eval`'s exit code means precision/recall pass/fail, not analysis
    // completeness (that is `analyze`'s 0/1/2 — see EXIT_INCOMPLETE above) —
    // deliberately NOT changed here. Still surfaced, so a partial underlying
    // scan is never silently read as a trustworthy precision/recall number.
    if (analyzed.report.coverage.status !== 'complete') {
        process.stderr.write(`[stoa] WARNING: the underlying analysis was not complete (status: ${analyzed.report.coverage.status}) — this evaluation's precision/recall reflects only the files actually reached.\n`);
    }
    const findings = analyzed.report.findings;
    const result = evaluate(findings, expected, root);
    const output = values.format === 'json' ? JSON.stringify(result, null, 2) : evaluationMarkdown(result);
    process.stdout.write(`${output}\n`);
    // The evaluation passes only when nothing is missing or spurious and the
    // manifest is internally consistent: any false negative, false positive, or
    // duplicate expected identity fails it.
    const passed = result.overall.falseNegatives === 0 && result.overall.falsePositives === 0 && result.duplicateExpected.length === 0;
    return passed ? 0 : 1;
};

const main = async (): Promise<number> => {
    const {values, positionals} = parseArgs({
        allowPositionals: true,
        options: {
            format: {type: 'string', default: 'markdown'},
            config: {type: 'string'},
            knowledge: {type: 'string'},
            rules: {type: 'string'},
            expected: {type: 'string'},
            semantic: {type: 'string'},
            lang: {type: 'string', default: 'en'},
            typecheck: {type: 'boolean', default: false},
            'dead-exports': {type: 'boolean', default: false},
            solid: {type: 'boolean', default: false},
            contracts: {type: 'string'},
            architecture: {type: 'string'},
            include: {type: 'string', multiple: true},
            exclude: {type: 'string', multiple: true},
            'memory-stats': {type: 'boolean', default: false},
            cache: {type: 'boolean', default: false},
            baseline: {type: 'string'},
            'update-baseline': {type: 'boolean', default: false},
            'only-new': {type: 'boolean', default: false},
            'min-confidence': {type: 'string'},
            certainty: {type: 'string', multiple: true},
            'no-experimental': {type: 'boolean', default: false},
            help: {type: 'boolean', default: false}
        }
    });

    const command = positionals[0];
    const target = positionals[1];

    if (values.help === true || command === undefined || target === undefined) {
        process.stdout.write(`${USAGE}\n`);
        return values.help === true ? 0 : 1;
    }

    if (command === 'analyze') {
        return runAnalyze(values, target);
    }
    if (command === 'eval') {
        return runEval(values, target);
    }

    process.stdout.write(`${USAGE}\n`);
    return 1;
};

// Set the exit code instead of calling process.exit(): exit() terminates
// before an asynchronous stdout (a pipe on POSIX) is drained, which cut a
// large JSON/SARIF report at 64 KiB when piped (`stoa analyze … | jq`).
process.exitCode = await main();
