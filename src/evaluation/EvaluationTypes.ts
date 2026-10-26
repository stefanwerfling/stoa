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
    precision: number;
    recall: number;
}

/**
 * The outcome of comparing produced findings against the corpus ground truth.
 * See docs evaluation §3–§4.
 */
export interface EvaluationResult {
    overall: OverallMetrics;
    perRule: RuleMetrics[];
    falsePositives: FindingKey[];
    falseNegatives: FindingKey[];
}
