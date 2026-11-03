import type {AnalysisReport, Certainty, FilterSummary} from './Types.js';

/**
 * Output filters (Flutter quality track E1c): `--min-confidence`,
 * `--certainty`, `--no-experimental`. They act on the REPORT only, after
 * evaluation and after any baseline comparison — the analysis, the baseline
 * written in the same run and the baseline `fixed` list are computed from the
 * unfiltered findings, so changing a filter never makes a finding look fixed.
 * The report records which criteria were active and how many findings they
 * hid (`AnalysisReport.filter`); nothing is hidden silently.
 */
export interface FindingFilter {
    /** Keep findings with `confidence >= minConfidence` (0..1). */
    minConfidence?: number;
    /** Keep findings whose `certaintyBasis` is one of these. */
    certainty?: Certainty[];
    /** Drop findings of `experimental` rules. */
    excludeExperimental?: boolean;
}

export const CERTAINTY_VALUES: readonly Certainty[] = ['syntactic', 'semantic-heuristic', 'external-tool'];

/** True when the filter has at least one active criterion. */
export const isActiveFilter = (filter: FindingFilter): boolean =>
    filter.minConfidence !== undefined || filter.certainty !== undefined || filter.excludeExperimental === true;

export const applyFindingFilter = (report: AnalysisReport, filter: FindingFilter): AnalysisReport => {
    if (!isActiveFilter(filter)) {
        return report;
    }
    const certainty = filter.certainty === undefined ? null : new Set(filter.certainty);
    const kept = report.findings.filter(
        (finding) =>
            (filter.minConfidence === undefined || finding.confidence >= filter.minConfidence) &&
            (certainty === null || certainty.has(finding.certaintyBasis)) &&
            !(filter.excludeExperimental === true && finding.ruleMaturity === 'experimental')
    );
    const summary: FilterSummary = {
        ...(filter.minConfidence !== undefined ? {minConfidence: filter.minConfidence} : {}),
        ...(filter.certainty !== undefined ? {certainty: [...filter.certainty].sort()} : {}),
        ...(filter.excludeExperimental === true ? {excludeExperimental: true} : {}),
        hiddenCount: report.findings.length - kept.length
    };
    return {...report, findings: kept, filter: summary};
};

/**
 * Parses the CLI filter options. Returns an error message for an invalid
 * value (the CLI reports it as a usage error before any analysis runs).
 */
export const parseFindingFilter = (options: {minConfidence?: string; certainty?: readonly string[]; noExperimental?: boolean}): FindingFilter | {error: string} => {
    const filter: FindingFilter = {};
    if (options.minConfidence !== undefined) {
        const value = Number(options.minConfidence);
        if (options.minConfidence.trim() === '' || !Number.isFinite(value) || value < 0 || value > 1) {
            return {error: `error: --min-confidence expects a number between 0 and 1, got "${options.minConfidence}"`};
        }
        filter.minConfidence = value;
    }
    if (options.certainty !== undefined) {
        const values = [...new Set(options.certainty.flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
        const invalid = values.filter((value) => !(CERTAINTY_VALUES as readonly string[]).includes(value));
        if (values.length === 0 || invalid.length > 0) {
            return {error: `error: --certainty expects one or more of ${CERTAINTY_VALUES.join(', ')}${invalid.length > 0 ? `, got "${invalid.join(', ')}"` : ''}`};
        }
        filter.certainty = values as Certainty[];
    }
    if (options.noExperimental === true) {
        filter.excludeExperimental = true;
    }
    return filter;
};
