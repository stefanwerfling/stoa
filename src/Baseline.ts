import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {findingKey, keyString, type FindingKey} from './FindingIdentity.js';
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
    findings: FindingKey[];
}

const parseBaselineFile = (path: string): BaselineFile => {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        throw new Error(`baseline file ${path} is not valid JSON: ${(error as Error).message}`);
    }
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as {findings?: unknown}).findings)) {
        throw new Error(`baseline file ${path} is malformed: expected {"version":1,"findings":[{"file":...,"rule":...,"symbol":...}]}`);
    }
    return raw as BaselineFile;
};

/** Reads a baseline file; throws on a malformed one (a broken baseline is a configuration error, never silently treated as "no baseline"). Returns null only when the path genuinely does not exist yet — the natural first-run state. */
export const loadBaseline = (path: string): BaselineFile | null => {
    if (!existsSync(path)) {
        return null;
    }
    return parseBaselineFile(path);
};

/** Writes the given findings as a new baseline, sorted deterministically (same engine run twice ⇒ byte-identical baseline file). */
export const saveBaseline = (path: string, findings: Finding[], rootDir: string): void => {
    const entries = findings.map((finding) => findingKey(rootDir, finding)).sort((a, b) => keyString(a).localeCompare(keyString(b)));
    const file: BaselineFile = {version: 1, findings: entries};
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
 */
export const applyBaseline = (report: AnalysisReport, baseline: BaselineFile | null, rootDir: string): AnalysisReport => {
    const baselineEntries = baseline?.findings ?? [];
    const baselineKeys = new Set(baselineEntries.map((entry) => keyString(entry)));
    const currentKeys = new Set<string>();
    let newCount = 0;
    let knownCount = 0;

    const stamped = report.findings.map((finding) => {
        const key = keyString(findingKey(rootDir, finding));
        currentKeys.add(key);
        const isKnown = baselineKeys.has(key);
        if (isKnown) {
            knownCount += 1;
        } else {
            newCount += 1;
        }
        return {...finding, baselineStatus: isKnown ? 'known' : 'new'} as Finding;
    });

    const fixed = baselineEntries.filter((entry) => !currentKeys.has(keyString(entry)));

    return {
        ...report,
        findings: stamped,
        baseline: {newCount, knownCount, fixedCount: fixed.length, fixed}
    };
};

/** Filters a baselined report down to only `new` findings — the CI/pre-commit use case: surface the delta, not the whole known backlog. A no-op (returns the report unchanged) if `applyBaseline` was never run. */
export const onlyNewFindings = (report: AnalysisReport): AnalysisReport => ({
    ...report,
    findings: report.findings.filter((finding) => finding.baselineStatus !== 'known')
});
