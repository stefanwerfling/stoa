import {createRequire} from 'node:module';
import {Language, Parser, type Node} from 'web-tree-sitter';
import type {Fact} from '../Types.js';
import {extractFacts} from './dart/DartExtraction.js';
import type {FileMeta, FileRef, LanguageAdapter, ParseResult, ProjectContext} from './LanguageAdapter.js';
import {assignSiteSymbols, schemeOf} from './SiteIdentity.js';

const require = createRequire(import.meta.url);

// tree-sitter needs an async WASM load, but the analysis pipeline is synchronous.
// The grammar is loaded once up front via initDart(); afterwards parse() is
// synchronous. Until it is initialized, Dart files are reported unparsed (and
// therefore skipped) rather than crashing a run.
let parser: Parser | null = null;

export const initDart = async (): Promise<void> => {
    if (parser !== null) {
        return;
    }
    await Parser.init();
    const language = await Language.load(require.resolve('tree-sitter-dart/tree-sitter-dart.wasm'));
    const instance = new Parser();
    instance.setLanguage(language);
    parser = instance;
};

/**
 * Dart (Flutter) adapter. It parses with tree-sitter (web-tree-sitter, pure WASM,
 * in-process — no subprocess) and emits the same language-neutral facts as the
 * other adapters, so the metric and error-handling rules apply unchanged.
 */
export class DartAdapter implements LanguageAdapter {
    public readonly id = 'dart';
    public readonly version = '0.1.0';

    public supports(file: FileMeta): boolean {
        return file.path.endsWith('.dart');
    }

    public parse(file: FileRef): ParseResult {
        if (parser === null) {
            return {file, ok: false, diagnostics: ['dart parser not initialized; call initDart() before analyze()']};
        }
        const tree = parser.parse(file.content);
        if (tree === null) {
            return {file, ok: false, diagnostics: ['dart parse produced no tree']};
        }
        return {file, ok: true, diagnostics: [], handle: tree.rootNode, release: () => tree.delete()};
    }

    public extractFacts(parsed: ParseResult, ctx: ProjectContext): Fact[] {
        if (parsed.handle === undefined) {
            return [];
        }
        return assignSiteSymbols(extractFacts(parsed.handle as Node, parsed.file.content, parsed.file.path, {id: this.id, version: this.version, ...schemeOf(ctx)}), ctx.identityScheme);
    }
}
