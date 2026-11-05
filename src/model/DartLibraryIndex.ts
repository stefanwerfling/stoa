import {dirname, join, normalize} from 'node:path';
import type {Fact} from '../Types.js';
import type {DartDirectiveValue, DartTypeDeclValue} from '../analysis/dart/DartDeclarations.js';
import type {DartPackageMap} from '../analysis/dart/DartPackages.js';

/**
 * Cross-file Dart name resolution (Flutter quality track, Phase B): which
 * declaration does `prefix.Name` in a given file refer to? Built once per
 * analysis from facts alone (`dart.importSpec`, `dart.classDecl`) plus the
 * project's package map (pubspec names). Dart-generic: knowledge about
 * external libraries (Flutter, `dart:async`) comes in through an
 * `ExternalLibraries` lookup, so this module knows nothing about Flutter.
 *
 * Deliberately separate from the SymbolGraph: Dart's library model (implicit
 * export of every public top-level name, `show`/`hide`, `export` barrels,
 * `part`/`part of`, `package:` URIs) is not the ES-module import/export model
 * the SymbolGraph is built on.
 *
 * Resolution of a name used in a file (in its LIBRARY: a `part` file uses the
 * imports and declarations of the library that owns it):
 * 1. declared in the library (any of its parts), unprefixed → `resolved`,
 *    origin = that library (a local declaration shadows every import);
 * 2. otherwise every import with the same prefix whose `show`/`hide` permit
 *    the name is asked: a project library answers from its export namespace
 *    (own declarations + `export` directives, transitively, cycle-safe); an
 *    external library answers via `ExternalLibraries` — a known ORIGIN, known
 *    ABSENT, or UNKNOWN (opaque);
 * 3. exactly one distinct definite origin → `resolved` (opaque imports may
 *    still be listed in `possible`: in code that compiles they cannot provide
 *    a DIFFERENT declaration of the same name — that is a Dart
 *    `ambiguous_import` error — so they do not make it ambiguous); two or more
 *    distinct origins → `ambiguous`; none → `unresolved`.
 * The same declaration reached through two paths (material.dart and a project
 * barrel re-exporting it) has ONE origin and is not ambiguous.
 *
 * Not modelled (documented limits): the implicit `dart:core` import, extension
 * and typedef/function declarations (only class/mixin/enum names are facts),
 * conditional imports beyond their default URI, other packages' sources.
 */

export type DartResolutionStatus = 'resolved' | 'ambiguous' | 'unresolved';

export interface DartNameResolution {
    status: DartResolutionStatus;
    /** The declaring library when `resolved`: `file:<path>` for project code, a library URI for external code; else null. */
    origin: string | null;
    /** All distinct definite origins, sorted (two or more when `ambiguous`). */
    origins: string[];
    /** Import URIs that may provide the name but cannot be inspected (opaque), sorted. */
    possible: string[];
    via: 'local' | 'import' | null;
}

/** What an external library knows about one of its names. */
export type ExternalAnswer = {origin: string} | 'absent' | 'unknown';
export type ExternalLibraries = (uri: string, name: string) => ExternalAnswer;

export const NO_EXTERNAL_KNOWLEDGE: ExternalLibraries = () => 'unknown';

/** True only for a `resolved` name whose declaring library starts with `source` (e.g. `package:flutter/`, `dart:async`). */
export const resolvedFrom = (resolution: DartNameResolution | null | undefined, source: string): boolean =>
    resolution !== null && resolution !== undefined && resolution.status === 'resolved' && resolution.origin !== null && resolution.origin.startsWith(source);

interface FileInfo {
    directives: DartDirectiveValue[];
    declared: Set<string>;
}

