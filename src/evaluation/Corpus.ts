import {readFileSync} from 'node:fs';
import type {ExpectedFinding} from './EvaluationTypes.js';

/**
 * Loads and validates the ground-truth manifest (expected.json) for a golden
 * corpus. A TypeScript cast is not a runtime guarantee, so the structure is
 * checked here: a top-level object with a `findings` array of entries that each
 * carry a non-empty `file` and `rule` and a string `symbol` (which may be empty
 * for module-level findings). Malformed data throws with the file and the
 * offending entry index, so a broken manifest is an explicit evaluation error
 * rather than silently-wrong metrics.
 */
export const loadExpected = (path: string): ExpectedFinding[] => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        throw new Error(`corpus manifest ${path} is not valid JSON: ${(error as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as {findings?: unknown}).findings)) {
        throw new Error(`corpus manifest ${path} must be an object with a "findings" array`);
    }

    const findings = (parsed as {findings: unknown[]}).findings;
    return findings.map((entry, index) => validateEntry(entry, index, path));
};

const validateEntry = (entry: unknown, index: number, path: string): ExpectedFinding => {
    if (typeof entry !== 'object' || entry === null) {
        throw new Error(`corpus manifest ${path}: finding #${index} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    const {file, rule, symbol} = record;
    if (typeof file !== 'string' || file.length === 0) {
        throw new Error(`corpus manifest ${path}: finding #${index} has an empty or non-string "file"`);
    }
    if (typeof rule !== 'string' || rule.length === 0) {
        throw new Error(`corpus manifest ${path}: finding #${index} has an empty or non-string "rule"`);
    }
    if (typeof symbol !== 'string') {
        throw new Error(`corpus manifest ${path}: finding #${index} has a non-string "symbol"`);
    }
    return {file, rule, symbol};
};
