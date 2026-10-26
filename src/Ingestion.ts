import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import picomatch from 'picomatch';
import type {FileRef} from './analysis/LanguageAdapter.js';

// Always pruned during traversal (never analyzed, and walking them is wasteful).
// Everything else is governed by the include/exclude globs.
const HARD_PRUNED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

export interface IngestionOptions {
    include: string[];
    exclude: string[];
}

type Matcher = (path: string) => boolean;

/**
 * Selects files under a root using include/exclude globs (relative, POSIX-style
 * paths). A single-file root is returned as-is (explicit selection bypasses the
 * globs). Output is sorted by path, so ingestion order is deterministic.
 */
export const collectFiles = (rootPath: string, options: IngestionOptions): FileRef[] => {
    const stats = statSync(rootPath);
    if (stats.isFile()) {
        return [readFile(rootPath)];
    }

    const matchInclude = picomatch(options.include);
    const matchExclude = options.exclude.length > 0 ? picomatch(options.exclude) : () => false;

    const files: FileRef[] = [];
    walk(rootPath, rootPath, matchInclude, matchExclude, files);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
};

const walk = (dir: string, root: string, include: Matcher, exclude: Matcher, out: FileRef[]): void => {
    const entries = readdirSync(dir, {withFileTypes: true});
    for (const entry of entries) {
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!HARD_PRUNED_DIRS.has(entry.name)) {
                walk(absolute, root, include, exclude, out);
            }
            continue;
        }
        if (!entry.isFile()) {
            continue;
        }
        const rel = toPosix(relative(root, absolute));
        if (include(rel) && !exclude(rel)) {
            out.push(readFile(absolute));
        }
    }
};

const toPosix = (path: string): string => (sep === '/' ? path : path.split(sep).join('/'));

const readFile = (path: string): FileRef => {
    return {path, content: readFileSync(path, 'utf8')};
};
