import {existsSync, readFileSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {ts} from 'ts-morph';

/**
 * The project-level configuration that INFLUENCES module resolution — read
 * once, up front, from the analysis root (see ModuleResolution.ts). This is
 * Phase 0 of the "Config-Aware Module Resolution" work: deliberately narrow,
 * deterministic, and fail-safe. It reads ONLY `tsconfig.json` (with its
 * `extends` chain, resolved by TypeScript's own config parser) and the root
 * `package.json` — it never walks `node_modules`, never touches the network,
 * and never guesses. Any read/parse error degrades to an empty config (no
 * alias/exports resolution), never an exception: a broken or absent config
 * must weaken resolution to "relative-only", not abort the analysis.
 */
export interface ProjectConfig {
    /** The directory the config is anchored at (the analysis root, or a single file's directory). */
    configDir: string;
    /** Absolute `compilerOptions.baseUrl`, if tsconfig declared one. */
    baseUrl?: string;
    /** `compilerOptions.paths` exactly as TypeScript resolved them (after `extends`). Patterns relative to `baseUrl` (or `configDir` when no `baseUrl`). */
    paths?: Record<string, string[]>;
    /** Root `package.json` `name`, used to recognize a self-referential import (`import x from "my-pkg/sub"`). */
    packageName?: string;
    /** Raw `package.json` `exports` field (string | object), consulted conservatively — see ModuleResolution.ts. */
    exports?: unknown;
    /** Raw `package.json` `imports` field (`#`-prefixed subpath imports), consulted conservatively — see ModuleResolution.ts. */
    imports?: unknown;
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
const readTsConfig = (configDir: string): {baseUrl?: string; paths?: Record<string, string[]>} => {
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
        const result: {baseUrl?: string; paths?: Record<string, string[]>} = {};
        if (typeof options.baseUrl === 'string') {
            result.baseUrl = options.baseUrl;
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
    return {
        configDir,
        ...(tsconfig.baseUrl !== undefined ? {baseUrl: tsconfig.baseUrl} : {}),
        ...(tsconfig.paths !== undefined ? {paths: tsconfig.paths} : {}),
        ...(pkg.packageName !== undefined ? {packageName: pkg.packageName} : {}),
        ...(pkg.exports !== undefined ? {exports: pkg.exports} : {}),
        ...(pkg.imports !== undefined ? {imports: pkg.imports} : {})
    };
};

/** An empty config — relative-only resolution, no tsconfig/package influence. For tests and single-file/no-config roots. */
export const EMPTY_PROJECT_CONFIG: ProjectConfig = {configDir: ''};
