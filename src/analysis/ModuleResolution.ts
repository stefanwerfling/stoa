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

/** Picks a single string target out of a Node conditions value (`{import, require, default, …}` | string), preferring the import/source-facing conditions. Null for anything not reducible to one string. */
const pickConditionTarget = (value: unknown): string | null => {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    for (const condition of ['import', 'node', 'default']) {
        if (condition in record) {
            const nested = pickConditionTarget(record[condition]);
            if (nested !== null) {
                return nested;
            }
        }
    }
    return null;
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

    // tsconfig `paths` + `baseUrl`. All matches (across every paths entry and
    // the baseUrl fallback) are collected into a set of DISTINCT analyzed
    // targets; exactly one → resolved, zero or more-than-one (ambiguous) →
    // null. Deterministic: paths keys are iterated in the sorted order
    // ProjectConfig already stored them in.
    private resolveTsconfig(specifier: string, analyzedFiles: ReadonlySet<string>): string | null {
        const base = this.config.baseUrl ?? (this.config.configDir.length > 0 ? this.config.configDir : null);
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

    // Looks a subpath key up in an exports/imports map. Handles a bare string
    // map value, an exact key, and a single-`*` subpath pattern. Returns the
    // mapped target string (via `pickConditionTarget`) or null.
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
        for (const key of Object.keys(record).sort()) {
            if (!key.includes('*')) {
                continue;
            }
            const substituted = substitutePattern(key, subpath, '*');
            if (substituted === null) {
                continue;
            }
            const template = pickConditionTarget(record[key]);
            if (template !== null && template.includes('*')) {
                return template.replace('*', substituted);
            }
        }
        return null;
    }
}
