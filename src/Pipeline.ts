import {statSync} from 'node:fs';
import {dirname} from 'node:path';
import type {AdapterRegistry} from './analysis/AdapterRegistry.js';
import {createAdapterRegistry, initGrammars} from './analysis/DefaultAdapters.js';
import type {FileMeta, FileRef, LanguageAdapter, ProjectContext} from './analysis/LanguageAdapter.js';
import {TypeDiagnosticsExtractor} from './analysis/typescript/TypeDiagnostics.js';
import {ExtractionPool} from './ExtractionPool.js';
import {FactCache} from './FactCache.js';
import {extractFile, type FileOutcome} from './FileExtraction.js';
import {IDENTITY_SCHEME, type IdentityScheme} from './FindingIdentity.js';
import {assignSiteSymbols, MODULE_SCOPE} from './analysis/SiteIdentity.js';
import {collectFiles, readFileContent} from './Ingestion.js';
import {loadProjectConfig, type ProjectConfig} from './config/ProjectConfig.js';
import {ModuleResolver} from './analysis/ModuleResolution.js';
import {buildModuleGraph} from './model/ModuleGraph.js';
import {buildSymbolGraph} from './model/SymbolGraph.js';
import {buildFlutterWidgetGraph} from './model/FlutterWidgetGraph.js';
import {loadDartPackages} from './analysis/dart/DartPackages.js';
import {flutterAwareIndex} from './analysis/dart/FlutterCatalog.js';
import {KnowledgeBase} from './knowledge/KnowledgeBase.js';
import {isMemoryCritical, takeMemorySnapshot, type MemorySnapshot} from './MemoryGuard.js';
import {RuleEngine} from './rules/RuleEngine.js';
import {RuleSet} from './rules/RuleSet.js';
import {DependencyCycleRule} from './rules/project/DependencyCycleRule.js';
import {flutterLayoutRules} from './rules/project/FlutterLayoutRules.js';
import {flutterLifecycleRules} from './rules/project/FlutterLifecycleRules.js';
import {DeadExportRule} from './rules/project/DeadExportRule.js';
import {solidRules} from './rules/project/SolidRules.js';
import {ValidationContractRule} from './rules/project/ValidationContractRule.js';
import {builtTypeModel, needsSymbolGraph, type ProjectRule} from './rules/ProjectRule.js';
import {moduleGraphMetrics, PhaseClock, symbolGraphMetrics, typeModelMetrics, type PipelineMetrics} from './PipelineMetrics.js';
import type {ValidationContract} from './contracts/ValidationContract.js';
import {ArchitectureModel, type ArchitectureConfig} from './architecture/ArchitectureConfig.js';
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
    /** Opt-in (Flutter quality track E6): run the SOLID rules (`--solid`); without it no SOLID rule runs. */
    solid?: boolean;
    /**
     * Opt-in: a loaded, schema-validated Validation Contract (see
     * contracts/ValidationContract.ts). When supplied, stoa:validation
     * annotations found in TypeScript sources are checked against it; when
     * omitted, annotations are still extracted as facts (harmless) but never
     * interpreted, so the feature is fully inert by default.
     */
    validationContract?: ValidationContract | null;
    /**
     * Opt-in (Flutter quality track E5b): a loaded architecture config
     * (`--architecture`, see architecture/ArchitectureConfig.ts). Adds the
     * `architecture` summary (layer sizes, configuration warnings) to the
     * report; no rule reads it before E6d. Absent = inert.
     */
    architecture?: ArchitectureConfig | null;
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
    memoryGuard?: {
        checkEveryFiles?: number;
        criticalRatio?: number;
        /** The ratio extraction workers check their own heaps against (`analyzeAsync` with `jobs` > 1); defaults to `criticalRatio`. Exists so a test can trigger a worker's guard alone. */
        workerCriticalRatio?: number;
    };
    /**
     * Opt-in: a directory for the fact cache (see FactCache.ts). Caches ONLY
     * per-file fact extraction, keyed by (running engine code, adapter id,
     * file path, file content) — never a rule/contract-dependent result, so
     * a rule set or Validation Contract change can never be served a stale
     * finding. Omit (the default) for the exact previous behavior: nothing
     * is read from or written to disk beyond the analysis target itself.
     */
    cacheDir?: string;
    /**
     * The finding-identity scheme of the symbols (FindingIdentity.ts); the
     * current one when absent. Another one only for `--migrate-baseline`
     * (src/BaselineMigration.ts), which needs a run's findings under the
     * scheme of an old baseline; such a run bypasses the fact cache, whose
     * entries hold current-scheme facts.
     */
    identityScheme?: IdentityScheme;
    /**
     * Opt-in measurement (CLI `--memory-stats`): called once at the end with
     * counts, phase timings and the peak RSS of the run (see
     * PipelineMetrics.ts). Purely observational — the report is identical
     * with or without it.
     */
    onMetrics?: (metrics: PipelineMetrics) => void;
}

