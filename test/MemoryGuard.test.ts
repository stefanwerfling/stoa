import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isMemoryCritical, takeMemorySnapshot} from '../src/MemoryGuard.js';

test('takeMemorySnapshot returns sane, positive numbers sourced from process.memoryUsage()/v8', () => {
    const snapshot = takeMemorySnapshot();
    assert.ok(snapshot.rss > 0);
    assert.ok(snapshot.heapUsed > 0);
    assert.ok(snapshot.heapTotal >= snapshot.heapUsed);
    assert.ok(snapshot.heapSizeLimit > snapshot.heapTotal, 'the limit is a ceiling above current usage, not a running total');
});

test('isMemoryCritical compares heapUsed against a ratio of heapSizeLimit, not against a fixed MB constant', () => {
    const base = {rss: 1, heapTotal: 100, external: 0};
    assert.equal(isMemoryCritical({...base, heapUsed: 95, heapSizeLimit: 100}, 0.9), true);
    assert.equal(isMemoryCritical({...base, heapUsed: 50, heapSizeLimit: 100}, 0.9), false);
    // The same heapUsed is critical under a looser ratio and not under a stricter one.
    assert.equal(isMemoryCritical({...base, heapUsed: 85, heapSizeLimit: 100}, 0.8), true);
    assert.equal(isMemoryCritical({...base, heapUsed: 85, heapSizeLimit: 100}, 0.95), false);
});

test('defaults to a 0.9 ratio when none is given', () => {
    assert.equal(isMemoryCritical({rss: 1, external: 0, heapTotal: 100, heapUsed: 91, heapSizeLimit: 100}), true);
    assert.equal(isMemoryCritical({rss: 1, external: 0, heapTotal: 100, heapUsed: 89, heapSizeLimit: 100}), false);
});
