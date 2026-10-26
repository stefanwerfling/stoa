import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import {isGrounded} from '../src/semantic/Groundedness.js';
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

// Deterministic mock that grounds its verdict in a real provided fact kind.
class GroundedMockAdapter implements SemanticAdapter {
    public readonly id = 'mock-grounded';
    public readonly deterministic = true;
    public assess(input: SemanticRequest): Promise<SemanticVerdict> {
        const kind = input.facts[0]?.kind ?? '';
        return Promise.resolve({verdict: 'confirmed', rationale: 'Grounded in the swallow fact.', citations: [kind], confidence: 0.8});
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
    assert.equal(isGrounded({verdict: 'confirmed', rationale: '', citations: ['ast.catchSwallowsError'], confidence: 0.8}, request), true);
    assert.equal(isGrounded({verdict: 'confirmed', rationale: '', citations: ['made.up'], confidence: 0.8}, request), false);
    assert.equal(isGrounded({verdict: 'confirmed', rationale: '', citations: [], confidence: 0.8}, request), false);
    assert.equal(isGrounded({verdict: 'confirmed', rationale: '', citations: ['ast.catchSwallowsError'], confidence: 2}, request), false);
});
