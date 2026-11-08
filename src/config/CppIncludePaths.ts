import {existsSync, readFileSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';
import type {CppConfig, CppIncludeSummary} from '../Types.js';

/**
 * Where a C/C++ `#include` is looked up, besides the directory of the
 * including file: the include paths of the build. Read once from the
 * analysis root, from two sources:
 * - a compilation database (`compile_commands.json`): the file given as
 *   `cpp.compileCommands` in stoa.config.json, else — as clangd looks —
 *   `<root>/compile_commands.json`, else `<root>/build/compile_commands.json`.
 *   The first file that exists is the one considered. It is used when at
 *   least one of its entries names a file that exists on disk; a database of
 *   another machine or container (no entry matches) is reported as `stale`
 *   and not used, an unparseable one as `unreadable`.
 * - `cpp.includePaths` in stoa.config.json: directories relative to the
 *   analysis root, searched like `-I` after the database's paths — for a
 *   project without a database.
 *
 * Per translation unit the database gives the compiler's own search order:
 * `-iquote` (quoted includes only), then `-I`, then `-isystem`, then
 * `-idirafter`. A file without an entry — a header, or a source file the
 * build does not compile — has no order of its own: it searches the
 * configured paths, then every directory the database names, where an
 * include resolves only when exactly one file matches (see
 * `ModuleResolver.resolveCppInclude`).
 *
 * Never throws: an unreadable source degrades to no include paths.
 */
export interface CppIncludeSearch {
    /** The include paths per translation unit (absolute file path), in compiler order. */
    units: ReadonlyMap<string, CppSearchPaths>;
    /** `cpp.includePaths`, absolute, in configured order. */
    configured: readonly string[];
    /** Every directory any translation unit searches, sorted — the fallback for files without an entry. */
    union: readonly string[];
    /** For the report: what was read. */
    summary: CppIncludeSummary;
}

/** One translation unit's include directories: `quote` only for `#include "…"`, then `angle` for both forms. */
export interface CppSearchPaths {
    quote: readonly string[];
    angle: readonly string[];
}

interface DatabaseEntry {
    directory?: unknown;
    file?: unknown;
    command?: unknown;
    arguments?: unknown;
}

const DATABASE = 'compile_commands.json';

/** The include search of the project at `rootDir`, or null when neither a database nor `includePaths` exist. */
export const loadCppIncludeSearch = (rootDir: string, config: CppConfig | undefined): CppIncludeSearch | null => {
    const configured = (config?.includePaths ?? []).map((path) => resolve(rootDir, path));
    const databasePath = databaseOf(rootDir, config?.compileCommands);
    if (databasePath === null && configured.length === 0) {
        return null;
    }
    const database = databasePath === null ? null : readDatabase(databasePath);
    const units = database?.status === 'used' ? database.units : new Map<string, CppSearchPaths>();
    const union = [...new Set([...units.values()].flatMap((paths) => [...paths.quote, ...paths.angle]))].sort((a, b) => a.localeCompare(b));
    const summary: CppIncludeSummary = {
        includePaths: configured.length,
        ...(databasePath === null || database === null ? {} : {compileCommands: {path: databasePath, status: database.status, entries: database.entries, matchedEntries: database.matched}})
    };
    return {units, configured, union, summary};
};

/** The database to consider: the configured one (even if missing), else the first that exists of `<root>/` and `<root>/build/`. */
const databaseOf = (rootDir: string, configuredPath: string | undefined): string | null => {
    if (configuredPath !== undefined) {
        return resolve(rootDir, configuredPath);
    }
    return [join(rootDir, DATABASE), join(rootDir, 'build', DATABASE)].find((path) => existsSync(path)) ?? null;
};

interface ReadDatabase {
    status: CppDatabaseStatus;
    entries: number;
    matched: number;
    units: Map<string, CppSearchPaths>;
}

type CppDatabaseStatus = NonNullable<CppIncludeSummary['compileCommands']>['status'];

const readDatabase = (path: string): ReadDatabase => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return {status: existsSync(path) ? 'unreadable' : 'missing', entries: 0, matched: 0, units: new Map()};
    }
    if (!Array.isArray(parsed)) {
        return {status: 'unreadable', entries: 0, matched: 0, units: new Map()};
    }
    const units = new Map<string, CppSearchPaths>();
    let matched = 0;
    for (const entry of parsed as DatabaseEntry[]) {
        const unit = unitOf(entry);
        if (unit !== null && existsSync(unit.file)) {
            matched += 1;
            // A file compiled twice (two targets): the first entry, as clangd takes it.
            if (!units.has(unit.file)) {
                units.set(unit.file, unit.paths);
            }
        }
    }
    return {status: matched > 0 ? 'used' : 'stale', entries: parsed.length, matched, units};
};

