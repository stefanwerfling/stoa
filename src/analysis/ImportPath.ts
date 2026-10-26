import {dirname, resolve} from 'node:path';

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
 * Resolves a relative import specifier to a file in the analyzed set (trying
 * common extensions and an index file). Bare/namespace specifiers are external
 * and resolve to null. Shared by the dependency-cycle and dead-export rules.
 */
export const resolveRelativeImport = (importer: string, specifier: string, analyzedFiles: ReadonlySet<string>): string | null => {
    if (!specifier.startsWith('.')) {
        return null;
    }
    const base = resolve(dirname(importer), specifier);
    const stem = stripExtension(base);
    const candidates = [
        base,
        ...RESOLVABLE_EXTENSIONS.map((ext) => `${stem}${ext}`),
        ...RESOLVABLE_EXTENSIONS.map((ext) => resolve(stem, `index${ext}`))
    ];
    for (const candidate of candidates) {
        if (analyzedFiles.has(candidate)) {
            return candidate;
        }
    }
    return null;
};

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
