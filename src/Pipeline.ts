import {AdapterRegistry} from './analysis/AdapterRegistry.js';
import {CppAdapter} from './analysis/CppAdapter.js';
import {DartAdapter} from './analysis/DartAdapter.js';
import {AngularAdapter} from './analysis/AngularAdapter.js';
import {HtmlAdapter} from './analysis/HtmlAdapter.js';
import {VueAdapter} from './analysis/VueAdapter.js';
import {PhpAdapter} from './analysis/PhpAdapter.js';
import {TypeScriptAdapter} from './analysis/TypeScriptAdapter.js';
import {TypeDiagnosticsExtractor} from './analysis/typescript/TypeDiagnostics.js';
import {FactCache} from './FactCache.js';
import {collectFiles, readFileContent} from './Ingestion.js';
import {loadProjectConfig} from './config/ProjectConfig.js';
import {ModuleResolver} from './analysis/ModuleResolution.js';
import {buildModuleGraph} from './model/ModuleGraph.js';
import {KnowledgeBase} from './knowledge/KnowledgeBase.js';
import {isMemoryCritical, takeMemorySnapshot, type MemorySnapshot} from './MemoryGuard.js';
import {RuleEngine} from './rules/RuleEngine.js';
import {RuleSet} from './rules/RuleSet.js';
import {DependencyCycleRule} from './rules/project/DependencyCycleRule.js';
import {DeadExportRule} from './rules/project/DeadExportRule.js';
import {ValidationContractRule} from './rules/project/ValidationContractRule.js';
import type {ProjectRule} from './rules/ProjectRule.js';
import type {ValidationContract} from './contracts/ValidationContract.js';
import {ENGINE_VERSION} from './Version.js';
import type {AnalysisReport, AnalysisResult, AnalysisStatus, ExcludedFile, ExclusionReason, Fact, Finding, StoaConfig, VersionStamp} from './Types.js';

export interface AnalyzeOptions {
    rootPath: string;
    knowledgeDir: string;
    ruleSetDir: string;
    config: StoaConfig;
    /** Output language for localized finding text; defaults to 'en'. */
    lang?: string;
    /** Opt-in: run the TypeScript type checker as an external fact source. */
    typecheck?: boolean;
    /** Opt-in: flag exports used nowhere in the analyzed set (whole-project scans only). */
    deadExports?: boolean;
    /**
     * Opt-in: a loaded, schema-validated Validation Contract (see
     * contracts/ValidationContract.ts). When supplied, stoa:validation
     * annotations found in TypeScript sources are checked against it; when
     * omitted, annotations are still extracted as facts (harmless) but never
     * interpreted, so the feature is fully inert by default.
     */
    validationContract?: ValidationContract | null;
    /**
     * Opt-in diagnostic hook, called every `MEMORY_CHECK_INTERVAL` files with a
     * memory snapshot and progress (see MemoryGuard.ts / CLI
     * `--memory-stats`). Never required for correct analysis — purely
     * observational, and never asked to retain anything across calls (callers
     * that want a trend print/log each call rather than accumulating them, so
     * the diagnostic itself never becomes a growth source).
     */
    onProgress?: (snapshot: MemorySnapshot, progress: AnalysisProgress) => void;
    /**
     * Overrides for the memory guard (see MemoryGuard.ts). Not exposed as a
     * CLI flag — the defaults are already derived from V8's own heap limit,
     * not a fixed guess, so there is nothing a typical run needs to tune.
     * Exists for tests (a deterministic trigger, e.g. `criticalRatio: 0`) and
     * for embedding Stoa under a tighter/looser budget than the default.
     */
    memoryGuard?: {checkEveryFiles?: number; criticalRatio?: number};
    /**
     * Opt-in: a directory for the fact cache (see FactCache.ts). Caches ONLY
     * per-file fact extraction, keyed by (running engine code, adapter id,
     * file path, file content) — never a rule/contract-dependent result, so
     * a rule set or Validation Contract change can never be served a stale
     * finding. Omit (the default) for the exact previous behavior: nothing
     * is read from or written to disk beyond the analysis target itself.
     */
    cacheDir?: string;
}

/** One `onProgress` snapshot's non-memory half — see AnalyzeOptions.onProgress. */
export interface AnalysisProgress {
    phase: 'discovery' | 'analysis' | 'evaluation';
    filesSelected: number;
    filesProcessed: number;
    factsExtracted: number;
    elapsedMs: number;
}

const TS_EXTENSIONS: readonly string[] = ['.ts', '.tsx'] as const;

// How often (in files) the memory guard samples `process.memoryUsage()` and
// checks it against V8's own heap limit, by default. Frequent enough to
// catch trouble within a few files of it starting; infrequent enough that
// the check itself (the one part of this pipeline that runs on every single
// file regardless of language or size) stays negligible overhead.
const DEFAULT_MEMORY_CHECK_INTERVAL = 100;
const DEFAULT_CRITICAL_RATIO = 0.9;

