import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import picomatch from 'picomatch';
import type {FileRef} from './analysis/LanguageAdapter.js';

// Always pruned during traversal (never analyzed, and walking them is wasteful).
// Everything else is governed by the include/exclude globs.
const HARD_PRUNED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

// A hand-written source file essentially never reaches this size; a bundled/
// minified/generated artifact routinely does (one real-world fixture used
// while measuring this: a single 3 MB webpack bundle alone drove ts-morph's
// AST + node-wrapper cost for that one file past what the rest of a ~300-file
// project needed combined). Reading and parsing such a file buys no analytical
// value — there is nothing left to say about naming/complexity/control-flow
// once code has been bundled — so it is excluded the same way a glob-excluded
// file is, not silently skipped later during parsing. Configurable, not a
// hidden constant: a project that genuinely wants a large generated file
// analyzed can raise `maxFileBytes`.
export const DEFAULT_MAX_FILE_BYTES = 1_000_000;

export interface IngestionOptions {
    include: string[];
    exclude: string[];
    /** Files larger than this are excluded, the same as a glob exclude (see DEFAULT_MAX_FILE_BYTES). Defaults to DEFAULT_MAX_FILE_BYTES; set to Infinity to disable. */
    maxFileBytes?: number;
    /** Called once per path dropped for a reason OTHER than the include/exclude globs: an oversized file, or a directory that could not be read (e.g. EACCES). Optional — purely a diagnostic hook, never required for correct selection. */
    onExcluded?: (path: string, reason: string) => void;
}

type Matcher = (path: string) => boolean;

/**
 * Selects files under a root using include/exclude globs (relative, POSIX-style
 * paths). A single-file root is returned as-is (explicit selection bypasses the
 * globs). Output is sorted by path, so ingestion order is deterministic.
 *
 * Robustness: a directory that cannot be read (permission error, race with a
 * concurrent delete, …) is reported via `onExcluded` and pruned — it never
 * aborts the whole walk (a single unreadable subtree used to crash the entire
 * analysis; see Ingestion.test.ts). Symlinks are deliberately never followed
 * (neither `isDirectory()` nor `isFile()` is true for a symlink's own Dirent
 * entry, so this is a no-op skip, not special-cased error handling) — the
 * alternative, following them, risks an unbounded walk on a circular symlink
 * with no correctness benefit documented as needed here.
 */
export const collectFiles = (rootPath: string, options: IngestionOptions): FileRef[] => {
    const stats = statSync(rootPath);
    if (stats.isFile()) {
        return [readFile(rootPath)];
    }

    const matchInclude = picomatch(options.include);
    const matchExclude = options.exclude.length > 0 ? picomatch(options.exclude) : () => false;
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const onExcluded = options.onExcluded ?? (() => undefined);

    const files: FileRef[] = [];
    walk(rootPath, rootPath, matchInclude, matchExclude, maxFileBytes, onExcluded, files);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
};

const walk = (dir: string, root: string, include: Matcher, exclude: Matcher, maxFileBytes: number, onExcluded: (path: string, reason: string) => void, out: FileRef[]): void => {
    let entries;
    try {
        entries = readdirSync(dir, {withFileTypes: true});
    } catch (error) {
        onExcluded(dir, `directory not readable: ${(error as Error).message}`);
        return;
    }
    for (const entry of entries) {
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!HARD_PRUNED_DIRS.has(entry.name)) {
                walk(absolute, root, include, exclude, maxFileBytes, onExcluded, out);
            }
            continue;
        }
        if (!entry.isFile()) {
            continue;
        }
        const rel = toPosix(relative(root, absolute));
        if (!include(rel) || exclude(rel)) {
            continue;
        }
        const size = statSync(absolute).size;
        if (size > maxFileBytes) {
            onExcluded(absolute, `exceeds maxFileBytes (${size} > ${maxFileBytes})`);
            continue;
        }
        out.push(readFile(absolute));
    }
};

const toPosix = (path: string): string => (sep === '/' ? path : path.split(sep).join('/'));

const readFile = (path: string): FileRef => {
    return {path, content: readFileSync(path, 'utf8')};
};
