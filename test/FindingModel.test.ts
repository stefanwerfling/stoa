import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
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

test('observation is technical and traceable; philosophy lives only in interpretation', () => {
    const result = analyzeCatch();
    const factKinds = new Set(result.facts.map((fact) => fact.kind));
    assert.ok(result.report.findings.length >= 1);

    for (const finding of result.report.findings) {
        // 1/2 — a concrete technical observation, evidenced by a real fact kind.
        assert.ok(finding.observation.statement.length > 0, 'observation has a statement');
        assert.ok(finding.observation.evidence.length >= 1, 'observation cites evidence');
        for (const evidence of finding.observation.evidence) {
            assert.ok(factKinds.has(evidence.fact), `evidence fact ${evidence.fact} is a produced fact`);
        }
        // 3 — no principle id leaks into the technical observation.
        assert.ok(!finding.observation.statement.includes('marcus.'), 'no principle id in the observation');

        // 3/4 — philosophy is interpretation: flagged, sourced, with explicit uncertainty.
        assert.ok(finding.interpretation.principles.length >= 1, 'an interpretation principle is attached');
        for (const principle of finding.interpretation.principles) {
            assert.ok(principle.attributionConfidence > 0 && principle.attributionConfidence <= 1, 'attribution confidence is a visible [0,1] value');
            assert.ok(principle.rationale.length > 0, 'the interpretation carries a rationale');
        }

        // severity and confidence are separate axes; the finding is deterministic.
        assert.ok(['info', 'low', 'medium', 'high'].includes(finding.severity));
        assert.ok(finding.confidence > 0 && finding.confidence <= 1);
        assert.equal(finding.source, 'deterministic');
        assert.equal(finding.semantic, undefined, 'no LLM augmentation on a plain run');
    }
});

// Grounds its verdict in a real provided fact id, so the runner attaches it.
class GroundedMockAdapter implements SemanticAdapter {
    public readonly id = 'mock-grounded';
    public readonly deterministic = true;
    public assess(input: SemanticRequest): Promise<SemanticVerdict> {
        return Promise.resolve({verdict: 'confirmed', rationale: 'grounded', citations: [input.facts[0]?.id ?? ''], confidence: 0.8});
    }
}

test('a grounded semantic verdict augments but never mutates the technical finding', async () => {
    const result = analyzeCatch();
    const before = result.report.findings.map((finding) => JSON.stringify({o: finding.observation, s: finding.severity, c: finding.confidence, i: finding.interpretation}));
    const augmented = await augmentWithSemantics(result, new GroundedMockAdapter());

    let attached = 0;
    augmented.report.findings.forEach((finding, index) => {
        const after = JSON.stringify({o: finding.observation, s: finding.severity, c: finding.confidence, i: finding.interpretation});
        assert.equal(after, before[index], 'observation/severity/confidence/interpretation are unchanged by the LLM layer');
        if (finding.semantic !== undefined) {
            attached += 1;
            assert.equal(finding.source, 'deterministic', 'the finding stays a deterministic finding with an advisory note');
        }
    });
    assert.ok(attached >= 1, 'at least one finding received the advisory note');
});
