import type {ReexportValue} from '../analysis/DepsFacts.js';
import type {Fact} from '../Types.js';
import type {ImportEvidence, ModuleGraph} from './ModuleGraph.js';

/**
 * A reusable, project-wide cross-file SYMBOL graph (Phase 1, step 1; re-exports
 * and `external` since the semantic consolidation, phase 2). It binds each
 * imported name to the export definition it refers to in another analyzed
 * file -- built ONCE per analysis, purely from existing facts
 * (`deps.importName` for import sites, `deps.export` for export definitions,
 * `deps.reexport` for `export … from`) plus the already-resolved `ModuleGraph`
 * edges. It performs NO AST analysis, holds NO copy of the fact array (only
 * file paths, names, fact ids and ranges), and never guesses: a binding that
 * cannot be shown unambiguously is `unresolved`, `ambiguous` or `external`,
 * never a fabricated identity.
 *
 * It is the ONE resolver of ES-module names: the TypeModel asks it (TS), no
 * rule re-resolves imports itself. Dart names are the DartLibraryIndex's (its
 * own library model: prefixes, show/hide, export barrels, parts) — Dart
 * module-graph edges are not part of this graph.
 *
 * Re-exports (`deps.reexport`): `export {a as b} from`, `export {default as
 * X} from`, `export * from` and `export * as ns from` are followed through the
 * module graph to the defining file, recording every hop (`via`):
 * - a local export or an explicit re-export of the name wins over `export *`
 *   (as in TypeScript); two of them is `ambiguous`;
 * - `export *` never provides `default`; two `export *` providing the name
 *   from DIFFERENT definitions is `ambiguous` (TypeScript drops such a name),
 *   never an arbitrary pick;
 * - a hop into a package is `external`, into an unresolvable project module
 *   `unresolved` (`unresolvedReason: 'module'`); a re-export cycle is
 *   detected on the current path and is `unresolved` (`'cycle'`) — every
 *   traversal is bounded by that path guard.
 * Not followed (documented limit): `import {A} from './a'; export {A};` — a
 * local export of an imported binding counts as defined in the exporting file.
 *
 * A namespace import (`import * as ns`) binds the whole module, not a single
 * export, so it is `resolved` exactly when its target file resolved -- there
 * is no per-name export to match (`resolveExport(file, name)` answers `ns.X`).
 */

export type SymbolResolutionStatus = 'resolved' | 'unresolved' | 'ambiguous' | 'external';

/** Why a binding is `unresolved`: its module did not resolve, the module does not export the name, or a re-export cycle. */
export type UnresolvedReason = 'module' | 'export' | 'cycle';

/** Where a symbol is defined (after following re-exports): the file, the name it has THERE, and its export site(s). */
export interface SymbolDefinition {
    file: string;
    /** The name as exported by `file` (`default` for a default export, `*` for a whole module reached through `export * as ns`). */
    name: string;
    evidence: ImportEvidence[];
}

/** One re-export hop: `file` re-exports the name (as `exportedAs`) from `specifier`. */
export interface ReexportHop {
    file: string;
    specifier: string;
    exportedAs: string;
    evidence: ImportEvidence;
}

export interface ExportResolution {
    status: SymbolResolutionStatus;
    /** One definition when `resolved`; every candidate when `ambiguous`; empty otherwise. */
    definitions: SymbolDefinition[];
    /** The re-export hops from the queried file to the definition (or to the point it stopped). */
    via: ReexportHop[];
    unresolvedReason?: UnresolvedReason;
}

