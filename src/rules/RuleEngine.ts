import type {Fact, Finding} from '../Types.js';
import type {KnowledgeBase} from '../knowledge/KnowledgeBase.js';

/**
 * M1 skeleton. The deterministic rule set arrives in M3; for now the engine
 * loads no rules and therefore produces no findings. Keeping it in place lets
 * the pipeline run end-to-end while the rule model is implemented.
 */
export class RuleEngine {
    public constructor(private readonly knowledgeBase: KnowledgeBase) {}

    public evaluate(_facts: Fact[]): Finding[] {
        // TODO(M3): select rules by feature/requiredEvidence, apply trigger and
        // suppressWhen, derive severity and confidence separately (capped by the
        // fact certainty), then attach the principle interpretation.
        return [];
    }

    /** How many principles the bound knowledge base exposes to future rules. */
    public principleCount(): number {
        return this.knowledgeBase.size();
    }
}
