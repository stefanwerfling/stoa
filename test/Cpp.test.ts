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

test('C/C++: the memory-safety fixtures (allocation.cpp, scope.cpp) are deterministic too, analyzed individually and together', () => {
    assert.equal(JSON.stringify(analyzePath(join(fixtures, 'allocation.cpp'))), JSON.stringify(analyzePath(join(fixtures, 'allocation.cpp'))));
    assert.equal(JSON.stringify(analyzePath(join(fixtures, 'scope.cpp'))), JSON.stringify(analyzePath(join(fixtures, 'scope.cpp'))));
    // Analyzed as a whole directory: no finding from one file is lost or
    // duplicated depending on what else is in the batch.
    const whole = analyzePath(fixtures);
    assert.equal(JSON.stringify(whole), JSON.stringify(analyzePath(fixtures)));
    const ids = whole.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, 'no finding identity collides across the two memory-safety fixture files');
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

// Scope-aware variable identity (Phase 4, "Analysis Integrity & Memory-
// Bounded Pipeline" spec). Before this, matching was by identifier TEXT
// across the whole function — two same-named pointers in different scopes
// could be mistaken for the same allocation (confirmed against the spec's
// own example before any fix: produced ZERO findings for a leaked outer
// pointer `delete`d only via an unrelated, differently-scoped inner `p`).

test('scope: a shadowed inner pointer\'s delete does not release the differently-scoped outer allocation', () => {
    const findings = analyzePath(join(fixtures, 'scope.cpp'));
    const leakLines = new Set(byLine(findings, 'R-CPP-UNRELEASED-ALLOCATION'));
    assert.ok(leakLines.has(6), 'the OUTER new int(1) (line 6) is unreleased');
    assert.ok(!leakLines.has(8), 'the inner new int(2) (line 8) is correctly deleted in its own scope, not mistaken for the outer');
});

test('scope: both an outer and an inner same-named pointer can be correctly released independently', () => {
    const findings = analyzePath(join(fixtures, 'scope.cpp'));
    const leakLines = new Set(byLine(findings, 'R-CPP-UNRELEASED-ALLOCATION'));
    assert.ok(!leakLines.has(14) && !leakLines.has(16), 'nestedShadowBothReleased: the inner delete (line 17) releases the inner (line 16), the outer delete (line 19) releases the outer (line 14)');
});

test('scope: reassigning the SAME pointer to nullptr or a new allocation does not count as an ownership-transferring escape — the original stays leaked', () => {
    const findings = analyzePath(join(fixtures, 'scope.cpp'));
    const leakLines = new Set(byLine(findings, 'R-CPP-UNRELEASED-ALLOCATION'));
    assert.ok(leakLines.has(23), 'nullptrAfterAllocationStillLeaked: `p = nullptr;` frees nothing and hands the original object to nobody');
    assert.ok(!leakLines.has(28), 'nullptrAfterFreeIsFine: the delete happens BEFORE the nullptr reassignment, so the allocation itself is correctly released');
    assert.ok(leakLines.has(34), 'overwriteWithNewAllocationLeaksOriginal: `p = new int(2);` neither frees int(1) nor hands it anywhere — the original is leaked at the overwrite');
});

test('scope: a same-named NON-pointer local shadowing a pointer allocation does not hide the pointer\'s own leak', () => {
    const findings = analyzePath(join(fixtures, 'scope.cpp'));
    assert.ok(byLine(findings, 'R-CPP-UNRELEASED-ALLOCATION').includes(39), 'shadowByNonPointerLocal: the inner `int p = 5; p = p + 1;` must not be mistaken for a use of the outer pointer, so the outer new int(1) is still correctly flagged as leaked');
});

test('scope: two allocations in separate sibling blocks sharing a name are each tracked and leaked independently', () => {
    const findings = analyzePath(join(fixtures, 'scope.cpp'));
    assert.deepEqual(byLine(findings, 'R-CPP-UNRELEASED-ALLOCATION').filter((line) => line === 48 || line === 51), [48, 51], 'siblingBlocksSameNameBothLeaked: neither block\'s `p` is visible in the other, so both are independently unreleased');
});

test('scope: a declaration guarded by #ifdef/#else is still correctly matched to its release — preprocessor conditionals are not their own C++ scope', () => {
    const findings = analyzePath(join(fixtures, 'scope.cpp'));
    const leakLines = new Set(byLine(findings, 'R-CPP-UNRELEASED-ALLOCATION'));
    // Confirmed as a real false positive via dogfooding (vllm's
    // cumem_allocator.cpp) before this test existed: tree-sitter-cpp nests
    // #ifdef/#else content one AST level deeper than a real block, so a
    // naive "declarations directly in this block" scan would miss both
    // branches' declarations entirely, making `free(p)` on line 61 bind to
    // NEITHER branch and falsely flag both as leaked.
    assert.ok(!leakLines.has(57) && !leakLines.has(59), 'preprocBranchAllocationReleased: free(p) on line 61 must release whichever #ifdef/#else branch is in scope');
});
