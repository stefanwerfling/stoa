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