export interface SymbolEdge {
    /** Absolute path of the importing module (an analyzed file). */
    fromFile: string;
    /** The raw module specifier of the import (e.g. `./b`, `@app/x`). */
    specifier: string;
    /** The name as EXPORTED by the target (not the local alias): a named import's imported name, `default` for a default import, `*` for a namespace import -- exactly the `deps.importName` convention. */
    importedName: string;
    kind: 'named' | 'default' | 'namespace';
    /**
     * The resolved MODULE target file when it is known — set on `resolved`, on
     * `ambiguous`, AND on an `unresolved`/`external` reached after the module
     * resolved (the export was absent, or a re-export chain stopped). It is
     * `null` ONLY when the module itself did not resolve to a single analyzed
     * file. So `toFile !== null` means "known target file"; it does NOT by
     * itself mean the binding is `resolved` — always read `status` for that.
     */
    toFile: string | null;
    /**
     * `resolved` — the binding is proven: for named/default, exactly one
     * definition (after re-exports); for a NAMESPACE import, `resolved` means
     * ONLY that the module was bound to `toFile` as a whole. `external` — the
     * module (or a re-export hop) is a package outside the project.
     * `unresolved` — see `unresolvedReason`. `ambiguous` — more than one
     * candidate, all retained in `definitions`/`exportEvidence`.
     */
    status: SymbolResolutionStatus;
    /** All import sites of this binding (one per contributing `deps.importName` fact), deduped by factId, sorted deterministically. */
    importEvidence: ImportEvidence[];
    /** The export site(s) of the name on `toFile` itself (a barrel's re-export specifier included) for a resolved/ambiguous named/default binding. Empty for namespace bindings and for other statuses. */
    exportEvidence: ImportEvidence[];
    /** Where the symbol is defined, after re-exports (see `ExportResolution`). Empty for namespace bindings. */
    definitions: SymbolDefinition[];
    /** Re-export hops from `toFile` to the definition; empty for a direct export. */
    via: ReexportHop[];
    unresolvedReason?: UnresolvedReason;
}

export interface SymbolGraph {
    /** Cross-file symbol bindings, sorted deterministically. */
    imports: readonly SymbolEdge[];
    /** What `name`, exported by the analyzed file `file`, resolves to (re-exports followed). */
    resolveExport(file: string, name: string): ExportResolution;
    /**
     * Every name the analyzed file `file` exports, sorted: its own exports,
     * its explicit re-exports, and what its `export *` re-exports provide
     * (followed through analyzed files, `default` excepted, cycle-safe). Names
     * only — whether one resolves, or is ambiguous, `resolveExport` says.
     */
    exportNames(file: string): string[];
}

interface ImportNameValue {
    module: string;
    name: string;
    kind: 'named' | 'default' | 'namespace';
}

interface Reexport extends ReexportValue {
    evidence: ImportEvidence;
    /** The analyzed file the specifier resolved to, or null. */
    target: string | null;
    external: boolean;
}

/** Resolution result plus whether a cycle was met (such results depend on the path and are not memoized). */
interface Traced {
    result: ExportResolution;
    cyclic: boolean;
}

// Key separator for grouping maps: a newline, which cannot occur inside an
// absolute file path, a module specifier, a JS identifier or one of the fixed
// `kind` values -- so concatenated keys are collision-free. Built via a char
// code (not a literal) so the source stays plain, single-line ASCII.
const SEP = String.fromCharCode(10);

const compareEvidence = (a: ImportEvidence, b: ImportEvidence): number =>
    a.factId.localeCompare(b.factId) || a.range.startLine - b.range.startLine || a.range.startCol - b.range.startCol;

const addEvidence = (sites: ImportEvidence[], evidence: ImportEvidence): void => {
    if (!sites.some((site) => site.factId === evidence.factId)) {
        sites.push(evidence);
    }
};

const compareEdges = (a: SymbolEdge, b: SymbolEdge): number =>
    a.fromFile.localeCompare(b.fromFile) || a.specifier.localeCompare(b.specifier) || a.importedName.localeCompare(b.importedName) || a.kind.localeCompare(b.kind);

const rangeKey = (file: string, evidence: ImportEvidence): string => `${file}${SEP}${evidence.range.startLine}:${evidence.range.startCol}`;
const definitionKey = (definition: SymbolDefinition): string => `${definition.file}${SEP}${definition.name}`;
const isFound = (result: ExportResolution): boolean => result.status === 'resolved' || result.status === 'ambiguous';
const unresolved = (reason: UnresolvedReason, via: ReexportHop[] = []): ExportResolution => ({status: 'unresolved', definitions: [], via, unresolvedReason: reason});

