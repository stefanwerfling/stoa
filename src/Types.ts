/**
 * Core, language-neutral domain model for the stoa engine. These types mirror
 * the specification under docs/ (knowledge-model, rule-model, finding-model).
 * The deterministic core deals in these shapes only; adapters translate
 * language-specific detail into them.
 */
import type {FindingKey} from './FindingIdentity.js';
import type {LocalizedText} from './i18n/Localized.js';

export interface SourceRange {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
}

/**
 * The eight quality dimensions are deliberately separate axes; a finding may
 * touch several. See docs finding-model §2.
 */
export type QualityDimension =
    | 'complexity'
    | 'understandability'
    | 'responsibility-boundaries'
    | 'dependencies'
    | 'error-handling'
    | 'side-effect-control'
    | 'decision-evidence'
    | 'robustness'
    | 'accessibility'
    | 'usability';

export const QUALITY_DIMENSIONS: readonly QualityDimension[] = [
    'complexity',
    'understandability',
    'responsibility-boundaries',
    'dependencies',
    'error-handling',
    'side-effect-control',
    'decision-evidence',
    'robustness'
] as const;

/** How bad a problem would be if real. Kept separate from confidence. */
export type Severity = 'info' | 'low' | 'medium' | 'high';

/** How the underlying observation was obtained; caps a finding's confidence. */
export type Certainty = 'syntactic' | 'semantic-heuristic' | 'external-tool';

export type AnalysisKind = 'ast' | 'cfg' | 'dfg' | 'deps' | 'metric' | 'external-tool' | 'semantic';

export type SubjectKind =
    | 'file'
    | 'module'
    | 'class'
    | 'function'
    | 'method'
    | 'statement'
    | 'import'
    | 'catch-clause';

export type FactValue = number | boolean | string | Record<string, unknown>;

export interface FactSubject {
    file: string;
    symbol?: string;
    kindOf: SubjectKind;
    range: SourceRange;
}

export interface FactEvidence {
    source: 'ast' | 'cfg' | 'dfg' | 'deps' | 'metric' | 'external-tool';
    detail: string;
}

export interface FactProducer {
    adapter: string;
    version: string;
}

/**
 * A normalized, language-neutral observation. Rules consume only facts, never
 * the raw AST, which keeps the rule layer sprachneutral and testable.
 */
export interface Fact {
    id: string;
    kind: string;
    subject: FactSubject;
    value: FactValue;
    evidence: FactEvidence[];
    certainty: Certainty;
    producedBy: FactProducer;
}

/** Marks which translation layer a quote belongs to (see philosophical-foundation). */
export type EvidenceLevel = 'QUELLE' | 'ÜBERSETZUNG' | 'INTERPRETATION';

export interface PrincipleChange {
    version: string;
    note: string;
}

/**
 * A philosophical principle with its source-checked meaning and its software
 * interpretation. Attribution and interpretation confidence are deliberately
 * separate. See docs knowledge-model §3.3.
 */
export interface Principle {
    id: string;
    name: LocalizedText;
    passages: string[];
    originalThought: string;
    softwareInterpretation: string;
    qualityDimensions: QualityDimension[];
    applicableAnalyses: AnalysisKind[];
    preconditions: string;
    limits: string;
    counterexamples: string[];
    attributionConfidence: number;
    interpretationConfidence: number;
    version: string;
    changelog: PrincipleChange[];
    relatedPrinciples?: string[];
}

export interface FindingEvidence {
    fact: string;
    value: FactValue;
    certainty: Certainty;
}

/** A verifiable fact. Must carry no evaluation or judgement. */
export interface FindingObservation {
    statement: string;
    evidence: FindingEvidence[];
}

export interface PrincipleInterpretationRef {
    id: string;
    name: string;
    passages: string[];
    attributionConfidence: number;
    rationale: string;
}

/** Flagged as interpretation; never rendered as objective fact. */
export interface FindingInterpretation {
    principles: PrincipleInterpretationRef[];
    dimensions: QualityDimension[];
}

export interface Remediation {
    suggestion: string;
    drawbacks?: string;
    patch?: string | null;
}

export interface FindingLocation {
    file: string;
    range: SourceRange;
    symbol?: string;
    structure?: string;
}

export type FindingSource = 'deterministic' | 'semantic';

/**
 * How established a rule is (Flutter quality track E1a). `experimental`
 * rules are new or heuristic and not yet past a precision gate; their
 * findings carry `ruleMaturity: 'experimental'` so reports and filters can
 * keep them apart from established ones. Absent = `stable`.
 */