/** `analyzeAsync`'s options: `analyze`'s, plus how many files are parsed at once. */
export interface AnalyzeAsyncOptions extends AnalyzeOptions {
    /**
     * Opt-in (CLI `--jobs`): parse and extract files on this many worker
     * threads. 1 (the default) runs exactly `analyze`'s sequential path. The
     * report is the same for every value — results are applied in file order
     * —; what grows is memory: every worker holds its own adapters and its
     * own heap (measured ≈ +40 % peak RSS with 2 workers, ≈ +100 % with 4).
     */
    jobs?: number;
}

/** What an adapter is told about the run: the analysis root and the identity scheme. */
const contextOf = (options: AnalyzeOptions): ProjectContext => ({rootDir: options.rootPath, ...(options.identityScheme !== undefined ? {identityScheme: options.identityScheme} : {})});

/**
 * One `onProgress` snapshot's non-memory half — see AnalyzeOptions.onProgress.
 * The phases, in order: `discovery` (files selected), `analysis` (every
 * `checkEveryFiles` files during ingestion), `evaluation` (ingestion done,
 * before the graphs), `graphs` (graphs built, before the rules), `evaluation`
 * again (rules done). A caller that samples memory at each point sees what
 * every pipeline phase holds (scripts/measure-phases.ts).
 */
export interface AnalysisProgress {
    phase: 'discovery' | 'analysis' | 'evaluation' | 'graphs';
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
    const run = startRun(options);
    const ingestion = new Ingestion(run, options);
    const ingestionStart = run.clock.sinceStart();
    ingestSequentially(run, ingestion, options);
    ingestion.finish();
    run.clock.add('ingestion', run.clock.sinceStart() - ingestionStart);
    return finishRun(run, ingestion, options);
};

/**
 * The sequential ingestion loop, in a function of its own: its locals (the
 * last file's adapter, among them) end with it instead of staying reachable
 * from `analyze`'s frame while the graphs and rules run.
 */
const ingestSequentially = (run: Run, ingestion: Ingestion, options: AnalyzeOptions): void => {
    for (const [index, meta] of run.files.entries()) {
        if (ingestion.memoryCritical(index)) {
            ingestion.stopAt(index, meta);
            break;
        }
        const prepared = ingestion.prepare(meta);
        const outcome = prepared.kind === 'extract' ? extractFile(prepared.adapter, prepared.file, contextOf(options)) : prepared.outcome;
        ingestion.commit(index, meta, prepared.file, outcome);
    }
};

/**
 * `analyze` with the grammars loaded first or, with `jobs` > 1, the files
 * parsed and extracted on that many worker threads (see ExtractionPool.ts).
 * Everything else stays on this thread and in file order: discovery, the
 * memory guard, reading, the fact cache, `--typecheck`, and applying each
 * file's outcome (`Ingestion.commit`) — so the report equals the sequential
 * one. At most `jobs` × WINDOW_PER_JOB files are read but not yet applied, so
 * file contents and facts in flight stay bounded. Only an aborted run can
 * differ: the main-thread guard samples at the same file positions, but
 * workers also check their own heaps (see ExtractionWorker.ts), and either
 * stops the run at the first file not yet applied.
 */
