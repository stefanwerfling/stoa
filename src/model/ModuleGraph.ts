import type {Fact, SourceRange} from '../Types.js';
import type {ModuleResolver, ResolutionMethod} from '../analysis/ModuleResolution.js';
import type {DartDirectiveValue} from '../analysis/dart/DartDeclarations.js';
import type {DartLibraryIndex} from './DartLibraryIndex.js';
import type {CppIncludeValue} from '../analysis/cpp/CppExtraction.js';
import {isStandardHeader} from '../analysis/cpp/StandardHeaders.js';

/**
 * A reusable, project-wide module dependency graph (Phase 0 of the
 * architecture-evolution work). It is built ONCE per analysis, after fact
 * extraction, from the existing `deps.import` facts plus the config-aware
 * `ModuleResolver` -- it holds only strings and small records (file paths,
 * specifiers, fact ids, ranges), never AST nodes and never a copy of the fact
 * array, so it adds no unbounded memory growth on top of the facts that
 * already exist.
 *
 * The graph records EVERY resolved import edge with its resolution method
 * (`relative`/`alias`/`exports`/`imports`), plus the imports that stayed
 * `unresolved`. In Phase 0 only `relative` value edges feed the existing
 * `DependencyCycleRule` (see `cycleAdjacency`); alias/exports/imports edges are
 * carried for a later phase to consume deliberately, without changing any
 * current finding (decision D1-a).
 *
 * Flutter quality track E2: when a `DartLibraryIndex` is passed, every Dart
 * `import`/`export` directive (`dart.importSpec`) is added too — an edge when
 * the index resolves its URI to an analyzed project file (relative or the
 * project's own `package:` URI), otherwise an unresolved import carrying the
 * URI (`dart:`, third-party packages, excluded/generated files). `part` /
 * `part of` add nothing: they form ONE library, not a dependency. A
 * configurable import contributes its default URI only. Dart entries carry
 * `origin: 'dart.importSpec'` (absent = `deps.import`, so every pre-E2 entry is
 * byte-identical) and are NOT part of `cycleAdjacency`: circular imports are
 * legal and common in Dart, and reporting them is a separate decision.
 *
 * Identity spec, phase 4: a PHP `use` (a `deps.import` fact carrying
 * `useKind`) resolves through the root composer.json's PSR-4 mappings
 * (`ModuleResolver.resolvePhpClass`) to an edge with `resolution: 'psr4'`,
 * part of `cycleAdjacency` — as a TS `import` is, whether the name is used
 * at run time or only in types (PHP has no `import type` to tell them apart).
 */

/**
 * Where an edge/unresolved import came from. Absent = `deps.import`.
 * `deps.reexport` (semantic consolidation, phase 2): a TS re-export
 * (`export … from`) — a module dependency of the barrel, carried for the
 * SymbolGraph's re-export chains; rules that predate it skip these entries.
 */
export type ModuleEdgeOrigin = 'deps.import' | 'dart.importSpec' | 'deps.reexport' | 'cpp.include';

/** How a Dart directive was resolved: a relative URI, or a `package:` URI of the project's own packages. */
export type DartResolutionMethod = 'relative' | 'package';

/** The one piece of provenance every edge/unresolved import keeps: which fact it came from and where. Never the fact itself. */
export interface ImportEvidence {
    factId: string;
    range: SourceRange;
}

export interface ModuleEdge {
    /** Absolute path of the importing module (an analyzed file). */
    from: string;
    /** Absolute path of the resolved target module (an analyzed file). */
    to: string;
    /** The raw import specifier as written in source (e.g. `./b`, `@app/x`). */
    specifier: string;
    /** From the `deps.import` fact: a type-only import (erased at compile time, no runtime dependency). */
    isTypeOnly: boolean;
    /** How `specifier` was resolved to `to` -- always a resolved method here (never `unresolved`). `package` only for Dart edges, `psr4` only for PHP `use` edges, `include-path` only for C/C++ includes found through an include path. */
    resolution: Exclude<ResolutionMethod, 'unresolved'> | 'package' | 'include-path';
    /** Set only for Dart edges (`dart.importSpec`); absent = `deps.import`. */
    origin?: ModuleEdgeOrigin;
    /** Dart edges only: the directive that created the edge. */
    dartDirective?: 'import' | 'export';
    /** C/C++ edges only (`cpp.include`): the include sits in a preprocessor conditional — compiled only in some configurations. */
    conditional?: boolean;
    /** ALL source sites of this one relationship (one per contributing `deps.import` fact), deduplicated by factId and sorted deterministically — so a finding can cite every place the edge occurs, never just the first. */
    evidence: ImportEvidence[];
}

