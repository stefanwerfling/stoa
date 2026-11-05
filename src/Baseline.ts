import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {duplicateIdentityText, duplicateKeys, findingKey, IDENTITY_SCHEME, IDENTITY_SCHEMES_TEXT, identityField, keyString, type FindingKey, type IdentityScheme} from './FindingIdentity.js';
import type {AnalysisReport, Finding} from './Types.js';

/**
 * A stored baseline: the set of finding identities "already known" as of
 * some earlier run (see src/FindingIdentity.ts for what an identity is and
 * why line/column are deliberately excluded from it). This is the same
 * identity scheme the golden-corpus evaluator already uses — reused, not
 * reinvented, so a baseline behaves exactly the way the existing
 * precision/recall matching already does.
 */
export interface BaselineFile {
    version: 1;
    /**
     * The finding-identity scheme its keys follow (FindingIdentity.ts).
     * Absent in a file written before schemes were recorded — that is
     * scheme 1. A baseline of another scheme than the running one is never
     * compared (`applyBaseline` throws); `--migrate-baseline` converts it
     * (src/BaselineMigration.ts).
     */
    identity?: IdentityScheme;
    findings: FindingKey[];
}

/** The identity scheme of a loaded baseline: its `identity`, or 1 for a file that has none. */
export const baselineScheme = (baseline: BaselineFile): IdentityScheme => baseline.identity ?? 1;

/** The message for a baseline written under another identity scheme: what happened and the explicit way out. */
export const schemeMismatchMessage = (path: string, scheme: IdentityScheme): string =>
    `baseline ${path} uses finding identity scheme ${scheme}, this stoa uses scheme ${IDENTITY_SCHEME} — its entries cannot be compared as they are. ` +
    'Convert it explicitly with --migrate-baseline (best on the code state the baseline was written for); nothing was compared or written.';

/** Thrown by `saveBaseline` when asked to overwrite a baseline from an incomplete analysis — a distinct type so callers can tell this apart from a plain I/O/parse error without string-matching the message. */
export class IncompleteAnalysisError extends Error {}

const isValidKey = (value: unknown): value is FindingKey => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return typeof candidate.file === 'string' && candidate.file.length > 0 && typeof candidate.rule === 'string' && candidate.rule.length > 0 && typeof candidate.symbol === 'string';
};

const parseBaselineFile = (path: string): BaselineFile => {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch (error) {
        throw new Error(`baseline file ${path} could not be read: ${(error as Error).message}`);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        throw new Error(`baseline file ${path} is not valid JSON: ${(error as Error).message}`);
    }
    if (typeof raw !== 'object' || raw === null) {
        throw new Error(`baseline file ${path} is malformed: expected a JSON object, got ${raw === null ? 'null' : typeof raw}`);
    }
    const candidate = raw as {version?: unknown; identity?: unknown; findings?: unknown};
    if (candidate.version !== 1) {
        throw new Error(`baseline file ${path} is malformed: "version" must be 1, got ${JSON.stringify(candidate.version)}`);
    }
    if (identityField(candidate.identity) === null) {
        throw new Error(`baseline file ${path} is malformed: "identity" must be ${IDENTITY_SCHEMES_TEXT} when present, got ${JSON.stringify(candidate.identity)}`);
    }
    if (!Array.isArray(candidate.findings)) {
        throw new Error(`baseline file ${path} is malformed: "findings" must be an array`);
    }
    assertFindingKeys(path, candidate.findings);
    return raw as BaselineFile;
};

/** Every entry a well-formed key, each identity at most once. */
const assertFindingKeys = (path: string, findings: readonly unknown[]): void => {
    const seen = new Set<string>();
    for (const [index, entry] of findings.entries()) {
        if (!isValidKey(entry)) {
            throw new Error(`baseline file ${path} is malformed: findings[${index}] must be {"file": string, "rule": string, "symbol": string} with non-empty "file"/"rule", got ${JSON.stringify(entry)}`);
        }
        const key = keyString(entry);
        if (seen.has(key)) {
            throw new Error(`baseline file ${path} is malformed: findings[${index}] duplicates an earlier entry's identity (${key}) — a baseline must name each finding at most once`);
        }
        seen.add(key);
    }
};

/** Reads a baseline file; throws on a malformed one (a broken baseline is a configuration error, never silently treated as "no baseline" — that would make every known finding look new). Returns null only when the path genuinely does not exist yet — the natural first-run state. */
export const loadBaseline = (path: string): BaselineFile | null => {
    if (!existsSync(path)) {
        return null;
    }
    if (statSync(path).isDirectory()) {
        throw new Error(`baseline path ${path} is a directory, not a file`);
    }
    return parseBaselineFile(path);
};

