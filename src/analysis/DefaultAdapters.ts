import {AdapterRegistry} from './AdapterRegistry.js';
import {AngularAdapter} from './AngularAdapter.js';
import {CppAdapter, initCpp} from './CppAdapter.js';
import {DartAdapter, initDart} from './DartAdapter.js';
import {HtmlAdapter, initHtml} from './HtmlAdapter.js';
import {PhpAdapter} from './PhpAdapter.js';
import {TypeScriptAdapter} from './TypeScriptAdapter.js';
import {VueAdapter} from './VueAdapter.js';

/**
 * The analysis' language adapters, in precedence order (the first that
 * supports a file wins). One function for the pipeline and for every
 * extraction worker, so both resolve a path to the same adapter.
 */
export const createAdapterRegistry = (): AdapterRegistry =>
    new AdapterRegistry()
        .register(new TypeScriptAdapter())
        .register(new PhpAdapter())
        .register(new DartAdapter())
        .register(new CppAdapter())
        .register(new AngularAdapter())
        .register(new HtmlAdapter())
        .register(new VueAdapter());

/**
 * Loads the tree-sitter (WASM) grammars of the Dart, C/C++ and HTML adapters
 * once per thread. Sequentially, not concurrently: all of them call the shared
 * web-tree-sitter `Parser.init()`, which is not safe to race. A grammar that
 * fails to load leaves its files unparsed (skipped), as before.
 */
export const initGrammars = async (): Promise<void> => {
    await initDart().catch(() => undefined);
    await initCpp().catch(() => undefined);
    await initHtml().catch(() => undefined);
};
