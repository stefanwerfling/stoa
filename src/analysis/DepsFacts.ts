/**
 * Neutral value shapes of the module-dependency facts that more than one
 * module reads (the adapter writes them, the models read them).
 */

/**
 * The value of a `deps.reexport` fact (semantic consolidation, phase 2): one
 * re-export of `export … from '<module>'`.
 * - `named`: `export {name as exportedAs} from` (`default as X`, `X as
 *   default` included); its range is the specifier's — the very range of the
 *   `deps.export` fact the same specifier produces, so a consumer can tell a
 *   re-exported name from a local definition;
 * - `star`: `export * from` (name and exportedAs `*`; no `deps.export`);
 * - `namespace`: `export * as exportedAs from` (name `*`; no `deps.export`).
 */
export interface ReexportValue {
    module: string;
    name: string;
    exportedAs: string;
    kind: 'named' | 'star' | 'namespace';
    isTypeOnly: boolean;
}
