import {Worker} from 'node:worker_threads';
import type {FileMeta, FileRef} from './analysis/LanguageAdapter.js';
import type {IdentityScheme} from './FindingIdentity.js';
import type {FileOutcome} from './FileExtraction.js';

/** What every extraction worker is started with. */
export interface ExtractionWorkerConfig {
    rootDir: string;
    /** The finding-identity scheme to extract under (AnalyzeOptions.identityScheme); the current one when absent. */
    identityScheme?: IdentityScheme;
    /** The memory guard's ratio, checked by the worker against its own heap before each file. */
    criticalRatio: number;
}

/** One file to parse and extract; `index` is its position in the run's file list. */
export interface ExtractionTask {
    index: number;
    meta: FileMeta;
    file: FileRef;
}

export type ExtractionReply = {index: number; outcome: FileOutcome} | {index: number; error: string};

interface Pending {
    resolve: (outcome: FileOutcome) => void;
    reject: (error: Error) => void;
}

interface PoolWorker {
    worker: Worker;
    /** Tasks sent to this worker and not yet answered, by file index. */
    pending: Map<number, Pending>;
}

/** Tasks in flight per worker: one being worked on, one waiting, so a worker never idles on a message round trip. */
const TASKS_PER_WORKER = 2;

/**
 * Parses and extracts files on up to `size` worker threads (`--jobs`, see
 * Pipeline.ts `analyzeAsync`). Workers start with `start()` or on demand, and
 * each gets at most TASKS_PER_WORKER files at a time;
 * the rest wait here, in the order they were handed in. Every result is a
 * `FileOutcome`; the caller applies them in file order, so which worker
 * finished first never shows in the report.
 *
 * A worker that fails (an uncaught error, or an exit while it still owes
 * answers — e.g. its heap ran out) fails the pool: every open and later task
 * is rejected with that error, so the run fails as a crash on the main thread
 * would, instead of hanging or silently losing files.
 */
export class ExtractionPool {
    private readonly workers: PoolWorker[] = [];
    private readonly queue: Array<{task: ExtractionTask; pending: Pending}> = [];
    private failure: Error | null = null;
    private closing = false;

    public constructor(
        private readonly size: number,
        private readonly config: ExtractionWorkerConfig
    ) {}

    /**
     * Starts all `size` workers now, so their start — loading TypeScript,
     * ts-morph and the grammars, ≈ 0.4–0.6 s each — overlaps whatever the
     * caller does before the first file (see Pipeline.ts `analyzeAsync`).
     */
    public start(): void {
        while (this.workers.length < this.size) {
            this.startWorker();
        }
    }

    public extract(index: number, meta: FileMeta, file: FileRef): Promise<FileOutcome> {
        return new Promise<FileOutcome>((resolve, reject) => {
            if (this.failure !== null) {
                reject(this.failure);
                return;
            }
            this.queue.push({task: {index, meta, file}, pending: {resolve, reject}});
            this.dispatch();
        });
    }

    /** Stops every worker; tasks still open are rejected (the caller no longer awaits them). */
    public async close(): Promise<void> {
        this.closing = true;
        this.failAll(new Error('extraction pool closed'));
        await Promise.all(this.workers.map(async ({worker}) => worker.terminate()));
    }

    private dispatch(): void {
        while (this.queue.length > 0) {
            const target = this.idleWorker();
            if (target === null) {
                return;
            }
            const next = this.queue.shift() as {task: ExtractionTask; pending: Pending};
            target.pending.set(next.task.index, next.pending);
            target.worker.postMessage(next.task);
        }
    }

    /** The least busy worker with room for one more task, starting a new one while below `size`. */
    private idleWorker(): PoolWorker | null {
        let best: PoolWorker | null = null;
        for (const candidate of this.workers) {
            if (candidate.pending.size < TASKS_PER_WORKER && (best === null || candidate.pending.size < best.pending.size)) {
                best = candidate;
            }
        }
        if (best !== null && best.pending.size === 0) {
            return best;
        }
        if (this.workers.length < this.size) {
            return this.startWorker();
        }
        return best;
    }

    private startWorker(): PoolWorker {
        const worker = new Worker(new URL('./ExtractionWorker.js', import.meta.url), {workerData: this.config});
        const entry: PoolWorker = {worker, pending: new Map()};
        worker.on('message', (reply: ExtractionReply) => {
            const pending = entry.pending.get(reply.index);
            if (pending === undefined) {
                return;
            }
            entry.pending.delete(reply.index);
            if ('error' in reply) {
                pending.reject(new Error(reply.error));
            } else {
                pending.resolve(reply.outcome);
            }
            this.dispatch();
        });
        worker.on('error', (error: Error) => this.fail(error));
        worker.on('exit', (code: number) => {
            if (!this.closing) {
                this.fail(new Error(`extraction worker exited with code ${code}`));
            }
        });
        this.workers.push(entry);
        return entry;
    }

    private fail(error: Error): void {
        if (this.failure === null) {
            this.failure = error;
        }
        this.failAll(this.failure);
    }

    private failAll(error: Error): void {
        for (const {worker, pending} of this.workers) {
            for (const open of pending.values()) {
                open.reject(error);
            }
            pending.clear();
            if (!this.closing) {
                void worker.terminate();
            }
        }
        for (const waiting of this.queue.splice(0)) {
            waiting.pending.reject(error);
        }
    }
}