export const analyzeAsync = async (options: AnalyzeAsyncOptions): Promise<AnalysisResult> => {
    const jobs = options.jobs ?? 1;
    if (jobs <= 1) {
        await initGrammars();
        return analyze(options);
    }
    // In parallel, this thread parses nothing — the workers load the
    // grammars they need themselves (see ExtractionWorker.ts) —, and the
    // workers start first, so their start overlaps everything below.
    const pool = new ExtractionPool(jobs, {...contextOf(options), criticalRatio: options.memoryGuard?.workerCriticalRatio ?? options.memoryGuard?.criticalRatio ?? DEFAULT_CRITICAL_RATIO});
    pool.start();
    let run: Run;
    try {
        run = startRun(options);
    } catch (error) {
        await pool.close();
        throw error;
    }
    const ingestion = new Ingestion(run, options);
    const window: Array<{index: number; meta: FileMeta; file: FileRef | undefined; outcome: Promise<FileOutcome>}> = [];
    const applyHead = async (): Promise<void> => {
        const head = window.shift() as (typeof window)[number];
        ingestion.commit(head.index, head.meta, head.file, await head.outcome);
    };
    const ingestionStart = run.clock.sinceStart();
    try {
        let stopIndex: number | undefined;
        for (const [index, meta] of run.files.entries()) {
            if (ingestion.memoryCritical(index)) {
                stopIndex = index;
                break;
            }
            const prepared = ingestion.prepare(meta);
            const outcome = prepared.kind === 'extract' ? pool.extract(index, meta, prepared.file) : Promise.resolve(prepared.outcome);
            // Marks the promise handled: one left behind by a stopped run
            // (never awaited) must not surface as an unhandled rejection.
            outcome.catch(() => undefined);
            window.push({index, meta, file: prepared.file, outcome});
            while (window.length >= jobs * WINDOW_PER_JOB && !ingestion.stopped) {
                await applyHead();
            }
            if (ingestion.stopped) {
                break;
            }
        }
        while (window.length > 0 && !ingestion.stopped) {
            await applyHead();
        }
        if (!ingestion.stopped && stopIndex !== undefined) {
            ingestion.stopAt(stopIndex, run.files[stopIndex] as FileMeta);
        }
    } finally {
        await pool.close();
    }
    ingestion.finish();
    run.clock.add('ingestion', run.clock.sinceStart() - ingestionStart);
    return finishRun(run, ingestion, options);
};

/** Files read ahead per worker in `analyzeAsync` — enough to keep every worker busy while one slow file holds up applying the others. */
const WINDOW_PER_JOB = 4;

/** What one run sets up before ingestion and needs again when it finishes. */
interface Run {
    ruleEngine: RuleEngine;
    /** Read once from the analysis root: module resolution and the package entry points (R-UNUSED-EXPORT) use it. */
    projectConfig: ProjectConfig;
    projectRules: ProjectRule[];
    architectureModel: ArchitectureModel | undefined;
    /** Milliseconds since the run started — for `onProgress` only (observational, like `clock`). */
    elapsedMs: () => number;
    // Observational timing only (monotonic clock): read by `onMetrics`,
    // never by anything that decides a fact, finding or report field.
    clock: PhaseClock;
    files: FileMeta[];
    excludedByReason: Partial<Record<ExclusionReason, number>>;
    excludedSample: ExcludedFile[];
    recordExcluded: (excluded: ExcludedFile) => void;
}

