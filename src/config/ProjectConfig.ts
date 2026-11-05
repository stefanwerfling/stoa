import {existsSync, readFileSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {ts} from 'ts-morph';

/**
 * The project-level configuration that INFLUENCES module resolution — read
 * once, up front, from the analysis root (see ModuleResolution.ts). This is
 * Phase 0 of the "Config-Aware Module Resolution" work: deliberately narrow,
 * deterministic, and fail-safe. It reads ONLY `tsconfig.json` (with its
 * `extends` chain, resolved by TypeScript's own config parser), the root
 * `package.json` and the root `composer.json` (PSR-4 only) — it never walks `node_modules`, never touches the network,
 * and never guesses. Any read/parse error degrades to an empty config (no
 * alias/exports resolution), never an exception: a broken or absent config
 * must weaken resolution to "relative-only", not abort the analysis.
 */
export interface ProjectConfig {
    /** The directory the config is anchored at (the analysis root, or a single file's directory). */
    configDir: string;
    /** Absolute `compilerOptions.baseUrl`, if tsconfig declared one. */
    baseUrl?: string;
    /**
     * Absolute base directory `paths` are resolved against when NO `baseUrl`
     * is set — TypeScript's `options.pathsBasePath`, which is the directory of
     * the config file that actually DECLARED `paths` (the base config in an
     * `extends` chain, not necessarily the root). Resolution base precedence
     * (see ModuleResolution.ts) is `baseUrl` → `pathsBasePath` → `configDir`.
     */
    pathsBasePath?: string;
    /** `compilerOptions.paths` exactly as TypeScript resolved them (after `extends`). Patterns relative to `baseUrl`, else `pathsBasePath`, else `configDir`. */
    paths?: Record<string, string[]>;
    /** Root `package.json` `name`, used to recognize a self-referential import (`import x from "my-pkg/sub"`). */
    packageName?: string;
    /** Raw `package.json` `exports` field (string | object), consulted conservatively — see ModuleResolution.ts. */
    exports?: unknown;
    /** Raw `package.json` `imports` field (`#`-prefixed subpath imports), consulted conservatively — see ModuleResolution.ts. */
    imports?: unknown;
    /**
     * Root `composer.json` PSR-4 mappings (`autoload` and `autoload-dev`),
     * in Composer's lookup order: longest namespace prefix first, each with
     * its directories (absolute) in declared order. Absent = no composer.json
     * (or none readable): PHP names then resolve to nothing and are never
     * classified as external — see `ModuleResolver.resolvePhpClass`.
     */
    psr4?: Psr4Mapping[];
}

/** One PSR-4 namespace prefix (`App\\`, `''` for the fallback) and the directories it maps to. */
interface Psr4Mapping {
    prefix: string;
    dirs: string[];
}

interface PackageJsonShape {
    name?: unknown;
    exports?: unknown;
    imports?: unknown;
}

const dirOf = (rootPath: string): string => {
    try {
        return statSync(rootPath).isDirectory() ? rootPath : dirname(rootPath);
    } catch {
        return dirname(rootPath);
    }
};

/**
 * Parses `<configDir>/tsconfig.json` using TypeScript's own
 * `parseJsonConfigFileContent`, which resolves the full `extends` chain
 * (including depth/cycle handling) deterministically through `ts.sys`. The
 * host's `readDirectory` is stubbed to `[]` so this never enumerates/globs the
 * project's source files — only the config files themselves (and their
 * `extends` targets) are read. Returns `baseUrl`/`paths` or `undefined` on any
 * problem (missing file, parse error, no such options) — never throws.
 */
const readTsConfig = (configDir: string): {baseUrl?: string; pathsBasePath?: string; paths?: Record<string, string[]>} => {
    const tsconfigPath = join(configDir, 'tsconfig.json');
    if (!existsSync(tsconfigPath)) {
        return {};
    }
    try {
        const readResult = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
        if (readResult.error !== undefined || readResult.config === undefined) {
            return {};
        }
        // Stub readDirectory so TypeScript resolves `extends` + compilerOptions
        // WITHOUT walking/globbing the whole project (we only want the options).
        const host: ts.ParseConfigHost = {
            useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
            readDirectory: () => [],
            fileExists: ts.sys.fileExists,
            readFile: ts.sys.readFile
        };
        const parsed = ts.parseJsonConfigFileContent(readResult.config, host, configDir);
        const options = parsed.options;
        const result: {baseUrl?: string; pathsBasePath?: string; paths?: Record<string, string[]>} = {};
        if (typeof options.baseUrl === 'string') {
            result.baseUrl = options.baseUrl;
        }
        // `pathsBasePath` is where TypeScript anchors `paths` when `baseUrl` is
        // absent (the declaring config's directory). It is typed `@internal` in
        // some TS versions but is present on the resolved options at runtime —
        // read it through a narrow, typed accessor rather than casting `options`.
        const pathsBasePath = (options as {pathsBasePath?: unknown}).pathsBasePath;
        if (typeof pathsBasePath === 'string') {
            result.pathsBasePath = pathsBasePath;
        }
        if (options.paths !== undefined) {
            // TypeScript hands back a plain object; copy defensively into a
            // null-prototype-free, deterministic record.
            const paths: Record<string, string[]> = {};
            for (const key of Object.keys(options.paths).sort()) {
                const value = options.paths[key];
                if (Array.isArray(value)) {
                    paths[key] = value.filter((entry): entry is string => typeof entry === 'string');
                }
            }
            result.paths = paths;
        }
        return result;
    } catch {
        return {};
    }
};

const readPackageJson = (configDir: string): {packageName?: string; exports?: unknown; imports?: unknown} => {
    const pkgPath = join(configDir, 'package.json');
    if (!existsSync(pkgPath)) {
        return {};
    }
    try {
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJsonShape;
        const result: {packageName?: string; exports?: unknown; imports?: unknown} = {};
        if (typeof parsed.name === 'string' && parsed.name.length > 0) {
            result.packageName = parsed.name;
        }
        if (parsed.exports !== undefined) {
            result.exports = parsed.exports;
        }
        if (parsed.imports !== undefined) {
            result.imports = parsed.imports;
        }
        return result;
    } catch {
        return {};
    }
};

const psr4Section = (section: unknown): [string, string[]][] => {
    const map = (section as {'psr-4'?: unknown} | null)?.['psr-4'];
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
        return [];
    }
    return Object.entries(map as Record<string, unknown>).map(([prefix, dirs]): [string, string[]] => [
        prefix,
        (Array.isArray(dirs) ? dirs : [dirs]).filter((dir): dir is string => typeof dir === 'string')
    ]);
};

