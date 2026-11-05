import {duplicateKeys, findingKey, keyString, type FindingKey} from './FindingIdentity.js';
import type {Finding} from './Types.js';

/**
 * How two finding lists are paired (see `diffFindings`):
 * - `identity`: by finding identity (file, rule, symbol) — the same key the
 *   evaluator and the baseline use; for two lists under one identity scheme;
 * - `position`: by `Finding.id` (rule, file, position) — for two lists under
 *   different identity schemes of the same code, where only symbols differ.
 */
type DiffPairing = 'identity' | 'position';

/** One finding present on both sides whose content differs beyond its position. */
interface ChangedFinding {
    key: FindingKey;
    /** The differing fields as paths (`.severity`, `.observation.statement`). */
    fields: string[];
}

/** A pair (position pairing) whose identity differs: the same finding under another name. */
interface RenamedFinding {
    before: FindingKey;
    after: FindingKey;
}

/** What differs between two finding lists of one target. */
interface FindingDiff {
    pairing: DiffPairing;
    /** Pairs that are equal in every field. */
    same: number;
    /** Pairs equal except for their position (`id`, `location.range`) — a shift, not a change. */
    moved: FindingKey[];
    /** Pairs whose content differs (severity, statement, evidence …). */
    changed: ChangedFinding[];
    /** Position pairing only: pairs whose identity differs. */
    renamed: RenamedFinding[];
    added: FindingKey[];
    removed: FindingKey[];
    /**
     * Keys a side holds more than once — an identity (identity pairing) or
     * an id (position pairing). A repeated identity is a rule defect; such
     * findings cannot be paired and are listed here, not merged.
     */
    duplicates: {before: FindingKey[]; after: FindingKey[]};
}

/** Whether a differing field only says where a finding sits (`id`, `location.range`): a difference there alone is a shift. */
const isPositionField = (path: string): boolean => path === '.id' || path === '.location.range' || path.startsWith('.location.range.');

/**
 * Compares two finding lists of one target (both relative to `rootDir`, as
 * the evaluator's and the baseline's are) and separates a shift from a
 * change: a finding with the same identity at another position is `moved`;
 * one whose content differs is `changed`, with the fields; one only on one
 * side is `added`/`removed`. Nothing is merged: a key that one side holds
 * more than once is listed in `duplicates` and left unpaired.
 *
 * Positions inside evidence values (a line in a fact value) are compared as
 * content — such a finding reads as `changed`, never as unchanged.
 */
export const diffFindings = (before: readonly Finding[], after: readonly Finding[], rootDir: string, pairing: DiffPairing = 'identity'): FindingDiff => {
    const keyOf = (finding: Finding): FindingKey => findingKey(rootDir, finding);
    const pairKey = pairing === 'identity' ? (finding: Finding): string => keyString(keyOf(finding)) : (finding: Finding): string => finding.id;
    const left = indexBy(before, pairKey);
    const right = indexBy(after, pairKey);
    const result: FindingDiff = {
        pairing,
        same: 0,
        moved: [],
        changed: [],
        renamed: [],
        added: [],
        removed: [],
        duplicates: {before: repeatedKeys(before, left.repeated, keyOf, pairing), after: repeatedKeys(after, right.repeated, keyOf, pairing)}
    };
    const removed = [...left.unique].filter(([key]) => !right.unique.has(key) && !right.repeated.has(key)).map(([, finding]) => finding);
    const added = [...right.unique].filter(([key]) => !left.unique.has(key) && !left.repeated.has(key)).map(([, finding]) => finding);
    for (const [key, finding] of left.unique) {
        const other = right.unique.get(key);
        if (other !== undefined) {
            comparePair(finding, other, keyOf, result);
        }
    }
    // Position pairing: a finding that kept its identity but moved has no
    // partner by position — paired by identity in a second pass.
    const rest = pairing === 'position' ? pairByIdentity(removed, added, keyOf, result) : {removed, added};
    result.removed.push(...rest.removed.map(keyOf));
    result.added.push(...rest.added.map(keyOf));
    for (const list of [result.moved, result.added, result.removed]) {
        list.sort(byKey);
    }
    result.changed.sort((a, b) => byKey(a.key, b.key));
    result.renamed.sort((a, b) => byKey(a.before, b.before));
    return result;
};