const startRun = (options: AnalyzeOptions): Run => {
    const knowledgeBase = KnowledgeBase.loadFromDirectory(options.knowledgeDir, options.config.knowledgeBase);
    const ruleSet = RuleSet.loadFromDirectory(options.ruleSetDir, options.config.ruleSet);
    const architectureModel = architectureModelOf(options);
    const projectRules: ProjectRule[] = [new DependencyCycleRule(), ...flutterLayoutRules(), ...flutterLifecycleRules()];
    const projectConfig = loadProjectConfig(options.rootPath);
    if (options.deadExports === true) {
        projectRules.push(new DeadExportRule({patterns: options.config.entryPoints ?? [], project: projectConfig}));
    }
    if (options.validationContract !== undefined && options.validationContract !== null) {
        projectRules.push(new ValidationContractRule(options.validationContract));
    }
    if (options.solid === true) {
        projectRules.push(...solidRules(architectureModel));
    }
    const ruleEngine = new RuleEngine(knowledgeBase, ruleSet, options.lang ?? 'en', projectRules, options.identityScheme ?? IDENTITY_SCHEME);

    const startedAt = Date.now();
    const elapsedMs = (): number => Date.now() - startedAt;
    const clock = new PhaseClock();
    const excludedByReason: Partial<Record<ExclusionReason, number>> = {};
    const excludedSample: ExcludedFile[] = [];
    const recordExcluded = (excluded: ExcludedFile): void => {
        excludedByReason[excluded.reason] = (excludedByReason[excluded.reason] ?? 0) + 1;
        if (excludedSample.length < EXCLUDED_SAMPLE_LIMIT) {
            excludedSample.push(excluded);
        }
    };

    const files = clock.time('discovery', () =>
        collectFiles(options.rootPath, {
            include: options.config.include,
            exclude: options.config.exclude,
            ...(options.config.maxFileBytes !== undefined ? {maxFileBytes: options.config.maxFileBytes} : {}),
            onExcluded: recordExcluded
        })
    );
    options.onProgress?.(takeMemorySnapshot(), {phase: 'discovery', filesSelected: files.length, filesProcessed: 0, factsExtracted: 0, elapsedMs: elapsedMs()});
    return {ruleEngine, projectConfig, projectRules, architectureModel, elapsedMs, clock, files, excludedByReason, excludedSample, recordExcluded};
};

/** A file the pipeline settled itself, or one whose adapter still has to parse it. */
type Prepared = {kind: 'settled'; outcome: FileOutcome; file?: FileRef} | {kind: 'extract'; adapter: LanguageAdapter; file: FileRef};

/**
 * The ingestion state of one run: the facts and counts so far, and the
 * per-file steps both drivers share — the memory guard, `prepare` (adapter,
 * read, cache) and `commit` (applying a file's outcome). Outcomes are
 * committed in file order by both drivers, so facts, counts and the excluded
 * sample come out the same, sequential or parallel.
 */
class Ingestion {
    public readonly facts: Fact[] = [];
    // The EXPLICIT set of files successfully analyzed — the authoritative node
    // set for the ModuleGraph (Phase 0 correction P5). Uses `meta.path`
    // verbatim, the SAME value the adapters bind as a fact's `subject.file`
    // (readFileContent keeps `meta.path`, FactBuilder stamps it unchanged), so
    // graph nodes, graph edges and facts all share one path normalization.
    // Deriving the set from `facts.map(subject.file)` instead would couple node
    // presence to the incidental "every extractor emits file.lineCount"
    // invariant — a file analyzed but emitting no fact would silently vanish.
    public readonly analyzedPaths = new Set<string>();
    public analyzed = 0;
    public skipped = 0;
    public cacheHits = 0;
    public hasCoverageGap = false;
    public stoppedAtFile: string | undefined;
    public stoppedAtIndex: number | undefined;
    public readonly criticalRatio: number;
    public readonly cache: FactCache | null;
    /** The adapters' ids and versions, for the report — read once, so the adapters themselves can go (`finish`). */
    public readonly adapterVersions: Record<string, string>;
    /**
     * The language adapters — needed only while files are prepared and
     * extracted. Released by `finish`: an adapter may hold parser state
     * worth tens of MB (the TypeScript adapter's shared Project with the lib
     * files, once a script or `declare global` file was parsed), which the
     * graphs and the rules never read.
     */
    private registry: AdapterRegistry | null;
    private readonly typeExtractor: TypeDiagnosticsExtractor | null;
    private readonly checkEveryFiles: number;

