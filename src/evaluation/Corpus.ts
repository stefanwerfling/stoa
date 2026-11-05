import {readFileSync} from 'node:fs';
import {IDENTITY_SCHEME, identityField} from '../FindingIdentity.js';
import type {ExpectedFinding} from './EvaluationTypes.js';

/**
 * Loads and validates the ground-truth manifest (expected.json) for a golden
 * corpus. A TypeScript cast is not a runtime guarantee, so the structure is
 * checked here: a top-level object with a `findings` array of entries that each
 * carry a non-empty `file` and `rule` and a string `symbol` (which may be empty
 * for module-level findings). Malformed data throws with the file and the
 * offending entry index, so a broken manifest is an explicit evaluation error
 * rather than silently-wrong metrics.
 *
 * The manifest names its finding-identity scheme (`"identity": 2`, see
 * FindingIdentity.ts); without the field it is scheme 1, as a baseline is. A
 * manifest of another scheme than the running one is refused: its symbols
 * would come out as false positives and false negatives, which reads as a
 * rule regression rather than what it is. There is no automatic conversion —
 * an expected finding the engine misses has no produced finding to pair it
 * with; the manifest is re-approved under the current scheme.
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

    const {findings, identity} = parsed as {findings: unknown[]; identity?: unknown};
    const scheme = identityField(identity);
    if (scheme === null) {
        throw new Error(`corpus manifest ${path}: "identity" must be 1 or 2 when present, got ${JSON.stringify(identity)}`);
    }
    const entries = findings.map((entry, index) => validateEntry(entry, index, path));
    if (scheme !== IDENTITY_SCHEME) {
        throw new Error(
            `corpus manifest ${path} uses finding identity scheme ${scheme}${identity === undefined ? ' (it has no "identity" field)' : ''}, this stoa uses scheme ${IDENTITY_SCHEME} — ` +
                `its symbols cannot be compared as they are (they would show as false positives and negatives). Re-approve the expected findings under scheme ${IDENTITY_SCHEME} and set "identity": ${IDENTITY_SCHEME}; nothing was evaluated.`
        );
    }
    return entries;
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
