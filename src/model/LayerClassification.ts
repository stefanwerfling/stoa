import type {Fact, SourceRange} from '../Types.js';
import type {DartDirectiveValue, DartTypeDeclValue, DartTypeRef} from '../analysis/dart/DartDeclarations.js';
import {DATA_ACCESS_CATALOG_VERSION, STATE_HOLDER_BASES, STATE_HOLDER_CATALOG_VERSION, dataAccessOf} from '../analysis/dart/DataAccessCatalog.js';
import type {DartLibraryIndex} from './DartLibraryIndex.js';

/**
 * Layer classification without a configuration (Flutter quality track E5a,
 * stage 1 of the DIP layer rule). Built from facts and the DartLibraryIndex
 * only — strings and fact ids, no AST — and Dart only:
 *
 * - **UI:** a class whose superclass resolves (DartLibraryIndex) to
 *   `StatelessWidget`, `StatefulWidget` or `State` from
 *   `package:flutter/src/widgets/framework.dart` — directly, or through a
 *   chain of PROJECT classes (`class Base extends StatelessWidget`,
 *   `class Page extends Base`), cycle-safe. A superclass that is ambiguous,
 *   unresolved or from another package (`GetView`, `ConsumerWidget`, …) never
 *   makes a class UI.
 * - **Data access:** the module imports a package of the static
 *   `DATA_ACCESS_PACKAGES` catalog itself, or `dart:io` with a `show` of
 *   file/socket/HTTP/process names. One level only, never transitive.
 *   `dart:io` without `show` is recorded as `undecided` and does not count.
 * - **State holder** (E6a, user decision): a class whose superclass or a
 *   mixin is a `STATE_HOLDER_BASES` name (`ChangeNotifier`, `GetxController`,
 *   `Cubit`, …) that is not a project declaration and that one of the
 *   library's imports with the same prefix may provide from the catalogued
 *   package. Direct only (no project chain). Used to EXCLUDE a module as a
 *   data-access target, never to report one.
 *
 * Roles belong to a LIBRARY (a file plus its `part`s share one import scope),
 * so every file of a library carries the library's roles; the evidence lists
 * (`ui`, `dataAccess`, `undecided`) stay with the file they are written in.
 * A module with no role is unknown — no rule may treat it as either layer.
 *
 * Not modelled (documented limits): TS/JSX/Angular/Vue components, UI base
 * classes of other packages, data access via a project wrapper package.
 */

export type ModuleRole = 'ui' | 'data-access' | 'state-holder';
export type UiBase = 'StatelessWidget' | 'StatefulWidget' | 'State';

export interface UiDeclaration {
    name: string;
    factId: string;
    range: SourceRange;
    /** The Flutter base class reached. */
    base: UiBase;
    /** The project classes between the class and the Flutter base, nearest first (empty = extends it directly). */
    chain: string[];
}

export interface StateHolderDeclaration {
    name: string;
    factId: string;
    range: SourceRange;
    /** The state base and the import URI that provides it, e.g. `ChangeNotifier (package:flutter/foundation.dart)`. */
    base: string;
}

export interface DataAccessImport {
    /** Catalog package name, or `dart:io`. */
    package: string;
    uri: string;
    factId: string;
    range: SourceRange;
}

export interface ModuleClassification {
    file: string;
    /** The library the file belongs to (the file itself unless it is a `part`). */
    library: string;
    /** Roles of the library, sorted; empty = unknown. */
    roles: ModuleRole[];
    ui: UiDeclaration[];
    dataAccess: DataAccessImport[];
    /** `dart:io` imports without `show`: possibly I/O, not counted. */
    undecided: DataAccessImport[];
    /** Classes extending/mixing in a catalogued state-management base. */
    stateHolders: StateHolderDeclaration[];
}

export interface LayerClassification {
    catalogVersion: string;
    stateHolderCatalogVersion: string;
    /** Every analyzed Dart file, sorted by path. */
    modules: ModuleClassification[];
}

const FRAMEWORK = 'package:flutter/src/widgets/framework.dart';
const UI_BASES: ReadonlySet<string> = new Set<UiBase>(['StatelessWidget', 'StatefulWidget', 'State']);

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const compareSite = (a: {range: SourceRange; factId: string}, b: {range: SourceRange; factId: string}): number =>
    a.range.startLine - b.range.startLine || a.range.startCol - b.range.startCol || compareText(a.factId, b.factId);

interface ClassDecl {
    fact: Fact;
    value: DartTypeDeclValue;
}

