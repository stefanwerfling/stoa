import {basename} from 'node:path';
import type {Finding} from '../Types.js';
import type {
    EvaluationResult,
    ExpectedFinding,
    FindingKey,
    OverallMetrics,
    RuleMetrics
} from './EvaluationTypes.js';

const keyString = (key: FindingKey): string => `${basename(key.file)}::${key.rule}::${key.symbol}`;

const findingKey = (finding: Finding): FindingKey => ({
    file: basename(finding.location.file),
    rule: finding.rule.id,
    symbol: finding.location.symbol ?? ''
});

const ratio = (hit: number, other: number): number => {
    const total = hit + other;
    // No predictions / no expectations is vacuously perfect, not a divide-by-zero.
    return total === 0 ? 1 : hit / total;
};

/**
 * Compares produced findings against the corpus ground truth and returns
 * precision/recall per rule and overall, plus the explicit false-positive and
 * false-negative lists. Matching is by (file basename, rule id, symbol), so
 * results do not depend on absolute paths. See docs evaluation §3–§4.
 */
export const evaluate = (findings: Finding[], expected: ExpectedFinding[]): EvaluationResult => {
    const produced: FindingKey[] = findings.map(findingKey);
    const expectedKeys = new Set(expected.map((item) => keyString(item)));
    const producedKeys = new Set(produced.map(keyString));

    const rules = new Set<string>([...expected.map((item) => item.rule), ...produced.map((item) => item.rule)]);
    const perRule: RuleMetrics[] = [];
    for (const rule of [...rules].sort()) {
        const producedForRule = produced.filter((item) => item.rule === rule);
        const expectedForRule = expected.filter((item) => item.rule === rule);
        const truePositives = producedForRule.filter((item) => expectedKeys.has(keyString(item))).length;
        const falsePositives = producedForRule.length - truePositives;
        const falseNegatives = expectedForRule.filter((item) => !producedKeys.has(keyString(item))).length;
        perRule.push({
            rule,
            truePositives,
            falsePositives,
            falseNegatives,
            precision: ratio(truePositives, falsePositives),
            recall: ratio(truePositives, falseNegatives)
        });
    }

    const falsePositives = produced.filter((item) => !expectedKeys.has(keyString(item)));
    const falseNegatives = expected
        .filter((item) => !producedKeys.has(keyString(item)))
        .map((item) => ({file: basename(item.file), rule: item.rule, symbol: item.symbol}));

    const truePositives = produced.length - falsePositives.length;
    const overall: OverallMetrics = {
        truePositives,
        falsePositives: falsePositives.length,
        falseNegatives: falseNegatives.length,
        precision: ratio(truePositives, falsePositives.length),
        recall: ratio(truePositives, falseNegatives.length)
    };

    return {overall, perRule, falsePositives, falseNegatives};
};
