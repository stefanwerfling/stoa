import {dirname, isAbsolute, resolve} from 'node:path';
import type {ProjectConfig} from '../config/ProjectConfig.js';

/**
 * How an import specifier was resolved to a module in the analyzed set — the
 * key piece of provenance Phase 0 adds. `DependencyCycleRule` consumes ONLY
 * `relative` edges in this phase (see docs architecture-evolution-assessment,
 * decision D1-a), so alias/exports/imports edges are fully built and carried
 * in the ModuleGraph for a later phase without changing any current finding.
 * `unresolved` is never a guess — it is the explicit, honest outcome when no
 * configured mechanism maps the specifier to an analyzed file.
 */
export type ResolutionMethod = 'relative' | 'alias' | 'exports' | 'imports' | 'unresolved';

export interface ResolvedImport {
    /** Absolute path of an analyzed file, or null when `resolution` is `unresolved`. */
    target: string | null;
    resolution: ResolutionMethod;
}

// The single canonical list of source extensions a specifier may omit — shared
// by every resolution path below so there is exactly ONE extension-resolution
// policy, not a second parallel one (ImportPath.ts delegates here).
const RESOLVABLE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

const stripExtension = (path: string): string => {
    for (const ext of RESOLVABLE_EXTENSIONS) {
        if (path.endsWith(ext)) {
            return path.slice(0, -ext.length);
        }
    }
    return path;
};

/**
 * Given an absolute path a specifier points at (possibly without, or with a
 * `.js`-style, extension), returns the matching file in `analyzedFiles` trying
 * the same candidate set the engine has always used: the path as-is, then each
 * source extension on its stem, then an `index.*` inside it. Null if none is in
 * the analyzed set. Pure membership check — never touches the filesystem, never
 * invents a path.
 */
const matchCandidate = (base: string, analyzedFiles: ReadonlySet<string>): string | null => {
    const stem = stripExtension(base);
    const candidates = [base, ...RESOLVABLE_EXTENSIONS.map((ext) => `${stem}${ext}`), ...RESOLVABLE_EXTENSIONS.map((ext) => resolve(stem, `index${ext}`))];
    for (const candidate of candidates) {
        if (analyzedFiles.has(candidate)) {
            return candidate;
        }
    }
    return null;
};

/**
 * Resolves a RELATIVE specifier (`./x`, `../y`) against the importer's
 * directory to a file in the analyzed set. This is the exact logic the engine
 * has always used for `deps.import`/`deps.export` resolution, extracted here so
 * it has a single home (ImportPath.ts's `resolveRelativeImport` now delegates
 * to it — no second parallel resolver exists). A bare/namespace specifier is
 * not this function's job and returns null.
 */
export const resolveRelative = (importer: string, specifier: string, analyzedFiles: ReadonlySet<string>): string | null => {
    if (!specifier.startsWith('.')) {
        return null;
    }
    return matchCandidate(resolve(dirname(importer), specifier), analyzedFiles);
};

/**
 * Substitutes a tsconfig `paths` pattern. Supports the single-`*` form
 * TypeScript itself allows (`@app/*` → `src/*`) and the exact form
 * (`@app` → `src/app`). Returns the substituted (still config-relative) target,
 * or null when the specifier does not match the pattern.
 */
const substitutePattern = (pattern: string, specifier: string, replacement: string): string | null => {
    const star = pattern.indexOf('*');
    if (star === -1) {
        return pattern === specifier ? replacement : null;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) {
        return null;
    }
    const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
    return replacement.includes('*') ? replacement.replace('*', captured) : replacement;
};

// Whether the first segment of a bare specifier (both segments for a scoped
// `@scope/name`) is an analyzed file or directory below `baseUrl`.
const underBaseUrl = (baseUrl: string, specifier: string, analyzedFiles: ReadonlySet<string>): boolean => {
    const segments = specifier.split('/');
    const head = resolve(baseUrl, ...segments.slice(0, specifier.startsWith('@') ? 2 : 1));
    for (const file of analyzedFiles) {
        if (file.startsWith(`${head}/`) || stripExtension(file) === head) {
            return true;
        }
    }
    return false;
};

/**
 * Orders two `*`-containing subpath-pattern keys by Node.js specificity
 * (`PATTERN_KEY_COMPARE`): the key with the longer part BEFORE `*` (larger
 * base) is more specific and sorts first; on a tie, the longer total key
 * (longer part AFTER `*`) sorts first. A final locale tiebreak keeps the order
 * deterministic for otherwise-equal keys. So `./features/*` beats `./*`, and
 * `./a/b/*` beats `./a/*`.
 */