    public constructor(
        private readonly run: Run,
        private readonly options: AnalyzeOptions
    ) {
        const registry = createAdapterRegistry();
        this.registry = registry;
        this.adapterVersions = registry.versions();
        this.typeExtractor = options.typecheck === true ? new TypeDiagnosticsExtractor() : null;
        this.cache = options.cacheDir !== undefined && (options.identityScheme ?? IDENTITY_SCHEME) === IDENTITY_SCHEME ? new FactCache(options.cacheDir) : null;
        this.checkEveryFiles = options.memoryGuard?.checkEveryFiles ?? DEFAULT_MEMORY_CHECK_INTERVAL;
        this.criticalRatio = options.memoryGuard?.criticalRatio ?? DEFAULT_CRITICAL_RATIO;
    }

    public get stopped(): boolean {
        return this.stoppedAtIndex !== undefined;
    }

    /**
     * The memory guard, sampled every `checkEveryFiles` files (by position, so
     * at the same files on both drivers). Stop ingesting further files rather
     * than let V8 crash with a fatal "JavaScript heap out of memory" error.
     * Facts and findings already produced are kept (never discarded) and
     * reported as genuinely partial via `coverage.status` — never silently
     * presented as a complete analysis. No global.gc() call here: by design,
     * this guard is a last resort, not a substitute for bounded object
     * lifetimes elsewhere in the pipeline.
     */
    public memoryCritical(index: number): boolean {
        if (index % this.checkEveryFiles !== 0) {
            return false;
        }
        const snapshot = takeMemorySnapshot();
        this.options.onProgress?.(snapshot, {
            phase: 'analysis',
            filesSelected: this.run.files.length,
            filesProcessed: index,
            factsExtracted: this.facts.length,
            elapsedMs: this.run.elapsedMs()
        });
        return isMemoryCritical(snapshot, this.criticalRatio);
    }

    public stopAt(index: number, meta: FileMeta): void {
        this.stoppedAtFile = meta.path;
        this.stoppedAtIndex = index;
    }

    /** Ends the ingestion: the adapters (and whatever parser state they hold) are released before the graphs and rules run. */
    public finish(): void {
        this.registry = null;
    }

    public prepare(meta: FileMeta): Prepared {
        // Resolved by path alone (FileMeta, no content) — a file nothing can
        // parse is never read at all. Not a coverage gap: Stoa simply has no
        // adapter for this language, the same as an excluded-by-config file.
        if (this.registry === null) {
            throw new Error('Ingestion.prepare after finish(): the adapters are released');
        }
        const adapter = this.registry.resolve(meta);
        if (adapter === null) {
            return {kind: 'settled', outcome: {kind: 'unsupported'}};
        }

        // Content is read lazily, right here, only once a matching adapter
        // is known — this is the one and only point in the whole pipeline
        // a file's content enters memory. Unlike a structural exclusion,
        // this file WAS selected and expected to be analyzed, so a failure
        // here is a genuine coverage gap (forces `status: 'partial'`), not
        // an intentional exclusion — a race with a concurrent delete/move
        // between discovery and read is the realistic cause.
        let file: FileRef;
        try {
            file = this.run.clock.time('read', () => readFileContent(meta));
        } catch (error) {
            return {kind: 'settled', outcome: {kind: 'readError', detail: (error as Error).message}};
        }

        const cachedAdapterFacts = this.cache?.get(adapter.id, file) ?? null;
        if (cachedAdapterFacts !== null) {
            return {kind: 'settled', outcome: {kind: 'extracted', adapterId: adapter.id, facts: cachedAdapterFacts, cached: true}, file};
        }
        return {kind: 'extract', adapter, file};
    }

