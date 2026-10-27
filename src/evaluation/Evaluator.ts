import {relative} from 'node:path';
import type {Finding} from '../Types.js';
import type {
    EvaluationResult,
    ExpectedFinding,
    FindingKey,
    OverallMetrics,
    RuleMetrics
} from './EvaluationTypes.js';

const toForwardSlashes = (path: string): string => path.split('\\').join('/');

const keyString = (key: FindingKey): string => `${toForwardSlashes(key.file)}::${key.rule}::${key.symbol}`;

const expectedKey = (item: ExpectedFinding): FindingKey => ({
    file: toForwardSlashes(item.file),
    rule: item.rule,
    symbol: item.symbol
});

// Produced findings carry an absolute location; relativize it against the
// analysis root so the identity matches the project-relative paths in the
// corpus manifest and does not depend on where the scan was launched.
const producedKey = (rootDir: string, finding: Finding): FindingKey => ({
    file: toForwardSlashes(relative(rootDir, finding.location.file)),
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
 * precision/recall per rule and overall, plus the explicit false-positive,
 * false-negative and duplicate lists.
 *
 * A finding's identity is (project-relative file, rule id, symbol); `rootDir`
 * is the analysis root the produced paths are relativized against. True
 * positives, false positives and false negatives are all computed over the set
 * of distinct keys, so a duplicate produced finding cannot inflate the metrics;
 * duplicates are reported separately rather than silently removed. See docs
 * evaluation §3–§4.
 */
export const evaluate = (findings: Finding[], expected: ExpectedFinding[], rootDir: string): EvaluationResult => {
    // Expected identities must themselves be unique; a repeated manifest entry
    // is a corpus-integrity error (it would otherwise collapse into the set and
    // hide a mistake). Reported explicitly, not silently de-duplicated.
    const expectedSeen = new Set<string>();
    const uniqueExpected: FindingKey[] = [];
    const duplicateExpected: FindingKey[] = [];
    for (const item of expected) {
        const key = expectedKey(item);
        const asString = keyString(key);
        if (expectedSeen.has(asString)) {
            duplicateExpected.push(key);
            continue;
        }
        expectedSeen.add(asString);
        uniqueExpected.push(key);
    }
    const expectedKeys = expectedSeen;

    const seen = new Set<string>();
    const uniqueProduced: FindingKey[] = [];
    const duplicates: FindingKey[] = [];
    for (const finding of findings) {
        const key = producedKey(rootDir, finding);
        const asString = keyString(key);
        if (seen.has(asString)) {
            duplicates.push(key);
            continue;
        }
        seen.add(asString);
        uniqueProduced.push(key);
    }
    const producedKeys = seen;

    const rules = new Set<string>([...uniqueExpected.map((item) => item.rule), ...uniqueProduced.map((item) => item.rule)]);
    const perRule: RuleMetrics[] = [];
    for (const rule of [...rules].sort()) {
        const producedForRule = uniqueProduced.filter((item) => item.rule === rule);
        const expectedForRule = uniqueExpected.filter((item) => item.rule === rule);
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

    const falsePositives = uniqueProduced.filter((item) => !expectedKeys.has(keyString(item)));
    const falseNegatives = uniqueExpected.filter((item) => !producedKeys.has(keyString(item)));
    const truePositives = uniqueProduced.length - falsePositives.length;

    const overall: OverallMetrics = {
        truePositives,
        falsePositives: falsePositives.length,
        falseNegatives: falseNegatives.length,
        producedCount: findings.length,
        precision: ratio(truePositives, falsePositives.length),
        recall: ratio(truePositives, falseNegatives.length)
    };

    return {overall, perRule, falsePositives, falseNegatives, duplicates, duplicateExpected};
};