/**
 * Writes the given report's findings as a new baseline, sorted
 * deterministically (same engine run twice ⇒ byte-identical baseline
 * file). Refuses outright — throwing `IncompleteAnalysisError`, never
 * silently writing a partial result — when the analysis that produced
 * `report` is not `coverage.status === 'complete'`: overwriting a
 * baseline with data from a scan that never reached every file would mean
 * files outside what was actually re-checked silently vanish from the
 * baseline, making their already-known findings look brand new on the
 * NEXT run. This check lives here, in the function that actually writes,
 * not only earlier in the CLI — so there is no path to this function that
 * bypasses it.
 */
export const saveBaseline = (path: string, report: AnalysisReport, rootDir: string): void => {
    if (report.coverage.status !== 'complete') {
        throw new IncompleteAnalysisError(
            `refusing to update baseline ${path}: the analysis status is "${report.coverage.status}"` +
                (report.coverage.stoppedAtFile !== undefined ? ` (stopped before reaching "${report.coverage.stoppedAtFile}")` : '') +
                ' — writing it now would overwrite the existing baseline with data from a partial scan'
        );
    }
    const entries = report.findings.map((finding) => findingKey(rootDir, finding)).sort((a, b) => keyString(a).localeCompare(keyString(b)));
    // `loadBaseline` rejects a repeated identity, so writing one would leave a
    // baseline that can never be read back. Refused (the existing file stays
    // untouched): two findings sharing an identity is a rule defect.
    const duplicates = duplicateKeys(entries);
    if (duplicates.length > 0) {
        throw new Error(`refusing to update baseline ${path} (it could not be read back): ${duplicateIdentityText(duplicates)}`);
    }
    writeBaselineFile(path, {version: 1, identity: IDENTITY_SCHEME, findings: entries});
};

/** Writes a baseline file as `saveBaseline` does (also used for a migrated one). */
export const writeBaselineFile = (path: string, file: BaselineFile): void => {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
};

/**
 * Stamps every CURRENT finding with `baselineStatus: 'new' | 'known'` and
 * reports which baseline entries no longer appear at all ("fixed") —
 * `fixed` is not represented as a Finding on current code (there is
 * nothing in the current source to anchor it to), so it is surfaced as a
 * compact identity list in `AnalysisReport.baseline`, never fabricated as a
 * finding. A `null` baseline (no file yet) marks everything `new` and
 * reports nothing fixed — the natural first-run state, not an error.
 *
 * When the analysis itself was not `coverage.status === 'complete'`,
 * NO baseline entry is ever reported as fixed, regardless of whether it
 * was reproduced: a file the scan never reached was never actually
 * checked, so "not reproduced" proves nothing about it. `new`/`known` are
 * still stamped (a finding that WAS produced either matches the baseline
 * or it doesn't — that part is not in doubt), but `baseline.incomplete` is
 * set so callers/renderers can mark the whole comparison as provisional.
 *
 * An identity the current run produces more than once (a rule defect) is
 * listed in `baseline.duplicateIdentities`: its copies cannot be told apart,
 * so if the baseline holds it every copy reads `known` although one may be
 * new. Nothing is merged; the caller reports it (Cli.ts).
 */
export const applyBaseline = (report: AnalysisReport, baseline: BaselineFile | null, rootDir: string): AnalysisReport => {
    if (baseline !== null && baselineScheme(baseline) !== IDENTITY_SCHEME) {
        // Comparing keys of two schemes would mark known findings new and
        // report others fixed, all silently — refused instead.
        throw new Error(schemeMismatchMessage('(given)', baselineScheme(baseline)));
    }
    const incomplete = report.coverage.status !== 'complete';
    const baselineEntries = baseline?.findings ?? [];
    const baselineKeys = new Set(baselineEntries.map((entry) => keyString(entry)));
    const currentKeys = new Set<string>();
    let newCount = 0;
    let knownCount = 0;

    const keys = report.findings.map((finding) => findingKey(rootDir, finding));
    const duplicates = duplicateKeys(keys);
    const stamped = report.findings.map((finding, index) => {
        const key = keyString(keys[index] as FindingKey);
        currentKeys.add(key);
        const isKnown = baselineKeys.has(key);
        if (isKnown) {
            knownCount += 1;
        } else {
            newCount += 1;
        }
        return {...finding, baselineStatus: isKnown ? 'known' : 'new'} as Finding;
    });

    const fixed = incomplete ? [] : baselineEntries.filter((entry) => !currentKeys.has(keyString(entry)));

    return {
        ...report,
        findings: stamped,
        baseline: {
            newCount,
            knownCount,
            fixedCount: fixed.length,
            fixed,
            ...(incomplete ? {incomplete: true} : {}),
            ...(duplicates.length > 0 ? {duplicateIdentities: duplicates} : {})
        }
    };
};

/** Filters a baselined report down to only `new` findings — the CI/pre-commit use case: surface the delta, not the whole known backlog. A no-op (returns the report unchanged) if `applyBaseline` was never run. */
export const onlyNewFindings = (report: AnalysisReport): AnalysisReport => ({
    ...report,
    findings: report.findings.filter((finding) => finding.baselineStatus !== 'known')
});
