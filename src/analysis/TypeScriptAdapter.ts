import {Project} from 'ts-morph';
import type {SourceFile} from 'ts-morph';
import type {Fact} from '../Types.js';
import type {FileRef, LanguageAdapter, ParseResult, ProjectContext} from './LanguageAdapter.js';
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
 */
export class TypeScriptAdapter implements LanguageAdapter {
    public readonly id = 'typescript';
    public readonly version = '0.2.0';

    private readonly project: Project;

    public constructor() {
        this.project = new Project({useInMemoryFileSystem: true, compilerOptions: {allowJs: true}});
    }

    public supports(file: FileRef): boolean {
        return SUPPORTED_EXTENSIONS.some((ext) => file.path.endsWith(ext));
    }

    public parse(file: FileRef): ParseResult {
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