/** Pairs the findings left over on both sides by identity (`comparePair`) and returns those that still have no partner. */
const pairByIdentity = (
    removed: readonly Finding[],
    added: readonly Finding[],
    keyOf: (finding: Finding) => FindingKey,
    result: FindingDiff
): {removed: Finding[]; added: Finding[]} => {
    const identity = (finding: Finding): string => keyString(keyOf(finding));
    const left = indexBy(removed, identity);
    const right = indexBy(added, identity);
    const paired = new Set<string>();
    for (const [key, finding] of left.unique) {
        const other = right.unique.get(key);
        if (other !== undefined) {
            comparePair(finding, other, keyOf, result);
            paired.add(key);
        }
    }
    return {removed: removed.filter((finding) => !paired.has(identity(finding))), added: added.filter((finding) => !paired.has(identity(finding)))};
};

/** Whether the two lists hold the same findings with the same content (positions and order aside). */
export const isSemanticallyEqual = (diff: FindingDiff): boolean =>
    diff.changed.length === 0 &&
    diff.renamed.length === 0 &&
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.duplicates.before.length === 0 &&
    diff.duplicates.after.length === 0;

const comparePair = (before: Finding, after: Finding, keyOf: (finding: Finding) => FindingKey, result: FindingDiff): void => {
    const beforeKey = keyOf(before);
    const afterKey = keyOf(after);
    const renamed = keyString(beforeKey) !== keyString(afterKey);
    if (renamed) {
        result.renamed.push({before: beforeKey, after: afterKey});
    }
    const fields = differingPaths(renamed ? underName(before, after) : before, after, '').filter((path) => !isPositionField(path));
    if (fields.length > 0) {
        result.changed.push({key: afterKey, fields});
    } else if (renamed) {
        return;
    } else if (JSON.stringify(before) === JSON.stringify(after)) {
        result.same += 1;
    } else {
        result.moved.push(afterKey);
    }
};

/**
 * `before` under `after`'s symbol: a renamed finding's symbol, and the
 * statement that quotes it, differ by definition; anything else that differs
 * is still a change.
 */
const underName = (before: Finding, after: Finding): Finding => {
    const from = before.location.symbol;
    const to = after.location.symbol;
    const statement = from !== undefined && from !== '' && to !== undefined ? before.observation.statement.split(from).join(to) : before.observation.statement;
    const location = to === undefined ? withoutSymbol(before.location) : {...before.location, symbol: to};
    return {...before, location, observation: {...before.observation, statement}};
};

const withoutSymbol = (location: Finding['location']): Finding['location'] => {
    const {symbol: _symbol, ...rest} = location;
    return rest;
};

const indexBy = (findings: readonly Finding[], keyOf: (finding: Finding) => string): {unique: Map<string, Finding>; repeated: Set<string>} => {
    const unique = new Map<string, Finding>();
    const repeated = new Set<string>();
    for (const finding of findings) {
        const key = keyOf(finding);
        if (unique.has(key) || repeated.has(key)) {
            unique.delete(key);
            repeated.add(key);
        } else {
            unique.set(key, finding);
        }
    }
    return {unique, repeated};
};

/** The findings behind repeated pairing keys, as identities: `duplicateKeys` for identity pairing, every finding of a repeated id for position pairing. */
const repeatedKeys = (findings: readonly Finding[], repeated: ReadonlySet<string>, keyOf: (finding: Finding) => FindingKey, pairing: DiffPairing): FindingKey[] => {
    if (repeated.size === 0) {
        return [];
    }
    if (pairing === 'identity') {
        return duplicateKeys(findings.map(keyOf));
    }
    return findings.filter((finding) => repeated.has(finding.id)).map(keyOf).sort(byKey);
};

const byKey = (a: FindingKey, b: FindingKey): number => keyString(a).localeCompare(keyString(b));

/** Paths of the leaves that differ between two JSON values (arrays by index, a length difference as `[len]`). */
const differingPaths = (a: unknown, b: unknown, path: string): string[] => {
    if (a === b) {
        return [];
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) {
            return [`${path}[len]`];
        }
        return a.flatMap((item, index) => differingPaths(item, b[index], `${path}[${index}]`));
    }
    if (isRecord(a) && isRecord(b)) {
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
        return keys.flatMap((key) => differingPaths(a[key], b[key], `${path}.${key}`));
    }
    return [path === '' ? '.' : path];
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
