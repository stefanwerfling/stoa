import {join, relative, resolve, sep} from 'node:path';
import picomatch from 'picomatch';
import type {ProjectConfig} from './ProjectConfig.js';

/**
 * Where a project's package entry points are declared — the files whose
 * exports are its public API (R-UNUSED-EXPORT does not report them, nor what
 * they re-export). Two sources, both explicit:
 * - `patterns`: `entryPoints` of stoa.config.json, globs relative to the
 *   analysis root (`index.ts`, `src/public/*.ts`);
 * - `project.packageEntries`: what the root `package.json` declares (`main`,
 *   `module`, `types`, `exports`, `bin`), mapped onto analyzed files.
 */
export interface EntryDeclarations {
    patterns: readonly string[];
    project: ProjectConfig;
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const OUTPUT_EXTENSION = /(\.d)?\.(m|c)?(ts|js)x?$/;

/** The source files `path` (a declared entry) may stand for: itself, then the same path with each source extension. */
const sourceCandidates = (path: string): string[] => {
    const base = path.replace(OUTPUT_EXTENSION, '');
    const withExtension = SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`);
    return OUTPUT_EXTENSION.test(path) ? [path, ...withExtension] : [path, ...withExtension, ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`))];
};

/**
 * The analyzed file a `package.json` entry names, or null. The entry itself
 * when it is analyzed; else its source: the same path with a source
 * extension (`index.js` → `index.ts`), or — when the entry lies in the
 * tsconfig `outDir` and a `rootDir` is set — the same path below `rootDir`
 * (`dist/index.d.ts` → `src/index.ts`). More than one analyzed candidate is
 * no match: nothing is guessed.
 */
const packageEntryFile = (entry: string, project: ProjectConfig, analyzedFiles: ReadonlySet<string>): string | null => {
    const path = resolve(project.configDir, entry);
    if (analyzedFiles.has(path)) {
        return path;
    }
    const mapped = project.outDir !== undefined && project.rootDir !== undefined && path.startsWith(`${project.outDir}${sep}`) ? join(project.rootDir, relative(project.outDir, path)) : null;
    const hits = new Set([...sourceCandidates(path), ...(mapped === null ? [] : sourceCandidates(mapped))].filter((candidate) => analyzedFiles.has(candidate)));
    return hits.size === 1 ? ([...hits][0] as string) : null;
};

/** The analyzed files that are package entry points (see `EntryDeclarations`). */
export const resolveEntryPoints = (declarations: EntryDeclarations, analyzedFiles: ReadonlySet<string>): Set<string> => {
    const entries = new Set<string>();
    const root = declarations.project.configDir;
    if (declarations.patterns.length > 0 && root.length > 0) {
        const matches = picomatch([...declarations.patterns]);
        [...analyzedFiles].filter((file) => matches(relative(root, file).split(sep).join('/'))).forEach((file) => entries.add(file));
    }
    if (root.length > 0) {
        for (const entry of declarations.project.packageEntries ?? []) {
            const file = packageEntryFile(entry, declarations.project, analyzedFiles);
            if (file !== null) {
                entries.add(file);
            }
        }
    }
    return entries;
};
