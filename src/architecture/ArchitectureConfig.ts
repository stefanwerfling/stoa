import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Options, ValidateFunction} from 'ajv/dist/2020.js';
import picomatch from 'picomatch';
import type {ArchitectureSummary} from '../Types.js';

/**
 * Architecture config R6 (Flutter quality track E5b, stage 2 of the DIP layer
 * rule): the user DECLARES the layers (`stoa.architecture.json`, schema
 * `schemas/architecture.schema.json`, CLI `--architecture <file>`).
 *
 * Semantics:
 * - A file belongs to the FIRST layer whose `include` globs match its path
 *   relative to the analysis root (POSIX, picomatch, dotfiles included); a
 *   file matching more than one layer is a configuration warning.
 * - An edge within one layer is always allowed; an edge between two layers is
 *   allowed only when `allow` lists it; an edge with an end outside every
 *   layer is unknown — never a violation.
 * - `forbidPackages` bans external packages for the files of a layer.
 *
 * Loading fails fast (invalid JSON, schema violation, duplicate layer names);
 * a reference to an undeclared layer in `allow`/`forbidPackages` is only a
 * warning — it simply never matches. Nothing here reads code: the model
 * answers questions about paths, layer names and package names; the rule
 * (E6d) asks them for ModuleGraph edges and imports.
 */

type Ajv2020Constructor = new (options?: Options) => {compile: (schema: object) => ValidateFunction};
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js') as Ajv2020Constructor;

const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas', 'architecture.schema.json');

let validator: ValidateFunction | null = null;
const configValidator = (): ValidateFunction => {
    if (validator === null) {
        validator = new Ajv2020({allErrors: true, strict: false}).compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object);
    }
    return validator;
};

export interface ArchitectureLayer {
    name: string;
    include: string[];
}

export interface ArchitectureAllow {
    from: string;
    to: string;
}

export interface ArchitecturePackageBan {
    layer: string;
    packages: string[];
}

export interface ArchitectureConfig {
    path: string;
    version: string;
    layers: ArchitectureLayer[];
    allow: ArchitectureAllow[];
    forbidPackages: ArchitecturePackageBan[];
    /** References to undeclared layers in `allow`/`forbidPackages` (never match), sorted. */
    unknownLayerReferences: string[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Loads and validates an architecture config; throws with the concrete problem. */
export const loadArchitectureConfig = (path: string): ArchitectureConfig => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        throw new Error(`architecture config ${path} is not valid JSON: ${(error as Error).message}`);
    }
    const validate = configValidator();
    if (!validate(parsed)) {
        const details = (validate.errors ?? []).map((error) => `${error.instancePath === '' ? '/' : error.instancePath} ${error.message ?? 'invalid'}`).join('; ');
        throw new Error(`architecture config ${path} does not match architecture.schema.json: ${details}`);
    }
    const data = parsed as {version: string; layers: ArchitectureLayer[]; allow?: ArchitectureAllow[]; forbidPackages?: ArchitecturePackageBan[]};
    const names = data.layers.map((layer) => layer.name);
    const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))].sort(compareText);
    if (duplicates.length > 0) {
        throw new Error(`architecture config ${path} declares layer(s) more than once: ${duplicates.join(', ')}`);
    }
    const allow = data.allow ?? [];
    const forbidPackages = data.forbidPackages ?? [];
    const declared = new Set(names);
    const referenced = [...allow.flatMap((edge) => [edge.from, edge.to]), ...forbidPackages.map((ban) => ban.layer)];
    return {
        path,
        version: data.version,
        layers: data.layers,
        allow,
        forbidPackages,
        unknownLayerReferences: [...new Set(referenced.filter((name) => !declared.has(name)))].sort(compareText)
    };
};

export type EdgeVerdict = 'same-layer' | 'allowed' | 'forbidden' | 'unknown';

export interface LayerAssignment {
    /** The first matching layer, or null (unknown). */
    layer: string | null;
    /** Every matching layer in config order (more than one = a configuration warning). */
    matches: string[];
}

/** At most this many multi-match files are listed in the summary (the count is always complete). */
export const MULTIPLE_MATCH_SAMPLE_LIMIT = 20;

