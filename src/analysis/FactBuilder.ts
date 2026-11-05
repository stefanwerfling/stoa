import {IDENTITY_SCHEME, type IdentityScheme} from '../FindingIdentity.js';
import type {Certainty, Fact, FactEvidence, FactValue, SourceRange, SubjectKind} from '../Types.js';

export interface AdapterInfo {
    id: string;
    version: string;
    /** The finding-identity scheme the extractor names declarations under (FindingIdentity.ts); the current one when absent. */
    identityScheme?: IdentityScheme;
}

/** The identity scheme an extractor names declarations under: `info.identityScheme`, else the current one. */
export const identitySchemeOf = (info: AdapterInfo): IdentityScheme => info.identityScheme ?? IDENTITY_SCHEME;

export interface FactSpec {
    kind: string;
    kindOf: SubjectKind;
    symbol?: string;
    range: SourceRange;
    value: FactValue;
    certainty?: Certainty;
    evidenceSource?: FactEvidence['source'];
    /**
     * A finding site below a declaration (a catch, an import, a DDL statement,
     * an a11y element …) whose `symbol` is the legacy per-file ordinal
     * (`catch#3`). The adapter's `assignSiteSymbols` (SiteIdentity.ts) gives
     * it its identity relative to the enclosing declaration.
     */
    site?: true;
}

/** A fact's id: the same for a fact built here and one whose symbol SiteIdentity.ts re-assigns. */
export const factIdOf = (filePath: string, kind: string, symbol: string | undefined, startLine: number): string =>
    `fact:${filePath}:${kind}:${symbol ?? 'file'}:${startLine}`;

const sites = new WeakSet<Fact>();

/** Whether `fact` was built as a finding site (`FactSpec.site`). */
export const isSiteFact = (fact: Fact): boolean => sites.has(fact);

/**
 * Returns a builder bound to one file/adapter, so each fact is described by a
 * single spec object rather than a long positional argument list. Shared by the
 * language adapters so every fact has an identical, language-neutral shape.
 */
export const factBuilder = (info: AdapterInfo, filePath: string) => {
    return (spec: FactSpec): Fact => {
        const subject =
            spec.symbol === undefined
                ? {file: filePath, kindOf: spec.kindOf, range: spec.range}
                : {file: filePath, symbol: spec.symbol, kindOf: spec.kindOf, range: spec.range};
        const fact: Fact = {
            id: factIdOf(filePath, spec.kind, spec.symbol, spec.range.startLine),
            kind: spec.kind,
            subject,
            value: spec.value,
            evidence: [{source: spec.evidenceSource ?? 'ast', detail: spec.kind}],
            certainty: spec.certainty ?? 'syntactic',
            producedBy: {adapter: info.id, version: info.version}
        };
        if (spec.site === true) {
            sites.add(fact);
        }
        return fact;
    };
};
