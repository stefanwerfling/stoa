import Anthropic from '@anthropic-ai/sdk';
import type {Fact} from '../Types.js';
import type {SemanticAdapter, SemanticRequest, SemanticVerdict} from './SemanticAdapter.js';

const DEFAULT_MODEL = 'claude-opus-4-8';

const SYSTEM_PROMPT = [
    'You are a cautious code-analysis reviewer embedded in a deterministic engine.',
    'A deterministic rule already produced an observation; your job is only to judge, in context,',
    'whether that observation is a real concern for the stated principle.',
    'Ground every statement strictly in the provided code snippet and facts.',
    'Do NOT invent facts, APIs, call sites, or project details that are not shown.',
    'If the provided context is insufficient, answer "uncertain" with low confidence.',
    'In "citations", list ONLY the evidence labels (e.g. "e1", "e2") of the facts you relied on;',
    'do not put prose, snippet text, or fact kinds there. If you relied on no provided fact, return an empty citations array.'
].join(' ');

const VERDICT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'rationale', 'citations', 'confidence'],
    properties: {
        verdict: {type: 'string', enum: ['confirmed', 'refuted', 'uncertain']},
        rationale: {type: 'string'},
        citations: {type: 'array', items: {type: 'string'}},
        confidence: {type: 'number'}
    }
} as const;

export interface AnthropicSemanticOptions {
    client?: Anthropic;
    model?: string;
    maxTokens?: number;
}

/**
 * Optional LLM adapter using the Anthropic SDK (Claude Opus 4.8, adaptive
 * thinking, structured JSON output). It is off by default and never part of the
 * deterministic core. It receives only what the engine provides and must ground
 * its verdict in that input; the runner additionally discards ungrounded output.
 * A zero-arg client resolves credentials from the environment / `ant` profile.
 */
export class AnthropicSemanticAdapter implements SemanticAdapter {
    public readonly id = 'anthropic';
    public readonly deterministic = false;

    private client: Anthropic | undefined;
    private readonly model: string;
    private readonly maxTokens: number;

    public constructor(options: AnthropicSemanticOptions = {}) {
        // Client construction is deferred to assess() so that missing-credential
        // errors surface at call time and the runner can degrade gracefully.
        this.client = options.client;
        this.model = options.model ?? DEFAULT_MODEL;
        this.maxTokens = options.maxTokens ?? 2048;
    }

    public async assess(input: SemanticRequest): Promise<SemanticVerdict> {
        const client = this.client ?? new Anthropic();
        this.client = client;
        const response = await client.messages.create({
            model: this.model,
            max_tokens: this.maxTokens,
            thinking: {type: 'adaptive'},
            system: SYSTEM_PROMPT,
            output_config: {format: {type: 'json_schema', schema: VERDICT_SCHEMA}},
            messages: [{role: 'user', content: buildPrompt(input)}]
        });
        const verdict = parseVerdict(response);
        // Map the transmitted evidence labels back to stable fact ids so the
        // runner can ground against the request's facts. Unknown labels are
        // kept verbatim so they fail grounding rather than being hidden.
        return {...verdict, citations: resolveCitations(verdict.citations, input.facts)};
    }
}

const factLabel = (index: number): string => `e${index + 1}`;

export const resolveCitations = (citations: string[], facts: Fact[]): string[] => {
    const byLabel = new Map<string, string>();
    facts.forEach((fact, index) => byLabel.set(factLabel(index), fact.id));
    return citations.map((citation) => byLabel.get(citation) ?? citation);
};

export const buildPrompt = (input: SemanticRequest): string => {
    // Facts are presented with a request-local label (e1, e2, …) rather than
    // their id, so no file paths or symbols leave the machine via the id.
    const facts = input.facts.map((fact, index) => `- ${factLabel(index)}: ${fact.kind} = ${JSON.stringify(fact.value)} (${fact.certainty})`).join('\n');
    return [
        `Principle under consideration: ${input.principleName} (${input.principleId}).`,
        `Deterministic observation: ${input.observation}`,
        input.projectContext.length > 0 ? `Project context: ${input.projectContext}` : '',
        '',
        'Facts for this code unit:',
        facts.length > 0 ? facts : '(none)',
        '',
        'Code snippet:',
        '```',
        input.codeSnippet,
        '```',
        '',
        'Cite facts by their label (e1, e2, …). Is the observation a real concern here for this principle?',
        'Answer in the required JSON shape.'
    ]
        .filter((line) => line.length > 0 || line === '')
        .join('\n');
};

const VALID_VERDICTS: ReadonlySet<string> = new Set(['confirmed', 'refuted', 'uncertain']);

/**
 * Parses and strictly validates the model's JSON text against the verdict shape.
 * Throws on any structural violation (invalid JSON, missing/mistyped field,
 * unknown verdict, out-of-range confidence, non-string citations) so the runner
 * treats a malformed response as a failed assessment and leaves the finding
 * untouched — a malformed response is never coerced into a usable verdict.
 */
export const parseVerdictText = (text: string): SemanticVerdict => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`semantic: model response is not valid JSON: ${(error as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('semantic: model response is not a JSON object');
    }
    const record = parsed as Record<string, unknown>;
    const {verdict, rationale, citations, confidence} = record;
    if (typeof verdict !== 'string' || !VALID_VERDICTS.has(verdict)) {
        throw new Error(`semantic: invalid verdict "${String(verdict)}"`);
    }
    if (typeof rationale !== 'string') {
        throw new Error('semantic: rationale must be a string');
    }
    if (!Array.isArray(citations) || !citations.every((item) => typeof item === 'string')) {
        throw new Error('semantic: citations must be an array of strings');
    }
    if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
        throw new Error(`semantic: confidence must be a number in [0, 1], got ${String(confidence)}`);
    }
    return {verdict, rationale, citations: citations as string[], confidence};
};

const parseVerdict = (response: Anthropic.Message): SemanticVerdict => {
    const textBlock = response.content.find((block) => block.type === 'text');
    if (textBlock === undefined || textBlock.type !== 'text') {
        throw new Error('semantic: model response contained no text block');
    }
    return parseVerdictText(textBlock.text);
};
