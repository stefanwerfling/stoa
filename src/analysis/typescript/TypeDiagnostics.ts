import {dirname, join, resolve} from 'node:path';
import {Node, Project, SyntaxKind, ts} from 'ts-morph';
import type {ExpressionStatement, SourceFile} from 'ts-morph';
import type {Fact, SourceRange} from '../../Types.js';
import {factBuilder} from '../FactBuilder.js';
import type {FileRef} from '../LanguageAdapter.js';

// Robustness-relevant, resolution-independent diagnostic codes. Module/name
// resolution codes (e.g. 2307 "cannot find module") are deliberately excluded so
// that checking a file without its imports resolved does not produce noise.
const ROBUSTNESS_CODES: ReadonlySet<number> = new Set([
    2322, // type not assignable
    2345, // argument not assignable
    2366, // not all code paths return a value
    2454, // used before being assigned
    2531, // object is possibly 'null'
    2532, // object is possibly 'undefined'
    2533, // object is possibly 'null' or 'undefined'
    18047, // possibly 'null'
    18048 // possibly 'undefined'
]);

// At most this many tsconfig-scoped Projects are held at once. Each one keeps
// the program for its project (the analyzed files plus their transitive
// imports) alive; analysis is file-ordered, so files of one project arrive
// together and a small LRU bounds memory without re-building programs.
const MAX_PROJECTS = 4;

// Used only for a file with NO tsconfig.json anywhere above it — the
// equivalent of `tsc --strict <file>`: imports still resolve from disk.
const FALLBACK_OPTIONS: ts.CompilerOptions = {
    strict: true,
    noImplicitReturns: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.full.d.ts'],
    noEmit: true,
    skipLibCheck: true
};
const FALLBACK_KEY = '<no-tsconfig>';

interface ParsedProject {
    options: ts.CompilerOptions;
    fileNames: ReadonlySet<string>;
    references: readonly string[];
}

/**
 * External-tool fact source: runs the TypeScript type checker in-process (via
 * ts-morph — no subprocess) and emits `external.tsc` facts for a curated set of
 * robustness-relevant diagnostics. Opt-in. Integrates a mature tool rather than
 * reimplementing type inference (N3).
 *
 * Parity with `tsc -p <nearest tsconfig>`: each file is checked inside the
 * project of the nearest `tsconfig.json` above it (loaded with
 * `ts.parseJsonConfigFileContent`, so `extends`, `lib`, `module`/
 * `moduleResolution`, `paths` and `include`/`exclude` all apply), on the real
 * file system, so imports resolve exactly as the compiler resolves them.
 * Checking a file in isolation instead degrades every import to `any`, which
 * produced false `unknown` diagnostics (e.g. `Object.entries` over an imported
 * Record). Membership follows the compiler:
 *  - the nearest tsconfig (or a project it `references`) lists the file → it
 *    is checked with that project's options;
 *  - a tsconfig exists but no reachable project lists the file (e.g. tests
 *    outside `include`) → NOT checked: `tsc -p` does not check it either;
 *  - no tsconfig anywhere above the file → checked with strict defaults, like
 *    `tsc --strict <file>`.
 * The checker is the TypeScript version bundled with stoa, not the analyzed
 * project's own — a documented limitation.
 */
export class TypeDiagnosticsExtractor {
    public readonly id = 'tsc';
    public readonly version = ts.version;

    private readonly nearestConfig = new Map<string, string | null>();
    private readonly parsedConfigs = new Map<string, ParsedProject | null>();
    private readonly projects = new Map<string, Project>();

    public extract(file: FileRef): Fact[] {
        const absolute = resolve(file.path);
        const owner = this.ownerOf(absolute);
        if (owner === null) {
            return [];
        }
        const sourceFile = this.projectFor(owner).createSourceFile(absolute, file.content, {overwrite: true});
        const build = factBuilder({id: this.id, version: this.version}, file.path);
        const facts: Fact[] = [];

        let index = 0;
        for (const diagnostic of sourceFile.getPreEmitDiagnostics()) {
            const code = diagnostic.getCode();
            if (!ROBUSTNESS_CODES.has(code)) {
                continue;
            }
            const message = ts.flattenDiagnosticMessageText(diagnostic.compilerObject.messageText, ' ');
            facts.push(
                build({
                    kind: 'external.tsc',
                    kindOf: 'statement',
                    symbol: `tsc#${index}`,
                    range: rangeOf(sourceFile, diagnostic.getStart(), diagnostic.getLength() ?? 0),
                    value: `[${code}] ${message}`,
                    certainty: 'external-tool',
                    evidenceSource: 'external-tool'
                })
            );
            index += 1;
        }

        let promiseIndex = 0;
        for (const statement of sourceFile.getDescendantsOfKind(SyntaxKind.ExpressionStatement)) {
            const callee = floatingPromiseCallee(statement);
            if (callee === null) {
                continue;
            }
            facts.push(
                build({
                    kind: 'external.floatingPromise',
                    kindOf: 'statement',
                    symbol: `promise#${promiseIndex}`,
                    range: rangeOf(sourceFile, statement.getStart(), statement.getWidth()),
                    value: callee,
                    certainty: 'external-tool',
                    evidenceSource: 'external-tool'
                })
            );
            promiseIndex += 1;
        }

        // The file stays in its Project: it is part of that program anyway (as
        // a root here, or as an import of a later file), so removing it would
        // only force a re-read from disk.
        return facts;
    }