interface ImportGroup {
    fromFile: string;
    specifier: string;
    importedName: string;
    kind: 'named' | 'default' | 'namespace';
    importEvidence: ImportEvidence[];
}

/** Module-level lookups from the module graph: resolved targets and external specifiers per (file, specifier, origin). */
class ModuleTargets {
    private readonly targets = new Map<string, string | null>();
    private readonly externals = new Set<string>();

    public constructor(moduleGraph: ModuleGraph) {
        for (const edge of moduleGraph.edges) {
            // Dart edges (E2) belong to Dart's library model, PHP `use` edges
            // (PSR-4) to PHP's class names, C/C++ includes to the
            // preprocessor — none to the ES-module model.
            if (edge.origin === 'dart.importSpec' || edge.origin === 'cpp.include' || edge.resolution === 'psr4') {
                continue;
            }
            const key = ModuleTargets.key(edge.from, edge.specifier, edge.origin);
            // A pair reaching more than one distinct target (not expected) is ambiguous (null), never a pick.
            this.targets.set(key, this.targets.has(key) && this.targets.get(key) !== edge.to ? null : edge.to);
        }
        for (const entry of moduleGraph.unresolved) {
            if (entry.external === true) {
                this.externals.add(ModuleTargets.key(entry.from, entry.specifier, entry.origin));
            }
        }
    }

    private static key(file: string, specifier: string, origin: string | undefined): string {
        return `${file}${SEP}${specifier}${SEP}${origin === 'deps.reexport' ? 'reexport' : 'import'}`;
    }

    /** undefined = not resolved; null = ambiguous; else the target file. */
    public target(file: string, specifier: string, reexport: boolean): string | null | undefined {
        return this.targets.get(ModuleTargets.key(file, specifier, reexport ? 'deps.reexport' : undefined));
    }

    public isExternal(file: string, specifier: string, reexport: boolean): boolean {
        return this.externals.has(ModuleTargets.key(file, specifier, reexport ? 'deps.reexport' : undefined));
    }
}

/** Resolves an exported name of an analyzed file to its definition, following re-exports (see the module comment). */
class ExportResolver {
    /** file → name → every deps.export site (re-export specifiers included). */
    public readonly exportSites = new Map<string, Map<string, ImportEvidence[]>>();
    private readonly reexportsByFile = new Map<string, Reexport[]>();
    private readonly reexportRanges = new Set<string>();
    private readonly memo = new Map<string, ExportResolution>();

    public constructor(facts: readonly Fact[], modules: ModuleTargets) {
        for (const fact of facts) {
            if (fact.kind === 'deps.reexport') {
                const value = fact.value as unknown as ReexportValue;
                const evidence: ImportEvidence = {factId: fact.id, range: fact.subject.range};
                const target = modules.target(fact.subject.file, value.module, true);
                const reexport: Reexport = {...value, evidence, target: target ?? null, external: modules.isExternal(fact.subject.file, value.module, true)};
                this.reexportsByFile.set(fact.subject.file, [...(this.reexportsByFile.get(fact.subject.file) ?? []), reexport]);
                this.reexportRanges.add(rangeKey(fact.subject.file, evidence));
            } else if (fact.kind === 'deps.export') {
                const byName = this.exportSites.get(fact.subject.file) ?? new Map<string, ImportEvidence[]>();
                const sites = byName.get(String(fact.value)) ?? [];
                addEvidence(sites, {factId: fact.id, range: fact.subject.range});
                byName.set(String(fact.value), sites);
                this.exportSites.set(fact.subject.file, byName);
            }
        }
        for (const sites of [...this.exportSites.values()].flatMap((byName) => [...byName.values()])) {
            sites.sort(compareEvidence);
        }
        for (const reexports of this.reexportsByFile.values()) {
            reexports.sort((a, b) => compareEvidence(a.evidence, b.evidence));
        }
    }

    public resolve(file: string, name: string): ExportResolution {
        return this.trace(file, name, new Set()).result;
    }

