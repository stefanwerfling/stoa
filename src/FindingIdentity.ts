import {relative} from 'node:path';
import type {Finding} from './Types.js';

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
}

/**
 * Symbols for one file's functions: an anonymous base is always numbered in
 * source order within its scope (`outer.(anonymous)#0`, `outer.(anonymous)#1`),
 * so an edit outside that scope never shifts it — unlike a line number; the
 * rest goes through `uniqueSymbols`.
 */
export const declarationSymbols = (entries: readonly DeclarationBase[]): string[] => {
    const anonymous = ordinalSymbols(entries.filter((entry) => entry.anonymous).map((entry) => entry.base));
    let next = 0;
    return uniqueSymbols(
        entries.map((entry) => {
            if (!entry.anonymous) {
                return entry.base;
            }
            next += 1;
            return anonymous[next - 1] as string;
        })
    );
};
