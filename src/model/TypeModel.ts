import type {Fact} from '../Types.js';
import {FLUTTER_FRAMEWORK_MEMBERS, flutterAwareIndex} from '../analysis/dart/FlutterCatalog.js';
import {ModuleResolver} from '../analysis/ModuleResolution.js';
import {
    expandMembers,
    type StructDeclKind,
    type StructImportBinding,
    type StructImportBindingsValue,
    type StructMember,
    type StructSupertype,
    type StructTypeDeclValue,
    type StructTypeRef
} from '../analysis/StructFacts.js';
import {EMPTY_PROJECT_CONFIG} from '../config/ProjectConfig.js';
import type {DartLibraryIndex} from './DartLibraryIndex.js';
import {buildModuleGraph, type ModuleGraph} from './ModuleGraph.js';

/**
 * The project type model (Flutter quality track E4). Built after extraction
 * from facts only (`struct.typeDecl`, `struct.importBindings`, `deps.export`,
 * plus the DartLibraryIndex and the ModuleGraph); holds strings, fact ids and
 * the expanded member records — no AST. Lives for one evaluation.
 *
 * A written type name (`prefix`, `name`) in a file resolves to:
 * - `project` — a declaration in the analyzed code (`target` = its key);
 * - `external` — a known non-project origin (Dart: a resolved library URI
 *   such as `package:flutter/src/widgets/framework.dart`; TS: an import from
 *   a module that is not an analyzed file, origin = the module specifier);
 * - `ambiguous` — two or more distinct definite origins (`candidates`);
 * - `unresolved` — none (Dart: opaque imports that may provide it are listed
 *   in `candidates`; TS: globals such as `Error`, barrels, missing exports).
 *
 * Dart resolution is the DartLibraryIndex's (prefixes, `show`/`hide`,
 * `export` barrels, `part`s). TS: a declaration in the same file, else the
 * file's import binding (named incl. alias, default, namespace) → the module
 * via the ModuleGraph → a declaration with the exported name in the target
 * file (a default export by its `deps.export` site). TS re-export barrels are
 * not followed (documented limit).
 *
 * Inherited members follow `extends`, `with` and `on` (not `implements`),
 * transitively and cycle-safe, most-derived first: own members, then the
 * mixins (last applied first), then the superclass; a name already present
 * hides the inherited one. Constructors and static members are not
 * inherited. A catalogued framework base (FLUTTER_FRAMEWORK_MEMBERS)
 * contributes its known members; any other external, ambiguous or unresolved
 * base makes the hierarchy incomplete (`hierarchyComplete: false`) — its
 * members are unknown, never guessed.
 */

export type TypeResolutionStatus = 'project' | 'external' | 'ambiguous' | 'unresolved';

export interface TypeResolution {
    status: TypeResolutionStatus;
    /** The key (`file#name`) of the project declaration when `project`, else null. */
    target: string | null;
    /** The non-project origin when `external`, else null. */
    origin: string | null;
    /** Distinct origins when `ambiguous`; opaque candidates when `unresolved` (Dart), sorted. */
    candidates: string[];
}

export interface ResolvedSupertype extends TypeResolution {
    kind: StructSupertype['kind'];
    prefix: string | null;
    name: string;
}

export interface InheritedMember {
    member: StructMember;
    /** The key of the declaring project type. */
    from: string;
}

export interface FrameworkMember {
    name: string;
    memberKind: 'method' | 'getter' | 'field';
    /** `origin#Type` of the catalogued framework base. */
    from: string;
}

export interface TypeNode {
    /** `file#name`. */
    key: string;
    file: string;
    name: string;
    declKind: StructDeclKind;
    factId: string;
    hasParseError: boolean;
    supertypes: ResolvedSupertype[];
    /** Own members, source order. */
    members: StructMember[];
    /** Members inherited from project supertypes (extends/with/on), most-derived first. */
    inherited: InheritedMember[];
    /** Known members of catalogued framework bases reached through the hierarchy. */
    frameworkMembers: FrameworkMember[];
    /** Every extends/with/on base, transitively, is a project type or a catalogued framework type, and no cycle was met. */
    hierarchyComplete: boolean;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const keyOf = (file: string, name: string): string => `${file}#${name}`;
const UNRESOLVED: TypeResolution = {status: 'unresolved', target: null, origin: null, candidates: []};
const INHERITING: ReadonlySet<StructSupertype['kind']> = new Set(['extends', 'with', 'on']);

interface Declaration {
    fact: Fact;
    value: StructTypeDeclValue;
}

export class TypeModel {
    /** Every declared type, sorted by key. */
    public readonly types: readonly TypeNode[];
    private readonly byKey: Map<string, TypeNode>;
    private readonly declarations = new Map<string, Declaration>();
    private readonly keysByName = new Map<string, string[]>();
    private readonly bindingsByFile = new Map<string, Map<string, StructImportBinding>>();
    private readonly defaultExportLine = new Map<string, number>();
    private readonly moduleTargets = new Map<string, string>();
    private readonly dartIndex: DartLibraryIndex;