const patternKeyCompare = (a: string, b: string): number => {
    const baseA = a.indexOf('*');
    const baseB = b.indexOf('*');
    if (baseA !== baseB) {
        return baseB - baseA;
    }
    if (a.length !== b.length) {
        return b.length - a.length;
    }
    return a.localeCompare(b);
};

// The ONLY conditional-export conditions this resolver follows — the
// source/ESM-facing ones. This is a deliberately CONSERVATIVE subset, NOT a
// full Node.js conditional-exports resolver: Node matches conditions against a
// live, caller-supplied condition set (which can include `require`, `browser`,
// `development`, custom flags, …) that a static analyzer does not have. See
// `pickConditionTarget` for how unsupported conditions are handled.
const SUPPORTED_CONDITIONS: ReadonlySet<string> = new Set(['import', 'node', 'default']);

/**
 * Picks a single string target out of a Node conditional-exports value
 * (`{import, require, default, …}` | string), honoring the ORIGINAL property
 * order (Node evaluates conditions in the order they are written). Rule, kept
 * deliberately strict so an unsupported condition can never yield a wrong
 * target:
 *   - a plain string resolves to itself;
 *   - for a conditions object, look at the FIRST property in source order: if
 *     its key is in `SUPPORTED_CONDITIONS`, recurse into it; if the first key
 *     is NOT supported (e.g. `require`, `browser`, `types`, a custom flag),
 *     return null (`unresolved`) — we never skip PAST a higher-priority
 *     unsupported condition to grab a later supported one, because under a real
 *     resolver that earlier condition might win and point elsewhere.
 * This is a conservative subset, not a full Node resolver (see
 * `SUPPORTED_CONDITIONS`): "not sure" is always `unresolved`, never a guess.
 */
const pickConditionTarget = (value: unknown): string | null => {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const keys = Object.keys(value as Record<string, unknown>);
    const firstKey = keys[0];
    if (firstKey === undefined || !SUPPORTED_CONDITIONS.has(firstKey)) {
        return null;
    }
    return pickConditionTarget((value as Record<string, unknown>)[firstKey]);
};

/**
 * Config-aware module resolution (Phase 0). Extends the long-standing relative
 * resolution with tsconfig `baseUrl`/`paths`, and conservatively with
 * package.json `exports`/`imports` — always resolving against the ANALYZED
 * file set (membership check), never the raw filesystem, and never by guessing
 * a directory shape. An ambiguous `paths` match (more than one distinct
 * analyzed target) is `unresolved`, not an arbitrary pick.
 */
export class ModuleResolver {
    public constructor(private readonly config: ProjectConfig) {}

    public resolve(importer: string, specifier: string, analyzedFiles: ReadonlySet<string>): ResolvedImport {
        if (specifier.startsWith('.')) {
            const target = resolveRelative(importer, specifier, analyzedFiles);
            return {target, resolution: target !== null ? 'relative' : 'unresolved'};
        }
        if (specifier.startsWith('#')) {
            const target = this.resolveImports(specifier, analyzedFiles);
            return {target, resolution: target !== null ? 'imports' : 'unresolved'};
        }
        const aliasTarget = this.resolveTsconfig(specifier, analyzedFiles);
        if (aliasTarget !== null) {
            return {target: aliasTarget, resolution: 'alias'};
        }
        const exportsTarget = this.resolveExports(specifier, analyzedFiles);
        if (exportsTarget !== null) {
            return {target: exportsTarget, resolution: 'exports'};
        }
        return {target: null, resolution: 'unresolved'};
    }

