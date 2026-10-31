#!/usr/bin/env node
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {initCpp} from './analysis/CppAdapter.js';
import {initDart} from './analysis/DartAdapter.js';
import {initHtml} from './analysis/HtmlAdapter.js';
import {loadConfig} from './Config.js';
import {loadValidationContract} from './contracts/ValidationContract.js';
import {loadExpected} from './evaluation/Corpus.js';
import {evaluate} from './evaluation/Evaluator.js';
import {toMarkdown as evaluationMarkdown} from './evaluation/EvaluationReporter.js';
import {analyze} from './Pipeline.js';
import {toJson, toMarkdown} from './reporting/Reporter.js';
import {toSarif} from './reporting/SarifReporter.js';
import {createSemanticAdapter} from './semantic/SemanticAdapters.js';
import {augmentWithSemantics} from './semantic/SemanticRunner.js';
import type {AnalysisReport} from './Types.js';

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
    contracts?: string;
    include?: string[];
    exclude?: string[];
    'memory-stats'?: boolean;
    cache?: boolean;
    help?: boolean;
};

const formatMB = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

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
    '  stoa analyze <path> [--format markdown|json|sarif] [--lang en|de] [--include <glob>]... [--exclude <glob>]... [--typecheck] [--dead-exports] [--contracts <file>] [--semantic noop|anthropic] [--config <file>] [--knowledge <dir>] [--rules <dir>] [--memory-stats] [--cache]',
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

const runAnalyze = async (values: CliValues, target: string): Promise<number> => {
    const lang = values.lang ?? 'en';
    const loadedContract = loadContractOrFail(values);
    if (loadedContract === null) {
        return 1;
    }
    const validationContract = loadedContract.contract;
    // Load the tree-sitter (WASM) grammars once before the synchronous pipeline
    // runs. Sequentially, not concurrently: both call the shared web-tree-sitter
    // Parser.init(), which is not safe to race. On failure those files are skipped.
    await initDart().catch(() => undefined);
    await initCpp().catch(() => undefined);
    await initHtml().catch(() => undefined);
    const memoryStats = values['memory-stats'] === true;
    const rootPath = resolve(target);
    let result = analyze({
        rootPath,
        knowledgeDir: knowledgeDirOf(values),
        ruleSetDir: ruleSetDirOf(values),
        config: configFor(values),
        lang,
        typecheck: values.typecheck === true,
        deadExports: values['dead-exports'] === true,
        validationContract,
        ...(values.cache === true ? {cacheDir: join(rootPath, '.stoa', 'cache')} : {}),
        ...(memoryStats
            ? {
                  onProgress: (snapshot, progress) => {
                      process.stderr.write(`[stoa] files ${progress.filesProcessed}/${progress.filesSelected} | heap ${formatMB(snapshot.heapUsed)}/${formatMB(snapshot.heapSizeLimit)} | rss ${formatMB(snapshot.rss)}\n`);
                  }
              }
            : {})
    });

    const semanticId = values.semantic ?? 'noop';
    if (semanticId !== 'noop') {
        // Optional, async, off the deterministic path: augment findings with a
        // grounded LLM verdict. Failures degrade gracefully to the plain report.
        result = await augmentWithSemantics(result, createSemanticAdapter(semanticId));
    }

    if (memoryStats) {
        const cacheNote = result.report.coverage.cacheHits !== undefined ? `, ${result.report.coverage.cacheHits} cache hits` : '';
        process.stderr.write(`[stoa] done: ${result.report.coverage.filesAnalyzed} analyzed, ${result.report.coverage.filesSkipped} skipped, ${result.report.coverage.factCount} facts, ${result.report.findings.length} findings${cacheNote}\n`);
    }
    // The memory guard stopped early: say so loudly, on every format, not only
    // buried in `coverage` — a truncated analysis must never read like a
    // complete one.
    if (result.report.coverage.analysisIncomplete === true) {
        process.stderr.write(`[stoa] WARNING: analysis stopped early under memory pressure before reaching "${result.report.coverage.stoppedAtFile}" — this report covers only the files reached up to that point, not the full selection.\n`);
    }

    process.stdout.write(`${render(values.format, result.report, lang)}\n`);
    return 0;
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
    const findings = analyze({
        rootPath: root,
        knowledgeDir: knowledgeDirOf(values),
        ruleSetDir: ruleSetDirOf(values),
        config: configFor(values),
        validationContract: loadedContract.contract
    }).report.findings;
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
            contracts: {type: 'string'},
            include: {type: 'string', multiple: true},
            exclude: {type: 'string', multiple: true},
            'memory-stats': {type: 'boolean', default: false},
            cache: {type: 'boolean', default: false},
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

process.exit(await main());