    // The tsconfig whose project checks `path` — FALLBACK_KEY when there is no
    // tsconfig above it, null when one exists but no reachable project lists
    // the file (tsc -p would not check it).
    private ownerOf(path: string): string | null {
        const nearest = this.findNearestConfig(dirname(path));
        if (nearest === null) {
            return FALLBACK_KEY;
        }
        const queue = [nearest];
        const visited = new Set<string>();
        while (queue.length > 0) {
            const configPath = queue.shift() as string;
            if (visited.has(configPath)) {
                continue;
            }
            visited.add(configPath);
            const parsed = this.parseConfig(configPath);
            if (parsed === null) {
                continue;
            }
            if (parsed.fileNames.has(path)) {
                return configPath;
            }
            queue.push(...parsed.references);
        }
        return null;
    }

    private findNearestConfig(dir: string): string | null {
        const cached = this.nearestConfig.get(dir);
        if (cached !== undefined) {
            return cached;
        }
        const found = ts.findConfigFile(dir, ts.sys.fileExists, 'tsconfig.json') ?? null;
        const nearest = found === null ? null : resolve(found);
        this.nearestConfig.set(dir, nearest);
        return nearest;
    }

    private parseConfig(configPath: string): ParsedProject | null {
        const cached = this.parsedConfigs.get(configPath);
        if (cached !== undefined) {
            return cached;
        }
        const read = ts.readConfigFile(configPath, ts.sys.readFile);
        let parsed: ParsedProject | null = null;
        if (read.error === undefined) {
            const config = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath);
            parsed = {
                options: {...config.options, noEmit: true},
                fileNames: new Set(config.fileNames.map((name) => resolve(name))),
                references: (config.projectReferences ?? []).map((reference) => {
                    const target = resolve(reference.path);
                    return ts.sys.directoryExists(target) ? join(target, 'tsconfig.json') : target;
                })
            };
        }
        this.parsedConfigs.set(configPath, parsed);
        return parsed;
    }

    private projectFor(key: string): Project {
        const existing = this.projects.get(key);
        if (existing !== undefined) {
            // Re-insert to mark as most recently used.
            this.projects.delete(key);
            this.projects.set(key, existing);
            return existing;
        }
        const options = key === FALLBACK_KEY ? FALLBACK_OPTIONS : (this.parseConfig(key)?.options ?? FALLBACK_OPTIONS);
        const project = new Project({compilerOptions: options, skipAddingFilesFromTsConfig: true});
        this.projects.set(key, project);
        if (this.projects.size > MAX_PROJECTS) {
            const oldest = this.projects.keys().next().value as string;
            this.projects.delete(oldest);
        }
        return project;
    }
}

// The check @typescript-eslint/no-floating-promises performs, done type-aware
// in-process: a bare call statement whose result is a Promise, where the
// rejection is not handled (not awaited/returned/assigned — those are not
// expression statements — and not a .catch/.finally chain or an explicit void).
const floatingPromiseCallee = (statement: ExpressionStatement): string | null => {
    const expression = statement.getExpression();
    if (!Node.isCallExpression(expression)) {
        return null;
    }
    const callee = expression.getExpression();
    if (Node.isPropertyAccessExpression(callee)) {
        const name = callee.getName();
        if (name === 'catch' || name === 'finally') {
            return null;
        }
    }
    const type = expression.getType();
    const typeText = type.getText();
    const isPromise = type.getSymbol()?.getName() === 'Promise' || typeText === 'Promise' || typeText.startsWith('Promise<');
    return isPromise ? callee.getText() : null;
};

const rangeOf = (sourceFile: SourceFile, start: number | undefined, length: number): SourceRange => {
    if (start === undefined) {
        return {startLine: 1, startCol: 0, endLine: 1, endCol: 0};
    }
    const from = sourceFile.getLineAndColumnAtPos(start);
    const to = sourceFile.getLineAndColumnAtPos(start + length);
    return {startLine: from.line, startCol: from.column, endLine: to.line, endCol: to.column};
};