export const buildLayerClassification = (facts: readonly Fact[], index: DartLibraryIndex): LayerClassification => {
    const files = new Set<string>();
    const classes: ClassDecl[] = [];
    // library + name → declarations (more than one = ambiguous, never followed)
    const byLibraryName = new Map<string, ClassDecl[]>();
    const imports: {fact: Fact; directive: DartDirectiveValue}[] = [];
    for (const fact of facts) {
        if (!fact.subject.file.endsWith('.dart')) {
            continue;
        }
        files.add(fact.subject.file);
        if (fact.kind === 'dart.classDecl') {
            const value = fact.value as unknown as DartTypeDeclValue;
            if (value.declKind !== 'class') {
                continue;
            }
            const decl = {fact, value};
            classes.push(decl);
            const key = `${index.libraryOf(fact.subject.file)}\n${value.name}`;
            byLibraryName.set(key, [...(byLibraryName.get(key) ?? []), decl]);
        } else if (fact.kind === 'dart.importSpec') {
            imports.push({fact, directive: fact.value as unknown as DartDirectiveValue});
        }
    }

    // The Flutter base a class reaches through its superclass chain, or null.
    const memo = new Map<ClassDecl, {base: UiBase; chain: string[]} | null>();
    const uiBaseOf = (decl: ClassDecl, visiting: Set<ClassDecl>): {base: UiBase; chain: string[]} | null => {
        if (memo.has(decl)) {
            return memo.get(decl) ?? null;
        }
        const superclass = decl.value.superclass;
        if (superclass === null || visiting.has(decl)) {
            return null;
        }
        visiting.add(decl);
        let result: {base: UiBase; chain: string[]} | null = null;
        const resolution = index.resolve(decl.fact.subject.file, superclass.name, superclass.prefix);
        if (resolution.status === 'resolved' && resolution.origin !== null) {
            if (resolution.origin === FRAMEWORK && UI_BASES.has(superclass.name)) {
                result = {base: superclass.name as UiBase, chain: []};
            } else if (resolution.origin.startsWith('file:')) {
                const candidates = byLibraryName.get(`${resolution.origin.slice('file:'.length)}\n${superclass.name}`) ?? [];
                const parent = candidates.length === 1 ? candidates[0] : undefined;
                const inherited = parent === undefined ? null : uiBaseOf(parent, visiting);
                result = inherited === null ? null : {base: inherited.base, chain: [superclass.name, ...inherited.chain]};
            }
        }
        visiting.delete(decl);
        memo.set(decl, result);
        return result;
    };

    // A catalogued state base that is not a project declaration and that an
    // import with the same prefix may provide from its catalogued package.
    const stateBaseOf = (file: string, ref: DartTypeRef): string | null => {
        const packages = STATE_HOLDER_BASES.get(ref.name);
        if (packages === undefined) {
            return null;
        }
        const resolution = index.resolve(file, ref.name, ref.prefix);
        if (resolution.via === 'local' || resolution.origins.some((origin) => origin.startsWith('file:'))) {
            return null;
        }
        const source = [...resolution.origins, ...resolution.possible].find((uri) => packages.some((prefix) => uri.startsWith(prefix)));
        return source === undefined ? null : `${ref.name} (${source})`;
    };

    const modules = new Map<string, ModuleClassification>();
    for (const file of [...files].sort(compareText)) {
        modules.set(file, {file, library: index.libraryOf(file), roles: [], ui: [], dataAccess: [], undecided: [], stateHolders: []});
    }
    for (const decl of classes) {
        const ui = uiBaseOf(decl, new Set());
        if (ui !== null) {
            modules.get(decl.fact.subject.file)?.ui.push({name: decl.value.name, factId: decl.fact.id, range: decl.fact.subject.range, base: ui.base, chain: ui.chain});
        }
        const bases = [decl.value.superclass, ...decl.value.mixins].filter((ref): ref is DartTypeRef => ref !== null);
        const stateBase = bases.map((ref) => stateBaseOf(decl.fact.subject.file, ref)).find((base) => base !== null);
        if (stateBase !== undefined && stateBase !== null) {
            modules.get(decl.fact.subject.file)?.stateHolders.push({name: decl.value.name, factId: decl.fact.id, range: decl.fact.subject.range, base: stateBase});
        }
    }
    for (const {fact, directive} of imports) {
        const verdict = dataAccessOf(directive);
        const module = modules.get(fact.subject.file);
        if (verdict === null || module === undefined || directive.uri === null) {
            continue;
        }
        const entry: DataAccessImport = {package: verdict.package, uri: directive.uri, factId: fact.id, range: fact.subject.range};
        (verdict.status === 'data-access' ? module.dataAccess : module.undecided).push(entry);
    }

    // Library-wide roles.
    const libraryRoles = new Map<string, Set<ModuleRole>>();
    for (const module of modules.values()) {
        const roles = libraryRoles.get(module.library) ?? new Set<ModuleRole>();
        if (module.ui.length > 0) {
            roles.add('ui');
        }
        if (module.dataAccess.length > 0) {
            roles.add('data-access');
        }
        if (module.stateHolders.length > 0) {
            roles.add('state-holder');
        }
        libraryRoles.set(module.library, roles);
    }
    for (const module of modules.values()) {
        module.roles = [...(libraryRoles.get(module.library) ?? [])].sort(compareText);
        module.ui.sort(compareSite);
        module.dataAccess.sort(compareSite);
        module.undecided.sort(compareSite);
        module.stateHolders.sort(compareSite);
    }
    return {catalogVersion: DATA_ACCESS_CATALOG_VERSION, stateHolderCatalogVersion: STATE_HOLDER_CATALOG_VERSION, modules: [...modules.values()]};
};

/** The classification of one file, or undefined when it is not an analyzed Dart file. */
const fileIndex = new WeakMap<LayerClassification, Map<string, ModuleClassification>>();

export const classificationOf = (classification: LayerClassification, file: string): ModuleClassification | undefined => {
    let byFile = fileIndex.get(classification);
    if (byFile === undefined) {
        byFile = new Map(classification.modules.map((module) => [module.file, module]));
        fileIndex.set(classification, byFile);
    }
    return byFile.get(file);
};
