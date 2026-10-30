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
    /**
     * Releases whatever this ONE parse result is pinning in memory (a
     * ts-morph SourceFile removed from its Project, a tree-sitter `Tree`
     * disposed via `.delete()`, …), once `extractFacts` is done with it. Set
     * by the adapter that created the handle — only it knows what backs it.
     * Called exactly once, by the pipeline, right after `extractFacts`
     * returns; omit when the handle is a plain JS object with no external
     * lifecycle to manage (nothing to call).
     */
    release?: () => void;
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