export interface UnresolvedImport {
    from: string;
    specifier: string;
    isTypeOnly: boolean;
    /** ALL source sites of this unresolved import, deduplicated by factId and sorted deterministically. */
    evidence: ImportEvidence[];
    /** Set only for Dart directives (`dart.importSpec`); absent = `deps.import`. */
    origin?: ModuleEdgeOrigin;
    /** Dart only: the directive kind. */
    dartDirective?: 'import' | 'export';
    /**
     * TS entries (`deps.import` / `deps.reexport`): the specifier names a
     * package outside the project (`ModuleResolver.isExternal`) — as opposed
     * to a project reference that failed to resolve (relative, `#`, a tsconfig
     * `paths` match without an analyzed target).
     * PHP `use` entries: the name lies outside every PSR-4 prefix of the
     * project's composer.json (`true`) or under one (`false`); absent when
     * there is no composer.json — unknown, neither project nor package.
     */
    external?: boolean;
}

export interface ModuleGraph {
    /** Every analyzed module, sorted -- including ones with no imports (isolated nodes), so the graph is a complete picture. */
    nodes: readonly string[];
    /** Resolved import edges, sorted deterministically. */
    edges: readonly ModuleEdge[];
    /** Imports that no configured mechanism could map to an analyzed file -- surfaced, never hidden or guessed. */
    unresolved: readonly UnresolvedImport[];
}

interface ImportValue {
    module: string;
    isTypeOnly: boolean;
}

// The trailing origin/directive keys only separate Dart entries from each
// other (a Dart file has no `deps.import` facts), so the order of every
// pre-E2 entry is unchanged.
const compareEdges = (a: ModuleEdge, b: ModuleEdge): number =>
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.specifier.localeCompare(b.specifier) ||
    a.resolution.localeCompare(b.resolution) ||
    (a.dartDirective ?? '').localeCompare(b.dartDirective ?? '') ||
    (a.origin ?? '').localeCompare(b.origin ?? '');

const compareUnresolved = (a: UnresolvedImport, b: UnresolvedImport): number =>
    a.from.localeCompare(b.from) ||
    a.specifier.localeCompare(b.specifier) ||
    (a.dartDirective ?? '').localeCompare(b.dartDirective ?? '') ||
    (a.origin ?? '').localeCompare(b.origin ?? '') ||
    // A PHP class and a function `use` of one name: two entries, ordered by their first site.
    (a.evidence[0]?.factId ?? '').localeCompare(b.evidence[0]?.factId ?? '');

// Deterministic order for the evidence sites of one edge/unresolved import:
// by factId, then by source position — independent of the order facts arrived.
const compareEvidence = (a: ImportEvidence, b: ImportEvidence): number =>
    a.factId.localeCompare(b.factId) || a.range.startLine - b.range.startLine || a.range.startCol - b.range.startCol;

// Appends a source site to an accumulator, deduplicated by factId (the same
// fact can only be one site; distinct facts for the same relationship are the
// extra sites we must NOT lose).
const addEvidence = (sites: ImportEvidence[], evidence: ImportEvidence): void => {
    if (!sites.some((site) => site.factId === evidence.factId)) {
        sites.push(evidence);
    }
};

/**
 * Builds the module graph from `deps.import` facts. Deterministic: the result
 * depends only on the set of facts and the resolver, never on the order facts
 * arrive in (nodes and edges are sorted; edges are de-duplicated by their full
 * identity before sorting). Duplicate identical imports collapse to one edge;
 * two DIFFERENT specifiers reaching the same target stay two distinct edges, so
 * no genuine relationship is lost. `dartIndex` (optional, E2) adds the Dart
 * directives; without it the graph is exactly the pre-E2 graph.
 */
export const buildModuleGraph = (facts: readonly Fact[], analyzedFiles: ReadonlySet<string>, resolver: ModuleResolver, dartIndex?: DartLibraryIndex): ModuleGraph => {
    const edgeByKey = new Map<string, ModuleEdge>();
    const unresolvedByKey = new Map<string, UnresolvedImport>();

    for (const fact of facts) {
        if (fact.kind === 'dart.importSpec' && dartIndex !== undefined) {
            addDartDirective(fact, analyzedFiles, dartIndex, edgeByKey, unresolvedByKey);
            continue;
        }
        if (fact.kind === 'deps.import' && (fact.value as unknown as Partial<PhpUseValue>).useKind !== undefined) {
            addPhpUse(fact, {analyzedFiles, resolver, edgeByKey, unresolvedByKey});
            continue;
        }
        if (fact.kind === 'cpp.include') {
            addCppInclude(fact, {analyzedFiles, resolver, edgeByKey, unresolvedByKey});
            continue;
        }
        if (fact.kind === 'deps.import' || fact.kind === 'deps.reexport') {
            addTsDependency(fact, {analyzedFiles, resolver, edgeByKey, unresolvedByKey});
        }
    }

    const edges = [...edgeByKey.values()];
    for (const edge of edges) {
        edge.evidence.sort(compareEvidence);
    }
    const unresolved = [...unresolvedByKey.values()];
    for (const entry of unresolved) {
        entry.evidence.sort(compareEvidence);
    }

    return {
        nodes: [...analyzedFiles].sort((a, b) => a.localeCompare(b)),
        edges: edges.sort(compareEdges),
        unresolved: unresolved.sort(compareUnresolved)
    };
};