interface Answer {
    definite: Set<string>;
    possible: Set<string>;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const permits = (directive: DartDirectiveValue, name: string): boolean =>
    (directive.show.length === 0 || directive.show.includes(name)) && !directive.hide.includes(name);

export class DartLibraryIndex {
    private readonly files = new Map<string, FileInfo>();
    private readonly ownerOf = new Map<string, string>();
    private readonly exportCache = new Map<string, Answer>();
    // Both pure over the index, which never changes after construction:
    // every name lookup walks a library's directives and resolved each URI
    // (path join/normalize) and re-collected its declarations anew.
    private readonly uriCache = new Map<string, string | null>();
    private readonly declaredCache = new Map<string, ReadonlySet<string>>();

    public constructor(
        facts: readonly Fact[],
        private readonly packages: DartPackageMap,
        private readonly external: ExternalLibraries
    ) {
        for (const fact of facts) {
            // Every analyzed .dart file is a member (any fact kind), so a
            // file without directives/classes is still a resolvable target.
            const file = fact.subject.file;
            if (!file.endsWith('.dart')) {
                continue;
            }
            const info = this.files.get(file) ?? {directives: [], declared: new Set<string>()};
            if (fact.kind === 'dart.importSpec') {
                info.directives.push(fact.value as unknown as DartDirectiveValue);
            } else if (fact.kind === 'dart.classDecl') {
                info.declared.add((fact.value as unknown as DartTypeDeclValue).name);
            }
            this.files.set(file, info);
        }
        // Part ownership: a library's `part 'x.dart'` claims x; a `part of 'lib.dart'` names its owner.
        for (const [file, info] of [...this.files].sort(([a], [b]) => compareText(a, b))) {
            for (const directive of info.directives) {
                if (directive.kind === 'part' && directive.uri !== null) {
                    const part = this.resolveUri(file, directive.uri);
                    if (part !== null && !this.ownerOf.has(part)) {
                        this.ownerOf.set(part, file);
                    }
                }
            }
        }
        for (const [file, info] of this.files) {
            const partOf = info.directives.find((directive) => directive.kind === 'part-of' && directive.uri !== null);
            if (partOf?.uri !== undefined && partOf.uri !== null && !this.ownerOf.has(file)) {
                const owner = this.resolveUri(file, partOf.uri);
                if (owner !== null) {
                    this.ownerOf.set(file, owner);
                }
            }
        }
    }

    /** Resolves `prefix.name` as used in `file`. */
    public resolve(file: string, name: string, prefix: string | null): DartNameResolution {
        const library = this.libraryOf(file);
        if (prefix === null && this.declaredIn(library).has(name)) {
            const origin = `file:${library}`;
            return {status: 'resolved', origin, origins: [origin], possible: [], via: 'local'};
        }
        const definite = new Set<string>();
        const possible = new Set<string>();
        for (const directive of this.files.get(library)?.directives ?? []) {
            if (directive.kind !== 'import' || directive.uri === null || directive.prefix !== prefix || !permits(directive, name)) {
                continue;
            }
            const answer = this.ask(library, directive.uri, name, new Set());
            answer.definite.forEach((origin) => definite.add(origin));
            answer.possible.forEach((uri) => possible.add(uri));
        }
        const origins = [...definite].sort(compareText);
        const status: DartResolutionStatus = origins.length === 1 ? 'resolved' : origins.length > 1 ? 'ambiguous' : 'unresolved';
        return {status, origin: status === 'resolved' ? (origins[0] as string) : null, origins, possible: [...possible].sort(compareText), via: origins.length > 0 ? 'import' : null};
    }

    /** What the library `file` exports under `name` (its export namespace), with sorted origins and opaque URIs. */
    public exportsOf(file: string, name: string): {origins: string[]; possible: string[]} {
        const answer = this.exported(this.libraryOf(file), name, new Set());
        return {origins: [...answer.definite].sort(compareText), possible: [...answer.possible].sort(compareText)};
    }

    /** The project file a Dart URI refers to from `from`, or null (external, or not in the analyzed set). */
    public resolveUri(from: string, uri: string): string | null {
        const key = `${dirname(from)}\n${uri}`;
        const cached = this.uriCache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const resolved = this.resolveUriUncached(from, uri);
        this.uriCache.set(key, resolved);
        return resolved;
    }

