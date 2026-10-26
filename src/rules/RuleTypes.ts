import type {QualityDimension, Severity} from '../Types.js';

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
    suggestion: string;
    drawbacks?: string;
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
    message: string;
    rationale?: string;
    remediation?: RuleRemediation;
    missingContext?: string[];
    remediationRef?: string;
    tests: string;
}