// One TS `deps.import` (or `deps.reexport`) fact → an edge or an unresolved
// import. A `deps.import` entry is exactly the pre-phase-2 entry plus the
// `external` flag on unresolved ones; re-export entries carry their origin
// (also in the key, so an import and a re-export of the same specifier stay
// two entries).
interface TsDependencySink {
    analyzedFiles: ReadonlySet<string>;
    resolver: ModuleResolver;
    edgeByKey: Map<string, ModuleEdge>;
    unresolvedByKey: Map<string, UnresolvedImport>;
}

const addTsDependency = (fact: Fact, {analyzedFiles, resolver, edgeByKey, unresolvedByKey}: TsDependencySink): void => {
    const value = fact.value as unknown as ImportValue;
    const from = fact.subject.file;
    const specifier = value.module;
    const isTypeOnly = value.isTypeOnly === true;
    const evidence: ImportEvidence = {factId: fact.id, range: fact.subject.range};
    const origin = fact.kind === 'deps.reexport' ? ({origin: 'deps.reexport'} as const) : {};
    const originKey = fact.kind === 'deps.reexport' ? ' reexport' : '';

    const resolved = resolver.resolve(from, specifier, analyzedFiles);
    if (resolved.target === null || resolved.resolution === 'unresolved') {
        const key = `${from} ${specifier} ${isTypeOnly}${originKey}`;
        const existing = unresolvedByKey.get(key);
        if (existing === undefined) {
            unresolvedByKey.set(key, {from, specifier, isTypeOnly, evidence: [evidence], ...origin, external: resolver.isExternal(specifier, analyzedFiles)});
        } else {
            addEvidence(existing.evidence, evidence);
        }
        return;
    }
    const key = `${from} ${resolved.target} ${specifier} ${isTypeOnly} ${resolved.resolution}${originKey}`;
    const existing = edgeByKey.get(key);
    if (existing === undefined) {
        edgeByKey.set(key, {from, to: resolved.target, specifier, isTypeOnly, resolution: resolved.resolution, ...origin, evidence: [evidence]});
    } else {
        addEvidence(existing.evidence, evidence);
    }
};

/** A PHP `use` (a `deps.import` fact of the PHP adapter): the imported name and what kind of name it is. */
interface PhpUseValue {
    module: string;
    useKind: 'class' | 'function' | 'const';
}

// One PHP `use` → an edge (PSR-4, `resolution: 'psr4'`) or an unresolved
// import. Only class-like names are looked up: Composer's PSR-4 autoloader
// loads classes, never functions or constants, so those stay unresolved —
// classified by namespace like a class (`resolvePhpClass` with no target).
// `external` is set only when known (see `PhpClassLookup`).
const addPhpUse = (fact: Fact, {analyzedFiles, resolver, edgeByKey, unresolvedByKey}: TsDependencySink): void => {
    const value = fact.value as unknown as PhpUseValue;
    const from = fact.subject.file;
    const specifier = value.module;
    const evidence: ImportEvidence = {factId: fact.id, range: fact.subject.range};
    const lookup = resolver.resolvePhpClass(specifier, analyzedFiles);
    const target = value.useKind === 'class' ? lookup.target : null;
    if (target === null) {
        const key = `php ${from} ${specifier} ${value.useKind}`;
        const existing = unresolvedByKey.get(key);
        if (existing === undefined) {
            unresolvedByKey.set(key, {from, specifier, isTypeOnly: false, evidence: [evidence], ...(lookup.external !== undefined ? {external: lookup.external} : {})});
        } else {
            addEvidence(existing.evidence, evidence);
        }
        return;
    }
    const key = `php ${from} ${target} ${specifier}`;
    const existing = edgeByKey.get(key);
    if (existing === undefined) {
        edgeByKey.set(key, {from, to: target, specifier, isTypeOnly: false, resolution: 'psr4', evidence: [evidence]});
    } else {
        addEvidence(existing.evidence, evidence);
    }
};

