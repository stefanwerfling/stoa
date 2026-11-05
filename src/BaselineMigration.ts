import {IncompleteAnalysisError, baselineScheme, type BaselineFile} from './Baseline.js';
import {duplicateIdentityText, duplicateKeys, findingKey, IDENTITY_SCHEME, keyString, type FindingKey} from './FindingIdentity.js';
import type {AnalysisReport, Finding} from './Types.js';

/** What an explicit baseline migration did (see `migrateBaseline`). */
interface BaselineMigration {
    /** The converted baseline, under the running identity scheme. */
    baseline: BaselineFile;
    /** Entries carried over to their new identity. */
    migrated: number;
    /** Entries no current finding reproduces (fixed since, or changed) — dropped, and listed so nothing vanishes unseen. */
    unmatched: FindingKey[];
}

/**
 * Converts a baseline written under an older finding-identity scheme
 * (FindingIdentity.ts) to the running one, explicitly (`--migrate-baseline`)
 * — never as a side effect of a comparison.
 *
 * Keys of two schemes cannot be translated by rewriting strings: an old
 * per-file ordinal (`catch#3`) says nothing about which declaration the site
 * is in. So the same code is analyzed under both schemes (`legacy` under the
 * baseline's scheme, `current` under the running one) and each finding is
 * paired with itself by `Finding.id` — rule, file and position, the same in
 * both runs because only symbols differ. An old entry takes the current key
 * of the finding that produced it under the old scheme.
 *
 * An entry no legacy finding reproduces is not guessed at: it is dropped and
 * returned in `unmatched` (it would have been reported fixed). An entry whose
 * legacy identity is not unique, or whose finding cannot be paired
 * unambiguously, is treated the same way. Both runs must be `complete` — a
 * partial scan cannot tell a fixed finding from an unreached one.
 */
export const migrateBaseline = (old: BaselineFile, legacy: AnalysisReport, current: AnalysisReport, rootDir: string): BaselineMigration => {
    for (const report of [legacy, current]) {
        if (report.coverage.status !== 'complete') {
            throw new IncompleteAnalysisError(`refusing to migrate the baseline: the analysis status is "${report.coverage.status}" — a partial scan cannot tell a fixed finding from one it never reached`);
        }
    }
    const currentById = uniqueBy(current.findings, (finding) => finding.id);
    const legacyByKey = uniqueBy(legacy.findings, (finding) => keyString(findingKey(rootDir, finding)));
    const findings: FindingKey[] = [];
    const unmatched: FindingKey[] = [];
    for (const entry of old.findings) {
        const legacyFinding = legacyByKey.get(keyString(entry));
        const currentFinding = legacyFinding === undefined ? undefined : currentById.get(legacyFinding.id);
        if (currentFinding === undefined) {
            unmatched.push(entry);
        } else {
            findings.push(findingKey(rootDir, currentFinding));
        }
    }
    findings.sort((a, b) => keyString(a).localeCompare(keyString(b)));
    const duplicates = duplicateKeys(findings);
    if (duplicates.length > 0) {
        // Such a baseline could not be read back (see Baseline.ts `loadBaseline`).
        throw new Error(`refusing to migrate the baseline: ${duplicateIdentityText(duplicates)}`);
    }
    return {baseline: {version: 1, identity: IDENTITY_SCHEME, findings}, migrated: findings.length, unmatched};
};

/** Whether `baseline` needs `migrateBaseline` before it can be compared. */
export const needsMigration = (baseline: BaselineFile): boolean => baselineScheme(baseline) !== IDENTITY_SCHEME;

/** Findings by a key, leaving out every key that more than one finding has (it could not be paired unambiguously). */
const uniqueBy = (findings: readonly Finding[], keyOf: (finding: Finding) => string): Map<string, Finding> => {
    const byKey = new Map<string, Finding>();
    const shared = new Set<string>();
    for (const finding of findings) {
        const key = keyOf(finding);
        if (byKey.has(key)) {
            shared.add(key);
        }
        byKey.set(key, finding);
    }
    for (const key of shared) {
        byKey.delete(key);
    }
    return byKey;
};