// Caps the number of individual excluded/skipped files kept as examples in
// `coverage.excludedSample` — the exact COUNT per reason always lives in
// `excludedByReason` regardless of repo size; this bounds only the sample
// list, so a repository with e.g. tens of thousands of gitignored files
// cannot turn this diagnostic itself into an unbounded growth source.
const EXCLUDED_SAMPLE_LIMIT = 20;


/**
 * Orchestrates the deterministic analysis pipeline:
 * ingest -> extract facts -> evaluate rules -> assemble report. There is no
 * clock, randomness or network on this path, so a run is reproducible for a
 * given input and set of versions (see docs architecture §6).
 */
export const analyze = (options: AnalyzeOptions): AnalysisResult => {
    const registry = new AdapterRegistry()
        .register(new TypeScriptAdapter())
        .register(new PhpAdapter())
        .register(new DartAdapter())
        .register(new CppAdapter())
        .register(new AngularAdapter())
        .register(new HtmlAdapter())
        .register(new VueAdapter());
    const knowledgeBase = KnowledgeBase.loadFromDirectory(options.knowledgeDir, options.config.knowledgeBase);
    const ruleSet = RuleSet.loadFromDirectory(options.ruleSetDir, options.config.ruleSet);
    const projectRules: ProjectRule[] = [new DependencyCycleRule()];
    if (options.deadExports === true) {
        projectRules.push(new DeadExportRule());
    }
    if (options.validationContract !== undefined && options.validationContract !== null) {
        projectRules.push(new ValidationContractRule(options.validationContract));
    }
    const ruleEngine = new RuleEngine(knowledgeBase, ruleSet, options.lang ?? 'en', projectRules);

    const startedAt = Date.now();
    const excludedByReason: Partial<Record<ExclusionReason, number>> = {};
    const excludedSample: ExcludedFile[] = [];
    const recordExcluded = (excluded: ExcludedFile): void => {
        excludedByReason[excluded.reason] = (excludedByReason[excluded.reason] ?? 0) + 1;
        if (excludedSample.length < EXCLUDED_SAMPLE_LIMIT) {
            excludedSample.push(excluded);
        }
    };

    const files = collectFiles(options.rootPath, {
        include: options.config.include,
        exclude: options.config.exclude,
        ...(options.config.maxFileBytes !== undefined ? {maxFileBytes: options.config.maxFileBytes} : {}),
        onExcluded: recordExcluded
    });
    options.onProgress?.(takeMemorySnapshot(), {phase: 'discovery', filesSelected: files.length, filesProcessed: 0, factsExtracted: 0, elapsedMs: Date.now() - startedAt});

    const typeExtractor = options.typecheck === true ? new TypeDiagnosticsExtractor() : null;
    const cache = options.cacheDir !== undefined ? new FactCache(options.cacheDir) : null;

    const checkEveryFiles = options.memoryGuard?.checkEveryFiles ?? DEFAULT_MEMORY_CHECK_INTERVAL;
    const criticalRatio = options.memoryGuard?.criticalRatio ?? DEFAULT_CRITICAL_RATIO;

    const facts: Fact[] = [];
    let analyzed = 0;
    let skipped = 0;
    let cacheHits = 0;
    let hasCoverageGap = false;
    let stoppedAtFile: string | undefined;
    let stoppedAtIndex: number | undefined;
    for (const [index, meta] of files.entries()) {
        if (index % checkEveryFiles === 0) {
            const snapshot = takeMemorySnapshot();
            options.onProgress?.(snapshot, {phase: 'analysis', filesSelected: files.length, filesProcessed: index, factsExtracted: facts.length, elapsedMs: Date.now() - startedAt});
            // Stop ingesting further files rather than let V8 crash with a
            // fatal "JavaScript heap out of memory" error. Facts and findings
            // already produced are kept (never discarded) and reported as
            // genuinely partial via `coverage.status` — never silently
            // presented as a complete analysis. No global.gc() call here: by
            // design, this guard is a last resort, not a substitute for
            // bounded object lifetimes elsewhere in the pipeline.
            if (isMemoryCritical(snapshot, criticalRatio)) {
                stoppedAtFile = meta.path;
                stoppedAtIndex = index;
                break;
            }
        }

        // Resolved by path alone (FileMeta, no content) — a file nothing can
        // parse is never read at all. Not a coverage gap: Stoa simply has no
        // adapter for this language, the same as an excluded-by-config file.
        const adapter = registry.resolve(meta);
        if (adapter === null) {
            skipped += 1;
            recordExcluded({path: meta.path, reason: 'unsupported_language'});
            continue;
        }

        // Content is read lazily, right here, only once a matching adapter
        // is known — this is the one and only point in the whole pipeline
        // a file's content enters memory. Unlike a structural exclusion,
        // this file WAS selected and expected to be analyzed, so a failure
        // here is a genuine coverage gap (forces `status: 'partial'`), not
        // an intentional exclusion — a race with a concurrent delete/move
        // between discovery and read is the realistic cause.
        let file;
        try {
            file = readFileContent(meta);
        } catch (error) {
            skipped += 1;
            hasCoverageGap = true;
            recordExcluded({path: meta.path, reason: 'read_error', detail: (error as Error).message});
            continue;
        }

        const cachedAdapterFacts = cache?.get(adapter.id, file) ?? null;
        if (cachedAdapterFacts !== null) {
            facts.push(...cachedAdapterFacts);
            cacheHits += 1;
        } else {
            const parsed = adapter.parse(file);
            if (!parsed.ok) {
                skipped += 1;
                hasCoverageGap = true;
                recordExcluded({path: meta.path, reason: 'read_error', detail: `parse failed: ${parsed.diagnostics.join('; ')}`});
                continue;
            }
            const extracted = adapter.extractFacts(parsed, {rootDir: options.rootPath});
            facts.push(...extracted);
            cache?.set(adapter.id, file, extracted);
            parsed.release?.();
        }

        // Independent of the adapter cache above: TypeDiagnosticsExtractor
        // builds its own ts-morph Project from `file` directly (not from
        // `parsed.handle`), so it has its own cache entry under a distinct
        // adapter id ('tsc') and works correctly whether or not the main
        // adapter facts were a cache hit.
        if (typeExtractor !== null && TS_EXTENSIONS.some((ext) => file.path.endsWith(ext))) {
            const cachedTscFacts = cache?.get('tsc', file) ?? null;
            if (cachedTscFacts !== null) {
                facts.push(...cachedTscFacts);
                cacheHits += 1;
            } else {
                const tscFacts = typeExtractor.extract(file);
                facts.push(...tscFacts);
                cache?.set('tsc', file, tscFacts);
            }
        }
        analyzed += 1;
    }

    options.onProgress?.(takeMemorySnapshot(), {phase: 'evaluation', filesSelected: files.length, filesProcessed: analyzed + skipped, factsExtracted: facts.length, elapsedMs: Date.now() - startedAt});
    // Phase 0: build the reusable, project-wide ModuleGraph once, here —
    // after all facts exist, before evaluation. Config-aware module resolution
    // (tsconfig paths/baseUrl, package exports/imports — see ModuleResolution.ts)
    // is read from the analysis root; it never walks node_modules or the
    // network, and degrades to relative-only on a missing/broken config. The
    // graph holds only paths/specifiers/fact-ids (no AST, no fact copy), is
    // passed to the rule engine for this one evaluate() call, and is released
    // with the rest of this function's locals afterward — it adds no persistent
    // or unbounded state (the FactCache stays strictly file-local, untouched).
    const moduleResolver = new ModuleResolver(loadProjectConfig(options.rootPath));
    const moduleGraph = buildModuleGraph(facts, new Set(facts.map((fact) => fact.subject.file)), moduleResolver);
    const findings: Finding[] = ruleEngine.evaluate(facts, moduleGraph);
    // RuleEngine.evaluate() is one atomic, synchronous pass with no internal
    // checkpointing — it cannot be partially applied or safely interrupted
    // (declarative rules iterate per-subject; project rules need the full
    // fact set at once, see rules/ProjectRule.ts). A second snapshot here
    // cannot change the outcome, only make its cost visible in diagnostics.
    options.onProgress?.(takeMemorySnapshot(), {phase: 'evaluation', filesSelected: files.length, filesProcessed: analyzed + skipped, factsExtracted: facts.length, elapsedMs: Date.now() - startedAt});

    // The memory guard's abort tail: every selected file after the one it
    // stopped at was never even looked at. Represented as a COUNT (and
    // mirrored once into excludedByReason), not one ExcludedFile per
    // remaining path — an unbounded per-file list here would reintroduce
    // exactly the kind of unbounded growth this phase exists to avoid.
    const filesCancelled = stoppedAtIndex !== undefined ? files.length - stoppedAtIndex : 0;
    if (filesCancelled > 0) {
        excludedByReason.analysis_cancelled = filesCancelled;
    }

    const status: AnalysisStatus = stoppedAtFile !== undefined || hasCoverageGap ? 'partial' : 'complete';

    const versions: VersionStamp = {
        engine: ENGINE_VERSION,
        ruleSet: options.config.ruleSet,
        knowledgeBase: options.config.knowledgeBase,
        adapters: registry.versions()
    };

    const report: AnalysisReport = {
        versions,
        coverage: {
            status,
            filesSelected: files.length,
            filesAnalyzed: analyzed,
            filesSkipped: skipped,
            filesCancelled,
            excludedByReason,
            excludedSample,
            factCount: facts.length,
            ...(status !== 'complete' ? {analysisIncomplete: true} : {}),
            ...(stoppedAtFile !== undefined ? {abortReason: 'memory_limit' as const, stoppedAtFile} : {}),
            ...(cache !== null ? {cacheHits} : {})
        },
        findings
    };

    return {report, facts};
};
