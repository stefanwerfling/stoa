import {AnthropicSemanticAdapter} from './AnthropicSemanticAdapter.js';
import {NoopSemanticAdapter} from './NoopSemanticAdapter.js';
import type {SemanticAdapter} from './SemanticAdapter.js';

/**
 * Resolves the configured semantic adapter by id. Unknown ids fall back to the
 * no-op adapter so an unrecognized value never silently enables an LLM. No
 * vendor is assumed: 'anthropic' is one adapter among future local/API ones.
 */
export const createSemanticAdapter = (id: string): SemanticAdapter => {
    switch (id) {
        case 'anthropic':
            return new AnthropicSemanticAdapter();
        case 'noop':
        default:
            return new NoopSemanticAdapter();
    }
};
