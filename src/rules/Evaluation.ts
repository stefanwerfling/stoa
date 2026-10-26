import type {Certainty, Fact, Severity} from '../Types.js';
import type {Condition, ConditionGroup, ConditionOp} from './RuleTypes.js';

/** The facts belonging to one subject (unit), keyed by fact kind. */
export type FactUnit = Map<string, Fact>;

const SEVERITY_RANK: Record<Severity, number> = {info: 0, low: 1, medium: 2, high: 3};
const CERTAINTY_CAP: Record<Certainty, number> = {syntactic: 1, 'external-tool': 0.9, 'semantic-heuristic': 0.6};

export const severityRank = (severity: Severity): number => SEVERITY_RANK[severity];

export const maxSeverity = (a: Severity, b: Severity): Severity => {
    return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
};

export const certaintyCap = (certainty: Certainty): number => CERTAINTY_CAP[certainty];

export const weakestCertainty = (facts: Fact[]): Certainty => {
    let weakest: Certainty = 'syntactic';
    for (const fact of facts) {
        if (CERTAINTY_CAP[fact.certainty] < CERTAINTY_CAP[weakest]) {
            weakest = fact.certainty;
        }
    }
    return weakest;
};

const compare = (actual: unknown, op: ConditionOp, expected: unknown): boolean => {
    switch (op) {
        case '==':
            return actual === expected;
        case '!=':
            return actual !== expected;
        case '>':
            return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
        case '>=':
            return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
        case '<':
            return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
        case '<=':
            return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
        default:
            return false;
    }
};

export const evalCondition = (condition: Condition, unit: FactUnit): boolean => {
    const fact = unit.get(condition.fact);
    if (fact === undefined) {
        return false;
    }
    if (!compare(fact.value, condition.op, condition.value)) {
        return false;
    }
    if (condition.and !== undefined) {
        return condition.and.every((sub) => evalCondition(sub, unit));
    }
    return true;
};

export const evalGroup = (group: ConditionGroup, unit: FactUnit): boolean => {
    if (group.all !== undefined) {
        return group.all.every((condition) => evalCondition(condition, unit));
    }
    if (group.any !== undefined) {
        return group.any.some((condition) => evalCondition(condition, unit));
    }
    return false;
};
