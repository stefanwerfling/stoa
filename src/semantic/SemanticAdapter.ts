import type {Fact} from '../Types.js';

/**
 * Everything the semantic layer is allowed to see. It receives only what the
 * engine prepares (a code snippet, the facts, the principle, project context)
 * and must ground its verdict in that input — it may not invent facts.
 */
export interface SemanticRequest {
    codeSnippet: string;
    facts: Fact[];
    principleId: string;
    projectContext: string;
}

export interface SemanticVerdict {
    verdict: string;
    rationale: string;
    citations: string[];
    confidence: number;
}

/**
 * Optional, vendor-neutral adapter for semantic (LLM) assessment. The engine is
 * fully functional without it; implementations exist for "no LLM" (no-op),
 * local models and external APIs. See docs architecture §D.
 */
export interface SemanticAdapter {
    readonly id: string;
    readonly deterministic: boolean;
    assess(input: SemanticRequest): Promise<SemanticVerdict>;
}
