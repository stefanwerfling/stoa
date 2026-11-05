import {relative} from 'node:path';
import type {Finding} from './Types.js';

/**
 * The finding-identity scheme a symbol follows, stored in every file that
 * holds identities — a baseline (src/Baseline.ts), a corpus manifest
 * (src/evaluation/Corpus.ts), a findings snapshot
 * (scripts/compare-findings.ts) — so one written under another scheme is
 * never compared silently. A file without the field is scheme 1:
 * - 1: finding sites numbered per file (`catch#3`), PHP and C++ symbols
 *   without their namespace, colliding accessors/overloads by order (`#n`);
 * - 2: sites relative to their enclosing declaration
 *   (`Service.load>catch#0`), imports by module (`import:./db`), namespaces in
 *   PHP (`App\Service.run`) and C++ (`app::Service::run`) symbols, accessors
 *   by kind (`Acc.v:get`), C++ overloads by parameter types (`over(int)`).
 *
 * Scheme 1 is still producible (`AnalyzeOptions.identityScheme`) only so a
 * baseline written under it can be migrated explicitly (`--migrate-baseline`).
 */
export type IdentityScheme = 1 | 2;

export const IDENTITY_SCHEME: IdentityScheme = 2;

/** A file's `identity` field read as a scheme: absent = 1; `null` for any other value than 1 or 2 (malformed). */
export const identityField = (value: unknown): IdentityScheme | null => {
    if (value === undefined) {
        return 1;
    }
    return value === 1 || value === 2 ? value : null;
};

/**
 * A finding reduced to its stable identity: (project-relative file, rule id,
 * symbol). Line/column are deliberately excluded — the symbol already
 * encodes identity (e.g. `handler#0`), and including the exact position
 * would make identity brittle to unrelated line shifts elsewhere in the
 * file. Shared by the golden-corpus evaluator (src/evaluation/Evaluator.ts)
 * and the baseline diff (src/Baseline.ts) — one identity scheme, not two.
 */
export interface FindingKey {
    file: string;
    rule: string;
    symbol: string;
}

export const toForwardSlashes = (path: string): string => path.split('\\').join('/');

export const keyString = (key: FindingKey): string => `${toForwardSlashes(key.file)}::${key.rule}::${key.symbol}`;

/**
 * A produced finding carries an absolute location; relativize it against the
 * analysis root so the identity is stable across machines/checkouts and
 * does not depend on where the scan was launched from.
 */
export const findingKey = (rootDir: string, finding: Finding): FindingKey => ({
    file: toForwardSlashes(relative(rootDir, finding.location.file)),
    rule: finding.rule.id,
    symbol: finding.location.symbol ?? ''
});

/**
 * The identities that occur more than once in `keys`, each once, in key
 * order. Two findings with one identity is a rule defect (an integrity
 * violation): no consumer — evaluator, baseline, snapshot diff — can tell
 * them apart, so none merges them; each reports them.
 */
export const duplicateKeys = (keys: readonly FindingKey[]): FindingKey[] => {
    const seen = new Set<string>();
    const repeated = new Map<string, FindingKey>();
    for (const key of keys) {
        const asString = keyString(key);
        if (seen.has(asString)) {
            repeated.set(asString, key);
        }
        seen.add(asString);
    }
    return [...repeated.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, key]) => key);
};

/** The one wording for `duplicateKeys` output: how many identities, which (the first five). */
export const duplicateIdentityText = (duplicates: readonly FindingKey[]): string =>
    `${duplicates.length} identit${duplicates.length === 1 ? 'y' : 'ies'} (file, rule, symbol) produced by more than one finding — a rule defect: ` +
    `${duplicates.slice(0, 5).map(keyString).join(', ')}${duplicates.length > 5 ? ', …' : ''}`;

/**
 * Call-site identities: each base gets its 0-based occurrence index in the
 * given order (`signIn#0`, `signIn#1`, `build>ListView#0`) — the same `#n`
 * convention the extractors use for anonymous functions (`handler#0`). A
 * rule that can report several sites under one base (one method, one build
 * function) must give each its own identity: two findings sharing (file,
 * rule, symbol) are indistinguishable to the evaluator and the baseline.
 */
export const ordinalSymbols = (bases: readonly string[]): string[] => {
    const seen = new Map<string, number>();
    return bases.map((base) => {
        const index = seen.get(base) ?? 0;
        seen.set(base, index + 1);
        return `${base}#${index}`;
    });
};

/**
 * Unique symbols for one file's declarations (the adapters' functions and
 * methods, in source order): a base that occurs once stays as it is; a base
 * shared by several (a getter/setter pair, C++ overloads, two closures on
 * one line) gets the `#n` ordinal on every occurrence. Names cannot contain
 * `#`, so a disambiguated symbol never equals another base.
 */
export const uniqueSymbols = (bases: readonly string[]): string[] => {
    const counts = new Map<string, number>();
    for (const base of bases) {
        counts.set(base, (counts.get(base) ?? 0) + 1);
    }
    const ordinals = ordinalSymbols(bases);
    return bases.map((base, index) => ((counts.get(base) ?? 0) > 1 ? (ordinals[index] as string) : base));
};

/** One declaration's identity base, in source order: a (qualified) name, or `scope.(anonymous)` for a function with no name (parentheses: never an identifier, so no collision with a function named `anonymous`). */
export interface DeclarationBase {
    base: string;
    anonymous: boolean;
    /**
     * What tells this declaration apart from another of the same name, under
     * scheme 2: an accessor's kind (`:get`, `:set`), a C++ overload's
     * parameter types (`(int, const char*)`). Appended only when the base
     * occurs more than once in the file (see `variantBases`).
     */
    variant?: string;
}

/**
 * Bases with their variant appended where the plain base is shared by
 * several declarations (`Acc.v` twice → `Acc.v:get`, `Acc.v:set`) — so two
 * declarations are told apart by what they are, not by their order. Whatever
 * is still shared afterwards gets `#n` from `uniqueSymbols`.
 */
export const variantBases = (entries: readonly {base: string; variant?: string}[]): string[] => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
        counts.set(entry.base, (counts.get(entry.base) ?? 0) + 1);
    }
    return entries.map((entry) => ((counts.get(entry.base) ?? 0) > 1 && entry.variant !== undefined ? `${entry.base}${entry.variant}` : entry.base));
};

/**
 * Symbols for one file's functions: an anonymous base is always numbered in
 * source order within its scope (`outer.(anonymous)#0`, `outer.(anonymous)#1`),
 * so an edit outside that scope never shifts it — unlike a line number; the
 * rest goes through `variantBases` (scheme 2) and `uniqueSymbols`.
 */
export const declarationSymbols = (entries: readonly DeclarationBase[], scheme: IdentityScheme = IDENTITY_SCHEME): string[] => {
    const anonymous = ordinalSymbols(entries.filter((entry) => entry.anonymous).map((entry) => entry.base));
    const named = scheme === 1 ? entries.map((entry) => entry.base) : variantBases(entries);
    let next = 0;
    return uniqueSymbols(
        entries.map((entry, index) => {
            if (!entry.anonymous) {
                return named[index] as string;
            }
            next += 1;
            return anonymous[next - 1] as string;
        })
    );
};