    /** Applies one file's outcome to the run — called in file order. */
    public commit(index: number, meta: FileMeta, file: FileRef | undefined, outcome: FileOutcome): void {
        switch (outcome.kind) {
            case 'unsupported':
                this.skipped += 1;
                this.run.recordExcluded({path: meta.path, reason: 'unsupported_language'});
                return;
            case 'readError':
                this.skipped += 1;
                this.hasCoverageGap = true;
                this.run.recordExcluded({path: meta.path, reason: 'read_error', detail: outcome.detail});
                return;
            case 'parseFailed':
                this.skipped += 1;
                this.hasCoverageGap = true;
                this.run.recordExcluded({path: meta.path, reason: 'read_error', detail: `parse failed: ${outcome.diagnostics.join('; ')}`});
                return;
            case 'memoryCritical':
                this.stopAt(index, meta);
                return;
            case 'extracted':
                break;
        }
        this.facts.push(...outcome.facts);
        if (outcome.cached) {
            this.cacheHits += 1;
        } else if (file !== undefined) {
            this.cache?.set(outcome.adapterId, file, outcome.facts);
        }

        // Deliberately NOT cached: tsc diagnostics depend on the file's
        // tsconfig and on every file it imports, so the FactCache's
        // content-of-this-file key cannot tell when they are stale.
        // Scheme 3 anchors each diagnostic like a site, in the declaration of
        // this file's own facts it falls in (`Service.load>tsc#0`).
        if (this.typeExtractor !== null && file !== undefined && TS_EXTENSIONS.some((ext) => file.path.endsWith(ext))) {
            const diagnostics = this.typeExtractor.extract(file);
            const scheme = this.options.identityScheme ?? IDENTITY_SCHEME;
            this.facts.push(...(scheme >= 3 ? assignSiteSymbols(diagnostics, scheme, MODULE_SCOPE, outcome.facts) : diagnostics));
        }
        this.analyzed += 1;
        this.analyzedPaths.add(meta.path);
    }
}

