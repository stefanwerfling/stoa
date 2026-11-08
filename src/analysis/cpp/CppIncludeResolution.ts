import {statSync} from 'node:fs';
import {dirname, isAbsolute, join} from 'node:path';
import type {CppIncludeSearch, CppSearchPaths} from '../../config/CppIncludePaths.js';
import type {CppIncludeValue} from './CppExtraction.js';

/** Where an include was found: next to the including file, or in an include path. */
type CppIncludeResolution = 'relative' | 'include-path';

export interface CppIncludeTarget {
    target: string;
    resolution: CppIncludeResolution;
}

type Probe = {hit: string} | 'shadowed' | 'missing';

/**
 * The analyzed file a `#include` reads, or null. Searched as the compiler
 * searches: a quoted include first next to the including file; then, for a
 * translation unit of the compilation database, its `-iquote` paths (quoted
 * only), `-I`, `-isystem` and `-idirafter`; then `cpp.includePaths`. The
 * first file that EXISTS wins — when it is not analyzed (excluded, outside
 * the root), the include is unresolved rather than letting a later
 * candidate win, which the compiler would never read.
 *
 * A file without its own entry (a header) has no search order: after the
 * steps above it tries every directory the database names and resolves
 * only when exactly one existing file matches, and that file is analyzed.
 *
 * Without include paths this is exactly the include-next-to-the-file rule.
 * A `<…>` include never looks next to the including file; a macro or an
 * absolute include is never resolved.
 */
export const resolveCppInclude = (search: CppIncludeSearch | undefined, from: string, include: CppIncludeValue, analyzedFiles: ReadonlySet<string>): CppIncludeTarget | null => {
    if (include.form === 'macro' || isAbsolute(include.module)) {
        return null;
    }
    const probe = (dir: string): Probe => probeFile(join(dir, include.module), analyzedFiles);
    const local = include.form === 'quoted' ? probe(dirname(from)) : 'missing';
    if (local !== 'missing') {
        return targetOf(local, 'relative');
    }
    const unit = search?.units.get(from);
    const found = firstFound(searchOrder(search, unit, include.form === 'quoted'), probe);
    if (found !== 'missing') {
        return targetOf(found, 'include-path');
    }
    return search !== undefined && unit === undefined ? uniqueInUnion(search.union, probe) : null;
};

/** The ordered include directories of `unit` (none without an entry), then the configured ones. */
const searchOrder = (search: CppIncludeSearch | undefined, unit: CppSearchPaths | undefined, quoted: boolean): string[] => [
    ...(quoted ? (unit?.quote ?? []) : []),
    ...(unit?.angle ?? []),
    ...(search?.configured ?? [])
];

/** The first directory whose candidate exists — analyzed or not; `missing` when none does. */
const firstFound = (dirs: readonly string[], probe: (dir: string) => Probe): Probe => {
    for (const dir of dirs) {
        const found = probe(dir);
        if (found !== 'missing') {
            return found;
        }
    }
    return 'missing';
};

const targetOf = (found: Exclude<Probe, 'missing'>, resolution: CppIncludeResolution): CppIncludeTarget | null => (found === 'shadowed' ? null : {target: found.hit, resolution});

/** Every directory's candidate that exists: one analyzed file → it, anything else → null. */
const uniqueInUnion = (union: readonly string[], probe: (dir: string) => Probe): CppIncludeTarget | null => {
    const found = new Set<string>();
    for (const dir of union) {
        const result = probe(dir);
        if (result !== 'missing') {
            found.add(result === 'shadowed' ? `shadowed:${dir}` : result.hit);
        }
    }
    const [only] = found;
    return found.size === 1 && only !== undefined && !only.startsWith('shadowed:') ? {target: only, resolution: 'include-path'} : null;
};

/** An analyzed file → hit; a file that exists on disk but is not analyzed → shadowed; else missing. */
const probeFile = (candidate: string, analyzedFiles: ReadonlySet<string>): Probe => {
    if (analyzedFiles.has(candidate)) {
        return {hit: candidate};
    }
    return isFile(candidate) ? 'shadowed' : 'missing';
};

const isFile = (path: string): boolean => {
    try {
        return statSync(path).isFile();
    } catch {
        // Absent or unreadable: not a file the compiler could read either.
        return false;
    }
};
