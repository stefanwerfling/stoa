import {getHeapStatistics} from 'node:v8';

/**
 * A point-in-time memory reading. Deliberately plain numbers, not an
 * accumulating history — callers that want a trend (e.g. `--memory-stats`)
 * print/log each snapshot as it is taken rather than collecting them, so the
 * diagnostic itself never becomes an unbounded growth source.
 */
export interface MemorySnapshot {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    /** V8's own ceiling for `heapUsed` (`--max-old-space-size`, or V8's default) — what a "JS heap out of memory" fatal error is measured against. */
    heapSizeLimit: number;
}

export const takeMemorySnapshot = (): MemorySnapshot => {
    const mem = process.memoryUsage();
    return {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        heapSizeLimit: getHeapStatistics().heap_size_limit
    };
};

/**
 * True once `heapUsed` crosses `ratio` of V8's own heap limit — the same
 * quantity a "FATAL ERROR: ... JavaScript heap out of memory" crash is
 * measured against, so this fires with headroom to spare rather than only
 * after the fact. Deliberately NOT based on a fixed MB constant (unreliable
 * across machines/Node versions) and NOT based on RSS (which also includes
 * native/WASM memory outside V8's heap — not what `--max-old-space-size`
 * bounds, and not what this guard claims to catch).
 */
export const isMemoryCritical = (snapshot: MemorySnapshot, ratio = 0.9): boolean => snapshot.heapUsed > ratio * snapshot.heapSizeLimit;