    /**
     * Whether an UNRESOLVED `specifier` names a module outside the project (a
     * package): bare (not relative, absolute or `#`), not the project's own
     * package name, not matched by any tsconfig `paths` pattern, and — with a
     * `baseUrl` — its first segment is no analyzed path below it. Anything a
     * configured mechanism could map into the project is NOT external: it is
     * an unresolved project reference, never a package.
     */
    public isExternal(specifier: string, analyzedFiles: ReadonlySet<string>): boolean {
        if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') || isAbsolute(specifier)) {
            return false;
        }
        const name = this.config.packageName;
        if (name !== undefined && (specifier === name || specifier.startsWith(`${name}/`))) {
            return false;
        }
        if (Object.keys(this.config.paths ?? {}).some((pattern) => substitutePattern(pattern, specifier, '') !== null)) {
            return false;
        }
        return this.config.baseUrl === undefined || !underBaseUrl(this.config.baseUrl, specifier, analyzedFiles);
    }

    // tsconfig `paths` + `baseUrl`. All matches (across every paths entry and
    // the baseUrl fallback) are collected into a set of DISTINCT analyzed
    // targets; exactly one → resolved, zero or more-than-one (ambiguous) →
    // null. Deterministic: paths keys are iterated in the sorted order
    // ProjectConfig already stored them in.
    private resolveTsconfig(specifier: string, analyzedFiles: ReadonlySet<string>): string | null {
        // Resolution base for `paths`: an explicit `baseUrl` wins; otherwise
        // TypeScript's `pathsBasePath` (the directory of the config that
        // DECLARED the paths — correct for paths inherited via `extends` from
        // a base config in another directory); only then the analysis root.
        const base = this.config.baseUrl ?? this.config.pathsBasePath ?? (this.config.configDir.length > 0 ? this.config.configDir : null);
        const matches = new Set<string>();
        if (this.config.paths !== undefined && base !== null) {
            for (const pattern of Object.keys(this.config.paths)) {
                for (const replacement of this.config.paths[pattern] ?? []) {
                    const substituted = substitutePattern(pattern, specifier, replacement);
                    if (substituted === null) {
                        continue;
                    }
                    const abs = isAbsolute(substituted) ? substituted : resolve(base, substituted);
                    const hit = matchCandidate(abs, analyzedFiles);
                    if (hit !== null) {
                        matches.add(hit);
                    }
                }
            }
        }
        if (this.config.baseUrl !== undefined) {
            const hit = matchCandidate(resolve(this.config.baseUrl, specifier), analyzedFiles);
            if (hit !== null) {
                matches.add(hit);
            }
        }
        return matches.size === 1 ? [...matches][0] ?? null : null;
    }

    // package.json `exports`, consulted only for a SELF-referential specifier
    // (`<packageName>` or `<packageName>/sub`). Conservative: resolves only
    // when the mapped target is a path into the analyzed set; a target pointing
    // at a build artifact (dist/*.js not analyzed) simply stays unresolved.
    private resolveExports(specifier: string, analyzedFiles: ReadonlySet<string>): string | null {
        const name = this.config.packageName;
        if (name === undefined || this.config.exports === undefined || this.config.configDir.length === 0) {
            return null;
        }
        let subpath: string | null = null;
        if (specifier === name) {
            subpath = '.';
        } else if (specifier.startsWith(`${name}/`)) {
            subpath = `./${specifier.slice(name.length + 1)}`;
        }
        if (subpath === null) {
            return null;
        }
        const mapped = this.lookupSubpath(this.config.exports, subpath);
        return mapped === null ? null : matchCandidate(resolve(this.config.configDir, mapped), analyzedFiles);
    }

    // package.json `imports` (`#`-prefixed). Festlegung 5: resolved only when
    // the import target is itself a path into the project (relative/absolute) —
    // a `#x` that redirects to an external package is NOT reliably resolvable
    // to an analyzed file and stays unresolved rather than guessed.
    private resolveImports(specifier: string, analyzedFiles: ReadonlySet<string>): string | null {
        if (this.config.imports === undefined || this.config.configDir.length === 0) {
            return null;
        }
        const mapped = this.lookupSubpath(this.config.imports, specifier);
        if (mapped === null || !(mapped.startsWith('.') || isAbsolute(mapped))) {
            return null;
        }
        return matchCandidate(isAbsolute(mapped) ? mapped : resolve(this.config.configDir, mapped), analyzedFiles);
    }

    // Looks a subpath key up in an exports/imports map. An exact
    // (non-pattern) key always wins. Otherwise the MOST SPECIFIC matching
    // `*` pattern is chosen by Node's `PATTERN_KEY_COMPARE` (see
    // `patternKeyCompare`) — not alphabetically — and ONLY that one is
    // resolved: there is deliberately no fallback to a less-specific pattern
    // (Node would never pick one once the specific pattern matched), so a
    // specific pattern whose target is not an analyzed file ends as
    // `unresolved` rather than silently matching a broader pattern.
    private lookupSubpath(field: unknown, subpath: string): string | null {
        if (typeof field === 'string') {
            return subpath === '.' ? field : null;
        }
        if (typeof field !== 'object' || field === null || Array.isArray(field)) {
            return null;
        }
        const record = field as Record<string, unknown>;
        if (subpath in record) {
            return pickConditionTarget(record[subpath]);
        }
        const matchingKeys = Object.keys(record).filter((key) => key.includes('*') && substitutePattern(key, subpath, '*') !== null);
        if (matchingKeys.length === 0) {
            return null;
        }
        matchingKeys.sort(patternKeyCompare);
        const bestKey = matchingKeys[0] as string;
        const captured = substitutePattern(bestKey, subpath, '*');
        const template = pickConditionTarget(record[bestKey]);
        if (captured !== null && template !== null && template.includes('*')) {
            return template.replace('*', captured);
        }
        return null;
    }
}
