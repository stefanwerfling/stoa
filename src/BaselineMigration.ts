import {IncompleteAnalysisError, baselineScheme, type BaselineFile} from './Baseline.js';
import {duplicateIdentityText, duplicateKeys, findingKey, IDENTITY_SCHEME, keyString, type FindingKey, type IdentityScheme} from './FindingIdentity.js';
import type {AnalysisReport, BaselineMigrationSummary, Finding, MigrationOutcome, MigrationReason} from './Types.js';

/** One baseline entry and what the migration did with it. */
interface MigrationEntry {
    outcome: MigrationOutcome;
    /** The entry as the old baseline holds it. */
    entry: FindingKey;
    /** The identity it was paired with in the current run (`matched`, `duplicate`). */
    current?: FindingKey;
    /** Why it was not carried over (every outcome but `matched`). */
    reason?: MigrationReason;
}

/** What an explicit baseline migration found (see `migrateBaseline`). */
interface BaselineMigration {
    from: IdentityScheme;
    to: IdentityScheme;
    /**
     * The converted baseline: every `matched` entry under its current
     * identity. `null` when an entry is `duplicate` — such a baseline could
     * not be read back (Baseline.ts `loadBaseline`), so nothing is written.
     */
    baseline: BaselineFile | null;
    /** Every entry of the old baseline, classified, in the old key order. */
    entries: MigrationEntry[];
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
 * Nothing is guessed. Each entry gets one outcome:
 * - `matched`: exactly one legacy finding has its identity, exactly one
 *   finding in each run has that finding's position, and no other finding of
 *   the current run has the identity it takes — carried over;
 * - `notReproducible`: no legacy finding has its identity (fixed since, or
 *   changed: `noLegacyFinding`), or the current run has no finding at that
 *   position (`noCurrentFinding`) — dropped, it would have read as fixed;
 * - `ambiguous`: the legacy run produces its identity more than once
 *   (`legacyIdentityShared`), or more than one finding sits at the paired
 *   position in either run (`positionShared`) — which one it was cannot be
 *   told, so it is dropped (its finding reads as new) rather than assigned;
 * - `duplicate`: the identity it would take is produced more than once by
 *   the current run, or taken by another entry too (`targetIdentityShared`)
 *   — a rule defect; the migration writes nothing (`baseline: null`).
 *
 * Both runs must be `complete` — a partial scan cannot tell a fixed finding
 * from an unreached one. The result depends only on the baseline and the
 * two reports, so the same code state migrates to the same file.
 */
export const migrateBaseline = (old: BaselineFile, legacy: AnalysisReport, current: AnalysisReport, rootDir: string): BaselineMigration => {
    for (const report of [legacy, current]) {
        if (report.coverage.status !== 'complete') {
            throw new IncompleteAnalysisError(`refusing to migrate the baseline: the analysis status is "${report.coverage.status}" — a partial scan cannot tell a fixed finding from one it never reached`);
        }
    }
    const legacyByKey = groupBy(legacy.findings, (finding) => keyString(findingKey(rootDir, finding)));
    const legacyById = groupBy(legacy.findings, (finding) => finding.id);
    const currentById = groupBy(current.findings, (finding) => finding.id);
    const sharedCurrentKeys = new Set(duplicateKeys(current.findings.map((finding) => findingKey(rootDir, finding))).map(keyString));
    const entries = [...old.findings]
        .sort((a, b) => keyString(a).localeCompare(keyString(b)))
        .map((entry) => pairEntry(entry, legacyByKey, legacyById, currentById, rootDir));
    markSharedTargets(entries, sharedCurrentKeys);
    const findings = entries.flatMap((item) => (item.outcome === 'matched' && item.current !== undefined ? [item.current] : []));
    findings.sort((a, b) => keyString(a).localeCompare(keyString(b)));
    const blocked = entries.some((item) => item.outcome === 'duplicate');
    return {from: baselineScheme(old), to: IDENTITY_SCHEME, baseline: blocked ? null : {version: 1, identity: IDENTITY_SCHEME, findings}, entries};
};

/** Whether `baseline` needs `migrateBaseline` before it can be compared. */
export const needsMigration = (baseline: BaselineFile): boolean => baselineScheme(baseline) !== IDENTITY_SCHEME;

/** The message for a migration that wrote nothing because entries would share an identity. */
export const duplicateMigrationText = (migration: BaselineMigration): string => {
    const shared = new Map<string, FindingKey>();
    for (const item of migration.entries) {
        if (item.outcome === 'duplicate' && item.current !== undefined) {
            shared.set(keyString(item.current), item.current);
        }
    }
    const keys = [...shared.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, key]) => key);
    return `refusing to migrate the baseline (it could not be read back): ${duplicateIdentityText(keys)}`;
};