    private resolveUriUncached(from: string, uri: string): string | null {
        if (uri.startsWith('dart:')) {
            return null;
        }
        let target: string | null = null;
        if (uri.startsWith('package:')) {
            const rest = uri.slice('package:'.length);
            const slash = rest.indexOf('/');
            const libDir = slash < 0 ? undefined : this.packages.get(rest.slice(0, slash));
            target = libDir === undefined ? null : join(libDir, rest.slice(slash + 1));
        } else if (!/^[a-z][a-z0-9+.-]*:/i.test(uri)) {
            target = normalize(join(dirname(from), uri));
        }
        return target !== null && this.files.has(target) ? target : null;
    }

    /** The library a file belongs to: the owner of a `part`, else the file itself. */
    public libraryOf(file: string): string {
        return this.ownerOf.get(file) ?? file;
    }

    // Declarations of a library: its own file plus every part it owns.
    private declaredIn(library: string): ReadonlySet<string> {
        const cached = this.declaredCache.get(library);
        if (cached !== undefined) {
            return cached;
        }
        const names = new Set(this.files.get(library)?.declared ?? []);
        for (const [part, owner] of this.ownerOf) {
            if (owner === library) {
                this.files.get(part)?.declared.forEach((name) => names.add(name));
            }
        }
        this.declaredCache.set(library, names);
        return names;
    }

    // One import/export target asked for `name`.
    private ask(from: string, uri: string, name: string, visiting: Set<string>): Answer {
        const target = this.resolveUri(from, uri);
        if (target !== null) {
            return this.exported(this.libraryOf(target), name, visiting);
        }
        if (!uri.startsWith('dart:') && !uri.startsWith('package:') && /^[a-z][a-z0-9+.-]*:/i.test(uri)) {
            return {definite: new Set(), possible: new Set([uri])};
        }
        if (this.isOwnPackageUri(uri) || (!uri.startsWith('dart:') && !uri.startsWith('package:'))) {
            // A project file that is not in the analyzed set (excluded, generated): opaque.
            return {definite: new Set(), possible: new Set([uri])};
        }
        const answer = this.external(uri, name);
        if (answer === 'absent') {
            return {definite: new Set(), possible: new Set()};
        }
        if (answer === 'unknown') {
            return {definite: new Set(), possible: new Set([uri])};
        }
        return {definite: new Set([answer.origin]), possible: new Set()};
    }

    // The export namespace of a project library for one name: own
    // declarations, then every `export` permitting it (transitively).
    private exported(library: string, name: string, visiting: Set<string>): Answer {
        if (name.startsWith('_')) {
            return {definite: new Set(), possible: new Set()};
        }
        const key = `${library}\n${name}`;
        const cached = this.exportCache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        if (visiting.has(library)) {
            return {definite: new Set(), possible: new Set()};
        }
        visiting.add(library);
        const definite = new Set<string>();
        const possible = new Set<string>();
        if (this.declaredIn(library).has(name)) {
            definite.add(`file:${library}`);
        }
        for (const directive of this.files.get(library)?.directives ?? []) {
            if (directive.kind !== 'export' || directive.uri === null || !permits(directive, name)) {
                continue;
            }
            const answer = this.ask(library, directive.uri, name, visiting);
            answer.definite.forEach((origin) => definite.add(origin));
            answer.possible.forEach((uri) => possible.add(uri));
        }
        visiting.delete(library);
        const answer = {definite, possible};
        this.exportCache.set(key, answer);
        return answer;
    }

    private isOwnPackageUri(uri: string): boolean {
        if (!uri.startsWith('package:')) {
            return false;
        }
        const rest = uri.slice('package:'.length);
        return this.packages.has(rest.slice(0, rest.indexOf('/')));
    }
}
