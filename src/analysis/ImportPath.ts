import {resolveRelative} from './ModuleResolution.js';

/**
 * Resolves a relative import specifier to a file in the analyzed set (trying
 * common extensions and an index file). Bare/namespace specifiers are external
 * and resolve to null. Shared by the dependency-cycle and dead-export rules.
 *
 * Thin delegate to `ModuleResolution.resolveRelative` — the canonical, single
 * implementation of relative resolution. Kept as a named export so the
 * relative-only callers (`DeadExportRule`, and `DependencyCycleRule`'s
 * no-ModuleGraph fallback) stay byte-identical without being coupled to the
 * full config-aware `ModuleResolver`. There is deliberately NO second parallel
 * resolver: config-aware resolution lives only in `ModuleResolver`, relative
 * resolution only in `resolveRelative`, and this re-exports the latter.
 */
export const resolveRelativeImport = (importer: string, specifier: string, analyzedFiles: ReadonlySet<string>): string | null =>
    resolveRelative(importer, specifier, analyzedFiles);

// Path/namespace segments that signal reaching past a module's public surface
// into its internals. Matched per segment (not substring) to avoid false hits
// like "International". Shared by the TS and PHP adapters.
const INTERNAL_SEGMENTS: ReadonlySet<string> = new Set(['internal', 'internals', 'private', 'impl']);

/**
 * True if an import specifier reaches into another module's internals, e.g.
 * `../internal/secret.js` (TS, separator '/') or `App\Internal\Secret`
 * (PHP, separator '\\').
 */
export const isDeepImport = (specifier: string, separator: string): boolean => {
    return specifier
        .split(separator)
        .some((segment) => INTERNAL_SEGMENTS.has(segment.toLowerCase()));
};