/**
 * The migration as the report carries it (`baseline.migration`): counts per
 * outcome, every entry whose identity changed, and every entry that was not
 * carried over, with the reason.
 */
export const migrationSummary = (migration: BaselineMigration): BaselineMigrationSummary => {
    const count = (outcome: MigrationOutcome): number => migration.entries.filter((item) => item.outcome === outcome).length;
    const renamed = migration.entries.flatMap((item) =>
        item.outcome === 'matched' && item.current !== undefined && keyString(item.current) !== keyString(item.entry) ? [{from: item.entry, to: item.current}] : []
    );
    const dropped = migration.entries.flatMap((item) =>
        item.outcome === 'matched' || item.reason === undefined
            ? []
            : [{outcome: item.outcome, reason: item.reason, entry: item.entry, ...(item.current !== undefined ? {current: item.current} : {})}]
    );
    return {
        from: migration.from,
        to: migration.to,
        matched: count('matched'),
        notReproducible: count('notReproducible'),
        ambiguous: count('ambiguous'),
        duplicate: count('duplicate'),
        renamed,
        dropped
    };
};

/** One entry paired through both runs, or the first reason it cannot be. */
const pairEntry = (
    entry: FindingKey,
    legacyByKey: ReadonlyMap<string, Finding[]>,
    legacyById: ReadonlyMap<string, Finding[]>,
    currentById: ReadonlyMap<string, Finding[]>,
    rootDir: string
): MigrationEntry => {
    const legacyFindings = legacyByKey.get(keyString(entry)) ?? [];
    const [legacyFinding] = legacyFindings;
    if (legacyFinding === undefined) {
        return {outcome: 'notReproducible', entry, reason: 'noLegacyFinding'};
    }
    if (legacyFindings.length > 1) {
        return {outcome: 'ambiguous', entry, reason: 'legacyIdentityShared'};
    }
    const atPosition = currentById.get(legacyFinding.id) ?? [];
    const [currentFinding] = atPosition;
    if (currentFinding === undefined) {
        return {outcome: 'notReproducible', entry, reason: 'noCurrentFinding'};
    }
    if (atPosition.length > 1 || (legacyById.get(legacyFinding.id)?.length ?? 0) > 1) {
        return {outcome: 'ambiguous', entry, reason: 'positionShared'};
    }
    return {outcome: 'matched', entry, current: findingKey(rootDir, currentFinding)};
};

/** Turns every matched entry whose target identity is not its own alone into `duplicate`. */
const markSharedTargets = (entries: MigrationEntry[], sharedCurrentKeys: ReadonlySet<string>): void => {
    const targets = new Map<string, number>();
    for (const item of entries) {
        if (item.outcome === 'matched' && item.current !== undefined) {
            const key = keyString(item.current);
            targets.set(key, (targets.get(key) ?? 0) + 1);
        }
    }
    for (const item of entries) {
        if (item.outcome !== 'matched' || item.current === undefined) {
            continue;
        }
        const key = keyString(item.current);
        if (sharedCurrentKeys.has(key) || (targets.get(key) ?? 0) > 1) {
            item.outcome = 'duplicate';
            item.reason = 'targetIdentityShared';
        }
    }
};

/** Findings grouped by a key, in report order. */
const groupBy = (findings: readonly Finding[], keyOf: (finding: Finding) => string): Map<string, Finding[]> => {
    const groups = new Map<string, Finding[]>();
    for (const finding of findings) {
        const key = keyOf(finding);
        const group = groups.get(key);
        if (group === undefined) {
            groups.set(key, [finding]);
        } else {
            group.push(finding);
        }
    }
    return groups;
};