export type RuleMaturity = 'stable' | 'experimental';

export type BaselineStatus = 'new' | 'known' | 'fixed';

/**
 * Optional LLM augmentation attached to a deterministic finding. It never alters
 * the finding's observation, severity or confidence; it is an advisory, grounded,
 * clearly-marked second opinion (see docs architecture §D, finding-model §1).
 */
export interface SemanticAugmentation {
    adapter: string;
    verdict: string;
    rationale: string;
    citations: string[];
    confidence: number;
}

export interface RuleRef {
    id: string;
    version: string;
}

/**
 * The transparent finding object. Observation and interpretation are separate,
 * severity and confidence are separate. See docs finding-model §1.
 */
export interface Finding {
    id: string;
    rule: RuleRef;
    ruleSet: string;
    location: FindingLocation;
    observation: FindingObservation;
    interpretation: FindingInterpretation;
    severity: Severity;
    confidence: number;
    certaintyBasis: Certainty;
    remediation: Remediation;
    missingContext?: string[];
    source: FindingSource;
    suppressed?: boolean;
    baselineStatus?: BaselineStatus;
    /** Present only when the optional semantic layer augmented this finding. */
    semantic?: SemanticAugmentation;
    /** Present only when the rule that produced this finding is `experimental` (E1a); absent = stable. */
    ruleMaturity?: 'experimental';
}

/** Stamped into every report so results are reproducible and attributable. */
export interface VersionStamp {
    engine: string;
    ruleSet: string;
    knowledgeBase: string;
    adapters: Record<string, string>;
}

/**
 * The single, centrally-managed verdict on whether a report can be trusted as
 * a full check (see Pipeline.ts / Cli.ts, and CLI exit codes 0/1/2):
 * - `complete`: every selected file was either analyzed or intentionally
 *   excluded for a documented, non-coverage reason (see `ExclusionReason`'s
 *   "structural" half below) — findings may be trusted as the full picture
 *   of the analyzed set.
 * - `partial`: at least one file Stoa intended to analyze was not reached
 *   (a memory-guard abort, or a read/parse failure on a selected file) —
 *   `findings` reflects only what was actually analyzed, never silently
 *   presented as the whole selection.
 * - `failed`: the run could not produce a report at all (a config/setup
 *   error) — `analyze()` itself never returns this; it is synthesized only
 *   by a caller (the CLI) around a caught exception, so JSON/SARIF output
 *   still has a valid, parseable shape instead of a raw stack trace.
 *
 * This is the ONLY field anything should branch on. `analysisIncomplete` is
 * kept, always derived from this one value at the same point it is set, so
 * the two can never disagree — never set `analysisIncomplete` independently.
 */
export type AnalysisStatus = 'complete' | 'partial' | 'failed';

/**
 * Why one file did not contribute facts, in a closed, machine-matchable set
 * (never a freeform string) — see Ingestion.ts/Pipeline.ts. The first four
 * are STRUCTURAL: Stoa never intended to analyze that file, so their presence
 * alone does not make a run `partial` (see AnalysisStatus). The last three
 * are COVERAGE GAPS: a file Stoa DID intend to analyze was not reached, which
 * is exactly what `partial` exists to flag.
 */
export type ExclusionReason =
    | 'excluded_by_config'
    | 'excluded_by_gitignore'
    | 'file_too_large'
    | 'unsupported_language'
    | 'read_error'
    | 'memory_limit'
    | 'analysis_cancelled';

/** One excluded/skipped path and why — see `CoverageSummary.excludedSample`. */
export interface ExcludedFile {
    path: string;
    reason: ExclusionReason;
    detail?: string;
}

