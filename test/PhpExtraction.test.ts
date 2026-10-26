import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {PhpAdapter} from '../src/analysis/PhpAdapter.js';
import type {Fact} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const phpDir = join(here, 'fixtures', 'php');
const adapter = new PhpAdapter();

const analyzeFixture = (name: string): Fact[] => {
    const path = join(phpDir, name);
    const content = readFileSync(path, 'utf8');
    const parsed = adapter.parse({path, content});
    return adapter.extractFacts(parsed, {rootDir: phpDir});
};

const factFor = (facts: Fact[], kind: string, symbol: string): Fact => {
    const match = facts.find((fact) => fact.kind === kind && fact.subject.symbol === symbol);
    assert.ok(match, `expected a ${kind} fact for ${symbol}`);
    return match;
};

test('PHP complexity metrics match the TypeScript adapter for the same shape', () => {
    const facts = analyzeFixture('Rate.php');
    assert.equal(factFor(facts, 'metric.cyclomaticComplexity', 'rate').value, 3);
    assert.equal(factFor(facts, 'metric.cognitiveComplexity', 'rate').value, 2);
    assert.equal(factFor(facts, 'metric.nestingDepth', 'rate').value, 1);
    assert.equal(factFor(facts, 'metric.parameterCount', 'rate').value, 1);
});

test('PHP error-handling facts distinguish empty, rethrowing and swallowing catches', () => {
    const facts = analyzeFixture('Catch.php');
    const empty = facts.filter((fact) => fact.kind === 'ast.emptyCatch').map((fact) => fact.value);
    const swallows = facts.filter((fact) => fact.kind === 'ast.catchSwallowsError').map((fact) => fact.value);
    assert.deepEqual(empty, [true, false, false]);
    assert.deepEqual(swallows, [true, false, true]);
});

test('PHP dependency facts carry the use-statement target', () => {
    const modules = analyzeFixture('Imports.php')
        .filter((fact) => fact.kind === 'deps.import')
        .map((fact) => (fact.value as {module: string}).module);
    assert.deepEqual(modules, ['App\\Service\\Mailer', 'App\\Repository\\UserRepository']);
});

test('PHP extraction is deterministic across runs', () => {
    assert.equal(JSON.stringify(analyzeFixture('Rate.php')), JSON.stringify(analyzeFixture('Rate.php')));
});

test('PHP detects non-deterministic built-ins and unused use statements', () => {
    const facts = analyzeFixture('Robust.php');
    assert.equal(factFor(facts, 'ast.usesNondeterminism', 'makeId').value, true);
    const unused = facts.filter((fact) => fact.kind === 'deps.importUnused').map((fact) => fact.value);
    assert.deepEqual(unused, ['App\\Unused\\Helper']);
});