const finishRun = (run: Run, ingestion: Ingestion, options: AnalyzeOptions): AnalysisResult => {
    const {ruleEngine, projectConfig, projectRules, architectureModel, clock, files, elapsedMs, excludedByReason, excludedSample} = run;
    const {facts, analyzedPaths, analyzed, skipped, cacheHits, hasCoverageGap, stoppedAtFile, stoppedAtIndex, cache, adapterVersions} = ingestion;
    options.onProgress?.(takeMemorySnapshot(), {phase: 'evaluation', filesSelected: files.length, filesProcessed: analyzed + skipped, factsExtracted: facts.length, elapsedMs: elapsedMs()});
    const graphsStart = clock.sinceStart();
    // Phase 0: build the reusable, project-wide ModuleGraph once, here —
    // after all facts exist, before evaluation. Config-aware module resolution
    // (tsconfig paths/baseUrl, package exports/imports — see ModuleResolution.ts)
    // is read from the analysis root; it never walks node_modules or the
    // network, and degrades to relative-only on a missing/broken config. The
    // graph holds only paths/specifiers/fact-ids (no AST, no fact copy), is
    // passed to the rule engine for this one evaluate() call, and is released
    // with the rest of this function's locals afterward — it adds no persistent
    // or unbounded state (the FactCache stays strictly file-local, untouched).
    const moduleResolver = new ModuleResolver(projectConfig);
    // Flutter quality Phase B: cross-file Dart name resolution (which
    // declaration a widget/controller name refers to), built only when Dart
    // files were analyzed — from facts + the project's own pubspec package
    // names (read here, never cached) + the static Flutter catalog. Built
    // before the module graph, which takes the Dart import edges from it (E2).
    const dartPaths = [...analyzedPaths].filter((path) => path.endsWith('.dart')).sort();
    const dartLibraryIndex = dartPaths.length > 0 ? flutterAwareIndex(facts, loadDartPackages(dartPaths)) : undefined;
    const moduleGraph = buildModuleGraph(facts, analyzedPaths, moduleResolver, dartLibraryIndex);
    // The cross-file symbol graph (the one ES-module name resolver), built
    // right after the module graph from the same facts (deps.importName +
    // deps.export + deps.reexport) + its resolved edges — ONLY when an active
    // rule declares `usesTypeModel` (the TypeModel resolves TS names through
    // it) or `usesSymbolGraph` (R-UNUSED-EXPORT). One instance per run,
    // shared by every rule.
    // Same discipline: strings/fact-ids only (no AST, no fact copy), lives
    // only for this evaluate() call.
    const symbolGraph = needsSymbolGraph(projectRules) ? buildSymbolGraph(facts, moduleGraph) : undefined;
    // Flutter Phase 1: the widget graph, same discipline (facts in, strings/
    // fact-ids out, lives only for this evaluate() call). Passed only when the
    // run actually produced widget trees; the Flutter layout rules (Phase 2,
    // rules/project/FlutterLayoutRules.ts) consume it.
    const flutterWidgetGraph = buildFlutterWidgetGraph(facts, dartLibraryIndex);
    clock.add('graphs', clock.sinceStart() - graphsStart);
    options.onProgress?.(takeMemorySnapshot(), {phase: 'graphs', filesSelected: files.length, filesProcessed: analyzed + skipped, factsExtracted: facts.length, elapsedMs: elapsedMs()});
    // The rules get the same explicit file list as the ModuleGraph's nodes —
    // never a set re-derived from the facts (see ProjectRuleInput.analyzedFiles).
    const findings: Finding[] = clock.time('evaluation', () =>
        ruleEngine.evaluate(facts, moduleGraph, symbolGraph, flutterWidgetGraph.nodes.length > 0 ? flutterWidgetGraph : undefined, dartLibraryIndex, analyzedPaths)
    );
    // RuleEngine.evaluate() is one atomic, synchronous pass with no internal
    // checkpointing — it cannot be partially applied or safely interrupted
    // (declarative rules iterate per-subject; project rules need the full
    // fact set at once, see rules/ProjectRule.ts). A second snapshot here
    // cannot change the outcome, only make its cost visible in diagnostics.
    options.onProgress?.(takeMemorySnapshot(), {phase: 'evaluation', filesSelected: files.length, filesProcessed: analyzed + skipped, factsExtracted: facts.length, elapsedMs: elapsedMs()});

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
        adapters: adapterVersions,
        identity: options.identityScheme ?? IDENTITY_SCHEME
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
        findings,
        ...architectureSummaryOf(architectureModel, analyzedPaths)
    };

    options.onMetrics?.({
        files: {selected: files.length, analyzed, skipped, cancelled: filesCancelled, cacheHits},
        facts: facts.length,
        findings: findings.length,
        moduleGraph: moduleGraphMetrics(moduleGraph),
        symbolGraph: symbolGraphMetrics(symbolGraph),
        typeModel: typeModelMetrics(builtTypeModel(facts, dartLibraryIndex, moduleGraph)),
        timingsMs: {
            discovery: clock.total('discovery'),
            read: clock.total('read'),
            extraction: Math.round((clock.total('ingestion') - clock.total('read')) * 10) / 10,
            graphs: clock.total('graphs'),
            evaluation: clock.total('evaluation'),
            total: clock.sinceStart()
        },
        peakRssBytes: process.resourceUsage().maxRSS * 1024
    });

    return {report, facts};
};

/** The directory the architecture globs are relative to: the analysis root, or the directory of a single-file root. */
const architectureRootOf = (rootPath: string): string => (statSync(rootPath).isFile() ? dirname(rootPath) : rootPath);

/** The declared architecture (E5b) as a model, or undefined without `--architecture`. */
const architectureModelOf = (options: AnalyzeOptions): ArchitectureModel | undefined =>
    options.architecture === undefined || options.architecture === null ? undefined : new ArchitectureModel(options.architecture, architectureRootOf(options.rootPath));

/** `{architecture}` for the report when a config was given, else nothing — the report shape is unchanged without one. */
const architectureSummaryOf = (model: ArchitectureModel | undefined, analyzedPaths: ReadonlySet<string>): Pick<AnalysisReport, 'architecture'> =>
    model === undefined ? {} : {architecture: model.summarize(analyzedPaths)};
