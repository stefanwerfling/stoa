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
        return {file, ok: true, diagnostics: [], handle: sourceFile};
    }

    public extractFacts(parsed: ParseResult, _ctx: ProjectContext): Fact[] {
        if (!parsed.ok || parsed.handle === undefined) {
            return [];
        }
        return extractFacts(parsed.handle as SourceFile, {id: this.id, version: this.version});
    }
}
