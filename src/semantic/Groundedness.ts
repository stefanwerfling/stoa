import type {SemanticRequest, SemanticVerdict} from './SemanticAdapter.js';

/**
 * Enforces that an LLM verdict is grounded in the evidence the engine actually
 * provided — the core guardrail against invented facts (see docs architecture §D).
 *
 * Grounding is by **stable fact id**: a verdict's `citations` must reference the
 * ids of facts in this request (which are already scoped to the finding's code
 * unit). A verdict is grounded only if its confidence is in range, it cites at
 * least one fact, and **every** citation is a known fact id from this request —
 * a single invented or out-of-context reference invalidates the grounding. The
 * mere mention of a fact kind or symbol name in prose is deliberately NOT
 * accepted as evidence.
 *
 * Limitation (by design): a valid evidence reference proves only that the
 * citation points at real, in-context evidence. It does NOT prove that the
 * model's conclusion drawn from that evidence is factually correct. Grounding
 * bounds hallucinated *references*, not flawed *reasoning*.
 */
export const isGrounded = (verdict: SemanticVerdict, request: SemanticRequest): boolean => {
    if (verdict.confidence < 0 || verdict.confidence > 1) {
        return false;
    }
    if (verdict.citations.length === 0) {
        return false;
    }
    const factIds = new Set(request.facts.map((fact) => fact.id));
    return verdict.citations.every((citation) => factIds.has(citation));
};
