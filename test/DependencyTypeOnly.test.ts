import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {KnowledgeBase} from '../src/knowledge/KnowledgeBase.js';
import {DependencyCycleRule} from '../src/rules/project/DependencyCycleRule.js';
import type {Fact} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const knowledgeBase = KnowledgeBase.loadFromDirectory(join(root, 'knowledge', 'marcus'), 'marcus');

const importFact = (file: string, module: string, isTypeOnly: boolean): Fact => ({
    id: `fact:${file}:${module}`,
    kind: 'deps.import',
    subject: {file, kindOf: 'import', range: {startLine: 1, startCol: 0, endLine: 1, endCol: 0}},
    value: {module, isTypeOnly},
    evidence: [{source: 'deps', detail: `import ${module}`}],
    certainty: 'syntactic',
    producedBy: {adapter: 'test', version: '0'}
});

const cycleCount = (aIsTypeOnly: boolean, bIsTypeOnly: boolean): number => {
    // Two files that import each other via relative specifiers — a two-module
    // cycle. The per-edge type-only flag decides whether it is a runtime cycle.
    const facts = [
        importFact('/proj/A.ts', './B', aIsTypeOnly),
        importFact('/proj/B.ts', './A', bIsTypeOnly)
    ];
    return new DependencyCycleRule()
        .evaluate({facts, ruleSetId: 'default', knowledgeBase, lang: 'en'})
        .length;
};

test('value import cycles are still reported (control)', () => {
    assert.equal(cycleCount(false, false), 1);
});

test('type-only import cycles are ignored — erased at compile time, no runtime cycle', () => {
    // Both edges type-only: no runtime cycle at all.
    assert.equal(cycleCount(true, true), 0);
    // A single type-only edge is enough to break the runtime cycle: the
    // remaining value edge is one-directional, so no cycle survives.
    assert.equal(cycleCount(true, false), 0);
});