/**
 * The package a module specifier names, or null for a relative/absolute path
 * or a project-internal Dart `package:` URI (`ownPackages`). `package:http/x.dart`
 * → `http`; `dart:io` → `dart:io`; `axios/lib/x` → `axios`; `@scope/name/x` →
 * `@scope/name`.
 */
export const packageNameOf = (specifier: string, ownPackages: ReadonlySet<string> = new Set()): string | null => {
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.length === 0) {
        return null;
    }
    if (specifier.startsWith('dart:')) {
        return specifier;
    }
    if (specifier.startsWith('package:')) {
        const name = specifier.slice('package:'.length).split('/')[0] ?? '';
        return name === '' || ownPackages.has(name) ? null : name;
    }
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null) : (parts[0] ?? null);
};

export class ArchitectureModel {
    private readonly matchers: {name: string; match: (path: string) => boolean}[];
    private readonly allowed: Set<string>;
    private readonly bans = new Map<string, Set<string>>();
    private readonly cache = new Map<string, LayerAssignment>();

    public constructor(
        public readonly config: ArchitectureConfig,
        private readonly rootPath: string
    ) {
        this.matchers = config.layers.map((layer) => ({name: layer.name, match: picomatch(layer.include, {dot: true})}));
        this.allowed = new Set(config.allow.map((edge) => `${edge.from}\n${edge.to}`));
        for (const ban of config.forbidPackages) {
            const packages = this.bans.get(ban.layer) ?? new Set<string>();
            ban.packages.forEach((name) => packages.add(name));
            this.bans.set(ban.layer, packages);
        }
    }

    /** The path of `file` relative to the analysis root, POSIX-style (the form the globs are written in). */
    public relativePath(file: string): string {
        return relative(this.rootPath, file).split(sep).join('/');
    }

    public assignment(file: string): LayerAssignment {
        let result = this.cache.get(file);
        if (result === undefined) {
            const path = this.relativePath(file);
            const matches = path.startsWith('../') ? [] : this.matchers.filter((matcher) => matcher.match(path)).map((matcher) => matcher.name);
            result = {layer: matches[0] ?? null, matches};
            this.cache.set(file, result);
        }
        return result;
    }

    public layerOf(file: string): string | null {
        return this.assignment(file).layer;
    }

    /** The verdict for a dependency of `from` on `to` (both analyzed files). */
    public edgeVerdict(from: string, to: string): EdgeVerdict {
        const fromLayer = this.layerOf(from);
        const toLayer = this.layerOf(to);
        if (fromLayer === null || toLayer === null) {
            return 'unknown';
        }
        if (fromLayer === toLayer) {
            return 'same-layer';
        }
        return this.allowed.has(`${fromLayer}\n${toLayer}`) ? 'allowed' : 'forbidden';
    }

    /** True when `file`'s layer bans `packageName` (see `packageNameOf`); a file without a layer bans nothing. */
    public isPackageForbidden(file: string, packageName: string): boolean {
        const layer = this.layerOf(file);
        return layer !== null && (this.bans.get(layer)?.has(packageName) ?? false);
    }

    /** What the report shows: layer sizes, unassigned files and configuration warnings over the analyzed files. */
    public summarize(files: Iterable<string>): ArchitectureSummary {
        const counts = new Map(this.config.layers.map((layer) => [layer.name, 0]));
        let unassigned = 0;
        const multiple: {file: string; layers: string[]}[] = [];
        for (const file of [...files].sort(compareText)) {
            const {layer, matches} = this.assignment(file);
            if (layer === null) {
                unassigned++;
                continue;
            }
            counts.set(layer, (counts.get(layer) ?? 0) + 1);
            if (matches.length > 1) {
                multiple.push({file: this.relativePath(file), layers: matches});
            }
        }
        return {
            path: this.config.path,
            version: this.config.version,
            layers: this.config.layers.map((layer) => ({name: layer.name, files: counts.get(layer.name) ?? 0})),
            unassignedFiles: unassigned,
            warnings: {
                multipleMatchCount: multiple.length,
                multipleMatchSample: multiple.slice(0, MULTIPLE_MATCH_SAMPLE_LIMIT),
                emptyLayers: this.config.layers.filter((layer) => (counts.get(layer.name) ?? 0) === 0).map((layer) => layer.name),
                unknownLayerReferences: this.config.unknownLayerReferences
            }
        };
    }
}
