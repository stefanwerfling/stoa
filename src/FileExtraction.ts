import type {FileRef, LanguageAdapter, ProjectContext} from './analysis/LanguageAdapter.js';
import type {Fact} from './Types.js';

/**
 * What became of one selected file — decided in the pipeline (unsupported,
 * unreadable, served from the cache) or by its adapter (parsed or not), and
 * applied to the run in file order (see Pipeline.ts `Ingestion.commit`). A
 * plain, cloneable value, so an extraction worker can hand it back.
 */
export type FileOutcome =
    | {kind: 'unsupported'}
    | {kind: 'readError'; detail: string}
    | {kind: 'parseFailed'; diagnostics: string[]}
    | {kind: 'extracted'; adapterId: string; facts: Fact[]; cached: boolean}
    /** An extraction worker's heap crossed the memory guard's ratio before this file (see MemoryGuard.ts `isHeapCritical`). */
    | {kind: 'memoryCritical'};

/** Parses one file, extracts its facts and releases the parse — the same steps on the main thread and in a worker. */
export const extractFile = (adapter: LanguageAdapter, file: FileRef, context: ProjectContext): FileOutcome => {
    const parsed = adapter.parse(file);
    if (!parsed.ok) {
        return {kind: 'parseFailed', diagnostics: parsed.diagnostics};
    }
    const facts = adapter.extractFacts(parsed, context);
    parsed.release?.();
    return {kind: 'extracted', adapterId: adapter.id, facts, cached: false};
};
