import type {SemanticAdapter, SemanticRequest, SemanticVerdict} from './SemanticAdapter.js';

/**
 * The default adapter: it never augments a finding. With it in place the engine
 * is deterministic and needs no LLM, which is the MVP default.
 */
export class NoopSemanticAdapter implements SemanticAdapter {
    public readonly id = 'noop';
    public readonly deterministic = true;

    public assess(_input: SemanticRequest): Promise<SemanticVerdict> {
        return Promise.resolve({
            verdict: 'not-assessed',
            rationale: 'Semantic analysis is disabled (noop adapter).',
            citations: [],
            confidence: 0
        });
    }
}
