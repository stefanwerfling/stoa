import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import {isGrounded} from '../src/semantic/Groundedness.js';
import {parseVerdictText} from '../src/semantic/AnthropicSemanticAdapter.js';
import {NoopSemanticAdapter} from '../src/semantic/NoopSemanticAdapter.js';
import {augmentWithSemantics} from '../src/semantic/SemanticRunner.js';
import type {SemanticAdapter, SemanticRequest, SemanticVerdict} from '../src/semantic/SemanticAdapter.js';
import type {AnalysisResult} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const analyzeCatch = (): AnalysisResult =>
    analyze({
        rootPath: join(here, 'fixtures', 'metrics', 'Catch.ts'),
        knowledgeDir: join(root, 'knowledge', 'marcus'),
        ruleSetDir: join(root, 'rules', 'default'),
        config: DEFAULT_CONFIG
    });

// Deterministic mock that grounds its verdict in a real provided fact id.
class GroundedMockAdapter implements SemanticAdapter {
    public readonly id = 'mock-grounded';
    public readonly deterministic = true;
    public assess(input: SemanticRequest): Promise<SemanticVerdict> {
        const id = input.facts[0]?.id ?? '';
        return Promise.resolve({verdict: 'confirmed', rationale: 'Grounded in the swallow fact.', citations: [id], confidence: 0.8});
    }
}

// Deterministic mock whose citation is a fact KIND name, not a stable id — a
// plausible-looking but ungrounded reference that must be rejected.
class NameDroppingMockAdapter implements SemanticAdapter {
    public readonly id = 'mock-namedrop';
    public readonly deterministic = true;
    public assess(input: SemanticRequest): Promise<SemanticVerdict> {
        const kind = input.facts[0]?.kind ?? '';
        return Promise.resolve({verdict: 'confirmed', rationale: `Looks like ${kind}.`, citations: [kind], confidence: 0.9});
    }
}

// Deterministic mock whose adapter fails (e.g. no network / credentials).
class ErroringMockAdapter implements SemanticAdapter {
    public readonly id = 'mock-error';
    public readonly deterministic = true;
    public assess(_input: SemanticRequest): Promise<SemanticVerdict> {
        return Promise.reject(new Error('adapter unavailable'));
    }
}

// Deterministic mock that cites a fact the engine never provided.
class HallucinatingMockAdapter implements SemanticAdapter {
    public readonly id = 'mock-hallucinate';
    public readonly deterministic = true;
    public assess(_input: SemanticRequest): Promise<SemanticVerdict> {
        return Promise.resolve({verdict: 'confirmed', rationale: 'Invented.', citations: ['totally.made.up.fact'], confidence: 0.95});
    }
}

test('grounded verdict is attached to selected findings', async () => {
    const result = analyzeCatch();
    const augmented = await augmentWithSemantics(result, new GroundedMockAdapter());
    const swallow = augmented.report.findings.filter((finding) => finding.rule.id === 'R-ERR-SWALLOWED');
    assert.ok(swallow.length >= 1);
    for (const finding of swallow) {
        assert.ok(finding.semantic, 'semantic augmentation present');
        assert.equal(finding.semantic?.adapter, 'mock-grounded');
        assert.equal(finding.semantic?.verdict, 'confirmed');
    }
});

test('ungrounded (hallucinated) verdict is discarded, not attached', async () => {
    const result = analyzeCatch();
    const augmented = await augmentWithSemantics(result, new HallucinatingMockAdapter());
    for (const finding of augmented.report.findings) {
        assert.equal(finding.semantic, undefined, 'hallucinated verdict must not be attached');
    }
});

test('the no-op adapter leaves findings unchanged', async () => {
    const result = analyzeCatch();
    const augmented = await augmentWithSemantics(result, new NoopSemanticAdapter());
    assert.equal(JSON.stringify(augmented.report.findings), JSON.stringify(result.report.findings));
});

test('isGrounded enforces citations and confidence range', () => {
    const request: SemanticRequest = {
        codeSnippet: 'try { risky(); } catch {}',
        facts: [
            {
                id: 'f1',
                kind: 'ast.catchSwallowsError',
                subject: {file: 'x.ts', kindOf: 'catch-clause', range: {startLine: 1, startCol: 0, endLine: 1, endCol: 0}},
                value: true,
                evidence: [{source: 'ast', detail: 'x'}],
                certainty: 'syntactic',
                producedBy: {adapter: 'typescript', version: '0.2.0'}
            }
        ],
        principleId: 'marcus.obstacle',
        principleName: 'The obstacle becomes a furtherance',
        observation: 'catch swallows error',
        projectContext: ''
    };
    // Grounding is by stable fact id (here 'f1'), not by fact kind or prose.
    assert.equal(isGrounded({verdict: 'confirmed', rationale: '', citations: ['f1'], confidence: 0.8}, request), true, 'valid fact-id reference');
    assert.equal(isGrounded({verdict: 'confirmed', rationale: '', citations: ['ast.catchSwallowsError'], confidence: 0.8}, request), false, 'a fact KIND name is not a valid evidence reference');
    assert.equal(isGrounded({verdict: 'confirmed', rationale: '', citations: ['fact:other.ts:x:y:9'], confidence: 0.8}, request), false, 'a non-existent / out-of-context fact id');
    assert.equal(isGrounded({verdict: 'confirmed', rationale: '', citations: ['f1', 'fact:made.up'], confidence: 0.8}, request), false, 'one invented reference invalidates the grounding');
    assert.equal(isGrounded({verdict: 'confirmed', rationale: '', citations: [], confidence: 0.8}, request), false, 'no citations');
    assert.equal(isGrounded({verdict: 'confirmed', rationale: '', citations: ['f1'], confidence: 2}, request), false, 'confidence out of range');
});

test('a verdict that only name-drops a fact kind is discarded, not attached', async () => {
    const result = analyzeCatch();
    const augmented = await augmentWithSemantics(result, new NameDroppingMockAdapter());
    for (const finding of augmented.report.findings) {
        assert.equal(finding.semantic, undefined, 'a kind-name citation is not grounded');
    }
});

test('a failing semantic adapter leaves findings untouched', async () => {
    const result = analyzeCatch();
    const augmented = await augmentWithSemantics(result, new ErroringMockAdapter());
    for (const finding of augmented.report.findings) {
        assert.equal(finding.semantic, undefined);
    }
});

test('parseVerdictText accepts a well-formed response and rejects malformed ones', () => {
    const ok = parseVerdictText('{"verdict":"confirmed","rationale":"r","citations":["f1"],"confidence":0.7}');
    assert.equal(ok.verdict, 'confirmed');
    assert.deepEqual(ok.citations, ['f1']);

    assert.throws(() => parseVerdictText('not json'), /not valid JSON/);
    assert.throws(() => parseVerdictText('{"verdict":"maybe","rationale":"r","citations":[],"confidence":0.5}'), /invalid verdict/);
    assert.throws(() => parseVerdictText('{"verdict":"confirmed","citations":[],"confidence":0.5}'), /rationale/);
    assert.throws(() => parseVerdictText('{"verdict":"confirmed","rationale":"r","citations":"f1","confidence":0.5}'), /citations/);
    assert.throws(() => parseVerdictText('{"verdict":"confirmed","rationale":"r","citations":[],"confidence":2}'), /confidence/);
    assert.throws(() => parseVerdictText('{"verdict":"confirmed","rationale":"r","citations":[1],"confidence":0.5}'), /citations/);
});
