import {parentPort, workerData} from 'node:worker_threads';
import {createAdapterRegistry, initGrammars} from './analysis/DefaultAdapters.js';
import {extractFile} from './FileExtraction.js';
import type {ExtractionReply, ExtractionTask, ExtractionWorkerConfig} from './ExtractionPool.js';
import {isHeapCritical} from './MemoryGuard.js';

/**
 * One extraction worker (see ExtractionPool.ts): its own adapters — and so its
 * own ts-morph Projects and tree-sitter parsers —, parsing and extracting the
 * files the pool hands it, one reply per task. Before each file it checks its
 * own heap against the memory guard's ratio and, when critical, answers
 * `memoryCritical` instead of parsing (the pipeline then stops there, as the
 * main-thread guard does). An adapter error is sent back as an error, so the
 * run fails as it would on the main thread.
 */
const port = parentPort;
if (port === null) {
    throw new Error('ExtractionWorker runs only as a worker thread');
}
const config = workerData as ExtractionWorkerConfig;
await initGrammars();
const registry = createAdapterRegistry();

port.on('message', (task: ExtractionTask) => {
    // Test-only hook, not a documented setting: a worker that dies on its
    // first file, so the pool's crash handling is testable without
    // exhausting memory. Invisible to a normal run.
    if (process.env.STOA_TEST_WORKER_EXIT === '1') {
        process.exit(3);
    }
    let reply: ExtractionReply;
    if (isHeapCritical(config.criticalRatio)) {
        reply = {index: task.index, outcome: {kind: 'memoryCritical'}};
    } else {
        try {
            const adapter = registry.resolve(task.meta);
            if (adapter === null) {
                throw new Error(`no adapter for ${task.meta.path}`);
            }
            reply = {index: task.index, outcome: extractFile(adapter, task.file, config.rootDir)};
        } catch (error) {
            reply = {index: task.index, error: error instanceof Error ? (error.stack ?? error.message) : String(error)};
        }
    }
    port.postMessage(reply);
});