const unitOf = (entry: DatabaseEntry): {file: string; paths: CppSearchPaths} | null => {
    if (typeof entry.directory !== 'string' || typeof entry.file !== 'string') {
        return null;
    }
    const argv = Array.isArray(entry.arguments) ? entry.arguments.filter((arg): arg is string => typeof arg === 'string') : typeof entry.command === 'string' ? splitCommand(entry.command) : [];
    return {file: resolve(entry.directory, entry.file), paths: includePathsOf(argv, entry.directory)};
};

/** The flags that add include directories, by where they sit in the search order. */
const FLAGS = [
    {flag: '-iquote', slot: 'quote'},
    {flag: '-isystem', slot: 'system'},
    {flag: '-idirafter', slot: 'after'},
    {flag: '--include-directory=', slot: 'angle'},
    {flag: '-I', slot: 'angle'}
] as const;

const MSVC_INCLUDE = {flag: '/I', slot: 'angle'} as const;

type Slot = (typeof FLAGS)[number]['slot'];

/**
 * The include directories of one compiler command line, relative ones
 * resolved against the entry's `directory`. GCC/Clang flags, joined (`-Isrc`)
 * or separate (`-I src`); `/I` only for an MSVC-style driver (`cl`,
 * `clang-cl`), where it cannot be a path.
 */
const includePathsOf = (argv: readonly string[], directory: string): CppSearchPaths => {
    const slots: Record<Slot, string[]> = {quote: [], angle: [], system: [], after: []};
    const msvc = /^(?:cl|clang-cl)(?:\.exe)?$/i.test(basename(argv[0] ?? ''));
    for (let index = 1; index < argv.length; index += 1) {
        const flag = flagOf(argv[index] ?? '', msvc);
        if (flag === null) {
            continue;
        }
        const separate = flag.value.length === 0 && flag.separable;
        const dir = separate ? argv[index + 1] : flag.value;
        index += separate ? 1 : 0;
        if (dir !== undefined && dir.length > 0) {
            slots[flag.slot].push(resolve(directory, dir));
        }
    }
    return {quote: slots.quote, angle: [...slots.angle, ...slots.system, ...slots.after]};
};

/** The include flag `arg` starts with: its slot, the directory joined to it (maybe empty), and whether the directory may follow separately. */
const flagOf = (arg: string, msvc: boolean): {slot: Slot; value: string; separable: boolean} | null => {
    const match = FLAGS.find(({flag}) => arg.startsWith(flag)) ?? (msvc && arg.startsWith(MSVC_INCLUDE.flag) ? MSVC_INCLUDE : undefined);
    return match === undefined ? null : {slot: match.slot, value: arg.slice(match.flag.length), separable: !match.flag.endsWith('=')};
};

// One shell word: unquoted characters, backslash escapes, "…" and '…' runs.
const WORD = /(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"|'[^']*')+/gs;
// The parts of one word, each unquoted on its own.
const PART = /\\(.)|"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\\"']+)/gs;

const unquote = (word: string): string =>
    [...word.matchAll(PART)].map(([, escaped, double, single, plain]) => escaped ?? double?.replace(/\\(.)/gs, '$1') ?? single ?? plain ?? '').join('');

/**
 * A `command` string split into arguments as a POSIX shell would: whitespace
 * separates, single quotes are literal, double quotes and backslashes escape.
 * No expansion — a compilation database holds no variables.
 */
const splitCommand = (command: string): string[] => [...command.matchAll(WORD)].map(([word]) => unquote(word));
