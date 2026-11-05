import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {FileRef} from './analysis/LanguageAdapter.js';
import {IDENTITY_KINDS} from './FindingIdentity.js';
import type {Certainty, Fact} from './Types.js';

const CERTAINTIES: ReadonlySet<string> = new Set<Certainty>(['syntactic', 'semantic-heuristic', 'external-tool']);
const IDENTITY_KIND_SET: ReadonlySet<unknown> = new Set<unknown>(IDENTITY_KINDS);

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isValidRange = (value: unknown): boolean => isPlainObject(value) && typeof value.startLine === 'number' && typeof value.startCol === 'number' && typeof value.endLine === 'number' && typeof value.endCol === 'number';

const isValidSubject = (value: unknown): boolean => isPlainObject(value) && typeof value.file === 'string' && typeof value.kindOf === 'string' && (value.symbol === undefined || typeof value.symbol === 'string') && (value.identityKind === undefined || IDENTITY_KIND_SET.has(value.identityKind)) && isValidRange(value.range);

const isValidProducer = (value: unknown): boolean => isPlainObject(value) && typeof value.adapter === 'string' && typeof value.version === 'string';

const isValidValue = (value: unknown): boolean => typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' || isPlainObject(value);

/**
 * A structural check, not a full schema validator — enough to catch garbage
 * (a corrupted write, a stray `{}`, a value of the wrong type) without
 * re-encoding every field's exact invariants a second time. A cache entry
 * that fails this is treated exactly like a missing one: recomputed, never
 * thrown, never allowed to feed a wrong value into a real analysis.
 */
const isValidFact = (value: unknown): value is Fact => {
    if (!isPlainObject(value)) {
        return false;
    }
    return (
        typeof value.id === 'string' &&
        typeof value.kind === 'string' &&
        isValidSubject(value.subject) &&
        isValidValue(value.value) &&
        Array.isArray(value.evidence) &&
        typeof value.certainty === 'string' &&
        CERTAINTIES.has(value.certainty) &&
        isValidProducer(value.producedBy)
    );
};

// The directory this module itself lives in — `dist/` once compiled,
// `src/` when run directly (e.g. via tsx in tests). Fingerprinting THAT
// directory, rather than a manually-maintained version constant, means a
// change to the actual fact-extraction code invalidates every cached fact
// automatically: nobody has to remember to bump a version string for the
// cache to stay correct. Coarser than a per-adapter fingerprint (any engine
// change invalidates everything, not just the adapter that changed) but
// "correctness over speed" (per the governing principle) favors the
// guarantee that is actually verifiable over one more targeted but
// dependent on manual discipline.
const ENGINE_ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.js', '.mjs', '.cjs'] as const;

const hashFile = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

const listSourceFiles = (dir: string, out: string[]): void => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) {
            listSourceFiles(absolute, out);
            continue;
        }
        if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
            out.push(absolute);
        }
    }
};

let memoizedFingerprint: string | null = null;

/**
 * A hash over every source file the running engine is actually built from
 * (path + content), computed once per process. Not a secret, not stored
 * anywhere sensitive — purely a cache-invalidation key.
 */
export const engineFingerprint = (): string => {
    if (memoizedFingerprint !== null) {
        return memoizedFingerprint;
    }
    const files: string[] = [];
    listSourceFiles(ENGINE_ROOT, files);
    files.sort();
    const hash = createHash('sha256');
    for (const file of files) {
        hash.update(relative(ENGINE_ROOT, file));
        hash.update(hashFile(file));
    }
    memoizedFingerprint = hash.digest('hex');
    return memoizedFingerprint;
};

/**
 * Caches ONE thing only: the facts produced by extracting a single file with
 * a single adapter (`LanguageAdapter.extractFacts`/`TypeDiagnosticsExtractor.extract`)
 * — never a rule evaluation result or a finding. This is deliberate, not an
 * oversight: facts are a pure function of (engine code, adapter id, file
 * path, file content) — nothing else, confirmed by reading every adapter
 * (none use `ProjectContext.rootDir`, none read another file). Rule sets and
 * Validation Contracts are consumed only AFTER this cache, every run,
 * unconditionally — so a rule/contract change can never be served a stale
 * result: there is nothing cached downstream of them to go stale.
 *
 * Known, accepted limits (documented, not hidden): no `tsconfig.json`
 * dependency is tracked because none of today's TypeScript analysis reads
 * one (the ts-morph Project is in-memory, no tsconfig is loaded) — if that
 * ever changes, this cache must be revisited. No cross-file fact dependency
 * is tracked because none exists today (every analysis in
 * `src/analysis/typescript/*` is documented and tested as same-file-only) —
 * same caveat if that ever changes.
 */
export class FactCache {
    public constructor(private readonly dir: string) {}

    private keyFor(adapterId: string, file: FileRef): string {
        const contentHash = createHash('sha256').update(file.content).digest('hex');
        return createHash('sha256').update(`${engineFingerprint()}|${adapterId}|${file.path}|${contentHash}`).digest('hex');
    }

    private pathFor(key: string): string {
        return join(this.dir, key.slice(0, 2), `${key}.json`);
    }

    /**
     * Returns the cached facts, or null on a miss OR a corrupted/unreadable
     * entry — a broken cache file degrades to recomputation, it never
     * throws and never blocks an analysis. Every element is structurally
     * validated (see isValidFact()), not just "parsed.facts is an array":
     * a cache hit that silently fed a malformed value into a real analysis
     * (a missing field, a value of the wrong type) could produce a wrong
     * finding that looks exactly like a correct one — a miss is always the
     * safe failure mode here, a cache is never allowed to be the reason an
     * analysis is wrong.
     */
    public get(adapterId: string, file: FileRef): Fact[] | null {
        const path = this.pathFor(this.keyFor(adapterId, file));
        if (!existsSync(path)) {
            return null;
        }
        try {
            const parsed = JSON.parse(readFileSync(path, 'utf8')) as {facts?: unknown};
            if (!Array.isArray(parsed.facts) || !parsed.facts.every(isValidFact)) {
                return null;
            }
            return parsed.facts;
        } catch {
            return null;
        }
    }

    public set(adapterId: string, file: FileRef, facts: Fact[]): void {
        const path = this.pathFor(this.keyFor(adapterId, file));
        mkdirSync(dirname(path), {recursive: true});
        writeFileSync(path, JSON.stringify({facts}));
    }
}
