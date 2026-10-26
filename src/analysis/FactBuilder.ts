import type {Fact, FactValue, SourceRange, SubjectKind} from '../Types.js';

export interface AdapterInfo {
    id: string;
    version: string;
}

export interface FactSpec {
    kind: string;
    kindOf: SubjectKind;
    symbol?: string;
    range: SourceRange;
    value: FactValue;
}

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
        return {
            id: `fact:${filePath}:${spec.kind}:${spec.symbol ?? 'file'}:${spec.range.startLine}`,
            kind: spec.kind,
            subject,
            value: spec.value,
            evidence: [{source: 'ast', detail: spec.kind}],
            certainty: 'syntactic',
            producedBy: {adapter: info.id, version: info.version}
        };
    };
};
