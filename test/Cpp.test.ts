import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initCpp} from '../src/analysis/CppAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const fixtures = join(here, 'fixtures', 'cpp');

// The C and C++ grammars (tree-sitter/WASM) load asynchronously; after this the
// pipeline parses them synchronously like the other adapters.
before(async () => {
    await initCpp();
});

const analyzePath = (path: string): Finding[] => {
    return analyze({rootPath: path, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings;
};

const bySymbol = (findings: Finding[], symbol: string): Finding[] => {
    return findings.filter((finding) => finding.location.symbol === symbol);
};

test('C: complexity and parameter rules fire on a tangled function, not a clean one', () => {
    const findings = analyzePath(join(fixtures, 'tangled.c'));
    const tangled = bySymbol(findings, 'tangled');
    assert.ok(tangled.some((f) => f.rule.id === 'R-COMPLEXITY-COGNITIVE'), 'cognitive complexity over threshold');
    assert.ok(tangled.some((f) => f.rule.id === 'R-DEEP-NESTING'), 'nesting over threshold');
    assert.ok(tangled.some((f) => f.rule.id === 'R-FN-TOO-MANY-PARAMS'), 'five parameters');
    assert.equal(bySymbol(findings, 'simple').length, 0, 'the clean function is not flagged');
});

test('C++: R-ERR-SWALLOWED fires on an empty catch, not on rethrow or a logged catch', () => {
    const findings = analyzePath(join(fixtures, 'handlers.cpp')).filter((f) => f.rule.id === 'R-ERR-SWALLOWED');
    assert.equal(findings.length, 1, 'only the empty catch swallows');
    assert.equal(findings[0]?.interpretation.principles[0]?.id, 'marcus.obstacle');
});

test('C++: lambda complexity and calls are not attributed to the enclosing function', () => {
    const findings = analyzePath(join(fixtures, 'lambda.cpp'));
    const outer = bySymbol(findings, 'outer');
    assert.equal(outer.filter((f) => f.rule.id === 'R-COMPLEXITY-COGNITIVE').length, 0, "the lambda's complexity is not outer()'s");
    assert.equal(outer.filter((f) => f.rule.id === 'R-DEEP-NESTING').length, 0, "the lambda's nesting is not outer()'s");
    assert.equal(outer.filter((f) => f.rule.id === 'R-SIDEEFFECT-NONDETERMINISM').length, 0, "the lambda's rand() is not outer()'s");

    const direct = bySymbol(findings, 'direct').filter((f) => f.rule.id === 'R-SIDEEFFECT-NONDETERMINISM');
    assert.equal(direct.length, 1, 'a direct rand() call is flagged');
});

test('C: malformed source and preprocessor guards do not crash extraction', () => {
    const first = analyzePath(join(fixtures, 'broken.c'));
    assert.ok(Array.isArray(first), 'extraction returns findings without throwing on a parse error');
    // and it stays deterministic on error-tolerant input
    assert.equal(JSON.stringify(first), JSON.stringify(analyzePath(join(fixtures, 'broken.c'))));
});

test('C/C++: analysis is deterministic', () => {
    assert.equal(JSON.stringify(analyzePath(join(fixtures, 'tangled.c'))), JSON.stringify(analyzePath(join(fixtures, 'tangled.c'))));
});

const byLine = (findings: Finding[], ruleId: string): number[] => findings.filter((f) => f.rule.id === ruleId).map((f) => f.location.range.startLine).sort((a, b) => a - b);

test('R-CPP-UNRELEASED-ALLOCATION: fires on new/malloc/calloc left with no release, no escape anywhere in the function', () => {
    const findings = analyzePath(join(fixtures, 'allocation.cpp'));
    // leakedNew (5), leakedMalloc (9), usedThenLeaked (53, dereferenced but
    // never released — a dereference is an ordinary use, not an escape),
    // callocLeak (69). Everything else in the fixture is either correctly
    // released, or escapes (a call argument, a return, a reassignment) and
    // is therefore deliberately NOT claimed as a leak.
    assert.deepEqual(byLine(findings, 'R-CPP-UNRELEASED-ALLOCATION'), [5, 9, 53, 69]);
});

test('R-CPP-NEW-DELETE-MISMATCH: fires only when the SAME pointer\'s new[]/new does not match its delete[]/delete form', () => {
    const findings = analyzePath(join(fixtures, 'allocation.cpp'));
    // mismatchedArray (23: new[] freed with plain delete), mismatchedScalar
    // (28: new freed with delete[]). matchedNew/matchedArray/matchedMalloc
    // are correctly paired and must not appear here.
    assert.deepEqual(byLine(findings, 'R-CPP-NEW-DELETE-MISMATCH'), [23, 28]);
});

test('R-CPP-UNRELEASED-ALLOCATION: escapes (call argument, return, reassignment) and a correct release all suppress the finding — never a false positive', () => {
    const findings = analyzePath(join(fixtures, 'allocation.cpp'));
    const leakLines = new Set(byLine(findings, 'R-CPP-UNRELEASED-ALLOCATION'));
    // matchedNew(13), matchedArray(18), mismatchedArray(23, reported under
    // the OTHER rule, not this one), mismatchedScalar(28, same), matchedMalloc(33),
    // escapesViaCall(38), escapesViaReturn(43), escapesViaReassign(48), reallocPattern(58).
    for (const safeLine of [13, 18, 33, 38, 43, 48, 58]) {
        assert.ok(!leakLines.has(safeLine), `line ${safeLine} must not be flagged as an unreleased allocation`);
    }
});

test('R-CPP-UNRELEASED-ALLOCATION: a declare-then-assign allocation and one inside a lambda are both out of scope (documented, not a false negative introduced by this test)', () => {
    const findings = analyzePath(join(fixtures, 'allocation.cpp'));
    assert.equal(byLine(findings, 'R-CPP-UNRELEASED-ALLOCATION').includes(65), false, 'p = new int(5) after a bare `int* p;` is not tracked — only a direct initializer is');
    assert.equal(byLine(findings, 'R-CPP-UNRELEASED-ALLOCATION').includes(74), false, 'an allocation inside a lambda is not attributed anywhere — lambdas are not analyzed at all, same as for complexity metrics');
});

test('R-CPP-UNRELEASED-ALLOCATION: four real-world false positives found by dogfooding against external repos are fixed and stay fixed', () => {
    const findings = analyzePath(join(fixtures, 'allocation.cpp'));
    const leakLines = new Set(byLine(findings, 'R-CPP-UNRELEASED-ALLOCATION'));
    assert.ok(!leakLines.has(82), 'a `static` local pointer is a process-lifetime singleton by design (mimirmind bigBlockPool()), not a leak');
    assert.ok(!leakLines.has(89), 'returning the pointer inside a braced aggregate initializer (mimirmind ComputeBuffer{raw,...}) is still an escape, not just a bare `return raw;`');
    assert.ok(!leakLines.has(94), 'placement new (vllm shm.cpp/cpu_attn_impl.hpp) constructs in caller-owned storage — there is nothing of its own to delete');
    assert.ok(!leakLines.has(98), 'free() reached through a cast (`free((void*)buf)`) is still a release, not a miss');
});
