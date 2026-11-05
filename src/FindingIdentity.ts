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
 *   by kind (`Acc.v:get`), C++ overloads by parameter types (`over(int)`);
 * - 3: what scheme 2 still numbered per file is anchored too — a site
 *   outside every declaration to its top-level binding
 *   (`dataSource>synchronize#0`) or, in markup, to the nearest element with
 *   an `id` (`#login>field#0`), else to the file, explicitly and counted
 *   among the file-level sites only (`(module)>catch#0`,
 *   `(document)>img#0`); type-checker diagnostics to their declaration
 *   (`Service.load>tsc#0`); Flutter lifecycle call sites to their method
 *   (`State.save>setState#0`); C++ definitions that share name and
 *   parameters by their preprocessor condition (`load(int)[!HAVE_CUDA]`).
 *
 * Schemes 1 and 2 are still producible (`AnalyzeOptions.identityScheme`)
 * only so a baseline written under them can be migrated explicitly
 * (`--migrate-baseline`).
 */
export type IdentityScheme = 1 | 2 | 3;

export const IDENTITY_SCHEME: IdentityScheme = 3;

/** Every scheme a file may name, oldest first. */
export const IDENTITY_SCHEMES: readonly IdentityScheme[] = [1, 2, 3];

/** The valid `identity` values, for an error message (`1, 2 or 3`). */
export const IDENTITY_SCHEMES_TEXT = `${IDENTITY_SCHEMES.slice(0, -1).join(', ')} or ${IDENTITY_SCHEMES[IDENTITY_SCHEMES.length - 1] ?? ''}`;

/** A file's `identity` field read as a scheme: absent = 1; `null` for any value that names no scheme (malformed). */
export const identityField = (value: unknown): IdentityScheme | null => {
    if (value === undefined) {
        return 1;
    }
    return IDENTITY_SCHEMES.find((scheme) => scheme === value) ?? null;
};

/**
 * What a finding's symbol is anchored to — set where the symbol is made
 * (an extractor, the site pass, a project rule), never read back from the
 * symbol text. Carried as `Finding.location.identityKind` (and on the fact
 * subject it comes from); not part of the identity (`FindingKey`).
 * - `declaration`: a named function, method, type or member (`Service.load`),
 *   or a relation between declarations (`Repo:IRepo`);
 * - `anonymous`: a function without a name, numbered within its scope
 *   (`outer.(anonymous)#0`);
 * - `site`: a place inside a declaration or binding (`Service.load>catch#0`);
 * - `module`: a module or package (`import:./db`, a dependency cycle, an
 *   architecture edge);
 * - `external`: a diagnostic of an external tool (the TypeScript checker),
 *   anchored like a site;
 * - `fileOrdinal`: a site with no declaration to anchor it, numbered among
 *   the file's top-level sites (`(module)>catch#0`) — the weakest identity:
 *   another top-level site of its kind inserted above it shifts it;
 * - `ambiguous`: declarations that share name, variant and condition, told
 *   apart only by their order (`f#0`, `f#1`);
 * - `file`: the file itself (no symbol).
 */
export type IdentityKind = 'declaration' | 'anonymous' | 'site' | 'module' | 'external' | 'fileOrdinal' | 'ambiguous' | 'file';

export const IDENTITY_KINDS: readonly IdentityKind[] = ['declaration', 'anonymous', 'site', 'module', 'external', 'fileOrdinal', 'ambiguous', 'file'];

/** The identity kind of a finding located at a fact's subject: `file` without a symbol, else what the fact says. */
export const subjectIdentityKind = (subject: {symbol?: string; identityKind?: IdentityKind}): {identityKind?: IdentityKind} => {
    if (subject.symbol === undefined || subject.symbol === '') {
        return {identityKind: 'file'};
    }
    return subject.identityKind === undefined ? {} : {identityKind: subject.identityKind};
};

/** A symbol together with the kind of identity it has. */
export interface SymbolIdentity {
    symbol: string;
    kind: IdentityKind;
}

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
export const uniqueSymbols = (bases: readonly string[]): string[] => uniqueIdentities(bases).map((identity) => identity.symbol);

/** `uniqueSymbols` with each symbol's kind: `declaration`, or `ambiguous` where only the `#n` ordinal tells it apart. */
export const uniqueIdentities = (bases: readonly string[]): SymbolIdentity[] => {
    const counts = new Map<string, number>();
    for (const base of bases) {
        counts.set(base, (counts.get(base) ?? 0) + 1);
    }
    const ordinals = ordinalSymbols(bases);
    return bases.map((base, index) => ((counts.get(base) ?? 0) > 1 ? {symbol: ordinals[index] as string, kind: 'ambiguous'} : {symbol: base, kind: 'declaration'}));
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
export const declarationSymbols = (entries: readonly DeclarationBase[], scheme: IdentityScheme = IDENTITY_SCHEME): string[] =>
    declarationIdentities(entries, scheme).map((identity) => identity.symbol);

/** `declarationSymbols` with each symbol's kind: `anonymous` for a function without a name, `ambiguous` where only a `#n` ordinal tells named declarations apart, else `declaration`. */
export const declarationIdentities = (entries: readonly DeclarationBase[], scheme: IdentityScheme = IDENTITY_SCHEME): SymbolIdentity[] => {
    const anonymous = ordinalSymbols(entries.filter((entry) => entry.anonymous).map((entry) => entry.base));
    const named = scheme === 1 ? entries.map((entry) => entry.base) : variantBases(entries);
    let next = 0;
    const identities = uniqueIdentities(
        entries.map((entry, index) => {
            if (!entry.anonymous) {
                return named[index] as string;
            }
            next += 1;
            return anonymous[next - 1] as string;
        })
    );
    return identities.map((identity, index) => (entries[index]?.anonymous === true ? {symbol: identity.symbol, kind: 'anonymous'} : identity));
};
