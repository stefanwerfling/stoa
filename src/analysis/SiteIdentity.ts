import {IDENTITY_SCHEME, uniqueSymbols, type IdentityScheme} from '../FindingIdentity.js';
import type {Fact, SourceRange} from '../Types.js';
import {factIdOf, isSiteFact} from './FactBuilder.js';
import type {ProjectContext} from './LanguageAdapter.js';

/** The `identityScheme` part of an AdapterInfo, from the run's context (absent = current). */
export const schemeOf = (context: ProjectContext): {identityScheme?: IdentityScheme} =>
    context.identityScheme === undefined ? {} : {identityScheme: context.identityScheme};

/**
 * Finding sites (FactSpec.site: a catch, an import, a DDL statement, an a11y
 * element …) relative to their declaration — identity scheme 2 (see
 * FindingIdentity.ts). An extractor names a site by its legacy per-file
 * ordinal (`catch#3`); this pass, run by every adapter on one file's facts,
 * renames it:
 * - inside a declaration: `<scope>>catch#n`, numbered per (scope, kind) in
 *   source order, where scope is the symbol of the innermost function or
 *   type whose range contains the site (`Service.load>catch#0`). An edit in
 *   another declaration — a new catch above it, a moved method — leaves it
 *   alone; a per-file ordinal shifted with every earlier site of its kind;
 * - an import: by its module (`import:./db`), `#n` only when one file
 *   imports the same module twice;
 * - outside every declaration (static HTML, a top-level config object): the
 *   per-file ordinal stays — there is no declaration to anchor it to.
 *
 * The facts of one site (a catch has three) share its legacy symbol and
 * position and get one new symbol; a renamed fact gets the id it would have
 * been built with (`factIdOf`). Scheme 1 returns the facts unchanged.
 */
export const assignSiteSymbols = (facts: Fact[], scheme: IdentityScheme = IDENTITY_SCHEME): Fact[] => {
    if (scheme === 1) {
        return facts;
    }
    const groups = siteGroups(facts);
    if (groups.length === 0) {
        return facts;
    }
    const renamed = new Map<string, string>();
    const scopes = scopesOf(facts);
    const counters = new Map<string, number>();
    const imports = groups.filter((group) => group.kind === 'import');
    const importSymbols = uniqueSymbols(imports.map((group) => `import:${group.module ?? ''}`));
    imports.forEach((group, index) => renamed.set(group.key, importSymbols[index] as string));
    for (const group of groups) {
        if (group.kind === 'import') {
            continue;
        }
        const scope = innermostScope(scopes, group.range);
        if (scope === undefined) {
            continue;
        }
        const counter = `${scope}\n${group.kind}`;
        const index = counters.get(counter) ?? 0;
        counters.set(counter, index + 1);
        renamed.set(group.key, `${scope}>${group.kind}#${index}`);
    }
    return facts.map((fact) => {
        const symbol = isSiteFact(fact) ? renamed.get(siteKey(fact)) : undefined;
        if (symbol === undefined) {
            return fact;
        }
        return {...fact, id: factIdOf(fact.subject.file, fact.kind, symbol, fact.subject.range.startLine), subject: {...fact.subject, symbol}};
    });
};

interface SiteGroup {
    key: string;
    kind: string;
    ordinal: number;
    range: SourceRange;
    module?: string;
}

interface Scope {
    symbol: string;
    range: SourceRange;
}

const LEGACY_SITE = /^(.+)#(\d+)$/;

const siteKey = (fact: Fact): string => `${fact.subject.symbol ?? ''}@${fact.subject.range.startLine}:${fact.subject.range.startCol}`;

/** One entry per site (legacy symbol + position), in source order. */
const siteGroups = (facts: readonly Fact[]): SiteGroup[] => {
    const groups = new Map<string, SiteGroup>();
    for (const fact of facts) {
        const match = isSiteFact(fact) ? LEGACY_SITE.exec(fact.subject.symbol ?? '') : null;
        if (match === null) {
            continue;
        }
        const key = siteKey(fact);
        const group = groups.get(key) ?? {key, kind: match[1] as string, ordinal: Number(match[2]), range: fact.subject.range};
        const module = group.module ?? moduleOf(fact);
        groups.set(key, module === undefined ? group : {...group, module});
    }
    return [...groups.values()].sort((a, b) => compareStart(a.range, b.range) || a.ordinal - b.ordinal);
};

/** The module an import fact names: `deps.import`/`deps.importName` carry `{module}`, `deps.importUnused`/`-Deep` the module itself. */
const moduleOf = (fact: Fact): string | undefined => {
    const value = fact.value as unknown;
    if (typeof value === 'string') {
        return fact.kind.startsWith('deps.') ? value : undefined;
    }
    if (typeof value === 'object' && value !== null && typeof (value as {module?: unknown}).module === 'string') {
        return (value as {module: string}).module;
    }
    return undefined;
};

/** Every function (its metric facts) and type (`struct.typeDecl`) of the file: the declarations a site can belong to. */
const scopesOf = (facts: readonly Fact[]): Scope[] =>
    facts
        .filter((fact) => (fact.kind === 'metric.cyclomaticComplexity' || fact.kind === 'struct.typeDecl') && fact.subject.symbol !== undefined)
        .map((fact) => ({symbol: fact.subject.symbol as string, range: fact.subject.range}));

const compareStart = (a: SourceRange, b: SourceRange): number => a.startLine - b.startLine || a.startCol - b.startCol;

const compareEnd = (a: SourceRange, b: SourceRange): number => a.endLine - b.endLine || a.endCol - b.endCol;

const contains = (outer: SourceRange, inner: SourceRange): boolean => compareStart(outer, inner) <= 0 && compareEnd(inner, outer) <= 0;

/** The innermost declaration containing `range`: the latest start, then the earliest end. */
const innermostScope = (scopes: readonly Scope[], range: SourceRange): string | undefined => {
    let best: Scope | undefined;
    for (const scope of scopes) {
        if (!contains(scope.range, range)) {
            continue;
        }
        if (best === undefined || compareStart(scope.range, best.range) > 0 || (compareStart(scope.range, best.range) === 0 && compareEnd(scope.range, best.range) <= 0)) {
            best = scope;
        }
    }
    return best?.symbol;
};
