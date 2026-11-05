import {IDENTITY_SCHEME, uniqueSymbols, type IdentityKind, type IdentityScheme} from '../FindingIdentity.js';
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
 * - outside every declaration, scheme 2: the per-file ordinal stays;
 *   scheme 3: anchored to the innermost `struct.anchor` containing it — a
 *   top-level binding (`dataSource>synchronize#0`), a markup element with an
 *   `id` (`#login>field#0`) — else to the file itself, explicitly
 *   (`(module)>catch#0`, `(document)>img#0`), numbered among the file-level
 *   sites only, so a site added inside any declaration no longer shifts it.
 *
 * The facts of one site (a catch has three) share its legacy symbol and
 * position and get one new symbol; a renamed fact gets the id it would have
 * been built with (`factIdOf`) and the kind of its anchor
 * (`subject.identityKind`: `module`, `site`, `fileOrdinal`; a fact built as
 * `external` stays `external`). Scheme 1 returns the facts unchanged.
 *
 * `context` holds the declarations and anchors of the file; it is `facts`
 * itself for an adapter, and the adapter's facts for sites produced apart
 * from it (the type checker's diagnostics, Pipeline.ts).
 */
export const assignSiteSymbols = (facts: Fact[], scheme: IdentityScheme = IDENTITY_SCHEME, fileScope: FileScope = MODULE_SCOPE, context: readonly Fact[] = facts): Fact[] => {
    if (scheme === 1) {
        return facts;
    }
    const groups = siteGroups(facts);
    if (groups.length === 0) {
        return facts;
    }
    const renamed = new Map<string, {symbol: string; kind: IdentityKind}>();
    const scopes = scopesOf(context, 'declaration');
    const anchors = scheme >= 3 ? scopesOf(context, 'anchor') : [];
    const counters = new Map<string, number>();
    const imports = groups.filter((group) => group.kind === 'import');
    const importSymbols = uniqueSymbols(imports.map((group) => `import:${group.module ?? ''}`));
    imports.forEach((group, index) => renamed.set(group.key, {symbol: importSymbols[index] as string, kind: 'module'}));
    for (const group of groups) {
        if (group.kind === 'import') {
            continue;
        }
        const declaration = innermostScope(scopes, group.range);
        const anchor = declaration ?? innermostScope(anchors, group.range);
        if (anchor === undefined && scheme < 3) {
            continue;
        }
        const scope = anchor ?? fileScope;
        const counter = `${scope}\n${group.kind}`;
        const index = counters.get(counter) ?? 0;
        counters.set(counter, index + 1);
        renamed.set(group.key, {symbol: `${scope}>${group.kind}#${index}`, kind: anchor === undefined ? 'fileOrdinal' : 'site'});
    }
    return facts.map((fact) => {
        const identity = isSiteFact(fact) ? renamed.get(siteKey(fact)) : undefined;
        if (identity === undefined) {
            return fact;
        }
        const identityKind = fact.subject.identityKind === 'external' ? 'external' : identity.kind;
        return {...fact, id: factIdOf(fact.subject.file, fact.kind, identity.symbol, fact.subject.range.startLine), subject: {...fact.subject, symbol: identity.symbol, identityKind}};
    });
};

/** The explicit scope of a site outside every declaration and anchor (scheme 3): code is a module, markup a document. */
export type FileScope = typeof MODULE_SCOPE | typeof DOCUMENT_SCOPE;

export const MODULE_SCOPE = '(module)';

export const DOCUMENT_SCOPE = '(document)';

/**
 * The fact kind of an anchor (scheme 3): something with a stable name that is
 * no declaration but can hold sites — a top-level binding (`const
 * dataSource = {…}`, `export default {…}`, `module.exports = {…}`), a markup
 * element with an `id` (symbol `#login`). Value: how it is named.
 */
export const ANCHOR_FACT = 'struct.anchor';

export interface AnchorValue {
    form: 'binding' | 'elementId';
}

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

/**
 * The declarations a site can belong to — every function (its metric facts)
 * and type (`struct.typeDecl`) of the file — or its anchors (`struct.anchor`).
 */
const scopesOf = (facts: readonly Fact[], what: 'declaration' | 'anchor'): Scope[] => {
    const scopes: Scope[] = [];
    for (const fact of facts) {
        const symbol = fact.subject.symbol;
        const wanted = what === 'anchor' ? fact.kind === ANCHOR_FACT : fact.kind === 'metric.cyclomaticComplexity' || fact.kind === 'struct.typeDecl';
        if (wanted && symbol !== undefined) {
            scopes.push({symbol, range: fact.subject.range});
        }
    }
    return scopes;
};

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
