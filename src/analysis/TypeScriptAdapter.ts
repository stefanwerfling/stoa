import type {Fact} from '../Types.js';
import type {FileRef, LanguageAdapter, ParseResult, ProjectContext} from './LanguageAdapter.js';

const SUPPORTED_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

/**
 * M1 skeleton adapter. It selects TypeScript/JavaScript files and emits a single
 * trivially-correct syntactic fact per file (its line count). Real AST, control-
 * flow, dependency and error-handling extraction via the TypeScript Compiler API
 * / ts-morph arrives in M2; this stub keeps the pipeline runnable end-to-end.
 */
export class TypeScriptAdapter implements LanguageAdapter {
    public readonly id = 'typescript';
    public readonly version = '0.1.0';

    public supports(file: FileRef): boolean {
        return SUPPORTED_EXTENSIONS.some((ext) => file.path.endsWith(ext));
    }

    public parse(file: FileRef): ParseResult {
        // M1: no real parse yet; a supported file is treated as parseable.
        return {file, ok: true, diagnostics: []};
    }

    public extractFacts(parsed: ParseResult, _ctx: ProjectContext): Fact[] {
        if (!parsed.ok) {
            return [];
        }

        const lineCount = countLines(parsed.file.content);
        const fact: Fact = {
            id: `fact:${parsed.file.path}:file.lineCount`,
            kind: 'file.lineCount',
            subject: {
                file: parsed.file.path,
                kindOf: 'file',
                range: {startLine: 1, startCol: 0, endLine: Math.max(lineCount, 1), endCol: 0}
            },
            value: lineCount,
            evidence: [{source: 'metric', detail: 'line count'}],
            certainty: 'syntactic',
            producedBy: {adapter: this.id, version: this.version}
        };
        return [fact];
    }
}

const countLines = (content: string): number => {
    if (content.length === 0) {
        return 0;
    }
    return content.split('\n').length;
};
