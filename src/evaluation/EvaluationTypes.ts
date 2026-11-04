import type {FindingKey} from '../FindingIdentity.js';
import type {AnalysisStatus} from '../Types.js';

/** One finding that the golden corpus expects the engine to produce. */
export interface ExpectedFinding {
    file: string;
    rule: string;
    symbol: string;
}

/** Re-exported from the shared identity module (src/FindingIdentity.ts) — also used by the baseline diff, so the match-key shape lives in one place. */
export type {FindingKey};

export interface RuleMetrics {
    rule: string;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    precision: number;
    recall: number;
}

/**
 * Per-language breakdown (derived from each finding's file extension) so results
 * can be compared across the supported languages within one corpus. Comparing
 * across SEPARATE corpora is left to the caller — these numbers are not merged
 * across corpora.
 */
export interface LanguageMetrics {
    language: string;
    expected: number;
    produced: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    precision: number;
    recall: number;
}

/**
 * Counts and derived rates. Over the set of distinct identity keys:
 * TP = produced ∩ expected, FP = produced \ expected, FN = expected \ produced.
 * precision = TP / (TP + FP), recall = TP / (TP + FN). Undefined cases (no
 * predictions → TP+FP = 0; no expectations → TP+FN = 0) are reported as the
 * vacuous 1.0 (there is no counterexample). Such a 1.0 is only meaningful read
 * together with `producedCount`: e.g. precision 1.0 with producedCount 0 means
 * "nothing was produced", not "everything produced was correct".
 */
export interface OverallMetrics {
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    /** Raw number of produced findings before de-duplication of identical keys. */
    producedCount: number;
    precision: number;
    recall: number;
}

/**
 * The outcome of comparing produced findings against the corpus ground truth.
 * See docs evaluation §3–§4.
 *
 * A finding's identity is (project-relative file path, rule id, symbol). The
 * path is relativized against the analysis root, so same-named files in
 * different directories (e.g. src/User.ts vs tests/fixtures/User.ts) never
 * collide. Line/column are deliberately excluded: the symbol already
 * distinguishes findings within a file and lines shift under edits.
 */
export interface EvaluationResult {
    overall: OverallMetrics;
    perRule: RuleMetrics[];
    byLanguage: LanguageMetrics[];
    falsePositives: FindingKey[];
    falseNegatives: FindingKey[];
    /** Produced findings whose identity key already appeared (an identity collision — fails the evaluation) — reported, never silently dropped. */
    duplicates: FindingKey[];
    /** Expected (manifest) findings whose identity key appears more than once — a corpus-integrity error. */
    duplicateExpected: FindingKey[];
    /** Set by `stoa eval`: the completeness of the analysis the metrics were computed from. */
    analysis?: EvaluationAnalysis;
    /** Set by `stoa eval`: the overall verdict (see `evaluationOutcome`). */
    outcome?: EvaluationOutcome;
}

/**
 * The verdict of an evaluation run:
 * - `passed` — the analysis was complete and nothing is missing, spurious or
 *   duplicated (in the manifest or among the produced identities);
 * - `failed` — the analysis was complete, but precision/recall deviate, the
 *   manifest is inconsistent, or two produced findings share one identity;
 * - `incomplete` — the analysis was not complete (memory guard, read/parse
 *   error): the metrics cover only the files reached and are never a pass,
 *   even when every finding produced so far matches.
 */
export type EvaluationOutcome = 'passed' | 'failed' | 'incomplete';

export interface EvaluationAnalysis {
    status: AnalysisStatus;
    /** The file the memory guard stopped before, when it aborted the scan. */
    stoppedAtFile?: string;
}
