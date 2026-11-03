import type {DartDirectiveValue} from './DartDeclarations.js';

/**
 * What a widget name refers to, decided per file from `dart.classDecl` +
 * `dart.importSpec` facts — never from the name alone:
 * - `verified` / `local`: a class/mixin/enum of that name is declared in the
 *   same file (Dart: a local declaration shadows every import).
 * - `heuristic` / `import`: the name is not declared locally but at least one
 *   import could provide it (prefix matches, show/hide permit it);
 *   `candidates` lists those import URIs. Which one actually exports it is not
 *   resolved here (no cross-file library index yet), so a Flutter class is
 *   never `verified`.
 * - `unresolved`: no local declaration and no import that could provide it
 *   (e.g. an undeclared prefix, a `show` list excluding it, a `part` file).
 */
export interface WidgetIdentity {
    status: 'verified' | 'heuristic' | 'unresolved';
    source: 'local' | 'import' | null;
    candidates: string[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Grades what `prefix.name` refers to in one file, from that file's
 * `dart.classDecl` names and `dart.importSpec` directives (or, at extraction
 * time, the same values computed from the file's own tree) — see WidgetIdentity.
 * Exported for rules that grade non-widget names (`State`, `Theme`, `Timer`)
 * the same way.
 */
export const identityOf = (name: string, prefix: string | null, declared: ReadonlySet<string> | undefined, directives: readonly DartDirectiveValue[]): WidgetIdentity => {
    if (prefix === null && declared?.has(name) === true) {
        return {status: 'verified', source: 'local', candidates: []};
    }
    const candidates = directives
        .filter((directive) => directive.kind === 'import' && directive.uri !== null && directive.prefix === prefix)
        .filter((directive) => (directive.show.length === 0 || directive.show.includes(name)) && !directive.hide.includes(name))
        .map((directive) => directive.uri as string);
    const unique = [...new Set(candidates)].sort(compareText);
    return unique.length === 0 ? {status: 'unresolved', source: null, candidates: []} : {status: 'heuristic', source: 'import', candidates: unique};
};

/** True when the identity says the name can come from an import whose URI starts with `source` (e.g. `package:flutter/`). */
export const identityFrom = (identity: WidgetIdentity, source: string): boolean =>
    identity.status === 'heuristic' && identity.candidates.some((candidate) => candidate.startsWith(source));