/**
 * Reads the PSR-4 mappings of `<configDir>/composer.json` (root package only;
 * `vendor/` and its installed packages are never read). `autoload` and
 * `autoload-dev` are merged per prefix (directories of `autoload` first, as
 * Composer's generated map does). Sorted longest prefix first, ties by
 * prefix — the order Composer's ClassLoader tries them in. `undefined` when
 * there is no readable composer.json.
 */
const readComposerPsr4 = (configDir: string): Psr4Mapping[] | undefined => {
    const composerPath = join(configDir, 'composer.json');
    if (!existsSync(composerPath)) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(readFileSync(composerPath, 'utf8')) as {autoload?: unknown; 'autoload-dev'?: unknown};
        const byPrefix = new Map<string, string[]>();
        for (const [prefix, dirs] of [...psr4Section(parsed.autoload), ...psr4Section(parsed['autoload-dev'])]) {
            byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), ...dirs.map((dir) => join(configDir, dir))]);
        }
        return [...byPrefix]
            .map(([prefix, dirs]) => ({prefix, dirs}))
            .sort((a, b) => b.prefix.length - a.prefix.length || (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
    } catch {
        // Unreadable composer.json: PHP names stay unknown (no mappings), the analysis goes on.
        return undefined;
    }
};

/**
 * Loads the project configuration from the analysis root. Deterministic
 * (depends only on the on-disk config files, no clock/network/random) and
 * total (never throws — a missing or malformed config yields an empty
 * `ProjectConfig`, which makes ModuleResolution behave exactly as the previous
 * relative-only resolver did).
 */
export const loadProjectConfig = (rootPath: string): ProjectConfig => {
    const configDir = dirOf(rootPath);
    const tsconfig = readTsConfig(configDir);
    const pkg = readPackageJson(configDir);
    const psr4 = readComposerPsr4(configDir);
    return {
        configDir,
        ...(tsconfig.baseUrl !== undefined ? {baseUrl: tsconfig.baseUrl} : {}),
        ...(tsconfig.pathsBasePath !== undefined ? {pathsBasePath: tsconfig.pathsBasePath} : {}),
        ...(tsconfig.paths !== undefined ? {paths: tsconfig.paths} : {}),
        ...(pkg.packageName !== undefined ? {packageName: pkg.packageName} : {}),
        ...(pkg.exports !== undefined ? {exports: pkg.exports} : {}),
        ...(pkg.imports !== undefined ? {imports: pkg.imports} : {}),
        ...(psr4 !== undefined ? {psr4} : {})
    };
};

/** An empty config — relative-only resolution, no tsconfig/package influence. For tests and single-file/no-config roots. */
export const EMPTY_PROJECT_CONFIG: ProjectConfig = {configDir: ''};
