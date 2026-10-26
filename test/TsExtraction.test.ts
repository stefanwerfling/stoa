import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {TypeScriptAdapter} from '../src/analysis/TypeScriptAdapter.js';
import type {Fact} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const metricsDir = join(here, 'fixtures', 'metrics');
const adapter = new TypeScriptAdapter();

const analyzeFixture = (name: string): Fact[] => {
    const path = join(metricsDir, name);
    const content = readFileSync(path, 'utf8');
    const parsed = adapter.parse({path, content});
    return adapter.extractFacts(parsed, {rootDir: metricsDir});
};

const factFor = (facts: Fact[], kind: string, symbol: string): Fact => {
    const match = facts.find((fact) => fact.kind === kind && fact.subject.symbol === symbol);
    assert.ok(match, `expected a ${kind} fact for ${symbol}`);
    return match;
};

test('complexity metrics for a known function are exact', () => {
    const facts = analyzeFixture('Rate.ts');
    assert.equal(factFor(facts, 'metric.cyclomaticComplexity', 'rate').value, 3);
    assert.equal(factFor(facts, 'metric.cognitiveComplexity', 'rate').value, 2);
    assert.equal(factFor(facts, 'metric.nestingDepth', 'rate').value, 1);
    assert.equal(factFor(facts, 'metric.parameterCount', 'rate').value, 1);
});

test('error-handling facts distinguish empty, rethrowing and swallowing catches', () => {
    const facts = analyzeFixture('Catch.ts');
    const empty = facts.filter((fact) => fact.kind === 'ast.emptyCatch').map((fact) => fact.value);
    const swallows = facts.filter((fact) => fact.kind === 'ast.catchSwallowsError').map((fact) => fact.value);

    // Source order: emptyCatch, rethrowCatch, swallowCatch.
    assert.deepEqual(empty, [true, false, false]);
    assert.deepEqual(swallows, [true, false, true]);
});

test('dependency facts carry module specifier and type-only flag', () => {
    const facts = analyzeFixture('Imports.ts').filter((fact) => fact.kind === 'deps.import');
    const values = facts.map((fact) => fact.value as {module: string; isTypeOnly: boolean});
    assert.deepEqual(values, [
        {module: 'node:fs', isTypeOnly: false},
        {module: './Foo.js', isTypeOnly: true}
    ]);
});

test('extraction is deterministic across runs', () => {
    const a = analyzeFixture('Rate.ts');
    const b = analyzeFixture('Rate.ts');
    assert.equal(JSON.stringify(a), JSON.stringify(b));
});
