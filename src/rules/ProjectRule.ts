import type {Fact, Finding} from '../Types.js';
import type {KnowledgeBase} from '../knowledge/KnowledgeBase.js';

export interface ProjectRuleInput {
    facts: Fact[];
    ruleSetId: string;
    knowledgeBase: KnowledgeBase;
    lang: string;
}

/**
 * A procedural, cross-file rule. Unlike the declarative rules, it sees the whole
 * fact set at once (needed for graph-shaped problems such as dependency cycles
 * that cannot be expressed as a per-subject condition). It still returns the
 * same Finding shape and flows through the engine's de-duplication and sorting.
 */
export interface ProjectRule {
    readonly id: string;
    readonly version: string;
    evaluate(input: ProjectRuleInput): Finding[];
}
