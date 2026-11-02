import type {Fact} from '../Types.js';
import type {ImportEvidence, ModuleGraph} from './ModuleGraph.js';

/**
 * A reusable, project-wide cross-file SYMBOL graph (Phase 1, step 1). It binds
 * each imported name to the export definition it refers to in another analyzed
 * file -- built ONCE per analysis, purely from existing facts
 * (`deps.importName` for import sites, `deps.export` for export definitions)
 * plus the already-resolved `ModuleGraph` edges. It performs NO AST analysis,
 * holds NO copy of the fact array (only file paths, names, fact ids and
 * ranges), and never guesses: a binding that cannot be shown unambiguously is
 * `unresolved` or `ambiguous`, never a fabricated identity.
 *
 * Deliberate scope limits for this step (see Phase-1 plan, decisions E2/E3):
 * - NO re-export / `export *` resolution. A re-exported name is only a
 *   `deps.export` on the barrel file with no recorded source module, and
 *   `export *` emits no fact at all -- so such a name simply is (or is not)
 *   present on the resolved target file by its own `deps.export` facts; this
 *   graph never follows a re-export chain.
 * - NO assumptions about external modules: an import whose module did not
 *   resolve to an analyzed file is `unresolved`.
 * - A namespace import (`import * as ns`) binds the whole module, not a single
 *   export, so it is `resolved` exactly when its target file resolved -- there
 *   is no per-name export to match.
 */

export type SymbolResolutionStatus = 'resolved' | 'unresolved' | 'ambiguous';

export interface SymbolEdge {
    /** Absolute path of the importing module (an analyzed file). */
    fromFile: string;
    /** The raw module specifier of the import (e.g. `./b`, `@app/x`). */
    specifier: string;
    /** The name as EXPORTED by the target (not the local alias): a named import's imported name, `default` for a default import, `*` for a namespace import -- exactly the `deps.importName` convention. */
    importedName: string;
    kind: 'named' | 'default' | 'namespace';
    /** The resolved export-defining file, or null when `status` is not `resolved`. */
    toFile: string | null;
    status: SymbolResolutionStatus;
    /** All import sites of this binding (one per contributing `deps.importName` fact), deduped by factId, sorted deterministically. */
    importEvidence: ImportEvidence[];
    /** The export-definition site(s) on `toFile` for a resolved named/default binding. Empty for namespace bindings (whole-module) and for non-resolved statuses. */
    exportEvidence: ImportEvidence[];
}

export interface SymbolGraph {
    /** Cross-file symbol bindings, sorted deterministically. */
    imports: readonly SymbolEdge[];
}

interface ImportNameValue {
    module: string;
    name: string;
    kind: 'named' | 'default' | 'namespace';
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

interface ImportGroup {
    fromFile: string;
    specifier: string;
    importedName: string;
    kind: 'named' | 'default' | 'namespace';
    importEvidence: ImportEvidence[];
}

/**
 * Builds the cross-file symbol graph from the fact set and the module graph.
 * Deterministic: the result depends only on the facts and the module graph,
 * never on the order facts arrive in (groups are keyed, evidence deduped and
 * sorted, edges sorted before return).
 */
export const buildSymbolGraph = (facts: readonly Fact[], moduleGraph: ModuleGraph): SymbolGraph => {
    // Export index: file -> exported name -> all its export-definition sites.
    const exportsByFile = new Map<string, Map<string, ImportEvidence[]>>();
    for (const fact of facts) {
        if (fact.kind !== 'deps.export') {
            continue;
        }
        const name = String(fact.value);
        let byName = exportsByFile.get(fact.subject.file);
        if (byName === undefined) {
            byName = new Map<string, ImportEvidence[]>();
            exportsByFile.set(fact.subject.file, byName);
        }
        const sites = byName.get(name) ?? [];
        addEvidence(sites, {factId: fact.id, range: fact.subject.range});
        byName.set(name, sites);
    }

    // Target index from the module graph: (fromFile, specifier) -> resolved
    // target file. A pair that maps to more than one distinct target (not
    // expected, since resolution is deterministic) is recorded as ambiguous
    // (null) rather than silently picking one.
    const targetByPair = new Map<string, string | null>();
    for (const edge of moduleGraph.edges) {
        const key = `${edge.from}${SEP}${edge.specifier}`;
        if (!targetByPair.has(key)) {
            targetByPair.set(key, edge.to);
        } else if (targetByPair.get(key) !== edge.to) {
            targetByPair.set(key, null);
        }
    }

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

    const imports: SymbolEdge[] = [];
    for (const group of groups.values()) {
        imports.push(resolveGroup(group, targetByPair, exportsByFile));
    }
    for (const edge of imports) {
        edge.importEvidence.sort(compareEvidence);
        edge.exportEvidence.sort(compareEvidence);
    }
    return {imports: imports.sort(compareEdges)};
};

const resolveGroup = (group: ImportGroup, targetByPair: Map<string, string | null>, exportsByFile: Map<string, Map<string, ImportEvidence[]>>): SymbolEdge => {
    const base = {
        fromFile: group.fromFile,
        specifier: group.specifier,
        importedName: group.importedName,
        kind: group.kind,
        importEvidence: group.importEvidence,
        exportEvidence: [] as ImportEvidence[]
    };
    const pairKey = `${group.fromFile}${SEP}${group.specifier}`;

    // The module itself did not resolve to a single analyzed file.
    if (!targetByPair.has(pairKey)) {
        return {...base, toFile: null, status: 'unresolved'};
    }
    const toFile = targetByPair.get(pairKey) ?? null;
    if (toFile === null) {
        return {...base, toFile: null, status: 'ambiguous'};
    }

    // A namespace import binds the whole module: resolved once its target file
    // is known -- there is no single export name to match.
    if (group.kind === 'namespace') {
        return {...base, toFile, status: 'resolved'};
    }

    // Named / default: the target file must declare this exact export name
    // (same convention on both sides: a default export is the name `default`).
    const sites = exportsByFile.get(toFile)?.get(group.importedName);
    if (sites === undefined || sites.length === 0) {
        // Target resolved, but the export name is not present by this file's
        // OWN export facts. Conservative and honest: unresolved (this step does
        // NOT follow re-export chains, so a barrel-provided name is not proven).
        return {...base, toFile: null, status: 'unresolved'};
    }
    if (sites.length > 1) {
        return {...base, toFile, status: 'ambiguous', exportEvidence: [...sites]};
    }
    return {...base, toFile, status: 'resolved', exportEvidence: [...sites]};
};
