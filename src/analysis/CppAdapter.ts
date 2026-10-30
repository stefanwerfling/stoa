import {createRequire} from 'node:module';
import {Language, Parser, type Node} from 'web-tree-sitter';
import type {Fact} from '../Types.js';
import {extractFacts} from './cpp/CppExtraction.js';
import type {FileRef, LanguageAdapter, ParseResult, ProjectContext} from './LanguageAdapter.js';

const require = createRequire(import.meta.url);

// Like the Dart adapter, tree-sitter needs an async WASM load up front; after
// initCpp() the parsers are reused synchronously. Two grammars are loaded (C and
// C++) and chosen per file extension.
let cParser: Parser | null = null;
let cppParser: Parser | null = null;

export const initCpp = async (): Promise<void> => {
    if (cParser !== null && cppParser !== null) {
        return;
    }
    await Parser.init();
    const c = await Language.load(require.resolve('tree-sitter-c/tree-sitter-c.wasm'));
    const cpp = await Language.load(require.resolve('tree-sitter-cpp/tree-sitter-cpp.wasm'));
    const cInstance = new Parser();
    cInstance.setLanguage(c);
    const cppInstance = new Parser();
    cppInstance.setLanguage(cpp);
    cParser = cInstance;
    cppParser = cppInstance;
};

const C_EXTENSIONS: readonly string[] = ['.c'];
const CPP_EXTENSIONS: readonly string[] = ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++'];

/**
 * C/C++ adapter. It parses with tree-sitter (web-tree-sitter, pure WASM,
 * in-process) and emits the language-neutral metric facts, plus error-handling
 * facts for C++ try/catch (C has neither, so only metrics apply there). A plain
 * `.c` uses the C grammar; everything else (including `.h`) uses C++.
 */
export class CppAdapter implements LanguageAdapter {
    public readonly id = 'cpp';
    public readonly version = '0.1.0';

    public supports(file: FileRef): boolean {
        return C_EXTENSIONS.some((ext) => file.path.endsWith(ext)) || CPP_EXTENSIONS.some((ext) => file.path.endsWith(ext)) || file.path.endsWith('.h');
    }

    public parse(file: FileRef): ParseResult {
        const parser = C_EXTENSIONS.some((ext) => file.path.endsWith(ext)) ? cParser : cppParser;
        if (parser === null) {
            return {file, ok: false, diagnostics: ['c/c++ parser not initialized; call initCpp() before analyze()']};
        }
        const tree = parser.parse(file.content);
        if (tree === null) {
            return {file, ok: false, diagnostics: ['c/c++ parse produced no tree']};
        }
        return {file, ok: true, diagnostics: [], handle: tree.rootNode, release: () => tree.delete()};
    }

    public extractFacts(parsed: ParseResult, _ctx: ProjectContext): Fact[] {
        if (parsed.handle === undefined) {
            return [];
        }
        return extractFacts(parsed.handle as Node, parsed.file.content, parsed.file.path, {id: this.id, version: this.version});
    }
}
