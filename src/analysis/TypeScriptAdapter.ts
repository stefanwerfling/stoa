import {Project, ts} from 'ts-morph';
import type {SourceFile} from 'ts-morph';
import type {Fact} from '../Types.js';
import type {FileMeta, FileRef, LanguageAdapter, ParseResult, ProjectContext} from './LanguageAdapter.js';
import {extractFacts} from './typescript/TsExtraction.js';

const SUPPORTED_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

/**
 * TypeScript/JavaScript adapter. It parses each file with ts-morph (in an
 * in-memory project, so no tsconfig is required for syntactic facts) and emits
 * complexity, error-handling and dependency facts. Type-aware facts (e.g. tsc
 * diagnostics) are a separate external-tool adapter and are not produced here.
 *
 * `parse()`'s `release` removes the SourceFile from the shared Project right
 * after its facts are extracted, so AST/binder/checker state does not
 * accumulate for the whole repository (a large repo would otherwise hold
 * every file's ts-morph wrapper tree simultaneously for the entire run — see
 * docs memory-architecture). This is safe only because every analysis in
 * `./typescript/*` that needs ts-morph's Symbol/Type APIs (ValidationDataflow,
 * OneHopResolution, SymbolResolution, SafeParseGuard, BackendValidation) is
 * documented and tested as SAME-FILE ONLY — nothing here resolves a symbol
 * across two files, so no file needs a sibling's SourceFile to still be
 * registered once its own facts have been extracted. If cross-file
 * resolution is ever added, it must build its multi-file scope deliberately
 * (e.g. hold a small, explicit group of SourceFiles for the files it
 * actually needs) rather than relying on this adapter's Project to still
 * contain everything.
 *
 * An ES module gets a Project of its own without the lib files: its facts are
 * the same, and releasing it is dropping the reference — no per-node
 * `forget()` walk, no lib files in a shared Program. That holds because every
 * symbol question in `./typescript/*` either compares against a binding
 * declared in this file (`isSameBinding`'s second argument, the export
 * symbols of `isExported()`), accepts only declarations from this file
 * (`resolveOneHop`) or needs a `const` with an initializer (`resolveSimpleAlias`,
 * the Zod shape) — and in a module a local binding never merges with a lib
 * global, while lib declarations are ambient, without initializers, in another
 * file. A script (no import/export — its top-level names DO merge with lib
 * globals, e.g. `var name`) and a file with `declare global` keep the shared
 * Project with the lib files and the `removeSourceFile` release.
 */
export class TypeScriptAdapter implements LanguageAdapter {
    public readonly id = 'typescript';
    public readonly version = '0.2.0';

    private readonly project: Project;

    public constructor() {
        this.project = new Project({useInMemoryFileSystem: true, compilerOptions: {allowJs: true}});
    }

    public supports(file: FileMeta): boolean {
        return SUPPORTED_EXTENSIONS.some((ext) => file.path.endsWith(ext));
    }

    public parse(file: FileRef): ParseResult {
        const own = new Project({useInMemoryFileSystem: true, skipLoadingLibFiles: true, compilerOptions: {allowJs: true}});
        const module = own.createSourceFile(file.path, file.content);
        if (ts.isExternalModule(module.compilerNode) && !file.content.includes('declare global')) {
            return {file, ok: true, diagnostics: [], handle: module, release: () => undefined};
        }
        const sourceFile = this.project.createSourceFile(file.path, file.content, {overwrite: true});
        return {file, ok: true, diagnostics: [], handle: sourceFile, release: () => this.project.removeSourceFile(sourceFile)};
    }

    public extractFacts(parsed: ParseResult, _ctx: ProjectContext): Fact[] {
        if (!parsed.ok || parsed.handle === undefined) {
            return [];
        }
        return extractFacts(parsed.handle as SourceFile, {id: this.id, version: this.version});
    }
}
