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
}
