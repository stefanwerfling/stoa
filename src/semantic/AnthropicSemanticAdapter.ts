import Anthropic from '@anthropic-ai/sdk';
import type {SemanticAdapter, SemanticRequest, SemanticVerdict} from './SemanticAdapter.js';

const DEFAULT_MODEL = 'claude-opus-4-8';

const SYSTEM_PROMPT = [
    'You are a cautious code-analysis reviewer embedded in a deterministic engine.',
    'A deterministic rule already produced an observation; your job is only to judge, in context,',
    'whether that observation is a real concern for the stated principle.',
    'Ground every statement strictly in the provided code snippet and facts.',
    'Do NOT invent facts, APIs, call sites, or project details that are not shown.',
    'If the provided context is insufficient, answer "uncertain" with low confidence.',
    'In "citations", quote the exact fact kind(s) or snippet text you relied on.'
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
        return parseVerdict(response);
    }
}

const buildPrompt = (input: SemanticRequest): string => {
    const facts = input.facts.map((fact) => `- ${fact.kind} = ${JSON.stringify(fact.value)} (${fact.certainty})`).join('\n');
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
        'Is the observation a real concern here for this principle? Answer in the required JSON shape.'
    ]
        .filter((line) => line.length > 0 || line === '')
        .join('\n');
};

const parseVerdict = (response: Anthropic.Message): SemanticVerdict => {
    const textBlock = response.content.find((block) => block.type === 'text');
    if (textBlock === undefined || textBlock.type !== 'text') {
        return {verdict: 'uncertain', rationale: 'No textual response.', citations: [], confidence: 0};
    }

    const parsed = JSON.parse(textBlock.text) as Partial<SemanticVerdict>;
    return {
        verdict: typeof parsed.verdict === 'string' ? parsed.verdict : 'uncertain',
        rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
        citations: Array.isArray(parsed.citations) ? parsed.citations.filter((item): item is string => typeof item === 'string') : [],
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0
    };
};