    public names(file: string, path: ReadonlySet<string> = new Set()): Set<string> {
        if (path.has(file)) {
            return new Set();
        }
        const inner = new Set([...path, file]);
        const names = new Set(this.exportSites.get(file)?.keys() ?? []);
        for (const reexport of this.reexportsByFile.get(file) ?? []) {
            if (reexport.kind !== 'star') {
                names.add(reexport.exportedAs);
            } else if (reexport.target !== null) {
                [...this.names(reexport.target, inner)].filter((name) => name !== 'default').forEach((name) => names.add(name));
            }
        }
        return names;
    }

    private trace(file: string, name: string, path: ReadonlySet<string>): Traced {
        const key = `${file}${SEP}${name}`;
        if (path.has(key)) {
            return {result: unresolved('cycle'), cyclic: true};
        }
        const cached = this.memo.get(key);
        if (cached !== undefined) {
            return {result: cached, cyclic: false};
        }
        const inner = new Set([...path, key]);
        const explicit = this.explicitCandidates(file, name, inner);
        const traced = explicit.length > 0 ? combine(explicit) : this.starCandidates(file, name, inner);
        if (!traced.cyclic) {
            this.memo.set(key, traced.result);
        }
        return traced;
    }

    // A local definition, an explicit `export {x as name} from`, an `export * as name from`.
    private explicitCandidates(file: string, name: string, path: ReadonlySet<string>): Traced[] {
        const reexports = this.reexportsByFile.get(file) ?? [];
        const local = (this.exportSites.get(file)?.get(name) ?? []).filter((site) => !this.reexportRanges.has(rangeKey(file, site)));
        const candidates: Traced[] = [];
        if (local.length > 0) {
            candidates.push({result: {status: local.length > 1 ? 'ambiguous' : 'resolved', definitions: [{file, name, evidence: local}], via: []}, cyclic: false});
        }
        for (const reexport of reexports.filter((candidate) => candidate.kind !== 'star' && candidate.exportedAs === name)) {
            candidates.push(this.follow(file, reexport, reexport.kind === 'namespace' ? '*' : reexport.name, path));
        }
        return candidates;
    }

    // `export * from` — never for `default`; a single distinct definition across all stars, else ambiguous.
    private starCandidates(file: string, name: string, path: ReadonlySet<string>): Traced {
        if (name === 'default') {
            return {result: unresolved('export'), cyclic: false};
        }
        const traced = (this.reexportsByFile.get(file) ?? []).filter((reexport) => reexport.kind === 'star').map((reexport) => this.follow(file, reexport, name, path));
        const found = traced.filter((candidate) => isFound(candidate.result));
        const cyclic = traced.some((candidate) => candidate.cyclic);
        return found.length > 0 ? {...combine(found), cyclic} : {result: notFound(traced.map((candidate) => candidate.result)), cyclic};
    }

    // One hop: into the re-exported module, or stop at a package / an unresolvable module.
    private follow(file: string, reexport: Reexport, name: string, path: ReadonlySet<string>): Traced {
        const hop: ReexportHop = {file, specifier: reexport.module, exportedAs: reexport.exportedAs, evidence: reexport.evidence};
        if (reexport.target === null) {
            return {result: reexport.external ? {status: 'external', definitions: [], via: [hop]} : unresolved('module', [hop]), cyclic: false};
        }
        if (name === '*') {
            // `export * as ns from` binds the whole target module.
            return {result: {status: 'resolved', definitions: [{file: reexport.target, name: '*', evidence: [reexport.evidence]}], via: [hop]}, cyclic: false};
        }
        const traced = this.trace(reexport.target, name, path);
        return {result: {...traced.result, via: [hop, ...traced.result.via]}, cyclic: traced.cyclic};
    }
}

// No `export *` provides the name: exactly one of them leads into a package →
// `external` (it can only come from there); a re-export cycle → `cycle`; else
// the name is not exported (`export`).
const notFound = (results: readonly ExportResolution[]): ExportResolution => {
    const external = results.filter((result) => result.status === 'external');
    if (external.length === 1) {
        return external[0] as ExportResolution;
    }
    return unresolved(external.length === 0 && results.some((result) => result.unresolvedReason === 'cycle') ? 'cycle' : 'export');
};

