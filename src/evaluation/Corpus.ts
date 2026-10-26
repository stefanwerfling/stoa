import {readFileSync} from 'node:fs';
import type {ExpectedFinding} from './EvaluationTypes.js';

interface ExpectedFile {
    findings: ExpectedFinding[];
}

/** Loads the ground-truth manifest (expected.json) for a golden corpus. */
export const loadExpected = (path: string): ExpectedFinding[] => {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ExpectedFile;
    return parsed.findings;
};