    public constructor(facts: readonly Fact[], dartIndex: DartLibraryIndex, moduleGraph: ModuleGraph) {
        this.dartIndex = dartIndex;
        for (const fact of facts) {
            if (fact.kind === 'struct.typeDecl' && fact.subject.symbol !== undefined) {
                const key = keyOf(fact.subject.file, fact.subject.symbol);
                this.declarations.set(key, {fact, value: fact.value as unknown as StructTypeDeclValue});
                this.keysByName.set(fact.subject.symbol, [...(this.keysByName.get(fact.subject.symbol) ?? []), key]);
            } else if (fact.kind === 'struct.importBindings') {
                const value = fact.value as unknown as StructImportBindingsValue;
                this.bindingsByFile.set(fact.subject.file, new Map(value.bindings.map((binding) => [binding.local, binding])));
            } else if (fact.kind === 'deps.export' && fact.value === 'default') {
                this.defaultExportLine.set(fact.subject.file, fact.subject.range.startLine);
            }
        }
        for (const edge of moduleGraph.edges) {
            if (edge.origin === undefined) {
                this.moduleTargets.set(`${edge.from}\n${edge.specifier}`, edge.to);
            }
        }
        const nodes = [...this.declarations.entries()].sort(([a], [b]) => compareText(a, b)).map(([key, declaration]) => this.nodeOf(key, declaration));
        this.byKey = new Map(nodes.map((node) => [node.key, node]));
        for (const node of nodes) {
            this.fillHierarchy(node);
        }
        this.types = nodes;
    }

    /** The type declared as `name` in `file`, if any. */
    public typeAt(file: string, name: string): TypeNode | undefined {
        return this.byKey.get(keyOf(file, name));
    }

    public get(key: string): TypeNode | undefined {
        return this.byKey.get(key);
    }

    /** Resolves a type name as written in `file`. */
    public resolveRef(file: string, ref: StructTypeRef): TypeResolution {
        return file.endsWith('.dart') ? this.resolveDart(file, ref) : this.resolveTs(file, ref);
    }

    private nodeOf(key: string, {fact, value}: Declaration): TypeNode {
        const file = fact.subject.file;
        return {
            key,
            file,
            name: fact.subject.symbol as string,
            declKind: value.declKind,
            factId: fact.id,
            hasParseError: value.hasParseError,
            supertypes: value.supertypes.map((supertype) => ({kind: supertype.kind, prefix: supertype.prefix, name: supertype.name, ...this.resolveRef(file, supertype)})),
            members: expandMembers(value),
            inherited: [],
            frameworkMembers: [],
            hierarchyComplete: true
        };
    }

    private resolveDart(file: string, ref: StructTypeRef): TypeResolution {
        const resolution = this.dartIndex.resolve(file, ref.name, ref.prefix);
        if (resolution.status === 'ambiguous') {
            return {status: 'ambiguous', target: null, origin: null, candidates: resolution.origins};
        }
        if (resolution.status === 'unresolved' || resolution.origin === null) {
            return {status: 'unresolved', target: null, origin: null, candidates: resolution.possible};
        }
        if (!resolution.origin.startsWith('file:')) {
            return {status: 'external', target: null, origin: resolution.origin, candidates: []};
        }
        // The origin is a library; the declaration may sit in one of its parts.
        const library = resolution.origin.slice('file:'.length);
        const matches = (this.keysByName.get(ref.name) ?? []).filter((key) => key.endsWith('.dart#' + ref.name) && this.dartIndex.libraryOf(key.slice(0, -(ref.name.length + 1))) === library);
        return matches.length === 1 ? {status: 'project', target: matches[0] as string, origin: null, candidates: []} : UNRESOLVED;
    }

