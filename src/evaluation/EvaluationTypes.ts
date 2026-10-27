/** One finding that the golden corpus expects the engine to produce. */
export interface ExpectedFinding {
    file: string;
    rule: string;
    symbol: string;
}

/** A produced-or-expected finding reduced to its match key parts. */
export interface FindingKey {
    file: string;
    rule: string;
    symbol: string;
}

export interface RuleMetrics {
    rule: string;
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
    falsePositives: FindingKey[];
    falseNegatives: FindingKey[];
    /** Produced findings whose identity key already appeared — reported, never silently dropped. */
    duplicates: FindingKey[];
    /** Expected (manifest) findings whose identity key appears more than once — a corpus-integrity error. */
    duplicateExpected: FindingKey[];
}
