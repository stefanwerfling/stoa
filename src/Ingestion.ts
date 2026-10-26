import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import type {FileRef} from './analysis/LanguageAdapter.js';

const DEFAULT_IGNORED_DIRS: readonly string[] = ['node_modules', '.git', 'dist', 'coverage', '.stoa'] as const;

export interface IngestionOptions {
    includeExtensions: readonly string[];
}

/**
 * Walks a directory (or reads a single file) and returns file references sorted
 * by path, so ingestion order is deterministic. Full glob support from the
 * config is simplified in M1: selection is by extension only.
 */
export const collectFiles = (rootPath: string, options: IngestionOptions): FileRef[] => {
    const stats = statSync(rootPath);
    if (stats.isFile()) {
        return [readFile(rootPath)];
    }

    const files: FileRef[] = [];
    walk(rootPath, options, files);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
};

const walk = (dir: string, options: IngestionOptions, out: FileRef[]): void => {
    const entries = readdirSync(dir, {withFileTypes: true});
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!DEFAULT_IGNORED_DIRS.includes(entry.name)) {
                walk(join(dir, entry.name), options, out);
            }
            continue;
        }
        if (entry.isFile() && options.includeExtensions.some((ext) => entry.name.endsWith(ext))) {
            out.push(readFile(join(dir, entry.name)));
        }
    }
};

const readFile = (path: string): FileRef => {
    return {path, content: readFileSync(path, 'utf8')};
};
