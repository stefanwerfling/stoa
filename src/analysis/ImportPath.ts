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
