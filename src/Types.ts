/**
 * Core, language-neutral domain model for the stoa engine. These types mirror
 * the specification under docs/ (knowledge-model, rule-model, finding-model).
 * The deterministic core deals in these shapes only; adapters translate
 * language-specific detail into them.
 */

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
    | 'robustness';

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
    name: string;
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
}

/** Stamped into every report so results are reproducible and attributable. */
export interface VersionStamp {
    engine: string;
    ruleSet: string;
    knowledgeBase: string;
    adapters: Record<string, string>;
}

export interface CoverageSummary {
    filesSelected: number;
    filesAnalyzed: number;
    filesSkipped: number;
    factCount: number;
}

/** The user-facing report. Intermediate facts stay out of it by default. */
export interface AnalysisReport {
    versions: VersionStamp;
    coverage: CoverageSummary;
    findings: Finding[];
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
    ruleSet: string;
    knowledgeBase: string;
    semantic: SemanticConfig;
}
