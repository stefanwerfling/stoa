import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const fixtures = join(here, 'fixtures', 'dart');

// The Dart grammar (tree-sitter/WASM) loads asynchronously; after this the
// pipeline parses Dart synchronously like the other adapters.
before(async () => {
    await initDart();
});

const analyzePath = (path: string): Finding[] => {
    return analyze({rootPath: path, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings;
};

const bySymbol = (findings: Finding[], symbol: string): Finding[] => {
    return findings.filter((finding) => finding.location.symbol === symbol);
};

test('Dart: complexity and parameter rules fire on a tangled function, not a clean one', () => {
    const findings = analyzePath(join(fixtures, 'Complex.dart'));

    const tangled = bySymbol(findings, 'tangled');
    assert.ok(
        tangled.some((f) => f.rule.id === 'R-COMPLEXITY-COGNITIVE'),
        'cognitive complexity over threshold'
    );
    assert.ok(tangled.some((f) => f.rule.id === 'R-DEEP-NESTING'), 'nesting over threshold');
    assert.ok(tangled.some((f) => f.rule.id === 'R-FN-TOO-MANY-PARAMS'), 'five parameters');
    assert.equal(bySymbol(findings, 'simple').length, 0, 'the clean function is not flagged');
});

test('Dart: R-ERR-SWALLOWED fires on an empty catch, not on rethrow or a logged catch', () => {
    const findings = analyzePath(join(fixtures, 'ErrorHandling.dart')).filter((f) => f.rule.id === 'R-ERR-SWALLOWED');
    assert.equal(findings.length, 1, 'only the empty catch swallows');
    assert.equal(findings[0]?.interpretation.principles[0]?.id, 'marcus.obstacle');
});

test('Dart: analysis is deterministic', () => {
    assert.equal(JSON.stringify(analyzePath(join(fixtures, 'Complex.dart'))), JSON.stringify(analyzePath(join(fixtures, 'Complex.dart'))));
});