// Several candidates for one name: one → itself; distinct definitions → ambiguous (all kept).
const combine = (candidates: readonly Traced[]): Traced => {
    const cyclic = candidates.some((candidate) => candidate.cyclic);
    if (candidates.length === 1) {
        return candidates[0] as Traced;
    }
    const definitions = new Map<string, SymbolDefinition>();
    candidates.flatMap((candidate) => candidate.result.definitions).forEach((definition) => definitions.set(definitionKey(definition), definition));
    if (definitions.size === 1 && candidates.every((candidate) => candidate.result.status === 'resolved')) {
        return {result: {...(candidates[0] as Traced).result}, cyclic};
    }
    return {result: {status: 'ambiguous', definitions: [...definitions.values()].sort((a, b) => definitionKey(a).localeCompare(definitionKey(b))), via: []}, cyclic};
};

/**
 * Builds the cross-file symbol graph from the fact set and the module graph.
 * Deterministic: the result depends only on the facts and the module graph,
 * never on the order facts arrive in (groups are keyed, evidence deduped and
 * sorted, edges sorted before return).
 */
export const buildSymbolGraph = (facts: readonly Fact[], moduleGraph: ModuleGraph): SymbolGraph => {
    const modules = new ModuleTargets(moduleGraph);
    const resolver = new ExportResolver(facts, modules);

    // Group import-name facts by their full binding identity so repeated import
    // sites of the same binding collapse to one edge (keeping every site).
    const groups = new Map<string, ImportGroup>();
    for (const fact of facts) {
        if (fact.kind !== 'deps.importName') {
            continue;
        }
        const value = fact.value as unknown as ImportNameValue;
        const key = `${fact.subject.file}${SEP}${value.module}${SEP}${value.name}${SEP}${value.kind}`;
        const evidence: ImportEvidence = {factId: fact.id, range: fact.subject.range};
        const existing = groups.get(key);
        if (existing === undefined) {
            groups.set(key, {fromFile: fact.subject.file, specifier: value.module, importedName: value.name, kind: value.kind, importEvidence: [evidence]});
        } else {
            addEvidence(existing.importEvidence, evidence);
        }
    }

    const imports = [...groups.values()].map((group) => resolveGroup(group, modules, resolver));
    for (const edge of imports) {
        edge.importEvidence.sort(compareEvidence);
    }
    return {
        imports: imports.sort(compareEdges),
        resolveExport: (file, name) => resolver.resolve(file, name),
        exportNames: (file) => [...resolver.names(file)].sort()
    };
};

const resolveGroup = (group: ImportGroup, modules: ModuleTargets, resolver: ExportResolver): SymbolEdge => {
    const base = {
        fromFile: group.fromFile,
        specifier: group.specifier,
        importedName: group.importedName,
        kind: group.kind,
        importEvidence: group.importEvidence,
        exportEvidence: [] as ImportEvidence[],
        definitions: [] as SymbolDefinition[],
        via: [] as ReexportHop[]
    };
    const target = modules.target(group.fromFile, group.specifier, false);

    // The module itself did not resolve to a single analyzed file.
    if (target === undefined) {
        return modules.isExternal(group.fromFile, group.specifier, false) ? {...base, toFile: null, status: 'external'} : {...base, toFile: null, status: 'unresolved', unresolvedReason: 'module'};
    }
    if (target === null) {
        return {...base, toFile: null, status: 'ambiguous'};
    }

    // A namespace import binds the whole module: resolved once its target file
    // is known -- there is no single export name to match.
    if (group.kind === 'namespace') {
        return {...base, toFile: target, status: 'resolved'};
    }

    // Named / default (a default export is the name `default` on both sides):
    // the name as exported by `toFile`, re-export chains followed.
    const resolution = resolver.resolve(target, group.importedName);
    const exportEvidence = isFound(resolution) ? [...(resolver.exportSites.get(target)?.get(group.importedName) ?? [])] : [];
    return {
        ...base,
        toFile: target,
        status: resolution.status,
        exportEvidence,
        definitions: resolution.definitions,
        via: resolution.via,
        ...(resolution.unresolvedReason !== undefined ? {unresolvedReason: resolution.unresolvedReason} : {})
    };
};
