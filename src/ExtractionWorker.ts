import * as nodeModule from 'node:module';

/**
 * Entry of an extraction worker thread (see ExtractionPool.ts). Before the
 * worker loads TypeScript, ts-morph and the adapters — ≈ 0.35 s of compiling
 * per worker, the bulk of its start — it turns on Node's module compile cache
 * (`module.enableCompileCache()`, Node ≥ 22.1): compiled code is kept in
 * Node's default cache directory (`os.tmpdir()/node-compile-cache`, ≈ 9 MB)
 * and reused by the workers of later runs, which then load in about half the
 * time. Only worker threads do this, so a run without `--jobs` writes nothing
 * beyond its report, as before. `NODE_DISABLE_COMPILE_CACHE=1` turns it off;
 * on a Node without the API the worker simply compiles. The cache is written
 * right after loading (`flushCompileCache()`), because the pool ends its
 * workers with `terminate()`, which may not leave time to write it.
 *
 * The modules that do the work are therefore imported dynamically, after the
 * cache is on — a static import would load them first.
 */
const compileCache = nodeModule as {enableCompileCache?: () => unknown; flushCompileCache?: () => void};
compileCache.enableCompileCache?.();
await import('./ExtractionWorkerTasks.js');
compileCache.flushCompileCache?.();
