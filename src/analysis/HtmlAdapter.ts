import {createRequire} from 'node:module';
import {Language, Parser, type Node} from 'web-tree-sitter';
import type {Fact} from '../Types.js';
import {extractFacts} from './html/HtmlExtraction.js';
import type {FileRef, LanguageAdapter, ParseResult, ProjectContext} from './LanguageAdapter.js';

const require = createRequire(import.meta.url);

// tree-sitter needs an async WASM load; the pipeline is synchronous, so the
// grammar is loaded once via initHtml() (awaited by the async CLI, together with
// the other tree-sitter grammars — sequentially, since the shared Parser.init()
// is not safe to race). Until then HTML files are reported unparsed and skipped.
let parser: Parser | null = null;

export const initHtml = async (): Promise<void> => {
    if (parser !== null) {
        return;
    }
    await Parser.init();
    const language = await Language.load(require.resolve('tree-sitter-html/tree-sitter-html.wasm'));
    const instance = new Parser();
    instance.setLanguage(language);
    parser = instance;
};

/**
 * Static HTML UI adapter. Parses markup with tree-sitter (in-process WASM) and
 * emits verifiable accessibility facts (image/control naming). It is purely
 * static — no rendering, CSS cascade or contrast — so checks that need a
 * rendered page are out of scope here and handled (later) by a visual analyser.
 */
export class HtmlAdapter implements LanguageAdapter {
    public readonly id = 'html';
    public readonly version = '0.1.0';

    public supports(file: FileRef): boolean {
        return file.path.endsWith('.html') || file.path.endsWith('.htm');
    }

    public parse(file: FileRef): ParseResult {
        if (parser === null) {
            return {file, ok: false, diagnostics: ['html parser not initialized; call initHtml() before analyze()']};
        }
        const tree = parser.parse(file.content);
        if (tree === null) {
            return {file, ok: false, diagnostics: ['html parse produced no tree']};
        }
        return {file, ok: true, diagnostics: [], handle: tree.rootNode};
    }

    public extractFacts(parsed: ParseResult, _ctx: ProjectContext): Fact[] {
        if (parsed.handle === undefined) {
            return [];
        }
        return extractFacts(parsed.handle as Node, parsed.file.content, parsed.file.path, {id: this.id, version: this.version});
    }
}
