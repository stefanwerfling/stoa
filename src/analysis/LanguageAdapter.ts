import type {Fact} from '../Types.js';

export interface FileRef {
    path: string;
    content: string;
}

export interface ParseResult {
    file: FileRef;
    ok: boolean;
    diagnostics: string[];
    /** Adapter-specific parse handle (e.g. a ts-morph SourceFile) for extractFacts. */
    handle?: unknown;
}

export interface ProjectContext {
    rootDir: string;
}

/**
 * A language adapter turns source files into normalized facts. It is the only
 * place that knows a concrete language; everything downstream sees facts only.
 * See docs architecture §A.
 */
export interface LanguageAdapter {
    readonly id: string;
    readonly version: string;
    supports(file: FileRef): boolean;
    parse(file: FileRef): ParseResult;
    extractFacts(parsed: ParseResult, ctx: ProjectContext): Fact[];
}
