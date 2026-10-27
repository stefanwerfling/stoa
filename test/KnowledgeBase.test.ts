import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {after, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {KnowledgeBase} from '../src/knowledge/KnowledgeBase.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const validSample = join(root, 'knowledge', 'marcus', 'principles', 'simplicity.json');

const created: string[] = [];
after(() => {
    for (const dir of created) {
        rmSync(dir, {recursive: true, force: true});
    }
});

// A schema-valid principle, taken from the real knowledge base so the baseline
// is guaranteed to pass; tests mutate a clone to produce each failure.
const basePrinciple = (): Record<string, unknown> => JSON.parse(readFileSync(validSample, 'utf8')) as Record<string, unknown>;

// Writes a temporary knowledge base (dir/principles/<name>.json) and returns its root.
const writeKnowledge = (principles: Record<string, Record<string, unknown>>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-kb-'));
    created.push(dir);
    mkdirSync(join(dir, 'principles'));
    for (const [name, data] of Object.entries(principles)) {
        writeFileSync(join(dir, 'principles', `${name}.json`), JSON.stringify(data, null, 2));
    }
    return dir;
};

test('valid principle data loads', () => {
    const principle = {...basePrinciple(), relatedPrinciples: []};
    const kb = KnowledgeBase.loadFromDirectory(writeKnowledge({simplicity: principle}), 'test');
    assert.equal(kb.size(), 1);
    assert.ok(kb.get('marcus.simplicity') !== null);
});

test('a missing required field is rejected with file context', () => {
    const principle = {...basePrinciple(), relatedPrinciples: []};
    delete principle.name;
    assert.throws(
        () => KnowledgeBase.loadFromDirectory(writeKnowledge({broken: principle}), 'test'),
        /broken\.json.*principle\.schema\.json/s
    );
});

test('a wrong field type is rejected', () => {
    const principle = {...basePrinciple(), relatedPrinciples: [], attributionConfidence: 'high'};
    assert.throws(() => KnowledgeBase.loadFromDirectory(writeKnowledge({wrongtype: principle}), 'test'), /principle\.schema\.json/);
});

test('an empty id is rejected', () => {
    const principle = {...basePrinciple(), id: '', relatedPrinciples: []};
    assert.throws(() => KnowledgeBase.loadFromDirectory(writeKnowledge({emptyid: principle}), 'test'), /principle\.schema\.json/);
});

test('duplicate ids are rejected, not silently overwritten', () => {
    const first = {...basePrinciple(), relatedPrinciples: []};
    const second = {...basePrinciple(), relatedPrinciples: [], version: '2.0.0'};
    assert.throws(
        () => KnowledgeBase.loadFromDirectory(writeKnowledge({a: first, b: second}), 'test'),
        /duplicate principle id "marcus\.simplicity"/
    );
});

test('a dangling related-principle reference is rejected', () => {
    const principle = {...basePrinciple(), relatedPrinciples: ['marcus.ghost']};
    assert.throws(
        () => KnowledgeBase.loadFromDirectory(writeKnowledge({lonely: principle}), 'test'),
        /unknown related principle "marcus\.ghost"/
    );
});

test('a valid cross-reference between two principles loads', () => {
    const simplicity = {...basePrinciple(), relatedPrinciples: ['marcus.purpose']};
    const purpose = {...basePrinciple(), id: 'marcus.purpose', relatedPrinciples: ['marcus.simplicity']};
    const kb = KnowledgeBase.loadFromDirectory(writeKnowledge({simplicity, purpose}), 'test');
    assert.equal(kb.size(), 2);
});