export interface CoverageSummary {
    status: AnalysisStatus;
    filesSelected: number;
    filesAnalyzed: number;
    filesSkipped: number;
    /** Selected files never reached at all because the memory guard aborted first (see `abortReason`/`stoppedAtFile`) — 0 on every run that was not cut short. */
    filesCancelled: number;
    /**
     * Exact counts per `ExclusionReason`, always complete (never capped) —
     * this is the authoritative breakdown; `excludedSample` below is only a
     * bounded set of examples for human debugging, not the full list (an
     * unbounded per-file list here would reintroduce the same kind of
     * unbounded growth Phase 3 exists to avoid).
     */
    excludedByReason: Partial<Record<ExclusionReason, number>>;
    /** A bounded sample of individual excluded/skipped files (see EXCLUDED_SAMPLE_LIMIT in Pipeline.ts) — for diagnosing WHICH files, not for counting (use `excludedByReason` for that). */
    excludedSample: ExcludedFile[];
    factCount: number;
    /** Set only when the memory guard stopped ingestion early (see MemoryGuard.ts). */
    abortReason?: 'memory_limit';
    /** The file ingestion was processing when the memory guard stopped it (set together with `abortReason`). */
    stoppedAtFile?: string;
    /** Derived from `status !== 'complete'` at the same point `status` is set — never set independently. Kept for backward compatibility; prefer `status`. */
    analysisIncomplete?: boolean;
    /** Present only when `cacheDir` was set (see FactCache.ts): how many of the per-file fact extractions were served from the cache instead of re-parsed. */
    cacheHits?: number;
}

/** Present only when `--baseline` was used (see Baseline.ts). `fixed` lists baseline identities absent from the current run — not Findings (there is nothing in current code to anchor them to), just reported so a diff/PR comment can say what got fixed, not only what's new. */
export interface BaselineSummary {
    newCount: number;
    knownCount: number;
    fixedCount: number;
    fixed: FindingKey[];
    /**
     * Set only when the underlying analysis itself was incomplete
     * (`coverage.analysisIncomplete === true`, see MemoryGuard.ts). When
     * true, `fixedCount`/`fixed` are always 0/[] — a baseline entry not
     * reproduced by a PARTIAL scan was never actually checked, so it is
     * never reported as fixed. `new`/`known` are still stamped per
     * finding (a finding that WAS produced either matches the baseline or
     * it doesn't), but the whole comparison is provisional: files the scan
     * never reached could still contain either, and nothing here claims
     * otherwise.
     */
    incomplete?: boolean;
    /**
     * Present only when the current run produced an identity more than once
     * (a rule defect, see FindingIdentity.ts `duplicateKeys`): its copies
     * cannot be told apart, so their `new`/`known` status is unreliable.
     */
    duplicateIdentities?: FindingKey[];
}

/**
 * Present only when an output filter was applied (E1c, see FindingFilter.ts):
 * which criteria were active and how many findings they hid — a filter never
 * hides findings silently. Filters act on the OUTPUT only; a baseline written
 * in the same run still holds every finding.
 */
export interface FilterSummary {
    minConfidence?: number;
    certainty?: Certainty[];
    excludeExperimental?: boolean;
    hiddenCount: number;
}

/**
 * The declared architecture (E5b, `--architecture`): layer sizes over the
 * analyzed files and configuration warnings. Present only with a config.
 */
export interface ArchitectureSummary {
    path: string;
    version: string;
    /** In config order. */
    layers: {name: string; files: number}[];
    /** Analyzed files outside every layer (unknown — never judged). */
    unassignedFiles: number;
    warnings: {
        /** Files matching more than one layer (they belong to the first). */
        multipleMatchCount: number;
        /** The first of them by path, relative to the analysis root. */
        multipleMatchSample: {file: string; layers: string[]}[];
        /** Declared layers no analyzed file belongs to. */
        emptyLayers: string[];
        /** Layer names used in `allow`/`forbidPackages` but never declared. */
        unknownLayerReferences: string[];
    };
}

/** The user-facing report. Intermediate facts stay out of it by default. */
export interface AnalysisReport {
    versions: VersionStamp;
    coverage: CoverageSummary;
    findings: Finding[];
    baseline?: BaselineSummary;
    filter?: FilterSummary;
    /** Present only with `--architecture` (E5b). */
    architecture?: ArchitectureSummary;
    /** Present only when `coverage.status === 'failed'` (see Cli.ts) — the caught error that prevented a real analysis from running at all. */
    error?: string;
}

/** What the pipeline returns: the report plus the intermediate facts. */
export interface AnalysisResult {
    report: AnalysisReport;
    facts: Fact[];
}

export interface SemanticConfig {
    adapter: string;
}

export interface StoaConfig {
    include: string[];
    exclude: string[];
    /** Files larger than this (bytes) are excluded during discovery, same as a glob exclude — see Ingestion.ts DEFAULT_MAX_FILE_BYTES. Optional; defaults to DEFAULT_MAX_FILE_BYTES when omitted. */
    maxFileBytes?: number;
    ruleSet: string;
    knowledgeBase: string;
    semantic: SemanticConfig;
}
