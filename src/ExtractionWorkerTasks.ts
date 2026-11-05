import {parentPort, workerData} from 'node:worker_threads';
import {createAdapterRegistry, grammarOf} from './analysis/DefaultAdapters.js';
import {extractFile} from './FileExtraction.js';
import type {ExtractionReply, ExtractionTask, ExtractionWorkerConfig} from './ExtractionPool.js';
import {isHeapCritical} from './MemoryGuard.js';

/**
 * The work of one extraction worker, loaded by ExtractionWorker.ts once the
 * compile cache is on (see ExtractionPool.ts): its own adapters — and so its
 * own ts-morph Projects and tree-sitter parsers —, parsing and extracting the
 * files the pool hands it, one reply per task, in the order received. Before
 * each file it checks its own heap against the memory guard's ratio and, when
 * critical, answers `memoryCritical` instead of parsing (the pipeline then
 * stops there, as the main-thread guard does). An adapter error is sent back
 * as an error, so the run fails as it would on the main thread.
 *
 * A tree-sitter grammar (Dart, C/C++, HTML for HTML/Vue/Angular) is loaded
 * the first time a file needs it, not at start: a worker that only sees
 * TypeScript never loads one. Loading is awaited inside the one task chain,
 * so grammars still load one after another (web-tree-sitter's shared
 * `Parser.init()` is not safe to race) and a failed load leaves that
 * adapter's files unparsed, as an eager `initGrammars()` would.
 */
const port = parentPort;
if (port === null) {
    throw new Error('ExtractionWorkerTasks runs only in an extraction worker thread');
}
const config = workerData as ExtractionWorkerConfig;
const registry = createAdapterRegistry();
const loaded = new Set<() => Promise<void>>();

const handle = async (task: ExtractionTask): Promise<ExtractionReply> => {
    if (isHeapCritical(config.criticalRatio)) {
        return {index: task.index, outcome: {kind: 'memoryCritical'}};
    }
    try {
        const adapter = registry.resolve(task.meta);
        if (adapter === null) {
            throw new Error(`no adapter for ${task.meta.path}`);
        }
        const grammar = grammarOf(adapter.id);
        if (grammar !== undefined && !loaded.has(grammar)) {
            loaded.add(grammar);
            await grammar().catch(() => undefined);
        }
        return {index: task.index, outcome: extractFile(adapter, task.file, {rootDir: config.rootDir, ...(config.identityScheme !== undefined ? {identityScheme: config.identityScheme} : {})})};
    } catch (error) {
        return {index: task.index, error: error instanceof Error ? (error.stack ?? error.message) : String(error)};
    }
};

let chain: Promise<void> = Promise.resolve();
port.on('message', (task: ExtractionTask) => {
    // Test-only hook, not a documented setting: a worker that dies on its
    // first file, so the pool's crash handling is testable without
    // exhausting memory. Invisible to a normal run.
    if (process.env.STOA_TEST_WORKER_EXIT === '1') {
        process.exit(3);
    }
    chain = chain.then(async () => port.postMessage(await handle(task)));
});
