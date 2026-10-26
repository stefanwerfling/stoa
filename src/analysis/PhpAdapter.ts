import {Engine} from 'php-parser';
import type {Fact} from '../Types.js';
import type {FileRef, LanguageAdapter, ParseResult, ProjectContext} from './LanguageAdapter.js';
import {extractFacts, type PhpNode} from './php/PhpExtraction.js';

/**
 * PHP adapter. It parses with the pure-JavaScript glayzzle php-parser (no PHP
 * runtime or Composer required), so analysis stays in-process and deterministic,
 * and emits the same language-neutral facts as the TypeScript adapter. This is a
 * deliberate deviation from the tentative nikic/php-parser subprocess bridge
 * (see docs technology-decision / open-questions OQ-3); the fact schema is
 * identical either way, so the choice is revisable.
 */
export class PhpAdapter implements LanguageAdapter {
    public readonly id = 'php';
    public readonly version = '0.1.0';

    private readonly engine: Engine;

    public constructor() {
        this.engine = new Engine({parser: {extractDoc: true}, ast: {withPositions: true}});
    }

    public supports(file: FileRef): boolean {
        return file.path.endsWith('.php');
    }

    public parse(file: FileRef): ParseResult {
        try {
            const program = this.engine.parseCode(file.content, file.path) as unknown as PhpNode;
            return {file, ok: true, diagnostics: [], handle: program};
        } catch (error) {
            return {file, ok: false, diagnostics: [String(error)]};
        }
    }

    public extractFacts(parsed: ParseResult, _ctx: ProjectContext): Fact[] {
        if (!parsed.ok || parsed.handle === undefined) {
            return [];
        }
        return extractFacts(parsed.handle as PhpNode, parsed.file.content, parsed.file.path, {
            id: this.id,
            version: this.version
        });
    }
}
