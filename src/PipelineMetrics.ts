import type {ModuleGraph} from './model/ModuleGraph.js';
import type {SymbolGraph} from './model/SymbolGraph.js';
import type {TypeModel} from './model/TypeModel.js';

/**
 * One analysis run, measured (opt-in: `AnalyzeOptions.onMetrics`, CLI
 * `--memory-stats`). Observational only — collecting it changes no fact,
 * finding or report byte. The counts are deterministic for a given input;
 * the timings and the peak RSS are not (machine, load, GC) and are meant for
 * comparing runs on one machine, never for a report or a baseline.
 */
export interface PipelineMetrics {
    files: {selected: number; analyzed: number; skipped: number; cancelled: number; cacheHits: number};
    facts: number;
    findings: number;
    moduleGraph: {nodes: number; edges: number; unresolved: number};
    /** `null` when no active rule needed it (see `needsSymbolGraph`). Nodes: the distinct defined symbols (file, name) the bindings reach. */
    symbolGraph: {bindings: number; nodes: number; byStatus: Record<string, number>} | null;
    /** `null` when no rule read the TypeModel in this run (it is built lazily). */
    typeModel: {types: number} | null;
    /**
     * Wall-clock milliseconds per phase: `discovery` (file selection),
     * `read` (file content), `extraction` (the rest of the per-file loop:
     * cache lookup, parse, fact extraction, typecheck facts, memory checks),
     * `graphs` (Dart library index, ModuleGraph, SymbolGraph, widget graph),
     * `evaluation` (every rule, the TypeModel included) and `total`.
     */
    timingsMs: {discovery: number; read: number; extraction: number; graphs: number; evaluation: number; total: number};
    /** The process's peak resident set size so far (`process.resourceUsage().maxRSS`), in bytes — includes everything loaded before the run. */
    peakRssBytes: number;
}

/** Accumulates wall-clock time per phase (monotonic clock); reads never feed back into the analysis. */
export class PhaseClock {
    private readonly totals = new Map<string, number>();
    private readonly startedAt = performance.now();

    /** Runs `work` and adds its duration to `phase`. */
    public time<T>(phase: string, work: () => T): T {
        const start = performance.now();
        try {
            return work();
        } finally {
            this.totals.set(phase, (this.totals.get(phase) ?? 0) + performance.now() - start);
        }
    }

    /** Adds a duration measured around code that cannot be wrapped (a loop with `break`/`continue`). */
    public add(phase: string, ms: number): void {
        this.totals.set(phase, (this.totals.get(phase) ?? 0) + ms);
    }

    public total(phase: string): number {
        return round(this.totals.get(phase) ?? 0);
    }

    public sinceStart(): number {
        return round(performance.now() - this.startedAt);
    }
}

const round = (ms: number): number => Math.round(ms * 10) / 10;

export const symbolGraphMetrics = (graph: SymbolGraph | undefined): PipelineMetrics['symbolGraph'] => {
    if (graph === undefined) {
        return null;
    }
    const byStatus: Record<string, number> = {};
    const nodes = new Set<string>();
    for (const edge of graph.imports) {
        byStatus[edge.status] = (byStatus[edge.status] ?? 0) + 1;
        for (const definition of edge.definitions) {
            nodes.add(`${definition.file}\n${definition.name}`);
        }
    }
    return {bindings: graph.imports.length, nodes: nodes.size, byStatus};
};

export const moduleGraphMetrics = (graph: ModuleGraph): PipelineMetrics['moduleGraph'] => ({nodes: graph.nodes.length, edges: graph.edges.length, unresolved: graph.unresolved.length});

export const typeModelMetrics = (model: TypeModel | undefined): PipelineMetrics['typeModel'] => (model === undefined ? null : {types: model.types.length});