// One C/C++ `#include` → an edge or an unresolved import. Resolved as the
// compiler searches (`ModuleResolver.resolveCppInclude`): a quoted include
// next to the including file (`relative`), then through the project's
// include paths — compilation database, `cpp.includePaths` —
// (`include-path`). Without include paths a quoted include not found next to
// the file stays unresolved (`external` unknown). An unresolved `<…>`
// include is external when it names a standard library header, otherwise
// unknown; an include of a macro (`#include NAME`) is never resolved.
const addCppInclude = (fact: Fact, {analyzedFiles, resolver, edgeByKey, unresolvedByKey}: TsDependencySink): void => {
    const value = fact.value as unknown as CppIncludeValue;
    const from = fact.subject.file;
    const specifier = value.module;
    const evidence: ImportEvidence = {factId: fact.id, range: fact.subject.range};
    const found = resolver.resolveCppInclude(from, value, analyzedFiles);
    if (found === null) {
        const key = `cpp ${from} ${specifier} ${value.form}`;
        const existing = unresolvedByKey.get(key);
        if (existing === undefined) {
            const external = value.form === 'system' && isStandardHeader(specifier) ? {external: true} : {};
            unresolvedByKey.set(key, {from, specifier, isTypeOnly: false, evidence: [evidence], origin: 'cpp.include', ...external});
        } else {
            addEvidence(existing.evidence, evidence);
        }
        return;
    }
    const key = `cpp ${from} ${found.target} ${specifier} ${value.conditional}`;
    const existing = edgeByKey.get(key);
    if (existing === undefined) {
        edgeByKey.set(key, {from, to: found.target, specifier, isTypeOnly: false, resolution: found.resolution, origin: 'cpp.include', conditional: value.conditional, evidence: [evidence]});
    } else {
        addEvidence(existing.evidence, evidence);
    }
};

// One Dart `import`/`export` directive → an edge or an unresolved import.
const addDartDirective = (
    fact: Fact,
    analyzedFiles: ReadonlySet<string>,
    dartIndex: DartLibraryIndex,
    edgeByKey: Map<string, ModuleEdge>,
    unresolvedByKey: Map<string, UnresolvedImport>
): void => {
    const directive = fact.value as unknown as DartDirectiveValue;
    if ((directive.kind !== 'import' && directive.kind !== 'export') || directive.uri === null) {
        return;
    }
    const from = fact.subject.file;
    const specifier = directive.uri;
    const dartDirective = directive.kind;
    const evidence: ImportEvidence = {factId: fact.id, range: fact.subject.range};
    const target = dartIndex.resolveUri(from, specifier);
    if (target === null || !analyzedFiles.has(target)) {
        const key = `dart ${from} ${specifier} ${dartDirective}`;
        const existing = unresolvedByKey.get(key);
        if (existing === undefined) {
            unresolvedByKey.set(key, {from, specifier, isTypeOnly: false, evidence: [evidence], origin: 'dart.importSpec', dartDirective});
        } else {
            addEvidence(existing.evidence, evidence);
        }
        return;
    }
    const resolution: DartResolutionMethod = specifier.startsWith('package:') ? 'package' : 'relative';
    const key = `dart ${from} ${target} ${specifier} ${dartDirective}`;
    const existing = edgeByKey.get(key);
    if (existing === undefined) {
        edgeByKey.set(key, {from, to: target, specifier, isTypeOnly: false, resolution, origin: 'dart.importSpec', dartDirective, evidence: [evidence]});
    } else {
        addEvidence(existing.evidence, evidence);
    }
};

/**
 * The Phase-0 view the existing `DependencyCycleRule` consumes: a plain
 * adjacency map seeded with EVERY node (so isolated files are present, exactly
 * as the rule's own former graph was), containing only `relative`, NON-type-only
 * edges, with self-edges excluded. This encodes decision D1-a in one place -- it
 * reproduces precisely the edge set the rule computed before (relative-resolved,
 * type-only skipped, self-import ignored), so cycle findings are byte-identical.
 * Dart edges (E2, `origin: 'dart.importSpec'`) are excluded: Dart cycles are
 * not reported (see the module comment).
 *
 * Identity spec, phase 4: C/C++ include edges (`origin: 'cpp.include'`,
 * next to the file or through an include path) are included unless conditional — a header that includes, directly or through
 * others, the file including it is a cycle in what the compiler reads,
 * whatever the include guards make of it. A conditional include exists only
 * in some configurations and is left out. PHP `use` edges (`psr4`) are
 * included (see the module comment).
 */
export const cycleAdjacency = (graph: ModuleGraph): Map<string, Set<string>> => {
    const adjacency = new Map<string, Set<string>>();
    for (const node of graph.nodes) {
        adjacency.set(node, new Set<string>());
    }
    for (const edge of graph.edges) {
        const cppInclude = edge.origin === 'cpp.include' && edge.conditional !== true;
        const resolved = edge.resolution === 'relative' || (edge.resolution === 'psr4' && edge.origin === undefined) || (edge.resolution === 'include-path' && cppInclude);
        if ((edge.origin !== undefined && !cppInclude) || !resolved || edge.isTypeOnly || edge.from === edge.to) {
            continue;
        }
        adjacency.get(edge.from)?.add(edge.to);
    }
    return adjacency;
};
