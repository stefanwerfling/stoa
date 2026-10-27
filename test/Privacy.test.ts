import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {buildPrompt, resolveCitations} from '../src/semantic/AnthropicSemanticAdapter.js';
import {augmentWithSemantics} from '../src/semantic/SemanticRunner.js';
import type {SemanticAdapter, SemanticRequest, SemanticVerdict} from '../src/semantic/SemanticAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {AnalysisResult, Fact} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const secretPath = '/home/alice/secret-project/src/User.ts';
const fact: Fact = {
    id: `fact:${secretPath}:ast.catchSwallowsError:handleUser:12`,
    kind: 'ast.catchSwallowsError',
    subject: {file: secretPath, symbol: 'handleUser', kindOf: 'catch-clause', range: {startLine: 12, startCol: 0, endLine: 12, endCol: 0}},
    value: true,
    evidence: [{source: 'ast', detail: 'x'}],
    certainty: 'syntactic',
    producedBy: {adapter: 'typescript', version: '0.2.0'}
};

const request: SemanticRequest = {
    codeSnippet: 'try { save(user); } catch (e) {}',
    facts: [fact],
    principleId: 'marcus.obstacle',
    principleName: 'The obstacle becomes a furtherance',
    observation: 'catch swallows error',
    projectContext: ''
};

test('the transmitted prompt carries the snippet and fact values but no file path or fact id', () => {
    const prompt = buildPrompt(request);
    // By design, the code excerpt and fact kinds/values ARE transmitted.
    assert.ok(prompt.includes('try { save(user); } catch (e) {}'), 'snippet is included (by design)');
    assert.ok(prompt.includes('ast.catchSwallowsError'), 'fact kind is included');
    assert.ok(prompt.includes('e1:'), 'facts are labelled e1, e2, …');
    // Privacy: the absolute path, the symbol-bearing fact id and the fact-id prefix must NOT leave the machine.
    assert.ok(!prompt.includes(secretPath), 'absolute file path is not transmitted');
    assert.ok(!prompt.includes('fact:'), 'the stable fact id (which embeds the path) is not transmitted');
    assert.ok(!prompt.includes('handleUser'), 'the fact id symbol is not transmitted via the id');
});

test('evidence labels resolve back to stable fact ids for grounding; unknown labels are kept', () => {
    assert.deepEqual(resolveCitations(['e1'], [fact]), [fact.id]);
    assert.deepEqual(resolveCitations(['e2'], [fact]), ['e2'], 'an out-of-range label is left verbatim (fails grounding)');
    assert.deepEqual(resolveCitations([], [fact]), []);
});

// A spy adapter that must never be invoked when the semantic layer is disabled.
class NoCallSpyAdapter implements SemanticAdapter {
    public readonly id = 'noop';
    public readonly deterministic = true;
    public called = false;
    public assess(_input: SemanticRequest): Promise<SemanticVerdict> {
        this.called = true;
        return Promise.reject(new Error('assess must not be called when semantics are disabled'));
    }
}

const analyzeCatch = (): AnalysisResult =>
    analyze({
        rootPath: join(here, 'fixtures', 'metrics', 'Catch.ts'),
        knowledgeDir: join(root, 'knowledge', 'marcus'),
        ruleSetDir: join(root, 'rules', 'default'),
        config: DEFAULT_CONFIG
    });

test('a disabled (noop) semantic layer never invokes the adapter', async () => {
    const spy = new NoCallSpyAdapter();
    const result = analyzeCatch();
    const augmented = await augmentWithSemantics(result, spy);
    assert.equal(spy.called, false, 'no outbound assess() call when disabled');
    assert.equal(JSON.stringify(augmented.report.findings), JSON.stringify(result.report.findings));
});

test('a plain deterministic analysis attaches no semantic output', () => {
    const result = analyzeCatch();
    assert.ok(result.report.findings.length >= 1);
    for (const finding of result.report.findings) {
        assert.equal(finding.semantic, undefined, 'deterministic findings carry no LLM augmentation');
    }
});
