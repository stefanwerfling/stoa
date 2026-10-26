import type {QualityDimension, Severity} from '../Types.js';
import type {LocalizedText} from '../i18n/Localized.js';

export type ConditionOp = '==' | '!=' | '>' | '>=' | '<' | '<=';

export interface Condition {
    fact: string;
    op: ConditionOp;
    value?: unknown;
    and?: Condition[];
}

export interface ConditionGroup {
    all?: Condition[];
    any?: Condition[];
}

export interface SeverityEscalation extends Condition {
    to: Severity;
}

export interface SeveritySpec {
    base: Severity;
    escalateWhen?: SeverityEscalation[];
}

export interface ConfidenceReduction extends Condition {
    by: number;
}

export interface ConfidenceSpec {
    base: number;
    capBy?: 'certainty';
    reduceWhen?: ConfidenceReduction[];
}

export interface RuleRemediation {
    suggestion: LocalizedText;
    drawbacks?: LocalizedText;
}

/**
 * A declarative rule. It evaluates facts only; the philosophical reading comes
 * from the referenced principles. See docs rule-model §3.
 */
export interface Rule {
    id: string;
    version: string;
    title: string;
    feature: string;
    appliesTo: string[];
    principles: string[];
    dimensions: QualityDimension[];
    trigger: ConditionGroup;
    requiredEvidence: string[];
    suppressWhen?: ConditionGroup;
    severity: SeveritySpec;
    confidence: ConfidenceSpec;
    message: LocalizedText;
    rationale?: LocalizedText;
    remediation?: RuleRemediation;
    missingContext?: LocalizedText[];
    remediationRef?: string;
    tests: string;
}
