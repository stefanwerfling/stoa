import type {SemanticRequest, SemanticVerdict} from './SemanticAdapter.js';

const MIN_SNIPPET_MATCH = 3;

/**
 * Enforces that an LLM verdict is grounded in the input the engine provided —
 * the core guardrail against invented facts (see docs architecture §D). A verdict
 * is grounded only if its confidence is in range and at least one citation refers
 * to a provided fact kind or to text present in the code snippet. Ungrounded
 * verdicts are discarded by the runner, never attached to a finding.
 */
export const isGrounded = (verdict: SemanticVerdict, request: SemanticRequest): boolean => {
    if (verdict.confidence < 0 || verdict.confidence > 1) {
        return false;
    }
    if (verdict.citations.length === 0) {
        return false;
    }

    const factKinds = request.facts.map((fact) => fact.kind);
    return verdict.citations.some((citation) => {
        if (citation.length === 0) {
            return false;
        }
        if (factKinds.some((kind) => citation.includes(kind))) {
            return true;
        }
        return citation.length >= MIN_SNIPPET_MATCH && request.codeSnippet.includes(citation);
    });
};