    private resolveTs(file: string, ref: StructTypeRef): TypeResolution {
        if (ref.prefix === null && this.declarations.has(keyOf(file, ref.name))) {
            return {status: 'project', target: keyOf(file, ref.name), origin: null, candidates: []};
        }
        const binding = this.bindingsByFile.get(file)?.get(ref.prefix ?? ref.name);
        if (binding === undefined || (ref.prefix !== null && binding.kind !== 'namespace') || (ref.prefix === null && binding.kind === 'namespace')) {
            return UNRESOLVED;
        }
        const target = this.moduleTargets.get(`${file}\n${binding.module}`);
        if (target === undefined) {
            // Not an analyzed file: a package import is external; a relative one that did not resolve stays unresolved.
            return binding.module.startsWith('.') || binding.module.startsWith('/') ? UNRESOLVED : {status: 'external', target: null, origin: binding.module, candidates: []};
        }
        const exported = binding.kind === 'namespace' ? ref.name : binding.importedName;
        if (exported === 'default') {
            const line = this.defaultExportLine.get(target);
            const match = [...this.declarations.entries()].find(([key, declaration]) => key.startsWith(`${target}#`) && declaration.fact.subject.range.startLine === line);
            return match === undefined ? UNRESOLVED : {status: 'project', target: match[0], origin: null, candidates: []};
        }
        return this.declarations.has(keyOf(target, exported)) ? {status: 'project', target: keyOf(target, exported), origin: null, candidates: []} : UNRESOLVED;
    }

    // Inherited and framework members, most-derived first (see the module comment).
    private fillHierarchy(node: TypeNode): void {
        const seen = new Set(node.members.filter(isInheritable).map(memberKey));
        const inherited: InheritedMember[] = [];
        const framework: FrameworkMember[] = [];
        const frameworkSeen = new Set<string>();
        let complete = true;
        const visit = (current: TypeNode, path: Set<string>): void => {
            const bases = current.supertypes.filter((supertype) => INHERITING.has(supertype.kind));
            // Mixins last-applied first, then the superclass / `on` constraints.
            const ordered = [...bases.filter((base) => base.kind === 'with').reverse(), ...bases.filter((base) => base.kind !== 'with')];
            for (const base of ordered) {
                if (base.status === 'project' && base.target !== null) {
                    const parent = this.byKey.get(base.target);
                    if (parent === undefined || path.has(parent.key)) {
                        complete = false;
                        continue;
                    }
                    for (const member of parent.members.filter(isInheritable)) {
                        if (!seen.has(memberKey(member))) {
                            seen.add(memberKey(member));
                            inherited.push({member, from: parent.key});
                        }
                    }
                    if (parent.hasParseError) {
                        complete = false;
                    }
                    visit(parent, new Set([...path, parent.key]));
                } else if (base.status === 'external' && base.origin !== null && FLUTTER_FRAMEWORK_MEMBERS[`${base.origin}#${base.name}`] !== undefined) {
                    const from = `${base.origin}#${base.name}`;
                    for (const [name, memberKind] of FLUTTER_FRAMEWORK_MEMBERS[from] ?? []) {
                        if (!frameworkSeen.has(name) && !seen.has(name)) {
                            frameworkSeen.add(name);
                            framework.push({name, memberKind, from});
                        }
                    }
                } else {
                    complete = false;
                }
            }
        };
        visit(node, new Set([node.key]));
        node.inherited = inherited;
        node.frameworkMembers = framework;
        node.hierarchyComplete = complete && !node.hasParseError;
    }
}

const isInheritable = (member: StructMember): boolean => member.memberKind !== 'constructor' && !member.isStatic;
const memberKey = (member: StructMember): string => (member.memberKind === 'setter' ? `${member.name}=` : member.name);

/**
 * Builds the type model. `dartIndex` and `moduleGraph` are the pipeline's;
 * without them (a focused test) an index over `facts` alone (own `package:`
 * URIs opaque) and a relative-only module graph are used.
 */
export const buildTypeModel = (facts: readonly Fact[], analyzedFiles: ReadonlySet<string>, dartIndex?: DartLibraryIndex, moduleGraph?: ModuleGraph): TypeModel => {
    const index = dartIndex ?? flutterAwareIndex(facts);
    return new TypeModel(facts, index, moduleGraph ?? buildModuleGraph(facts, analyzedFiles, new ModuleResolver(EMPTY_PROJECT_CONFIG), index));
};
